import { describe, expect, it } from 'vitest';
import {
  compareDesktopMainContractCandidate,
  matchDesktopMainContractDays,
  resolveDesktopMainContractAudits,
  type DesktopMainContractFallbackEvidence,
  type DesktopMainMatchMinuteRecord,
} from '../src/domain/desktop-main-contract-matching';
import { parseBeijing } from '../src/domain/time';
import type {
  HistoricalMainContractCandidateDecision,
  HistoricalMainContractDecision,
} from '../src/domain/historical-main-contract';
import type { Instrument } from '../src/shared/instruments';
import type { MainContractMapping } from '../src/shared/types';

function minute(
  timestamp: string,
  overrides: Partial<DesktopMainMatchMinuteRecord> = {},
): DesktopMainMatchMinuteRecord {
  return {
    instrumentId: 'main_continuous',
    tradingDate: '2026-08-10',
    timestamp,
    startMs: parseBeijing(timestamp),
    open: 3_000,
    high: 3_010,
    low: 2_990,
    close: 3_005,
    amount: 30_050,
    volume: 10,
    openInterest: 1_000,
    ...overrides,
  };
}

function tradeStatisticsVarianceFixture(options: {
  rowCount?: number;
  mutationIndexes: readonly number[];
  mutate: (
    record: DesktopMainMatchMinuteRecord,
    mutationIndex: number,
  ) => Partial<DesktopMainMatchMinuteRecord>;
  unavailableField?: 'amount' | 'volume';
}) {
  const rowCount = options.rowCount ?? 345;
  const dates = ['2022-01-26', '2022-01-27', '2022-01-28'];
  const main = dates.flatMap((tradingDate, dayIndex) => (
    Array.from({ length: rowCount }, (_, minuteIndex) => {
      const totalMinutes = 9 * 60 + minuteIndex;
      return minute(
        `${tradingDate} ${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:`
        + `${String(totalMinutes % 60).padStart(2, '0')}:00`,
        {
          tradingDate,
          open: 2_400 + dayIndex,
          high: 2_410 + dayIndex,
          low: 2_390 + dayIndex,
          close: 2_405 + dayIndex,
          amount: options.unavailableField === 'amount' ? null : 100_000_000,
          volume: options.unavailableField === 'volume' ? null : 10_000,
          openInterest: 800_000 + dayIndex,
        },
      );
    })
  ));
  const contracts = main.map((record, recordIndex) => {
    const minuteIndex = recordIndex % rowCount;
    const mutationIndex = options.mutationIndexes.indexOf(minuteIndex);
    return {
      ...record,
      contract: 'SA2205',
      ...(record.tradingDate === '2022-01-27' && mutationIndex >= 0
        ? options.mutate(record, mutationIndex)
        : {}),
    };
  });
  return { main, contracts };
}

function rolloverBoundaryFixture(options: {
  previousContract: string;
  nextContract: string;
  boundaryCandidates: ReadonlyArray<{
    contract: string;
    mutate?: (
      record: DesktopMainMatchMinuteRecord,
      mutationIndex: number,
    ) => Partial<DesktopMainMatchMinuteRecord>;
  }>;
  dates?: readonly [string, string, string];
  rowCount?: number;
  mutationIndexes?: readonly number[];
}) {
  const instrumentId: Instrument = 'soybean_1_main';
  const dates = options.dates ?? [
    '2021-10-13',
    '2021-10-14',
    '2021-10-15',
  ];
  const rowCount = options.rowCount ?? 100;
  const mutationIndexes = options.mutationIndexes ?? [17];
  const main = dates.flatMap((tradingDate, dayIndex) => (
    Array.from({ length: rowCount }, (_, minuteIndex) => {
      const totalMinutes = 9 * 60 + minuteIndex;
      return minute(
        `${tradingDate} ${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:`
        + `${String(totalMinutes % 60).padStart(2, '0')}:00`,
        {
          instrumentId,
          tradingDate,
          open: 6_000 + dayIndex,
          high: 6_010 + dayIndex,
          low: 5_990 + dayIndex,
          close: 6_005 + dayIndex,
          amount: 100_000_000,
          volume: 10_000,
          openInterest: 800_000 + dayIndex,
        },
      );
    })
  ));
  const contracts = main.flatMap(record => {
    if (record.tradingDate === dates[0]) {
      return [{ ...record, contract: options.previousContract }];
    }
    if (record.tradingDate === dates[2]) {
      return [{ ...record, contract: options.nextContract }];
    }
    const minuteIndex = main
      .filter(item => item.tradingDate === record.tradingDate)
      .findIndex(item => item.startMs === record.startMs);
    const mutationIndex = mutationIndexes.indexOf(minuteIndex);
    return options.boundaryCandidates.map(candidate => ({
      ...record,
      contract: candidate.contract,
      ...(mutationIndex >= 0
        ? candidate.mutate?.(record, mutationIndex) ?? {
            close: record.close + 1,
          }
        : {}),
    }));
  });
  return { main, contracts };
}

function heuristicCandidate(
  contract: string,
  endOpenInterest: number,
  overrides: Partial<HistoricalMainContractCandidateDecision> = {},
): HistoricalMainContractCandidateDecision {
  const expiry = contract.match(/(\d{2})(\d{2})$/);
  return {
    contract,
    expiryYear: expiry ? 2000 + Number(expiry[1]) : 2027,
    expiryMonth: expiry ? Number(expiry[2]) : 1,
    endOpenInterest,
    totalVolume: 100,
    eligible: true,
    ...overrides,
  };
}

