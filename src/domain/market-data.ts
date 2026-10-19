import type { Bar, EdbMinuteRecord, MarketUpdateCounts, Period } from '../shared/types';
import {
  DEFAULT_INSTRUMENT,
  type TradingSchedule,
  type TradingSessionDefinition,
} from '../shared/instruments';
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

function sessionTotal(session: TradingSessionDefinition): number {
  return session.segments.reduce(
    (total, segment) => total + segment.endMinute - segment.startMinute,
    0,
  );
}

function assertTradingSchedule(schedule: TradingSchedule): void {
  const sessionIds = new Set<string>();
  for (const session of schedule) {
    if (sessionIds.has(session.id) || !session.segments.length) {
      throw new Error('交易时段配置无效');
    }
    sessionIds.add(session.id);
    let previousEnd = -1;
    for (const segment of session.segments) {
      if (!Number.isInteger(segment.startMinute)
        || !Number.isInteger(segment.endMinute)
        || segment.startMinute < 0
        || segment.endMinute > 24 * 60
        || segment.startMinute >= segment.endMinute
        || segment.startMinute < previousEnd) {
        throw new Error('交易时段配置无效');
      }
      previousEnd = segment.endMinute;
    }
  }
}

export function tradingMinuteAt(
  ms: number,
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): TradingMinute {
  assertTradingSchedule(schedule);
  const text = formatBeijing(ms);
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (second !== 0 || ms % MINUTE_MS !== 0) throw new Error(`非整分钟时间：${text}`);
  const wallMinute = hour * 60 + minute;
  for (const session of schedule) {
    let base = 0;
    const total = sessionTotal(session);
    for (const segment of session.segments) {
      if (wallMinute >= segment.startMinute && wallMinute < segment.endMinute) {
        return {
          session: session.id,
          index: wallMinute - segment.startMinute + base,
          total,
          date: text.slice(0, 10),
        };
      }
      base += segment.endMinute - segment.startMinute;
    }
  }
  throw new Error(`非交易分钟：${text}`);
}

function wallMinute(
  sessionId: Bar['session'],
  index: number,
  schedule: TradingSchedule,
): number {
  const session = schedule.find(candidate => candidate.id === sessionId);
  if (!session || index < 0 || index >= sessionTotal(session)) {
    throw new Error('交易分钟索引超出交易时段');
  }
  let remaining = index;
  for (const segment of session.segments) {
    const length = segment.endMinute - segment.startMinute;
    if (remaining < length) return segment.startMinute + remaining;
    remaining -= length;
  }
  throw new Error('交易分钟索引超出交易时段');
}

function dateStartUtcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 60 * MINUTE_MS;
}

