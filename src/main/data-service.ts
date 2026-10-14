import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Instrument, LoadResult, Dataset, Anomaly } from '../shared/types';
import { parseBars, parseAudit } from '../domain/data';

export function resolveDataDirectory(exe: string, packaged: boolean, root: string): string {
  return packaged ? join(dirname(exe), 'data') : join(root, 'futures_investigation_20261009');
}

const instruments = {
  main_continuous: { name: '豆粕主连', symbol: 'KQ.m@DCE.m' },
  m2701: { name: '豆粕2701', symbol: 'DCE.m2701' },
} as const;

export function createDataService(directory: string) {
  const cache = new Map<Instrument, Dataset>();
  async function read(name: string): Promise<string> {
    const path = join(directory, name);
    try { return await readFile(path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`${name}：${code === 'ENOENT' ? '文件不存在，请恢复 data 目录后重试' : '文件无法读取'}。\n位置：${path}`);
    }
  }
  return {
    async readEntryRules() {
      const path = join(directory, 'entry-rules.md');
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
        const names = [5, 60].map(period => `edb_${instrument}_${period}m.csv`);
        const values = await Promise.all(names.map(async name => parseBars(await read(name), name)));
        let auditAvailable = false;
        let anomalies: Anomaly[] = [];
        try {
          anomalies = parseAudit(await read('cross_source_audit.json'), instrument);
          auditAvailable = true;
        } catch { /* Optional audit metadata cannot prevent viewing valid prices. */ }
        const data: Dataset = {
          instrument, ...instruments[instrument], bars5: values[0], bars60: values[1],
          anomalies, auditAvailable, dataDirectory: directory,
        };
        cache.set(instrument, data);
        return { ok: true, data };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '行情数据加载失败，请重试' }; }
    },
  };
}
