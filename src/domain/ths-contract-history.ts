import type {
  ContractHistorySourceDescription,
  DesktopFuturesHistoryFile,
  DesktopFuturesHistorySource,
  DesktopFuturesMinuteRecord,
} from './contract-history-import';
import {
  normalizeHistoricalContractCodeForTradingDate,
  normalizeHistoricalTradingDates,
  tradingDateForHistoricalTimestamp,
} from './contract-history-normalization';
import type { DesktopMainMatchMinuteRecord } from './desktop-main-contract-matching';
import { tradingBarBucketAt } from './market-data';
import { parseBeijing } from './time';
import {
  normalizeThsGlassMainFiveMinuteBars,
  type ThsKlinePageInput,
} from './ths-benchmark';
import {
  INSTRUMENT_DEFINITIONS,
  type InstrumentDefinition,
} from '../shared/instruments';

const GLASS = INSTRUMENT_DEFINITIONS.glass_main;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_SIZE = 10_000;

export interface ThsGlassContractPageInput extends ThsKlinePageInput {
  rawSha256: string;
}

export type GlassContractSourceEvidence =
  | {
      kind: 'ths-contract';
      sourceId: 'ths-glass-contract';
      sourceName: '同花顺玻璃具体合约 5 分钟';
      license: ContractHistorySourceDescription['license'];
      rawPages: Array<{
        pageNumber: number;
        rawSha256: string;
        rows: number;
      }>;
    }
  | {
      kind: 'project-auditable-fallback';
      sourceId: string;
      sourceName: string;
      sourceVersion?: string;
      acquiredAt?: string;
      license: ContractHistorySourceDescription['license'];
      sourceFile: DesktopFuturesHistoryFile;
    };

export type GlassContractRecordEvidence =
  | {
      kind: 'ths-contract';
      pageNumber: number;
      sourceRow: number;
      rawSha256: string;
    }
  | {
      kind: 'project-auditable-fallback';
      relativePath: string;
      firstLine: number;
      lastLine: number;
      sourceMinuteRows: number;
      fileSha256: string;
    };

export interface GlassContractCandidateRecord
  extends DesktopMainMatchMinuteRecord {
  contract: string;
  rawContract: string;
  normalizedContract: string;
  endMs: number;
  endTimestamp: string;
  sourceEvidence: GlassContractRecordEvidence;
}

export interface GlassContractCandidateSeries {
  instrumentId: 'glass_main';
  rawContract: string;
  normalizedContract: string;
  source: GlassContractSourceEvidence;
  records: GlassContractCandidateRecord[];
}

function validateSourceDescription(
  description: ContractHistorySourceDescription,
): void {
  if (!description.sourceId.trim() || !description.sourceName.trim()) {
    throw new Error('具体合约后备来源必须提供来源 ID 和名称');
  }
  if (!description.sourceVersion?.trim() && !description.acquiredAt?.trim()) {
    throw new Error('具体合约后备来源必须提供版本或取得时间');
  }
  if (!description.license.conclusion.trim()) {
    throw new Error('具体合约后备来源必须提供授权结论');
  }
}

function validateSourceFile(file: DesktopFuturesHistoryFile): void {
  if (!file.relativePath.trim()
    || !HASH_PATTERN.test(file.sha256)
    || !Number.isSafeInteger(file.bytes)
    || file.bytes < 0
    || !Number.isSafeInteger(file.rows)
    || file.rows < 0
    || file.format !== 'desktop-contract-v1'
    || (file.firstTimestamp === null) !== (file.lastTimestamp === null)
    || (file.rows === 0) !== (file.firstTimestamp === null)) {
    throw new Error('具体合约后备来源文件审计元数据无效');
  }
}

function sameSourceFile(
  left: DesktopFuturesHistoryFile,
  right: DesktopFuturesHistoryFile,
): boolean {
  return left.relativePath === right.relativePath
    && left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.rows === right.rows
    && left.firstTimestamp === right.firstTimestamp
    && left.lastTimestamp === right.lastTimestamp
    && left.format === right.format
    && left.storage === right.storage
    && left.archiveRelativePath === right.archiveRelativePath
    && left.archiveMember === right.archiveMember
    && left.compressedBytes === right.compressedBytes;
}

