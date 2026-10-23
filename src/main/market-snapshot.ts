import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  detectContractRollovers,
  parseContractRollovers,
  parseMainContractMappings,
  serializeContractRollovers,
  serializeMainContractMappings,
} from '../domain/contract-rollover';
import {
  aggregateFiveMinuteBars,
  assertBarsValid,
  assertMinuteCoverageMatchesFiveMinuteBars,
  assertMinuteRecordsValid,
  assertSegmentedSixtyMinuteBarsValid,
  parseEdbMinuteCsv,
  reconcileBars,
  reconcileCompatibleBars,
  serializeBars,
  serializeMinuteRecords,
} from '../domain/market-data';
import { assertBenchmarkProtectionUnchanged } from '../domain/benchmark-protection';
import { parseBars } from '../domain/data';
import { auditThsGlassMainMinuteProtection } from '../domain/ths-benchmark';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  DEFAULT_INSTRUMENT,
  type InstrumentDefinition,
} from '../shared/instruments';
import type {
  Bar,
  ContractRollover,
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotBenchmarkProtection,
  MarketSnapshotMetadata,
  MarketSnapshotMetadataV4,
  MarketSnapshotMetadataV5,
  MarketSnapshotMetadataV6,
  MarketSnapshotMetadataV7,
  MarketSnapshotMetadataV7Full,
  MarketSnapshotMetadataV7Tail,
  MarketSnapshotRedistribution,
  MarketSnapshotSourceSegment,
  MarketUpdateIntent,
  SnapshotFileMetadata,
  SnapshotSource,
} from '../shared/types';

export const SNAPSHOT_SCHEMA_VERSION = 7 as const;
const ONE_MINUTE_FILE = 'edb_main_continuous_1m_raw.csv';
const FIVE_MINUTE_FILE = 'edb_main_continuous_5m.csv';
const SIXTY_MINUTE_FILE = 'edb_main_continuous_60m.csv';
const ROLLOVER_FILE = 'edb_main_continuous_rollovers.csv';
const MAPPING_FILE = 'edb_main_contract_mapping.csv';
const METADATA_FILE = 'metadata.json';
const ACTIVATED_FILE = 'activated.json';
const POINTER_FILE = 'current.json';
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BENCHMARK_PROTECTED_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
] as const;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7]);
const DEFAULT_TAIL_COMPACTION_THRESHOLD = 64;
type LegacyMigrationResult = {
  builtinMigrated: boolean;
  userSnapshotMigrated: boolean;
};

function isV7Full(
  metadata: MarketSnapshotMetadata,
): metadata is MarketSnapshotMetadataV7Full {
  return metadata.schemaVersion === 7 && metadata.storage.kind === 'full';
}

function isV7Tail(
  metadata: MarketSnapshotMetadata,
): metadata is MarketSnapshotMetadataV7Tail {
  return metadata.schemaVersion === 7 && metadata.storage.kind === 'tail';
}
const legacyMigrationFlights = new Map<string, Promise<LegacyMigrationResult>>();
const builtinUpgradeFlights = new Map<string, Promise<LoadedMarketSnapshot>>();

export interface MarketDataPaths {
  builtinDataDirectory: string;
  marketDataDirectory: string;
  legacyBuiltinDataDirectory?: string;
}

export interface LoadedMarketSnapshot {
  source: SnapshotSource;
  directory: string;
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  mainContractMappings: MainContractMapping[];
  rollovers: ContractRollover[];
  sourceLatestAt: string;
  snapshotUpdatedAt?: string;
  metadata?: MarketSnapshotMetadata;
}

export type SnapshotDirectoryLoadRequest =
  | {
      kind: 'metadata';
      directory: string;
      expectedId?: string;
      definition: InstrumentDefinition;
      source: SnapshotSource;
      fallback?: LoadedMarketSnapshot;
    }
  | {
      kind: 'legacy-builtin';
      directory: string;
      definition: InstrumentDefinition;
    };

export type SnapshotDirectoryLoader = (
  request: SnapshotDirectoryLoadRequest,
) => Promise<LoadedMarketSnapshot>;

export interface SnapshotCandidate {
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  mainContractMappings: MainContractMapping[];
  rollovers: ContractRollover[];
  requestStart: string;
  requestEnd: string;
  sourceLatestAt: string;
  source?: MarketSnapshotMetadataV5['source'];
  sourceSegments?: MarketSnapshotSourceSegment[];
  redistribution?: MarketSnapshotRedistribution;
  benchmarkProtection?: MarketSnapshotBenchmarkProtection;
}

export interface SaveSnapshotOptions {
  now?: () => Date;
  idFactory?: () => string;
  beforePointerSwitch?: () => void | Promise<void>;
  onTiming?: (phase: SaveSnapshotTimingPhase, durationMs: number) => void;
  intent?: MarketUpdateIntent;
  current?: LoadedMarketSnapshot;
  tailCompactionThreshold?: number;
}

export type SaveSnapshotTimingPhase =
  | 'serialization'
  | 'write'
  | 'validation'
  | 'activation'
  | 'reload';

export interface WriteBuiltinSnapshotOptions {
  now?: () => Date;
  beforeCommit?: () => void | Promise<void>;
}

interface CurrentPointer {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  snapshotId: string;
  updatedAt: string;
}

interface ActivatedSnapshot {
  id: string;
  time: number;
}

interface SerializedSnapshot {
  oneText?: string;
  fiveText: string;
  sixtyText: string;
  rolloverText: string;
  mappingText: string;
}

interface PreparedSnapshot {
  candidate: SnapshotCandidate;
  serialized: SerializedSnapshot;
}

interface TailLayerPlanV6 {
  schemaVersion: 6;
  base: MarketSnapshotMetadataV6['base'];
  replacementCutoff: string;
  layerSequence: number;
}

interface TailLayerPlanV7 {
  schemaVersion: 7;
  base: MarketSnapshotMetadataV7Tail['storage']['base'];
  replacementCutoff: string;
  layerSequence: number;
}

type TailLayerPlan = TailLayerPlanV6 | TailLayerPlanV7;

type PersistedSnapshotMetadata =
  | MarketSnapshotMetadataV4
  | MarketSnapshotMetadataV5
  | MarketSnapshotMetadataV6
  | MarketSnapshotMetadataV7Full
  | MarketSnapshotMetadataV7Tail;

interface CachedBaseSnapshot {
  signatures: string[];
  snapshot: LoadedMarketSnapshot;
}

const verifiedBaseCache = new Map<string, CachedBaseSnapshot>();

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSnapshotId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SNAPSHOT_ID.test(value)) {
    throw new Error('快照标识无效');
  }
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label} JSON 无效`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 结构无效`);
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}结构无效`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
    || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label}结构无效`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label}无效`);
  }
}

function assertTradingDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !TRADING_DATE.test(value)) {
    throw new Error(`${label}无效`);
  }
  const parsed = parseBeijing(`${value} 00:00:00`);
  if (formatBeijing(parsed).slice(0, 10) !== value) {
    throw new Error(`${label}无效`);
  }
}

function fileMetadata(
  files: Record<string, unknown>,
  key: string,
): SnapshotFileMetadata {
  const file = files[key];
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error('快照文件元数据无效');
  }
  const record = file as Record<string, unknown>;
  if (typeof record.name !== 'string'
    || typeof record.sha256 !== 'string'
    || !SHA256.test(record.sha256)
    || typeof record.rows !== 'number'
    || !Number.isSafeInteger(record.rows)
    || record.rows < 0) {
    throw new Error('快照文件元数据无效');
  }
  return record as unknown as SnapshotFileMetadata;
}

function optionalFileMetadata(
  files: Record<string, unknown>,
  key: string,
): SnapshotFileMetadata | undefined {
  return files[key] === undefined ? undefined : fileMetadata(files, key);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function assertPeriodMetadata(
  value: unknown,
  label: string,
  expectedRows?: number,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}覆盖元数据无效`);
  }
  const period = value as Record<string, unknown>;
  const first = nonEmptyString(period.first, `${label}首条时间`);
  const last = nonEmptyString(period.last, `${label}末条时间`);
  parseBeijing(first);
  parseBeijing(last);
  if (first > last
    || !Number.isSafeInteger(period.rows)
    || (period.rows as number) <= 0
    || (expectedRows !== undefined && period.rows !== expectedRows)) {
    throw new Error(`${label}覆盖元数据无效`);
  }
}

function assertSourceSegments(value: unknown): asserts value is MarketSnapshotSourceSegment[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('快照分段来源声明无效');
  }
  const kinds = new Set([
    'desktop-main',
    'public-history',
    'gap-fill',
    'edb-tail',
    'benchmark-main',
    'legacy-migration',
    'test-fixture',
  ]);
  const sourceIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('快照分段来源声明无效');
    }
    const segment = item as unknown as Record<string, unknown>;
    const sourceId = nonEmptyString(segment.sourceId, '快照来源标识');
    if (sourceIds.has(sourceId)) {
      throw new Error('快照来源标识重复');
    }
    sourceIds.add(sourceId);
    nonEmptyString(segment.sourceName, '快照来源名称');
    if (!kinds.has(segment.kind as string)) {
      throw new Error('快照来源类型无效');
    }
    if (segment.sourceVersion !== undefined) {
      nonEmptyString(segment.sourceVersion, '快照来源版本');
    }
    if (segment.acquiredAt !== undefined
      && (typeof segment.acquiredAt !== 'string'
        || Number.isNaN(Date.parse(segment.acquiredAt)))) {
      throw new Error('快照来源取得时间无效');
    }
    const coverage = segment.coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
      throw new Error('快照来源覆盖范围无效');
    }
    const coverageRecord = coverage as Record<string, unknown>;
    const first = nonEmptyString(coverageRecord.first, '快照来源首条时间');
    const last = nonEmptyString(coverageRecord.last, '快照来源末条时间');
    parseBeijing(first);
    parseBeijing(last);
    if (first > last) throw new Error('快照来源覆盖范围无效');
    if (!Array.isArray(segment.rawFiles) || !segment.rawFiles.length) {
      throw new Error('快照来源原始文件审计无效');
    }
    for (const rawFile of segment.rawFiles) {
      if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
        throw new Error('快照来源原始文件审计无效');
      }
      const file = rawFile as Record<string, unknown>;
      nonEmptyString(file.name, '快照原始文件名');
      if (typeof file.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.rows)
        || (file.rows as number) < 0) {
        throw new Error('快照来源原始文件审计无效');
      }
    }
    nonEmptyString(segment.importerVersion, '快照导入器版本');
    const license = segment.license;
    if (!license || typeof license !== 'object' || Array.isArray(license)) {
      throw new Error('快照来源授权结论无效');
    }
    const licenseRecord = license as Record<string, unknown>;
    if (licenseRecord.identifier !== undefined) {
      nonEmptyString(licenseRecord.identifier, '快照来源授权标识');
    }
    if (typeof licenseRecord.redistributionAllowed !== 'boolean') {
      throw new Error('快照来源授权结论无效');
    }
    nonEmptyString(licenseRecord.conclusion, '快照来源授权结论');
  }
}

function assertRedistribution(
  value: unknown,
): asserts value is MarketSnapshotRedistribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('快照再分发结论无效');
  }
  const redistribution = value as Record<string, unknown>;
  if (typeof redistribution.allowed !== 'boolean') {
    throw new Error('快照再分发结论无效');
  }
  nonEmptyString(redistribution.conclusion, '快照再分发结论');
}

function assertRedistributionDenied(
  value: unknown,
  label: string,
): asserts value is MarketSnapshotRedistribution {
  assertRedistribution(value);
  if (value.allowed !== false) {
    throw new Error(`${label}必须禁止再分发`);
  }
}

