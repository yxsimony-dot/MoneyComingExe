import type {
  Bar,
  EdbMinuteRecord,
  Instrument,
  InstrumentDefinition,
  MinuteDecisionGranularity,
} from '../shared/types';
import type { BeijingDateRange } from './time';
import {
  DEFAULT_ENTRY_STRATEGY_SETTINGS,
  entryLifecycle,
  entryStrategyDateRange,
  filterEntryLifecycleByDateRange,
  validateEntryStrategySettings,
  type EntryExitType,
  type EntryLifecycle,
  type EntryLifecycleAttempt,
  type EntryReactionPricingMode,
  type EntryStrategySettings,
  type WeeklyEntry,
} from './weekly-entry';

export const REVIEW_INITIAL_CAPITAL = 1_000_000;
export const REVIEW_FUTURES_LEVERAGE = 10;

export interface ProfitLossReviewTrade {
  id: string;
  sourceIndex: number;
  direction: WeeklyEntry['direction'];
  reactionBar: Bar;
  pricingMode: EntryReactionPricingMode;
  entryTimeMs: number;
  entryPrice: number;
  entryBar: Bar;
  exitTimeMs: number;
  exitPrice: number;
  exitBar: Bar;
  exitType: EntryExitType;
  granularity: MinuteDecisionGranularity;
  exitMinuteStartMs?: number;
  lots: number;
  capitalBefore: number;
  pricePnl: number;
  cashPnl: number;
  capitalAfter: number;
}

export interface ProfitLossReviewIncompleteTrade {
  id: string;
  sourceIndex: number;
  direction: WeeklyEntry['direction'];
  reactionBar: Bar;
  pricingMode: EntryReactionPricingMode;
  entryTimeMs: number;
  entryPrice: number;
  entryBar: Bar;
  lots: number;
  capitalBefore: number;
  lifecycleEndReason: EntryLifecycle['endReason'];
}

export interface ProfitLossReviewEquityPoint {
  tradeId: string;
  sourceIndex: number;
  eventTimeMs: number;
  capital: number;
  cashPnl: number;
}

export interface ProfitLossReviewStatistics {
  candidateCount: number;
  ignoredNoEntryCount: number;
  validEntryCount: number;
  completedTradeCount: number;
  incompleteTradeCount: number;
  winningTradeCount: number;
  losingTradeCount: number;
  flatTradeCount: number;
  takeProfitCount: number;
  stopLossCount: number;
  sessionCloseCount: number;
  winRate: number;
  cumulativeProfit: number;
  cumulativeLoss: number;
  averageProfit: number;
  averageLoss: number;
  profitLossRatio: number | null;
  maxDrawdown: number;
  maxDrawdownRate: number;
  largestWin: number;
  largestLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}

export interface ProfitLossReviewResult {
  instrument: Instrument;
  instrumentName: string;
  priceTick: number;
  contractMultiplier: number;
  leverage: number;
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  returnRate: number;
  completedTrades: ProfitLossReviewTrade[];
  incompleteTrades: ProfitLossReviewIncompleteTrade[];
  equityCurve: ProfitLossReviewEquityPoint[];
  statistics: ProfitLossReviewStatistics;
}

export interface ProfitLossReviewLifecycleCandidate {
  entry: WeeklyEntry;
  lifecycle: EntryLifecycle;
  sourceIndex: number;
}

function entryId(
  sourceIndex: number,
  attempt: EntryLifecycleAttempt,
  entry: WeeklyEntry,
): string {
  return `review-${sourceIndex}-attempt-${attempt.number}-${entry.direction}-${entry.triggerBar.startMs}`;
}

function exitEventTime(exitBar: Bar, minute?: EdbMinuteRecord): number {
  return minute?.startMs ?? exitBar.endMs;
}

function priceProfit(
  direction: WeeklyEntry['direction'],
  entryPrice: number,
  exitPrice: number,
): number {
  return direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function calculateMaxDrawdown(
  initialCapital: number,
  curve: readonly ProfitLossReviewEquityPoint[],
): { amount: number; rate: number } {
  let peak = initialCapital;
  let amount = 0;
  let rate = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.capital);
    const drawdown = peak - point.capital;
    amount = Math.max(amount, drawdown);
    rate = Math.max(rate, peak > 0 ? drawdown / peak : 0);
  }
  return { amount, rate };
}

