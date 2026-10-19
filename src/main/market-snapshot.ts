import { createHash, randomBytes } from 'node:crypto';
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
import { basename, dirname, join } from 'node:path';
import {
  parseContractRollovers,
  parseMainContractMappings,
  serializeContractRollovers,
  serializeMainContractMappings,
} from '../domain/contract-rollover';
import {
  assertBarsValid,
  assertMinuteRecordsValid,
  parseEdbMinuteCsv,
  reconcileBars,
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
  SnapshotFileMetadata,
  SnapshotSource,
} from '../shared/types';

export const SNAPSHOT_SCHEMA_VERSION = 4 as const;
const ONE_MINUTE_FILE = 'edb_main_continuous_1m_raw.csv';
const FIVE_MINUTE_FILE = 'edb_main_continuous_5m.csv';
const SIXTY_MINUTE_FILE = 'edb_main_continuous_60m.csv';
const ROLLOVER_FILE = 'edb_main_continuous_rollovers.csv';
const MAPPING_FILE = 'edb_main_contract_mapping.csv';
const METADATA_FILE = 'metadata.json';
const ACTIVATED_FILE = 'activated.json';
const POINTER_FILE = 'current.json';
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const LEGACY_SCHEMA_VERSIONS = new Set([1, 2, 3]);

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
}

export interface SaveSnapshotOptions {
  now?: () => Date;
  idFactory?: () => string;
  beforePointerSwitch?: () => void | Promise<void>;
}

export interface WriteBuiltinSnapshotOptions {
  now?: () => Date;
  beforeCommit?: () => void | Promise<void>;
}

interface CurrentPointer {
  schemaVersion: 1 | 2 | 3 | 4;
  snapshotId: string;
  updatedAt: string;
}

interface SerializedSnapshot {
  oneText: string;
  fiveText: string;
  sixtyText: string;
  rolloverText: string;
  mappingText: string;
}

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