function parseV7Storage(value: unknown): MarketSnapshotMetadataV7['storage'] {
  const storage = objectValue(value, 'schema v7 存储声明');
  if (storage.kind === 'full') {
    assertExactKeys(storage, ['kind'], 'schema v7 完整存储声明');
    return storage as unknown as MarketSnapshotMetadataV7Full['storage'];
  }
  if (storage.kind !== 'tail') {
    throw new Error('schema v7 存储类型无效');
  }
  assertExactKeys(
    storage,
    ['kind', 'base', 'replacementCutoff', 'layerSequence'],
    'schema v7 尾部存储声明',
  );
  const base = objectValue(storage.base, 'schema v7 尾部基础引用');
  assertExactKeys(
    base,
    ['snapshotId', 'metadataSha256'],
    'schema v7 尾部基础引用',
  );
  assertSnapshotId(base.snapshotId);
  assertSha256(base.metadataSha256, 'schema v7 尾部基础元数据哈希');
  if (typeof storage.replacementCutoff !== 'string') {
    throw new Error('schema v7 尾部替换起点无效');
  }
  parseBeijing(storage.replacementCutoff);
  if (!Number.isSafeInteger(storage.layerSequence)
    || (storage.layerSequence as number) <= 0) {
    throw new Error('schema v7 尾部层序号无效');
  }
  return storage as unknown as MarketSnapshotMetadataV7Tail['storage'];
}

function assertBenchmarkProtection(
  value: unknown,
  sourceSegments: MarketSnapshotSourceSegment[],
  snapshotRedistribution: MarketSnapshotRedistribution,
): asserts value is MarketSnapshotBenchmarkProtection {
  const protection = objectValue(value, '基准保护元数据');
  assertExactKeys(protection, [
    'provider',
    'sourceSegmentId',
    'bars5',
    'bars60',
    'mappings',
    'rollovers',
    'minutePolicy',
    'reportSha256',
    'redistribution',
  ], '基准保护元数据');
  if (protection.provider !== 'THS') {
    throw new Error('基准保护提供方无效');
  }
  const sourceSegmentId = nonEmptyString(
    protection.sourceSegmentId,
    '基准保护来源分段标识',
  );

  const bars5 = objectValue(protection.bars5, '基准 5 分钟保护范围');
  assertExactKeys(
    bars5,
    ['firstStart', 'lastEnd', 'protectedFields'],
    '基准 5 分钟保护范围',
  );
  const firstStart = nonEmptyString(bars5.firstStart, '基准 5 分钟首条时间');
  const lastEnd = nonEmptyString(bars5.lastEnd, '基准 5 分钟末条时间');
  if (parseBeijing(firstStart) >= parseBeijing(lastEnd)) {
    throw new Error('基准 5 分钟保护范围无效');
  }
  const protectedFields = bars5.protectedFields;
  if (!Array.isArray(protectedFields)
    || protectedFields.length !== BENCHMARK_PROTECTED_FIELDS.length
    || new Set(protectedFields).size !== BENCHMARK_PROTECTED_FIELDS.length
    || BENCHMARK_PROTECTED_FIELDS.some(field => !protectedFields.includes(field))) {
    throw new Error('基准 5 分钟受保护字段无效');
  }

  const bars60 = objectValue(protection.bars60, '基准 60 分钟保护范围');
  assertExactKeys(
    bars60,
    ['firstStart', 'lastEnd', 'derivedFrom'],
    '基准 60 分钟保护范围',
  );
  const firstSixtyStart = nonEmptyString(
    bars60.firstStart,
    '基准 60 分钟首条时间',
  );
  const lastSixtyEnd = nonEmptyString(
    bars60.lastEnd,
    '基准 60 分钟末条时间',
  );
  if (parseBeijing(firstSixtyStart) >= parseBeijing(lastSixtyEnd)
    || bars60.derivedFrom !== 'bars5') {
    throw new Error('基准 60 分钟保护范围无效');
  }

  const mappings = objectValue(protection.mappings, '基准主力映射保护范围');
  assertExactKeys(
    mappings,
    ['firstTradingDate', 'lastTradingDate'],
    '基准主力映射保护范围',
  );
  assertTradingDate(mappings.firstTradingDate, '基准主力映射首个交易日');
  assertTradingDate(mappings.lastTradingDate, '基准主力映射末个交易日');
  if (mappings.firstTradingDate > mappings.lastTradingDate) {
    throw new Error('基准主力映射保护范围无效');
  }

  const rollovers = objectValue(protection.rollovers, '基准换月保护范围');
  assertExactKeys(
    rollovers,
    ['firstTradingDate', 'lastTradingDate'],
    '基准换月保护范围',
  );
  assertTradingDate(rollovers.firstTradingDate, '基准换月首个交易日');
  assertTradingDate(rollovers.lastTradingDate, '基准换月末个交易日');
  if (rollovers.firstTradingDate > rollovers.lastTradingDate
    || rollovers.firstTradingDate < mappings.firstTradingDate
    || rollovers.lastTradingDate > mappings.lastTradingDate) {
    throw new Error('基准换月保护范围无效');
  }

  if (protection.minutePolicy !== 'preserved-audit-only') {
    throw new Error('基准分钟保护策略无效');
  }
  assertSha256(protection.reportSha256, '基准保护报告哈希');
  assertRedistributionDenied(protection.redistribution, '基准保护');
  if (snapshotRedistribution.allowed !== false) {
    throw new Error('基准快照必须禁止再分发');
  }

  const benchmarkSegments = sourceSegments.filter(
    segment => segment.kind === 'benchmark-main',
  );
  const matchingSegments = benchmarkSegments.filter(
    segment => segment.sourceId === sourceSegmentId,
  );
  if (benchmarkSegments.length !== 1
    || matchingSegments.length !== 1
    || matchingSegments[0].coverage.first !== firstStart
    || matchingSegments[0].coverage.last !== lastEnd
    || matchingSegments[0].license.redistributionAllowed !== false) {
    throw new Error('基准保护来源分段无效');
  }
}

function parseMetadata(
  text: string,
  expectedId: string | undefined,
  definition: InstrumentDefinition,
): MarketSnapshotMetadata {
  const value = parseObject(text, METADATA_FILE);
  const schemaVersion = value.schemaVersion;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion as number)) {
    throw new Error('快照 schema 不受支持');
  }
  if (typeof value.snapshotId !== 'string') throw new Error('快照标识无效');
  assertSnapshotId(value.snapshotId);
  if (expectedId !== undefined && value.snapshotId !== expectedId) {
    throw new Error('快照标识与目录不一致');
  }
  const v7Storage = schemaVersion === 7
    ? parseV7Storage(value.storage)
    : undefined;
  if (schemaVersion === 7) {
    if (definition.id !== 'glass_main') {
      throw new Error('schema v7 仅支持玻璃主连');
    }
    if (['base', 'replacementCutoff', 'layerSequence'].some(
      key => Object.prototype.hasOwnProperty.call(value, key),
    )) {
      throw new Error('schema v7 不允许旧版尾部存储字段');
    }
  }
  const source = value.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('快照数据源声明无效');
  }
  const sourceRecord = source as Record<string, unknown>;
  if (schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7) {
    if (!['EDB', 'MIXED'].includes(sourceRecord.provider as string)
      || typeof sourceRecord.symbol !== 'string'
      || (sourceRecord.endpoint !== undefined
        && sourceRecord.endpoint !== 'https://edb.shinnytech.com/md/kline')) {
      throw new Error('快照数据源声明无效');
    }
  } else if (sourceRecord.provider !== 'EDB'
    || sourceRecord.endpoint !== 'https://edb.shinnytech.com/md/kline'
    || typeof sourceRecord.symbol !== 'string') {
    throw new Error('快照数据源声明无效');
  }
  if ((schemaVersion as number) >= 4) {
    if (value.instrumentId !== definition.id
      || value.mainSymbol !== definition.mainSymbol
      || value.parameterVersion !== definition.parameterVersion
      || sourceRecord.symbol !== definition.mainSymbol) {
      throw new Error('快照品种声明与当前品种不匹配');
    }
  } else if (definition.id !== DEFAULT_INSTRUMENT.id
    || sourceRecord.symbol !== DEFAULT_INSTRUMENT.mainSymbol) {
    throw new Error('旧版快照仅支持豆粕主连');
  }
  const filesValue = value.files;
  if (!filesValue || typeof filesValue !== 'object' || Array.isArray(filesValue)) {
    throw new Error('快照文件元数据无效');
  }
  const files = filesValue as Record<string, unknown>;
  const bars5File = fileMetadata(files, 'bars5');
  const bars60File = fileMetadata(files, 'bars60');
  if ((schemaVersion as number) >= 2) fileMetadata(files, 'rollovers');
  if (schemaVersion === 3 || schemaVersion === 4) fileMetadata(files, 'bars1');
  if ((schemaVersion as number) >= 4) {
    fileMetadata(files, 'mainContractMappings');
  }
  if (schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7) {
    const isFullStorage = schemaVersion === 5 || v7Storage?.kind === 'full';
    const bars1File = isFullStorage
      ? optionalFileMetadata(files, 'bars1')
      : fileMetadata(files, 'bars1');
    const periods = value.periods;
    if (!periods || typeof periods !== 'object' || Array.isArray(periods)) {
      throw new Error('快照周期覆盖元数据无效');
    }
    const periodRecord = periods as Record<string, unknown>;
    assertPeriodMetadata(
      periodRecord.bars5,
      '5 分钟',
      isFullStorage ? bars5File.rows : undefined,
    );
    assertPeriodMetadata(
      periodRecord.bars60,
      '60 分钟',
      isFullStorage ? bars60File.rows : undefined,
    );
    if (isFullStorage) {
      if ((bars1File === undefined) !== (periodRecord.bars1 === undefined)) {
        throw new Error('快照 1 分钟文件与覆盖元数据不一致');
      }
      if (bars1File) {
        assertPeriodMetadata(periodRecord.bars1, '1 分钟', bars1File.rows);
      }
    } else if (periodRecord.bars1 === undefined) {
      if (bars1File?.rows !== 0) {
        throw new Error('尾部快照 1 分钟覆盖元数据无效');
      }
    } else {
      assertPeriodMetadata(periodRecord.bars1, '1 分钟');
    }
    assertSourceSegments(value.sourceSegments);
    assertRedistribution(value.redistribution);
    if (schemaVersion === 6) {
      const base = value.base;
      if (!base || typeof base !== 'object' || Array.isArray(base)) {
        throw new Error('尾部快照基础引用无效');
      }
      const baseRecord = base as Record<string, unknown>;
      assertSnapshotId(baseRecord.snapshotId);
      if (typeof baseRecord.metadataSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(baseRecord.metadataSha256)) {
        throw new Error('尾部快照基础元数据哈希无效');
      }
      if (typeof value.replacementCutoff !== 'string') {
        throw new Error('尾部快照替换起点无效');
      }
      parseBeijing(value.replacementCutoff);
      if (!Number.isSafeInteger(value.layerSequence)
        || (value.layerSequence as number) <= 0) {
        throw new Error('尾部快照层序号无效');
      }
    } else if (schemaVersion === 7) {
      assertBenchmarkProtection(
        value.benchmarkProtection,
        value.sourceSegments,
        value.redistribution,
      );
    }
  }
  for (const field of ['generatedAt', 'requestStart', 'requestEnd', 'sourceLatestAt'] as const) {
    if (typeof value[field] !== 'string') throw new Error(`快照缺少 ${field}`);
  }
  parseBeijing(value.requestStart as string);
  parseBeijing(value.requestEnd as string);
  parseBeijing(value.sourceLatestAt as string);
  if (Number.isNaN(Date.parse(value.generatedAt as string))) {
    throw new Error('快照生成时间无效');
  }
  return value as unknown as MarketSnapshotMetadata;
}

function instrumentBuiltinDirectory(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): string {
  return join(paths.builtinDataDirectory, 'instruments', definition.id);
}

function instrumentMarketDataDirectory(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): string {
  return join(paths.marketDataDirectory, 'instruments', definition.id);
}

export function resolveInstrumentDataDirectories(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): { builtin: string; user: string } {
  return {
    builtin: instrumentBuiltinDirectory(paths, definition),
    user: instrumentMarketDataDirectory(paths, definition),
  };
}

function legacyBuiltinDirectory(paths: MarketDataPaths): string {
  return paths.legacyBuiltinDataDirectory ?? paths.builtinDataDirectory;
}

