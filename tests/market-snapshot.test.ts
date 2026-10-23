import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseContractRollovers,
  serializeContractRollovers,
  serializeMainContractMappings,
} from '../src/domain/contract-rollover';
import { parseBars } from '../src/domain/data';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  parseEdbMinuteCsv,
  serializeBars,
  serializeMinuteRecords,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import {
  cleanupSnapshots,
  loadEffectiveSnapshot,
  loadEffectiveSnapshotWithLoader,
  migrateLegacySoymealData,
  prepareSnapshotDirectory,
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  snapshotFingerprint,
  writeBuiltinMarketSnapshot,
  type LoadedMarketSnapshot,
  type MarketDataPaths,
  type SnapshotCandidate,
  type SnapshotDirectoryLoader,
} from '../src/main/market-snapshot';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
  type InstrumentDefinition,
} from '../src/shared/instruments';
import type {
  Bar,
  ContractRollover,
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotBenchmarkProtection,
  MarketSnapshotMetadataV7Full,
  MarketSnapshotMetadataV7Tail,
  MarketSnapshotSourceSegment,
} from '../src/shared/types';

const source = resolve('futures_investigation_20261009');
const temps: string[] = [];
const DATA_FILES = [
  'edb_main_continuous_1m_raw.csv',
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'edb_main_continuous_rollovers.csv',
] as const;
const SNAPSHOT_IO_TIMEOUT = 60_000;
const GLASS = INSTRUMENT_DEFINITIONS.glass_main;
const ONE_MINUTE_FILE = 'edb_main_continuous_1m_raw.csv';
const FIVE_MINUTE_FILE = 'edb_main_continuous_5m.csv';
const SIXTY_MINUTE_FILE = 'edb_main_continuous_60m.csv';
const ROLLOVER_FILE = 'edb_main_continuous_rollovers.csv';
const MAPPING_FILE = 'edb_main_contract_mapping.csv';

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<MarketDataPaths> {
  const root = await mkdtemp(join(tmpdir(), '行情 快照-'));
  temps.push(root);
  const builtin = join(root, '内置 数据');
  await mkdir(builtin);
  for (const name of DATA_FILES) await cp(join(source, name), join(builtin, name));
  return {
    builtinDataDirectory: builtin,
    marketDataDirectory: join(root, 'App Data', 'market-data'),
  };
}

async function candidate(paths: MarketDataPaths): Promise<SnapshotCandidate> {
  const legacy = paths.legacyBuiltinDataDirectory ?? paths.builtinDataDirectory;
  const bars1 = parseEdbMinuteCsv(
    await readFile(join(legacy, 'edb_main_continuous_1m_raw.csv'), 'utf8'),
    '1m',
  );
  const bars5 = parseBars(
    await readFile(join(legacy, 'edb_main_continuous_5m.csv'), 'utf8'),
    '5m',
  );
  const bars60 = parseBars(
    await readFile(join(legacy, 'edb_main_continuous_60m.csv'), 'utf8'),
    '60m',
  );
  const rollovers = parseContractRollovers(
    await readFile(join(legacy, 'edb_main_continuous_rollovers.csv'), 'utf8'),
  );
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings: [
      { tradingDate: '2025-10-10', contract: 'm2601' },
      { tradingDate: '2025-12-04', contract: 'm2605' },
      { tradingDate: '2026-04-09', contract: 'm2609' },
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ],
    rollovers,
    requestStart: '2026-10-08 00:00:00',
    requestEnd: '2026-10-15 12:00:00',
    sourceLatestAt: '2026-10-09 15:00:00',
  };
}

function syntheticCandidate(
  minuteCount: number,
  requestStart = '2026-10-09 09:00:00',
): SnapshotCandidate {
  const startMs = parseBeijing('2026-10-09 09:00:00');
  const bars1 = Array.from({ length: minuteCount }, (_, index) => {
    const minuteStartMs = startMs + index * 60_000;
    const open = 2_500 + index;
    const close = open + 1;
    return {
      datetimeNano: (BigInt(minuteStartMs) * 1_000_000n).toString(),
      startMs: minuteStartMs,
      start: formatBeijing(minuteStartMs),
      open,
      high: close + 1,
      low: open - 1,
      close,
      volume: 10 + index,
      openOi: 100_000 + index,
      closeOi: 100_001 + index,
    };
  });
  const coverageEndMs = bars1.at(-1)!.startMs + 60_000;
  const bars5 = aggregateMinutes(
    bars1,
    5,
    coverageEndMs,
    DEFAULT_INSTRUMENT.tradingSessions,
  ).filter(bar => bar.complete);
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    DEFAULT_INSTRUMENT.tradingSessions,
  ).filter(bar => bar.complete);
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings: [
      { tradingDate: '2026-10-09', contract: 'm2701' },
    ],
    rollovers: [],
    requestStart,
    requestEnd: formatBeijing(coverageEndMs),
    sourceLatestAt: formatBeijing(coverageEndMs),
  };
}

async function syntheticFixture(): Promise<MarketDataPaths> {
  const root = await mkdtemp(join(tmpdir(), '行情 增量快照-'));
  temps.push(root);
  const paths = {
    builtinDataDirectory: join(root, 'builtin'),
    marketDataDirectory: join(root, 'market-data'),
  };
  await writeBuiltinMarketSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    syntheticCandidate(65),
    { now: () => new Date('2026-10-09T02:05:00.000Z') },
  );
  return paths;
}

async function saveSyntheticBase(
  paths: MarketDataPaths,
  snapshotId = 'base',
): Promise<LoadedMarketSnapshot> {
  return saveMarketSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    syntheticCandidate(65),
    {
      idFactory: () => snapshotId,
      now: () => new Date('2026-10-09T02:05:00.000Z'),
    },
  );
}

async function saveSyntheticTail(
  paths: MarketDataPaths,
  current: LoadedMarketSnapshot,
  minuteCount: number,
  snapshotId: string,
  minuteOffset: number,
  tailCompactionThreshold?: number,
): Promise<LoadedMarketSnapshot> {
  return saveMarketSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    syntheticCandidate(minuteCount, '2026-10-09 10:05:00'),
    {
      intent: 'tail',
      current,
      idFactory: () => snapshotId,
      now: () => new Date(
        Date.parse('2026-10-09T02:05:00.000Z') + minuteOffset * 60_000,
      ),
      tailCompactionThreshold,
    },
  );
}

function userDirectory(
  paths: MarketDataPaths,
  definition: InstrumentDefinition = DEFAULT_INSTRUMENT,
): string {
  return resolveInstrumentDataDirectories(paths, definition).user;
}

async function installInstrumentBaseline(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<void> {
  const directory = resolveInstrumentDataDirectories(paths, definition).builtin;
  await mkdir(directory, { recursive: true });
  const legacy = paths.legacyBuiltinDataDirectory ?? paths.builtinDataDirectory;
  const one = await readFile(join(legacy, 'edb_main_continuous_1m_raw.csv'), 'utf8');
  const five = await readFile(join(legacy, 'edb_main_continuous_5m.csv'), 'utf8');
  const sixty = await readFile(join(legacy, 'edb_main_continuous_60m.csv'), 'utf8');
  const rollovers = '\uFEFFtrading_date,time,from_contract,to_contract\r\n';
  const mappings = '\uFEFFtrading_date,contract\r\n';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const rows = (text: string) => text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).length - 1;
  await Promise.all([
    writeFile(join(directory, 'edb_main_continuous_1m_raw.csv'), one),
    writeFile(join(directory, 'edb_main_continuous_5m.csv'), five),
    writeFile(join(directory, 'edb_main_continuous_60m.csv'), sixty),
    writeFile(join(directory, 'edb_main_continuous_rollovers.csv'), rollovers),
    writeFile(join(directory, 'edb_main_contract_mapping.csv'), mappings),
    writeFile(join(directory, 'metadata.json'), `${JSON.stringify({
      schemaVersion: 4,
      snapshotId: `builtin-${definition.id}`,
      instrumentId: definition.id,
      mainSymbol: definition.mainSymbol,
      parameterVersion: definition.parameterVersion,
      source: {
        provider: 'EDB',
        endpoint: 'https://edb.shinnytech.com/md/kline',
        symbol: definition.mainSymbol,
      },
      generatedAt: '2026-10-18T00:00:00.000Z',
      requestStart: '2025-10-09 21:00:00',
      requestEnd: '2026-10-09 15:00:00',
      sourceLatestAt: '2026-10-09 15:00:00',
      files: {
        bars1: { name: 'edb_main_continuous_1m_raw.csv', sha256: hash(one), rows: rows(one) },
        bars5: { name: 'edb_main_continuous_5m.csv', sha256: hash(five), rows: rows(five) },
        bars60: { name: 'edb_main_continuous_60m.csv', sha256: hash(sixty), rows: rows(sixty) },
        rollovers: { name: 'edb_main_continuous_rollovers.csv', sha256: hash(rollovers), rows: 0 },
        mainContractMappings: { name: 'edb_main_contract_mapping.csv', sha256: hash(mappings), rows: 0 },
      },
    }, null, 2)}\n`),
  ]);
}

