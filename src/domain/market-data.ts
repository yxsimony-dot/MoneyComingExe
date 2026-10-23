import type {
  Bar,
  EdbMinuteRecord,
  MainContractMapping,
  MarketUpdateCounts,
  Period,
} from '../shared/types';
import {
  DEFAULT_INSTRUMENT,
  type InstrumentDefinition,
  type TradingSchedule,
  type TradingSessionDefinition,
} from '../shared/instruments';
import { formatBeijing } from './time';
import { timeIndexForRecords, type TimeSeriesIndex } from './time-index';

const MINUTE_MS = 60_000;
const CALENDAR_DAY_MS = 24 * 60 * MINUTE_MS;
const MINIMUM_THREE_YEAR_TRADING_DAYS = 600;
const MAXIMUM_TRADING_DATE_GAP_DAYS = 14;
const NANO_PER_MINUTE = 60_000_000_000n;
const SPECIAL_MARKET_SUSPENSION_MINUTES = new Set([
  '2022-12-06 10:00:00',
  '2022-12-06 10:01:00',
]);
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

interface TradingSegmentMinute {
  session: Bar['session'];
  segmentIndex: number;
  index: number;
  total: number;
  startMinute: number;
  endMinute: number;
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

function tradingSegmentMinuteAt(
  ms: number,
  schedule: TradingSchedule,
): TradingSegmentMinute {
  assertTradingSchedule(schedule);
  const text = formatBeijing(ms);
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (second !== 0 || ms % MINUTE_MS !== 0) throw new Error(`非整分钟时间：${text}`);
  const wallMinuteValue = hour * 60 + minute;
  for (const session of schedule) {
    for (let segmentIndex = 0; segmentIndex < session.segments.length; segmentIndex += 1) {
      const segment = session.segments[segmentIndex];
      if (wallMinuteValue >= segment.startMinute && wallMinuteValue < segment.endMinute) {
        return {
          session: session.id,
          segmentIndex,
          index: wallMinuteValue - segment.startMinute,
          total: segment.endMinute - segment.startMinute,
          startMinute: segment.startMinute,
          endMinute: segment.endMinute,
          date: text.slice(0, 10),
        };
      }
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

function isExpectedTradingMinute(startMs: number): boolean {
  return !SPECIAL_MARKET_SUSPENSION_MINUTES.has(formatBeijing(startMs));
}

function expectedSessionMinuteStarts(
  date: string,
  session: Bar['session'],
  startIndex: number,
  stopIndex: number,
  schedule: TradingSchedule,
): number[] {
  const dayStart = dateStartUtcMs(date);
  const starts: number[] = [];
  for (let index = startIndex; index < stopIndex; index += 1) {
    const startMs = dayStart + wallMinute(session, index, schedule) * MINUTE_MS;
    if (isExpectedTradingMinute(startMs)) starts.push(startMs);
  }
  return starts;
}

function expectedWallMinuteStarts(
  date: string,
  startMinute: number,
  stopMinute: number,
): number[] {
  const dayStart = dateStartUtcMs(date);
  const starts: number[] = [];
  for (let minute = startMinute; minute < stopMinute; minute += 1) {
    const startMs = dayStart + minute * MINUTE_MS;
    if (isExpectedTradingMinute(startMs)) starts.push(startMs);
  }
  return starts;
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
    const expectedMinutes = expectedSessionMinuteStarts(
      group.minute.date,
      group.minute.session,
      startIndex,
      stopIndex,
      schedule,
    ).length;
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
      expectedMinutes,
      complete: part.length === expectedMinutes,
    });
  }
  return bars.sort((left, right) => left.startMs - right.startMs);
}

export function aggregateFiveMinuteBars(
  bars5: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): Bar[] {
  assertBarsValid(bars5, 5, schedule);
  const groups = new Map<string, {
    minute: TradingSegmentMinute;
    bucket: number;
    bars: Bar[];
  }>();
  for (const bar of bars5) {
    const minute = tradingSegmentMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / 60);
    const startIndex = bucket * 60;
    const stopIndex = Math.min(startIndex + 60, minute.total);
    const segmentEndMs = dateStartUtcMs(minute.date) + minute.endMinute * MINUTE_MS;
    if (bar.session !== minute.session
      || bar.startMs + 5 * MINUTE_MS !== bar.endMs
      || bar.endMs > segmentEndMs
      || minute.index % 5 !== 0
      || (stopIndex - startIndex) % 5 !== 0) {
      throw new Error(`5 分钟行情不能按交易分段聚合：${bar.start}`);
    }
    const key = `${minute.date}|${minute.session}|${minute.segmentIndex}|${bucket}`;
    const group = groups.get(key) ?? { minute, bucket, bars: [] };
    group.bars.push(bar);
    groups.set(key, group);
  }

