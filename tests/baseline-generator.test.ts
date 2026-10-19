import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMainContractCandidates,
} from '../src/domain/contract-rollover';
import {
  aggregateMinutes,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import {
  BASELINE_REPORT_FILE,
  generateMarketBaselines,
  type BaselineSeed,
} from '../src/main/baseline-generator';
import {
  validateMarketBaselines,
} from '../src/main/baseline-validator';
import {
  loadEffectiveSnapshot,
  type MarketDataPaths,
} from '../src/main/market-snapshot';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../src/shared/instruments';
import type {
  EdbDailyRecord,
  EdbMinuteRecord,
} from '../src/shared/types';

const MINUTE_MS = 60_000;
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function minute(start: string, offset: number): EdbMinuteRecord {
  const startMs = parseBeijing(start) + offset * MINUTE_MS;
  const open = 3000 + offset;
  return {
    datetimeNano: String(BigInt(startMs) * 1_000_000n),
    startMs,
    start: formatBeijing(startMs),
    open,
    high: open + 2,
    low: open - 1,
    close: open + 1,
    volume: 100 + offset,
    openOi: 1000 + offset,
    closeOi: 1001 + offset,
  };
}

function minuteDay(date: string): EdbMinuteRecord[] {
  return Array.from({ length: 10 }, (_, index) => minute(`${date} 09:00:00`, index));
}

function daily(date: string, price: number): EdbDailyRecord {
  const timeMs = parseBeijing(`${date} 00:00:00`);
  return {
    datetimeNano: String(BigInt(timeMs) * 1_000_000n),
    tradingDate: date,
    open: price,
    high: price + 3,
    low: price - 2,
    close: price + 1,
    volume: 1000,
    openOi: 2000,
    closeOi: 2100,
  };
}

function fixtureClient() {
  const minutes = [...minuteDay('2026-10-12'), ...minuteDay('2026-10-13')];
  const mainDaily = [daily('2026-10-12', 3000), daily('2026-10-13', 3010)];
  let minuteRequests = 0;
  return {
    get minuteRequests() {
      return minuteRequests;
    },
    async fetchRange(
      _definition: InstrumentDefinition,
      startMs: number,
      endMs: number,
    ) {
      minuteRequests += 1;
      return minutes.filter(record => record.startMs >= startMs && record.startMs <= endMs);
    },
    async fetchMainDailyRange() {
      return mainDaily;
    },
    async fetchContractDailyRange(
      definition: InstrumentDefinition,
      contract: string,
    ) {
      const candidates = buildMainContractCandidates(
        definition,
        '2026-10-12',
        '2026-10-13',
      );
      if (contract === candidates[0]) return [mainDaily[0]];
      if (contract === candidates[1]) return [mainDaily[1]];
      return [];
    },
  };
}

function soymealSeed(): BaselineSeed {
  const bars1 = Array.from(
    { length: 5 },
    (_, index) => minute('2025-10-09 21:00:00', index),
  );
  return {
    bars1,
    mainContractMappings: [
      { tradingDate: '2025-10-10', contract: 'm2601' },
    ],
  };
}

describe('multi-instrument baseline generator', () => {
  it('enumerates the registry, chunks requests, preserves soymeal history, and writes loadable schema-v4 baselines', async () => {
    const root = await mkdtemp(join(tmpdir(), '多品种基线-'));
    temps.push(root);
    const paths: MarketDataPaths = {
      builtinDataDirectory: join(root, 'data'),
      marketDataDirectory: join(root, 'user-data'),
    };
    const client = fixtureClient();
    const startMs = parseBeijing('2026-10-12 09:00:00');
    const endMs = parseBeijing('2026-10-13 09:09:00');
    const report = await generateMarketBaselines({
      paths,
      client,
      requestStartMs: startMs,
      requestEndMs: endMs,
      daysPerChunk: 1,
      now: () => new Date('2026-10-19T04:00:00.000Z'),
      loadSeed: async definition => (
        definition.id === 'main_continuous' ? soymealSeed() : undefined
      ),
    });

    expect(report.instruments).toHaveLength(15);
    expect(report.instruments.every(item => item.status === 'succeeded')).toBe(true);
    expect(client.minuteRequests).toBe(30);
    expect(report.instruments[0]).toMatchObject({
      instrumentId: 'main_continuous',
      firstMinute: '2025-10-09 21:00:00',
      minuteRows: 25,
      mappingRows: 3,
      rolloverRows: 1,
    });

    for (const definition of INSTRUMENT_LIST) {
      const loaded = await loadEffectiveSnapshot(paths, definition);
      expect(loaded.source).toBe('builtin');
      expect(loaded.bars1.length).toBe(
        definition.id === 'main_continuous' ? 25 : 20,
      );
      expect(loaded.bars5).toEqual(aggregateMinutes(
        loaded.bars1,
        5,
        loaded.bars1.at(-1)!.startMs + MINUTE_MS,
        definition.tradingSessions,
      ));
      expect(loaded.mainContractMappings).toHaveLength(
        definition.id === 'main_continuous' ? 3 : 2,
      );
      expect(loaded.rollovers).toHaveLength(1);
      const metadata = JSON.parse(await readFile(
        join(paths.builtinDataDirectory, 'instruments', definition.id, 'metadata.json'),
        'utf8',
      ));
      expect(metadata).toMatchObject({
        schemaVersion: 4,
        snapshotId: `builtin-${definition.id}`,
        instrumentId: definition.id,
        mainSymbol: definition.mainSymbol,
        parameterVersion: definition.parameterVersion,
        generatedAt: '2026-10-19T04:00:00.000Z',
      });
      expect(Object.keys(metadata.files).sort()).toEqual([
        'bars1',
        'bars5',
        'bars60',
        'mainContractMappings',
        'rollovers',
      ]);
    }

    const persistedReport = JSON.parse(await readFile(
      join(paths.builtinDataDirectory, BASELINE_REPORT_FILE),
      'utf8',
    ));
    expect(persistedReport).toEqual(report);

    const validation = await validateMarketBaselines({ paths });
    expect(validation.instruments).toHaveLength(15);
    expect(validation.instruments.every(item => (
      Object.values(item.checks).every(Boolean)
    ))).toBe(true);
  });
});
