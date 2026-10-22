import type { Bar } from '../shared/types';
import {
  instrumentDefinition,
  type Instrument,
} from '../shared/instruments';
import { assertBarsValid } from './market-data';
import { formatBeijing } from './time';

export type HistoricalSegmentKind =
  | 'desktop-main'
  | 'public-history'
  | 'gap-fill'
  | 'edb-tail';

export interface HistoricalFiveMinuteSegment {
  sourceId: string;
  kind: HistoricalSegmentKind;
  instrumentId: Instrument;
  bars5: readonly Bar[];
}

export interface HistoricalSegmentConflictApproval {
  startMs: number;
  selectedSourceId: string;
  reason: string;
}

export type HistoricalSegmentComparedField =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'volume'
  | 'openOi'
  | 'closeOi'
  | 'session'
  | 'observedMinutes'
  | 'expectedMinutes'
  | 'complete';

export type HistoricalSegmentComparedValue = number | string | boolean;

export interface HistoricalSegmentFieldDifference {
  field: HistoricalSegmentComparedField;
  values: Array<{
    sourceId: string;
    value: HistoricalSegmentComparedValue;
  }>;
}

export interface HistoricalSegmentOverlapReport {
  startMs: number;
  start: string;
  sourceIds: string[];
  prioritySourceId: string;
  identical: boolean;
  differences: HistoricalSegmentFieldDifference[];
  resolution:
    | 'identical'
    | 'desktop-authority'
    | 'approved-priority'
    | 'blocked';
  selectedSourceId?: string;
  approvalReason?: string;
  blockingReason?: string;
}

export interface HistoricalSegmentMergeReport {
  schemaVersion: 1;
  instrumentId: Instrument;
  priorities: Array<{
    kind: HistoricalSegmentKind;
    priority: number;
  }>;
  sources: Array<{
    sourceId: string;
    kind: HistoricalSegmentKind;
    priority: number;
    rows: number;
    firstTimestamp: string;
    lastTimestamp: string;
  }>;
  overlaps: HistoricalSegmentOverlapReport[];
  desktopBoundary?: {
    sourceId: string;
    lastBarStart: string;
    lastMinuteCutoff: string;
    firstAppendedEdbBar?: string;
    ignoredEdbRows: number;
    ignoredEdbFirst?: string;
    ignoredEdbLast?: string;
    ignoredOverlapRows: number;
    ignoredEdbOnlyRows: number;
  };
  counts: {
    inputRows: number;
    uniqueTimestamps: number;
    overlapTimestamps: number;
    identicalOverlapTimestamps: number;
    conflictTimestamps: number;
    approvedConflictTimestamps: number;
    unresolvedConflictTimestamps: number;
    deduplicatedRows: number;
    outputRows: number;
  };
  activation: {
    allowed: boolean;
    violations: string[];
  };
}

export type HistoricalSegmentMergeResult =
  | {
      ok: true;
      bars5: Bar[];
      report: HistoricalSegmentMergeReport;
    }
  | {
      ok: false;
      bars5: [];
      report: HistoricalSegmentMergeReport;
    };

export const HISTORICAL_SEGMENT_PRIORITIES: Readonly<
Record<HistoricalSegmentKind, number>
> = {
  'public-history': 1,
  'gap-fill': 2,
  'edb-tail': 3,
  'desktop-main': 4,
};

const MINUTE_MS = 60_000;

const COMPARED_FIELDS: readonly HistoricalSegmentComparedField[] = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'openOi',
  'closeOi',
  'session',
  'observedMinutes',
  'expectedMinutes',
  'complete',
];

