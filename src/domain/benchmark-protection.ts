import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InstrumentDefinition } from '../shared/instruments';
import type {
  Bar,
  ContractRollover,
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotBenchmarkProtection,
  MarketUpdateCounts,
} from '../shared/types';
import {
  detectContractRollovers,
  mergeMainContractMappings,
} from './contract-rollover';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  mergeBarsPreservingHistory,
  mergeMinuteHistory,
  reconcileBars,
  updateCounts,
  type MergeBarsResult,
} from './market-data';
import {
  auditThsGlassMainMinuteProtection,
  type ThsMinuteReconciliationReport,
} from './ths-benchmark';
import { parseBeijing } from './time';

const NUMBER_EQUALITY_EPSILON = 1e-9;

export interface BenchmarkProtectionDataset {
  bars5: readonly Bar[];
  bars60: readonly Bar[];
  mainContractMappings: readonly MainContractMapping[];
  rollovers: readonly ContractRollover[];
}

export interface BenchmarkProtectionMergeSnapshot
  extends BenchmarkProtectionDataset {
  bars1: readonly EdbMinuteRecord[];
}

export interface BenchmarkProtectedMappingDifference {
  tradingDate: string;
  protectedContract: string | null;
  incomingContract: string;
}

export interface BenchmarkProtectedMappingAudit {
  protectedRemoteRows: number;
  matchingRows: number;
  differingRows: number;
  differences: BenchmarkProtectedMappingDifference[];
}

export interface BenchmarkProtectionFingerprint {
  before: string;
  after: string;
}

export interface BenchmarkProtectionMergeInput {
  definition: InstrumentDefinition;
  current: BenchmarkProtectionMergeSnapshot;
  incomingMinutes: readonly EdbMinuteRecord[];
  remoteMappings?: readonly MainContractMapping[];
  protection?: MarketSnapshotBenchmarkProtection;
  rebuildStartMs: number;
  coverageEndMs: number;
}

export interface BenchmarkProtectionMergeResult {
  bars1: EdbMinuteRecord[];
  bars5: Bar[];
  bars60: Bar[];
  mainContractMappings: MainContractMapping[];
  rollovers: ContractRollover[];
  counts: MarketUpdateCounts;
  mappingsChanged: boolean;
  minuteReconciliation?: ThsMinuteReconciliationReport;
  protectedMappingAudit?: BenchmarkProtectedMappingAudit;
  protectionFingerprint?: BenchmarkProtectionFingerprint;
}

