import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DesktopFuturesHistoryFile,
  DesktopFuturesMinuteRecord,
} from '../domain/contract-history-import';
import {
  detectContractRollovers,
  parseMainContractMappings,
  serializeContractRollovers,
  serializeMainContractMappings,
} from '../domain/contract-rollover';
import { normalizeHistoricalContractCode } from '../domain/contract-history-normalization';
import {
  compareDesktopMainContractCandidate,
  resolveDesktopMainContractAudits,
  type DesktopMainContractCandidateAudit,
  type DesktopMainContractExactMatchReport,
  type DesktopMainMatchMinuteRecord,
} from '../domain/desktop-main-contract-matching';
import {
  calibrateHistoricalMainContracts,
  DEFAULT_HISTORICAL_MAIN_CALIBRATION_THRESHOLDS,
  determineHistoricalMainContracts,
  type HistoricalContractDailySummary,
  type HistoricalMainCalibrationReport,
} from '../domain/historical-main-contract';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  assertContinuousBarCoverage,
  assertMinuteRecordsValid,
  assertSegmentedSixtyMinuteBarsValid,
  parseEdbMinuteCsv,
  serializeBars,
  tradingMinuteAt,
} from '../domain/market-data';
import {
  rollingMarketWindow,
  trimToRollingMarketWindow,
} from '../domain/rolling-market-window';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type Instrument,
  type InstrumentDefinition,
  type TradingSchedule,
} from '../shared/instruments';
import type {
  Bar,
  EdbDailyRecord,
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotRawSourceFile,
  MarketSnapshotSourceSegment,
} from '../shared/types';
import { DesktopFuturesHistoryAdapter } from './local-contract-history-adapter';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60_000;
const DEFAULT_SOURCE_ROOT = join(
  process.env.USERPROFILE ?? homedir(),
  'Desktop',
  '期货数据',
  '期货分钟',
);
const DEFAULT_OUTPUT_ROOT = 'D:\\MoneyComing-temp\\desktop-candidates';
const DEFAULT_BASELINE_ROOT = resolve('data', 'instruments');
const IMPORTER_VERSION = 'desktop-temporary-candidate-v1';
const EXPECTED_DESKTOP_LAST = '2026-10-14 14:59:00';
const EXPECTED_EDB_FIRST_TAIL = '2026-10-14 21:00:00';
const EXPECTED_EDB_LAST = '2026-10-16 22:59:00';
const EXPECTED_EDB_TAIL_ROWS = 810;
const AUTHORIZATION_CONCLUSION = {
  allCandidateMarketDataRedistributionRightsConfirmed: false,
  baselineReplacementAllowed: false,
  releaseEligible: false,
  existingBaselineChanged: false,
} as const;

interface Options {
  sourceRoot: string;
  outputRoot: string;
  baselineRoot: string;
  repositoryRoot: string;
}

interface CandidateFileDeclaration {
  name: string;
  sha256: string;
  rows: number;
}

interface DesktopMainCollection {
  records: DesktopMainMatchMinuteRecord[];
  byTradingDate: Map<string, DesktopMainMatchMinuteRecord[]>;
  sourceFile: DesktopFuturesHistoryFile;
}

interface ExactMatchCollection {
  mappings: MainContractMapping[];
  sourceFiles: DesktopFuturesHistoryFile[];
  matchReport: DesktopMainContractExactMatchReport;
  calibration: HistoricalMainCalibrationReport;
  calibrationReferenceDates: string[];
  summary: {
    tradingDays: number;
    matchedDays: number;
    uniqueExactMatches: number;
    sourceVarianceFallbackMatches: number;
    rolloverBoundarySourceVarianceMatches: number;
    heuristicFallbackMatches: number;
    zeroExactMatches: number;
    multipleExactMatches: number;
    uniqueExactMatchRate: number;
    minimumConfidence: number;
    candidateComparisons: number;
    scannedContracts: number;
  };
}

interface CutoverExpectation {
  desktopLast: string;
  firstTail: string;
  lastTail: string;
  tailRows: number;
}

interface CutoverValidation {
  desktopLast: string;
  firstTail: string;
  lastTail: string;
  tailRows: number;
  normalSessionBreak: boolean;
}

export interface SparseDesktopFiveMinuteAggregation {
  bars: Bar[];
  sourceMinuteRows: number;
  fiveMinuteBars: number;
  sparseFiveMinuteBars: number;
  omittedMinutesWithinEmittedBars: number;
  maximumOmittedMinutesPerBar: number;
  syntheticOneMinuteRows: 0;
}

interface DerivedTailMapping {
  sourceMappingDate: string;
  nightNaturalDate: string;
  normalizedTradingDate: string;
  contract: string;
  reason: string;
}

interface EdbTailMappingNormalization {
  mappings: MainContractMapping[];
  latestRepresentedTradingDate: string;
  sourceLastMappingDate: string;
  derivedMappings: DerivedTailMapping[];
}

interface CandidateResult {
  instrumentId: Instrument;
  name: string;
  first5: string;
  last5: string;
  first60: string;
  last60: string;
  rows5: number;
  rows60: number;
  mappings: number;
  rollovers: number;
  repeatedFirst5Stable: boolean | null;
  technicalValidationPassed: true;
}

function isPathInside(path: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(path));
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation)
  );
}

export function assertCandidateOutputPath(
  outputRoot: string,
  repositoryRoot: string,
  baselineRoot: string,
): void {
  const output = resolve(outputRoot);
  if (basename(output).toLowerCase() === 'undefined') {
    throw new Error('候选输出目录不得命名为 undefined');
  }
  if (isPathInside(output, repositoryRoot)) {
    throw new Error('桌面行情候选只能写入项目仓库之外的临时目录');
  }
  if (isPathInside(output, baselineRoot) || isPathInside(baselineRoot, output)) {
    throw new Error('桌面行情候选不得覆盖或包围正式 data/instruments 基线');
  }
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    baselineRoot: DEFAULT_BASELINE_ROOT,
    repositoryRoot: resolve('.'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} 缺少参数值`);
    if (argument === '--source-root') options.sourceRoot = value;
    else if (argument === '--output') options.outputRoot = value;
    else if (argument === '--baseline-root') options.baselineRoot = value;
    else throw new Error(`未知参数：${argument}`);
    index += 1;
  }
  const resolved = {
    ...options,
    sourceRoot: resolve(options.sourceRoot),
    outputRoot: resolve(options.outputRoot),
    baselineRoot: resolve(options.baselineRoot),
    repositoryRoot: resolve(options.repositoryRoot),
  };
  assertCandidateOutputPath(
    resolved.outputRoot,
    resolved.repositoryRoot,
    resolved.baselineRoot,
  );
  return resolved;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const key = relative(root, path).split(sep).join('/');
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\0${key}\0`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(await readFile(path));
      else throw new Error(`正式基线包含不支持的文件类型：${path}`);
    }
  };
  await visit(resolve(root));
  return hash.digest('hex');
}

