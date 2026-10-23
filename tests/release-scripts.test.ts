import { readFile, readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import { validateMarketBaselines } from '../src/main/baseline-validator';
import {
  writeBuiltinMarketSnapshot,
  type MarketDataPaths,
} from '../src/main/market-snapshot';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../src/shared/instruments';
import type { Bar } from '../src/shared/types';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { prepareRelease } from '../scripts/prepare-release.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { credentialMatches } from '../scripts/verify-credentials.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { validateTagVersion } from '../scripts/verify-tag-version.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { resolveAutomaticReleaseVersion } from '../scripts/resolve-automatic-release-version.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import * as verifyRelease from '../scripts/verify-release.mjs';

const {
  PACKAGED_USAGE_GUIDE,
  REQUIRED_DATA,
  REQUIRED_INSTRUMENT_FILES,
  validatePackagedData,
  validatePackagedDataDirectory,
  validateUsageGuide,
} = verifyRelease;

const MINUTE_MS = 60_000;
const CALENDAR_DAY_MS = 24 * 60 * MINUTE_MS;

function fixtureWeekdays(first: string, last: string): string[] {
  const firstMs = Date.parse(`${first}T00:00:00Z`);
  const lastMs = Date.parse(`${last}T00:00:00Z`);
  const dates: string[] = [];
  for (let currentMs = firstMs; currentMs <= lastMs; currentMs += CALENDAR_DAY_MS) {
    const current = new Date(currentMs);
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(current.toISOString().slice(0, 10));
    }
  }
  return dates;
}

function evenlySpacedDates(dates: readonly string[], count: number): string[] {
  if (count < 2 || dates.length < count) throw new Error('交易日夹具数量无效');
  return Array.from({ length: count }, (_, index) => (
    dates[Math.round(index * (dates.length - 1) / (count - 1))]
  ));
}

function fixtureFiveMinuteBars(
  definition: InstrumentDefinition,
  tradingDates: readonly string[],
  priceOffset: number,
): Bar[] {
  const daySession = definition.tradingSessions.find(session => session.id === 'day');
  if (!daySession) throw new Error(`${definition.name} 缺少日盘交易时段`);
  const bars: Bar[] = [];
  for (const [dateIndex, tradingDate] of tradingDates.entries()) {
    const dayStartMs = parseBeijing(`${tradingDate} 00:00:00`);
    for (const segment of daySession.segments) {
      for (let minute = segment.startMinute; minute < segment.endMinute; minute += 5) {
        const startMs = dayStartMs + minute * MINUTE_MS;
        const expectedMinutes = Math.min(5, segment.endMinute - minute);
        const endMs = startMs + expectedMinutes * MINUTE_MS;
        const open = 2_500 + priceOffset + dateIndex + minute / 5;
        bars.push({
          startMs,
          endMs,
          start: formatBeijing(startMs),
          end: formatBeijing(endMs),
          open,
          high: open + 2,
          low: open - 1,
          close: open + 1,
          volume: 100 + dateIndex,
          openOi: 10_000 + dateIndex,
          closeOi: 10_001 + dateIndex,
          session: 'day',
          observedMinutes: expectedMinutes,
          expectedMinutes,
          complete: true,
        });
      }
    }
  }
  return bars;
}

function fixtureContract(definition: InstrumentDefinition): string {
  const month = definition.contractCode.candidateMonths[0];
  const monthText = String(month).padStart(2, '0');
  const expiry = definition.contractCode.expiryDigits === 3
    ? `4${monthText}`
    : `24${monthText}`;
  return `${definition.productCode}${expiry}`;
}

