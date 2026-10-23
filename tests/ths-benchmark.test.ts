import { describe, expect, it } from 'vitest';
import {
  auditThsGlassMainMinuteProtection,
  compareThsGlassMainFiveMinuteBars,
  mergeThsGlassMainFiveMinuteBars,
  normalizeThsGlassMainFiveMinuteBars,
  rebuildThsGlassMainSixtyMinuteBars,
  type ThsKlinePageInput,
} from '../src/domain/ths-benchmark';
import { aggregateFiveMinuteBars, aggregateMinutes } from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';

const row = (
  closeTime: string,
  values: readonly number[] = [100, 102, 99, 101, 10, 20_200],
) => [parseBeijing(closeTime), ...values];

const page = (
  pageNumber: number,
  ...values: ReturnType<typeof row>[]
): ThsKlinePageInput => ({ pageNumber, values });

const CLOSED_THROUGH = parseBeijing('2026-10-10 00:00:00');

const localBar = (
  benchmark: ReturnType<typeof normalizeThsGlassMainFiveMinuteBars>[number],
  overrides: Partial<Bar> = {},
): Bar => ({
  startMs: benchmark.barStartMs,
  endMs: benchmark.barEndMs,
  start: benchmark.start,
  end: benchmark.end,
  open: benchmark.open,
  high: benchmark.high,
  low: benchmark.low,
  close: benchmark.close,
  volume: benchmark.volume,
  openOi: 200,
  closeOi: 201,
  session: benchmark.session,
  observedMinutes: benchmark.observedMinutes,
  expectedMinutes: benchmark.expectedMinutes,
  complete: benchmark.complete,
  ...overrides,
});

const fiveMinuteSequence = (
  start: string,
  count: number,
  session: Bar['session'],
  valueOffset = 0,
): Bar[] => {
  const firstStartMs = parseBeijing(start);
  return Array.from({ length: count }, (_, index) => {
    const startMs = firstStartMs + index * 5 * 60_000;
    const endMs = startMs + 5 * 60_000;
    const open = 100 + valueOffset + index;
    return {
      startMs,
      endMs,
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      open,
      high: open + 3,
      low: open - 2,
      close: open + 1,
      volume: index + 1,
      openOi: 1_000 + valueOffset + index,
      closeOi: 2_000 + valueOffset + index,
      session,
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    };
  });
};

const minuteSequence = (
  start: string,
  count: number,
): EdbMinuteRecord[] => {
  const firstStartMs = parseBeijing(start);
  return Array.from({ length: count }, (_, index) => {
    const startMs = firstStartMs + index * 60_000;
    const open = 100 + index;
    return {
      datetimeNano: String(BigInt(startMs) * 1_000_000n),
      startMs,
      start: formatBeijing(startMs),
      open,
      high: open + 3,
      low: open - 2,
      close: open + 1,
      volume: index + 1,
      openOi: 1_000 + index,
      closeOi: 2_000 + index,
    };
  });
};