function fallbackEvidence(
  mappings: MainContractMapping[],
  decisions: HistoricalMainContractDecision[],
  options: {
    instrumentId?: Instrument;
    calibrationAllowed?: boolean;
    calibrationViolations?: string[];
  } = {},
): DesktopMainContractFallbackEvidence {
  const instrumentId = options.instrumentId ?? 'main_continuous';
  const calibrationViolations = options.calibrationViolations ?? [];
  return {
    selection: {
      instrumentId,
      mappings,
      decisions,
      blocked: decisions.some(decision => decision.status === 'rejected'),
      affectedDates: decisions
        .filter(decision => decision.status === 'rejected')
        .map(decision => decision.tradingDate),
    },
    calibration: {
      schemaVersion: 1,
      instrumentId,
      overlap: {
        firstTradingDate: '2026-07-01',
        lastTradingDate: '2026-08-31',
        days: 40,
      },
      thresholds: {
        minOverlapDays: 20,
        maxContractMismatchDays: 0,
        maxOhlcMismatchDays: 0,
        maxRolloverMismatchDays: 0,
        priceTolerance: 0,
      },
      days: [],
      affectedDates: {
        missingEvidence: [],
        contractMismatch: [],
        ohlcMismatch: [],
        rolloverMismatch: [],
      },
      counts: {
        missingEvidence: 0,
        contractMismatch: 0,
        ohlcMismatch: 0,
        rolloverMismatch: 0,
      },
      activation: {
        allowed: options.calibrationAllowed ?? calibrationViolations.length === 0,
        violations: calibrationViolations,
      },
    },
  };
}

