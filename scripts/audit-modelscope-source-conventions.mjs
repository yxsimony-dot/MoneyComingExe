import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INSTRUMENT_LIST } from '../src/shared/instruments.ts';
import {
  normalizeDailyRecordContinuity,
  readEdbBaseline,
} from './generate-modelscope-temporary-candidates.mjs';
import {
  INSTRUMENTS,
  REPOSITORY,
  aggregateMinutes,
  ticksToMinutes,
} from './probe-modelscope-tick-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIAGNOSTICS_ROOT =
  'D:\\MoneyComing-temp\\modelscope-calibration-diagnostics-rapeseed-meal-v4';
const DEFAULT_CACHE_ROOT =
  'D:\\MoneyComing-temp\\modelscope-candidates\\.cache';
const DEFAULT_OUTPUT = join(
  ROOT,
  'data',
  'modelscope-source-convention-blocker-audit.json',
);
const CZCE_DIAGNOSTIC_DATES = [
  '2025-10-20',
  '2025-11-04',
  '2025-11-07',
];
const DCE_INSTRUMENT_IDS = [
  'main_continuous',
  'pvc_main',
  'palm_oil_main',
  'soybean_oil_main',
  'corn_main',
  'soybean_1_main',
  'soybean_2_main',
];
const BAR_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'openOi',
  'closeOi',
  'observedMinutes',
  'expectedMinutes',
  'complete',
];
const DUPLICATE_TIMESTAMP_STRATEGIES = [
  {
    id: 'keep-all',
    name: '保留全部',
  },
  {
    id: 'first-per-timestamp',
    name: '每时间戳首条',
  },
  {
    id: 'last-per-timestamp',
    name: '每时间戳末条',
  },
  {
    id: 'cumulative-volume-increase-only',
    name: '仅累计成交量增加',
  },
  {
    id: 'price-or-open-interest-change-only',
    name: '仅价格或持仓变化',
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    diagnosticsRoot: DEFAULT_DIAGNOSTICS_ROOT,
    cacheRoot: DEFAULT_CACHE_ROOT,
    output: DEFAULT_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--diagnostics-root' && value) {
      options.diagnosticsRoot = value;
      index += 1;
    } else if (argument === '--cache-root' && value) {
      options.cacheRoot = value;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, resolve(value)]),
  );
}

function withCumulativeVolume(ticks) {
  let cumulativeVolume = 0;
  return ticks.map((tick, originalIndex) => {
    cumulativeVolume += tick.volumeDelta;
    return {
      ...tick,
      originalIndex,
      cumulativeVolume,
    };
  });
}

function stripAuditFields(tick, previousCumulativeVolume) {
  return {
    timestampMs: tick.timestampMs,
    lastPrice: tick.lastPrice,
    volumeDelta: previousCumulativeVolume === null
      ? tick.cumulativeVolume
      : tick.cumulativeVolume - previousCumulativeVolume,
    openInterest: tick.openInterest,
    session: tick.session,
  };
}

export function applyDuplicateTimestampStrategy(ticks, strategyId) {
  assert(
    DUPLICATE_TIMESTAMP_STRATEGIES.some(strategy => strategy.id === strategyId),
    `未知重复时间戳策略：${strategyId}`,
  );
  const cumulativeTicks = withCumulativeVolume(ticks);
  let retained;
  if (strategyId === 'keep-all') {
    retained = cumulativeTicks;
  } else if (strategyId === 'first-per-timestamp') {
    const seen = new Set();
    retained = cumulativeTicks.filter(tick => {
      if (seen.has(tick.timestampMs)) return false;
      seen.add(tick.timestampMs);
      return true;
    });
  } else if (strategyId === 'last-per-timestamp') {
    const lastIndexByTimestamp = new Map(
      cumulativeTicks.map((tick, index) => [tick.timestampMs, index]),
    );
    retained = cumulativeTicks.filter(
      (tick, index) => lastIndexByTimestamp.get(tick.timestampMs) === index,
    );
  } else if (strategyId === 'cumulative-volume-increase-only') {
    retained = cumulativeTicks.filter(
      (tick, index) => index === 0 || tick.volumeDelta > 0,
    );
  } else {
    retained = cumulativeTicks.filter((tick, index) => {
      if (index === 0) return true;
      const previous = cumulativeTicks[index - 1];
      return tick.lastPrice !== previous.lastPrice
        || tick.openInterest !== previous.openInterest;
    });
  }

  let previousCumulativeVolume = null;
  return retained.map(tick => {
    const normalized = stripAuditFields(tick, previousCumulativeVolume);
    previousCumulativeVolume = tick.cumulativeVolume;
    return normalized;
  });
}