describe('THS glass main five-minute normalization', () => {
  it('maps the 09:05 close timestamp to the local 09:00~09:05 bucket', () => {
    const result = normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:05:00')),
    ], CLOSED_THROUGH);

    expect(result).toEqual([expect.objectContaining({
      closeTimeMs: parseBeijing('2026-10-09 09:05:00'),
      barStartMs: parseBeijing('2026-10-09 09:00:00'),
      barEndMs: parseBeijing('2026-10-09 09:05:00'),
      start: '2026-10-09 09:00:00',
      end: '2026-10-09 09:05:00',
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 10,
      turnover: 20_200,
      session: 'day',
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    })]);
  });

  it('validates day, night, and both sides of the intraday break', () => {
    const result = normalizeThsGlassMainFiveMinuteBars([
      page(
        1,
        row('2026-10-09 10:15:00'),
        row('2026-10-09 10:35:00'),
        row('2026-10-09 22:05:00'),
      ),
    ], CLOSED_THROUGH);

    expect(result.map(bar => [bar.start, bar.end, bar.session])).toEqual([
      ['2026-10-09 10:10:00', '2026-10-09 10:15:00', 'day'],
      ['2026-10-09 10:30:00', '2026-10-09 10:35:00', 'day'],
      ['2026-10-09 22:00:00', '2026-10-09 22:05:00', 'night'],
    ]);
    expect(() => normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 10:20:00')),
    ], CLOSED_THROUGH)).toThrow(/非交易分钟|合法玻璃 5 分钟桶/);
  });

  it('sorts backward-fetched pages into one ascending timeline', () => {
    const result = normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:15:00'), row('2026-10-09 09:20:00')),
      page(2, row('2026-10-09 09:05:00'), row('2026-10-09 09:10:00')),
    ], CLOSED_THROUGH);

    expect(result.map(bar => bar.end)).toEqual([
      '2026-10-09 09:05:00',
      '2026-10-09 09:10:00',
      '2026-10-09 09:15:00',
      '2026-10-09 09:20:00',
    ]);
  });

  it('rejects duplicate records across pages', () => {
    expect(() => normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:05:00')),
      page(2, row('2026-10-09 09:05:00')),
    ], CLOSED_THROUGH)).toThrow(/记录重复/);
  });

  it('rejects descending records inside a raw page', () => {
    expect(() => normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:10:00'), row('2026-10-09 09:05:00')),
    ], CLOSED_THROUGH)).toThrow(/未严格递增/);
  });

  it.each([
    ['missing field', [parseBeijing('2026-10-09 09:05:00'), 100]],
    ['non-finite field', row('2026-10-09 09:05:00', [100, 102, 99, Number.NaN, 10, 1])],
    ['invalid OHLC', row('2026-10-09 09:05:00', [98, 102, 99, 101, 10, 1])],
    ['negative volume', row('2026-10-09 09:05:00', [100, 102, 99, 101, -1, 1])],
    ['open bucket', row('2026-10-10 09:05:00')],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeThsGlassMainFiveMinuteBars([
      { pageNumber: 1, values: [value] },
    ], CLOSED_THROUGH)).toThrow();
  });
});

