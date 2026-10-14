import type { Bar } from '../shared/types';

export interface WeeklyBreakout {
  bar: Bar;
  direction: 'up' | 'down';
  previousBoundary: number;
  value: number;
  weekStart: string;
  ordinal: number;
}

/** Analyze chronological 60-minute bars using Beijing calendar weeks, without future data. */
export function analyzeWeeklyRange(bars: Bar[]): { seedBars: Bar[]; breakouts: WeeklyBreakout[] } {
  const seedBars: Bar[] = [];
  const breakouts: WeeklyBreakout[] = [];
  const dayMs = 86_400_000;
  let currentWeek: number | undefined;
  let weekStart = '';
  let active = false;
  let ordinal = 0;
  let high = -Infinity;
  let low = Infinity;

  for (const bar of bars) {
    // Shift to Beijing before using UTC arithmetic; the host timezone is irrelevant.
    const localDay = Math.floor((bar.startMs + 8 * 3_600_000) / dayMs) * dayMs;
    const weekday = new Date(localDay).getUTCDay();
    const monday = localDay - ((weekday + 6) % 7) * dayMs;
    if (monday !== currentWeek) {
      currentWeek = monday;
      weekStart = new Date(monday).toISOString().slice(0, 10);
      active = weekday === 1;
      ordinal = 0;
      high = -Infinity;
      low = Infinity;
    }
    if (!active) continue;

    ordinal += 1;
    if (ordinal <= 8) {
      seedBars.push(bar);
    } else {
      // Both comparisons use the previous range, so an outside bar can mark both sides.
      if (bar.high > high) breakouts.push({ bar, direction: 'up', previousBoundary: high, value: bar.high, weekStart, ordinal });
      if (bar.low < low) breakouts.push({ bar, direction: 'down', previousBoundary: low, value: bar.low, weekStart, ordinal });
    }
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
  }
  return { seedBars, breakouts };
}
