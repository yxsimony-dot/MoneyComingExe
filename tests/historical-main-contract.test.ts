import { describe, expect, it } from 'vitest';
import { locateRolloverBar } from '../src/domain/contract-rollover';
import type { NormalizedContractFiveMinuteRecord } from '../src/domain/contract-history-import';
import {
  activateHistoricalMainContractCandidate,
  buildAuthoritativeDesktopMainContract,
  calibrateHistoricalMainContracts,
  determineHistoricalMainContracts,
  stitchHistoricalMainContract,
  summarizeHistoricalContractDays,
  type HistoricalContractDailySummary,
} from '../src/domain/historical-main-contract';
import { aggregateFiveMinuteBars } from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import type { Bar, EdbDailyRecord, MainContractMapping } from '../src/shared/types';

function normalizedRecord(
  overrides: Partial<NormalizedContractFiveMinuteRecord> = {},
): NormalizedContractFiveMinuteRecord {
  const start = overrides.start ?? '2025-12-01 09:00:00';
  const startMs = overrides.startMs ?? parseBeijing(start);
  return {
    instrumentId: 'main_continuous',
    exchange: 'DCE',
    contract: 'm2605',
    expiryYear: 2026,
    expiryMonth: 5,
    startMs,
    start,
    endMs: startMs + 5 * 60_000,
    end: formatBeijing(startMs + 5 * 60_000),
    tradingDate: '2025-12-01',
    session: start.slice(11, 13) === '21' ? 'night' : 'day',
    open: 3_000,
    high: 3_010,
    low: 2_990,
    close: 3_005,
    volume: 10,
    openInterest: 1_000,
    provenance: {
      sourceId: 'historical-main-fixture',
      relativePath: 'fixture/M2605.csv',
      line: 2,
    },
    ...overrides,
  };
}

function summary(
  overrides: Partial<HistoricalContractDailySummary> = {},
): HistoricalContractDailySummary {
  return {
    instrumentId: 'main_continuous',
    exchange: 'DCE',
    tradingDate: '2025-12-01',
    contract: 'm2605',
    expiryYear: 2026,
    expiryMonth: 5,
    firstStartMs: parseBeijing('2025-12-01 09:00:00'),
    lastStartMs: parseBeijing('2025-12-01 14:55:00'),
    open: 3_000,
    high: 3_010,
    low: 2_990,
    close: 3_005,
    totalVolume: 100,
    endOpenInterest: 1_000,
    barCount: 45,
    ...overrides,
  };
}

function daily(
  value: HistoricalContractDailySummary,
  overrides: Partial<EdbDailyRecord> = {},
): EdbDailyRecord {
  return {
    datetimeNano: '0',
    tradingDate: value.tradingDate,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: value.totalVolume,
    openOi: value.endOpenInterest,
    closeOi: value.endOpenInterest,
    ...overrides,
  };
}

function sixtyMinuteBar(start: string): Bar {
  const startMs = parseBeijing(start);
  return {
    startMs,
    endMs: startMs + 60 * 60_000,
    start,
    end: formatBeijing(startMs + 60 * 60_000),
    open: 3_200,
    high: 3_220,
    low: 3_190,
    close: 3_210,
    volume: 100,
    openOi: 1_000,
    closeOi: 1_010,
    session: 'night',
    observedMinutes: 55,
    expectedMinutes: 60,
    complete: false,
  };
}