function fileDeclaration(
  name: string,
  text: string,
  rows: number,
): CandidateFileDeclaration {
  return { name, sha256: sha256(text), rows };
}

function sourceRawFile(
  file: DesktopFuturesHistoryFile,
): MarketSnapshotRawSourceFile {
  return {
    name: file.relativePath,
    sha256: file.sha256,
    rows: file.rows,
  };
}

function baseMatchRecord(
  record: DesktopFuturesMinuteRecord,
  definition: InstrumentDefinition,
  tradingDate: string,
  contract?: string,
): DesktopMainMatchMinuteRecord {
  const startMs = parseBeijing(record.timestamp);
  return {
    instrumentId: definition.id,
    tradingDate,
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

function recordNaturalSession(
  record: DesktopFuturesMinuteRecord,
  definition: InstrumentDefinition,
) {
  return tradingMinuteAt(parseBeijing(record.timestamp), definition.tradingSessions);
}

function sumRequiredField(
  rows: readonly DesktopMainMatchMinuteRecord[],
  field: 'volume' | 'openInterest',
): number {
  let total = 0;
  for (const row of rows) {
    const value = row[field];
    if (value === null) {
      throw new Error(`${row.tradingDate} ${row.contract ?? '主连'} 缺少 ${field}`);
    }
    total += value;
  }
  return total;
}

function summarizeContractDay(
  definition: InstrumentDefinition,
  tradingDate: string,
  contract: {
    contract: string;
    expiryYear: number;
    expiryMonth: number;
  },
  rows: readonly DesktopMainMatchMinuteRecord[],
): HistoricalContractDailySummary | undefined {
  const first = rows[0];
  const last = rows.at(-1)!;
  if (!first || rows.some(row => row.contract !== contract.contract)) {
    throw new Error(`${definition.name} ${tradingDate} 合约日汇总记录不一致`);
  }
  if (last.openInterest === null || rows.some(row => row.volume === null)) {
    return undefined;
  }
  return {
    instrumentId: definition.id,
    exchange: definition.exchange,
    tradingDate,
    contract: contract.contract,
    expiryYear: contract.expiryYear,
    expiryMonth: contract.expiryMonth,
    firstStartMs: first.startMs,
    lastStartMs: last.startMs,
    open: first.open,
    high: Math.max(...rows.map(row => row.high)),
    low: Math.min(...rows.map(row => row.low)),
    close: last.close,
    totalVolume: sumRequiredField(rows, 'volume'),
    endOpenInterest: last.openInterest,
    barCount: rows.length,
  };
}

function summarizeDesktopMainDay(
  tradingDate: string,
  rows: readonly DesktopMainMatchMinuteRecord[],
): EdbDailyRecord {
  const first = rows[0];
  const last = rows.at(-1)!;
  if (!first || first.openInterest === null || last.openInterest === null) {
    throw new Error(`${tradingDate} 桌面主连缺少日线校准证据`);
  }
  return {
    datetimeNano: (BigInt(first.startMs) * 1_000_000n).toString(),
    tradingDate,
    open: first.open,
    high: Math.max(...rows.map(row => row.high)),
    low: Math.min(...rows.map(row => row.low)),
    close: last.close,
    volume: sumRequiredField(rows, 'volume'),
    openOi: first.openInterest,
    closeOi: last.openInterest,
  };
}

async function collectDesktopMain(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  collectionStartMs: number,
): Promise<DesktopMainCollection> {
  const records: DesktopMainMatchMinuteRecord[] = [];
  let pendingNight: DesktopFuturesMinuteRecord[] = [];
  const sourceFile = await adapter.scanMainRecords(definition.id, record => {
    const startMs = parseBeijing(record.timestamp);
    if (startMs < collectionStartMs) return;
    const minute = recordNaturalSession(record, definition);
    if (minute.session === 'night') {
      pendingNight.push(record);
      return;
    }
    if (pendingNight.length) {
      for (const pending of pendingNight) {
        records.push(baseMatchRecord(pending, definition, minute.date));
      }
      pendingNight = [];
    }
    records.push(baseMatchRecord(record, definition, minute.date));
  });
  if (!records.length) throw new Error(`${definition.name} 五年窗口内没有桌面主连分钟`);
  if (pendingNight.length) {
    throw new Error(`${definition.name} 桌面主连尾部夜盘缺少后续日盘交易日`);
  }
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].startMs <= records[index - 1].startMs) {
      throw new Error(`${definition.name} 桌面主连分钟时间戳重复或倒序`);
    }
  }
  const byTradingDate = new Map<string, DesktopMainMatchMinuteRecord[]>();
  for (const record of records) {
    const daily = byTradingDate.get(record.tradingDate) ?? [];
    daily.push(record);
    byTradingDate.set(record.tradingDate, daily);
  }
  return { records, byTradingDate, sourceFile };
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
  for (
    let referenceYear = firstYear - 1;
    referenceYear <= lastYear;
    referenceYear += 1
  ) {
    try {
      const normalized = normalizeHistoricalContractCode(
        definition,
        sourceContract,
        referenceYear,
      );
      const expiry = normalized.expiryYear * 12 + normalized.expiryMonth - 1;
      if (expiry >= firstMonth && expiry <= lastMonth + 12) return true;
    } catch {
      // The same source code can be outside a particular inference year.
    }
  }
  return false;
}

function localCalibrationReferences(
  tradingDates: readonly string[],
  exactMappings: readonly MainContractMapping[],
  fallbackDates: readonly string[],
): MainContractMapping[] {
  const tradingDateIndex = new Map(
    tradingDates.map((tradingDate, index) => [tradingDate, index]),
  );
  const desired = DEFAULT_HISTORICAL_MAIN_CALIBRATION_THRESHOLDS.minOverlapDays;
  const selectedDates = new Set<string>();
  const anchors = fallbackDates.length
    ? fallbackDates
    : [tradingDates.at(-1)!];
  for (const fallbackDate of anchors) {
    const fallbackIndex = tradingDateIndex.get(fallbackDate);
    if (fallbackIndex === undefined) continue;
    const nearest = [...exactMappings].sort((left, right) => {
      const leftIndex = tradingDateIndex.get(left.tradingDate) ?? 0;
      const rightIndex = tradingDateIndex.get(right.tradingDate) ?? 0;
      return Math.abs(leftIndex - fallbackIndex) - Math.abs(rightIndex - fallbackIndex)
        || leftIndex - rightIndex;
    });
    for (const mapping of nearest.slice(0, desired)) {
      selectedDates.add(mapping.tradingDate);
    }
  }
  return exactMappings.filter(mapping => selectedDates.has(mapping.tradingDate));
}