async function writeSchemaFiveReleaseFixture(
  dataDirectory: string,
): Promise<void> {
  const paths: MarketDataPaths = {
    builtinDataDirectory: dataDirectory,
    marketDataDirectory: join(dataDirectory, '..', 'user-data'),
  };
  const tradingDates = evenlySpacedDates(
    fixtureWeekdays('2023-10-20', '2026-10-20'),
    600,
  );
  const barsBySchedule = new Map<string, Bar[]>();

  for (const [instrumentIndex, definition] of INSTRUMENT_LIST.entries()) {
    const scheduleKey = JSON.stringify(definition.tradingSessions);
    let bars5 = barsBySchedule.get(scheduleKey);
    if (!bars5) {
      bars5 = fixtureFiveMinuteBars(
        definition,
        tradingDates,
        instrumentIndex * 1_000,
      );
      barsBySchedule.set(scheduleKey, bars5);
    }
    const contract = fixtureContract(definition);
    await writeBuiltinMarketSnapshot(
      paths,
      definition,
      {
        bars1: [],
        bars5,
        bars60: [],
        mainContractMappings: tradingDates.map(tradingDate => ({ tradingDate, contract })),
        rollovers: [],
        requestStart: bars5[0].start,
        requestEnd: bars5.at(-1)!.end,
        sourceLatestAt: bars5.at(-1)!.end,
        sourceSegments: [{
          sourceId: `fixture-${definition.id}`,
          sourceName: '发布校验测试夹具',
          kind: 'test-fixture',
          acquiredAt: '2026-10-20T00:00:00.000Z',
          coverage: {
            first: bars5[0].start,
            last: bars5.at(-1)!.end,
          },
          rawFiles: [{
            name: `${definition.id}-fixture.csv`,
            sha256: 'a'.repeat(64),
            rows: bars5.length,
          }],
          importerVersion: 'release-validation-test-v1',
          license: {
            redistributionAllowed: true,
            conclusion: '测试夹具允许再分发',
          },
        }],
      },
      { now: () => new Date('2026-10-20T00:00:00.000Z') },
    );
  }

  const validationReport = await validateMarketBaselines({
    paths,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });
  const validationById = new Map(
    validationReport.instruments.map(item => [item.instrumentId, item]),
  );
  const baselineReport = {
    schemaVersion: 1,
    generatedAt: '2026-10-20T00:00:00.000Z',
    instruments: INSTRUMENT_LIST.map(definition => {
      const validated = validationById.get(definition.id)!;
      return {
        instrumentId: definition.id,
        name: definition.name,
        mainSymbol: definition.mainSymbol,
        status: 'succeeded',
        firstMinute: validated.firstMinute,
        lastMinute: validated.lastMinute,
        sourceLatestAt: validated.sourceLatestAt,
        minuteRows: validated.minuteRows,
        fiveMinuteRows: validated.fiveMinuteRows,
        sixtyMinuteRows: validated.sixtyMinuteRows,
        mappingRows: validated.mappingRows,
        rolloverRows: validated.rolloverRows,
        periods: validated.periods,
        sourceSegments: validated.sourceSegments,
        redistribution: validated.redistribution,
      };
    }),
  };
  await Promise.all([
    writeFile(
      join(dataDirectory, 'baseline-validation-report.json'),
      `${JSON.stringify(validationReport, null, 2)}\n`,
    ),
    writeFile(
      join(dataDirectory, 'baseline-report.json'),
      `${JSON.stringify(baselineReport, null, 2)}\n`,
    ),
  ]);
}

