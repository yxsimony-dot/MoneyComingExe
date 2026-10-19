import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DEFAULT_ENTRY_STRATEGY_SETTINGS,
  DEFAULT_ENTRY_RANGE_PERCENT,
  ENTRY_SESSION_POLICIES,
  MAX_ENTRY_RANGE_PERCENT,
  MAX_REACTION_BODY_TICKS,
  MIN_ENTRY_RANGE_PERCENT,
  MIN_REACTION_BODY_TICKS,
  analyzeEntryExit,
  analyzeWeeklyEntries,
  entryExitDecisionUnits,
  entryLifecycle as entryLifecycleWithTick,
  entryObservationLine,
  entryObservationWindow,
  entryQuarterSignal as entryQuarterSignalWithTick,
  entryReactionRange as entryReactionRangeWithTick,
  entryStopLossSignal as entryStopLossSignalWithTick,
  entryTakeProfitSignal as entryTakeProfitSignalWithTick,
  selectWeeklyEntry,
  validateEntryStrategySettings,
  weeklyEntryMarkerId,
  type EntryStrategySettings,
  type EntryQuarterSignal,
  type EntryReactionRange,
  type WeeklyEntry,
} from '../src/domain/weekly-entry';
import { exponentialMovingAverage } from '../src/domain/ema';
import { parseBars } from '../src/domain/data';
import { formatBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';
import type { EmaPoint } from '../src/domain/ema';

const H = 3_600_000; const M = 5 * 60_000;
const TEST_PRICE_TICK = 1;
const TWO_TICK_REACTION = { reactionBodyTicks: 2, entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT };

const entryReactionRange = (
  direction: WeeklyEntry['direction'],
  bars: Bar[],
  tick = TEST_PRICE_TICK,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
) => entryReactionRangeWithTick(direction, bars, tick, settings);

const entryQuarterSignal = (
  range: EntryReactionRange,
  bars: readonly Bar[],
  tick = TEST_PRICE_TICK,
  entryCutoff = Number.POSITIVE_INFINITY,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
) => entryQuarterSignalWithTick(range, bars, tick, entryCutoff, settings);

const entryStopLossSignal = (
  range: EntryReactionRange,
  tick = TEST_PRICE_TICK,
) => entryStopLossSignalWithTick(range, tick);

const entryTakeProfitSignal = (
  range: EntryReactionRange,
  bars: readonly Bar[],
  quarterSignal: EntryQuarterSignal,
  tick = TEST_PRICE_TICK,
) => entryTakeProfitSignalWithTick(range, bars, quarterSignal, tick);

const entryLifecycle = (
  entry: WeeklyEntry,
  bars: readonly Bar[],
  minutes: readonly EdbMinuteRecord[] = [],
  tick = TEST_PRICE_TICK,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
) => entryLifecycleWithTick(entry, bars, minutes, tick, settings);
function bar(startMs: number, high: number, low: number, duration = H, expectedMinutes = 60): Bar {
  return { startMs, endMs: startMs + duration, start: '', end: '', open: (high + low) / 2, high, low, close: (high + low) / 2,
    volume: 1, openOi: 1, closeOi: 1, session: 'day', observedMinutes: expectedMinutes, expectedMinutes, complete: true };
}
function candle(index: number, open: number, high: number, low: number, close: number): Bar {
  return { ...bar(monday + index * M, high, low, M, 5), open, close };
}
const monday = Date.UTC(2026, 1, 2, 1); // 09:00 Beijing
function beijingMs(time: string, date = '2026-02-02'): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}
function sessionCandle(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  session: Bar['session'] = 'day',
  date = '2026-02-02',
): Bar {
  return {
    ...bar(beijingMs(time, date), high, low, M, 5),
    open,
    close,
    session,
  };
}
function lifecycleEntry(triggerBar: Bar, direction: WeeklyEntry['direction']): WeeklyEntry {
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
function minuteRecord(
  startMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
): EdbMinuteRecord {
  return {
    datetimeNano: String(BigInt(startMs) * 1_000_000n),
    startMs,
    start: formatBeijing(startMs),
    open,
    high,
    low,
    close,
    volume: 1,
    openOi: 10,
    closeOi: 10,
  };
}
function minuteBackedCandle(
  index: number,
  values: Array<[open: number, high: number, low: number, close: number]>,
): { bar: Bar; minutes: EdbMinuteRecord[] } {
  if (values.length !== 5) throw new Error('Minute-backed candle requires exactly five rows.');
  const startMs = monday + index * M;
  const minutes = values.map((value, minuteIndex) =>
    minuteRecord(startMs + minuteIndex * 60_000, ...value));
  return {
    bar: {
      ...candle(
        index,
        minutes[0].open,
        Math.max(...minutes.map(record => record.high)),
        Math.min(...minutes.map(record => record.low)),
        minutes.at(-1)!.close,
      ),
      volume: 5,
      openOi: 10,
      closeOi: 10,
    },
    minutes,
  };
}
function build(hours: number[], overrides: Record<string, [number, number]> = {}) {
  const h60 = hours.map((_, i) => bar(monday + i * H, 100, 90));
  const m5: Bar[] = [];
  for (let i = 0; i < hours.length; i++) for (let j = 0; j < 12; j++) {
    const key = `${i}:${j}`; const [high, low] = overrides[key] || [100, 90];
    m5.push(bar(monday + i * H + j * M, high, low, M, 5));
  }
  for (let i = 0; i < h60.length; i++) {
    const children = m5.slice(i * 12, i * 12 + 12);
    h60[i] = { ...h60[i], high: Math.max(...children.map(child => child.high)), low: Math.min(...children.map(child => child.low)) };
  }
  const ema: EmaPoint[] = h60.map((b, i) => ({ bar: b, value: i ? 95 : 95 }));
  return { h60, m5, ema };
}

describe('5-minute entry observation window', () => {
  it('returns the trigger and next 15 records without price filtering', () => {
    const bars = Array.from({ length: 20 }, (_, index) => bar(monday + index * M, index % 2 ? 10 : 1, index % 2 ? 9 : 0, M, 5));
    expect(entryObservationWindow(bars[2], bars)).toEqual(bars.slice(2, 18));
  });

  it('continues across hour and Beijing date boundaries', () => {
    const beforeMidnight = Date.UTC(2026, 1, 2, 15, 30);
    const bars = Array.from({ length: 20 }, (_, index) => bar(beforeMidnight + index * M, 100, 90, M, 5));
    const result = entryObservationWindow(bars[0], bars);
    expect(result).toHaveLength(16);
    expect(result.at(-1)).toBe(bars[15]);
    expect(new Date(result[0].startMs + 8 * H).getUTCDate()).not.toBe(new Date(result.at(-1)!.startMs + 8 * H).getUTCDate());
  });

  it('truncates at the dataset end and returns empty when the trigger is absent', () => {
    const bars = Array.from({ length: 5 }, (_, index) => bar(monday + index * M, 100, 90, M, 5));
    expect(entryObservationWindow(bars[3], bars)).toEqual(bars.slice(3));
    expect(entryObservationWindow(bar(monday - M, 100, 90, M, 5), bars)).toEqual([]);
  });

  it('builds a per-bar line from the lower long or higher short pullback/5-minute EMA20 value', () => {
    const observation = Array.from({ length: 4 }, (_, index) => bar(monday + index * M, 110, 90, M, 5));
    const emaByStart = new Map(observation.map((item, index) => [item.startMs, [105, 98, 101, 95][index]]));
    const long = entryObservationLine({ direction: 'long', pullbackLine: 100 }, observation, emaByStart);
    const short = entryObservationLine({ direction: 'short', pullbackLine: 100 }, observation, emaByStart);
    expect(long.map(point => point.value)).toEqual([100, 98, 100, 95]);
    expect(short.map(point => point.value)).toEqual([105, 100, 101, 100]);
    expect(long.map(point => point.ema20)).toEqual([105, 98, 101, 95]);
    expect(long.map(point => point.bar)).toEqual(observation);
  });
});

describe('session-bounded entry lifecycle', () => {
  it('defines the confirmed day and night boundaries', () => {
    expect(ENTRY_SESSION_POLICIES.day).toMatchObject({
      entryCutoffIndex: 210,
      sessionEndIndex: 225,
      forcedExitBarStartIndex: 205,
      entryCutoffWallTime: '14:45',
      sessionEndWallTime: '15:00',
    });
    expect(ENTRY_SESSION_POLICIES.night).toMatchObject({
      entryCutoffIndex: 105,
      sessionEndIndex: 120,
      forcedExitBarStartIndex: 100,
      entryCutoffWallTime: '22:45',
      sessionEndWallTime: '23:00',
    });
  });

  it('keeps the day-session lunch gap but never joins night or the next Beijing date', () => {
    const trigger = sessionCandle('09:50', 100, 101, 98, 99);
    const sameDay = [
      trigger,
      sessionCandle('09:55', 99, 100, 97, 98),
      sessionCandle('10:30', 98, 101, 97, 100),
      sessionCandle('10:35', 100, 101, 99, 100),
    ];
    const night = sessionCandle('21:00', 100, 101, 99, 100, 'night');
    const nextDay = sessionCandle('09:00', 100, 101, 99, 100, 'day', '2026-02-03');
    const result = entryLifecycle(lifecycleEntry(trigger, 'long'), [...sameDay, night, nextDay]);

    expect(result.analysisBars).toEqual(sameDay);
    expect(result.endReason).toBe('data-end');
  });

  it('returns an empty data-end lifecycle when the trigger record is absent', () => {
    const trigger = sessionCandle('14:30', 100, 104, 100, 103);
    const result = entryLifecycle(
      lifecycleEntry(trigger, 'long'),
      [sessionCandle('14:35', 103, 105, 102, 104)],
    );
    expect(result).toMatchObject({
      analysisBars: [],
      focusBars: [],
      entryCutoff: beijingMs('14:45'),
      sessionEnd: beijingMs('15:00'),
      endReason: 'data-end',
    });
  });

  it('separates a long full lifecycle from the compact 16-bar click focus', () => {
    const bars = Array.from({ length: 18 }, (_, index) => {
      const start = beijingMs('13:30') + index * M;
      return {
        ...bar(start, 110, 105, M, 5),
        open: 109,
        close: index === 0 ? 108 : 107,
      };
    });
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars);

    expect(result.analysisBars).toEqual(bars);
    expect(result.focusBars).toEqual(bars.slice(0, 16));
    expect(result.endReason).toBe('no-entry-session-end');
  });

  it.each([
    {
      label: 'day long',
      session: 'day' as const,
      times: ['14:35', '14:40'],
      direction: 'long' as const,
      values: [
        [100, 104, 100, 103],
        [103, 105, 101, 103],
      ] as const,
      close: 103,
      cutoff: '14:45',
      end: '15:00',
    },
    {
      label: 'day short',
      session: 'day' as const,
      times: ['14:35', '14:40'],
      direction: 'short' as const,
      values: [
        [104, 104, 100, 101],
        [101, 103, 99, 101],
      ] as const,
      close: 101,
      cutoff: '14:45',
      end: '15:00',
    },
    {
      label: 'night long',
      session: 'night' as const,
      times: ['22:35', '22:40'],
      direction: 'long' as const,
      values: [
        [100, 104, 100, 103],
        [103, 105, 101, 103],
      ] as const,
      close: 103,
      cutoff: '22:45',
      end: '23:00',
    },
    {
      label: 'night short',
      session: 'night' as const,
      times: ['22:35', '22:40'],
      direction: 'short' as const,
      values: [
        [104, 104, 100, 101],
        [101, 103, 99, 101],
      ] as const,
      close: 101,
      cutoff: '22:45',
      end: '23:00',
    },
  ])('allows entry on the forced-close bar and closes at its candle close: $label', ({
    session,
    times,
    direction,
    values,
    close,
    cutoff,
    end,
  }) => {
    const bars = times.map((time, index) => {
      const [open, high, low, candleClose] = values[index];
      return sessionCandle(time, open, high, low, candleClose, session);
    });
    const result = entryLifecycle(lifecycleEntry(bars[0], direction), bars);

    expect(result.entryCutoff).toBe(beijingMs(cutoff));
    expect(result.sessionEnd).toBe(beijingMs(end));
    expect(result.quarterSignal?.entryBar).toBe(bars[1]);
    expect(result.forcedExitBar).toBe(bars[1]);
    expect(result.exitAnalysis?.exitSignal).toMatchObject({
      type: 'session-close',
      price: close,
      bar: bars[1],
      granularity: 'five-minute-close',
      lineEndMs: bars[1].endMs,
    });
    expect(result.endReason).toBe('session-close');
    expect(result.analysisBars).toEqual(bars);
  });

  it.each([
    { session: 'day' as const, times: ['14:35', '14:40', '14:45', '14:50', '14:55'] },
    { session: 'night' as const, times: ['22:35', '22:40', '22:45', '22:50', '22:55'] },
  ])('rejects a first entry touch at the cutoff and ends without a fabricated exit', ({ session, times }) => {
    const bars = [
      sessionCandle(times[0], 100, 104, 100, 103, session),
      sessionCandle(times[1], 103, 105, 102, 104, session),
      sessionCandle(times[2], 104, 105, 101, 104, session),
      sessionCandle(times[3], 104, 106, 101, 105, session),
      sessionCandle(times[4], 105, 106, 101, 105, session),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars);

    expect(result.quarterSignal).toMatchObject({
      price: 101,
      searchStartBar: bars[1],
      entryBar: undefined,
    });
    expect(result.exitAnalysis?.exitSignal).toBeUndefined();
    expect(result.endReason).toBe('no-entry-session-end');
    expect(result.analysisBars).toEqual(bars);
  });

  it('keeps a reaction range formed after cutoff but never opens a position', () => {
    const bars = [
      sessionCandle('14:45', 103, 104, 100, 101),
      sessionCandle('14:50', 101, 105, 99, 104),
      sessionCandle('14:55', 104, 105, 100, 103),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars);

    expect(result.reactionRange).toMatchObject({
      reactionBar: bars[1],
      high: 105,
      low: 99,
    });
    expect(result.quarterSignal).toMatchObject({
      price: 101,
      searchStartBar: bars[2],
      entryBar: undefined,
    });
    expect(result.stopLossSignal).toBeDefined();
    expect(result.takeProfitSignal).toBeDefined();
    expect(result.exitAnalysis).toEqual({});
    expect(result.endReason).toBe('no-entry-session-end');
  });

  it('gives take-profit and stop-loss priority over the forced session close', () => {
    const trigger = sessionCandle('14:30', 100, 104, 100, 103);
    const entry = sessionCandle('14:35', 103, 105, 101, 103);
    const takeProfit = sessionCandle('14:40', 103, 112, 102, 110);
    const profit = entryLifecycle(lifecycleEntry(trigger, 'long'), [trigger, entry, takeProfit]);
    expect(profit.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 112,
      bar: takeProfit,
    });
    expect(profit.endReason).toBe('take-profit');

    const stop = sessionCandle('14:40', 101, 103, 97, 98);
    const loss = entryLifecycle(lifecycleEntry(trigger, 'long'), [trigger, entry, stop]);
    expect(loss.exitAnalysis?.exitSignal).toMatchObject({
      type: 'stop-loss',
      price: 97,
      bar: stop,
    });
    expect(loss.endReason).toBe('stop-loss');
  });

  it('uses complete minute order on the forced bar before falling back to its close', () => {
    const trigger = sessionCandle('14:35', 100, 104, 100, 103);
    const forced = minuteBackedCandle(67, [
      [103, 104, 101, 102],
      [102, 103, 100, 101],
      [101, 105, 101, 104],
      [104, 105, 103, 104],
      [104, 105, 103, 104],
    ]);
    const forcedBar = {
      ...forced.bar,
      startMs: beijingMs('14:40'),
      endMs: beijingMs('14:45'),
      session: 'day' as const,
    };
    const minutes = forced.minutes.map((minute, index) => ({
      ...minute,
      startMs: forcedBar.startMs + index * 60_000,
      datetimeNano: String(BigInt(forcedBar.startMs + index * 60_000) * 1_000_000n),
      start: formatBeijing(forcedBar.startMs + index * 60_000),
    }));
    const result = entryLifecycle(lifecycleEntry(trigger, 'long'), [trigger, forcedBar], minutes);

    expect(result.quarterSignal?.entryBar).toBe(forcedBar);
    expect(result.exitAnalysis?.riskTouchSignal).toMatchObject({
      bar: forcedBar,
      minute: minutes[1],
      granularity: 'one-minute',
    });
    expect(result.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 104,
      bar: forcedBar,
      minute: minutes[2],
      granularity: 'one-minute',
    });
    expect(result.endReason).toBe('take-profit');
  });

  it('stays data-end when data stops before the forced bar or final session bar', () => {
    const enteredBars = [
      sessionCandle('14:25', 100, 104, 100, 103),
      sessionCandle('14:30', 103, 105, 101, 103),
      sessionCandle('14:35', 103, 106, 102, 104),
    ];
    const entered = entryLifecycle(lifecycleEntry(enteredBars[0], 'long'), enteredBars);
    expect(entered.quarterSignal?.entryBar).toBe(enteredBars[1]);
    expect(entered.exitAnalysis?.exitSignal).toBeUndefined();
    expect(entered.endReason).toBe('data-end');

    const waitingBars = [
      sessionCandle('14:35', 100, 104, 100, 103),
      sessionCandle('14:40', 103, 105, 102, 104),
      sessionCandle('14:45', 104, 106, 102, 105),
      sessionCandle('14:50', 105, 107, 102, 106),
    ];
    const waiting = entryLifecycle(lifecycleEntry(waitingBars[0], 'long'), waitingBars);
    expect(waiting.quarterSignal?.entryBar).toBeUndefined();
    expect(waiting.endReason).toBe('data-end');
    expect(waiting.analysisBars).toEqual(waitingBars);
  });

  it('replaces the complete lifecycle when the reaction threshold changes', () => {
    const bars = [
      sessionCandle('13:30', 100, 102, 90, 101),
      sessionCandle('13:35', 101, 104, 95, 103),
      sessionCandle('13:40', 103, 105, 93, 104),
      sessionCandle('13:45', 104, 128, 95, 127),
    ];
    const entry = lifecycleEntry(bars[0], 'long');
    const oneTick = entryLifecycle(entry, bars, [], 1, {
      reactionBodyTicks: 1,
      entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT,
    });
    const twoTicks = entryLifecycle(entry, bars, [], 1, TWO_TICK_REACTION);

    expect(oneTick.reactionRange).toMatchObject({
      reactionBar: bars[0],
      high: 102,
      low: 90,
    });
    expect(oneTick.quarterSignal).toMatchObject({ price: 93, entryBar: bars[2] });
    expect(oneTick.stopLossSignal?.price).toBe(81);
    expect(oneTick.takeProfitSignal?.defaultPrice).toBe(126);
    expect(oneTick.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 126,
      bar: bars[3],
    });

    expect(twoTicks.reactionRange).toMatchObject({
      reactionBar: bars[1],
      high: 104,
      low: 90,
    });
    expect(twoTicks.quarterSignal).toMatchObject({ price: 94, entryBar: bars[2] });
    expect(twoTicks.stopLossSignal?.price).toBe(79);
    expect(twoTicks.takeProfitSignal?.defaultPrice).toBe(132);
    expect(twoTicks.exitAnalysis?.exitSignal).toBeUndefined();
  });

  it('continues past a three-times-wick first candidate and rebuilds the full lifecycle from the later reaction', () => {
    const bars = [
      sessionCandle('13:30', 100, 108, 90, 102),
      sessionCandle('13:35', 102, 105, 95, 104),
      sessionCandle('13:40', 104, 104, 94, 95),
      sessionCandle('13:45', 95, 135, 95, 134),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars);

    expect(bars[0].high - bars[0].close).toBe((bars[0].close - bars[0].open) * 3);
    expect(result.reactionRange).toMatchObject({
      reactionBar: bars[1],
      extremeBar: bars[0],
      pricingMode: 'configured-percent',
      high: 105,
      low: 90,
    });
    expect(result.quarterSignal).toMatchObject({
      reactionBar: bars[1],
      pricingMode: 'configured-percent',
      price: 94,
      entryBar: bars[2],
    });
    expect(result.stopLossSignal?.price).toBe(78);
    expect(result.takeProfitSignal?.defaultPrice).toBe(135);
    expect(result.exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 135,
      bar: bars[3],
    });
  });

  it.each([
    {
      label: 'adjusted take profit',
      secondMinute: [100, 106, 100, 105] as [number, number, number, number],
      exitType: 'take-profit' as const,
      exitPrice: 106,
    },
    {
      label: 'stop loss wins a same-minute collision',
      secondMinute: [100, 106, 95, 101] as [number, number, number, number],
      exitType: 'stop-loss' as const,
      exitPrice: 95,
    },
  ])('feeds risk-edge entry pricing through stop, target, and one-minute exit ordering: $label', ({
    secondMinute,
    exitType,
    exitPrice,
  }) => {
    const trigger = sessionCandle('09:00', 100, 106, 100, 102);
    const entered = minuteBackedCandle(1, [
      [102, 102, 100, 100],
      secondMinute,
      [101, 102, 100, 101],
      [101, 102, 100, 101],
      [101, 102, 100, 101],
    ]);
    const result = entryLifecycle(
      lifecycleEntry(trigger, 'long'),
      [trigger, entered.bar],
      entered.minutes,
    );

    expect(result.reactionRange).toMatchObject({
      reactionBar: trigger,
      pricingMode: 'risk-edge',
      high: 106,
      low: 100,
    });
    expect(result.quarterSignal).toMatchObject({
      pricingMode: 'risk-edge',
      entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT,
      entryDistanceTicks: 0,
      price: 100,
      entryBar: entered.bar,
    });
    expect(result.stopLossSignal?.price).toBe(95);
    expect(result.takeProfitSignal).toMatchObject({
      defaultPrice: 118,
      adjustedPrice: 106,
      riskTouchBar: entered.bar,
    });
    expect(result.exitAnalysis?.riskTouchSignal).toMatchObject({
      bar: entered.bar,
      minute: entered.minutes[0],
      granularity: 'one-minute',
    });
    expect(result.exitAnalysis?.exitSignal).toMatchObject({
      type: exitType,
      price: exitPrice,
      bar: entered.bar,
      minute: entered.minutes[1],
      granularity: 'one-minute',
    });
  });
});

