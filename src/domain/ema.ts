import type { Bar } from '../shared/types';

export interface EmaPoint { bar: Bar; value: number; }

/** Chronological closes, seeded at the first available close and continued across sessions. */
export function exponentialMovingAverage(bars: Bar[], period = 20): EmaPoint[] {
  if (!bars.length) return [];
  const alpha = 2 / (period + 1);
  let value = bars[0].close;
  const points = new Array<EmaPoint>(bars.length);
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (index > 0) value += alpha * (bar.close - value);
    points[index] = { bar, value };
  }
  return points;
}

export async function exponentialMovingAverageCooperatively(
  bars: Bar[],
  period: number,
  yieldControl: () => void | Promise<void>,
  batchSize = 2_048,
): Promise<EmaPoint[]> {
  if (!bars.length) return [];
  const alpha = 2 / (period + 1);
  let value = bars[0].close;
  const points = new Array<EmaPoint>(bars.length);
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (index > 0) value += alpha * (bar.close - value);
    points[index] = { bar, value };
    if (index + 1 < bars.length && (index + 1) % batchSize === 0) {
      await yieldControl();
    }
  }
  return points;
}