describe('desktop main-contract exact minute matching', () => {
  it('selects the only contract whose timestamp and available fields match exactly', () => {
    const main = [
      minute('2026-08-07 21:00:00'),
      minute('2026-08-10 09:00:00', {
        open: 3_005,
        high: 3_015,
        close: 3_010,
        amount: 60_100,
        volume: 20,
        openInterest: 1_010,
      }),
    ];
    const contracts = [
      ...main.map(record => ({ ...record, contract: 'm2701' })),
      ...main.map(record => ({
        ...record,
        contract: 'm2609',
        openInterest: (record.openInterest ?? 0) + 500,
      })),
    ];

    const report = matchDesktopMainContractDays(main, contracts);

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
    expect(report.days[0]).toMatchObject({
      method: 'exact-minute-sequence',
      selectedContract: 'm2701',
      confidence: 1,
      participatingFields: [
        'timestamp',
        'open',
        'high',
        'low',
        'close',
        'amount',
        'volume',
        'openInterest',
      ],
    });
    expect(report.summary).toEqual({
      tradingDays: 1,
      matchedDays: 1,
      uniqueExactMatches: 1,
      sourceVarianceFallbackMatches: 0,
      rolloverBoundarySourceVarianceMatches: 0,
      heuristicFallbackMatches: 0,
      zeroExactMatches: 0,
      multipleExactMatches: 0,
      uniqueExactMatchRate: 1,
      minimumConfidence: 1,
    });
  });

  it('uses only optional fields that are complete for the whole compared day', () => {
    const main = [
      minute('2026-08-10 09:00:00'),
      minute('2026-08-10 09:01:00'),
    ];
    const contract = main.map((record, index) => ({
      ...record,
      contract: 'm2701',
      amount: index === 0 ? null : record.amount,
    }));

    const report = matchDesktopMainContractDays(main, contract);

    expect(report.days[0].status).toBe('matched');
    expect(report.days[0].participatingFields).not.toContain('amount');
    expect(report.days[0].candidates[0].unavailableFields).toEqual(['amount']);
  });

  it('treats source serialization round-off as the same numeric value', () => {
    const main = [
      minute('2026-08-10 09:00:00', {
        amount: 392_061_339.999_999_05,
      }),
    ];
    const report = matchDesktopMainContractDays(main, [
      { ...main[0], contract: 'm2701', amount: 392_061_340 },
    ]);

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
  });

  it('rejects a real amount difference beyond source precision noise', () => {
    const main = [minute('2026-08-10 09:00:00', { amount: 10_000_000 })];
    const report = matchDesktopMainContractDays(main, [
      { ...main[0], contract: 'm2701', amount: 10_000_000.01 },
    ]);

    expect(report.blocked).toBe(true);
    expect(report.days[0].candidates[0].mismatchFields).toContain('amount');
  });

  it('blocks zero and multiple exact matches without guessing', () => {
    const firstDate = minute('2026-08-10 09:00:00');
    const secondDate = minute('2026-08-11 09:00:00', {
      tradingDate: '2026-08-11',
    });
    const report = matchDesktopMainContractDays(
      [firstDate, secondDate],
      [
        { ...firstDate, contract: 'm2609', close: firstDate.close + 1 },
        { ...secondDate, contract: 'm2609' },
        { ...secondDate, contract: 'm2701' },
      ],
    );

    expect(report.blocked).toBe(true);
    expect(report.affectedDates).toEqual(['2026-08-10', '2026-08-11']);
    expect(report.days[0].ambiguityReasons[0]).toMatch(/没有具体合约/);
    expect(report.days[1].ambiguityReasons[0]).toMatch(/多个具体合约/);
    expect(report.summary).toEqual({
      tradingDays: 2,
      matchedDays: 0,
      uniqueExactMatches: 0,
      sourceVarianceFallbackMatches: 0,
      rolloverBoundarySourceVarianceMatches: 0,
      heuristicFallbackMatches: 0,
      zeroExactMatches: 1,
      multipleExactMatches: 1,
      uniqueExactMatchRate: 0,
      minimumConfidence: 0,
    });
  });

  it('keeps the unique exact match when the maximum-open-interest heuristic differs', () => {
    const main = [minute('2026-08-10 09:00:00')];
    const report = matchDesktopMainContractDays(
      main,
      [
        { ...main[0], contract: 'm2701' },
        {
          ...main[0],
          contract: 'm2609',
          openInterest: (main[0].openInterest ?? 0) + 10_000,
        },
      ],
      fallbackEvidence(
        [{ tradingDate: '2026-08-10', contract: 'm2609' }],
        [{
          tradingDate: '2026-08-10',
          status: 'selected',
          selectedContract: 'm2609',
          candidates: [
            heuristicCandidate('m2609', 11_000),
            heuristicCandidate('m2701', 1_000),
          ],
        }],
      ),
    );

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
    expect(report.days[0]).toMatchObject({
      method: 'exact-minute-sequence',
      selectedContract: 'm2701',
      heuristic: {
        status: 'selected',
        selectedContract: 'm2609',
        disagreementWithExact: true,
      },
    });
  });

  it('uses a unique calibrated heuristic only when exact matching returns zero', () => {
    const main = [minute('2026-08-10 09:00:00')];
    const report = matchDesktopMainContractDays(
      main,
      [
        { ...main[0], contract: 'm2609', close: main[0].close + 1 },
        { ...main[0], contract: 'm2701', close: main[0].close + 2 },
      ],
      fallbackEvidence(
        [{ tradingDate: '2026-08-10', contract: 'm2701' }],
        [{
          tradingDate: '2026-08-10',
          status: 'selected',
          selectedContract: 'm2701',
          candidates: [
            heuristicCandidate('m2609', 1_000),
            heuristicCandidate('m2701', 2_000),
          ],
        }],
      ),
    );

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
    expect(report.days[0]).toMatchObject({
      status: 'matched',
      method: 'heuristic-fallback',
      selectedContract: 'm2701',
      confidence: 0.5,
      exactMatch: {
        status: 'zero',
        matchingContracts: [],
      },
    });
    expect(report.summary.heuristicFallbackMatches).toBe(1);
    expect(report.summary.minimumConfidence).toBe(0.5);
  });

  it('keeps amount and volume differences non-exact while allowing calibrated fallback', () => {
    const main = [minute('2026-08-10 09:00:00')];
    const contract = {
      ...main[0],
      contract: 'm2701',
      amount: (main[0].amount ?? 0) + 100,
      volume: (main[0].volume ?? 0) + 1,
    };
    const fallback = fallbackEvidence(
      [{ tradingDate: '2026-08-10', contract: 'm2701' }],
      [{
        tradingDate: '2026-08-10',
        status: 'selected',
        selectedContract: 'm2701',
        candidates: [heuristicCandidate('m2701', 2_000)],
      }],
    );

    const candidate = compareDesktopMainContractCandidate(
      main,
      'm2701',
      [contract],
    );
    expect(candidate.exact).toBe(false);
    expect(candidate.mismatchFields).toEqual(['amount', 'volume']);

    const report = resolveDesktopMainContractAudits(
      'main_continuous',
      [{ tradingDate: '2026-08-10', candidates: [candidate] }],
      fallback,
    );
    expect(report.blocked).toBe(false);
    expect(report.days[0]).toMatchObject({
      method: 'heuristic-fallback',
      selectedContract: 'm2701',
      confidence: 0.5,
    });
    expect(report.summary.minimumConfidence).toBe(0.5);
  });

  it('accepts a unique limited source variance confirmed by exact neighbors', () => {
    const tradingDates = ['2021-11-11', '2021-11-12', '2021-11-15'];
    const main = tradingDates.flatMap((tradingDate, dayIndex) => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        {
          tradingDate,
          open: 8_000 + dayIndex,
          high: 8_010 + dayIndex,
          low: 7_990 + dayIndex,
          close: 8_005 + dayIndex,
        },
      ))
    ));
    const contracts = main.map(record => ({
      ...record,
      contract: 'v2201',
      ...(record.tradingDate === '2021-11-12'
        && record.timestamp.endsWith('09:17:00')
        ? {
            close: record.close + 1,
            volume: (record.volume ?? 0) + 2,
          }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);
    const target = report.days[1];
    const candidate = target.candidates[0];

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2021-11-11', contract: 'v2201' },
      { tradingDate: '2021-11-12', contract: 'v2201' },
      { tradingDate: '2021-11-15', contract: 'v2201' },
    ]);
    expect(target).toMatchObject({
      status: 'matched',
      method: 'neighbor-confirmed-source-variance',
      selectedContract: 'v2201',
      confidence: 0.99,
      exactMatch: {
        status: 'zero',
        matchingContracts: [],
      },
      sourceVariance: {
        status: 'selected',
        selectedContract: 'v2201',
        selectedRule: 'general-limited-source-variance',
        qualifyingContracts: ['v2201'],
        qualifyingCandidates: [{
          contract: 'v2201',
          rule: 'general-limited-source-variance',
        }],
        previousExactMatch: {
          tradingDate: '2021-11-11',
          contract: 'v2201',
        },
        nextExactMatch: {
          tradingDate: '2021-11-15',
          contract: 'v2201',
        },
        issues: [],
      },
    });
    expect(candidate).toMatchObject({
      mainRows: 100,
      rows: 100,
      exact: false,
      mismatchRows: 1,
      timestampMismatchRows: 0,
      ohlcMismatchRows: 1,
      optionalMismatchRows: 1,
      fullyMatchingRows: 99,
      fullFieldMatchRate: 0.99,
      mismatchSamples: [{
        timestamp: '2021-11-12 09:17:00',
        fields: ['close', 'volume'],
      }],
    });
    expect(report.summary).toMatchObject({
      uniqueExactMatches: 2,
      sourceVarianceFallbackMatches: 1,
      heuristicFallbackMatches: 0,
      zeroExactMatches: 1,
    });
  });

  it('accepts five tiny trade-statistics-only differences with exact neighbors', () => {
    const volumeDeltas = [1, 26, -8, 4, 120];
    const amountDeltas = [56_000, 1_456_000, -448_000, 224_000, 6_720_000];
    const { main, contracts } = tradeStatisticsVarianceFixture({
      mutationIndexes: [15, 19, 31, 49, 57],
      mutate: (record, mutationIndex) => ({
        amount: (record.amount ?? 0) + amountDeltas[mutationIndex],
        volume: (record.volume ?? 0) + volumeDeltas[mutationIndex],
      }),
    });

    const report = matchDesktopMainContractDays(main, contracts);
    const target = report.days[1];
    const candidate = target.candidates[0];

    expect(report.blocked).toBe(false);
    expect(report.schemaVersion).toBe(6);
    expect(target).toMatchObject({
      tradingDate: '2022-01-27',
      status: 'matched',
      method: 'neighbor-confirmed-source-variance',
      selectedContract: 'SA2205',
      sourceVariance: {
        status: 'selected',
        selectedContract: 'SA2205',
        selectedRule: 'trade-statistics-only',
        qualifyingContracts: ['SA2205'],
        qualifyingCandidates: [{
          contract: 'SA2205',
          rule: 'trade-statistics-only',
        }],
        segmentTradingDates: ['2022-01-27'],
        previousExactMatch: {
          tradingDate: '2022-01-26',
          contract: 'SA2205',
        },
        nextExactMatch: {
          tradingDate: '2022-01-28',
          contract: 'SA2205',
        },
        thresholds: {
          tradeStatisticsOnly: {
            maximumMismatchRows: 5,
            maximumVolumeDifferenceRatio: 0.0005,
            maximumAmountDifferenceRatio: 0.0005,
          },
        },
        issues: [],
      },
    });
    expect(candidate).toMatchObject({
      mainRows: 345,
      rows: 345,
      exact: false,
      mismatchFields: ['amount', 'volume'],
      mismatchRows: 5,
      timestampMismatchRows: 0,
      ohlcMismatchRows: 0,
      optionalMismatchRows: 5,
      fullyMatchingRows: 340,
    });
    expect(candidate.fullFieldMatchRate).toBeCloseTo(340 / 345, 12);
    expect(candidate.mismatchSamples).toHaveLength(5);
    expect(candidate.mismatchSamples[0].differences).toEqual([
      {
        field: 'amount',
        mainValue: 100_000_000,
        candidateValue: 100_056_000,
        absoluteDifference: 56_000,
      },
      {
        field: 'volume',
        mainValue: 10_000,
        candidateValue: 10_001,
        absoluteDifference: 1,
      },
    ]);
    expect(candidate.tradeStatisticsDifferences.volume.absoluteDifference).toBe(159);
    expect(candidate.tradeStatisticsDifferences.volume.differenceRatio)
      .toBeCloseTo(159 / 3_450_143, 12);
    expect(candidate.tradeStatisticsDifferences.amount.absoluteDifference)
      .toBe(8_904_000);
    expect(candidate.tradeStatisticsDifferences.amount.differenceRatio)
      .toBeCloseTo(8_904_000 / 34_508_008_000, 12);
  });

  it('keeps the old contract on a one-day rollover-boundary variance', () => {
    const { main, contracts } = rolloverBoundaryFixture({
      previousContract: 'a2111',
      nextContract: 'a2201',
      boundaryCandidates: [{ contract: 'a2111' }],
    });

    const report = matchDesktopMainContractDays(main, contracts);
    const boundaryDay = report.days[1];

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2021-10-13', contract: 'a2111' },
      { tradingDate: '2021-10-14', contract: 'a2111' },
      { tradingDate: '2021-10-15', contract: 'a2201' },
    ]);
    expect(boundaryDay).toMatchObject({
      method: 'rollover-boundary-source-variance',
      selectedContract: 'a2111',
      rolloverBoundarySourceVariance: {
        status: 'selected',
        selectedContract: 'a2111',
        candidateAnchor: 'previous-exact',
        inferredRolloverTradingDate: '2021-10-15',
        previousExactMatch: {
          tradingDate: '2021-10-13',
          contract: 'a2111',
        },
        nextExactMatch: {
          tradingDate: '2021-10-15',
          contract: 'a2201',
        },
        adjacentExpiry: {
          fromYearMonth: '2111',
          toYearMonth: '2201',
          expectedNextYearMonth: '2201',
          adjacentForward: true,
        },
        issues: [],
      },
    });
    expect(boundaryDay.sourceVariance?.status).toBe('rejected');
    expect(report.days[2].rollover).toEqual({
      tradingDate: '2021-10-15',
      fromContract: 'a2111',
      toContract: 'a2201',
    });
    expect(report.summary).toMatchObject({
      sourceVarianceFallbackMatches: 0,
      rolloverBoundarySourceVarianceMatches: 1,
    });
  });

  it('switches to the new contract on a one-day rollover-boundary variance', () => {
    const { main, contracts } = rolloverBoundaryFixture({
      previousContract: 'a2203',
      nextContract: 'a2205',
      boundaryCandidates: [{
        contract: 'a2205',
        mutate: record => ({
          amount: (record.amount ?? 0) + 60_550,
          volume: (record.volume ?? 0) + 1,
        }),
      }],
      dates: ['2022-02-21', '2022-02-22', '2022-02-23'],
      rowCount: 344,
      mutationIndexes: [177],
    });

    const report = matchDesktopMainContractDays(main, contracts);
    const boundaryDay = report.days[1];

    expect(report.blocked).toBe(false);
    expect(boundaryDay).toMatchObject({
      method: 'rollover-boundary-source-variance',
      selectedContract: 'a2205',
      rollover: {
        tradingDate: '2022-02-22',
        fromContract: 'a2203',
        toContract: 'a2205',
      },
      rolloverBoundarySourceVariance: {
        status: 'selected',
        selectedContract: 'a2205',
        candidateAnchor: 'next-exact',
        inferredRolloverTradingDate: '2022-02-22',
        adjacentExpiry: {
          expectedNextYearMonth: '2205',
          adjacentForward: true,
        },
        issues: [],
      },
    });
    expect(boundaryDay.candidates[0].mismatchSamples[0].differences).toEqual([
      {
        field: 'amount',
        mainValue: 100_000_000,
        candidateValue: 100_060_550,
        absoluteDifference: 60_550,
      },
      {
        field: 'volume',
        mainValue: 10_000,
        candidateValue: 10_001,
        absoluteDifference: 1,
      },
    ]);
  });

  it.each([
    {
      name: 'multiple candidates pass the daily thresholds',
      fixture: () => rolloverBoundaryFixture({
        previousContract: 'a2111',
        nextContract: 'a2201',
        boundaryCandidates: [
          { contract: 'a2111' },
          { contract: 'a2201' },
        ],
      }),
      reason: /多个候选/,
    },
    {
      name: 'the only candidate belongs to neither anchor',
      fixture: () => rolloverBoundaryFixture({
        previousContract: 'a2111',
        nextContract: 'a2201',
        boundaryCandidates: [{ contract: 'a2203' }],
      }),
      reason: /不属于任一/,
    },
    {
      name: 'the exact anchors skip an allowed expiry month',
      fixture: () => rolloverBoundaryFixture({
        previousContract: 'a2109',
        nextContract: 'a2201',
        boundaryCandidates: [{ contract: 'a2109' }],
      }),
      reason: /不是允许月份序列中的相邻向后/,
    },
    {
      name: 'the daily differences exceed the existing thresholds',
      fixture: () => rolloverBoundaryFixture({
        previousContract: 'a2111',
        nextContract: 'a2201',
        boundaryCandidates: [{ contract: 'a2111' }],
        mutationIndexes: [17, 18, 19, 20],
      }),
      reason: /没有候选满足换月边界/,
    },
  ])('rejects rollover-boundary variance when $name', ({ fixture, reason }) => {
    const { main, contracts } = fixture();
    const report = matchDesktopMainContractDays(main, contracts);
    const boundaryDay = report.days[1];

    expect(report.blocked).toBe(true);
    expect(boundaryDay.method).toBe('unresolved');
    expect(boundaryDay.rolloverBoundarySourceVariance).toMatchObject({
      status: 'rejected',
      issues: [expect.stringMatching(reason)],
    });
    expect(report.summary.rolloverBoundarySourceVarianceMatches).toBe(0);
  });

  it('rejects two consecutive rollover-boundary variance days', () => {
    const instrumentId: Instrument = 'soybean_1_main';
    const dates = [
      '2021-10-13',
      '2021-10-14',
      '2021-10-15',
      '2021-10-18',
    ];
    const main = dates.flatMap((tradingDate, dayIndex) => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        {
          instrumentId,
          tradingDate,
          close: 6_000 + dayIndex,
        },
      ))
    ));
    const contracts = main.map(record => ({
      ...record,
      contract: record.tradingDate <= '2021-10-14' ? 'a2111' : 'a2201',
      ...((record.tradingDate === '2021-10-14'
        || record.tradingDate === '2021-10-15')
        && record.timestamp.endsWith('09:17:00')
        ? { close: record.close + 1 }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);

    expect(report.blocked).toBe(true);
    expect(report.days.slice(1, 3).every(day => day.method === 'unresolved'))
      .toBe(true);
    for (const day of report.days.slice(1, 3)) {
      expect(day.rolloverBoundarySourceVariance?.issues).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/也未唯一精确匹配.*不是单日/),
        ]),
      );
    }
    expect(report.summary.rolloverBoundarySourceVarianceMatches).toBe(0);
  });

  it.each([
    {
      name: '差异达到第 6 行',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49, 57, 58],
        mutate: record => ({
          amount: (record.amount ?? 0) + 1,
          volume: (record.volume ?? 0) + 1,
        }),
      }),
    },
    {
      name: '成交量差异占比超过 0.05%',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49, 57],
        mutate: record => ({
          volume: (record.volume ?? 0) + 400,
        }),
      }),
    },
    {
      name: '四行 OHLC 差异',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49],
        mutate: record => ({
          close: record.close + 1,
        }),
      }),
    },
    {
      name: '四行持仓量差异',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49],
        mutate: record => ({
          openInterest: (record.openInterest ?? 0) + 1,
        }),
      }),
    },
    {
      name: '成交额字段不完整',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49, 57],
        unavailableField: 'amount',
        mutate: record => ({
          volume: (record.volume ?? 0) + 1,
        }),
      }),
    },
    {
      name: '成交量字段不完整',
      fixture: () => tradeStatisticsVarianceFixture({
        mutationIndexes: [15, 19, 31, 49, 57],
        unavailableField: 'volume',
        mutate: record => ({
          amount: (record.amount ?? 0) + 1,
        }),
      }),
    },
  ])('rejects the trade-statistics-only exception when $name', ({ fixture }) => {
    const { main, contracts } = fixture();
    const report = matchDesktopMainContractDays(main, contracts);
    const target = report.days[1];

    expect(report.blocked).toBe(true);
    expect(target.status).toBe('ambiguous');
    expect(target.sourceVariance).toMatchObject({
      status: 'rejected',
      qualifyingContracts: [],
      qualifyingCandidates: [],
      issues: [expect.stringMatching(/没有候选满足/)],
    });
  });

  it('accepts a two-day source-variance segment anchored by the same exact contract', () => {
    const tradingDates = [
      '2022-03-16',
      '2022-03-17',
      '2022-03-18',
      '2022-03-21',
    ];
    const main = tradingDates.flatMap((tradingDate, dayIndex) => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        {
          tradingDate,
          open: 3_800 + dayIndex,
          high: 3_810 + dayIndex,
          low: 3_790 + dayIndex,
          close: 3_805 + dayIndex,
        },
      ))
    ));
    const contracts = main.map(record => ({
      ...record,
      contract: 'FG2209',
      ...(record.tradingDate === '2022-03-17'
        && record.timestamp.endsWith('09:17:00')
        ? { close: record.close + 1 }
        : {}),
      ...(record.tradingDate === '2022-03-18'
        && record.timestamp.endsWith('09:18:00')
        ? { volume: (record.volume ?? 0) + 1 }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);
    const varianceDays = report.days.slice(1, 3);

    expect(report.blocked).toBe(false);
    expect(varianceDays).toHaveLength(2);
    for (const day of varianceDays) {
      expect(day).toMatchObject({
        status: 'matched',
        method: 'neighbor-confirmed-source-variance',
        selectedContract: 'FG2209',
        sourceVariance: {
          status: 'selected',
          selectedContract: 'FG2209',
          qualifyingContracts: ['FG2209'],
          segmentTradingDates: ['2022-03-17', '2022-03-18'],
          previousExactMatch: {
            tradingDate: '2022-03-16',
            contract: 'FG2209',
          },
          nextExactMatch: {
            tradingDate: '2022-03-21',
            contract: 'FG2209',
          },
          thresholds: {
            maximumConsecutiveDays: 2,
          },
          issues: [],
        },
      });
    }
    expect(report.summary).toMatchObject({
      uniqueExactMatches: 2,
      sourceVarianceFallbackMatches: 2,
      zeroExactMatches: 2,
    });
  });

  it('rejects a source-variance segment spanning three trading days', () => {
    const tradingDates = [
      '2022-03-16',
      '2022-03-17',
      '2022-03-18',
      '2022-03-21',
      '2022-03-22',
    ];
    const main = tradingDates.flatMap(tradingDate => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        { tradingDate },
      ))
    ));
    const varianceDates = new Set(tradingDates.slice(1, 4));
    const contracts = main.map(record => ({
      ...record,
      contract: 'FG2209',
      ...(varianceDates.has(record.tradingDate)
        && record.timestamp.endsWith('09:17:00')
        ? { volume: (record.volume ?? 0) + 1 }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);
    const varianceDays = report.days.filter(
      day => varianceDates.has(day.tradingDate),
    );

    expect(report.blocked).toBe(true);
    expect(report.affectedDates).toEqual([...varianceDates]);
    for (const day of varianceDays) {
      expect(day.sourceVariance).toMatchObject({
        status: 'rejected',
        segmentTradingDates: [...varianceDates],
        issues: [expect.stringMatching(/超过上限 2/)],
      });
    }
    expect(report.summary.sourceVarianceFallbackMatches).toBe(0);
  });

  it('rejects a source-variance segment whose daily candidates differ', () => {
    const tradingDates = [
      '2022-03-16',
      '2022-03-17',
      '2022-03-18',
      '2022-03-21',
    ];
    const main = tradingDates.flatMap(tradingDate => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        { tradingDate },
      ))
    ));
    const contracts = main.map(record => ({
      ...record,
      contract: record.tradingDate === '2022-03-18' ? 'FG2301' : 'FG2209',
      ...(['2022-03-17', '2022-03-18'].includes(record.tradingDate)
        && record.timestamp.endsWith('09:17:00')
        ? { volume: (record.volume ?? 0) + 1 }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);

    expect(report.blocked).toBe(true);
    for (const day of report.days.slice(1, 3)) {
      expect(day.sourceVariance).toMatchObject({
        status: 'rejected',
        segmentTradingDates: ['2022-03-17', '2022-03-18'],
        issues: expect.arrayContaining([
          expect.stringMatching(/差异段内候选合约不一致/),
        ]),
      });
    }
  });

  it('rejects a two-day source-variance segment without both exact anchors', () => {
    const tradingDates = ['2022-03-17', '2022-03-18', '2022-03-21'];
    const main = tradingDates.flatMap(tradingDate => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        { tradingDate },
      ))
    ));
    const contracts = main.map(record => ({
      ...record,
      contract: 'FG2209',
      ...(['2022-03-17', '2022-03-18'].includes(record.tradingDate)
        && record.timestamp.endsWith('09:17:00')
        ? { volume: (record.volume ?? 0) + 1 }
        : {}),
    }));

    const report = matchDesktopMainContractDays(main, contracts);

    expect(report.blocked).toBe(true);
    for (const day of report.days.slice(0, 2)) {
      expect(day.sourceVariance).toMatchObject({
        status: 'rejected',
        segmentTradingDates: ['2022-03-17', '2022-03-18'],
        issues: expect.arrayContaining([
          expect.stringMatching(/差异段前一个实际交易日/),
        ]),
      });
    }
  });

  it.each([
    {
      name: '缺少前一精确交易日',
      dates: ['2021-11-12', '2021-11-15'],
      targetDate: '2021-11-12',
      mutations: [17],
      mutationField: 'volume' as const,
      contracts: ['v2201', 'v2201'],
      duplicateTargetCandidate: false,
      reason: /前一个实际交易日/,
    },
    {
      name: '缺少后一精确交易日',
      dates: ['2021-11-11', '2021-11-12'],
      targetDate: '2021-11-12',
      mutations: [17],
      mutationField: 'volume' as const,
      contracts: ['v2201', 'v2201'],
      duplicateTargetCandidate: false,
      reason: /后一个实际交易日/,
    },
    {
      name: '相邻交易日合约不一致',
      dates: ['2021-11-11', '2021-11-12', '2021-11-15'],
      targetDate: '2021-11-12',
      mutations: [17],
      mutationField: 'volume' as const,
      contracts: ['v2201', 'v2201', 'v2205'],
      duplicateTargetCandidate: false,
      reason: /前后相邻精确合约不一致/,
    },
    {
      name: '差异超过三行',
      dates: ['2021-11-11', '2021-11-12', '2021-11-15'],
      targetDate: '2021-11-12',
      mutations: [17, 18, 19, 20],
      mutationField: 'volume' as const,
      contracts: ['v2201', 'v2201', 'v2201'],
      duplicateTargetCandidate: false,
      reason: /没有候选满足/,
    },
    {
      name: 'OHLC 差异超过两行',
      dates: ['2021-11-11', '2021-11-12', '2021-11-15'],
      targetDate: '2021-11-12',
      mutations: [17, 18, 19],
      mutationField: 'close' as const,
      contracts: ['v2201', 'v2201', 'v2201'],
      duplicateTargetCandidate: false,
      reason: /没有候选满足/,
    },
    {
      name: '多个候选满足阈值',
      dates: ['2021-11-11', '2021-11-12', '2021-11-15'],
      targetDate: '2021-11-12',
      mutations: [17],
      mutationField: 'volume' as const,
      contracts: ['v2201', 'v2201', 'v2201'],
      duplicateTargetCandidate: true,
      reason: /多个候选满足/,
    },
  ])('rejects limited source variance when $name', ({
    dates,
    targetDate,
    mutations,
    mutationField,
    contracts: dailyContracts,
    duplicateTargetCandidate,
    reason,
  }) => {
    const main = dates.flatMap((tradingDate, dayIndex) => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        {
          tradingDate,
          open: 8_000 + dayIndex,
          high: 8_010 + dayIndex,
          low: 7_990 + dayIndex,
          close: 8_005 + dayIndex,
        },
      ))
    ));
    const contracts = main.map((record) => {
      const dayIndex = dates.indexOf(record.tradingDate);
      const minuteIndex = Number(record.timestamp.slice(14, 16))
        + (Number(record.timestamp.slice(11, 13)) - 9) * 60;
      const shouldMutate = record.tradingDate === targetDate
        && mutations.includes(minuteIndex);
      return {
        ...record,
        contract: dailyContracts[dayIndex],
        ...(shouldMutate
          ? { [mutationField]: (record[mutationField] ?? 0) + 1 }
          : {}),
      };
    });
    if (duplicateTargetCandidate) {
      contracts.push(...contracts
        .filter(record => record.tradingDate === targetDate)
        .map(record => ({ ...record, contract: 'v2205' })));
    }

    const report = matchDesktopMainContractDays(main, contracts);
    const target = report.days.find(day => day.tradingDate === targetDate)!;

    expect(report.blocked).toBe(true);
    expect(target.status).toBe('ambiguous');
    expect(target.method).toBe('unresolved');
    expect(target.sourceVariance?.status).toBe('rejected');
    expect(target.sourceVariance?.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(reason),
    ]));
    expect(report.summary.sourceVarianceFallbackMatches).toBe(0);
  });

  it('keeps a unique exact match ahead of a qualifying source-variance candidate', () => {
    const dates = ['2021-11-11', '2021-11-12', '2021-11-15'];
    const main = dates.flatMap(tradingDate => (
      Array.from({ length: 100 }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        { tradingDate },
      ))
    ));
    const contracts = main.flatMap(record => {
      const exact = { ...record, contract: 'v2201' };
      if (record.tradingDate !== '2021-11-12') return [exact];
      return [
        exact,
        {
          ...record,
          contract: 'v2205',
          ...(record.timestamp.endsWith('09:17:00')
            ? { volume: (record.volume ?? 0) + 1 }
            : {}),
        },
      ];
    });

    const report = matchDesktopMainContractDays(main, contracts);

    expect(report.blocked).toBe(false);
    expect(report.days[1]).toMatchObject({
      method: 'exact-minute-sequence',
      selectedContract: 'v2201',
    });
    expect(report.days[1]).not.toHaveProperty('sourceVariance');
    expect(report.summary).toMatchObject({
      uniqueExactMatches: 3,
      sourceVarianceFallbackMatches: 0,
    });
  });

  it.each([
    {
      name: '全字段一致率低于 99%',
      rowCount: 99,
      mutate: (record: DesktopMainMatchMinuteRecord) => ({
        ...record,
        volume: (record.volume ?? 0) + 1,
      }),
    },
    {
      name: '时间戳序列不一致',
      rowCount: 100,
      mutate: (record: DesktopMainMatchMinuteRecord) => ({
        ...record,
        startMs: record.startMs + 1,
      }),
    },
  ])('rejects limited source variance when $name', ({ rowCount, mutate }) => {
    const dates = ['2021-11-11', '2021-11-12', '2021-11-15'];
    const main = dates.flatMap(tradingDate => (
      Array.from({ length: rowCount }, (_, minuteIndex) => minute(
        `${tradingDate} ${String(9 + Math.floor(minuteIndex / 60)).padStart(2, '0')}:`
        + `${String(minuteIndex % 60).padStart(2, '0')}:00`,
        { tradingDate },
      ))
    ));
    const contracts = main.map(record => ({
      ...(record.tradingDate === '2021-11-12'
        && record.timestamp.endsWith('09:17:00')
        ? mutate(record)
        : record),
      contract: 'v2201',
    }));

    const report = matchDesktopMainContractDays(main, contracts);
    const target = report.days[1];

    expect(report.blocked).toBe(true);
    expect(target.status).toBe('ambiguous');
    expect(target.sourceVariance).toMatchObject({
      status: 'rejected',
      qualifyingContracts: [],
      issues: [expect.stringMatching(/没有候选满足/)],
    });
  });

  it('resolves precomputed streaming audits with the same rules as in-memory records', () => {
    const main = [
      minute('2026-08-10 09:00:00'),
      minute('2026-08-11 09:00:00', { tradingDate: '2026-08-11' }),
    ];
    const contracts = [
      { ...main[0], contract: 'm2609' },
      {
        ...main[1],
        contract: 'm2701',
        amount: (main[1].amount ?? 0) + 100,
      },
    ];
    const fallback = fallbackEvidence(
      [
        { tradingDate: '2026-08-10', contract: 'm2609' },
        { tradingDate: '2026-08-11', contract: 'm2701' },
      ],
      [
        {
          tradingDate: '2026-08-10',
          status: 'selected',
          selectedContract: 'm2609',
          candidates: [heuristicCandidate('m2609', 2_000)],
        },
        {
          tradingDate: '2026-08-11',
          status: 'selected',
          selectedContract: 'm2701',
          candidates: [heuristicCandidate('m2701', 2_100)],
        },
      ],
    );
    const inMemory = matchDesktopMainContractDays(main, contracts, fallback);
    const precomputed = resolveDesktopMainContractAudits(
      'main_continuous',
      main.map((record, index) => ({
        tradingDate: record.tradingDate,
        candidates: [
          compareDesktopMainContractCandidate(
            [record],
            contracts[index].contract,
            [contracts[index]],
          ),
        ],
      })),
      fallback,
    );

    expect(precomputed).toEqual(inMemory);
  });

  it('blocks rejected, missing and uncalibrated fallback evidence', () => {
    const dates = [
      minute('2026-08-10 09:00:00'),
      minute('2026-08-11 09:00:00', { tradingDate: '2026-08-11' }),
    ];
    const contracts = dates.map(record => ({
      ...record,
      contract: 'm2609',
      close: record.close + 1,
    }));
    const uncalibrated = matchDesktopMainContractDays(
      dates,
      contracts,
      fallbackEvidence(
        [{ tradingDate: '2026-08-10', contract: 'm2609' }],
        [
          {
            tradingDate: '2026-08-10',
            status: 'selected',
            selectedContract: 'm2609',
            candidates: [heuristicCandidate('m2609', 2_000)],
          },
          {
            tradingDate: '2026-08-11',
            status: 'rejected',
            candidates: [heuristicCandidate('m2605', 3_000)],
            reason: '主力到期月份发生未解释倒退',
          },
        ],
        {
          calibrationAllowed: false,
          calibrationViolations: ['重叠交易日不足：2 < 20'],
        },
      ),
    );

    expect(uncalibrated.blocked).toBe(true);
    expect(uncalibrated.affectedDates).toEqual(['2026-08-10', '2026-08-11']);
    expect(uncalibrated.days[0].ambiguityReasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/校准未通过/),
    ]));
    expect(uncalibrated.days[1].ambiguityReasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/未解释倒退/),
    ]));

    const missing = matchDesktopMainContractDays([dates[0]], [contracts[0]]);
    expect(missing.blocked).toBe(true);
    expect(missing.days[0].ambiguityReasons).toEqual(expect.arrayContaining([
      '未提供启发式选择和校准证据',
    ]));
  });

  it('never uses a heuristic to resolve multiple exact contracts', () => {
    const main = [minute('2026-08-10 09:00:00')];
    const report = matchDesktopMainContractDays(
      main,
      [
        { ...main[0], contract: 'm2609' },
        { ...main[0], contract: 'm2701' },
      ],
      fallbackEvidence(
        [{ tradingDate: '2026-08-10', contract: 'm2701' }],
        [{
          tradingDate: '2026-08-10',
          status: 'selected',
          selectedContract: 'm2701',
          candidates: [
            heuristicCandidate('m2609', 1_000),
            heuristicCandidate('m2701', 2_000),
          ],
        }],
      ),
    );

    expect(report.blocked).toBe(true);
    expect(report.mappings).toEqual([]);
    expect(report.days[0]).toMatchObject({
      status: 'ambiguous',
      method: 'unresolved',
      exactMatch: {
        status: 'multiple',
        matchingContracts: ['m2609', 'm2701'],
      },
    });
  });

  it('audits exact desktop-source rollovers with normalized contract codes', () => {
    const first = minute('2026-08-10 09:00:00', {
      instrumentId: 'rapeseed_meal_main',
    });
    const second = minute('2026-08-11 09:00:00', {
      instrumentId: 'rapeseed_meal_main',
      tradingDate: '2026-08-11',
      open: 2_500,
      high: 2_510,
      low: 2_490,
      close: 2_505,
    });
    const report = matchDesktopMainContractDays(
      [first, second],
      [
        { ...first, contract: 'RM2601' },
        { ...second, contract: 'RM2605' },
      ],
    );

    expect(report.blocked).toBe(false);
    expect(report.mappings).toEqual([
      { tradingDate: '2026-08-10', contract: 'RM2601' },
      { tradingDate: '2026-08-11', contract: 'RM2605' },
    ]);
    expect(report.days[1].rollover).toEqual({
      tradingDate: '2026-08-11',
      fromContract: 'RM2601',
      toContract: 'RM2605',
    });
  });

  it('audits the desktop-source soybean-meal rollover m2609 -> m2701', () => {
    const first = minute('2026-08-10 09:00:00');
    const second = minute('2026-08-11 09:00:00', {
      tradingDate: '2026-08-11',
      close: 3_006,
    });
    const report = matchDesktopMainContractDays(
      [first, second],
      [
        { ...first, contract: 'm2609' },
        { ...second, contract: 'm2701' },
      ],
    );

    expect(report.days[1].rollover).toEqual({
      tradingDate: '2026-08-11',
      fromContract: 'm2609',
      toContract: 'm2701',
    });
  });
});