async function collectExactMappings(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  main: DesktopMainCollection,
): Promise<ExactMatchCollection> {
  const tradingDates = [...main.byTradingDate.keys()].sort();
  const firstTradingDate = tradingDates[0];
  const lastTradingDate = tradingDates.at(-1)!;
  const desktopLastMs = main.records.at(-1)!.startMs;
  const candidateComparisons = new Map<string, DesktopMainContractCandidateAudit[]>();
  const dailySummaries: HistoricalContractDailySummary[] = [];
  const availableContracts = await adapter.listContracts(definition.id);
  const contracts = availableContracts.filter(contract => relevantContract(
    contract,
    definition,
    firstTradingDate,
    lastTradingDate,
  ));
  const sourceFiles: DesktopFuturesHistoryFile[] = [];

  for (const sourceContract of contracts) {
    let currentTradingDate: string | undefined;
    let currentRows: DesktopMainMatchMinuteRecord[] = [];
    let pendingNight: DesktopFuturesMinuteRecord[] = [];
    let normalizedContract: ReturnType<typeof normalizeHistoricalContractCode>
      | undefined;
    const normalizeContract = (
      record: DesktopFuturesMinuteRecord,
    ): ReturnType<typeof normalizeHistoricalContractCode> => {
      const normalized = normalizeHistoricalContractCode(
        definition,
        record.sourceSymbol,
        Number(record.timestamp.slice(0, 4)),
      );
      if (normalizedContract && normalizedContract.contract !== normalized.contract) {
        throw new Error(
          `${definition.name} 来源合约 ${sourceContract} 跨记录规范为多个合约代码`,
        );
      }
      normalizedContract = normalized;
      return normalized;
    };
    const flush = (): void => {
      if (!currentTradingDate || !currentRows.length || !normalizedContract) return;
      const mainRows = main.byTradingDate.get(currentTradingDate);
      if (mainRows) {
        const audit = compareDesktopMainContractCandidate(
          mainRows,
          normalizedContract.contract,
          currentRows,
        );
        const audits = candidateComparisons.get(currentTradingDate) ?? [];
        audits.push(audit);
        candidateComparisons.set(currentTradingDate, audits);
        const summary = summarizeContractDay(
          definition,
          currentTradingDate,
          normalizedContract,
          currentRows,
        );
        if (summary) dailySummaries.push(summary);
      }
      currentRows = [];
    };
    const sourceFile = await adapter.scanContractRecords(
      { instrument: definition.id, contract: sourceContract },
      record => {
        const startMs = parseBeijing(record.timestamp);
        if (startMs < main.records[0].startMs || startMs > desktopLastMs) return;
        const minute = recordNaturalSession(record, definition);
        if (minute.session === 'night') {
          pendingNight.push(record);
          return;
        }
        if (currentTradingDate !== minute.date) {
          flush();
          currentTradingDate = minute.date;
          currentRows = pendingNight.map(pending => baseMatchRecord(
            pending,
            definition,
            minute.date,
            normalizeContract(pending).contract,
          ));
          pendingNight = [];
        } else if (pendingNight.length) {
          throw new Error(
            `${definition.name} ${sourceContract} 夜盘记录出现在同交易日日盘之后`,
          );
        }
        currentRows.push(baseMatchRecord(
          record,
          definition,
          minute.date,
          normalizeContract(record).contract,
        ));
      },
    );
    flush();
    sourceFiles.push(sourceFile);
  }

  const auditInputs = tradingDates.map(tradingDate => ({
    tradingDate,
    candidates: candidateComparisons.get(tradingDate) ?? [],
  }));
  const exactReferenceMappings = auditInputs.flatMap(({ tradingDate, candidates }) => {
    const exact = candidates.filter(candidate => candidate.exact);
    return exact.length === 1
      ? [{ tradingDate, contract: exact[0].contract }]
      : [];
  });
  const fallbackDates = auditInputs
    .filter(({ candidates }) => !candidates.some(candidate => candidate.exact))
    .map(({ tradingDate }) => tradingDate);
  const calibrationReferences = localCalibrationReferences(
    tradingDates,
    exactReferenceMappings,
    fallbackDates,
  );
  const selection = determineHistoricalMainContracts(dailySummaries);
  const selectionByDate = new Map(
    selection.mappings.map(mapping => [mapping.tradingDate, mapping]),
  );
  const calibrationCandidates = calibrationReferences.flatMap(mapping => {
    const selected = selectionByDate.get(mapping.tradingDate);
    return selected ? [selected] : [];
  });
  const referenceMainDaily = calibrationReferences.map(mapping => (
    summarizeDesktopMainDay(
      mapping.tradingDate,
      main.byTradingDate.get(mapping.tradingDate) ?? [],
    )
  ));
  const calibration = calibrateHistoricalMainContracts(
    definition.id,
    dailySummaries,
    calibrationCandidates,
    calibrationReferences,
    referenceMainDaily,
  );
  const matchReport = resolveDesktopMainContractAudits(
    definition.id,
    auditInputs,
    { selection, calibration },
  );
  if (matchReport.blocked) {
    const affected = matchReport.days
      .filter(day => day.status === 'ambiguous')
      .slice(0, 10)
      .map(day => ({
        tradingDate: day.tradingDate,
        mainRows: main.byTradingDate.get(day.tradingDate)?.length ?? 0,
        candidates: day.candidates.map(candidate => ({
          contract: candidate.contract,
          mainRows: candidate.mainRows,
          rows: candidate.rows,
          mismatchFields: candidate.mismatchFields,
          mismatchRows: candidate.mismatchRows,
          timestampMismatchRows: candidate.timestampMismatchRows,
          ohlcMismatchRows: candidate.ohlcMismatchRows,
          optionalMismatchRows: candidate.optionalMismatchRows,
          fullFieldMatchRate: candidate.fullFieldMatchRate,
          tradeStatisticsDifferences: candidate.tradeStatisticsDifferences,
          mismatchSamples: candidate.mismatchSamples,
          firstMismatchTimestamp: candidate.firstMismatchTimestamp,
        })),
        sourceVariance: day.sourceVariance,
        rolloverBoundarySourceVariance: day.rolloverBoundarySourceVariance,
        ambiguityReasons: day.ambiguityReasons,
      }));
    throw new Error(
      `${definition.name} 全窗口主力映射存在未确认交易日：`
      + `${matchReport.affectedDates.length} 日；详情 ${JSON.stringify(affected)}`,
    );
  }
  return {
    mappings: matchReport.mappings,
    sourceFiles,
    matchReport,
    calibration,
    calibrationReferenceDates: calibrationReferences.map(
      mapping => mapping.tradingDate,
    ),
    summary: {
      ...matchReport.summary,
      candidateComparisons: [...candidateComparisons.values()]
        .reduce((sum, audits) => sum + audits.length, 0),
      scannedContracts: contracts.length,
    },
  };
}

