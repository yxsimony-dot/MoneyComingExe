import type { Bar, EdbMinuteRecord, MinuteDecisionGranularity } from '../shared/types';
import { MARKET_PRICE_TICK } from '../shared/market';
import type { EmaPoint } from './ema';
import { completeMinutesForFiveMinuteBar, tradingMinuteAt } from './market-data';

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

export interface EntryStopLossSignal {
  direction: WeeklyEntry['direction'];
  price: number;
  tick: number;
  rangeTicks: number;
  stopTicks: number;
  lineStartBar: Bar;
}

export interface EntryTakeProfitSignal {
  direction: WeeklyEntry['direction'];
  tick: number;
  rangeTicks: number;
  targetTicks: number;
  defaultPrice: number;
  adjustedPrice: number;
  lineStartBar: Bar;
  entryBar?: Bar;
  riskTouchBar?: Bar;
}

export type EntryExitType = 'take-profit' | 'stop-loss' | 'session-close';

export interface EntryExitSignal {
  direction: WeeklyEntry['direction'];
  type: EntryExitType;
  price: number;
  bar: Bar;
  minute?: EdbMinuteRecord;
  granularity: MinuteDecisionGranularity;
  lineEndMs: number;
}

export interface EntryRiskTouchSignal {
  direction: WeeklyEntry['direction'];
  bar: Bar;
  minute?: EdbMinuteRecord;
  granularity: MinuteDecisionGranularity;
}

export interface EntryExitAnalysis {
  riskTouchSignal?: EntryRiskTouchSignal;
  exitSignal?: EntryExitSignal;
}

export interface EntryExitDecisionUnit {
  bar: Bar;
  minute?: EdbMinuteRecord;
  granularity: MinuteDecisionGranularity;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EntrySessionPolicy {
  session: Bar['session'];
  entryCutoffIndex: number;
  sessionEndIndex: number;
  forcedExitBarStartIndex: number;
  entryCutoffWallTime: string;
  sessionEndWallTime: string;
}

export const ENTRY_SESSION_POLICIES: Readonly<Record<Bar['session'], EntrySessionPolicy>> = {
  day: {
    session: 'day',
    entryCutoffIndex: 210,
    sessionEndIndex: 225,
    forcedExitBarStartIndex: 205,
    entryCutoffWallTime: '14:45',
    sessionEndWallTime: '15:00',
  },
  night: {
    session: 'night',
    entryCutoffIndex: 105,
    sessionEndIndex: 120,
    forcedExitBarStartIndex: 100,
    entryCutoffWallTime: '22:45',
    sessionEndWallTime: '23:00',
  },
};

export type EntryLifecycleEndReason =
  | 'take-profit'
  | 'stop-loss'
  | 'session-close'
  | 'no-entry-session-end'
  | 'data-end';

export interface EntryLifecycle {
  analysisBars: Bar[];
  focusBars: Bar[];
  entryCutoff: number;
  sessionEnd: number;
  forcedExitBar?: Bar;
  reactionRange?: EntryReactionRange;
  quarterSignal?: EntryQuarterSignal;
  stopLossSignal?: EntryStopLossSignal;
  takeProfitSignal?: EntryTakeProfitSignal;
  exitAnalysis?: EntryExitAnalysis;
  endReason: EntryLifecycleEndReason;
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

/** Compact trigger-centered range used only for the initial chart focus. */
export function entryObservationWindow(triggerBar: Bar, bars5: Bar[]): Bar[] {
  const triggerIndex = bars5.findIndex(bar => bar.startMs === triggerBar.startMs);
  return triggerIndex < 0 ? [] : bars5.slice(triggerIndex, triggerIndex + ENTRY_OBSERVATION_BAR_COUNT);
}

/** First directional response and the inclusive extreme through that response bar. */
export function entryReactionRange(
  direction: WeeklyEntry['direction'],
  bars: Bar[],
): EntryReactionRange | undefined {
  const reactionIndex = bars.findIndex(bar => direction === 'long' ? bar.close > bar.open : bar.close < bar.open);
  if (reactionIndex < 0) return undefined;

  const reactionBar = bars[reactionIndex];
  const rangeBars = bars.slice(0, reactionIndex + 1);
  const extremeBar = rangeBars.reduce((extreme, bar) => {
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
  entryCutoff = Number.POSITIVE_INFINITY,
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
    entryBar: candidates.find(bar =>
      bar.startMs < entryCutoff && bar.low <= price && price <= bar.high),
  };
}

/** Planned stop-loss price at 75% of the reaction range beyond its risk-side edge. */
export function entryStopLossSignal(
  range: EntryReactionRange,
  tick = MARKET_PRICE_TICK,
): EntryStopLossSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Stop-loss price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const stopTicks = Math.ceil(rangeTicks * 0.75);
  const distance = stopTicks * tick;
  const rawPrice = range.direction === 'long' ? range.low - distance : range.high + distance;
  const price = Math.round(rawPrice / tick) * tick;

  return {
    direction: range.direction,
    price,
    tick,
    rangeTicks,
    stopTicks,
    lineStartBar: range.extremeBar,
  };
}

/** Planned take-profit price and the first post-entry touch of the reaction range's risk side. */
export function entryTakeProfitSignal(
  range: EntryReactionRange,
  bars: readonly Bar[],
  quarterSignal: EntryQuarterSignal,
  tick = MARKET_PRICE_TICK,
): EntryTakeProfitSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Take-profit price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }
  if (quarterSignal.direction !== range.direction) {
    throw new RangeError('Take-profit range and true-entry signal directions must match.');
  }

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const targetTicks = rangeTicks * 2;
  const distance = targetTicks * tick;
  const rawDefaultPrice = range.direction === 'long' ? range.high + distance : range.low - distance;
  const rawAdjustedPrice = range.direction === 'long' ? range.high : range.low;
  const defaultPrice = Math.round(rawDefaultPrice / tick) * tick;
  const adjustedPrice = Math.round(rawAdjustedPrice / tick) * tick;
  const entryBar = quarterSignal.entryBar;
  const entryIndex = entryBar ? bars.findIndex(bar => bar.startMs === entryBar.startMs) : -1;
  const riskTouchBar = entryIndex < 0
    ? undefined
    : bars.slice(entryIndex).find(bar => range.direction === 'long'
      ? bar.low <= range.low
      : bar.high >= range.high);

