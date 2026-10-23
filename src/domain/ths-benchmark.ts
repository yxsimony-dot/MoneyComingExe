import { INSTRUMENT_DEFINITIONS } from '../shared/instruments';
import type { Bar, EdbMinuteRecord } from '../shared/types';
import { formatBeijing } from './time';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  assertMinuteCoverageMatchesFiveMinuteBars,
  assertMinuteRecordsValid,
  reconcileBars,
  tradingBarBucketAt,
} from './market-data';

const FIVE_MINUTES_MS = 5 * 60_000;
const NUMBER_EQUALITY_EPSILON = 1e-9;

export const THS_BENCHMARK_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
] as const;
const THS_PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
const THS_MINUTE_AUDIT_FIELDS = [
  ...THS_BENCHMARK_FIELDS,
  'openOi',
  'closeOi',
] as const;

export type ThsBenchmarkField = typeof THS_BENCHMARK_FIELDS[number];
export type ThsMinuteAuditField = typeof THS_MINUTE_AUDIT_FIELDS[number];

export interface ThsKlinePageInput {
  pageNumber: number;
  values: readonly (readonly unknown[])[];
}

export interface ThsBenchmarkFiveMinuteBar {
  sourcePage: number;
  sourceRow: number;
  closeTimeMs: number;
  barStartMs: number;
  barEndMs: number;
  start: string;
  end: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  session: Bar['session'];
  observedMinutes: number;
  expectedMinutes: number;
  complete: true;
}

export interface ThsBenchmarkCoverageSummary {
  rowCount: number;
  firstStartMs: number | null;
  firstStart: string | null;
  lastEndMs: number | null;
  lastEnd: string | null;
}

export interface ThsBenchmarkTimelinePoint {
  barStartMs: number;
  start: string;
}

export interface ThsBenchmarkFieldStatistics {
  comparedRows: number;
  matchingRows: number;
  differingRows: number;
  matchRate: number;
  absoluteDifferenceTotal: number;
  maximumAbsoluteDifference: number;
}

export interface ThsBenchmarkFieldDifference {
  field: ThsBenchmarkField;
  benchmarkValue: number;
  localValue: number;
  absoluteDifference: number;
}

export interface ThsBenchmarkDifferenceRow {
  barStartMs: number;
  barEndMs: number;
  start: string;
  end: string;
  differences: ThsBenchmarkFieldDifference[];
}

export interface ThsBenchmarkMaximumPriceDifference {
  field: typeof THS_PRICE_FIELDS[number];
  barStartMs: number;
  start: string;
  benchmarkValue: number;
  localValue: number;
  absoluteDifference: number;
}

export interface ThsBenchmarkContinuousDifferenceRange {
  firstBarStartMs: number;
  firstStart: string;
  lastBarStartMs: number;
  lastEndMs: number;
  lastEnd: string;
  rowCount: number;
  fields: ThsBenchmarkField[];
}

export interface ThsBenchmarkDifferenceReport {
  benchmark: ThsBenchmarkCoverageSummary;
  local: ThsBenchmarkCoverageSummary;
  timeline: {
    oneToOne: boolean;
    matchedRows: number;
    missingFromLocal: ThsBenchmarkTimelinePoint[];
    extraInLocal: ThsBenchmarkTimelinePoint[];
  };
  fields: Record<ThsBenchmarkField, ThsBenchmarkFieldStatistics>;
  differences: ThsBenchmarkDifferenceRow[];
  maximumPriceDifference: ThsBenchmarkMaximumPriceDifference | null;
  continuousDifferenceRanges: ThsBenchmarkContinuousDifferenceRange[];
}

export interface ThsBenchmarkMergeResult {
  bars5: Bar[];
  differenceReport: ThsBenchmarkDifferenceReport;
}

export interface ThsMinuteAuditFieldDifference {
  field: ThsMinuteAuditField;
  protectedValue: number;
  minuteAggregateValue: number | null;
  absoluteDifference: number | null;
}

export interface ThsMinuteAuditDifferenceRow {
  barStartMs: number;
  barEndMs: number;
  start: string;
  end: string;
  minuteRows: number;
  expectedMinuteRows: number;
  coverageComplete: boolean;
  differences: ThsMinuteAuditFieldDifference[];
}

