import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  DesktopMainContractFallbackEvidence,
  DesktopMainMatchMinuteRecord,
} from '../src/domain/desktop-main-contract-matching';
import type {
  HistoricalMainContractCandidateDecision,
  HistoricalMainContractDecision,
} from '../src/domain/historical-main-contract';
import {
  THS_GLASS_MAIN_ALLOWED_MATCH_METHODS,
  matchThsGlassMainContracts,
  rebuildThsGlassMainContractArtifacts,
} from '../src/domain/ths-main-contract-matching';
import type {
  GlassContractCandidateRecord,
  GlassContractCandidateSeries,
} from '../src/domain/ths-contract-history';
import type { ThsBenchmarkFiveMinuteBar } from '../src/domain/ths-benchmark';
import { tradingBarBucketAt } from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import { INSTRUMENT_DEFINITIONS } from '../src/shared/instruments';
import type { Bar, MainContractMapping } from '../src/shared/types';

const RAW_HASH = 'a'.repeat(64);
const REGRESSION_FIXTURE = JSON.parse(readFileSync(
  new URL(
    './fixtures/ths/glass-main-contract-matching-2023-08-09.json',
    import.meta.url,
  ),
  'utf8',
)) as {
  tradingDates: string[];
  benchmark: Array<{
    tradingDate: string;
    start: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number;
  }>;
  contracts: Array<{
    rawContract: string;
    normalizedContract: string;
    rows: Array<{
      tradingDate: string;
      benchmarkIndex: number;
      priceOffset: number;
    }>;
  }>;
};

function benchmarkBar(
  tradingDate: string,
  overrides: Partial<ThsBenchmarkFiveMinuteBar> = {},
): ThsBenchmarkFiveMinuteBar {
  const barStartMs = parseBeijing(`${tradingDate} 09:00:00`);
  const barEndMs = barStartMs + 5 * 60_000;
  return {
    sourcePage: 1,
    sourceRow: 1,
    closeTimeMs: barEndMs,
    barStartMs,
    barEndMs,
    start: formatBeijing(barStartMs),
    end: formatBeijing(barEndMs),
    open: 1_500,
    high: 1_510,
    low: 1_490,
    close: 1_505,
    volume: 100,
    turnover: 3_010_000,
    session: 'day',
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
    ...overrides,
  };
}

function candidateRecord(
  benchmark: ThsBenchmarkFiveMinuteBar,
  tradingDate: string,
  rawContract: string,
  normalizedContract: string,
  overrides: Partial<GlassContractCandidateRecord> = {},
): GlassContractCandidateRecord {
  return {
    instrumentId: 'glass_main',
    tradingDate,
    contract: normalizedContract,
    rawContract,
    normalizedContract,
    timestamp: benchmark.start,
    startMs: benchmark.barStartMs,
    endMs: benchmark.barEndMs,
    endTimestamp: benchmark.end,
    open: benchmark.open,
    high: benchmark.high,
    low: benchmark.low,
    close: benchmark.close,
    amount: benchmark.turnover,
    volume: benchmark.volume,
    openInterest: null,
    sourceEvidence: {
      kind: 'ths-contract',
      pageNumber: 1,
      sourceRow: 1,
      rawSha256: RAW_HASH,
    },
    ...overrides,
  };
}

function candidateSeries(
  rawContract: string,
  normalizedContract: string,
  records: GlassContractCandidateRecord[],
): GlassContractCandidateSeries {
  return {
    instrumentId: 'glass_main',
    rawContract,
    normalizedContract,
    source: {
      kind: 'ths-contract',
      sourceId: 'ths-glass-contract',
      sourceName: '同花顺玻璃具体合约 5 分钟',
      license: {
        redistributionAllowed: false,
        conclusion: '仅限本机测试',
      },
      rawPages: [{
        pageNumber: 1,
        rawSha256: RAW_HASH,
        rows: records.length,
      }],
    },
    records,
  };
}

function regressionBenchmarkBars(): ThsBenchmarkFiveMinuteBar[] {
  return REGRESSION_FIXTURE.benchmark.map((row, index) => {
    const barStartMs = parseBeijing(row.start);
    const bucket = tradingBarBucketAt(
      barStartMs,
      5,
      INSTRUMENT_DEFINITIONS.glass_main.tradingSessions,
    );
    return {
      sourcePage: 1,
      sourceRow: index + 1,
      closeTimeMs: bucket.endMs,
      barStartMs,
      barEndMs: bucket.endMs,
      start: row.start,
      end: bucket.end,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      turnover: row.turnover,
      session: bucket.session,
      observedMinutes: bucket.expectedMinutes,
      expectedMinutes: bucket.expectedMinutes,
      complete: true,
    };
  });
}

