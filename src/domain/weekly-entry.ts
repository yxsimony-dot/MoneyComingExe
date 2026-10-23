import type { Bar, EdbMinuteRecord, MinuteDecisionGranularity } from '../shared/types';
import type { EmaPoint } from './ema';
import { completeMinutesForFiveMinuteBar, tradingMinuteAt } from './market-data';
import { timeIndexForRecords } from './time-index';
import {
  isBeijingDateInRange,
  validateBeijingDateRange,
  type BeijingDateRange,
} from './time';

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
export const MIN_REACTION_BODY_TICKS = 1;
export const MAX_REACTION_BODY_TICKS = 20;
export const MIN_ENTRY_RANGE_PERCENT = 0;
export const MAX_ENTRY_RANGE_PERCENT = 100;
export const DEFAULT_ENTRY_RANGE_PERCENT = 25;
export const MIN_STOP_LOSS_RANGE_PERCENT = 0;
export const MAX_STOP_LOSS_RANGE_PERCENT = 300;
export const DEFAULT_STOP_LOSS_RANGE_PERCENT = 75;
export const STOP_LOSS_RANGE_PERCENT_STEP = 5;
export const MIN_TAKE_PROFIT_RANGE_PERCENT = 0;
export const MAX_TAKE_PROFIT_RANGE_PERCENT = 500;
export const DEFAULT_TAKE_PROFIT_RANGE_PERCENT = 200;
export const TAKE_PROFIT_RANGE_PERCENT_STEP = 5;
export const MIN_OPPOSITE_CANDLE_COUNT = 0;
export const MAX_OPPOSITE_CANDLE_COUNT = 10;
export const DEFAULT_OPPOSITE_CANDLE_COUNT = 6;
export const SESSION_EXIT_MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30] as const;
export type SessionExitMinutes = typeof SESSION_EXIT_MINUTE_OPTIONS[number];
export const DEFAULT_SESSION_EXIT_MINUTES: SessionExitMinutes = 15;

export interface EntryStrategySettings {
  reactionBodyTicks: number;
  entryRangePercent: number;
  stopLossRangePercent: number;
  takeProfitRangePercent: number;
  oppositeCandleCount: number;
  sessionExitMinutes: SessionExitMinutes;
  reviewStartDate?: string;
  reviewEndDate?: string;
}

export const DEFAULT_ENTRY_STRATEGY_SETTINGS: Readonly<EntryStrategySettings> = Object.freeze({
  reactionBodyTicks: MIN_REACTION_BODY_TICKS,
  entryRangePercent: DEFAULT_ENTRY_RANGE_PERCENT,
  stopLossRangePercent: DEFAULT_STOP_LOSS_RANGE_PERCENT,
  takeProfitRangePercent: DEFAULT_TAKE_PROFIT_RANGE_PERCENT,
  oppositeCandleCount: DEFAULT_OPPOSITE_CANDLE_COUNT,
  sessionExitMinutes: DEFAULT_SESSION_EXIT_MINUTES,
});