async function createLegacyGlobalSnapshot(
  paths: MarketDataPaths,
  snapshotId = 'old-global',
): Promise<string> {
  const seedPaths: MarketDataPaths = {
    builtinDataDirectory: paths.legacyBuiltinDataDirectory!,
    marketDataDirectory: join(paths.marketDataDirectory, '..', 'seed-market-data'),
  };
  const saved = await saveMarketSnapshot(
    seedPaths,
    DEFAULT_INSTRUMENT,
    await candidate(paths),
    {
      idFactory: () => snapshotId,
      now: () => new Date('2026-10-15T04:00:00.000Z'),
    },
  );
  const metadataPath = join(saved.directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.schemaVersion = 3;
  delete metadata.instrumentId;
  delete metadata.mainSymbol;
  delete metadata.parameterVersion;
  delete metadata.files.mainContractMappings;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await unlink(join(saved.directory, 'edb_main_contract_mapping.csv'));
  const legacySnapshot = join(paths.marketDataDirectory, 'snapshots', snapshotId);
  await mkdir(join(paths.marketDataDirectory, 'snapshots'), { recursive: true });
  await cp(saved.directory, legacySnapshot, { recursive: true });
  await writeFile(join(paths.marketDataDirectory, 'current.json'), `${JSON.stringify({
    schemaVersion: 3,
    snapshotId,
    updatedAt: '2026-10-15T04:00:00.000Z',
  }, null, 2)}\n`);
  return legacySnapshot;
}

interface GlassV7Data {
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  mainContractMappings: MainContractMapping[];
  rollovers: ContractRollover[];
  requestStart: string;
  requestEnd: string;
  sourceLatestAt: string;
}

interface ManualV7Snapshot {
  directory: string;
  metadata: MarketSnapshotMetadataV7Full | MarketSnapshotMetadataV7Tail;
  metadataText: string;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function glassV7Data(
  minuteCount: number,
  protectedMinuteMismatch = true,
): GlassV7Data {
  const startMs = parseBeijing('2026-10-09 09:00:00');
  const bars1 = Array.from({ length: minuteCount }, (_, index) => {
    const breakOffsetMs = index >= 75 ? 15 * 60_000 : 0;
    const minuteStartMs = startMs + index * 60_000 + breakOffsetMs;
    const open = 1_500 + index;
    const close = open + 1;
    return {
      datetimeNano: (BigInt(minuteStartMs) * 1_000_000n).toString(),
      startMs: minuteStartMs,
      start: formatBeijing(minuteStartMs),
      open,
      high: close + 1,
      low: open - 1,
      close,
      volume: 20 + index,
      openOi: 80_000 + index,
      closeOi: 80_001 + index,
    };
  });
  const coverageEndMs = bars1.at(-1)!.startMs + 60_000;
  const bars5 = aggregateMinutes(
    bars1,
    5,
    coverageEndMs,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  if (protectedMinuteMismatch) {
    bars5[0] = {
      ...bars5[0],
      open: bars5[0].open + 20,
      high: bars5[0].high + 25,
      low: bars5[0].low + 15,
      close: bars5[0].close + 20,
      volume: bars5[0].volume + 100,
    };
  }
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings: [
      { tradingDate: '2026-10-09', contract: 'FG2609' },
      { tradingDate: '2026-10-12', contract: 'FG2701' },
    ],
    rollovers: [{
      tradingDate: '2026-10-12',
      time: '2026-10-12 09:00:00',
      timeMs: parseBeijing('2026-10-12 09:00:00'),
      fromContract: 'FG2609',
      toContract: 'FG2701',
    }],
    requestStart: '2026-10-09 09:00:00',
    requestEnd: formatBeijing(coverageEndMs),
    sourceLatestAt: formatBeijing(coverageEndMs),
  };
}

function glassBenchmarkSourceSegment(): MarketSnapshotSourceSegment {
  return {
    sourceId: 'ths-fg9999',
    sourceName: '同花顺 FG9999 玻璃主连',
    kind: 'benchmark-main',
    sourceVersion: 'fixture-v1',
    acquiredAt: '2026-10-23T00:00:00.000Z',
    coverage: {
      first: '2026-10-09 09:00:00',
      last: '2026-10-09 10:00:00',
    },
    rawFiles: [{
      name: 'ths-fg9999-page-1.json',
      sha256: 'b'.repeat(64),
      rows: 12,
    }],
    importerVersion: 'market-snapshot-test-v7',
    license: {
      identifier: 'THS local test fixture',
      redistributionAllowed: false,
      conclusion: '仅用于本机测试，不允许再分发。',
    },
  };
}

function glassBenchmarkProtection(): MarketSnapshotBenchmarkProtection {
  return {
    provider: 'THS',
    sourceSegmentId: 'ths-fg9999',
    bars5: {
      firstStart: '2026-10-09 09:00:00',
      lastEnd: '2026-10-09 10:00:00',
      protectedFields: ['open', 'high', 'low', 'close', 'volume'],
    },
    bars60: {
      firstStart: '2026-10-09 09:00:00',
      lastEnd: '2026-10-09 10:00:00',
      derivedFrom: 'bars5',
    },
    mappings: {
      firstTradingDate: '2026-10-09',
      lastTradingDate: '2026-10-12',
    },
    rollovers: {
      firstTradingDate: '2026-10-12',
      lastTradingDate: '2026-10-12',
    },
    minutePolicy: 'preserved-audit-only',
    reportSha256: 'c'.repeat(64),
    redistribution: {
      allowed: false,
      conclusion: '同花顺基准只允许当前用户本机使用。',
    },
  };
}

function v7Periods(data: GlassV7Data) {
  return {
    bars1: data.bars1.length ? {
      first: data.bars1[0].start,
      last: data.bars1.at(-1)!.start,
      rows: data.bars1.length,
    } : undefined,
    bars5: {
      first: data.bars5[0].start,
      last: data.bars5.at(-1)!.end,
      rows: data.bars5.length,
    },
    bars60: {
      first: data.bars60[0].start,
      last: data.bars60.at(-1)!.end,
      rows: data.bars60.length,
    },
  };
}

async function writeManualV7Snapshot(
  paths: MarketDataPaths,
  snapshotId: string,
  storage: MarketSnapshotMetadataV7Full['storage']
    | MarketSnapshotMetadataV7Tail['storage'],
  persisted: GlassV7Data,
  merged: GlassV7Data,
  options: {
    activatedAt?: string;
    benchmarkProtection?: MarketSnapshotBenchmarkProtection;
    sourceSegments?: MarketSnapshotSourceSegment[];
  } = {},
): Promise<ManualV7Snapshot> {
  const marketDirectory = userDirectory(paths, GLASS);
  const directory = join(marketDirectory, 'snapshots', snapshotId);
  const oneText = serializeMinuteRecords(persisted.bars1, GLASS.tradingSessions);
  const fiveText = serializeBars(persisted.bars5);
  const sixtyText = serializeBars(persisted.bars60);
  const rolloverText = serializeContractRollovers(persisted.rollovers, GLASS);
  const mappingText = serializeMainContractMappings(
    persisted.mainContractMappings,
    GLASS,
  );
  const common = {
    schemaVersion: 7 as const,
    snapshotId,
    instrumentId: GLASS.id,
    mainSymbol: GLASS.mainSymbol,
    parameterVersion: GLASS.parameterVersion,
    source: {
      provider: 'MIXED' as const,
      endpoint: 'https://edb.shinnytech.com/md/kline' as const,
      symbol: GLASS.mainSymbol,
    },
    generatedAt: options.activatedAt ?? '2026-10-23T00:00:00.000Z',
    requestStart: merged.requestStart,
    requestEnd: merged.requestEnd,
    sourceLatestAt: merged.sourceLatestAt,
    sourceSegments: options.sourceSegments ?? [glassBenchmarkSourceSegment()],
    redistribution: {
      allowed: false,
      conclusion: '至少一个来源未确认允许随产品再分发。',
    },
    periods: v7Periods(merged),
    benchmarkProtection: options.benchmarkProtection ?? glassBenchmarkProtection(),
  };
  const files = {
    bars1: {
      name: ONE_MINUTE_FILE,
      sha256: sha256Text(oneText),
      rows: persisted.bars1.length,
    },
    bars5: {
      name: FIVE_MINUTE_FILE,
      sha256: sha256Text(fiveText),
      rows: persisted.bars5.length,
    },
    bars60: {
      name: SIXTY_MINUTE_FILE,
      sha256: sha256Text(sixtyText),
      rows: persisted.bars60.length,
    },
    rollovers: {
      name: ROLLOVER_FILE,
      sha256: sha256Text(rolloverText),
      rows: persisted.rollovers.length,
    },
    mainContractMappings: {
      name: MAPPING_FILE,
      sha256: sha256Text(mappingText),
      rows: persisted.mainContractMappings.length,
    },
  };
  const metadata = storage.kind === 'full'
    ? { ...common, storage, files } satisfies MarketSnapshotMetadataV7Full
    : { ...common, storage, files } satisfies MarketSnapshotMetadataV7Tail;
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  const activatedAt = options.activatedAt ?? '2026-10-23T00:00:00.000Z';
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, ONE_MINUTE_FILE), oneText),
    writeFile(join(directory, FIVE_MINUTE_FILE), fiveText),
    writeFile(join(directory, SIXTY_MINUTE_FILE), sixtyText),
    writeFile(join(directory, ROLLOVER_FILE), rolloverText),
    writeFile(join(directory, MAPPING_FILE), mappingText),
    writeFile(join(directory, 'metadata.json'), metadataText),
    writeFile(join(directory, 'activated.json'), `${JSON.stringify({
      snapshotId,
      activatedAt,
    }, null, 2)}\n`),
  ]);
  await writeFile(join(marketDirectory, 'current.json'), `${JSON.stringify({
    schemaVersion: 7,
    snapshotId,
    updatedAt: activatedAt,
  }, null, 2)}\n`);
  return { directory, metadata, metadataText };
}

