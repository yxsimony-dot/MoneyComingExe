import { createHash, randomBytes } from 'node:crypto';
import {
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
  serializeContractRollovers,
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
import type {
  Bar,
  ContractRollover,
  EdbMinuteRecord,
  MarketSnapshotMetadata,
  SnapshotFileMetadata,
  SnapshotSource,
} from '../shared/types';

export const SNAPSHOT_SCHEMA_VERSION = 3 as const;
const ONE_MINUTE_FILE = 'edb_main_continuous_1m_raw.csv';
const FIVE_MINUTE_FILE = 'edb_main_continuous_5m.csv';
const SIXTY_MINUTE_FILE = 'edb_main_continuous_60m.csv';
const ROLLOVER_FILE = 'edb_main_continuous_rollovers.csv';
const METADATA_FILE = 'metadata.json';
const ACTIVATED_FILE = 'activated.json';
const POINTER_FILE = 'current.json';
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;

export interface MarketDataPaths {
  builtinDataDirectory: string;
  marketDataDirectory: string;
}

export interface LoadedMarketSnapshot {
  source: SnapshotSource;
  directory: string;
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  rollovers: ContractRollover[];
  sourceLatestAt: string;
  snapshotUpdatedAt?: string;
  metadata?: MarketSnapshotMetadata;
}

export interface SnapshotCandidate {
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
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

interface CurrentPointer {
  schemaVersion: 1 | 2 | 3;
  snapshotId: string;
  updatedAt: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSnapshotId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SNAPSHOT_ID.test(value)) throw new Error('快照标识无效');
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label} JSON 无效`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 结构无效`);
  return parsed as Record<string, unknown>;
}

function parseMetadata(text: string, expectedId: string): MarketSnapshotMetadata {
  const value = parseObject(text, METADATA_FILE);
  if (value.schemaVersion !== 1
    && value.schemaVersion !== 2
    && value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('快照 schema 不受支持');
  }
  if (value.snapshotId !== expectedId) throw new Error('快照标识与目录不一致');
  const source = value.source;
  const files = value.files;
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || (source as Record<string, unknown>).provider !== 'EDB'
    || (source as Record<string, unknown>).endpoint !== 'https://edb.shinnytech.com/md/kline'
    || (source as Record<string, unknown>).symbol !== 'KQ.m@DCE.m') {
    throw new Error('快照数据源声明无效');
  }
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('快照文件元数据无效');
  const fileMetadata = (key: 'bars1' | 'bars5' | 'bars60' | 'rollovers'): SnapshotFileMetadata => {
    const file = (files as Record<string, unknown>)[key];
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('快照文件元数据无效');
    const record = file as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.sha256 !== 'string' || typeof record.rows !== 'number') {
      throw new Error('快照文件元数据无效');
    }
    return record as unknown as SnapshotFileMetadata;
  };
  for (const key of ['bars5', 'bars60'] as const) {
    fileMetadata(key);
  }
  if (value.schemaVersion >= 2) fileMetadata('rollovers');
  if (value.schemaVersion === SNAPSHOT_SCHEMA_VERSION) fileMetadata('bars1');
  for (const field of ['generatedAt', 'requestStart', 'requestEnd', 'sourceLatestAt'] as const) {
    if (typeof value[field] !== 'string') throw new Error(`快照缺少 ${field}`);
  }
  parseBeijing(value.requestStart as string);
  parseBeijing(value.requestEnd as string);
  parseBeijing(value.sourceLatestAt as string);
  if (Number.isNaN(Date.parse(value.generatedAt as string))) throw new Error('快照生成时间无效');
  return value as unknown as MarketSnapshotMetadata;
}

async function readBuiltinRollovers(directory: string): Promise<ContractRollover[]> {
  const path = join(directory, ROLLOVER_FILE);
  try {
    return parseContractRollovers(await readFile(path, 'utf8'), ROLLOVER_FILE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`${ROLLOVER_FILE}：文件不存在，请恢复 data 目录后重试。\n位置：${path}`);
    }
    throw error;
  }
}

async function readBuiltinMinutes(directory: string): Promise<EdbMinuteRecord[]> {
  const path = join(directory, ONE_MINUTE_FILE);
  try {
    const records = parseEdbMinuteCsv(await readFile(path, 'utf8'), ONE_MINUTE_FILE);
    assertMinuteRecordsValid(records);
    return records;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`${ONE_MINUTE_FILE}：文件不存在，请恢复 data 目录后重试。\n位置：${path}`);
    }
    throw error;
  }
}

