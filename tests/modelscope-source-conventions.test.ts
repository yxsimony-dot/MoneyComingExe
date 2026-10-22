import { describe, expect, it } from 'vitest';
// @ts-expect-error Data scripts are executable ESM JavaScript modules.
import * as sourceConventionAudit from '../scripts/audit-modelscope-source-conventions.mjs';
const {
  analyzeDceOpenInterestPropagation,
  applyDuplicateTimestampStrategy,
  compareBarsAgainstReference,
} = sourceConventionAudit;

function tick(
  timestampMs: number,
  lastPrice: number,
  volumeDelta: number,
  openInterest: number,
) {
  return {
    timestampMs,
    lastPrice,
    volumeDelta,
    openInterest,
    session: 'day',
  };
}

function bar(
  startMs: number,
  overrides: Record<string, number | boolean> = {},
) {
  return {
    startMs,
    endMs: startMs + 300_000,
    open: 3_000,
    high: 3_002,
    low: 2_999,
    close: 3_001,
    volume: 100,
    openOi: 10_000,
    closeOi: 10_001,
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
    ...overrides,
  };
}

describe('ModelScope source convention blocker audit', () => {
  it('filters duplicate timestamps without losing cumulative volume', () => {
    const ticks = [
      tick(1_000, 100, 10, 1_000),
      tick(1_000, 101, 5, 1_001),
      tick(2_000, 101, 0, 1_001),
      tick(3_000, 102, 7, 1_002),
    ];

    expect(applyDuplicateTimestampStrategy(
      ticks,
      'first-per-timestamp',
    )).toEqual([
      tick(1_000, 100, 10, 1_000),
      tick(2_000, 101, 5, 1_001),
      tick(3_000, 102, 7, 1_002),
    ]);
    expect(applyDuplicateTimestampStrategy(
      ticks,
      'last-per-timestamp',
    )).toEqual([
      tick(1_000, 101, 15, 1_001),
      tick(2_000, 101, 0, 1_001),
      tick(3_000, 102, 7, 1_002),
    ]);
    expect(applyDuplicateTimestampStrategy(
      ticks,
      'cumulative-volume-increase-only',
    )).toEqual([
      tick(1_000, 100, 10, 1_000),
      tick(1_000, 101, 5, 1_001),
      tick(3_000, 102, 7, 1_002),
    ]);
  });

  it('excludes candidate-only bars while retaining strict field mismatches', () => {
    const candidate = [
      bar(0),
      bar(300_000, { close: 3_005, volume: 105 }),
      bar(600_000),
    ];
    const reference = [
      bar(0),
      bar(300_000),
    ];

    expect(compareBarsAgainstReference(candidate, reference)).toMatchObject({
      comparedBars: 2,
      mismatchRows: 1,
      fieldMismatches: 2,
      missingCandidateBars: 0,
      candidateOnlyBarsExcluded: 1,
      fieldMismatchCounts: {
        close: 1,
        volume: 1,
      },
    });
  });

  it('detects cross-day open interest mismatch propagation and recovery', () => {
    const records = [
      {
        tradingDate: '2025-10-20',
        contract: 'm2601',
        bars5: [
          bar(0, { openOi: 900, closeOi: 1_010 }),
        ],
      },
      {
        tradingDate: '2025-10-21',
        contract: 'm2601',
        bars5: [
          bar(300_000, { openOi: 1_000, closeOi: 1_001 }),
          bar(600_000, { openOi: 1_001, closeOi: 1_002 }),
        ],
      },
    ];
    const reference = [
      bar(0, { openOi: 900, closeOi: 1_000 }),
      bar(300_000, { openOi: 1_000, closeOi: 1_001 }),
      bar(600_000, { openOi: 1_001, closeOi: 1_002 }),
    ];

    expect(analyzeDceOpenInterestPropagation(records, reference)).toMatchObject({
      adjacentPairs: 1,
      sameContractPairs: 1,
      comparablePairs: 1,
      previousCloseMismatchPairs: 1,
      rawCurrentOpenMismatchPairs: 0,
      normalizationChangedPairs: 1,
      propagatedPreviousCloseDifferencePairs: 1,
      normalizationIntroducedMismatchPairs: 1,
      normalizationResolvedMismatchPairs: 0,
      firstCloseRecoveredPairs: 1,
      nextOpenRecoveredPairs: 1,
    });
  });

  it('does not join open interest across a contract rollover', () => {
    const records = [
      {
        tradingDate: '2025-10-20',
        contract: 'm2601',
        bars5: [bar(0)],
      },
      {
        tradingDate: '2025-10-21',
        contract: 'm2605',
        bars5: [bar(300_000)],
      },
    ];

    expect(analyzeDceOpenInterestPropagation(
      records,
      [bar(0), bar(300_000)],
    )).toMatchObject({
      adjacentPairs: 1,
      sameContractPairs: 0,
      comparablePairs: 0,
      normalizationChangedPairs: 0,
    });
  });
});
