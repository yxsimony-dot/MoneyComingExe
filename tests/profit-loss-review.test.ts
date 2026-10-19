import { describe, expect, it } from 'vitest';
import {
  calculateMaxLots,
  reviewProfitLoss,
} from '../src/domain/profit-loss-review';
import { completeMinutesForFiveMinuteBar } from '../src/domain/market-data';
import { formatBeijing } from '../src/domain/time';
import { instrumentDefinition } from '../src/shared/instruments';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';
import { entryLifecycle, type WeeklyEntry } from '../src/domain/weekly-entry';

const M = 5 * 60_000;
const MINUTE = 60_000;
const DEFINITION = instrumentDefinition('main_continuous');

function beijingMs(time: string, date = '2026-02-02'): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function bar(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  session: Bar['session'] = 'day',
  date = '2026-02-02',
): Bar {
  const startMs = beijingMs(time, date);
  return {
    startMs,
    endMs: startMs + M,
    start: '',
    end: '',
    open,
    high,
    low,
    close,
    volume: 1,
    openOi: 1,
    closeOi: 1,
    session,
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
  };
}

function entry(triggerBar: Bar, direction: WeeklyEntry['direction']): WeeklyEntry {
  return {
    bar: triggerBar,
    triggerBar,
    direction,
    boundaryHigh: triggerBar.high,
    boundaryLow: triggerBar.low,
    midpoint: (triggerBar.high + triggerBar.low) / 2,
    ema20: triggerBar.close,
    pullbackLine: triggerBar.close,
    weekStart: '2026-02-02',
  };
}

function minute(startMs: number, open: number, high: number, low: number, close: number): EdbMinuteRecord {
  return {
    datetimeNano: String(BigInt(startMs) * 1_000_000n),
    startMs,
    start: formatBeijing(startMs),
    open,
    high,
    low,
    close,
    volume: 1,
    openOi: 1,
    closeOi: 1,
  };
}