describe('historical main-contract determination', () => {
  it('summarizes daily evidence and applies open-interest, volume, then expiry ordering', () => {
    const records = [
      normalizedRecord({
        start: '2025-12-01 09:00:00',
        startMs: parseBeijing('2025-12-01 09:00:00'),
        close: 3_001,
        volume: 70,
        openInterest: 100,
      }),
      normalizedRecord({
        start: '2025-12-01 09:05:00',
        startMs: parseBeijing('2025-12-01 09:05:00'),
        open: 3_001,
        high: 3_015,
        close: 3_010,
        volume: 50,
        openInterest: 110,
      }),
      normalizedRecord({
        contract: 'm2609',
        expiryMonth: 9,
        volume: 10,
        openInterest: 120,
        provenance: {
          sourceId: 'historical-main-fixture',
          relativePath: 'fixture/M2609.csv',
          line: 2,
        },
      }),
    ];
    const summaries = summarizeHistoricalContractDays(records);
    expect(summaries.find(item => item.contract === 'm2605')).toMatchObject({
      open: 3_000,
      high: 3_015,
      low: 2_990,
      close: 3_010,
      totalVolume: 120,
      endOpenInterest: 110,
      barCount: 2,
    });

    const selection = determineHistoricalMainContracts([
      ...summaries,
      summary({
        tradingDate: '2025-12-02',
        contract: 'm2609',
        expiryMonth: 9,
        endOpenInterest: 200,
        totalVolume: 300,
      }),
      summary({
        tradingDate: '2025-12-02',
        contract: 'm2701',
        expiryYear: 2027,
        expiryMonth: 1,
        endOpenInterest: 200,
        totalVolume: 100,
      }),
      summary({
        tradingDate: '2025-12-03',
        contract: 'm2609',
        expiryMonth: 9,
        endOpenInterest: 300,
        totalVolume: 500,
      }),
      summary({
        tradingDate: '2025-12-03',
        contract: 'm2701',
        expiryYear: 2027,
        expiryMonth: 1,
        endOpenInterest: 300,
        totalVolume: 500,
      }),
    ]);

    expect(selection.blocked).toBe(false);
    expect(selection.mappings).toEqual([
      { tradingDate: '2025-12-01', contract: 'm2609' },
      { tradingDate: '2025-12-02', contract: 'm2609' },
      { tradingDate: '2025-12-03', contract: 'm2609' },
    ]);
  });

  it('excludes delivery-month contracts and stops after an unexplained expiry rollback', () => {
    const deliverySelection = determineHistoricalMainContracts([
      summary({
        tradingDate: '2026-01-05',
        contract: 'm2601',
        expiryMonth: 1,
        endOpenInterest: 9_999,
      }),
      summary({
        tradingDate: '2026-01-05',
        contract: 'm2605',
        expiryMonth: 5,
        endOpenInterest: 100,
      }),
    ]);
    expect(deliverySelection.mappings).toEqual([
      { tradingDate: '2026-01-05', contract: 'm2605' },
    ]);
    expect(deliverySelection.decisions[0].candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contract: 'm2601',
        eligible: false,
        rejectionReason: '已进入交割限制窗口',
      }),
    ]));

    const summaries = [
      summary({
        tradingDate: '2025-10-01',
        contract: 'm2609',
        expiryMonth: 9,
      }),
      summary({
        tradingDate: '2025-10-02',
        contract: 'm2605',
        expiryMonth: 5,
      }),
      summary({
        tradingDate: '2025-10-03',
        contract: 'm2701',
        expiryYear: 2027,
        expiryMonth: 1,
      }),
    ];
    const rejected = determineHistoricalMainContracts(summaries);
    expect(rejected.blocked).toBe(true);
    expect(rejected.mappings).toEqual([
      { tradingDate: '2025-10-01', contract: 'm2609' },
    ]);
    expect(rejected.affectedDates).toEqual(['2025-10-02', '2025-10-03']);
    expect(rejected.decisions[1].reason).toMatch(/无解释倒退/);
    expect(rejected.decisions[2].reason).toMatch(/此前 2025-10-02/);

    const allowed = determineHistoricalMainContracts(summaries, {
      allowedExpiryRollbacks: {
        '2025-10-02': '与经审计的交易所临时恢复映射一致',
      },
    });
    expect(allowed.blocked).toBe(false);
    expect(allowed.mappings).toHaveLength(3);
    expect(allowed.decisions[1].expiryRollbackReason).toBe(
      '与经审计的交易所临时恢复映射一致',
    );
  });

  it('rejects missing fields and fully tied duplicate candidates without guessing', () => {
    expect(() => summarizeHistoricalContractDays([
      normalizedRecord({ openInterest: Number.NaN }),
    ])).toThrow(/openInterest 缺失或不是有限数值/);

    const duplicate = summary();
    const selection = determineHistoricalMainContracts([duplicate, { ...duplicate }]);
    expect(selection.blocked).toBe(true);
    expect(selection.mappings).toEqual([]);
    expect(selection.decisions[0].reason).toMatch(/重复候选合约/);
  });
});

