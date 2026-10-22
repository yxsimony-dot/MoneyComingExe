import type { Bar } from '../shared/types';
import { analyzeWeeklyRange } from './weekly-range';

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

export interface BeijingDateRange {
  startDate: string;
  endDate: string;
}

export function isBeijingDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function beijingDateKey(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error('无效时间戳');
  return formatBeijing(ms).slice(0, 10);
}

export function validateBeijingDateRange(range: BeijingDateRange): BeijingDateRange {
  if (!isBeijingDate(range?.startDate) || !isBeijingDate(range?.endDate)) {
    throw new RangeError('复盘日期必须使用有效的 YYYY-MM-DD 北京时间日期。');
  }
  if (range.startDate > range.endDate) {
    throw new RangeError('开始日期不能晚于结束日期');
  }
  return range;
}

export function isBeijingDateInRange(ms: number, range: BeijingDateRange): boolean {
  validateBeijingDateRange(range);
  const date = beijingDateKey(ms);
  return date >= range.startDate && date <= range.endDate;
}

/** Interpret source timestamps explicitly; never consult the machine's local timezone. */
export function parseBeijing(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\+08:00)?$/.exec(text);
  if (!match) throw new Error(`无效北京时间：${text}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`无效北京时间：${text}`);
  }
  return date.getTime() - BEIJING_OFFSET;
}

export function formatBeijing(ms: number): string {
  const date = new Date(ms + BEIJING_OFFSET);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) throw new Error('无效时间戳');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** First record starting on/after the natural date, with dataset edge clamping. */
export function locateDate(bars: Bar[], date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请输入有效日期（YYYY-MM-DD）');
  const ms = parseBeijing(`${date} 00:00:00`);
  if (!bars.length) return -1;
  return Math.min(lowerBoundStart(bars, ms), bars.length - 1);
}

/** Containing half-open interval, otherwise the next record (or final record). */
export function locateTime(bars: Bar[], ms: number): number {
  if (!Number.isFinite(ms)) throw new Error('无效定位时间');
  if (!bars.length) return -1;
  const next = lowerBoundStart(bars, ms);
  if (next > 0 && bars[next - 1].endMs > ms) return next - 1;
  return Math.min(next, bars.length - 1);
}

export function lowerBoundStart(bars: Bar[], ms: number): number {
  let left = 0;
  let right = bars.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (bars[middle].startMs < ms) left = middle + 1;
    else right = middle;
  }
  return left;
}

/** Return eight chronological bars starting at each Beijing Monday's first bar. */
export function mondayFirstBars(bars: Bar[]): Bar[] {
  return analyzeWeeklyRange(bars).seedBars;
}
