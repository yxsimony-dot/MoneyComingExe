import { describe, expect, it } from 'vitest';
import type {
  ContractFiveMinuteHistorySource,
  ContractFiveMinuteImportRecord,
  ContractHistoryPage,
  ContractHistoryPageRequest,
  ContractHistorySourceDescription,
  ContractHistorySourceFile,
} from '../src/domain/contract-history-import';
import {
  importContractFiveMinuteFile,
  normalizeContractFiveMinuteRecords,
} from '../src/domain/contract-history-normalization';

const LICENSE: ContractHistorySourceDescription['license'] = {
  identifier: 'fixture-redistribution',
  redistributionAllowed: true,
  conclusion: '跨交易所测试夹具允许再分发。',
};

class FixtureSource implements ContractFiveMinuteHistorySource {
  readonly description: ContractHistorySourceDescription;
  readonly file: ContractHistorySourceFile;

  constructor(
    private readonly records: ContractFiveMinuteImportRecord[],
    sourceContract: string,
    sourceDescription: Partial<ContractHistorySourceDescription> = {},
  ) {
    this.description = {
      sourceId: 'cross-exchange-fixture',
      sourceName: '跨交易所合约历史夹具',
      sourceVersion: 'fixture-v1',
      license: LICENSE,
      ...sourceDescription,
    };
    this.file = {
      relativePath: `fixture/${sourceContract}.csv`,
      sha256: 'a'.repeat(64),
      bytes: 1_024,
      rows: records.length,
      firstTimestamp: records[0]?.timestamp ?? null,
      lastTimestamp: records.at(-1)?.timestamp ?? null,
    };
  }

  async listContracts(): Promise<string[]> {
    return [...new Set(this.records.map(record => record.sourceContract))];
  }

  async inspectFile(): Promise<ContractHistorySourceFile> {
    return this.file;
  }

  async readPage(request: ContractHistoryPageRequest): Promise<ContractHistoryPage> {
    const offset = Number(request.cursor ?? '0');
    const size = request.pageSize ?? 5_000;
    const records = this.records.slice(offset, offset + size);
    const nextOffset = offset + records.length;
    return {
      records,
      sourceFile: this.file,
      nextCursor: nextOffset < this.records.length ? String(nextOffset) : undefined,
    };
  }
}

function record(
  overrides: Partial<ContractFiveMinuteImportRecord> = {},
): ContractFiveMinuteImportRecord {
  return {
    instrumentId: 'main_continuous',
    sourceExchange: 'Dalian Commodity Exchange',
    sourceContract: 'M2601',
    timestamp: '2025-10-09 09:00:00',
    open: 3_000,
    high: 3_005,
    low: 2_998,
    close: 3_002,
    volume: 10,
    openInterest: 1_000,
    provenance: {
      sourceId: 'cross-exchange-fixture',
      relativePath: 'fixture/M2601.csv',
      line: 2,
    },
    ...overrides,
  };
}

async function importFixture(
  records: ContractFiveMinuteImportRecord[],
  instrument: ContractHistoryPageRequest['instrument'],
  contract: string,
  tradingDates: readonly string[],
  sourceDescription?: Partial<ContractHistorySourceDescription>,
) {
  return importContractFiveMinuteFile(
    new FixtureSource(records, contract, sourceDescription),
    { instrument, contract },
    {
      tradingDates,
      toolVersion: 'contract-history-import-test-v1',
      pageSize: 2,
    },
  );
}

