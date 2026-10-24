import type { Bar, Dataset, EdbMinuteRecord } from '../shared/types';

export interface TimeIndexedRecord {
  startMs: number;
}

export interface TimeRangeBounds {
  startIndex: number;
  endIndex: number;
}

export interface TimeSeriesIndexMetadata {
  startTimes: number[];
}

export class TimeSeriesIndex<T extends TimeIndexedRecord> {
  private cachedStartTimes?: readonly number[];

  constructor(
    readonly records: readonly T[],
    metadata?: TimeSeriesIndexMetadata,
  ) {
    if (metadata && metadata.startTimes.length !== records.length) {
      throw new Error('时间索引记录数与行情记录不一致');
    }
  }

  get startTimes(): readonly number[] {
    this.cachedStartTimes ??= this.records.map(record => record.startMs);
    return this.cachedStartTimes;
  }

  positionAt(startMs: number): number | undefined {
    const position = this.lowerBound(startMs);
    return this.records[position]?.startMs === startMs ? position : undefined;
  }

  lowerBound(startMs: number): number {
    let low = 0;
    let high = this.records.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.records[middle].startMs < startMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  upperBound(startMs: number): number {
    let low = 0;
    let high = this.records.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.records[middle].startMs <= startMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  rangeBounds(startMs: number, endMs: number): TimeRangeBounds {
    const startIndex = this.lowerBound(startMs);
    if (endMs <= startMs) return { startIndex, endIndex: startIndex };
    return {
      startIndex,
      endIndex: Math.max(startIndex, this.lowerBound(endMs)),
    };
  }

  recordsInRange(startMs: number, endMs: number): T[] {
    const { startIndex, endIndex } = this.rangeBounds(startMs, endMs);
    return this.records.slice(startIndex, endIndex);
  }
}

export interface DatasetTimeIndex {
  bars1: TimeSeriesIndex<EdbMinuteRecord>;
  bars5: TimeSeriesIndex<Bar>;
  bars60: TimeSeriesIndex<Bar>;
}

const recordIndexes = new WeakMap<object, TimeSeriesIndex<TimeIndexedRecord>>();
const datasetIndexes = new WeakMap<Dataset, DatasetTimeIndex>();

export function timeIndexForRecords<T extends TimeIndexedRecord>(
  records: readonly T[],
): TimeSeriesIndex<T> {
  const cached = recordIndexes.get(records);
  if (cached) return cached as TimeSeriesIndex<T>;
  const created = new TimeSeriesIndex(records);
  recordIndexes.set(records, created as TimeSeriesIndex<TimeIndexedRecord>);
  return created;
}

export function timeIndexMetadataForRecords<T extends TimeIndexedRecord>(
  records: readonly T[],
): TimeSeriesIndexMetadata {
  const index = timeIndexForRecords(records);
  return { startTimes: [...index.startTimes] };
}

export function primeTimeIndexForRecords<T extends TimeIndexedRecord>(
  records: readonly T[],
  metadata: TimeSeriesIndexMetadata,
): TimeSeriesIndex<T> {
  const created = new TimeSeriesIndex(records, metadata);
  recordIndexes.set(records, created as TimeSeriesIndex<TimeIndexedRecord>);
  return created;
}

export function timeIndexForDataset(dataset: Dataset): DatasetTimeIndex {
  const cached = datasetIndexes.get(dataset);
  if (cached) return cached;
  const created: DatasetTimeIndex = {
    bars1: timeIndexForRecords(dataset.bars1),
    bars5: timeIndexForRecords(dataset.bars5),
    bars60: timeIndexForRecords(dataset.bars60),
  };
  datasetIndexes.set(dataset, created);
  return created;
}