interface IndexedSegmentBar {
  sourceId: string;
  kind: HistoricalSegmentKind;
  priority: number;
  bar: Bar;
}

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function assertSegmentValid(
  segment: HistoricalFiveMinuteSegment,
  expectedInstrument: Instrument,
): void {
  assertNonEmpty(segment.sourceId, '分段来源 ID');
  if (segment.instrumentId !== expectedInstrument) {
    throw new Error('一次历史分段合并不得混入多个品种');
  }
  if (!segment.bars5.length) {
    throw new Error(`分段来源 ${segment.sourceId} 没有 5 分钟记录`);
  }
  const definition = instrumentDefinition(segment.instrumentId);
  assertBarsValid([...segment.bars5], 5, definition.tradingSessions);
  for (const bar of segment.bars5) {
    if (bar.start !== formatBeijing(bar.startMs)
      || bar.end !== formatBeijing(bar.endMs)) {
      throw new Error(`分段来源 ${segment.sourceId} 的时间字段不一致：${bar.start}`);
    }
  }
}

function indexedApprovals(
  approvals: readonly HistoricalSegmentConflictApproval[],
): Map<number, HistoricalSegmentConflictApproval> {
  const result = new Map<number, HistoricalSegmentConflictApproval>();
  for (const approval of approvals) {
    if (!Number.isSafeInteger(approval.startMs)) {
      throw new Error('冲突批准时间戳必须为安全整数');
    }
    const selectedSourceId = assertNonEmpty(
      approval.selectedSourceId,
      `${formatBeijing(approval.startMs)} 的冲突批准来源`,
    );
    const reason = assertNonEmpty(
      approval.reason,
      `${formatBeijing(approval.startMs)} 的冲突批准原因`,
    );
    if (result.has(approval.startMs)) {
      throw new Error(`冲突批准时间戳重复：${formatBeijing(approval.startMs)}`);
    }
    result.set(approval.startMs, {
      ...approval,
      selectedSourceId,
      reason,
    });
  }
  return result;
}

function comparedValue(
  bar: Bar,
  field: HistoricalSegmentComparedField,
): HistoricalSegmentComparedValue {
  return bar[field];
}

function differencesFor(entries: readonly IndexedSegmentBar[]): HistoricalSegmentFieldDifference[] {
  return COMPARED_FIELDS.flatMap(field => {
    const first = comparedValue(entries[0].bar, field);
    if (entries.every(entry => Object.is(comparedValue(entry.bar, field), first))) {
      return [];
    }
    return [{
      field,
      values: entries.map(entry => ({
        sourceId: entry.sourceId,
        value: comparedValue(entry.bar, field),
      })),
    }];
  });
}

function violationForConflict(
  start: string,
  sourceIds: readonly string[],
): string {
  return `${start} 存在未批准的分段来源冲突：${sourceIds.join('、')}`;
}

