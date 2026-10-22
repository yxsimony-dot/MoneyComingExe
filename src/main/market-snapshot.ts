import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
  parseEdbMinuteCsv,
  reconcileBars,
  reconcileCompatibleBars,
  serializeBars,
  serializeMinuteRecords,
} from '../domain/market-data';
import { parseBars } from '../domain/data';
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
  MarketSnapshotMetadata,
  MarketSnapshotMetadataV4,
  MarketSnapshotMetadataV5,
  MarketSnapshotMetadataV6,
  MarketSnapshotRedistribution,
  MarketSnapshotSourceSegment,
  MarketUpdateIntent,
  SnapshotFileMetadata,
  SnapshotSource,
} from '../shared/types';

export const SNAPSHOT_SCHEMA_VERSION = 6 as const;
const ONE_MINUTE_FILE = 'edb_main_continuous_1m_raw.csv';
const FIVE_MINUTE_FILE = 'edb_main_continuous_5m.csv';
const SIXTY_MINUTE_FILE = 'edb_main_continuous_60m.csv';
const ROLLOVER_FILE = 'edb_main_continuous_rollovers.csv';
const MAPPING_FILE = 'edb_main_contract_mapping.csv';
const METADATA_FILE = 'metadata.json';
const ACTIVATED_FILE = 'activated.json';
const POINTER_FILE = 'current.json';
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5, 6]);
const DEFAULT_TAIL_COMPACTION_THRESHOLD = 64;
type LegacyMigrationResult = {
  builtinMigrated: boolean;
  userSnapshotMigrated: boolean;
};
const legacyMigrationFlights = new Map<string, Promise<LegacyMigrationResult>>();

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
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  snapshotId: string;
  updatedAt: string;
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

interface TailLayerPlan {
  base: MarketSnapshotMetadataV6['base'];
  replacementCutoff: string;
  layerSequence: number;
}

