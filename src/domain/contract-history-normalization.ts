import type {
  ContractFiveMinuteHistorySource,
  ContractFiveMinuteImportRecord,
  ContractHistoryImportReport,
  ContractHistoryImportResult,
  ContractHistoryPageRequest,
  ContractHistorySourceFile,
  NormalizedContractFiveMinuteRecord,
} from './contract-history-import';
import { tradingMinuteAt } from './market-data';
import { formatBeijing, parseBeijing } from './time';
import {
  instrumentDefinition,
  type ExchangeId,
  type InstrumentDefinition,
} from '../shared/instruments';

const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;
const DEFAULT_PAGE_SIZE = 5_000;

const EXCHANGE_ALIASES = new Map<string, ExchangeId>([
  ['DCE', 'DCE'],
  ['DALIAN', 'DCE'],
  ['DALIAN COMMODITY EXCHANGE', 'DCE'],
  ['大商所', 'DCE'],
  ['CZCE', 'CZCE'],
  ['ZCE', 'CZCE'],
  ['ZHENGZHOU', 'CZCE'],
  ['ZHENGZHOU COMMODITY EXCHANGE', 'CZCE'],
  ['郑商所', 'CZCE'],
  ['SHFE', 'SHFE'],
  ['SHF', 'SHFE'],
  ['SHANGHAI', 'SHFE'],
  ['SHANGHAI FUTURES EXCHANGE', 'SHFE'],
  ['上期所', 'SHFE'],
]);

export interface ContractHistoryImportOptions {
  tradingDates: readonly string[];
  toolVersion: string;
  pageSize?: number;
}

interface NormalizationResult {
  records: NormalizedContractFiveMinuteRecord[];
  identicalDuplicatesRemoved: number;
  normalizedContract: string;
  sourceCoverage: {
    firstTimestamp: string;
    lastTimestamp: string;
  };
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNonEmpty(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

function assertSourceFileValid(file: ContractHistorySourceFile): void {
  assertNonEmpty(file.relativePath, '来源文件路径');
  if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error('来源文件 SHA-256 无效');
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new Error('来源文件字节数无效');
  }
  if (!Number.isSafeInteger(file.rows) || file.rows < 0) {
    throw new Error('来源文件行数无效');
  }
  if ((file.firstTimestamp === null) !== (file.lastTimestamp === null)) {
    throw new Error('来源文件首末时间不完整');
  }
}

function sameSourceFile(
  left: ContractHistorySourceFile,
  right: ContractHistorySourceFile,
): boolean {
  return left.relativePath === right.relativePath
    && left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.rows === right.rows
    && left.firstTimestamp === right.firstTimestamp
    && left.lastTimestamp === right.lastTimestamp;
}

export function normalizeExchangeCode(value: string): ExchangeId {
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  const exchange = EXCHANGE_ALIASES.get(normalized);
  if (!exchange) throw new Error(`不支持的交易所代码：${value}`);
  return exchange;
}

function fullYearFromTwoDigits(twoDigits: number, referenceYear: number): number {
  const century = Math.floor(referenceYear / 100) * 100;
  const candidates = [
    century - 100 + twoDigits,
    century + twoDigits,
    century + 100 + twoDigits,
  ];
  return candidates.sort((left, right) => {
    const distance = Math.abs(left - referenceYear) - Math.abs(right - referenceYear);
    return distance || left - right;
  })[0];
}

function czceFullYear(
  expiry: string,
  referenceYear: number,
  definition: InstrumentDefinition,
): number {
  if (expiry.length === 4) {
    return fullYearFromTwoDigits(Number(expiry.slice(0, 2)), referenceYear);
  }
  const yearDigit = Number(expiry[0]);
  const candidates: number[] = [];
  for (
    let year = referenceYear;
    year <= referenceYear + definition.contractCode.futureYearWindow;
    year += 1
  ) {
    if (year % 10 === yearDigit) candidates.push(year);
  }
  if (candidates.length !== 1) {
    throw new Error(
      `无法根据 ${referenceYear} 年记录唯一推断郑商所到期年份：${expiry}`,
    );
  }
  return candidates[0];
}

export function normalizeHistoricalContractCode(
  definition: InstrumentDefinition,
  sourceContract: string,
  referenceYear: number,
): {
  contract: string;
  expiryYear: number;
  expiryMonth: number;
} {
  const sourceProduct = definition.productCode.toUpperCase();
  const match = new RegExp(
    `^${escapedRegExp(sourceProduct)}(\\d{${definition.exchange === 'CZCE' ? '3,4' : '4'}})$`,
    'i',
  ).exec(sourceContract.trim());
  if (!match) {
    throw new Error(`${definition.name} 不支持来源合约代码：${sourceContract}`);
  }
  const expiry = match[1];
  const expiryMonth = Number(expiry.slice(-2));
  if (!definition.contractCode.candidateMonths.includes(expiryMonth)) {
    throw new Error(`${sourceContract} 的到期月份不在品种候选月份内`);
  }
  const expiryYear = definition.exchange === 'CZCE'
    ? czceFullYear(expiry, referenceYear, definition)
    : fullYearFromTwoDigits(Number(expiry.slice(0, 2)), referenceYear);
  const internalProduct = definition.contractCode.productCase === 'upper'
    ? definition.productCode.toUpperCase()
    : definition.productCode.toLowerCase();
  const internalExpiry =
    `${String(expiryYear).slice(-2)}${String(expiryMonth).padStart(2, '0')}`;
  return {
    contract: `${internalProduct}${internalExpiry}`,
    expiryYear,
    expiryMonth,
  };
}

function normalizedTradingDates(values: readonly string[]): string[] {
  if (!values.length) throw new Error('交易日历不能为空');
  const unique = new Set<string>();
  for (const date of values) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`交易日历日期格式无效：${date}`);
    }
    parseBeijing(`${date} 00:00:00`);
    if (unique.has(date)) throw new Error(`交易日历日期重复：${date}`);
    unique.add(date);
  }
  return [...unique].sort();
}