function validateSnapshotData(
  definition: InstrumentDefinition,
  bars1: EdbMinuteRecord[],
  bars5: Bar[],
  bars60: Bar[],
  schemaVersion: MarketSnapshotMetadata['schemaVersion'],
): void {
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  if (schemaVersion === 5) {
    reconcileBars(bars5, bars60, definition.tradingSessions);
    assertMinuteCoverageMatchesFiveMinuteBars(
      bars1,
      bars5,
      definition.tradingSessions,
    );
  } else {
    reconcileCompatibleBars(bars5, bars60, definition.tradingSessions);
  }
}

function validateV7ProtectionData(
  definition: InstrumentDefinition,
  protection: MarketSnapshotBenchmarkProtection,
  bars1: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  mainContractMappings: readonly MainContractMapping[],
  rollovers: readonly ContractRollover[],
): void {
  const firstProtectedStartMs = parseBeijing(protection.bars5.firstStart);
  const lastProtectedEndMs = parseBeijing(protection.bars5.lastEnd);
  auditThsGlassMainMinuteProtection(
    bars1,
    bars5,
    bars60,
    firstProtectedStartMs,
    lastProtectedEndMs,
  );

  const protectedBars5 = bars5.filter(bar => (
    bar.startMs >= firstProtectedStartMs
    && bar.endMs <= lastProtectedEndMs
  ));
  const rebuiltProtectedBars60 = aggregateFiveMinuteBars(
    protectedBars5,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  if (!rebuiltProtectedBars60.length
    || rebuiltProtectedBars60[0].start !== protection.bars60.firstStart
    || rebuiltProtectedBars60.at(-1)!.end !== protection.bars60.lastEnd) {
    throw new Error('基准 60 分钟保护范围与 5 分钟重建结果不一致');
  }

  const hasMappingDate = (tradingDate: string) => (
    mainContractMappings.some(mapping => mapping.tradingDate === tradingDate)
  );
  if (!hasMappingDate(protection.mappings.firstTradingDate)
    || !hasMappingDate(protection.mappings.lastTradingDate)) {
    throw new Error('基准主力映射保护边界不存在');
  }

  const hasRolloverDate = (tradingDate: string) => (
    rollovers.some(rollover => rollover.tradingDate === tradingDate)
  );
  if (!hasRolloverDate(protection.rollovers.firstTradingDate)
    || !hasRolloverDate(protection.rollovers.lastTradingDate)
    || protection.rollovers.firstTradingDate < protection.mappings.firstTradingDate
    || protection.rollovers.lastTradingDate > protection.mappings.lastTradingDate) {
    throw new Error('基准换月保护边界不存在或越过主力映射范围');
  }
}

function validateV7Protection(
  definition: InstrumentDefinition,
  metadata: MarketSnapshotMetadataV7,
  bars1: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  mainContractMappings: readonly MainContractMapping[],
  rollovers: readonly ContractRollover[],
): void {
  validateV7ProtectionData(
    definition,
    metadata.benchmarkProtection,
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
  );
}

function deriveLegacyMappings(
  bars5: Bar[],
  rollovers: ContractRollover[],
  definition: InstrumentDefinition,
): MainContractMapping[] {
  if (!rollovers.length) return [];
  let initialDate = bars5[0]?.start.slice(0, 10) ?? rollovers[0].tradingDate;
  if (initialDate >= rollovers[0].tradingDate) {
    initialDate = formatBeijing(
      parseBeijing(`${rollovers[0].tradingDate} 00:00:00`) - 24 * 60 * 60 * 1000,
    ).slice(0, 10);
  }
  return parseMainContractMappings(serializeMainContractMappings([
    { tradingDate: initialDate, contract: rollovers[0].fromContract },
    ...rollovers.map(rollover => ({
      tradingDate: rollover.tradingDate,
      contract: rollover.toContract,
    })),
  ], definition), '旧版主力映射', definition);
}

async function readRequiredFile(directory: string, name: string): Promise<string> {
  const path = join(directory, name);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`${name}：${code === 'ENOENT' ? '文件不存在，请恢复 data 目录后重试' : '文件无法读取'}。\n位置：${path}`);
  }
}

async function readVerifiedFile(
  directory: string,
  metadata: SnapshotFileMetadata,
  expectedName: string,
): Promise<string> {
  if (metadata.name !== expectedName) throw new Error('快照文件名与元数据不一致');
  const text = await readFile(join(directory, expectedName), 'utf8');
  if (sha256(text) !== metadata.sha256) throw new Error('快照文件哈希不一致');
  return text;
}

function assertLoadedPeriods(
  metadata:
    | MarketSnapshotMetadataV5
    | MarketSnapshotMetadataV6
    | MarketSnapshotMetadataV7,
  bars1: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  bars60: readonly Bar[],
): void {
  const samePeriod = (
    actual: MarketSnapshotMetadataV5['periods']['bars1'],
    first: string,
    last: string,
    rows: number,
  ) => actual?.first === first
    && actual.last === last
    && actual.rows === rows;
  const bars1Matches = bars1.length
    ? samePeriod(
        metadata.periods.bars1,
        bars1[0].start,
        bars1.at(-1)!.start,
        bars1.length,
      )
    : metadata.periods.bars1 === undefined;
  if (!bars1Matches
    || !samePeriod(
      metadata.periods.bars5,
      bars5[0].start,
      bars5.at(-1)!.end,
      bars5.length,
    )
    || !samePeriod(
      metadata.periods.bars60,
      bars60[0].start,
      bars60.at(-1)!.end,
      bars60.length,
    )) {
    throw new Error('快照周期覆盖元数据与文件内容不一致');
  }
}

async function loadStandaloneMetadataSnapshotDirectory(
  directory: string,
  expectedId: string | undefined,
  definition: InstrumentDefinition,
  metadata: Exclude<
    MarketSnapshotMetadata,
    MarketSnapshotMetadataV6 | MarketSnapshotMetadataV7Tail
  >,
  source: SnapshotSource,
  fallback?: LoadedMarketSnapshot,
): Promise<LoadedMarketSnapshot> {
  if (expectedId !== undefined && metadata.snapshotId !== expectedId) {
    throw new Error('快照标识与目录不一致');
  }
  const files = metadata.files as unknown as Record<
    string,
    SnapshotFileMetadata | undefined
  >;
  const bars5File = files.bars5;
  const bars60File = files.bars60;
  if (!bars5File || !bars60File) throw new Error('快照文件元数据无效');
  const [fiveText, sixtyText] = await Promise.all([
    readVerifiedFile(directory, bars5File, FIVE_MINUTE_FILE),
    readVerifiedFile(directory, bars60File, SIXTY_MINUTE_FILE),
  ]);
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  if (bars5.length !== bars5File.rows || bars60.length !== bars60File.rows) {
    throw new Error('快照记录数与元数据不一致');
  }

  let bars1: EdbMinuteRecord[];
  if ((metadata.schemaVersion === 5 || metadata.schemaVersion === 7)
    && !files.bars1) {
    bars1 = [];
  } else if (metadata.schemaVersion >= 3) {
    const bars1File = files.bars1;
    if (!bars1File) throw new Error('快照文件元数据无效');
    const oneText = await readVerifiedFile(
      directory,
      bars1File,
      ONE_MINUTE_FILE,
    );
    bars1 = parseEdbMinuteCsv(
      oneText,
      ONE_MINUTE_FILE,
      definition.tradingSessions,
    );
    if (bars1.length !== bars1File.rows) {
      throw new Error('快照 1 分钟记录数与元数据不一致');
    }
  } else {
    if (!fallback) throw new Error('旧版快照缺少可用的内置 1 分钟基线');
    bars1 = fallback.bars1;
  }

  let rollovers: ContractRollover[];
  if (metadata.schemaVersion >= 2) {
    const rolloverFile = files.rollovers;
    if (!rolloverFile) throw new Error('快照文件元数据无效');
    const rolloverText = await readVerifiedFile(
      directory,
      rolloverFile,
      ROLLOVER_FILE,
    );
    rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE, definition);
    if (rollovers.length !== rolloverFile.rows) {
      throw new Error('快照换月记录数与元数据不一致');
    }
  } else {
    if (!fallback) throw new Error('旧版快照缺少可用的内置换月基线');
    rollovers = fallback.rollovers;
  }

  let mainContractMappings: MainContractMapping[];
  if (metadata.schemaVersion >= 4) {
    const mappingFile = files.mainContractMappings;
    if (!mappingFile) throw new Error('快照文件元数据无效');
    const mappingText = await readVerifiedFile(
      directory,
      mappingFile,
      MAPPING_FILE,
    );
    mainContractMappings = parseMainContractMappings(
      mappingText,
      MAPPING_FILE,
      definition,
    );
    if (mainContractMappings.length !== mappingFile.rows) {
      throw new Error('快照主力映射记录数与元数据不一致');
    }
  } else if (metadata.schemaVersion === 1 && fallback) {
    mainContractMappings = fallback.mainContractMappings;
  } else {
    mainContractMappings = deriveLegacyMappings(bars5, rollovers, definition);
  }

  if (metadata.schemaVersion === 7) {
    validateV7Protection(
      definition,
      metadata,
      bars1,
      bars5,
      bars60,
      mainContractMappings,
      rollovers,
    );
  } else {
    validateSnapshotData(
      definition,
      bars1,
      bars5,
      bars60,
      metadata.schemaVersion,
    );
  }
  if (metadata.schemaVersion === 5 || metadata.schemaVersion === 7) {
    assertLoadedPeriods(metadata, bars1, bars5, bars60);
  }
  return {
    source,
    directory,
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
    sourceLatestAt: metadata.sourceLatestAt,
    snapshotUpdatedAt: source === 'user' ? metadata.generatedAt : undefined,
    metadata,
  };
}

function snapshotDirectoryRoot(directory: string): string {
  const parent = dirname(directory);
  return basename(parent) === 'snapshots' ? parent : join(parent, 'snapshots');
}

async function fileSignatures(
  directory: string,
  metadata: MarketSnapshotMetadataV5 | MarketSnapshotMetadataV7Full,
): Promise<string[]> {
  const files = Object.values(metadata.files)
    .filter((file): file is SnapshotFileMetadata => file !== undefined);
  return Promise.all(files.map(async file => {
    const info = await stat(join(directory, file.name));
    if (!info.isFile()) throw new Error('基础快照文件无效');
    return `${file.name}:${info.size}:${info.mtimeMs}`;
  }));
}

async function loadVerifiedBaseSnapshot(
  layerDirectory: string,
  metadata: MarketSnapshotMetadataV6 | MarketSnapshotMetadataV7Tail,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  const baseReference = metadata.schemaVersion === 6
    ? metadata.base
    : metadata.storage.base;
  const baseDirectory = join(
    snapshotDirectoryRoot(layerDirectory),
    baseReference.snapshotId,
  );
  const metadataText = await readFile(join(baseDirectory, METADATA_FILE), 'utf8');
  if (sha256(metadataText) !== baseReference.metadataSha256) {
    throw new Error('尾部快照基础元数据哈希不一致');
  }
  const baseMetadata = parseMetadata(
    metadataText,
    baseReference.snapshotId,
    definition,
  );
  let verifiedBaseMetadata:
    | MarketSnapshotMetadataV5
    | MarketSnapshotMetadataV7Full;
  if (metadata.schemaVersion === 6) {
    if (baseMetadata.schemaVersion !== 5) {
      throw new Error('尾部快照必须直接引用 schema 5 基础快照');
    }
    verifiedBaseMetadata = baseMetadata;
  } else {
    if (!isV7Full(baseMetadata)) {
      throw new Error('schema v7 尾部快照必须直接引用 schema v7 完整基础快照');
    }
    verifiedBaseMetadata = baseMetadata;
  }
  const signatures = await fileSignatures(baseDirectory, verifiedBaseMetadata);
  const cacheKey = `${baseDirectory}\0${baseReference.metadataSha256}`;
  const cached = verifiedBaseCache.get(cacheKey);
  if (cached
    && cached.signatures.length === signatures.length
    && cached.signatures.every((signature, index) => signature === signatures[index])) {
    return cached.snapshot;
  }
  const snapshot = await loadStandaloneMetadataSnapshotDirectory(
    baseDirectory,
    baseReference.snapshotId,
    definition,
    verifiedBaseMetadata,
    'user',
  );
  verifiedBaseCache.set(cacheKey, { signatures, snapshot });
  return snapshot;
}