export interface ThsMinuteReconciliationReport {
  protection: {
    firstStartMs: number;
    firstStart: string;
    lastEndMs: number;
    lastEnd: string;
  };
  preservedMinuteRows: number;
  protectedBarRows: number;
  matchingRows: number;
  differingRows: number;
  differences: ThsMinuteAuditDifferenceRow[];
}

export interface ThsMinuteProtectionAuditResult {
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  report: ThsMinuteReconciliationReport;
}

function finiteNumber(value: unknown, field: string, page: number, row: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`同花顺第 ${page} 页第 ${row} 根 ${field} 缺失或不是有限数值`);
  }
  return value;
}

function normalizeRow(
  value: readonly unknown[],
  pageNumber: number,
  sourceRow: number,
  closedThroughMs: number,
): ThsBenchmarkFiveMinuteBar {
  if (value.length !== 7) {
    throw new Error(`同花顺第 ${pageNumber} 页第 ${sourceRow} 根字段数量无效`);
  }
  const closeTimeMs = finiteNumber(value[0], '收盘时间', pageNumber, sourceRow);
  if (!Number.isSafeInteger(closeTimeMs) || closeTimeMs <= 0) {
    throw new Error(`同花顺第 ${pageNumber} 页第 ${sourceRow} 根收盘时间无效`);
  }
  if (closeTimeMs > closedThroughMs) {
    throw new Error(`同花顺第 ${pageNumber} 页第 ${sourceRow} 根尚未收盘`);
  }
  const open = finiteNumber(value[1], 'open', pageNumber, sourceRow);
  const high = finiteNumber(value[2], 'high', pageNumber, sourceRow);
  const low = finiteNumber(value[3], 'low', pageNumber, sourceRow);
  const close = finiteNumber(value[4], 'close', pageNumber, sourceRow);
  const volume = finiteNumber(value[5], 'volume', pageNumber, sourceRow);
  const turnover = finiteNumber(value[6], 'turnover', pageNumber, sourceRow);
  if (low > high || open < low || open > high || close < low || close > high) {
    throw new Error(`同花顺第 ${pageNumber} 页第 ${sourceRow} 根 OHLC 范围无效`);
  }
  if (volume < 0 || turnover < 0) {
    throw new Error(`同花顺第 ${pageNumber} 页第 ${sourceRow} 根成交量或成交额为负`);
  }

  const barStartMs = closeTimeMs - FIVE_MINUTES_MS;
  const bucket = tradingBarBucketAt(
    barStartMs,
    5,
    INSTRUMENT_DEFINITIONS.glass_main.tradingSessions,
  );
  if (bucket.startMs !== barStartMs || bucket.endMs !== closeTimeMs) {
    throw new Error(
      `同花顺第 ${pageNumber} 页第 ${sourceRow} 根不能形成合法玻璃 5 分钟桶：`
      + `${formatBeijing(barStartMs)}~${formatBeijing(closeTimeMs)}`,
    );
  }
  return {
    sourcePage: pageNumber,
    sourceRow,
    closeTimeMs,
    barStartMs,
    barEndMs: closeTimeMs,
    start: bucket.start,
    end: bucket.end,
    open,
    high,
    low,
    close,
    volume,
    turnover,
    session: bucket.session,
    observedMinutes: bucket.expectedMinutes,
    expectedMinutes: bucket.expectedMinutes,
    complete: true,
  };
}

export function normalizeThsGlassMainFiveMinuteBars(
  pages: readonly ThsKlinePageInput[],
  closedThroughMs = Date.now(),
): ThsBenchmarkFiveMinuteBar[] {
  if (!Number.isSafeInteger(closedThroughMs) || closedThroughMs <= 0) {
    throw new Error('同花顺闭合时间边界无效');
  }
  const normalized: ThsBenchmarkFiveMinuteBar[] = [];
  for (const page of pages) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber <= 0) {
      throw new Error('同花顺页码无效');
    }
    let previousCloseTimeMs: number | undefined;
    for (let index = 0; index < page.values.length; index += 1) {
      const bar = normalizeRow(
        page.values[index],
        page.pageNumber,
        index + 1,
        closedThroughMs,
      );
      if (previousCloseTimeMs !== undefined && bar.closeTimeMs <= previousCloseTimeMs) {
        throw new Error(
          `同花顺第 ${page.pageNumber} 页记录重复或未严格递增：${bar.end}`,
        );
      }
      previousCloseTimeMs = bar.closeTimeMs;
      normalized.push(bar);
    }
  }

  normalized.sort((left, right) => left.barStartMs - right.barStartMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].barStartMs === normalized[index - 1].barStartMs) {
      throw new Error(`同花顺 5 分钟记录重复：${normalized[index].start}`);
    }
  }
  return normalized;
}