function nextTradingDate(tradingDates: readonly string[], naturalDate: string): string {
  let left = 0;
  let right = tradingDates.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tradingDates[middle] <= naturalDate) left = middle + 1;
    else right = middle;
  }
  const date = tradingDates[left];
  if (!date) throw new Error(`${naturalDate} 夜盘之后缺少下一交易日`);
  return date;
}

function assertFiniteValues(record: ContractFiveMinuteImportRecord): void {
  const values = [
    record.open,
    record.high,
    record.low,
    record.close,
    record.volume,
    record.openInterest,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error('OHLC、成交量和持仓量必须为有限数值');
  }
  if (record.low > record.high
    || record.open < record.low
    || record.open > record.high
    || record.close < record.low
    || record.close > record.high) {
    throw new Error('OHLC 范围无效：开盘价和收盘价必须位于最低价与最高价之间');
  }
  if (record.volume < 0 || record.openInterest < 0) {
    throw new Error('成交量和持仓量不得为负数');
  }
}

function normalizeRecord(
  record: ContractFiveMinuteImportRecord,
  definition: InstrumentDefinition,
  tradingDates: readonly string[],
  tradingDateSet: ReadonlySet<string>,
): NormalizedContractFiveMinuteRecord {
  const location = `${record.provenance.relativePath} 第${record.provenance.line}行`;
  try {
    if (record.instrumentId !== definition.id) {
      throw new Error(`品种不一致：${record.instrumentId}`);
    }
    const exchange = normalizeExchangeCode(record.sourceExchange);
    if (exchange !== definition.exchange) {
      throw new Error(`交易所与品种不一致：${record.sourceExchange}`);
    }
    assertFiniteValues(record);
    const startMs = parseBeijing(record.timestamp);
    const start = formatBeijing(startMs);
    const referenceYear = Number(start.slice(0, 4));
    const contract = normalizeHistoricalContractCode(
      definition,
      record.sourceContract,
      referenceYear,
    );
    const minute = tradingMinuteAt(startMs, definition.tradingSessions);
    if (minute.index % 5 !== 0 || startMs % FIVE_MINUTE_MS !== 0) {
      throw new Error(`未对齐 5 分钟边界：${start}`);
    }
    const finalMinute = tradingMinuteAt(
      startMs + 4 * MINUTE_MS,
      definition.tradingSessions,
    );
    if (finalMinute.session !== minute.session
      || finalMinute.date !== minute.date
      || finalMinute.index !== minute.index + 4) {
      throw new Error(`5 分钟 K 线跨越休市边界：${start}`);
    }
    const tradingDate = minute.session === 'night'
      ? nextTradingDate(tradingDates, minute.date)
      : minute.date;
    if (minute.session === 'day' && !tradingDateSet.has(tradingDate)) {
      throw new Error(`日盘自然日不在交易日历中：${tradingDate}`);
    }
    const endMs = startMs + FIVE_MINUTE_MS;
    return {
      instrumentId: definition.id,
      exchange,
      contract: contract.contract,
      expiryYear: contract.expiryYear,
      expiryMonth: contract.expiryMonth,
      startMs,
      start,
      endMs,
      end: formatBeijing(endMs),
      tradingDate,
      session: minute.session,
      open: record.open,
      high: record.high,
      low: record.low,
      close: record.close,
      volume: record.volume,
      openInterest: record.openInterest,
      provenance: record.provenance,
    };
  } catch (error) {
    throw new Error(`${location}：${errorMessage(error)}`);
  }
}