async function loadUserSnapshotDirectory(
  directory: string,
  snapshotId: string,
  builtinDataDirectory: string,
): Promise<LoadedMarketSnapshot> {
  assertSnapshotId(snapshotId);
  const metadataText = await readFile(join(directory, METADATA_FILE), 'utf8');
  const metadata = parseMetadata(metadataText, snapshotId);
  const [fiveText, sixtyText] = await Promise.all([
    readFile(join(directory, FIVE_MINUTE_FILE), 'utf8'),
    readFile(join(directory, SIXTY_MINUTE_FILE), 'utf8'),
  ]);
  if (metadata.files.bars5.name !== FIVE_MINUTE_FILE
    || metadata.files.bars60.name !== SIXTY_MINUTE_FILE
    || sha256(fiveText) !== metadata.files.bars5.sha256
    || sha256(sixtyText) !== metadata.files.bars60.sha256) {
    throw new Error('快照文件哈希不一致');
  }
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  if (bars5.length !== metadata.files.bars5.rows || bars60.length !== metadata.files.bars60.rows) {
    throw new Error('快照记录数与元数据不一致');
  }
  assertBarsValid(bars5, 5);
  assertBarsValid(bars60, 60);
  reconcileBars(bars5, bars60);
  let bars1: EdbMinuteRecord[];
  if (metadata.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    const oneText = await readFile(join(directory, ONE_MINUTE_FILE), 'utf8');
    if (metadata.files.bars1.name !== ONE_MINUTE_FILE
      || sha256(oneText) !== metadata.files.bars1.sha256) {
      throw new Error('快照 1 分钟文件哈希不一致');
    }
    bars1 = parseEdbMinuteCsv(oneText, ONE_MINUTE_FILE);
    if (bars1.length !== metadata.files.bars1.rows) {
      throw new Error('快照 1 分钟记录数与元数据不一致');
    }
    assertMinuteRecordsValid(bars1);
  } else {
    bars1 = await readBuiltinMinutes(builtinDataDirectory);
  }
  let rollovers: ContractRollover[];
  if (metadata.schemaVersion === 2 || metadata.schemaVersion === 3) {
    const rolloverText = await readFile(join(directory, ROLLOVER_FILE), 'utf8');
    if (metadata.files.rollovers.name !== ROLLOVER_FILE
      || sha256(rolloverText) !== metadata.files.rollovers.sha256) {
      throw new Error('快照换月文件哈希不一致');
    }
    rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE);
    if (rollovers.length !== metadata.files.rollovers.rows) {
      throw new Error('快照换月记录数与元数据不一致');
    }
  } else {
    rollovers = await readBuiltinRollovers(builtinDataDirectory);
  }
  return {
    source: 'user',
    directory,
    bars1,
    bars5,
    bars60,
    rollovers,
    sourceLatestAt: metadata.sourceLatestAt,
    snapshotUpdatedAt: metadata.generatedAt,
    metadata,
  };
}

async function loadBuiltinSnapshot(directory: string): Promise<LoadedMarketSnapshot> {
  const readPrice = async (name: string): Promise<string> => {
    const path = join(directory, name);
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`${name}：${code === 'ENOENT' ? '文件不存在，请恢复 data 目录后重试' : '文件无法读取'}。\n位置：${path}`);
    }
  };
  const [bars1, fiveText, sixtyText, rollovers] = await Promise.all([
    readBuiltinMinutes(directory),
    readPrice(FIVE_MINUTE_FILE),
    readPrice(SIXTY_MINUTE_FILE),
    readBuiltinRollovers(directory),
  ]);
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  assertBarsValid(bars5, 5);
  assertBarsValid(bars60, 60);
  reconcileBars(bars5, bars60);
  return {
    source: 'builtin',
    directory,
    bars1,
    bars5,
    bars60,
    rollovers,
    sourceLatestAt: formatBeijing(Math.max(bars5.at(-1)!.endMs, bars60.at(-1)!.endMs)),
  };
}

async function readCurrentPointer(directory: string): Promise<CurrentPointer> {
  const value = parseObject(await readFile(join(directory, POINTER_FILE), 'utf8'), POINTER_FILE);
  if ((value.schemaVersion !== 1
      && value.schemaVersion !== 2
      && value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION)
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
      const marker = parseObject(await readFile(join(snapshots, entry.name, ACTIVATED_FILE), 'utf8'), ACTIVATED_FILE);
      const activatedAt = typeof marker.activatedAt === 'string' ? Date.parse(marker.activatedAt) : Number.NaN;
      if (Number.isNaN(activatedAt)) continue;
      activated.push({ id: entry.name, time: activatedAt });
    } catch {
      // Incomplete candidates are intentionally invisible.
    }
  }
  return activated.sort((left, right) => right.time - left.time).map(item => item.id);
}

export async function loadEffectiveSnapshot(paths: MarketDataPaths): Promise<LoadedMarketSnapshot> {
  const snapshotsDirectory = join(paths.marketDataDirectory, 'snapshots');
  const candidates: string[] = [];
  try {
    candidates.push((await readCurrentPointer(paths.marketDataDirectory)).snapshotId);
  } catch {
    // A broken pointer must not block fallback discovery.
  }
  for (const id of await activatedSnapshotIds(paths.marketDataDirectory)) {
    if (!candidates.includes(id)) candidates.push(id);
  }
  for (const snapshotId of candidates) {
    try {
      return await loadUserSnapshotDirectory(
        join(snapshotsDirectory, snapshotId),
        snapshotId,
        paths.builtinDataDirectory,
      );
    } catch {
      // Try the previous activated snapshot before the built-in baseline.
    }
  }
  return loadBuiltinSnapshot(paths.builtinDataDirectory);
}