describe('second entry attempt trigger', () => {
  it('classifies a normal first attempt and a risk-edge second attempt independently and never starts a third', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 112, 102, 111),
      sessionCandle('13:45', 100, 106, 100, 102),
      sessionCandle('13:50', 102, 103, 100, 102),
      sessionCandle('13:55', 102, 106, 101, 105),
      sessionCandle('14:00', 100, 101, 90, 91),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].reactionRange).toMatchObject({
      reactionBar: bars[0],
      pricingMode: 'configured-percent',
    });
    expect(result.attempts[0].quarterSignal).toMatchObject({
      pricingMode: 'configured-percent',
      price: 101,
    });
    expect(result.attempts[1].triggerBar).toBe(bars[3]);
    expect(result.attempts[1].reactionRange).toMatchObject({
      reactionBar: bars[3],
      pricingMode: 'risk-edge',
      high: 106,
      low: 100,
    });
    expect(result.attempts[1].quarterSignal).toMatchObject({
      pricingMode: 'risk-edge',
      entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT,
      entryDistanceTicks: 0,
      price: 100,
      entryBar: bars[4],
    });
    expect(result.attempts[1].exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 106,
      bar: bars[5],
    });
    expect(result.analysisBars).toEqual(bars.slice(0, 6));
    expect(result.endReason).toBe('take-profit');
  });

  it.each([
    {
      label: 'long equality touch',
      direction: 'long' as const,
      values: [
        [100, 104, 100, 103],
        [103, 103, 101, 102],
        [102, 112, 102, 111],
        [100, 105, 100, 104],
        [104, 104, 102, 103],
        [103, 115, 103, 114],
      ] as const,
      firstBoundary: 100,
      secondTriggerExtreme: 100,
      secondRange: { high: 105, low: 100 },
    },
    {
      label: 'short crossing touch',
      direction: 'short' as const,
      values: [
        [104, 104, 100, 101],
        [101, 103, 101, 102],
        [102, 102, 92, 93],
        [105, 105, 99, 100],
        [100, 103, 100, 101],
        [101, 101, 87, 88],
      ] as const,
      firstBoundary: 104,
      secondTriggerExtreme: 105,
      secondRange: { high: 105, low: 99 },
    },
  ])('starts a mirrored second attempt when the post-exit wick reaches the first risk edge: $label', ({
    direction,
    values,
    firstBoundary,
    secondTriggerExtreme,
    secondRange,
  }) => {
    const bars = values.map((value, index) =>
      sessionCandle(
        `13:${String(30 + index * 5).padStart(2, '0')}`,
        value[0],
        value[1],
        value[2],
        value[3],
      ));
    const result = entryLifecycle(lifecycleEntry(bars[0], direction), bars, [], 1);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      bar: bars[2],
    });
    expect(direction === 'long'
      ? result.attempts[0].reactionRange?.low
      : result.attempts[0].reactionRange?.high).toBe(firstBoundary);
    expect(result.attempts[1].triggerBar).toBe(bars[3]);
    expect(direction === 'long' ? bars[3].low : bars[3].high).toBe(secondTriggerExtreme);
    expect(result.attempts[1].reactionRange).toMatchObject({
      reactionBar: bars[3],
      extremeBar: bars[3],
      ...secondRange,
    });
    expect(result.attempts[1].exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      bar: bars[5],
    });
  });

  it('excludes the first exit candle itself from the second-trigger scan', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 103, 97, 98),
      sessionCandle('13:45', 102, 104, 101, 103),
      sessionCandle('13:50', 103, 105, 101, 104),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars, [], 1, TWO_TICK_REACTION);

    expect(result.attempts[0].exitAnalysis?.exitSignal).toMatchObject({
      type: 'stop-loss',
      bar: bars[2],
    });
    expect(bars[2].low).toBeLessThan(result.attempts[0].reactionRange!.low);
    expect(result.attempts).toHaveLength(1);
    expect(result.analysisBars).toEqual(bars);
    expect(result.endReason).toBe('data-end');
  });

  it('skips a one-tick second trigger reaction, keeps inclusive extremes, and never rebuilds the range', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 112, 102, 111),
      sessionCandle('13:45', 100, 104, 100, 101),
      sessionCandle('13:50', 101, 103, 98, 99),
      sessionCandle('13:55', 99, 106, 99, 105),
      sessionCandle('14:00', 98, 99, 97, 98),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars, [], 1, TWO_TICK_REACTION);
    const second = result.attempts[1];

    expect(second.triggerBar).toBe(bars[3]);
    expect(bars[3].close - bars[3].open).toBe(1);
    expect(second.reactionRange).toMatchObject({
      reactionBar: bars[5],
      extremeBar: bars[4],
      high: 106,
      low: 98,
    });
    expect(second.quarterSignal).toMatchObject({
      price: 100,
      searchStartBar: bars[6],
      entryBar: undefined,
    });
    expect(bars[5].low).toBeLessThanOrEqual(second.quarterSignal!.price);
    expect(bars[6].low).toBeLessThan(second.reactionRange!.low);
    expect(second.reactionRange?.low).toBe(98);
    expect(second.endReason).toBe('data-end');
  });

  it('keeps a second true entry unfinished at the current data end', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 112, 102, 111),
      sessionCandle('13:45', 100, 105, 100, 104),
      sessionCandle('13:50', 104, 104, 102, 103),
      sessionCandle('13:55', 103, 104, 103, 104),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars, [], 1);
    const second = result.attempts[1];

    expect(second.quarterSignal?.entryBar).toBe(bars[4]);
    expect(second.exitAnalysis?.exitSignal).toBeUndefined();
    expect(second.analysisBars).toEqual(bars.slice(3));
    expect(second.endReason).toBe('data-end');
    expect(result.endReason).toBe('data-end');
  });

  it('ends at the second actual exit and never creates a third attempt', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 112, 102, 111),
      sessionCandle('13:45', 100, 105, 100, 104),
      sessionCandle('13:50', 104, 104, 102, 103),
      sessionCandle('13:55', 103, 115, 103, 114),
      sessionCandle('14:00', 100, 101, 90, 91),
      sessionCandle('14:05', 91, 108, 91, 107),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars, [], 1);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].analysisBars).toEqual(bars.slice(0, 3));
    expect(result.attempts[1].analysisBars).toEqual(bars.slice(3, 6));
    expect(result.attempts[1].exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      bar: bars[5],
    });
    expect(result.analysisBars).toEqual(bars.slice(0, 6));
    expect(result.endReason).toBe('take-profit');
  });

  it('shares one entry percentage across both attempts without changing signals or reaction ranges', () => {
    const bars = [
      sessionCandle('13:30', 100, 104, 100, 103),
      sessionCandle('13:35', 103, 103, 101, 102),
      sessionCandle('13:40', 102, 112, 102, 111),
      sessionCandle('13:45', 100, 105, 100, 104),
      sessionCandle('13:50', 104, 104, 102, 103),
      sessionCandle('13:55', 103, 115, 103, 114),
    ];
    const candidate = lifecycleEntry(bars[0], 'long');
    const candidateSnapshot = structuredClone(candidate);
    const twentyFive = entryLifecycle(candidate, bars, [], 1, {
      reactionBodyTicks: 1,
      entryRangePercent: 25,
    });
    const fifty = entryLifecycle(candidate, bars, [], 1, {
      reactionBodyTicks: 1,
      entryRangePercent: 50,
    });
    const hundred = entryLifecycle(candidate, bars, [], 1, {
      reactionBodyTicks: 1,
      entryRangePercent: 100,
    });

    expect(twentyFive.attempts).toHaveLength(2);
    expect(fifty.attempts).toHaveLength(2);
    expect(twentyFive.attempts.map(attempt => attempt.quarterSignal?.entryRangePercent)).toEqual([25, 25]);
    expect(fifty.attempts.map(attempt => attempt.quarterSignal?.entryRangePercent)).toEqual([50, 50]);
    expect(twentyFive.attempts.map(attempt => attempt.quarterSignal?.price)).toEqual([101, 102]);
    expect(fifty.attempts.map(attempt => attempt.quarterSignal?.price)).toEqual([102, 103]);
    expect(fifty.attempts.map(attempt => attempt.quarterSignal?.entryBar)).toEqual([bars[1], bars[4]]);
    expect(fifty.attempts.map(attempt => attempt.stopLossSignal?.price)).toEqual(
      twentyFive.attempts.map(attempt => attempt.stopLossSignal?.price),
    );
    expect(fifty.attempts.map(attempt => attempt.takeProfitSignal?.defaultPrice)).toEqual(
      twentyFive.attempts.map(attempt => attempt.takeProfitSignal?.defaultPrice),
    );
    expect(fifty.attempts.map(attempt => attempt.exitAnalysis?.exitSignal)).toEqual(
      twentyFive.attempts.map(attempt => attempt.exitAnalysis?.exitSignal),
    );
    expect(fifty.attempts.map(attempt => attempt.reactionRange)).toEqual(
      twentyFive.attempts.map(attempt => attempt.reactionRange),
    );

    expect(hundred.attempts).toHaveLength(1);
    expect(hundred.attempts[0].quarterSignal).toMatchObject({
      entryRangePercent: 100,
      price: 104,
      entryBar: bars[2],
    });
    expect(hundred.attempts[0].reactionRange).toEqual(twentyFive.attempts[0].reactionRange);
    expect(hundred.attempts[0].takeProfitSignal).toMatchObject({
      adjustedPrice: 104,
      riskTouchBar: bars[3],
    });
    expect(hundred.attempts[0].exitAnalysis?.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 104,
      bar: bars[4],
    });
    expect(candidate).toEqual(candidateSnapshot);
  });

  it('keeps a second plan formed at the cutoff but forbids its true entry', () => {
    const bars = [
      sessionCandle('14:20', 100, 104, 100, 103),
      sessionCandle('14:25', 103, 103, 101, 102),
      sessionCandle('14:30', 102, 112, 102, 111),
      sessionCandle('14:35', 103, 105, 101, 104),
      sessionCandle('14:40', 104, 106, 101, 105),
      sessionCandle('14:45', 100, 105, 100, 104),
      sessionCandle('14:50', 104, 105, 102, 103),
      sessionCandle('14:55', 103, 105, 102, 104),
    ];
    const result = entryLifecycle(lifecycleEntry(bars[0], 'long'), bars, [], 1);
    const second = result.attempts[1];

    expect(second.triggerBar).toBe(bars[5]);
    expect(second.reactionRange?.reactionBar).toBe(bars[5]);
    expect(second.quarterSignal).toMatchObject({
      searchStartBar: bars[6],
      entryBar: undefined,
    });
    expect(second.endReason).toBe('no-entry-session-end');
    expect(result.analysisBars).toEqual(bars);
    expect(result.endReason).toBe('no-entry-session-end');
  });
});

