import type { Bar } from '../shared/types';
import { MARKET_PRICE_TICK } from '../shared/market';
import type { EmaPoint } from './ema';

export interface WeeklyEntry {
  bar: Bar;
  triggerBar: Bar;
  direction: 'long' | 'short';
  boundaryHigh: number;
  boundaryLow: number;
  midpoint: number;
  ema20: number;
  pullbackLine: number;
  weekStart: string;
}

export interface WeeklyEntryAnalysis { entries: WeeklyEntry[]; incompleteHours: number; }

export const ENTRY_OBSERVATION_BAR_COUNT = 16;

export interface EntryObservationLinePoint {
  bar: Bar;
  ema20: number;
  value: number;
}

export interface EntryReactionRange {
  direction: WeeklyEntry['direction'];
  reactionBar: Bar;
  extremeBar: Bar;
  high: number;
  low: number;
}

export interface EntryQuarterSignal {
  direction: WeeklyEntry['direction'];
  price: number;
  tick: number;
  rangeTicks: number;
  quarterTicks: number;
  lineStartBar: Bar;
  reactionBar: Bar;
  searchStartBar?: Bar;
  entryBar?: Bar;
}

export function weeklyEntryMarkerId(entry: WeeklyEntry): string {
  return `entry-${entry.direction}-${entry.triggerBar.startMs}`;
}

export function selectWeeklyEntry(entries: WeeklyEntry[], markerId?: string): WeeklyEntry | undefined {
  const exact = markerId ? entries.find(entry => weeklyEntryMarkerId(entry) === markerId) : undefined;
  return exact || entries.reduce<WeeklyEntry | undefined>(
    (earliest, entry) => !earliest || entry.triggerBar.startMs < earliest.triggerBar.startMs ? entry : earliest,
    undefined,
  );
}

/** Trigger bar plus the next 15 available records from the complete 5-minute sequence. */
export function entryObservationWindow(triggerBar: Bar, bars5: Bar[]): Bar[] {
  const triggerIndex = bars5.findIndex(bar => bar.startMs === triggerBar.startMs);
  return triggerIndex < 0 ? [] : bars5.slice(triggerIndex, triggerIndex + ENTRY_OBSERVATION_BAR_COUNT);
}

/** First directional response and its preceding extreme within an entry observation window. */
export function entryReactionRange(
  direction: WeeklyEntry['direction'],
  bars: Bar[],
): EntryReactionRange | undefined {
  const reactionIndex = bars.findIndex(bar => direction === 'long' ? bar.close > bar.open : bar.close < bar.open);
  if (reactionIndex < 0) return undefined;

  const reactionBar = bars[reactionIndex];
  const precedingBars = reactionIndex === 0 ? [reactionBar] : bars.slice(0, reactionIndex);
  const extremeBar = precedingBars.reduce((extreme, bar) => {
    if (direction === 'long') return bar.low < extreme.low ? bar : extreme;
    return bar.high > extreme.high ? bar : extreme;
  });

  return direction === 'long'
    ? { direction, reactionBar, extremeBar, high: reactionBar.high, low: extremeBar.low }
    : { direction, reactionBar, extremeBar, high: extremeBar.high, low: reactionBar.low };
}

/** Quarter-range entry price plus the first later touch inside the original observation window. */
export function entryQuarterSignal(
  range: EntryReactionRange,
  bars: readonly Bar[],
  tick = MARKET_PRICE_TICK,
): EntryQuarterSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Entry price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const quarterTicks = Math.ceil(rangeTicks / 4);
  const distance = quarterTicks * tick;
  const price = range.direction === 'long' ? range.low + distance : range.high - distance;
  const reactionIndex = bars.findIndex(bar => bar.startMs === range.reactionBar.startMs);
  const candidates = reactionIndex < 0 ? [] : bars.slice(reactionIndex + 1);

  return {
    direction: range.direction,
    price,
    tick,
    rangeTicks,
    quarterTicks,
    lineStartBar: range.extremeBar,
    reactionBar: range.reactionBar,
    searchStartBar: candidates[0],
    entryBar: candidates.find(bar => bar.low <= price && price <= bar.high),
  };
}