export function compareBarsAgainstReference(candidateBars, referenceBars) {
  const candidateByStart = new Map(
    candidateBars.map(bar => [bar.startMs, bar]),
  );
  const referenceStarts = new Set(referenceBars.map(bar => bar.startMs));
  const fieldMismatchCounts = Object.fromEntries(
    BAR_FIELDS.map(field => [field, 0]),
  );
  let comparedBars = 0;
  let mismatchRows = 0;
  let fieldMismatches = 0;
  let missingCandidateBars = 0;

  for (const reference of referenceBars) {
    const candidate = candidateByStart.get(reference.startMs);
    if (!candidate) {
      missingCandidateBars += 1;
      mismatchRows += 1;
      fieldMismatches += 1;
      continue;
    }
    comparedBars += 1;
    const fields = BAR_FIELDS.filter(
      field => candidate[field] !== reference[field],
    );
    if (!fields.length) continue;
    mismatchRows += 1;
    fieldMismatches += fields.length;
    for (const field of fields) fieldMismatchCounts[field] += 1;
  }

  return {
    comparedBars,
    mismatchRows,
    fieldMismatches,
    missingCandidateBars,
    candidateOnlyBarsExcluded: candidateBars.filter(
      bar => !referenceStarts.has(bar.startMs),
    ).length,
    fieldMismatchCounts,
  };
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

async function auditCzceDuplicateTimestamps(diagnosticsRoot) {
  const strategies = new Map(DUPLICATE_TIMESTAMP_STRATEGIES.map(strategy => [
    strategy.id,
    {
      ...strategy,
      retainedTicks: 0,
      candidateBars: 0,
      comparedBars: 0,
      mismatchRows: 0,
      fieldMismatches: 0,
      missingCandidateBars: 0,
      candidateOnlyBarsExcluded: 0,
      fieldMismatchCounts: Object.fromEntries(
        BAR_FIELDS.map(field => [field, 0]),
      ),
    },
  ]));
  let sourceTicks = 0;
  let duplicateTimestamps = 0;

  for (const tradingDate of CZCE_DIAGNOSTIC_DATES) {
    const directory = join(diagnosticsRoot, tradingDate);
    const [ticks, referenceBars, existingCandidateBars] = await Promise.all([
      readFile(join(directory, 'parsed-ticks.json'), 'utf8').then(JSON.parse),
      readFile(join(directory, 'bars5-edb.json'), 'utf8').then(JSON.parse),
      readFile(
        join(directory, 'bars5-modelscope.json'),
        'utf8',
      ).then(JSON.parse),
    ]);
    sourceTicks += ticks.length;
    duplicateTimestamps += ticks.filter(
      (tick, index) => (
        index > 0 && tick.timestampMs === ticks[index - 1].timestampMs
      ),
    ).length;

    for (const strategy of DUPLICATE_TIMESTAMP_STRATEGIES) {
      const retainedTicks = applyDuplicateTimestampStrategy(ticks, strategy.id);
      const candidateBars = aggregateMinutes(ticksToMinutes(retainedTicks), 5);
      if (candidateBars.length && existingCandidateBars.length) {
        candidateBars[0].openOi = existingCandidateBars[0].openOi;
      }
      const comparison = compareBarsAgainstReference(
        candidateBars,
        referenceBars,
      );
      const totals = strategies.get(strategy.id);
      totals.retainedTicks += retainedTicks.length;
      totals.candidateBars += candidateBars.length;
      totals.comparedBars += comparison.comparedBars;
      totals.mismatchRows += comparison.mismatchRows;
      totals.fieldMismatches += comparison.fieldMismatches;
      totals.missingCandidateBars += comparison.missingCandidateBars;
      totals.candidateOnlyBarsExcluded += comparison.candidateOnlyBarsExcluded;
      addCounts(
        totals.fieldMismatchCounts,
        comparison.fieldMismatchCounts,
      );
    }
  }

  const results = [...strategies.values()];
  const best = [...results].sort(
    (left, right) => (
      left.mismatchRows - right.mismatchRows
      || left.fieldMismatches - right.fieldMismatches
    ),
  )[0];
  return {
    exchange: 'CZCE',
    instrumentId: 'rapeseed_meal_main',
    sampledTradingDates: CZCE_DIAGNOSTIC_DATES,
    sourceTicks,
    duplicateTimestamps,
    comparisonPolicy: {
      strictNumericTolerance: 0,
      candidateOnlyBarsExcluded: true,
      existingDailyContinuityOpenInterestAnchorApplied: true,
      reason: 'EDB 参考数据没有对应夜盘 K 线时，不把该候选 K 线计为字段差异。',
    },
    strategies: results,
    bestStrategyId: best.id,
    duplicateFilteringImprovesStrictCalibration: best.id !== 'keep-all',
    strictCalibrationPassed: best.mismatchRows === 0,
  };
}

function emptyDceCounts() {
  return {
    adjacentPairs: 0,
    sameContractPairs: 0,
    comparablePairs: 0,
    previousCloseMismatchPairs: 0,
    rawCurrentOpenMismatchPairs: 0,
    normalizationChangedPairs: 0,
    propagatedPreviousCloseDifferencePairs: 0,
    normalizationIntroducedMismatchPairs: 0,
    normalizationResolvedMismatchPairs: 0,
    firstCloseRecoveredPairs: 0,
    nextOpenRecoveredPairs: 0,
  };
}

export function analyzeDceOpenInterestPropagation(records, referenceBars) {
  const ordered = [...records].sort(
    (left, right) => left.tradingDate.localeCompare(right.tradingDate),
  );
  const normalized = normalizeDailyRecordContinuity(ordered);
  const referenceByStart = new Map(
    referenceBars.map(bar => [bar.startMs, bar]),
  );
  const counts = emptyDceCounts();

  for (let index = 1; index < ordered.length; index += 1) {
    counts.adjacentPairs += 1;
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous.contract !== current.contract
      || !previous.bars5.length
      || !current.bars5.length
    ) {
      continue;
    }
    counts.sameContractPairs += 1;
    const previousLast = previous.bars5.at(-1);
    const currentFirst = current.bars5[0];
    const normalizedFirst = normalized[index].bars5[0];
    const referencePreviousLast = referenceByStart.get(previousLast.startMs);
    const referenceCurrentFirst = referenceByStart.get(currentFirst.startMs);
    if (!referencePreviousLast || !referenceCurrentFirst) continue;
    counts.comparablePairs += 1;

    const previousDifference =
      previousLast.closeOi - referencePreviousLast.closeOi;
    const rawOpenDifference =
      currentFirst.openOi - referenceCurrentFirst.openOi;
    const normalizedOpenDifference =
      normalizedFirst.openOi - referenceCurrentFirst.openOi;
    if (previousDifference !== 0) counts.previousCloseMismatchPairs += 1;
    if (rawOpenDifference !== 0) counts.rawCurrentOpenMismatchPairs += 1;
    if (normalizedFirst.openOi !== currentFirst.openOi) {
      counts.normalizationChangedPairs += 1;
    }
    if (
      previousDifference !== 0
      &&
      normalizedFirst.openOi === previousLast.closeOi
      && normalizedOpenDifference === previousDifference
    ) {
      counts.propagatedPreviousCloseDifferencePairs += 1;
    }
    if (rawOpenDifference === 0 && normalizedOpenDifference !== 0) {
      counts.normalizationIntroducedMismatchPairs += 1;
    }
    if (rawOpenDifference !== 0 && normalizedOpenDifference === 0) {
      counts.normalizationResolvedMismatchPairs += 1;
    }
    if (currentFirst.closeOi === referenceCurrentFirst.closeOi) {
      counts.firstCloseRecoveredPairs += 1;
    }
    const currentSecond = current.bars5[1];
    const referenceCurrentSecond = currentSecond
      ? referenceByStart.get(currentSecond.startMs)
      : null;
    if (
      currentSecond
      && referenceCurrentSecond
      && currentSecond.openOi === referenceCurrentSecond.openOi
    ) {
      counts.nextOpenRecoveredPairs += 1;
    }
  }

  return counts;
}