describe('entry strategy settings', () => {
  it('defaults to one tick and 25 percent and accepts all configured boundaries', () => {
    expect(DEFAULT_ENTRY_STRATEGY_SETTINGS).toEqual({
      reactionBodyTicks: 1,
      entryRangePercent: 25,
    });
    expect(MIN_REACTION_BODY_TICKS).toBe(1);
    expect(MAX_REACTION_BODY_TICKS).toBe(20);
    expect(MIN_ENTRY_RANGE_PERCENT).toBe(0);
    expect(MAX_ENTRY_RANGE_PERCENT).toBe(100);
    expect(DEFAULT_ENTRY_RANGE_PERCENT).toBe(25);
    expect(validateEntryStrategySettings({
      reactionBodyTicks: 1,
      entryRangePercent: 0,
    })).toEqual({
      reactionBodyTicks: 1,
      entryRangePercent: 0,
    });
    expect(validateEntryStrategySettings({
      reactionBodyTicks: 20,
      entryRangePercent: 100,
    })).toEqual({
      reactionBodyTicks: 20,
      entryRangePercent: 100,
    });
  });

  it.each([0, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid reaction body tick value: %s',
    (reactionBodyTicks) => {
      expect(() => validateEntryStrategySettings({
        reactionBodyTicks,
        entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT,
      })).toThrow(RangeError);
    },
  );

  it.each([-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid entry range percent: %s',
    (entryRangePercent) => {
      expect(() => validateEntryStrategySettings({
        reactionBodyTicks: MIN_REACTION_BODY_TICKS,
        entryRangePercent,
      })).toThrow(RangeError);
    },
  );

  it('rejects invalid settings at lifecycle entry even without matching bars', () => {
    const trigger = sessionCandle('13:30', 100, 101, 99, 100);
    expect(() => entryLifecycle(
      lifecycleEntry(trigger, 'long'),
      [],
      [],
      1,
      { reactionBodyTicks: 0, entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT },
    )).toThrow(RangeError);
  });
});

describe('5-minute first reaction range', () => {
  it('treats a body exactly equal to the default one-tick threshold as a reaction', () => {
    const rising = candle(0, 100, 102, 99, 101);
    const falling = candle(1, 101, 102, 99, 100);

    expect(entryReactionRange('long', [rising])?.reactionBar).toBe(rising);
    expect(entryReactionRange('short', [falling])?.reactionBar).toBe(falling);
  });

  it('accepts a body exactly equal to the maximum 20-tick threshold', () => {
    const below = candle(0, 100, 120, 80, 119);
    const exact = candle(1, 119, 140, 79, 139);
    const result = entryReactionRange(
      'long',
      [below, exact],
      1,
      { reactionBodyTicks: 20, entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT },
    );

    expect(result).toMatchObject({
      reactionBar: exact,
      extremeBar: exact,
      high: 140,
      low: 79,
    });
  });

  it('uses the trigger candle itself for an immediate long or short reaction', () => {
    const rising = candle(0, 95, 103, 92, 101);
    const falling = candle(1, 101, 104, 91, 94);
    expect(entryReactionRange('long', [rising])).toEqual({
      direction: 'long', pricingMode: 'configured-percent',
      reactionBar: rising, extremeBar: rising, high: 103, low: 92,
    });
    expect(entryReactionRange('short', [falling])).toEqual({
      direction: 'short', pricingMode: 'configured-percent',
      reactionBar: falling, extremeBar: falling, high: 104, low: 91,
    });
  });

  it('skips doji and opposite candles, then uses the earlier long low or short high', () => {
    const longBars = [
      candle(0, 100, 104, 96, 100),
      candle(1, 100, 102, 91, 97),
      candle(2, 97, 100, 93, 95),
      candle(3, 95, 105, 94, 103),
    ];
    const shortBars = [
      candle(4, 100, 104, 96, 100),
      candle(5, 100, 109, 98, 104),
      candle(6, 104, 107, 99, 106),
      candle(7, 106, 108, 92, 95),
    ];
    expect(entryReactionRange('long', longBars)).toEqual({
      direction: 'long', pricingMode: 'configured-percent',
      reactionBar: longBars[3], extremeBar: longBars[1], high: 105, low: 91,
    });
    expect(entryReactionRange('short', shortBars)).toEqual({
      direction: 'short', pricingMode: 'configured-percent',
      reactionBar: shortBars[3], extremeBar: shortBars[1], high: 109, low: 92,
    });
  });

  it('skips one-tick directional candles but keeps them in the inclusive extreme', () => {
    const longBars = [
      candle(0, 100, 102, 90, 101),
      candle(1, 101, 104, 95, 103),
    ];
    const shortBars = [
      candle(2, 100, 110, 98, 99),
      candle(3, 99, 105, 96, 97),
    ];

    expect(entryReactionRange('long', longBars, 1, TWO_TICK_REACTION)).toEqual({
      direction: 'long', pricingMode: 'configured-percent',
      reactionBar: longBars[1], extremeBar: longBars[0], high: 104, low: 90,
    });
    expect(entryReactionRange('short', shortBars, 1, TWO_TICK_REACTION)).toEqual({
      direction: 'short', pricingMode: 'configured-percent',
      reactionBar: shortBars[1], extremeBar: shortBars[0], high: 110, low: 96,
    });
  });

  it('uses the configured tick count with a non-unit market tick', () => {
    const bars = [
      candle(0, 100, 101, 99, 100.25),
      candle(1, 100.25, 101.25, 100, 100.75),
    ];

    expect(entryReactionRange('long', bars, 0.25, TWO_TICK_REACTION)).toEqual({
      direction: 'long', pricingMode: 'configured-percent',
      reactionBar: bars[1], extremeBar: bars[0], high: 101.25, low: 99,
    });
    expect(() => entryReactionRange('long', bars, 0)).toThrow(RangeError);
  });

  it('includes the reaction candle when it sets the long low or short high', () => {
    const longBars = [
      candle(0, 100, 104, 96, 100),
      candle(1, 100, 102, 94, 97),
      candle(2, 97, 105, 91, 103),
    ];
    const shortBars = [
      candle(3, 100, 104, 96, 100),
      candle(4, 100, 106, 98, 104),
      candle(5, 104, 109, 92, 95),
    ];
    expect(entryReactionRange('long', longBars)).toEqual({
      direction: 'long', pricingMode: 'configured-percent',
      reactionBar: longBars[2], extremeBar: longBars[2], high: 105, low: 91,
    });
    expect(entryReactionRange('short', shortBars)).toEqual({
      direction: 'short', pricingMode: 'configured-percent',
      reactionBar: shortBars[2], extremeBar: shortBars[2], high: 109, low: 92,
    });
  });

  it('uses only the directional wick and mirrors long and short classification', () => {
    const long = candle(0, 100, 103, 80, 102);
    const short = candle(1, 102, 125, 99, 100);

    expect(entryReactionRange('long', [long])).toMatchObject({
      reactionBar: long,
      pricingMode: 'configured-percent',
    });
    expect(entryReactionRange('short', [short])).toMatchObject({
      reactionBar: short,
      pricingMode: 'configured-percent',
    });
  });

  it('uses inclusive two-times and three-times directional-wick boundaries', () => {
    const longBelowTwo = candle(0, 100, 105, 98, 102);
    const longAtTwo = candle(1, 100, 106, 98, 102);
    const longAtThree = candle(2, 100, 108, 97, 102);
    const longAfterReject = candle(3, 102, 105, 96, 104);
    const shortBelowTwo = candle(4, 102, 104, 97, 100);
    const shortAtTwo = candle(5, 102, 104, 96, 100);
    const shortAtThree = candle(6, 102, 105, 94, 100);
    const shortAfterReject = candle(7, 100, 106, 97, 98);

    expect(entryReactionRange('long', [longBelowTwo])?.pricingMode).toBe('configured-percent');
    expect(entryReactionRange('long', [longAtTwo])?.pricingMode).toBe('risk-edge');
    expect(entryReactionRange('long', [longAtThree, longAfterReject])).toMatchObject({
      reactionBar: longAfterReject,
      pricingMode: 'configured-percent',
    });
    expect(entryReactionRange('short', [shortBelowTwo])?.pricingMode).toBe('configured-percent');
    expect(entryReactionRange('short', [shortAtTwo])?.pricingMode).toBe('risk-edge');
    expect(entryReactionRange('short', [shortAtThree, shortAfterReject])).toMatchObject({
      reactionBar: shortAfterReject,
      pricingMode: 'configured-percent',
    });
  });

  it('keeps rejected candles in the risk extreme and uses the final accepted profit edge', () => {
    const rejectedLong = candle(0, 100, 108, 80, 102);
    const acceptedLong = candle(1, 102, 105, 95, 104);
    const rejectedShort = candle(2, 102, 120, 94, 100);
    const acceptedShort = candle(3, 100, 105, 97, 98);

    expect(entryReactionRange('long', [rejectedLong, acceptedLong])).toEqual({
      direction: 'long',
      pricingMode: 'configured-percent',
      reactionBar: acceptedLong,
      extremeBar: rejectedLong,
      high: 105,
      low: 80,
    });
    expect(entryReactionRange('short', [rejectedShort, acceptedShort])).toEqual({
      direction: 'short',
      pricingMode: 'configured-percent',
      reactionBar: acceptedShort,
      extremeBar: rejectedShort,
      high: 120,
      low: 97,
    });
  });

  it('returns no range when every body-qualified candle has a three-times wick', () => {
    const longBars = [
      candle(0, 100, 108, 90, 102),
      candle(1, 102, 110, 91, 104),
    ];
    const shortBars = [
      candle(2, 104, 115, 96, 102),
      candle(3, 102, 114, 94, 100),
    ];

    expect(entryReactionRange('long', longBars)).toBeUndefined();
    expect(entryReactionRange('short', shortBars)).toBeUndefined();
  });

  it('keeps the first candle when the inclusive extreme occurs more than once', () => {
    const longBars = [
      candle(0, 100, 104, 90, 98),
      candle(1, 98, 101, 90, 96),
      candle(2, 96, 105, 90, 103),
    ];
    const shortBars = [
      candle(3, 100, 110, 97, 103),
      candle(4, 103, 110, 99, 105),
      candle(5, 105, 110, 92, 96),
    ];
    expect(entryReactionRange('long', longBars)?.extremeBar).toBe(longBars[0]);
    expect(entryReactionRange('short', shortBars)?.extremeBar).toBe(shortBars[0]);
  });

  it('uses only the available short observation window and returns no range without a reaction', () => {
    const bars = [
      candle(0, 100, 103, 95, 98),
      candle(1, 98, 100, 94, 96),
      candle(2, 96, 99, 93, 94),
    ];
    const observation = entryObservationWindow(bars[0], bars);
    expect(observation).toHaveLength(3);
    expect(entryReactionRange('long', observation)).toBeUndefined();
    expect(entryReactionRange('short', observation)?.reactionBar).toBe(bars[0]);
    expect(entryReactionRange('long', [])).toBeUndefined();
  });

  it('does not mutate the observation, dynamic line, or weekly entry analysis', () => {
    const fixture = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const analysisBefore = analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema);
    const observation = entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5);
    const observationBefore = structuredClone(observation);
    const emaByStart = new Map(fixture.m5.map((item, index) => [item.startMs, 94 + index / 100]));
    const lineBefore = entryObservationLine(analysisBefore.entries[0], observation, emaByStart);

    entryReactionRange(analysisBefore.entries[0].direction, observation);

    expect(observation).toEqual(observationBefore);
    expect(entryObservationLine(analysisBefore.entries[0], observation, emaByStart)).toEqual(lineBefore);
    expect(analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema)).toEqual(analysisBefore);
  });
});