function maxStreak(values: readonly boolean[]): number {
  let current = 0;
  let longest = 0;
  for (const value of values) {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

type CompletedTradeDraft = Omit<
  ProfitLossReviewTrade,
  'lots' | 'capitalBefore' | 'cashPnl' | 'capitalAfter'
> & {
  pricePnl: number;
  lots?: number;
  capitalBefore?: number;
};

type IncompleteTradeDraft = Omit<
  ProfitLossReviewIncompleteTrade,
  'lots' | 'capitalBefore'
> & {
  lots?: number;
  capitalBefore?: number;
};

type ReplayEvent =
  | {
    kind: 'entry';
    eventTimeMs: number;
    sourceIndex: number;
    trade: CompletedTradeDraft | IncompleteTradeDraft;
  }
  | {
    kind: 'exit';
    eventTimeMs: number;
    sourceIndex: number;
    trade: CompletedTradeDraft;
  };

export function calculateMaxLots(
  capital: number,
  entryPrice: number,
  contractMultiplier: number,
): number {
  if (capital <= 0 || entryPrice <= 0 || contractMultiplier <= 0) return 0;
  return Math.floor(
    capital * REVIEW_FUTURES_LEVERAGE / (entryPrice * contractMultiplier),
  );
}

/**
 * Replays each historical weekly entry as an independent fully funded trade.
 * Candidates without a true entry are ignored; entered lifecycles without an
 * exit remain visible separately and never affect realized capital. Each entry
 * uses the maximum whole number of lots allowed by the fixed 10x theoretical
 * notional leverage and the current instrument contract multiplier.
 */
export function reviewProfitLoss(
  entries: readonly WeeklyEntry[],
  bars5: readonly Bar[],
  bars1: readonly EdbMinuteRecord[] = [],
  definition: InstrumentDefinition,
  settings: EntryStrategySettings = DEFAULT_ENTRY_STRATEGY_SETTINGS,
): ProfitLossReviewResult {
  validateEntryStrategySettings(settings);
  return reviewProfitLossLifecycles(
    entries.map((entry, sourceIndex) => ({
      entry,
      lifecycle: entryLifecycle(
        entry,
        bars5,
        bars1,
        definition.priceTick,
        settings,
      ),
      sourceIndex,
    })),
    definition,
    entryStrategyDateRange(settings),
  );
}

/**
 * Replays already-computed complete lifecycles. The optional date range only
 * selects attempts by their actual entry bar; it never truncates later analysis
 * bars or exit evidence.
 */
export function reviewProfitLossLifecycles(
  candidates: readonly ProfitLossReviewLifecycleCandidate[],
  definition: InstrumentDefinition,
  range?: BeijingDateRange,
): ProfitLossReviewResult {
  const completedDrafts: CompletedTradeDraft[] = [];
  const incompleteDrafts: IncompleteTradeDraft[] = [];
  let ignoredNoEntryCount = 0;
  let candidateCount = 0;

  candidates.forEach(({ entry, lifecycle: completeLifecycle, sourceIndex }) => {
    const lifecycle = range
      ? filterEntryLifecycleByDateRange(completeLifecycle, range)
      : completeLifecycle;
    if (!lifecycle) return;

    candidateCount += 1;
    let hasTrueEntry = false;

    lifecycle.attempts.forEach(attempt => {
      const entryBar = attempt.quarterSignal?.entryBar;
      if (!entryBar) return;

      hasTrueEntry = true;
      const id = entryId(sourceIndex, attempt, entry);
      const entryPrice = attempt.quarterSignal!.price;
      const reactionBar = attempt.reactionRange!.reactionBar;
      const pricingMode = attempt.quarterSignal!.pricingMode;
      const exit = attempt.exitAnalysis?.exitSignal;
      if (!exit) {
        incompleteDrafts.push({
          id,
          sourceIndex,
          direction: entry.direction,
          reactionBar,
          pricingMode,
          entryTimeMs: entryBar.startMs,
          entryPrice,
          entryBar,
          lifecycleEndReason: attempt.endReason,
        });
        return;
      }

      completedDrafts.push({
        id,
        sourceIndex,
        direction: entry.direction,
        reactionBar,
        pricingMode,
        entryTimeMs: entryBar.startMs,
        entryPrice,
        entryBar,
        exitTimeMs: exitEventTime(exit.bar, exit.minute),
        exitPrice: exit.price,
        exitBar: exit.bar,
        exitType: exit.type,
        granularity: exit.granularity,
        exitMinuteStartMs: exit.minute?.startMs,
        pricePnl: priceProfit(entry.direction, entryPrice, exit.price),
      });
    });

    if (!hasTrueEntry && !range) ignoredNoEntryCount += 1;
  });

  const replayEvents: ReplayEvent[] = [
    ...completedDrafts.flatMap((trade): ReplayEvent[] => [
      {
        kind: 'entry',
        eventTimeMs: trade.entryTimeMs,
        sourceIndex: trade.sourceIndex,
        trade,
      },
      {
        kind: 'exit',
        eventTimeMs: trade.exitTimeMs,
        sourceIndex: trade.sourceIndex,
        trade,
      },
    ]),
    ...incompleteDrafts.map((trade): ReplayEvent => ({
      kind: 'entry',
      eventTimeMs: trade.entryTimeMs,
      sourceIndex: trade.sourceIndex,
      trade,
    })),
  ].sort((left, right) => {
    if (left.eventTimeMs !== right.eventTimeMs) {
      return left.eventTimeMs - right.eventTimeMs;
    }
    if (left.trade.id === right.trade.id) {
      return left.kind === 'entry' ? -1 : 1;
    }
    if (left.kind !== right.kind) {
      return left.kind === 'exit' ? -1 : 1;
    }
    return left.sourceIndex - right.sourceIndex;
  });

  let capital = REVIEW_INITIAL_CAPITAL;
  const equityCurve: ProfitLossReviewEquityPoint[] = [];
  const completedWithCapital: ProfitLossReviewTrade[] = [];
  const incompleteTrades: ProfitLossReviewIncompleteTrade[] = [];

  for (const event of replayEvents) {
    if (event.kind === 'entry') {
      const lots = calculateMaxLots(
        capital,
        event.trade.entryPrice,
        definition.contractMultiplier,
      );
      event.trade.lots = lots;
      event.trade.capitalBefore = capital;
      if ('lifecycleEndReason' in event.trade) {
        incompleteTrades.push({
          ...event.trade,
          lots,
          capitalBefore: capital,
        });
      }
      continue;
    }

    const lots = event.trade.lots ?? 0;
    const cashPnl = event.trade.pricePnl * definition.contractMultiplier * lots;
    capital += cashPnl;
    const completed: ProfitLossReviewTrade = {
      ...event.trade,
      lots,
      capitalBefore: event.trade.capitalBefore ?? REVIEW_INITIAL_CAPITAL,
      cashPnl,
      capitalAfter: capital,
    };
    completedWithCapital.push(completed);
    equityCurve.push({
      tradeId: event.trade.id,
      sourceIndex: event.trade.sourceIndex,
      eventTimeMs: event.trade.exitTimeMs,
      capital,
      cashPnl,
    });
  }

  const winning = completedWithCapital.filter(trade => trade.cashPnl > 0);
  const losing = completedWithCapital.filter(trade => trade.cashPnl < 0);
  const flat = completedWithCapital.filter(trade => trade.cashPnl === 0);
  const totalPnl = completedWithCapital.reduce((sum, trade) => sum + trade.cashPnl, 0);
  const cumulativeProfit = winning.reduce((sum, trade) => sum + trade.cashPnl, 0);
  const cumulativeLoss = losing.reduce((sum, trade) => sum + trade.cashPnl, 0);
  const drawdown = calculateMaxDrawdown(REVIEW_INITIAL_CAPITAL, equityCurve);
  const winLossValues = completedWithCapital.map(trade => trade.cashPnl > 0);
  const lossValues = completedWithCapital.map(trade => trade.cashPnl < 0);

  return {
    instrument: definition.id,
    instrumentName: definition.name,
    priceTick: definition.priceTick,
    contractMultiplier: definition.contractMultiplier,
    leverage: REVIEW_FUTURES_LEVERAGE,
    initialCapital: REVIEW_INITIAL_CAPITAL,
    finalCapital: capital,
    totalPnl,
    returnRate: totalPnl / REVIEW_INITIAL_CAPITAL,
    completedTrades: completedWithCapital,
    incompleteTrades,
    equityCurve,
    statistics: {
      candidateCount,
      ignoredNoEntryCount,
      validEntryCount: completedWithCapital.length + incompleteTrades.length,
      completedTradeCount: completedWithCapital.length,
      incompleteTradeCount: incompleteTrades.length,
      winningTradeCount: winning.length,
      losingTradeCount: losing.length,
      flatTradeCount: flat.length,
      takeProfitCount: completedWithCapital.filter(trade => trade.exitType === 'take-profit').length,
      stopLossCount: completedWithCapital.filter(trade => trade.exitType === 'stop-loss').length,
      sessionCloseCount: completedWithCapital.filter(trade => trade.exitType === 'session-close').length,
      winRate: completedWithCapital.length ? winning.length / completedWithCapital.length : 0,
      cumulativeProfit,
      cumulativeLoss,
      averageProfit: winning.length ? cumulativeProfit / winning.length : 0,
      averageLoss: losing.length ? cumulativeLoss / losing.length : 0,
      profitLossRatio: cumulativeLoss < 0 ? cumulativeProfit / Math.abs(cumulativeLoss) : null,
      maxDrawdown: drawdown.amount,
      maxDrawdownRate: drawdown.rate,
      largestWin: winning.length ? Math.max(...winning.map(trade => trade.cashPnl)) : 0,
      largestLoss: losing.length ? Math.min(...losing.map(trade => trade.cashPnl)) : 0,
      maxConsecutiveWins: maxStreak(winLossValues),
      maxConsecutiveLosses: maxStreak(lossValues),
    },
  };
}
