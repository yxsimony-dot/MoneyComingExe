import type { Anomaly, Bar, Instrument } from '../shared/types';
import { parseBeijing } from './time';

const COLUMNS = ['bar_start', 'bar_end', 'session', 'open', 'high', 'low', 'close', 'volume', 'open_oi', 'close_oi', 'observed_minutes', 'expected_minutes', 'complete'] as const;

// The source contract has one record per physical line; quoted scalar fields are allowed.
function splitRow(line: string): string[] {
  const result: string[] = [];
  let value = '';
  let quoted = false;
  let closed = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ',') {
      result.push(value); value = ''; closed = false;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (char === '"' || closed) throw new Error('CSV 引号格式无效');
    else value += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  result.push(value);
  return result;
}

export function parseBars(text: string, filename: string): Bar[] {
  const fail = (line: number, reason: string): never => { throw new Error(`${filename} 第${line}行：${reason}`); };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) fail(1, '文件为空，没有行情记录');
  let header: string[];
  try { header = splitRow(lines[0]); } catch (error) { return fail(1, (error as Error).message); }
  if (new Set(header).size !== header.length) fail(1, '存在重复列');
  for (const column of COLUMNS) if (!header.includes(column)) fail(1, `缺少列 ${column}`);
  if (lines.length === 1) fail(2, '没有行情记录');
  const indexes = Object.fromEntries(COLUMNS.map(column => [column, header.indexOf(column)])) as Record<typeof COLUMNS[number], number>;
  const bars: Bar[] = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitRow(lines[index]);
      if (fields.length !== header.length) throw new Error('列数与表头不一致');
      const field = (name: typeof COLUMNS[number]) => fields[indexes[name]];
      const number = (name: typeof COLUMNS[number]): number => {
        const value = field(name);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
          throw new Error(`${name} 必须为非空有限数值`);
        }
        return Number(value);
      };
      const start = field('bar_start'); const end = field('bar_end');
      const startMs = parseBeijing(start); const endMs = parseBeijing(end);
      if (startMs >= endMs) throw new Error('时间区间必须满足开始早于结束');
      const previous = bars.at(-1);
      if (previous && (startMs <= previous.startMs || startMs < previous.endMs)) throw new Error('时间顺序错误、重复记录或区间重叠');
      const open = number('open'); const high = number('high'); const low = number('low'); const close = number('close');
      if (low > high || open < low || open > high || close < low || close > high) throw new Error('价格范围错误：开收盘必须处于最低与最高之间');
      const volume = number('volume'); const openOi = number('open_oi'); const closeOi = number('close_oi');
      if (volume < 0) throw new Error('volume 不得为负数');
      if (openOi < 0 || closeOi < 0) throw new Error('open_oi / close_oi 不得为负数');
      const observedMinutes = number('observed_minutes'); const expectedMinutes = number('expected_minutes');
      if (!Number.isInteger(observedMinutes) || !Number.isInteger(expectedMinutes) || observedMinutes < 0 || expectedMinutes <= 0 || observedMinutes > expectedMinutes) {
        throw new Error('observed_minutes / expected_minutes 必须为有效分钟数');
      }
      const completeValue = field('complete');
      if (completeValue !== 'True' && completeValue !== 'False') throw new Error('complete 必须为 True 或 False');
      const complete = completeValue === 'True';
      if (complete && observedMinutes !== expectedMinutes) throw new Error('complete 与组成分钟数不一致');
      const session = field('session');
      if (session !== 'day' && session !== 'night') throw new Error('session 必须为 day 或 night');
      bars.push({ start, end, startMs, endMs, open, high, low, close, volume, openOi, closeOi, observedMinutes, expectedMinutes, complete, session });
    } catch (error) { fail(index + 1, (error as Error).message); }
  }
  return bars;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审计文件结构无效');
  return value as Record<string, unknown>;
}

export function parseAudit(text: string, instrument: Instrument): Anomaly[] {
  const root = object(JSON.parse(text.replace(/^\uFEFF/, '')));
  const observation = object(root.suspicious_source_observation);
  const raw = object(observation.raw_edb_1m);
  if (typeof observation.local_time !== 'string' || typeof observation.edb_60m_bar_end !== 'string') throw new Error('审计文件缺少异常时间');
  const timeMs = parseBeijing(observation.local_time);
  const endMs = parseBeijing(observation.edb_60m_bar_end);
  if (endMs <= timeMs) throw new Error('审计文件60分钟结束时间无效');
  const numeric = (value: unknown): number => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('审计文件价格无效');
    return Number(value);
  };
  const rawLow = numeric(raw.low);
  const edbLow = numeric(observation.edb_60m_low);
  const sinaLow = numeric(observation.sina_60m_low);
  if (instrument === 'main_continuous') return [];
  return [{
    timeMs,
    title: '源价格差异 · 待核实',
    detail: `EDB 原始1分钟 ${observation.local_time} 最低价 ${rawLow}；所属60分钟（结束于 ${observation.edb_60m_bar_end}）EDB 最低价 ${edbLow}，所属60分钟的新浪对照低价 ${sinaLow}。这不是同一根5分钟的新浪对照值。差异已存在于原始分钟数据，尚未确认哪一来源有误，未修改原值。完整性标记仅检查组成分钟，不保证价格准确。`,
  }];
}