export function mergeHistoricalFiveMinuteSegments(
  segments: readonly HistoricalFiveMinuteSegment[],
  approvals: readonly HistoricalSegmentConflictApproval[] = [],
): HistoricalSegmentMergeResult {
  if (!segments.length) throw new Error('历史分段来源不能为空');
  const instrumentId = segments[0].instrumentId;
  const sourceIds = new Set<string>();
  const kinds = new Set<HistoricalSegmentKind>();
  for (const segment of segments) {
    assertSegmentValid(segment, instrumentId);
    const sourceId = segment.sourceId.trim();
    if (sourceIds.has(sourceId)) throw new Error(`分段来源 ID 重复：${sourceId}`);
    if (kinds.has(segment.kind)) throw new Error(`分段来源类型重复：${segment.kind}`);
    sourceIds.add(sourceId);
    kinds.add(segment.kind);
  }

  const approvalByStart = indexedApprovals(approvals);
  const usedApprovalStarts = new Set<number>();
  const barsByStart = new Map<number, IndexedSegmentBar[]>();
  const desktopSegment = segments.find(segment => segment.kind === 'desktop-main');
  const edbSegment = segments.find(segment => segment.kind === 'edb-tail');
  const desktopLastBar = desktopSegment?.bars5.at(-1);
  const desktopCutoffMs = desktopLastBar
    ? desktopLastBar.endMs - MINUTE_MS
    : undefined;
  const desktopStarts = new Set(
    desktopSegment?.bars5.map(bar => bar.startMs) ?? [],
  );
  const ignoredEdbBars: Bar[] = [];
  let ignoredOverlapRows = 0;
  let ignoredEdbOnlyRows = 0;
  for (const segment of segments) {
    const sourceId = segment.sourceId.trim();
    const priority = HISTORICAL_SEGMENT_PRIORITIES[segment.kind];
    for (const bar of segment.bars5) {
      if (
        segment.kind === 'edb-tail'
        && desktopCutoffMs !== undefined
        && bar.startMs <= desktopCutoffMs
      ) {
        ignoredEdbBars.push(bar);
        if (desktopStarts.has(bar.startMs)) {
          ignoredOverlapRows += 1;
        } else {
          ignoredEdbOnlyRows += 1;
          continue;
        }
      }
      const entries = barsByStart.get(bar.startMs) ?? [];
      entries.push({
        sourceId,
        kind: segment.kind,
        priority,
        bar,
      });
      barsByStart.set(bar.startMs, entries);
    }
  }

  const selectedBars: Bar[] = [];
  const overlaps: HistoricalSegmentOverlapReport[] = [];
  const violations: string[] = [];
  const sortedStarts = [...barsByStart.keys()].sort((left, right) => left - right);
  for (const startMs of sortedStarts) {
    const entries = barsByStart.get(startMs)!.sort((left, right) => (
      right.priority - left.priority
      || left.sourceId.localeCompare(right.sourceId)
    ));
    const priorityEntry = entries[0];
    if (entries.length === 1) {
      selectedBars.push(priorityEntry.bar);
      continue;
    }

    const start = formatBeijing(startMs);
    const differences = differencesFor(entries);
    const sourceIdsAtStart = entries.map(entry => entry.sourceId);
    if (!differences.length) {
      selectedBars.push(priorityEntry.bar);
      overlaps.push({
        startMs,
        start,
        sourceIds: sourceIdsAtStart,
        prioritySourceId: priorityEntry.sourceId,
        identical: true,
        differences,
        resolution: 'identical',
        selectedSourceId: priorityEntry.sourceId,
      });
      continue;
    }

    const desktopEntry = entries.find(entry => entry.kind === 'desktop-main');
    const edbEntry = entries.find(entry => entry.kind === 'edb-tail');
    if (
      desktopEntry
      && edbEntry
      && desktopCutoffMs !== undefined
      && startMs <= desktopCutoffMs
    ) {
      const approval = approvalByStart.get(startMs);
      if (approval) {
        usedApprovalStarts.add(startMs);
        if (approval.selectedSourceId !== desktopEntry.sourceId) {
          const blockingReason =
            `${start} 位于桌面主连权威区间，必须保留 ${desktopEntry.sourceId}`;
          violations.push(blockingReason);
          overlaps.push({
            startMs,
            start,
            sourceIds: sourceIdsAtStart,
            prioritySourceId: desktopEntry.sourceId,
            identical: false,
            differences,
            resolution: 'blocked',
            approvalReason: approval.reason,
            blockingReason,
          });
          continue;
        }
      }
      selectedBars.push(desktopEntry.bar);
      overlaps.push({
        startMs,
        start,
        sourceIds: sourceIdsAtStart,
        prioritySourceId: desktopEntry.sourceId,
        identical: false,
        differences,
        resolution: 'desktop-authority',
        selectedSourceId: desktopEntry.sourceId,
        approvalReason: approval?.reason,
      });
      continue;
    }

    const approval = approvalByStart.get(startMs);
    if (!approval) {
      const blockingReason = violationForConflict(start, sourceIdsAtStart);
      violations.push(blockingReason);
      overlaps.push({
        startMs,
        start,
        sourceIds: sourceIdsAtStart,
        prioritySourceId: priorityEntry.sourceId,
        identical: false,
        differences,
        resolution: 'blocked',
        blockingReason,
      });
      continue;
    }
    usedApprovalStarts.add(startMs);
    if (!sourceIdsAtStart.includes(approval.selectedSourceId)) {
      const blockingReason =
        `${start} 的冲突批准来源 ${approval.selectedSourceId} 不在重叠来源中`;
      violations.push(blockingReason);
      overlaps.push({
        startMs,
        start,
        sourceIds: sourceIdsAtStart,
        prioritySourceId: priorityEntry.sourceId,
        identical: false,
        differences,
        resolution: 'blocked',
        approvalReason: approval.reason,
        blockingReason,
      });
      continue;
    }
    if (approval.selectedSourceId !== priorityEntry.sourceId) {
      const blockingReason =
        `${start} 的冲突批准来源 ${approval.selectedSourceId}`
        + ` 不符合既定优先级，应为 ${priorityEntry.sourceId}`;
      violations.push(blockingReason);
      overlaps.push({
        startMs,
        start,
        sourceIds: sourceIdsAtStart,
        prioritySourceId: priorityEntry.sourceId,
        identical: false,
        differences,
        resolution: 'blocked',
        approvalReason: approval.reason,
        blockingReason,
      });
      continue;
    }

    selectedBars.push(priorityEntry.bar);
    overlaps.push({
      startMs,
      start,
      sourceIds: sourceIdsAtStart,
      prioritySourceId: priorityEntry.sourceId,
      identical: false,
      differences,
      resolution: 'approved-priority',
      selectedSourceId: priorityEntry.sourceId,
      approvalReason: approval.reason,
    });
  }

  for (const approval of approvalByStart.values()) {
    if (usedApprovalStarts.has(approval.startMs)) continue;
    violations.push(
      `${formatBeijing(approval.startMs)} 的冲突批准没有对应的不一致重叠记录`,
    );
  }

  const inputRows = segments.reduce((sum, segment) => sum + segment.bars5.length, 0);
  const conflictTimestamps = overlaps.filter(overlap => !overlap.identical).length;
  const approvedConflictTimestamps = overlaps.filter(
    overlap => overlap.resolution === 'approved-priority',
  ).length;
  const unresolvedConflictTimestamps = overlaps.filter(
    overlap => overlap.resolution === 'blocked',
  ).length;
  const allowed = violations.length === 0;
  if (allowed) {
    assertBarsValid(
      selectedBars,
      5,
      instrumentDefinition(instrumentId).tradingSessions,
    );
  }
  const report: HistoricalSegmentMergeReport = {
    schemaVersion: 1,
    instrumentId,
    priorities: (Object.entries(HISTORICAL_SEGMENT_PRIORITIES) as Array<
      [HistoricalSegmentKind, number]
    >).map(([kind, priority]) => ({ kind, priority })),
    sources: segments
      .map(segment => ({
        sourceId: segment.sourceId.trim(),
        kind: segment.kind,
        priority: HISTORICAL_SEGMENT_PRIORITIES[segment.kind],
        rows: segment.bars5.length,
        firstTimestamp: segment.bars5[0].start,
        lastTimestamp: segment.bars5.at(-1)!.start,
      }))
      .sort((left, right) => left.priority - right.priority),
    overlaps,
    desktopBoundary: desktopSegment && desktopLastBar && desktopCutoffMs !== undefined
      ? {
          sourceId: desktopSegment.sourceId.trim(),
          lastBarStart: desktopLastBar.start,
          lastMinuteCutoff: formatBeijing(desktopCutoffMs),
          firstAppendedEdbBar: edbSegment?.bars5.find(
            bar => bar.startMs > desktopCutoffMs,
          )?.start,
          ignoredEdbRows: ignoredEdbBars.length,
          ignoredEdbFirst: ignoredEdbBars[0]?.start,
          ignoredEdbLast: ignoredEdbBars.at(-1)?.start,
          ignoredOverlapRows,
          ignoredEdbOnlyRows,
        }
      : undefined,
    counts: {
      inputRows,
      uniqueTimestamps: barsByStart.size,
      overlapTimestamps: overlaps.length,
      identicalOverlapTimestamps: overlaps.filter(overlap => overlap.identical).length,
      conflictTimestamps,
      approvedConflictTimestamps,
      unresolvedConflictTimestamps,
      deduplicatedRows: inputRows - barsByStart.size,
      outputRows: allowed ? selectedBars.length : 0,
    },
    activation: {
      allowed,
      violations,
    },
  };

  return allowed
    ? { ok: true, bars5: selectedBars, report }
    : { ok: false, bars5: [], report };
}