describe('historical main-contract calibration', () => {
  const summaries = [
    summary({
      tradingDate: '2025-12-01',
      contract: 'm2605',
      expiryMonth: 5,
    }),
    summary({
      tradingDate: '2025-12-02',
      contract: 'm2609',
      expiryMonth: 9,
      open: 3_100,
      high: 3_120,
      low: 3_090,
      close: 3_110,
    }),
  ];
  const candidateMappings: MainContractMapping[] = [
    { tradingDate: '2025-12-01', contract: 'm2605' },
    { tradingDate: '2025-12-02', contract: 'm2609' },
  ];

  it('reports daily contract, OHLC and rollover differences with affected dates', () => {
    const report = calibrateHistoricalMainContracts(
      'main_continuous',
      summaries,
      candidateMappings,
      [
        { tradingDate: '2025-12-01', contract: 'm2605' },
        { tradingDate: '2025-12-02', contract: 'm2605' },
      ],
      [
        daily(summaries[0]),
        daily(summaries[1], { close: summaries[1].close + 1 }),
      ],
      { minOverlapDays: 2 },
    );

    expect(report.overlap).toEqual({
      firstTradingDate: '2025-12-01',
      lastTradingDate: '2025-12-02',
      days: 2,
    });
    expect(report.affectedDates).toEqual({
      missingEvidence: [],
      contractMismatch: ['2025-12-02'],
      ohlcMismatch: ['2025-12-02'],
      rolloverMismatch: ['2025-12-02'],
    });
    expect(report.days[1]).toMatchObject({
      candidateContract: 'm2609',
      referenceContract: 'm2605',
      contractMatches: false,
      ohlcMatches: false,
      candidateRollover: true,
      referenceRollover: false,
      rolloverMatches: false,
    });
    expect(report.activation.allowed).toBe(false);
    expect(report.activation.violations).toEqual([
      '主力合约差异超限：1 > 0',
      'OHLC 差异超限：1 > 0',
      '换月日期差异超限：1 > 0',
    ]);
  });

  it('uses explicit release thresholds and blocks candidate activation on overflow', () => {
    const passing = calibrateHistoricalMainContracts(
      'main_continuous',
      summaries,
      candidateMappings,
      candidateMappings,
      summaries.map(item => daily(item)),
      { minOverlapDays: 2 },
    );
    expect(passing.activation).toEqual({ allowed: true, violations: [] });

    const tooShort = calibrateHistoricalMainContracts(
      'main_continuous',
      summaries,
      candidateMappings,
      candidateMappings,
      summaries.map(item => daily(item)),
    );
    expect(tooShort.activation.allowed).toBe(false);
    expect(tooShort.activation.violations).toEqual([
      '重叠交易日不足：2 < 20',
    ]);

    const selection = determineHistoricalMainContracts(summaries);
    const blocked = activateHistoricalMainContractCandidate([], selection, tooShort);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('Expected activation rejection');
    expect(blocked.reasons).toContain('重叠交易日不足：2 < 20');
  });
});

