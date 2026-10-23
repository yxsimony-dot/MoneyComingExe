import { describe, expect, it } from 'vitest';
import {
  TimeSeriesIndex,
  timeIndexForDataset,
  timeIndexForRecords,
} from '../src/domain/time-index';
import { DEFAULT_INSTRUMENT } from '../src/shared/instruments';
import type { Bar, Dataset, EdbMinuteRecord } from '../src/shared/types';

interface FixtureRecord {
  startMs: number;
  value: string;
}

const records: FixtureRecord[] = [
  { startMs: 10, value: 'a' },
  { startMs: 20, value: 'b' },
  { startMs: 30, value: 'c' },
  { startMs: 40, value: 'd' },
];

function bar(startMs: number): Bar {
  return {
    startMs,
    endMs: startMs + 5,
    start: String(startMs),
    end: String(startMs + 5),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    openOi: 1,
    closeOi: 1,
    session: 'day',
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
  };
}

function minute(startMs: number): EdbMinuteRecord {
  return {
    datetimeNano: String(BigInt(startMs) * 1_000_000n),
    startMs,
    start: String(startMs),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    openOi: 1,
    closeOi: 1,
  };
}

function dataset(
  bars1: EdbMinuteRecord[],
  bars5: Bar[],
  bars60: Bar[],
): Dataset {
  return {
    instrument: DEFAULT_INSTRUMENT.id,
    definition: DEFAULT_INSTRUMENT,
    name: DEFAULT_INSTRUMENT.name,
    symbol: DEFAULT_INSTRUMENT.mainSymbol,
    bars1,
    bars5,
    bars60,
    mainContractMappings: [],
    rollovers: [],
    anomalies: [],
    auditAvailable: false,
    dataDirectory: 'fixture',
    snapshotSource: 'builtin',
    sourceLatestAt: '2026-10-23 15:00:00',
  };
}

describe('TimeSeriesIndex', () => {
  it('provides exact positions and binary lower and upper boundaries', () => {
    const index = new TimeSeriesIndex(records);

    expect(index.startTimes).toEqual([10, 20, 30, 40]);
    expect(index.positionAt(10)).toBe(0);
    expect(index.positionAt(30)).toBe(2);
    expect(index.positionAt(31)).toBeUndefined();
    expect([0, 10, 15, 20, 40, 41].map(value => index.lowerBound(value)))
      .toEqual([0, 0, 1, 1, 3, 4]);
    expect([0, 10, 15, 20, 40, 41].map(value => index.upperBound(value)))
      .toEqual([0, 1, 1, 2, 4, 4]);
  });

  it('matches linear half-open range lookup for boundary and empty ranges', () => {
    const index = new TimeSeriesIndex(records);
    const ranges = [
      [0, 10],
      [0, 11],
      [10, 30],
      [15, 40],
      [20, 41],
      [40, 40],
      [50, 60],
      [40, 20],
    ] as const;

    for (const [startMs, endMs] of ranges) {
      expect(index.recordsInRange(startMs, endMs)).toEqual(
        records.filter(record => record.startMs >= startMs && record.startMs < endMs),
      );
    }
  });
});

describe('Dataset time index ownership', () => {
  it('builds reusable 1/5/60 minute indexes from Dataset identity', () => {
    const bars1 = [minute(10), minute(20)];
    const bars5 = [bar(10), bar(20)];
    const bars60 = [bar(10)];
    const firstDataset = dataset(bars1, bars5, bars60);
    const secondDataset = dataset([...bars1], [...bars5], [...bars60]);

    const first = timeIndexForDataset(firstDataset);
    const second = timeIndexForDataset(secondDataset);

    expect(timeIndexForDataset(firstDataset)).toBe(first);
    expect(first.bars1).toBe(timeIndexForRecords(bars1));
    expect(first.bars5).toBe(timeIndexForRecords(bars5));
    expect(first.bars60).toBe(timeIndexForRecords(bars60));
    expect(first.bars1.positionAt(20)).toBe(1);
    expect(first.bars5.recordsInRange(10, 20)).toEqual([bars5[0]]);
    expect(first.bars60.startTimes).toEqual([10]);
    expect(second).not.toBe(first);
    expect(second.bars1).not.toBe(first.bars1);
  });
});
