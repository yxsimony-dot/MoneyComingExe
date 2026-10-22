import { isDeepStrictEqual } from 'node:util';
import {
  detectContractRollovers,
} from '../domain/contract-rollover';
import {
  aggregateFiveMinuteBars,
  assertBarsValid,
  assertContinuousBarCoverage,
  assertMinuteCoverageMatchesFiveMinuteBars,
  assertMinuteRecordsValid,
  reconcileBars,
} from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../shared/instruments';
import type {
  MarketSnapshotRedistribution,
  MarketSnapshotSourceSegment,
  SnapshotPeriodMetadata,
} from '../shared/types';
import {
  loadEffectiveSnapshot,
  type MarketDataPaths,
} from './market-snapshot';

export const BASELINE_VALIDATION_REPORT_FILE = 'baseline-validation-report.json';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export interface BaselineValidationInstrumentReport {
  instrumentId: InstrumentDefinition['id'];
  name: string;
  firstMinute?: string;
  lastMinute?: string;
  sourceLatestAt: string;
  minuteRows: number;
  fiveMinuteRows: number;
  sixtyMinuteRows: number;
  mappingRows: number;
  rolloverRows: number;
  periods: {
    bars1?: SnapshotPeriodMetadata;
    bars5: SnapshotPeriodMetadata;
    bars60: SnapshotPeriodMetadata;
  };
  coverageBoundaries: {
    bars5: string;
    bars60: string;
  };
  sourceSegments: MarketSnapshotSourceSegment[];
  redistribution: MarketSnapshotRedistribution;
  checks: {
    metadataAndHashes: true;
    minuteRecords: true;
    minuteOverlapReconciliation: true;
    fiveMinuteBars: true;
    rebuiltSixtyMinuteBars: true;
    crossPeriodReconciliation: true;
    threeYearCoverage: true;
    continuousCoverage: true;
    mainContractMappings: true;
    rolloverLocations: true;
    redistributionAllowed: true;
  };
}

export interface BaselineValidationReport {
  schemaVersion: 1;
  validatedAt: string;
  instruments: BaselineValidationInstrumentReport[];
}

export interface BaselineValidatorOptions {
  paths: MarketDataPaths;
  instruments?: readonly InstrumentDefinition[];
  now?: () => Date;
  onProgress?: (definition: InstrumentDefinition) => void;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
}

function period(
  values: readonly { start: string; end?: string }[],
): SnapshotPeriodMetadata | undefined {
  if (!values.length) return undefined;
  return {
    first: values[0].start,
    last: values.at(-1)!.end ?? values.at(-1)!.start,
    rows: values.length,
  };
}

export function subtractBeijingCalendarYears(
  value: string,
  years: number,
): string {
  const local = new Date(parseBeijing(value) + BEIJING_OFFSET_MS);
  const targetYear = local.getUTCFullYear() - years;
  const targetMonth = local.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetMs = Date.UTC(
    targetYear,
    targetMonth,
    Math.min(local.getUTCDate(), lastDay),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ) - BEIJING_OFFSET_MS;
  return formatBeijing(targetMs);
}

function assertThreeYearCoverage(
  definition: InstrumentDefinition,
  label: '5 分钟' | '60 分钟',
  first: string,
  last: string,
): string {
  const boundary = subtractBeijingCalendarYears(last, 3);
  if (parseBeijing(first) > parseBeijing(boundary)) {
    throw new Error(
      `${definition.name} ${label}覆盖不足三个自然年：实际 ${first} 至 ${last}，至少需要从 ${boundary} 开始`,
    );
  }
  return boundary;
}

function assertRedistributable(
  definition: InstrumentDefinition,
  segments: readonly MarketSnapshotSourceSegment[],
  redistribution: MarketSnapshotRedistribution,
): void {
  if (!segments.length) {
    throw new Error(`${definition.name} 缺少可审计的数据来源`);
  }
  const rejected = segments.find(segment => (
    !segment.license.redistributionAllowed
  ));
  if (rejected) {
    throw new Error(
      `${definition.name} 来源 ${rejected.sourceName} 未确认允许随产品再分发`,
    );
  }
  if (!redistribution.allowed) {
    throw new Error(`${definition.name} 顶层再分发结论不允许发布`);
  }
}