describe('5-minute quarter-range true entry', () => {
  const range = (
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    low: number,
    high: number,
    reactionIndex = 1,
    extremeIndex = 0,
    pricingMode: EntryReactionRange['pricingMode'] = 'configured-percent',
  ): EntryReactionRange => ({
    direction,
    pricingMode,
    reactionBar: bars[reactionIndex],
    extremeBar: bars[extremeIndex],
    high,
    low,
  });

  it('uses one shared market tick and mirrors the non-divisible 3020-3031 example', () => {
    const bars = [candle(0, 3022, 3024, 3020, 3021), candle(1, 3021, 3031, 3021, 3030)];
    const long = entryQuarterSignal(range('long', bars, 3020, 3031), bars);
    const short = entryQuarterSignal(range('short', bars, 3020, 3031), bars);

    expect(TEST_PRICE_TICK).toBe(1);
    expect(long).toMatchObject({
      direction: 'long',
      tick: 1,
      rangeTicks: 11,
      entryRangePercent: 25,
      entryDistanceTicks: 3,
      quarterTicks: 3,
      price: 3023,
    });
    expect(short).toMatchObject({
      direction: 'short',
      tick: 1,
      rangeTicks: 11,
      entryRangePercent: 25,
      entryDistanceTicks: 3,
      quarterTicks: 3,
      price: 3028,
    });
    expect(long.price / long.tick).toBe(Math.round(long.price / long.tick));
    expect(short.price / short.tick).toBe(Math.round(short.price / short.tick));
  });

  it('does not add a tick when the range is divisible by four', () => {
    const bars = [candle(0, 100, 100, 88, 90), candle(1, 90, 100, 88, 99)];
    expect(entryQuarterSignal(range('long', bars, 88, 100), bars)).toMatchObject({
      rangeTicks: 12, quarterTicks: 3, price: 91,
    });
    expect(entryQuarterSignal(range('short', bars, 88, 100), bars)).toMatchObject({
      rangeTicks: 12, quarterTicks: 3, price: 97,
    });
  });

  it('places zero and one hundred percent at mirrored range edges', () => {
    const bars = [candle(0, 100, 100, 88, 90), candle(1, 90, 100, 88, 99)];
    const zero = { ...DEFAULT_ENTRY_STRATEGY_SETTINGS, entryRangePercent: 0 };
    const hundred = { ...DEFAULT_ENTRY_STRATEGY_SETTINGS, entryRangePercent: 100 };

    expect(entryQuarterSignal(
      range('long', bars, 88, 100),
      bars,
      1,
      Number.POSITIVE_INFINITY,
      zero,
    )).toMatchObject({ entryDistanceTicks: 0, price: 88 });
    expect(entryQuarterSignal(
      range('short', bars, 88, 100),
      bars,
      1,
      Number.POSITIVE_INFINITY,
      zero,
    )).toMatchObject({ entryDistanceTicks: 0, price: 100 });
    expect(entryQuarterSignal(
      range('long', bars, 88, 100),
      bars,
      1,
      Number.POSITIVE_INFINITY,
      hundred,
    )).toMatchObject({ entryDistanceTicks: 12, price: 100 });
    expect(entryQuarterSignal(
      range('short', bars, 88, 100),
      bars,
      1,
      Number.POSITIVE_INFINITY,
      hundred,
    )).toMatchObject({ entryDistanceTicks: 12, price: 88 });
  });

  it('rounds a non-divisible configured percentage upward by one whole tick', () => {
    const bars = [candle(0, 100, 100, 90, 92), candle(1, 92, 100, 90, 99)];
    const settings = { ...DEFAULT_ENTRY_STRATEGY_SETTINGS, entryRangePercent: 33 };
    const signal = entryQuarterSignal(
      range('long', bars, 90, 100),
      bars,
      1,
      Number.POSITIVE_INFINITY,
      settings,
    );

    expect(signal).toMatchObject({
      rangeTicks: 10,
      entryRangePercent: 33,
      entryDistanceTicks: 4,
      price: 94,
    });
  });

  it('supports a non-unit tick while keeping the result on its tick grid', () => {
    const bars = [candle(0, 100, 100, 97.25, 98), candle(1, 98, 100, 97.25, 99)];
    const signal = entryQuarterSignal(range('long', bars, 97.25, 100), bars, 0.25);
    expect(signal).toMatchObject({
      tick: 0.25,
      rangeTicks: 11,
      entryRangePercent: 25,
      entryDistanceTicks: 3,
      quarterTicks: 3,
      price: 98,
    });
    expect(signal.price / signal.tick).toBe(Math.round(signal.price / signal.tick));
  });

  it('forces risk-edge pricing without changing the configured percentage', () => {
    const bars = [candle(0, 100, 100, 97.25, 98), candle(1, 98, 100, 97.25, 99)];
    const settings = { ...DEFAULT_ENTRY_STRATEGY_SETTINGS, entryRangePercent: 67 };
    const longRange = range('long', bars, 97.25, 100, 1, 0, 'risk-edge');
    const shortRange = range('short', bars, 97.25, 100, 1, 0, 'risk-edge');

    expect(entryQuarterSignal(longRange, bars, 0.25, Number.POSITIVE_INFINITY, settings)).toMatchObject({
      pricingMode: 'risk-edge',
      entryRangePercent: 67,
      entryDistanceTicks: 0,
      quarterTicks: 0,
      price: 97.25,
    });
    expect(entryQuarterSignal(shortRange, bars, 0.25, Number.POSITIVE_INFINITY, settings)).toMatchObject({
      pricingMode: 'risk-edge',
      entryRangePercent: 67,
      entryDistanceTicks: 0,
      quarterTicks: 0,
      price: 100,
    });
  });

  it('excludes the reaction candle even when it covers the line and accepts the first later wick touch', () => {
    const bars = [
      candle(0, 100, 101, 96, 98),
      candle(1, 98, 108, 96, 107),
      candle(2, 107, 109, 100, 108),
      candle(3, 108, 110, 98, 109),
      candle(4, 109, 111, 98, 110),
    ];
    const signal = entryQuarterSignal(range('long', bars, 96, 108), bars);
    expect(signal.price).toBe(99);
    expect(signal.searchStartBar).toBe(bars[2]);
    expect(signal.entryBar).toBe(bars[3]);
  });

  it('counts equality and upper-wick touches and chooses only the first repeated touch', () => {
    const bars = [
      candle(0, 100, 110, 98, 99),
      candle(1, 99, 108, 96, 97),
      candle(2, 96, 105, 95, 97),
      candle(3, 97, 105, 94, 96),
    ];
    const signal = entryQuarterSignal(range('short', bars, 96, 108), bars);
    expect(signal.price).toBe(105);
    expect(signal.entryBar).toBe(bars[2]);
    expect(bars[2].high).toBe(signal.price);
  });

  it('returns no entry when the reaction is last, absent from the window, or no later candle touches', () => {
    const noTouchBars = [
      candle(0, 100, 104, 96, 98),
      candle(1, 98, 108, 96, 107),
      candle(2, 107, 110, 101, 109),
    ];
    const noTouch = entryQuarterSignal(range('long', noTouchBars, 96, 108), noTouchBars);
    expect(noTouch.searchStartBar).toBe(noTouchBars[2]);
    expect(noTouch.entryBar).toBeUndefined();

    const lastReaction = range('long', noTouchBars, 96, 108, 2);
    expect(entryQuarterSignal(lastReaction, noTouchBars)).toMatchObject({
      searchStartBar: undefined, entryBar: undefined,
    });

    const outsideReaction = { ...lastReaction, reactionBar: candle(99, 100, 108, 96, 107) };
    expect(entryQuarterSignal(outsideReaction, noTouchBars)).toMatchObject({
      searchStartBar: undefined, entryBar: undefined,
    });
  });

  it('does not inspect bars outside the supplied window or mutate its inputs and existing analysis', () => {
    const bars = [
      candle(0, 100, 104, 96, 98),
      candle(1, 98, 108, 96, 107),
      candle(2, 107, 110, 101, 109),
    ];
    const outsideTouch = candle(3, 109, 110, 98, 109);
    const reaction = range('long', bars, 96, 108);
    const barsBefore = structuredClone(bars);
    const rangeBefore = structuredClone(reaction);
    const fixture = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const analysisBefore = analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema);
    const observationBefore = entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5);
    const emaByStart = new Map(fixture.m5.map((item, index) => [item.startMs, 94 + index / 100]));
    const lineBefore = entryObservationLine(analysisBefore.entries[0], observationBefore, emaByStart);

    const result = entryQuarterSignal(reaction, bars);

    expect(result.entryBar).toBeUndefined();
    expect(outsideTouch.low).toBeLessThanOrEqual(result.price);
    expect(result.price).toBeLessThanOrEqual(outsideTouch.high);
    expect(bars).toEqual(barsBefore);
    expect(reaction).toEqual(rangeBefore);
    expect(entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5)).toEqual(observationBefore);
    expect(entryObservationLine(analysisBefore.entries[0], observationBefore, emaByStart)).toEqual(lineBefore);
    expect(analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema)).toEqual(analysisBefore);
  });

  it('rejects invalid tick and reaction range inputs', () => {
    const bars = [candle(0, 100, 101, 99, 100), candle(1, 100, 102, 99, 101)];
    const valid = range('long', bars, 99, 102);
    expect(() => entryQuarterSignal(valid, bars, 0)).toThrow(RangeError);
    expect(() => entryQuarterSignal({ ...valid, high: 98 }, bars)).toThrow(RangeError);
  });
});

