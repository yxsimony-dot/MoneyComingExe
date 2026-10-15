import type { Bar, EdbMinuteRecord, MarketUpdateCounts, Period } from '../shared/types';
import { formatBeijing } from './time';

const MINUTE_MS = 60_000;
const NANO_PER_MINUTE = 60_000_000_000n;
const REQUIRED_COLUMNS = [
  'datetime_nano',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'open_oi',
  'close_oi',
] as const;

function splitCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        value += character;
      }
    } else if (character === ',') {
      values.push(value);
      value = '';
      quoteClosed = false;
    } else if (character === '"' && !value && !quoteClosed) {
      quoted = true;
    } else if (character === '"' || quoteClosed) {
      throw new Error('CSV 引号格式无效');
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  values.push(value);
  return values;
}

function finiteNumber(value: string, field: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error(`${field} 必须为非空有限数值`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} 必须为非空有限数值`);
  return parsed;
}

export interface TradingMinute {
  session: Bar['session'];
  index: number;
  total: number;
  date: string;
}

export function tradingMinuteAt(ms: number): TradingMinute {
  const text = formatBeijing(ms);
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (second !== 0 || ms % MINUTE_MS !== 0) throw new Error(`非整分钟时间：${text}`);
  const wallMinute = hour * 60 + minute;
  const sessions: Array<[number, number, number, Bar['session'], number]> = [
    [540, 615, 0, 'day', 225],
    [630, 690, 75, 'day', 225],
    [810, 900, 135, 'day', 225],
    [1260, 1380, 0, 'night', 120],
  ];
  for (const [start, end, base, session, total] of sessions) {
    if (wallMinute >= start && wallMinute < end) {
      return { session, index: wallMinute - start + base, total, date: text.slice(0, 10) };
    }
  }
  throw new Error(`非交易分钟：${text}`);
}

function wallMinute(session: Bar['session'], index: number): number {
  if (session === 'night') return 1260 + index;
  if (index < 75) return 540 + index;
  if (index < 135) return 630 + index - 75;
  return 810 + index - 135;
}

function dateStartUtcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 60 * MINUTE_MS;
}

export function parseEdbMinuteCsv(text: string, label = 'EDB 响应'): EdbMinuteRecord[] {
  const fail = (line: number, reason: string): never => {
    throw new Error(`${label} 第${line}行：${reason}`);
  };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) fail(1, '响应为空');
  let header: string[];
  try {
    header = splitCsvRow(lines[0]);
  } catch (error) {
    return fail(1, (error as Error).message);
  }
  if (new Set(header).size !== header.length) fail(1, '存在重复列');
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) fail(1, `缺少列 ${column}`);
  }
  if (lines.length === 1) return [];
  const indexes = Object.fromEntries(
    REQUIRED_COLUMNS.map(column => [column, header.indexOf(column)]),
  ) as Record<typeof REQUIRED_COLUMNS[number], number>;
  const records: EdbMinuteRecord[] = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitCsvRow(lines[index]);
      if (fields.length !== header.length) throw new Error('列数与表头不一致');
      const field = (name: typeof REQUIRED_COLUMNS[number]) => fields[indexes[name]];
      const datetimeNano = field('datetime_nano');
      if (!/^\d+$/.test(datetimeNano)) throw new Error('datetime_nano 必须为非负整数');
      const nanos = BigInt(datetimeNano);
      if (nanos % NANO_PER_MINUTE !== 0n) throw new Error('datetime_nano 必须对齐到整分钟');
      const startMs = Number(nanos / 1_000_000n);
      if (!Number.isSafeInteger(startMs)) throw new Error('datetime_nano 超出可支持范围');
      tradingMinuteAt(startMs);
      const open = finiteNumber(field('open'), 'open');
      const high = finiteNumber(field('high'), 'high');
      const low = finiteNumber(field('low'), 'low');
      const close = finiteNumber(field('close'), 'close');
      if (low > high || open < low || open > high || close < low || close > high) {
        throw new Error('价格范围错误：开收盘必须处于最低与最高之间');
      }
      const volume = finiteNumber(field('volume'), 'volume');
      const openOi = finiteNumber(field('open_oi'), 'open_oi');
      const closeOi = finiteNumber(field('close_oi'), 'close_oi');
      if (volume < 0) throw new Error('volume 不得为负数');
      if (openOi < 0 || closeOi < 0) throw new Error('open_oi / close_oi 不得为负数');
      const previous = records.at(-1);
      if (previous && startMs <= previous.startMs) throw new Error('时间戳重复或未严格递增');
      records.push({
        datetimeNano,
        startMs,
        start: formatBeijing(startMs),
        open,
        high,
        low,
        close,
        volume,
        openOi,
        closeOi,
      });
    } catch (error) {
      fail(index + 1, (error as Error).message);
    }
  }
  return records;
}

export function mergeMinuteChunks(chunks: EdbMinuteRecord[][]): EdbMinuteRecord[] {
  const byTimestamp = new Map<string, EdbMinuteRecord>();
  for (const record of chunks.flat()) {
    const existing = byTimestamp.get(record.datetimeNano);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`EDB 分块边界存在冲突记录：${record.start}`);
    }
    byTimestamp.set(record.datetimeNano, record);
  }
  return [...byTimestamp.values()].sort((left, right) => left.startMs - right.startMs);
}

export function aggregateMinutes(
  records: EdbMinuteRecord[],
  period: Period,
  coverageEndMs = records.length ? records.at(-1)!.startMs + MINUTE_MS : Number.NEGATIVE_INFINITY,
): Bar[] {
  const groups = new Map<string, { minute: TradingMinute; bucket: number; records: EdbMinuteRecord[] }>();
  for (const record of records) {
    const minute = tradingMinuteAt(record.startMs);
    const bucket = Math.floor(minute.index / period);
    const key = `${minute.date}|${minute.session}|${bucket}`;
    const group = groups.get(key) ?? { minute, bucket, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const bars: Bar[] = [];
  for (const group of groups.values()) {
    const startIndex = group.bucket * period;
    const stopIndex = Math.min(startIndex + period, group.minute.total);
    const dayStart = dateStartUtcMs(group.minute.date);
    const startMs = dayStart + wallMinute(group.minute.session, startIndex) * MINUTE_MS;
    const endMs = dayStart + (wallMinute(group.minute.session, stopIndex - 1) + 1) * MINUTE_MS;
    if (endMs > coverageEndMs) continue;
    const part = group.records.sort((left, right) => left.startMs - right.startMs);
    bars.push({
      startMs,
      endMs,
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      open: part[0].open,
      high: Math.max(...part.map(record => record.high)),
      low: Math.min(...part.map(record => record.low)),
      close: part.at(-1)!.close,
      volume: part.reduce((sum, record) => sum + record.volume, 0),
      openOi: part[0].openOi,
      closeOi: part.at(-1)!.closeOi,
      session: group.minute.session,
      observedMinutes: part.length,
      expectedMinutes: stopIndex - startIndex,
      complete: part.length === stopIndex - startIndex,
    });
  }
  return bars.sort((left, right) => left.startMs - right.startMs);
}

function equalNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

export function assertBarsValid(bars: Bar[], period: Period): void {
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (previous && (bar.startMs <= previous.startMs || bar.startMs < previous.endMs)) {
      throw new Error(`${period} 分钟行情存在重复、倒序或重叠记录`);
    }
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.openOi, bar.closeOi].every(Number.isFinite)) {
      throw new Error(`${period} 分钟行情存在非有限数值`);
    }
    if (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high || bar.close < bar.low || bar.close > bar.high) {
      throw new Error(`${period} 分钟行情 OHLC 范围无效`);
    }
    if (bar.volume < 0 || bar.openOi < 0 || bar.closeOi < 0) {
      throw new Error(`${period} 分钟行情成交量或持仓量为负`);
    }
    const minute = tradingMinuteAt(bar.startMs);
    const bucket = Math.floor(minute.index / period);
    const expectedStartIndex = bucket * period;
    const expectedStopIndex = Math.min(expectedStartIndex + period, minute.total);
    const dayStart = dateStartUtcMs(minute.date);
    const expectedStartMs = dayStart + wallMinute(minute.session, expectedStartIndex) * MINUTE_MS;
    const expectedEndMs = dayStart + (wallMinute(minute.session, expectedStopIndex - 1) + 1) * MINUTE_MS;
    if (bar.startMs !== expectedStartMs || bar.endMs !== expectedEndMs || bar.session !== minute.session) {
      throw new Error(`${period} 分钟行情时间桶或交易时段无效：${bar.start}`);
    }
    if (bar.expectedMinutes !== expectedStopIndex - expectedStartIndex
      || !Number.isInteger(bar.observedMinutes)
      || bar.observedMinutes < 0
      || bar.observedMinutes > bar.expectedMinutes
      || bar.complete !== (bar.observedMinutes === bar.expectedMinutes)) {
      throw new Error(`${period} 分钟行情完整性字段无效：${bar.start}`);
    }
  }
}

export function reconcileBars(bars5: Bar[], bars60: Bar[]): void {
  let childIndex = 0;
  for (const parent of bars60) {
    while (childIndex < bars5.length && bars5[childIndex].endMs <= parent.startMs) childIndex += 1;
    const children: Bar[] = [];
    for (let index = childIndex; index < bars5.length && bars5[index].startMs < parent.endMs; index++) {
      const child = bars5[index];
      if (child.startMs >= parent.startMs && child.endMs <= parent.endMs) children.push(child);
    }
    if (!children.length) throw new Error(`60 分钟行情缺少 5 分钟组成记录：${parent.start}`);
    const expected = {
      open: children[0].open,
      high: Math.max(...children.map(child => child.high)),
      low: Math.min(...children.map(child => child.low)),
      close: children.at(-1)!.close,
      volume: children.reduce((sum, child) => sum + child.volume, 0),
    };
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (!equalNumber(parent[field], expected[field])) {
        throw new Error(`5 分钟与 60 分钟 ${field} 对账不一致：${parent.start}`);
      }
    }
  }
}

function sameBar(left: Bar, right: Bar): boolean {
  return left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.session === right.session
    && equalNumber(left.open, right.open)
    && equalNumber(left.high, right.high)
    && equalNumber(left.low, right.low)
    && equalNumber(left.close, right.close)
    && equalNumber(left.volume, right.volume)
    && equalNumber(left.openOi, right.openOi)
    && equalNumber(left.closeOi, right.closeOi)
    && left.observedMinutes === right.observedMinutes
    && left.expectedMinutes === right.expectedMinutes
    && left.complete === right.complete;
}

export interface MergeBarsResult {
  bars: Bar[];
  added: number;
  replaced: number;
  removed: number;
}

export function mergeBars(local: Bar[], replacement: Bar[], switchPointMs: number): MergeBarsResult {
  const prefix = local.filter(bar => bar.startMs < switchPointMs);
  const tail = replacement.filter(bar => bar.startMs >= switchPointMs);
  const oldTail = local.filter(bar => bar.startMs >= switchPointMs);
  const oldByStart = new Map(oldTail.map(bar => [bar.startMs, bar]));
  const nextByStart = new Map(tail.map(bar => [bar.startMs, bar]));
  return {
    bars: [...prefix, ...tail],
    added: tail.filter(bar => !oldByStart.has(bar.startMs)).length,
    replaced: tail.filter(bar => {
      const old = oldByStart.get(bar.startMs);
      return old !== undefined && !sameBar(old, bar);
    }).length,
    removed: oldTail.filter(bar => !nextByStart.has(bar.startMs)).length,
  };
}

export function updateCounts(five: MergeBarsResult, sixty: MergeBarsResult): MarketUpdateCounts {
  return {
    added5: five.added,
    replaced5: five.replaced,
    removed5: five.removed,
    added60: sixty.added,
    replaced60: sixty.replaced,
    removed60: sixty.removed,
  };
}

export function serializeBars(bars: Bar[]): string {
  const header = 'bar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete';
  const lines = bars.map(bar => [
    bar.start,
    bar.end,
    bar.session,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.openOi,
    bar.closeOi,
    bar.observedMinutes,
    bar.expectedMinutes,
    bar.complete ? 'True' : 'False',
  ].join(','));
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}