function assertGlassSourceContract(
  rawContract: string,
  referenceTradingDate: string,
): void {
  if (!/^FG\d{3,4}$/.test(rawContract)) {
    throw new Error(`玻璃具体合约原始代码无效：${rawContract}`);
  }
  normalizeHistoricalContractCodeForTradingDate(
    GLASS,
    rawContract,
    referenceTradingDate,
  );
}

function normalizedContract(
  rawContract: string,
  tradingDate: string,
): ReturnType<typeof normalizeHistoricalContractCodeForTradingDate> {
  return normalizeHistoricalContractCodeForTradingDate(
    GLASS,
    rawContract,
    tradingDate,
  );
}

function oneNormalizedContract(
  records: readonly GlassContractCandidateRecord[],
): string {
  if (!records.length) throw new Error('玻璃具体合约候选序列为空');
  const contracts = new Set(records.map(record => record.normalizedContract));
  if (contracts.size !== 1) {
    throw new Error(
      `同一原始玻璃合约被规范为多个合约：${[...contracts].join('、')}`,
    );
  }
  return records[0].normalizedContract;
}

export function normalizeThsGlassContractFiveMinuteSeries(
  rawContract: string,
  pages: readonly ThsGlassContractPageInput[],
  tradingDateValues: readonly string[],
  closedThroughMs = Date.now(),
): GlassContractCandidateSeries {
  const tradingDates = normalizeHistoricalTradingDates(tradingDateValues);
  assertGlassSourceContract(rawContract, tradingDates[0]);
  const tradingDateSet = new Set(tradingDates);
  const pageByNumber = new Map<number, ThsGlassContractPageInput>();
  for (const page of pages) {
    if (pageByNumber.has(page.pageNumber)) {
      throw new Error(`同花顺玻璃具体合约页码重复：${page.pageNumber}`);
    }
    if (!HASH_PATTERN.test(page.rawSha256)) {
      throw new Error(`同花顺玻璃具体合约第 ${page.pageNumber} 页哈希无效`);
    }
    pageByNumber.set(page.pageNumber, page);
  }
  const bars = normalizeThsGlassMainFiveMinuteBars(pages, closedThroughMs);
  const records = bars.map(bar => {
    const tradingDate = tradingDateForHistoricalTimestamp(
      GLASS,
      bar.barStartMs,
      tradingDates,
      tradingDateSet,
    );
    const contract = normalizedContract(rawContract, tradingDate).contract;
    return {
      instrumentId: 'glass_main' as const,
      tradingDate,
      contract,
      rawContract,
      normalizedContract: contract,
      timestamp: bar.start,
      startMs: bar.barStartMs,
      endMs: bar.barEndMs,
      endTimestamp: bar.end,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      amount: bar.turnover,
      volume: bar.volume,
      openInterest: null,
      sourceEvidence: {
        kind: 'ths-contract' as const,
        pageNumber: bar.sourcePage,
        sourceRow: bar.sourceRow,
        rawSha256: pageByNumber.get(bar.sourcePage)!.rawSha256,
      },
    };
  });
  const normalized = oneNormalizedContract(records);
  return {
    instrumentId: 'glass_main',
    rawContract,
    normalizedContract: normalized,
    source: {
      kind: 'ths-contract',
      sourceId: 'ths-glass-contract',
      sourceName: '同花顺玻璃具体合约 5 分钟',
      license: {
        redistributionAllowed: false,
        conclusion: '未确认允许随产品再分发，仅限本机修复审计使用。',
      },
      rawPages: pages.map(page => ({
        pageNumber: page.pageNumber,
        rawSha256: page.rawSha256,
        rows: page.values.length,
      })),
    },
    records,
  };
}

