import { describe, expect, it } from 'vitest';
import {
  aggregateMinutes,
  assertBarsValid,
  mergeBars,
  mergeMinuteChunks,
  parseEdbMinuteCsv,
  reconcileBars,
} from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const nano = (time: string) => String(BigInt(parseBeijing(time)) * 1_000_000n);
const row = (
  time: string,
  values: [number | string, number | string, number | string, number | string, number | string, number | string, number | string]
    = [100, 102, 99, 101, 10, 1000, 1001],
) => [nano(time), ...values].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('EDB minute CSV parsing', () => {
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
