import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ContractHistorySourceDescription,
  DesktopFuturesHistoryFile,
  DesktopFuturesHistorySource,
  DesktopFuturesMinuteRecord,
} from '../src/domain/contract-history-import';
import {
  loadAuditableDesktopGlassContractFallback,
  normalizeThsGlassContractFiveMinuteSeries,
} from '../src/domain/ths-contract-history';
import { parseBeijing } from '../src/domain/time';

const FIXTURE_PATH = 'tests/fixtures/ths/fg309-page-2023.json';
const LICENSE: ContractHistorySourceDescription['license'] = {
  redistributionAllowed: false,
  conclusion: '测试夹具仅用于本机审计。',
};

function thsFixture() {
  const rawText = readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = JSON.parse(rawText);
  return {
    rawText,
    rawSha256: createHash('sha256').update(rawText).digest('hex'),
    values: parsed.data.quote_data[0].value as unknown[][],
  };
}

function desktopMinute(
  timestamp: string,
  line: number,
  overrides: Partial<DesktopFuturesMinuteRecord> = {},
): DesktopFuturesMinuteRecord {
  return {
    instrumentId: 'glass_main',
    sourceExchange: 'CZCE',
    sourceSymbol: 'FG309',
    kind: 'contract',
    timestamp,
    open: 100 + line,
    high: 102 + line,
    low: 99 + line,
    close: 101 + line,
    amount: 1_000 + line,
    volume: 10 + line,
    openInterest: 200 + line,
    provenance: {
      sourceId: 'desktop-glass-fixture',
      relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG309.csv',
      line,
    },
    ...overrides,
  };
}

function desktopRecords(): DesktopFuturesMinuteRecord[] {
  return Array.from({ length: 5 }, (_, index) => desktopMinute(
    `2023-08-09 09:0${index}:00`,
    index + 2,
  ));
}

interface DesktopSourceFixtureOptions {
  contract?: string;
  records?: DesktopFuturesMinuteRecord[];
  description?: Partial<ContractHistorySourceDescription>;
  inspectedFile?: Partial<DesktopFuturesHistoryFile>;
  pageFile?: Partial<DesktopFuturesHistoryFile>;
  emptyPageCursor?: string;
}