function mergeTailRecords<T extends { startMs: number }>(
  base: readonly T[],
  tail: readonly T[],
  cutoffMs: number,
  endMs: (value: T) => number,
  label: string,
): T[] {
  if (tail.some(value => value.startMs < cutoffMs)) {
    throw new Error(`${label}尾部包含替换起点之前的记录`);
  }
  const prefix = base.filter(value => value.startMs < cutoffMs);
  if (prefix.some(value => endMs(value) > cutoffMs)) {
    throw new Error(`${label}基础前缀跨越替换起点`);
  }
  const previous = prefix.at(-1);
  const first = tail[0];
  if (previous && first
    && (first.startMs <= previous.startMs || first.startMs < endMs(previous))) {
    throw new Error(`${label}基础前缀与尾部重叠`);
  }
  return [...prefix, ...tail];
}

function mergeOverlappingTailRecords<T extends { startMs: number }>(
  base: readonly T[],
  tail: readonly T[],
  cutoffMs: number,
  endMs: (value: T) => number,
  label: string,
): T[] {
  if (tail.some(value => endMs(value) <= cutoffMs)) {
    throw new Error(`${label}尾部包含替换起点之前的记录`);
  }
  const prefix = base.filter(value => endMs(value) <= cutoffMs);
  const previous = prefix.at(-1);
  const first = tail[0];
  if (previous && first && endMs(previous) > first.startMs) {
    throw new Error(`${label}基础前缀与尾部重叠`);
  }
  return [...prefix, ...tail];
}

function parseTailBars(
  text: string,
  expectedRows: number,
  filename: string,
): Bar[] {
  if (expectedRows === 0) {
    if (text !== serializeBars([])) {
      throw new Error(`${filename} 空尾部文件格式无效`);
    }
    return [];
  }
  return parseBars(text, filename);
}

function parseTailMinutes(
  text: string,
  expectedRows: number,
  definition: InstrumentDefinition,
): EdbMinuteRecord[] {
  if (expectedRows === 0) {
    if (text !== serializeMinuteRecords([], definition.tradingSessions)) {
      throw new Error(`${ONE_MINUTE_FILE} 空尾部文件格式无效`);
    }
    return [];
  }
  return parseEdbMinuteCsv(
    text,
    ONE_MINUTE_FILE,
    definition.tradingSessions,
  );
}

function validateTailReplacement(
  definition: InstrumentDefinition,
  bars1: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  bars60: readonly Bar[],
): void {
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  reconcileBars(bars5, bars60, definition.tradingSessions);
  assertMinuteCoverageMatchesFiveMinuteBars(
    bars1,
    bars5,
    definition.tradingSessions,
  );
}

function assertV7TailBaseProtection(
  metadata: MarketSnapshotMetadataV7Tail,
  base: LoadedMarketSnapshot,
): asserts base is LoadedMarketSnapshot & {
  metadata: MarketSnapshotMetadataV7Full;
} {
  if (base.metadata?.schemaVersion !== 7
    || base.metadata.storage.kind !== 'full') {
    throw new Error('schema v7 尾部快照基础保护元数据无效');
  }
  if (!isDeepStrictEqual(
    metadata.benchmarkProtection,
    base.metadata.benchmarkProtection,
  )) {
    throw new Error('schema v7 尾部快照基准保护元数据与基础快照不一致');
  }
  const benchmarkSegment = metadata.sourceSegments.filter(
    segment => segment.kind === 'benchmark-main',
  );
  const baseBenchmarkSegment = base.metadata.sourceSegments.filter(
    segment => segment.kind === 'benchmark-main',
  );
  if (benchmarkSegment.length !== 1
    || baseBenchmarkSegment.length !== 1
    || !isDeepStrictEqual(benchmarkSegment[0], baseBenchmarkSegment[0])) {
    throw new Error('schema v7 尾部快照基准来源分段与基础快照不一致');
  }
}

function assertV7ProtectedDataUnchanged(
  protection: MarketSnapshotBenchmarkProtection,
  base: LoadedMarketSnapshot,
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  mainContractMappings: readonly MainContractMapping[],
  rollovers: readonly ContractRollover[],
): void {
  assertBenchmarkProtectionUnchanged(
    protection,
    base,
    {
      bars5,
      bars60,
      mainContractMappings,
      rollovers,
    },
  );
}

async function loadTailLayerSnapshotDirectory(
  directory: string,
  definition: InstrumentDefinition,
  metadata: MarketSnapshotMetadataV6 | MarketSnapshotMetadataV7Tail,
  source: SnapshotSource,
): Promise<LoadedMarketSnapshot> {
  if (source !== 'user') throw new Error('内置快照不支持尾部增量层');
  const files = metadata.files;
  const [
    oneText,
    fiveText,
    sixtyText,
    rolloverText,
    mappingText,
    base,
  ] = await Promise.all([
    readVerifiedFile(directory, files.bars1, ONE_MINUTE_FILE),
    readVerifiedFile(directory, files.bars5, FIVE_MINUTE_FILE),
    readVerifiedFile(directory, files.bars60, SIXTY_MINUTE_FILE),
    readVerifiedFile(directory, files.rollovers, ROLLOVER_FILE),
    readVerifiedFile(directory, files.mainContractMappings, MAPPING_FILE),
    loadVerifiedBaseSnapshot(directory, metadata, definition),
  ]);
  if (metadata.schemaVersion === 7) {
    assertV7TailBaseProtection(metadata, base);
  }
  const bars1Tail = parseTailMinutes(
    oneText,
    files.bars1.rows,
    definition,
  );
  const bars5Tail = parseTailBars(
    fiveText,
    files.bars5.rows,
    FIVE_MINUTE_FILE,
  );
  const bars60Tail = parseTailBars(
    sixtyText,
    files.bars60.rows,
    SIXTY_MINUTE_FILE,
  );
  const rollovers = parseContractRollovers(
    rolloverText,
    ROLLOVER_FILE,
    definition,
  );
  const mainContractMappings = parseMainContractMappings(
    mappingText,
    MAPPING_FILE,
    definition,
  );
  if (bars1Tail.length !== files.bars1.rows
    || bars5Tail.length !== files.bars5.rows
    || bars60Tail.length !== files.bars60.rows
    || rollovers.length !== files.rollovers.rows
    || mainContractMappings.length !== files.mainContractMappings.rows) {
    throw new Error('尾部快照记录数与元数据不一致');
  }
  const cutoffMs = parseBeijing(
    metadata.schemaVersion === 6
      ? metadata.replacementCutoff
      : metadata.storage.replacementCutoff,
  );
  const bars1 = mergeTailRecords(
    base.bars1,
    bars1Tail,
    cutoffMs,
    value => value.startMs + 60_000,
    '1 分钟',
  );
  const bars5 = mergeTailRecords(
    base.bars5,
    bars5Tail,
    cutoffMs,
    value => value.endMs,
    '5 分钟',
  );
  const bars60 = metadata.schemaVersion === 6
    ? mergeTailRecords(
        base.bars60,
        bars60Tail,
        cutoffMs,
        value => value.endMs,
        '60 分钟',
      )
    : mergeOverlappingTailRecords(
        base.bars60,
        bars60Tail,
        cutoffMs,
        value => value.endMs,
        '60 分钟',
      );
  if (metadata.schemaVersion === 6) {
    validateTailReplacement(
      definition,
      bars1.filter(record => record.startMs >= cutoffMs),
      bars5.filter(bar => bar.startMs >= cutoffMs),
      bars60.filter(bar => bar.startMs >= cutoffMs),
    );
  } else {
    assertV7ProtectedDataUnchanged(
      metadata.benchmarkProtection,
      base,
      bars5,
      bars60,
      mainContractMappings,
      rollovers,
    );
    validateV7Protection(
      definition,
      metadata,
      bars1,
      bars5,
      bars60,
      mainContractMappings,
      rollovers,
    );
  }
  assertLoadedPeriods(metadata, bars1, bars5, bars60);
  return {
    source,
    directory,
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
    sourceLatestAt: metadata.sourceLatestAt,
    snapshotUpdatedAt: metadata.generatedAt,
    metadata,
  };
}

async function loadMetadataSnapshotDirectory(
  directory: string,
  expectedId: string | undefined,
  definition: InstrumentDefinition,
  source: SnapshotSource,
  fallback?: LoadedMarketSnapshot,
): Promise<LoadedMarketSnapshot> {
  const metadata = parseMetadata(
    await readFile(join(directory, METADATA_FILE), 'utf8'),
    expectedId,
    definition,
  );
  if (source === 'builtin' && metadata.schemaVersion === 7) {
    throw new Error('内置快照不支持 schema v7 基准保护数据');
  }
  if (metadata.schemaVersion === 6) {
    return loadTailLayerSnapshotDirectory(
      directory,
      definition,
      metadata,
      source,
    );
  }
  if (isV7Tail(metadata)) {
    return loadTailLayerSnapshotDirectory(
      directory,
      definition,
      metadata,
      source,
    );
  }
  return loadStandaloneMetadataSnapshotDirectory(
    directory,
    expectedId,
    definition,
    metadata,
    source,
    fallback,
  );
}

async function loadLegacyBuiltinSnapshot(
  directory: string,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  if (definition.id !== DEFAULT_INSTRUMENT.id) {
    throw new Error(`${definition.name} 缺少按品种隔离的内置数据目录`);
  }
  const [oneText, fiveText, sixtyText, rolloverText] = await Promise.all([
    readRequiredFile(directory, ONE_MINUTE_FILE),
    readRequiredFile(directory, FIVE_MINUTE_FILE),
    readRequiredFile(directory, SIXTY_MINUTE_FILE),
    readRequiredFile(directory, ROLLOVER_FILE),
  ]);
  const bars1 = parseEdbMinuteCsv(
    oneText,
    ONE_MINUTE_FILE,
    definition.tradingSessions,
  );
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  const rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE, definition);
  validateSnapshotData(definition, bars1, bars5, bars60, 3);
  return {
    source: 'builtin',
    directory,
    bars1,
    bars5,
    bars60,
    mainContractMappings: deriveLegacyMappings(bars5, rollovers, definition),
    rollovers,
    sourceLatestAt: formatBeijing(Math.max(
      bars1.at(-1)?.startMs ?? 0,
      bars5.at(-1)?.endMs ?? 0,
      bars60.at(-1)?.endMs ?? 0,
    )),
  };
}

export function prepareSnapshotDirectory(
  request: SnapshotDirectoryLoadRequest,
): Promise<LoadedMarketSnapshot> {
  if (request.kind === 'legacy-builtin') {
    return loadLegacyBuiltinSnapshot(request.directory, request.definition);
  }
  return loadMetadataSnapshotDirectory(
    request.directory,
    request.expectedId,
    request.definition,
    request.source,
    request.fallback,
  );
}

async function loadBuiltinSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  loadDirectory: SnapshotDirectoryLoader = prepareSnapshotDirectory,
): Promise<LoadedMarketSnapshot> {
  const directory = instrumentBuiltinDirectory(paths, definition);
  try {
    return await loadDirectory({
      kind: 'metadata',
      directory,
      definition,
      source: 'builtin',
    });
  } catch (metadataError) {
    if (definition.id !== DEFAULT_INSTRUMENT.id) throw metadataError;
    try {
      return await loadDirectory({
        kind: 'legacy-builtin',
        directory: legacyBuiltinDirectory(paths),
        definition,
      });
    } catch {
      throw metadataError;
    }
  }
}

async function readCurrentPointer(directory: string): Promise<CurrentPointer> {
  const value = parseObject(
    await readFile(join(directory, POINTER_FILE), 'utf8'),
    POINTER_FILE,
  );
  if (!SUPPORTED_SCHEMA_VERSIONS.has(value.schemaVersion as number)
    || typeof value.updatedAt !== 'string'
    || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error('当前快照指针无效');
  }
  assertSnapshotId(value.snapshotId);
  return value as unknown as CurrentPointer;
}