export function parseEdbMinuteCsv(
  text: string,
  label = 'EDB 响应',
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): EdbMinuteRecord[] {
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
      tradingMinuteAt(startMs, schedule);
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
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): Bar[] {
  const groups = new Map<string, { minute: TradingMinute; bucket: number; records: EdbMinuteRecord[] }>();
  for (const record of records) {
    const minute = tradingMinuteAt(record.startMs, schedule);
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
    const startMs = dayStart + wallMinute(group.minute.session, startIndex, schedule) * MINUTE_MS;
    const endMs = dayStart + (wallMinute(group.minute.session, stopIndex - 1, schedule) + 1) * MINUTE_MS;
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

function sameMinuteRecord(left: EdbMinuteRecord, right: EdbMinuteRecord): boolean {
  return left.datetimeNano === right.datetimeNano
    && left.startMs === right.startMs
    && left.start === right.start
    && equalNumber(left.open, right.open)
    && equalNumber(left.high, right.high)
    && equalNumber(left.low, right.low)
    && equalNumber(left.close, right.close)
    && equalNumber(left.volume, right.volume)
    && equalNumber(left.openOi, right.openOi)
    && equalNumber(left.closeOi, right.closeOi);
}

export function assertMinuteRecordsValid(
  records: readonly EdbMinuteRecord[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): void {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    if (previous && record.startMs <= previous.startMs) {
      throw new Error('1 分钟行情存在重复或未严格递增记录');
    }
    if (!/^\d+$/.test(record.datetimeNano)
      || BigInt(record.datetimeNano) !== BigInt(record.startMs) * 1_000_000n
      || record.start !== formatBeijing(record.startMs)) {
      throw new Error(`1 分钟行情时间字段不一致：${record.start}`);
    }
    tradingMinuteAt(record.startMs, schedule);
    if (![record.open, record.high, record.low, record.close, record.volume, record.openOi, record.closeOi]
      .every(Number.isFinite)) {
      throw new Error(`1 分钟行情存在非有限数值：${record.start}`);
    }
    if (record.low > record.high
      || record.open < record.low
      || record.open > record.high
      || record.close < record.low
      || record.close > record.high) {
      throw new Error(`1 分钟行情 OHLC 范围无效：${record.start}`);
    }
    if (record.volume < 0 || record.openOi < 0 || record.closeOi < 0) {
      throw new Error(`1 分钟行情成交量或持仓量为负：${record.start}`);
    }
  }
}

export interface MergeMinutesResult {
  records: EdbMinuteRecord[];
  added: number;
  replaced: number;
  removed: number;
}

/**
 * Revises overlapping records and appends new records without deleting local
 * history that is no longer available from the remote rolling window.
 */
export function mergeMinuteHistory(
  local: readonly EdbMinuteRecord[],
  remote: readonly EdbMinuteRecord[],
): MergeMinutesResult {
  assertMinuteRecordsValid(local);
  assertMinuteRecordsValid(remote);
  const recordsByStart = new Map(local.map(record => [record.startMs, record]));
  let added = 0;
  let replaced = 0;
  for (const record of remote) {
    const existing = recordsByStart.get(record.startMs);
    if (!existing) added += 1;
    else if (!sameMinuteRecord(existing, record)) replaced += 1;
    recordsByStart.set(record.startMs, record);
  }
  const records = [...recordsByStart.values()].sort((left, right) => left.startMs - right.startMs);
  assertMinuteRecordsValid(records);
  return { records, added, replaced, removed: 0 };
}

export function completeMinutesForFiveMinuteBar(
  bar: Bar,
  records: readonly EdbMinuteRecord[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): EdbMinuteRecord[] | undefined {
  if (bar.expectedMinutes !== 5 || bar.endMs - bar.startMs !== 5 * MINUTE_MS) return undefined;
  const candidates = records.filter(record => record.startMs >= bar.startMs && record.startMs < bar.endMs);
  if (candidates.length !== 5) return undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].startMs !== bar.startMs + index * MINUTE_MS) return undefined;
    try {
      assertMinuteRecordsValid([candidates[index]], schedule);
    } catch {
      return undefined;
    }
  }
  const aggregate = aggregateMinutes(candidates, 5, bar.endMs, schedule);
  if (aggregate.length !== 1) return undefined;
  const rebuilt = aggregate[0];
  const matches = rebuilt.startMs === bar.startMs
    && rebuilt.endMs === bar.endMs
    && equalNumber(rebuilt.open, bar.open)
    && equalNumber(rebuilt.high, bar.high)
    && equalNumber(rebuilt.low, bar.low)
    && equalNumber(rebuilt.close, bar.close)
    && equalNumber(rebuilt.volume, bar.volume)
    && equalNumber(rebuilt.openOi, bar.openOi)
    && equalNumber(rebuilt.closeOi, bar.closeOi);
  return matches ? candidates : undefined;
}

export function assertBarsValid(
  bars: Bar[],
  period: Period,
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): void {
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
    const minute = tradingMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / period);
    const expectedStartIndex = bucket * period;
    const expectedStopIndex = Math.min(expectedStartIndex + period, minute.total);
    const dayStart = dateStartUtcMs(minute.date);
    const expectedStartMs = dayStart + wallMinute(minute.session, expectedStartIndex, schedule) * MINUTE_MS;
    const expectedEndMs = dayStart + (wallMinute(minute.session, expectedStopIndex - 1, schedule) + 1) * MINUTE_MS;
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

export function updateCounts(
  minutes: MergeMinutesResult,
  five: MergeBarsResult,
  sixty: MergeBarsResult,
): MarketUpdateCounts {
  return {
    added1: minutes.added,
    replaced1: minutes.replaced,
    removed1: minutes.removed,
    added5: five.added,
    replaced5: five.replaced,
    removed5: five.removed,
    added60: sixty.added,
    replaced60: sixty.replaced,
    removed60: sixty.removed,
    addedRollovers: 0,
    replacedRollovers: 0,
    removedRollovers: 0,
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

export function serializeMinuteRecords(
  records: readonly EdbMinuteRecord[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): string {
  assertMinuteRecordsValid(records, schedule);
  const header = REQUIRED_COLUMNS.join(',');
  const lines = records.map(record => [
    record.datetimeNano,
    record.open,
    record.high,
    record.low,
    record.close,
    record.volume,
    record.openOi,
    record.closeOi,
  ].join(','));
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}
