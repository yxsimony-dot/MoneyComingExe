import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBars, parseAudit } from '../src/domain/data';
import { parseBeijing, formatBeijing, locateDate, locateTime, mondayFirstBars } from '../src/domain/time';
import { childrenFor, linkedLogicalRange, parentFor } from '../src/domain/link';
import type { Bar } from '../src/shared/types';

const header = 'bar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete';
const row = '2026-02-05 09:20:00,2026-02-05 09:25:00,day,2913,2914,2720,2914,0,19396,20396,5,5,True';
const csv = (body = row) => `${header}\n${body}\n`;
const source = (name: string) => readFileSync(`futures_investigation_20261009/${name}`, 'utf8');
const sample = (start: string, end: string): Bar => ({
  start, end, startMs: Date.parse(start.replace(' ', 'T') + '+08:00'),
  endMs: Date.parse(end.replace(' ', 'T') + '+08:00'),
  open: 1, high: 1, low: 1, close: 1, volume: 0, openOi: 0, closeOi: 0,
  session: 'day', observedMinutes: 5, expectedMinutes: 5, complete: true,
});
describe('Beijing time and navigation', () => {
  it('parses and formats the actual natural date with explicit UTC+08:00', () => {
    const expected = Date.UTC(2026, 1, 5, 1, 24);
    expect(parseBeijing('2026-02-05 09:24:00')).toBe(expected);
    expect(parseBeijing('2026-02-05 09:24:00+08:00')).toBe(expected);
    expect(formatBeijing(expected)).toBe('2026-02-05 09:24:00');
    expect(formatBeijing(parseBeijing('2025-10-09 21:00:00'))).toBe('2025-10-09 21:00:00');
  });
  it.each(['', '2026-02-29 09:00:00', '2026-13-01 09:00:00', '2026-01-01 24:00:00', '2026-01-01 09:60:00', '2026-01-01 09:00:60', '2026-01-01 09:00:00Z'])('rejects invalid local timestamps: %s', value => {
    expect(() => parseBeijing(value)).toThrow();
  });
  const bars = [sample('2026-02-05 09:00:00', '2026-02-05 10:00:00'), sample('2026-02-05 10:00:00', '2026-02-05 11:15:00'), sample('2026-02-09 09:00:00', '2026-02-09 10:00:00')];
  it('selects the first bar of a natural date, next after closures, and clamps boundaries', () => {
    expect(locateDate(bars, '2026-02-05')).toBe(0);
    expect(locateDate(bars, '2026-02-07')).toBe(2);
    expect(locateDate(bars, '2025-01-01')).toBe(0);
    expect(locateDate(bars, '2027-01-01')).toBe(2);
    expect(locateDate([], '2026-02-05')).toBe(-1);
    expect(() => locateDate(bars, '')).toThrow();
    expect(() => locateDate(bars, '2026-02-30')).toThrow();
  });
  it('retains an exact focus time and handles half-open boundaries', () => {
    expect(locateTime(bars, Date.parse('2026-02-05T09:30:00+08:00'))).toBe(0);
    expect(locateTime(bars, Date.parse('2026-02-05T10:00:00+08:00'))).toBe(1);
    expect(locateTime(bars, Date.parse('2026-02-05T12:00:00+08:00'))).toBe(2);
    expect(locateTime(bars, 0)).toBe(0);
    expect(locateTime(bars, Date.UTC(2030, 0, 1))).toBe(2);
    expect(locateTime([], 0)).toBe(-1);
    expect(() => locateTime(bars, NaN)).toThrow();
  });

  it('selects the first eight chronological 60-minute bars starting at each Beijing Monday', () => {
    const monday = Array.from({ length: 6 }, (_, index) => sample(`2026-02-09 ${String(9 + index).padStart(2, '0')}:00:00`, `2026-02-09 ${String(10 + index).padStart(2, '0')}:00:00`));
    const tuesday = Array.from({ length: 3 }, (_, index) => sample(`2026-02-10 ${String(9 + index).padStart(2, '0')}:00:00`, `2026-02-10 ${String(10 + index).padStart(2, '0')}:00:00`));
    const secondMonday = Array.from({ length: 2 }, (_, index) => sample(`2026-02-16 ${String(9 + index).padStart(2, '0')}:00:00`, `2026-02-16 ${String(10 + index).padStart(2, '0')}:00:00`));
    const tenth = sample('2026-02-10 14:15:00', '2026-02-10 15:00:00');
    const highlighted = mondayFirstBars([...monday, ...tuesday, tenth, ...secondMonday]);
    expect(highlighted).toEqual([...monday, ...tuesday.slice(0, 2), ...secondMonday]);
  });

  it('starts by Beijing Monday rather than UTC Sunday and never invents a missing Monday', () => {
    const sunday = sample('2026-02-08 23:00:00', '2026-02-09 00:00:00');
    const monday = sample('2026-02-09 00:00:00', '2026-02-09 01:00:00');
    const tuesday = sample('2026-02-10 09:00:00', '2026-02-10 10:00:00');
    expect(mondayFirstBars([sunday, monday, tuesday])).toEqual([monday, tuesday]);
    expect(mondayFirstBars([tuesday])).toEqual([]);
    expect(mondayFirstBars([])).toEqual([]);
  });

  it('highlights six Monday bars and two Tuesday bars in real main-continuous data', () => {
    const bars = parseBars(source('edb_main_continuous_60m.csv'), '60m.csv');
    const highlighted = mondayFirstBars(bars);
    const week = highlighted.filter(bar => bar.start >= '2026-02-02' && bar.start < '2026-02-09');
    expect(week).toHaveLength(8);
    expect(week.filter(bar => bar.start.startsWith('2026-02-02'))).toHaveLength(6);
    expect(week.slice(6).map(bar => bar.start)).toEqual([
      '2026-02-03 09:00:00', '2026-02-03 10:00:00',
    ]);
    expect(highlighted.some(bar => bar.start === '2026-02-03 11:15:00')).toBe(false);
  });
});
describe('CSV contract', () => {
  it('handles BOM/CRLF/quoted cells and retains zero volume, exact OHLC and OI', () => {
    const [bar] = parseBars('\uFEFF' + csv().replaceAll('\n', '\r\n').replace('2913', '"2913"'), 'quote.csv');
    expect(bar).toMatchObject({ start: '2026-02-05 09:20:00', end: '2026-02-05 09:25:00', open: 2913, high: 2914, low: 2720, close: 2914, volume: 0, openOi: 19396, closeOi: 20396, complete: true });
  });
  it.each([
    ['', /空|记录/], [header, /记录/], [csv().replace('close_oi,', ''), /列/],
    [csv().replace('2913', 'NaN'), /第2行.*open/], [csv().replace('2913', ''), /第2行.*open/],
    [csv().replace(',0,19396', ',-1,19396'), /第2行.*volume/],
    [csv().replace('2720', '3000'), /第2行.*价格/],
    [csv().replace('2026-02-05 09:25:00', '2026-02-05 09:20:00'), /第2行.*时间/],
    [csv().replace('True', 'yes'), /第2行.*complete/],
    [csv().replace('day', 'holiday'), /第2行.*session/],
    [csv().replace('5,5,True', '4,5,True'), /第2行.*complete/],
    [csv(row + '\n' + row), /第3行.*重复|第3行.*顺序/],
    [csv(row + '\n' + row.replaceAll('09:20:00', '09:10:00').replaceAll('09:25:00', '09:15:00')), /第3行.*顺序/],
  ])('rejects malformed input with filename and row details', (text, reason) => {
    expect(() => parseBars(text, 'broken.csv')).toThrow(/broken.csv/);
    expect(() => parseBars(text, 'broken.csv')).toThrow(reason);
  });
  it('retains incomplete valid bars without filling minutes', () => {
    expect(parseBars(csv().replace('5,5,True', '4,5,False'), 'partial.csv')[0]).toMatchObject({ observedMinutes: 4, expectedMinutes: 5, complete: false });
  });
});
describe('full delivered dataset and linkage', () => {
  it('preserves all main-continuous rows and OHLCV composition', () => {
    const bars5 = parseBars(source('edb_main_continuous_5m.csv'), 'main_continuous_5m.csv');
    const bars60 = parseBars(source('edb_main_continuous_60m.csv'), 'main_continuous_60m.csv');
    expect(bars5).toHaveLength(16530); expect(bars60).toHaveLength(1438);
    expect(bars5[0].start).toBe('2025-10-09 21:00:00'); expect(bars60[0].start).toBe('2025-10-09 21:00:00');
    expect(bars5.at(-1)?.end).toBe('2026-10-09 15:00:00'); expect(bars60.at(-1)?.end).toBe('2026-10-09 15:00:00');
    for (const parent of bars60) {
      const children = childrenFor(parent, bars5);
      expect(children).toHaveLength(parent.observedMinutes / 5);
      expect(children[0].open).toBe(parent.open); expect(children.at(-1)?.close).toBe(parent.close);
      expect(Math.max(...children.map(b => b.high))).toBe(parent.high);
      expect(Math.min(...children.map(b => b.low))).toBe(parent.low);
      expect(children.reduce((n, b) => n + b.volume, 0)).toBe(parent.volume);
      for (const child of children) expect(parentFor(child, bars60)).toBe(parent);
    }
    const day = bars60.filter(b => b.start.startsWith('2026-02-05'));
    for (const [start, end, count] of [['10:00:00', '11:15:00', 12], ['11:15:00', '14:15:00', 12], ['14:15:00', '15:00:00', 9]] as const) {
      const parent = day.find(b => b.start.endsWith(start))!;
      expect(parent.end).toBe('2026-02-05 ' + end);
      expect(childrenFor(parent, bars5)).toHaveLength(count);
    }
    const a = bars5.find(b => b.end === '2026-02-05 10:00:00')!;
    const b = bars5.find(b => b.start === '2026-02-05 10:00:00')!;
    expect(parentFor(a, bars60)?.start).toBe('2026-02-05 09:00:00');
    expect(parentFor(b, bars60)?.start).toBe('2026-02-05 10:00:00');
    expect(childrenFor(bars60[0], [])).toEqual([]);
    expect(parentFor(bars5[0], [])).toBeUndefined();
  });
});
describe('linked chart logical range', () => {
  it('keeps a source span that already contains the child interval', () => {
    expect(linkedLogicalRange(30, 100, 111, 1000)).toEqual({ from: 90.5, to: 120.5 });
  });

  it('expands a narrow source span to include 12 children and four bars of margin', () => {
    expect(linkedLogicalRange(8, 100, 111, 1000)).toEqual({ from: 97.5, to: 113.5 });
  });

  it('uses the actual nine-bar closing interval when calculating the minimum span', () => {
    expect(linkedLogicalRange(5, 100, 108, 1000)).toEqual({ from: 97.5, to: 110.5 });
  });

  it('shifts ranges at the beginning and end without shortening them', () => {
    expect(linkedLogicalRange(30, 0, 11, 100)).toEqual({ from: 0, to: 30 });
    expect(linkedLogicalRange(30, 88, 99, 100)).toEqual({ from: 70, to: 100 });
  });

  it('shows all available data when the dataset is smaller than the target span', () => {
    expect(linkedLogicalRange(30, 0, 8, 10)).toEqual({ from: 0, to: 10 });
  });

  it('rejects invalid or missing child indexes', () => {
    expect(linkedLogicalRange(30, -1, -1, 100)).toBeUndefined();
    expect(linkedLogicalRange(Number.NaN, 1, 2, 100)).toBeUndefined();
  });
});
describe('source audit metadata', () => {
  it('loads the main-continuous audit with no recorded anomalies', () => {
    expect(parseAudit(source('cross_source_audit.json'))).toEqual([]);
  });
  it.each(['{', '{}', 'null', '{"anomalies":{}}', '{"anomalies":[{}]}', '{"suspicious_source_observation":{}}'])('rejects unavailable audit schema', text => {
    expect(() => parseAudit(text)).toThrow();
  });
});