async function glassV7Fixture(): Promise<{
  paths: MarketDataPaths;
  data: GlassV7Data;
  base: ManualV7Snapshot;
}> {
  const root = await mkdtemp(join(tmpdir(), '玻璃 v7 快照-'));
  temps.push(root);
  const paths: MarketDataPaths = {
    builtinDataDirectory: join(root, 'builtin'),
    marketDataDirectory: join(root, 'market-data'),
  };
  const data = glassV7Data(65);
  const base = await writeManualV7Snapshot(
    paths,
    'v7-base',
    { kind: 'full' },
    data,
    data,
    { activatedAt: '2026-10-23T00:00:00.000Z' },
  );
  return { paths, data, base };
}

function v7TailData(data: GlassV7Data, cutoff: string): GlassV7Data {
  const cutoffMs = parseBeijing(cutoff);
  return {
    ...data,
    bars1: data.bars1.filter(record => record.startMs >= cutoffMs),
    bars5: data.bars5.filter(bar => bar.startMs >= cutoffMs),
    bars60: data.bars60.filter(bar => bar.startMs >= cutoffMs),
  };
}

async function emptyGlassPaths(): Promise<MarketDataPaths> {
  const root = await mkdtemp(join(tmpdir(), '玻璃 v7 保存-'));
  temps.push(root);
  return {
    builtinDataDirectory: join(root, 'builtin'),
    marketDataDirectory: join(root, 'market-data'),
  };
}

function glassProtectedCandidate(
  data: GlassV7Data,
  requestStart = data.requestStart,
): SnapshotCandidate {
  return {
    ...data,
    requestStart,
    source: {
      provider: 'MIXED',
      endpoint: 'https://edb.shinnytech.com/md/kline',
      symbol: GLASS.mainSymbol,
    },
    sourceSegments: [glassBenchmarkSourceSegment()],
    redistribution: {
      allowed: false,
      conclusion: '至少一个来源未确认允许随产品再分发。',
    },
    benchmarkProtection: glassBenchmarkProtection(),
  };
}

