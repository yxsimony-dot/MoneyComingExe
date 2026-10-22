import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DesktopFuturesHistoryPageRequest,
  DesktopFuturesMinuteRecord,
} from '../domain/contract-history-import';
import { normalizeHistoricalContractCode } from '../domain/contract-history-normalization';
import {
  matchDesktopMainContractDays,
  type DesktopMainMatchMinuteRecord,
} from '../domain/desktop-main-contract-matching';
import { tradingMinuteAt } from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../shared/instruments';
import { DesktopFuturesHistoryAdapter } from './local-contract-history-adapter';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SOURCE_ROOT = join(
  process.env.USERPROFILE ?? homedir(),
  'Desktop',
  '期货数据',
  '期货分钟',
);
const DEFAULT_OUTPUT = resolve(
  'data',
  'desktop-main-contract-match-audit.json',
);
const DEFAULT_FIRST_TRADING_DATE = '2025-10-15';
const DEFAULT_LAST_TRADING_DATE = '2026-10-14';

interface Options {
  sourceRoot: string;
  output: string;
  firstTradingDate: string;
  lastTradingDate: string;
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    output: DEFAULT_OUTPUT,
    firstTradingDate: DEFAULT_FIRST_TRADING_DATE,
    lastTradingDate: DEFAULT_LAST_TRADING_DATE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} 缺少参数值`);
    if (argument === '--source-root') options.sourceRoot = value;
    else if (argument === '--output') options.output = value;
    else if (argument === '--first-trading-date') options.firstTradingDate = value;
    else if (argument === '--last-trading-date') options.lastTradingDate = value;
    else throw new Error(`未知参数：${argument}`);
    index += 1;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.firstTradingDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(options.lastTradingDate)
    || options.firstTradingDate > options.lastTradingDate) {
    throw new Error('审计交易日范围无效');
  }
  return {
    ...options,
    sourceRoot: resolve(options.sourceRoot),
    output: resolve(options.output),
  };
}

function firstTradingDateAfter(
  tradingDates: readonly string[],
  naturalDate: string,
): string {
  let left = 0;
  let right = tradingDates.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tradingDates[middle] <= naturalDate) left = middle + 1;
    else right = middle;
  }
  const tradingDate = tradingDates[left];
  if (!tradingDate) throw new Error(`${naturalDate} 夜盘之后缺少下一交易日`);
  return tradingDate;
}

function tradingDateForTimestamp(
  timestamp: string,
  definition: InstrumentDefinition,
  tradingDates: readonly string[],
): string {
  const minute = tradingMinuteAt(
    parseBeijing(timestamp),
    definition.tradingSessions,
  );
  return minute.session === 'night'
    ? firstTradingDateAfter(tradingDates, minute.date)
    : minute.date;
}

function normalizedMinute(
  record: DesktopFuturesMinuteRecord,
  definition: InstrumentDefinition,
  tradingDates: readonly string[],
  contract?: string,
): DesktopMainMatchMinuteRecord {
  const startMs = parseBeijing(record.timestamp);
  return {
    instrumentId: definition.id,
    tradingDate: tradingDateForTimestamp(record.timestamp, definition, tradingDates),
    contract,
    timestamp: formatBeijing(startMs),
    startMs,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    amount: record.amount,
    volume: record.volume,
    openInterest: record.openInterest,
  };
}

function subtractDays(date: string, days: number): string {
  return formatBeijing(parseBeijing(`${date} 12:00:00`) - days * DAY_MS).slice(0, 10);
}

function relevantContract(
  sourceContract: string,
  definition: InstrumentDefinition,
  firstTradingDate: string,
  lastTradingDate: string,
): boolean {
  const firstMonth = Number(firstTradingDate.slice(0, 4)) * 12
    + Number(firstTradingDate.slice(5, 7)) - 1;
  const lastMonth = Number(lastTradingDate.slice(0, 4)) * 12
    + Number(lastTradingDate.slice(5, 7)) - 1;
  const firstYear = Number(firstTradingDate.slice(0, 4));
  const lastYear = Number(lastTradingDate.slice(0, 4));
  for (let referenceYear = firstYear - 1; referenceYear <= lastYear; referenceYear += 1) {
    try {
      const normalized = normalizeHistoricalContractCode(
        definition,
        sourceContract,
        referenceYear,
      );
      const expiry = normalized.expiryYear * 12 + normalized.expiryMonth - 1;
      if (expiry >= firstMonth && expiry <= lastMonth + 12) return true;
    } catch {
      // A source code can be outside the inference window for this reference year.
    }
  }
  return false;
}

async function collectMainRows(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  options: Options,
): Promise<{
  rows: DesktopFuturesMinuteRecord[];
  tradingDates: string[];
}> {
  const firstNaturalDate = subtractDays(options.firstTradingDate, 7);
  const firstTimestamp = `${firstNaturalDate} 00:00:00`;
  const lastTimestamp = `${options.lastTradingDate} 23:59:59`;
  const rows: DesktopFuturesMinuteRecord[] = [];
  const tradingDates = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await adapter.readMainPage({
      instrument: definition.id,
      cursor,
      pageSize: 10_000,
    });
    for (const record of page.records) {
      if (record.timestamp < firstTimestamp || record.timestamp > lastTimestamp) continue;
      rows.push(record);
      const minute = tradingMinuteAt(
        parseBeijing(record.timestamp),
        definition.tradingSessions,
      );
      if (minute.session === 'day') tradingDates.add(minute.date);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return {
    rows,
    tradingDates: [...tradingDates].sort(),
  };
}

async function collectContractRows(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  tradingDates: readonly string[],
  options: Options,
): Promise<DesktopMainMatchMinuteRecord[]> {
  const firstTimestamp = `${subtractDays(options.firstTradingDate, 7)} 00:00:00`;
  const lastTimestamp = `${options.lastTradingDate} 23:59:59`;
  const available = await adapter.listContracts(definition.id);
  const contracts = available.filter(contract => relevantContract(
    contract,
    definition,
    options.firstTradingDate,
    options.lastTradingDate,
  ));
  const rows: DesktopMainMatchMinuteRecord[] = [];
  for (const sourceContract of contracts) {
    let cursor: string | undefined;
    do {
      const request: DesktopFuturesHistoryPageRequest & { contract: string } = {
        instrument: definition.id,
        contract: sourceContract,
        cursor,
        pageSize: 10_000,
      };
      const page = await adapter.readContractPage(request);
      for (const record of page.records) {
        if (record.timestamp < firstTimestamp || record.timestamp > lastTimestamp) continue;
        const referenceYear = Number(record.timestamp.slice(0, 4));
        const normalizedContract = normalizeHistoricalContractCode(
          definition,
          record.sourceSymbol,
          referenceYear,
        ).contract;
        let normalized: DesktopMainMatchMinuteRecord;
        try {
          normalized = normalizedMinute(
            record,
            definition,
            tradingDates,
            normalizedContract,
          );
        } catch (error) {
          if (record.timestamp.slice(0, 10) >= options.lastTradingDate) continue;
          throw error;
        }
        if (normalized.tradingDate >= options.firstTradingDate
          && normalized.tradingDate <= options.lastTradingDate) {
          rows.push(normalized);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return rows;
}

function mappingHash(mappings: readonly { tradingDate: string; contract: string }[]): string {
  return createHash('sha256').update(JSON.stringify(mappings)).digest('hex');
}

async function auditInstrument(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  options: Options,
) {
  const mainSource = await collectMainRows(adapter, definition, options);
  const mainRows = mainSource.rows.map(record => (
    normalizedMinute(record, definition, mainSource.tradingDates)
  )).filter(record => (
    record.tradingDate >= options.firstTradingDate
    && record.tradingDate <= options.lastTradingDate
  ));
  const contractRows = await collectContractRows(
    adapter,
    definition,
    mainSource.tradingDates,
    options,
  );
  const report = matchDesktopMainContractDays(mainRows, contractRows);
  const minimumParticipatingFields = report.days.length
    ? Math.min(...report.days.map(day => day.participatingFields.length))
    : 0;
  const rolloverCount = report.mappings.reduce((count, mapping, index) => (
    index > 0 && report.mappings[index - 1].contract !== mapping.contract
      ? count + 1
      : count
  ), 0);
  return {
    instrumentId: definition.id,
    name: definition.name,
    exchange: definition.exchange,
    productCode: definition.productCode,
    firstTradingDate: report.days[0]?.tradingDate ?? null,
    lastTradingDate: report.days.at(-1)?.tradingDate ?? null,
    tradingDays: report.summary.tradingDays,
    uniqueExactMatches: report.summary.uniqueExactMatches,
    zeroExactMatches: report.summary.zeroExactMatches,
    multipleExactMatches: report.summary.multipleExactMatches,
    uniqueExactMatchRate: report.summary.uniqueExactMatchRate,
    minimumConfidence: report.summary.minimumConfidence,
    minimumParticipatingFields,
    rolloverCount,
    mappingSha256: mappingHash(report.mappings),
    passed: !report.blocked
      && report.summary.uniqueExactMatchRate === 1
      && report.summary.minimumConfidence === 1,
  };
}

export async function runDesktopMainContractAudit(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseArguments(argv);
  const adapter = new DesktopFuturesHistoryAdapter(options.sourceRoot, {
    sourceVersion: 'desktop-archive-2026-10-19',
  });
  const instruments = [];
  for (const definition of INSTRUMENT_LIST) {
    const result = await auditInstrument(adapter, definition, options);
    instruments.push(result);
    console.log(
      `${definition.name}: ${result.uniqueExactMatches}/${result.tradingDays}, `
      + `最低置信度 ${(result.minimumConfidence * 100).toFixed(0)}%`,
    );
  }
  const passed = instruments.every(instrument => instrument.passed);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    auditWindow: {
      firstTradingDate: options.firstTradingDate,
      lastTradingDate: options.lastTradingDate,
    },
    source: {
      sourceId: adapter.description.sourceId,
      sourceName: adapter.description.sourceName,
      sourceVersion: adapter.description.sourceVersion,
      redistributionAllowed: adapter.description.license.redistributionAllowed,
      licenseConclusion: adapter.description.license.conclusion,
    },
    privacy: {
      containsMinutePrices: false,
      containsDailyMappings: false,
      mappingHashesOnly: true,
    },
    summary: {
      instruments: instruments.length,
      passedInstruments: instruments.filter(instrument => instrument.passed).length,
      tradingDays: instruments.reduce((sum, instrument) => sum + instrument.tradingDays, 0),
      uniqueExactMatches: instruments.reduce(
        (sum, instrument) => sum + instrument.uniqueExactMatches,
        0,
      ),
      minimumUniqueExactMatchRate: Math.min(
        ...instruments.map(instrument => instrument.uniqueExactMatchRate),
      ),
      minimumConfidence: Math.min(
        ...instruments.map(instrument => instrument.minimumConfidence),
      ),
      passed,
    },
    instruments,
    releaseEligibility: {
      allowed: false,
      reasons: [
        '桌面来源尚未提供允许写入 Git、EXE 或安装包的再分发授权。',
      ],
    },
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (!passed) {
    throw new Error(
      `桌面主连精确匹配审计未通过：`
      + `${report.summary.passedInstruments}/${report.summary.instruments} 个品种`,
    );
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runDesktopMainContractAudit();
}
