import type { Bar } from '../shared/types';

export interface EmaPoint { bar: Bar; value: number; }

/** Chronological closes, seeded at the first available close and continued across sessions. */
export function exponentialMovingAverage(bars: Bar[], period = 20): EmaPoint[] {
  if (!bars.length) return [];
  const alpha = 2 / (period + 1);
  let value = bars[0].close;
  return bars.map((bar, index) => {
    if (index > 0) value += alpha * (bar.close - value);
    return { bar, value };
  });
}
