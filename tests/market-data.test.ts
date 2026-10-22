import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  assertContinuousBarCoverage,
  assertMinuteCoverageMatchesFiveMinuteBars,
  assertMinuteRecordsValid,
  assertSegmentedSixtyMinuteBarsValid,
  completeMinutesForFiveMinuteBar,
  mergeBars,
  mergeMinuteHistory,
  mergeMinuteChunks,
  parseEdbMinuteCsv,
  reconcileBars,
  serializeMinuteRecords,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord, MainContractMapping } from '../src/shared/types';
import {
  DEFAULT_INSTRUMENT,
  type InstrumentDefinition,
  type TradingSchedule,
} from '../src/shared/instruments';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const nano = (time: string) => String(BigInt(parseBeijing(time)) * 1_000_000n);
const row = (
  time: string,
  values: [number | string, number | string, number | string, number | string, number | string, number | string, number | string]
    = [100, 102, 99, 101, 10, 1000, 1001],
) => [nano(time), ...values].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('EDB minute CSV parsing', () => {
  it('parses and validates the committed one-minute baseline', () => {
    const records = parseEdbMinuteCsv(
      readFileSync('futures_investigation_20261009/edb_main_continuous_1m_raw.csv', 'utf8'),
      '内置 1 分钟基线',
    );
    expect(records).toHaveLength(82_650);
    expect(records[0].start).toBe('2025-10-09 21:00:00');
    expect(records.at(-1)?.start).toBe('2026-10-09 14:59:00');
    expect(() => assertMinuteRecordsValid(records)).not.toThrow();
  });

  it('parses valid fixed-field records', () => {
    const records = parseEdbMinuteCsv(csv(
      row('2026-10-09 09:00:00'),
      row('2026-10-09 09:01:00', [101, 103, 100, 102, 11, 1001, 1002]),
    ));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ start: '2026-10-09 09:00:00', open: 100, closeOi: 1001 });
  });

  it.each([
    ['缺列', 'datetime_nano,open,high,low,close,volume,open_oi\n' + row('2026-10-09 09:00:00'), /缺少列 close_oi/],
    ['非法时间', csv('bad,100,102,99,101,10,1000,1001'), /datetime_nano/],
    ['重复时间戳', csv(row('2026-10-09 09:00:00'), row('2026-10-09 09:00:00')), /重复或未严格递增/],
    ['非有限数值', csv(row('2026-10-09 09:00:00', ['NaN', 102, 99, 101, 10, 1000, 1001])), /有限数值/],
    ['OHLC 越界', csv(row('2026-10-09 09:00:00', [98, 102, 99, 101, 10, 1000, 1001])), /价格范围/],
    ['负成交量', csv(row('2026-10-09 09:00:00', [100, 102, 99, 101, -1, 1000, 1001])), /volume 不得为负/],
    ['负持仓量', csv(row('2026-10-09 09:00:00', [100, 102, 99, 101, 1, -1, 1001])), /open_oi/],
    ['非交易分钟', csv(row('2026-10-09 12:00:00')), /非交易分钟/],
  ])('rejects %s', (_name, input, pattern) => {
    expect(() => parseEdbMinuteCsv(input)).toThrow(pattern);
  });

  it('validates reusable minute records and round-trips snapshot serialization', () => {
    const records = parseEdbMinuteCsv(csv(
      row('2026-10-09 09:00:00'),
      row('2026-10-09 09:01:00', [101, 103, 100, 102, 11, 1001, 1002]),
    ));
    expect(parseEdbMinuteCsv(serializeMinuteRecords(records))).toEqual(records);
    expect(() => assertMinuteRecordsValid([{ ...records[0], start: 'wrong' }])).toThrow(/时间字段/);
    expect(() => assertMinuteRecordsValid([{ ...records[0], high: Number.NaN }])).toThrow(/非有限/);
    expect(() => assertMinuteRecordsValid([{ ...records[0], low: 200 }])).toThrow(/OHLC/);
    expect(() => assertMinuteRecordsValid([{ ...records[0], volume: -1 }])).toThrow(/负/);
    expect(() => assertMinuteRecordsValid([records[1], records[0]])).toThrow(/严格递增/);
  });
});