describe('historical main-contract stitching and rollover positioning', () => {
  it('keeps raw cross-contract prices and marks the first actual five-minute bar', () => {
    const records = [
      normalizedRecord({
        tradingDate: '2025-12-01',
        contract: 'm2609',
        expiryMonth: 9,
        start: '2025-12-01 14:55:00',
        startMs: parseBeijing('2025-12-01 14:55:00'),
        open: 3_000,
        high: 3_005,
        low: 2_995,
        close: 3_002,
        volume: 100,
        openInterest: 2_000,
      }),
      normalizedRecord({
        tradingDate: '2025-12-02',
        contract: 'm2701',
        expiryYear: 2027,
        expiryMonth: 1,
        start: '2025-12-01 21:05:00',
        startMs: parseBeijing('2025-12-01 21:05:00'),
        session: 'night',
        open: 3_200,
        high: 3_210,
        low: 3_195,
        close: 3_205,
        volume: 80,
        openInterest: 2_100,
      }),
      normalizedRecord({
        tradingDate: '2025-12-02',
        contract: 'm2701',
        expiryYear: 2027,
        expiryMonth: 1,
        start: '2025-12-02 09:00:00',
        startMs: parseBeijing('2025-12-02 09:00:00'),
        open: 3_206,
        high: 3_215,
        low: 3_200,
        close: 3_210,
        volume: 90,
        openInterest: 2_120,
      }),
    ];
    const mappings = [
      { tradingDate: '2025-12-01', contract: 'm2609' },
      { tradingDate: '2025-12-02', contract: 'm2701' },
    ];
    const stitched = stitchHistoricalMainContract(records, mappings);

    expect(stitched.bars5.map(bar => [bar.start, bar.open, bar.close])).toEqual([
      ['2025-12-01 14:55:00', 3_000, 3_002],
      ['2025-12-01 21:05:00', 3_200, 3_205],
      ['2025-12-02 09:00:00', 3_206, 3_210],
    ]);
    expect(stitched.rollovers).toEqual([
      {
        tradingDate: '2025-12-02',
        time: '2025-12-01 21:05:00',
        timeMs: parseBeijing('2025-12-01 21:05:00'),
        fromContract: 'm2609',
        toContract: 'm2701',
      },
    ]);

    const rollover = stitched.rollovers[0];
    expect(locateRolloverBar(rollover, stitched.bars5, 5)?.start).toBe(
      '2025-12-01 21:05:00',
    );
    expect(locateRolloverBar(rollover, [
      sixtyMinuteBar('2025-12-01 21:00:00'),
      sixtyMinuteBar('2025-12-01 22:00:00'),
    ], 60)?.start).toBe('2025-12-01 21:00:00');
  });

  it('preserves authoritative desktop-main bars and derives only rollover metadata', () => {
    const first = normalizedRecord({
      tradingDate: '2025-12-01',
      contract: 'm2609',
      expiryMonth: 9,
      start: '2025-12-01 14:55:00',
      startMs: parseBeijing('2025-12-01 14:55:00'),
      open: 3_000,
      high: 3_005,
      low: 2_995,
      close: 3_002,
      volume: 100,
      openInterest: 2_000,
    });
    const second = normalizedRecord({
      tradingDate: '2025-12-02',
      contract: 'm2701',
      expiryYear: 2027,
      expiryMonth: 1,
      start: '2025-12-01 21:05:00',
      startMs: parseBeijing('2025-12-01 21:05:00'),
      session: 'night',
      open: 3_247,
      high: 3_259,
      low: 3_241,
      close: 3_253,
      volume: 83,
      openInterest: 2_100,
    });
    const bars5: Bar[] = [first, second].map((record, index) => ({
      startMs: record.startMs,
      endMs: record.endMs,
      start: record.start,
      end: record.end,
      open: record.open,
      high: record.high,
      low: record.low,
      close: record.close,
      volume: record.volume,
      openOi: record.openInterest + index,
      closeOi: record.openInterest + index + 1,
      session: record.session,
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    }));
    const result = buildAuthoritativeDesktopMainContract(
      'main_continuous',
      bars5,
      [
        { tradingDate: '2025-12-01', contract: 'm2609' },
        { tradingDate: '2025-12-02', contract: 'm2701' },
      ],
    );

    expect(result.bars5).toEqual(bars5);
    expect(result.bars5[0]).toBe(bars5[0]);
    expect(result.bars5[1]).toBe(bars5[1]);
    expect(result.rollovers).toEqual([
      {
        tradingDate: '2025-12-02',
        time: '2025-12-01 21:05:00',
        timeMs: parseBeijing('2025-12-01 21:05:00'),
        fromContract: 'm2609',
        toContract: 'm2701',
      },
    ]);

    const rollover = result.rollovers[0];
    const bars60 = aggregateFiveMinuteBars(result.bars5);
    expect(locateRolloverBar(rollover, result.bars5, 5)).toBe(bars5[1]);
    expect(locateRolloverBar(rollover, bars60, 60)?.start).toBe(
      '2025-12-01 21:00:00',
    );
  });

  it('requires normalized four-digit CZCE mappings for desktop history', () => {
    const start = '2025-12-01 14:55:00';
    const startMs = parseBeijing(start);
    const bar: Bar = {
      startMs,
      endMs: startMs + 5 * 60_000,
      start,
      end: formatBeijing(startMs + 5 * 60_000),
      open: 2_500,
      high: 2_510,
      low: 2_490,
      close: 2_505,
      volume: 100,
      openOi: 1_000,
      closeOi: 1_010,
      session: 'day',
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    };

    expect(() => buildAuthoritativeDesktopMainContract(
      'rapeseed_meal_main',
      [bar],
      [{ tradingDate: '2025-12-01', contract: 'RM601' }],
    )).toThrow(/四位年份代码/);
    expect(buildAuthoritativeDesktopMainContract(
      'rapeseed_meal_main',
      [bar],
      [{ tradingDate: '2025-12-01', contract: 'RM2601' }],
    ).mappings).toEqual([
      { tradingDate: '2025-12-01', contract: 'RM2601' },
    ]);
  });
});