describe('release validation scripts', () => {
  it('derives one stable update version from every main workflow run', () => {
    expect(resolveAutomaticReleaseVersion({
      packageVersion: '1.0.9',
      latestTag: 'v1.0.8',
      runNumber: 11,
      baseRunNumber: 11,
    })).toEqual({ version: '1.0.9', tag: 'v1.0.9' });
    expect(resolveAutomaticReleaseVersion({
      packageVersion: '1.0.9',
      latestTag: 'v1.0.9',
      runNumber: 12,
      baseRunNumber: 11,
    })).toEqual({ version: '1.0.10', tag: 'v1.0.10' });
    expect(() => resolveAutomaticReleaseVersion({
      packageVersion: '1.0.9',
      latestTag: 'v1.0.10',
      runNumber: 11,
      baseRunNumber: 11,
    })).toThrow(/not newer/);
  });

  it('accepts only a stable v<semver> tag matching package.json', () => {
    expect(validateTagVersion('v1.2.3', '1.2.3')).toBe('1.2.3');
    expect(() => validateTagVersion('v1.2.4', '1.2.3')).toThrow();
    expect(() => validateTagVersion('release-1.2.3', '1.2.3')).toThrow(/v<semver>/);
    expect(() => validateTagVersion('v1.2.3-beta.1', '1.2.3-beta.1')).toThrow();
  });

  it('detects real-shape GitHub credentials without flagging short test placeholders', () => {
    expect(credentialMatches(Buffer.from('ghp_abcdefghijklmnop'))).toEqual([]);
    expect(credentialMatches(Buffer.from(`ghp_${'a'.repeat(36)}`))).toEqual(['ghp_aaaaaaaa']);
    expect(credentialMatches(Buffer.from('artifact-secret'), ['artifact-secret'])).toHaveLength(1);
  });

  it('packages exactly the required market-data baselines without copying release history', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const marketData = manifest.build.extraFiles.find(
      (entry: { from?: string }) => entry.from === 'data',
    );
    expect(marketData?.filter).toEqual([
      'instruments/**/*',
      'baseline-report.json',
      'baseline-validation-report.json',
    ]);
    expect(manifest.build.extraFiles).toContainEqual({
      from: 'futures_investigation_20261009/entry-rules.md',
      to: 'data/entry-rules.md',
    });
    expect(manifest.build.extraFiles).toContainEqual({
      from: `docs/${PACKAGED_USAGE_GUIDE}`,
      to: PACKAGED_USAGE_GUIDE,
    });
    expect(manifest.build.files).toEqual(['build/**/*', 'dist/**/*', 'package.json']);
    expect(JSON.stringify(manifest.build)).not.toContain('release/**/*');
  });

  it('validates the packaged usage and entry-rule documentation contracts', async () => {
    const usageGuide = await readFile(join('docs', PACKAGED_USAGE_GUIDE), 'utf8');
    const entryRules = await readFile('futures_investigation_20261009/entry-rules.md', 'utf8');
    expect(() => validateUsageGuide(usageGuide)).not.toThrow();
    expect(() => validatePackagedData('entry-rules.md', entryRules)).not.toThrow();
    expect(() => validateUsageGuide('# 旧版豆粕说明')).toThrow(/标题未更新/);
    expect(() => validatePackagedData(
      'entry-rules.md',
      '# 每周突破回调入场规则\n后台1分钟数据\n第一处实际出场',
    )).toThrow(/十五个主连品种/);
  });

  it('cleans old installers and unpacked directories before packaging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-release-'));
    try {
      await mkdir(join(directory, 'win-unpacked'));
      await mkdir(join(directory, 'win-unpacked.tmp'));
      await writeFile(join(directory, 'win-unpacked', 'old.exe'), 'old');
      await writeFile(join(directory, 'win-unpacked.tmp', 'partial.exe'), 'partial');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe'), 'old');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe.blockmap'), 'old');
      await writeFile(join(directory, 'latest.yml'), 'old');
      await writeFile(join(directory, 'builder-debug.yml'), 'old');
      await writeFile(join(directory, 'keep.txt'), 'keep');

      expect(await prepareRelease(directory)).toHaveLength(6);
      expect(await readdir(directory)).toEqual(['keep.txt']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the current schema 5 data tree with optional one-minute files', async () => {
    expect(REQUIRED_DATA).toHaveLength(
      3 + INSTRUMENT_LIST.length * REQUIRED_INSTRUMENT_FILES.length,
    );
    for (const definition of INSTRUMENT_LIST) {
      for (const name of REQUIRED_INSTRUMENT_FILES) {
        expect(REQUIRED_DATA).toContain(`instruments/${definition.id}/${name}`);
      }
    }
    await expect(validatePackagedDataDirectory('data', {
      entryRulesPath: 'futures_investigation_20261009/entry-rules.md',
    })).resolves.toMatchObject({ valid: true, instrumentCount: 15 });
  }, 120_000);

  it('keeps schema 5 validation compatible with explicit installer legacy mode', async () => {
    await expect(validatePackagedDataDirectory('data', {
      entryRulesPath: 'futures_investigation_20261009/entry-rules.md',
      allowLegacySchema4: true,
    })).resolves.toMatchObject({ valid: true, instrumentCount: 15 });
  }, 120_000);

  it('accepts continuous schema 5 history without one-minute files and rejects a multi-year gap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-schema-five-release-'));
    try {
      await writeSchemaFiveReleaseFixture(directory);
      await expect(validatePackagedDataDirectory(directory, {
        entryRulesPath: 'futures_investigation_20261009/entry-rules.md',
      })).resolves.toMatchObject({ valid: true, instrumentCount: 15 });

      const paths: MarketDataPaths = {
        builtinDataDirectory: directory,
        marketDataDirectory: join(directory, '..', 'user-data'),
      };
      const tradingDates = ['2023-10-20', '2026-10-20'];
      const bars5 = fixtureFiveMinuteBars(DEFAULT_INSTRUMENT, tradingDates, 0);
      const contract = fixtureContract(DEFAULT_INSTRUMENT);
      await writeBuiltinMarketSnapshot(
        paths,
        DEFAULT_INSTRUMENT,
        {
          bars1: [],
          bars5,
          bars60: [],
          mainContractMappings: tradingDates.map(tradingDate => ({ tradingDate, contract })),
          rollovers: [],
          requestStart: bars5[0].start,
          requestEnd: bars5.at(-1)!.end,
          sourceLatestAt: bars5.at(-1)!.end,
          sourceSegments: [{
            sourceId: 'fixture-main-continuous-gap',
            sourceName: '发布校验缺口测试夹具',
            kind: 'test-fixture',
            acquiredAt: '2026-10-20T00:00:00.000Z',
            coverage: {
              first: bars5[0].start,
              last: bars5.at(-1)!.end,
            },
            rawFiles: [{
              name: 'main-continuous-gap-fixture.csv',
              sha256: 'b'.repeat(64),
              rows: bars5.length,
            }],
            importerVersion: 'release-validation-test-v1',
            license: {
              redistributionAllowed: true,
              conclusion: '测试夹具允许再分发',
            },
          }],
        },
        { now: () => new Date('2026-10-20T00:00:00.000Z') },
      );

      await expect(validatePackagedDataDirectory(directory, {
        entryRulesPath: 'futures_investigation_20261009/entry-rules.md',
      })).rejects.toThrow(/主力映射交易日间隔超过 14 天/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);

  it('rejects a packaged data tree that is missing one registered instrument', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-packaged-data-'));
    try {
      const instrumentsDirectory = join(directory, 'instruments');
      await mkdir(instrumentsDirectory, { recursive: true });
      for (const definition of INSTRUMENT_LIST) {
        if (definition.id !== 'soda_ash_main') {
          await mkdir(join(instrumentsDirectory, definition.id));
        }
      }
      await expect(validatePackagedDataDirectory(directory)).rejects.toThrow(
        /soda_ash_main|纯碱主连/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects malformed packaged resources instead of accepting non-empty files', () => {
    expect(() => validatePackagedData(
      'edb_main_continuous_1m_raw.csv',
      'not,csv\n1,2\n',
    )).toThrow();
    expect(() => validatePackagedData(
      'edb_main_continuous_5m.csv',
      'not,csv\n1,2\n',
    )).toThrow();
    expect(() => validatePackagedData(
      'edb_main_continuous_rollovers.csv',
      'not,csv\n1,2\n',
      DEFAULT_INSTRUMENT,
    )).toThrow();
    expect(() => validatePackagedData('baseline-report.json', '{')).toThrow();
    expect(() => validatePackagedData('entry-rules.md', '# 空规则')).toThrow();
  });
});