async function cloneBrokenV7Snapshot(
  paths: MarketDataPaths,
  sourceDirectory: string,
  snapshotId: string,
  mutate: (metadata: Record<string, any>, directory: string) => void | Promise<void>,
): Promise<void> {
  const marketDirectory = userDirectory(paths, GLASS);
  const directory = join(marketDirectory, 'snapshots', snapshotId);
  await cp(sourceDirectory, directory, { recursive: true });
  const metadataPath = join(directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.snapshotId = snapshotId;
  await mutate(metadata, directory);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const activatedAt = '2026-10-23T00:05:00.000Z';
  await writeFile(join(directory, 'activated.json'), `${JSON.stringify({
    snapshotId,
    activatedAt,
  }, null, 2)}\n`);
  await writeFile(join(marketDirectory, 'current.json'), `${JSON.stringify({
    schemaVersion: 7,
    snapshotId,
    updatedAt: activatedAt,
  }, null, 2)}\n`);
}

async function cloneActivatedGlassSnapshot(
  paths: MarketDataPaths,
  sourceDirectory: string,
  snapshotId: string,
  activatedAt: string,
  mutate?: (
    directory: string,
    metadata: Record<string, any>,
  ) => void | Promise<void>,
): Promise<string> {
  const directory = join(
    userDirectory(paths, GLASS),
    'snapshots',
    snapshotId,
  );
  await cp(sourceDirectory, directory, { recursive: true });
  const metadataPath = join(directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.snapshotId = snapshotId;
  await mutate?.(directory, metadata);
  await Promise.all([
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
    writeFile(join(directory, 'activated.json'), `${JSON.stringify({
      snapshotId,
      activatedAt,
    }, null, 2)}\n`),
  ]);
  return directory;
}

async function writeGlassActivationReport(
  paths: MarketDataPaths,
  snapshot: ManualV7Snapshot,
  runId = 'repair-run',
): Promise<void> {
  const reportsDirectory = join(
    paths.marketDataDirectory,
    'repairs',
    GLASS.id,
    runId,
    'reports',
  );
  await mkdir(reportsDirectory, { recursive: true });
  await writeFile(
    join(reportsDirectory, 'activation.json'),
    `${JSON.stringify({
      snapshotId: snapshot.metadata.snapshotId,
      metadataSha256: sha256Text(snapshot.metadataText),
    }, null, 2)}\n`,
  );
}

describe('market snapshot paths', () => {
  it('resolves development and packaged paths independently from cwd', () => {
    expect(resolveMarketDataPaths(
      'C:\\中文 空格\\MoneyComing\\MoneyComing.exe',
      true,
      'D:\\dev',
      'C:\\Users\\测试\\AppData\\Roaming\\MoneyComing',
    )).toEqual({
      builtinDataDirectory: 'C:\\中文 空格\\MoneyComing\\data',
      marketDataDirectory: 'C:\\Users\\测试\\AppData\\Roaming\\MoneyComing\\market-data',
      legacyBuiltinDataDirectory: 'C:\\中文 空格\\MoneyComing\\data',
    });
    expect(resolveMarketDataPaths('ignored', false, 'D:\\项目', 'E:\\用户 数据')).toEqual({
      builtinDataDirectory: 'D:\\项目\\data',
      marketDataDirectory: 'E:\\用户 数据\\market-data',
      legacyBuiltinDataDirectory: 'D:\\项目\\futures_investigation_20261009',
    });
  });
});

describe('versioned market snapshots', () => {
  it('keeps a staged snapshot invisible and loads it only after the pointer switch', async () => {
    const paths = await fixture();
    const before = await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT);
    let observedSource = '';
    const saved = await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      {
        now: () => new Date('2026-10-15T04:00:00.000Z'),
        idFactory: () => 'snapshot-a',
        beforePointerSwitch: async () => {
          observedSource = (await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).source;
        },
      },
    );
    expect(before.source).toBe('builtin');
    expect(observedSource).toBe('builtin');
    expect(saved).toMatchObject({ source: 'user', snapshotUpdatedAt: '2026-10-15T04:00:00.000Z' });
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory).toContain('snapshot-a');
  }, SNAPSHOT_IO_TIMEOUT);

  it('falls back from a broken pointer or corrupt current snapshot to the previous complete snapshot', async () => {
    const paths = await fixture();
    await saveMarketSnapshot(paths, DEFAULT_INSTRUMENT, await candidate(paths), {
      now: () => new Date('2026-10-15T01:00:00.000Z'),
      idFactory: () => 'snapshot-old',
    });
    await saveMarketSnapshot(paths, DEFAULT_INSTRUMENT, await candidate(paths), {
      now: () => new Date('2026-10-15T02:00:00.000Z'),
      idFactory: () => 'snapshot-new',
    });
    await writeFile(join(userDirectory(paths), 'current.json'), '{bad json');
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory).toContain('snapshot-new');
    await writeFile(
      join(userDirectory(paths), 'snapshots', 'snapshot-new', 'edb_main_contract_mapping.csv'),
      'corrupt',
    );
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory).toContain('snapshot-old');
  }, SNAPSHOT_IO_TIMEOUT);

  it.each([
    ['missing file', async (paths: MarketDataPaths) => unlink(join(userDirectory(paths), 'snapshots', 'snapshot-a', 'edb_main_continuous_5m.csv'))],
    ['unknown schema', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'metadata.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.schemaVersion = 99;
      await writeFile(file, JSON.stringify(metadata));
    }],
    ['hash mismatch', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'edb_main_continuous_5m.csv');
      await writeFile(file, `${await readFile(file, 'utf8')}\n`);
    }],
    ['minute row mismatch', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'metadata.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.files.bars1.rows += 1;
      await writeFile(file, JSON.stringify(metadata));
    }],
    ['rollover hash mismatch', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'edb_main_continuous_rollovers.csv');
      await writeFile(file, `${await readFile(file, 'utf8')}\n`);
    }],
    ['mapping missing', async (paths: MarketDataPaths) => {
      await unlink(join(userDirectory(paths), 'snapshots', 'snapshot-a', 'edb_main_contract_mapping.csv'));
    }],
    ['mapping row mismatch', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'metadata.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.files.mainContractMappings.rows += 1;
      await writeFile(file, JSON.stringify(metadata));
    }],
    ['symbol mismatch', async (paths: MarketDataPaths) => {
      const file = join(userDirectory(paths), 'snapshots', 'snapshot-a', 'metadata.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.source.symbol = 'KQ.m@SHFE.rb';
      await writeFile(file, JSON.stringify(metadata));
    }],
  ])(
    'falls back to the built-in baseline on %s without a previous user snapshot',
    async (_name, breakSnapshot) => {
      const paths = await fixture();
      await saveMarketSnapshot(
        paths,
        DEFAULT_INSTRUMENT,
        await candidate(paths),
        { idFactory: () => 'snapshot-a' },
      );
      await breakSnapshot(paths);
      expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).source).toBe('builtin');
    },
    SNAPSHOT_IO_TIMEOUT,
  );

  it('writes and loads a schema 5 baseline without a one-minute file', async () => {
    const root = await mkdtemp(join(tmpdir(), '行情 无一分钟快照-'));
    temps.push(root);
    const paths: MarketDataPaths = {
      builtinDataDirectory: join(root, 'data'),
      marketDataDirectory: join(root, 'market-data'),
    };
    const sourceCandidate = syntheticCandidate(65);
    const saved = await writeBuiltinMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      {
        ...sourceCandidate,
        bars1: [],
        bars60: [],
        source: {
          provider: 'MIXED',
          symbol: DEFAULT_INSTRUMENT.mainSymbol,
        },
        sourceSegments: [{
          sourceId: 'desktop-main-test',
          sourceName: '桌面主连测试数据',
          kind: 'desktop-main',
          sourceVersion: 'test-v1',
          acquiredAt: '2026-10-09',
          coverage: {
            first: sourceCandidate.bars5[0].start,
            last: sourceCandidate.bars5.at(-1)!.end,
          },
          rawFiles: [{
            name: 'desktop-main.csv',
            sha256: 'a'.repeat(64),
            rows: sourceCandidate.bars5.length,
          }],
          importerVersion: 'test-v1',
          license: {
            redistributionAllowed: false,
            conclusion: '仅用于验证本机基线加载。',
          },
        }],
        redistribution: {
          allowed: false,
          conclusion: '仅用于验证本机基线加载。',
        },
      },
      { now: () => new Date('2026-10-09T02:05:00.000Z') },
    );

    expect(saved.metadata).toMatchObject({
      schemaVersion: 5,
      periods: {
        bars5: {
          first: sourceCandidate.bars5[0].start,
          rows: sourceCandidate.bars5.length,
        },
      },
    });
    if (saved.metadata?.schemaVersion !== 5) throw new Error('expected schema 5');
    expect(saved.metadata.files.bars1).toBeUndefined();
    expect(saved.metadata.periods.bars1).toBeUndefined();
    expect(saved.metadata.sourceSegments[0].kind).toBe('desktop-main');
    expect(saved.metadata.redistribution.allowed).toBe(false);
    await expect(readFile(
      join(saved.directory, 'edb_main_continuous_1m_raw.csv'),
    )).rejects.toThrow();
    await expect(loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT))
      .resolves.toMatchObject({
        source: 'builtin',
        bars1: [],
        bars5: sourceCandidate.bars5,
      });
  }, SNAPSHOT_IO_TIMEOUT);

  it('keeps long 5/60-minute history with only a recent one-minute overlap', async () => {
    const paths = await fixture();
    const fullCandidate = await candidate(paths);
    const recentMinutes = fullCandidate.bars1.slice(-60);
    const saved = await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      {
        ...fullCandidate,
        bars1: recentMinutes,
        bars60: [],
      },
      {
        idFactory: () => 'partial-one-minute',
        now: () => new Date('2026-10-15T04:00:00.000Z'),
      },
    );

    expect(saved.bars5[0].start < saved.bars1[0].start).toBe(true);
    expect(saved.metadata).toMatchObject({
      schemaVersion: 5,
      periods: {
        bars1: {
          first: recentMinutes[0].start,
          last: recentMinutes.at(-1)!.start,
          rows: recentMinutes.length,
        },
        bars5: {
          first: fullCandidate.bars5[0].start,
          last: fullCandidate.bars5.at(-1)!.end,
          rows: fullCandidate.bars5.length,
        },
      },
    });
    await expect(loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT))
      .resolves.toMatchObject({
        source: 'user',
        bars1: recentMinutes,
        bars5: fullCandidate.bars5,
      });
  }, SNAPSHOT_IO_TIMEOUT);

  it('upgrades a shorter user snapshot with the built-in history while preserving its newer tail once', async () => {
    const paths = await fixture();
    const full = await candidate(paths);
    const completeSixty = full.bars60.slice(-25);
    const completeStartMs = completeSixty[0].startMs;
    const completeEndMs = completeSixty.at(-1)!.endMs;
    const builtinEndMs = completeSixty.at(-3)!.endMs;
    const userStartMs = completeSixty.at(-10)!.startMs;
    const completeBars = full.bars5.filter(bar => (
      bar.startMs >= completeStartMs
      && bar.endMs <= completeEndMs
    ));
    const builtinBars = completeBars.filter(bar => bar.endMs <= builtinEndMs);
    const mapping = [{
      tradingDate: builtinBars[0].start.slice(0, 10),
      contract: 'm2701',
    }];
    await writeBuiltinMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      {
        bars1: full.bars1.filter(record => (
          record.startMs >= builtinBars[0].startMs
          && record.startMs < builtinEndMs
        )),
        bars5: builtinBars,
        bars60: [],
        mainContractMappings: mapping,
        rollovers: [],
        requestStart: builtinBars[0].start,
        requestEnd: builtinBars.at(-1)!.end,
        sourceLatestAt: builtinBars.at(-1)!.end,
      },
      { now: () => new Date('2026-10-20T00:00:00.000Z') },
    );
    const userBars = completeBars
      .filter(bar => bar.startMs >= userStartMs)
      .map(bar => ({ ...bar }));
    const overlappingStart = userBars[10].start;
    userBars[10] = {
      ...userBars[10],
      volume: userBars[10].volume + 123,
    };
    const shortUser = await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      {
        bars1: full.bars1.filter(record => record.startMs >= builtinEndMs),
        bars5: userBars,
        bars60: [],
        mainContractMappings: mapping,
        rollovers: [],
        requestStart: userBars[0].start,
        requestEnd: userBars.at(-1)!.end,
        sourceLatestAt: userBars.at(-1)!.end,
      },
      {
        idFactory: () => 'short-user',
        now: () => new Date('2026-10-22T08:00:00.000Z'),
      },
    );

    const [first, concurrent] = await Promise.all([
      loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT),
      loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT),
    ]);
    expect(first.directory).toBe(concurrent.directory);
    expect(first.directory).not.toBe(shortUser.directory);
    expect(first.metadata?.schemaVersion).toBe(5);
    expect(first.bars5[0].start).toBe(builtinBars[0].start);
    expect(first.bars5.at(-1)!.end).toBe(completeBars.at(-1)!.end);
    expect(first.bars5.find(bar => bar.start === overlappingStart)?.volume)
      .toBe(completeBars.find(bar => bar.start === overlappingStart)?.volume);
    expect(first.bars1[0].startMs).toBeGreaterThanOrEqual(builtinBars[0].startMs);
    expect(first.bars1.at(-1)!.startMs).toBeGreaterThanOrEqual(builtinEndMs);

    const pointerAfterUpgrade = JSON.parse(
      await readFile(join(userDirectory(paths), 'current.json'), 'utf8'),
    );
    expect(pointerAfterUpgrade.snapshotId).not.toBe('short-user');
    const loadedAgain = await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT);
    expect(loadedAgain.directory).toBe(first.directory);
    expect(JSON.parse(
      await readFile(join(userDirectory(paths), 'current.json'), 'utf8'),
    )).toEqual(pointerAfterUpgrade);
  }, SNAPSHOT_IO_TIMEOUT);

  it.each([1, 2, 3, 4] as const)(
    'loads schema %i user prices while deriving missing newer fields',
    async schemaVersion => {
      const paths = await fixture();
      const saved = await saveMarketSnapshot(
        paths,
        DEFAULT_INSTRUMENT,
        await candidate(paths),
        {
          idFactory: () => `legacy-schema-${schemaVersion}`,
          now: () => new Date('2026-10-15T04:00:00.000Z'),
        },
      );
      const metadataPath = join(saved.directory, 'metadata.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      metadata.schemaVersion = schemaVersion;
      if (schemaVersion < 4) {
        delete metadata.instrumentId;
        delete metadata.mainSymbol;
        delete metadata.parameterVersion;
        delete metadata.files.mainContractMappings;
      }
      if (schemaVersion < 3) delete metadata.files.bars1;
      if (schemaVersion === 1) delete metadata.files.rollovers;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      if (schemaVersion < 4) {
        await unlink(join(saved.directory, 'edb_main_contract_mapping.csv'));
      }
      if (schemaVersion < 3) await unlink(join(saved.directory, 'edb_main_continuous_1m_raw.csv'));
      if (schemaVersion === 1) await unlink(join(saved.directory, 'edb_main_continuous_rollovers.csv'));
      await writeFile(join(userDirectory(paths), 'current.json'), `${JSON.stringify({
        schemaVersion,
        snapshotId: `legacy-schema-${schemaVersion}`,
        updatedAt: '2026-10-15T04:00:00.000Z',
      }, null, 2)}\n`);

      const loaded = await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT);
      expect(loaded.source).toBe('user');
      expect(loaded.bars1).toHaveLength(82_650);
      expect(loaded.mainContractMappings.length).toBeGreaterThan(0);
      expect(loaded.rollovers.map(item => `${item.fromContract}->${item.toContract}`)).toEqual([
        'm2601->m2605',
        'm2605->m2609',
        'm2609->m2701',
      ]);
    },
    SNAPSHOT_IO_TIMEOUT,
  );

  it('does not activate a snapshot when saving fails before pointer replacement', async () => {
    const paths = await fixture();
    await expect(saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      {
        idFactory: () => 'snapshot-failed',
        beforePointerSwitch: () => {
          throw new Error('simulated disk failure');
        },
      },
    )).rejects.toThrow(/disk failure/);
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).source).toBe('builtin');
  }, SNAPSHOT_IO_TIMEOUT);

  it('keeps the current and one previous activated snapshot during cleanup', async () => {
    const paths = await fixture();
    for (const [id, hour] of [['one', 1], ['two', 2], ['three', 3]] as const) {
      await saveMarketSnapshot(paths, DEFAULT_INSTRUMENT, await candidate(paths), {
        idFactory: () => id,
        now: () => new Date(`2026-10-15T0${hour}:00:00.000Z`),
      });
    }
    await cleanupSnapshots(paths, DEFAULT_INSTRUMENT, 'three');
    await expect(readFile(join(userDirectory(paths), 'snapshots', 'three', 'metadata.json'))).resolves.toBeTruthy();
    await expect(readFile(join(userDirectory(paths), 'snapshots', 'two', 'metadata.json'))).resolves.toBeTruthy();
    await expect(readFile(join(userDirectory(paths), 'snapshots', 'one', 'metadata.json'))).rejects.toThrow();
  }, SNAPSHOT_IO_TIMEOUT);

  it('writes schema 5 identity fields and hashes for every persisted file', async () => {
    const paths = await fixture();
    const saved = await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      { idFactory: () => 'snapshot-hash' },
    );
    const metadata = saved.metadata!;
    expect(metadata).toMatchObject({
      schemaVersion: 5,
      instrumentId: 'main_continuous',
      mainSymbol: 'KQ.m@DCE.m',
      parameterVersion: 1,
    });
    if (metadata.schemaVersion !== 5) throw new Error('expected schema 5');
    for (const file of Object.values(metadata.files)) {
      if (!file) continue;
      const contents = await readFile(join(saved.directory, file.name));
      expect(createHash('sha256').update(contents).digest('hex')).toBe(file.sha256);
    }
    expect(saved.mainContractMappings).toHaveLength(4);
    expect(await snapshotFingerprint(saved.directory)).toHaveProperty('edb_main_contract_mapping.csv');
  }, SNAPSHOT_IO_TIMEOUT);

  it('isolates one instrument corruption from another instrument snapshot', async () => {
    const paths = await fixture();
    const rebar = INSTRUMENT_DEFINITIONS.rebar_main;
    await installInstrumentBaseline(paths, rebar);
    await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      { idFactory: () => 'soymeal-user' },
    );
    const rebarCandidate = {
      ...await candidate(paths),
      mainContractMappings: [],
      rollovers: [],
    };
    await saveMarketSnapshot(paths, rebar, rebarCandidate, { idFactory: () => 'rebar-user' });
    await writeFile(
      join(userDirectory(paths), 'snapshots', 'soymeal-user', 'edb_main_continuous_5m.csv'),
      'corrupt',
    );
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).source).toBe('builtin');
    expect((await loadEffectiveSnapshot(paths, rebar))).toMatchObject({
      source: 'user',
      directory: expect.stringContaining('rebar-user'),
    });
  }, SNAPSHOT_IO_TIMEOUT);
});

