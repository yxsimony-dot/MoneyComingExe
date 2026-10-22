import { describe, expect, it } from 'vitest';
import {
  firstIndexAtOrAfter,
  rollingMarketWindow,
  subtractBeijingCalendarYears,
  trimToRollingMarketWindow,
} from '../src/domain/rolling-market-window';
import { formatBeijing, parseBeijing } from '../src/domain/time';

describe('rolling market window', () => {
  it('subtracts five Beijing calendar years without changing wall-clock time', () => {
    const latest = parseBeijing('2026-10-16 22:59:00');
    expect(formatBeijing(subtractBeijingCalendarYears(latest, 5)))
      .toBe('2021-10-16 22:59:00');
    expect(rollingMarketWindow(latest)).toEqual({
      latestMs: latest,
      latest: '2026-10-16 22:59:00',
      lowerBoundMs: parseBeijing('2021-10-16 22:59:00'),
      lowerBound: '2021-10-16 22:59:00',
      years: 5,
    });
  });

  it('clamps leap day to the last valid day in the target year', () => {
    expect(formatBeijing(subtractBeijingCalendarYears(
      parseBeijing('2024-02-29 09:01:00'),
      5,
    ))).toBe('2019-02-28 09:01:00');
  });

  it('selects the first actual record at or after the hard lower bound stably', () => {
    const records = [
      { startMs: parseBeijing('2021-10-15 14:55:00') },
      { startMs: parseBeijing('2021-10-18 09:00:00') },
      { startMs: parseBeijing('2021-10-18 09:05:00') },
      { startMs: parseBeijing('2026-10-16 22:55:00') },
    ];
    const window = rollingMarketWindow(parseBeijing('2026-10-16 22:59:00'));
    expect(firstIndexAtOrAfter(records, window.lowerBoundMs)).toBe(1);
    expect(trimToRollingMarketWindow(records, window)).toEqual(records.slice(1));
    expect(trimToRollingMarketWindow(
      trimToRollingMarketWindow(records, window),
      window,
    )).toEqual(records.slice(1));
  });
});
