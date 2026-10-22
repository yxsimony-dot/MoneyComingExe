import { describe, expect, it } from 'vitest';
import {
  mergeHistoricalFiveMinuteSegments,
  type HistoricalFiveMinuteSegment,
} from '../src/domain/historical-segment-merge';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import type { Bar } from '../src/shared/types';

function bar(start: string, overrides: Partial<Bar> = {}): Bar {
  const startMs = parseBeijing(start);
  const endMs = startMs + 5 * 60_000;
  return {
    startMs,
    endMs,
    start,
    end: formatBeijing(endMs),
    open: 3_000,
    high: 3_010,
    low: 2_990,
    close: 3_005,
    volume: 100,
    openOi: 1_000,
    closeOi: 1_010,
    session: start.slice(11, 13) === '21' ? 'night' : 'day',
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
    ...overrides,
  };
}

function segment(
  sourceId: string,
  kind: HistoricalFiveMinuteSegment['kind'],
  bars5: Bar[],
): HistoricalFiveMinuteSegment {
  return {
    sourceId,
    kind,
    instrumentId: 'main_continuous',
    bars5,
  };
}

describe('historical five-minute segment merging', () => {
  it('reports overlaps and automatically deduplicates fully identical records', () => {
    const publicBar = bar('2025-06-30 14:55:00');
    const gapBar = bar('2025-06-30 14:55:00');
    const result = mergeHistoricalFiveMinuteSegments([
      segment('public-archive', 'public-history', [publicBar]),
      segment('licensed-gap', 'gap-fill', [
        gapBar,
        bar('2025-07-01 09:00:00', { close: 3_006 }),
      ]),
      segment('edb-current', 'edb-tail', [
        bar('2025-10-20 09:00:00', { high: 3_110, close: 3_100 }),
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected successful segment merge');
    expect(result.bars5.map(item => item.start)).toEqual([
      '2025-06-30 14:55:00',
      '2025-07-01 09:00:00',
      '2025-10-20 09:00:00',
    ]);
    expect(result.bars5[0]).toBe(gapBar);
    expect(result.report.overlaps).toEqual([
      expect.objectContaining({
        start: '2025-06-30 14:55:00',
        sourceIds: ['licensed-gap', 'public-archive'],
        prioritySourceId: 'licensed-gap',
        identical: true,
        differences: [],
        resolution: 'identical',
        selectedSourceId: 'licensed-gap',
      }),
    ]);
    expect(result.report.counts).toEqual({
      inputRows: 4,
      uniqueTimestamps: 3,
      overlapTimestamps: 1,
      identicalOverlapTimestamps: 1,
      conflictTimestamps: 0,
      approvedConflictTimestamps: 0,
      unresolvedConflictTimestamps: 0,
      deduplicatedRows: 1,
      outputRows: 3,
    });
  });

  it('blocks activation and reports differing market and completeness fields', () => {
    const start = '2025-10-20 09:00:00';
    const startMs = parseBeijing(start);
    const result = mergeHistoricalFiveMinuteSegments([
      segment('licensed-gap', 'gap-fill', [bar(start)]),
      segment('edb-current', 'edb-tail', [bar(start, {
        open: 3_001,
        high: 3_011,
        low: 2_991,
        close: 3_006,
        volume: 101,
        openOi: 1_001,
        closeOi: 1_011,
        observedMinutes: 4,
        complete: false,
      })]),
    ]);

    expect(result.ok).toBe(false);
    expect(result.bars5).toEqual([]);
    expect(result.report.activation.allowed).toBe(false);
    expect(result.report.activation.violations).toEqual([
      '2025-10-20 09:00:00 存在未批准的分段来源冲突：edb-current、licensed-gap',
    ]);
    expect(result.report.overlaps[0]).toMatchObject({
      startMs,
      prioritySourceId: 'edb-current',
      identical: false,
      resolution: 'blocked',
    });
    expect(result.report.overlaps[0].differences.map(difference => difference.field)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'volume',
      'openOi',
      'closeOi',
      'observedMinutes',
      'complete',
    ]);
    expect(result.report.overlaps[0].differences[3].values).toEqual([
      { sourceId: 'edb-current', value: 3_006 },
      { sourceId: 'licensed-gap', value: 3_005 },
    ]);
  });

  it('uses the confirmed priority only after an explicit conflict approval', () => {
    const start = '2025-10-20 09:00:00';
    const startMs = parseBeijing(start);
    const edbBar = bar(start, { close: 3_006 });
    const result = mergeHistoricalFiveMinuteSegments([
      segment('public-archive', 'public-history', [bar(start, { close: 3_004 })]),
      segment('licensed-gap', 'gap-fill', [bar(start)]),
      segment('edb-current', 'edb-tail', [edbBar]),
    ], [{
      startMs,
      selectedSourceId: 'edb-current',
      reason: 'EDB 尾部已经通过同交易日主连映射校准',
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected approved segment merge');
    expect(result.bars5).toEqual([edbBar]);
    expect(result.report.overlaps[0]).toMatchObject({
      resolution: 'approved-priority',
      selectedSourceId: 'edb-current',
      approvalReason: 'EDB 尾部已经通过同交易日主连映射校准',
    });
    expect(result.report.counts.approvedConflictTimestamps).toBe(1);
  });

  it('preserves desktop bars and only appends EDB bars after the last desktop minute', () => {
    const firstDesktopBar = bar('2022-01-04 09:00:00', { close: 3_001 });
    const lastDesktopBar = bar('2026-10-14 14:55:00', { close: 3_001 });
    const overlappingEdbBar = bar('2026-10-14 14:55:00', {
      open: 3_002,
      close: 3_003,
    });
    const firstAppendedEdbBar = bar('2026-10-14 21:00:00', { close: 3_010 });
    const result = mergeHistoricalFiveMinuteSegments([
      segment('desktop-authority', 'desktop-main', [
        firstDesktopBar,
        lastDesktopBar,
      ]),
      segment('edb-current', 'edb-tail', [
        bar('2026-10-14 14:50:00', { close: 2_999 }),
        overlappingEdbBar,
        firstAppendedEdbBar,
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected desktop authority merge');
    expect(result.bars5).toEqual([
      firstDesktopBar,
      lastDesktopBar,
      firstAppendedEdbBar,
    ]);
    expect(result.bars5[0]).toBe(firstDesktopBar);
    expect(result.bars5[1]).toBe(lastDesktopBar);
    expect(result.report.overlaps).toEqual([
      expect.objectContaining({
        start: '2026-10-14 14:55:00',
        prioritySourceId: 'desktop-authority',
        resolution: 'desktop-authority',
        selectedSourceId: 'desktop-authority',
        identical: false,
      }),
    ]);
    expect(result.report.desktopBoundary).toEqual({
      sourceId: 'desktop-authority',
      lastBarStart: '2026-10-14 14:55:00',
      lastMinuteCutoff: '2026-10-14 14:59:00',
      firstAppendedEdbBar: '2026-10-14 21:00:00',
      ignoredEdbRows: 2,
      ignoredEdbFirst: '2026-10-14 14:50:00',
      ignoredEdbLast: '2026-10-14 14:55:00',
      ignoredOverlapRows: 1,
      ignoredEdbOnlyRows: 1,
    });
  });

  it('keeps the earliest desktop history when the merge is rerun', () => {
    const earliest = bar('2010-01-04 09:00:00', { close: 3_001 });
    const desktopLast = bar('2026-10-14 14:55:00', { close: 3_000 });
    const firstRun = mergeHistoricalFiveMinuteSegments([
      segment('desktop-authority', 'desktop-main', [earliest, desktopLast]),
      segment('edb-current', 'edb-tail', [
        bar('2026-10-14 21:00:00', { high: 3_020, close: 3_010 }),
      ]),
    ]);
    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) throw new Error('Expected first merge to succeed');

    const rerun = mergeHistoricalFiveMinuteSegments([
      segment('desktop-authority', 'desktop-main', firstRun.bars5),
      segment('edb-current', 'edb-tail', [
        bar('2026-10-14 21:00:00', { high: 3_020, close: 3_011 }),
        bar('2026-10-14 21:05:00', { high: 3_020, close: 3_012 }),
      ]),
    ]);

    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('Expected rerun to succeed');
    expect(rerun.bars5[0]).toBe(earliest);
    expect(rerun.bars5.map(item => item.start)).toEqual([
      '2010-01-04 09:00:00',
      '2026-10-14 14:55:00',
      '2026-10-14 21:00:00',
      '2026-10-14 21:05:00',
    ]);
  });

  it('rejects an approval that attempts to override the confirmed priority', () => {
    const start = '2025-10-20 09:00:00';
    const result = mergeHistoricalFiveMinuteSegments([
      segment('licensed-gap', 'gap-fill', [bar(start)]),
      segment('edb-current', 'edb-tail', [bar(start, { close: 3_006 })]),
    ], [{
      startMs: parseBeijing(start),
      selectedSourceId: 'licensed-gap',
      reason: '人工选择较低优先级来源',
    }]);

    expect(result.ok).toBe(false);
    expect(result.report.activation.violations).toEqual([
      '2025-10-20 09:00:00 的冲突批准来源 licensed-gap'
      + ' 不符合既定优先级，应为 edb-current',
    ]);
  });

  it('rejects duplicate source roles and malformed source bars', () => {
    expect(() => mergeHistoricalFiveMinuteSegments([
      segment('public-a', 'public-history', [bar('2025-06-30 09:00:00')]),
      segment('public-b', 'public-history', [bar('2025-06-30 09:05:00')]),
    ])).toThrow(/分段来源类型重复/);

    expect(() => mergeHistoricalFiveMinuteSegments([
      segment('public-a', 'public-history', [
        bar('2025-06-30 09:00:00', { start: '错误时间' }),
      ]),
    ])).toThrow(/时间字段不一致/);
  });
});