function mapUniqueByStart<T>(
  records: readonly T[],
  startMs: (record: T) => number,
  start: (record: T) => string,
  label: string,
): Map<number, T> {
  const byStart = new Map<number, T>();
  for (const record of records) {
    const timestamp = startMs(record);
    if (!Number.isSafeInteger(timestamp)) {
      throw new Error(`${label}包含无效 5 分钟时间戳`);
    }
    if (byStart.has(timestamp)) {
      throw new Error(`${label}包含重复 5 分钟记录：${start(record)}`);
    }
    byStart.set(timestamp, record);
  }
  return byStart;
}

function coverageSummary(
  rows: readonly {
    startMs: number;
    endMs: number;
    start: string;
    end: string;
  }[],
): ThsBenchmarkCoverageSummary {
  const ordered = [...rows].sort((left, right) => left.startMs - right.startMs);
  return {
    rowCount: ordered.length,
    firstStartMs: ordered[0]?.startMs ?? null,
    firstStart: ordered[0]?.start ?? null,
    lastEndMs: ordered.at(-1)?.endMs ?? null,
    lastEnd: ordered.at(-1)?.end ?? null,
  };
}

function emptyFieldStatistics(): Record<
ThsBenchmarkField,
ThsBenchmarkFieldStatistics
> {
  const empty = (): ThsBenchmarkFieldStatistics => ({
    comparedRows: 0,
    matchingRows: 0,
    differingRows: 0,
    matchRate: 0,
    absoluteDifferenceTotal: 0,
    maximumAbsoluteDifference: 0,
  });
  return {
    open: empty(),
    high: empty(),
    low: empty(),
    close: empty(),
    volume: empty(),
  };
}

function valuesMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMBER_EQUALITY_EPSILON;
}