describe('contract five-minute history import', () => {
  it('sorts and deduplicates DCE records while assigning night sessions by the explicit calendar', async () => {
    const duplicate = record({
      timestamp: '2025-10-09 09:00:00',
      provenance: {
        sourceId: 'cross-exchange-fixture',
        relativePath: 'fixture/M2601.csv',
        line: 5,
      },
    });
    const result = await importFixture([
      record({
        timestamp: '2025-10-10 21:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/M2601.csv',
          line: 2,
        },
      }),
      record({
        timestamp: '2025-10-08 21:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/M2601.csv',
          line: 3,
        },
      }),
      record({
        timestamp: '2025-10-09 09:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/M2601.csv',
          line: 4,
        },
      }),
      duplicate,
    ], 'main_continuous', 'M2601', [
      '2025-09-30',
      '2025-10-09',
      '2025-10-10',
      '2025-10-13',
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.report.rejectionReasons.join('\n'));
    expect(result.records.map(item => [
      item.start,
      item.tradingDate,
      item.session,
    ])).toEqual([
      ['2025-10-08 21:00:00', '2025-10-09', 'night'],
      ['2025-10-09 09:00:00', '2025-10-09', 'day'],
      ['2025-10-10 21:00:00', '2025-10-13', 'night'],
    ]);
    expect(result.records.every(item => (
      item.exchange === 'DCE'
      && item.contract === 'm2601'
      && item.expiryYear === 2026
      && item.expiryMonth === 1
    ))).toBe(true);
    expect(result.report).toMatchObject({
      status: 'succeeded',
      normalizedContract: 'm2601',
      source: {
        sourceName: '跨交易所合约历史夹具',
        sourceVersion: 'fixture-v1',
        license: LICENSE,
      },
      sourceFile: {
        relativePath: 'fixture/M2601.csv',
        sha256: 'a'.repeat(64),
      },
      sourceCoverage: {
        firstTimestamp: '2025-10-08 21:00:00',
        lastTimestamp: '2025-10-10 21:00:00',
      },
      normalizedCoverage: {
        firstTradingDate: '2025-10-09',
        lastTradingDate: '2025-10-13',
      },
      rows: {
        source: 4,
        accepted: 3,
        identicalDuplicatesRemoved: 1,
      },
      toolVersion: 'contract-history-import-test-v1',
      rejectionReasons: [],
    });
  });

  it('infers CZCE three-digit years across decades and emits four-digit internal codes', async () => {
    const threeDigit = await importFixture([
      record({
        instrumentId: 'rapeseed_meal_main',
        sourceExchange: 'ZCE',
        sourceContract: 'RM601',
        timestamp: '2025-12-26 21:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RM601.csv',
          line: 2,
        },
      }),
      record({
        instrumentId: 'rapeseed_meal_main',
        sourceExchange: '郑商所',
        sourceContract: 'RM601',
        timestamp: '2025-12-29 09:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RM601.csv',
          line: 3,
        },
      }),
    ], 'rapeseed_meal_main', 'RM601', [
      '2025-12-26',
      '2025-12-29',
    ]);

    expect(threeDigit.ok).toBe(true);
    if (!threeDigit.ok) throw new Error(threeDigit.report.rejectionReasons.join('\n'));
    expect(threeDigit.records.map(item => [
      item.contract,
      item.expiryYear,
      item.tradingDate,
    ])).toEqual([
      ['RM2601', 2026, '2025-12-29'],
      ['RM2601', 2026, '2025-12-29'],
    ]);

    const legacyThreeDigit = normalizeContractFiveMinuteRecords([
      record({
        instrumentId: 'rapeseed_meal_main',
        sourceExchange: 'CZCE',
        sourceContract: 'RM601',
        timestamp: '2015-12-28 09:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RM601.csv',
          line: 2,
        },
      }),
    ], 'rapeseed_meal_main', ['2015-12-28']);
    expect(legacyThreeDigit.normalizedContract).toBe('RM1601');

    const fourDigit = normalizeContractFiveMinuteRecords([
      record({
        instrumentId: 'rapeseed_meal_main',
        sourceExchange: 'CZCE',
        sourceContract: 'RM1601',
        timestamp: '2016-01-04 09:00:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RM1601.csv',
          line: 2,
        },
      }),
    ], 'rapeseed_meal_main', ['2016-01-04']);
    expect(fourDigit.normalizedContract).toBe('RM1601');
    expect(fourDigit.records[0]).toMatchObject({
      exchange: 'CZCE',
      contract: 'RM1601',
      expiryYear: 2016,
      expiryMonth: 1,
    });
  });

  it('normalizes SHFE contracts and accepts the last complete bar before the morning break', async () => {
    const result = await importFixture([
      record({
        instrumentId: 'rebar_main',
        sourceExchange: 'SHF',
        sourceContract: 'RB2601',
        timestamp: '2025-10-09 10:10:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RB2601.csv',
          line: 2,
        },
      }),
      record({
        instrumentId: 'rebar_main',
        sourceExchange: 'Shanghai Futures Exchange',
        sourceContract: 'RB2601',
        timestamp: '2025-10-09 10:30:00',
        provenance: {
          sourceId: 'cross-exchange-fixture',
          relativePath: 'fixture/RB2601.csv',
          line: 3,
        },
      }),
    ], 'rebar_main', 'RB2601', ['2025-10-09']);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.report.rejectionReasons.join('\n'));
    expect(result.records.map(item => [item.contract, item.start, item.end])).toEqual([
      ['rb2601', '2025-10-09 10:10:00', '2025-10-09 10:15:00'],
      ['rb2601', '2025-10-09 10:30:00', '2025-10-09 10:35:00'],
    ]);
  });

  it.each([
    {
      name: 'conflicting duplicate timestamp',
      records: [
        record(),
        record({
          close: 3_003,
          provenance: {
            sourceId: 'cross-exchange-fixture',
            relativePath: 'fixture/M2601.csv',
            line: 3,
          },
        }),
      ],
      reason: /存在冲突记录/,
    },
    {
      name: 'invalid OHLC envelope',
      records: [record({ open: 3_010 })],
      reason: /OHLC 范围无效/,
    },
    {
      name: 'negative volume',
      records: [record({ volume: -1 })],
      reason: /成交量和持仓量不得为负数/,
    },
    {
      name: 'negative open interest',
      records: [record({ openInterest: -1 })],
      reason: /成交量和持仓量不得为负数/,
    },
    {
      name: 'morning break',
      records: [record({ timestamp: '2025-10-09 10:15:00' })],
      reason: /非交易分钟/,
    },
    {
      name: 'non-five-minute boundary',
      records: [record({ timestamp: '2025-10-09 09:01:00' })],
      reason: /未对齐 5 分钟边界/,
    },
    {
      name: 'weekend day session',
      records: [record({ timestamp: '2025-10-11 09:00:00' })],
      reason: /不在交易日历中/,
    },
  ])('rejects $name with a per-file reason', async ({ records, reason }) => {
    const result = await importFixture(
      records,
      'main_continuous',
      'M2601',
      ['2025-10-09', '2025-10-10', '2025-10-13'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected import rejection');
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe('rejected');
    expect(result.report.rows.accepted).toBe(0);
    expect(result.report.rejectionReasons).toHaveLength(1);
    expect(result.report.rejectionReasons[0]).toMatch(/^fixture\/M2601\.csv(?:：| )/);
    expect(result.report.rejectionReasons[0]).toMatch(reason);
  });

  it('rejects missing audit version/acquisition metadata while retaining the file report', async () => {
    const result = await importFixture(
      [record()],
      'main_continuous',
      'M2601',
      ['2025-10-09'],
      {
        sourceVersion: undefined,
        acquiredAt: undefined,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected import rejection');
    expect(result.report.sourceFile).toEqual(expect.objectContaining({
      relativePath: 'fixture/M2601.csv',
      sha256: 'a'.repeat(64),
    }));
    expect(result.report.rejectionReasons).toEqual([
      'fixture/M2601.csv：来源必须提供版本或取得时间',
    ]);
  });

  it('rejects a source page that returns a contract different from the request', async () => {
    const result = await importFixture(
      [record({ sourceContract: 'M2605' })],
      'main_continuous',
      'M2601',
      ['2025-10-09'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected import rejection');
    expect(result.report.rejectionReasons[0]).toMatch(/来源合约 M2605 与请求 M2601 不一致/);
  });
});
