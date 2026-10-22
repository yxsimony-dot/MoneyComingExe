import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import { DEFAULT_INSTRUMENT } from '../src/shared/instruments';
import type { Bar } from '../src/shared/types';
// @ts-expect-error Data scripts are executable ESM JavaScript modules.
import * as candidateGenerator from '../scripts/generate-modelscope-temporary-candidates.mjs';
const {
  assertSafeOutputPath,
  atomicReplaceDirectory,
  buildReleaseDecision,
  calibrateAgainstEdb,
  generateTemporaryCandidates,
  hashDailyCacheRecord,
  loadOrCreateDailyCache,
  normalizeDailyRecordContinuity,
  parseArguments,
  prepareSourceContext,
  summarizeCalibration,
} = candidateGenerator;
// @ts-expect-error Probe scripts are executable ESM JavaScript modules.
import * as modelScopeProbe from '../scripts/probe-modelscope-tick-source.mjs';
const {
  INSTRUMENTS,
  REPOSITORY,
  parseTickCsv,
  ticksToMinutes,
} = modelScopeProbe;

const FIXED_NOW = new Date('2026-10-20T00:00:00.000Z');
const CONTRACT = 'm2601';

function fixtureDayBars(tradingDate: string): Bar[] {
  const daySession = DEFAULT_INSTRUMENT.tradingSessions.find(
    session => session.id === 'day',
  );
  if (!daySession) throw new Error('豆粕测试夹具缺少日盘交易时段');
  const dayStartMs = parseBeijing(`${tradingDate} 00:00:00`);
  const bars: Bar[] = [];
  let index = 0;
  for (const segment of daySession.segments) {
    for (let minute = segment.startMinute; minute < segment.endMinute; minute += 5) {
      const startMs = dayStartMs + minute * 60_000;
      const endMs = startMs + 5 * 60_000;
      const open = 3_000 + index;
      bars.push({
        startMs,
        endMs,
        start: formatBeijing(startMs),
        end: formatBeijing(endMs),
        session: 'day',
        open,
        high: open + 2,
        low: open - 1,
        close: open + 1,
        volume: 100 + index,
        openOi: 10_000 + index,
        closeOi: 10_001 + index,
        observedMinutes: 5,
        expectedMinutes: 5,
        complete: true,
      });
      index += 1;
    }
  }
  return bars;
}

function fixtureBar(
  start: string,
  session: 'day' | 'night',
  overrides: Partial<Bar> = {},
): Bar {
  const startMs = parseBeijing(start);
  const endMs = startMs + 5 * 60_000;
  return {
    startMs,
    endMs,
    start,
    end: formatBeijing(endMs),
    session,
    open: 3_000,
    high: 3_002,
    low: 2_999,
    close: 3_001,
    volume: 100,
    openOi: 10_000,
    closeOi: 10_001,
    observedMinutes: 5,
    expectedMinutes: 5,
    complete: true,
    ...overrides,
  };
}

function fixtureEntry(tradingDate: string) {
  return {
    name: `m2601_${tradingDate.replaceAll('-', '')}.csv`,
    crc32Hex: '1234abcd',
    compressedSize: 1_024,
    uncompressedSize: 4_096,
  };
}

function fixtureMapping(tradingDate: string) {
  return {
    tradingDate,
    instrumentId: 'main_continuous',
    status: 'mapped',
    contract: CONTRACT,
    concreteEntry: fixtureEntry(tradingDate),
    matchMethod: 'identical-stored-payload',
  };
}

function fixtureArchive() {
  return {
    name: '202510.zip',
    path: 'future/202510.zip',
    period: '202510',
    granularity: 'month',
    pointer: {
      sha256: 'a'.repeat(64),
      size: 1_000_000,
    },
  };
}