export function validateEntryStrategySettings(
  settings: EntryStrategySettings,
): EntryStrategySettings {
  const reactionBodyTicks = settings?.reactionBodyTicks;
  if (!Number.isFinite(reactionBodyTicks)
    || !Number.isInteger(reactionBodyTicks)
    || reactionBodyTicks < MIN_REACTION_BODY_TICKS
    || reactionBodyTicks > MAX_REACTION_BODY_TICKS) {
    throw new RangeError(
      `Reaction body ticks must be an integer from ${MIN_REACTION_BODY_TICKS} to ${MAX_REACTION_BODY_TICKS}.`,
    );
  }
  const entryRangePercent = settings?.entryRangePercent;
  if (!Number.isFinite(entryRangePercent)
    || !Number.isInteger(entryRangePercent)
    || entryRangePercent < MIN_ENTRY_RANGE_PERCENT
    || entryRangePercent > MAX_ENTRY_RANGE_PERCENT) {
    throw new RangeError(
      `Entry range percent must be an integer from ${MIN_ENTRY_RANGE_PERCENT} to ${MAX_ENTRY_RANGE_PERCENT}.`,
    );
  }
  const stopLossRangePercent = settings?.stopLossRangePercent;
  if (!Number.isFinite(stopLossRangePercent)
    || !Number.isInteger(stopLossRangePercent)
    || stopLossRangePercent < MIN_STOP_LOSS_RANGE_PERCENT
    || stopLossRangePercent > MAX_STOP_LOSS_RANGE_PERCENT
    || stopLossRangePercent % STOP_LOSS_RANGE_PERCENT_STEP !== 0) {
    throw new RangeError(
      `Stop-loss range percent must be an integer from ${MIN_STOP_LOSS_RANGE_PERCENT} to ${MAX_STOP_LOSS_RANGE_PERCENT} in ${STOP_LOSS_RANGE_PERCENT_STEP}% steps.`,
    );
  }
  const takeProfitRangePercent = settings?.takeProfitRangePercent;
  if (!Number.isFinite(takeProfitRangePercent)
    || !Number.isInteger(takeProfitRangePercent)
    || takeProfitRangePercent < MIN_TAKE_PROFIT_RANGE_PERCENT
    || takeProfitRangePercent > MAX_TAKE_PROFIT_RANGE_PERCENT
    || takeProfitRangePercent % TAKE_PROFIT_RANGE_PERCENT_STEP !== 0) {
    throw new RangeError(
      `Take-profit range percent must be an integer from ${MIN_TAKE_PROFIT_RANGE_PERCENT} to ${MAX_TAKE_PROFIT_RANGE_PERCENT} in ${TAKE_PROFIT_RANGE_PERCENT_STEP}% steps.`,
    );
  }
  const oppositeCandleCount = settings?.oppositeCandleCount;
  if (!Number.isFinite(oppositeCandleCount)
    || !Number.isInteger(oppositeCandleCount)
    || oppositeCandleCount < MIN_OPPOSITE_CANDLE_COUNT
    || oppositeCandleCount > MAX_OPPOSITE_CANDLE_COUNT) {
    throw new RangeError(
      `Opposite candle count must be an integer from ${MIN_OPPOSITE_CANDLE_COUNT} to ${MAX_OPPOSITE_CANDLE_COUNT}.`,
    );
  }
  const sessionExitMinutes = settings?.sessionExitMinutes;
  if (!SESSION_EXIT_MINUTE_OPTIONS.includes(sessionExitMinutes)) {
    throw new RangeError(
      `Session exit minutes must be one of ${SESSION_EXIT_MINUTE_OPTIONS.join(', ')}.`,
    );
  }
  const hasReviewStartDate = settings.reviewStartDate !== undefined;
  const hasReviewEndDate = settings.reviewEndDate !== undefined;
  if (hasReviewStartDate !== hasReviewEndDate) {
    throw new RangeError('Review start and end dates must both be present or both be absent.');
  }
  if (hasReviewStartDate && hasReviewEndDate) {
    validateBeijingDateRange({
      startDate: settings.reviewStartDate!,
      endDate: settings.reviewEndDate!,
    });
  }
  return settings;
}

export function theoreticalDefaultRewardRiskRatio(
  settings: EntryStrategySettings,
): number | null {
  const {
    entryRangePercent,
    stopLossRangePercent,
    takeProfitRangePercent,
  } = validateEntryStrategySettings(settings);
  const riskPercent = entryRangePercent + stopLossRangePercent;
  if (riskPercent === 0) return null;
  return (100 + takeProfitRangePercent - entryRangePercent) / riskPercent;
}

export function entryStrategyDateRange(
  settings: EntryStrategySettings,
): BeijingDateRange | undefined {
  validateEntryStrategySettings(settings);
  return settings.reviewStartDate === undefined || settings.reviewEndDate === undefined
    ? undefined
    : {
      startDate: settings.reviewStartDate,
      endDate: settings.reviewEndDate,
    };
}

export interface EntryObservationLinePoint {
  bar: Bar;
  ema20: number;
  value: number;
}

