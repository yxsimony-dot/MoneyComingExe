import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseContractRollovers } from '../src/domain/contract-rollover';
import { parseBars } from '../src/domain/data';
import {
  reviewProfitLoss,
  reviewProfitLossLifecycles,
} from '../src/domain/profit-loss-review';
import {
  DEFAULT_ENTRY_STRATEGY_SETTINGS,
  entryLifecycle,
  entryStrategyDateRange,
  weeklyEntryMarkerId,
  type EntryStrategySettings,
} from '../src/domain/weekly-entry';
import {
  normalizedEntryStrategyKey,
  prepareStrategyDerivations,
  releaseStrategyDerivations,
  strategyDerivationsFor,
} from '../src/renderer/strategy-derivations';
import { DEFAULT_INSTRUMENT } from '../src/shared/instruments';
import type { Dataset } from '../src/shared/types';

function fixtureDataset(): Dataset {
  const prefix = 'futures_investigation_20261009/edb_main_continuous';
  return {
    instrument: DEFAULT_INSTRUMENT.id,
    definition: DEFAULT_INSTRUMENT,
    name: DEFAULT_INSTRUMENT.name,
    symbol: DEFAULT_INSTRUMENT.mainSymbol,
    bars1: [],
    bars5: parseBars(readFileSync(`${prefix}_5m.csv`, 'utf8'), '5m.csv'),
    bars60: parseBars(readFileSync(`${prefix}_60m.csv`, 'utf8'), '60m.csv'),
    mainContractMappings: [],
    rollovers: parseContractRollovers(
      readFileSync(`${prefix}_rollovers.csv`, 'utf8'),
    ),
    anomalies: [],
    auditAvailable: true,
    dataDirectory: 'fixture',
    snapshotSource: 'builtin',
    sourceLatestAt: '2026-10-09 15:00:00',
  };
}

const settings = (
  override: Partial<EntryStrategySettings> = {},
): EntryStrategySettings => ({
  ...DEFAULT_ENTRY_STRATEGY_SETTINGS,
  ...override,
});

describe('strategy derivations', () => {
  it('caches equivalent lifecycle settings for the same Dataset identity', () => {
    const dataset = fixtureDataset();
    let creationCount = 0;
    const first = strategyDerivationsFor(
      dataset,
      settings(),
      () => { creationCount += 1; },
    );
    const cached = strategyDerivationsFor(
      dataset,
      settings(),
      () => { creationCount += 1; },
    );

    expect(cached).toBe(first);
    expect(creationCount).toBe(1);
    expect(first.candidates.length).toBeGreaterThan(0);
    expect(first.lifecyclesByMarkerId.size).toBe(first.candidates.length);
  });

  it.each([
    ['reactionBodyTicks', 2],
    ['entryRangePercent', 30],
    ['stopLossRangePercent', 80],
    ['takeProfitRangePercent', 205],
    ['oppositeCandleCount', 5],
    ['sessionExitMinutes', 10],
  ] satisfies [keyof EntryStrategySettings, number][])(
    'invalidates when %s changes',
    (key, value) => {
      const dataset = fixtureDataset();
      const baseline = strategyDerivationsFor(dataset, settings());
      const changed = strategyDerivationsFor(dataset, settings({
        [key]: value,
      }));

      expect(changed).not.toBe(baseline);
      expect(changed.settingsKey).not.toBe(baseline.settingsKey);
    },
  );

  it('reuses complete lifecycles when only the review date range changes', () => {
    const dataset = fixtureDataset();
    const baselineSettings = settings();
    const rangedSettings = settings({
      reviewStartDate: '2025-01-01',
      reviewEndDate: '2025-12-31',
    });
    const baseline = strategyDerivationsFor(dataset, baselineSettings);
    const ranged = strategyDerivationsFor(dataset, rangedSettings);

    expect(ranged).toBe(baseline);
    expect(normalizedEntryStrategyKey(rangedSettings)).toBe(
      normalizedEntryStrategyKey(baselineSettings),
    );
  });

  it('does not share results between different Dataset identities', () => {
    const dataset = fixtureDataset();
    const first = strategyDerivationsFor(dataset, settings());
    const other = strategyDerivationsFor({ ...dataset }, settings());

    expect(other).not.toBe(first);
    expect(other.candidates).not.toBe(first.candidates);
  });

  it('matches direct lifecycle and profit-loss calculations', () => {
    const dataset = fixtureDataset();
    const strategySettings = settings();
    const derived = strategyDerivationsFor(dataset, strategySettings);

    for (const candidate of derived.candidates) {
      expect(candidate.lifecycle).toEqual(entryLifecycle(
        candidate.entry,
        dataset.bars5,
        dataset.bars1,
        dataset.definition.priceTick,
        strategySettings,
      ));
      expect(
        derived.lifecyclesByMarkerId.get(weeklyEntryMarkerId(candidate.entry)),
      ).toBe(candidate.lifecycle);
    }

    expect(reviewProfitLossLifecycles(
      derived.candidates,
      dataset.definition,
      entryStrategyDateRange(strategySettings),
    )).toEqual(reviewProfitLoss(
      derived.candidates.map(candidate => candidate.entry),
      dataset.bars5,
      dataset.bars1,
      dataset.definition,
      strategySettings,
    ));
  });

  it('does not linearly search the complete 5-minute history for lifecycle positions', () => {
    const dataset = fixtureDataset();
    const entry = strategyDerivationsFor(dataset, settings()).candidates[0].entry;
    const guardedBars5 = new Proxy(dataset.bars5, {
      get(target, property, receiver) {
        if (property === 'findIndex' || property === 'indexOf') {
          return () => {
            throw new Error('完整 5 分钟历史不得使用线性位置查找');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(entryLifecycle(
      entry,
      guardedBars5,
      dataset.bars1,
      dataset.definition.priceTick,
      settings(),
    )).toEqual(entryLifecycle(
      entry,
      dataset.bars5,
      dataset.bars1,
      dataset.definition.priceTick,
      settings(),
    ));
  });

  it('prepares the same cached strategy result while yielding cooperatively', async () => {
    const dataset = fixtureDataset();
    let yieldCount = 0;
    let creationCount = 0;
    const prepared = await prepareStrategyDerivations(
      dataset,
      settings(),
      async () => {
        yieldCount += 1;
        await Promise.resolve();
      },
      () => { creationCount += 1; },
    );

    expect(yieldCount).toBeGreaterThan(0);
    expect(creationCount).toBe(1);
    expect(strategyDerivationsFor(dataset, settings())).toBe(prepared);
  });

  it('releases every cached setting for a retained Dataset identity', () => {
    const dataset = fixtureDataset();
    const baseline = strategyDerivationsFor(dataset, settings());
    const changed = strategyDerivationsFor(dataset, settings({
      takeProfitRangePercent: 205,
    }));

    releaseStrategyDerivations(dataset);

    expect(strategyDerivationsFor(dataset, settings())).not.toBe(baseline);
    expect(strategyDerivationsFor(dataset, settings({
      takeProfitRangePercent: 205,
    }))).not.toBe(changed);
  });
});
