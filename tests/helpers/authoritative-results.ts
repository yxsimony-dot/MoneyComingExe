import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { exponentialMovingAverage } from '../../src/domain/ema';
import { reviewProfitLossLifecycles } from '../../src/domain/profit-loss-review';
import {
  analyzeWeeklyEntries,
  DEFAULT_ENTRY_STRATEGY_SETTINGS,
  entryLifecycle,
  type EntryStrategySettings,
} from '../../src/domain/weekly-entry';
import { createDataService } from '../../src/main/data-service';
import {
  INSTRUMENT_IDS,
  type Instrument,
} from '../../src/shared/instruments';
import type { Dataset } from '../../src/shared/types';

export type NormalizedJsonValue =
  | null
  | boolean
  | number
  | string
  | NormalizedJsonValue[]
  | { [key: string]: NormalizedJsonValue };

export interface AuthoritativeSequenceSummary {
  count: number;
  first?: string | number;
  last?: string | number;
  sha256: string;
}

export interface InstrumentAuthoritativeSummary {
  instrument: Instrument;
  symbol: string;
  snapshotSource: Dataset['snapshotSource'];
  sourceLatestAt: string;
  snapshotUpdatedAt?: string;
  market: {
    bars1: AuthoritativeSequenceSummary;
    bars5: AuthoritativeSequenceSummary;
    bars60: AuthoritativeSequenceSummary;
    mainContractMappings: AuthoritativeSequenceSummary;
    rollovers: AuthoritativeSequenceSummary;
    anomalies: AuthoritativeSequenceSummary;
  };
  strategy: {
    entries: AuthoritativeSequenceSummary & {
      incompleteHours: number;
    };
    lifecycles: AuthoritativeSequenceSummary & {
      attemptCount: number;
      abandonedSetupCount: number;
      enteredAttemptCount: number;
    };
  };
  profitLoss: {
    completedTrades: AuthoritativeSequenceSummary;
    incompleteTrades: AuthoritativeSequenceSummary;
    equityCurve: AuthoritativeSequenceSummary;
    statistics: ReturnType<typeof reviewProfitLossLifecycles>['statistics'];
    initialCapital: number;
    finalCapital: number;
    totalPnl: number;
    returnRate: number;
    sha256: string;
  };
  sha256: string;
}

export interface AuthoritativeResultsBaseline {
  schemaVersion: 1;
  strategySettings: EntryStrategySettings;
  instruments: Record<Instrument, InstrumentAuthoritativeSummary>;
}

export interface AuthoritativeDifference {
  path: string;
  kind: 'missing' | 'unexpected' | 'value';
  expected?: unknown;
  actual?: unknown;
}

export interface BuildAuthoritativeResultsOptions {
  builtinDataDirectory?: string;
  marketDataDirectory?: string;
  instruments?: readonly Instrument[];
  onInstrument?: (
    instrument: Instrument,
    index: number,
    total: number,
  ) => void;
}

function normalizeJsonValue(value: unknown): NormalizedJsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt values must be converted to strings before normalization.');
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeJsonValue(item) ?? null);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const normalized: { [key: string]: NormalizedJsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const child = normalizeJsonValue((value as Record<string, unknown>)[key]);
      if (child !== undefined) normalized[key] = child;
    }
    return normalized;
  }
  throw new TypeError(`Unsupported value type: ${typeof value}`);
}

export function normalizeAuthoritativeValue(value: unknown): NormalizedJsonValue {
  return normalizeJsonValue(value) ?? null;
}

export function stableAuthoritativeJson(value: unknown): string {
  return JSON.stringify(normalizeAuthoritativeValue(value));
}

export function authoritativeSha256(value: unknown): string {
  return createHash('sha256')
    .update(stableAuthoritativeJson(value))
    .digest('hex');
}

function sequenceSummary<T>(
  records: readonly T[],
  boundary: (record: T) => string | number,
): AuthoritativeSequenceSummary {
  const first = records[0];
  const last = records.at(-1);
  return {
    count: records.length,
    ...(first === undefined ? {} : { first: boundary(first) }),
    ...(last === undefined ? {} : { last: boundary(last) }),
    sha256: authoritativeSha256(records),
  };
}