async function activatedSnapshots(directory: string): Promise<ActivatedSnapshot[]> {
  const snapshots = join(directory, 'snapshots');
  let entries;
  try {
    entries = await readdir(snapshots, { withFileTypes: true });
  } catch {
    return [];
  }
  const activated: ActivatedSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) continue;
    try {
      const marker = parseObject(
        await readFile(join(snapshots, entry.name, ACTIVATED_FILE), 'utf8'),
        ACTIVATED_FILE,
      );
      const activatedAt = typeof marker.activatedAt === 'string'
        ? Date.parse(marker.activatedAt)
        : Number.NaN;
      if (Number.isNaN(activatedAt)) continue;
      activated.push({ id: entry.name, time: activatedAt });
    } catch {
      // Incomplete candidates are intentionally invisible.
    }
  }
  return activated
    .sort((left, right) => right.time - left.time);
}

async function readSnapshotMetadata(
  directory: string,
  snapshotId: string,
  definition: InstrumentDefinition,
): Promise<{ metadata: MarketSnapshotMetadata; metadataText: string }> {
  const metadataText = await readFile(
    join(directory, 'snapshots', snapshotId, METADATA_FILE),
    'utf8',
  );
  return {
    metadata: parseMetadata(metadataText, snapshotId, definition),
    metadataText,
  };
}

async function activationReportSnapshotIds(
  directory: string,
  definition: InstrumentDefinition,
): Promise<string[]> {
  const repairsDirectory = join(
    dirname(dirname(directory)),
    'repairs',
    definition.id,
  );
  let runs;
  try {
    runs = await readdir(repairsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const referenced = new Map<string, number>();
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const reportPath = join(
      repairsDirectory,
      run.name,
      'reports',
      'activation.json',
    );
    try {
      const report = parseObject(
        await readFile(reportPath, 'utf8'),
        'activation.json',
      );
      assertSnapshotId(report.snapshotId);
      assertSha256(report.metadataSha256, '激活报告元数据哈希');
      const { metadata, metadataText } = await readSnapshotMetadata(
        directory,
        report.snapshotId,
        definition,
      );
      if (metadata.schemaVersion !== 7
        || sha256(metadataText) !== report.metadataSha256) {
        continue;
      }
      const reportInfo = await stat(reportPath);
      referenced.set(
        report.snapshotId,
        Math.max(referenced.get(report.snapshotId) ?? 0, reportInfo.mtimeMs),
      );
    } catch {
      // Broken or stale reports must not protect unrelated snapshots.
    }
  }
  return [...referenced]
    .sort((left, right) => right[1] - left[1])
    .map(([snapshotId]) => snapshotId);
}

async function snapshotCandidates(
  directory: string,
  definition: InstrumentDefinition,
): Promise<string[]> {
  const candidates: string[] = [];
  const add = (snapshotId: string | undefined) => {
    if (snapshotId && !candidates.includes(snapshotId)) {
      candidates.push(snapshotId);
    }
  };
  const pointerId = await readCurrentPointer(directory)
    .then(pointer => pointer.snapshotId)
    .catch(() => undefined);
  const activated = await activatedSnapshots(directory);
  const schemaVersions = new Map<string, number | undefined>();
  const schemaVersion = async (snapshotId: string | undefined) => {
    if (!snapshotId) return undefined;
    if (!schemaVersions.has(snapshotId)) {
      const version = await readSnapshotMetadata(
        directory,
        snapshotId,
        definition,
      ).then(value => value.metadata.schemaVersion).catch(() => undefined);
      schemaVersions.set(snapshotId, version);
    }
    return schemaVersions.get(snapshotId);
  };
  if (await schemaVersion(pointerId) === 7) add(pointerId);
  for (const snapshotId of await activationReportSnapshotIds(
    directory,
    definition,
  )) {
    add(snapshotId);
  }
  for (const snapshot of activated) {
    if (await schemaVersion(snapshot.id) === 7) add(snapshot.id);
  }
  const pointerVersion = await schemaVersion(pointerId);
  if (pointerVersion !== undefined && pointerVersion <= 6) add(pointerId);
  for (const snapshot of activated) {
    const version = await schemaVersion(snapshot.id);
    if (version !== undefined && version <= 6) add(snapshot.id);
  }
  return candidates;
}

async function firstValidUserSnapshot(
  directory: string,
  definition: InstrumentDefinition,
  builtin?: LoadedMarketSnapshot,
  loadDirectory: SnapshotDirectoryLoader = prepareSnapshotDirectory,
): Promise<LoadedMarketSnapshot | undefined> {
  for (const snapshotId of await snapshotCandidates(directory, definition)) {
    try {
      return await loadDirectory({
        kind: 'metadata',
        directory: join(directory, 'snapshots', snapshotId),
        expectedId: snapshotId,
        definition,
        source: 'user',
        fallback: builtin,
      });
    } catch {
      // Try the previous activated snapshot before the built-in baseline.
    }
  }
  return undefined;
}

function serializedSnapshot(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): SerializedSnapshot {
  return {
    oneText: candidate.bars1.length
      ? serializeMinuteRecords(candidate.bars1, definition.tradingSessions)
      : undefined,
    fiveText: serializeBars(candidate.bars5),
    sixtyText: serializeBars(candidate.bars60),
    rolloverText: serializeContractRollovers(candidate.rollovers, definition),
    mappingText: serializeMainContractMappings(
      candidate.mainContractMappings,
      definition,
    ),
  };
}

function serializedTailSnapshot(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): SerializedSnapshot {
  return {
    oneText: serializeMinuteRecords(
      candidate.bars1,
      definition.tradingSessions,
    ),
    fiveText: serializeBars(candidate.bars5),
    sixtyText: serializeBars(candidate.bars60),
    rolloverText: serializeContractRollovers(candidate.rollovers, definition),
    mappingText: serializeMainContractMappings(
      candidate.mainContractMappings,
      definition,
    ),
  };
}

function inheritCandidateProvenance(
  candidate: SnapshotCandidate,
  current?: LoadedMarketSnapshot,
): SnapshotCandidate {
  const metadata = current?.metadata;
  if (metadata?.schemaVersion !== 5
    && metadata?.schemaVersion !== 6
    && metadata?.schemaVersion !== 7) {
    return candidate;
  }
  const inherited = {
    ...candidate,
    source: candidate.source ?? metadata.source,
    sourceSegments: candidate.sourceSegments ?? metadata.sourceSegments,
    redistribution: candidate.redistribution ?? metadata.redistribution,
  };
  return metadata.schemaVersion === 7
    ? {
        ...inherited,
        benchmarkProtection: candidate.benchmarkProtection
          ?? metadata.benchmarkProtection,
      }
    : inherited;
}

function prepareCandidateV5(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): PreparedSnapshot {
  if (!candidate.bars5.length) throw new Error('快照缺少必要的 5 分钟行情');
  const bars60 = aggregateFiveMinuteBars(
    candidate.bars5,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  if (!bars60.length) throw new Error('快照缺少可由 5 分钟重建的完整 60 分钟行情');
  const preparedCandidate = {
    ...candidate,
    bars60,
  };
  validateSnapshotData(
    definition,
    preparedCandidate.bars1,
    preparedCandidate.bars5,
    preparedCandidate.bars60,
    5,
  );
  return {
    candidate: preparedCandidate,
    serialized: serializedSnapshot(definition, preparedCandidate),
  };
}

function prepareCandidateV4(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): PreparedSnapshot {
  validateSnapshotData(
    definition,
    candidate.bars1,
    candidate.bars5,
    candidate.bars60,
    4,
  );
  const serialized = serializedSnapshot(definition, candidate);
  if (!serialized.oneText) throw new Error('旧版快照必须包含 1 分钟行情');
  return { candidate, serialized };
}

function prepareCandidateV6(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
  replacementCutoff: string,
): PreparedSnapshot {
  if (!candidate.bars5.length) throw new Error('快照缺少必要的 5 分钟行情');
  if (!candidate.bars60.length) throw new Error('快照缺少必要的 60 分钟行情');
  const cutoffMs = parseBeijing(replacementCutoff);
  const preparedCandidate = {
    ...candidate,
    bars1: candidate.bars1.filter(record => record.startMs >= cutoffMs),
    bars5: candidate.bars5.filter(bar => bar.startMs >= cutoffMs),
    bars60: candidate.bars60.filter(bar => bar.startMs >= cutoffMs),
  };
  validateTailReplacement(
    definition,
    preparedCandidate.bars1,
    preparedCandidate.bars5,
    preparedCandidate.bars60,
  );
  return {
    candidate: preparedCandidate,
    serialized: serializedTailSnapshot(definition, preparedCandidate),
  };
}

function prepareCandidateV7Full(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): PreparedSnapshot {
  if (definition.id !== 'glass_main') {
    throw new Error('schema v7 基准保护快照仅支持玻璃主连');
  }
  const protection = candidate.benchmarkProtection;
  if (!protection) throw new Error('schema v7 快照缺少基准保护元数据');
  if (!candidate.bars5.length) throw new Error('快照缺少必要的 5 分钟行情');
  const bars60 = aggregateFiveMinuteBars(
    candidate.bars5,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  if (!bars60.length) throw new Error('快照缺少可由 5 分钟重建的完整 60 分钟行情');
  const preparedCandidate = {
    ...candidate,
    bars60,
  };
  validateV7ProtectionData(
    definition,
    protection,
    preparedCandidate.bars1,
    preparedCandidate.bars5,
    preparedCandidate.bars60,
    preparedCandidate.mainContractMappings,
    preparedCandidate.rollovers,
  );
  return {
    candidate: preparedCandidate,
    serialized: serializedSnapshot(definition, preparedCandidate),
  };
}

function prepareCandidateV7Tail(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
  current: LoadedMarketSnapshot,
  replacementCutoff: string,
): PreparedSnapshot {
  if (definition.id !== 'glass_main') {
    throw new Error('schema v7 基准保护快照仅支持玻璃主连');
  }
  const protection = candidate.benchmarkProtection;
  if (!protection || current.metadata?.schemaVersion !== 7) {
    throw new Error('schema v7 尾部快照缺少有效的当前保护快照');
  }
  if (!isDeepStrictEqual(protection, current.metadata.benchmarkProtection)) {
    throw new Error('schema v7 尾部快照不得修改基准保护元数据');
  }
  assertV7ProtectedDataUnchanged(
    protection,
    current,
    candidate.bars5,
    candidate.bars60,
    candidate.mainContractMappings,
    candidate.rollovers,
  );
  validateV7ProtectionData(
    definition,
    protection,
    candidate.bars1,
    candidate.bars5,
    candidate.bars60,
    candidate.mainContractMappings,
    candidate.rollovers,
  );
  const cutoffMs = parseBeijing(replacementCutoff);
  const preparedCandidate = {
    ...candidate,
    bars1: candidate.bars1.filter(record => record.startMs >= cutoffMs),
    bars5: candidate.bars5.filter(bar => bar.startMs >= cutoffMs),
    bars60: candidate.bars60.filter(bar => bar.endMs > cutoffMs),
  };
  assertMinuteRecordsValid(
    preparedCandidate.bars1,
    definition.tradingSessions,
  );
  assertBarsValid(
    preparedCandidate.bars5,
    5,
    definition.tradingSessions,
  );
  assertSegmentedSixtyMinuteBarsValid(
    preparedCandidate.bars60,
    definition.tradingSessions,
  );
  assertMinuteCoverageMatchesFiveMinuteBars(
    preparedCandidate.bars1,
    preparedCandidate.bars5,
    definition.tradingSessions,
  );
  return {
    candidate: preparedCandidate,
    serialized: serializedTailSnapshot(definition, preparedCandidate),
  };
}

function buildMetadataV4(
  definition: InstrumentDefinition,
  snapshotId: string,
  candidate: SnapshotCandidate,
  generatedAt: string,
  serialized: SerializedSnapshot,
): MarketSnapshotMetadataV4 {
  if (!serialized.oneText) throw new Error('旧版快照必须包含 1 分钟行情');
  return {
    schemaVersion: 4,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: {
      provider: 'EDB',
      endpoint: 'https://edb.shinnytech.com/md/kline',
      symbol: definition.mainSymbol,
    },
    generatedAt,
    requestStart: candidate.requestStart,
    requestEnd: candidate.requestEnd,
    sourceLatestAt: candidate.sourceLatestAt,
    files: {
      bars1: {
        name: ONE_MINUTE_FILE,
        sha256: sha256(serialized.oneText),
        rows: candidate.bars1.length,
      },
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(serialized.fiveText),
        rows: candidate.bars5.length,
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(serialized.sixtyText),
        rows: candidate.bars60.length,
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(serialized.rolloverText),
        rows: candidate.rollovers.length,
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(serialized.mappingText),
        rows: candidate.mainContractMappings.length,
      },
    },
  };
}

function defaultSourceSegment(
  candidate: SnapshotCandidate,
  serialized: SerializedSnapshot,
  generatedAt: string,
): MarketSnapshotSourceSegment {
  const coverageFirst = candidate.bars1[0]?.start ?? candidate.bars5[0].start;
  const coverageLast = candidate.bars1.at(-1)?.start
    ?? candidate.bars5.at(-1)!.end;
  const rawFile = serialized.oneText
    ? {
        name: 'edb-api-minute-response.csv',
        sha256: sha256(serialized.oneText),
        rows: candidate.bars1.length,
      }
    : {
        name: 'five-minute-source.csv',
        sha256: sha256(serialized.fiveText),
        rows: candidate.bars5.length,
      };
  return {
    sourceId: 'edb-main-continuous',
    sourceName: 'EDB 主连分钟接口',
    kind: 'edb-tail',
    acquiredAt: generatedAt,
    coverage: {
      first: coverageFirst,
      last: coverageLast,
    },
    rawFiles: [rawFile],
    importerVersion: 'moneycoming-snapshot-v5',
    license: {
      identifier: 'EDB account terms',
      redistributionAllowed: false,
      conclusion: '仅供当前用户本机使用，未确认可随产品再分发',
    },
  };
}

function snapshotProvenance(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
  serialized: SerializedSnapshot,
  generatedAt: string,
): Pick<
  MarketSnapshotMetadataV5,
  'source' | 'sourceSegments' | 'redistribution'
> {
  const sourceSegments = candidate.sourceSegments?.length
    ? candidate.sourceSegments
    : [defaultSourceSegment(candidate, serialized, generatedAt)];
  const redistribution = candidate.redistribution ?? (
    sourceSegments.every(segment => segment.license.redistributionAllowed)
      ? {
          allowed: true,
          conclusion: '全部来源均已确认允许随产品再分发',
        }
      : {
          allowed: false,
          conclusion: '至少一个来源未确认允许随产品再分发',
        }
  );
  return {
    source: candidate.source ?? {
      provider: sourceSegments.some(segment => segment.kind !== 'edb-tail')
        ? 'MIXED'
        : 'EDB',
      endpoint: 'https://edb.shinnytech.com/md/kline',
      symbol: definition.mainSymbol,
    },
    sourceSegments,
    redistribution,
  };
}

function snapshotPeriods(
  candidate: SnapshotCandidate,
): MarketSnapshotMetadataV5['periods'] {
  return {
    bars1: candidate.bars1.length ? {
      first: candidate.bars1[0].start,
      last: candidate.bars1.at(-1)!.start,
      rows: candidate.bars1.length,
    } : undefined,
    bars5: {
      first: candidate.bars5[0].start,
      last: candidate.bars5.at(-1)!.end,
      rows: candidate.bars5.length,
    },
    bars60: {
      first: candidate.bars60[0].start,
      last: candidate.bars60.at(-1)!.end,
      rows: candidate.bars60.length,
    },
  };
}

function buildMetadataV5(
  definition: InstrumentDefinition,
  snapshotId: string,
  candidate: SnapshotCandidate,
  generatedAt: string,
  serialized: SerializedSnapshot,
): MarketSnapshotMetadataV5 {
  const provenance = snapshotProvenance(
    definition,
    candidate,
    serialized,
    generatedAt,
  );
  const bars1File = serialized.oneText ? {
    name: ONE_MINUTE_FILE,
    sha256: sha256(serialized.oneText),
    rows: candidate.bars1.length,
  } : undefined;
  return {
    schemaVersion: 5,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: provenance.source,
    generatedAt,
    requestStart: candidate.requestStart,
    requestEnd: candidate.requestEnd,
    sourceLatestAt: candidate.sourceLatestAt,
    sourceSegments: provenance.sourceSegments,
    redistribution: provenance.redistribution,
    periods: snapshotPeriods(candidate),
    files: {
      bars1: bars1File,
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(serialized.fiveText),
        rows: candidate.bars5.length,
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(serialized.sixtyText),
        rows: candidate.bars60.length,
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(serialized.rolloverText),
        rows: candidate.rollovers.length,
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(serialized.mappingText),
        rows: candidate.mainContractMappings.length,
      },
    },
  };
}

function buildMetadataV6(
  definition: InstrumentDefinition,
  snapshotId: string,
  mergedCandidate: SnapshotCandidate,
  tail: PreparedSnapshot,
  generatedAt: string,
  plan: TailLayerPlanV6,
): MarketSnapshotMetadataV6 {
  if (!tail.serialized.oneText) {
    throw new Error('尾部快照必须包含 1 分钟文件');
  }
  const provenance = snapshotProvenance(
    definition,
    mergedCandidate,
    tail.serialized,
    generatedAt,
  );
  return {
    schemaVersion: 6,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: provenance.source,
    generatedAt,
    requestStart: mergedCandidate.requestStart,
    requestEnd: mergedCandidate.requestEnd,
    sourceLatestAt: mergedCandidate.sourceLatestAt,
    sourceSegments: provenance.sourceSegments,
    redistribution: provenance.redistribution,
    base: plan.base,
    replacementCutoff: plan.replacementCutoff,
    layerSequence: plan.layerSequence,
    periods: snapshotPeriods(mergedCandidate),
    files: {
      bars1: {
        name: ONE_MINUTE_FILE,
        sha256: sha256(tail.serialized.oneText),
        rows: tail.candidate.bars1.length,
      },
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(tail.serialized.fiveText),
        rows: tail.candidate.bars5.length,
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(tail.serialized.sixtyText),
        rows: tail.candidate.bars60.length,
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(tail.serialized.rolloverText),
        rows: tail.candidate.rollovers.length,
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(tail.serialized.mappingText),
        rows: tail.candidate.mainContractMappings.length,
      },
    },
  };
}