describe('5-minute reaction-range stop loss', () => {
  const range = (
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    low: number,
    high: number,
    reactionIndex = 1,
    extremeIndex = 0,
  ): EntryReactionRange => ({
    direction,
    pricingMode: 'configured-percent',
    reactionBar: bars[reactionIndex],
    extremeBar: bars[extremeIndex],
    high,
    low,
  });

  it('mirrors the non-divisible 3020-3031 example for long and short', () => {
    const bars = [candle(0, 3022, 3024, 3020, 3021), candle(1, 3021, 3031, 3021, 3030)];
    const long = entryStopLossSignal(range('long', bars, 3020, 3031));
    const short = entryStopLossSignal(range('short', bars, 3020, 3031));

    expect(long).toEqual({
      direction: 'long',
      price: 3011,
      tick: 1,
      rangeTicks: 11,
      stopTicks: 9,
      lineStartBar: bars[0],
    });
    expect(short).toEqual({
      direction: 'short',
      price: 3040,
      tick: 1,
      rangeTicks: 11,
      stopTicks: 9,
      lineStartBar: bars[0],
    });
  });

  it('uses exactly nine stop ticks when 75% is already integral', () => {
    const bars = [candle(0, 90, 100, 88, 90), candle(1, 90, 100, 88, 99)];
    expect(entryStopLossSignal(range('long', bars, 88, 100))).toMatchObject({
      rangeTicks: 12, stopTicks: 9, price: 79,
    });
    expect(entryStopLossSignal(range('short', bars, 88, 100))).toMatchObject({
      rangeTicks: 12, stopTicks: 9, price: 109,
    });
  });

  it('supports a non-unit tick and keeps both mirror prices on its tick grid', () => {
    const bars = [candle(0, 98, 100, 97.25, 98), candle(1, 98, 100, 97.25, 99)];
    const long = entryStopLossSignal(range('long', bars, 97.25, 100), 0.25);
    const short = entryStopLossSignal(range('short', bars, 97.25, 100), 0.25);

    expect(long).toMatchObject({ tick: 0.25, rangeTicks: 11, stopTicks: 9, price: 95 });
    expect(short).toMatchObject({ tick: 0.25, rangeTicks: 11, stopTicks: 9, price: 102.25 });
    expect(long.price / long.tick).toBe(Math.round(long.price / long.tick));
    expect(short.price / short.tick).toBe(Math.round(short.price / short.tick));
  });

  it('does not create a result without a reaction range or mutate existing entry behavior', () => {
    const noReactionBars = [
      candle(0, 100, 103, 95, 98),
      candle(1, 98, 100, 94, 96),
      candle(2, 96, 99, 93, 94),
    ];
    const noRange = entryReactionRange('long', noReactionBars);
    expect(noRange && entryStopLossSignal(noRange)).toBeUndefined();

    const fixture = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const analysisBefore = analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema);
    const observationBefore = entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5);
    const reactionBars = [
      candle(10, 100, 102, 94, 96),
      candle(11, 96, 101, 95, 100),
      candle(12, 100, 103, 97, 102),
    ];
    const rangeBefore = entryReactionRange('long', reactionBars)!;
    const quarterBefore = entryQuarterSignal(rangeBefore, reactionBars);
    const emaByStart = new Map(fixture.m5.map((item, index) => [item.startMs, 94 + index / 100]));
    const lineBefore = entryObservationLine(analysisBefore.entries[0], observationBefore, emaByStart);
    const observationSnapshot = structuredClone(observationBefore);
    const reactionBarsSnapshot = structuredClone(reactionBars);
    const rangeSnapshot = structuredClone(rangeBefore);

    entryStopLossSignal(rangeBefore);

    expect(observationBefore).toEqual(observationSnapshot);
    expect(reactionBars).toEqual(reactionBarsSnapshot);
    expect(rangeBefore).toEqual(rangeSnapshot);
    expect(entryReactionRange('long', reactionBars)).toEqual(rangeBefore);
    expect(entryQuarterSignal(rangeBefore, reactionBars)).toEqual(quarterBefore);
    expect(entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5)).toEqual(observationBefore);
    expect(entryObservationLine(analysisBefore.entries[0], observationBefore, emaByStart)).toEqual(lineBefore);
    expect(analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema)).toEqual(analysisBefore);
  });

  it('rejects invalid tick and reaction range inputs', () => {
    const bars = [candle(0, 100, 101, 99, 100), candle(1, 100, 102, 99, 101)];
    const valid = range('long', bars, 99, 102);
    expect(() => entryStopLossSignal(valid, 0)).toThrow(RangeError);
    expect(() => entryStopLossSignal(valid, Number.NaN)).toThrow(RangeError);
    expect(() => entryStopLossSignal({ ...valid, high: 98 })).toThrow(RangeError);
    expect(() => entryStopLossSignal({ ...valid, low: Number.NaN })).toThrow(RangeError);
  });
});