  return {
    direction: range.direction,
    tick,
    rangeTicks,
    targetTicks,
    defaultPrice,
    adjustedPrice,
    lineStartBar: range.extremeBar,
    entryBar,
    riskTouchBar,
  };
}

/**
 * Builds chronological decision units while choosing minute evidence
 * independently for each 5-minute bar.
 */
export function entryExitDecisionUnits(
  bars: readonly Bar[],
  minutes: readonly EdbMinuteRecord[],
): EntryExitDecisionUnit[] {
  return bars.flatMap<EntryExitDecisionUnit>((bar): EntryExitDecisionUnit[] => {
    const completeMinutes = completeMinutesForFiveMinuteBar(bar, minutes);
    if (completeMinutes) {
      return completeMinutes.map(minute => ({
        bar,
        minute,
        granularity: 'one-minute' as const,
        open: minute.open,
        high: minute.high,
        low: minute.low,
        close: minute.close,
      }));
    }
    return [{
      bar,
      granularity: 'five-minute-fallback' as const,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }];
  });
}

/** First actual post-entry exit, using minute order when each 5-minute bar supports it. */
export function analyzeEntryExit(
  range: EntryReactionRange,
  bars: readonly Bar[],
  minutes: readonly EdbMinuteRecord[],
  quarterSignal: EntryQuarterSignal,
  stopLossSignal: EntryStopLossSignal,
  takeProfitSignal: EntryTakeProfitSignal,
  forcedExitBar?: Bar,
): EntryExitAnalysis {
  const directions = [
    range.direction,
    quarterSignal.direction,
    stopLossSignal.direction,
    takeProfitSignal.direction,
  ];
  if (directions.some(direction => direction !== range.direction)) {
    throw new RangeError('Entry exit signals and reaction range directions must match.');
  }
  const entryBar = quarterSignal.entryBar;
  if (!entryBar) return {};
  const entryIndex = bars.findIndex(bar => bar.startMs === entryBar.startMs);
  if (entryIndex < 0) return {};

  type State = 'waiting-entry' | 'active-default-target' | 'active-adjusted-target';
  let state: State = 'waiting-entry';
  let riskTouchSignal: EntryRiskTouchSignal | undefined;
  const units = entryExitDecisionUnits(bars.slice(entryIndex), minutes);
  const touchesEntry = (unit: EntryExitDecisionUnit) =>
    unit.low <= quarterSignal.price && quarterSignal.price <= unit.high;
  const touchesStop = (unit: EntryExitDecisionUnit) => range.direction === 'long'
    ? unit.low <= stopLossSignal.price
    : unit.high >= stopLossSignal.price;
  const touchesRiskSide = (unit: EntryExitDecisionUnit) => range.direction === 'long'
    ? unit.low <= range.low
    : unit.high >= range.high;
  const touchesTarget = (unit: EntryExitDecisionUnit, price: number) => range.direction === 'long'
    ? unit.high >= price
    : unit.low <= price;
  const resultFor = (
    unit: EntryExitDecisionUnit,
    type: EntryExitType,
    price: number,
  ): EntryExitSignal => ({
    direction: range.direction,
    type,
    price,
    bar: unit.bar,
    minute: unit.minute,
    granularity: unit.granularity,
    lineEndMs: unit.bar.endMs,
  });
  const riskResultFor = (unit: EntryExitDecisionUnit): EntryRiskTouchSignal => ({
    direction: range.direction,
    bar: unit.bar,
    minute: unit.minute,
    granularity: unit.granularity,
  });

  for (const unit of units) {
    if (state === 'waiting-entry') {
      if (!touchesEntry(unit)) continue;
      if (touchesStop(unit)) {
        return { exitSignal: resultFor(unit, 'stop-loss', stopLossSignal.price) };
      }
      if (touchesRiskSide(unit)) {
        riskTouchSignal = riskResultFor(unit);
        state = 'active-adjusted-target';
      } else {
        state = 'active-default-target';
      }
      // An entry unit never takes profit because its internal event order is unknown.
      continue;
    }

    if (touchesStop(unit)) {
      return {
        riskTouchSignal,
        exitSignal: resultFor(unit, 'stop-loss', stopLossSignal.price),
      };
    }

    if (state === 'active-default-target') {
      if (touchesRiskSide(unit)) {
        riskTouchSignal = riskResultFor(unit);
        state = 'active-adjusted-target';
        // The first risk-side touch adjusts the target but cannot also take profit.
        continue;
      }
      if (touchesTarget(unit, takeProfitSignal.defaultPrice)) {
        return {
          riskTouchSignal,
          exitSignal: resultFor(unit, 'take-profit', takeProfitSignal.defaultPrice),
        };
      }
      continue;
    }

    if (touchesTarget(unit, takeProfitSignal.adjustedPrice)) {
      return {
        riskTouchSignal,
        exitSignal: resultFor(unit, 'take-profit', takeProfitSignal.adjustedPrice),
      };
    }
  }

  if (state !== 'waiting-entry'
    && forcedExitBar?.complete
    && bars.some(bar => bar.startMs === forcedExitBar.startMs)) {
    return {
      riskTouchSignal,
      exitSignal: {
        direction: range.direction,
        type: 'session-close',
        price: forcedExitBar.close,
        bar: forcedExitBar,
        granularity: 'five-minute-close',
        lineEndMs: forcedExitBar.endMs,
      },
    };
  }

  return { riskTouchSignal };
}