function regressionCandidateSeries(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
): GlassContractCandidateSeries[] {
  return REGRESSION_FIXTURE.contracts.map(contract => candidateSeries(
    contract.rawContract,
    contract.normalizedContract,
    contract.rows.map(row => {
      const source = benchmark[row.benchmarkIndex];
      const offset = row.priceOffset;
      return candidateRecord(
        source,
        row.tradingDate,
        contract.rawContract,
        contract.normalizedContract,
        {
          open: source.open + offset,
          high: source.high + offset,
          low: source.low + offset,
          close: source.close + offset,
        },
      );
    }),
  ));
}

function barsForRollover(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
): Bar[] {
  return benchmark.map(bar => ({
    startMs: bar.barStartMs,
    endMs: bar.barEndMs,
    start: bar.start,
    end: bar.end,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    openOi: 1_000,
    closeOi: 1_001,
    session: bar.session,
    observedMinutes: bar.observedMinutes,
    expectedMinutes: bar.expectedMinutes,
    complete: true,
  }));
}

function heuristicCandidate(
  contract: string,
  endOpenInterest: number,
): HistoricalMainContractCandidateDecision {
  const expiry = /(\d{2})(\d{2})$/.exec(contract)!;
  return {
    contract,
    expiryYear: 2000 + Number(expiry[1]),
    expiryMonth: Number(expiry[2]),
    endOpenInterest,
    totalVolume: 100,
    eligible: true,
  };
}

function fallbackEvidence(
  mappings: MainContractMapping[],
  decisions: HistoricalMainContractDecision[],
): DesktopMainContractFallbackEvidence {
  return {
    selection: {
      instrumentId: 'glass_main',
      mappings,
      decisions,
      blocked: false,
      affectedDates: [],
    },
    calibration: {
      schemaVersion: 1,
      instrumentId: 'glass_main',
      overlap: {
        firstTradingDate: '2023-08-01',
        lastTradingDate: '2023-08-31',
        days: 23,
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
        allowed: true,
        violations: [],
      },
    },
  };
}