type PersistedSnapshotMetadata =
  | MarketSnapshotMetadataV4
  | MarketSnapshotMetadataV5
  | MarketSnapshotMetadataV6;

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
    || !/^[a-f0-9]{64}$/.test(record.sha256)
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
    'legacy-migration',
    'test-fixture',
  ]);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('快照分段来源声明无效');
    }
    const segment = item as unknown as Record<string, unknown>;
    nonEmptyString(segment.sourceId, '快照来源标识');
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
  const source = value.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('快照数据源声明无效');
  }
  const sourceRecord = source as Record<string, unknown>;
  if (schemaVersion === 5 || schemaVersion === 6) {
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
  if (schemaVersion === 5 || schemaVersion === 6) {
    const bars1File = schemaVersion === 5
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
      schemaVersion === 5 ? bars5File.rows : undefined,
    );
    assertPeriodMetadata(
      periodRecord.bars60,
      '60 分钟',
      schemaVersion === 5 ? bars60File.rows : undefined,
    );
    if (schemaVersion === 5) {
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
  metadata: MarketSnapshotMetadataV5 | MarketSnapshotMetadataV6,
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
  metadata: Exclude<MarketSnapshotMetadata, MarketSnapshotMetadataV6>,
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
  if (metadata.schemaVersion === 5 && !files.bars1) {
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

  validateSnapshotData(
    definition,
    bars1,
    bars5,
    bars60,
    metadata.schemaVersion,
  );
  if (metadata.schemaVersion === 5) {
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
  metadata: MarketSnapshotMetadataV5,
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
  metadata: MarketSnapshotMetadataV6,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  const baseDirectory = join(
    snapshotDirectoryRoot(layerDirectory),
    metadata.base.snapshotId,
  );
  const metadataText = await readFile(join(baseDirectory, METADATA_FILE), 'utf8');
  if (sha256(metadataText) !== metadata.base.metadataSha256) {
    throw new Error('尾部快照基础元数据哈希不一致');
  }
  const baseMetadata = parseMetadata(
    metadataText,
    metadata.base.snapshotId,
    definition,
  );
  if (baseMetadata.schemaVersion !== 5) {
    throw new Error('尾部快照必须直接引用 schema 5 基础快照');
  }
  const signatures = await fileSignatures(baseDirectory, baseMetadata);
  const cacheKey = `${baseDirectory}\0${metadata.base.metadataSha256}`;
  const cached = verifiedBaseCache.get(cacheKey);
  if (cached
    && cached.signatures.length === signatures.length
    && cached.signatures.every((signature, index) => signature === signatures[index])) {
    return cached.snapshot;
  }
  const snapshot = await loadStandaloneMetadataSnapshotDirectory(
    baseDirectory,
    metadata.base.snapshotId,
    definition,
    baseMetadata,
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

async function loadTailLayerSnapshotDirectory(
  directory: string,
  definition: InstrumentDefinition,
  metadata: MarketSnapshotMetadataV6,
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
  const cutoffMs = parseBeijing(metadata.replacementCutoff);
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
  const bars60 = mergeTailRecords(
    base.bars60,
    bars60Tail,
    cutoffMs,
    value => value.endMs,
    '60 分钟',
  );
  validateTailReplacement(
    definition,
    bars1.filter(record => record.startMs >= cutoffMs),
    bars5.filter(bar => bar.startMs >= cutoffMs),
    bars60.filter(bar => bar.startMs >= cutoffMs),
  );
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
  if (metadata.schemaVersion === 6) {
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

async function loadBuiltinSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  const directory = instrumentBuiltinDirectory(paths, definition);
  try {
    return await loadMetadataSnapshotDirectory(
      directory,
      undefined,
      definition,
      'builtin',
    );
  } catch (error) {
    if (definition.id !== DEFAULT_INSTRUMENT.id) throw error;
    return loadLegacyBuiltinSnapshot(legacyBuiltinDirectory(paths), definition);
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

async function activatedSnapshotIds(directory: string): Promise<string[]> {
  const snapshots = join(directory, 'snapshots');
  let entries;
  try {
    entries = await readdir(snapshots, { withFileTypes: true });
  } catch {
    return [];
  }
  const activated: Array<{ id: string; time: number }> = [];
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
    .sort((left, right) => right.time - left.time)
    .map(item => item.id);
}

async function snapshotCandidates(directory: string): Promise<string[]> {
  const candidates: string[] = [];
  try {
    candidates.push((await readCurrentPointer(directory)).snapshotId);
  } catch {
    // A broken pointer must not block fallback discovery.
  }
  for (const id of await activatedSnapshotIds(directory)) {
    if (!candidates.includes(id)) candidates.push(id);
  }
  return candidates;
}

async function firstValidUserSnapshot(
  directory: string,
  definition: InstrumentDefinition,
  builtin?: LoadedMarketSnapshot,
): Promise<LoadedMarketSnapshot | undefined> {
  for (const snapshotId of await snapshotCandidates(directory)) {
    try {
      return await loadMetadataSnapshotDirectory(
        join(directory, 'snapshots', snapshotId),
        snapshotId,
        definition,
        'user',
        builtin,
      );
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
  if (metadata?.schemaVersion !== 5 && metadata?.schemaVersion !== 6) {
    return candidate;
  }
  return {
    ...candidate,
    source: candidate.source ?? metadata.source,
    sourceSegments: candidate.sourceSegments ?? metadata.sourceSegments,
    redistribution: candidate.redistribution ?? metadata.redistribution,
  };
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
  plan: TailLayerPlan,
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
    || (metadata?.schemaVersion !== 5 && metadata?.schemaVersion !== 6)
    || !Number.isSafeInteger(threshold)
    || threshold <= 0) {
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
      base: metadata.base,
      replacementCutoff,
      layerSequence,
    };
  }
  const metadataText = await readFile(join(current.directory, METADATA_FILE), 'utf8');
  return {
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
    await loadMetadataSnapshotDirectory(
      staging,
      undefined,
      DEFAULT_INSTRUMENT,
      'builtin',
    );
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
): Promise<boolean> {
  const target = instrumentMarketDataDirectory(paths, DEFAULT_INSTRUMENT);
  if (await firstValidUserSnapshot(target, DEFAULT_INSTRUMENT, builtin)) {
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
  const legacy = await loadMetadataSnapshotDirectory(
    source,
    pointer.snapshotId,
    DEFAULT_INSTRUMENT,
    'user',
    builtin,
  );
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
      await loadMetadataSnapshotDirectory(
        staging,
        migratedId,
        DEFAULT_INSTRUMENT,
        'user',
        builtin,
      );
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (!await pathExists(destination)) throw error;
    }
  }
  await loadMetadataSnapshotDirectory(
    destination,
    migratedId,
    DEFAULT_INSTRUMENT,
    'user',
    builtin,
  );
  await writeCurrentPointer(target, {
    schemaVersion: legacy.metadata!.schemaVersion,
    snapshotId: migratedId,
    updatedAt: pointer.updatedAt,
  });
  return true;
}

async function performLegacySoymealMigration(
  paths: MarketDataPaths,
): Promise<LegacyMigrationResult> {
  const builtinMigrated = await migrateLegacyBuiltin(paths);
  const builtin = await loadBuiltinSnapshot(paths, DEFAULT_INSTRUMENT);
  const userSnapshotMigrated = await migrateLegacyUserSnapshot(paths, builtin);
  return { builtinMigrated, userSnapshotMigrated };
}

export function migrateLegacySoymealData(
  paths: MarketDataPaths,
): Promise<LegacyMigrationResult> {
  const key = resolve(paths.marketDataDirectory);
  const running = legacyMigrationFlights.get(key);
  if (running) return running;

  const migration = performLegacySoymealMigration(paths);
  legacyMigrationFlights.set(key, migration);
  const clear = () => {
    if (legacyMigrationFlights.get(key) === migration) {
      legacyMigrationFlights.delete(key);
    }
  };
  void migration.then(clear, clear);
  return migration;
}

export async function loadEffectiveSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  if (definition.id === DEFAULT_INSTRUMENT.id && paths.legacyBuiltinDataDirectory) {
    await migrateLegacySoymealData(paths).catch(() => undefined);
  }
  const userDirectory = instrumentMarketDataDirectory(paths, definition);
  const standaloneUser = await firstValidUserSnapshot(
    userDirectory,
    definition,
  );
  if (standaloneUser) return standaloneUser;
  const builtin = await loadBuiltinSnapshot(paths, definition);
  return await firstValidUserSnapshot(userDirectory, definition, builtin)
    ?? builtin;
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
  const prepared = plan
    ? prepareCandidateV6(
        definition,
        effectiveCandidate,
        plan.replacementCutoff,
      )
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
  const metadata = plan
    ? buildMetadataV6(
        definition,
        snapshotId,
        effectiveCandidate,
        prepared,
        generatedAt,
        plan,
      )
    : buildMetadataV5(
        definition,
        snapshotId,
        prepared.candidate,
        generatedAt,
        prepared.serialized,
      );
  await mkdir(snapshotsDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
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
  const activated = await activatedSnapshotIds(marketDataDirectory);
  const keep = new Set<string>();
  if (pointerId) keep.add(pointerId);
  for (const id of activated) {
    keep.add(id);
    if (keep.size >= 2) break;
  }
  const snapshotsDirectory = join(marketDataDirectory, 'snapshots');
  for (const id of [...keep]) {
    try {
      const metadata = parseMetadata(
        await readFile(join(snapshotsDirectory, id, METADATA_FILE), 'utf8'),
        id,
        definition,
      );
      if (metadata.schemaVersion === 6) {
        keep.add(metadata.base.snapshotId);
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
