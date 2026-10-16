import type {
  Bar,
  ContractRollover,
  EdbDailyRecord,
  MainContractMapping,
  Period,
} from '../shared/types';
import { formatBeijing, lowerBoundStart, parseBeijing } from './time';

const DAY_NANOS = 86_400_000_000_000n;
const DAILY_COLUMNS = [
  'datetime_nano',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'open_oi',
  'close_oi',
] as const;
const ROLLOVER_COLUMNS = ['trading_date', 'time', 'from_contract', 'to_contract'] as const;
const MAIN_CONTRACT = /^m\d{2}(?:01|05|09)$/;

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

function normalizedLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines;
}

function validateHeader(
  lines: string[],
  columns: readonly string[],
  label: string,
): { header: string[]; indexes: Record<string, number> } {
  if (!lines.length) throw new Error(`${label} 第1行：文件为空`);
  let header: string[];
  try {
    header = splitCsvRow(lines[0]);
  } catch (error) {
    throw new Error(`${label} 第1行：${(error as Error).message}`);
  }
  if (new Set(header).size !== header.length) throw new Error(`${label} 第1行：存在重复列`);
  for (const column of columns) {
    if (!header.includes(column)) throw new Error(`${label} 第1行：缺少列 ${column}`);
  }
  return {
    header,
    indexes: Object.fromEntries(columns.map(column => [column, header.indexOf(column)])),
  };
}

function assertContract(contract: string, field: string): void {
  if (!MAIN_CONTRACT.test(contract)) {
    throw new Error(`${field} 必须为豆粕主力月份合约，例如 m2701`);
  }
}