function beijingBoundaryMs(date: string, wallTime: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = wallTime.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function lifecycleSessionBars(triggerBar: Bar, bars5: readonly Bar[]): {
  bars: Bar[];
  policy: EntrySessionPolicy;
  entryCutoff: number;
  sessionEnd: number;
} {
  const triggerMinute = tradingMinuteAt(triggerBar.startMs);
  const policy = ENTRY_SESSION_POLICIES[triggerMinute.session];
  const entryCutoff = beijingBoundaryMs(triggerMinute.date, policy.entryCutoffWallTime);
  const sessionEnd = beijingBoundaryMs(triggerMinute.date, policy.sessionEndWallTime);
  if (triggerBar.session !== triggerMinute.session) {
    return { bars: [], policy, entryCutoff, sessionEnd };
  }

  const triggerIndex = bars5.findIndex(bar => bar.startMs === triggerBar.startMs);
  if (triggerIndex < 0) return { bars: [], policy, entryCutoff, sessionEnd };

  const bars: Bar[] = [];
  for (let index = triggerIndex; index < bars5.length; index += 1) {
    const bar = bars5[index];
    let minute;
    try {
      minute = tradingMinuteAt(bar.startMs);
    } catch {
      break;
    }
    if (minute.date !== triggerMinute.date
      || minute.session !== triggerMinute.session
      || bar.session !== triggerMinute.session
      || minute.index >= policy.sessionEndIndex) {
      break;
    }
    bars.push(bar);
  }
  return { bars, policy, entryCutoff, sessionEnd };
}

/** Complete entry lifecycle constrained to the trigger's Beijing trading session. */
export function entryLifecycle(
  entry: WeeklyEntry,
  bars5: readonly Bar[],
  minutes: readonly EdbMinuteRecord[] = [],
  tick = MARKET_PRICE_TICK,
): EntryLifecycle {
  const session = lifecycleSessionBars(entry.triggerBar, bars5);
  const candidateBars = session.bars;
  const focusFor = (bars: readonly Bar[]) => bars.slice(0, ENTRY_OBSERVATION_BAR_COUNT);
  if (!candidateBars.length) {
    return {
      analysisBars: [],
      focusBars: [],
      entryCutoff: session.entryCutoff,
      sessionEnd: session.sessionEnd,
      endReason: 'data-end',
    };
  }

  const indexedBars = candidateBars.map(bar => ({ bar, minute: tradingMinuteAt(bar.startMs) }));
  const forcedExitBar = indexedBars.find(({ bar, minute }) =>
    minute.index === session.policy.forcedExitBarStartIndex && bar.complete)?.bar;
  const sessionEndBar = indexedBars.find(({ bar, minute }) =>
    minute.index === session.policy.sessionEndIndex - 5 && bar.complete)?.bar;
  const reactionRange = entryReactionRange(entry.direction, candidateBars);
  const quarterSignal = reactionRange
    ? entryQuarterSignal(reactionRange, candidateBars, tick, session.entryCutoff)
    : undefined;
  const stopLossSignal = reactionRange ? entryStopLossSignal(reactionRange, tick) : undefined;
  const forcedExitIndex = forcedExitBar
    ? candidateBars.findIndex(bar => bar.startMs === forcedExitBar.startMs)
    : -1;
  const holdingBars = forcedExitIndex < 0
    ? candidateBars
    : candidateBars.slice(0, forcedExitIndex + 1);
  const takeProfitSignal = reactionRange && quarterSignal
    ? entryTakeProfitSignal(reactionRange, holdingBars, quarterSignal, tick)
    : undefined;

  let exitAnalysis: EntryExitAnalysis | undefined;
  if (reactionRange && quarterSignal && stopLossSignal && takeProfitSignal) {
    exitAnalysis = analyzeEntryExit(
      reactionRange,
      holdingBars,
      minutes,
      quarterSignal,
      stopLossSignal,
      takeProfitSignal,
      forcedExitBar,
    );
  }

  const exitSignal = exitAnalysis?.exitSignal;
  if (exitSignal) {
    const exitIndex = candidateBars.findIndex(bar => bar.startMs === exitSignal.bar.startMs);
    const analysisBars = exitIndex < 0 ? candidateBars : candidateBars.slice(0, exitIndex + 1);
    return {
      analysisBars,
      focusBars: focusFor(analysisBars),
      entryCutoff: session.entryCutoff,
      sessionEnd: session.sessionEnd,
      forcedExitBar,
      reactionRange,
      quarterSignal,
      stopLossSignal,
      takeProfitSignal,
      exitAnalysis,
      endReason: exitSignal.type,
    };
  }

  const endReason: EntryLifecycleEndReason = quarterSignal?.entryBar
    ? 'data-end'
    : sessionEndBar
      ? 'no-entry-session-end'
      : 'data-end';
  const analysisBars = sessionEndBar
    ? candidateBars.slice(0, candidateBars.findIndex(bar => bar.startMs === sessionEndBar.startMs) + 1)
    : candidateBars;
  return {
    analysisBars,
    focusBars: focusFor(analysisBars),
    entryCutoff: session.entryCutoff,
    sessionEnd: session.sessionEnd,
    forcedExitBar,
    reactionRange,
    quarterSignal,
    stopLossSignal,
    takeProfitSignal,
    exitAnalysis,
    endReason,
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