export function resolveMarketDataPaths(
  executablePath: string,
  packaged: boolean,
  appRoot: string,
  userDataDirectory: string,
): MarketDataPaths {
  return {
    builtinDataDirectory: packaged
      ? join(dirname(executablePath), 'data')
      : join(appRoot, 'futures_investigation_20261009'),
    marketDataDirectory: join(userDataDirectory, 'market-data'),
  };
}

function defaultSnapshotId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
}

export async function saveMarketSnapshot(
  paths: MarketDataPaths,
  candidate: SnapshotCandidate,
  options: SaveSnapshotOptions = {},
): Promise<LoadedMarketSnapshot> {
  assertMinuteRecordsValid(candidate.bars1);
  assertBarsValid(candidate.bars5, 5);
  assertBarsValid(candidate.bars60, 60);
  reconcileBars(candidate.bars5, candidate.bars60);
  parseBeijing(candidate.requestStart);
  parseBeijing(candidate.requestEnd);
  parseBeijing(candidate.sourceLatestAt);
  const now = options.now?.() ?? new Date();
  const snapshotId = options.idFactory?.() ?? defaultSnapshotId(now);
  assertSnapshotId(snapshotId);
  const snapshotsDirectory = join(paths.marketDataDirectory, 'snapshots');
  const stagingDirectory = join(paths.marketDataDirectory, `.staging-${snapshotId}`);
  const finalDirectory = join(snapshotsDirectory, snapshotId);
  const oneText = serializeMinuteRecords(candidate.bars1);
  const fiveText = serializeBars(candidate.bars5);
  const sixtyText = serializeBars(candidate.bars60);
  const rolloverText = serializeContractRollovers(candidate.rollovers);
  const metadata: MarketSnapshotMetadata = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    source: {
      provider: 'EDB',
      endpoint: 'https://edb.shinnytech.com/md/kline',
      symbol: 'KQ.m@DCE.m',
    },
    generatedAt: now.toISOString(),
    requestStart: candidate.requestStart,
    requestEnd: candidate.requestEnd,
    sourceLatestAt: candidate.sourceLatestAt,
    files: {
      bars1: { name: ONE_MINUTE_FILE, sha256: sha256(oneText), rows: candidate.bars1.length },
      bars5: { name: FIVE_MINUTE_FILE, sha256: sha256(fiveText), rows: candidate.bars5.length },
      bars60: { name: SIXTY_MINUTE_FILE, sha256: sha256(sixtyText), rows: candidate.bars60.length },
      rollovers: { name: ROLLOVER_FILE, sha256: sha256(rolloverText), rows: candidate.rollovers.length },
    },
  };
  await mkdir(paths.marketDataDirectory, { recursive: true });
  await mkdir(snapshotsDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await mkdir(stagingDirectory);
    await Promise.all([
      writeFile(join(stagingDirectory, ONE_MINUTE_FILE), oneText, 'utf8'),
      writeFile(join(stagingDirectory, FIVE_MINUTE_FILE), fiveText, 'utf8'),
      writeFile(join(stagingDirectory, SIXTY_MINUTE_FILE), sixtyText, 'utf8'),
      writeFile(join(stagingDirectory, ROLLOVER_FILE), rolloverText, 'utf8'),
      writeFile(join(stagingDirectory, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
    ]);
    await loadUserSnapshotDirectory(stagingDirectory, snapshotId, paths.builtinDataDirectory);
    await options.beforePointerSwitch?.();
    await rename(stagingDirectory, finalDirectory);
    const pointer: CurrentPointer = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      updatedAt: now.toISOString(),
    };
    const temporaryPointer = join(paths.marketDataDirectory, `.current-${snapshotId}.tmp`);
    await writeFile(temporaryPointer, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
    await rename(temporaryPointer, join(paths.marketDataDirectory, POINTER_FILE));
    await writeFile(
      join(finalDirectory, ACTIVATED_FILE),
      `${JSON.stringify({ activatedAt: now.toISOString() })}\n`,
      'utf8',
    );
    await cleanupSnapshots(paths.marketDataDirectory, snapshotId);
    return loadUserSnapshotDirectory(finalDirectory, snapshotId, paths.builtinDataDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupSnapshots(marketDataDirectory: string, currentSnapshotId?: string): Promise<void> {
  const pointerId = currentSnapshotId ?? await readCurrentPointer(marketDataDirectory).then(pointer => pointer.snapshotId).catch(() => undefined);
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
    if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name) || keep.has(entry.name)) return;
    await rm(join(snapshotsDirectory, entry.name), { recursive: true, force: true });
  }));
}

export async function snapshotFingerprint(directory: string): Promise<Record<string, string>> {
  const files = [ONE_MINUTE_FILE, FIVE_MINUTE_FILE, SIXTY_MINUTE_FILE, ROLLOVER_FILE, METADATA_FILE];
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
