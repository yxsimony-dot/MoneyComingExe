import { formatBeijing, parseBeijing } from './time';

export const DEFAULT_MAXIMUM_MARKET_HISTORY_YEARS = 5;

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function subtractBeijingCalendarYears(
  timestampMs: number,
  years = DEFAULT_MAXIMUM_MARKET_HISTORY_YEARS,
): number {
  if (!Number.isSafeInteger(timestampMs)) {
    throw new Error('滚动窗口最新时间必须是安全整数毫秒时间戳');
  }
  if (!Number.isInteger(years) || years < 1) {
    throw new Error('滚动窗口年数必须是正整数');
  }
  const timestamp = formatBeijing(timestampMs);
  const year = Number(timestamp.slice(0, 4)) - years;
  const month = Number(timestamp.slice(5, 7));
  const day = Math.min(
    Number(timestamp.slice(8, 10)),
    daysInUtcMonth(year, month),
  );
  return parseBeijing(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + timestamp.slice(10),
  );
}

export interface RollingMarketWindow {
  latestMs: number;
  latest: string;
  lowerBoundMs: number;
  lowerBound: string;
  years: number;
}

export function rollingMarketWindow(
  latestMs: number,
  years = DEFAULT_MAXIMUM_MARKET_HISTORY_YEARS,
): RollingMarketWindow {
  const lowerBoundMs = subtractBeijingCalendarYears(latestMs, years);
  return {
    latestMs,
    latest: formatBeijing(latestMs),
    lowerBoundMs,
    lowerBound: formatBeijing(lowerBoundMs),
    years,
  };
}

export function firstIndexAtOrAfter<T extends { startMs: number }>(
  records: readonly T[],
  lowerBoundMs: number,
): number {
  let left = 0;
  let right = records.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (records[middle].startMs < lowerBoundMs) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function trimToRollingMarketWindow<T extends { startMs: number }>(
  records: readonly T[],
  window: Pick<RollingMarketWindow, 'lowerBoundMs' | 'latestMs'>,
): T[] {
  const start = firstIndexAtOrAfter(records, window.lowerBoundMs);
  let end = start;
  while (end < records.length && records[end].startMs <= window.latestMs) {
    end += 1;
  }
  return records.slice(start, end);
}
