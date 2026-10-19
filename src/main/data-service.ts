import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Instrument, LoadResult, Dataset, Anomaly } from '../shared/types';
import {
  instrumentDefinition,
  isInstrument,
} from '../shared/instruments';
import { parseAudit } from '../domain/data';
import {
  loadEffectiveSnapshot,
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  type MarketDataPaths,
} from './market-snapshot';

export function resolveDataDirectory(exe: string, packaged: boolean, root: string): string {
  return packaged ? join(dirname(exe), 'data') : join(root, 'data');
}

export function createDataService(paths: MarketDataPaths): ReturnType<typeof createService>;
export function createDataService(
  directory: string,
  marketDataDirectory?: string,
): ReturnType<typeof createService>;
export function createDataService(
  directoryOrPaths: string | MarketDataPaths,
  marketDataDirectory?: string,
) {
  const paths: MarketDataPaths = typeof directoryOrPaths === 'string'
    ? {
        builtinDataDirectory: directoryOrPaths,
        marketDataDirectory: marketDataDirectory ?? join(directoryOrPaths, '.market-data'),
      }
    : directoryOrPaths;
  return createService(paths);
}

function createService(paths: MarketDataPaths) {
  const cache = new Map<Instrument, Dataset>();

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
      if (reload) cache.delete(instrument);
      const cached = cache.get(instrument);
      if (cached) return { ok: true, data: cached };
      try {
        const definition = instrumentDefinition(instrument);
        const snapshot = await loadEffectiveSnapshot(paths, definition);
        let auditAvailable = false;
        let anomalies: Anomaly[] = [];
        try {
          const instrumentDirectory = resolveInstrumentDataDirectories(paths, definition).builtin;
          const auditPaths = [join(instrumentDirectory, 'cross_source_audit.json')];
          if (definition.id === 'main_continuous') {
            auditPaths.push(...sharedPaths('cross_source_audit.json'));
          }
          anomalies = parseAudit((await readFirst([...new Set(auditPaths)])).text);
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
        cache.set(instrument, data);
        return { ok: true, data };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '行情数据加载失败，请重试' }; }
    },
    invalidate(instrument: Instrument = 'main_continuous') {
      cache.delete(instrument);
    },
    loadSnapshot(instrument: Instrument) {
      if (!isInstrument(instrument)) {
        return Promise.reject(new Error('不支持的行情标的'));
      }
      return loadEffectiveSnapshot(paths, instrumentDefinition(instrument));
    },
    paths,
  };
}

export { resolveMarketDataPaths };
