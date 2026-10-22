import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectContractRollovers,
  mergeMainContractMappings,
} from '../domain/contract-rollover';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  assertMinuteRecordsValid,
  mergeBarsPreservingHistory,
  mergeMinuteChunks,
  reconcileBars,
  serializeBars,
  serializeMinuteRecords,
} from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../shared/instruments';
import type {
  Bar,
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotMetadataV5,
  MarketSnapshotRedistribution,
  MarketSnapshotSourceKind,
  MarketSnapshotSourceSegment,
  SnapshotPeriodMetadata,
} from '../shared/types';
import {
  fetchEdbChunks,
  fetchEdbContractMappings,
  type EdbClient,
} from './edb-client';
import {
  loadEffectiveSnapshot,
  writeBuiltinMarketSnapshot,
  type LoadedMarketSnapshot,
  type MarketDataPaths,
  type SnapshotCandidate,
} from './market-snapshot';

const MINUTE_MS = 60_000;
export const BASELINE_REPORT_FILE = 'baseline-report.json';

type BaselineClient = Pick<
  EdbClient,
  'fetchRange' | 'fetchMainDailyRange' | 'fetchContractDailyRange'
>;

export interface BaselineSeed {
  bars1?: EdbMinuteRecord[];
  bars5: Bar[];
  mainContractMappings: MainContractMapping[];
  source?: MarketSnapshotMetadataV5['source'];
  sourceSegments?: MarketSnapshotSourceSegment[];
  redistribution?: MarketSnapshotRedistribution;
}

export interface BaselineRemoteSource {
  sourceId: string;
  sourceName: string;
  kind: MarketSnapshotSourceKind;
  sourceVersion?: string;
  rawFileName?: string;
  importerVersion: string;
  license: MarketSnapshotSourceSegment['license'];
}

export interface BaselineInstrumentReport {
  instrumentId: InstrumentDefinition['id'];
  name: string;
  mainSymbol: string;
  status: 'succeeded' | 'failed';
  firstMinute?: string;
  lastMinute?: string;
  sourceLatestAt?: string;
  minuteRows?: number;
  fiveMinuteRows?: number;
  sixtyMinuteRows?: number;
  mappingRows?: number;
  rolloverRows?: number;
  periods?: {
    bars1?: SnapshotPeriodMetadata;
    bars5: SnapshotPeriodMetadata;
    bars60: SnapshotPeriodMetadata;
  };
  sourceSegments?: MarketSnapshotSourceSegment[];
  redistribution?: MarketSnapshotRedistribution;
  error?: string;
}

export interface BaselineGenerationReport {
  schemaVersion: 1;
  generatedAt: string;
  requestStart: string;
  requestEnd: string;
  instruments: BaselineInstrumentReport[];
}

export interface BaselineGeneratorOptions {
  paths: MarketDataPaths;
  client: BaselineClient;
  requestStartMs: number;
  requestEndMs: number;
  daysPerChunk?: number;
  instruments?: readonly InstrumentDefinition[];
  now?: () => Date;
  remoteSource?: BaselineRemoteSource;
  loadSeed?: (
    definition: InstrumentDefinition,
  ) => Promise<BaselineSeed | LoadedMarketSnapshot | undefined>;
  onProgress?: (
    definition: InstrumentDefinition,
    phase: 'fetching' | 'mapping' | 'writing' | 'completed',
  ) => void;
}

function assertRequestRange(startMs: number, endMs: number): void {
  if (!Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || startMs > endMs
    || startMs % MINUTE_MS !== 0
    || endMs % MINUTE_MS !== 0) {
    throw new Error('基线请求范围必须是有效且对齐整分钟的时间区间');
  }
}