export function compareThsGlassMainFiveMinuteBars(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
  local: readonly Bar[],
): ThsBenchmarkDifferenceReport {
  const benchmarkByStart = mapUniqueByStart(
    benchmark,
    bar => bar.barStartMs,
    bar => bar.start,
    '同花顺基准',
  );
  const localByStart = mapUniqueByStart(
    local,
    bar => bar.startMs,
    bar => bar.start,
    '本地快照',
  );
  const benchmarkCoverage = coverageSummary(benchmark.map(bar => ({
    startMs: bar.barStartMs,
    endMs: bar.barEndMs,
    start: bar.start,
    end: bar.end,
  })));
  const localCoverage = coverageSummary(local);
  const missingFromLocal: ThsBenchmarkTimelinePoint[] = [];
  const extraInLocal: ThsBenchmarkTimelinePoint[] = [];
  const fields = emptyFieldStatistics();
  const differences: ThsBenchmarkDifferenceRow[] = [];
  const continuousDifferenceRanges: ThsBenchmarkContinuousDifferenceRange[] = [];
  let maximumPriceDifference: ThsBenchmarkMaximumPriceDifference | null = null;
  let currentRange: ThsBenchmarkDifferenceRow[] = [];
  let matchedRows = 0;

  const flushRange = (): void => {
    if (!currentRange.length) return;
    const first = currentRange[0];
    const last = currentRange.at(-1)!;
    continuousDifferenceRanges.push({
      firstBarStartMs: first.barStartMs,
      firstStart: first.start,
      lastBarStartMs: last.barStartMs,
      lastEndMs: last.barEndMs,
      lastEnd: last.end,
      rowCount: currentRange.length,
      fields: THS_BENCHMARK_FIELDS.filter(field => (
        currentRange.some(row => row.differences.some(difference => difference.field === field))
      )),
    });
    currentRange = [];
  };

  const timeline = [...new Set([
    ...benchmarkByStart.keys(),
    ...localByStart.keys(),
  ])].sort((left, right) => left - right);
  for (const barStartMs of timeline) {
    const benchmarkBar = benchmarkByStart.get(barStartMs);
    const localBar = localByStart.get(barStartMs);
    if (!benchmarkBar) {
      extraInLocal.push({ barStartMs, start: localBar!.start });
      flushRange();
      continue;
    }
    if (!localBar) {
      missingFromLocal.push({ barStartMs, start: benchmarkBar.start });
      flushRange();
      continue;
    }

    matchedRows += 1;
    const rowDifferences: ThsBenchmarkFieldDifference[] = [];
    for (const field of THS_BENCHMARK_FIELDS) {
      const benchmarkValue = benchmarkBar[field];
      const localValue = localBar[field];
      const absoluteDifference = Math.abs(benchmarkValue - localValue);
      const statistics = fields[field];
      statistics.comparedRows += 1;
      statistics.absoluteDifferenceTotal += absoluteDifference;
      statistics.maximumAbsoluteDifference = Math.max(
        statistics.maximumAbsoluteDifference,
        absoluteDifference,
      );
      if (valuesMatch(benchmarkValue, localValue)) {
        statistics.matchingRows += 1;
        continue;
      }
      statistics.differingRows += 1;
      rowDifferences.push({
        field,
        benchmarkValue,
        localValue,
        absoluteDifference,
      });
      if ((THS_PRICE_FIELDS as readonly ThsBenchmarkField[]).includes(field)
        && (
          maximumPriceDifference === null
          || absoluteDifference > maximumPriceDifference.absoluteDifference
        )) {
        maximumPriceDifference = {
          field: field as typeof THS_PRICE_FIELDS[number],
          barStartMs,
          start: benchmarkBar.start,
          benchmarkValue,
          localValue,
          absoluteDifference,
        };
      }
    }

    if (!rowDifferences.length) {
      flushRange();
      continue;
    }
    const differenceRow: ThsBenchmarkDifferenceRow = {
      barStartMs,
      barEndMs: benchmarkBar.barEndMs,
      start: benchmarkBar.start,
      end: benchmarkBar.end,
      differences: rowDifferences,
    };
    differences.push(differenceRow);
    currentRange.push(differenceRow);
  }
  flushRange();

  for (const field of THS_BENCHMARK_FIELDS) {
    const statistics = fields[field];
    statistics.matchRate = statistics.comparedRows
      ? statistics.matchingRows / statistics.comparedRows
      : 0;
  }

  return {
    benchmark: benchmarkCoverage,
    local: localCoverage,
    timeline: {
      oneToOne: missingFromLocal.length === 0 && extraInLocal.length === 0,
      matchedRows,
      missingFromLocal,
      extraInLocal,
    },
    fields,
    differences,
    maximumPriceDifference,
    continuousDifferenceRanges,
  };
}

export function mergeThsGlassMainFiveMinuteBars(
  benchmark: readonly ThsBenchmarkFiveMinuteBar[],
  local: readonly Bar[],
): ThsBenchmarkMergeResult {
  const differenceReport = compareThsGlassMainFiveMinuteBars(benchmark, local);
  if (!differenceReport.timeline.oneToOne) {
    throw new Error(
      '同花顺基准与本地 5 分钟时间轴不能一一对应：'
      + `本地缺少 ${differenceReport.timeline.missingFromLocal.length} 根，`
      + `本地多余 ${differenceReport.timeline.extraInLocal.length} 根`,
    );
  }
  const localByStart = mapUniqueByStart(
    local,
    bar => bar.startMs,
    bar => bar.start,
    '本地快照',
  );
  const bars5 = benchmark.map(source => {
    const localBar = localByStart.get(source.barStartMs);
    if (!localBar) {
      throw new Error(`同花顺基准缺少唯一的本地对应记录：${source.start}`);
    }
    if (![localBar.openOi, localBar.closeOi].every(Number.isFinite)
      || localBar.openOi < 0
      || localBar.closeOi < 0) {
      throw new Error(`本地 5 分钟持仓量无效，不能生成修复候选：${localBar.start}`);
    }
    return {
      ...localBar,
      open: source.open,
      high: source.high,
      low: source.low,
      close: source.close,
      volume: source.volume,
    };
  });
  assertBarsValid(bars5, 5, INSTRUMENT_DEFINITIONS.glass_main.tradingSessions);
  return { bars5, differenceReport };
}

