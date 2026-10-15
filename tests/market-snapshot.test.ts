import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBars } from '../src/domain/data';
import {
  cleanupSnapshots,
  loadEffectiveSnapshot,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  type MarketDataPaths,
} from '../src/main/market-snapshot';

const source = resolve('futures_investigation_20261009');
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<MarketDataPaths> {
  const root = await mkdtemp(join(tmpdir(), '行情 快照-'));
  temps.push(root);
  const builtin = join(root, '内置 数据');
  await mkdir(builtin);
  for (const name of ['edb_main_continuous_5m.csv', 'edb_main_continuous_60m.csv']) {
    await cp(join(source, name), join(builtin, name));
  }
  return { builtinDataDirectory: builtin, marketDataDirectory: join(root, 'App Data', 'market-data') };
}

async function candidate(paths: MarketDataPaths) {
  const bars5 = parseBars(await readFile(join(paths.builtinDataDirectory, 'edb_main_continuous_5m.csv'), 'utf8'), '5m');
  const bars60 = parseBars(await readFile(join(paths.builtinDataDirectory, 'edb_main_continuous_60m.csv'), 'utf8'), '60m');
  return {
    bars5,
    bars60,
    requestStart: '2026-10-08 00:00:00',
    requestEnd: '2026-10-15 12:00:00',
    sourceLatestAt: '2026-10-09 15:00:00',
  };
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
    });
    expect(resolveMarketDataPaths('ignored', false, 'D:\\项目', 'E:\\用户 数据')).toEqual({
      builtinDataDirectory: 'D:\\项目\\futures_investigation_20261009',
      marketDataDirectory: 'E:\\用户 数据\\market-data',
    });
  });
});

describe('versioned market snapshots', () => {
  it('keeps a staged snapshot invisible and loads it only after the pointer switch', async () => {
    const paths = await fixture();
    const before = await loadEffectiveSnapshot(paths);
    let observedSource = '';
    const saved = await saveMarketSnapshot(paths, await candidate(paths), {
      now: () => new Date('2026-10-15T04:00:00.000Z'),
      idFactory: () => 'snapshot-a',
      beforePointerSwitch: async () => {
        observedSource = (await loadEffectiveSnapshot(paths)).source;
      },
    });
    expect(before.source).toBe('builtin');
    expect(observedSource).toBe('builtin');
    expect(saved).toMatchObject({ source: 'user', snapshotUpdatedAt: '2026-10-15T04:00:00.000Z' });
    expect((await loadEffectiveSnapshot(paths)).directory).toContain('snapshot-a');
  });

  it('falls back from a broken pointer or corrupt current snapshot to the previous complete snapshot', async () => {
    const paths = await fixture();
    await saveMarketSnapshot(paths, await candidate(paths), {
      now: () => new Date('2026-10-15T01:00:00.000Z'),
      idFactory: () => 'snapshot-old',
    });
    await saveMarketSnapshot(paths, await candidate(paths), {
      now: () => new Date('2026-10-15T02:00:00.000Z'),
      idFactory: () => 'snapshot-new',
    });
    await writeFile(join(paths.marketDataDirectory, 'current.json'), '{bad json');
    expect((await loadEffectiveSnapshot(paths)).directory).toContain('snapshot-new');
    await writeFile(
      join(paths.marketDataDirectory, 'snapshots', 'snapshot-new', 'edb_main_continuous_5m.csv'),
      'corrupt',
    );
    expect((await loadEffectiveSnapshot(paths)).directory).toContain('snapshot-old');
  });

  it.each([
    ['missing file', async (paths: MarketDataPaths) => unlink(join(paths.marketDataDirectory, 'snapshots', 'snapshot-a', 'edb_main_continuous_5m.csv'))],
    ['unknown schema', async (paths: MarketDataPaths) => {
      const file = join(paths.marketDataDirectory, 'snapshots', 'snapshot-a', 'metadata.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.schemaVersion = 99;
      await writeFile(file, JSON.stringify(metadata));
    }],
    ['hash mismatch', async (paths: MarketDataPaths) => {
      const file = join(paths.marketDataDirectory, 'snapshots', 'snapshot-a', 'edb_main_continuous_5m.csv');
      await writeFile(file, `${await readFile(file, 'utf8')}\n`);
    }],
  ])('falls back to the built-in baseline on %s without a previous user snapshot', async (_name, breakSnapshot) => {
    const paths = await fixture();
    await saveMarketSnapshot(paths, await candidate(paths), { idFactory: () => 'snapshot-a' });
    await breakSnapshot(paths);
    expect((await loadEffectiveSnapshot(paths)).source).toBe('builtin');
  });

  it('does not activate a snapshot when saving fails before pointer replacement', async () => {
    const paths = await fixture();
    await expect(saveMarketSnapshot(paths, await candidate(paths), {
      idFactory: () => 'snapshot-failed',
      beforePointerSwitch: () => {
        throw new Error('simulated disk failure');
      },
    })).rejects.toThrow(/disk failure/);
    expect((await loadEffectiveSnapshot(paths)).source).toBe('builtin');
  });

  it('keeps the current and one previous activated snapshot during cleanup', async () => {
    const paths = await fixture();
    for (const [id, hour] of [['one', 1], ['two', 2], ['three', 3]] as const) {
      await saveMarketSnapshot(paths, await candidate(paths), {
        idFactory: () => id,
        now: () => new Date(`2026-10-15T0${hour}:00:00.000Z`),
      });
    }
    await cleanupSnapshots(paths.marketDataDirectory, 'three');
    await expect(readFile(join(paths.marketDataDirectory, 'snapshots', 'three', 'metadata.json'))).resolves.toBeTruthy();
    await expect(readFile(join(paths.marketDataDirectory, 'snapshots', 'two', 'metadata.json'))).resolves.toBeTruthy();
    await expect(readFile(join(paths.marketDataDirectory, 'snapshots', 'one', 'metadata.json'))).rejects.toThrow();
  });

  it('writes hashes matching the committed CSV files', async () => {
    const paths = await fixture();
    const saved = await saveMarketSnapshot(paths, await candidate(paths), { idFactory: () => 'snapshot-hash' });
    const metadata = saved.metadata!;
    const five = await readFile(join(saved.directory, metadata.files.bars5.name));
    expect(createHash('sha256').update(five).digest('hex')).toBe(metadata.files.bars5.sha256);
  });
});
