import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregateMinutes,
  serializeBars,
  serializeMinuteRecords,
} from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import { timeIndexForDataset } from '../src/domain/time-index';
import { createDataService, resolveDataDirectory } from '../src/main/data-service';
import { createWorkerMarketDataPreparation } from '../src/main/market-data-preparation';
import {
  type MarketDataPaths,
  resolveInstrumentDataDirectories,
} from '../src/main/market-snapshot';
import {
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_IDS,
  type InstrumentDefinition,
} from '../src/shared/instruments';
import type { EdbMinuteRecord } from '../src/shared/types';

const temps: string[] = [];
let workerBundleRoot = '';
let workerScriptPath = '';

beforeAll(async () => {
  workerBundleRoot = await mkdtemp(join(tmpdir(), 'moneycoming-worker-bundle-'));
  workerScriptPath = join(workerBundleRoot, 'market-data-worker.cjs');
  await build({
    entryPoints: [resolve('src/main/market-data-worker.ts')],
    outfile: workerScriptPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  });
});

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

afterAll(async () => {
  await rm(workerBundleRoot, { recursive: true, force: true });
});

function minuteRecords(): EdbMinuteRecord[] {
  const first = parseBeijing('2026-10-09 09:00:00');
  return Array.from({ length: 60 }, (_, index) => {
    const startMs = first + index * 60_000;
    return {
      datetimeNano: String(BigInt(startMs) * 1_000_000n),
      startMs,
      start: `2026-10-09 09:${String(index).padStart(2, '0')}:00`,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 10,
      openOi: 1_000,
      closeOi: 1_001,
    };
  });
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function fixture(): Promise<MarketDataPaths> {
  const root = await mkdtemp(join(tmpdir(), 'moneycoming-service-'));
  temps.push(root);
  return {
    builtinDataDirectory: join(root, 'data'),
    marketDataDirectory: join(root, 'AppData', 'market-data'),
  };
}

async function installBaseline(
  paths: MarketDataPaths,
  definition: InstrumentDefinition,
): Promise<string> {
  const directory = resolveInstrumentDataDirectories(paths, definition).builtin;
  await mkdir(directory, { recursive: true });
  const bars1 = minuteRecords();
  const bars5 = aggregateMinutes(
    bars1,
    5,
    bars1.at(-1)!.startMs + 60_000,
    definition.tradingSessions,
  );
  const bars60 = aggregateMinutes(
    bars1,
    60,
    bars1.at(-1)!.startMs + 60_000,
    definition.tradingSessions,
  );
  const one = serializeMinuteRecords(bars1, definition.tradingSessions);
  const five = serializeBars(bars5);
  const sixty = serializeBars(bars60);
  const rollovers = '\uFEFFtrading_date,time,from_contract,to_contract\r\n';
  const mappings = '\uFEFFtrading_date,contract\r\n';
  const files = {
    bars1: {
      name: 'edb_main_continuous_1m_raw.csv',
      sha256: hash(one),
      rows: bars1.length,
    },
    bars5: {
      name: 'edb_main_continuous_5m.csv',
      sha256: hash(five),
      rows: bars5.length,
    },
    bars60: {
      name: 'edb_main_continuous_60m.csv',
      sha256: hash(sixty),
      rows: bars60.length,
    },
    rollovers: {
      name: 'edb_main_continuous_rollovers.csv',
      sha256: hash(rollovers),
      rows: 0,
    },
    mainContractMappings: {
      name: 'edb_main_contract_mapping.csv',
      sha256: hash(mappings),
      rows: 0,
    },
  };
  const metadata = {
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
    requestStart: '2026-10-09 09:00:00',
    requestEnd: '2026-10-09 10:00:00',
    sourceLatestAt: '2026-10-09 10:00:00',
    files,
  };
  await Promise.all([
    writeFile(join(directory, files.bars1.name), one),
    writeFile(join(directory, files.bars5.name), five),
    writeFile(join(directory, files.bars60.name), sixty),
    writeFile(join(directory, files.rollovers.name), rollovers),
    writeFile(join(directory, files.mainContractMappings.name), mappings),
    writeFile(join(directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  return directory;
}

describe('portable data service', () => {
  it('uses the executable location in production and the data directory in development', () => {
    expect(resolveDataDirectory(
      'C:\\中文 空格\\MoneyComing\\MoneyComing.exe',
      true,
      'D:\\development',
    )).toBe('C:\\中文 空格\\MoneyComing\\data');
    expect(resolveDataDirectory(
      'irrelevant',
      false,
      'D:\\development',
    )).toBe('D:\\development\\data');
  });

  it('loads all fifteen instrument identifiers with isolated source metadata', async () => {
    const paths = await fixture();
    await Promise.all(INSTRUMENT_IDS.map(id => (
      installBaseline(paths, INSTRUMENT_DEFINITIONS[id])
    )));
    const service = createDataService(paths);
    for (const instrument of INSTRUMENT_IDS) {
      const result = await service.load(instrument);
      expect(result.ok, instrument).toBe(true);
      if (!result.ok) continue;
      expect(result.data).toMatchObject({
        instrument,
        definition: INSTRUMENT_DEFINITIONS[instrument],
        name: INSTRUMENT_DEFINITIONS[instrument].name,
        symbol: INSTRUMENT_DEFINITIONS[instrument].mainSymbol,
        snapshotSource: 'builtin',
        sourceLatestAt: '2026-10-09 10:00:00',
      });
      expect(result.data.bars1).toHaveLength(60);
      expect(result.data.bars5).toHaveLength(12);
      expect(result.data.bars60).toHaveLength(1);
      expect(result.data.mainContractMappings).toEqual([]);
      expect(result.data.rollovers).toEqual([]);
    }
  });

  it('exposes accurate preparation diagnostics only in explicit test mode', async () => {
    const paths = await fixture();
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    const productionService = createDataService(paths);
    expect(productionService.getTestDiagnostics).toBeUndefined();

    const service = createDataService(paths, { testMode: true });
    const pending = service.load('main_continuous');
    expect(service.getTestDiagnostics?.()).toMatchObject({
      instruments: {
        main_continuous: {
          preparationStarted: 1,
          preparationCompleted: 0,
          preparationFailed: 0,
          cacheHits: 0,
        },
      },
      inFlightCount: 1,
      cacheSize: 0,
      lruOrder: [],
    });
    const first = await pending;
    expect(first.ok).toBe(true);
    const second = await service.load('main_continuous');
    expect(second.ok && first.ok && second.data).toBe(
      first.ok ? first.data : undefined,
    );
    expect(service.getTestDiagnostics?.()).toEqual({
      instruments: {
        main_continuous: {
          preparationStarted: 1,
          preparationCompleted: 1,
          preparationFailed: 0,
          cacheHits: 1,
        },
      },
      inFlightCount: 0,
      cacheSize: 1,
      lruOrder: ['main_continuous'],
    });
  });

  it('shares one preparation between concurrent dataset and snapshot requests', async () => {
    const paths = await fixture();
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    const service = createDataService(paths, { testMode: true });

    const [first, snapshot, second] = await Promise.all([
      service.load('main_continuous'),
      service.loadSnapshot('main_continuous'),
      service.load('main_continuous'),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data).toBe(first.data);
    expect(snapshot.bars1).toBe(first.data.bars1);
    expect(snapshot.bars5).toBe(first.data.bars5);
    expect(snapshot.bars60).toBe(first.data.bars60);
    expect(service.getTestDiagnostics?.()).toEqual({
      instruments: {
        main_continuous: {
          preparationStarted: 1,
          preparationCompleted: 1,
          preparationFailed: 0,
          cacheHits: 0,
        },
      },
      inFlightCount: 0,
      cacheSize: 1,
      lruOrder: ['main_continuous'],
    });
  });

  it('starts a new generation after invalidation without caching the stale result', async () => {
    const paths = await fixture();
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    const service = createDataService(paths, { testMode: true });

    const stalePending = service.load('main_continuous');
    service.invalidate('main_continuous');
    const freshPending = service.load('main_continuous');
    const [stale, fresh] = await Promise.all([stalePending, freshPending]);

    expect(stale.ok).toBe(true);
    expect(fresh.ok).toBe(true);
    if (!stale.ok || !fresh.ok) return;
    expect(fresh.data).not.toBe(stale.data);
    const cached = await service.load('main_continuous');
    expect(cached.ok && cached.data).toBe(fresh.data);
    expect(service.getTestDiagnostics?.()).toEqual({
      instruments: {
        main_continuous: {
          preparationStarted: 2,
          preparationCompleted: 2,
          preparationFailed: 0,
          cacheHits: 1,
        },
      },
      inFlightCount: 0,
      cacheSize: 1,
      lruOrder: ['main_continuous'],
    });
  });

  it('shares an explicit reload generation and retries after preparation failure', async () => {
    const paths = await fixture();
    const directory = await installBaseline(
      paths,
      INSTRUMENT_DEFINITIONS.main_continuous,
    );
    const service = createDataService(paths, { testMode: true });
    expect((await service.load('main_continuous')).ok).toBe(true);

    const reloadedPending = service.load('main_continuous', true);
    const snapshotPending = service.loadSnapshot('main_continuous');
    const [reloaded, snapshot] = await Promise.all([
      reloadedPending,
      snapshotPending,
    ]);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(snapshot.bars5).toBe(reloaded.data.bars5);

    service.invalidate('main_continuous');
    await unlink(join(directory, 'metadata.json'));
    expect((await service.load('main_continuous')).ok).toBe(false);
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    expect((await service.load('main_continuous')).ok).toBe(true);
    expect(service.getTestDiagnostics?.()).toEqual({
      instruments: {
        main_continuous: {
          preparationStarted: 4,
          preparationCompleted: 3,
          preparationFailed: 1,
          cacheHits: 0,
        },
      },
      inFlightCount: 0,
      cacheSize: 1,
      lruOrder: ['main_continuous'],
    });
  });

  it('counts failed preparation and invalidation without retaining stale cache state', async () => {
    const paths = await fixture();
    const directory = await installBaseline(
      paths,
      INSTRUMENT_DEFINITIONS.main_continuous,
    );
    const service = createDataService(paths, { testMode: true });
    expect((await service.load('main_continuous')).ok).toBe(true);
    expect((await service.load('main_continuous')).ok).toBe(true);

    service.invalidate('main_continuous');
    await unlink(join(directory, 'metadata.json'));
    expect((await service.load('main_continuous')).ok).toBe(false);

    expect(service.getTestDiagnostics?.()).toEqual({
      instruments: {
        main_continuous: {
          preparationStarted: 2,
          preparationCompleted: 1,
          preparationFailed: 1,
          cacheHits: 1,
        },
      },
      inFlightCount: 0,
      cacheSize: 0,
      lruOrder: [],
    });
  });

  it('rejects unknown instrument identifiers without treating them as paths', async () => {
    const paths = await fixture();
    const result = await createDataService(paths).load('../secrets' as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('不支持的行情标的');
  });

  it('reuses cached data and invalidates only the requested instrument', async () => {
    const paths = await fixture();
    const soymealDirectory = await installBaseline(
      paths,
      INSTRUMENT_DEFINITIONS.main_continuous,
    );
    const rebarDirectory = await installBaseline(
      paths,
      INSTRUMENT_DEFINITIONS.rebar_main,
    );
    const service = createDataService(paths);
    const soymeal = await service.load('main_continuous');
    const rebar = await service.load('rebar_main');
    expect(soymeal.ok).toBe(true);
    expect(rebar.ok).toBe(true);

    await unlink(join(soymealDirectory, 'metadata.json'));
    await unlink(join(rebarDirectory, 'metadata.json'));
    const cachedSoymeal = await service.load('main_continuous');
    const cachedRebar = await service.load('rebar_main');
    expect(cachedSoymeal.ok && soymeal.ok && cachedSoymeal.data).toBe(
      soymeal.ok ? soymeal.data : undefined,
    );
    expect(cachedRebar.ok && rebar.ok && cachedRebar.data).toBe(
      rebar.ok ? rebar.data : undefined,
    );

    service.invalidate('main_continuous');
    expect((await service.load('main_continuous')).ok).toBe(false);
    const stillCachedRebar = await service.load('rebar_main');
    expect(stillCachedRebar.ok && rebar.ok && stillCachedRebar.data).toBe(
      rebar.ok ? rebar.data : undefined,
    );
  });

  it('keeps three prepared instruments in least-recently-used order', async () => {
    const paths = await fixture();
    const instruments = [
      'main_continuous',
      'rebar_main',
      'pvc_main',
      'corn_main',
    ] as const;
    const directories = new Map<string, string>();
    for (const instrument of instruments) {
      directories.set(
        instrument,
        await installBaseline(paths, INSTRUMENT_DEFINITIONS[instrument]),
      );
    }
    const service = createDataService(paths, { testMode: true });

    for (const instrument of instruments.slice(0, 3)) {
      expect((await service.load(instrument)).ok).toBe(true);
    }
    expect(service.getTestDiagnostics?.().lruOrder).toEqual([
      'main_continuous',
      'rebar_main',
      'pvc_main',
    ]);

    expect((await service.load('main_continuous')).ok).toBe(true);
    expect(service.getTestDiagnostics?.().lruOrder).toEqual([
      'rebar_main',
      'pvc_main',
      'main_continuous',
    ]);

    expect((await service.load('corn_main')).ok).toBe(true);
    expect(service.getTestDiagnostics?.()).toMatchObject({
      cacheSize: 3,
      lruOrder: ['pvc_main', 'main_continuous', 'corn_main'],
    });

    await unlink(join(directories.get('rebar_main')!, 'metadata.json'));
    expect((await service.load('rebar_main')).ok).toBe(false);
    expect(service.getTestDiagnostics?.()).toMatchObject({
      cacheSize: 3,
      lruOrder: ['pvc_main', 'main_continuous', 'corn_main'],
      instruments: {
        rebar_main: {
          preparationStarted: 2,
          preparationCompleted: 1,
          preparationFailed: 1,
          cacheHits: 0,
        },
      },
    });

    service.invalidate('main_continuous');
    expect(service.getTestDiagnostics?.()).toMatchObject({
      cacheSize: 2,
      lruOrder: ['pvc_main', 'corn_main'],
    });
  });

  it('bounds sequential access to all instruments and prepares an evicted item again', async () => {
    const paths = await fixture();
    await Promise.all(INSTRUMENT_IDS.map(instrument => (
      installBaseline(paths, INSTRUMENT_DEFINITIONS[instrument])
    )));
    const service = createDataService(paths, { testMode: true });

    for (const instrument of INSTRUMENT_IDS) {
      expect((await service.load(instrument)).ok).toBe(true);
      expect(service.getTestDiagnostics?.().cacheSize).toBeLessThanOrEqual(3);
    }
    expect(service.getTestDiagnostics?.().lruOrder).toEqual(
      INSTRUMENT_IDS.slice(-3),
    );

    expect((await service.load(INSTRUMENT_IDS[0])).ok).toBe(true);
    expect(service.getTestDiagnostics?.()).toMatchObject({
      cacheSize: 3,
      instruments: {
        [INSTRUMENT_IDS[0]]: {
          preparationStarted: 2,
          preparationCompleted: 2,
          preparationFailed: 0,
          cacheHits: 0,
        },
      },
    });
  });

  it('reports the missing per-instrument baseline path', async () => {
    const paths = await fixture();
    const result = await createDataService(paths).load('pvc_main');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(join(
        paths.builtinDataDirectory,
        'instruments',
        'pvc_main',
        'metadata.json',
      ));
    }
  });

  it('reloads editable entry rules and rejects missing or oversized files', async () => {
    const paths = await fixture();
    await mkdir(paths.builtinDataDirectory, { recursive: true });
    const file = join(paths.builtinDataDirectory, 'entry-rules.md');
    await writeFile(file, '# 规则\n<script>不执行</script>');
    const service = createDataService(paths);
    const first = await service.readEntryRules();
    expect(first).toMatchObject({
      ok: true,
      fallback: false,
      path: file,
      text: '# 规则\n<script>不执行</script>',
    });
    await writeFile(file, '修改后的规则');
    expect((await service.readEntryRules()).text).toBe('修改后的规则');
    await writeFile(file, 'x'.repeat(128 * 1024 + 1));
    expect(await service.readEntryRules()).toMatchObject({
      ok: false,
      fallback: true,
      error: '规则文件超过128KB',
    });
    await unlink(file);
    expect(await service.readEntryRules()).toMatchObject({
      ok: false,
      fallback: true,
      error: '规则文件不存在',
    });
  });

  it('does not alter a baseline while reading it', async () => {
    const paths = await fixture();
    const directory = await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    const file = join(directory, 'edb_main_continuous_5m.csv');
    const before = createHash('sha256').update(await readFile(file)).digest('hex');
    expect((await createDataService(paths).load('main_continuous')).ok).toBe(true);
    expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(before);
  });

  it('matches the synchronous reference path through the worker on the real baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moneycoming-worker-parity-'));
    temps.push(root);
    const paths: MarketDataPaths = {
      builtinDataDirectory: resolve('data'),
      marketDataDirectory: join(root, 'market-data'),
    };
    const reference = createDataService(paths);
    const workerBackend = createWorkerMarketDataPreparation(workerScriptPath);
    const workerService = createDataService(paths, {
      preparationBackend: workerBackend,
    });
    try {
      const [referenceResult, workerResult] = await Promise.all([
        reference.load('main_continuous'),
        workerService.load('main_continuous'),
      ]);
      expect(referenceResult.ok).toBe(true);
      expect(workerResult.ok).toBe(true);
      if (!referenceResult.ok || !workerResult.ok) return;

      expect(isDeepStrictEqual(workerResult.data, referenceResult.data)).toBe(true);
      const referenceIndexes = timeIndexForDataset(referenceResult.data);
      const workerIndexes = timeIndexForDataset(workerResult.data);
      expect(workerIndexes.bars1.startTimes).toEqual(referenceIndexes.bars1.startTimes);
      expect(workerIndexes.bars5.startTimes).toEqual(referenceIndexes.bars5.startTimes);
      expect(workerIndexes.bars60.startTimes).toEqual(referenceIndexes.bars60.startTimes);
      expect(workerResult.data.mainContractMappings)
        .toEqual(referenceResult.data.mainContractMappings);
      expect(workerResult.data.rollovers).toEqual(referenceResult.data.rollovers);
      expect(workerResult.data.anomalies).toEqual(referenceResult.data.anomalies);
    } finally {
      await Promise.all([reference.dispose(), workerService.dispose()]);
    }
  }, 120_000);

  it('propagates corrupt files without caching the failure and retries successfully', async () => {
    const paths = await fixture();
    const directory = await installBaseline(
      paths,
      INSTRUMENT_DEFINITIONS.corn_main,
    );
    const file = join(directory, 'edb_main_continuous_5m.csv');
    const original = await readFile(file, 'utf8');
    const service = createDataService(paths, {
      testMode: true,
      preparationBackend: createWorkerMarketDataPreparation(workerScriptPath),
    });
    try {
      await writeFile(file, `${original}\ncorrupt`);

      const failed = await service.load('corn_main');
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).toContain('哈希不一致');
      expect(service.getTestDiagnostics?.()).toMatchObject({
        inFlightCount: 0,
        cacheSize: 0,
        instruments: {
          corn_main: {
            preparationStarted: 1,
            preparationCompleted: 0,
            preparationFailed: 1,
          },
        },
      });

      await writeFile(file, original);
      expect((await service.load('corn_main')).ok).toBe(true);
      expect(service.getTestDiagnostics?.()).toMatchObject({
        inFlightCount: 0,
        cacheSize: 1,
        instruments: {
          corn_main: {
            preparationStarted: 2,
            preparationCompleted: 1,
            preparationFailed: 1,
          },
        },
      });
    } finally {
      await service.dispose();
    }
  });

  it('recovers after a worker crash without retaining a failed preparation', async () => {
    const paths = await fixture();
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    let workersCreated = 0;
    const backend = createWorkerMarketDataPreparation(
      workerScriptPath,
      path => {
        workersCreated += 1;
        if (workersCreated === 1) {
          return new Worker(
            'const { parentPort } = require("node:worker_threads");'
              + 'parentPort.once("message", () => process.exit(17));',
            { eval: true },
          );
        }
        return new Worker(path);
      },
    );
    const service = createDataService(paths, {
      testMode: true,
      preparationBackend: backend,
    });

    expect((await service.load('main_continuous')).ok).toBe(false);
    expect(service.getTestDiagnostics?.()).toMatchObject({
      inFlightCount: 0,
      cacheSize: 0,
      instruments: {
        main_continuous: {
          preparationStarted: 1,
          preparationCompleted: 0,
          preparationFailed: 1,
        },
      },
    });
    expect((await service.load('main_continuous')).ok).toBe(true);
    expect(workersCreated).toBe(2);
    await service.dispose();
  });

  it('rejects pending worker requests and clears service state on dispose', async () => {
    const paths = await fixture();
    await installBaseline(paths, INSTRUMENT_DEFINITIONS.main_continuous);
    const backend = createWorkerMarketDataPreparation(
      workerScriptPath,
      () => new Worker(
        'const { parentPort } = require("node:worker_threads");'
          + 'parentPort.on("message", () => {});',
        { eval: true },
      ),
    );
    const service = createDataService(paths, {
      testMode: true,
      preparationBackend: backend,
    });

    const pending = service.load('main_continuous');
    expect(service.getTestDiagnostics?.().inFlightCount).toBe(1);
    await service.dispose();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Worker 已关闭');
    expect(service.getTestDiagnostics?.()).toMatchObject({
      inFlightCount: 0,
      cacheSize: 0,
      lruOrder: [],
    });
    expect((await service.load('main_continuous')).ok).toBe(false);
  });
});
