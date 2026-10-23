import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Instrument, LoadResult, Dataset, Anomaly } from '../shared/types';
import {
  instrumentDefinition,
  isInstrument,
} from '../shared/instruments';
import { timeIndexForDataset } from '../domain/time-index';
import {
  createLocalMarketDataPreparation,
  type MarketDataPreparationBackend,
} from './market-data-preparation';
import {
  loadEffectiveSnapshotWithLoader,
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  type LoadedMarketSnapshot,
  type MarketDataPaths,
} from './market-snapshot';

export interface DataServiceOptions {
  testMode?: boolean;
  cacheCapacity?: number;
  preparationBackend?: MarketDataPreparationBackend;
}

export interface DataServiceInstrumentDiagnostics {
  preparationStarted: number;
  preparationCompleted: number;
  preparationFailed: number;
  cacheHits: number;
}

export interface DataServiceDiagnostics {
  instruments: Partial<Record<Instrument, DataServiceInstrumentDiagnostics>>;
  inFlightCount: number;
  cacheSize: number;
  lruOrder: Instrument[];
}

interface PreparedInstrument {
  data: Dataset;
  snapshot: LoadedMarketSnapshot;
}

interface CachedPreparedInstrument {
  generation: number;
  value: PreparedInstrument;
}

interface InFlightPreparation {
  generation: number;
  promise: Promise<PreparedInstrument>;
}

export function resolveDataDirectory(exe: string, packaged: boolean, root: string): string {
  return packaged ? join(dirname(exe), 'data') : join(root, 'data');
}

export function createDataService(
  paths: MarketDataPaths,
  options?: DataServiceOptions,
): ReturnType<typeof createService>;
export function createDataService(
  directory: string,
  marketDataDirectory?: string,
  options?: DataServiceOptions,
): ReturnType<typeof createService>;
export function createDataService(
  directoryOrPaths: string | MarketDataPaths,
  marketDataDirectoryOrOptions?: string | DataServiceOptions,
  options: DataServiceOptions = {},
) {
  const paths: MarketDataPaths = typeof directoryOrPaths === 'string'
    ? {
        builtinDataDirectory: directoryOrPaths,
        marketDataDirectory: typeof marketDataDirectoryOrOptions === 'string'
          ? marketDataDirectoryOrOptions
          : join(directoryOrPaths, '.market-data'),
      }
    : directoryOrPaths;
  const resolvedOptions = typeof directoryOrPaths === 'string'
    ? options
    : marketDataDirectoryOrOptions ?? {};
  return createService(paths, resolvedOptions as DataServiceOptions);
}