function protectedFiveMinuteValues(
  bars: readonly Bar[],
  protection: MarketSnapshotBenchmarkProtection,
) {
  const firstStartMs = parseBeijing(protection.bars5.firstStart);
  const lastEndMs = parseBeijing(protection.bars5.lastEnd);
  return bars.filter(bar => (
    bar.startMs >= firstStartMs && bar.endMs <= lastEndMs
  )).sort((left, right) => left.startMs - right.startMs).map(bar => ({
    startMs: bar.startMs,
    endMs: bar.endMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function protectedSixtyMinuteValues(
  bars: readonly Bar[],
  protection: MarketSnapshotBenchmarkProtection,
) {
  const firstStartMs = parseBeijing(protection.bars60.firstStart);
  const lastEndMs = parseBeijing(protection.bars60.lastEnd);
  return bars.filter(bar => (
    bar.complete
    && bar.startMs >= firstStartMs
    && bar.endMs <= lastEndMs
  )).sort((left, right) => left.startMs - right.startMs).map(bar => ({
    startMs: bar.startMs,
    endMs: bar.endMs,
    start: bar.start,
    end: bar.end,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    openOi: bar.openOi,
    closeOi: bar.closeOi,
    session: bar.session,
    observedMinutes: bar.observedMinutes,
    expectedMinutes: bar.expectedMinutes,
    complete: bar.complete,
  }));
}

function protectedMappingValues(
  mappings: readonly MainContractMapping[],
  protection: MarketSnapshotBenchmarkProtection,
) {
  return mappings.filter(mapping => (
    mapping.tradingDate >= protection.mappings.firstTradingDate
    && mapping.tradingDate <= protection.mappings.lastTradingDate
  )).sort((left, right) => (
    left.tradingDate.localeCompare(right.tradingDate)
  )).map(mapping => ({
    tradingDate: mapping.tradingDate,
    contract: mapping.contract,
  }));
}

function protectedRolloverValues(
  rollovers: readonly ContractRollover[],
  protection: MarketSnapshotBenchmarkProtection,
) {
  return rollovers.filter(rollover => (
    rollover.tradingDate >= protection.rollovers.firstTradingDate
    && rollover.tradingDate <= protection.rollovers.lastTradingDate
  )).sort((left, right) => (
    left.tradingDate.localeCompare(right.tradingDate)
  )).map(rollover => ({
    tradingDate: rollover.tradingDate,
    time: rollover.time,
    timeMs: rollover.timeMs,
    fromContract: rollover.fromContract,
    toContract: rollover.toContract,
  }));
}

export function benchmarkProtectionProjection(
  dataset: BenchmarkProtectionDataset,
  protection: MarketSnapshotBenchmarkProtection,
) {
  return {
    version: 1,
    boundaries: {
      bars5: {
        firstStart: protection.bars5.firstStart,
        lastEnd: protection.bars5.lastEnd,
      },
      bars60: {
        firstStart: protection.bars60.firstStart,
        lastEnd: protection.bars60.lastEnd,
      },
      mappings: {
        firstTradingDate: protection.mappings.firstTradingDate,
        lastTradingDate: protection.mappings.lastTradingDate,
      },
      rollovers: {
        firstTradingDate: protection.rollovers.firstTradingDate,
        lastTradingDate: protection.rollovers.lastTradingDate,
      },
    },
    bars5: protectedFiveMinuteValues(dataset.bars5, protection),
    bars60: protectedSixtyMinuteValues(dataset.bars60, protection),
    mappings: protectedMappingValues(
      dataset.mainContractMappings,
      protection,
    ),
    rollovers: protectedRolloverValues(dataset.rollovers, protection),
  };
}

export function benchmarkProtectionFingerprint(
  dataset: BenchmarkProtectionDataset,
  protection: MarketSnapshotBenchmarkProtection,
): string {
  return createHash('sha256')
    .update(JSON.stringify(benchmarkProtectionProjection(dataset, protection)))
    .digest('hex');
}

export function assertBenchmarkProtectionUnchanged(
  protection: MarketSnapshotBenchmarkProtection,
  before: BenchmarkProtectionDataset,
  after: BenchmarkProtectionDataset,
): void {
  if (!isDeepStrictEqual(
    protectedFiveMinuteValues(before.bars5, protection),
    protectedFiveMinuteValues(after.bars5, protection),
  )) {
    throw new Error('schema v7 尾部快照修改了受保护 5 分钟字段');
  }
  if (!isDeepStrictEqual(
    protectedSixtyMinuteValues(before.bars60, protection),
    protectedSixtyMinuteValues(after.bars60, protection),
  )) {
    throw new Error('schema v7 尾部快照修改了受保护 60 分钟数据');
  }
  if (!isDeepStrictEqual(
    protectedMappingValues(before.mainContractMappings, protection),
    protectedMappingValues(after.mainContractMappings, protection),
  )) {
    throw new Error('schema v7 尾部快照修改了受保护主力映射');
  }
  if (!isDeepStrictEqual(
    protectedRolloverValues(before.rollovers, protection),
    protectedRolloverValues(after.rollovers, protection),
  )) {
    throw new Error('schema v7 尾部快照修改了受保护换月记录');
  }
  if (benchmarkProtectionFingerprint(before, protection)
    !== benchmarkProtectionFingerprint(after, protection)) {
    throw new Error('schema v7 尾部快照保护指纹发生变化');
  }
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMBER_EQUALITY_EPSILON;
}

function sameBar(left: Bar, right: Bar): boolean {
  return left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.session === right.session
    && sameNumber(left.open, right.open)
    && sameNumber(left.high, right.high)
    && sameNumber(left.low, right.low)
    && sameNumber(left.close, right.close)
    && sameNumber(left.volume, right.volume)
    && sameNumber(left.openOi, right.openOi)
    && sameNumber(left.closeOi, right.closeOi)
    && left.observedMinutes === right.observedMinutes
    && left.expectedMinutes === right.expectedMinutes
    && left.complete === right.complete;
}

function replacementCounts(
  current: readonly Bar[],
  candidate: readonly Bar[],
): MergeBarsResult {
  const currentByStart = new Map(current.map(bar => [bar.startMs, bar]));
  const candidateByStart = new Map(candidate.map(bar => [bar.startMs, bar]));
  return {
    bars: [...candidate],
    added: candidate.filter(bar => !currentByStart.has(bar.startMs)).length,
    replaced: candidate.filter(bar => {
      const previous = currentByStart.get(bar.startMs);
      return previous !== undefined && !sameBar(previous, bar);
    }).length,
    removed: current.filter(bar => !candidateByStart.has(bar.startMs)).length,
  };
}

function sameMappings(
  left: readonly MainContractMapping[],
  right: readonly MainContractMapping[],
): boolean {
  return left.length === right.length && left.every((mapping, index) => (
    mapping.tradingDate === right[index]?.tradingDate
    && mapping.contract === right[index]?.contract
  ));
}

function sameRollover(
  left: ContractRollover,
  right: ContractRollover,
): boolean {
  return left.tradingDate === right.tradingDate
    && left.timeMs === right.timeMs
    && left.fromContract === right.fromContract
    && left.toContract === right.toContract;
}

function rolloverCounts(
  current: readonly ContractRollover[],
  next: readonly ContractRollover[],
): Pick<
  MarketUpdateCounts,
  'addedRollovers' | 'replacedRollovers' | 'removedRollovers'
> {
  const currentByDate = new Map(
    current.map(rollover => [rollover.tradingDate, rollover]),
  );
  const nextByDate = new Map(
    next.map(rollover => [rollover.tradingDate, rollover]),
  );
  return {
    addedRollovers: next.filter(
      rollover => !currentByDate.has(rollover.tradingDate),
    ).length,
    replacedRollovers: next.filter(rollover => {
      const previous = currentByDate.get(rollover.tradingDate);
      return previous !== undefined && !sameRollover(previous, rollover);
    }).length,
    removedRollovers: current.filter(
      rollover => !nextByDate.has(rollover.tradingDate),
    ).length,
  };
}

function preserveProtectedSixtyMinuteBars(
  current: readonly Bar[],
  rebuilt: readonly Bar[],
  protection: MarketSnapshotBenchmarkProtection,
): Bar[] {
  const firstStartMs = parseBeijing(protection.bars60.firstStart);
  const lastEndMs = parseBeijing(protection.bars60.lastEnd);
  const outside = rebuilt.filter(bar => (
    bar.startMs < firstStartMs || bar.endMs > lastEndMs
  ));
  const protectedBars = current.filter(bar => (
    bar.complete
    && bar.startMs >= firstStartMs
    && bar.endMs <= lastEndMs
  ));
  return [...outside, ...protectedBars].sort(
    (left, right) => left.startMs - right.startMs,
  );
}

function preserveProtectedRollovers(
  current: readonly ContractRollover[],
  rebuilt: readonly ContractRollover[],
  protection: MarketSnapshotBenchmarkProtection,
): ContractRollover[] {
  const outside = rebuilt.filter(rollover => (
    rollover.tradingDate < protection.rollovers.firstTradingDate
    || rollover.tradingDate > protection.rollovers.lastTradingDate
  ));
  const protectedRollovers = current.filter(rollover => (
    rollover.tradingDate >= protection.rollovers.firstTradingDate
    && rollover.tradingDate <= protection.rollovers.lastTradingDate
  ));
  return [...outside, ...protectedRollovers].sort(
    (left, right) => left.tradingDate.localeCompare(right.tradingDate),
  );
}

function protectedMappingAudit(
  current: readonly MainContractMapping[],
  remote: readonly MainContractMapping[],
  protection: MarketSnapshotBenchmarkProtection,
): BenchmarkProtectedMappingAudit {
  const currentByDate = new Map(
    current.map(mapping => [mapping.tradingDate, mapping]),
  );
  const protectedRemote = remote.filter(mapping => (
    mapping.tradingDate >= protection.mappings.firstTradingDate
    && mapping.tradingDate <= protection.mappings.lastTradingDate
  ));
  const differences = protectedRemote.flatMap(mapping => {
    const existing = currentByDate.get(mapping.tradingDate);
    if (existing?.contract === mapping.contract) return [];
    return [{
      tradingDate: mapping.tradingDate,
      protectedContract: existing?.contract ?? null,
      incomingContract: mapping.contract,
    }];
  });
  return {
    protectedRemoteRows: protectedRemote.length,
    matchingRows: protectedRemote.length - differences.length,
    differingRows: differences.length,
    differences,
  };
}

export function mergeBenchmarkProtectedMarketData(
  input: BenchmarkProtectionMergeInput,
): BenchmarkProtectionMergeResult {
  const {
    definition,
    current,
    incomingMinutes,
    remoteMappings = [],
    protection,
    rebuildStartMs,
    coverageEndMs,
  } = input;
  const minuteMerge = mergeMinuteHistory(current.bars1, incomingMinutes);
  const protectedTailStartMs = protection
    ? parseBeijing(protection.bars5.lastEnd)
    : Number.NEGATIVE_INFINITY;
  const visibleRebuildStartMs = Math.max(
    rebuildStartMs,
    protectedTailStartMs,
  );
  const rebuildMinutes = minuteMerge.records.filter(
    record => record.startMs >= visibleRebuildStartMs,
  );
  const rebuilt5 = aggregateMinutes(
    rebuildMinutes,
    5,
    coverageEndMs,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  const five = rebuilt5.length
    ? mergeBarsPreservingHistory(current.bars5, rebuilt5)
    : {
        bars: [...current.bars5],
        added: 0,
        replaced: 0,
        removed: 0,
      };
  assertBarsValid(five.bars, 5, definition.tradingSessions);

  const rebuilt60 = aggregateFiveMinuteBars(
    five.bars,
    definition.tradingSessions,
  ).filter(bar => bar.complete);
  const final60 = protection
    ? preserveProtectedSixtyMinuteBars(
        current.bars60,
        rebuilt60,
        protection,
      )
    : rebuilt60;
  const sixty = replacementCounts(current.bars60, final60);
  reconcileBars(five.bars, sixty.bars, definition.tradingSessions);

  const mappings = protection
    ? mergeMainContractMappings(
        current.mainContractMappings,
        remoteMappings.filter(mapping => (
          mapping.tradingDate > protection.mappings.lastTradingDate
        )),
        definition,
      )
    : mergeMainContractMappings(
        current.mainContractMappings,
        remoteMappings,
        definition,
      );
  const rebuiltRollovers = detectContractRollovers(
    mappings,
    five.bars,
    definition,
  );
  const rollovers = protection
    ? preserveProtectedRollovers(
        current.rollovers,
        rebuiltRollovers,
        protection,
      )
    : rebuiltRollovers;
  const counts = {
    ...updateCounts(minuteMerge, five, sixty),
    ...rolloverCounts(current.rollovers, rollovers),
  };

  if (!protection) {
    return {
      bars1: minuteMerge.records,
      bars5: five.bars,
      bars60: sixty.bars,
      mainContractMappings: mappings,
      rollovers,
      counts,
      mappingsChanged: !sameMappings(current.mainContractMappings, mappings),
    };
  }
  if (definition.id !== 'glass_main') {
    throw new Error('基准保护合并仅支持玻璃主连');
  }

  const candidate = {
    bars5: five.bars,
    bars60: sixty.bars,
    mainContractMappings: mappings,
    rollovers,
  };
  const beforeFingerprint = benchmarkProtectionFingerprint(
    current,
    protection,
  );
  assertBenchmarkProtectionUnchanged(protection, current, candidate);
  const afterFingerprint = benchmarkProtectionFingerprint(
    candidate,
    protection,
  );
  const minuteAudit = auditThsGlassMainMinuteProtection(
    minuteMerge.records,
    five.bars,
    sixty.bars,
    parseBeijing(protection.bars5.firstStart),
    protectedTailStartMs,
  );

  return {
    bars1: minuteMerge.records,
    bars5: five.bars,
    bars60: sixty.bars,
    mainContractMappings: mappings,
    rollovers,
    counts,
    mappingsChanged: !sameMappings(current.mainContractMappings, mappings),
    minuteReconciliation: minuteAudit.report,
    protectedMappingAudit: protectedMappingAudit(
      current.mainContractMappings,
      remoteMappings,
      protection,
    ),
    protectionFingerprint: {
      before: beforeFingerprint,
      after: afterFingerprint,
    },
  };
}