describe('5-minute reaction-range take profit', () => {
  const range = (
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    low: number,
    high: number,
    reactionIndex = 1,
    extremeIndex = 0,
  ): EntryReactionRange => ({
    direction,
    pricingMode: 'configured-percent',
    reactionBar: bars[reactionIndex],
    extremeBar: bars[extremeIndex],
    high,
    low,
  });
  const quarter = (
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    entryIndex?: number,
  ): EntryQuarterSignal => ({
    direction,
    pricingMode: 'configured-percent',
    price: direction === 'long' ? 3023 : 3028,
    tick: 1,
    rangeTicks: 11,
    entryRangePercent: 25,
    entryDistanceTicks: 3,
    quarterTicks: 3,
    lineStartBar: bars[0],
    reactionBar: bars[1] || bars[0],
    searchStartBar: bars[2],
    entryBar: entryIndex === undefined ? undefined : bars[entryIndex],
  });

  it('calculates the mirrored 3020-3031 default and adjusted targets', () => {
    const bars = [
      candle(0, 3022, 3024, 3020, 3021),
      candle(1, 3021, 3031, 3021, 3030),
      candle(2, 3030, 3030, 3024, 3028),
    ];
    const long = entryTakeProfitSignal(range('long', bars, 3020, 3031), bars, quarter('long', bars));
    const short = entryTakeProfitSignal(range('short', bars, 3020, 3031), bars, quarter('short', bars));

    expect(long).toEqual({
      direction: 'long',
      tick: 1,
      rangeTicks: 11,
      targetTicks: 22,
      defaultPrice: 3053,
      adjustedPrice: 3031,
      lineStartBar: bars[0],
      entryBar: undefined,
      riskTouchBar: undefined,
    });
    expect(short).toEqual({
      direction: 'short',
      tick: 1,
      rangeTicks: 11,
      targetTicks: 22,
      defaultPrice: 2998,
      adjustedPrice: 3020,
      lineStartBar: bars[0],
      entryBar: undefined,
      riskTouchBar: undefined,
    });
  });

  it('supports a non-unit tick and keeps every target on the tick grid', () => {
    const bars = [
      candle(0, 98, 100, 97.25, 98),
      candle(1, 98, 100, 97.25, 99),
    ];
    const long = entryTakeProfitSignal(range('long', bars, 97.25, 100), bars, quarter('long', bars), 0.25);
    const short = entryTakeProfitSignal(range('short', bars, 97.25, 100), bars, quarter('short', bars), 0.25);

    expect(long).toMatchObject({
      tick: 0.25, rangeTicks: 11, targetTicks: 22, defaultPrice: 105.5, adjustedPrice: 100,
    });
    expect(short).toMatchObject({
      tick: 0.25, rangeTicks: 11, targetTicks: 22, defaultPrice: 91.75, adjustedPrice: 97.25,
    });
    for (const price of [long.defaultPrice, long.adjustedPrice, short.defaultPrice, short.adjustedPrice]) {
      expect(price / 0.25).toBe(Math.round(price / 0.25));
    }
  });

  it('keeps a zero-height range valid and detects an entry-bar equality touch', () => {
    const bars = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      candle(2, 100, 100, 100, 100),
    ];
    const long = entryTakeProfitSignal(range('long', bars, 100, 100), bars, quarter('long', bars, 2));
    const short = entryTakeProfitSignal(range('short', bars, 100, 100), bars, quarter('short', bars, 2));

    expect(long).toMatchObject({
      rangeTicks: 0, targetTicks: 0, defaultPrice: 100, adjustedPrice: 100,
      entryBar: bars[2], riskTouchBar: bars[2],
    });
    expect(short).toMatchObject({
      rangeTicks: 0, targetTicks: 0, defaultPrice: 100, adjustedPrice: 100,
      entryBar: bars[2], riskTouchBar: bars[2],
    });
  });

  it('ignores pre-entry touches and uses an entry-candle touch immediately', () => {
    const longBars = [
      candle(0, 3021, 3024, 3019, 3020),
      candle(1, 3020, 3031, 3021, 3030),
      candle(2, 3030, 3030, 3025, 3028),
      candle(3, 3028, 3029, 3019, 3023),
      candle(4, 3023, 3026, 3018, 3025),
    ];
    const shortBars = [
      candle(5, 3030, 3032, 3022, 3028),
      candle(6, 3028, 3030, 3020, 3021),
      candle(7, 3021, 3027, 3021, 3025),
      candle(8, 3025, 3032, 3023, 3028),
      candle(9, 3028, 3033, 3024, 3026),
    ];
    const long = entryTakeProfitSignal(range('long', longBars, 3020, 3031), longBars, quarter('long', longBars, 3));
    const short = entryTakeProfitSignal(range('short', shortBars, 3020, 3031), shortBars, quarter('short', shortBars, 3));

    expect(long.entryBar).toBe(longBars[3]);
    expect(long.riskTouchBar).toBe(longBars[3]);
    expect(short.entryBar).toBe(shortBars[3]);
    expect(short.riskTouchBar).toBe(shortBars[3]);
  });

  it('chooses only the first later equality or boundary-crossing touch', () => {
    const longBars = [
      candle(0, 3022, 3024, 3020, 3021),
      candle(1, 3021, 3031, 3021, 3030),
      candle(2, 3030, 3030, 3023, 3028),
      candle(3, 3028, 3029, 3021, 3024),
      candle(4, 3024, 3027, 3020, 3026),
      candle(5, 3026, 3028, 3018, 3020),
    ];
    const shortBars = [
      candle(6, 3029, 3031, 3022, 3028),
      candle(7, 3028, 3030, 3020, 3021),
      candle(8, 3021, 3028, 3021, 3025),
      candle(9, 3025, 3030, 3023, 3028),
      candle(10, 3028, 3031, 3024, 3026),
      candle(11, 3026, 3034, 3022, 3030),
    ];
    const long = entryTakeProfitSignal(range('long', longBars, 3020, 3031), longBars, quarter('long', longBars, 2));
    const short = entryTakeProfitSignal(range('short', shortBars, 3020, 3031), shortBars, quarter('short', shortBars, 2));

    expect(long.riskTouchBar).toBe(longBars[4]);
    expect(long.riskTouchBar?.low).toBe(3020);
    expect(short.riskTouchBar).toBe(shortBars[4]);
    expect(short.riskTouchBar?.high).toBe(3031);
  });

  it('does not scan risk touches without a true entry or after an entry outside the window', () => {
    const bars = [
      candle(0, 3022, 3024, 3019, 3021),
      candle(1, 3021, 3031, 3021, 3030),
      candle(2, 3030, 3032, 3018, 3028),
    ];
    const noEntry = entryTakeProfitSignal(range('long', bars, 3020, 3031), bars, quarter('long', bars));
    const outsideQuarter = { ...quarter('long', bars), entryBar: candle(99, 3025, 3028, 3018, 3020) };
    const outside = entryTakeProfitSignal(range('long', bars, 3020, 3031), bars, outsideQuarter);

    expect(noEntry.riskTouchBar).toBeUndefined();
    expect(outside.entryBar).toBe(outsideQuarter.entryBar);
    expect(outside.riskTouchBar).toBeUndefined();
  });

  it('keeps the default target when no post-entry risk touch occurs', () => {
    const bars = [
      candle(0, 3022, 3024, 3020, 3021),
      candle(1, 3021, 3031, 3021, 3030),
      candle(2, 3030, 3030, 3023, 3028),
      candle(3, 3028, 3029, 3021, 3024),
      candle(4, 3024, 3027, 3021, 3026),
    ];
    const signal = entryTakeProfitSignal(range('long', bars, 3020, 3031), bars, quarter('long', bars, 2));
    expect(signal.entryBar).toBe(bars[2]);
    expect(signal.riskTouchBar).toBeUndefined();
    expect(signal.defaultPrice).toBe(3053);
  });

  it('does not mutate its inputs or alter existing entry, range, quarter, and stop-loss results', () => {
    const fixture = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const analysisBefore = analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema);
    const observation = entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5);
    const reactionBars = [
      candle(10, 100, 102, 94, 96),
      candle(11, 96, 101, 95, 100),
      candle(12, 100, 103, 97, 102),
    ];
    const reaction = entryReactionRange('long', reactionBars)!;
    const quarterBefore = entryQuarterSignal(reaction, reactionBars);
    const stopBefore = entryStopLossSignal(reaction);
    const observationSnapshot = structuredClone(observation);
    const reactionBarsSnapshot = structuredClone(reactionBars);
    const reactionSnapshot = structuredClone(reaction);
    const quarterSnapshot = structuredClone(quarterBefore);

    entryTakeProfitSignal(reaction, reactionBars, quarterBefore);

    expect(observation).toEqual(observationSnapshot);
    expect(reactionBars).toEqual(reactionBarsSnapshot);
    expect(reaction).toEqual(reactionSnapshot);
    expect(quarterBefore).toEqual(quarterSnapshot);
    expect(entryObservationWindow(analysisBefore.entries[0].triggerBar, fixture.m5)).toEqual(observationSnapshot);
    expect(entryReactionRange('long', reactionBars)).toEqual(reactionSnapshot);
    expect(entryQuarterSignal(reaction, reactionBars)).toEqual(quarterBefore);
    expect(entryStopLossSignal(reaction)).toEqual(stopBefore);
    expect(analyzeWeeklyEntries(fixture.h60, fixture.m5, fixture.ema)).toEqual(analysisBefore);
  });

  it('rejects invalid ticks, ranges, and mismatched directions', () => {
    const bars = [candle(0, 100, 101, 99, 100), candle(1, 100, 102, 99, 101)];
    const valid = range('long', bars, 99, 102);
    expect(() => entryTakeProfitSignal(valid, bars, quarter('long', bars), 0)).toThrow(RangeError);
    expect(() => entryTakeProfitSignal(valid, bars, quarter('long', bars), Number.NaN)).toThrow(RangeError);
    expect(() => entryTakeProfitSignal({ ...valid, high: 98 }, bars, quarter('long', bars))).toThrow(RangeError);
    expect(() => entryTakeProfitSignal({ ...valid, low: Number.NaN }, bars, quarter('long', bars))).toThrow(RangeError);
    expect(() => entryTakeProfitSignal(valid, bars, quarter('short', bars))).toThrow(RangeError);
  });
});

