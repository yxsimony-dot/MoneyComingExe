import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContractHistorySourceDescription,
  DesktopFuturesHistoryFile,
  DesktopFuturesHistorySource,
  DesktopFuturesMinuteRecord,
} from '../src/domain/contract-history-import';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import {
  runGlassMainRepair,
  type GlassMainRepairClient,
} from '../src/main/glass-main-repair-cli';
import {
  resolveInstrumentDataDirectories,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  type LoadedMarketSnapshot,
  type SnapshotCandidate,
} from '../src/main/market-snapshot';
import {
  THS_GLASS_MAIN_REQUEST,
  THS_KLINE_FIELDS,
  type ThsGlassContractHistory,
  type ThsGlassMainHistory,
  type ThsKlineRequest,
  type ThsRawKlinePage,
} from '../src/main/ths-main-client';
import { INSTRUMENT_DEFINITIONS } from '../src/shared/instruments';
import type {
  Bar,
  EdbMinuteRecord,
  MainContractMapping,
} from '../src/shared/types';

const GLASS = INSTRUMENT_DEFINITIONS.glass_main;
const NOW = new Date('2026-10-23T04:00:00.000Z');
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

function minuteRecords(
  tradingDate: string,
  priceBase: number,
): EdbMinuteRecord[] {
  const startMs = parseBeijing(`${tradingDate} 09:00:00`);
  return Array.from({ length: 60 }, (_, index) => {
    const minuteStartMs = startMs + index * 60_000;
    const open = priceBase + index;
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
}

function localFixture(): {
  snapshot: LoadedMarketSnapshot;
  candidate: SnapshotCandidate;
  mappings: MainContractMapping[];
} {
  const bars1 = [
    ...minuteRecords('2023-08-08', 1_500),
    ...minuteRecords('2023-08-10', 1_700),
  ];
  const coverageEndMs = bars1.at(-1)!.startMs + 60_000;
  const bars5 = aggregateMinutes(
    bars1,
    5,
    coverageEndMs,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  const mappings = [
    { tradingDate: '2023-08-08', contract: 'FG2309' },
    { tradingDate: '2023-08-10', contract: 'FG2401' },
  ];
  const rollovers = [{
    tradingDate: '2023-08-10',
    time: '2023-08-10 09:00:00',
    timeMs: parseBeijing('2023-08-10 09:00:00'),
    fromContract: 'FG2309',
    toContract: 'FG2401',
  }];
  const requestStart = bars5[0].start;
  const requestEnd = bars5.at(-1)!.end;
  return {
    mappings,
    snapshot: {
      source: 'user',
      directory: 'synthetic-glass-main',
      bars1,
      bars5,
      bars60,
      mainContractMappings: mappings,
      rollovers,
      sourceLatestAt: requestEnd,
      snapshotUpdatedAt: NOW.toISOString(),
    },
    candidate: {
      bars1,
      bars5,
      bars60,
      mainContractMappings: mappings,
      rollovers,
      requestStart,
      requestEnd,
      sourceLatestAt: requestEnd,
    },
  };
}

function thsRows(bars: readonly Bar[]): unknown[][] {
  return bars.map(bar => [
    bar.endMs,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.volume * bar.close * GLASS.contractMultiplier,
  ]);
}

function rawPage<Code extends string>(
  code: Code,
  values: unknown[][],
): ThsRawKlinePage<Code> {
  const request = {
    ...THS_GLASS_MAIN_REQUEST,
    code_list: [{
      codes: [code],
      market: '67',
    }],
  } as ThsKlineRequest<Code>;
  const rawText = `${JSON.stringify({
    status_code: 0,
    data: {
      quote_data: [{
        market: '67',
        code,
        delay: false,
        data_fields: THS_KLINE_FIELDS,
        value: values,
      }],
    },
  })}\n`;
  const closeTimes = values.map(row => row[0] as number);
  return {
    pageNumber: 1,
    request,
    rawText,
    rawSha256: createHash('sha256').update(rawText).digest('hex'),
    quote: {
      market: '67',
      code,
      delay: false,
      dataFields: THS_KLINE_FIELDS,
      values,
    },
    firstCloseTimeMs: closeTimes.length ? Math.min(...closeTimes) : undefined,
    lastCloseTimeMs: closeTimes.length ? Math.max(...closeTimes) : undefined,
  };
}

function pageHistory<Code extends string>(
  page: ThsRawKlinePage<Code>,
): {
  pages: ThsRawKlinePage<Code>[];
  termination: 'target-reached';
  firstCloseTimeMs?: number;
  lastCloseTimeMs?: number;
} {
  return {
    pages: [page],
    termination: 'target-reached',
    firstCloseTimeMs: page.firstCloseTimeMs,
    lastCloseTimeMs: page.lastCloseTimeMs,
  };
}

function repairClient(
  snapshot: LoadedMarketSnapshot,
  emptyContracts: readonly string[] = [],
): GlassMainRepairClient {
  const empty = new Set(emptyContracts);
  const mainPage = rawPage('FG9999', thsRows(snapshot.bars5));
  const rowsByContract = new Map<string, unknown[][]>([
    ['FG2309', thsRows(snapshot.bars5.filter(
      bar => bar.start.startsWith('2023-08-08'),
    ))],
    ['FG2401', thsRows(snapshot.bars5.filter(
      bar => bar.start.startsWith('2023-08-10'),
    ))],
  ]);
  return {
    fetchGlassMainHistory: vi.fn(async (): Promise<ThsGlassMainHistory> => (
      pageHistory(mainPage)
    )),
    fetchGlassContractHistory: vi.fn(
      async (sourceContract: string): Promise<ThsGlassContractHistory> => ({
        ...pageHistory(rawPage(
          sourceContract,
          empty.has(sourceContract)
            ? []
            : rowsByContract.get(sourceContract) ?? [],
        )),
        sourceContract,
      }),
    ),
  };
}

function desktopFallbackFixture(
  snapshot: LoadedMarketSnapshot,
  inspectedContracts: string[],
): DesktopFuturesHistorySource {
  const sourceId = 'desktop-glass-repair-fixture';
  const contract = 'FG2309';
  const records: DesktopFuturesMinuteRecord[] = snapshot.bars5
    .filter(bar => bar.start.startsWith('2023-08-08'))
    .map((bar, index) => ({
      instrumentId: 'glass_main',
      sourceExchange: 'CZCE',
      sourceSymbol: contract,
      kind: 'contract',
      timestamp: bar.start,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      amount: bar.volume * bar.close * GLASS.contractMultiplier,
      volume: bar.volume,
      openInterest: bar.closeOi,
      provenance: {
        sourceId,
        relativePath: `CZCE_郑州商品交易所/FG_玻璃/${contract}.csv`,
        line: index + 2,
      },
    }));
  const description: ContractHistorySourceDescription = {
    sourceId,
    sourceName: '桌面玻璃修复夹具',
    sourceVersion: 'desktop-fixture-v1',
    acquiredAt: '2026-10-22',
    license: {
      redistributionAllowed: false,
      conclusion: '测试夹具仅用于本机审计。',
    },
  };
  const sourceFile: DesktopFuturesHistoryFile = {
    relativePath: `CZCE_郑州商品交易所/FG_玻璃/${contract}.csv`,
    sha256: 'd'.repeat(64),
    bytes: 4_096,
    rows: records.length,
    firstTimestamp: records[0].timestamp,
    lastTimestamp: records.at(-1)!.timestamp,
    format: 'desktop-contract-v1',
    storage: 'csv',
  };
  const location = (requestedContract: string) => {
    inspectedContracts.push(requestedContract);
    if (requestedContract !== contract) {
      throw new Error(`fixture missing ${requestedContract}`);
    }
  };
  return {
    description,
    async listContracts() {
      return [contract];
    },
    async inspectMainFile() {
      throw new Error('unused');
    },
    async inspectContractFile(request) {
      location(request.contract ?? '');
      return sourceFile;
    },
    async readMainPage() {
      throw new Error('unused');
    },
    async readContractPage(request) {
      if (request.contract !== contract) {
        throw new Error(`fixture missing ${request.contract}`);
      }
      const offset = Number(request.cursor ?? '0');
      const size = request.pageSize ?? records.length;
      const pageRecords = records.slice(offset, offset + size);
      const nextOffset = offset + pageRecords.length;
      return {
        records: pageRecords,
        sourceFile,
        nextCursor: nextOffset < records.length
          ? String(nextOffset)
          : undefined,
      };
    },
    async scanMainRecords() {
      throw new Error('unused');
    },
    async scanContractRecords() {
      throw new Error('unused');
    },
  };
}

async function temporaryRoots(prefix: string): Promise<{
  root: string;
  appRoot: string;
  appDataRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temps.push(root);
  const appRoot = join(root, 'app');
  const appDataRoot = join(root, 'AppData', 'MoneyComing');
  await Promise.all([
    mkdir(appRoot, { recursive: true }),
    mkdir(appDataRoot, { recursive: true }),
  ]);
  return { root, appRoot, appDataRoot };
}

describe('glass_main THS repair CLI', () => {
  it('defaults to compare-only and writes a complete audit run', async () => {
    const { appRoot, appDataRoot } = await temporaryRoots(
      'glass-main-repair-compare-',
    );
    const fixture = localFixture();
    const saveSnapshot = vi.fn();

    const result = await runGlassMainRepair(
      ['--app-root', appRoot, '--app-data-root', appDataRoot],
      {
        client: repairClient(fixture.snapshot),
        contractFallbackSource: null,
        loadSnapshot: async () => fixture.snapshot,
        saveSnapshot,
        now: () => new Date(NOW),
        runIdFactory: () => 'compare-only-run',
      },
    );

    expect(result).toMatchObject({
      mode: 'compare-only',
      runId: 'compare-only-run',
      activationAllowed: true,
      activated: false,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
    await expect(readFile(join(result.runDirectory, 'request.json'), 'utf8'))
      .resolves.toContain('"FG9999"');
    await expect(readFile(
      join(result.runDirectory, 'normalized', 'ths_fg9999_5m.csv'),
      'utf8',
    )).resolves.toContain('2023-08-08 09:00:00');
    await expect(readFile(
      join(result.runDirectory, 'reports', 'field-diff.json'),
      'utf8',
    )).resolves.toContain('"oneToOne": true');
    await expect(readFile(
      join(result.runDirectory, 'reports', 'minute-reconciliation.json'),
      'utf8',
    )).resolves.toContain('"protectedBarRows": 24');
    await expect(readFile(
      join(result.runDirectory, 'reports', 'contract-matching.json'),
      'utf8',
    )).resolves.toContain('"allowed": true');
    await expect(readFile(
      join(result.runDirectory, 'reports', 'report-manifest.json'),
      'utf8',
    )).resolves.toContain('"hashAlgorithm": "sha256"');
    await expect(readFile(
      join(result.runDirectory, 'reports', 'activation.json'),
      'utf8',
    )).resolves.toContain('"status": "not-activated"');
    const rawFiles = await readdir(join(result.runDirectory, 'raw', 'pages'));
    expect(rawFiles.sort()).toEqual([
      'fg2308-page-0001.json',
      'fg2309-page-0001.json',
      'fg2310-page-0001.json',
      'fg2312-page-0001.json',
      'fg2401-page-0001.json',
      'fg2402-page-0001.json',
      'fg9999-page-0001.json',
    ]);
  });

  it('falls back from empty THS FG2309 history to the desktop FG2309 archive', async () => {
    const { appRoot, appDataRoot } = await temporaryRoots(
      'glass-main-repair-fallback-',
    );
    const fixture = localFixture();
    const client = repairClient(fixture.snapshot, ['FG2309']);
    const inspectedContracts: string[] = [];

    const result = await runGlassMainRepair(
      ['--app-root', appRoot, '--app-data-root', appDataRoot],
      {
        client,
        contractFallbackSource: desktopFallbackFixture(
          fixture.snapshot,
          inspectedContracts,
        ),
        loadSnapshot: async () => fixture.snapshot,
        saveSnapshot: vi.fn(),
        now: () => new Date(NOW),
        runIdFactory: () => 'desktop-fallback-run',
      },
    );

    expect(result.activationAllowed).toBe(true);
    expect(client.fetchGlassContractHistory).toHaveBeenCalledWith(
      'FG2309',
      expect.objectContaining({
        minimumCloseTimeMs: expect.any(Number),
      }),
    );
    expect(inspectedContracts).toContain('FG2309');

    const matching = JSON.parse(await readFile(
      join(result.runDirectory, 'reports', 'contract-matching.json'),
      'utf8',
    ));
    expect(matching.matching.mappings).toContainEqual({
      tradingDate: '2023-08-08',
      contract: 'FG2309',
    });
    expect(matching.matching.summary.dailyRelativeEvidenceMatches).toBe(0);
    expect(matching.matching.summary.heuristicFallbackMatches).toBe(0);
    expect(matching.candidateSources).toContainEqual(expect.objectContaining({
      rawContract: 'FG2309',
      normalizedContract: 'FG2309',
      source: expect.objectContaining({
        kind: 'project-auditable-fallback',
        sourceVersion: 'desktop-fixture-v1',
        acquiredAt: '2026-10-22',
        sourceFile: expect.objectContaining({
          relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG2309.csv',
          sha256: 'd'.repeat(64),
        }),
      }),
    }));
    expect(matching.fetches).toContainEqual(expect.objectContaining({
      rawContract: 'FG2309',
      thsContract: 'FG2309',
      desktopContract: 'FG2309',
      normalizedContract: 'FG2309',
      selectedSource: 'project-auditable-fallback',
      fallback: expect.objectContaining({
        status: 'loaded',
        requestedContract: 'FG2309',
      }),
    }));
  });

  it('keeps the current pointer byte-for-byte when activation fails', async () => {
    const { appRoot, appDataRoot } = await temporaryRoots(
      'glass-main-repair-activate-',
    );
    const fixture = localFixture();
    const paths = resolveMarketDataPaths(
      process.execPath,
      false,
      appRoot,
      appDataRoot,
    );
    const current = await saveMarketSnapshot(
      paths,
      GLASS,
      fixture.candidate,
      {
        idFactory: () => 'existing-v5',
        now: () => new Date('2026-10-23T03:00:00.000Z'),
      },
    );
    const pointerPath = join(
      resolveInstrumentDataDirectories(paths, GLASS).user,
      'current.json',
    );
    const pointerBefore = await readFile(pointerPath);

    await expect(runGlassMainRepair(
      [
        '--activate',
        '--app-root',
        appRoot,
        '--app-data-root',
        appDataRoot,
      ],
      {
        client: repairClient(fixture.snapshot),
        contractFallbackSource: null,
        loadSnapshot: async () => current,
        now: () => new Date(NOW),
        runIdFactory: () => 'failed-activation-run',
        saveOptions: {
          idFactory: () => 'repair-candidate',
          beforePointerSwitch: () => {
            throw new Error('simulated activation failure');
          },
        },
      },
    )).rejects.toThrow(/simulated activation failure/);

    expect(await readFile(pointerPath)).toEqual(pointerBefore);
    const runDirectory = join(
      paths.marketDataDirectory,
      'repairs',
      GLASS.id,
      'failed-activation-run',
    );
    const activation = JSON.parse(await readFile(
      join(runDirectory, 'reports', 'activation.json'),
      'utf8',
    ));
    expect(activation).toMatchObject({
      mode: 'activate',
      status: 'failed',
      activationAllowed: false,
      error: {
        message: 'simulated activation failure',
      },
    });
    await expect(readFile(
      join(runDirectory, 'reports', 'report-manifest.json'),
      'utf8',
    )).resolves.toContain('"hashAlgorithm": "sha256"');
  }, 60_000);

  it('binds a successful activation report to the saved v7 root snapshot', async () => {
    const { appRoot, appDataRoot } = await temporaryRoots(
      'glass-main-repair-success-',
    );
    const fixture = localFixture();
    const paths = resolveMarketDataPaths(
      process.execPath,
      false,
      appRoot,
      appDataRoot,
    );
    const current = await saveMarketSnapshot(
      paths,
      GLASS,
      fixture.candidate,
      {
        idFactory: () => 'successful-existing-v5',
        now: () => new Date('2026-10-23T03:00:00.000Z'),
      },
    );

    const result = await runGlassMainRepair(
      [
        '--activate',
        '--app-root',
        appRoot,
        '--app-data-root',
        appDataRoot,
      ],
      {
        client: repairClient(fixture.snapshot),
        contractFallbackSource: null,
        loadSnapshot: async () => current,
        now: () => new Date(NOW),
        runIdFactory: () => 'successful-activation-run',
        saveOptions: {
          idFactory: () => 'successful-v7-root',
        },
      },
    );

    expect(result).toMatchObject({
      mode: 'activate',
      runId: 'successful-activation-run',
      activationAllowed: true,
      activated: true,
      snapshotId: 'successful-v7-root',
    });
    const activation = JSON.parse(await readFile(
      join(result.runDirectory, 'reports', 'activation.json'),
      'utf8',
    ));
    expect(Object.keys(activation).sort()).toEqual([
      'activatedAt',
      'activationAllowed',
      'metadataSha256',
      'mode',
      'reportRunId',
      'reportSha256',
      'schemaVersion',
      'snapshotId',
      'status',
    ].sort());
    expect(activation).toMatchObject({
      schemaVersion: 1,
      mode: 'activate',
      status: 'activated',
      activationAllowed: true,
      reportRunId: 'successful-activation-run',
      reportSha256: result.reportSha256,
      snapshotId: 'successful-v7-root',
      activatedAt: NOW.toISOString(),
    });
    expect(activation).not.toHaveProperty('snapshotDirectory');

    const snapshotDirectory = join(
      resolveInstrumentDataDirectories(paths, GLASS).user,
      'snapshots',
      'successful-v7-root',
    );
    const metadataText = await readFile(
      join(snapshotDirectory, 'metadata.json'),
      'utf8',
    );
    const metadata = JSON.parse(metadataText);
    expect(metadata).toMatchObject({
      schemaVersion: 7,
      storage: { kind: 'full' },
      benchmarkProtection: {
        reportRunId: 'successful-activation-run',
        reportSha256: result.reportSha256,
      },
    });
    expect(activation.metadataSha256)
      .toBe(createHash('sha256').update(metadataText).digest('hex'));
    expect(JSON.parse(await readFile(
      join(snapshotDirectory, 'activated.json'),
      'utf8',
    ))).toEqual({
      snapshotId: 'successful-v7-root',
      metadataSha256: activation.metadataSha256,
      activatedAt: NOW.toISOString(),
    });
  }, 60_000);

  it('rejects unknown arguments before loading data or calling THS', async () => {
    const loadSnapshot = vi.fn();
    const client: GlassMainRepairClient = {
      fetchGlassMainHistory: vi.fn(),
      fetchGlassContractHistory: vi.fn(),
    };

    await expect(runGlassMainRepair(
      ['--unknown'],
      { client, loadSnapshot },
    )).rejects.toThrow(/不支持的 glass_main 修复参数/);

    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(client.fetchGlassMainHistory).not.toHaveBeenCalled();
    expect(client.fetchGlassContractHistory).not.toHaveBeenCalled();
  });
});