describe('schema 7 protected benchmark snapshots', () => {
  it('saves the first protected repair as a full v7 snapshot', async () => {
    const paths = await emptyGlassPaths();
    const saved = await saveMarketSnapshot(
      paths,
      GLASS,
      glassProtectedCandidate(glassV7Data(65)),
      {
        idFactory: () => 'saved-v7-full',
        now: () => new Date('2026-10-23T00:00:00.000Z'),
      },
    );

    expect(saved.metadata).toMatchObject({
      schemaVersion: 7,
      storage: { kind: 'full' },
      benchmarkProtection: glassBenchmarkProtection(),
    });
    expect(saved.bars60).toEqual(
      aggregateFiveMinuteBars(
        saved.bars5,
        GLASS.tradingSessions,
      ).filter(bar => bar.complete),
    );
    expect(JSON.parse(await readFile(
      join(userDirectory(paths, GLASS), 'current.json'),
      'utf8',
    ))).toMatchObject({
      schemaVersion: 7,
      snapshotId: 'saved-v7-full',
    });
  });

  it('writes consecutive v7 tails against the original full base and compacts to v7', async () => {
    const paths = await emptyGlassPaths();
    const base = await saveMarketSnapshot(
      paths,
      GLASS,
      glassProtectedCandidate(glassV7Data(65)),
      {
        idFactory: () => 'saved-v7-base',
        now: () => new Date('2026-10-23T00:00:00.000Z'),
      },
    );
    const first = await saveMarketSnapshot(
      paths,
      GLASS,
      {
        ...glassV7Data(70),
        requestStart: '2026-10-09 10:05:00',
      },
      {
        intent: 'tail',
        current: base,
        idFactory: () => 'saved-v7-tail-one',
        now: () => new Date('2026-10-23T00:05:00.000Z'),
        tailCompactionThreshold: 3,
      },
    );
    const second = await saveMarketSnapshot(
      paths,
      GLASS,
      {
        ...glassV7Data(75),
        requestStart: '2026-10-09 10:10:00',
      },
      {
        intent: 'tail',
        current: first,
        idFactory: () => 'saved-v7-tail-two',
        now: () => new Date('2026-10-23T00:10:00.000Z'),
        tailCompactionThreshold: 3,
      },
    );
    const compacted = await saveMarketSnapshot(
      paths,
      GLASS,
      {
        ...glassV7Data(80),
        requestStart: '2026-10-09 10:30:00',
      },
      {
        intent: 'tail',
        current: second,
        idFactory: () => 'saved-v7-compacted',
        now: () => new Date('2026-10-23T00:15:00.000Z'),
        tailCompactionThreshold: 3,
      },
    );

    expect(first.metadata).toMatchObject({
      schemaVersion: 7,
      storage: {
        kind: 'tail',
        base: { snapshotId: 'saved-v7-base' },
        replacementCutoff: '2026-10-09 10:05:00',
        layerSequence: 1,
      },
    });
    expect(second.metadata).toMatchObject({
      schemaVersion: 7,
      storage: {
        kind: 'tail',
        base: { snapshotId: 'saved-v7-base' },
        replacementCutoff: '2026-10-09 10:05:00',
        layerSequence: 2,
      },
    });
    expect(second.metadata?.schemaVersion).toBe(7);
    expect(second.metadata && 'benchmarkProtection' in second.metadata
      ? second.metadata.benchmarkProtection
      : undefined).toEqual(glassBenchmarkProtection());
    expect(compacted.metadata).toMatchObject({
      schemaVersion: 7,
      storage: { kind: 'full' },
      benchmarkProtection: glassBenchmarkProtection(),
    });
    expect(compacted.bars1).toHaveLength(80);
  });

  it('keeps the previous protected snapshot across activation failures and duplicate ids', async () => {
    const paths = await emptyGlassPaths();
    const base = await saveMarketSnapshot(
      paths,
      GLASS,
      glassProtectedCandidate(glassV7Data(65)),
      {
        idFactory: () => 'stable-v7-base',
        now: () => new Date('2026-10-23T00:00:00.000Z'),
      },
    );
    const baseFingerprint = await snapshotFingerprint(base.directory);
    const nextCandidate = {
      ...glassV7Data(70),
      requestStart: '2026-10-09 10:05:00',
    };

    await expect(saveMarketSnapshot(
      paths,
      GLASS,
      nextCandidate,
      {
        intent: 'tail',
        current: base,
        idFactory: () => 'before-switch-failure',
        beforePointerSwitch: () => {
          throw new Error('切换前失败');
        },
      },
    )).rejects.toThrow('切换前失败');
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);

    const postSwitchId = 'after-switch-failure';
    await expect(saveMarketSnapshot(
      paths,
      GLASS,
      nextCandidate,
      {
        intent: 'tail',
        current: base,
        idFactory: () => postSwitchId,
        onTiming: phase => {
          if (phase === 'activation') {
            writeFileSync(
              join(
                userDirectory(paths, GLASS),
                'snapshots',
                postSwitchId,
                FIVE_MINUTE_FILE,
              ),
              'corrupt',
            );
          }
        },
      },
    )).rejects.toThrow('快照文件哈希不一致');
    expect(JSON.parse(await readFile(
      join(userDirectory(paths, GLASS), 'current.json'),
      'utf8',
    )).snapshotId).toBe('stable-v7-base');
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);

    await expect(saveMarketSnapshot(
      paths,
      GLASS,
      glassProtectedCandidate(glassV7Data(65)),
      {
        idFactory: () => 'stable-v7-base',
      },
    )).rejects.toThrow('快照标识已存在');
    expect(await snapshotFingerprint(base.directory)).toEqual(baseFingerprint);
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);
  });

  it('rejects protected saves for other instruments and protected mutations in a v7 tail', async () => {
    const paths = await emptyGlassPaths();
    const protectedCandidate = glassProtectedCandidate(glassV7Data(65));
    await expect(saveMarketSnapshot(
      paths,
      INSTRUMENT_DEFINITIONS.rebar_main,
      {
        ...protectedCandidate,
        mainContractMappings: [],
        rollovers: [],
      },
      { idFactory: () => 'invalid-rebar-v7' },
    )).rejects.toThrow('仅支持玻璃主连');

    const base = await saveMarketSnapshot(
      paths,
      GLASS,
      protectedCandidate,
      {
        idFactory: () => 'mutation-base',
        now: () => new Date('2026-10-23T00:00:00.000Z'),
      },
    );
    const changed = glassV7Data(70);
    changed.bars5[0] = {
      ...changed.bars5[0],
      close: changed.bars5[0].close + 1,
    };
    await expect(saveMarketSnapshot(
      paths,
      GLASS,
      {
        ...changed,
        requestStart: '2026-10-09 10:05:00',
      },
      {
        intent: 'tail',
        current: base,
        idFactory: () => 'mutated-v7-tail',
      },
    )).rejects.toThrow('受保护 5 分钟字段');
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);
  });

  it('loads a valid full snapshot while treating protected minute differences as audit-only', async () => {
    const { paths, data, base } = await glassV7Fixture();

    const loaded = await loadEffectiveSnapshot(paths, GLASS);

    expect(loaded).toMatchObject({
      source: 'user',
      directory: base.directory,
      metadata: {
        schemaVersion: 7,
        storage: { kind: 'full' },
        benchmarkProtection: {
          provider: 'THS',
          minutePolicy: 'preserved-audit-only',
        },
      },
    });
    expect(loaded.bars1).toHaveLength(65);
    expect(loaded.bars5[0]).toMatchObject(data.bars5[0]);
    expect(loaded.bars5[0].open).not.toBe(data.bars1[0].open);
  });

  it('loads a valid v7 tail that directly references a v7 full base', async () => {
    const { paths, base } = await glassV7Fixture();
    const merged = glassV7Data(70);
    const cutoff = '2026-10-09 10:05:00';
    const tail = await writeManualV7Snapshot(
      paths,
      'v7-tail',
      {
        kind: 'tail',
        base: {
          snapshotId: base.metadata.snapshotId,
          metadataSha256: sha256Text(base.metadataText),
        },
        replacementCutoff: cutoff,
        layerSequence: 1,
      },
      v7TailData(merged, cutoff),
      merged,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );

    const loaded = await loadEffectiveSnapshot(paths, GLASS);

    expect(loaded).toMatchObject({
      source: 'user',
      directory: tail.directory,
      metadata: {
        schemaVersion: 7,
        storage: {
          kind: 'tail',
          base: { snapshotId: 'v7-base' },
          replacementCutoff: cutoff,
          layerSequence: 1,
        },
      },
    });
    expect(loaded.bars1).toHaveLength(70);
    expect(loaded.bars5).toHaveLength(14);
    expect(loaded.bars60).toHaveLength(1);
  });

  it('retains protected chains, activation reports, and the newest v6 compatibility chain', async () => {
    const paths = await emptyGlassPaths();
    const legacyBase = await saveMarketSnapshot(
      paths,
      GLASS,
      glassV7Data(65, false),
      {
        idFactory: () => 'compat-v5-base',
        now: () => new Date('2026-10-23T00:01:00.000Z'),
      },
    );
    const legacyTail = await saveMarketSnapshot(
      paths,
      GLASS,
      {
        ...glassV7Data(66, false),
        requestStart: '2026-10-09 10:05:00',
      },
      {
        intent: 'tail',
        current: legacyBase,
        idFactory: () => 'compat-v6-tail',
        now: () => new Date('2026-10-23T00:02:00.000Z'),
      },
    );
    await cloneActivatedGlassSnapshot(
      paths,
      legacyBase.directory,
      'stale-v5',
      '2026-10-23T00:00:00.000Z',
    );

    const protectedData = glassV7Data(65);
    const protectedBase = await writeManualV7Snapshot(
      paths,
      'protected-v7-base',
      { kind: 'full' },
      protectedData,
      protectedData,
      { activatedAt: '2026-10-23T00:10:00.000Z' },
    );
    const reported = await writeManualV7Snapshot(
      paths,
      'reported-v7',
      { kind: 'full' },
      protectedData,
      protectedData,
      { activatedAt: '2026-10-23T00:12:00.000Z' },
    );
    await writeGlassActivationReport(paths, reported);
    const merged = glassV7Data(70);
    const protectedTail = await writeManualV7Snapshot(
      paths,
      'protected-v7-tail',
      {
        kind: 'tail',
        base: {
          snapshotId: protectedBase.metadata.snapshotId,
          metadataSha256: sha256Text(protectedBase.metadataText),
        },
        replacementCutoff: '2026-10-09 10:05:00',
        layerSequence: 1,
      },
      v7TailData(merged, '2026-10-09 10:05:00'),
      merged,
      { activatedAt: '2026-10-23T00:15:00.000Z' },
    );
    const corruptLegacy = await cloneActivatedGlassSnapshot(
      paths,
      legacyBase.directory,
      'corrupt-newer-v5',
      '2026-10-23T00:30:00.000Z',
      async directory => {
        await writeFile(join(directory, FIVE_MINUTE_FILE), 'corrupt');
      },
    );

    await cleanupSnapshots(paths, GLASS, protectedTail.metadata.snapshotId);

    const snapshotIds = (await readdir(
      join(userDirectory(paths, GLASS), 'snapshots'),
      { withFileTypes: true },
    )).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(snapshotIds).toEqual([
      'compat-v5-base',
      'compat-v6-tail',
      'corrupt-newer-v5',
      'protected-v7-base',
      'protected-v7-tail',
      'reported-v7',
    ]);
    await expect(readFile(
      join(corruptLegacy, 'metadata.json'),
      'utf8',
    )).resolves.toBeTruthy();
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(protectedTail.directory);

    const schemaV6Loader: SnapshotDirectoryLoader = async request => {
      if (request.kind === 'metadata') {
        const metadata = JSON.parse(
          await readFile(join(request.directory, 'metadata.json'), 'utf8'),
        );
        if (metadata.schemaVersion > 6) {
          throw new Error('schema v7 unsupported');
        }
      }
      return prepareSnapshotDirectory(request);
    };
    const legacyLoaded = await loadEffectiveSnapshotWithLoader(
      paths,
      GLASS,
      schemaV6Loader,
    );
    expect(legacyLoaded).toMatchObject({
      directory: legacyTail.directory,
      metadata: {
        schemaVersion: 6,
        base: { snapshotId: 'compat-v5-base' },
      },
    });
  });

  it('restores an activation-report protected v7 snapshot over a newer legacy pointer', async () => {
    const paths = await emptyGlassPaths();
    const legacy = await saveMarketSnapshot(
      paths,
      GLASS,
      glassV7Data(65, false),
      {
        idFactory: () => 'old-app-write',
        now: () => new Date('2026-10-23T00:30:00.000Z'),
      },
    );
    const protectedData = glassV7Data(65);
    const protectedSnapshot = await writeManualV7Snapshot(
      paths,
      'protected-repair',
      { kind: 'full' },
      protectedData,
      protectedData,
      { activatedAt: '2026-10-23T00:00:00.000Z' },
    );
    await writeGlassActivationReport(paths, protectedSnapshot);
    await writeFile(
      join(userDirectory(paths, GLASS), 'current.json'),
      `${JSON.stringify({
        schemaVersion: 5,
        snapshotId: 'old-app-write',
        updatedAt: '2026-10-23T00:30:00.000Z',
      }, null, 2)}\n`,
    );

    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(protectedSnapshot.directory);

    const schemaV6Loader: SnapshotDirectoryLoader = async request => {
      if (request.kind === 'metadata') {
        const metadata = JSON.parse(
          await readFile(join(request.directory, 'metadata.json'), 'utf8'),
        );
        if (metadata.schemaVersion > 6) {
          throw new Error('schema v7 unsupported');
        }
      }
      return prepareSnapshotDirectory(request);
    };
    expect((await loadEffectiveSnapshotWithLoader(
      paths,
      GLASS,
      schemaV6Loader,
    )).directory).toBe(legacy.directory);
  });

  it.each([
    ['extra full storage key', (metadata: Record<string, any>) => {
      metadata.storage.extra = true;
    }],
    ['incomplete tail storage', (metadata: Record<string, any>) => {
      metadata.storage = { kind: 'tail' };
    }],
    ['legacy top-level base', (metadata: Record<string, any>) => {
      metadata.base = {
        snapshotId: 'v7-base',
        metadataSha256: '0'.repeat(64),
      };
    }],
    ['invalid report hash', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.reportSha256 = 'not-a-sha';
    }],
    ['missing benchmark segment', (metadata: Record<string, any>) => {
      metadata.sourceSegments = [{
        ...glassBenchmarkSourceSegment(),
        sourceId: 'edb-only',
        kind: 'edb-tail',
      }];
    }],
    ['duplicate benchmark segment', (metadata: Record<string, any>) => {
      metadata.sourceSegments.push({
        ...glassBenchmarkSourceSegment(),
        sourceId: 'ths-fg9999-duplicate',
      });
    }],
    ['benchmark coverage mismatch', (metadata: Record<string, any>) => {
      metadata.sourceSegments[0].coverage.last = '2026-10-09 10:05:00';
    }],
    ['incomplete protected fields', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.bars5.protectedFields = [
        'open',
        'high',
        'low',
        'close',
      ];
    }],
    ['snapshot redistribution allowed', (metadata: Record<string, any>) => {
      metadata.redistribution.allowed = true;
    }],
    ['protection redistribution allowed', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.redistribution.allowed = true;
    }],
    ['unaligned protected range', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.bars5.lastEnd = '2026-10-09 09:59:00';
      metadata.sourceSegments[0].coverage.last = '2026-10-09 09:59:00';
    }],
    ['wrong 60-minute boundary', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.bars60.lastEnd = '2026-10-09 10:05:00';
    }],
    ['missing mapping boundary', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.mappings.firstTradingDate = '2026-10-08';
    }],
    ['missing rollover boundary', (metadata: Record<string, any>) => {
      metadata.benchmarkProtection.rollovers.firstTradingDate = '2026-10-11';
      metadata.benchmarkProtection.rollovers.lastTradingDate = '2026-10-11';
    }],
  ])('falls back from a v7 full snapshot with %s', async (_label, mutate) => {
    const { paths, base } = await glassV7Fixture();
    await cloneBrokenV7Snapshot(
      paths,
      base.directory,
      'v7-broken',
      mutate,
    );

    const loaded = await loadEffectiveSnapshot(paths, GLASS);

    expect(loaded.directory).toBe(base.directory);
    expect(loaded.metadata).toMatchObject({
      schemaVersion: 7,
      storage: { kind: 'full' },
    });
  });

  it('falls back when minute aggregation differs outside the protected range', async () => {
    const { paths, data, base } = await glassV7Fixture();
    const broken: GlassV7Data = {
      ...data,
      bars5: data.bars5.map((bar, index) => (
        index === data.bars5.length - 1
          ? { ...bar, open: bar.open + 10 }
          : bar
      )),
    };
    await writeManualV7Snapshot(
      paths,
      'v7-outside-mismatch',
      { kind: 'full' },
      broken,
      broken,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );

    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);
  });

  it('rejects schema v7 for another instrument and falls back to its valid v5 snapshot', async () => {
    const paths = await fixture();
    const rebar = INSTRUMENT_DEFINITIONS.rebar_main;
    await installInstrumentBaseline(paths, rebar);
    const valid = await saveMarketSnapshot(
      paths,
      rebar,
      {
        ...await candidate(paths),
        mainContractMappings: [],
        rollovers: [],
      },
      {
        idFactory: () => 'rebar-v5',
        now: () => new Date('2026-10-23T00:00:00.000Z'),
      },
    );
    const data = glassV7Data(65);
    const glass = await writeManualV7Snapshot(
      paths,
      'glass-v7-source',
      { kind: 'full' },
      data,
      data,
    );
    const rebarDirectory = userDirectory(paths, rebar);
    const invalidDirectory = join(
      rebarDirectory,
      'snapshots',
      'rebar-v7',
    );
    await cp(glass.directory, invalidDirectory, { recursive: true });
    const metadataPath = join(invalidDirectory, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.snapshotId = 'rebar-v7';
    metadata.instrumentId = rebar.id;
    metadata.mainSymbol = rebar.mainSymbol;
    metadata.parameterVersion = rebar.parameterVersion;
    metadata.source.symbol = rebar.mainSymbol;
    await Promise.all([
      writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
      writeFile(join(invalidDirectory, 'activated.json'), `${JSON.stringify({
        snapshotId: 'rebar-v7',
        activatedAt: '2026-10-23T00:05:00.000Z',
      }, null, 2)}\n`),
      writeFile(join(rebarDirectory, 'current.json'), `${JSON.stringify({
        schemaVersion: 7,
        snapshotId: 'rebar-v7',
        updatedAt: '2026-10-23T00:05:00.000Z',
      }, null, 2)}\n`),
    ]);

    expect((await loadEffectiveSnapshot(paths, rebar)).directory)
      .toBe(valid.directory);
  }, SNAPSHOT_IO_TIMEOUT);

  it('falls back when a v7 tail has the wrong base metadata hash', async () => {
    const { paths, base } = await glassV7Fixture();
    const merged = glassV7Data(70);
    const cutoff = '2026-10-09 10:05:00';
    const tail = await writeManualV7Snapshot(
      paths,
      'v7-bad-base-hash',
      {
        kind: 'tail',
        base: {
          snapshotId: base.metadata.snapshotId,
          metadataSha256: '0'.repeat(64),
        },
        replacementCutoff: cutoff,
        layerSequence: 1,
      },
      v7TailData(merged, cutoff),
      merged,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );

    expect(tail.metadata.storage.kind).toBe('tail');
    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);
  });

  it('rejects a v7 tail over schema v5 and restores the valid protected v7 chain', async () => {
    const { paths, base } = await glassV7Fixture();
    const legacyData = glassV7Data(65, false);
    const legacyBase = await saveMarketSnapshot(
      paths,
      GLASS,
      legacyData,
      {
        idFactory: () => 'v5-base',
        now: () => new Date('2026-10-23T00:02:00.000Z'),
      },
    );
    const legacyMetadataText = await readFile(
      join(legacyBase.directory, 'metadata.json'),
      'utf8',
    );
    const merged = glassV7Data(70);
    const cutoff = '2026-10-09 10:05:00';
    await writeManualV7Snapshot(
      paths,
      'v7-over-v5',
      {
        kind: 'tail',
        base: {
          snapshotId: 'v5-base',
          metadataSha256: sha256Text(legacyMetadataText),
        },
        replacementCutoff: cutoff,
        layerSequence: 1,
      },
      v7TailData(merged, cutoff),
      merged,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );

    const loaded = await loadEffectiveSnapshot(paths, GLASS);

    expect(loaded.directory).toBe(base.directory);
    expect(loaded.directory).not.toBe(legacyBase.directory);
    expect(loaded.metadata).toMatchObject({
      schemaVersion: 7,
      storage: { kind: 'full' },
    });
  });

  it('rejects a v7 tail that references another tail and falls back to the first valid tail', async () => {
    const { paths, base } = await glassV7Fixture();
    const cutoff = '2026-10-09 10:05:00';
    const firstMerged = glassV7Data(70);
    const firstTail = await writeManualV7Snapshot(
      paths,
      'v7-tail-one',
      {
        kind: 'tail',
        base: {
          snapshotId: base.metadata.snapshotId,
          metadataSha256: sha256Text(base.metadataText),
        },
        replacementCutoff: cutoff,
        layerSequence: 1,
      },
      v7TailData(firstMerged, cutoff),
      firstMerged,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );
    const secondMerged = glassV7Data(75);
    await writeManualV7Snapshot(
      paths,
      'v7-tail-two',
      {
        kind: 'tail',
        base: {
          snapshotId: firstTail.metadata.snapshotId,
          metadataSha256: sha256Text(firstTail.metadataText),
        },
        replacementCutoff: cutoff,
        layerSequence: 2,
      },
      v7TailData(secondMerged, cutoff),
      secondMerged,
      { activatedAt: '2026-10-23T00:10:00.000Z' },
    );

    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(firstTail.directory);
  });

  it.each([
    ['protected 5-minute OHLCV', (data: GlassV7Data): GlassV7Data => ({
      ...data,
      bars5: data.bars5.map((bar, index) => (
        index === 0 ? { ...bar, close: bar.close + 1 } : bar
      )),
    })],
    ['protected 60-minute bar', (data: GlassV7Data): GlassV7Data => ({
      ...data,
      bars60: data.bars60.map((bar, index) => (
        index === 0 ? { ...bar, volume: bar.volume + 1 } : bar
      )),
    })],
    ['protected mapping', (data: GlassV7Data): GlassV7Data => ({
      ...data,
      mainContractMappings: data.mainContractMappings.map((mapping, index) => (
        index === 0 ? { ...mapping, contract: 'FG2509' } : mapping
      )),
    })],
    ['protected rollover', (data: GlassV7Data): GlassV7Data => ({
      ...data,
      rollovers: data.rollovers.map((rollover, index) => (
        index === 0 ? { ...rollover, fromContract: 'FG2509' } : rollover
      )),
    })],
  ])('falls back when a v7 tail changes %s', async (_label, mutate) => {
    const { paths, data, base } = await glassV7Fixture();
    const changed = mutate(data);
    await writeManualV7Snapshot(
      paths,
      'v7-protected-mutation',
      {
        kind: 'tail',
        base: {
          snapshotId: base.metadata.snapshotId,
          metadataSha256: sha256Text(base.metadataText),
        },
        replacementCutoff: '2026-10-09 09:00:00',
        layerSequence: 1,
      },
      changed,
      changed,
      { activatedAt: '2026-10-23T00:05:00.000Z' },
    );

    expect((await loadEffectiveSnapshot(paths, GLASS)).directory)
      .toBe(base.directory);
  });
});