function toEdbMinute(record: DesktopMainMatchMinuteRecord): EdbMinuteRecord {
  if (record.volume === null || record.openInterest === null) {
    throw new Error(`${record.timestamp} 桌面主连缺少成交量或持仓量`);
  }
  return {
    datetimeNano: (BigInt(record.startMs) * 1_000_000n).toString(),
    startMs: record.startMs,
    start: record.timestamp,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    volume: record.volume,
    openOi: record.openInterest,
    closeOi: record.openInterest,
  };
}

export function aggregateSparseDesktopFiveMinuteBars(
  records: readonly EdbMinuteRecord[],
  coverageEndMs: number,
  schedule: TradingSchedule,
): SparseDesktopFiveMinuteAggregation {
  assertMinuteRecordsValid(records, schedule);
  const strictBars = aggregateMinutes([...records], 5, coverageEndMs, schedule);
  let sparseFiveMinuteBars = 0;
  let omittedMinutesWithinEmittedBars = 0;
  let maximumOmittedMinutesPerBar = 0;
  const bars = strictBars.map((bar) => {
    const omittedMinutes = bar.expectedMinutes - bar.observedMinutes;
    if (omittedMinutes < 0) {
      throw new Error(`桌面 5 分钟桶的分钟记录超过交易日历：${bar.start}`);
    }
    if (omittedMinutes === 0) return bar;
    sparseFiveMinuteBars += 1;
    omittedMinutesWithinEmittedBars += omittedMinutes;
    maximumOmittedMinutesPerBar = Math.max(
      maximumOmittedMinutesPerBar,
      omittedMinutes,
    );
    return {
      ...bar,
      observedMinutes: bar.expectedMinutes,
      complete: true,
    };
  });
  return {
    bars,
    sourceMinuteRows: records.length,
    fiveMinuteBars: bars.length,
    sparseFiveMinuteBars,
    omittedMinutesWithinEmittedBars,
    maximumOmittedMinutesPerBar,
    syntheticOneMinuteRows: 0,
  };
}

export function validateEdbTailCutover(
  desktopLastMs: number,
  edbTail: readonly EdbMinuteRecord[],
  expectation: CutoverExpectation = {
    desktopLast: EXPECTED_DESKTOP_LAST,
    firstTail: EXPECTED_EDB_FIRST_TAIL,
    lastTail: EXPECTED_EDB_LAST,
    tailRows: EXPECTED_EDB_TAIL_ROWS,
  },
): CutoverValidation {
  if (!edbTail.length) throw new Error('EDB 没有严格晚于桌面尾部的分钟记录');
  const desktopLast = formatBeijing(desktopLastMs);
  const firstTail = edbTail[0].start;
  const lastTail = edbTail.at(-1)!.start;
  if (desktopLast !== expectation.desktopLast) {
    throw new Error(`桌面主连实际尾部异常：${desktopLast}`);
  }
  if (firstTail !== expectation.firstTail) {
    throw new Error(`EDB 接续首分钟异常：${firstTail}`);
  }
  if (lastTail !== expectation.lastTail) {
    throw new Error(`EDB 接续尾分钟异常：${lastTail}`);
  }
  if (edbTail.length !== expectation.tailRows) {
    throw new Error(`EDB 新增尾部应为 ${expectation.tailRows} 条，实际 ${edbTail.length} 条`);
  }
  const desktopMinute = tradingMinuteAt(desktopLastMs);
  const tailMinute = tradingMinuteAt(edbTail[0].startMs);
  const normalSessionBreak = desktopMinute.session === 'day'
    && desktopMinute.index === desktopMinute.total - 1
    && tailMinute.session === 'night'
    && tailMinute.index === 0
    && desktopMinute.date === tailMinute.date;
  if (!normalSessionBreak) {
    throw new Error(`${desktopLast} -> ${firstTail} 不是正常日盘至夜盘休市边界`);
  }
  return {
    desktopLast,
    firstTail,
    lastTail,
    tailRows: edbTail.length,
    normalSessionBreak,
  };
}