function sameRecord(
  left: NormalizedContractFiveMinuteRecord,
  right: NormalizedContractFiveMinuteRecord,
): boolean {
  return left.instrumentId === right.instrumentId
    && left.exchange === right.exchange
    && left.contract === right.contract
    && left.expiryYear === right.expiryYear
    && left.expiryMonth === right.expiryMonth
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.tradingDate === right.tradingDate
    && left.session === right.session
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.openInterest === right.openInterest;
}

export function normalizeContractFiveMinuteRecords(
  records: readonly ContractFiveMinuteImportRecord[],
  instrument: ContractHistoryPageRequest['instrument'],
  tradingDateValues: readonly string[],
): NormalizationResult {
  if (!records.length) throw new Error('来源文件没有数据记录');
  const definition = instrumentDefinition(instrument);
  const tradingDates = normalizedTradingDates(tradingDateValues);
  const tradingDateSet = new Set(tradingDates);
  const sourceTimes = records.map(record => {
    try {
      return {
        timestamp: record.timestamp,
        timeMs: parseBeijing(record.timestamp),
      };
    } catch (error) {
      throw new Error(
        `${record.provenance.relativePath} 第${record.provenance.line}行：`
        + errorMessage(error),
      );
    }
  }).sort((left, right) => left.timeMs - right.timeMs);
  const normalized = records.map(record => normalizeRecord(
    record,
    definition,
    tradingDates,
    tradingDateSet,
  )).sort((left, right) => (
    left.startMs - right.startMs
    || left.provenance.line - right.provenance.line
  ));
  const deduplicated: NormalizedContractFiveMinuteRecord[] = [];
  let identicalDuplicatesRemoved = 0;
  for (const record of normalized) {
    const previous = deduplicated.at(-1);
    if (!previous || previous.startMs !== record.startMs) {
      deduplicated.push(record);
      continue;
    }
    if (!sameRecord(previous, record)) {
      throw new Error(
        `${record.provenance.relativePath} 在 ${record.start} 存在冲突记录`
        + `（第${previous.provenance.line}行与第${record.provenance.line}行）`,
      );
    }
    identicalDuplicatesRemoved += 1;
  }
  const contracts = new Set(deduplicated.map(record => record.contract));
  if (contracts.size !== 1) {
    throw new Error(`同一来源文件被推断为多个内部合约：${[...contracts].join('、')}`);
  }
  return {
    records: deduplicated,
    identicalDuplicatesRemoved,
    normalizedContract: deduplicated[0].contract,
    sourceCoverage: {
      firstTimestamp: sourceTimes[0].timestamp,
      lastTimestamp: sourceTimes.at(-1)!.timestamp,
    },
  };
}

function baseReport(
  source: ContractFiveMinuteHistorySource,
  request: Pick<ContractHistoryPageRequest, 'instrument' | 'contract'>,
  toolVersion: string,
): ContractHistoryImportReport {
  return {
    schemaVersion: 1,
    status: 'rejected',
    instrumentId: request.instrument,
    sourceContract: request.contract,
    source: source.description,
    rows: {
      source: 0,
      accepted: 0,
      identicalDuplicatesRemoved: 0,
    },
    toolVersion,
    rejectionReasons: [],
  };
}

