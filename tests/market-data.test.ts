import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  aggregateMinutes,
  assertBarsValid,
  assertMinuteRecordsValid,
  completeMinutesForFiveMinuteBar,
  mergeBars,
  mergeMinuteHistory,
  mergeMinuteChunks,
  parseEdbMinuteCsv,
  reconcileBars,
  serializeMinuteRecords,
} from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';
import type { TradingSchedule } from '../src/shared/instruments';

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

  it('accepts matching 5m/60m bars and rejects altered OHLC or volume', () => {
    const input: EdbMinuteRecord[] = [];
    for (let minute = 0; minute < 60; minute++) {
      input.push(...parseEdbMinuteCsv(csv(row(
        `2026-10-09 09:${String(minute).padStart(2, '0')}:00`,
        [100, 102, 99, 101, 10, 1000, 1001],
      ))));
    }
    const bars5 = aggregateMinutes(input, 5);
    const bars60 = aggregateMinutes(input, 60);
    assertBarsValid(bars5, 5);
    assertBarsValid(bars60, 60);
    expect(() => reconcileBars(bars5, bars60)).not.toThrow();
    expect(() => reconcileBars(bars5, [{ ...bars60[0], volume: bars60[0].volume + 1 }])).toThrow(/volume 对账/);
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
