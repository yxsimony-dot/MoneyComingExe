import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Data scripts are executable ESM JavaScript modules.
import * as diagnostics from '../scripts/diagnose-modelscope-calibration.mjs';
const {
  classifyMismatchEvidence,
  decodeRawTickRows,
  parseDiagnosticArguments,
  summarizeTimestampOffsetMatrix,
} = diagnostics;

describe('ModelScope calibration diagnostics', () => {
  it('keeps diagnostic output inside the configured temporary root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moneycoming-calibration-'));
    const repositoryRoot = join(root, 'repository');
    const temporaryRoot = join(root, 'temporary');
    try {
      await Promise.all([
        mkdir(repositoryRoot, { recursive: true }),
        mkdir(temporaryRoot, { recursive: true }),
      ]);
      const output = join(temporaryRoot, 'diagnostics');
      const options = parseDiagnosticArguments([
        '--dates',
        '2025-11-07,2025-11-04,2025-11-07',
        '--output',
        output,
      ], {
        repositoryRoot,
        temporaryRoot,
      });

      expect(options).toMatchObject({
        dates: ['2025-11-04', '2025-11-07'],
        output,
        instrumentId: 'main_continuous',
        timestampOffsetsMs: [
          -1_000,
          -500,
          -250,
          -100,
          -50,
          0,
          50,
          100,
          250,
          500,
          1_000,
        ],
      });
      expect(() => parseDiagnosticArguments([
        '--output',
        join(repositoryRoot, 'diagnostics'),
      ], {
        repositoryRoot,
        temporaryRoot,
      })).toThrow(/临时根目录/);
      expect(() => parseDiagnosticArguments([
        '--output',
        join(repositoryRoot, 'diagnostics'),
      ], {
        repositoryRoot,
        temporaryRoot: root,
      })).toThrow(/项目仓库/);
      expect(parseDiagnosticArguments([
        '--instrument',
        'rebar_main',
        '--output',
        output,
      ], {
        repositoryRoot,
        temporaryRoot,
      }).instrumentId).toBe('rebar_main');
      expect(() => parseDiagnosticArguments([
        '--instrument',
        'unknown',
        '--output',
        output,
      ], {
        repositoryRoot,
        temporaryRoot,
      })).toThrow(/未知品种/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('decodes quoted GB18030 rows without changing source values', () => {
    const csv = [
      'TradingDay,InstrumentID,UpdateTime,UpdateMillisec,LastPrice,Volume,OpenInterest',
      '20251104,m2601,14:59:59,500,3033,12345,1600000',
      '20251104,m2601,15:00:00,0,"3034",12346,1599999',
    ].join('\n');
    const decoded = decodeRawTickRows(Buffer.from(csv, 'ascii'));

    expect(decoded.rows).toHaveLength(2);
    expect(decoded.rows[1]).toMatchObject({
      lineNumber: 3,
      values: {
        UpdateTime: '15:00:00',
        LastPrice: '3034',
        Volume: '12346',
        OpenInterest: '1599999',
      },
    });
  });

  it('distinguishes boundary price evidence from absent source prices', () => {
    const boundary = classifyMismatchEvidence({
      fields: ['close'],
      candidate: { close: 3043 },
      edb: { close: 3044 },
      startMs: 0,
      endMs: 300_000,
      ticks: [
        {
          timestampMs: 299_500,
          lastPrice: 3043,
          volumeDelta: 1,
          openInterest: 100,
          session: 'day',
        },
        {
          timestampMs: 300_000,
          lastPrice: 3044,
          volumeDelta: 1,
          openInterest: 101,
          session: 'day',
        },
      ],
      minutes: [],
    });
    const absentExtreme = classifyMismatchEvidence({
      fields: ['high'],
      candidate: { high: 3043 },
      edb: { high: 3045 },
      startMs: 0,
      endMs: 300_000,
      ticks: [
        {
          timestampMs: 1_000,
          lastPrice: 3043,
          volumeDelta: 1,
          openInterest: 100,
          session: 'day',
        },
      ],
      minutes: [],
    });

    expect(boundary.categories).toContain('bar-boundary-price-convention');
    expect(absentExtreme.categories).toContain('tick-source-price-difference');
  });

  it('identifies a near-boundary snapshot convention on both adjacent bars', () => {
    const ticks = [
      {
        timestampMs: 299_492,
        lastPrice: 3_044,
        volumeDelta: 15,
        openInterest: 1_605_152,
        session: 'day',
      },
      {
        timestampMs: 299_992,
        lastPrice: 3_043,
        volumeDelta: 1,
        openInterest: 1_605_151,
        session: 'day',
      },
      {
        timestampMs: 300_492,
        lastPrice: 3_043,
        volumeDelta: 11,
        openInterest: 1_605_148,
        session: 'day',
      },
    ];
    const closingBar = classifyMismatchEvidence({
      fields: ['close', 'volume', 'closeOi'],
      candidate: {
        close: 3_043,
        volume: 11_703,
        closeOi: 1_605_151,
      },
      edb: {
        close: 3_044,
        volume: 11_702,
        closeOi: 1_605_152,
      },
      startMs: 0,
      endMs: 300_000,
      ticks,
      minutes: [],
    });
    const openingBar = classifyMismatchEvidence({
      fields: ['open', 'volume', 'openOi'],
      candidate: {
        open: 3_043,
        volume: 16_374,
        openOi: 1_605_151,
      },
      edb: {
        open: 3_044,
        volume: 16_375,
        openOi: 1_605_152,
      },
      startMs: 300_000,
      endMs: 600_000,
      ticks,
      minutes: [],
    });

    expect(closingBar.categories).toEqual([
      'near-boundary-snapshot-convention',
    ]);
    expect(closingBar.nearBoundarySnapshotEvidence).toMatchObject({
      side: 'end',
      transferredVolume: 1,
      snapshotTick: { timestampMs: 299_492 },
      snapshotIntervalMs: 500,
      transferredTickBoundaryGapMs: 8,
    });
    expect(openingBar.categories).toEqual([
      'near-boundary-snapshot-convention',
    ]);
    expect(openingBar.nearBoundarySnapshotEvidence).toMatchObject({
      side: 'start',
      transferredVolume: 1,
      snapshotTick: { timestampMs: 299_492 },
      snapshotIntervalMs: 500,
      transferredTickBoundaryGapMs: 8,
    });
  });

  it('recognizes a near-boundary snapshot when only volume and open interest move', () => {
    const evidence = classifyMismatchEvidence({
      fields: ['volume', 'closeOi'],
      candidate: {
        volume: 63_537,
        closeOi: 1_606_065,
      },
      edb: {
        volume: 63_510,
        closeOi: 1_606_078,
      },
      startMs: 0,
      endMs: 300_000,
      ticks: [
        {
          timestampMs: 299_484,
          lastPrice: 3_046,
          volumeDelta: 59,
          openInterest: 1_606_078,
          session: 'day',
        },
        {
          timestampMs: 299_984,
          lastPrice: 3_046,
          volumeDelta: 27,
          openInterest: 1_606_065,
          session: 'day',
        },
      ],
      minutes: [],
    });

    expect(evidence.categories).toEqual([
      'near-boundary-snapshot-convention',
    ]);
    expect(evidence.nearBoundarySnapshotEvidence).toMatchObject({
      side: 'end',
      transferredVolume: 27,
      snapshotIntervalMs: 500,
      transferredTickBoundaryGapMs: 16,
    });
  });

  it('does not infer a snapshot convention by summing multiple late ticks', () => {
    const evidence = classifyMismatchEvidence({
      fields: ['volume', 'closeOi'],
      candidate: {
        volume: 103,
        closeOi: 102,
      },
      edb: {
        volume: 100,
        closeOi: 100,
      },
      startMs: 0,
      endMs: 300_000,
      ticks: [
        {
          timestampMs: 299_100,
          lastPrice: 3_044,
          volumeDelta: 5,
          openInterest: 100,
          session: 'day',
        },
        {
          timestampMs: 299_500,
          lastPrice: 3_044,
          volumeDelta: 1,
          openInterest: 101,
          session: 'day',
        },
        {
          timestampMs: 299_900,
          lastPrice: 3_044,
          volumeDelta: 2,
          openInterest: 102,
          session: 'day',
        },
      ],
      minutes: [],
    });

    expect(evidence.categories).not.toContain(
      'near-boundary-snapshot-convention',
    );
    expect(evidence.categories).toContain(
      'tick-source-volume-open-interest-difference',
    );
    expect(evidence.nearBoundarySnapshotEvidence).toBeNull();
  });

  it('keeps 0ms as best when a non-zero offset repairs local fields but adds new ones', () => {
    const matrix = summarizeTimestampOffsetMatrix([
      {
        offsetMs: 0,
        mismatches: [
          { tradingDate: '2025-11-04', start: '09:20', fields: ['close', 'volume'] },
          { tradingDate: '2025-11-06', start: '11:00', fields: ['close'] },
        ],
      },
      {
        offsetMs: 500,
        mismatches: [
          { tradingDate: '2025-11-04', start: '09:20', fields: ['volume'] },
          { tradingDate: '2025-11-06', start: '11:00', fields: ['close'] },
          { tradingDate: '2025-11-07', start: '09:00', fields: ['open', 'openOi'] },
        ],
      },
      {
        offsetMs: -50,
        mismatches: [
          { tradingDate: '2025-11-04', start: '09:20', fields: ['close', 'volume'] },
          { tradingDate: '2025-11-06', start: '11:00', fields: ['close', 'volume'] },
        ],
      },
    ]);

    expect(matrix).toMatchObject({
      bestOffsetMs: 0,
      zeroOffsetRemainsBest: true,
      fixedTimestampOffsetSupported: false,
    });
    expect(matrix.evaluations.find(
      (evaluation: { offsetMs: number }) => evaluation.offsetMs === 500,
    )).toMatchObject({
      repairedOriginalFieldMismatches: 1,
      introducedFieldMismatches: 2,
      eligibleAsGlobalFixedOffset: false,
    });
  });
});
