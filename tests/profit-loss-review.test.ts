import { describe, expect, it } from 'vitest';
import { reviewProfitLoss } from '../src/domain/profit-loss-review';
import { aggregateMinutes, completeMinutesForFiveMinuteBar } from '../src/domain/market-data';
import { formatBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';
import type { WeeklyEntry } from '../src/domain/weekly-entry';

const M = 5 * 60_000;
const MINUTE = 60_000;

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
    ], bars);

    expect(result.completedTrades.map(trade => trade.exitType)).toEqual([
      'take-profit',
      'stop-loss',
      'session-close',
    ]);
    expect(result.completedTrades.map(trade => trade.cashPnl)).toEqual([110, -80, -20]);
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
      cumulativeProfit: 110,
      cumulativeLoss: -100,
      winRate: 1 / 3,
      profitLossRatio: 110 / 100,
    });
    expect(result.finalCapital).toBe(1_000_010);
    expect(result.statistics.maxDrawdown).toBe(100);
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
    ]);

    expect(result.statistics.ignoredNoEntryCount).toBe(1);
    expect(result.statistics.validEntryCount).toBe(1);
    expect(result.completedTrades).toHaveLength(0);
    expect(result.incompleteTrades).toHaveLength(1);
    expect(result.incompleteTrades[0]).toMatchObject({
      direction: 'long',
      entryPrice: 101,
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
    ], [trigger, reaction, entered, target]);

    expect(result.completedTrades).toHaveLength(2);
    expect(result.completedTrades[0].id).not.toBe(result.completedTrades[1].id);
    expect(result.equityCurve.map(point => point.capital)).toEqual([1_000_000 + 110, 1_000_000 + 220]);
    expect(result.statistics.completedTradeCount).toBe(2);
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
    const result = reviewProfitLoss([entry(trigger, 'long')], [trigger, reaction, entered, target], minutes);

    expect(result.completedTrades[0]).toMatchObject({
      exitType: 'take-profit',
      granularity: 'one-minute',
      exitMinuteStartMs: target.startMs + 60_000,
      exitTimeMs: target.startMs + 60_000,
      cashPnl: 130,
    });
    expect(result.statistics).toMatchObject({
      maxDrawdown: 0,
      maxDrawdownRate: 0,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 0,
      profitLossRatio: null,
    });
  });
});