export async function validateMarketBaselines(
  options: BaselineValidatorOptions,
): Promise<BaselineValidationReport> {
  const report: BaselineValidationReport = {
    schemaVersion: 1,
    validatedAt: (options.now?.() ?? new Date()).toISOString(),
    instruments: [],
  };

  for (const definition of options.instruments ?? INSTRUMENT_LIST) {
    options.onProgress?.(definition);
    const snapshot = await loadEffectiveSnapshot(options.paths, definition);
    if (snapshot.source !== 'builtin') {
      throw new Error(`${definition.name} 验收时意外加载了用户快照`);
    }
    if (snapshot.metadata?.schemaVersion !== 5) {
      throw new Error(`${definition.name} 内置基线必须使用 schema 5 元数据`);
    }
    if (!snapshot.bars5.length || !snapshot.bars60.length) {
      throw new Error(`${definition.name} 基线缺少必要的 5/60 分钟行情`);
    }
    if (!snapshot.mainContractMappings.length) {
      throw new Error(`${definition.name} 缺少主力合约日映射`);
    }

    assertMinuteRecordsValid(snapshot.bars1, definition.tradingSessions);
    assertBarsValid(snapshot.bars5, 5, definition.tradingSessions);
    assertMinuteCoverageMatchesFiveMinuteBars(
      snapshot.bars1,
      snapshot.bars5,
      definition.tradingSessions,
    );
    reconcileBars(
      snapshot.bars5,
      snapshot.bars60,
      definition.tradingSessions,
    );
    const rebuilt60 = aggregateFiveMinuteBars(
      snapshot.bars5,
      definition.tradingSessions,
    ).filter(bar => bar.complete);
    assertEqual(
      snapshot.bars60,
      rebuilt60,
      `${definition.name} 的 60 分钟数据无法由最终 5 分钟基线精确重建`,
    );

    const bars5Period = period(snapshot.bars5)!;
    const bars60Period = period(snapshot.bars60)!;
    const bars1Period = period(snapshot.bars1);
    const bars5Boundary = assertThreeYearCoverage(
      definition,
      '5 分钟',
      bars5Period.first,
      bars5Period.last,
    );
    const bars60Boundary = assertThreeYearCoverage(
      definition,
      '60 分钟',
      bars60Period.first,
      bars60Period.last,
    );
    assertContinuousBarCoverage(
      definition,
      snapshot.bars5,
      snapshot.bars60,
      snapshot.mainContractMappings,
    );

    const sourceLatestMs = parseBeijing(snapshot.sourceLatestAt);
    const actualLatestMs = Math.max(
      snapshot.bars1.at(-1)?.startMs === undefined
        ? Number.NEGATIVE_INFINITY
        : snapshot.bars1.at(-1)!.startMs + MINUTE_MS,
      snapshot.bars5.at(-1)!.endMs,
      snapshot.bars60.at(-1)!.endMs,
    );
    if (sourceLatestMs < actualLatestMs) {
      throw new Error(`${definition.name} 数据源截止时间早于实际行情末端`);
    }

    assertRedistributable(
      definition,
      snapshot.metadata.sourceSegments,
      snapshot.metadata.redistribution,
    );

    const detectedRollovers = detectContractRollovers(
      snapshot.mainContractMappings,
      snapshot.bars5,
      definition,
    );
    assertEqual(
      snapshot.rollovers,
      detectedRollovers,
      `${definition.name} 的换月记录与日映射或首根 5 分钟 K 线不一致`,
    );

    report.instruments.push({
      instrumentId: definition.id,
      name: definition.name,
      firstMinute: snapshot.bars1[0]?.start,
      lastMinute: snapshot.bars1.at(-1)?.start,
      sourceLatestAt: snapshot.sourceLatestAt,
      minuteRows: snapshot.bars1.length,
      fiveMinuteRows: snapshot.bars5.length,
      sixtyMinuteRows: snapshot.bars60.length,
      mappingRows: snapshot.mainContractMappings.length,
      rolloverRows: snapshot.rollovers.length,
      periods: {
        bars1: bars1Period,
        bars5: bars5Period,
        bars60: bars60Period,
      },
      coverageBoundaries: {
        bars5: bars5Boundary,
        bars60: bars60Boundary,
      },
      sourceSegments: snapshot.metadata.sourceSegments,
      redistribution: snapshot.metadata.redistribution,
      checks: {
        metadataAndHashes: true,
        minuteRecords: true,
        minuteOverlapReconciliation: true,
        fiveMinuteBars: true,
        rebuiltSixtyMinuteBars: true,
        crossPeriodReconciliation: true,
        threeYearCoverage: true,
        continuousCoverage: true,
        mainContractMappings: true,
        rolloverLocations: true,
        redistributionAllowed: true,
      },
    });
  }

  return report;
}
