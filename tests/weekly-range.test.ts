import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBars } from '../src/domain/data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import { analyzeWeeklyRange } from '../src/domain/weekly-range';
import type { Bar } from '../src/shared/types';

const HOUR = 3_600_000;
function bar(startMs: number, high = 3000, low = 2900): Bar {
  return { startMs, endMs: startMs + HOUR, start: formatBeijing(startMs), end: formatBeijing(startMs + HOUR),
    open: 2950, close: 2950, high, low, volume: 1, openOi: 1, closeOi: 1,
    session: 'day', observedMinutes: 60, expectedMinutes: 60, complete: true };
}
const start = parseBeijing('2026-02-02 09:00:00');
const sequence = (extremes: [number, number][], origin = start) => extremes.map(([high, low], i) => bar(origin + i * HOUR, high, low));
const seed = () => sequence(Array.from({ length: 8 }, () => [3000, 2900]));
const summary = (bars: Bar[]) => analyzeWeeklyRange(bars).breakouts.map(b => ({
  ordinal: b.ordinal, direction: b.direction, previousBoundary: b.previousBoundary, value: b.value, weekStart: b.weekStart,
}));

describe('weekly first-eight running range', () => {
  it('uses wick extremes from exactly the first eight bars and starts on the ninth', () => {
    const bars = sequence([[2990, 2910], [3010, 2905], [2990, 2890], [3000, 2900], [3000, 2900], [3000, 2900], [3000, 2900], [3020, 2880], [3021, 2879]]);
    expect(analyzeWeeklyRange(bars).seedBars).toEqual(bars.slice(0, 8));
    expect(summary(bars)).toEqual([
      { ordinal: 9, direction: 'up', previousBoundary: 3020, value: 3021, weekStart: '2026-02-02' },
      { ordinal: 9, direction: 'down', previousBoundary: 2880, value: 2879, weekStart: '2026-02-02' },
    ]);
  });

  it('marks every new extreme but ignores equality and moves back inside the updated bounds', () => {
    const bars = [...seed(), ...sequence([[3010, 2890], [3008, 2892], [3010, 2890], [3020, 2880], [3015, 2870]], start + 8 * HOUR)];
    expect(summary(bars)).toEqual([
      { ordinal: 9, direction: 'up', previousBoundary: 3000, value: 3010, weekStart: '2026-02-02' },
      { ordinal: 9, direction: 'down', previousBoundary: 2900, value: 2890, weekStart: '2026-02-02' },
      { ordinal: 12, direction: 'up', previousBoundary: 3010, value: 3020, weekStart: '2026-02-02' },
      { ordinal: 12, direction: 'down', previousBoundary: 2890, value: 2880, weekStart: '2026-02-02' },
      { ordinal: 13, direction: 'down', previousBoundary: 2880, value: 2870, weekStart: '2026-02-02' },
    ]);
  });

  it('continues counting into Tuesday and includes the tenth bar after a quiet ninth', () => {
    const monday = sequence(Array.from({ length: 6 }, () => [3000, 2900]));
    const tuesday = sequence([[3000, 2900], [3000, 2900], [3000, 2900], [3001, 2900]], parseBeijing('2026-02-03 09:00:00'));
    expect(analyzeWeeklyRange([...monday, ...tuesday]).seedBars).toEqual([...monday, ...tuesday.slice(0, 2)]);
    expect(summary([...monday, ...tuesday])).toEqual([
      { ordinal: 10, direction: 'up', previousBoundary: 3000, value: 3001, weekStart: '2026-02-02' },
    ]);
  });

  it('resets both boundaries and counting each week', () => {
    const first = [...seed(), bar(start + 8 * HOUR, 4000, 2000)];
    const next = [...sequence(Array.from({ length: 8 }, () => [3000, 2900]), start + 7 * 24 * HOUR), bar(start + (7 * 24 + 8) * HOUR, 3010, 2890)];
    expect(summary([...first, ...next]).slice(-2)).toEqual([
      { ordinal: 9, direction: 'up', previousBoundary: 3000, value: 3010, weekStart: '2026-02-09' },
      { ordinal: 9, direction: 'down', previousBoundary: 2900, value: 2890, weekStart: '2026-02-09' },
    ]);
  });

  it('skips weeks without Monday and does not carry incomplete seed bars into them', () => {
    const partial = seed().slice(0, 3);
    const noMonday = sequence(Array.from({ length: 12 }, () => [3100, 2800]), parseBeijing('2026-02-10 09:00:00'));
    expect(analyzeWeeklyRange([...partial, ...noMonday])).toEqual({ seedBars: partial, breakouts: [] });
    expect(analyzeWeeklyRange(noMonday)).toEqual({ seedBars: [], breakouts: [] });
    expect(analyzeWeeklyRange([])).toEqual({ seedBars: [], breakouts: [] });
  });

  it('ends an active week at the next calendar Monday even when that Monday has no data', () => {
    const oldWeek = [...seed(), bar(start + 8 * HOUR, 3010, 2890)];
    const nextTuesday = bar(parseBeijing('2026-02-10 09:00:00'), 5000, 1000);
    expect(analyzeWeeklyRange([...oldWeek, nextTuesday])).toEqual(analyzeWeeklyRange(oldWeek));
  });

  it('treats midnight Beijing Monday as Monday independently of the process timezone', () => {
    const origin = parseBeijing('2026-02-02 00:00:00');
    const bars = [bar(origin - HOUR, 9000, 1), ...sequence(Array.from({ length: 8 }, () => [3000, 2900]), origin), bar(origin + 8 * HOUR, 3001, 2900)];
    const oldTz = process.env.TZ;
    try {
      for (const zone of ['America/New_York', 'Asia/Shanghai', 'Pacific/Honolulu']) {
        process.env.TZ = zone;
        expect(analyzeWeeklyRange(bars).seedBars).toEqual(bars.slice(1, 9));
        expect(summary(bars)).toEqual([{ ordinal: 9, direction: 'up', previousBoundary: 3000, value: 3001, weekStart: '2026-02-02' }]);
      }
    } finally { if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz; }
  });

  it('matches an independent all-prior-extremes check for real main-continuous data and never repaints a prefix', () => {
    const bars = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_60m.csv', 'utf8'), '60m.csv');
    const expected: { bar: Bar; direction: 'up' | 'down'; previousBoundary: number; value: number; weekStart: string; ordinal: number }[] = [];
    const expectedSeed: Bar[] = [];
    // Enumerate calendar weeks and compare each bar against all previous bars, not a running-state implementation.
    for (let monday = Date.UTC(2025, 9, 6); monday <= Date.UTC(2026, 9, 12); monday += 7 * 24 * HOUR) {
      const date = new Date(monday).toISOString().slice(0, 10);
      const next = new Date(monday + 7 * 24 * HOUR).toISOString().slice(0, 10);
      const week = bars.filter(b => b.start.slice(0, 10) >= date && b.start.slice(0, 10) < next);
      if (!week[0]?.start.startsWith(date)) continue;
      expectedSeed.push(...week.slice(0, 8));
      for (let i = 8; i < week.length; i++) {
        const high = Math.max(...week.slice(0, i).map(b => b.high));
        const low = Math.min(...week.slice(0, i).map(b => b.low));
        if (week[i].high > high) expected.push({ bar: week[i], direction: 'up', previousBoundary: high, value: week[i].high, weekStart: date, ordinal: i + 1 });
        if (week[i].low < low) expected.push({ bar: week[i], direction: 'down', previousBoundary: low, value: week[i].low, weekStart: date, ordinal: i + 1 });
      }
    }
    const full = analyzeWeeklyRange(bars);
    expect(full).toEqual({ seedBars: expectedSeed, breakouts: expected });
    expect(full.breakouts.length).toBeGreaterThan(0);
    for (const length of [1, 8, 9, 29, 180, bars.length - 1]) {
      const last = bars[length - 1].startMs;
      expect(analyzeWeeklyRange(bars.slice(0, length))).toEqual({
        seedBars: full.seedBars.filter(b => b.startMs <= last),
        breakouts: full.breakouts.filter(b => b.bar.startMs <= last),
      });
    }
  });
});
