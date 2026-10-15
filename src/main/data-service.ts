import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Instrument, LoadResult, Dataset, Anomaly } from '../shared/types';
import { parseAudit } from '../domain/data';
import {
  loadEffectiveSnapshot,
  resolveMarketDataPaths,
  type MarketDataPaths,
} from './market-snapshot';

export function resolveDataDirectory(exe: string, packaged: boolean, root: string): string {
  return packaged ? join(dirname(exe), 'data') : join(root, 'futures_investigation_20261009');
}

const instruments = {
  main_continuous: { name: '豆粕主连', symbol: 'KQ.m@DCE.m' },
} as const;

export function createDataService(directory: string, marketDataDirectory?: string) {
  const paths: MarketDataPaths = {
    builtinDataDirectory: directory,
    marketDataDirectory: marketDataDirectory ?? join(directory, '.market-data'),
  };
  const cache = new Map<Instrument, Dataset>();
  async function readBuiltin(name: string): Promise<string> {
    const path = join(paths.builtinDataDirectory, name);
    try { return await readFile(path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`${name}：${code === 'ENOENT' ? '文件不存在，请恢复 data 目录后重试' : '文件无法读取'}。\n位置：${path}`);
    }
  }
  return {
    async readEntryRules() {
      const path = join(paths.builtinDataDirectory, 'entry-rules.md');
      try {
        const info = await stat(path);
        if (info.size > 128 * 1024) return { ok: false, text: '', path, fallback: true, error: '规则文件超过128KB' };
        return { ok: true, text: await readFile(path, 'utf8'), path, modifiedAt: info.mtime.toISOString(), fallback: false };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, text: '', path, fallback: true, error: code === 'ENOENT' ? '规则文件不存在' : '规则文件无法读取' };
      }
    },
    async load(instrument: Instrument, reload = false): Promise<LoadResult> {
      if (!Object.hasOwn(instruments, instrument)) return { ok: false, error: '不支持的行情标的' };
      if (reload) cache.delete(instrument);
      const cached = cache.get(instrument);
      if (cached) return { ok: true, data: cached };
      try {
        const snapshot = await loadEffectiveSnapshot(paths);
        let auditAvailable = false;
        let anomalies: Anomaly[] = [];
        try {
          anomalies = parseAudit(await readBuiltin('cross_source_audit.json'));
          auditAvailable = true;
        } catch { /* Optional audit metadata cannot prevent viewing valid prices. */ }
        const data: Dataset = {
          instrument,
          ...instruments[instrument],
          bars5: snapshot.bars5,
          bars60: snapshot.bars60,
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
    loadSnapshot() {
      return loadEffectiveSnapshot(paths);
    },
    paths,
  };
}

export { resolveMarketDataPaths };