function buildMetadataV7Full(
  definition: InstrumentDefinition,
  snapshotId: string,
  candidate: SnapshotCandidate,
  generatedAt: string,
  serialized: SerializedSnapshot,
): MarketSnapshotMetadataV7Full {
  const protection = candidate.benchmarkProtection;
  if (!protection) throw new Error('schema v7 快照缺少基准保护元数据');
  const provenance = snapshotProvenance(
    definition,
    candidate,
    serialized,
    generatedAt,
  );
  const bars1File = serialized.oneText ? {
    name: ONE_MINUTE_FILE,
    sha256: sha256(serialized.oneText),
    rows: candidate.bars1.length,
  } : undefined;
  return {
    schemaVersion: 7,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: provenance.source,
    generatedAt,
    requestStart: candidate.requestStart,
    requestEnd: candidate.requestEnd,
    sourceLatestAt: candidate.sourceLatestAt,
    sourceSegments: provenance.sourceSegments,
    redistribution: provenance.redistribution,
    storage: { kind: 'full' },
    periods: snapshotPeriods(candidate),
    benchmarkProtection: protection,
    files: {
      bars1: bars1File,
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(serialized.fiveText),
        rows: candidate.bars5.length,
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(serialized.sixtyText),
        rows: candidate.bars60.length,
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(serialized.rolloverText),
        rows: candidate.rollovers.length,
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(serialized.mappingText),
        rows: candidate.mainContractMappings.length,
      },
    },
  };
}

function buildMetadataV7Tail(
  definition: InstrumentDefinition,
  snapshotId: string,
  mergedCandidate: SnapshotCandidate,
  tail: PreparedSnapshot,
  generatedAt: string,
  plan: TailLayerPlanV7,
): MarketSnapshotMetadataV7Tail {
  const protection = mergedCandidate.benchmarkProtection;
  if (!protection) throw new Error('schema v7 快照缺少基准保护元数据');
  if (!tail.serialized.oneText) {
    throw new Error('schema v7 尾部快照必须包含 1 分钟文件');
  }
  const provenance = snapshotProvenance(
    definition,
    mergedCandidate,
    tail.serialized,
    generatedAt,
  );
  return {
    schemaVersion: 7,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: provenance.source,
    generatedAt,
    requestStart: mergedCandidate.requestStart,
    requestEnd: mergedCandidate.requestEnd,
    sourceLatestAt: mergedCandidate.sourceLatestAt,
    sourceSegments: provenance.sourceSegments,
    redistribution: provenance.redistribution,
    storage: {
      kind: 'tail',
      base: plan.base,
      replacementCutoff: plan.replacementCutoff,
      layerSequence: plan.layerSequence,
    },
    periods: snapshotPeriods(mergedCandidate),
    benchmarkProtection: protection,
    files: {
      bars1: {
        name: ONE_MINUTE_FILE,
        sha256: sha256(tail.serialized.oneText),
        rows: tail.candidate.bars1.length,
      },
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(tail.serialized.fiveText),
        rows: tail.candidate.bars5.length,
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(tail.serialized.sixtyText),
        rows: tail.candidate.bars60.length,
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(tail.serialized.rolloverText),
        rows: tail.candidate.rollovers.length,
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(tail.serialized.mappingText),
        rows: tail.candidate.mainContractMappings.length,
      },
    },
  };
}

async function tailLayerPlan(
  candidate: SnapshotCandidate,
  options: SaveSnapshotOptions,
): Promise<TailLayerPlan | undefined> {
  const threshold = options.tailCompactionThreshold
    ?? DEFAULT_TAIL_COMPACTION_THRESHOLD;
  const current = options.current;
  const metadata = current?.metadata;
  if (options.intent !== 'tail'
    || current?.source !== 'user'
    || !Number.isSafeInteger(threshold)
    || threshold <= 0) {
    return undefined;
  }
  if (candidate.benchmarkProtection) {
    if (metadata?.schemaVersion !== 7) return undefined;
    if (!isDeepStrictEqual(
      candidate.benchmarkProtection,
      metadata.benchmarkProtection,
    )) {
      throw new Error('后续快照不得修改既有基准保护元数据');
    }
    const layerSequence = metadata.storage.kind === 'full'
      ? 1
      : metadata.storage.layerSequence + 1;
    if (layerSequence >= threshold) return undefined;
    const replacementCutoff = metadata.storage.kind === 'full'
      ? candidate.requestStart
      : metadata.storage.replacementCutoff;
    if (parseBeijing(candidate.requestStart) < parseBeijing(replacementCutoff)) {
      return undefined;
    }
    if (metadata.storage.kind === 'tail') {
      return {
        schemaVersion: 7,
        base: metadata.storage.base,
        replacementCutoff,
        layerSequence,
      };
    }
    const metadataText = await readFile(
      join(current.directory, METADATA_FILE),
      'utf8',
    );
    return {
      schemaVersion: 7,
      base: {
        snapshotId: metadata.snapshotId,
        metadataSha256: sha256(metadataText),
      },
      replacementCutoff,
      layerSequence,
    };
  }
  if (metadata?.schemaVersion !== 5 && metadata?.schemaVersion !== 6) {
    return undefined;
  }
  const layerSequence = metadata.schemaVersion === 5
    ? 1
    : metadata.layerSequence + 1;
  if (layerSequence >= threshold) return undefined;
  const replacementCutoff = metadata.schemaVersion === 5
    ? candidate.requestStart
    : metadata.replacementCutoff;
  if (parseBeijing(candidate.requestStart) < parseBeijing(replacementCutoff)) {
    return undefined;
  }
  if (metadata.schemaVersion === 6) {
    return {
      schemaVersion: 6,
      base: metadata.base,
      replacementCutoff,
      layerSequence,
    };
  }
  const metadataText = await readFile(join(current.directory, METADATA_FILE), 'utf8');
  return {
    schemaVersion: 6,
    base: {
      snapshotId: metadata.snapshotId,
      metadataSha256: sha256(metadataText),
    },
    replacementCutoff,
    layerSequence,
  };
}

