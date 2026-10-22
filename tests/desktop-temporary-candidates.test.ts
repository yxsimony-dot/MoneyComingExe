import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateMinutes, parseEdbMinuteCsv } from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import {
  aggregateSparseDesktopFiveMinuteBars,
  assertCandidateOutputPath,
  atomicReplaceDirectory,
  candidatePeriodMetadata,
  candidateSourceLatestAt,
  normalizeEdbTailMappings,
  validateEdbTailCutover,
} from '../src/main/desktop-temporary-candidate-cli';
import { DEFAULT_INSTRUMENT } from '../src/shared/instruments';
import type { Bar, EdbMinuteRecord } from '../src/shared/types';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'moneycoming-desktop-candidate-'));
  temporaryDirectories.push(directory);
  return directory;
}

function minuteRecord(
  start: string,
  values: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    openOi: number;
    closeOi: number;
  },
): EdbMinuteRecord {
  const startMs = parseBeijing(start);
  return {
    datetimeNano: (BigInt(startMs) * 1_000_000n).toString(),
    startMs,
    start,
    ...values,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('desktop temporary candidates', () => {
  it('records the final bar end as the period coverage boundary', () => {
    const bar = {
      start: '2026-10-16 22:55:00',
      end: '2026-10-16 23:00:00',
      endMs: parseBeijing('2026-10-16 23:00:00'),
    } as Bar;

    expect(candidatePeriodMetadata([bar])).toEqual({
      first: '2026-10-16 22:55:00',
      last: '2026-10-16 23:00:00',
      rows: 1,
    });
    expect(candidateSourceLatestAt([bar])).toBe('2026-10-16 23:00:00');
  });

  it('aggregates sparse desktop trade minutes without inventing one-minute rows', () => {
    const records = [
      minuteRecord('2026-10-09 09:00:00', {
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1,
        openOi: 10,
        closeOi: 11,
      }),
      minuteRecord('2026-10-09 09:01:00', {
        open: 101,
        high: 104,
        low: 100,
        close: 103,
        volume: 2,
        openOi: 11,
        closeOi: 12,
      }),
      minuteRecord('2026-10-09 09:03:00', {
        open: 103,
        high: 106,
        low: 102,
        close: 105,
        volume: 3,
        openOi: 13,
        closeOi: 14,
      }),
      minuteRecord('2026-10-09 09:04:00', {
        open: 105,
        high: 107,
        low: 104,
        close: 106,
        volume: 4,
        openOi: 14,
        closeOi: 15,
      }),
    ];
    const original = structuredClone(records);

    const result = aggregateSparseDesktopFiveMinuteBars(
      records,
      parseBeijing('2026-10-09 09:05:00'),
      DEFAULT_INSTRUMENT.tradingSessions,
    );

    expect(records).toEqual(original);
    expect(records).toHaveLength(4);
    expect(result.bars).toMatchObject([{
      start: '2026-10-09 09:00:00',
      open: 100,
      high: 107,
      low: 99,
      close: 106,
      volume: 10,
      openOi: 10,
      closeOi: 15,
      observedMinutes: 5,
      expectedMinutes: 5,
      complete: true,
    }]);
    expect(result).toMatchObject({
      sourceMinuteRows: 4,
      fiveMinuteBars: 1,
      sparseFiveMinuteBars: 1,
      omittedMinutesWithinEmittedBars: 1,
      maximumOmittedMinutesPerBar: 1,
      syntheticOneMinuteRows: 0,
    });

    expect(aggregateMinutes(
      [...records],
      5,
      parseBeijing('2026-10-09 09:05:00'),
      DEFAULT_INSTRUMENT.tradingSessions,
    )).toMatchObject([{
      observedMinutes: 4,
      expectedMinutes: 5,
      complete: false,
    }]);
  });

  it('does not create a desktop five-minute bar when the entire bucket has no rows', () => {
    const records = [
      ...Array.from({ length: 5 }, (_, index) => minuteRecord(
        `2026-10-09 09:0${index}:00`,
        {
          open: 100 + index,
          high: 101 + index,
          low: 99 + index,
          close: 100 + index,
          volume: 1,
          openOi: 10 + index,
          closeOi: 10 + index,
        },
      )),
      ...Array.from({ length: 5 }, (_, index) => minuteRecord(
        `2026-10-09 09:1${index}:00`,
        {
          open: 110 + index,
          high: 111 + index,
          low: 109 + index,
          close: 110 + index,
          volume: 1,
          openOi: 20 + index,
          closeOi: 20 + index,
        },
      )),
    ];

    const result = aggregateSparseDesktopFiveMinuteBars(
      records,
      parseBeijing('2026-10-09 09:15:00'),
      DEFAULT_INSTRUMENT.tradingSessions,
    );

    expect(result.bars.map(bar => bar.start)).toEqual([
      '2026-10-09 09:00:00',
      '2026-10-09 09:10:00',
    ]);
    expect(result.bars.some(bar => bar.start === '2026-10-09 09:05:00')).toBe(false);
    expect(result.syntheticOneMinuteRows).toBe(0);
  });

  it('rejects any candidate output inside the repository or formal baseline', () => {
    const repository = 'C:\\workspace\\MoneyComing';
    const baseline = 'C:\\workspace\\MoneyComing\\data\\instruments';
    expect(() => assertCandidateOutputPath(
      'C:\\workspace\\MoneyComing\\candidate',
      repository,
      baseline,
    )).toThrow(/仓库之外/);
    expect(() => assertCandidateOutputPath(
      baseline,
      repository,
      baseline,
    )).toThrow();
    expect(() => assertCandidateOutputPath(
      'D:\\MoneyComing-temp\\desktop-candidates',
      repository,
      baseline,
    )).not.toThrow();
  });

  it('recognizes the audited day-to-night cutover without filling the session break', () => {
    const csv = [
      'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
      `${BigInt(parseBeijing('2026-10-14 21:00:00')) * 1_000_000n},1,1,1,1,1,1,1`,
      `${BigInt(parseBeijing('2026-10-14 21:01:00')) * 1_000_000n},1,1,1,1,1,1,1`,
    ].join('\n');
    const tail = parseEdbMinuteCsv(csv);
    expect(validateEdbTailCutover(
      parseBeijing('2026-10-14 14:59:00'),
      tail,
      {
        desktopLast: '2026-10-14 14:59:00',
        firstTail: '2026-10-14 21:00:00',
        lastTail: '2026-10-14 21:01:00',
        tailRows: 2,
      },
    )).toEqual({
      desktopLast: '2026-10-14 14:59:00',
      firstTail: '2026-10-14 21:00:00',
      lastTail: '2026-10-14 21:01:00',
      tailRows: 2,
      normalSessionBreak: true,
    });
  });

  it('records the source date and derived trading date for a trailing Friday night session', () => {
    const csv = [
      'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
      `${BigInt(parseBeijing('2026-10-16 21:00:00')) * 1_000_000n},1,1,1,1,1,1,1`,
      `${BigInt(parseBeijing('2026-10-16 21:01:00')) * 1_000_000n},1,1,1,1,1,1,1`,
    ].join('\n');
    const sourceMappings = [
      { tradingDate: '2026-10-15', contract: 'm2701' },
      { tradingDate: '2026-10-16', contract: 'm2701' },
    ];

    const normalized = normalizeEdbTailMappings(
      DEFAULT_INSTRUMENT,
      sourceMappings,
      parseEdbMinuteCsv(csv),
    );

    expect(sourceMappings).toHaveLength(2);
    expect(normalized.latestRepresentedTradingDate).toBe('2026-10-19');
    expect(normalized.mappings.at(-1)).toEqual({
      tradingDate: '2026-10-19',
      contract: 'm2701',
    });
    expect(normalized.derivedMappings).toEqual([{
      sourceMappingDate: '2026-10-16',
      nightNaturalDate: '2026-10-16',
      normalizedTradingDate: '2026-10-19',
      contract: 'm2701',
      reason: 'EDB 源映射采用自然日/已完成日线口径，尾部夜盘按项目交易日口径归入下一工作日',
    }]);
  });

  it('atomically replaces the temporary candidate directory', async () => {
    const root = await temporaryDirectory();
    const staging = join(root, '.staging');
    const target = join(root, 'desktop-candidates');
    await mkdir(staging);
    await mkdir(target);
    await writeFile(join(staging, 'new.txt'), 'new', 'utf8');
    await writeFile(join(target, 'old.txt'), 'old', 'utf8');

    await atomicReplaceDirectory(staging, target);

    await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
    await expect(readFile(join(target, 'old.txt'), 'utf8')).rejects.toThrow();
  });
});