describe('bounded tail snapshot layers', () => {
  it('writes and reloads schema 6 with a direct schema 5 base and stable cutoff', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const first = await saveSyntheticTail(paths, base, 66, 'tail-one', 1);
    const second = await saveSyntheticTail(paths, first, 67, 'tail-two', 2);

    expect(base.metadata?.schemaVersion).toBe(5);
    expect(first.metadata).toMatchObject({
      schemaVersion: 6,
      base: { snapshotId: 'base' },
      replacementCutoff: '2026-10-09 10:05:00',
      layerSequence: 1,
    });
    expect(second.metadata).toMatchObject({
      schemaVersion: 6,
      base: { snapshotId: 'base' },
      replacementCutoff: '2026-10-09 10:05:00',
      layerSequence: 2,
    });
    if (base.metadata?.schemaVersion !== 5) throw new Error('expected schema 5');
    if (second.metadata?.schemaVersion !== 6) throw new Error('expected schema 6');
    expect(second.metadata?.sourceSegments).toEqual(base.metadata?.sourceSegments);
    expect(second.metadata?.redistribution).toEqual(base.metadata?.redistribution);
    expect(second.mainContractMappings).toEqual(base.mainContractMappings);
    expect(second.rollovers).toEqual(base.rollovers);
    expect(second.bars1).toHaveLength(67);
    expect(second.bars5).toHaveLength(base.bars5.length);
    expect(second.bars60).toHaveLength(base.bars60.length);

    const pointer = JSON.parse(
      await readFile(join(userDirectory(paths), 'current.json'), 'utf8'),
    );
    expect(pointer).toMatchObject({
      schemaVersion: 6,
      snapshotId: 'tail-two',
    });
    await expect(loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT))
      .resolves.toMatchObject({
        directory: expect.stringContaining('tail-two'),
        bars1: expect.arrayContaining([
          expect.objectContaining({ start: '2026-10-09 10:06:00' }),
        ]),
      });
  });

  it('writes canonical empty 5/60-minute tails while keeping complete mappings', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const tail = await saveSyntheticTail(paths, base, 66, 'empty-bars-tail', 1);
    if (tail.metadata?.schemaVersion !== 6) throw new Error('expected schema 6');

    expect(tail.metadata.files.bars1.rows).toBe(1);
    expect(tail.metadata.files.bars5.rows).toBe(0);
    expect(tail.metadata.files.bars60.rows).toBe(0);
    expect(tail.metadata.files.mainContractMappings.rows)
      .toBe(base.mainContractMappings.length);
    await expect(readFile(
      join(tail.directory, 'edb_main_continuous_5m.csv'),
      'utf8',
    )).resolves.toBe(
      '\uFEFFbar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete\r\n',
    );
    await expect(readFile(
      join(tail.directory, 'edb_main_continuous_60m.csv'),
      'utf8',
    )).resolves.toBe(
      '\uFEFFbar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete\r\n',
    );
  });

  it('falls back across corrupt tail, base, and base-hash references', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const first = await saveSyntheticTail(paths, base, 66, 'tail-one', 1);
    const second = await saveSyntheticTail(paths, first, 67, 'tail-two', 2);

    await writeFile(
      join(second.directory, 'edb_main_continuous_1m_raw.csv'),
      'corrupt',
    );
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory)
      .toContain('tail-one');

    const secondMetadataPath = join(second.directory, 'metadata.json');
    const secondMetadata = JSON.parse(await readFile(secondMetadataPath, 'utf8'));
    secondMetadata.base.metadataSha256 = '0'.repeat(64);
    await writeFile(
      secondMetadataPath,
      `${JSON.stringify(secondMetadata, null, 2)}\n`,
    );
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory)
      .toContain('tail-one');

    await writeFile(
      join(base.directory, 'edb_main_continuous_5m.csv'),
      'corrupt',
    );
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).source)
      .toBe('builtin');
  });

  it('removes a renamed candidate when pointer replacement fails', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const currentPath = join(userDirectory(paths), 'current.json');
    const backupPath = join(userDirectory(paths), 'current.backup.json');

    try {
      await expect(saveMarketSnapshot(
        paths,
        DEFAULT_INSTRUMENT,
        syntheticCandidate(66, '2026-10-09 10:05:00'),
        {
          intent: 'tail',
          current: base,
          idFactory: () => 'pointer-failure',
          beforePointerSwitch: async () => {
            await rename(currentPath, backupPath);
            await mkdir(currentPath);
          },
        },
      )).rejects.toThrow();
    } finally {
      await rm(currentPath, { recursive: true, force: true });
      await rename(backupPath, currentPath);
    }

    const snapshotIds = (await readdir(
      join(userDirectory(paths), 'snapshots'),
      { withFileTypes: true },
    )).filter(entry => entry.isDirectory()).map(entry => entry.name);
    expect(snapshotIds).not.toContain('pointer-failure');
    expect((await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT)).directory)
      .toContain('base');
  });

  it('retains the referenced base and at most three snapshot directories', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const first = await saveSyntheticTail(paths, base, 66, 'tail-one', 1);
    const second = await saveSyntheticTail(paths, first, 67, 'tail-two', 2);
    const third = await saveSyntheticTail(paths, second, 68, 'tail-three', 3);
    const snapshotIds = (await readdir(
      join(userDirectory(paths), 'snapshots'),
      { withFileTypes: true },
    )).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

    expect(snapshotIds).toEqual(['base', 'tail-three', 'tail-two']);
    expect(third.metadata).toMatchObject({
      schemaVersion: 6,
      base: { snapshotId: 'base' },
      layerSequence: 3,
    });
  });

  it('compacts back to schema 5 at the configured layer threshold', async () => {
    const paths = await syntheticFixture();
    const base = await saveSyntheticBase(paths);
    const first = await saveSyntheticTail(paths, base, 66, 'tail-one', 1, 3);
    const second = await saveSyntheticTail(paths, first, 67, 'tail-two', 2, 3);
    const compacted = await saveSyntheticTail(
      paths,
      second,
      68,
      'compacted',
      3,
      3,
    );

    expect(first.metadata).toMatchObject({ schemaVersion: 6, layerSequence: 1 });
    expect(second.metadata).toMatchObject({ schemaVersion: 6, layerSequence: 2 });
    expect(compacted.metadata).toMatchObject({
      schemaVersion: 5,
      snapshotId: 'compacted',
    });
    expect(compacted.bars1).toHaveLength(68);
    const pointer = JSON.parse(
      await readFile(join(userDirectory(paths), 'current.json'), 'utf8'),
    );
    expect(pointer).toMatchObject({
      schemaVersion: 5,
      snapshotId: 'compacted',
    });
  });
});