describe('minute aggregation', () => {
  const records = (...times: string[]) => parseEdbMinuteCsv(csv(...times.map((time, index) => row(
    time,
    [100 + index, 102 + index, 99 + index, 101 + index, 10 + index, 1000 + index, 1001 + index],
  ))));

  it('honors day breaks, night sessions, and the 45-minute day tail', () => {
    const input: EdbMinuteRecord[] = [];
    for (let minute = 15; minute < 60; minute++) {
      input.push(...records(`2026-10-09 14:${String(minute).padStart(2, '0')}:00`));
    }
    const tail = aggregateMinutes(input, 60);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({
      start: '2026-10-09 14:15:00',
      end: '2026-10-09 15:00:00',
      session: 'day',
      observedMinutes: 45,
      expectedMinutes: 45,
      complete: true,
    });

    const separated = aggregateMinutes(records(
      '2026-10-09 10:14:00',
      '2026-10-09 10:30:00',
      '2026-10-09 21:00:00',
    ), 5, parseBeijing('2026-10-09 21:05:00'));
    expect(separated.map(bar => [bar.start, bar.session, bar.complete])).toEqual([
      ['2026-10-09 10:10:00', 'day', false],
      ['2026-10-09 10:30:00', 'day', false],
      ['2026-10-09 21:00:00', 'night', false],
    ]);
  });

  it('drops a still-open tail bucket but keeps ended historical buckets with missing minutes', () => {
    const input = records(
      '2026-10-09 09:00:00',
      '2026-10-09 09:01:00',
      '2026-10-09 09:05:00',
      '2026-10-09 09:06:00',
    );
    const at0907 = parseBeijing('2026-10-09 09:07:00');
    expect(aggregateMinutes(input, 5, at0907)).toMatchObject([
      { start: '2026-10-09 09:00:00', observedMinutes: 2, expectedMinutes: 5, complete: false },
    ]);
    expect(aggregateMinutes(input, 60, at0907)).toEqual([]);
  });

  it('uses the active instrument schedule for minute validation and bucket boundaries', () => {
    const schedule: TradingSchedule = [
      {
        id: 'day',
        segments: [
          { startMinute: 9 * 60, endMinute: 9 * 60 + 3 },
          { startMinute: 9 * 60 + 10, endMinute: 9 * 60 + 14 },
        ],
      },
    ];
    const input = parseEdbMinuteCsv(csv(
      row('2026-10-09 09:00:00'),
      row('2026-10-09 09:01:00'),
      row('2026-10-09 09:02:00'),
      row('2026-10-09 09:10:00'),
      row('2026-10-09 09:11:00'),
      row('2026-10-09 09:12:00'),
      row('2026-10-09 09:13:00'),
    ), '短日盘', schedule);
    const bars = aggregateMinutes(input, 5, parseBeijing('2026-10-09 09:14:00'), schedule);
    expect(bars).toMatchObject([
      {
        start: '2026-10-09 09:00:00',
        end: '2026-10-09 09:12:00',
        observedMinutes: 5,
        expectedMinutes: 5,
      },
      {
        start: '2026-10-09 09:12:00',
        end: '2026-10-09 09:14:00',
        observedMinutes: 2,
        expectedMinutes: 2,
      },
    ]);
    expect(() => parseEdbMinuteCsv(csv(row('2026-10-09 09:05:00')), '短日盘', schedule))
      .toThrow(/非交易分钟/);
    expect(() => assertBarsValid(bars, 5, schedule)).not.toThrow();
  });

  it('builds 60-minute bars inside each real day and night segment', () => {
    const times = [
      ...Array.from({ length: 75 }, (_, index) => 9 * 60 + index),
      ...Array.from({ length: 60 }, (_, index) => 10 * 60 + 30 + index),
      ...Array.from({ length: 90 }, (_, index) => 13 * 60 + 30 + index),
      ...Array.from({ length: 120 }, (_, index) => 21 * 60 + index),
    ].map(wallMinute => (
      `2026-10-09 ${String(Math.floor(wallMinute / 60)).padStart(2, '0')}:${String(wallMinute % 60).padStart(2, '0')}:00`
    ));
    const input = parseEdbMinuteCsv(csv(...times.map(time => row(time))));
    const bars5 = aggregateMinutes(input, 5);
    const bars60 = aggregateFiveMinuteBars(bars5);

    expect(bars60.map(bar => [bar.start, bar.end, bar.expectedMinutes])).toEqual([
      ['2026-10-09 09:00:00', '2026-10-09 10:00:00', 60],
      ['2026-10-09 10:00:00', '2026-10-09 10:15:00', 15],
      ['2026-10-09 10:30:00', '2026-10-09 11:30:00', 60],
      ['2026-10-09 13:30:00', '2026-10-09 14:30:00', 60],
      ['2026-10-09 14:30:00', '2026-10-09 15:00:00', 30],
      ['2026-10-09 21:00:00', '2026-10-09 22:00:00', 60],
      ['2026-10-09 22:00:00', '2026-10-09 23:00:00', 60],
    ]);
    expect(bars60.every(bar => bar.complete)).toBe(true);
    expect(() => assertSegmentedSixtyMinuteBarsValid(bars60)).not.toThrow();
    expect(() => reconcileBars(bars5, bars60)).not.toThrow();
  });

  it('treats the 2022-12-06 temporary market suspension as scheduled non-trading minutes', () => {
    const times = Array.from({ length: 13 }, (_, index) => (
      `2022-12-06 10:${String(index + 2).padStart(2, '0')}:00`
    ));
    const input = records(...times);
    const bars5 = aggregateMinutes(input, 5);
    const bars60 = aggregateFiveMinuteBars(bars5);

    expect(input.map(record => record.start)).toEqual(times);
    expect(bars5).toMatchObject([
      {
        start: '2022-12-06 10:00:00',
        end: '2022-12-06 10:05:00',
        observedMinutes: 3,
        expectedMinutes: 3,
        complete: true,
      },
      {
        start: '2022-12-06 10:05:00',
        observedMinutes: 5,
        expectedMinutes: 5,
        complete: true,
      },
      {
        start: '2022-12-06 10:10:00',
        observedMinutes: 5,
        expectedMinutes: 5,
        complete: true,
      },
    ]);
    expect(bars60).toMatchObject([{
      start: '2022-12-06 10:00:00',
      end: '2022-12-06 10:15:00',
      observedMinutes: 13,
      expectedMinutes: 13,
      complete: true,
    }]);
    expect(completeMinutesForFiveMinuteBar(bars5[0], input)).toEqual(input.slice(0, 3));
    expect(() => assertMinuteCoverageMatchesFiveMinuteBars(input, bars5)).not.toThrow();
    expect(() => assertBarsValid(bars5, 5)).not.toThrow();
    expect(() => assertSegmentedSixtyMinuteBarsValid(bars60)).not.toThrow();
    expect(() => reconcileBars(bars5, bars60)).not.toThrow();
  });

  it('does not forgive the same missing minutes on an ordinary trading date', () => {
    const input = records(...Array.from({ length: 13 }, (_, index) => (
      `2022-12-07 10:${String(index + 2).padStart(2, '0')}:00`
    )));
    const bars5 = aggregateMinutes(input, 5);
    const bars60 = aggregateFiveMinuteBars(bars5);

    expect(bars5[0]).toMatchObject({
      start: '2022-12-07 10:00:00',
      observedMinutes: 3,
      expectedMinutes: 5,
      complete: false,
    });
    expect(bars60[0]).toMatchObject({
      start: '2022-12-07 10:00:00',
      observedMinutes: 13,
      expectedMinutes: 15,
      complete: false,
    });
    expect(completeMinutesForFiveMinuteBar(bars5[0], input)).toBeUndefined();
  });
});