describe('profit and loss review', () => {
  it('replays long take-profit, short stop-loss, and session-close trades', () => {
    const longTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-02');
    const longReaction = bar('09:05', 100, 103, 99, 102, 'day', '2026-02-02');
    const longEntry = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-02');
    const longTarget = bar('09:15', 100, 111, 102, 110, 'day', '2026-02-02');

    const shortTrigger = bar('09:00', 100, 103, 97, 100, 'day', '2026-02-03');
    const shortReaction = bar('09:05', 100, 102, 95, 96, 'day', '2026-02-03');
    const shortEntry = bar('09:10', 101, 102, 100, 101, 'day', '2026-02-03');
    const shortStop = bar('09:15', 101, 109, 100, 107, 'day', '2026-02-03');

    const closeTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-04');
    const closeReaction = bar('09:05', 100, 104, 99, 103, 'day', '2026-02-04');
    const closeEntry = bar('09:10', 101, 102, 100, 101, 'day', '2026-02-04');
    const forcedClose = bar('14:40', 100, 102, 99, 99, 'day', '2026-02-04');
    const bars = [
      longTrigger, longReaction, longEntry, longTarget,
      shortTrigger, shortReaction, shortEntry, shortStop,
      closeTrigger, closeReaction, closeEntry, forcedClose,
    ];
    const result = reviewProfitLoss([
      entry(longTrigger, 'long'),
      entry(shortTrigger, 'short'),
      entry(closeTrigger, 'long'),
    ], bars, [], DEFINITION);
    expect(result.completedTrades.map(trade => trade.exitType)).toEqual([
      'take-profit',
      'stop-loss',
      'session-close',
    ]);
    expect(result.completedTrades.map(trade => trade.lots)).toEqual([10000, 20792, 4323]);
    expect(result.completedTrades.map(trade => trade.capitalBefore)).toEqual([
      1_000_000,
      2_100_000,
      436_640,
    ]);
    expect(result).toMatchObject({
      instrument: 'main_continuous',
      instrumentName: '豆粕主连',
      priceTick: 1,
      contractMultiplier: 10,
      leverage: 10,
    });
    expect(result.completedTrades.map(trade => trade.cashPnl)).toEqual([1_100_000, -1_663_360, -86_460]);
    expect(result.completedTrades.map(trade => trade.capitalAfter)).toEqual([
      2_100_000,
      436_640,
      350_180,
    ]);
    expect(result.statistics).toMatchObject({
      candidateCount: 3,
      validEntryCount: 3,
      completedTradeCount: 3,
      incompleteTradeCount: 0,
      winningTradeCount: 1,
      losingTradeCount: 2,
      flatTradeCount: 0,
      takeProfitCount: 1,
      stopLossCount: 1,
      sessionCloseCount: 1,
      cumulativeProfit: 1_100_000,
      cumulativeLoss: -1_749_820,
      winRate: 1 / 3,
      profitLossRatio: 1_100_000 / 1_749_820,
    });
    expect(result.finalCapital).toBe(350_180);
    expect(result.statistics.maxDrawdown).toBe(1_749_820);
  });

  it('ignores candidates without a true entry and separates a data-end trade', () => {
    const noEntryTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-05');
    const noEntryFollow = bar('09:05', 100, 101, 99, 100, 'day', '2026-02-05');
    const incompleteTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-06');
    const incompleteReaction = bar('09:05', 100, 104, 99, 103, 'day', '2026-02-06');
    const incompleteEntry = bar('09:10', 100, 101, 99, 100, 'day', '2026-02-06');
    const incompleteFollow = bar('09:15', 100, 101, 99, 100, 'day', '2026-02-06');
    const result = reviewProfitLoss([
      entry(noEntryTrigger, 'long'),
      entry(incompleteTrigger, 'long'),
    ], [
      noEntryTrigger, noEntryFollow,
      incompleteTrigger, incompleteReaction, incompleteEntry, incompleteFollow,
    ], [], DEFINITION);

    expect(result.statistics.ignoredNoEntryCount).toBe(1);
    expect(result.statistics.validEntryCount).toBe(1);
    expect(result.completedTrades).toHaveLength(0);
    expect(result.incompleteTrades).toHaveLength(1);
    expect(result.incompleteTrades[0]).toMatchObject({
      direction: 'long',
      entryPrice: 101,
      lots: 9900,
      capitalBefore: 1_000_000,
      lifecycleEndReason: 'data-end',
    });
    expect(result.finalCapital).toBe(result.initialCapital);
    expect(result.statistics.winRate).toBe(0);
  });

  it('counts overlapping entries independently and orders the equity curve by exit event time', () => {
    const trigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-07');
    const reaction = bar('09:05', 100, 103, 99, 102, 'day', '2026-02-07');
    const entered = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-07');
    const target = bar('09:15', 100, 111, 102, 110, 'day', '2026-02-07');
    const result = reviewProfitLoss([
      entry(trigger, 'long'),
      entry(trigger, 'long'),
    ], [trigger, reaction, entered, target], [], DEFINITION);

    expect(result.completedTrades).toHaveLength(2);
    expect(result.completedTrades[0].id).not.toBe(result.completedTrades[1].id);
    expect(result.completedTrades.map(trade => trade.lots)).toEqual([10000, 10000]);
    expect(result.equityCurve.map(point => point.capital)).toEqual([2_100_000, 3_200_000]);
    expect(result.statistics.completedTradeCount).toBe(2);
  });

  it('replays two completed attempts from one 60-minute event with updated capital', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
      bar('13:45', 100, 105, 100, 104),
      bar('13:50', 104, 104, 102, 103),
      bar('13:55', 103, 115, 103, 114),
    ];
    const result = reviewProfitLoss([entry(bars[0], 'long')], bars, [], DEFINITION);

    expect(result.completedTrades).toHaveLength(2);
    expect(result.completedTrades.map(trade => trade.id)).toEqual([
      `review-0-attempt-1-long-${bars[0].startMs}`,
      `review-0-attempt-2-long-${bars[0].startMs}`,
    ]);
    expect(result.completedTrades[0]).toMatchObject({
      entryPrice: 101,
      exitPrice: 112,
      lots: 9900,
      capitalBefore: 1_000_000,
      cashPnl: 1_089_000,
      capitalAfter: 2_089_000,
      exitType: 'take-profit',
    });
    expect(result.completedTrades[1]).toMatchObject({
      entryPrice: 102,
      exitPrice: 115,
      lots: 20480,
      capitalBefore: 2_089_000,
      cashPnl: 2_662_400,
      capitalAfter: 4_751_400,
      exitType: 'take-profit',
    });
    expect(result.equityCurve.map(point => point.tradeId)).toEqual(
      result.completedTrades.map(trade => trade.id),
    );
    expect(result.equityCurve.map(point => point.capital)).toEqual([2_089_000, 4_751_400]);
    expect(result.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 2,
      completedTradeCount: 2,
      incompleteTradeCount: 0,
      winningTradeCount: 2,
      losingTradeCount: 0,
      takeProfitCount: 2,
      cumulativeProfit: 3_751_400,
      maxConsecutiveWins: 2,
    });
    expect(result.finalCapital).toBe(4_751_400);
  });

  it('lists an entered second attempt without an exit as a separate incomplete trade', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
      bar('13:45', 100, 105, 100, 104),
      bar('13:50', 104, 104, 102, 103),
      bar('13:55', 103, 104, 103, 104),
    ];
    const result = reviewProfitLoss([entry(bars[0], 'long')], bars, [], DEFINITION);

    expect(result.completedTrades).toHaveLength(1);
    expect(result.incompleteTrades).toHaveLength(1);
    expect(result.incompleteTrades[0]).toMatchObject({
      id: `review-0-attempt-2-long-${bars[0].startMs}`,
      entryPrice: 102,
      lots: 20480,
      capitalBefore: 2_089_000,
      lifecycleEndReason: 'data-end',
    });
    expect(result.statistics).toMatchObject({
      ignoredNoEntryCount: 0,
      validEntryCount: 2,
      completedTradeCount: 1,
      incompleteTradeCount: 1,
      winningTradeCount: 1,
      takeProfitCount: 1,
    });
    expect(result.finalCapital).toBe(2_089_000);
  });

  it('ignores a second trigger or range that never produces a true entry', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
      bar('13:45', 103, 104, 100, 101),
      bar('13:50', 101, 103, 98, 99),
      bar('13:55', 99, 106, 99, 105),
      bar('14:00', 98, 99, 97, 98),
    ];
    const result = reviewProfitLoss([entry(bars[0], 'long')], bars, [], DEFINITION);

    expect(result.completedTrades).toHaveLength(1);
    expect(result.incompleteTrades).toHaveLength(0);
    expect(result.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 1,
      completedTradeCount: 1,
      incompleteTradeCount: 0,
    });
    expect(result.completedTrades[0].id).toContain('attempt-1');
  });

  it('uses one-minute exit evidence time and calculates drawdown, streaks, and no-loss ratio safely', () => {
    const trigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-08');
    const reaction = bar('09:05', 100, 104, 99, 103, 'day', '2026-02-08');
    const entered = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-08');
    const target = { ...bar('09:15', 100, 116, 100, 110, 'day', '2026-02-08'), volume: 5 };
    const minutes = [
      minute(target.startMs, 100, 105, 100, 104),
      minute(target.startMs + MINUTE, 104, 116, 104, 111),
      minute(target.startMs + 2 * MINUTE, 111, 115, 110, 110),
      minute(target.startMs + 3 * MINUTE, 110, 111, 109, 110),
      minute(target.startMs + 4 * MINUTE, 110, 111, 109, 110),
    ];
    expect(completeMinutesForFiveMinuteBar(target, minutes)).toHaveLength(5);
    const result = reviewProfitLoss(
      [entry(trigger, 'long')],
      [trigger, reaction, entered, target],
      minutes,
      DEFINITION,
    );
    expect(result.completedTrades[0]).toMatchObject({
      exitType: 'take-profit',
      granularity: 'one-minute',
      exitMinuteStartMs: target.startMs + 60_000,
      exitTimeMs: target.startMs + 60_000,
      lots: 9900,
      capitalBefore: 1_000_000,
      cashPnl: 1_287_000,
    });
    expect(result.statistics).toMatchObject({
      maxDrawdown: 0,
      maxDrawdownRate: 0,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 0,
      profitLossRatio: null,
    });
  });

  it('uses the same reaction threshold as direct lifecycle calculation', () => {
    const bars = [
      bar('13:30', 100, 102, 90, 101),
      bar('13:35', 101, 104, 95, 103),
      bar('13:40', 103, 105, 93, 104),
      bar('13:45', 104, 128, 95, 127),
    ];
    const candidate = entry(bars[0], 'long');
    const oneTickSettings = { reactionBodyTicks: 1, entryRangePercent: 25 };
    const twoTickSettings = { reactionBodyTicks: 2, entryRangePercent: 25 };
    const oneTickLifecycle = entryLifecycle(candidate, bars, [], 1, oneTickSettings);
    const twoTickLifecycle = entryLifecycle(candidate, bars, [], 1, twoTickSettings);
    const oneTickReview = reviewProfitLoss([candidate], bars, [], DEFINITION, oneTickSettings);
    const twoTickReview = reviewProfitLoss([candidate], bars, [], DEFINITION, twoTickSettings);

    expect(oneTickLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 126,
      bar: bars[3],
    });
    expect(oneTickReview.completedTrades).toHaveLength(1);
    expect(oneTickReview.completedTrades[0]).toMatchObject({
      entryBar: oneTickLifecycle.quarterSignal?.entryBar,
      entryPrice: oneTickLifecycle.quarterSignal?.price,
      exitBar: oneTickLifecycle.exitAnalysis?.exitSignal?.bar,
      exitPrice: oneTickLifecycle.exitAnalysis?.exitSignal?.price,
    });
    expect(oneTickReview.finalCapital).toBeGreaterThan(oneTickReview.initialCapital);
    expect(oneTickReview.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 1,
      takeProfitCount: 1,
    });

    expect(twoTickLifecycle.exitAnalysis?.exitSignal).toBeUndefined();
    expect(twoTickReview.completedTrades).toHaveLength(0);
    expect(twoTickReview.incompleteTrades).toHaveLength(1);
    expect(twoTickReview.incompleteTrades[0]).toMatchObject({
      entryBar: twoTickLifecycle.quarterSignal?.entryBar,
      entryPrice: twoTickLifecycle.quarterSignal?.price,
    });
    expect(twoTickReview.finalCapital).toBe(twoTickReview.initialCapital);
    expect(twoTickReview.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 0,
      incompleteTradeCount: 1,
      takeProfitCount: 0,
    });
  });

  it('reuses the risk-edge lifecycle reaction, entry, exit, sizing, and capital in the full review', () => {
    const bars = [
      bar('13:30', 100, 106, 100, 102),
      bar('13:35', 102, 103, 100, 102),
      bar('13:40', 102, 106, 101, 105),
    ];
    const candidate = entry(bars[0], 'long');
    const settings = { reactionBodyTicks: 1, entryRangePercent: 67 };
    const lifecycle = entryLifecycle(candidate, bars, [], 1, settings);
    const review = reviewProfitLoss([candidate], bars, [], DEFINITION, settings);
    const attempt = lifecycle.attempts[0];
    const trade = review.completedTrades[0];

    expect(attempt.reactionRange).toMatchObject({
      reactionBar: bars[0],
      pricingMode: 'risk-edge',
      high: 106,
      low: 100,
    });
    expect(attempt.quarterSignal).toMatchObject({
      pricingMode: 'risk-edge',
      entryRangePercent: 67,
      entryDistanceTicks: 0,
      price: 100,
      entryBar: bars[1],
    });
    expect(attempt.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 106,
      bar: bars[2],
    });
    expect(review.completedTrades).toHaveLength(1);
    expect(trade).toMatchObject({
      reactionBar: attempt.reactionRange?.reactionBar,
      pricingMode: attempt.quarterSignal?.pricingMode,
      entryBar: attempt.quarterSignal?.entryBar,
      entryPrice: attempt.quarterSignal?.price,
      exitBar: attempt.exitAnalysis?.exitSignal?.bar,
      exitPrice: attempt.exitAnalysis?.exitSignal?.price,
      exitType: attempt.exitAnalysis?.exitSignal?.type,
      lots: 10_000,
      capitalBefore: 1_000_000,
      cashPnl: 600_000,
      capitalAfter: 1_600_000,
    });
    expect(review.finalCapital).toBe(1_600_000);
    expect(review.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 1,
      takeProfitCount: 1,
      cumulativeProfit: 600_000,
    });
  });

  it('uses the same entry percentage for lifecycle trades, capital, and review statistics', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
      bar('13:45', 100, 105, 100, 104),
      bar('13:50', 104, 104, 102, 103),
      bar('13:55', 103, 115, 103, 114),
    ];
    const candidate = entry(bars[0], 'long');
    const twentyFiveSettings = { reactionBodyTicks: 1, entryRangePercent: 25 };
    const hundredSettings = { reactionBodyTicks: 1, entryRangePercent: 100 };
    const twentyFiveLifecycle = entryLifecycle(candidate, bars, [], 1, twentyFiveSettings);
    const hundredLifecycle = entryLifecycle(candidate, bars, [], 1, hundredSettings);
    const twentyFiveReview = reviewProfitLoss([candidate], bars, [], DEFINITION, twentyFiveSettings);
    const hundredReview = reviewProfitLoss([candidate], bars, [], DEFINITION, hundredSettings);

    expect(twentyFiveLifecycle.attempts.map(attempt => attempt.quarterSignal?.price)).toEqual([101, 102]);
    expect(twentyFiveLifecycle.attempts.map(attempt => attempt.exitAnalysis?.exitSignal?.type)).toEqual([
      'take-profit',
      'take-profit',
    ]);
    expect(twentyFiveReview.completedTrades).toHaveLength(twentyFiveLifecycle.attempts.length);
    expect(twentyFiveReview.completedTrades.map(trade => trade.entryPrice)).toEqual(
      twentyFiveLifecycle.attempts.map(attempt => attempt.quarterSignal?.price),
    );
    expect(twentyFiveReview.statistics).toMatchObject({
      validEntryCount: 2,
      completedTradeCount: 2,
      takeProfitCount: 2,
    });
    expect(twentyFiveReview.finalCapital).toBe(4_751_400);

    expect(hundredLifecycle.attempts).toHaveLength(1);
    expect(hundredLifecycle.quarterSignal).toMatchObject({
      entryRangePercent: 100,
      price: 104,
      entryBar: bars[2],
    });
    expect(hundredReview.completedTrades).toHaveLength(1);
    expect(hundredReview.completedTrades[0]).toMatchObject({
      entryBar: hundredLifecycle.quarterSignal?.entryBar,
      entryPrice: hundredLifecycle.quarterSignal?.price,
      exitBar: hundredLifecycle.exitAnalysis?.exitSignal?.bar,
      exitPrice: hundredLifecycle.exitAnalysis?.exitSignal?.price,
      cashPnl: 0,
    });
    expect(hundredReview.incompleteTrades).toHaveLength(0);
    expect(hundredReview.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 1,
      completedTradeCount: 1,
      incompleteTradeCount: 0,
      flatTradeCount: 1,
      takeProfitCount: 1,
    });
    expect(hundredReview.finalCapital).toBe(hundredReview.initialCapital);
  });

  it('calculates whole lots with leverage and contract multipliers', () => {
    expect(calculateMaxLots(1_000_000, 3_000, 10)).toBe(333);
    expect(calculateMaxLots(1_000_000, 3_000, 20)).toBe(166);
    expect(calculateMaxLots(0, 3_000, 10)).toBe(0);
    expect(calculateMaxLots(1_000_000, 0, 10)).toBe(0);
    expect(calculateMaxLots(1_000_000, 3_000, 0)).toBe(0);
  });
});
