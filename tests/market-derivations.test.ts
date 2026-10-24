import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locateRolloverBar, parseContractRollovers } from '../src/domain/contract-rollover';
import { parseBars } from '../src/domain/data';
import {
  exponentialMovingAverage,
  exponentialMovingAverageCooperatively,
} from '../src/domain/ema';
import {
  analyzeWeeklyEntries,
  analyzeWeeklyEntriesCooperatively,
} from '../src/domain/weekly-entry';
import {
  analyzeWeeklyRange,
  analyzeWeeklyRangeCooperatively,
} from '../src/domain/weekly-range';
import {
  marketDerivationsFor,
  marketSubchartPoints,
  marketTimeKey,
  prepareMarketDerivations,
  releaseMarketDerivations,
} from '../src/renderer/market-derivations';
import { DEFAULT_INSTRUMENT } from '../src/shared/instruments';
import type { Dataset } from '../src/shared/types';

function fixtureDataset(): Dataset {
  const prefix = 'futures_investigation_20261009/edb_main_continuous';
  return {
    instrument: DEFAULT_INSTRUMENT.id,
    definition: DEFAULT_INSTRUMENT,
    name: DEFAULT_INSTRUMENT.name,
    symbol: DEFAULT_INSTRUMENT.mainSymbol,
    bars1: [],
    bars5: parseBars(readFileSync(`${prefix}_5m.csv`, 'utf8'), '5m.csv'),
    bars60: parseBars(readFileSync(`${prefix}_60m.csv`, 'utf8'), '60m.csv'),
    mainContractMappings: [],
    rollovers: parseContractRollovers(
      readFileSync(`${prefix}_rollovers.csv`, 'utf8'),
    ),
    anomalies: [],
    auditAvailable: true,
    dataDirectory: 'fixture',
    snapshotSource: 'builtin',
    sourceLatestAt: '2026-10-09 15:00:00',
  };
}

describe('market derivations', () => {
  it('caches every Dataset identity without sharing results between datasets', () => {
    const dataset = fixtureDataset();
    const first = marketDerivationsFor(dataset);
    const cached = marketDerivationsFor(dataset);
    const other = marketDerivationsFor({ ...dataset });

    expect(cached).toBe(first);
    expect(cached.periods[5]).toBe(first.periods[5]);
    expect(cached.periods[60]).toBe(first.periods[60]);
    expect(other).not.toBe(first);
    expect(other.periods[5]).not.toBe(first.periods[5]);
    expect(other.periods[60]).not.toBe(first.periods[60]);
  });

  it('matches direct chart, EMA, weekly-entry and rollover derivations', () => {
    const dataset = fixtureDataset();
    const derived = marketDerivationsFor(dataset);
    const five = derived.periods[5];
    const sixty = derived.periods[60];
    const ema = exponentialMovingAverage(dataset.bars60, 20);
    const weekly = analyzeWeeklyRange(dataset.bars60);
    const entries = analyzeWeeklyEntries(dataset.bars60, dataset.bars5, ema);

    expect(five.bars).toBe(dataset.bars5);
    expect(sixty.bars).toBe(dataset.bars60);
    expect(five.candles).toEqual(dataset.bars5.map(bar => ({
      time: marketTimeKey(bar),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })));
    expect(marketSubchartPoints(dataset.bars60).volume).toEqual(
      dataset.bars60.map(bar => ({
      time: marketTimeKey(bar),
      value: bar.volume,
      color: bar.close >= bar.open ? '#ef646e88' : '#28b59c88',
      })),
    );
    expect(marketSubchartPoints(dataset.bars60).openInterest).toEqual(
      dataset.bars60.map(bar => ({
      time: marketTimeKey(bar),
      value: bar.closeOi,
      })),
    );
    expect(sixty.ema20).toEqual(ema);
    expect(sixty.ema20Points).toEqual(ema.map(point => ({
      time: marketTimeKey(point.bar),
      value: point.value,
    })));
    expect(sixty.mondayHighlights).toEqual(
      new Set(weekly.seedBars.map(bar => bar.startMs)),
    );
    expect(sixty.weeklyBreakouts).toEqual(weekly.breakouts);
    expect(sixty.weeklyEntryAnalysis).toEqual(entries);
    expect(five.weeklyBreakouts).toEqual([]);
    expect(five.weeklyEntryAnalysis).toEqual({
      entries: [],
      incompleteHours: 0,
    });

    for (const period of [5, 60] as const) {
      const bars = period === 5 ? dataset.bars5 : dataset.bars60;
      expect(derived.periods[period].rolloverLocations).toEqual(
        dataset.rollovers.flatMap(rollover => {
          const bar = locateRolloverBar(rollover, bars, period);
          return bar ? [{ rollover, bar }] : [];
        }),
      );
    }
  });

  it('builds subchart points only for the requested visible window', () => {
    const bars = fixtureDataset().bars5;
    const points = marketSubchartPoints(bars, 2, 5);

    expect(points.volume).toHaveLength(3);
    expect(points.openInterest).toHaveLength(3);
    expect(points.volume[0].time).toBe(marketTimeKey(bars[2]));
    expect(points.volume.at(-1)?.time).toBe(marketTimeKey(bars[4]));
    expect(points.openInterest.map(point => point.value)).toEqual(
      bars.slice(2, 5).map(bar => bar.closeOi),
    );
  });

  it('prepares the same cached derivations while yielding between large batches', async () => {
    const dataset = fixtureDataset();
    let yieldCount = 0;
    const prepared = await prepareMarketDerivations(dataset, async () => {
      yieldCount += 1;
      await Promise.resolve();
    });

    expect(yieldCount).toBeGreaterThan(0);
    expect(marketDerivationsFor(dataset)).toBe(prepared);
    expect(prepared).toEqual(marketDerivationsFor(dataset));
  });

  it('keeps cooperative weekly and EMA analysis identical to the synchronous path', async () => {
    const dataset = fixtureDataset();
    let yieldCount = 0;
    const yieldControl = async () => {
      yieldCount += 1;
      await Promise.resolve();
    };
    const ema = exponentialMovingAverage(dataset.bars60, 20);

    await expect(exponentialMovingAverageCooperatively(
      dataset.bars60,
      20,
      yieldControl,
      64,
    )).resolves.toEqual(ema);
    await expect(analyzeWeeklyRangeCooperatively(
      dataset.bars60,
      yieldControl,
      64,
    )).resolves.toEqual(analyzeWeeklyRange(dataset.bars60));
    await expect(analyzeWeeklyEntriesCooperatively(
      dataset.bars60,
      dataset.bars5,
      ema,
      yieldControl,
      64,
    )).resolves.toEqual(analyzeWeeklyEntries(
      dataset.bars60,
      dataset.bars5,
      ema,
    ));
    expect(yieldCount).toBeGreaterThan(0);
  });

  it('releases cached derivations for a retained Dataset identity', () => {
    const dataset = fixtureDataset();
    const first = marketDerivationsFor(dataset);

    releaseMarketDerivations(dataset);

    expect(marketDerivationsFor(dataset)).not.toBe(first);
  });
});
