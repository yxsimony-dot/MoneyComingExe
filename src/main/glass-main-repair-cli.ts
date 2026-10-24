import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  normalizeHistoricalContractCodeForTradingDate,
  normalizeHistoricalTradingDates,
  tradingDateForHistoricalTimestamp,
} from '../domain/contract-history-normalization';
import {
  loadAuditableDesktopGlassContractFallback,
  normalizeThsGlassContractFiveMinuteSeries,
  type GlassContractCandidateSeries,
  type ThsGlassContractPageInput,
} from '../domain/ths-contract-history';
import type {
  DesktopFuturesHistorySource,
} from '../domain/contract-history-import';
import {
  auditThsGlassMainMinuteProtection,
  compareThsGlassMainFiveMinuteBars,
  mergeThsGlassMainFiveMinuteBars,
  normalizeThsGlassMainFiveMinuteBars,
  rebuildThsGlassMainSixtyMinuteBars,
  THS_BENCHMARK_FIELDS,
  type ThsBenchmarkFiveMinuteBar,
} from '../domain/ths-benchmark';
import {
  matchThsGlassMainContracts,
  rebuildThsGlassMainContractArtifacts,
} from '../domain/ths-main-contract-matching';
import { INSTRUMENT_DEFINITIONS } from '../shared/instruments';
import type {
  MarketSnapshotBenchmarkProtection,
  MarketSnapshotSourceSegment,
} from '../shared/types';
import {
  DesktopFuturesHistoryAdapter,
} from './local-contract-history-adapter';
import {
  loadEffectiveSnapshot,
  resolveMarketDataPaths,
  saveMarketSnapshot,
  type LoadedMarketSnapshot,
  type SaveSnapshotOptions,
  type SnapshotCandidate,
} from './market-snapshot';
import {
  THS_GLASS_MAIN_CODE,
  THS_GLASS_MAIN_MARKET,
  THS_GLASS_MAIN_REQUEST,
  THS_KLINE_ENDPOINT,
  ThsMainClient,
  type ThsFetch,
  type ThsGlassContractHistory,
  type ThsGlassMainHistory,
  type ThsRawKlinePage,
} from './ths-main-client';

const GLASS = INSTRUMENT_DEFINITIONS.glass_main;
const IMPORTER_VERSION = 'glass-main-repair-v1';
const FIVE_MINUTES_MS = 5 * 60_000;
const DESKTOP_HISTORY_SOURCE_VERSION = 'desktop-archive-2026-10-19';
const DESKTOP_HISTORY_ACQUIRED_AT = '2026-10-22';
const NORMALIZED_CSV_HEADER = [
  'bar_start_ms',
  'bar_end_ms',
  'start',
  'end',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'turnover',
  'session',
  'source_page',
  'source_row',
].join(',');

interface GlassMainRepairOptions {
  activate: boolean;
  appRoot: string;
  appDataRoot: string;
}

export interface GlassMainRepairClient {
  fetchGlassMainHistory(
    options?: { minimumCloseTimeMs?: number },
  ): Promise<ThsGlassMainHistory>;
  fetchGlassContractHistory(
    sourceContract: string,
    options?: { minimumCloseTimeMs?: number },
  ): Promise<ThsGlassContractHistory>;
}

export interface GlassMainRepairDependencies {
  client?: GlassMainRepairClient;
  contractFallbackSource?: DesktopFuturesHistorySource | null;
  fetch?: ThsFetch;
  now?: () => Date;
  runIdFactory?: (now: Date) => string;
  loadSnapshot?: typeof loadEffectiveSnapshot;
  saveSnapshot?: typeof saveMarketSnapshot;
  saveOptions?: SaveSnapshotOptions;
}

export interface GlassMainRepairResult {
  mode: 'compare-only' | 'activate';
  runId: string;
  runDirectory: string;
  activationAllowed: boolean;
  activated: boolean;
  reportSha256?: string;
  snapshotId?: string;
}

interface RawFileAudit {
  code: string;
  pageNumber: number;
  name: string;
  sha256: string;
  rows: number;
  bytes: number;
}