function parseMetadata(
  text: string,
  expectedId: string | undefined,
  definition: InstrumentDefinition,
): MarketSnapshotMetadata {
  const value = parseObject(text, METADATA_FILE);
  const schemaVersion = value.schemaVersion;
  if (!LEGACY_SCHEMA_VERSIONS.has(schemaVersion as number)
    && schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
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
  if (sourceRecord.provider !== 'EDB'
    || sourceRecord.endpoint !== 'https://edb.shinnytech.com/md/kline'
    || typeof sourceRecord.symbol !== 'string') {
    throw new Error('快照数据源声明无效');
  }
  if (schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
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
  fileMetadata(files, 'bars5');
  fileMetadata(files, 'bars60');
  if ((schemaVersion as number) >= 2) fileMetadata(files, 'rollovers');
  if ((schemaVersion as number) >= 3) fileMetadata(files, 'bars1');
  if (schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    fileMetadata(files, 'mainContractMappings');
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
): void {
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  assertBarsValid(bars60, 60, definition.tradingSessions);
  reconcileBars(bars5, bars60);
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
  const files = metadata.files as unknown as Record<string, SnapshotFileMetadata>;
  const [fiveText, sixtyText] = await Promise.all([
    readVerifiedFile(directory, files.bars5, FIVE_MINUTE_FILE),
    readVerifiedFile(directory, files.bars60, SIXTY_MINUTE_FILE),
  ]);
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  if (bars5.length !== files.bars5.rows || bars60.length !== files.bars60.rows) {
    throw new Error('快照记录数与元数据不一致');
  }

  let bars1: EdbMinuteRecord[];
  if (metadata.schemaVersion >= 3) {
    const oneText = await readVerifiedFile(directory, files.bars1, ONE_MINUTE_FILE);
    bars1 = parseEdbMinuteCsv(
      oneText,
      ONE_MINUTE_FILE,
      definition.tradingSessions,
    );
    if (bars1.length !== files.bars1.rows) {
      throw new Error('快照 1 分钟记录数与元数据不一致');
    }
  } else {
    if (!fallback) throw new Error('旧版快照缺少可用的内置 1 分钟基线');
    bars1 = fallback.bars1;
  }

  let rollovers: ContractRollover[];
  if (metadata.schemaVersion >= 2) {
    const rolloverText = await readVerifiedFile(
      directory,
      files.rollovers,
      ROLLOVER_FILE,
    );
    rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE, definition);
    if (rollovers.length !== files.rollovers.rows) {
      throw new Error('快照换月记录数与元数据不一致');
    }
  } else {
    if (!fallback) throw new Error('旧版快照缺少可用的内置换月基线');
    rollovers = fallback.rollovers;
  }

  let mainContractMappings: MainContractMapping[];
  if (metadata.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    const mappingText = await readVerifiedFile(
      directory,
      files.mainContractMappings,
      MAPPING_FILE,
    );
    mainContractMappings = parseMainContractMappings(
      mappingText,
      MAPPING_FILE,
      definition,
    );
    if (mainContractMappings.length !== files.mainContractMappings.rows) {
      throw new Error('快照主力映射记录数与元数据不一致');
    }
  } else if (metadata.schemaVersion === 1 && fallback) {
    mainContractMappings = fallback.mainContractMappings;
  } else {
    mainContractMappings = deriveLegacyMappings(bars5, rollovers, definition);
  }

  validateSnapshotData(definition, bars1, bars5, bars60);
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
  validateSnapshotData(definition, bars1, bars5, bars60);
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
  if (![1, 2, 3, SNAPSHOT_SCHEMA_VERSION].includes(value.schemaVersion as number)
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
  builtin: LoadedMarketSnapshot,
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

function serializeCandidate(
  definition: InstrumentDefinition,
  candidate: SnapshotCandidate,
): SerializedSnapshot {
  validateSnapshotData(
    definition,
    candidate.bars1,
    candidate.bars5,
    candidate.bars60,
  );
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

function buildMetadata(
  definition: InstrumentDefinition,
  snapshotId: string,
  candidate: SnapshotCandidate,
  generatedAt: string,
  serialized: SerializedSnapshot,
): MarketSnapshotMetadataV4 {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
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

async function writeSerializedSnapshot(
  directory: string,
  metadata: MarketSnapshotMetadataV4,
  serialized: SerializedSnapshot,
): Promise<void> {
  await Promise.all([
    writeFile(join(directory, ONE_MINUTE_FILE), serialized.oneText, 'utf8'),
    writeFile(join(directory, FIVE_MINUTE_FILE), serialized.fiveText, 'utf8'),
    writeFile(join(directory, SIXTY_MINUTE_FILE), serialized.sixtyText, 'utf8'),
    writeFile(join(directory, ROLLOVER_FILE), serialized.rolloverText, 'utf8'),
    writeFile(join(directory, MAPPING_FILE), serialized.mappingText, 'utf8'),
    writeFile(
      join(directory, METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    ),
  ]);
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
  const serialized = serializeCandidate(DEFAULT_INSTRUMENT, candidate);
  const metadata = buildMetadata(
    DEFAULT_INSTRUMENT,
    'builtin-main_continuous',
    candidate,
    generatedAt,
    serialized,
  );
  const parent = dirname(target);
  const staging = join(parent, `.migrating-main_continuous-${randomBytes(4).toString('hex')}`);
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(staging);
    await writeSerializedSnapshot(staging, metadata, serialized);
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

export async function migrateLegacySoymealData(
  paths: MarketDataPaths,
): Promise<{ builtinMigrated: boolean; userSnapshotMigrated: boolean }> {
  const builtinMigrated = await migrateLegacyBuiltin(paths);
  const builtin = await loadBuiltinSnapshot(paths, DEFAULT_INSTRUMENT);
  const userSnapshotMigrated = await migrateLegacyUserSnapshot(paths, builtin);
  return { builtinMigrated, userSnapshotMigrated };
}

export async function loadEffectiveSnapshot(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<LoadedMarketSnapshot> {
  if (definition.id === DEFAULT_INSTRUMENT.id && paths.legacyBuiltinDataDirectory) {
    await migrateLegacySoymealData(paths).catch(() => undefined);
  }
  const builtin = await loadBuiltinSnapshot(paths, definition);
  const userDirectory = instrumentMarketDataDirectory(paths, definition);
  return await firstValidUserSnapshot(userDirectory, definition, builtin) ?? builtin;
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
  const serialized = serializeCandidate(definition, candidate);
  const now = options.now?.() ?? new Date();
  const snapshotId = options.idFactory?.() ?? defaultSnapshotId(now);
  assertSnapshotId(snapshotId);
  const marketDataDirectory = instrumentMarketDataDirectory(paths, definition);
  const snapshotsDirectory = join(marketDataDirectory, 'snapshots');
  const stagingDirectory = join(marketDataDirectory, `.staging-${snapshotId}`);
  const finalDirectory = join(snapshotsDirectory, snapshotId);
  const metadata = buildMetadata(
    definition,
    snapshotId,
    candidate,
    now.toISOString(),
    serialized,
  );
  await mkdir(snapshotsDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await mkdir(stagingDirectory);
    await writeSerializedSnapshot(stagingDirectory, metadata, serialized);
    const builtin = await loadBuiltinSnapshot(paths, definition);
    await loadMetadataSnapshotDirectory(
      stagingDirectory,
      snapshotId,
      definition,
      'user',
      builtin,
    );
    await options.beforePointerSwitch?.();
    await rename(stagingDirectory, finalDirectory);
    const pointer: CurrentPointer = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      updatedAt: now.toISOString(),
    };
    await writeCurrentPointer(marketDataDirectory, pointer);
    await writeFile(
      join(finalDirectory, ACTIVATED_FILE),
      `${JSON.stringify({ activatedAt: now.toISOString() })}\n`,
      'utf8',
    );
    await cleanupSnapshots(paths, definition, snapshotId);
    return loadMetadataSnapshotDirectory(
      finalDirectory,
      snapshotId,
      definition,
      'user',
      builtin,
    );
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
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
  const serialized = serializeCandidate(definition, candidate);
  const snapshotId = `builtin-${definition.id}`;
  const metadata = buildMetadata(
    definition,
    snapshotId,
    candidate,
    (options.now?.() ?? new Date()).toISOString(),
    serialized,
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
    await writeSerializedSnapshot(stagingDirectory, metadata, serialized);
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