function validateAuditMetadata(
  source: ContractFiveMinuteHistorySource,
  toolVersion: string,
): void {
  assertNonEmpty(source.description.sourceId, '来源 ID');
  assertNonEmpty(source.description.sourceName, '来源名称');
  if (!source.description.sourceVersion?.trim() && !source.description.acquiredAt?.trim()) {
    throw new Error('来源必须提供版本或取得时间');
  }
  assertNonEmpty(source.description.license.conclusion, '许可证/授权结论');
  assertNonEmpty(toolVersion, '导入工具版本');
}

function rejectedResult(
  report: ContractHistoryImportReport,
  error: unknown,
): ContractHistoryImportResult {
  const path = report.sourceFile?.relativePath;
  const message = errorMessage(error);
  return {
    ok: false,
    records: [],
    report: {
      ...report,
      status: 'rejected',
      rows: {
        ...report.rows,
        accepted: 0,
      },
      rejectionReasons: [
        path && !message.startsWith(path) ? `${path}：${message}` : message,
      ],
    },
  };
}

export async function importContractFiveMinuteFile(
  source: ContractFiveMinuteHistorySource,
  request: Pick<ContractHistoryPageRequest, 'instrument' | 'contract'>,
  options: ContractHistoryImportOptions,
): Promise<ContractHistoryImportResult> {
  const report = baseReport(source, request, options.toolVersion);
  try {
    const sourceFile = await source.inspectFile(request);
    assertSourceFileValid(sourceFile);
    report.sourceFile = sourceFile;
    report.rows.source = sourceFile.rows;
    if (sourceFile.firstTimestamp && sourceFile.lastTimestamp) {
      report.sourceCoverage = {
        firstTimestamp: sourceFile.firstTimestamp,
        lastTimestamp: sourceFile.lastTimestamp,
      };
    }
    validateAuditMetadata(source, options.toolVersion);

    const records: ContractFiveMinuteImportRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const cursorKey = cursor ?? '<first-page>';
      if (seenCursors.has(cursorKey)) throw new Error(`分页游标形成循环：${cursorKey}`);
      seenCursors.add(cursorKey);
      const page = await source.readPage({
        ...request,
        cursor,
        pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      });
      if (!sameSourceFile(sourceFile, page.sourceFile)) {
        throw new Error('分页读取期间来源文件元数据发生变化');
      }
      if (!page.records.length && page.nextCursor !== undefined) {
        throw new Error('空分页不得继续返回下一游标');
      }
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    if (records.length !== sourceFile.rows) {
      throw new Error(
        `来源文件行数与分页读取数量不一致：${sourceFile.rows} / ${records.length}`,
      );
    }
    const requestedContract = request.contract.trim().toUpperCase();
    const mismatchedContract = records.find(
      record => record.sourceContract.trim().toUpperCase() !== requestedContract,
    );
    if (mismatchedContract) {
      throw new Error(
        `${mismatchedContract.provenance.relativePath}`
        + ` 第${mismatchedContract.provenance.line}行：`
        + `来源合约 ${mismatchedContract.sourceContract} 与请求 ${request.contract} 不一致`,
      );
    }
    const normalized = normalizeContractFiveMinuteRecords(
      records,
      request.instrument,
      options.tradingDates,
    );
    const first = normalized.records[0];
    const last = normalized.records.at(-1)!;
    return {
      ok: true,
      records: normalized.records,
      report: {
        ...report,
        status: 'succeeded',
        normalizedContract: normalized.normalizedContract,
        sourceCoverage: normalized.sourceCoverage,
        normalizedCoverage: {
          firstTimestamp: first.start,
          lastTimestamp: last.start,
          firstTradingDate: first.tradingDate,
          lastTradingDate: last.tradingDate,
        },
        rows: {
          source: sourceFile.rows,
          accepted: normalized.records.length,
          identicalDuplicatesRemoved: normalized.identicalDuplicatesRemoved,
        },
        rejectionReasons: [],
      },
    };
  } catch (error) {
    return rejectedResult(report, error);
  }
}