export function rebuildThsGlassMainSixtyMinuteBars(
  bars5: readonly Bar[],
): Bar[] {
  const schedule = INSTRUMENT_DEFINITIONS.glass_main.tradingSessions;
  const bars60 = aggregateFiveMinuteBars(bars5, schedule)
    .filter(bar => bar.complete);
  reconcileBars(bars5, bars60, schedule);
  return bars60;
}

export function auditThsGlassMainMinuteProtection(
  bars1: readonly EdbMinuteRecord[],
  bars5: readonly Bar[],
  bars60: readonly Bar[],
  firstProtectedStartMs: number,
  lastProtectedEndMs: number,
): ThsMinuteProtectionAuditResult {
  const schedule = INSTRUMENT_DEFINITIONS.glass_main.tradingSessions;
  if (!Number.isSafeInteger(firstProtectedStartMs)
    || !Number.isSafeInteger(lastProtectedEndMs)
    || firstProtectedStartMs >= lastProtectedEndMs) {
    throw new Error('同花顺基准分钟审计保护范围无效');
  }
  assertMinuteRecordsValid(bars1, schedule);
  assertBarsValid(bars5, 5, schedule);
  reconcileBars(bars5, bars60, schedule);

  const protectedBars = bars5.filter(bar => (
    bar.startMs >= firstProtectedStartMs && bar.endMs <= lastProtectedEndMs
  ));
  if (!protectedBars.length
    || protectedBars[0].startMs !== firstProtectedStartMs
    || protectedBars.at(-1)!.endMs !== lastProtectedEndMs
    || bars5.some(bar => (
      bar.startMs < lastProtectedEndMs
      && bar.endMs > firstProtectedStartMs
      && !protectedBars.includes(bar)
    ))) {
    throw new Error('同花顺基准分钟审计保护范围未与完整 5 分钟桶对齐');
  }

  const outsideMinutes = bars1.filter(record => (
    record.startMs < firstProtectedStartMs || record.startMs >= lastProtectedEndMs
  ));
  const outsideBars = bars5.filter(bar => (
    bar.endMs <= firstProtectedStartMs || bar.startMs >= lastProtectedEndMs
  ));
  assertMinuteCoverageMatchesFiveMinuteBars(outsideMinutes, outsideBars, schedule);

  const differences: ThsMinuteAuditDifferenceRow[] = [];
  let matchingRows = 0;
  for (const protectedBar of protectedBars) {
    const minuteRows = bars1.filter(record => (
      record.startMs >= protectedBar.startMs && record.startMs < protectedBar.endMs
    ));
    const rebuilt = aggregateMinutes(
      [...minuteRows],
      5,
      protectedBar.endMs,
      schedule,
    )[0];
    const coverageComplete = rebuilt?.complete === true
      && rebuilt.startMs === protectedBar.startMs
      && rebuilt.endMs === protectedBar.endMs;
    const fieldDifferences = THS_MINUTE_AUDIT_FIELDS.flatMap(field => {
      const minuteAggregateValue = coverageComplete ? rebuilt[field] : null;
      if (minuteAggregateValue !== null
        && valuesMatch(protectedBar[field], minuteAggregateValue)) {
        return [];
      }
      return [{
        field,
        protectedValue: protectedBar[field],
        minuteAggregateValue,
        absoluteDifference: minuteAggregateValue === null
          ? null
          : Math.abs(protectedBar[field] - minuteAggregateValue),
      }];
    });
    if (!fieldDifferences.length) {
      matchingRows += 1;
      continue;
    }
    differences.push({
      barStartMs: protectedBar.startMs,
      barEndMs: protectedBar.endMs,
      start: protectedBar.start,
      end: protectedBar.end,
      minuteRows: minuteRows.length,
      expectedMinuteRows: protectedBar.expectedMinutes,
      coverageComplete,
      differences: fieldDifferences,
    });
  }

  return {
    bars1: [...bars1],
    bars5: [...bars5],
    bars60: [...bars60],
    report: {
      protection: {
        firstStartMs: firstProtectedStartMs,
        firstStart: formatBeijing(firstProtectedStartMs),
        lastEndMs: lastProtectedEndMs,
        lastEnd: formatBeijing(lastProtectedEndMs),
      },
      preservedMinuteRows: bars1.filter(record => (
        record.startMs >= firstProtectedStartMs && record.startMs < lastProtectedEndMs
      )).length,
      protectedBarRows: protectedBars.length,
      matchingRows,
      differingRows: differences.length,
      differences,
    },
  };
}
