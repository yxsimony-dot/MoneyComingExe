import { createHash } from 'node:crypto';
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
import { parseContractRollovers } from '../src/domain/contract-rollover';
import { parseBars } from '../src/domain/data';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  parseEdbMinuteCsv,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import {
  cleanupSnapshots,
  loadEffectiveSnapshot,
  migrateLegacySoymealData,
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  snapshotFingerprint,
  writeBuiltinMarketSnapshot,
  type LoadedMarketSnapshot,
  type MarketDataPaths,
  type SnapshotCandidate,
} from '../src/main/market-snapshot';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
  type InstrumentDefinition,
} from '../src/shared/instruments';

const source = resolve('futures_investigation_20261009');
const temps: string[] = [];
const DATA_FILES = [
  'edb_main_continuous_1m_raw.csv',
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'edb_main_continuous_rollovers.csv',
] as const;
const SNAPSHOT_IO_TIMEOUT = 60_000;

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
