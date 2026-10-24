import type { ProfitLossReviewLifecycleCandidate } from '../domain/profit-loss-review';
import {
  entryLifecycle,
  validateEntryStrategySettings,
  weeklyEntryMarkerId,
  type EntryLifecycle,
  type EntryStrategySettings,
} from '../domain/weekly-entry';
import type { Dataset } from '../shared/types';
import {
  marketDerivationsFor,
  prepareMarketDerivations,
  type CooperativeYield,
} from './market-derivations';

export interface LifecycleStrategySettings {
  reactionBodyTicks: number;
  entryRangePercent: number;
  stopLossRangePercent: number;
  takeProfitRangePercent: number;
  oppositeCandleCount: number;
  sessionExitMinutes: EntryStrategySettings['sessionExitMinutes'];
}

export interface StrategyDerivations {
  dataset: Dataset;
  settingsKey: string;
  lifecycleSettings: LifecycleStrategySettings;
  candidates: ProfitLossReviewLifecycleCandidate[];
  lifecyclesByMarkerId: Map<string, EntryLifecycle>;
}

const derivationsByDataset = new WeakMap<
  Dataset,
  Map<string, StrategyDerivations>
>();
const STRATEGY_BATCH_SIZE = 16;

export function releaseStrategyDerivations(dataset: Dataset): void {
  derivationsByDataset.delete(dataset);
}

function lifecycleSettingsFor(
  settings: EntryStrategySettings,
): LifecycleStrategySettings {
  const validated = validateEntryStrategySettings(settings);
  return {
    reactionBodyTicks: validated.reactionBodyTicks,
    entryRangePercent: validated.entryRangePercent,
    stopLossRangePercent: validated.stopLossRangePercent,
    takeProfitRangePercent: validated.takeProfitRangePercent,
    oppositeCandleCount: validated.oppositeCandleCount,
    sessionExitMinutes: validated.sessionExitMinutes,
  };
}

export function normalizedEntryStrategyKey(
  settings: EntryStrategySettings,
): string {
  const normalized = lifecycleSettingsFor(settings);
  return [
    normalized.reactionBodyTicks,
    normalized.entryRangePercent,
    normalized.stopLossRangePercent,
    normalized.takeProfitRangePercent,
    normalized.oppositeCandleCount,
    normalized.sessionExitMinutes,
  ].join('|');
}

export function strategyDerivationsFor(
  dataset: Dataset,
  settings: EntryStrategySettings,
  onCreate?: (derivations: StrategyDerivations) => void,
): StrategyDerivations {
  const lifecycleSettings = lifecycleSettingsFor(settings);
  const settingsKey = normalizedEntryStrategyKey(lifecycleSettings);
  let datasetDerivations = derivationsByDataset.get(dataset);
  const cached = datasetDerivations?.get(settingsKey);
  if (cached) return cached;

  const entries = marketDerivationsFor(dataset).periods[60]
    .weeklyEntryAnalysis.entries;
  const candidates = entries.map((entry, sourceIndex) => ({
    entry,
    sourceIndex,
    lifecycle: entryLifecycle(
      entry,
      dataset.bars5,
      dataset.bars1,
      dataset.definition.priceTick,
      lifecycleSettings,
    ),
  }));
  const derivations: StrategyDerivations = {
    dataset,
    settingsKey,
    lifecycleSettings,
    candidates,
    lifecyclesByMarkerId: new Map(candidates.map(candidate => [
      weeklyEntryMarkerId(candidate.entry),
      candidate.lifecycle,
    ])),
  };
  if (!datasetDerivations) {
    datasetDerivations = new Map();
    derivationsByDataset.set(dataset, datasetDerivations);
  }
  datasetDerivations.set(settingsKey, derivations);
  onCreate?.(derivations);
  return derivations;
}

export async function prepareStrategyDerivations(
  dataset: Dataset,
  settings: EntryStrategySettings,
  yieldControl: CooperativeYield,
  onCreate?: (derivations: StrategyDerivations) => void,
): Promise<StrategyDerivations> {
  const lifecycleSettings = lifecycleSettingsFor(settings);
  const settingsKey = normalizedEntryStrategyKey(lifecycleSettings);
  let datasetDerivations = derivationsByDataset.get(dataset);
  const cached = datasetDerivations?.get(settingsKey);
  if (cached) return cached;

  const entries = (await prepareMarketDerivations(dataset, yieldControl))
    .periods[60]
    .weeklyEntryAnalysis.entries;
  const candidates: ProfitLossReviewLifecycleCandidate[] = [];
  await yieldControl();
  for (let sourceIndex = 0; sourceIndex < entries.length; sourceIndex += 1) {
    const entry = entries[sourceIndex];
    candidates.push({
      entry,
      sourceIndex,
      lifecycle: entryLifecycle(
        entry,
        dataset.bars5,
        dataset.bars1,
        dataset.definition.priceTick,
        lifecycleSettings,
      ),
    });
    if (
      sourceIndex + 1 < entries.length
      && (sourceIndex + 1) % STRATEGY_BATCH_SIZE === 0
    ) {
      await yieldControl();
    }
  }

  const derivations: StrategyDerivations = {
    dataset,
    settingsKey,
    lifecycleSettings,
    candidates,
    lifecyclesByMarkerId: new Map(candidates.map(candidate => [
      weeklyEntryMarkerId(candidate.entry),
      candidate.lifecycle,
    ])),
  };
  if (!datasetDerivations) {
    datasetDerivations = new Map();
    derivationsByDataset.set(dataset, datasetDerivations);
  }
  datasetDerivations.set(settingsKey, derivations);
  onCreate?.(derivations);
  return derivations;
}