interface ContractFetchAudit {
  rawContract: string;
  thsContract: string;
  desktopContract: string;
  termination: ThsGlassContractHistory['termination'];
  rawFiles: RawFileAudit[];
  croppedRows: number;
  normalizedContract: string | null;
  normalizedRows: number;
  selectedSource: GlassContractCandidateSeries['source']['kind'] | null;
  fallback:
    | {
        status: 'not-needed' | 'unavailable';
      }
    | {
        status: 'loaded';
        requestedContract: string;
        source: Extract<
          GlassContractCandidateSeries['source'],
          { kind: 'project-auditable-fallback' }
        >;
      }
    | {
        status: 'failed';
        requestedContract: string;
        error: ReturnType<typeof errorDetails>;
      };
}

interface ContractCandidate {
  thsContract: string;
  normalizedContract: string;
}

interface ArtifactPaths {
  runDirectory: string;
  rawPagesDirectory: string;
  request: string;
  normalized: string;
  fieldDiff: string;
  minuteReconciliation: string;
  contractMatching: string;
  reportManifest: string;
  activation: string;
}

interface ReportManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, stableJson(value), 'utf8');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorDetails(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function defaultRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
    || runId === '.'
    || runId === '..') {
    throw new Error('glass_main 修复运行标识无效');
  }
}

function parseArguments(argv: readonly string[]): GlassMainRepairOptions {
  let activate = false;
  let appRoot: string | undefined;
  let appDataRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--activate') {
      if (activate) throw new Error('参数 --activate 不得重复');
      activate = true;
      continue;
    }
    if (argument === '--app-root' || argument === '--app-data-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`参数 ${argument} 缺少路径`);
      }
      index += 1;
      if (argument === '--app-root') {
        if (appRoot !== undefined) throw new Error('参数 --app-root 不得重复');
        appRoot = resolve(value);
      } else {
        if (appDataRoot !== undefined) {
          throw new Error('参数 --app-data-root 不得重复');
        }
        appDataRoot = resolve(value);
      }
      continue;
    }
    throw new Error(`不支持的 glass_main 修复参数：${argument}`);
  }

  const appDataDirectory = process.env.APPDATA;
  if (!appDataRoot && !appDataDirectory) {
    throw new Error('缺少 APPDATA，必须显式提供 --app-data-root');
  }
  return {
    activate,
    appRoot: appRoot ?? process.cwd(),
    appDataRoot: appDataRoot ?? resolve(appDataDirectory!, 'MoneyComing'),
  };
}

function artifactPaths(
  marketDataDirectory: string,
  runId: string,
): ArtifactPaths {
  const runDirectory = join(
    marketDataDirectory,
    'repairs',
    GLASS.id,
    runId,
  );
  return {
    runDirectory,
    rawPagesDirectory: join(runDirectory, 'raw', 'pages'),
    request: join(runDirectory, 'request.json'),
    normalized: join(runDirectory, 'normalized', 'ths_fg9999_5m.csv'),
    fieldDiff: join(runDirectory, 'reports', 'field-diff.json'),
    minuteReconciliation: join(
      runDirectory,
      'reports',
      'minute-reconciliation.json',
    ),
    contractMatching: join(
      runDirectory,
      'reports',
      'contract-matching.json',
    ),
    reportManifest: join(runDirectory, 'reports', 'report-manifest.json'),
    activation: join(runDirectory, 'reports', 'activation.json'),
  };
}

async function initializeArtifacts(
  paths: ArtifactPaths,
  request: unknown,
  mode: GlassMainRepairResult['mode'],
  startedAt: string,
): Promise<void> {
  await Promise.all([
    mkdir(paths.rawPagesDirectory, { recursive: true }),
    mkdir(join(paths.runDirectory, 'normalized'), { recursive: true }),
    mkdir(join(paths.runDirectory, 'reports'), { recursive: true }),
  ]);
  await Promise.all([
    writeJson(paths.request, request),
    writeFile(paths.normalized, `${NORMALIZED_CSV_HEADER}\n`, 'utf8'),
    writeJson(paths.fieldDiff, { status: 'pending' }),
    writeJson(paths.minuteReconciliation, { status: 'pending' }),
    writeJson(paths.contractMatching, { status: 'pending' }),
    writeJson(paths.reportManifest, { status: 'pending' }),
    writeJson(paths.activation, {
      schemaVersion: 1,
      mode,
      status: 'pending',
      startedAt,
    }),
  ]);
}

function rawFileName(code: string, pageNumber: number): string {
  return `${code.toLowerCase()}-page-${String(pageNumber).padStart(4, '0')}.json`;
}