export function summarizeInstrumentAuthoritativeResults(
  dataset: Dataset,
): InstrumentAuthoritativeSummary {
  const entryAnalysis = analyzeWeeklyEntries(
    dataset.bars60,
    dataset.bars5,
    exponentialMovingAverage(dataset.bars60),
  );
  const candidates = entryAnalysis.entries.map((entry, sourceIndex) => ({
    entry,
    sourceIndex,
    lifecycle: entryLifecycle(
      entry,
      dataset.bars5,
      dataset.bars1,
      dataset.definition.priceTick,
      DEFAULT_ENTRY_STRATEGY_SETTINGS,
    ),
  }));
  const review = reviewProfitLossLifecycles(candidates, dataset.definition);

  const market = {
    bars1: sequenceSummary(dataset.bars1, record => record.start),
    bars5: sequenceSummary(dataset.bars5, bar => bar.start),
    bars60: sequenceSummary(dataset.bars60, bar => bar.start),
    mainContractMappings: sequenceSummary(
      dataset.mainContractMappings,
      mapping => mapping.tradingDate,
    ),
    rollovers: sequenceSummary(dataset.rollovers, rollover => rollover.time),
    anomalies: sequenceSummary(dataset.anomalies, anomaly => anomaly.timeMs),
  };
  const entries = {
    ...sequenceSummary(
      entryAnalysis.entries,
      entry => entry.triggerBar.startMs,
    ),
    incompleteHours: entryAnalysis.incompleteHours,
  };
  const lifecycles = {
    ...sequenceSummary(candidates, candidate => candidate.entry.triggerBar.startMs),
    attemptCount: candidates.reduce(
      (total, candidate) => total + candidate.lifecycle.attempts.length,
      0,
    ),
    abandonedSetupCount: candidates.reduce(
      (total, candidate) => total + candidate.lifecycle.abandonedSetups.length,
      0,
    ),
    enteredAttemptCount: candidates.reduce(
      (total, candidate) => total + candidate.lifecycle.attempts.filter(
        attempt => attempt.quarterSignal?.entryBar !== undefined,
      ).length,
      0,
    ),
  };
  const profitLoss = {
    completedTrades: sequenceSummary(
      review.completedTrades,
      trade => trade.entryTimeMs,
    ),
    incompleteTrades: sequenceSummary(
      review.incompleteTrades,
      trade => trade.entryTimeMs,
    ),
    equityCurve: sequenceSummary(
      review.equityCurve,
      point => point.eventTimeMs,
    ),
    statistics: review.statistics,
    initialCapital: review.initialCapital,
    finalCapital: review.finalCapital,
    totalPnl: review.totalPnl,
    returnRate: review.returnRate,
    sha256: authoritativeSha256(review),
  };
  const summaryWithoutHash = {
    instrument: dataset.instrument,
    symbol: dataset.symbol,
    snapshotSource: dataset.snapshotSource,
    sourceLatestAt: dataset.sourceLatestAt,
    ...(dataset.snapshotUpdatedAt === undefined
      ? {}
      : { snapshotUpdatedAt: dataset.snapshotUpdatedAt }),
    market,
    strategy: {
      entries,
      lifecycles,
    },
    profitLoss,
  };

  return {
    ...summaryWithoutHash,
    sha256: authoritativeSha256(summaryWithoutHash),
  };
}

export async function buildAuthoritativeResultsBaseline(
  options: BuildAuthoritativeResultsOptions = {},
): Promise<AuthoritativeResultsBaseline> {
  const instruments = options.instruments ?? INSTRUMENT_IDS;
  const service = createDataService({
    builtinDataDirectory: options.builtinDataDirectory ?? resolve('data'),
    marketDataDirectory: options.marketDataDirectory ?? resolve('data', '.market-data'),
  });
  const summaries = {} as Record<Instrument, InstrumentAuthoritativeSummary>;

  for (const [index, instrument] of instruments.entries()) {
    options.onInstrument?.(instrument, index, instruments.length);
    try {
      const result = await service.load(instrument);
      if (!result.ok) {
        throw new Error(`${instrument}: ${result.error}`);
      }
      summaries[instrument] = summarizeInstrumentAuthoritativeResults(result.data);
    } finally {
      service.invalidate(instrument);
    }
  }

  return {
    schemaVersion: 1,
    strategySettings: { ...DEFAULT_ENTRY_STRATEGY_SETTINGS },
    instruments: summaries,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}

function compareValues(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: AuthoritativeDifference[],
): void {
  if (Object.is(expected, actual)) return;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push({
        path: `${path}.length`,
        kind: 'value',
        expected: expected.length,
        actual: actual.length,
      });
    }
    const sharedLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < sharedLength; index += 1) {
      compareValues(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return;
  }

  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ])].sort();
    for (const key of keys) {
      const expectedHasKey = Object.prototype.hasOwnProperty.call(expected, key);
      const actualHasKey = Object.prototype.hasOwnProperty.call(actual, key);
      const nextPath = childPath(path, key);
      if (!expectedHasKey) {
        differences.push({
          path: nextPath,
          kind: 'unexpected',
          actual: actual[key],
        });
      } else if (!actualHasKey) {
        differences.push({
          path: nextPath,
          kind: 'missing',
          expected: expected[key],
        });
      } else {
        compareValues(expected[key], actual[key], nextPath, differences);
      }
    }
    return;
  }

  differences.push({
    path,
    kind: 'value',
    expected,
    actual,
  });
}

export function compareAuthoritativeResults(
  expected: unknown,
  actual: unknown,
): AuthoritativeDifference[] {
  const differences: AuthoritativeDifference[] = [];
  compareValues(
    normalizeAuthoritativeValue(expected),
    normalizeAuthoritativeValue(actual),
    '$',
    differences,
  );
  return differences;
}
