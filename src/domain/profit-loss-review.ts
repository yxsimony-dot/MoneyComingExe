import type { Bar, EdbMinuteRecord, MinuteDecisionGranularity } from '../shared/types';
import {
  entryLifecycle,
  type EntryExitType,
  type EntryLifecycle,
  type WeeklyEntry,
} from './weekly-entry';

export const REVIEW_INITIAL_CAPITAL = 1_000_000;
export const REVIEW_CONTRACTS_PER_TRADE = 1;
export const REVIEW_CONTRACT_MULTIPLIER = 10;

export interface ProfitLossReviewTrade {
  id: string;
  sourceIndex: number;
  direction: WeeklyEntry['direction'];
  entryTimeMs: number;
  entryPrice: number;
  entryBar: Bar;
  exitTimeMs: number;
  exitPrice: number;
  exitBar: Bar;
  exitType: EntryExitType;
  granularity: MinuteDecisionGranularity;
  exitMinuteStartMs?: number;
  pricePnl: number;
  cashPnl: number;
  capitalAfter: number;
}

export interface ProfitLossReviewIncompleteTrade {
  id: string;
  sourceIndex: number;
  direction: WeeklyEntry['direction'];
  entryTimeMs: number;
  entryPrice: number;
  entryBar: Bar;
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
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  returnRate: number;
  completedTrades: ProfitLossReviewTrade[];
  incompleteTrades: ProfitLossReviewIncompleteTrade[];
  equityCurve: ProfitLossReviewEquityPoint[];
  statistics: ProfitLossReviewStatistics;
}

function entryId(sourceIndex: number, entry: WeeklyEntry): string {
  return `review-${sourceIndex}-${entry.direction}-${entry.triggerBar.startMs}`;
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

/**
 * Replays each historical weekly entry as an independent one-lot trade.
 * Candidates without a true entry are ignored; entered lifecycles without an
 * exit remain visible separately and never affect realized capital.
 */
export function reviewProfitLoss(
  entries: readonly WeeklyEntry[],
  bars5: readonly Bar[],
  bars1: readonly EdbMinuteRecord[] = [],
): ProfitLossReviewResult {
  const completedTrades: Array<Omit<ProfitLossReviewTrade, 'capitalAfter'>> = [];
  const incompleteTrades: ProfitLossReviewIncompleteTrade[] = [];
  let ignoredNoEntryCount = 0;

  entries.forEach((entry, sourceIndex) => {
    const lifecycle = entryLifecycle(entry, bars5, bars1);
    const entryBar = lifecycle.quarterSignal?.entryBar;
    const id = entryId(sourceIndex, entry);
    if (!entryBar) {
      ignoredNoEntryCount += 1;
      return;
    }

    const exit = lifecycle.exitAnalysis?.exitSignal;
    if (!exit) {
      incompleteTrades.push({
        id,
        sourceIndex,
        direction: entry.direction,
        entryTimeMs: entryBar.startMs,
        entryPrice: lifecycle.quarterSignal!.price,
        entryBar,
        lifecycleEndReason: lifecycle.endReason,
      });
      return;
    }

    const pricePnl = priceProfit(entry.direction, lifecycle.quarterSignal!.price, exit.price);
    completedTrades.push({
      id,
      sourceIndex,
      direction: entry.direction,
      entryTimeMs: entryBar.startMs,
      entryPrice: lifecycle.quarterSignal!.price,
      entryBar,
      exitTimeMs: exitEventTime(exit.bar, exit.minute),
      exitPrice: exit.price,
      exitBar: exit.bar,
      exitType: exit.type,
      granularity: exit.granularity,
      exitMinuteStartMs: exit.minute?.startMs,
      pricePnl,
      cashPnl: pricePnl * REVIEW_CONTRACT_MULTIPLIER * REVIEW_CONTRACTS_PER_TRADE,
    });
  });

  const ordered = [...completedTrades].sort((left, right) =>
    left.exitTimeMs - right.exitTimeMs
    || left.entryTimeMs - right.entryTimeMs
    || left.sourceIndex - right.sourceIndex);
  let capital = REVIEW_INITIAL_CAPITAL;
  const equityCurve: ProfitLossReviewEquityPoint[] = [];
  const completedWithCapital: ProfitLossReviewTrade[] = ordered.map(trade => {
    capital += trade.cashPnl;
    const completed = { ...trade, capitalAfter: capital };
    equityCurve.push({
      tradeId: trade.id,
      sourceIndex: trade.sourceIndex,
      eventTimeMs: trade.exitTimeMs,
      capital,
      cashPnl: trade.cashPnl,
    });
    return completed;
  });

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
    initialCapital: REVIEW_INITIAL_CAPITAL,
    finalCapital: REVIEW_INITIAL_CAPITAL + totalPnl,
    totalPnl,
    returnRate: totalPnl / REVIEW_INITIAL_CAPITAL,
    completedTrades: completedWithCapital,
    incompleteTrades,
    equityCurve,
    statistics: {
      candidateCount: entries.length,
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