function firstMappingAfterDate(
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

function lastMappingAtOrBeforeDate(
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
  return mappings[left - 1];
}

function nextWeekdayDate(naturalDate: string): string {
  let value = Date.parse(`${naturalDate}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new Error(`EDB 尾部自然日无效：${naturalDate}`);
  do {
    value += DAY_MS;
  } while ([0, 6].includes(new Date(value).getUTCDay()));
  return new Date(value).toISOString().slice(0, 10);
}

export function normalizeEdbTailMappings(
  definition: InstrumentDefinition,
  edbMappings: readonly MainContractMapping[],
  edbTail: readonly EdbMinuteRecord[],
): EdbTailMappingNormalization {
  if (!edbMappings.length) throw new Error(`${definition.name} EDB 主力映射为空`);
  if (!edbTail.length) throw new Error(`${definition.name} EDB 尾部分钟为空`);

  const mappings = [...edbMappings];
  const derivedMappings: DerivedTailMapping[] = [];
  const nightNaturalDates = [...new Set(edbTail.flatMap(record => {
    const minute = tradingMinuteAt(record.startMs, definition.tradingSessions);
    return minute.session === 'night' ? [minute.date] : [];
  }))].sort();

  for (const nightNaturalDate of nightNaturalDates) {
    if (firstMappingAfterDate(mappings, nightNaturalDate)) continue;
    const sourceMapping = lastMappingAtOrBeforeDate(mappings, nightNaturalDate);
    if (!sourceMapping) {
      throw new Error(
        `${definition.name} ${nightNaturalDate} 尾部夜盘缺少可沿用的 EDB 主力映射`,
      );
    }
    const normalizedTradingDate = nextWeekdayDate(nightNaturalDate);
    const derivedMapping = {
      tradingDate: normalizedTradingDate,
      contract: sourceMapping.contract,
    };
    mappings.push(derivedMapping);
    mappings.sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
    derivedMappings.push({
      sourceMappingDate: sourceMapping.tradingDate,
      nightNaturalDate,
      normalizedTradingDate,
      contract: sourceMapping.contract,
      reason: 'EDB 源映射采用自然日/已完成日线口径，尾部夜盘按项目交易日口径归入下一工作日',
    });
  }

  const mappingDates = new Set(mappings.map(mapping => mapping.tradingDate));
  const representedTradingDates = edbTail.map(record => {
    const minute = tradingMinuteAt(record.startMs, definition.tradingSessions);
    if (minute.session === 'day') {
      if (!mappingDates.has(minute.date)) {
        throw new Error(`${definition.name} ${record.start} 日盘缺少 EDB 主力映射`);
      }
      return minute.date;
    }
    const mapping = firstMappingAfterDate(mappings, minute.date);
    if (!mapping) {
      throw new Error(`${definition.name} ${record.start} 夜盘之后缺少 EDB 主力交易日`);
    }
    return mapping.tradingDate;
  });

  return {
    mappings,
    latestRepresentedTradingDate: representedTradingDates.sort().at(-1)!,
    sourceLastMappingDate: edbMappings.at(-1)!.tradingDate,
    derivedMappings,
  };
}

function sameBar(left: Bar, right: Bar): boolean {
  return left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.openOi === right.openOi
    && left.closeOi === right.closeOi
    && left.session === right.session
    && left.observedMinutes === right.observedMinutes
    && left.expectedMinutes === right.expectedMinutes
    && left.complete === right.complete;
}

function assertBarsReconcile(
  definition: InstrumentDefinition,
  bars5: readonly Bar[],
  bars60: readonly Bar[],
): void {
  const rebuilt = aggregateFiveMinuteBars(bars5, definition.tradingSessions);
  if (rebuilt.length !== bars60.length
    || rebuilt.some((bar, index) => !sameBar(bar, bars60[index]))) {
    throw new Error(`${definition.name} 5/60 分钟全量重新聚合对账不一致`);
  }
}

function overlapDifferenceReport(
  desktopRecords: readonly DesktopMainMatchMinuteRecord[],
  edbRecords: readonly EdbMinuteRecord[],
  desktopLastMs: number,
) {
  const desktop = new Map(desktopRecords.map(record => [record.startMs, record]));
  const fields = {
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    openInterest: 0,
  };
  let overlapRows = 0;
  for (const edb of edbRecords) {
    if (edb.startMs > desktopLastMs) break;
    const local = desktop.get(edb.startMs);
    if (!local) continue;
    overlapRows += 1;
    if (local.open !== edb.open) fields.open += 1;
    if (local.high !== edb.high) fields.high += 1;
    if (local.low !== edb.low) fields.low += 1;
    if (local.close !== edb.close) fields.close += 1;
    if (local.volume !== edb.volume) fields.volume += 1;
    if (local.openInterest !== edb.closeOi) fields.openInterest += 1;
  }
  if (!overlapRows) throw new Error('桌面主连与 EDB 没有可审计的重叠分钟');
  return {
    overlapRows,
    fieldDifferences: fields,
    authority: 'desktop-main',
    edbOverlapNeverOverwritesDesktop: true,
  };
}

function mappingOverlapReport(
  definition: InstrumentDefinition,
  desktopMappings: readonly MainContractMapping[],
  edbMappings: readonly MainContractMapping[],
  desktopLastTradingDate: string,
): {
  overlapDays: number;
  matchingDays: number;
  differences: Array<{
    tradingDate: string;
    desktopContract: string;
    edbContract: string;
  }>;
  authority: 'desktop-main';
  edbOverlapNeverOverridesDesktop: true;
} {
  const desktop = new Map(
    desktopMappings.map(mapping => [mapping.tradingDate, mapping.contract]),
  );
  let overlapDays = 0;
  let matchingDays = 0;
  const differences: Array<{
    tradingDate: string;
    desktopContract: string;
    edbContract: string;
  }> = [];
  for (const mapping of edbMappings) {
    if (mapping.tradingDate > desktopLastTradingDate) continue;
    const desktopContract = desktop.get(mapping.tradingDate);
    if (!desktopContract) continue;
    overlapDays += 1;
    if (desktopContract === mapping.contract) matchingDays += 1;
    else differences.push({
      tradingDate: mapping.tradingDate,
      desktopContract,
      edbContract: mapping.contract,
    });
  }
  if (!overlapDays) {
    throw new Error(`${definition.name} 桌面主力映射与 EDB 没有重叠交易日`);
  }
  return {
    overlapDays,
    matchingDays,
    differences,
    authority: 'desktop-main',
    edbOverlapNeverOverridesDesktop: true,
  };
}

export function candidatePeriodMetadata(bars: readonly Bar[]) {
  if (!bars.length) throw new Error('周期行情不能为空');
  return {
    first: bars[0].start,
    last: bars.at(-1)!.end,
    rows: bars.length,
  };
}

export function candidateSourceLatestAt(
  ...series: ReadonlyArray<readonly Bar[]>
): string {
  const latestEndMs = Math.max(
    ...series.map(bars => {
      if (!bars.length) throw new Error('周期行情不能为空');
      return bars.at(-1)!.endMs;
    }),
  );
  return formatBeijing(latestEndMs);
}

function snapshotId(files: readonly CandidateFileDeclaration[]): string {
  return sha256(files.map(file => (
    `${file.name}:${file.sha256}:${file.rows}`
  )).join('\n')).slice(0, 24);
}

async function readPreviousFirstStarts(
  outputRoot: string,
): Promise<Map<Instrument, string>> {
  const starts = new Map<Instrument, string>();
  for (const definition of INSTRUMENT_LIST) {
    const path = join(
      outputRoot,
      definition.id,
      'edb_main_continuous_5m.csv',
    );
    if (!await exists(path)) continue;
    const text = await readFile(path, 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[1]) starts.set(definition.id, lines[1].split(',')[0]);
  }
  return starts;
}

async function writeInstrumentCandidate(
  directory: string,
  files: {
    bars5Text: string;
    bars60Text: string;
    mappingsText: string;
    rolloversText: string;
    metadata: unknown;
    technicalReport: unknown;
  },
): Promise<void> {
  await mkdir(directory, { recursive: false });
  await Promise.all([
    writeFile(
      join(directory, 'edb_main_continuous_5m.csv'),
      files.bars5Text,
      'utf8',
    ),
    writeFile(
      join(directory, 'edb_main_continuous_60m.csv'),
      files.bars60Text,
      'utf8',
    ),
    writeFile(
      join(directory, 'edb_main_contract_mapping.csv'),
      files.mappingsText,
      'utf8',
    ),
    writeFile(
      join(directory, 'edb_main_continuous_rollovers.csv'),
      files.rolloversText,
      'utf8',
    ),
    writeFile(
      join(directory, 'metadata.json'),
      `${JSON.stringify(files.metadata, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      join(directory, 'technical-validation-report.json'),
      `${JSON.stringify(files.technicalReport, null, 2)}\n`,
      'utf8',
    ),
  ]);
}

async function generateInstrumentCandidate(
  adapter: DesktopFuturesHistoryAdapter,
  definition: InstrumentDefinition,
  options: Options,
  stagingRoot: string,
  generatedAt: string,
  previousFirst5: string | undefined,
): Promise<CandidateResult> {
  const baselineDirectory = join(options.baselineRoot, definition.id);
  const minutePath = join(baselineDirectory, 'edb_main_continuous_1m_raw.csv');
  const mappingPath = join(baselineDirectory, 'edb_main_contract_mapping.csv');
  const metadataPath = join(baselineDirectory, 'metadata.json');
  const [edbMinuteText, edbMappingText, edbMetadataText] = await Promise.all([
    readFile(minutePath, 'utf8'),
    readFile(mappingPath, 'utf8'),
    readFile(metadataPath, 'utf8'),
  ]);
  const edbRecords = parseEdbMinuteCsv(
    edbMinuteText,
    `${definition.name} 正式 EDB 1 分钟`,
    definition.tradingSessions,
  );
  if (!edbRecords.length) throw new Error(`${definition.name} 正式 EDB 1 分钟为空`);
  const window = rollingMarketWindow(edbRecords.at(-1)!.startMs);
  const collectionStartMs = window.lowerBoundMs - 7 * DAY_MS;
  const main = await collectDesktopMain(
    adapter,
    definition,
    collectionStartMs,
  );
  const desktopLast = main.records.at(-1)!;
  const edbTail = edbRecords.filter(record => record.startMs > desktopLast.startMs);
  const cutover = validateEdbTailCutover(desktopLast.startMs, edbTail);
  const exact = await collectExactMappings(adapter, definition, main);
  const desktopLastTradingDate = desktopLast.tradingDate;
  const edbMappings = parseMainContractMappings(
    edbMappingText,
    `${definition.name} 正式 EDB 主力映射`,
    definition,
  );
  const mappingOverlap = mappingOverlapReport(
    definition,
    exact.mappings,
    edbMappings,
    desktopLastTradingDate,
  );
  const mappingNormalization = normalizeEdbTailMappings(
    definition,
    edbMappings,
    edbTail,
  );
  const tailMappings = mappingNormalization.mappings.filter(mapping => (
    mapping.tradingDate > desktopLastTradingDate
    && mapping.tradingDate <= mappingNormalization.latestRepresentedTradingDate
  ));
  if (!tailMappings.length) {
    throw new Error(`${definition.name} EDB 尾部缺少新增交易日主力映射`);
  }
  const mappingByDate = new Map(
    exact.mappings.map(mapping => [mapping.tradingDate, mapping]),
  );
  for (const mapping of tailMappings) mappingByDate.set(mapping.tradingDate, mapping);
  const mappings = [...mappingByDate.values()]
    .filter(mapping => mapping.tradingDate >= window.lowerBound.slice(0, 10))
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));

  const desktopMinutes = main.records.map(toEdbMinute);
  const mergedMinutes = [...desktopMinutes, ...edbTail]
    .sort((left, right) => left.startMs - right.startMs);
  for (let index = 1; index < mergedMinutes.length; index += 1) {
    if (mergedMinutes[index].startMs <= mergedMinutes[index - 1].startMs) {
      throw new Error(`${definition.name} 桌面与 EDB 合并后分钟重复或倒序`);
    }
  }
  const desktopAggregation = aggregateSparseDesktopFiveMinuteBars(
    desktopMinutes,
    desktopLast.startMs + MINUTE_MS,
    definition.tradingSessions,
  );
  const edbTailBars5 = aggregateMinutes(
    edbTail,
    5,
    window.latestMs + MINUTE_MS,
    definition.tradingSessions,
  );
  const allBars5 = [...desktopAggregation.bars, ...edbTailBars5]
    .sort((left, right) => left.startMs - right.startMs);
  const allBars60 = aggregateFiveMinuteBars(
    allBars5,
    definition.tradingSessions,
  );
  const bars5 = trimToRollingMarketWindow(allBars5, window);
  const bars60 = trimToRollingMarketWindow(allBars60, window);
  if (!bars5.length || !bars60.length) {
    throw new Error(`${definition.name} 五年窗口裁剪后没有 5/60 分钟行情`);
  }
  if (bars5.some(bar => !bar.complete) || bars60.some(bar => !bar.complete)) {
    const details = {
      bars5: bars5.filter(bar => !bar.complete).slice(0, 10).map(bar => ({
        start: bar.start,
        observedMinutes: bar.observedMinutes,
        expectedMinutes: bar.expectedMinutes,
      })),
      bars60: bars60.filter(bar => !bar.complete).slice(0, 10).map(bar => ({
        start: bar.start,
        observedMinutes: bar.observedMinutes,
        expectedMinutes: bar.expectedMinutes,
      })),
    };
    throw new Error(
      `${definition.name} 候选包含不完整 5/60 分钟 K 线：${JSON.stringify(details)}`,
    );
  }
  assertBarsValid(bars5, 5, definition.tradingSessions);
  assertSegmentedSixtyMinuteBarsValid(bars60, definition.tradingSessions);
  assertBarsReconcile(definition, bars5, bars60);
  assertContinuousBarCoverage(definition, bars5, bars60, mappings);
  const threeYearBoundary = rollingMarketWindow(window.latestMs, 3).lowerBoundMs;
  if (bars5[0].startMs > threeYearBoundary || bars60[0].startMs > threeYearBoundary) {
    throw new Error(`${definition.name} 5/60 分钟连续覆盖不足三个自然年`);
  }
  if (bars5[0].startMs < window.lowerBoundMs
    || bars60[0].startMs < window.lowerBoundMs) {
    throw new Error(`${definition.name} 候选写入了滚动五年下限之前的 K 线`);
  }

  const rollovers = detectContractRollovers(mappings, bars5, definition);
  if (rollovers.some(rollover => rollover.timeMs < window.lowerBoundMs)) {
    throw new Error(`${definition.name} 候选写入了滚动五年下限之前的换月记录`);
  }
  const overlap = overlapDifferenceReport(
    main.records,
    edbRecords,
    desktopLast.startMs,
  );
  const bars5Text = serializeBars([...bars5]);
  const bars60Text = serializeBars([...bars60]);
  const mappingsText = serializeMainContractMappings(mappings, definition);
  const rolloversText = serializeContractRollovers(rollovers, definition);
  const declarations = {
    bars5: fileDeclaration(
      'edb_main_continuous_5m.csv',
      bars5Text,
      bars5.length,
    ),
    bars60: fileDeclaration(
      'edb_main_continuous_60m.csv',
      bars60Text,
      bars60.length,
    ),
    mainContractMappings: fileDeclaration(
      'edb_main_contract_mapping.csv',
      mappingsText,
      mappings.length,
    ),
    rollovers: fileDeclaration(
      'edb_main_continuous_rollovers.csv',
      rolloversText,
      rollovers.length,
    ),
  };
  const sourceSegments: MarketSnapshotSourceSegment[] = [
    {
      sourceId: adapter.description.sourceId,
      sourceName: adapter.description.sourceName,
      kind: 'desktop-main',
      sourceVersion: adapter.description.sourceVersion,
      acquiredAt: adapter.description.acquiredAt,
      coverage: {
        first: bars5[0].start,
        last: cutover.desktopLast,
      },
      rawFiles: [
        sourceRawFile(main.sourceFile),
        ...exact.sourceFiles.map(sourceRawFile),
      ],
      importerVersion: IMPORTER_VERSION,
      license: adapter.description.license,
    },
    {
      sourceId: 'edb-builtin-tail',
      sourceName: '现有内置 EDB 近期尾部',
      kind: 'edb-tail',
      sourceVersion: JSON.parse(edbMetadataText).generatedAt,
      acquiredAt: JSON.parse(edbMetadataText).generatedAt,
      coverage: {
        first: cutover.firstTail,
        last: cutover.lastTail,
      },
      rawFiles: [{
        name: `data/instruments/${definition.id}/edb_main_continuous_1m_raw.csv`,
        sha256: sha256(edbMinuteText),
        rows: edbRecords.length,
      }],
      importerVersion: IMPORTER_VERSION,
      license: {
        redistributionAllowed: true,
        conclusion: '沿用现有已发布 EDB 内置尾部，仅用于桌面尾部之后的接续。',
      },
    },
  ];
  const repeatedFirst5Stable = previousFirst5 === undefined
    ? null
    : previousFirst5 === bars5[0].start;
  if (repeatedFirst5Stable === false) {
    throw new Error(
      `${definition.name} 重复生成首根不稳定：${previousFirst5} -> ${bars5[0].start}`,
    );
  }
  const metadata = {
    schemaVersion: 5,
    snapshotId: snapshotId(Object.values(declarations)),
    generatedAt,
    requestStart: window.lowerBound,
    requestEnd: window.latest,
    sourceLatestAt: candidateSourceLatestAt(bars5, bars60),
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: {
      provider: 'MIXED',
      symbol: definition.mainSymbol,
    },
    sourceSegments,
    redistribution: {
      allowed: false,
      conclusion: '桌面期货分钟数据尚未确认允许写入 Git、EXE 或安装包。',
    },
    periods: {
      bars5: candidatePeriodMetadata(bars5),
      bars60: candidatePeriodMetadata(bars60),
    },
    files: declarations,
  };
  const technicalReport = {
    schemaVersion: 1,
    generatedAt,
    instrumentId: definition.id,
    name: definition.name,
    status: 'passed',
    candidateOnly: true,
    window,
    cutover,
    overlap,
    mappingOverlap,
    desktopSparseMinuteAggregation: {
      sourceSemantics: 'only-minutes-with-trades',
      sourceMinuteRows: desktopAggregation.sourceMinuteRows,
      fiveMinuteBars: desktopAggregation.fiveMinuteBars,
      sparseFiveMinuteBars: desktopAggregation.sparseFiveMinuteBars,
      omittedMinutesWithinEmittedBars:
        desktopAggregation.omittedMinutesWithinEmittedBars,
      maximumOmittedMinutesPerBar:
        desktopAggregation.maximumOmittedMinutesPerBar,
      syntheticOneMinuteRows: desktopAggregation.syntheticOneMinuteRows,
      syntheticOneMinuteRowsGenerated: false,
    },
    edbTailMappingNormalization: {
      sourceLastMappingDate: mappingNormalization.sourceLastMappingDate,
      normalizedLastTradingDate: mappingNormalization.latestRepresentedTradingDate,
      derivedMappings: mappingNormalization.derivedMappings,
    },
    exactMainContractMatching: {
      ...exact.summary,
      desktopLastTradingDate,
      edbTailMappingDays: tailMappings.length,
      sourceVarianceFallbacks: exact.matchReport.days
        .filter(day => day.method === 'neighbor-confirmed-source-variance')
        .map(day => {
          const selectedCandidate = day.candidates.find(
            candidate => candidate.contract === day.selectedContract,
          );
          return {
            tradingDate: day.tradingDate,
            selectedContract: day.selectedContract,
            confidence: day.confidence,
            participatingFields: day.participatingFields,
            unavailableFields: day.unavailableFields,
            mismatchFields: selectedCandidate?.mismatchFields ?? [],
            mismatchRows: selectedCandidate?.mismatchRows ?? 0,
            timestampMismatchRows:
              selectedCandidate?.timestampMismatchRows ?? 0,
            ohlcMismatchRows: selectedCandidate?.ohlcMismatchRows ?? 0,
            optionalMismatchRows:
              selectedCandidate?.optionalMismatchRows ?? 0,
            fullFieldMatchRate:
              selectedCandidate?.fullFieldMatchRate ?? 0,
            tradeStatisticsDifferences:
              selectedCandidate?.tradeStatisticsDifferences,
            mismatchSamples: selectedCandidate?.mismatchSamples ?? [],
            sourceVariance: day.sourceVariance,
          };
        }),
      rolloverBoundarySourceVarianceFallbacks: exact.matchReport.days
        .filter(day => day.method === 'rollover-boundary-source-variance')
        .map(day => {
          const selectedCandidate = day.candidates.find(
            candidate => candidate.contract === day.selectedContract,
          );
          return {
            tradingDate: day.tradingDate,
            selectedContract: day.selectedContract,
            confidence: day.confidence,
            participatingFields: day.participatingFields,
            unavailableFields: day.unavailableFields,
            mismatchFields: selectedCandidate?.mismatchFields ?? [],
            mismatchRows: selectedCandidate?.mismatchRows ?? 0,
            timestampMismatchRows:
              selectedCandidate?.timestampMismatchRows ?? 0,
            ohlcMismatchRows: selectedCandidate?.ohlcMismatchRows ?? 0,
            optionalMismatchRows:
              selectedCandidate?.optionalMismatchRows ?? 0,
            fullFieldMatchRate:
              selectedCandidate?.fullFieldMatchRate ?? 0,
            tradeStatisticsDifferences:
              selectedCandidate?.tradeStatisticsDifferences,
            mismatchSamples: selectedCandidate?.mismatchSamples ?? [],
            sourceVariance: day.sourceVariance,
            rolloverBoundarySourceVariance:
              day.rolloverBoundarySourceVariance,
          };
        }),
      heuristicFallbacks: exact.matchReport.days
        .filter(day => day.method === 'heuristic-fallback')
        .map(day => {
          const selectedCandidate = day.candidates.find(
            candidate => candidate.contract === day.selectedContract,
          );
          return {
            tradingDate: day.tradingDate,
            selectedContract: day.selectedContract,
            confidence: day.confidence,
            participatingFields: day.participatingFields,
            unavailableFields: day.unavailableFields,
            mismatchFields: selectedCandidate?.mismatchFields ?? [],
            firstMismatchTimestamp: selectedCandidate?.firstMismatchTimestamp,
            calibration: day.heuristic.calibration,
          };
        }),
      calibration: {
        strategy: 'nearest-unique-exact-trading-days',
        referenceDates: exact.calibrationReferenceDates,
        overlap: exact.calibration.overlap,
        thresholds: exact.calibration.thresholds,
        counts: exact.calibration.counts,
        activation: exact.calibration.activation,
      },
    },
    validation: {
      atLeastThreeCalendarYears: true,
      noRecordBeforeFiveYearLowerBound: true,
      firstActualBarAtOrAfterLowerBound: bars5[0].start,
      repeatedFirst5Stable,
      duplicateFiveMinuteTimestamps: 0,
      duplicateSixtyMinuteTimestamps: 0,
      completeFiveMinuteBars: true,
      completeSixtyMinuteBars: true,
      sixtyMinuteRebuiltFromFiveMinute: true,
      uniqueMainContractMapping: true,
      canonicalRolloverContracts: true,
      existingBaselineChanged: false,
    },
    counts: {
      bars5: bars5.length,
      bars60: bars60.length,
      mappings: mappings.length,
      rollovers: rollovers.length,
      edbTailMinutes: edbTail.length,
    },
    authorizationConclusion: AUTHORIZATION_CONCLUSION,
  };
  await writeInstrumentCandidate(join(stagingRoot, definition.id), {
    bars5Text,
    bars60Text,
    mappingsText,
    rolloversText,
    metadata,
    technicalReport,
  });
  return {
    instrumentId: definition.id,
    name: definition.name,
    first5: bars5[0].start,
    last5: bars5.at(-1)!.start,
    first60: bars60[0].start,
    last60: bars60.at(-1)!.start,
    rows5: bars5.length,
    rows60: bars60.length,
    mappings: mappings.length,
    rollovers: rollovers.length,
    repeatedFirst5Stable,
    technicalValidationPassed: true,
  };
}