  const bars60: Bar[] = [];
  for (const group of groups.values()) {
    const startIndex = group.bucket * 60;
    const stopIndex = Math.min(startIndex + 60, group.minute.total);
    const dayStart = dateStartUtcMs(group.minute.date);
    const startMs = dayStart + (group.minute.startMinute + startIndex) * MINUTE_MS;
    const endMs = dayStart + (group.minute.startMinute + stopIndex) * MINUTE_MS;
    const expectedMinutes = expectedWallMinuteStarts(
      group.minute.date,
      group.minute.startMinute + startIndex,
      group.minute.startMinute + stopIndex,
    ).length;
    const children = group.bars.sort((left, right) => left.startMs - right.startMs);
    const expectedChildren = (endMs - startMs) / (5 * MINUTE_MS);
    const contiguous = children.length === expectedChildren
      && children.every((bar, index) => (
        bar.startMs === startMs + index * 5 * MINUTE_MS
        && bar.endMs === startMs + (index + 1) * 5 * MINUTE_MS
      ));
    const observedMinutes = children.reduce((sum, bar) => sum + bar.observedMinutes, 0);
    bars60.push({
      startMs,
      endMs,
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      open: children[0].open,
      high: Math.max(...children.map(bar => bar.high)),
      low: Math.min(...children.map(bar => bar.low)),
      close: children.at(-1)!.close,
      volume: children.reduce((sum, bar) => sum + bar.volume, 0),
      openOi: children[0].openOi,
      closeOi: children.at(-1)!.closeOi,
      session: group.minute.session,
      observedMinutes,
      expectedMinutes,
      complete: contiguous
        && observedMinutes === expectedMinutes
        && children.every(bar => bar.complete),
    });
  }
  return bars60.sort((left, right) => left.startMs - right.startMs);
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
  index: TimeSeriesIndex<EdbMinuteRecord> = timeIndexForRecords(records),
): EdbMinuteRecord[] | undefined {
  try {
    assertBarsValid([bar], 5, schedule);
  } catch {
    return undefined;
  }
  if (!bar.complete) return undefined;
  const minute = tradingMinuteAt(bar.startMs, schedule);
  const startIndex = Math.floor(minute.index / 5) * 5;
  const stopIndex = Math.min(startIndex + 5, minute.total);
  const expectedStarts = expectedSessionMinuteStarts(
    minute.date,
    minute.session,
    startIndex,
    stopIndex,
    schedule,
  );
  const candidates = index.recordsInRange(bar.startMs, bar.endMs);
  if (candidates.length !== expectedStarts.length) return undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].startMs !== expectedStarts[index]) return undefined;
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

export function assertMinuteCoverageMatchesFiveMinuteBars(
  records: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): void {
  assertMinuteRecordsValid(records, schedule);
  assertBarsValid(bars5, 5, schedule);
  let minuteIndex = 0;
  for (const bar of bars5) {
    while (records[minuteIndex]?.startMs < bar.startMs) minuteIndex += 1;
    let stopIndex = minuteIndex;
    while (records[stopIndex]?.startMs < bar.endMs) stopIndex += 1;
    const candidates = records.slice(minuteIndex, stopIndex);
    const minute = tradingMinuteAt(bar.startMs, schedule);
    const startIndex = Math.floor(minute.index / 5) * 5;
    const expectedStarts = expectedSessionMinuteStarts(
      minute.date,
      minute.session,
      startIndex,
      Math.min(startIndex + 5, minute.total),
      schedule,
    );
    const completeCoverage = candidates.length === expectedStarts.length
      && candidates.every((record, index) => record.startMs === expectedStarts[index]);
    if (completeCoverage
      && !completeMinutesForFiveMinuteBar(bar, candidates, schedule)) {
      throw new Error(`1 分钟与 5 分钟行情对账不一致：${bar.start}`);
    }
    minuteIndex = stopIndex;
  }
}

export interface TradingBarBucket {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  session: Bar['session'];
  expectedMinutes: number;
}

