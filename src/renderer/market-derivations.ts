import type {
  CandlestickData,
  HistogramData,
  LineData,
  UTCTimestamp,
} from 'lightweight-charts';
import { locateRolloverBar } from '../domain/contract-rollover';
import {
  exponentialMovingAverage,
  exponentialMovingAverageCooperatively,
  type EmaPoint,
} from '../domain/ema';
import {
  analyzeWeeklyEntries,
  analyzeWeeklyEntriesCooperatively,
  type WeeklyEntryAnalysis,
} from '../domain/weekly-entry';
import {
  analyzeWeeklyRange,
  analyzeWeeklyRangeCooperatively,
  type WeeklyBreakout,
} from '../domain/weekly-range';
import type {
  Bar,
  ContractRollover,
  Dataset,
  Period,
} from '../shared/types';

export interface LocatedRollover {
  rollover: ContractRollover;
  bar: Bar;
}

export interface MarketPeriodDerivations {
  period: Period;
  bars: Bar[];
  candles: CandlestickData[];
  mondayCandles: CandlestickData[];
  ema20: EmaPoint[];
  ema20Points: LineData[];
  emaByStart: Map<number, number>;
  mondayHighlights: Set<number>;
  weeklyBreakouts: WeeklyBreakout[];
  breakoutsByStart: Map<number, WeeklyBreakout[]>;
  weeklyEntryAnalysis: WeeklyEntryAnalysis;
  rolloverLocations: LocatedRollover[];
}

export interface MarketDerivations {
  dataset: Dataset;
  periods: Record<Period, MarketPeriodDerivations>;
}

export interface MarketSubchartPoints {
  volume: HistogramData[];
  openInterest: LineData[];
}

export type CooperativeYield = () => void | Promise<void>;

const derivationsByDataset = new WeakMap<Dataset, MarketDerivations>();
const DERIVATION_BATCH_SIZE = 4_096;

export function releaseMarketDerivations(dataset: Dataset): void {
  derivationsByDataset.delete(dataset);
}

export const marketTimeKey = (bar: Bar): UTCTimestamp => (
  bar.endMs / 1000
) as UTCTimestamp;

export function marketSubchartPoints(
  bars: readonly Bar[],
  fromIndex = 0,
  toIndexExclusive = bars.length,
): MarketSubchartPoints {
  const from = Math.max(0, Math.min(bars.length, Math.floor(fromIndex)));
  const to = Math.max(from, Math.min(
    bars.length,
    Math.ceil(toIndexExclusive),
  ));
  const volume = new Array<HistogramData>(to - from);
  const openInterest = new Array<LineData>(to - from);
  for (let index = from; index < to; index += 1) {
    const bar = bars[index];
    const targetIndex = index - from;
    const time = marketTimeKey(bar);
    volume[targetIndex] = {
      time,
      value: bar.volume,
      color: bar.close >= bar.open ? '#ef646e88' : '#28b59c88',
    };
    openInterest[targetIndex] = {
      time,
      value: bar.closeOi,
    };
  }
  return { volume, openInterest };
}

function groupWeeklyBreakouts(
  breakouts: WeeklyBreakout[],
): Map<number, WeeklyBreakout[]> {
  const byStart = new Map<number, WeeklyBreakout[]>();
  for (const breakout of breakouts) {
    const matches = byStart.get(breakout.bar.startMs) ?? [];
    matches.push(breakout);
    byStart.set(breakout.bar.startMs, matches);
  }
  return byStart;
}

