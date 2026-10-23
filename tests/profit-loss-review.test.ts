import { describe, expect, it } from 'vitest';
import {
  calculateMaxLots,
  reviewProfitLoss,
  reviewProfitLossLifecycles,
} from '../src/domain/profit-loss-review';
import { completeMinutesForFiveMinuteBar } from '../src/domain/market-data';
import { formatBeijing } from '../src/domain/time';
import { instrumentDefinition } from '../src/shared/instruments';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';
import {
  DEFAULT_ENTRY_STRATEGY_SETTINGS,
  entryLifecycle,
  filterEntryLifecycleByDateRange,
  type EntryExitType,
  type EntryLifecycle,
  type WeeklyEntry,
} from '../src/domain/weekly-entry';

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

function completedLifecycle(
  candidate: WeeklyEntry,
  entryBar: Bar,
  exitBar: Bar,
  exitType: EntryExitType,
  exitPrice: number,
  exitMinute?: EdbMinuteRecord,
): EntryLifecycle {
  const analysisBars = [candidate.triggerBar, entryBar, exitBar];
  const reactionRange = {
    direction: candidate.direction,
    pricingMode: 'configured-percent' as const,
    reactionBar: candidate.triggerBar,
    extremeBar: candidate.triggerBar,
    high: candidate.triggerBar.high,
    low: candidate.triggerBar.low,
  };
  const quarterSignal = {
    direction: candidate.direction,
    pricingMode: 'configured-percent' as const,
    price: entryBar.open,
    tick: 1,
    rangeTicks: candidate.triggerBar.high - candidate.triggerBar.low,
    entryRangePercent: 25,
    entryDistanceTicks: 1,
    quarterTicks: 1,
    lineStartBar: candidate.triggerBar,
    reactionBar: candidate.triggerBar,
    entryBar,
  };
  const exitAnalysis = {
    exitSignal: {
      direction: candidate.direction,
      type: exitType,
      price: exitPrice,
      bar: exitBar,
      minute: exitMinute,
      granularity: exitMinute ? 'one-minute' as const : 'five-minute-close' as const,
      lineEndMs: exitBar.endMs,
    },
  };
  const attempt = {
    number: 1 as const,
    triggerBar: candidate.triggerBar,
    analysisBars,
    reactionRange,
    quarterSignal,
    exitAnalysis,
    endReason: exitType,
  };
  return {
    analysisBars,
    focusBars: analysisBars,
    entryCutoff: exitBar.endMs,
    sessionEnd: exitBar.endMs,
    attempts: [attempt],
    abandonedSetups: [],
    reactionRange,
    quarterSignal,
    exitAnalysis,
    endReason: exitType,
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
    const oneTickSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reactionBodyTicks: 1,
      entryRangePercent: 25,
    };
    const twoTickSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reactionBodyTicks: 2,
      entryRangePercent: 25,
    };
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

  it('recalculates exit type, timing, capital, equity, and statistics from the target parameter', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 108, 101, 107),
      bar('13:45', 107, 107, 97, 98),
    ];
    const candidate = entry(bars[0], 'long');
    const baselineLifecycle = entryLifecycle(
      candidate,
      bars,
      [],
      1,
      DEFAULT_ENTRY_STRATEGY_SETTINGS,
    );
    const baselineReview = reviewProfitLoss(
      [candidate],
      bars,
      [],
      DEFINITION,
      DEFAULT_ENTRY_STRATEGY_SETTINGS,
    );
    const targetSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      takeProfitRangePercent: 100,
    };
    const targetLifecycle = entryLifecycle(candidate, bars, [], 1, targetSettings);
    const targetReview = reviewProfitLoss([candidate], bars, [], DEFINITION, targetSettings);

    expect(baselineLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'stop-loss',
      price: 97,
      bar: bars[3],
    });
    expect(baselineReview.completedTrades[0]).toMatchObject({
      exitType: 'stop-loss',
      exitPrice: 97,
      exitBar: bars[3],
      lots: 9900,
      cashPnl: -396_000,
      capitalAfter: 604_000,
    });
    expect(baselineReview.statistics).toMatchObject({
      takeProfitCount: 0,
      stopLossCount: 1,
      winningTradeCount: 0,
      losingTradeCount: 1,
      cumulativeLoss: -396_000,
    });
    expect(baselineReview.equityCurve).toEqual([
      expect.objectContaining({ capital: 604_000, cashPnl: -396_000 }),
    ]);
    expect(baselineReview.finalCapital).toBe(604_000);

    expect(targetLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 108,
      bar: bars[2],
    });
    expect(targetReview.completedTrades[0]).toMatchObject({
      exitType: 'take-profit',
      exitPrice: 108,
      exitBar: bars[2],
      lots: 9900,
      cashPnl: 693_000,
      capitalAfter: 1_693_000,
    });
    expect(targetReview.statistics).toMatchObject({
      takeProfitCount: 1,
      stopLossCount: 0,
      winningTradeCount: 1,
      losingTradeCount: 0,
      cumulativeProfit: 693_000,
    });
    expect(targetReview.equityCurve).toEqual([
      expect.objectContaining({ capital: 1_693_000, cashPnl: 693_000 }),
    ]);
    expect(targetReview.finalCapital).toBe(1_693_000);
  });

  it('recalculates stop timing, cash loss, and final capital from the stop parameter', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 107, 98, 100),
      bar('13:45', 100, 103, 97, 98),
    ];
    const candidate = entry(bars[0], 'long');
    const halfStopSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      stopLossRangePercent: 50,
    };
    const baselineLifecycle = entryLifecycle(
      candidate,
      bars,
      [],
      1,
      DEFAULT_ENTRY_STRATEGY_SETTINGS,
    );
    const halfStopLifecycle = entryLifecycle(candidate, bars, [], 1, halfStopSettings);
    const baselineReview = reviewProfitLoss(
      [candidate],
      bars,
      [],
      DEFINITION,
      DEFAULT_ENTRY_STRATEGY_SETTINGS,
    );
    const halfStopReview = reviewProfitLoss([candidate], bars, [], DEFINITION, halfStopSettings);

    expect(baselineLifecycle.stopLossSignal?.price).toBe(97);
    expect(baselineLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'stop-loss',
      price: 97,
      bar: bars[3],
    });
    expect(halfStopLifecycle.stopLossSignal?.price).toBe(98);
    expect(halfStopLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'stop-loss',
      price: 98,
      bar: bars[2],
    });
    expect(baselineReview.completedTrades[0]).toMatchObject({
      exitPrice: 97,
      exitBar: bars[3],
      cashPnl: -396_000,
      capitalAfter: 604_000,
    });
    expect(halfStopReview.completedTrades[0]).toMatchObject({
      exitPrice: 98,
      exitBar: bars[2],
      cashPnl: -297_000,
      capitalAfter: 703_000,
    });
    expect(halfStopReview.statistics).toMatchObject({
      stopLossCount: 1,
      cumulativeLoss: -297_000,
      largestLoss: -297_000,
    });
    expect(halfStopReview.finalCapital).toBe(703_000);
  });

  it('reuses the risk-edge lifecycle reaction, entry, exit, sizing, and capital in the full review', () => {
    const bars = [
      bar('13:30', 100, 106, 100, 102),
      bar('13:35', 102, 103, 100, 102),
      bar('13:40', 102, 106, 101, 105),
    ];
    const candidate = entry(bars[0], 'long');
    const settings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reactionBodyTicks: 1,
      entryRangePercent: 67,
      stopLossRangePercent: 50,
      takeProfitRangePercent: 500,
    };
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
    expect(attempt.stopLossSignal?.price).toBe(97);
    expect(attempt.takeProfitSignal).toMatchObject({
      defaultPrice: 136,
      adjustedPrice: 106,
      riskTouchBar: bars[1],
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
    const twentyFiveSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reactionBodyTicks: 1,
      entryRangePercent: 25,
    };
    const hundredSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reactionBodyTicks: 1,
      entryRangePercent: 100,
    };
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

  it('replays both attempts with shared percentages and each attempt own reaction range', () => {
    const bars = [
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
      bar('13:45', 100, 105, 100, 104),
      bar('13:50', 104, 104, 102, 103),
      bar('13:55', 103, 115, 103, 114),
    ];
    const candidate = entry(bars[0], 'long');
    const settings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      stopLossRangePercent: 50,
      takeProfitRangePercent: 100,
    };
    const lifecycle = entryLifecycle(candidate, bars, [], 1, settings);
    const review = reviewProfitLoss([candidate], bars, [], DEFINITION, settings);

    expect(lifecycle.attempts.map(attempt => ({
      range: [attempt.reactionRange?.low, attempt.reactionRange?.high],
      stop: attempt.stopLossSignal?.price,
      target: attempt.takeProfitSignal?.defaultPrice,
      exitPrice: attempt.exitAnalysis?.exitSignal?.price,
    }))).toEqual([
      { range: [100, 104], stop: 98, target: 108, exitPrice: 108 },
      { range: [100, 105], stop: 97, target: 110, exitPrice: 110 },
    ]);
    expect(review.completedTrades).toHaveLength(2);
    expect(review.completedTrades.map(trade => ({
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      lots: trade.lots,
      capitalBefore: trade.capitalBefore,
      cashPnl: trade.cashPnl,
      capitalAfter: trade.capitalAfter,
    }))).toEqual([
      {
        entryPrice: 101,
        exitPrice: 108,
        lots: 9900,
        capitalBefore: 1_000_000,
        cashPnl: 693_000,
        capitalAfter: 1_693_000,
      },
      {
        entryPrice: 102,
        exitPrice: 110,
        lots: 16_598,
        capitalBefore: 1_693_000,
        cashPnl: 1_327_840,
        capitalAfter: 3_020_840,
      },
    ]);
    expect(review.statistics).toMatchObject({
      validEntryCount: 2,
      completedTradeCount: 2,
      takeProfitCount: 2,
      stopLossCount: 0,
      winningTradeCount: 2,
      cumulativeProfit: 2_020_840,
    });
    expect(review.equityCurve.map(point => point.capital)).toEqual([1_693_000, 3_020_840]);
    expect(review.finalCapital).toBe(3_020_840);
  });

  it('keeps capital and trade statistics unchanged when the lifecycle only has an abandonment', () => {
    const bars = [
      bar('13:00', 106, 107, 104, 105),
      bar('13:05', 105, 106, 103, 104),
      bar('13:10', 104, 105, 102, 103),
      bar('13:15', 103, 104, 101, 102),
      bar('13:20', 102, 103, 100, 101),
      bar('13:25', 101, 102, 99, 100),
      bar('13:30', 100, 104, 100, 103),
      bar('13:35', 103, 103, 101, 102),
      bar('13:40', 102, 112, 102, 111),
    ];
    const candidate = entry(bars[6], 'long');
    const disabledSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      oppositeCandleCount: 0,
    };
    const sixCandleSettings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      oppositeCandleCount: 6,
    };
    const disabledLifecycle = entryLifecycle(candidate, bars, [], 1, disabledSettings);
    const filteredLifecycle = entryLifecycle(candidate, bars, [], 1, sixCandleSettings);
    const disabledReview = reviewProfitLoss([candidate], bars, [], DEFINITION, disabledSettings);
    const filteredReview = reviewProfitLoss([candidate], bars, [], DEFINITION, sixCandleSettings);

    expect(disabledLifecycle.reactionRange?.reactionBar).toBe(bars[6]);
    expect(disabledLifecycle.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 112,
      bar: bars[8],
    });
    expect(disabledReview.completedTrades).toHaveLength(1);
    expect(disabledReview.completedTrades[0]).toMatchObject({
      reactionBar: disabledLifecycle.reactionRange?.reactionBar,
      entryBar: disabledLifecycle.quarterSignal?.entryBar,
      entryPrice: disabledLifecycle.quarterSignal?.price,
      exitBar: disabledLifecycle.exitAnalysis?.exitSignal?.bar,
      exitPrice: disabledLifecycle.exitAnalysis?.exitSignal?.price,
      cashPnl: 1_089_000,
      capitalAfter: 2_089_000,
    });
    expect(disabledReview.finalCapital).toBe(2_089_000);
    expect(disabledReview.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 1,
      winningTradeCount: 1,
      takeProfitCount: 1,
      ignoredNoEntryCount: 0,
    });

    expect(filteredLifecycle.attempts).toHaveLength(0);
    expect(filteredLifecycle.abandonedSetups).toHaveLength(1);
    expect(filteredLifecycle.abandonedSetups[0]).toMatchObject({
      triggerBar: bars[6],
      candidateBar: bars[6],
      reason: 'opposite-momentum',
    });
    expect(filteredReview.completedTrades).toHaveLength(0);
    expect(filteredReview.incompleteTrades).toHaveLength(0);
    expect(filteredReview.equityCurve).toHaveLength(0);
    expect(filteredReview.finalCapital).toBe(filteredReview.initialCapital);
    expect(filteredReview.statistics).toMatchObject({
      candidateCount: 1,
      validEntryCount: 0,
      completedTradeCount: 0,
      incompleteTradeCount: 0,
      winningTradeCount: 0,
      losingTradeCount: 0,
      flatTradeCount: 0,
      takeProfitCount: 0,
      stopLossCount: 0,
      sessionCloseCount: 0,
      cumulativeProfit: 0,
      cumulativeLoss: 0,
      winRate: 0,
      profitLossRatio: null,
      maxDrawdown: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      ignoredNoEntryCount: 1,
    });
  });

  it('ignores repeated abandonments while funding two formal trades in sequence', () => {
    const bars = [
      bar('13:30', 103, 104, 100, 102),
      bar('13:35', 102, 103, 99, 101),
      bar('13:40', 101, 105, 99, 104),
      bar('13:45', 99, 104, 99, 103),
      bar('13:50', 103, 103, 101, 102),
      bar('13:55', 102, 115, 102, 114),
      bar('14:00', 103, 104, 99, 102),
      bar('14:05', 102, 103, 98, 101),
      bar('14:10', 101, 105, 98, 104),
      bar('14:15', 98, 104, 98, 103),
      bar('14:20', 103, 103, 100, 102),
      bar('14:25', 102, 117, 102, 116),
    ];
    const candidate = entry(bars[0], 'long');
    const settings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      oppositeCandleCount: 2,
    };
    const lifecycle = entryLifecycle(candidate, bars, [], 1, settings);
    const review = reviewProfitLoss([candidate], bars, [], DEFINITION, settings);

    expect(lifecycle.abandonedSetups.map(setup => setup.candidateBar)).toEqual([
      bars[2],
      bars[8],
    ]);
    expect(lifecycle.attempts).toHaveLength(2);
    expect(lifecycle.attempts.map(attempt => attempt.number)).toEqual([1, 2]);
    expect(lifecycle.attempts.map(attempt => attempt.reactionRange?.reactionBar)).toEqual([
      bars[3],
      bars[9],
    ]);
    expect(review.completedTrades).toHaveLength(2);
    expect(review.incompleteTrades).toHaveLength(0);
    expect(review.completedTrades.map(trade => trade.reactionBar)).toEqual([
      bars[3],
      bars[9],
    ]);
    expect(review.completedTrades[1].capitalBefore).toBe(
      review.completedTrades[0].capitalAfter,
    );
    expect(review.finalCapital).toBe(review.completedTrades[1].capitalAfter);
    expect(review.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 2,
      completedTradeCount: 2,
      incompleteTradeCount: 0,
      winningTradeCount: 2,
      takeProfitCount: 2,
    });
  });

  it('uses the selected nonzero session exit minute for close price, capital, and statistics', () => {
    const bars = [
      bar('14:30', 100, 104, 100, 103),
      bar('14:35', 103, 105, 101, 103),
      bar('14:40', 103, 106, 101, 102),
      bar('14:45', 102, 106, 101, 104),
      bar('14:50', 104, 106, 101, 105),
      bar('14:55', 105, 106, 101, 104),
    ];
    const candidate = entry(bars[0], 'long');
    const fifteenMinutes = reviewProfitLoss([candidate], bars, [], DEFINITION, {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      sessionExitMinutes: 15,
    });
    const fiveMinutes = reviewProfitLoss([candidate], bars, [], DEFINITION, {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      sessionExitMinutes: 5,
    });

    expect(fifteenMinutes.completedTrades[0]).toMatchObject({
      entryPrice: 101,
      exitType: 'session-close',
      exitBar: bars[2],
      exitPrice: 102,
      cashPnl: 99_000,
      capitalAfter: 1_099_000,
    });
    expect(fiveMinutes.completedTrades[0]).toMatchObject({
      entryPrice: 101,
      exitType: 'session-close',
      exitBar: bars[4],
      exitPrice: 105,
      cashPnl: 396_000,
      capitalAfter: 1_396_000,
    });
    expect(fifteenMinutes.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 1,
      incompleteTradeCount: 0,
      sessionCloseCount: 1,
      cumulativeProfit: 99_000,
    });
    expect(fiveMinutes.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 1,
      incompleteTradeCount: 0,
      sessionCloseCount: 1,
      cumulativeProfit: 396_000,
    });
    expect(fiveMinutes.finalCapital).toBeGreaterThan(fifteenMinutes.finalCapital);
  });

  it('keeps a zero-minute natural-close position incomplete and out of realized capital', () => {
    const bars = [
      bar('14:50', 100, 104, 100, 103),
      bar('14:55', 103, 105, 101, 103),
    ];
    const result = reviewProfitLoss([entry(bars[0], 'long')], bars, [], DEFINITION, {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      sessionExitMinutes: 0,
    });

    expect(result.completedTrades).toHaveLength(0);
    expect(result.incompleteTrades).toHaveLength(1);
    expect(result.incompleteTrades[0]).toMatchObject({
      entryBar: bars[1],
      entryPrice: 101,
      lifecycleEndReason: 'open-position-session-end',
      capitalBefore: 1_000_000,
      lots: 9900,
    });
    expect(result.statistics).toMatchObject({
      validEntryCount: 1,
      completedTradeCount: 0,
      incompleteTradeCount: 1,
      sessionCloseCount: 0,
      cumulativeProfit: 0,
      cumulativeLoss: 0,
    });
    expect(result.totalPnl).toBe(0);
    expect(result.finalCapital).toBe(result.initialCapital);
  });

  it('changes the valid-entry set when the dynamic cutoff moves', () => {
    const bars = [
      bar('14:35', 100, 104, 100, 103),
      bar('14:40', 103, 105, 102, 104),
      bar('14:45', 104, 105, 101, 104),
      bar('14:50', 104, 106, 100, 103),
      bar('14:55', 103, 105, 100, 102),
    ];
    const candidate = entry(bars[0], 'long');
    const fifteenMinutes = reviewProfitLoss([candidate], bars, [], DEFINITION, {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      sessionExitMinutes: 15,
    });
    const fiveMinutes = reviewProfitLoss([candidate], bars, [], DEFINITION, {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      sessionExitMinutes: 5,
    });

    expect(fifteenMinutes.statistics).toMatchObject({
      ignoredNoEntryCount: 1,
      validEntryCount: 0,
      completedTradeCount: 0,
    });
    expect(fiveMinutes.completedTrades[0]).toMatchObject({
      entryBar: bars[2],
      exitType: 'session-close',
      exitBar: bars[3],
    });
    expect(fiveMinutes.statistics).toMatchObject({
      ignoredNoEntryCount: 0,
      validEntryCount: 1,
      completedTradeCount: 1,
      sessionCloseCount: 1,
    });
  });

  it('calculates whole lots with leverage and contract multipliers', () => {
    expect(calculateMaxLots(1_000_000, 3_000, 10)).toBe(333);
    expect(calculateMaxLots(1_000_000, 3_000, 20)).toBe(166);
    expect(calculateMaxLots(0, 3_000, 10)).toBe(0);
    expect(calculateMaxLots(1_000_000, 0, 10)).toBe(0);
    expect(calculateMaxLots(1_000_000, 3_000, 0)).toBe(0);
  });

  it('excludes out-of-range entries without counting them as ignored candidates', () => {
    const outsideTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-01');
    const outsideReaction = bar('09:05', 100, 103, 99, 102, 'day', '2026-02-01');
    const outsideEntry = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-01');
    const outsideTarget = bar('09:15', 100, 111, 102, 110, 'day', '2026-02-01');
    const insideTrigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-02');
    const insideReaction = bar('09:05', 100, 103, 99, 102, 'day', '2026-02-02');
    const insideEntry = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-02');
    const insideTarget = bar('09:15', 100, 111, 102, 110, 'day', '2026-02-02');
    const settings = {
      ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
      reviewStartDate: '2026-02-02',
      reviewEndDate: '2026-02-02',
    };
    const result = reviewProfitLoss([
      entry(outsideTrigger, 'long'),
      entry(insideTrigger, 'long'),
    ], [
      outsideTrigger, outsideReaction, outsideEntry, outsideTarget,
      insideTrigger, insideReaction, insideEntry, insideTarget,
    ], [], DEFINITION, settings);

    expect(result.completedTrades).toHaveLength(1);
    expect(result.completedTrades[0].entryBar).toBe(insideEntry);
    expect(result.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 1,
      completedTradeCount: 1,
    });
  });

  it.each([
    {
      exitType: 'take-profit' as const,
      exitPrice: 111,
      expectedCashPnl: 990_000,
      expectedCapital: 1_990_000,
    },
    {
      exitType: 'stop-loss' as const,
      exitPrice: 97,
      expectedCashPnl: -396_000,
      expectedCapital: 604_000,
    },
    {
      exitType: 'session-close' as const,
      exitPrice: 103,
      expectedCashPnl: 198_000,
      expectedCapital: 1_198_000,
    },
  ])('keeps a complete $exitType after the selected end date', ({
    exitType,
    exitPrice,
    expectedCashPnl,
    expectedCapital,
  }) => {
    const trigger = bar('14:30', 100, 104, 100, 103, 'day', '2026-02-02');
    const entered = bar('14:35', 101, 105, 100, 102, 'day', '2026-02-02');
    const afterEndExit = bar('09:00', 103, 112, 96, 104, 'day', '2026-02-03');
    const exitMinute = minute(afterEndExit.startMs + MINUTE, 103, 112, 96, 104);
    const candidate = entry(trigger, 'long');
    const lifecycle = completedLifecycle(
      candidate,
      entered,
      afterEndExit,
      exitType,
      exitPrice,
      exitMinute,
    );
    const range = {
      startDate: '2026-02-02',
      endDate: '2026-02-02',
    };
    const filtered = filterEntryLifecycleByDateRange(lifecycle, range);
    const result = reviewProfitLossLifecycles([
      { entry: candidate, lifecycle, sourceIndex: 0 },
    ], DEFINITION, range);

    expect(filtered?.analysisBars).toEqual([trigger, entered, afterEndExit]);
    expect(filtered?.attempts[0].analysisBars).toEqual([trigger, entered, afterEndExit]);
    expect(filtered?.attempts[0].exitAnalysis?.exitSignal).toMatchObject({
      type: exitType,
      price: exitPrice,
      bar: afterEndExit,
      minute: exitMinute,
      granularity: 'one-minute',
      lineEndMs: afterEndExit.endMs,
    });
    expect(result.incompleteTrades).toHaveLength(0);
    expect(result.completedTrades).toHaveLength(1);
    expect(result.completedTrades[0]).toMatchObject({
      entryBar: entered,
      entryTimeMs: entered.startMs,
      entryPrice: 101,
      exitType,
      exitBar: afterEndExit,
      exitTimeMs: exitMinute.startMs,
      exitMinuteStartMs: exitMinute.startMs,
      exitPrice,
      granularity: 'one-minute',
      lots: 9900,
      capitalBefore: 1_000_000,
      cashPnl: expectedCashPnl,
      capitalAfter: expectedCapital,
    });
    expect(result.finalCapital).toBe(expectedCapital);
    expect(result.totalPnl).toBe(expectedCashPnl);
    expect(result.statistics).toMatchObject({
      candidateCount: 1,
      ignoredNoEntryCount: 0,
      validEntryCount: 1,
      completedTradeCount: 1,
      incompleteTradeCount: 0,
      takeProfitCount: exitType === 'take-profit' ? 1 : 0,
      stopLossCount: exitType === 'stop-loss' ? 1 : 0,
      sessionCloseCount: exitType === 'session-close' ? 1 : 0,
      cumulativeProfit: Math.max(0, expectedCashPnl),
      cumulativeLoss: Math.min(0, expectedCashPnl),
    });
  });

  it('returns unchanged initial capital when the selected range has no entries', () => {
    const trigger = bar('09:00', 100, 102, 99, 100, 'day', '2026-02-01');
    const reaction = bar('09:05', 100, 103, 99, 102, 'day', '2026-02-01');
    const entered = bar('09:10', 100, 101, 100, 100, 'day', '2026-02-01');
    const target = bar('09:15', 100, 111, 102, 110, 'day', '2026-02-01');
    const result = reviewProfitLoss(
      [entry(trigger, 'long')],
      [trigger, reaction, entered, target],
      [],
      DEFINITION,
      {
        ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
        reviewStartDate: '2026-02-02',
        reviewEndDate: '2026-02-03',
      },
    );

    expect(result.completedTrades).toEqual([]);
    expect(result.incompleteTrades).toEqual([]);
    expect(result.finalCapital).toBe(1_000_000);
    expect(result.totalPnl).toBe(0);
    expect(result.statistics).toMatchObject({
      candidateCount: 0,
      ignoredNoEntryCount: 0,
      validEntryCount: 0,
    });
  });
});