function fixtureExtraction(bars5: Bar[]) {
  return {
    rawSha256: 'b'.repeat(64),
    fields: [
      'TradingDay',
      'InstrumentID',
      'UpdateTime',
      'UpdateMillisec',
      'LastPrice',
      'Volume',
      'OpenInterest',
    ],
    tickStats: {
      sourceRows: bars5.length * 5,
      acceptedTicks: bars5.length * 5,
      filteredOutsideTradingSession: 0,
      invalidPriceRows: 0,
      tradingDayFieldMismatches: 0,
      tradingDayFieldUsesPreviousSessionDate: 0,
      observedTradingDayFields: { day: {}, night: {} },
      instrumentFieldMismatches: 0,
      duplicateTimestamps: 0,
      cumulativeVolumeResets: 0,
      sessionCloseTicksReassigned: 0,
      exactMinuteBoundarySnapshotsReassigned: 0,
    },
    minuteRecords: bars5.length * 5,
    bars5,
  };
}

function fixtureCacheContext(outputRoot: string, tradingDate = '2025-10-20') {
  return {
    outputRoot,
    instrument: INSTRUMENTS.find(
      (instrument: { id: string }) => instrument.id === 'main_continuous',
    ),
    tradingDate,
    previousTradingDate: '2025-10-17',
    mapping: fixtureMapping(tradingDate),
    archive: fixtureArchive(),
  };
}