function assertDesktopMinute(
  record: DesktopFuturesMinuteRecord,
  rawContract: string,
  sourceId: string,
  sourceFile: DesktopFuturesHistoryFile,
): number {
  if (record.instrumentId !== 'glass_main'
    || record.kind !== 'contract'
    || record.sourceSymbol.toUpperCase() !== rawContract.toUpperCase()) {
    throw new Error(
      `具体合约后备记录与请求不一致：${record.instrumentId}/${record.sourceSymbol}`,
    );
  }
  if (record.provenance.sourceId !== sourceId
    || record.provenance.relativePath !== sourceFile.relativePath
    || record.provenance.archiveMember !== sourceFile.archiveMember
    || !Number.isSafeInteger(record.provenance.line)
    || record.provenance.line <= 1) {
    throw new Error(`具体合约后备记录来源证据无效：${record.timestamp}`);
  }
  const startMs = parseBeijing(record.timestamp);
  const values = [
    record.open,
    record.high,
    record.low,
    record.close,
    record.amount,
    record.volume,
    record.openInterest,
  ].filter((value): value is number => value !== null);
  if (!values.every(Number.isFinite)
    || record.low > record.high
    || record.open < record.low
    || record.open > record.high
    || record.close < record.low
    || record.close > record.high
    || (record.amount !== null && record.amount < 0)
    || (record.volume !== null && record.volume < 0)
    || (record.openInterest !== null && record.openInterest < 0)) {
    throw new Error(`具体合约后备分钟字段无效：${record.timestamp}`);
  }
  return startMs;
}

interface NormalizedDesktopMinute {
  record: DesktopFuturesMinuteRecord;
  startMs: number;
  tradingDate: string;
  normalizedContract: string;
}

export interface DesktopGlassContractFallbackRange {
  firstStartMs: number;
  lastEndMs: number;
}

function validateFallbackRange(
  range: DesktopGlassContractFallbackRange | undefined,
): void {
  if (!range) return;
  if (!Number.isSafeInteger(range.firstStartMs)
    || !Number.isSafeInteger(range.lastEndMs)
    || range.firstStartMs >= range.lastEndMs) {
    throw new Error('具体合约后备保护区间无效');
  }
}

function aggregateDesktopFallback(
  rows: readonly NormalizedDesktopMinute[],
  rawContract: string,
  sourceFile: DesktopFuturesHistoryFile,
): GlassContractCandidateRecord[] {
  const groups = new Map<number, NormalizedDesktopMinute[]>();
  for (const row of rows) {
    const bucket = tradingBarBucketAt(
      row.startMs,
      5,
      GLASS.tradingSessions,
    );
    const group = groups.get(bucket.startMs) ?? [];
    group.push(row);
    groups.set(bucket.startMs, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startMs, group]) => {
      group.sort((left, right) => left.startMs - right.startMs);
      for (let index = 1; index < group.length; index += 1) {
        if (group[index].startMs <= group[index - 1].startMs) {
          throw new Error(
            `具体合约后备分钟时间戳重复或倒序：${group[index].record.timestamp}`,
          );
        }
      }
      const first = group[0];
      const last = group.at(-1)!;
      const tradingDates = new Set(group.map(row => row.tradingDate));
      const contracts = new Set(group.map(row => row.normalizedContract));
      if (tradingDates.size !== 1 || contracts.size !== 1) {
        throw new Error(`具体合约后备 5 分钟桶跨越交易日或规范合约：${first.record.timestamp}`);
      }
      const bucket = tradingBarBucketAt(startMs, 5, GLASS.tradingSessions);
      const optionalTotal = (field: 'amount' | 'volume'): number | null => (
        group.every(row => row.record[field] !== null)
          ? group.reduce((total, row) => total + row.record[field]!, 0)
          : null
      );
      return {
        instrumentId: 'glass_main',
        tradingDate: first.tradingDate,
        contract: first.normalizedContract,
        rawContract,
        normalizedContract: first.normalizedContract,
        timestamp: bucket.start,
        startMs: bucket.startMs,
        endMs: bucket.endMs,
        endTimestamp: bucket.end,
        open: first.record.open,
        high: Math.max(...group.map(row => row.record.high)),
        low: Math.min(...group.map(row => row.record.low)),
        close: last.record.close,
        amount: optionalTotal('amount'),
        volume: optionalTotal('volume'),
        openInterest: last.record.openInterest,
        sourceEvidence: {
          kind: 'project-auditable-fallback',
          relativePath: sourceFile.relativePath,
          firstLine: first.record.provenance.line,
          lastLine: last.record.provenance.line,
          sourceMinuteRows: group.length,
          fileSha256: sourceFile.sha256,
        },
      };
    });
}

