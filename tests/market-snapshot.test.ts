import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseContractRollovers } from '../src/domain/contract-rollover';
import { parseBars } from '../src/domain/data';
import { parseEdbMinuteCsv } from '../src/domain/market-data';
import {
  cleanupSnapshots,
  loadEffectiveSnapshot,
  migrateLegacySoymealData,
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  snapshotFingerprint,
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
const SNAPSHOT_IO_TIMEOUT = 15_000;

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
  }, 15_000);

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
  }, 15_000);

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

  it.each([1, 2, 3] as const)(
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
      delete metadata.instrumentId;
      delete metadata.mainSymbol;
      delete metadata.parameterVersion;
      delete metadata.files.mainContractMappings;
      if (schemaVersion < 3) delete metadata.files.bars1;
      if (schemaVersion === 1) delete metadata.files.rollovers;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await unlink(join(saved.directory, 'edb_main_contract_mapping.csv'));
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
  });

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
  }, 15_000);

  it('writes schema 4 identity fields and hashes for every persisted file', async () => {
    const paths = await fixture();
    const saved = await saveMarketSnapshot(
      paths,
      DEFAULT_INSTRUMENT,
      await candidate(paths),
      { idFactory: () => 'snapshot-hash' },
    );
    const metadata = saved.metadata!;
    expect(metadata).toMatchObject({
      schemaVersion: 4,
      instrumentId: 'main_continuous',
      mainSymbol: 'KQ.m@DCE.m',
      parameterVersion: 1,
    });
    if (metadata.schemaVersion !== 4) throw new Error('expected schema 4');
    for (const file of Object.values(metadata.files)) {
      const contents = await readFile(join(saved.directory, file.name));
      expect(createHash('sha256').update(contents).digest('hex')).toBe(file.sha256);
    }
    expect(saved.mainContractMappings).toHaveLength(4);
    expect(await snapshotFingerprint(saved.directory)).toHaveProperty('edb_main_contract_mapping.csv');
  });

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
  }, 15_000);
});

describe('legacy soymeal migration', () => {
  it('copies flat built-in data and the old global user snapshot without deleting either source', async () => {
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
    const first = await migrateLegacySoymealData(paths);
    expect(first).toEqual({ builtinMigrated: true, userSnapshotMigrated: true });
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
  }, 30_000);

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
  }, 30_000);
});