describe('THS glass main five-minute comparison', () => {
  it('reports timeline gaps, field rates, absolute differences, and separate ranges', () => {
    const benchmark = normalizeThsGlassMainFiveMinuteBars([
      page(
        1,
        row('2026-10-09 09:05:00'),
        row('2026-10-09 09:10:00'),
        row('2026-10-09 09:15:00'),
        row('2026-10-09 09:20:00'),
        row('2026-10-09 09:25:00'),
        row('2026-10-09 09:30:00'),
      ),
    ], CLOSED_THROUGH);
    const local = benchmark.map(bar => localBar(bar));
    local.splice(1, 1);
    Object.assign(local[1], { open: 101, volume: 15 });
    Object.assign(local[2], { high: 104 });
    Object.assign(local[4], { low: 95 });
    local.push(localBar(benchmark.at(-1)!, {
      startMs: parseBeijing('2026-10-09 09:30:00'),
      endMs: parseBeijing('2026-10-09 09:35:00'),
      start: '2026-10-09 09:30:00',
      end: '2026-10-09 09:35:00',
    }));

    const report = compareThsGlassMainFiveMinuteBars(benchmark, local);

    expect(report.benchmark).toEqual({
      rowCount: 6,
      firstStartMs: parseBeijing('2026-10-09 09:00:00'),
      firstStart: '2026-10-09 09:00:00',
      lastEndMs: parseBeijing('2026-10-09 09:30:00'),
      lastEnd: '2026-10-09 09:30:00',
    });
    expect(report.local).toEqual(expect.objectContaining({
      rowCount: 6,
      lastEndMs: parseBeijing('2026-10-09 09:35:00'),
      lastEnd: '2026-10-09 09:35:00',
    }));
    expect(report.timeline).toEqual({
      oneToOne: false,
      matchedRows: 5,
      missingFromLocal: [{
        barStartMs: parseBeijing('2026-10-09 09:05:00'),
        start: '2026-10-09 09:05:00',
      }],
      extraInLocal: [{
        barStartMs: parseBeijing('2026-10-09 09:30:00'),
        start: '2026-10-09 09:30:00',
      }],
    });
    expect(report.fields).toEqual({
      open: {
        comparedRows: 5,
        matchingRows: 4,
        differingRows: 1,
        matchRate: 0.8,
        absoluteDifferenceTotal: 1,
        maximumAbsoluteDifference: 1,
      },
      high: {
        comparedRows: 5,
        matchingRows: 4,
        differingRows: 1,
        matchRate: 0.8,
        absoluteDifferenceTotal: 2,
        maximumAbsoluteDifference: 2,
      },
      low: {
        comparedRows: 5,
        matchingRows: 4,
        differingRows: 1,
        matchRate: 0.8,
        absoluteDifferenceTotal: 4,
        maximumAbsoluteDifference: 4,
      },
      close: {
        comparedRows: 5,
        matchingRows: 5,
        differingRows: 0,
        matchRate: 1,
        absoluteDifferenceTotal: 0,
        maximumAbsoluteDifference: 0,
      },
      volume: {
        comparedRows: 5,
        matchingRows: 4,
        differingRows: 1,
        matchRate: 0.8,
        absoluteDifferenceTotal: 5,
        maximumAbsoluteDifference: 5,
      },
    });
    expect(report.differences.map(difference => ({
      start: difference.start,
      fields: difference.differences.map(field => field.field),
    }))).toEqual([
      { start: '2026-10-09 09:10:00', fields: ['open', 'volume'] },
      { start: '2026-10-09 09:15:00', fields: ['high'] },
      { start: '2026-10-09 09:25:00', fields: ['low'] },
    ]);
    expect(report.maximumPriceDifference).toEqual({
      field: 'low',
      barStartMs: parseBeijing('2026-10-09 09:25:00'),
      start: '2026-10-09 09:25:00',
      benchmarkValue: 99,
      localValue: 95,
      absoluteDifference: 4,
    });
    expect(report.continuousDifferenceRanges).toEqual([
      {
        firstBarStartMs: parseBeijing('2026-10-09 09:10:00'),
        firstStart: '2026-10-09 09:10:00',
        lastBarStartMs: parseBeijing('2026-10-09 09:15:00'),
        lastEndMs: parseBeijing('2026-10-09 09:20:00'),
        lastEnd: '2026-10-09 09:20:00',
        rowCount: 2,
        fields: ['open', 'high', 'volume'],
      },
      {
        firstBarStartMs: parseBeijing('2026-10-09 09:25:00'),
        firstStart: '2026-10-09 09:25:00',
        lastBarStartMs: parseBeijing('2026-10-09 09:25:00'),
        lastEndMs: parseBeijing('2026-10-09 09:30:00'),
        lastEnd: '2026-10-09 09:30:00',
        rowCount: 1,
        fields: ['low'],
      },
    ]);
  });

  it('rejects duplicate timestamps instead of silently aligning by array position', () => {
    const benchmark = normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:05:00')),
    ], CLOSED_THROUGH);
    const duplicate = localBar(benchmark[0]);

    expect(() => compareThsGlassMainFiveMinuteBars(
      benchmark,
      [duplicate, { ...duplicate }],
    )).toThrow(/本地快照包含重复 5 分钟记录/);
  });
});