describe('legacy soymeal migration', () => {
  it('single-flights concurrent startup migrations without deleting either legacy source', async () => {
    const root = await mkdtemp(join(tmpdir(), '行情 迁移-'));
    temps.push(root);
    const legacy = join(root, 'legacy-flat');
    await mkdir(legacy);
    for (const name of DATA_FILES) await cp(join(source, name), join(legacy, name));
    const paths: MarketDataPaths = {
      builtinDataDirectory: join(root, 'data'),
      legacyBuiltinDataDirectory: legacy,
      marketDataDirectory: join(root, 'AppData', 'market-data'),
    };
    const oldSnapshot = await createLegacyGlobalSnapshot(paths);
    const concurrent = await Promise.all([
      migrateLegacySoymealData(paths),
      migrateLegacySoymealData(paths),
      migrateLegacySoymealData(paths),
      migrateLegacySoymealData(paths),
    ]);
    expect(concurrent).toEqual(Array.from(
      { length: 4 },
      () => ({ builtinMigrated: true, userSnapshotMigrated: true }),
    ));
    const loaded = await loadEffectiveSnapshot(paths, DEFAULT_INSTRUMENT);
    expect(loaded.source).toBe('user');
    expect(loaded.bars1[0].start <= '2025-10-09 21:00:00').toBe(true);
    expect(loaded.mainContractMappings.length).toBeGreaterThan(0);
    await expect(readFile(join(legacy, 'edb_main_continuous_1m_raw.csv'))).resolves.toBeTruthy();
    await expect(readFile(join(oldSnapshot, 'metadata.json'))).resolves.toBeTruthy();
    await expect(readFile(join(
      resolveInstrumentDataDirectories(paths, DEFAULT_INSTRUMENT).builtin,
      'metadata.json',
    ))).resolves.toBeTruthy();

    const second = await migrateLegacySoymealData(paths);
    expect(second).toEqual({ builtinMigrated: false, userSnapshotMigrated: false });
    const entries = await readFile(join(userDirectory(paths), 'current.json'), 'utf8');
    expect(JSON.parse(entries).snapshotId).toBe('legacy-old-global');
  }, SNAPSHOT_IO_TIMEOUT);

  it('does not overwrite a valid newer per-instrument snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), '行情 新快照优先-'));
    temps.push(root);
    const legacy = join(root, 'legacy-flat');
    await mkdir(legacy);
    for (const name of DATA_FILES) await cp(join(source, name), join(legacy, name));
    const paths: MarketDataPaths = {
      builtinDataDirectory: join(root, 'data'),
      legacyBuiltinDataDirectory: legacy,
      marketDataDirectory: join(root, 'AppData', 'market-data'),
    };
    await migrateLegacySoymealData(paths);
    await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      {
        idFactory: () => 'new-layout',
        now: () => new Date('2026-10-18T04:00:00.000Z'),
      },
    );
    const oldSnapshot = await createLegacyGlobalSnapshot(paths, 'older-global');
    expect((await migrateLegacySoymealData(paths)).userSnapshotMigrated).toBe(false);
    const pointer = JSON.parse(await readFile(join(userDirectory(paths), 'current.json'), 'utf8'));
    expect(pointer.snapshotId).toBe('new-layout');
    await expect(readFile(join(oldSnapshot, 'metadata.json'))).resolves.toBeTruthy();
  }, SNAPSHOT_IO_TIMEOUT);
});
