import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateMinutes,
  serializeBars,
  serializeMinuteRecords,
} from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import { createDataService, resolveDataDirectory } from '../src/main/data-service';
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

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
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
});