function derivePeriod(
  dataset: Dataset,
  period: Period,
  bars: Bar[],
  bars5: Bar[],
): MarketPeriodDerivations {
  const candles = bars.map(bar => ({
    time: marketTimeKey(bar),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
  const weekly = period === 60
    ? analyzeWeeklyRange(bars)
    : { seedBars: [], breakouts: [] };
  const mondayHighlights = new Set(weekly.seedBars.map(bar => bar.startMs));
  const ema20 = period === 60
    ? exponentialMovingAverage(bars, 20)
    : [];
  const weeklyEntryAnalysis = period === 60
    ? analyzeWeeklyEntries(bars, bars5, ema20)
    : { entries: [], incompleteHours: 0 };

  return {
    period,
    bars,
    candles,
    mondayCandles: period === 60
      ? candles.map((point, index) => (
          mondayHighlights.has(bars[index].startMs)
            ? { ...point, borderColor: '#ffd27a', wickColor: '#ffd27a' }
            : point
        ))
      : candles,
    ema20,
    ema20Points: ema20.map(point => ({
      time: marketTimeKey(point.bar),
      value: point.value,
    })),
    emaByStart: new Map(ema20.map(point => [point.bar.startMs, point.value])),
    mondayHighlights,
    weeklyBreakouts: weekly.breakouts,
    breakoutsByStart: groupWeeklyBreakouts(weekly.breakouts),
    weeklyEntryAnalysis,
    rolloverLocations: dataset.rollovers.flatMap(rollover => {
      const bar = locateRolloverBar(rollover, bars, period);
      return bar ? [{ rollover, bar }] : [];
    }),
  };
}

async function derivePeriodCooperatively(
  dataset: Dataset,
  period: Period,
  bars: Bar[],
  bars5: Bar[],
  yieldControl: CooperativeYield,
): Promise<MarketPeriodDerivations> {
  const candles: CandlestickData[] = new Array(bars.length);

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const time = marketTimeKey(bar);
    candles[index] = {
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    };
    if (
      index + 1 < bars.length
      && (index + 1) % DERIVATION_BATCH_SIZE === 0
    ) {
      await yieldControl();
    }
  }

  const weekly = period === 60
    ? await analyzeWeeklyRangeCooperatively(bars, yieldControl)
    : { seedBars: [], breakouts: [] };
  const mondayHighlights = new Set(weekly.seedBars.map(bar => bar.startMs));
  const ema20 = period === 60
    ? await exponentialMovingAverageCooperatively(bars, 20, yieldControl)
    : [];
  const weeklyEntryAnalysis = period === 60
    ? await analyzeWeeklyEntriesCooperatively(
        bars,
        bars5,
        ema20,
        yieldControl,
      )
    : { entries: [], incompleteHours: 0 };
  const mondayCandles = period === 60
    ? new Array<CandlestickData>(candles.length)
    : candles;
  const ema20Points = new Array<LineData>(ema20.length);
  const emaByStart = new Map<number, number>();

  if (period === 60) {
    for (let index = 0; index < candles.length; index += 1) {
      const point = candles[index];
      mondayCandles[index] = mondayHighlights.has(bars[index].startMs)
        ? { ...point, borderColor: '#ffd27a', wickColor: '#ffd27a' }
        : point;
      if (
        index + 1 < candles.length
        && (index + 1) % DERIVATION_BATCH_SIZE === 0
      ) {
        await yieldControl();
      }
    }
  }

  for (let index = 0; index < ema20.length; index += 1) {
    const point = ema20[index];
    ema20Points[index] = {
      time: marketTimeKey(point.bar),
      value: point.value,
    };
    emaByStart.set(point.bar.startMs, point.value);
    if (
      index + 1 < ema20.length
      && (index + 1) % DERIVATION_BATCH_SIZE === 0
    ) {
      await yieldControl();
    }
  }

  return {
    period,
    bars,
    candles,
    mondayCandles,
    ema20,
    ema20Points,
    emaByStart,
    mondayHighlights,
    weeklyBreakouts: weekly.breakouts,
    breakoutsByStart: groupWeeklyBreakouts(weekly.breakouts),
    weeklyEntryAnalysis,
    rolloverLocations: dataset.rollovers.flatMap(rollover => {
      const bar = locateRolloverBar(rollover, bars, period);
      return bar ? [{ rollover, bar }] : [];
    }),
  };
}

export function marketDerivationsFor(dataset: Dataset): MarketDerivations {
  const cached = derivationsByDataset.get(dataset);
  if (cached) return cached;

  const derivations: MarketDerivations = {
    dataset,
    periods: {
      5: derivePeriod(dataset, 5, dataset.bars5, []),
      60: derivePeriod(dataset, 60, dataset.bars60, dataset.bars5),
    },
  };
  derivationsByDataset.set(dataset, derivations);
  return derivations;
}

export async function prepareMarketDerivations(
  dataset: Dataset,
  yieldControl: CooperativeYield,
): Promise<MarketDerivations> {
  const cached = derivationsByDataset.get(dataset);
  if (cached) return cached;

  const periods = {
    5: await derivePeriodCooperatively(
      dataset,
      5,
      dataset.bars5,
      [],
      yieldControl,
    ),
    60: await derivePeriodCooperatively(
      dataset,
      60,
      dataset.bars60,
      dataset.bars5,
      yieldControl,
    ),
  };
  const derivations: MarketDerivations = { dataset, periods };
  derivationsByDataset.set(dataset, derivations);
  return derivations;
}
