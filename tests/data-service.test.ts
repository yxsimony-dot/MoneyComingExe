import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDataService, resolveDataDirectory } from '../src/main/data-service';

const source = resolve('futures_investigation_20261009');
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('portable data service', () => {
  it('uses the executable location rather than cwd', () => {
    expect(resolveDataDirectory('C:\\中文 空格\\MoneyComing\\MoneyComing.exe', true, 'D:\\development')).toBe('C:\\中文 空格\\MoneyComing\\data');
    expect(resolveDataDirectory('irrelevant', false, process.cwd())).toBe(source);
  });
  it('loads background minutes and both visible periods without altering source files', async () => {
    const file=join(source,'edb_main_continuous_5m.csv');
    const before=createHash('sha256').update(await readFile(file)).digest('hex');
    const service=createDataService(source);
    const result=await service.load('main_continuous');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bars1).toHaveLength(82_650);
      expect([result.data.bars5.length,result.data.bars60.length]).toEqual([16530,1438]);
      expect(result.data.rollovers.map(({ fromContract, toContract }) => `${fromContract}->${toContract}`))
        .toEqual(['m2601->m2605', 'm2605->m2609', 'm2609->m2701']);
      expect(result.data.bars5.at(-1)?.end).toBe('2026-10-09 15:00:00');
      expect(result.data.anomalies).toEqual([]);
      expect(result.data.auditAvailable).toBe(true);
      expect(result.data.snapshotSource).toBe('builtin');
      expect(result.data.sourceLatestAt).toBe('2026-10-09 15:00:00');
    }
    expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(before);
  });
  it('rejects arbitrary file/path instrument inputs', async () => {
    const result=await createDataService(source).load('../secrets' as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/标的/);
  });
  it('reports a missing data directory with an actionable path', async () => {
    const result=await createDataService(join(source,'missing')).load('main_continuous');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/edb_main_continuous_(?:1m_raw|5m|60m)\.csv/);
      expect(result.error).toContain(join(source, 'missing'));
      expect(result.error).toContain('文件不存在');
    }
  });
  it('invalidates cached data on reload and recovers after files are restored', async () => {
    const dir=await mkdtemp(join(tmpdir(),'moneycoming-service-')); temps.push(dir);
    for (const n of ['edb_main_continuous_1m_raw.csv','edb_main_continuous_5m.csv','edb_main_continuous_60m.csv','edb_main_continuous_rollovers.csv']) await cp(join(source,n),join(dir,n));
    const service=createDataService(dir); const first=await service.load('main_continuous'); expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.auditAvailable).toBe(false);
    const file=join(dir,'edb_main_continuous_5m.csv'); await writeFile(file,'bad data');
    const failed=await service.load('main_continuous',true); expect(failed.ok).toBe(false);
    await cp(join(source,'edb_main_continuous_5m.csv'),file);
    expect((await service.load('main_continuous',true)).ok).toBe(true);
    await unlink(file);
    expect((await service.load('main_continuous',true)).ok).toBe(false);
  });
  it('reloads editable entry rules and rejects missing or oversized files', async () => {
    const dir=await mkdtemp(join(tmpdir(),'moneycoming-rules-')); temps.push(dir);
    const file=join(dir,'entry-rules.md');
    await writeFile(file,'# 规则\n<script>不执行</script>');
    const service=createDataService(dir);
    const first=await service.readEntryRules();
    expect(first).toMatchObject({ ok:true, fallback:false, path:file, text:'# 规则\n<script>不执行</script>' });
    await writeFile(file,'修改后的规则');
    expect((await service.readEntryRules()).text).toBe('修改后的规则');
    await writeFile(file,'x'.repeat(128 * 1024 + 1));
    expect(await service.readEntryRules()).toMatchObject({ ok:false, fallback:true, error:'规则文件超过128KB' });
    await unlink(file);
    expect(await service.readEntryRules()).toMatchObject({ ok:false, fallback:true, error:'规则文件不存在' });
  });
});