function createService(paths: MarketDataPaths, options: DataServiceOptions) {
  const cacheCapacity = Math.max(1, Math.floor(options.cacheCapacity ?? 3));
  const preparationBackend = options.preparationBackend
    ?? createLocalMarketDataPreparation();
  const cache = new Map<Instrument, CachedPreparedInstrument>();
  const inFlight = new Map<Instrument, InFlightPreparation>();
  const generations = new Map<Instrument, number>();
  const diagnosticCounters = new Map<Instrument, DataServiceInstrumentDiagnostics>();
  let inFlightCount = 0;
  let disposed = false;

  function countersFor(instrument: Instrument): DataServiceInstrumentDiagnostics {
    const existing = diagnosticCounters.get(instrument);
    if (existing) return existing;
    const created: DataServiceInstrumentDiagnostics = {
      preparationStarted: 0,
      preparationCompleted: 0,
      preparationFailed: 0,
      cacheHits: 0,
    };
    diagnosticCounters.set(instrument, created);
    return created;
  }

  function diagnostics(): DataServiceDiagnostics {
    return {
      instruments: Object.fromEntries(
        [...diagnosticCounters].map(([instrument, counters]) => [
          instrument,
          { ...counters },
        ]),
      ),
      inFlightCount,
      cacheSize: cache.size,
      lruOrder: [...cache.keys()],
    };
  }

  async function readFirst(pathsToTry: string[]): Promise<{ path: string; text: string }> {
    let lastError: unknown;
    for (const path of pathsToTry) {
      try {
        return { path, text: await readFile(path, 'utf8') };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function sharedPaths(name: string): string[] {
    const candidates = [join(paths.builtinDataDirectory, name)];
    if (paths.legacyBuiltinDataDirectory
      && paths.legacyBuiltinDataDirectory !== paths.builtinDataDirectory) {
      candidates.push(join(paths.legacyBuiltinDataDirectory, name));
    }
    return candidates;
  }

  async function readPreparedInstrument(
    instrument: Instrument,
  ): Promise<PreparedInstrument> {
    const definition = instrumentDefinition(instrument);
    const snapshot = await loadEffectiveSnapshotWithLoader(
      paths,
      definition,
      request => preparationBackend.loadSnapshotDirectory(request),
    );
    let auditAvailable = false;
    let anomalies: Anomaly[] = [];
    try {
      const instrumentDirectory = resolveInstrumentDataDirectories(paths, definition).builtin;
      const auditPaths = [join(instrumentDirectory, 'cross_source_audit.json')];
      if (definition.id === 'main_continuous') {
        auditPaths.push(...sharedPaths('cross_source_audit.json'));
      }
      anomalies = await preparationBackend.loadAudit([...new Set(auditPaths)]);
      auditAvailable = true;
    } catch { /* Optional audit metadata cannot prevent viewing valid prices. */ }
    const data: Dataset = {
      instrument,
      definition,
      name: definition.name,
      symbol: definition.mainSymbol,
      bars1: snapshot.bars1,
      bars5: snapshot.bars5,
      bars60: snapshot.bars60,
      mainContractMappings: snapshot.mainContractMappings,
      rollovers: snapshot.rollovers,
      anomalies,
      auditAvailable,
      dataDirectory: snapshot.directory,
      snapshotSource: snapshot.source,
      sourceLatestAt: snapshot.sourceLatestAt,
      snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
    };
    timeIndexForDataset(data);
    return {
      snapshot,
      data,
    };
  }

  function generationFor(instrument: Instrument): number {
    return generations.get(instrument) ?? 0;
  }

  function invalidateInstrument(instrument: Instrument): void {
    generations.set(instrument, generationFor(instrument) + 1);
    cache.delete(instrument);
  }

  function prepareInstrument(instrument: Instrument): Promise<PreparedInstrument> {
    if (disposed) {
      return Promise.reject(new Error('行情数据服务已关闭'));
    }
    const generation = generationFor(instrument);
    const cached = cache.get(instrument);
    if (cached?.generation === generation) {
      countersFor(instrument).cacheHits += 1;
      cache.delete(instrument);
      cache.set(instrument, cached);
      return Promise.resolve(cached.value);
    }
    if (cached) cache.delete(instrument);

    const pending = inFlight.get(instrument);
    if (pending?.generation === generation) return pending.promise;

    const counters = countersFor(instrument);
    counters.preparationStarted += 1;
    inFlightCount += 1;
    let entry: InFlightPreparation;
    const promise = readPreparedInstrument(instrument)
      .then(value => {
        if (generationFor(instrument) === generation) {
          cache.set(instrument, { generation, value });
          while (cache.size > cacheCapacity) {
            const oldest = cache.keys().next().value as Instrument | undefined;
            if (!oldest) break;
            cache.delete(oldest);
          }
        }
        counters.preparationCompleted += 1;
        return value;
      })
      .catch(error => {
        counters.preparationFailed += 1;
        throw error;
      })
      .finally(() => {
        inFlightCount -= 1;
        if (inFlight.get(instrument) === entry) {
          inFlight.delete(instrument);
        }
      });
    entry = { generation, promise };
    inFlight.set(instrument, entry);
    return promise;
  }

  return {
    async readEntryRules() {
      try {
        const { path } = await readFirst(sharedPaths('entry-rules.md'));
        const info = await stat(path);
        if (info.size > 128 * 1024) return { ok: false, text: '', path, fallback: true, error: '规则文件超过128KB' };
        return { ok: true, text: await readFile(path, 'utf8'), path, modifiedAt: info.mtime.toISOString(), fallback: false };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const path = sharedPaths('entry-rules.md')[0];
        return { ok: false, text: '', path, fallback: true, error: code === 'ENOENT' ? '规则文件不存在' : '规则文件无法读取' };
      }
    },
    async load(instrument: Instrument, reload = false): Promise<LoadResult> {
      if (!isInstrument(instrument)) return { ok: false, error: '不支持的行情标的' };
      if (reload) invalidateInstrument(instrument);
      try {
        const { data } = await prepareInstrument(instrument);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '行情数据加载失败，请重试' };
      }
    },
    invalidate(instrument: Instrument = 'main_continuous') {
      invalidateInstrument(instrument);
    },
    loadSnapshot(instrument: Instrument) {
      if (!isInstrument(instrument)) {
        return Promise.reject(new Error('不支持的行情标的'));
      }
      return prepareInstrument(instrument).then(({ snapshot }) => snapshot);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const instrument of inFlight.keys()) {
        generations.set(instrument, generationFor(instrument) + 1);
      }
      cache.clear();
      const pending = [...inFlight.values()].map(entry => entry.promise);
      await preparationBackend.dispose();
      await Promise.allSettled(pending);
      inFlight.clear();
    },
    paths,
    getTestDiagnostics: options.testMode ? diagnostics : undefined,
  };
}

export { resolveMarketDataPaths };