describe('minute-backed actual exit state', () => {
  function signals(
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    entryIndex = 0,
  ) {
    const range: EntryReactionRange = {
      direction,
      pricingMode: 'configured-percent',
      reactionBar: bars[0],
      extremeBar: bars[0],
      high: 104,
      low: 100,
    };
    const quarterSignal: EntryQuarterSignal = {
      direction,
      pricingMode: 'configured-percent',
      price: direction === 'long' ? 101 : 103,
      tick: 1,
      rangeTicks: 4,
      entryRangePercent: 25,
      entryDistanceTicks: 1,
      quarterTicks: 1,
      lineStartBar: bars[0],
      reactionBar: bars[0],
      searchStartBar: bars[entryIndex],
      entryBar: bars[entryIndex],
    };
    return {
      range,
      quarterSignal,
      stopLossSignal: {
        direction,
        price: direction === 'long' ? 97 : 107,
        tick: 1,
        rangeTicks: 4,
        stopTicks: 3,
        lineStartBar: bars[0],
      },
      takeProfitSignal: {
        direction,
        tick: 1,
        rangeTicks: 4,
        targetTicks: 8,
        defaultPrice: direction === 'long' ? 112 : 92,
        adjustedPrice: direction === 'long' ? 104 : 100,
        lineStartBar: bars[0],
        entryBar: bars[entryIndex],
      },
    };
  }

  function analyze(
    direction: WeeklyEntry['direction'],
    bars: Bar[],
    minutes: EdbMinuteRecord[] = [],
    entryIndex = 0,
  ) {
    const fixture = signals(direction, bars, entryIndex);
    return analyzeEntryExit(
      fixture.range,
      bars,
      minutes,
      fixture.quarterSignal,
      fixture.stopLossSignal,
      fixture.takeProfitSignal,
    );
  }

  it('chooses granularity independently for each 5-minute bar and restores minute order after a gap', () => {
    const first = minuteBackedCandle(0, [
      [101, 102, 101, 102],
      [102, 103, 102, 103],
      [103, 104, 103, 104],
      [104, 105, 104, 105],
      [105, 106, 105, 106],
    ]);
    const second = minuteBackedCandle(1, [
      [106, 107, 106, 107],
      [107, 108, 107, 108],
      [108, 109, 108, 109],
      [109, 110, 109, 110],
      [110, 111, 110, 111],
    ]);
    const minutes = [...first.minutes.slice(0, 4), ...second.minutes];
    const units = entryExitDecisionUnits([first.bar, second.bar], minutes);

    expect(units.map(unit => unit.granularity)).toEqual([
      'five-minute-fallback',
      'one-minute',
      'one-minute',
      'one-minute',
      'one-minute',
      'one-minute',
    ]);
    expect(units.slice(1).map(unit => unit.minute?.startMs)).toEqual(second.minutes.map(minute => minute.startMs));
  });

  it('starts at the first entry-touching minute and ignores all earlier risk, stop, and target touches', () => {
    const entry = minuteBackedCandle(0, [
      [99, 100, 97, 99],
      [111, 113, 110, 111],
      [102, 102, 101, 102],
      [102, 103, 102, 103],
      [103, 103, 102, 102],
    ]);
    const result = analyze('long', [entry.bar], entry.minutes);

    expect(result).toEqual({});
  });

  it.each([
    {
      direction: 'long' as const,
      values: [
        [102, 102, 101, 102],
        [101, 101, 99, 100],
        [103, 105, 103, 104],
        [104, 105, 103, 104],
        [104, 105, 103, 104],
      ] as Array<[number, number, number, number]>,
      riskMinute: 1,
      exitMinute: 2,
      exitPrice: 104,
    },
    {
      direction: 'short' as const,
      values: [
        [102, 103, 102, 102],
        [103, 105, 103, 104],
        [101, 102, 99, 100],
        [100, 101, 99, 100],
        [100, 101, 99, 100],
      ] as Array<[number, number, number, number]>,
      riskMinute: 1,
      exitMinute: 2,
      exitPrice: 100,
    },
  ])('allows a later minute to hit the adjusted $direction target in the same 5-minute bar', ({
    direction,
    values,
    riskMinute,
    exitMinute,
    exitPrice,
  }) => {
    const entry = minuteBackedCandle(0, values);
    const result = analyze(direction, [entry.bar], entry.minutes);

    expect(result.riskTouchSignal).toMatchObject({
      direction,
      bar: entry.bar,
      minute: entry.minutes[riskMinute],
      granularity: 'one-minute',
    });
    expect(result.exitSignal).toMatchObject({
      direction,
      type: 'take-profit',
      price: exitPrice,
      bar: entry.bar,
      minute: entry.minutes[exitMinute],
      granularity: 'one-minute',
      lineEndMs: entry.bar.endMs,
    });
  });

  it('applies conservative collision priorities within one decision unit', () => {
    const entryAndStop = [candle(0, 101, 101, 97, 100)];
    expect(analyze('long', entryAndStop).exitSignal).toMatchObject({
      type: 'stop-loss',
      price: 97,
      granularity: 'five-minute-fallback',
    });
    expect(analyze('long', entryAndStop).riskTouchSignal).toBeUndefined();

    const entryAndTarget = [candle(1, 101, 112, 101, 110)];
    expect(analyze('long', entryAndTarget)).toEqual({});

    const entry = candle(2, 102, 103, 101, 102);
    const stopAndTarget = candle(3, 102, 112, 97, 100);
    expect(analyze('long', [entry, stopAndTarget]).exitSignal).toMatchObject({
      type: 'stop-loss',
      bar: stopAndTarget,
      price: 97,
    });

    const riskAndTarget = candle(4, 102, 112, 100, 104);
    const adjusted = analyze('long', [entry, riskAndTarget]);
    expect(adjusted.riskTouchSignal?.bar).toBe(riskAndTarget);
    expect(adjusted.exitSignal).toBeUndefined();

    const riskAndStop = candle(5, 101, 102, 97, 99);
    const stopped = analyze('long', [entry, riskAndStop]);
    expect(stopped.exitSignal).toMatchObject({ type: 'stop-loss', bar: riskAndStop });
    expect(stopped.riskTouchSignal).toBeUndefined();
  });

  it('stops at the first actual exit and uses the planned line price rather than the candle extreme', () => {
    const entry = candle(0, 102, 103, 101, 102);
    const target = candle(1, 110, 118, 109, 117);
    const laterStop = candle(2, 100, 101, 90, 91);
    const result = analyze('long', [entry, target, laterStop]);

    expect(result.exitSignal).toMatchObject({
      type: 'take-profit',
      price: 112,
      bar: target,
      granularity: 'five-minute-fallback',
      lineEndMs: target.endMs,
    });
  });

  it('falls back for an incomplete entry bar and treats equal wick touches as exits for both directions', () => {
    const incomplete = minuteBackedCandle(0, [
      [101, 102, 101, 102],
      [102, 103, 102, 103],
      [103, 104, 103, 104],
      [104, 105, 104, 105],
      [105, 106, 97, 100],
    ]);
    const fallback = analyze('long', [incomplete.bar], incomplete.minutes.slice(0, 4));
    expect(fallback.exitSignal).toMatchObject({
      type: 'stop-loss',
      bar: incomplete.bar,
      granularity: 'five-minute-fallback',
    });

    const longEntry = candle(1, 102, 103, 101, 102);
    const longTarget = candle(2, 110, 112, 109, 111);
    expect(analyze('long', [longEntry, longTarget]).exitSignal).toMatchObject({
      type: 'take-profit',
      price: 112,
      bar: longTarget,
    });

    const shortEntry = candle(3, 102, 103, 101, 102);
    const shortTarget = candle(4, 94, 95, 92, 93);
    expect(analyze('short', [shortEntry, shortTarget]).exitSignal).toMatchObject({
      type: 'take-profit',
      price: 92,
      bar: shortTarget,
    });
  });

  it('returns no state without a true entry and rejects mismatched signal directions', () => {
    const bars = [candle(0, 102, 103, 101, 102)];
    const fixture = signals('long', bars);
    expect(analyzeEntryExit(
      fixture.range,
      bars,
      [],
      { ...fixture.quarterSignal, entryBar: undefined },
      fixture.stopLossSignal,
      fixture.takeProfitSignal,
    )).toEqual({});
    expect(() => analyzeEntryExit(
      fixture.range,
      bars,
      [],
      fixture.quarterSignal,
      { ...fixture.stopLossSignal, direction: 'short' },
      fixture.takeProfitSignal,
    )).toThrow(RangeError);
  });
});