/** Per-bar 5-minute guide: lower of pullback/EMA20 for long, higher for short. */
export function entryObservationLine(
  entry: Pick<WeeklyEntry, 'direction' | 'pullbackLine'>,
  bars: Bar[],
  emaByStart: ReadonlyMap<number, number>,
): EntryObservationLinePoint[] {
  return bars.flatMap((bar) => {
    const ema20 = emaByStart.get(bar.startMs);
    if (ema20 === undefined) return [];
    const value = entry.direction === 'long'
      ? Math.min(entry.pullbackLine, ema20)
      : Math.max(entry.pullbackLine, ema20);
    return [{ bar, ema20, value }];
  });
}

const dayMs = 86_400_000;
const beijingDay = (ms: number) => Math.floor((ms + 8 * 3_600_000) / dayMs) * dayMs;
const weekStartFor = (ms: number) => {
  const day = beijingDay(ms);
  const weekday = new Date(day).getUTCDay();
  return day - ((weekday + 6) % 7) * dayMs;
};
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Causal weekly pullback entries reconstructed from 5-minute event order. */
export function analyzeWeeklyEntries(bars60: Bar[], bars5: Bar[], ema: EmaPoint[]): WeeklyEntryAnalysis {
  const entries: WeeklyEntry[] = [];
  const emaByStart = new Map(ema.map(point => [point.bar.startMs, point.value]));
  let currentWeek: number | undefined;
  let active = false;
  let ordinal = 0;
  let high = -Infinity;
  let low = Infinity;
  let waiting: 'long' | 'short' | undefined;
  let incompleteHours = 0;
  let childCursor = 0;

  for (let barIndex = 0; barIndex < bars60.length; barIndex += 1) {
    const bar = bars60[barIndex];
    const week = weekStartFor(bar.startMs);
    if (week !== currentWeek) {
      currentWeek = week;
      active = beijingDay(bar.startMs) === week;
      ordinal = 0; high = -Infinity; low = Infinity; waiting = undefined;
    }
    if (!active) continue;
    ordinal += 1;
    if (ordinal <= 8) {
      high = Math.max(high, bar.high); low = Math.min(low, bar.low);
      continue;
    }

    while (childCursor < bars5.length && bars5[childCursor].startMs < bar.startMs) childCursor += 1;
    const children: Bar[] = [];
    for (let index = childCursor; index < bars5.length && bars5[index].startMs < bar.endMs; index += 1) {
      if (bars5[index].endMs <= bar.endMs) children.push(bars5[index]);
    }
    const childHigh = children.length ? Math.max(...children.map(child => child.high)) : -Infinity;
    const childLow = children.length ? Math.min(...children.map(child => child.low)) : Infinity;
    const complete = children.length === Math.round(bar.expectedMinutes / 5) && children.every(child => child.complete)
      && childHigh === bar.high && childLow === bar.low;
    const ema20 = emaByStart.get(bars60[barIndex - 1]?.startMs);
    if (!complete || ema20 === undefined) {
      incompleteHours += 1;
      const up = bar.high > high;
      const down = bar.low < low;
      if (up && down) waiting = undefined;
      else if (up) waiting = 'long';
      else if (down) waiting = 'short';
      high = Math.max(high, bar.high); low = Math.min(low, bar.low);
      continue;
    }

    for (const child of children) {
      const up = child.high > high;
      const down = child.low < low;
      const beforeHigh = high;
      const beforeLow = low;
      if (up || down) {
        high = Math.max(high, child.high); low = Math.min(low, child.low);
        // A direction-changing or ambiguous breakout supersedes the old wait.
        waiting = up && down ? undefined : up ? 'long' : 'short';
        continue;
      }
      if (!waiting) continue;
      const midpoint = (high + low) / 2;
      const pullbackLine = waiting === 'long' ? Math.min(midpoint, ema20) : Math.max(midpoint, ema20);
      const touched = child.low <= pullbackLine && pullbackLine <= child.high;
      if (touched) {
        entries.push({ bar, triggerBar: child, direction: waiting, boundaryHigh: high, boundaryLow: low,
          midpoint, ema20, pullbackLine, weekStart: dateOf(currentWeek!) });
        waiting = undefined;
      }
      // Keep these local names as an explicit reminder that comparison is to the
      // boundary known before this 5-minute event; they also aid debugger inspection.
      void beforeHigh; void beforeLow;
    }
  }
  return { entries, incompleteHours };
}