describe('THS glass main benchmark merge', () => {
  it('replaces only OHLCV and preserves every local non-benchmark field', () => {
    const benchmark = normalizeThsGlassMainFiveMinuteBars([
      page(
        1,
        row('2026-10-09 09:05:00', [110, 115, 108, 114, 88, 10_000]),
        row('2026-10-09 09:10:00', [114, 118, 113, 117, 99, 11_000]),
      ),
    ], CLOSED_THROUGH);
    const local = benchmark.map((bar, index) => localBar(bar, {
      open: 100 + index,
      high: 105 + index,
      low: 98 + index,
      close: 104 + index,
      volume: 10 + index,
      openOi: 2_000 + index,
      closeOi: 2_100 + index,
    }));
    const original = structuredClone(local);

    const result = mergeThsGlassMainFiveMinuteBars(benchmark, local);

    expect(result.differenceReport.timeline.oneToOne).toBe(true);
    expect(result.bars5).toEqual([
      {
        ...original[0],
        open: 110,
        high: 115,
        low: 108,
        close: 114,
        volume: 88,
      },
      {
        ...original[1],
        open: 114,
        high: 118,
        low: 113,
        close: 117,
        volume: 99,
      },
    ]);
    expect(result.bars5.map(bar => [bar.openOi, bar.closeOi])).toEqual([
      [2_000, 2_100],
      [2_001, 2_101],
    ]);
    expect(local).toEqual(original);
  });

  it('rejects a candidate when either timeline lacks a unique corresponding row', () => {
    const benchmark = normalizeThsGlassMainFiveMinuteBars([
      page(
        1,
        row('2026-10-09 09:05:00'),
        row('2026-10-09 09:10:00'),
      ),
    ], CLOSED_THROUGH);

    expect(() => mergeThsGlassMainFiveMinuteBars(
      benchmark,
      [localBar(benchmark[0])],
    )).toThrow(/不能一一对应.*本地缺少 1 根/);
  });

  it.each([
    ['non-finite open OI', { openOi: Number.NaN }],
    ['negative close OI', { closeOi: -1 }],
  ])('rejects %s instead of clearing or fabricating holdings', (_name, overrides) => {
    const benchmark = normalizeThsGlassMainFiveMinuteBars([
      page(1, row('2026-10-09 09:05:00')),
    ], CLOSED_THROUGH);

    expect(() => mergeThsGlassMainFiveMinuteBars(
      benchmark,
      [localBar(benchmark[0], overrides)],
    )).toThrow(/持仓量无效/);
  });
});

describe('THS glass main sixty-minute rebuild', () => {
  it('rebuilds only complete segment-local buckets across breaks and sessions', () => {
    const bars5 = [
      ...fiveMinuteSequence('2026-10-09 09:00:00', 12, 'day'),
      ...fiveMinuteSequence('2026-10-09 10:00:00', 3, 'day', 100),
      ...fiveMinuteSequence('2026-10-09 10:30:00', 12, 'day', 200),
      ...fiveMinuteSequence('2026-10-09 21:00:00', 12, 'night', 300),
    ];

    const result = rebuildThsGlassMainSixtyMinuteBars(bars5);

    expect(result.map(bar => [bar.start, bar.end, bar.session])).toEqual([
      ['2026-10-09 09:00:00', '2026-10-09 10:00:00', 'day'],
      ['2026-10-09 10:00:00', '2026-10-09 10:15:00', 'day'],
      ['2026-10-09 10:30:00', '2026-10-09 11:30:00', 'day'],
      ['2026-10-09 21:00:00', '2026-10-09 22:00:00', 'night'],
    ]);
    expect(result[1]).toEqual(expect.objectContaining({
      start: '2026-10-09 10:00:00',
      end: '2026-10-09 10:15:00',
      observedMinutes: 15,
      expectedMinutes: 15,
      complete: true,
    }));
  });

  it('uses final five-minute OHLCV and holdings without retaining stale sixty-minute values', () => {
    const bars5 = fiveMinuteSequence('2026-10-09 09:00:00', 12, 'day');
    bars5[4] = {
      ...bars5[4],
      high: 999,
      low: 1,
      volume: 100,
    };
    const staleSixtyMinuteBar: Bar = {
      ...bars5[0],
      endMs: parseBeijing('2026-10-09 10:00:00'),
      end: '2026-10-09 10:00:00',
      open: -1,
      high: -1,
      low: -1,
      close: -1,
      volume: -1,
      openOi: -1,
      closeOi: -1,
      observedMinutes: 60,
      expectedMinutes: 60,
    };

    const result = rebuildThsGlassMainSixtyMinuteBars(bars5);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      startMs: parseBeijing('2026-10-09 09:00:00'),
      endMs: parseBeijing('2026-10-09 10:00:00'),
      start: '2026-10-09 09:00:00',
      end: '2026-10-09 10:00:00',
      open: 100,
      high: 999,
      low: 1,
      close: 112,
      volume: 173,
      openOi: 1_000,
      closeOi: 2_011,
      session: 'day',
      observedMinutes: 60,
      expectedMinutes: 60,
      complete: true,
    });
    expect(result[0]).not.toEqual(staleSixtyMinuteBar);
  });
});