async function defaultSeedLoader(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot | undefined> {
  try {
    return await loadEffectiveSnapshot(paths, definition);
  } catch {
    return undefined;
  }
}

async function writeReport(
  paths: MarketDataPaths,
  report: BaselineGenerationReport,
): Promise<void> {
  await mkdir(paths.builtinDataDirectory, { recursive: true });
  await writeFile(
    join(paths.builtinDataDirectory, BASELINE_REPORT_FILE),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}

function mappingRequestStart(records: readonly EdbMinuteRecord[]): number {
  const firstDate = records[0].start.slice(0, 10);
  return parseBeijing(`${firstDate} 00:00:00`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function period(
  values: readonly { start: string; end?: string }[],
): SnapshotPeriodMetadata | undefined {
  if (!values.length) return undefined;
  return {
    first: values[0].start,
    last: values.at(-1)!.end ?? values.at(-1)!.start,
    rows: values.length,
  };
}

function seedProvenance(
  seed: BaselineSeed | LoadedMarketSnapshot | undefined,
  definition: InstrumentDefinition,
  generatedAt: string,
): {
  source?: MarketSnapshotMetadataV5['source'];
  sourceSegments: MarketSnapshotSourceSegment[];
} {
  if (!seed) return { sourceSegments: [] };
  if (!('directory' in seed) && seed.sourceSegments?.length) {
    return {
      source: seed.source,
      sourceSegments: seed.sourceSegments,
    };
  }
  const metadata = 'directory' in seed ? seed.metadata : undefined;
  if (metadata?.schemaVersion === 5 || metadata?.schemaVersion === 6) {
    return {
      source: metadata.source,
      sourceSegments: metadata.sourceSegments,
    };
  }
  if (!seed.bars5.length) return { sourceSegments: [] };
  const serialized = serializeBars(seed.bars5);
  return {
    sourceSegments: [{
      sourceId: `legacy-${definition.id}`,
      sourceName: '现有本地历史快照',
      kind: 'legacy-migration',
      acquiredAt: generatedAt,
      coverage: {
        first: seed.bars5[0].start,
        last: seed.bars5.at(-1)!.end,
      },
      rawFiles: [{
        name: 'edb_main_continuous_5m.csv',
        sha256: sha256(serialized),
        rows: seed.bars5.length,
      }],
      importerVersion: 'moneycoming-baseline-generator-v2',
      license: {
        redistributionAllowed: false,
        conclusion: '旧快照未携带可再分发授权审计，必须重新确认后才能发布',
      },
    }],
  };
}

function remoteSourceSegment(
  definition: InstrumentDefinition,
  records: readonly EdbMinuteRecord[],
  generatedAt: string,
  source: BaselineRemoteSource | undefined,
): MarketSnapshotSourceSegment | undefined {
  if (!records.length) return undefined;
  const descriptor = source ?? {
    sourceId: 'edb-main-continuous',
    sourceName: 'EDB 主连分钟接口',
    kind: 'edb-tail' as const,
    importerVersion: 'moneycoming-baseline-generator-v2',
    license: {
      identifier: 'EDB account terms',
      redistributionAllowed: false,
      conclusion: '仅供当前用户本机使用，未确认可随产品再分发',
    },
  };
  const serialized = serializeMinuteRecords(records, definition.tradingSessions);
  return {
    sourceId: descriptor.sourceId,
    sourceName: descriptor.sourceName,
    kind: descriptor.kind,
    sourceVersion: descriptor.sourceVersion,
    acquiredAt: generatedAt,
    coverage: {
      first: records[0].start,
      last: records.at(-1)!.start,
    },
    rawFiles: [{
      name: descriptor.rawFileName
        ?? `${descriptor.sourceId}-${definition.id}-minute.csv`,
      sha256: sha256(serialized),
      rows: records.length,
    }],
    importerVersion: descriptor.importerVersion,
    license: descriptor.license,
  };
}

function mergeSourceSegments(
  existing: readonly MarketSnapshotSourceSegment[],
  incoming: MarketSnapshotSourceSegment | undefined,
): MarketSnapshotSourceSegment[] {
  if (!incoming) return [...existing];
  const segments = existing.filter(segment => segment.sourceId !== incoming.sourceId);
  const previous = existing.find(segment => segment.sourceId === incoming.sourceId);
  if (!previous) return [...segments, incoming];
  const rawFiles = [...previous.rawFiles, ...incoming.rawFiles].filter(
    (file, index, files) => files.findIndex(candidate => (
      candidate.name === file.name && candidate.sha256 === file.sha256
    )) === index,
  );
  return [...segments, {
    ...previous,
    ...incoming,
    coverage: {
      first: previous.coverage.first < incoming.coverage.first
        ? previous.coverage.first
        : incoming.coverage.first,
      last: previous.coverage.last > incoming.coverage.last
        ? previous.coverage.last
        : incoming.coverage.last,
    },
    rawFiles,
    license: {
      identifier: incoming.license.identifier ?? previous.license.identifier,
      redistributionAllowed: previous.license.redistributionAllowed
        && incoming.license.redistributionAllowed,
      conclusion: previous.license.conclusion === incoming.license.conclusion
        ? incoming.license.conclusion
        : `${previous.license.conclusion}；${incoming.license.conclusion}`,
    },
  }];
}

function redistributionFor(
  sourceSegments: readonly MarketSnapshotSourceSegment[],
): MarketSnapshotRedistribution {
  return sourceSegments.length > 0
    && sourceSegments.every(segment => segment.license.redistributionAllowed)
    ? {
        allowed: true,
        conclusion: '全部来源均已确认允许随产品再分发',
      }
    : {
        allowed: false,
        conclusion: sourceSegments.length
          ? '至少一个来源未确认允许随产品再分发'
          : '候选基线缺少来源与再分发审计',
      };
}

function candidateFor(
  definition: InstrumentDefinition,
  bars1: EdbMinuteRecord[],
  bars5: Bar[],
  mappings: MainContractMapping[],
  requestStartMs: number,
  requestEndMs: number,
  source: MarketSnapshotMetadataV5['source'] | undefined,
  sourceSegments: MarketSnapshotSourceSegment[],
): SnapshotCandidate {
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  reconcileBars(bars5, bars60, definition.tradingSessions);
  const sourceLatestMs = Math.max(
    bars1.at(-1)?.startMs === undefined
      ? Number.NEGATIVE_INFINITY
      : bars1.at(-1)!.startMs + MINUTE_MS,
    bars5.at(-1)?.endMs ?? Number.NEGATIVE_INFINITY,
    bars60.at(-1)?.endMs ?? Number.NEGATIVE_INFINITY,
  );
  const rollovers = detectContractRollovers(mappings, bars5, definition);
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings: mappings,
    rollovers,
    requestStart: formatBeijing(requestStartMs),
    requestEnd: formatBeijing(requestEndMs),
    sourceLatestAt: formatBeijing(sourceLatestMs),
    source: source ?? {
      provider: sourceSegments.some(segment => segment.kind !== 'edb-tail')
        ? 'MIXED'
        : 'EDB',
      endpoint: sourceSegments.some(segment => segment.kind === 'edb-tail')
        ? 'https://edb.shinnytech.com/md/kline'
        : undefined,
      symbol: definition.mainSymbol,
    },
    sourceSegments,
    redistribution: redistributionFor(sourceSegments),
  };
}

export async function generateMarketBaselines(
  options: BaselineGeneratorOptions,
): Promise<BaselineGenerationReport> {
  assertRequestRange(options.requestStartMs, options.requestEndMs);
  const definitions = options.instruments ?? INSTRUMENT_LIST;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const report: BaselineGenerationReport = {
    schemaVersion: 1,
    generatedAt,
    requestStart: formatBeijing(options.requestStartMs),
    requestEnd: formatBeijing(options.requestEndMs),
    instruments: [],
  };
  const loadSeed = options.loadSeed
    ?? (definition => defaultSeedLoader(options.paths, definition));

  for (const definition of definitions) {
    try {
      options.onProgress?.(definition, 'fetching');
      const remoteMinutes = await fetchEdbChunks(
        options.client,
        definition,
        options.requestStartMs,
        options.requestEndMs,
        options.daysPerChunk,
      );
      const seed = await loadSeed(definition);
      const bars1 = mergeMinuteChunks([
        seed?.bars1 ?? [],
        remoteMinutes,
      ]);
      assertMinuteRecordsValid(bars1, definition.tradingSessions);
      const seedBars5 = seed?.bars5.length
        ? seed.bars5
        : aggregateMinutes(
            seed?.bars1 ?? [],
            5,
            seed?.bars1?.at(-1)?.startMs === undefined
              ? Number.NEGATIVE_INFINITY
              : seed.bars1.at(-1)!.startMs + MINUTE_MS,
            definition.tradingSessions,
          ).filter(bar => bar.complete);
      const remoteBars5 = aggregateMinutes(
        remoteMinutes,
        5,
        remoteMinutes.at(-1)?.startMs === undefined
          ? Number.NEGATIVE_INFINITY
          : remoteMinutes.at(-1)!.startMs + MINUTE_MS,
        definition.tradingSessions,
      ).filter(bar => bar.complete);
      const bars5 = mergeBarsPreservingHistory(seedBars5, remoteBars5).bars;
      if (!bars5.length) {
        throw new Error(`${definition.name} 没有可写入的 5 分钟行情`);
      }

      options.onProgress?.(definition, 'mapping');
      let remoteMappings: MainContractMapping[] = [];
      if (remoteMinutes.length) {
        remoteMappings = await fetchEdbContractMappings(
          options.client,
          definition,
          mappingRequestStart(remoteMinutes),
          options.requestEndMs,
        );
      }
      const mappings = mergeMainContractMappings(
        seed?.mainContractMappings ?? [],
        remoteMappings,
        definition,
      );
      const provenance = seedProvenance(seed, definition, generatedAt);
      const sourceSegments = mergeSourceSegments(
        provenance.sourceSegments,
        remoteSourceSegment(
          definition,
          remoteMinutes,
          generatedAt,
          options.remoteSource,
        ),
      );
      const candidate = candidateFor(
        definition,
        bars1,
        bars5,
        mappings,
        options.requestStartMs,
        options.requestEndMs,
        provenance.source,
        sourceSegments,
      );

      options.onProgress?.(definition, 'writing');
      const written = await writeBuiltinMarketSnapshot(
        options.paths,
        definition,
        candidate,
        { now: () => new Date(generatedAt) },
      );
      if (written.metadata?.schemaVersion !== 5) {
        throw new Error(`${definition.name} 基线未写入 schema 5 元数据`);
      }
      const result: BaselineInstrumentReport = {
        instrumentId: definition.id,
        name: definition.name,
        mainSymbol: definition.mainSymbol,
        status: 'succeeded',
        firstMinute: bars1[0]?.start,
        lastMinute: bars1.at(-1)?.start,
        sourceLatestAt: candidate.sourceLatestAt,
        minuteRows: bars1.length,
        fiveMinuteRows: candidate.bars5.length,
        sixtyMinuteRows: candidate.bars60.length,
        mappingRows: candidate.mainContractMappings.length,
        rolloverRows: candidate.rollovers.length,
        periods: {
          bars1: period(candidate.bars1),
          bars5: period(candidate.bars5)!,
          bars60: period(candidate.bars60)!,
        },
        sourceSegments: written.metadata.sourceSegments,
        redistribution: written.metadata.redistribution,
      };
      report.instruments.push(result);
      await writeReport(options.paths, report);
      options.onProgress?.(definition, 'completed');
    } catch (error) {
      report.instruments.push({
        instrumentId: definition.id,
        name: definition.name,
        mainSymbol: definition.mainSymbol,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      await writeReport(options.paths, report);
      throw error;
    }
  }
  return report;
}