export async function loadAuditableDesktopGlassContractFallback(
  source: DesktopFuturesHistorySource,
  rawContract: string,
  tradingDateValues: readonly string[],
  range?: DesktopGlassContractFallbackRange,
): Promise<GlassContractCandidateSeries> {
  validateSourceDescription(source.description);
  validateFallbackRange(range);
  const tradingDates = normalizeHistoricalTradingDates(tradingDateValues);
  assertGlassSourceContract(rawContract, tradingDates[0]);
  const tradingDateSet = new Set(tradingDates);
  const sourceFile = await source.inspectContractFile({
    instrument: 'glass_main',
    contract: rawContract,
  });
  validateSourceFile(sourceFile);
  const rows: NormalizedDesktopMinute[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let previousStartMs: number | undefined;
  let sourceRows = 0;
  let firstSourceTimestamp: string | null = null;
  let lastSourceTimestamp: string | null = null;
  do {
    const cursorKey = cursor ?? '<first-page>';
    if (seenCursors.has(cursorKey)) {
      throw new Error(`具体合约后备分页游标形成循环：${cursorKey}`);
    }
    seenCursors.add(cursorKey);
    const page = await source.readContractPage({
      instrument: 'glass_main',
      contract: rawContract,
      cursor,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    if (!sameSourceFile(sourceFile, page.sourceFile)) {
      throw new Error('具体合约后备分页期间来源文件元数据发生变化');
    }
    if (!page.records.length && page.nextCursor !== undefined) {
      throw new Error('具体合约后备空分页不得继续返回下一游标');
    }
    for (const record of page.records) {
      const startMs = assertDesktopMinute(
        record,
        rawContract,
        source.description.sourceId,
        sourceFile,
      );
      if (previousStartMs !== undefined && startMs <= previousStartMs) {
        throw new Error(
          `具体合约后备分钟时间戳重复或倒序：${record.timestamp}`,
        );
      }
      previousStartMs = startMs;
      sourceRows += 1;
      firstSourceTimestamp ??= record.timestamp;
      lastSourceTimestamp = record.timestamp;
      if (range
        && (startMs < range.firstStartMs || startMs >= range.lastEndMs)) {
        continue;
      }
      const tradingDate = tradingDateForHistoricalTimestamp(
        GLASS,
        startMs,
        tradingDates,
        tradingDateSet,
      );
      rows.push({
        record,
        startMs,
        tradingDate,
        normalizedContract: normalizedContract(rawContract, tradingDate).contract,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  if (sourceRows !== sourceFile.rows) {
    throw new Error(
      `具体合约后备来源文件行数与分页读取数量不一致：`
      + `${sourceFile.rows} / ${sourceRows}`,
    );
  }
  if (sourceRows
    && (
      firstSourceTimestamp !== sourceFile.firstTimestamp
      || lastSourceTimestamp !== sourceFile.lastTimestamp
    )) {
    throw new Error('具体合约后备来源文件首末时间与分页记录不一致');
  }
  if (!rows.length) {
    throw new Error(`具体合约后备在保护区间内没有记录：${rawContract}`);
  }
  const records = aggregateDesktopFallback(rows, rawContract, sourceFile);
  const normalized = oneNormalizedContract(records);
  return {
    instrumentId: 'glass_main',
    rawContract,
    normalizedContract: normalized,
    source: {
      kind: 'project-auditable-fallback',
      sourceId: source.description.sourceId,
      sourceName: source.description.sourceName,
      sourceVersion: source.description.sourceVersion,
      acquiredAt: source.description.acquiredAt,
      license: source.description.license,
      sourceFile,
    },
    records,
  };
}
