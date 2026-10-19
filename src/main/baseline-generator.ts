import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectContractRollovers,
  mergeMainContractMappings,
} from '../domain/contract-rollover';
import {
  aggregateMinutes,
  assertBarsValid,
  assertMinuteRecordsValid,
  mergeMinuteChunks,
  reconcileBars,
} from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../shared/instruments';
import type {
  EdbMinuteRecord,
  MainContractMapping,
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
  bars1: EdbMinuteRecord[];
  mainContractMappings: MainContractMapping[];
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

function candidateFor(
  definition: InstrumentDefinition,
  bars1: EdbMinuteRecord[],
  mappings: MainContractMapping[],
  requestStartMs: number,
  requestEndMs: number,
): SnapshotCandidate {
  const sourceLatestMs = bars1.at(-1)!.startMs + MINUTE_MS;
  const bars5 = aggregateMinutes(
    bars1,
    5,
    sourceLatestMs,
    definition.tradingSessions,
  );
  const bars60 = aggregateMinutes(
    bars1,
    60,
    sourceLatestMs,
    definition.tradingSessions,
  );
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  assertBarsValid(bars60, 60, definition.tradingSessions);
  reconcileBars(bars5, bars60);
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
      if (!bars1.length) {
        throw new Error(`${definition.name} 没有可写入的 1 分钟行情`);
      }
      assertMinuteRecordsValid(bars1, definition.tradingSessions);

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
      const candidate = candidateFor(
        definition,
        bars1,
        mappings,
        options.requestStartMs,
        options.requestEndMs,
      );

      options.onProgress?.(definition, 'writing');
      await writeBuiltinMarketSnapshot(
        options.paths,
        definition,
        candidate,
        { now: () => new Date(generatedAt) },
      );
      const result: BaselineInstrumentReport = {
        instrumentId: definition.id,
        name: definition.name,
        mainSymbol: definition.mainSymbol,
        status: 'succeeded',
        firstMinute: bars1[0].start,
        lastMinute: bars1.at(-1)!.start,
        sourceLatestAt: candidate.sourceLatestAt,
        minuteRows: bars1.length,
        fiveMinuteRows: candidate.bars5.length,
        sixtyMinuteRows: candidate.bars60.length,
        mappingRows: candidate.mainContractMappings.length,
        rolloverRows: candidate.rollovers.length,
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