describe('ModelScope temporary candidate generator', () => {
  it('assigns exact session-close ticks to the previous minute and advances volume anchors', () => {
    const header = [
      'TradingDay',
      'InstrumentID',
      'UpdateTime',
      'UpdateMillisec',
      'LastPrice',
      'Volume',
      'OpenInterest',
    ];
    const rows = [
      ['20251017', CONTRACT, '20:59:00', '6', '99', '5', '990'],
      ['20251017', CONTRACT, '21:00:00', '59', '100', '10', '1000'],
      ['20251017', CONTRACT, '22:59:59', '618', '105', '100', '1100'],
      ['20251017', CONTRACT, '23:00:00', '18', '106', '110', '1110'],
      ['20251020', CONTRACT, '08:59:00', '41', '106', '120', '1115'],
      ['20251020', CONTRACT, '09:00:00', '545', '107', '130', '1120'],
      ['20251020', CONTRACT, '10:14:59', '583', '108', '200', '1130'],
      ['20251020', CONTRACT, '10:15:00', '33', '109', '210', '1140'],
      ['20251020', CONTRACT, '10:30:00', '100', '115', '230', '1150'],
      ['20251020', CONTRACT, '10:31:00', '100', '116', '240', '1155'],
      ['20251020', CONTRACT, '11:29:59', '623', '116', '300', '1160'],
      ['20251020', CONTRACT, '11:30:00', '23', '117', '320', '1170'],
      ['20251020', CONTRACT, '13:30:00', '100', '118', '330', '1180'],
      ['20251020', CONTRACT, '14:59:59', '721', '119', '400', '1190'],
      ['20251020', CONTRACT, '15:00:00', '21', '120', '430', '1200'],
    ];
    const csv = `${header.join(',')}\n${rows.map(row => row.join(',')).join('\n')}\n`;
    const parsed = parseTickCsv(Buffer.from(csv, 'ascii'), {
      entryName: 'm2601_20251020.csv',
      tradingDate: '2025-10-20',
      previousTradingDate: '2025-10-17',
      contract: CONTRACT,
      exchange: 'DCE',
    });

    expect(parsed.stats).toMatchObject({
      acceptedTicks: 13,
      filteredOutsideTradingSession: 2,
      sessionCloseTicksReassigned: 4,
    });
    expect(parsed.ticks.filter(
      (tick: { timestampMs: number }) => (
        formatBeijing(tick.timestampMs).endsWith(':59')
        && tick.timestampMs % 1_000 === 999
      ),
    )).toHaveLength(4);

    const minutes = ticksToMinutes(parsed.ticks);
    const byStart = new Map(minutes.map(
      (minute: { startMs: number }) => [formatBeijing(minute.startMs), minute],
    ));
    expect([...byStart.keys()]).not.toEqual(expect.arrayContaining([
      '2025-10-17 23:00:00',
      '2025-10-20 10:15:00',
      '2025-10-20 11:30:00',
      '2025-10-20 15:00:00',
    ]));
    expect(byStart.get('2025-10-20 10:14:00')).toMatchObject({
      close: 109,
      volume: 80,
      closeOi: 1140,
    });
    expect(byStart.get('2025-10-20 10:30:00')).toMatchObject({
      open: 115,
      high: 115,
      low: 115,
      close: 115,
      volume: 20,
      openOi: 1140,
      closeOi: 1150,
    });
    expect(byStart.get('2025-10-20 10:31:00')).toMatchObject({
      open: 115,
      high: 116,
      low: 115,
      close: 116,
      volume: 10,
      openOi: 1150,
      closeOi: 1155,
    });
    expect(byStart.get('2025-10-20 13:30:00')).toMatchObject({
      open: 118,
      volume: 10,
      openOi: 1170,
    });
  });

  it('reassigns SHFE exact-minute snapshots but keeps DCE and CZCE half-open buckets', () => {
    const header = [
      'TradingDay',
      'InstrumentID',
      'UpdateTime',
      'UpdateMillisec',
      'LastPrice',
      'Volume',
      'OpenInterest',
    ];
    const rows = [
      ['20251107', 'rb2601', '09:04:59', '500', '3072', '100', '1910000'],
      ['20251107', 'rb2601', '09:05:00', '0', '3073', '113', '1910007'],
      ['20251107', 'rb2601', '09:05:00', '500', '3074', '120', '1910010'],
    ];
    const csv = `${header.join(',')}\n${rows.map(row => row.join(',')).join('\n')}\n`;
    const parseForExchange = (exchange: 'DCE' | 'CZCE' | 'SHFE') => (
      parseTickCsv(Buffer.from(csv, 'ascii'), {
        entryName: 'rb2601_20251107.csv',
        tradingDate: '2025-11-07',
        previousTradingDate: '2025-11-06',
        contract: 'rb2601',
        exchange,
      })
    );

    const shfe = parseForExchange('SHFE');
    const dce = parseForExchange('DCE');
    const czce = parseForExchange('CZCE');

    expect(shfe.stats.exactMinuteBoundarySnapshotsReassigned).toBe(1);
    expect(formatBeijing(shfe.ticks[1].timestampMs)).toBe('2025-11-07 09:04:59');
    expect(shfe.ticks[1].timestampMs % 1_000).toBe(999);
    expect(ticksToMinutes(shfe.ticks).map(
      (minute: { startMs: number; volume: number }) => ({
        start: formatBeijing(minute.startMs),
        volume: minute.volume,
      }),
    )).toEqual([
      { start: '2025-11-07 09:04:00', volume: 113 },
      { start: '2025-11-07 09:05:00', volume: 7 },
    ]);

    for (const parsed of [dce, czce]) {
      expect(parsed.stats.exactMinuteBoundarySnapshotsReassigned).toBe(0);
      expect(formatBeijing(parsed.ticks[1].timestampMs)).toBe(
        '2025-11-07 09:05:00',
      );
      expect(parsed.ticks[1].timestampMs % 1_000).toBe(0);
      expect(ticksToMinutes(parsed.ticks).map(
        (minute: { startMs: number; volume: number }) => ({
          start: formatBeijing(minute.startMs),
          volume: minute.volume,
        }),
      )).toEqual([
        { start: '2025-11-07 09:04:00', volume: 100 },
        { start: '2025-11-07 09:05:00', volume: 20 },
      ]);
    }
  });

  it('keeps SHFE session-opening exact-minute ticks in their current minute', () => {
    const header = [
      'TradingDay',
      'InstrumentID',
      'UpdateTime',
      'UpdateMillisec',
      'LastPrice',
      'Volume',
      'OpenInterest',
    ];
    const rows = [
      ['20251106', 'rb2601', '21:00:00', '0', '3060', '10', '1900000'],
      ['20251107', 'rb2601', '09:00:00', '0', '3070', '20', '1900100'],
      ['20251107', 'rb2601', '10:30:00', '0', '3075', '30', '1900200'],
      ['20251107', 'rb2601', '13:30:00', '0', '3080', '40', '1900300'],
    ];
    const csv = `${header.join(',')}\n${rows.map(row => row.join(',')).join('\n')}\n`;
    const parsed = parseTickCsv(Buffer.from(csv, 'ascii'), {
      entryName: 'rb2601_20251107.csv',
      tradingDate: '2025-11-07',
      previousTradingDate: '2025-11-06',
      contract: 'rb2601',
      exchange: 'SHFE',
    });

    expect(parsed.stats.exactMinuteBoundarySnapshotsReassigned).toBe(0);
    expect(parsed.ticks.map(
      (tick: { timestampMs: number }) => formatBeijing(tick.timestampMs),
    )).toEqual([
      '2025-11-06 21:00:00',
      '2025-11-07 09:00:00',
      '2025-11-07 10:30:00',
      '2025-11-07 13:30:00',
    ]);
  });

  it.each(['-1', '1000', '0.5'])(
    'rejects invalid UpdateMillisec values before assigning minute buckets: %s',
    updateMillisec => {
      const csv = [
        'TradingDay,InstrumentID,UpdateTime,UpdateMillisec,LastPrice,Volume,OpenInterest',
        `20251107,rb2601,09:05:00,${updateMillisec},3073,113,1910007`,
      ].join('\n');

      expect(() => parseTickCsv(Buffer.from(csv, 'ascii'), {
        entryName: 'rb2601_20251107.csv',
        tradingDate: '2025-11-07',
        previousTradingDate: '2025-11-06',
        contract: 'rb2601',
        exchange: 'SHFE',
      })).toThrow(/UpdateMillisec 必须是 0 至 999 的整数/);
    },
  );

  it('parses CLI options with an injected temporary root and rejects malformed options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-cli-'));
    try {
      const repositoryRoot = join(root, 'repository');
      const temporaryRoot = join(root, 'temporary');
      await Promise.all([
        mkdir(repositoryRoot, { recursive: true }),
        mkdir(temporaryRoot, { recursive: true }),
      ]);
      const output = join(temporaryRoot, 'custom-candidates');
      const options = parseArguments([
        '--probe',
        join(repositoryRoot, 'probe.json'),
        '--instrument',
        'main_continuous,main_continuous',
        '--start',
        '2025-10-17',
        '--end',
        '2025-10-20',
        '--output',
        output,
      ], { repositoryRoot, temporaryRoot });

      expect(options).toMatchObject({
        instrumentIds: ['main_continuous'],
        start: '2025-10-17',
        end: '2025-10-20',
        output,
        repositoryRoot,
        temporaryRoot,
        requireThreeYearCoverage: false,
      });
      expect(() => parseArguments(
        ['--probe'],
        { repositoryRoot, temporaryRoot },
      )).toThrow(/--probe 缺少参数值/);
      expect(() => parseArguments(
        ['--instrument', 'unknown'],
        { repositoryRoot, temporaryRoot },
      )).toThrow(/未知品种/);
      expect(() => parseArguments(
        ['--start', '2025-10-21', '--end', '2025-10-20'],
        { repositoryRoot, temporaryRoot },
      )).toThrow(/不得晚于/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects repository, data/instruments, and outside-temporary output paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-paths-'));
    try {
      const repositoryRoot = join(root, 'repository');
      const temporaryRoot = root;
      await mkdir(join(repositoryRoot, 'data', 'instruments'), { recursive: true });

      expect(() => assertSafeOutputPath(
        join(repositoryRoot, 'candidate'),
        { repositoryRoot, temporaryRoot },
      )).toThrow(/项目仓库/);
      expect(() => assertSafeOutputPath(
        join(repositoryRoot, 'data', 'instruments', 'candidate'),
        { repositoryRoot, temporaryRoot },
      )).toThrow(/data\/instruments/);
      expect(() => assertSafeOutputPath(
        join(root, '..', 'outside-candidate'),
        { repositoryRoot, temporaryRoot },
      )).toThrow(/临时根目录/);
      expect(() => assertSafeOutputPath(
        temporaryRoot,
        { repositoryRoot, temporaryRoot },
      )).toThrow(/临时根目录/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses a valid daily cache and regenerates a damaged cache', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-cache-'));
    let extractions = 0;
    const extractDailyCandidate = async () => {
      extractions += 1;
      return fixtureExtraction(fixtureDayBars('2025-10-20'));
    };
    try {
      const context = fixtureCacheContext(outputRoot);
      const first = await loadOrCreateDailyCache(context, {
        extractDailyCandidate,
        now: () => FIXED_NOW,
      });
      const second = await loadOrCreateDailyCache(context, {
        extractDailyCandidate,
        now: () => FIXED_NOW,
      });

      expect(first.status).toBe('generated');
      expect(second.status).toBe('reused');
      expect(extractions).toBe(1);
      expect(second.record.payloadSha256).toBe(first.record.payloadSha256);

      await writeFile(first.path, '{"damaged":true}\n', 'utf8');
      const regenerated = await loadOrCreateDailyCache(context, {
        extractDailyCandidate,
        now: () => FIXED_NOW,
      });
      expect(regenerated.status).toBe('generated');
      expect(extractions).toBe(2);
      expect(regenerated.record.instrumentId).toBe('main_continuous');
      expect(regenerated.record.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('regenerates an old cache schema even when its payload hash is valid', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-schema-'));
    let extractions = 0;
    const extractDailyCandidate = async () => {
      extractions += 1;
      return fixtureExtraction(fixtureDayBars('2025-10-20'));
    };
    try {
      const context = fixtureCacheContext(outputRoot);
      const current = await loadOrCreateDailyCache(context, {
        extractDailyCandidate,
        now: () => FIXED_NOW,
      });
      const oldRecord = {
        ...current.record,
        schemaVersion: 1,
        aggregationVersion: 'edb-minute-boundary-v1',
        importerVersion: 'modelscope-temporary-candidate-v1',
      };
      oldRecord.payloadSha256 = hashDailyCacheRecord(oldRecord);
      await writeFile(
        current.path,
        `${JSON.stringify(oldRecord, null, 2)}\n`,
        'utf8',
      );

      const regenerated = await loadOrCreateDailyCache(context, {
        extractDailyCandidate,
        now: () => FIXED_NOW,
      });
      expect(regenerated.status).toBe('generated');
      expect(extractions).toBe(2);
      expect(regenerated.record).toMatchObject({
        schemaVersion: 4,
        aggregationVersion: 'edb-minute-boundary-v4',
        importerVersion: 'modelscope-temporary-candidate-v4',
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('inherits only cross-day open interest while the concrete contract is unchanged', () => {
    const records = [
      {
        contract: 'm2609',
        payloadSha256: 'a'.repeat(64),
        bars5: [fixtureBar('2026-08-10 14:55:00', 'day', {
          close: 3_005,
          closeOi: 973_676,
        })],
      },
      {
        contract: 'm2609',
        payloadSha256: 'b'.repeat(64),
        bars5: [fixtureBar('2026-08-10 21:00:00', 'night', {
          open: 3_010,
          high: 3_012,
          low: 3_009,
          openOi: 1_000_000,
        })],
      },
      {
        contract: 'm2701',
        payloadSha256: 'c'.repeat(64),
        bars5: [fixtureBar('2026-08-11 09:00:00', 'day', {
          open: 3_100,
          high: 3_102,
          low: 3_099,
          openOi: 2_160_574,
        })],
      },
    ];

    const normalized = normalizeDailyRecordContinuity(records);

    expect(normalized[1].bars5[0]).toMatchObject({
      open: 3_010,
      high: 3_012,
      low: 3_009,
      openOi: 973_676,
    });
    expect(normalized[2].bars5[0]).toMatchObject({
      open: 3_100,
      high: 3_102,
      low: 3_099,
      openOi: 2_160_574,
    });
    expect(records[1].bars5[0]).toMatchObject({
      open: 3_010,
      low: 3_009,
      openOi: 1_000_000,
    });
    expect(records[1].payloadSha256).toBe('b'.repeat(64));
  });

  it('restores the previous candidate and removes staging after replacement failure', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-atomic-'));
    const target = join(parent, 'main_continuous');
    const staging = join(parent, '.staging-main_continuous-test');
    await Promise.all([
      mkdir(target),
      mkdir(staging),
    ]);
    await Promise.all([
      writeFile(join(target, 'marker.txt'), 'old', 'utf8'),
      writeFile(join(staging, 'marker.txt'), 'new', 'utf8'),
    ]);
    let renameCalls = 0;
    try {
      await expect(atomicReplaceDirectory(staging, target, {
        rename: async (source: string, destination: string) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('simulated replacement failure');
          await rename(source, destination);
        },
      })).rejects.toThrow(/simulated replacement failure/);

      expect(await readFile(join(target, 'marker.txt'), 'utf8')).toBe('old');
      await expect(access(staging)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(parent)).filter(name => name.startsWith('.backup-'))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('groups night bars by the next observed day session despite sparse EDB mappings', () => {
    const barsByTradingDate = new Map<string, Bar[]>([
      ['2025-10-10', [
        fixtureBar('2025-10-09 21:00:00', 'night'),
        fixtureBar('2025-10-10 09:00:00', 'day'),
      ]],
      ['2025-10-13', [
        fixtureBar('2025-10-10 21:00:00', 'night'),
        fixtureBar('2025-10-13 09:00:00', 'day'),
      ]],
      ['2025-10-20', [
        fixtureBar('2025-10-17 21:00:00', 'night'),
        fixtureBar('2025-10-20 09:00:00', 'day'),
      ]],
    ]);
    const candidateMappings = [...barsByTradingDate.keys()].map(tradingDate => ({
      tradingDate,
      contract: CONTRACT,
    }));
    const calibration = calibrateAgainstEdb(
      [...barsByTradingDate].map(([tradingDate, bars5]) => ({
        tradingDate,
        bars5,
      })),
      candidateMappings,
      {
        bars5: [...barsByTradingDate.values()].flat(),
        mappings: [
          { tradingDate: '2025-10-09', contract: CONTRACT },
          { tradingDate: '2025-10-20', contract: CONTRACT },
        ],
      },
      { requireThreeYearCoverage: false },
    );

    expect(calibration).toMatchObject({
      allowed: true,
      overlap: {
        days: 1,
        barTradingDays: 3,
        comparedBars: 6,
        firstBarTradingDate: '2025-10-10',
        lastBarTradingDate: '2025-10-20',
      },
      counts: {
        missingModelBars: 0,
        missingEdbBars: 0,
        barTradingDateMismatches: 0,
        barMismatchRows: 0,
      },
    });
  });

  it('checks missing bars only inside the shared first and last timestamp boundary', () => {
    const candidateRecords = [
      {
        tradingDate: '2025-10-09',
        bars5: [fixtureBar('2025-10-09 09:00:00', 'day')],
      },
      {
        tradingDate: '2025-10-10',
        bars5: [
          fixtureBar('2025-10-09 21:00:00', 'night'),
          fixtureBar('2025-10-10 09:00:00', 'day'),
        ],
      },
    ];
    const calibration = calibrateAgainstEdb(
      candidateRecords,
      [{ tradingDate: '2025-10-10', contract: CONTRACT }],
      {
        bars5: [
          fixtureBar('2025-10-09 21:00:00', 'night'),
          fixtureBar('2025-10-10 09:00:00', 'day'),
          fixtureBar('2025-10-10 21:00:00', 'night'),
          fixtureBar('2025-10-13 09:00:00', 'day'),
        ],
        mappings: [{ tradingDate: '2025-10-10', contract: CONTRACT }],
      },
      { requireThreeYearCoverage: false },
    );

    expect(calibration).toMatchObject({
      allowed: true,
      overlap: {
        firstBarStart: '2025-10-09 21:00:00',
        lastBarStart: '2025-10-10 09:00:00',
        candidateBarsInWindow: 2,
        edbBarsInWindow: 2,
        comparedBars: 2,
      },
      counts: {
        missingModelBars: 0,
        missingEdbBars: 0,
      },
    });
  });

  it('keeps strict zero tolerance and complete field-level mismatch details', () => {
    const edbBars = Array.from({ length: 101 }, (_, index) => {
      const startMs = parseBeijing('2025-10-20 00:00:00') + index * 5 * 60_000;
      return fixtureBar(formatBeijing(startMs), 'day');
    });
    const candidateBars = edbBars.map(bar => ({
      ...bar,
      open: bar.open + 0.25,
    }));
    const calibration = calibrateAgainstEdb(
      [{ tradingDate: '2025-10-20', bars5: candidateBars }],
      [{ tradingDate: '2025-10-20', contract: CONTRACT }],
      {
        bars5: edbBars,
        mappings: [{ tradingDate: '2025-10-20', contract: CONTRACT }],
      },
      { requireThreeYearCoverage: false },
    );

    expect(calibration.allowed).toBe(false);
    expect(calibration.thresholds.numericTolerance).toBe(0);
    expect(calibration.counts.barMismatchRows).toBe(101);
    expect(calibration.details.barMismatches).toHaveLength(101);
    expect(calibration.samples.barMismatches).toHaveLength(100);
    expect(calibration.fieldStatistics.open).toMatchObject({
      mismatchRows: 101,
      numericMismatchRows: 101,
      nonNumericMismatchRows: 0,
      absoluteDifference: {
        count: 101,
        minimum: 0.25,
        maximum: 0.25,
        buckets: { gt0Lte1: 101 },
      },
    });
    expect(calibration.fieldStatistics.high).toMatchObject({
      mismatchRows: 0,
      absoluteDifference: null,
    });
    expect(summarizeCalibration(calibration)).toMatchObject({
      allowed: false,
      overlap: {
        comparedBars: 101,
      },
      counts: {
        mappingMismatchDays: 0,
        missingModelBars: 0,
        missingEdbBars: 0,
        barTradingDateMismatches: 0,
        barMismatchRows: 101,
      },
      affectedTradingDateCount: 1,
      fieldMismatchRows: {
        open: 101,
        high: 0,
      },
      violations: ['OHLC/成交量/持仓量差异：101 根 5 分钟 K 线'],
    });
  });

  it('builds a short candidate from mocked archive extraction without release eligibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moneycoming-modelscope-candidate-'));
    const repositoryRoot = join(root, 'repository');
    const output = join(root, 'temporary', 'candidates');
    const tradingDates = ['2025-10-17', '2025-10-20'];
    const barsByDate = new Map(
      tradingDates.map(tradingDate => [tradingDate, fixtureDayBars(tradingDate)]),
    );
    const archive = fixtureArchive();
    const mappings = tradingDates.map(fixtureMapping);
    try {
      await mkdir(repositoryRoot, { recursive: true });
      const options = parseArguments([
        '--instrument',
        'main_continuous',
        '--start',
        tradingDates[0],
        '--end',
        tradingDates[1],
        '--output',
        output,
      ], {
        repositoryRoot,
        temporaryRoot: join(root, 'temporary'),
      });
      const sourceContext = await prepareSourceContext(options, {
        readProbeInventory: async () => ({
          reportPath: options.probe,
          capturedAt: '2026-10-20T00:00:00.000Z',
          commit: REPOSITORY.commit,
          normalizedManifestSha256: 'c'.repeat(64),
          firstArchivePeriod: archive.period,
          lastArchivePeriod: archive.period,
          archives: [archive],
        }),
        readCentralDirectory: async () => ({
          centralDirectory: { entryCount: mappings.length },
          entries: mappings.map(mapping => mapping.concreteEntry),
        }),
        analyzeArchiveEntries: () => ({
          path: archive.path,
          tradingDates,
          mappings,
        }),
        resolveSemanticMappings: async () => undefined,
        summarizeMappings: () => ({
          mappingByKey: new Map(
            mappings.map(mapping => [
              `${mapping.tradingDate}|${mapping.instrumentId}`,
              mapping,
            ]),
          ),
        }),
      });
      const normalizedBarsByDate = new Map<string, Bar[]>(
        normalizeDailyRecordContinuity(tradingDates.map(tradingDate => ({
          tradingDate,
          contract: CONTRACT,
          bars5: barsByDate.get(tradingDate),
        }))).map((record: { tradingDate: string; bars5: Bar[] }) => [
          record.tradingDate,
          record.bars5,
        ] as [string, Bar[]]),
      );
      const edbBars = normalizedBarsByDate.get('2025-10-20');
      if (!edbBars) throw new Error('缺少 EDB 测试夹具');
      const summary = await generateTemporaryCandidates(options, {
        sourceContext,
        now: () => FIXED_NOW,
        extractDailyCandidate: async (context: { tradingDate: string }) => {
          const bars = barsByDate.get(context.tradingDate);
          if (!bars) throw new Error(`缺少 ${context.tradingDate} 测试夹具`);
          return fixtureExtraction(bars);
        },
        readEdbBaseline: async () => ({
          bars5: edbBars,
          bars60: [],
          mappings: [{ tradingDate: '2025-10-20', contract: CONTRACT }],
          rollovers: [],
          metadata: {
            generatedAt: '2026-10-19T02:04:38.581Z',
            sourceLatestAt: edbBars.at(-1)?.end,
          },
          rawFiles: [{
            name: 'edb_main_continuous_5m.csv',
            sha256: 'd'.repeat(64),
            rows: edbBars.length,
          }],
        }),
      });

      expect(summary).toMatchObject({
        schemaVersion: 2,
        counts: { requested: 1, succeeded: 1, failed: 0 },
        allTechnicalCandidatesPassed: true,
        calibrationTotals: {
          instrumentsReported: 1,
          comparedBars: 45,
          barMismatchRows: 0,
        },
        releaseEligible: false,
      });
      expect(summary.instruments[0]).toMatchObject({
        instrumentId: 'main_continuous',
        status: 'succeeded',
        technicalPassed: true,
        releaseEligible: false,
        calibration: {
          allowed: true,
          overlap: { comparedBars: 45 },
          counts: { barMismatchRows: 0 },
        },
      });
      const candidateDirectory = join(output, 'main_continuous');
      const metadata = JSON.parse(
        await readFile(join(candidateDirectory, 'metadata.json'), 'utf8'),
      );
      const technicalReport = JSON.parse(
        await readFile(
          join(candidateDirectory, 'technical-validation-report.json'),
          'utf8',
        ),
      );
      expect(metadata).toMatchObject({
        schemaVersion: 5,
        releaseEligible: false,
        redistribution: { allowed: false },
        periods: {
          bars5: {
            first: '2025-10-17 09:00:00',
            last: '2025-10-20 15:00:00',
            rows: 90,
          },
        },
      });
      expect(technicalReport).toMatchObject({
        technicalPassed: true,
        releaseEligible: false,
        cache: { generated: 2, reused: 0 },
        calibration: {
          allowed: true,
          overlap: { days: 1, comparedBars: 45 },
        },
        merge: {
          modelScopeContributedBars5: 45,
          edbTailBars5: 45,
          outputBars5: 90,
          edbTailPriority: true,
        },
      });
      expect(await readdir(candidateDirectory)).toEqual([
        'edb_main_continuous_5m.csv',
        'edb_main_continuous_60m.csv',
        'edb_main_continuous_rollovers.csv',
        'edb_main_contract_mapping.csv',
        'metadata.json',
        'technical-validation-report.json',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('always blocks release and baseline replacement for ModelScope candidates', () => {
    expect(buildReleaseDecision()).toMatchObject({
      technicalCandidateOnly: true,
      redistributionPermissionConfirmed: false,
      baselineReplacementAllowed: false,
      releaseEligible: false,
    });
  });
});