export async function atomicReplaceDirectory(
  staging: string,
  target: string,
): Promise<void> {
  const stagingParent = resolve(dirname(staging));
  const targetParent = resolve(dirname(target));
  if (stagingParent !== targetParent) {
    throw new Error('staging 与目标目录必须位于同一父目录');
  }
  const backup = join(targetParent, `.desktop-candidates-backup-${randomUUID()}`);
  const targetExists = await exists(target);
  try {
    if (targetExists) await rename(target, backup);
    await rename(staging, target);
    if (targetExists) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (await exists(target)) await rm(target, { recursive: true, force: true });
    if (targetExists && await exists(backup)) await rename(backup, target);
    throw error;
  } finally {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
  }
}

export async function generateDesktopTemporaryCandidates(
  options: Options,
): Promise<{
  outputRoot: string;
  baselineSha256: string;
  repeatedGenerationVerified: boolean;
  instruments: CandidateResult[];
}> {
  assertCandidateOutputPath(
    options.outputRoot,
    options.repositoryRoot,
    options.baselineRoot,
  );
  const baselineBefore = await hashDirectory(options.baselineRoot);
  const previousFirstStarts = await readPreviousFirstStarts(options.outputRoot);
  const parent = dirname(options.outputRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = join(parent, `.desktop-candidates-staging-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: false });
  const generatedAt = new Date().toISOString();
  const adapter = new DesktopFuturesHistoryAdapter(options.sourceRoot, {
    sourceVersion: 'desktop-archive-2026-10-19',
    acquiredAt: '2026-10-22',
  });
  const instruments: CandidateResult[] = [];
  try {
    for (const definition of INSTRUMENT_LIST) {
      console.log(`[${instruments.length + 1}/${INSTRUMENT_LIST.length}] ${definition.name}`);
      instruments.push(await generateInstrumentCandidate(
        adapter,
        definition,
        options,
        stagingRoot,
        generatedAt,
        previousFirstStarts.get(definition.id),
      ));
    }
    const baselineAfterGeneration = await hashDirectory(options.baselineRoot);
    if (baselineAfterGeneration !== baselineBefore) {
      throw new Error('候选生成期间正式 data/instruments 基线发生变化');
    }
    const repeatedGenerationVerified = previousFirstStarts.size === INSTRUMENT_LIST.length
      && instruments.every(result => result.repeatedFirst5Stable === true);
    const summary = {
      schemaVersion: 1,
      generatedAt,
      sourceRoot: options.sourceRoot,
      outputRoot: options.outputRoot,
      baselineRoot: options.baselineRoot,
      importerVersion: IMPORTER_VERSION,
      status: 'passed',
      candidateOnly: true,
      instruments,
      validation: {
        instrumentsExpected: INSTRUMENT_LIST.length,
        instrumentsGenerated: instruments.length,
        allTechnicalValidationsPassed: true,
        repeatedGenerationVerified,
        outputContainsOnlyInstrumentDirectoriesAndSummary: true,
        baselineSha256Before: baselineBefore,
        baselineSha256After: baselineAfterGeneration,
        existingBaselineChanged: false,
      },
      authorizationConclusion: AUTHORIZATION_CONCLUSION,
    };
    await writeFile(
      join(stagingRoot, 'technical-validation-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    const entries = (await readdir(stagingRoot)).sort();
    const expected = [
      ...INSTRUMENT_LIST.map(definition => definition.id),
      'technical-validation-summary.json',
    ].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      throw new Error('临时候选根目录包含预期之外的文件或目录');
    }
    for (const definition of INSTRUMENT_LIST) {
      const directory = join(stagingRoot, definition.id);
      const files = (await readdir(directory)).sort();
      const expectedFiles = [
        'edb_main_continuous_5m.csv',
        'edb_main_continuous_60m.csv',
        'edb_main_continuous_rollovers.csv',
        'edb_main_contract_mapping.csv',
        'metadata.json',
        'technical-validation-report.json',
      ].sort();
      if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
        throw new Error(`${definition.name} 临时候选文件集合不符合六文件约束`);
      }
      for (const file of files) {
        if (!(await stat(join(directory, file))).isFile()) {
          throw new Error(`${definition.name} 临时候选包含非文件项：${file}`);
        }
      }
    }
    await atomicReplaceDirectory(stagingRoot, options.outputRoot);
    const baselineAfterReplace = await hashDirectory(options.baselineRoot);
    if (baselineAfterReplace !== baselineBefore) {
      throw new Error('替换临时候选后正式 data/instruments 基线发生变化');
    }
    return {
      outputRoot: options.outputRoot,
      baselineSha256: baselineBefore,
      repeatedGenerationVerified,
      instruments,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function runDesktopTemporaryCandidateCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseArguments(argv);
  const result = await generateDesktopTemporaryCandidates(options);
  console.log(
    `桌面临时候选生成完成：${result.instruments.length} 个品种，`
    + `重复首根验证 ${result.repeatedGenerationVerified ? '通过' : '待第二次运行'}，`
    + `输出 ${result.outputRoot}`,
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runDesktopTemporaryCandidateCli();
}