export function tradingBarBucketAt(
  startMs: number,
  period: Period,
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): TradingBarBucket {
  const minute = tradingMinuteAt(startMs, schedule);
  const bucket = Math.floor(minute.index / period);
  const expectedStartIndex = bucket * period;
  const expectedStopIndex = Math.min(expectedStartIndex + period, minute.total);
  const dayStart = dateStartUtcMs(minute.date);
  const expectedStartMs = dayStart
    + wallMinute(minute.session, expectedStartIndex, schedule) * MINUTE_MS;
  const expectedEndMs = dayStart
    + (wallMinute(minute.session, expectedStopIndex - 1, schedule) + 1) * MINUTE_MS;
  return {
    startMs: expectedStartMs,
    endMs: expectedEndMs,
    start: formatBeijing(expectedStartMs),
    end: formatBeijing(expectedEndMs),
    session: minute.session,
    expectedMinutes: expectedSessionMinuteStarts(
      minute.date,
      minute.session,
      expectedStartIndex,
      expectedStopIndex,
      schedule,
    ).length,
  };
}

export function assertBarsValid(
  bars: readonly Bar[],
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
    const bucket = tradingBarBucketAt(bar.startMs, period, schedule);
    if (bar.startMs !== bucket.startMs
      || bar.endMs !== bucket.endMs
      || bar.session !== bucket.session) {
      throw new Error(`${period} 分钟行情时间桶或交易时段无效：${bar.start}`);
    }
    if (bar.expectedMinutes !== bucket.expectedMinutes
      || !Number.isInteger(bar.observedMinutes)
      || bar.observedMinutes < 0
      || bar.observedMinutes > bar.expectedMinutes
      || bar.complete !== (bar.observedMinutes === bar.expectedMinutes)) {
      throw new Error(`${period} 分钟行情完整性字段无效：${bar.start}`);
    }
  }
}

export function assertSegmentedSixtyMinuteBarsValid(
  bars: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): void {
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (previous && (bar.startMs <= previous.startMs || bar.startMs < previous.endMs)) {
      throw new Error('60 分钟行情存在重复、倒序或重叠记录');
    }
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.openOi, bar.closeOi]
      .every(Number.isFinite)) {
      throw new Error('60 分钟行情存在非有限数值');
    }
    if (bar.low > bar.high
      || bar.open < bar.low
      || bar.open > bar.high
      || bar.close < bar.low
      || bar.close > bar.high) {
      throw new Error('60 分钟行情 OHLC 范围无效');
    }
    if (bar.volume < 0 || bar.openOi < 0 || bar.closeOi < 0) {
      throw new Error('60 分钟行情成交量或持仓量为负');
    }
    const minute = tradingSegmentMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / 60);
    const expectedStartIndex = bucket * 60;
    const expectedStopIndex = Math.min(expectedStartIndex + 60, minute.total);
    const dayStart = dateStartUtcMs(minute.date);
    const expectedStartMs = dayStart
      + (minute.startMinute + expectedStartIndex) * MINUTE_MS;
    const expectedEndMs = dayStart
      + (minute.startMinute + expectedStopIndex) * MINUTE_MS;
    if (bar.startMs !== expectedStartMs
      || bar.endMs !== expectedEndMs
      || bar.session !== minute.session) {
      throw new Error(`60 分钟行情跨越休息或交易时段边界：${bar.start}`);
    }
    const expectedMinutes = expectedWallMinuteStarts(
      minute.date,
      minute.startMinute + expectedStartIndex,
      minute.startMinute + expectedStopIndex,
    ).length;
    if (bar.expectedMinutes !== expectedMinutes
      || (expectedEndMs - expectedStartMs) % (5 * MINUTE_MS) !== 0
      || !Number.isInteger(bar.observedMinutes)
      || bar.observedMinutes < 0
      || bar.observedMinutes > bar.expectedMinutes
      || bar.complete !== (bar.observedMinutes === bar.expectedMinutes)) {
      throw new Error(`60 分钟行情完整性字段无效：${bar.start}`);
    }
  }
}

function calendarDayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`交易日格式无效：${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const milliseconds = Date.UTC(year, month - 1, day);
  const parsed = new Date(milliseconds);
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    throw new Error(`交易日格式无效：${date}`);
  }
  return milliseconds / CALENDAR_DAY_MS;
}

function subtractCalendarYearsFromDate(date: string, years: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const targetYear = year - years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return [
    targetYear,
    String(month).padStart(2, '0'),
    String(Math.min(day, lastDay)).padStart(2, '0'),
  ].join('-');
}

function firstMappingAfter(
  mappings: readonly MainContractMapping[],
  naturalDate: string,
): MainContractMapping | undefined {
  let left = 0;
  let right = mappings.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (mappings[middle].tradingDate <= naturalDate) left = middle + 1;
    else right = middle;
  }
  return mappings[left];
}

interface RepresentedTradingDate {
  dayObserved: boolean;
  nightNaturalDates: Set<string>;
}

function missingCoverageError(
  definition: InstrumentDefinition,
  tradingDate: string,
  session: Bar['session'],
  period: 5 | 60,
  startMs: number,
): Error {
  const sessionLabel = session === 'day' ? '日盘' : '夜盘';
  return new Error(
    `${definition.name} ${tradingDate} ${sessionLabel}缺少 ${period} 分钟 K 线：${formatBeijing(startMs)}`,
  );
}

export function assertContinuousBarCoverage(
  definition: InstrumentDefinition,
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  mainContractMappings: readonly MainContractMapping[],
): void {
  if (!bars5.length || !bars60.length || !mainContractMappings.length) {
    throw new Error(`${definition.name} 缺少连续覆盖校验所需的 5/60 分钟行情或主力映射`);
  }
  assertBarsValid(bars5, 5, definition.tradingSessions);
  assertSegmentedSixtyMinuteBarsValid(bars60, definition.tradingSessions);

  const mappingDates = new Set<string>();
  for (let index = 0; index < mainContractMappings.length; index += 1) {
    const mapping = mainContractMappings[index];
    calendarDayNumber(mapping.tradingDate);
    const previous = mainContractMappings[index - 1];
    if (previous && mapping.tradingDate <= previous.tradingDate) {
      throw new Error(`${definition.name} 主力映射交易日必须严格递增`);
    }
    mappingDates.add(mapping.tradingDate);
  }

  const represented = new Map<string, RepresentedTradingDate>();
  const mapBars = (bars: readonly Bar[], period: 5 | 60): void => {
    for (const bar of bars) {
      const minute = tradingSegmentMinuteAt(bar.startMs, definition.tradingSessions);
      let tradingDate: string;
      if (minute.session === 'day') {
        tradingDate = minute.date;
        if (!mappingDates.has(tradingDate)) {
          throw new Error(
            `${definition.name} ${period} 分钟日盘 K 线无法映射到主力交易日：${bar.start}`,
          );
        }
      } else {
        const mapping = firstMappingAfter(mainContractMappings, minute.date);
        if (!mapping) {
          throw new Error(
            `${definition.name} ${period} 分钟夜盘 K 线之后缺少主力交易日：${bar.start}`,
          );
        }
        tradingDate = mapping.tradingDate;
      }
      const entry = represented.get(tradingDate) ?? {
        dayObserved: false,
        nightNaturalDates: new Set<string>(),
      };
      if (minute.session === 'day') entry.dayObserved = true;
      else entry.nightNaturalDates.add(minute.date);
      represented.set(tradingDate, entry);
    }
  };
  mapBars(bars5, 5);
  mapBars(bars60, 60);

  const representedDates = [...represented.keys()].sort();
  if (!representedDates.length) {
    throw new Error(`${definition.name} 没有可映射的交易日`);
  }
  const firstRepresentedDate = representedDates[0];
  const lastRepresentedDate = representedDates.at(-1)!;
  const representedMappings = mainContractMappings.filter(mapping => (
    mapping.tradingDate >= firstRepresentedDate
    && mapping.tradingDate <= lastRepresentedDate
  ));
  if (!representedMappings.length
    || representedMappings[0].tradingDate !== firstRepresentedDate
    || representedMappings.at(-1)!.tradingDate !== lastRepresentedDate) {
    throw new Error(
      `${definition.name} 主力映射未覆盖完整行情交易日范围：${firstRepresentedDate} 至 ${lastRepresentedDate}`,
    );
  }

  for (let index = 1; index < representedMappings.length; index += 1) {
    const previous = representedMappings[index - 1].tradingDate;
    const current = representedMappings[index].tradingDate;
    const gapDays = calendarDayNumber(current) - calendarDayNumber(previous);
    if (gapDays > MAXIMUM_TRADING_DATE_GAP_DAYS) {
      throw new Error(
        `${definition.name} 主力映射交易日间隔超过 ${MAXIMUM_TRADING_DATE_GAP_DAYS} 天：${previous} -> ${current}`,
      );
    }
  }

  const requiredStartDate = subtractCalendarYearsFromDate(lastRepresentedDate, 3);
  const requiredWindowMappings = representedMappings.filter(mapping => (
    mapping.tradingDate >= requiredStartDate
  ));
  if (requiredWindowMappings.length < MINIMUM_THREE_YEAR_TRADING_DAYS) {
    throw new Error(
      `${definition.name} 最近三年主力映射交易日不足 ${MINIMUM_THREE_YEAR_TRADING_DAYS} 日：`
      + `${requiredStartDate} 至 ${lastRepresentedDate} 仅 ${requiredWindowMappings.length} 日`,
    );
  }

  const bars5ByStart = new Map(bars5.map(bar => [bar.startMs, bar]));
  const bars60ByStart = new Map(bars60.map(bar => [bar.startMs, bar]));
  const assertExpected = (
    barsByStart: ReadonlyMap<number, Bar>,
    period: 5 | 60,
    tradingDate: string,
    naturalDate: string,
    session: TradingSessionDefinition,
    startMinute: number,
  ): void => {
    const startMs = dateStartUtcMs(naturalDate) + startMinute * MINUTE_MS;
    const bar = barsByStart.get(startMs);
    if (!bar) {
      throw missingCoverageError(definition, tradingDate, session.id, period, startMs);
    }
    if (!bar.complete || bar.observedMinutes !== bar.expectedMinutes) {
      throw new Error(
        `${definition.name} ${tradingDate} ${session.id === 'day' ? '日盘' : '夜盘'}`
        + `${period} 分钟 K 线不完整：${formatBeijing(startMs)}`,
      );
    }
  };
  const assertSession = (
    tradingDate: string,
    naturalDate: string,
    session: TradingSessionDefinition,
  ): void => {
    for (const segment of session.segments) {
      for (let minute = segment.startMinute; minute < segment.endMinute; minute += 5) {
        assertExpected(bars5ByStart, 5, tradingDate, naturalDate, session, minute);
      }
      for (let minute = segment.startMinute; minute < segment.endMinute; minute += 60) {
        assertExpected(bars60ByStart, 60, tradingDate, naturalDate, session, minute);
      }
    }
  };

  for (const mapping of representedMappings) {
    const entry = represented.get(mapping.tradingDate)
      ?? { dayObserved: false, nightNaturalDates: new Set<string>() };
    const isTrailingNightOnlyTradingDate = mapping.tradingDate === lastRepresentedDate
      && !entry.dayObserved
      && entry.nightNaturalDates.size > 0;
    for (const session of definition.tradingSessions) {
      if (session.id === 'day') {
        if (!isTrailingNightOnlyTradingDate) {
          assertSession(mapping.tradingDate, mapping.tradingDate, session);
        }
        continue;
      }
      if (entry.nightNaturalDates.size > 1) {
        throw new Error(
          `${definition.name} ${mapping.tradingDate} 夜盘映射到多个自然日：`
          + [...entry.nightNaturalDates].sort().join('、'),
        );
      }
      for (const naturalDate of entry.nightNaturalDates) {
        assertSession(mapping.tradingDate, naturalDate, session);
      }
    }
  }
}

export function reconcileLegacyBars(
  bars5: readonly Bar[],
  bars60: readonly Bar[],
): void {
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

export type SixtyMinuteBarFormat = 'legacy' | 'segmented';

export function detectSixtyMinuteBarFormat(
  bars60: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
  ambiguousPreference: SixtyMinuteBarFormat = 'segmented',
): SixtyMinuteBarFormat {
  let segmentedError: unknown;
  let segmentedValid = false;
  try {
    assertSegmentedSixtyMinuteBarsValid(bars60, schedule);
    segmentedValid = true;
  } catch (error) {
    segmentedError = error;
  }
  let legacyValid = false;
  try {
    assertBarsValid(bars60, 60, schedule);
    legacyValid = true;
  } catch {
    if (segmentedValid) return 'segmented';
    throw segmentedError;
  }
  if (segmentedValid && legacyValid) return ambiguousPreference;
  return legacyValid ? 'legacy' : 'segmented';
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

export function reconcileBars(
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): void {
  assertBarsValid(bars5, 5, schedule);
  assertSegmentedSixtyMinuteBarsValid(bars60, schedule);
  const rebuilt = aggregateFiveMinuteBars(bars5, schedule);
  const completeRebuiltCount = rebuilt.reduce(
    (count, bar) => count + Number(bar.complete),
    0,
  );
  if (bars60.length !== completeRebuiltCount) {
    if (bars60.length > completeRebuiltCount) {
      const parent = bars60[completeRebuiltCount];
      throw new Error(
        `5 分钟与 60 分钟时间桶数量不一致（60 分钟行情组成 5 分钟数量不一致）：${parent.start}`,
      );
    }
    throw new Error('5 分钟与 60 分钟时间桶数量不一致');
  }

  let barIndex = 0;
  let completeIndex = 0;
  for (const expected of rebuilt) {
    const firstChildIndex = barIndex;
    let contiguous = true;
    while (barIndex < bars5.length && bars5[barIndex].startMs < expected.endMs) {
      const child = bars5[barIndex];
      const childIndex = barIndex - firstChildIndex;
      if (
        !child.complete
        || child.startMs !== expected.startMs + childIndex * 5 * MINUTE_MS
        || child.endMs !== expected.startMs + (childIndex + 1) * 5 * MINUTE_MS
      ) {
        contiguous = false;
      }
      barIndex += 1;
    }
    const childCount = barIndex - firstChildIndex;
    const expectedChildren = (expected.endMs - expected.startMs) / (5 * MINUTE_MS);
    if (!contiguous
      || childCount === 0
      || bars5[firstChildIndex].startMs !== expected.startMs
      || bars5[barIndex - 1].endMs > expected.endMs) {
      throw new Error(
        `5 分钟与 60 分钟时间桶数量不一致（60 分钟行情组成 5 分钟数量不一致）：${expected.start}`,
      );
    }

    if (!expected.complete) {
      if (childCount >= expectedChildren) {
        throw new Error('5 分钟与 60 分钟时间桶数量不一致');
      }
      continue;
    }

    const parent = bars60[completeIndex];
    completeIndex += 1;
    if (childCount !== expectedChildren) {
      throw new Error(
        `5 分钟与 60 分钟时间桶数量不一致（60 分钟行情组成 5 分钟数量不一致）：${parent.start}`,
      );
    }
    if (parent.startMs !== expected.startMs
      || parent.endMs !== expected.endMs
      || parent.session !== expected.session) {
      throw new Error(`5 分钟与 60 分钟时间桶不一致：${parent.start}`);
    }
    for (const field of [
      'open',
      'high',
      'low',
      'close',
      'volume',
      'openOi',
      'closeOi',
    ] as const) {
      if (!equalNumber(parent[field], expected[field])) {
        throw new Error(`5 分钟与 60 分钟 ${field} 对账不一致：${parent.start}`);
      }
    }
    if (parent.observedMinutes !== expected.observedMinutes
      || parent.expectedMinutes !== expected.expectedMinutes
      || parent.complete !== expected.complete) {
      throw new Error(`5 分钟与 60 分钟完整性对账不一致：${parent.start}`);
    }
  }
  if (barIndex !== bars5.length || completeIndex !== bars60.length) {
      throw new Error('5 分钟与 60 分钟时间桶数量不一致');
  }
}

export function reconcileCompatibleBars(
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  schedule: TradingSchedule = DEFAULT_INSTRUMENT.tradingSessions,
): SixtyMinuteBarFormat {
  const format = detectSixtyMinuteBarFormat(bars60, schedule);
  if (format === 'segmented') {
    reconcileBars(bars5, bars60, schedule);
  } else {
    assertBarsValid(bars5, 5, schedule);
    reconcileLegacyBars(bars5, bars60);
  }
  return format;
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

export function mergeBarsPreservingHistory(
  local: readonly Bar[],
  replacement: readonly Bar[],
): MergeBarsResult {
  const barsByStart = new Map(local.map(bar => [bar.startMs, bar]));
  let added = 0;
  let replaced = 0;
  for (const bar of replacement) {
    const previous = barsByStart.get(bar.startMs);
    if (!previous) added += 1;
    else if (!sameBar(previous, bar)) replaced += 1;
    barsByStart.set(bar.startMs, bar);
  }
  return {
    bars: [...barsByStart.values()].sort((left, right) => left.startMs - right.startMs),
    added,
    replaced,
    removed: 0,
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