async function readCacheRecords(cacheRoot, instrumentId) {
  const directory = join(cacheRoot, instrumentId);
  const names = (await readdir(directory))
    .filter(name => name.endsWith('.json'))
    .sort();
  return Promise.all(names.map(
    name => readFile(join(directory, name), 'utf8').then(JSON.parse),
  ));
}

async function auditDceOpenInterest(cacheRoot) {
  const definitionById = new Map(
    INSTRUMENT_LIST.map(definition => [definition.id, definition]),
  );
  const sourceInstrumentById = new Map(
    INSTRUMENTS.map(instrument => [instrument.id, instrument]),
  );
  const instruments = [];
  const totals = emptyDceCounts();

  for (const instrumentId of DCE_INSTRUMENT_IDS) {
    const definition = definitionById.get(instrumentId);
    const sourceInstrument = sourceInstrumentById.get(instrumentId);
    assert(definition && sourceInstrument, `缺少品种定义：${instrumentId}`);
    const [records, edb] = await Promise.all([
      readCacheRecords(cacheRoot, instrumentId),
      readEdbBaseline(ROOT, definition),
    ]);
    const counts = analyzeDceOpenInterestPropagation(records, edb.bars5);
    addCounts(totals, counts);
    instruments.push({
      instrumentId,
      name: sourceInstrument.name,
      cacheRecords: records.length,
      ...counts,
    });
  }

  return {
    exchange: 'DCE',
    instrumentCount: instruments.length,
    instruments,
    totals,
    finding: (
      totals.propagatedPreviousCloseDifferencePairs > 0
        ? '跨日规范化会把前一交易日末根持仓差异传播到下一交易日首根 openOi。'
        : '没有观察到前一交易日持仓差异被传播。'
    ),
    strictCalibrationPassed: false,
  };
}

