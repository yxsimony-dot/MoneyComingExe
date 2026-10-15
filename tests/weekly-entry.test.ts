import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { analyzeWeeklyEntries, entryObservationLine, entryObservationWindow, entryQuarterSignal, entryReactionRange, selectWeeklyEntry, weeklyEntryMarkerId, type EntryReactionRange, type WeeklyEntry } from '../src/domain/weekly-entry';
import { exponentialMovingAverage } from '../src/domain/ema';
import { parseBars } from '../src/domain/data';
import { MARKET_PRICE_TICK } from '../src/shared/market';
import type { Bar } from '../src/shared/types';
import type { EmaPoint } from '../src/domain/ema';

const H = 3_600_000; const M = 5 * 60_000;
function bar(startMs: number, high: number, low: number, duration = H, expectedMinutes = 60): Bar {
  return { startMs, endMs: startMs + duration, start: '', end: '', open: (high + low) / 2, high, low, close: (high + low) / 2,
    volume: 1, openOi: 1, closeOi: 1, session: 'day', observedMinutes: expectedMinutes, expectedMinutes, complete: true };
}
function candle(index: number, open: number, high: number, low: number, close: number): Bar {
  return { ...bar(monday + index * M, high, low, M, 5), open, close };
}
const monday = Date.UTC(2026, 1, 2, 1); // 09:00 Beijing
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

describe('5-minute first reaction range', () => {
  it('uses the trigger candle itself for an immediate long or short reaction', () => {
    const rising = candle(0, 95, 103, 92, 101);
    const falling = candle(1, 101, 104, 91, 94);
    expect(entryReactionRange('long', [rising])).toEqual({
      direction: 'long', reactionBar: rising, extremeBar: rising, high: 103, low: 92,
    });
    expect(entryReactionRange('short', [falling])).toEqual({
      direction: 'short', reactionBar: falling, extremeBar: falling, high: 104, low: 91,
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
      direction: 'long', reactionBar: longBars[3], extremeBar: longBars[1], high: 105, low: 91,
    });
    expect(entryReactionRange('short', shortBars)).toEqual({
      direction: 'short', reactionBar: shortBars[3], extremeBar: shortBars[1], high: 109, low: 92,
    });
  });

  it('keeps the first candle when the preceding extreme occurs more than once', () => {
    const longBars = [
      candle(0, 100, 104, 90, 98),
      candle(1, 98, 101, 90, 96),
      candle(2, 96, 105, 94, 103),
    ];
    const shortBars = [
      candle(3, 100, 110, 97, 103),
      candle(4, 103, 110, 99, 105),
      candle(5, 105, 108, 92, 96),
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
  ): EntryReactionRange => ({
    direction,
    reactionBar: bars[reactionIndex],
    extremeBar: bars[extremeIndex],
    high,
    low,
  });

  it('uses one shared market tick and mirrors the non-divisible 3020-3031 example', () => {
    const bars = [candle(0, 3022, 3024, 3020, 3021), candle(1, 3021, 3031, 3021, 3030)];
    const long = entryQuarterSignal(range('long', bars, 3020, 3031), bars);
    const short = entryQuarterSignal(range('short', bars, 3020, 3031), bars);

    expect(MARKET_PRICE_TICK).toBe(1);
    expect(long).toMatchObject({ direction: 'long', tick: 1, rangeTicks: 11, quarterTicks: 3, price: 3023 });
    expect(short).toMatchObject({ direction: 'short', tick: 1, rangeTicks: 11, quarterTicks: 3, price: 3028 });
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

  it('supports a non-unit tick while keeping the result on its tick grid', () => {
    const bars = [candle(0, 100, 100, 97.25, 98), candle(1, 98, 100, 97.25, 99)];
    const signal = entryQuarterSignal(range('long', bars, 97.25, 100), bars, 0.25);
    expect(signal).toMatchObject({ tick: 0.25, rangeTicks: 11, quarterTicks: 3, price: 98 });
    expect(signal.price / signal.tick).toBe(Math.round(signal.price / signal.tick));
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