async function writeSerializedSnapshot(
  directory: string,
  metadata: PersistedSnapshotMetadata,
  serialized: SerializedSnapshot,
): Promise<void> {
  const writes: Array<Promise<void>> = [
    writeFile(join(directory, FIVE_MINUTE_FILE), serialized.fiveText, 'utf8'),
    writeFile(join(directory, SIXTY_MINUTE_FILE), serialized.sixtyText, 'utf8'),
    writeFile(join(directory, ROLLOVER_FILE), serialized.rolloverText, 'utf8'),
    writeFile(join(directory, MAPPING_FILE), serialized.mappingText, 'utf8'),
    writeFile(
      join(directory, METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    ),
  ];
  if (serialized.oneText) {
    writes.push(writeFile(
      join(directory, ONE_MINUTE_FILE),
      serialized.oneText,
      'utf8',
    ));
  }
  await Promise.all(writes);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyBuiltin(
  paths: MarketDataPaths,
  loadDirectory: SnapshotDirectoryLoader = prepareSnapshotDirectory,
): Promise<boolean> {
  if (!paths.legacyBuiltinDataDirectory) return false;
  const target = instrumentBuiltinDirectory(paths, DEFAULT_INSTRUMENT);
  if (await pathExists(target)) return false;
  const legacy = await loadLegacyBuiltinSnapshot(
    paths.legacyBuiltinDataDirectory,
    DEFAULT_INSTRUMENT,
  );
  const generatedAt = new Date().toISOString();
  const candidate: SnapshotCandidate = {
    bars1: legacy.bars1,
    bars5: legacy.bars5,
    bars60: legacy.bars60,
    mainContractMappings: legacy.mainContractMappings,
    rollovers: legacy.rollovers,
    requestStart: legacy.bars1[0]?.start ?? legacy.sourceLatestAt,
    requestEnd: legacy.sourceLatestAt,
    sourceLatestAt: legacy.sourceLatestAt,
  };
  const prepared = prepareCandidateV4(DEFAULT_INSTRUMENT, candidate);
  const metadata = buildMetadataV4(
    DEFAULT_INSTRUMENT,
    'builtin-main_continuous',
    prepared.candidate,
    generatedAt,
    prepared.serialized,
  );
  const parent = dirname(target);
  const staging = join(parent, `.migrating-main_continuous-${randomBytes(4).toString('hex')}`);
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(staging);
    await writeSerializedSnapshot(staging, metadata, prepared.serialized);
    await loadDirectory({
      kind: 'metadata',
      directory: staging,
      definition: DEFAULT_INSTRUMENT,
      source: 'builtin',
    });
    await rename(staging, target);
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (await pathExists(target)) return false;
    throw error;
  }
}

async function writeCurrentPointer(
  directory: string,
  pointer: CurrentPointer,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.current-${pointer.snapshotId}-${randomBytes(4).toString('hex')}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  await rename(temporary, join(directory, POINTER_FILE));
}

async function migrateLegacyUserSnapshot(
  paths: MarketDataPaths,
  builtin: LoadedMarketSnapshot,
  loadDirectory: SnapshotDirectoryLoader,
): Promise<boolean> {
  const target = instrumentMarketDataDirectory(paths, DEFAULT_INSTRUMENT);
  if (await firstValidUserSnapshot(
    target,
    DEFAULT_INSTRUMENT,
    builtin,
    loadDirectory,
  )) {
    return false;
  }
  let pointer: CurrentPointer;
  try {
    pointer = await readCurrentPointer(paths.marketDataDirectory);
  } catch {
    return false;
  }
  const source = join(
    paths.marketDataDirectory,
    'snapshots',
    pointer.snapshotId,
  );
  const legacy = await loadDirectory({
    kind: 'metadata',
    directory: source,
    expectedId: pointer.snapshotId,
    definition: DEFAULT_INSTRUMENT,
    source: 'user',
    fallback: builtin,
  });
  const migratedId = `legacy-${pointer.snapshotId}`.slice(0, 100);
  assertSnapshotId(migratedId);
  const snapshots = join(target, 'snapshots');
  const destination = join(snapshots, migratedId);
  const staging = join(target, `.migrating-${migratedId}`);
  await mkdir(snapshots, { recursive: true });
  if (!await pathExists(destination)) {
    await rm(staging, { recursive: true, force: true });
    try {
      await cp(source, staging, { recursive: true, errorOnExist: true });
      const metadataPath = join(staging, METADATA_FILE);
      const metadata = parseObject(await readFile(metadataPath, 'utf8'), METADATA_FILE);
      metadata.snapshotId = migratedId;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      await writeFile(
        join(staging, ACTIVATED_FILE),
        `${JSON.stringify({ activatedAt: pointer.updatedAt }, null, 2)}\n`,
        'utf8',
      );
      await loadDirectory({
        kind: 'metadata',
        directory: staging,
        expectedId: migratedId,
        definition: DEFAULT_INSTRUMENT,
        source: 'user',
        fallback: builtin,
      });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (!await pathExists(destination)) throw error;
    }
  }
  await loadDirectory({
    kind: 'metadata',
    directory: destination,
    expectedId: migratedId,
    definition: DEFAULT_INSTRUMENT,
    source: 'user',
    fallback: builtin,
  });
  await writeCurrentPointer(target, {
    schemaVersion: legacy.metadata!.schemaVersion,
    snapshotId: migratedId,
    updatedAt: pointer.updatedAt,
  });
  return true;
}

async function performLegacySoymealMigration(
  paths: MarketDataPaths,
  loadDirectory: SnapshotDirectoryLoader,
): Promise<LegacyMigrationResult> {
  const builtinMigrated = await migrateLegacyBuiltin(paths, loadDirectory);
  const builtin = await loadBuiltinSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    loadDirectory,
  );
  const userSnapshotMigrated = await migrateLegacyUserSnapshot(
    paths,
    builtin,
    loadDirectory,
  );
  return { builtinMigrated, userSnapshotMigrated };
}

function migrateLegacySoymealDataWithLoader(
  paths: MarketDataPaths,
  loadDirectory: SnapshotDirectoryLoader,
): Promise<LegacyMigrationResult> {
  const key = resolve(paths.marketDataDirectory);
  const running = legacyMigrationFlights.get(key);
  if (running) return running;

  const migration = performLegacySoymealMigration(paths, loadDirectory);
  legacyMigrationFlights.set(key, migration);
  const clear = () => {
    if (legacyMigrationFlights.get(key) === migration) {
      legacyMigrationFlights.delete(key);
    }
  };
  void migration.then(clear, clear);
  return migration;
}

export function migrateLegacySoymealData(
  paths: MarketDataPaths,
): Promise<LegacyMigrationResult> {
  return migrateLegacySoymealDataWithLoader(paths, prepareSnapshotDirectory);
}

function snapshotRequestBoundary(
  snapshot: LoadedMarketSnapshot,
  field: 'requestStart' | 'requestEnd',
): string {
  const metadata = snapshot.metadata;
  if (metadata) return metadata[field];
  return field === 'requestStart'
    ? snapshot.bars5[0].start
    : snapshot.bars5.at(-1)!.end;
}

function earlierBeijing(left: string, right: string): string {
  return parseBeijing(left) <= parseBeijing(right) ? left : right;
}

function laterBeijing(left: string, right: string): string {
  return parseBeijing(left) >= parseBeijing(right) ? left : right;
}

function mergeSnapshotSourceSegments(
  builtin: LoadedMarketSnapshot,
  user: LoadedMarketSnapshot,
): MarketSnapshotSourceSegment[] | undefined {
  const segments = [builtin, user].flatMap(snapshot => {
    const metadata = snapshot.metadata;
    return metadata?.schemaVersion === 5 || metadata?.schemaVersion === 6
      ? metadata.sourceSegments
      : [];
  });
  if (!segments.length) return undefined;
  const unique = new Map<string, MarketSnapshotSourceSegment>();
  for (const segment of segments) {
    const existing = unique.get(segment.sourceId);
    if (!existing) {
      unique.set(segment.sourceId, segment);
      continue;
    }
    const sameSource = existing.sourceName === segment.sourceName
      && existing.kind === segment.kind
      && existing.sourceVersion === segment.sourceVersion
      && existing.importerVersion === segment.importerVersion
      && isDeepStrictEqual(existing.license, segment.license);
    if (sameSource) {
      const rawFiles = new Map(existing.rawFiles.map(file => [
        `${file.name}\0${file.sha256}\0${file.rows}`,
        file,
      ]));
      for (const file of segment.rawFiles) {
        rawFiles.set(`${file.name}\0${file.sha256}\0${file.rows}`, file);
      }
      unique.set(segment.sourceId, {
        ...existing,
        acquiredAt: segment.acquiredAt ?? existing.acquiredAt,
        coverage: {
          first: earlierBeijing(existing.coverage.first, segment.coverage.first),
          last: laterBeijing(existing.coverage.last, segment.coverage.last),
        },
        rawFiles: [...rawFiles.values()],
      });
      continue;
    }
    let suffix = 2;
    while (unique.has(`${segment.sourceId}-${suffix}`)) suffix += 1;
    const sourceId = `${segment.sourceId}-${suffix}`;
    unique.set(sourceId, { ...segment, sourceId });
  }
  return [...unique.values()];
}

function buildBuiltinUpgradeCandidate(
  definition: InstrumentDefinition,
  builtin: LoadedMarketSnapshot,
  user: LoadedMarketSnapshot,
): SnapshotCandidate {
  const builtinLastFive = builtin.bars5.at(-1)!;
  const fiveCutoffMs = builtinLastFive.endMs;
  const builtinLastMinute = builtin.bars1.at(-1);
  const minuteCutoffMs = Math.max(
    fiveCutoffMs,
    builtinLastMinute ? builtinLastMinute.startMs + 60_000 : fiveCutoffMs,
  );
  const bars1 = [
    ...builtin.bars1,
    ...user.bars1.filter(record => record.startMs >= minuteCutoffMs),
  ];
  const bars5 = [
    ...builtin.bars5,
    ...user.bars5.filter(bar => bar.startMs >= fiveCutoffMs),
  ];
  const builtinLastMappingDate = builtin.mainContractMappings.at(-1)?.tradingDate;
  const mainContractMappings = [
    ...builtin.mainContractMappings,
    ...user.mainContractMappings.filter(mapping => (
      builtinLastMappingDate === undefined
      || mapping.tradingDate > builtinLastMappingDate
    )),
  ];
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  const rollovers = mainContractMappings.length
    ? detectContractRollovers(mainContractMappings, bars5, definition)
    : [
        ...builtin.rollovers,
        ...user.rollovers.filter(rollover => (
          builtin.rollovers.at(-1) === undefined
          || rollover.tradingDate > builtin.rollovers.at(-1)!.tradingDate
        )),
      ];
  validateSnapshotData(definition, bars1, bars5, bars60, 5);
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
    requestStart: earlierBeijing(
      snapshotRequestBoundary(builtin, 'requestStart'),
      snapshotRequestBoundary(user, 'requestStart'),
    ),
    requestEnd: laterBeijing(
      snapshotRequestBoundary(builtin, 'requestEnd'),
      snapshotRequestBoundary(user, 'requestEnd'),
    ),
    sourceLatestAt: laterBeijing(
      builtin.sourceLatestAt,
      user.sourceLatestAt,
    ),
    sourceSegments: mergeSnapshotSourceSegments(builtin, user),
  };
}

async function performBuiltinUpgrade(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  builtin: LoadedMarketSnapshot,
  user: LoadedMarketSnapshot,
): Promise<LoadedMarketSnapshot> {
  const candidate = buildBuiltinUpgradeCandidate(definition, builtin, user);
  try {
    return await saveMarketSnapshot(paths, definition, candidate);
  } catch {
    return {
      source: 'user',
      directory: user.directory,
      bars1: candidate.bars1,
      bars5: candidate.bars5,
      bars60: candidate.bars60,
      mainContractMappings: candidate.mainContractMappings,
      rollovers: candidate.rollovers,
      sourceLatestAt: candidate.sourceLatestAt,
      snapshotUpdatedAt: user.snapshotUpdatedAt,
    };
  }
}

