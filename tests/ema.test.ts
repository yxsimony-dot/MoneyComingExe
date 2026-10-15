import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBars } from '../src/domain/data';
import { exponentialMovingAverage } from '../src/domain/ema';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import type { Bar } from '../src/shared/types';

function bars(closes: number[]): Bar[] {
  const origin = parseBeijing('2026-02-06 21:00:00');
  return closes.map((close, index) => {
    const startMs = origin + index * 3_600_000;
    return { startMs, endMs: startMs + 3_600_000, start: formatBeijing(startMs), end: formatBeijing(startMs + 3_600_000),
      open: close - 1, high: close + 10, low: close - 10, close, volume: 1, openOi: 1, closeOi: 1,
      session: 'day', observedMinutes: 60, expectedMinutes: 60, complete: true };
  });
}

describe('exponential moving average', () => {
  it('returns no points for an empty history', () => {
    expect(exponentialMovingAverage([])).toEqual([]);
  });

  it('starts at the first close and preserves a constant price without waiting for twenty bars', () => {
    const history = bars([3000, 3000, 3000]);
    expect(exponentialMovingAverage(history)).toEqual(history.map(bar => ({ bar, value: 3000 })));
  });

  it('uses the requested exponential weight and each close rather than wick prices', () => {
    const history = bars([10, 14, 12, 20]);
    expect(exponentialMovingAverage(history, 3).map(point => point.value)).toEqual([10, 12, 12, 16]);
    expect(exponentialMovingAverage(history, 1).map(point => point.value)).toEqual([10, 14, 12, 20]);
  });

  it('defaults to EMA20 and gives a new close 2/21 weight rather than the 1/20 SMA weight', () => {
    const history = bars([...Array(20).fill(100), 121, 121]);
    const result = exponentialMovingAverage(history);
    expect(result).toHaveLength(22);
    expect(result[20].value).toBeCloseTo(102, 12);
    expect(result[21].value).toBeCloseTo(103.80952380952381, 12);
    expect(result[20].value).not.toBeCloseTo(101.05, 6);
  });

  it('continues across date and week gaps without changing the historical prefix or input', () => {
    const history = bars([10, 14, 12, 20]);
    history[2] = { ...history[2], startMs: parseBeijing('2026-02-09 09:00:00'), start: '2026-02-09 09:00:00' };
    history[3] = { ...history[3], startMs: parseBeijing('2026-02-09 10:00:00'), start: '2026-02-09 10:00:00' };
    const snapshot = structuredClone(history);
    const full = exponentialMovingAverage(history, 3);
    expect(full.map(point => point.value)).toEqual([10, 12, 12, 16]);
    for (let count = 1; count <= history.length; count++) {
      expect(exponentialMovingAverage(history.slice(0, count), 3)).toEqual(full.slice(0, count));
    }
    expect(history).toEqual(snapshot);
  });

  it('matches an independent expanded-weight formula for real main-continuous history', () => {
    const history = parseBars(readFileSync('futures_investigation_20261009/edb_main_continuous_60m.csv', 'utf8'), '60m.csv');
    const result = exponentialMovingAverage(history);
    expect(result).toHaveLength(history.length);
    // Expand the entire weighted sum independently, rather than copy the production recurrence.
    for (const index of [0, 1, 19, 20, 100, 500, history.length - 1]) {
      const decay = 19 / 21;
      let expected = history[0].close * Math.pow(decay, index);
      for (let j = 1; j <= index; j++) expected += history[j].close * (2 / 21) * Math.pow(decay, index - j);
      expect(result[index].bar).toBe(history[index]);
      expect(result[index].value).toBeCloseTo(expected, 8);
    }
    for (const length of [1, 20, 30, 500, history.length - 1]) {
      expect(exponentialMovingAverage(history.slice(0, length))).toEqual(result.slice(0, length));
    }
  });
});