describe('THS glass main protected minute audit', () => {
  it('reports protected differences while preserving minute and visible bars', () => {
    const originalMinutes = minuteSequence('2026-10-09 09:00:00', 60);
    const bars5 = aggregateMinutes(
      originalMinutes,
      5,
      parseBeijing('2026-10-09 10:00:00'),
    );
    const bars60 = aggregateFiveMinuteBars(bars5).filter(bar => bar.complete);
    const bars1 = structuredClone(originalMinutes);
    Object.assign(bars1[0], {
      open: 500,
      high: 503,
      low: 498,
      close: 501,
      volume: 999,
    });
    const originalBars1 = structuredClone(bars1);
    const originalBars5 = structuredClone(bars5);
    const originalBars60 = structuredClone(bars60);

    const result = auditThsGlassMainMinuteProtection(
      bars1,
      bars5,
      bars60,
      parseBeijing('2026-10-09 09:00:00'),
      parseBeijing('2026-10-09 09:05:00'),
    );

    expect(result.bars1).toEqual(originalBars1);
    expect(result.bars5).toEqual(originalBars5);
    expect(result.bars60).toEqual(originalBars60);
    expect(result.report).toMatchObject({
      preservedMinuteRows: 5,
      protectedBarRows: 1,
      matchingRows: 0,
      differingRows: 1,
      differences: [{
        start: '2026-10-09 09:00:00',
        minuteRows: 5,
        expectedMinuteRows: 5,
        coverageComplete: true,
      }],
    });
    expect(result.report.differences[0].differences.map(difference => difference.field))
      .toEqual(['open', 'high', 'low', 'volume']);
    expect(bars1).toEqual(originalBars1);
    expect(bars5).toEqual(originalBars5);
    expect(bars60).toEqual(originalBars60);
  });

  it('keeps strict one-minute reconciliation outside the protected range', () => {
    const bars1 = minuteSequence('2026-10-09 09:00:00', 60);
    const bars5 = aggregateMinutes(
      bars1,
      5,
      parseBeijing('2026-10-09 10:00:00'),
    );
    const bars60 = aggregateFiveMinuteBars(bars5).filter(bar => bar.complete);
    Object.assign(bars1[5], {
      open: 500,
      high: 503,
      low: 498,
      close: 501,
    });

    expect(() => auditThsGlassMainMinuteProtection(
      bars1,
      bars5,
      bars60,
      parseBeijing('2026-10-09 09:00:00'),
      parseBeijing('2026-10-09 09:05:00'),
    )).toThrow(/1 分钟与 5 分钟行情对账不一致：2026-10-09 09:05:00/);
  });

  it('audits missing protected minutes instead of fabricating or replacing bars', () => {
    const originalMinutes = minuteSequence('2026-10-09 09:00:00', 60);
    const bars5 = aggregateMinutes(
      originalMinutes,
      5,
      parseBeijing('2026-10-09 10:00:00'),
    );
    const bars60 = aggregateFiveMinuteBars(bars5).filter(bar => bar.complete);
    const bars1 = originalMinutes.filter(record => (
      record.start !== '2026-10-09 09:02:00'
    ));

    const result = auditThsGlassMainMinuteProtection(
      bars1,
      bars5,
      bars60,
      parseBeijing('2026-10-09 09:00:00'),
      parseBeijing('2026-10-09 09:05:00'),
    );

    expect(result.report).toMatchObject({
      preservedMinuteRows: 4,
      differingRows: 1,
      differences: [{
        minuteRows: 4,
        expectedMinuteRows: 5,
        coverageComplete: false,
      }],
    });
    expect(result.report.differences[0].differences).toHaveLength(7);
    expect(result.report.differences[0].differences.every(difference => (
      difference.minuteAggregateValue === null
      && difference.absoluteDifference === null
    ))).toBe(true);
  });
});