describe('weekly entry selection', () => {
  const entry = (direction: WeeklyEntry['direction'], parentStart: number, triggerStart: number): WeeklyEntry => {
    const parent = bar(parentStart, 100, 90);
    const triggerBar = bar(triggerStart, 100, 90, M, 5);
    return { bar: parent, triggerBar, direction, boundaryHigh: 100, boundaryLow: 90, midpoint: 95, ema20: 95, pullbackLine: 95, weekStart: '2026-02-02' };
  };

  it('uses the concrete marker id when multiple events share a 60-minute bar', () => {
    const first = entry('long', monday, monday + M);
    const second = entry('short', monday, monday + 3 * M);
    expect(selectWeeklyEntry([first, second], weeklyEntryMarkerId(second))).toBe(second);
  });

  it('uses the earliest trigger when the candle body is clicked', () => {
    const first = entry('long', monday, monday + M);
    const second = entry('short', monday, monday + 3 * M);
    expect(selectWeeklyEntry([second, first])).toBe(first);
  });
});

describe('weekly pullback entry state', () => {
  it('marks the first later 5-minute wick touching the long line', () => {
    const { h60, m5, ema } = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const result = analyzeWeeklyEntries(h60, m5, ema);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ direction: 'long', pullbackLine: 95, triggerBar: m5[97], boundaryHigh: 101, boundaryLow: 90 });
  });

  it('replaces long waiting with short after a later reverse breakout', () => {
    const { h60, m5, ema } = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 89], '8:2': [100, 95] });
    const result = analyzeWeeklyEntries(h60, m5, ema);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ direction: 'short', triggerBar: m5[98], pullbackLine: 95 });
  });

  it('skips a breakout and touch in one 5-minute bar, then accepts later touch', () => {
    const { h60, m5, ema } = build(Array(9).fill(0), { '8:0': [101, 95], '8:1': [100, 95], '8:2': [100, 95] });
    const result = analyzeWeeklyEntries(h60, m5, ema);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].triggerBar).toBe(m5[97]);
  });

  it('reopens after a same-direction new high and resets at the next week', () => {
    const first = build(Array(10).fill(0), { '8:0': [101, 96], '8:1': [100, 95], '8:2': [102, 96], '8:3': [100, 95] });
    const next = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 95] });
    const shifted = { ...next, h60: next.h60.map(b => ({ ...b, startMs: b.startMs + 7 * 24 * H, endMs: b.endMs + 7 * 24 * H })), m5: next.m5.map(b => ({ ...b, startMs: b.startMs + 7 * 24 * H, endMs: b.endMs + 7 * 24 * H })), ema: next.ema.map(point => ({ ...point, bar: { ...point.bar, startMs: point.bar.startMs + 7 * 24 * H, endMs: point.bar.endMs + 7 * 24 * H } })) };
    const result = analyzeWeeklyEntries([...first.h60, ...shifted.h60], [...first.m5, ...shifted.m5], [...first.ema, ...shifted.ema]);
    expect(result.entries.map(entry => entry.direction)).toEqual(['long', 'long', 'long']);
  });

  it('uses the lower midpoint/EMA for long and the higher one for short', () => {
    const long = build(Array(9).fill(0), { '8:0': [101, 96], '8:1': [100, 94] });
    long.ema = long.ema.map(point => ({ ...point, value: 94 }));
    expect(analyzeWeeklyEntries(long.h60, long.m5, long.ema).entries[0]).toMatchObject({ direction: 'long', midpoint: 95.5, ema20: 94, pullbackLine: 94 });
    const short = build(Array(9).fill(0), { '8:0': [99, 89], '8:1': [96, 90] });
    short.ema = short.ema.map(point => ({ ...point, value: 96 }));
    expect(analyzeWeeklyEntries(short.h60, short.m5, short.ema).entries[0]).toMatchObject({ direction: 'short', midpoint: 94.5, ema20: 96, pullbackLine: 96 });
  });

  it('is causal on real main-continuous data', () => {
    const bars60 = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_60m.csv', 'utf8'), '60m.csv');
    const bars5 = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_5m.csv', 'utf8'), '5m.csv');
    const ema = exponentialMovingAverage(bars60);
    const full = analyzeWeeklyEntries(bars60, bars5, ema);
    expect(full.entries.length).toBeGreaterThan(0);
    for (const length of [20, 100, 500, bars60.length - 1]) {
      const end = bars60[length - 1].endMs;
      expect(analyzeWeeklyEntries(bars60.slice(0, length), bars5.filter(bar => bar.endMs <= end), ema.slice(0, length)).entries)
        .toEqual(full.entries.filter(entry => entry.bar.endMs <= end));
    }
  });

  it('preserves the real main-continuous entry event fingerprint', () => {
    const bars60 = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_60m.csv', 'utf8'), '60m.csv');
    const bars5 = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_5m.csv', 'utf8'), '5m.csv');
    const entries = analyzeWeeklyEntries(bars60, bars5, exponentialMovingAverage(bars60)).entries;
    const fingerprint = entries.map(entry => [entry.direction, entry.bar.startMs, entry.triggerBar.startMs]);
    expect(entries).toHaveLength(39);
    expect(entries.filter(entry => entry.direction === 'long')).toHaveLength(25);
    expect(entries.filter(entry => entry.direction === 'short')).toHaveLength(14);
    expect(createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')).toBe('8478a8c2fb9ca4cb400f948eb8ffa124c99b599f29ee40463d3754876d6bdbc5');
  });
});