export async function buildAuditReport(
  options,
  { now = () => new Date() } = {},
) {
  const [czce, dce] = await Promise.all([
    auditCzceDuplicateTimestamps(options.diagnosticsRoot),
    auditDceOpenInterest(options.cacheRoot),
  ]);
  return {
    schemaVersion: 1,
    purpose: 'modelscope-source-convention-release-blocker-audit',
    generatedAt: now().toISOString(),
    source: {
      repositoryId: REPOSITORY.id,
      commit: REPOSITORY.commit,
      temporaryInputsOnly: true,
      rawMarketDataWrittenToRepository: false,
    },
    czceDuplicateTimestampAudit: czce,
    dceOpenInterestPropagationAudit: dce,
    releaseDecision: {
      technicalCandidateOnly: true,
      strictZeroToleranceCalibrationPassed: false,
      redistributionPermissionConfirmed: false,
      baselineReplacementAllowed: false,
      releaseEligible: false,
      reason: (
        '重复时间戳过滤不能消除严格校准差异，DCE 跨日持仓规范化还会传播部分差异；'
        + '同时上游行情再分发权没有可审计证明。'
      ),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await buildAuditReport(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(
    options.output,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({
    output: options.output,
    czceBestStrategy:
      report.czceDuplicateTimestampAudit.bestStrategyId,
    czceMismatchRows:
      report.czceDuplicateTimestampAudit.strategies.find(
        strategy => strategy.id
          === report.czceDuplicateTimestampAudit.bestStrategyId,
      ).mismatchRows,
    dceComparablePairs:
      report.dceOpenInterestPropagationAudit.totals.comparablePairs,
    releaseEligible: report.releaseDecision.releaseEligible,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