function assertDate(date: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${field} 必须为 YYYY-MM-DD`);
  parseBeijing(`${date} 00:00:00`);
}

export function parseEdbDailyCsv(text: string, label = 'EDB 日线响应'): EdbDailyRecord[] {
  const lines = normalizedLines(text);
  const { header, indexes } = validateHeader(lines, DAILY_COLUMNS, label);
  const records: EdbDailyRecord[] = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitCsvRow(lines[index]);
      if (fields.length !== header.length) throw new Error('列数与表头不一致');
      const field = (name: typeof DAILY_COLUMNS[number]) => fields[indexes[name]];
      const datetimeNano = field('datetime_nano');
      if (!/^\d+$/.test(datetimeNano)) throw new Error('datetime_nano 必须为非负整数');
      const nanos = BigInt(datetimeNano);
      if (nanos % DAY_NANOS !== 0n) throw new Error('datetime_nano 必须对齐到 UTC 自然日');
      const timeMs = Number(nanos / 1_000_000n);
      if (!Number.isSafeInteger(timeMs)) throw new Error('datetime_nano 超出可支持范围');
      const tradingDate = new Date(timeMs).toISOString().slice(0, 10);
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
      if (volume < 0 || openOi < 0 || closeOi < 0) {
        throw new Error('volume / open_oi / close_oi 不得为负数');
      }
      const previous = records.at(-1);
      if (previous && tradingDate <= previous.tradingDate) throw new Error('交易日重复或未严格递增');
      records.push({
        datetimeNano,
        tradingDate,
        open,
        high,
        low,
        close,
        volume,
        openOi,
        closeOi,
      });
    } catch (error) {
      throw new Error(`${label} 第${index + 1}行：${(error as Error).message}`);
    }
  }
  return records;
}

export function parseContractRollovers(text: string, label = '换月文件'): ContractRollover[] {
  const lines = normalizedLines(text);
  const { header, indexes } = validateHeader(lines, ROLLOVER_COLUMNS, label);
  const rollovers: ContractRollover[] = [];
  const tradingDates = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitCsvRow(lines[index]);
      if (fields.length !== header.length) throw new Error('列数与表头不一致');
      const field = (name: typeof ROLLOVER_COLUMNS[number]) => fields[indexes[name]];
      const tradingDate = field('trading_date');
      const time = field('time');
      const fromContract = field('from_contract');
      const toContract = field('to_contract');
      assertDate(tradingDate, 'trading_date');
      const timeMs = parseBeijing(time);
      assertContract(fromContract, 'from_contract');
      assertContract(toContract, 'to_contract');
      if (fromContract === toContract) throw new Error('新旧合约不得相同');
      if (tradingDates.has(tradingDate)) throw new Error('交易日重复');
      const previous = rollovers.at(-1);
      if (previous && (tradingDate <= previous.tradingDate || timeMs <= previous.timeMs)) {
        throw new Error('换月记录必须按交易日和时间严格递增');
      }
      tradingDates.add(tradingDate);
      rollovers.push({ tradingDate, time, timeMs, fromContract, toContract });
    } catch (error) {
      throw new Error(`${label} 第${index + 1}行：${(error as Error).message}`);
    }
  }
  return rollovers;
}

export function serializeContractRollovers(rollovers: ContractRollover[]): string {
  const parsed = parseContractRollovers([
    ROLLOVER_COLUMNS.join(','),
    ...rollovers.map(rollover => [
      rollover.tradingDate,
      rollover.time,
      rollover.fromContract,
      rollover.toContract,
    ].join(',')),
  ].join('\n'));
  const lines = parsed.map(rollover => [
    rollover.tradingDate,
    rollover.time,
    rollover.fromContract,
    rollover.toContract,
  ].join(','));
  return `\uFEFF${[ROLLOVER_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}

function sameDailyMatch(left: EdbDailyRecord, right: EdbDailyRecord): boolean {
  return left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.openOi === right.openOi
    && left.closeOi === right.closeOi;
}

export function identifyMainContracts(
  main: EdbDailyRecord[],
  candidates: ReadonlyMap<string, EdbDailyRecord[]>,
): MainContractMapping[] {
  const candidateRows = new Map(
    [...candidates].map(([contract, rows]) => {
      assertContract(contract, '候选合约');
      return [contract, new Map(rows.map(row => [row.tradingDate, row]))] as const;
    }),
  );
  return main.map(row => {
    const matches = [...candidateRows]
      .filter(([, rows]) => {
        const candidate = rows.get(row.tradingDate);
        return candidate !== undefined && sameDailyMatch(row, candidate);
      })
      .map(([contract]) => contract);
    if (matches.length !== 1) {
      throw new Error(`主连 ${row.tradingDate} 的具体合约匹配${matches.length ? '存在歧义' : '缺失'}`);
    }
    return { tradingDate: row.tradingDate, contract: matches[0] };
  });
}

export function locateRolloverBar(
  rollover: ContractRollover,
  bars: Bar[],
  period: Period,
): Bar | undefined {
  const index = lowerBoundStart(bars, rollover.timeMs);
  const bar = bars[index];
  if (!bar) return undefined;
  if (period === 5 && bar.startMs !== rollover.timeMs) return undefined;
  return bar;
}

export function detectContractRollovers(
  mappings: MainContractMapping[],
  bars5: Bar[],
): ContractRollover[] {
  const rollovers: ContractRollover[] = [];
  for (let index = 1; index < mappings.length; index++) {
    const previous = mappings[index - 1];
    const current = mappings[index];
    assertDate(previous.tradingDate, '前一交易日');
    assertDate(current.tradingDate, '当前交易日');
    assertContract(previous.contract, '旧合约');
    assertContract(current.contract, '新合约');
    if (current.tradingDate <= previous.tradingDate) throw new Error('主力合约映射必须按交易日严格递增');
    if (current.contract === previous.contract) continue;
    const cutoff = parseBeijing(`${previous.tradingDate} 15:00:00`);
    const firstIndex = lowerBoundStart(bars5, cutoff + 1);
    const first = bars5[firstIndex];
    if (!first) throw new Error(`换月 ${current.tradingDate} 缺少新主力首根 5 分钟 K 线`);
    const currentClose = parseBeijing(`${current.tradingDate} 15:00:00`);
    if (first.startMs > currentClose) {
      throw new Error(`换月 ${current.tradingDate} 无法在对应交易日定位首根 5 分钟 K 线`);
    }
    rollovers.push({
      tradingDate: current.tradingDate,
      time: formatBeijing(first.startMs),
      timeMs: first.startMs,
      fromContract: previous.contract,
      toContract: current.contract,
    });
  }
  return rollovers;
}

export function buildMainContractCandidates(startDate: string, endDate: string): string[] {
  assertDate(startDate, '候选开始日期');
  assertDate(endDate, '候选结束日期');
  if (endDate < startDate) throw new Error('候选日期范围无效');
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4)) + 1;
  const contracts: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    for (const month of ['01', '05', '09']) {
      contracts.push(`m${String(year).slice(-2)}${month}`);
    }
  }
  return contracts;
}

export function sameContractRollovers(
  left: ContractRollover[],
  right: ContractRollover[],
): boolean {
  return left.length === right.length && left.every((rollover, index) => {
    const other = right[index];
    return rollover.tradingDate === other.tradingDate
      && rollover.timeMs === other.timeMs
      && rollover.fromContract === other.fromContract
      && rollover.toContract === other.toContract;
  });
}