describe('incremental merging and reconciliation', () => {
  function bar(start: string, period: 5 | 60, close: number, volume = 10): Bar {
    const startMs = parseBeijing(start);
    const endMs = startMs + period * 60_000;
    return {
      startMs,
      endMs,
      start,
      end: new Date(endMs + 8 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
      open: close,
      high: close,
      low: close,
      close,
      volume,
      openOi: 100,
      closeOi: 101,
      session: Number(start.slice(11, 13)) >= 21 ? 'night' : 'day',
      observedMinutes: period,
      expectedMinutes: period,
      complete: true,
    };
  }

  it('keeps the prefix, replaces revised overlap, appends new rows, and removes vanished source rows', () => {
    const local = [
      bar('2026-10-09 09:00:00', 5, 100),
      bar('2026-10-09 09:05:00', 5, 101),
      bar('2026-10-09 09:10:00', 5, 102),
    ];
    const replacement = [
      bar('2026-10-09 09:05:00', 5, 999),
      bar('2026-10-09 09:15:00', 5, 103),
    ];
    const result = mergeBars(local, replacement, parseBeijing('2026-10-09 09:05:00'));
    expect(result.bars.map(item => [item.start, item.close])).toEqual([
      ['2026-10-09 09:00:00', 100],
      ['2026-10-09 09:05:00', 999],
      ['2026-10-09 09:15:00', 103],
    ]);
    expect(result).toMatchObject({ added: 1, replaced: 1, removed: 1 });
  });

  it('deduplicates identical chunk boundaries and rejects conflicting duplicates', () => {
    const minute = parseEdbMinuteCsv(csv(row('2026-10-09 09:00:00')))[0];
    expect(mergeMinuteChunks([[minute], [minute]])).toEqual([minute]);
    expect(() => mergeMinuteChunks([[minute], [{ ...minute, close: 999 }]])).toThrow(/冲突/);
  });

  it('revises overlapping minutes, appends new minutes, and preserves old local history', () => {
    const local = parseEdbMinuteCsv(csv(
      row('2026-10-09 09:00:00'),
      row('2026-10-09 09:01:00'),
    ));
    const remote = parseEdbMinuteCsv(csv(
      row('2026-10-09 09:01:00', [101, 103, 100, 102, 11, 1001, 1002]),
      row('2026-10-09 09:02:00'),
    ));
    const merged = mergeMinuteHistory(local, remote);
    expect(merged).toMatchObject({ added: 1, replaced: 1, removed: 0 });
    expect(merged.records.map(record => record.start)).toEqual([
      '2026-10-09 09:00:00',
      '2026-10-09 09:01:00',
      '2026-10-09 09:02:00',
    ]);
    expect(merged.records[0]).toBe(local[0]);
    expect(merged.records[1]).toBe(remote[0]);
  });

  it('accepts matching 5m/60m bars and rejects altered values or child counts', () => {
    const input: EdbMinuteRecord[] = [];
    for (let minute = 0; minute < 60; minute++) {
      input.push(...parseEdbMinuteCsv(csv(row(
        `2026-10-09 09:${String(minute).padStart(2, '0')}:00`,
        [100, 102, 99, 101, 10, 1000, 1001],
      ))));
    }
    const bars5 = aggregateMinutes(input, 5);
    const bars60 = aggregateFiveMinuteBars(bars5);
    assertBarsValid(bars5, 5);
    assertSegmentedSixtyMinuteBarsValid(bars60);
    expect(() => reconcileBars(bars5, bars60)).not.toThrow();
    expect(() => reconcileBars(bars5, [{ ...bars60[0], volume: bars60[0].volume + 1 }])).toThrow(/volume 对账/);
    expect(() => reconcileBars(bars5, [{ ...bars60[0], openOi: bars60[0].openOi + 1 }])).toThrow(/openOi 对账/);
    expect(() => reconcileBars(bars5.slice(1), bars60)).toThrow(/组成 5 分钟数量/);
  });

  it('allows only a contiguous trailing 5-minute prefix of an unpublished 60-minute bucket', () => {
    const input = parseEdbMinuteCsv(csv(...Array.from({ length: 70 }, (_, index) => row(
      `2026-10-09 ${String(9 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
      [100, 102, 99, 101, 10, 1000, 1001],
    ))));
    const bars5 = aggregateMinutes(input, 5);
    const completeBars60 = aggregateFiveMinuteBars(bars5).filter(bar => bar.complete);

    expect(() => reconcileBars(bars5, completeBars60)).not.toThrow();
    expect(() => reconcileBars(
      [...bars5.slice(0, 12), ...bars5.slice(13)],
      completeBars60,
    )).toThrow(/时间桶数量/);
  });
});

describe('continuous multi-year bar coverage', () => {
  const coverageSchedule: TradingSchedule = [
    {
      id: 'day',
      segments: [
        { startMinute: 9 * 60, endMinute: 9 * 60 + 5 },
        { startMinute: 9 * 60 + 10, endMinute: 9 * 60 + 15 },
      ],
    },
    {
      id: 'night',
      segments: [
        { startMinute: 21 * 60, endMinute: 21 * 60 + 10 },
      ],
    },
  ];
  const definition: InstrumentDefinition = {
    ...DEFAULT_INSTRUMENT,
    name: '连续覆盖测试品种',
    tradingSessions: coverageSchedule,
  };

  function weekdays(first: string, last: string): string[] {
    const dates: string[] = [];
    for (
      let value = Date.parse(`${first}T00:00:00Z`);
      value <= Date.parse(`${last}T00:00:00Z`);
      value += 24 * 60 * 60_000
    ) {
      const day = new Date(value).getUTCDay();
      if (day !== 0 && day !== 6) dates.push(new Date(value).toISOString().slice(0, 10));
    }
    return dates;
  }

  function coverageBar(
    date: string,
    startMinute: number,
    session: Bar['session'],
    price: number,
  ): Bar {
    const start = `${date} ${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00`;
    const startMs = parseBeijing(start);
    const endMs = startMs + 5 * 60_000;
    return {
      startMs,
      endMs,
      start,
      end: formatBeijing(endMs),
      open: price,
      high: price + 2,
      low: price - 1,
      close: price + 1,
      volume: 100,
      openOi: 1_000,
      closeOi: 1_001,
      session,
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    };
  }

  function coverageFixture(nightTradingDateIndex?: number): {
    dates: string[];
    bars5: Bar[];
    bars60: Bar[];
    mappings: MainContractMapping[];
  } {
    const dates = weekdays('2023-10-20', '2026-10-20');
    const bars5 = dates.flatMap((date, index) => [
      coverageBar(date, 9 * 60, 'day', 2_500 + index),
      coverageBar(date, 9 * 60 + 10, 'day', 2_501 + index),
    ]);
    if (nightTradingDateIndex !== undefined) {
      const naturalDate = dates[nightTradingDateIndex - 1];
      bars5.push(
        coverageBar(naturalDate, 21 * 60, 'night', 3_000),
        coverageBar(naturalDate, 21 * 60 + 5, 'night', 3_001),
      );
    }
    bars5.sort((left, right) => left.startMs - right.startMs);
    return {
      dates,
      bars5,
      bars60: aggregateFiveMinuteBars(bars5, coverageSchedule),
      mappings: dates.map(tradingDate => ({ tradingDate, contract: 'm2401' })),
    };
  }

  it('accepts a continuous weekday calendar with complete day sessions', () => {
    const fixture = coverageFixture();
    expect(fixture.mappings.length).toBeGreaterThan(600);
    expect(() => assertContinuousBarCoverage(
      definition,
      fixture.bars5,
      fixture.bars60,
      fixture.mappings,
    )).not.toThrow();
  });

  it('rejects two distant blocks that only satisfy the first/last boundary', () => {
    const fixture = coverageFixture();
    const boundaryDates = [fixture.dates[0], fixture.dates.at(-1)!];
    const bars5 = fixture.bars5.filter(bar => boundaryDates.includes(bar.start.slice(0, 10)));
    const bars60 = aggregateFiveMinuteBars(bars5, coverageSchedule);
    const mappings = fixture.mappings.filter(mapping => boundaryDates.includes(mapping.tradingDate));

    expect(() => assertContinuousBarCoverage(definition, bars5, bars60, mappings))
      .toThrow(/主力映射交易日间隔超过 14 天/);
  });

  it('reports the first missing day-session 5-minute bar', () => {
    const fixture = coverageFixture();
    const tradingDate = fixture.dates[100];
    const missingStart = `${tradingDate} 09:10:00`;
    const bars5 = fixture.bars5.filter(bar => bar.start !== missingStart);

    expect(() => assertContinuousBarCoverage(
      definition,
      bars5,
      fixture.bars60,
      fixture.mappings,
    )).toThrow(new RegExp(`连续覆盖测试品种 ${tradingDate} 日盘缺少 5 分钟 K 线：${missingStart}`));
  });

  it('reports a wholly absent 60-minute bucket', () => {
    const fixture = coverageFixture();
    const tradingDate = fixture.dates[120];
    const missingStart = `${tradingDate} 09:10:00`;
    const bars60 = fixture.bars60.filter(bar => bar.start !== missingStart);

    expect(() => assertContinuousBarCoverage(
      definition,
      fixture.bars5,
      bars60,
      fixture.mappings,
    )).toThrow(new RegExp(`连续覆盖测试品种 ${tradingDate} 日盘缺少 60 分钟 K 线：${missingStart}`));
  });

  it('allows absent night sessions but requires an observed night session to be complete', () => {
    const withoutNight = coverageFixture();
    expect(() => assertContinuousBarCoverage(
      definition,
      withoutNight.bars5,
      withoutNight.bars60,
      withoutNight.mappings,
    )).not.toThrow();

    const withNight = coverageFixture(100);
    expect(() => assertContinuousBarCoverage(
      definition,
      withNight.bars5,
      withNight.bars60,
      withNight.mappings,
    )).not.toThrow();

    const missingNightStart = withNight.bars5.find(bar => (
      bar.session === 'night' && bar.start.endsWith('21:05:00')
    ))!.start;
    expect(() => assertContinuousBarCoverage(
      definition,
      withNight.bars5.filter(bar => bar.start !== missingNightStart),
      withNight.bars60,
      withNight.mappings,
    )).toThrow(/夜盘缺少 5 分钟 K 线/);
  });

  it('maps a complete Friday night session to Monday and allows the trailing day session to be pending', () => {
    const fixture = coverageFixture();
    const monday = '2026-10-19';
    const friday = '2026-10-16';
    const bars5 = fixture.bars5.filter(bar => bar.start.slice(0, 10) < monday);
    bars5.push(
      coverageBar(friday, 21 * 60, 'night', 4_200),
      coverageBar(friday, 21 * 60 + 5, 'night', 4_201),
    );
    bars5.sort((left, right) => left.startMs - right.startMs);
    const mappings = fixture.mappings.filter(mapping => mapping.tradingDate <= monday);

    expect(() => assertContinuousBarCoverage(
      definition,
      bars5,
      aggregateFiveMinuteBars(bars5, coverageSchedule),
      mappings,
    )).not.toThrow();
  });

  it('still rejects an intermediate trading date that only contains a night session', () => {
    const fixture = coverageFixture(100);
    const tradingDate = fixture.dates[100];
    const bars5 = fixture.bars5.filter(bar => (
      bar.session === 'night' || bar.start.slice(0, 10) !== tradingDate
    ));

    expect(() => assertContinuousBarCoverage(
      definition,
      bars5,
      aggregateFiveMinuteBars(bars5, coverageSchedule),
      fixture.mappings,
    )).toThrow(new RegExp(`${tradingDate} 日盘缺少 5 分钟 K 线`));
  });

  it('rejects day and night bars that cannot map to a known trading date', () => {
    const fixture = coverageFixture();
    const unmappedDay = coverageBar('2023-10-21', 9 * 60, 'day', 4_000);
    const dayBars = [...fixture.bars5, unmappedDay]
      .sort((left, right) => left.startMs - right.startMs);
    expect(() => assertContinuousBarCoverage(
      definition,
      dayBars,
      aggregateFiveMinuteBars(dayBars, coverageSchedule),
      fixture.mappings,
    )).toThrow(/日盘 K 线无法映射到主力交易日/);

    const lastDate = fixture.dates.at(-1)!;
    const nightBars = [
      ...fixture.bars5,
      coverageBar(lastDate, 21 * 60, 'night', 4_100),
      coverageBar(lastDate, 21 * 60 + 5, 'night', 4_101),
    ].sort((left, right) => left.startMs - right.startMs);
    expect(() => assertContinuousBarCoverage(
      definition,
      nightBars,
      aggregateFiveMinuteBars(nightBars, coverageSchedule),
      fixture.mappings,
    )).toThrow(/夜盘 K 线之后缺少主力交易日/);
  });
});

describe('five-minute minute coverage', () => {
  function completeFixture() {
    const records = parseEdbMinuteCsv(csv(...Array.from({ length: 5 }, (_, index) => row(
      `2026-10-09 09:0${index}:00`,
      [100 + index, 102 + index, 99 + index, 101 + index, 10 + index, 1000 + index, 1001 + index],
    ))));
    return { records, bar: aggregateMinutes(records, 5)[0] };
  }

  it('returns exactly five ordered records when aggregation matches', () => {
    const { records, bar } = completeFixture();
    expect(completeMinutesForFiveMinuteBar(bar, records)).toEqual(records);
  });

  it.each([
    ['missing', ({ records, bar }: ReturnType<typeof completeFixture>) => completeMinutesForFiveMinuteBar(bar, records.slice(0, 4))],
    ['duplicate', ({ records, bar }: ReturnType<typeof completeFixture>) => completeMinutesForFiveMinuteBar(bar, [records[0], records[0], ...records.slice(2)])],
    ['wrong order', ({ records, bar }: ReturnType<typeof completeFixture>) => completeMinutesForFiveMinuteBar(bar, [records[1], records[0], ...records.slice(2)])],
    ['OHLC mismatch', ({ records, bar }: ReturnType<typeof completeFixture>) => completeMinutesForFiveMinuteBar({ ...bar, high: bar.high + 1 }, records)],
  ])('rejects %s coverage', (_name, check) => {
    expect(check(completeFixture())).toBeUndefined();
  });
});