function upgradeUserSnapshotWithBuiltin(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  builtin: LoadedMarketSnapshot,
  user: LoadedMarketSnapshot,
): Promise<LoadedMarketSnapshot> {
  if (user.bars5[0].startMs <= builtin.bars5[0].startMs) {
    return Promise.resolve(user);
  }
  const key = resolve(instrumentMarketDataDirectory(paths, definition));
  const running = builtinUpgradeFlights.get(key);
  if (running) return running;
  const upgrade = performBuiltinUpgrade(paths, definition, builtin, user);
  builtinUpgradeFlights.set(key, upgrade);
  const clear = () => {
    if (builtinUpgradeFlights.get(key) === upgrade) {
      builtinUpgradeFlights.delete(key);
    }
  };
  void upgrade.then(clear, clear);
  return upgrade;
}

export async function loadEffectiveSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  return loadEffectiveSnapshotWithLoader(
    paths,
    definition,
    prepareSnapshotDirectory,
  );
}

export async function loadEffectiveSnapshotWithLoader(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  loadDirectory: SnapshotDirectoryLoader,
): Promise<LoadedMarketSnapshot> {
  if (definition.id === DEFAULT_INSTRUMENT.id && paths.legacyBuiltinDataDirectory) {
    await migrateLegacySoymealDataWithLoader(
      paths,
      loadDirectory,
    ).catch(() => undefined);
  }
  const userDirectory = instrumentMarketDataDirectory(paths, definition);
  let builtin: LoadedMarketSnapshot;
  try {
    builtin = await loadBuiltinSnapshot(paths, definition, loadDirectory);
  } catch (error) {
    const standaloneUser = await firstValidUserSnapshot(
      userDirectory,
      definition,
      undefined,
      loadDirectory,
    );
    if (standaloneUser) return standaloneUser;
    throw error;
  }
  const user = await firstValidUserSnapshot(
    userDirectory,
    definition,
    builtin,
    loadDirectory,
  );
  if (!user) return builtin;
  return upgradeUserSnapshotWithBuiltin(paths, definition, builtin, user);
}

export function resolveMarketDataPaths(
  executablePath: string,
  packaged: boolean,
  appRoot: string,
  userDataDirectory: string,
): MarketDataPaths {
  const builtinDataDirectory = packaged
    ? join(dirname(executablePath), 'data')
    : join(appRoot, 'data');
  return {
    builtinDataDirectory,
    marketDataDirectory: join(userDataDirectory, 'market-data'),
    legacyBuiltinDataDirectory: packaged
      ? builtinDataDirectory
      : join(appRoot, 'futures_investigation_20261009'),
  };
}

function defaultSnapshotId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
}

export async function saveMarketSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
  options: SaveSnapshotOptions = {},
): Promise<LoadedMarketSnapshot> {
  parseBeijing(candidate.requestStart);
  parseBeijing(candidate.requestEnd);
  parseBeijing(candidate.sourceLatestAt);
  const effectiveCandidate = inheritCandidateProvenance(
    candidate,
    options.current,
  );
  const serializationStarted = performance.now();
  const plan = await tailLayerPlan(effectiveCandidate, options);
  const prepared = plan?.schemaVersion === 6
    ? prepareCandidateV6(
        definition,
        effectiveCandidate,
        plan.replacementCutoff,
      )
    : plan?.schemaVersion === 7
      ? prepareCandidateV7Tail(
          definition,
          effectiveCandidate,
          options.current!,
          plan.replacementCutoff,
        )
      : effectiveCandidate.benchmarkProtection
        ? prepareCandidateV7Full(definition, effectiveCandidate)
        : prepareCandidateV5(definition, effectiveCandidate);
  options.onTiming?.(
    'serialization',
    performance.now() - serializationStarted,
  );
  const now = options.now?.() ?? new Date();
  const snapshotId = options.idFactory?.() ?? defaultSnapshotId(now);
  assertSnapshotId(snapshotId);
  const marketDataDirectory = instrumentMarketDataDirectory(paths, definition);
  const snapshotsDirectory = join(marketDataDirectory, 'snapshots');
  const stagingDirectory = join(marketDataDirectory, `.staging-${snapshotId}`);
  const finalDirectory = join(snapshotsDirectory, snapshotId);
  const generatedAt = now.toISOString();
  const metadata = plan?.schemaVersion === 6
    ? buildMetadataV6(
        definition,
        snapshotId,
        effectiveCandidate,
        prepared,
        generatedAt,
        plan,
      )
    : plan?.schemaVersion === 7
      ? buildMetadataV7Tail(
          definition,
          snapshotId,
          effectiveCandidate,
          prepared,
          generatedAt,
          plan,
        )
      : effectiveCandidate.benchmarkProtection
        ? buildMetadataV7Full(
            definition,
            snapshotId,
            prepared.candidate,
            generatedAt,
            prepared.serialized,
          )
        : buildMetadataV5(
            definition,
            snapshotId,
            prepared.candidate,
            generatedAt,
            prepared.serialized,
          );
  await mkdir(snapshotsDirectory, { recursive: true });
  if (await pathExists(finalDirectory)) {
    throw new Error(`快照标识已存在：${snapshotId}`);
  }
  await rm(stagingDirectory, { recursive: true, force: true });
  let previousPointer: CurrentPointer | undefined;
  try {
    previousPointer = await readCurrentPointer(marketDataDirectory);
  } catch {
    // A first user snapshot has no pointer to restore.
  }
  let finalRenamed = false;
  let pointerSwitched = false;
  try {
    await mkdir(stagingDirectory);
    const writeStarted = performance.now();
    await writeSerializedSnapshot(
      stagingDirectory,
      metadata,
      prepared.serialized,
    );
    options.onTiming?.('write', performance.now() - writeStarted);
    const validationStarted = performance.now();
    await loadMetadataSnapshotDirectory(
      stagingDirectory,
      snapshotId,
      definition,
      'user',
    );
    options.onTiming?.(
      'validation',
      performance.now() - validationStarted,
    );
    const activationStarted = performance.now();
    await options.beforePointerSwitch?.();
    await rename(stagingDirectory, finalDirectory);
    finalRenamed = true;
    const pointer: CurrentPointer = {
      schemaVersion: metadata.schemaVersion,
      snapshotId,
      updatedAt: generatedAt,
    };
    await writeCurrentPointer(marketDataDirectory, pointer);
    pointerSwitched = true;
    await writeFile(
      join(finalDirectory, ACTIVATED_FILE),
      `${JSON.stringify({ activatedAt: generatedAt })}\n`,
      'utf8',
    );
    await cleanupSnapshots(paths, definition, snapshotId);
    options.onTiming?.(
      'activation',
      performance.now() - activationStarted,
    );
    const reloadStarted = performance.now();
    const loaded = await loadMetadataSnapshotDirectory(
      finalDirectory,
      snapshotId,
      definition,
      'user',
    );
    options.onTiming?.('reload', performance.now() - reloadStarted);
    return loaded;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (finalRenamed && !pointerSwitched) {
      await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
    } else if (pointerSwitched) {
      if (previousPointer) {
        await writeCurrentPointer(
          marketDataDirectory,
          previousPointer,
        ).catch(() => undefined);
      } else {
        await rm(
          join(marketDataDirectory, POINTER_FILE),
          { force: true },
        ).catch(() => undefined);
      }
      await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function writeBuiltinMarketSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
  options: WriteBuiltinSnapshotOptions = {},
): Promise<LoadedMarketSnapshot> {
  parseBeijing(candidate.requestStart);
  parseBeijing(candidate.requestEnd);
  parseBeijing(candidate.sourceLatestAt);
  const prepared = prepareCandidateV5(definition, candidate);
  const snapshotId = `builtin-${definition.id}`;
  const metadata = buildMetadataV5(
    definition,
    snapshotId,
    prepared.candidate,
    (options.now?.() ?? new Date()).toISOString(),
    prepared.serialized,
  );
  const finalDirectory = instrumentBuiltinDirectory(paths, definition);
  const parentDirectory = dirname(finalDirectory);
  const nonce = randomBytes(4).toString('hex');
  const stagingDirectory = join(
    parentDirectory,
    `.staging-${definition.id}-${nonce}`,
  );
  const backupDirectory = join(
    parentDirectory,
    `.backup-${definition.id}-${nonce}`,
  );
  await mkdir(parentDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
  let backedUp = false;
  try {
    await mkdir(stagingDirectory);
    await writeSerializedSnapshot(
      stagingDirectory,
      metadata,
      prepared.serialized,
    );
    await loadMetadataSnapshotDirectory(
      stagingDirectory,
      undefined,
      definition,
      'builtin',
    );
    await options.beforeCommit?.();
    if (await pathExists(finalDirectory)) {
      await rename(finalDirectory, backupDirectory);
      backedUp = true;
    }
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (backedUp && !await pathExists(finalDirectory)) {
        await rename(backupDirectory, finalDirectory);
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) {
      await rm(backupDirectory, { recursive: true, force: true });
      backedUp = false;
    }
    return loadMetadataSnapshotDirectory(
      finalDirectory,
      undefined,
      definition,
      'builtin',
    );
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp && !await pathExists(finalDirectory)) {
      await rename(backupDirectory, finalDirectory).catch(() => undefined);
      backedUp = false;
    }
    throw error;
  } finally {
    if (!backedUp) {
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function cleanupSnapshots(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
  currentSnapshotId?: string,
): Promise<void> {
  const marketDataDirectory = instrumentMarketDataDirectory(paths, definition);
  const pointerId = currentSnapshotId
    ?? await readCurrentPointer(marketDataDirectory)
      .then(pointer => pointer.snapshotId)
      .catch(() => undefined);
  const activated = await activatedSnapshots(marketDataDirectory);
  const keep = new Set<string>();
  if (pointerId) keep.add(pointerId);
  for (const snapshot of activated) {
    keep.add(snapshot.id);
    if (keep.size >= 2) break;
  }
  const snapshotsDirectory = join(marketDataDirectory, 'snapshots');
  for (const snapshotId of await activationReportSnapshotIds(
    marketDataDirectory,
    definition,
  )) {
    keep.add(snapshotId);
  }
  let builtin: LoadedMarketSnapshot | undefined;
  try {
    builtin = await loadBuiltinSnapshot(paths, definition);
  } catch {
    // A self-contained compatibility snapshot can still be retained.
  }
  for (const snapshot of activated) {
    try {
      const { metadata } = await readSnapshotMetadata(
        marketDataDirectory,
        snapshot.id,
        definition,
      );
      if (metadata.schemaVersion > 6) continue;
      await prepareSnapshotDirectory({
        kind: 'metadata',
        directory: join(snapshotsDirectory, snapshot.id),
        expectedId: snapshot.id,
        definition,
        source: 'user',
        fallback: builtin,
      });
      keep.add(snapshot.id);
      break;
    } catch {
      // Keep looking for the newest compatibility snapshot that fully loads.
    }
  }
  const pending = [...keep];
  const inspected = new Set<string>();
  while (pending.length > 0) {
    const snapshotId = pending.shift()!;
    if (inspected.has(snapshotId)) continue;
    inspected.add(snapshotId);
    try {
      const { metadata } = await readSnapshotMetadata(
        marketDataDirectory,
        snapshotId,
        definition,
      );
      const baseId = metadata.schemaVersion === 6
        ? metadata.base.snapshotId
        : isV7Tail(metadata)
          ? metadata.storage.base.snapshotId
          : undefined;
      if (baseId && !keep.has(baseId)) {
        keep.add(baseId);
        pending.push(baseId);
      }
    } catch {
      // Invalid retained snapshots will be skipped by normal fallback loading.
    }
  }
  let entries;
  try {
    entries = await readdir(snapshotsDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name) || keep.has(entry.name)) {
      return;
    }
    await rm(join(snapshotsDirectory, entry.name), { recursive: true, force: true });
  }));
}

export async function snapshotFingerprint(directory: string): Promise<Record<string, string>> {
  const files = [
    ONE_MINUTE_FILE,
    FIVE_MINUTE_FILE,
    SIXTY_MINUTE_FILE,
    ROLLOVER_FILE,
    MAPPING_FILE,
    METADATA_FILE,
  ];
  const result: Record<string, string> = {};
  for (const file of files) {
    const path = join(directory, file);
    try {
      const info = await stat(path);
      if (info.isFile()) result[file] = sha256(await readFile(path));
    } catch {
      // Missing optional fingerprint entries are simply omitted.
    }
  }
  return result;
}

export function snapshotIdFromDirectory(directory: string): string {
  return basename(directory);
}