export type EntryReactionPricingMode = 'configured-percent' | 'risk-edge';

export interface EntryReactionRange {
  direction: WeeklyEntry['direction'];
  pricingMode: EntryReactionPricingMode;
  reactionBar: Bar;
  extremeBar: Bar;
  high: number;
  low: number;
}

export interface EntryQuarterSignal {
  direction: WeeklyEntry['direction'];
  pricingMode: EntryReactionPricingMode;
  price: number;
  tick: number;
  rangeTicks: number;
  entryRangePercent: number;
  entryDistanceTicks: number;
  /** Compatibility alias for existing consumers. */
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
  forcedExitBarStartIndex?: number;
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

function subtractWallTimeMinutes(wallTime: string, minutes: number): string {
  const [hour, minute] = wallTime.split(':').map(Number);
  const totalMinutes = hour * 60 + minute - minutes;
  const normalized = (totalMinutes + 24 * 60) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function entrySessionPolicy(
  session: Bar['session'],
  sessionExitMinutes: SessionExitMinutes = DEFAULT_SESSION_EXIT_MINUTES,
): EntrySessionPolicy {
  if (!SESSION_EXIT_MINUTE_OPTIONS.includes(sessionExitMinutes)) {
    throw new RangeError(
      `Session exit minutes must be one of ${SESSION_EXIT_MINUTE_OPTIONS.join(', ')}.`,
    );
  }
  const base = ENTRY_SESSION_POLICIES[session];
  const entryCutoffIndex = base.sessionEndIndex - sessionExitMinutes;
  return {
    session,
    entryCutoffIndex,
    sessionEndIndex: base.sessionEndIndex,
    forcedExitBarStartIndex: sessionExitMinutes === 0 ? undefined : entryCutoffIndex - 5,
    entryCutoffWallTime: subtractWallTimeMinutes(base.sessionEndWallTime, sessionExitMinutes),
    sessionEndWallTime: base.sessionEndWallTime,
  };
}

export type EntryLifecycleEndReason =
  | 'take-profit'
  | 'stop-loss'
  | 'session-close'
  | 'open-position-session-end'
  | 'no-entry-session-end'
  | 'data-end';

export interface EntryLifecycleAttempt {
  number: 1 | 2;
  triggerBar: Bar;
  analysisBars: Bar[];
  reactionRange?: EntryReactionRange;
  quarterSignal?: EntryQuarterSignal;
  stopLossSignal?: EntryStopLossSignal;
  takeProfitSignal?: EntryTakeProfitSignal;
  exitAnalysis?: EntryExitAnalysis;
  endReason: EntryLifecycleEndReason;
}

export interface EntryAbandonedSetup {
  triggerBar: Bar;
  candidateBar: Bar;
  reactionRange: EntryReactionRange;
  reason: 'opposite-momentum';
}

export type EntryReactionSearchResult =
  | { kind: 'accepted'; range: EntryReactionRange }
  | { kind: 'abandoned-opposite-momentum'; setup: EntryAbandonedSetup }
  | { kind: 'not-found' };

export interface EntryLifecycle {
  analysisBars: Bar[];
  focusBars: Bar[];
  entryCutoff: number;
  sessionEnd: number;
  forcedExitBar?: Bar;
  attempts: EntryLifecycleAttempt[];
  abandonedSetups: EntryAbandonedSetup[];
  /** First-attempt compatibility aliases for existing consumers. */
  reactionRange?: EntryReactionRange;
  quarterSignal?: EntryQuarterSignal;
  stopLossSignal?: EntryStopLossSignal;
  takeProfitSignal?: EntryTakeProfitSignal;
  exitAnalysis?: EntryExitAnalysis;
  endReason: EntryLifecycleEndReason;
}

export function filterEntryLifecycleByDateRange(
  lifecycle: EntryLifecycle,
  range: BeijingDateRange,
): EntryLifecycle | undefined {
  validateBeijingDateRange(range);
  const attempts = lifecycle.attempts.filter(attempt => {
    const entryBar = attempt.quarterSignal?.entryBar;
    return entryBar ? isBeijingDateInRange(entryBar.startMs, range) : false;
  });
  if (!attempts.length) return undefined;

  const barsByStart = new Map<number, Bar>();
  for (const attempt of attempts) {
    for (const bar of attempt.analysisBars) barsByStart.set(bar.startMs, bar);
  }
  const analysisBars = [...barsByStart.values()].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const firstAttempt = attempts[0];
  const lastAttempt = attempts.at(-1)!;
  return {
    analysisBars,
    focusBars: analysisBars.slice(0, ENTRY_OBSERVATION_BAR_COUNT),
    entryCutoff: lifecycle.entryCutoff,
    sessionEnd: lifecycle.sessionEnd,
    forcedExitBar: lifecycle.forcedExitBar,
    attempts,
    abandonedSetups: [],
    reactionRange: firstAttempt.reactionRange,
    quarterSignal: firstAttempt.quarterSignal,
    stopLossSignal: firstAttempt.stopLossSignal,
    takeProfitSignal: firstAttempt.takeProfitSignal,
    exitAnalysis: firstAttempt.exitAnalysis,
    endReason: lastAttempt.endReason,
  };
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

function hasFilteredOppositeSequence(
  direction: WeeklyEntry['direction'],
  bars: readonly Bar[],
  candidateIndex: number,
  threshold: number,
): boolean {
  if (threshold === 0) return false;
  let count = 0;
  for (let index = candidateIndex - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    if (bar.close === bar.open) continue;
    const opposite = direction === 'long'
      ? bar.close < bar.open
      : bar.close > bar.open;
    if (!opposite) break;
    count += 1;
    if (count >= threshold) return true;
  }
  return false;
}

function buildEntryReactionRange(
  direction: WeeklyEntry['direction'],
  bars: readonly Bar[],
  attemptStartIndex: number,
  reactionIndex: number,
  pricingMode: EntryReactionPricingMode,
): EntryReactionRange {
  const reactionBar = bars[reactionIndex];
  const rangeBars = bars.slice(attemptStartIndex, reactionIndex + 1);
  const extremeBar = rangeBars.reduce((extreme, bar) => {
    if (direction === 'long') return bar.low < extreme.low ? bar : extreme;
    return bar.high > extreme.high ? bar : extreme;
  });

  return direction === 'long'
    ? { direction, pricingMode, reactionBar, extremeBar, high: reactionBar.high, low: extremeBar.low }
    : { direction, pricingMode, reactionBar, extremeBar, high: extremeBar.high, low: reactionBar.low };
}

function entryReactionSearchInHistory(
  direction: WeeklyEntry['direction'],
  bars: readonly Bar[],
  attemptStartIndex: number,
  searchEndIndex: number,
  tick: number,
  settings: EntryStrategySettings,
): EntryReactionSearchResult {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Reaction price tick must be positive.');
  const { reactionBodyTicks, oppositeCandleCount } = validateEntryStrategySettings(settings);
  const minimumBody = tick * reactionBodyTicks;
  for (let index = attemptStartIndex; index < searchEndIndex; index += 1) {
    const bar = bars[index];
    const body = direction === 'long'
      ? bar.close - bar.open
      : bar.open - bar.close;
    if (body < minimumBody) continue;

    const directionalWick = direction === 'long'
      ? bar.high - bar.close
      : bar.close - bar.low;
    if (directionalWick >= body * 3) continue;
    const pricingMode: EntryReactionPricingMode = directionalWick >= body * 2
      ? 'risk-edge'
      : 'configured-percent';
    const range = buildEntryReactionRange(direction, bars, attemptStartIndex, index, pricingMode);
    if (hasFilteredOppositeSequence(direction, bars, index, oppositeCandleCount)) {
      return {
        kind: 'abandoned-opposite-momentum',
        setup: {
          triggerBar: bars[attemptStartIndex],
          candidateBar: bar,
          reactionRange: range,
          reason: 'opposite-momentum',
        },
      };
    }

    return { kind: 'accepted', range };
  }
  return { kind: 'not-found' };
}

/** First directional response and the inclusive extreme through that response bar. */
export function entryReactionRange(
  direction: WeeklyEntry['direction'],
  bars: Bar[],
  tick: number,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): EntryReactionRange | undefined {
  const result = entryReactionSearchInHistory(direction, bars, 0, bars.length, tick, settings);
  return result.kind === 'accepted' ? result.range : undefined;
}

/** Classified entry price plus the first later touch inside the supplied lifecycle bars. */
export function entryQuarterSignal(
  range: EntryReactionRange,
  bars: readonly Bar[],
  tick: number,
  entryCutoff = Number.POSITIVE_INFINITY,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): EntryQuarterSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Entry price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }
  const { entryRangePercent } = validateEntryStrategySettings(settings);

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const entryDistanceTicks = range.pricingMode === 'risk-edge'
    ? 0
    : Math.ceil(rangeTicks * entryRangePercent / 100);
  const distance = entryDistanceTicks * tick;
  const price = range.direction === 'long' ? range.low + distance : range.high - distance;
  const reactionIndex = bars.findIndex(bar => bar.startMs === range.reactionBar.startMs);
  const candidates = reactionIndex < 0 ? [] : bars.slice(reactionIndex + 1);

  return {
    direction: range.direction,
    pricingMode: range.pricingMode,
    price,
    tick,
    rangeTicks,
    entryRangePercent,
    entryDistanceTicks,
    quarterTicks: entryDistanceTicks,
    lineStartBar: range.extremeBar,
    reactionBar: range.reactionBar,
    searchStartBar: candidates[0],
    entryBar: candidates.find(bar =>
      bar.startMs < entryCutoff && bar.low <= price && price <= bar.high),
  };
}

/** Planned stop-loss price beyond the reaction range's risk-side edge. */
export function entryStopLossSignal(
  range: EntryReactionRange,
  tick: number,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): EntryStopLossSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Stop-loss price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }
  const { stopLossRangePercent } = validateEntryStrategySettings(settings);

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const stopTicks = Math.ceil(rangeTicks * stopLossRangePercent / 100);
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
  tick: number,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): EntryTakeProfitSignal {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError('Take-profit price tick must be positive.');
  if (!Number.isFinite(range.high) || !Number.isFinite(range.low) || range.high < range.low) {
    throw new RangeError('Entry reaction range must have finite prices with high >= low.');
  }
  if (quarterSignal.direction !== range.direction) {
    throw new RangeError('Take-profit range and true-entry signal directions must match.');
  }
  const { takeProfitRangePercent } = validateEntryStrategySettings(settings);

  const rangeTicks = Math.round((range.high - range.low) / tick);
  const targetTicks = Math.ceil(rangeTicks * takeProfitRangePercent / 100);
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
  const minuteIndex = timeIndexForRecords(minutes);
  return bars.flatMap<EntryExitDecisionUnit>((bar): EntryExitDecisionUnit[] => {
    const completeMinutes = completeMinutesForFiveMinuteBar(bar, minutes, undefined, minuteIndex);
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

function lifecycleSessionBars(
  triggerBar: Bar,
  bars5: readonly Bar[],
  sessionExitMinutes: SessionExitMinutes,
): {
  bars: Bar[];
  policy: EntrySessionPolicy;
  entryCutoff: number;
  sessionEnd: number;
} {
  const triggerMinute = tradingMinuteAt(triggerBar.startMs);
  const policy = entrySessionPolicy(triggerMinute.session, sessionExitMinutes);
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

function buildEntryLifecycleAttempt(
  number: EntryLifecycleAttempt['number'],
  fullHistory: readonly Bar[],
  attemptStartIndex: number,
  searchEndIndex: number,
  reactionRange: EntryReactionRange,
  minutes: readonly EdbMinuteRecord[],
  tick: number,
  settings: EntryStrategySettings,
  entryCutoff: number,
  forcedExitBar?: Bar,
  sessionEndBar?: Bar,
): EntryLifecycleAttempt {
  const analysisBars = fullHistory.slice(attemptStartIndex, searchEndIndex);
  const quarterSignal = entryQuarterSignal(reactionRange, analysisBars, tick, entryCutoff, settings);
  const stopLossSignal = entryStopLossSignal(reactionRange, tick, settings);
  const forcedExitIndex = forcedExitBar
    ? analysisBars.findIndex(bar => bar.startMs === forcedExitBar.startMs)
    : -1;
  const holdingBars = forcedExitIndex < 0
    ? analysisBars
    : analysisBars.slice(0, forcedExitIndex + 1);
  const takeProfitSignal = entryTakeProfitSignal(
    reactionRange,
    holdingBars,
    quarterSignal,
    tick,
    settings,
  );

  const exitAnalysis = analyzeEntryExit(
    reactionRange,
    holdingBars,
    minutes,
    quarterSignal,
    stopLossSignal,
    takeProfitSignal,
    forcedExitIndex < 0 ? undefined : forcedExitBar,
  );

  const exitSignal = exitAnalysis?.exitSignal;
  if (exitSignal) {
    const exitIndex = analysisBars.findIndex(bar => bar.startMs === exitSignal.bar.startMs);
    const attemptBars = exitIndex < 0 ? analysisBars : analysisBars.slice(0, exitIndex + 1);
    return {
      number,
      triggerBar: analysisBars[0],
      analysisBars: attemptBars,
      reactionRange,
      quarterSignal,
      stopLossSignal,
      takeProfitSignal,
      exitAnalysis,
      endReason: exitSignal.type,
    };
  }

  const reachedSessionEnd = Boolean(
    sessionEndBar
    && analysisBars.some(bar => bar.startMs === sessionEndBar.startMs),
  );
  const entered = Boolean(quarterSignal?.entryBar);
  return {
    number,
    triggerBar: analysisBars[0],
    analysisBars,
    reactionRange,
    quarterSignal,
    stopLossSignal,
    takeProfitSignal,
    exitAnalysis,
    endReason: reachedSessionEnd && !entered
      ? 'no-entry-session-end'
      : reachedSessionEnd && entered && settings.sessionExitMinutes === 0
        ? 'open-position-session-end'
        : 'data-end',
  };
}

function findSecondAttemptTrigger(
  direction: WeeklyEntry['direction'],
  range: EntryReactionRange,
  bars: readonly Bar[],
): Bar | undefined {
  return bars.find(bar => direction === 'long'
    ? bar.low <= range.low
    : bar.high >= range.high);
}

/** Complete entry lifecycle constrained to the trigger's Beijing trading session. */
export function entryLifecycle(
  entry: WeeklyEntry,
  bars5: readonly Bar[],
  minutes: readonly EdbMinuteRecord[],
  tick: number,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): EntryLifecycle {
  validateEntryStrategySettings(settings);
  const session = lifecycleSessionBars(
    entry.triggerBar,
    bars5,
    settings.sessionExitMinutes,
  );
  const candidateBars = session.bars;
  const focusFor = (bars: readonly Bar[]) => bars.slice(0, ENTRY_OBSERVATION_BAR_COUNT);
  if (!candidateBars.length) {
    return {
      analysisBars: [],
      focusBars: [],
      entryCutoff: session.entryCutoff,
      sessionEnd: session.sessionEnd,
      attempts: [],
      abandonedSetups: [],
      endReason: 'data-end',
    };
  }

  const indexedBars = candidateBars.map(bar => ({ bar, minute: tradingMinuteAt(bar.startMs) }));
  const forcedExitBar = session.policy.forcedExitBarStartIndex === undefined
    ? undefined
    : indexedBars.find(({ bar, minute }) =>
      minute.index === session.policy.forcedExitBarStartIndex && bar.complete)?.bar;
  const sessionEndBar = indexedBars.find(({ bar, minute }) =>
    minute.index === session.policy.sessionEndIndex - 5 && bar.complete)?.bar;
  const naturalAnalysisBars = sessionEndBar
    ? candidateBars.slice(0, candidateBars.findIndex(bar => bar.startMs === sessionEndBar.startMs) + 1)
    : candidateBars;
  const naturalStartIndex = bars5.findIndex(
    bar => bar.startMs === naturalAnalysisBars[0]?.startMs,
  );
  const naturalEndIndex = naturalStartIndex + naturalAnalysisBars.length;
  const attempts: EntryLifecycleAttempt[] = [];
  const abandonedSetups: EntryAbandonedSetup[] = [];
  let analysisBars = naturalAnalysisBars;
  let endReason: EntryLifecycleEndReason = sessionEndBar ? 'no-entry-session-end' : 'data-end';
  let formalAttemptNumber: EntryLifecycleAttempt['number'] = 1;
  let searchStartIndex = naturalStartIndex;

  while (formalAttemptNumber <= 2 && searchStartIndex < naturalEndIndex) {
    const searchResult = entryReactionSearchInHistory(
      entry.direction,
      bars5,
      searchStartIndex,
      naturalEndIndex,
      tick,
      settings,
    );
    if (searchResult.kind === 'not-found') break;

    if (searchResult.kind === 'abandoned-opposite-momentum') {
      abandonedSetups.push(searchResult.setup);
      const candidateIndex = bars5.indexOf(searchResult.setup.candidateBar);
      const restartSearchStart = candidateIndex + 1;
      const restartTrigger = findSecondAttemptTrigger(
        entry.direction,
        searchResult.setup.reactionRange,
        bars5.slice(restartSearchStart, naturalEndIndex),
      );
      if (!restartTrigger) break;
      const restartIndex = bars5.indexOf(restartTrigger);
      if (restartIndex <= candidateIndex) break;
      searchStartIndex = restartIndex;
      continue;
    }

    const attempt = buildEntryLifecycleAttempt(
      formalAttemptNumber,
      bars5,
      searchStartIndex,
      naturalEndIndex,
      searchResult.range,
      minutes,
      tick,
      settings,
      session.entryCutoff,
      forcedExitBar,
      sessionEndBar,
    );
    attempts.push(attempt);
    endReason = attempt.endReason;

    const exit = attempt.exitAnalysis?.exitSignal;
    if (exit) {
      const exitIndex = bars5.indexOf(exit.bar);
      analysisBars = exitIndex < naturalStartIndex
        ? naturalAnalysisBars
        : bars5.slice(naturalStartIndex, exitIndex + 1);
    } else {
      analysisBars = naturalAnalysisBars;
    }
    if (!attempt.quarterSignal?.entryBar || !exit || formalAttemptNumber === 2) break;

    const exitIndex = bars5.indexOf(exit.bar);
    const restartSearchStart = exitIndex + 1;
    const restartTrigger = findSecondAttemptTrigger(
      entry.direction,
      searchResult.range,
      bars5.slice(restartSearchStart, naturalEndIndex),
    );
    if (!restartTrigger) {
      if (exitIndex < naturalEndIndex - 1) {
        analysisBars = naturalAnalysisBars;
        endReason = sessionEndBar ? 'no-entry-session-end' : 'data-end';
      }
      break;
    }

    const restartIndex = bars5.indexOf(restartTrigger);
    if (restartIndex <= exitIndex) break;
    formalAttemptNumber = 2;
    searchStartIndex = restartIndex;
  }

  const firstAttempt = attempts[0];
  return {
    analysisBars,
    focusBars: focusFor(analysisBars),
    entryCutoff: session.entryCutoff,
    sessionEnd: session.sessionEnd,
    forcedExitBar,
    attempts,
    abandonedSetups,
    reactionRange: firstAttempt?.reactionRange,
    quarterSignal: firstAttempt?.quarterSignal,
    stopLossSignal: firstAttempt?.stopLossSignal,
    takeProfitSignal: firstAttempt?.takeProfitSignal,
    exitAnalysis: firstAttempt?.exitAnalysis,
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