describe('THS glass main-contract matching gate', () => {
  it('blocks activation when a benchmark trading day has zero candidates', () => {
    const benchmark = benchmarkBar('2023-08-09');

    const report = matchThsGlassMainContracts(
      [benchmark],
      [],
      ['2023-08-09'],
    );

    expect(report.matching.blocked).toBe(true);
    expect(report.matching.days[0]).toMatchObject({
      status: 'ambiguous',
      method: 'unresolved',
      exactMatch: {
        status: 'zero',
        matchingContracts: [],
      },
    });
    expect(report.activation).toMatchObject({
      allowed: false,
      violations: [
        expect.stringMatching(/未取得唯一且允许/),
      ],
    });
  });

  it('blocks activation when multiple contracts exactly match the same day', () => {
    const benchmark = benchmarkBar('2023-08-09');
    const oldContract = candidateRecord(
      benchmark,
      '2023-08-09',
      'FG309',
      'FG2309',
    );
    const newContract = candidateRecord(
      benchmark,
      '2023-08-09',
      'FG401',
      'FG2401',
    );

    const report = matchThsGlassMainContracts(
      [benchmark],
      [
        candidateSeries('FG309', 'FG2309', [oldContract]),
        candidateSeries('FG401', 'FG2401', [newContract]),
      ],
      ['2023-08-09'],
    );

    expect(report.matching.days[0]).toMatchObject({
      status: 'ambiguous',
      exactMatch: {
        status: 'multiple',
        matchingContracts: ['FG2309', 'FG2401'],
      },
    });
    expect(report.activation.allowed).toBe(false);
  });

  it('blocks activation when exact mappings move backward in expiry', () => {
    const first = benchmarkBar('2023-08-08');
    const second = benchmarkBar('2023-08-09', {
      sourceRow: 2,
      open: 1_520,
      high: 1_530,
      low: 1_510,
      close: 1_525,
    });

    const report = matchThsGlassMainContracts(
      [first, second],
      [
        candidateSeries('FG401', 'FG2401', [
          candidateRecord(first, '2023-08-08', 'FG401', 'FG2401'),
        ]),
        candidateSeries('FG309', 'FG2309', [
          candidateRecord(second, '2023-08-09', 'FG309', 'FG2309'),
        ]),
      ],
      ['2023-08-08', '2023-08-09'],
    );

    expect(report.matching.blocked).toBe(false);
    expect(report.expirySequence.map(item => item.direction)).toEqual([
      'initial',
      'backward',
    ]);
    expect(report.activation).toMatchObject({
      allowed: false,
      violations: [
        expect.stringMatching(/到期年月异常倒退.*FG2401 -> FG2309/),
      ],
    });
  });

  it('keeps price-jump heuristic evidence in the audit but never selects it', () => {
    const benchmark = benchmarkBar('2023-08-09');
    const oldContract = candidateRecord(
      benchmark,
      '2023-08-09',
      'FG309',
      'FG2309',
      { close: benchmark.close + 1 },
    );
    const newContract = candidateRecord(
      benchmark,
      '2023-08-09',
      'FG401',
      'FG2401',
      { close: benchmark.close + 2 },
    );
    const fallback = fallbackEvidence(
      [{ tradingDate: '2023-08-09', contract: 'FG2401' }],
      [{
        tradingDate: '2023-08-09',
        status: 'selected',
        selectedContract: 'FG2401',
        candidates: [
          heuristicCandidate('FG2309', 100_000),
          heuristicCandidate('FG2401', 200_000),
        ],
      }],
    );

    const report = matchThsGlassMainContracts(
      [benchmark],
      [
        candidateSeries('FG309', 'FG2309', [oldContract]),
        candidateSeries('FG401', 'FG2401', [newContract]),
      ],
      ['2023-08-09'],
      fallback,
    );

    expect(report.matching.days[0]).toMatchObject({
      status: 'ambiguous',
      method: 'unresolved',
      heuristic: {
        status: 'selected',
        selectedContract: 'FG2401',
      },
      ambiguityReasons: expect.arrayContaining([
        expect.stringMatching(/禁止 heuristic-fallback/),
      ]),
    });
    expect(report.matching.summary.heuristicFallbackMatches).toBe(0);
    expect(report.matching.mappings).toEqual([]);
    expect(report.activation.allowed).toBe(false);
  });

  it('allows a unique exact report and exposes only the four approved methods', () => {
    const benchmark = benchmarkBar('2023-08-09');
    const exact = candidateRecord(
      benchmark,
      '2023-08-09',
      'FG309',
      'FG2309',
    );

    const report = matchThsGlassMainContracts(
      [benchmark],
      [candidateSeries('FG309', 'FG2309', [exact])],
      ['2023-08-09'],
    );

    expect(report.activation).toEqual({
      allowed: true,
      violations: [],
    });
    expect(report.allowedMethods).toEqual(
      THS_GLASS_MAIN_ALLOWED_MATCH_METHODS,
    );
    expect(report.allowedMethods).toContain('daily-relative-candidate-evidence');
    expect(report.matching.days.map(day => day.method)).toEqual([
      'exact-minute-sequence',
    ]);
    expect(report.matching.days.every(day => (
      report.allowedMethods.includes(
        day.method as typeof report.allowedMethods[number],
      )
    ))).toBe(true);
  });

  it('rebuilds the August 2023 mapping and rolls only after FG2309 owns 2023-08-09', () => {
    const benchmark = regressionBenchmarkBars();
    const candidates = regressionCandidateSeries(benchmark).map(series => ({
      ...series,
      records: series.records.map(record => (
        series.normalizedContract === 'FG2309'
          && record.tradingDate === '2023-08-09'
          ? {
              ...record,
              amount: record.amount === null ? null : record.amount * 0.9,
            }
          : record
      )),
    }));
    const report = matchThsGlassMainContracts(
      benchmark,
      candidates,
      REGRESSION_FIXTURE.tradingDates,
    );

    expect(report.activation.allowed).toBe(true);
    expect(report.matching.mappings).toEqual([
      { tradingDate: '2023-08-08', contract: 'FG2309' },
      { tradingDate: '2023-08-09', contract: 'FG2309' },
      { tradingDate: '2023-08-10', contract: 'FG2401' },
    ]);
    expect(report.matching.days[1]).toMatchObject({
      tradingDate: '2023-08-09',
      method: 'daily-relative-candidate-evidence',
      selectedContract: 'FG2309',
      dailyRelativeEvidence: {
        status: 'selected',
        bestContract: 'FG2309',
        runnerUpContract: 'FG2401',
      },
    });
    expect(report.matching.summary.dailyRelativeEvidenceMatches).toBe(1);
    expect(report.matching.summary.heuristicFallbackMatches).toBe(0);

    const rebuilt = rebuildThsGlassMainContractArtifacts(
      report,
      barsForRollover(benchmark),
    );

    expect(rebuilt.mappings[1]).toEqual({
      tradingDate: '2023-08-09',
      contract: 'FG2309',
    });
    expect(rebuilt.rollovers).toEqual([{
      tradingDate: '2023-08-10',
      time: '2023-08-09 21:00:00',
      timeMs: parseBeijing('2023-08-09 21:00:00'),
      fromContract: 'FG2309',
      toContract: 'FG2401',
    }]);
    expect(rebuilt.matchAudit).toEqual(report);
    expect(rebuilt.matchAudit).not.toBe(report);
  });

  it('refuses to rebuild mappings from a report that failed activation', () => {
    const benchmark = benchmarkBar('2023-08-09');
    const report = matchThsGlassMainContracts(
      [benchmark],
      [],
      ['2023-08-09'],
    );

    expect(() => rebuildThsGlassMainContractArtifacts(
      report,
      barsForRollover([benchmark]),
    )).toThrow(/未通过激活门禁/);
  });
});