async function writeRawPages(
  paths: ArtifactPaths,
  code: string,
  pages: readonly ThsRawKlinePage[],
): Promise<RawFileAudit[]> {
  const audits: RawFileAudit[] = [];
  for (const page of pages) {
    const actualSha256 = sha256(page.rawText);
    if (actualSha256 !== page.rawSha256) {
      throw new Error(`同花顺 ${code} 第 ${page.pageNumber} 页原始哈希不一致`);
    }
    const fileName = rawFileName(code, page.pageNumber);
    await writeFile(join(paths.rawPagesDirectory, fileName), page.rawText, 'utf8');
    audits.push({
      code,
      pageNumber: page.pageNumber,
      name: `raw/pages/${fileName}`,
      sha256: actualSha256,
      rows: page.quote.values.length,
      bytes: Buffer.byteLength(page.rawText),
    });
  }
  return audits;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function serializeNormalizedBenchmark(
  bars: readonly ThsBenchmarkFiveMinuteBar[],
): string {
  return `${[
    NORMALIZED_CSV_HEADER,
    ...bars.map(bar => [
      bar.barStartMs,
      bar.barEndMs,
      bar.start,
      bar.end,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      bar.turnover,
      bar.session,
      bar.sourcePage,
      bar.sourceRow,
    ].map(csvCell).join(',')),
  ].join('\n')}\n`;
}

function protectedTradingDates(
  snapshot: LoadedMarketSnapshot,
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
): string[] {
  if (!snapshot.mainContractMappings.length) {
    throw new Error('当前 glass_main 快照缺少主力合约映射');
  }
  const calendar = normalizeHistoricalTradingDates(
    snapshot.mainContractMappings.map(mapping => mapping.tradingDate),
  );
  const calendarSet = new Set(calendar);
  const dates = benchmark.map(bar => tradingDateForHistoricalTimestamp(
    GLASS,
    bar.barStartMs,
    calendar,
    calendarSet,
  ));
  return [...new Set(dates)].sort();
}

function adjacentExpiry(year: number, month: number, offset: -1 | 1): {
  year: number;
  month: number;
} {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

function toThsGlassContract(year: number, month: number): string {
  return `FG${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
}

function toNormalizedGlassContract(year: number, month: number): string {
  return `FG${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
}

function contractCandidates(
  snapshot: LoadedMarketSnapshot,
  tradingDates: readonly string[],
): ContractCandidate[] {
  const firstTradingDate = tradingDates[0];
  const lastTradingDate = tradingDates.at(-1)!;
  const expiries = new Map<string, { year: number; month: number }>();
  for (const mapping of snapshot.mainContractMappings) {
    if (mapping.tradingDate < firstTradingDate
      || mapping.tradingDate > lastTradingDate) {
      continue;
    }
    const normalized = normalizeHistoricalContractCodeForTradingDate(
      GLASS,
      mapping.contract,
      mapping.tradingDate,
    );
    const values = [
      {
        year: normalized.expiryYear,
        month: normalized.expiryMonth,
      },
      adjacentExpiry(normalized.expiryYear, normalized.expiryMonth, -1),
      adjacentExpiry(normalized.expiryYear, normalized.expiryMonth, 1),
    ];
    for (const expiry of values) {
      expiries.set(`${expiry.year}-${expiry.month}`, expiry);
    }
  }
  if (!expiries.size) {
    throw new Error('基准保护交易日内没有可用于生成具体合约候选的映射');
  }
  return [...expiries.values()]
    .sort((left, right) => (
      left.year - right.year || left.month - right.month
    ))
    .map(expiry => ({
      thsContract: toThsGlassContract(expiry.year, expiry.month),
      normalizedContract: toNormalizedGlassContract(
        expiry.year,
        expiry.month,
      ),
    }));
}

function croppedContractPages(
  pages: readonly ThsRawKlinePage[],
  firstStartMs: number,
  lastEndMs: number,
): ThsGlassContractPageInput[] {
  return pages.map(page => ({
    pageNumber: page.pageNumber,
    rawSha256: page.rawSha256,
    values: page.quote.values.filter(row => {
      const closeTimeMs = row[0];
      return typeof closeTimeMs === 'number'
        && closeTimeMs - FIVE_MINUTES_MS >= firstStartMs
        && closeTimeMs <= lastEndMs;
    }),
  }));
}

async function fetchContractCandidates(
  client: GlassMainRepairClient,
  fallbackSource: DesktopFuturesHistorySource | undefined,
  paths: ArtifactPaths,
  candidates: readonly ContractCandidate[],
  tradingDates: readonly string[],
  firstStartMs: number,
  firstEndMs: number,
  lastEndMs: number,
  closedThroughMs: number,
): Promise<{
  series: GlassContractCandidateSeries[];
  fetches: ContractFetchAudit[];
  rawFiles: RawFileAudit[];
}> {
  const series: GlassContractCandidateSeries[] = [];
  const fetches: ContractFetchAudit[] = [];
  const rawFiles: RawFileAudit[] = [];
  for (const candidate of candidates) {
    const history = await client.fetchGlassContractHistory(
      candidate.thsContract,
      {
        minimumCloseTimeMs: firstEndMs,
      },
    );
    const historyRawFiles = await writeRawPages(
      paths,
      candidate.thsContract,
      history.pages,
    );
    rawFiles.push(...historyRawFiles);
    const pages = croppedContractPages(
      history.pages,
      firstStartMs,
      lastEndMs,
    );
    const croppedRows = pages.reduce(
      (total, page) => total + page.values.length,
      0,
    );
    if (!croppedRows) {
      if (!fallbackSource) {
        fetches.push({
          rawContract: candidate.thsContract,
          thsContract: candidate.thsContract,
          desktopContract: candidate.normalizedContract,
          termination: history.termination,
          rawFiles: historyRawFiles,
          croppedRows: 0,
          normalizedContract: null,
          normalizedRows: 0,
          selectedSource: null,
          fallback: { status: 'unavailable' },
        });
        continue;
      }
      try {
        const fallback = await loadAuditableDesktopGlassContractFallback(
          fallbackSource,
          candidate.normalizedContract,
          tradingDates,
          { firstStartMs, lastEndMs },
        );
        if (fallback.source.kind !== 'project-auditable-fallback') {
          throw new Error(
            `具体合约后备返回了非桌面审计来源：${fallback.source.kind}`,
          );
        }
        series.push(fallback);
        fetches.push({
          rawContract: candidate.thsContract,
          thsContract: candidate.thsContract,
          desktopContract: candidate.normalizedContract,
          termination: history.termination,
          rawFiles: historyRawFiles,
          croppedRows: 0,
          normalizedContract: fallback.normalizedContract,
          normalizedRows: fallback.records.length,
          selectedSource: fallback.source.kind,
          fallback: {
            status: 'loaded',
            requestedContract: candidate.normalizedContract,
            source: fallback.source,
          },
        });
      } catch (error) {
        fetches.push({
          rawContract: candidate.thsContract,
          thsContract: candidate.thsContract,
          desktopContract: candidate.normalizedContract,
          termination: history.termination,
          rawFiles: historyRawFiles,
          croppedRows: 0,
          normalizedContract: null,
          normalizedRows: 0,
          selectedSource: null,
          fallback: {
            status: 'failed',
            requestedContract: candidate.normalizedContract,
            error: errorDetails(error),
          },
        });
      }
      continue;
    }
    const normalized = normalizeThsGlassContractFiveMinuteSeries(
      candidate.thsContract,
      pages,
      tradingDates,
      closedThroughMs,
    );
    if (normalized.normalizedContract !== candidate.normalizedContract) {
      throw new Error(
        `同花顺具体合约规范代码不一致：`
        + `${candidate.thsContract} -> ${normalized.normalizedContract}，`
        + `预期 ${candidate.normalizedContract}`,
      );
    }
    series.push(normalized);
    fetches.push({
      rawContract: candidate.thsContract,
      thsContract: candidate.thsContract,
      desktopContract: candidate.normalizedContract,
      termination: history.termination,
      rawFiles: historyRawFiles,
      croppedRows,
      normalizedContract: normalized.normalizedContract,
      normalizedRows: normalized.records.length,
      selectedSource: normalized.source.kind,
      fallback: { status: 'not-needed' },
    });
  }
  return { series, fetches, rawFiles };
}

async function buildReportManifest(
  paths: ArtifactPaths,
  rawFiles: readonly RawFileAudit[],
): Promise<{ text: string; sha256: string; files: ReportManifestFile[] }> {
  const fixedFiles = [
    ['request.json', paths.request],
    ['normalized/ths_fg9999_5m.csv', paths.normalized],
    ['reports/field-diff.json', paths.fieldDiff],
    ['reports/minute-reconciliation.json', paths.minuteReconciliation],
    ['reports/contract-matching.json', paths.contractMatching],
  ] as const;
  const files: ReportManifestFile[] = [];
  for (const [relativePath, absolutePath] of fixedFiles) {
    const content = await readFile(absolutePath);
    files.push({
      path: relativePath,
      sha256: sha256(content),
      bytes: content.byteLength,
    });
  }
  for (const rawFile of [...rawFiles].sort((left, right) => (
    left.name.localeCompare(right.name, 'en')
  ))) {
    files.push({
      path: rawFile.name,
      sha256: rawFile.sha256,
      bytes: rawFile.bytes,
    });
  }
  const text = stableJson({
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    files,
  });
  const reportSha256 = sha256(text);
  await writeFile(paths.reportManifest, text, 'utf8');
  return { text, sha256: reportSha256, files };
}

function sourceSegment(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
  mainRawFiles: readonly RawFileAudit[],
  acquiredAt: string,
): MarketSnapshotSourceSegment {
  return {
    sourceId: 'ths-fg9999',
    sourceName: '同花顺 FG9999 玻璃主连',
    kind: 'benchmark-main',
    sourceVersion: IMPORTER_VERSION,
    acquiredAt,
    coverage: {
      first: benchmark[0].start,
      last: benchmark.at(-1)!.end,
    },
    rawFiles: mainRawFiles.map(file => ({
      name: file.name,
      sha256: file.sha256,
      rows: file.rows,
    })),
    importerVersion: IMPORTER_VERSION,
    license: {
      identifier: 'THS local repair',
      redistributionAllowed: false,
      conclusion: '未确认允许随产品再分发，仅限本机修复审计使用。',
    },
  };
}

function benchmarkProtection(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
  bars60: SnapshotCandidate['bars60'],
  mappings: SnapshotCandidate['mainContractMappings'],
  rollovers: SnapshotCandidate['rollovers'],
  reportRunId: string,
  reportSha256: string,
): MarketSnapshotBenchmarkProtection {
  if (!bars60.length) throw new Error('修复候选缺少完整 60 分钟记录');
  if (!mappings.length) throw new Error('修复候选缺少主力合约映射');
  if (!rollovers.length) throw new Error('修复候选缺少可验证换月记录');
  return {
    provider: 'THS',
    reportRunId,
    sourceSegmentId: 'ths-fg9999',
    bars5: {
      firstStart: benchmark[0].start,
      lastEnd: benchmark.at(-1)!.end,
      protectedFields: [...THS_BENCHMARK_FIELDS],
    },
    bars60: {
      firstStart: bars60[0].start,
      lastEnd: bars60.at(-1)!.end,
      derivedFrom: 'bars5',
    },
    mappings: {
      firstTradingDate: mappings[0].tradingDate,
      lastTradingDate: mappings.at(-1)!.tradingDate,
    },
    rollovers: {
      firstTradingDate: rollovers[0].tradingDate,
      lastTradingDate: rollovers.at(-1)!.tradingDate,
    },
    minutePolicy: 'preserved-audit-only',
    reportSha256,
    redistribution: {
      allowed: false,
      conclusion: '同花顺基准只允许当前用户本机使用。',
    },
  };
}

function repairClient(dependencies: GlassMainRepairDependencies): GlassMainRepairClient {
  if (dependencies.client) return dependencies.client;
  const fetchImplementation = dependencies.fetch
    ?? ((input: string, init: RequestInit) => fetch(input, init));
  return new ThsMainClient({ fetch: fetchImplementation });
}

function defaultContractFallbackSource(): DesktopFuturesHistorySource {
  const sourceRoot = process.env.MONEYCOMING_DESKTOP_FUTURES_HISTORY_ROOT
    ?? resolve(
      process.env.USERPROFILE ?? 'C:\\Users\\yangxiaoyuan',
      'Desktop',
      '期货数据',
      '期货分钟',
    );
  return new DesktopFuturesHistoryAdapter(sourceRoot, {
    sourceId: 'desktop-futures-minute-history',
    sourceName: '桌面期货分钟数据',
    sourceVersion: DESKTOP_HISTORY_SOURCE_VERSION,
    acquiredAt: DESKTOP_HISTORY_ACQUIRED_AT,
    license: {
      redistributionAllowed: false,
      conclusion: '桌面归档仅用于本机具体合约匹配审计，不得随产品再分发。',
    },
  });
}

function contractFallbackSource(
  dependencies: GlassMainRepairDependencies,
): DesktopFuturesHistorySource | undefined {
  if (dependencies.contractFallbackSource === null) return undefined;
  return dependencies.contractFallbackSource ?? defaultContractFallbackSource();
}

export async function runGlassMainRepair(
  argv: readonly string[],
  dependencies: GlassMainRepairDependencies = {},
): Promise<GlassMainRepairResult> {
  const options = parseArguments(argv);
  const mode = options.activate ? 'activate' : 'compare-only';
  const now = dependencies.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('glass_main 修复时钟无效');
  const runId = dependencies.runIdFactory?.(now) ?? defaultRunId(now);
  assertRunId(runId);
  const paths = resolveMarketDataPaths(
    process.execPath,
    false,
    options.appRoot,
    options.appDataRoot,
  );
  const artifacts = artifactPaths(paths.marketDataDirectory, runId);
  const startedAt = now.toISOString();
  const requestReport: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    mode,
    instrumentId: GLASS.id,
    startedAt,
    appRoot: options.appRoot,
    appDataRoot: options.appDataRoot,
    request: {
      endpoint: THS_KLINE_ENDPOINT,
      market: THS_GLASS_MAIN_MARKET,
      code: THS_GLASS_MAIN_CODE,
      payload: THS_GLASS_MAIN_REQUEST,
    },
    coverage: null,
    contractCandidates: [],
  };
  await initializeArtifacts(artifacts, requestReport, mode, startedAt);

  let reportSha256: string | undefined;
  let saveCompleted = false;
  try {
    const loadSnapshot = dependencies.loadSnapshot ?? loadEffectiveSnapshot;
    const saveSnapshot = dependencies.saveSnapshot ?? saveMarketSnapshot;
    const current = await loadSnapshot(paths, GLASS);
    if (!current.bars5.length) {
      throw new Error('当前 glass_main 快照缺少 5 分钟行情');
    }
    const firstLocal = current.bars5[0];
    const lastLocal = current.bars5.at(-1)!;
    const client = repairClient(dependencies);
    const mainHistory = await client.fetchGlassMainHistory({
      minimumCloseTimeMs: firstLocal.endMs,
    });
    const mainRawFiles = await writeRawPages(
      artifacts,
      THS_GLASS_MAIN_CODE,
      mainHistory.pages,
    );
    const allBenchmark = normalizeThsGlassMainFiveMinuteBars(
      mainHistory.pages.map(page => ({
        pageNumber: page.pageNumber,
        values: page.quote.values,
      })),
      now.getTime(),
    );
    const benchmark = allBenchmark.filter(bar => (
      bar.barStartMs >= firstLocal.startMs
      && bar.barEndMs <= lastLocal.endMs
    ));
    if (!benchmark.length) {
      throw new Error('同花顺 FG9999 未覆盖当前 glass_main 5 分钟范围');
    }
    await writeFile(
      artifacts.normalized,
      serializeNormalizedBenchmark(benchmark),
      'utf8',
    );

    const differenceReport = compareThsGlassMainFiveMinuteBars(
      benchmark,
      current.bars5,
    );
    await writeJson(artifacts.fieldDiff, differenceReport);
    const merged = mergeThsGlassMainFiveMinuteBars(
      benchmark,
      current.bars5,
    );
    const bars60 = rebuildThsGlassMainSixtyMinuteBars(merged.bars5);
    const minuteAudit = auditThsGlassMainMinuteProtection(
      current.bars1,
      merged.bars5,
      bars60,
      benchmark[0].barStartMs,
      benchmark.at(-1)!.barEndMs,
    );
    await writeJson(artifacts.minuteReconciliation, minuteAudit.report);

    const tradingDates = protectedTradingDates(current, benchmark);
    const candidates = contractCandidates(current, tradingDates);
    const fetchedContracts = await fetchContractCandidates(
      client,
      contractFallbackSource(dependencies),
      artifacts,
      candidates,
      tradingDates,
      benchmark[0].barStartMs,
      benchmark[0].barEndMs,
      benchmark.at(-1)!.barEndMs,
      now.getTime(),
    );
    const contractMatch = matchThsGlassMainContracts(
      benchmark,
      fetchedContracts.series,
      tradingDates,
    );
    await writeJson(artifacts.contractMatching, {
      ...contractMatch,
      fetches: fetchedContracts.fetches,
    });

    requestReport.coverage = {
      firstStart: benchmark[0].start,
      lastEnd: benchmark.at(-1)!.end,
      localRows: current.bars5.length,
      benchmarkRows: benchmark.length,
      mainHistoryTermination: mainHistory.termination,
    };
    requestReport.contractCandidates = candidates;
    await writeJson(artifacts.request, requestReport);

    const allRawFiles = [...mainRawFiles, ...fetchedContracts.rawFiles];
    const activationViolations = [...contractMatch.activation.violations];
    let rebuilt:
      | ReturnType<typeof rebuildThsGlassMainContractArtifacts>
      | undefined;
    if (contractMatch.activation.allowed) {
      rebuilt = rebuildThsGlassMainContractArtifacts(
        contractMatch,
        merged.bars5,
      );
      if (!rebuilt.rollovers.length) {
        activationViolations.push('修复候选没有可验证的换月记录');
        rebuilt = undefined;
      }
    }
    const manifest = await buildReportManifest(artifacts, allRawFiles);
    reportSha256 = manifest.sha256;

    if (!rebuilt || activationViolations.length) {
      await writeJson(artifacts.activation, {
        schemaVersion: 1,
        mode,
        status: options.activate ? 'failed' : 'not-activated',
        activationAllowed: false,
        violations: activationViolations,
        reportSha256,
        completedAt: now.toISOString(),
      });
      if (options.activate) {
        throw new Error(
          `glass_main 修复候选未通过激活门禁：${activationViolations.join('；')}`,
        );
      }
      return {
        mode,
        runId,
        runDirectory: artifacts.runDirectory,
        activationAllowed: false,
        activated: false,
        reportSha256,
      };
    }

    const source = sourceSegment(benchmark, mainRawFiles, startedAt);
    const protection = benchmarkProtection(
      benchmark,
      bars60,
      rebuilt.mappings,
      rebuilt.rollovers,
      runId,
      reportSha256,
    );
    const candidate: SnapshotCandidate = {
      bars1: minuteAudit.bars1,
      bars5: minuteAudit.bars5,
      bars60: minuteAudit.bars60,
      mainContractMappings: rebuilt.mappings,
      rollovers: rebuilt.rollovers,
      requestStart: benchmark[0].start,
      requestEnd: benchmark.at(-1)!.end,
      sourceLatestAt: benchmark.at(-1)!.end,
      source: {
        provider: 'MIXED',
        endpoint: 'https://edb.shinnytech.com/md/kline',
        symbol: GLASS.mainSymbol,
      },
      sourceSegments: [source],
      redistribution: {
        allowed: false,
        conclusion: '至少一个来源未确认允许随产品再分发。',
      },
      benchmarkProtection: protection,
    };

    if (!options.activate) {
      await writeJson(artifacts.activation, {
        schemaVersion: 1,
        mode,
        status: 'not-activated',
        activationAllowed: true,
        reason: 'compare-only',
        reportSha256,
        candidate: {
          bars1: candidate.bars1.length,
          bars5: candidate.bars5.length,
          bars60: candidate.bars60.length,
          mappings: candidate.mainContractMappings.length,
          rollovers: candidate.rollovers.length,
        },
        completedAt: now.toISOString(),
      });
      return {
        mode,
        runId,
        runDirectory: artifacts.runDirectory,
        activationAllowed: true,
        activated: false,
        reportSha256,
      };
    }

    const saved = await saveSnapshot(paths, GLASS, candidate, {
      ...dependencies.saveOptions,
      intent: 'full',
      current: undefined,
      now: () => new Date(now.getTime()),
      bindBenchmarkReport: true,
    });
    saveCompleted = true;
    const snapshotId = saved.metadata?.snapshotId;
    if (!snapshotId) throw new Error('激活后的 glass_main 快照缺少标识');
    return {
      mode,
      runId,
      runDirectory: artifacts.runDirectory,
      activationAllowed: true,
      activated: true,
      reportSha256,
      snapshotId,
    };
  } catch (error) {
    if (!saveCompleted) {
      await writeJson(artifacts.activation, {
        schemaVersion: 1,
        mode,
        status: 'failed',
        activationAllowed: false,
        reportSha256: reportSha256 ?? null,
        failedAt: now.toISOString(),
        error: errorDetails(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}