function desktopSourceFixture(
  options: DesktopSourceFixtureOptions = {},
): DesktopFuturesHistorySource {
  const contract = options.contract ?? 'FG309';
  const records = options.records ?? desktopRecords();
  const file: DesktopFuturesHistoryFile = {
    relativePath: `CZCE_郑州商品交易所/FG_玻璃/${contract}.csv`,
    sha256: 'a'.repeat(64),
    bytes: 1_024,
    rows: records.length,
    firstTimestamp: records[0]?.timestamp ?? null,
    lastTimestamp: records.at(-1)?.timestamp ?? null,
    format: 'desktop-contract-v1',
    storage: 'csv',
    ...options.inspectedFile,
  };
  const pageFile = {
    ...file,
    ...options.pageFile,
  };
  const description: ContractHistorySourceDescription = {
    sourceId: 'desktop-glass-fixture',
    sourceName: '桌面玻璃具体合约夹具',
    sourceVersion: 'fixture-v1',
    license: LICENSE,
    ...options.description,
  };
  return {
    description,
    async listContracts() {
      return [contract];
    },
    async inspectMainFile() {
      throw new Error('unused');
    },
    async inspectContractFile() {
      return file;
    },
    async readMainPage() {
      throw new Error('unused');
    },
    async readContractPage(request) {
      if (options.emptyPageCursor !== undefined) {
        return {
          records: [],
          sourceFile: pageFile,
          nextCursor: options.emptyPageCursor,
        };
      }
      const offset = Number(request.cursor ?? '0');
      const size = request.pageSize ?? records.length;
      const pageRecords = records.slice(offset, offset + size);
      const nextOffset = offset + pageRecords.length;
      return {
        records: pageRecords,
        sourceFile: pageFile,
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

describe('THS glass contract history normalization', () => {
  it('preserves raw and normalized CZCE codes, trading dates, fields and page evidence', () => {
    const fixture = thsFixture();
    const result = normalizeThsGlassContractFiveMinuteSeries(
      'FG309',
      [{
        pageNumber: 1,
        values: fixture.values,
        rawSha256: fixture.rawSha256,
      }],
      ['2023-08-09'],
      parseBeijing('2023-08-09 09:10:00'),
    );

    expect(result).toMatchObject({
      instrumentId: 'glass_main',
      rawContract: 'FG309',
      normalizedContract: 'FG2309',
      source: {
        kind: 'ths-contract',
        sourceId: 'ths-glass-contract',
        license: {
          redistributionAllowed: false,
        },
        rawPages: [{
          pageNumber: 1,
          rawSha256: fixture.rawSha256,
          rows: 2,
        }],
      },
    });
    expect(result.records).toEqual([
      expect.objectContaining({
        tradingDate: '2023-08-09',
        contract: 'FG2309',
        rawContract: 'FG309',
        normalizedContract: 'FG2309',
        timestamp: '2023-08-09 09:00:00',
        endTimestamp: '2023-08-09 09:05:00',
        startMs: parseBeijing('2023-08-09 09:00:00'),
        endMs: parseBeijing('2023-08-09 09:05:00'),
        open: 1662,
        high: 1665,
        low: 1660,
        close: 1664,
        amount: 3_992_400,
        volume: 120,
        openInterest: null,
        sourceEvidence: {
          kind: 'ths-contract',
          pageNumber: 1,
          sourceRow: 1,
          rawSha256: fixture.rawSha256,
        },
      }),
      expect.objectContaining({
        timestamp: '2023-08-09 09:05:00',
        endTimestamp: '2023-08-09 09:10:00',
        sourceEvidence: {
          kind: 'ths-contract',
          pageNumber: 1,
          sourceRow: 2,
          rawSha256: fixture.rawSha256,
        },
      }),
    ]);
  });

  it('assigns a night-session bar to the next explicit trading date before expanding FG309', () => {
    const closeTimeMs = parseBeijing('2023-08-08 21:05:00');
    const result = normalizeThsGlassContractFiveMinuteSeries(
      'FG309',
      [{
        pageNumber: 1,
        rawSha256: 'b'.repeat(64),
        values: [[closeTimeMs, 1_660, 1_665, 1_658, 1_662, 10, 332_400]],
      }],
      ['2023-08-09'],
      closeTimeMs,
    );

    expect(result.records[0]).toMatchObject({
      tradingDate: '2023-08-09',
      contract: 'FG2309',
      timestamp: '2023-08-08 21:00:00',
      endTimestamp: '2023-08-08 21:05:00',
    });
  });

  it.each(['SA309', 'FG300', 'FG9999', 'fg309'])(
    'rejects an invalid glass source contract %s before normalization',
    rawContract => {
      const fixture = thsFixture();
      expect(() => normalizeThsGlassContractFiveMinuteSeries(
        rawContract,
        [{
          pageNumber: 1,
          values: fixture.values,
          rawSha256: fixture.rawSha256,
        }],
        ['2023-08-09'],
        parseBeijing('2023-08-09 09:10:00'),
      )).toThrow(/合约|到期月份/);
    },
  );
});

describe('auditable desktop glass contract fallback', () => {
  it('aggregates legal minute buckets and preserves source file evidence', async () => {
    const result = await loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture(),
      'FG309',
      ['2023-08-09'],
    );

    expect(result).toMatchObject({
      instrumentId: 'glass_main',
      rawContract: 'FG309',
      normalizedContract: 'FG2309',
      source: {
        kind: 'project-auditable-fallback',
        sourceId: 'desktop-glass-fixture',
        sourceVersion: 'fixture-v1',
        sourceFile: {
          relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG309.csv',
          sha256: 'a'.repeat(64),
          rows: 5,
          format: 'desktop-contract-v1',
        },
      },
    });
    expect(result.records).toEqual([
      expect.objectContaining({
        tradingDate: '2023-08-09',
        contract: 'FG2309',
        rawContract: 'FG309',
        normalizedContract: 'FG2309',
        timestamp: '2023-08-09 09:00:00',
        endTimestamp: '2023-08-09 09:05:00',
        open: 102,
        high: 108,
        low: 101,
        close: 107,
        amount: 5_020,
        volume: 70,
        openInterest: 206,
        sourceEvidence: {
          kind: 'project-auditable-fallback',
          relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG309.csv',
          firstLine: 2,
          lastLine: 6,
          sourceMinuteRows: 5,
          fileSha256: 'a'.repeat(64),
        },
      }),
    ]);
  });

  it('uses a four-digit desktop contract code while preserving its audit evidence', async () => {
    const records = desktopRecords().map(record => ({
      ...record,
      sourceSymbol: 'FG2309',
      provenance: {
        ...record.provenance,
        relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG2309.csv',
      },
    }));
    const result = await loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({ contract: 'FG2309', records }),
      'FG2309',
      ['2023-08-09'],
    );

    expect(result).toMatchObject({
      rawContract: 'FG2309',
      normalizedContract: 'FG2309',
      source: {
        kind: 'project-auditable-fallback',
        sourceFile: {
          relativePath: 'CZCE_郑州商品交易所/FG_玻璃/FG2309.csv',
        },
      },
    });
    expect(result.records[0]).toMatchObject({
      rawContract: 'FG2309',
      normalizedContract: 'FG2309',
      contract: 'FG2309',
    });
  });

  it('validates the full source file but normalizes only records inside the protected range', async () => {
    const records = [
      desktopMinute('2022-01-04 09:00:00', 2),
      ...desktopRecords().map((record, index) => ({
        ...record,
        provenance: {
          ...record.provenance,
          line: index + 3,
        },
      })),
    ];
    const result = await loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({ records }),
      'FG309',
      ['2023-08-09'],
      {
        firstStartMs: parseBeijing('2023-08-09 09:00:00'),
        lastEndMs: parseBeijing('2023-08-09 09:05:00'),
      },
    );

    expect(result.source).toMatchObject({
      kind: 'project-auditable-fallback',
      sourceFile: {
        rows: 6,
        firstTimestamp: '2022-01-04 09:00:00',
        lastTimestamp: '2023-08-09 09:04:00',
      },
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      tradingDate: '2023-08-09',
      timestamp: '2023-08-09 09:00:00',
      sourceEvidence: {
        firstLine: 3,
        lastLine: 7,
        sourceMinuteRows: 5,
      },
    });
  });

  it('rejects missing source version and acquisition metadata', async () => {
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({
        description: {
          sourceVersion: undefined,
          acquiredAt: undefined,
        },
      }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/版本或取得时间/);
  });

  it('rejects source file changes during paging', async () => {
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({
        pageFile: { sha256: 'b'.repeat(64) },
      }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/元数据发生变化/);
  });

  it('rejects records for a contract different from the request', async () => {
    const records = desktopRecords();
    records[2] = {
      ...records[2],
      sourceSymbol: 'FG401',
    };
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({ records }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/记录与请求不一致/);
  });

  it('rejects duplicate or descending source timestamps before aggregation', async () => {
    const records = desktopRecords();
    [records[1], records[2]] = [records[2], records[1]];
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({ records }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/重复或倒序/);
  });

  it('rejects metadata row counts that do not match the paged records', async () => {
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({
        inspectedFile: { rows: 6 },
        pageFile: { rows: 6 },
      }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/行数与分页读取数量不一致/);
  });

  it('rejects an empty page that still returns a continuation cursor', async () => {
    await expect(loadAuditableDesktopGlassContractFallback(
      desktopSourceFixture({ emptyPageCursor: '1' }),
      'FG309',
      ['2023-08-09'],
    )).rejects.toThrow(/空分页不得继续/);
  });
});
