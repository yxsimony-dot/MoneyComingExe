import {
  normalizeHistoricalContractCodeForTradingDate,
  normalizeHistoricalTradingDates,
  tradingDateForHistoricalTimestamp,
} from './contract-history-normalization';
import {
  matchDesktopMainContractDays,
  type DesktopMainContractExactMatchReport,
  type DesktopMainContractFallbackEvidence,
  type DesktopMainContractDayAudit,
  type DesktopMainMatchMinuteRecord,
} from './desktop-main-contract-matching';
import { detectContractRollovers } from './contract-rollover';
import type {
  GlassContractCandidateSeries,
  GlassContractSourceEvidence,
} from './ths-contract-history';
import type { ThsBenchmarkFiveMinuteBar } from './ths-benchmark';
import { assertBarsValid } from './market-data';
import { INSTRUMENT_DEFINITIONS } from '../shared/instruments';
import type {
  Bar,
  ContractRollover,
  MainContractMapping,
} from '../shared/types';

const GLASS = INSTRUMENT_DEFINITIONS.glass_main;

export const THS_GLASS_MAIN_ALLOWED_MATCH_METHODS = [
  'exact-minute-sequence',
  'neighbor-confirmed-source-variance',
  'rollover-boundary-source-variance',
] as const satisfies readonly DesktopMainContractDayAudit['method'][];

export type ThsGlassMainAllowedMatchMethod =
  typeof THS_GLASS_MAIN_ALLOWED_MATCH_METHODS[number];

export interface ThsGlassMainContractCandidateSourceAudit {
  rawContract: string;
  normalizedContract: string;
  source: GlassContractSourceEvidence;
  rows: number;
  firstStartMs: number | null;
  lastStartMs: number | null;
}

export interface ThsGlassMainContractExpiryAudit {
  tradingDate: string;
  contract: string;
  expiryYear: number;
  expiryMonth: number;
  previousContract?: string;
  direction: 'initial' | 'same' | 'forward' | 'backward';
}

export interface ThsGlassMainContractMatchReport {
  schemaVersion: 1;
  instrumentId: 'glass_main';
  allowedMethods: readonly ThsGlassMainAllowedMatchMethod[];
  matching: DesktopMainContractExactMatchReport;
  candidateSources: ThsGlassMainContractCandidateSourceAudit[];
  expirySequence: ThsGlassMainContractExpiryAudit[];
  activation: {
    allowed: boolean;
    violations: string[];
  };
}

export interface ThsGlassMainContractRebuildResult {
  mappings: MainContractMapping[];
  rollovers: ContractRollover[];
  matchAudit: ThsGlassMainContractMatchReport;
}

function benchmarkRecords(
  bars: readonly ThsBenchmarkFiveMinuteBar[],
  tradingDateValues: readonly string[],
): DesktopMainMatchMinuteRecord[] {
  if (!bars.length) throw new Error('同花顺玻璃主连基准不能为空');
  const tradingDates = normalizeHistoricalTradingDates(tradingDateValues);
  const tradingDateSet = new Set(tradingDates);
  return bars.map(bar => ({
    instrumentId: 'glass_main',
    tradingDate: tradingDateForHistoricalTimestamp(
      GLASS,
      bar.barStartMs,
      tradingDates,
      tradingDateSet,
    ),
    timestamp: bar.start,
    startMs: bar.barStartMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    amount: bar.turnover,
    volume: bar.volume,
    openInterest: null,
  }));
}

function candidateRecords(
  seriesValues: readonly GlassContractCandidateSeries[],
): DesktopMainMatchMinuteRecord[] {
  const contracts = new Set<string>();
  const records: DesktopMainMatchMinuteRecord[] = [];
  for (const series of seriesValues) {
    if (series.instrumentId !== 'glass_main') {
      throw new Error('同花顺玻璃主连匹配不得混入其他品种');
    }
    if (contracts.has(series.normalizedContract)) {
      throw new Error(
        `玻璃具体合约候选序列重复：${series.normalizedContract}`,
      );
    }
    contracts.add(series.normalizedContract);
    for (const record of series.records) {
      if (record.instrumentId !== 'glass_main'
        || record.contract !== series.normalizedContract
        || record.normalizedContract !== series.normalizedContract
        || record.rawContract !== series.rawContract) {
        throw new Error(
          `玻璃具体合约候选记录与序列元数据不一致：`
          + `${series.rawContract}/${record.timestamp}`,
        );
      }
      records.push(record);
    }
  }
  return records;
}

function candidateSourceAudits(
  seriesValues: readonly GlassContractCandidateSeries[],
): ThsGlassMainContractCandidateSourceAudit[] {
  return seriesValues.map(series => {
    const startValues = series.records.map(record => record.startMs);
    return {
      rawContract: series.rawContract,
      normalizedContract: series.normalizedContract,
      source: structuredClone(series.source),
      rows: series.records.length,
      firstStartMs: startValues.length ? Math.min(...startValues) : null,
      lastStartMs: startValues.length ? Math.max(...startValues) : null,
    };
  }).sort((left, right) => (
    left.normalizedContract.localeCompare(right.normalizedContract, 'en')
  ));
}

function expirySequence(
  matching: DesktopMainContractExactMatchReport,
): {
  audits: ThsGlassMainContractExpiryAudit[];
  violations: string[];
} {
  const audits: ThsGlassMainContractExpiryAudit[] = [];
  const violations: string[] = [];
  let previous:
    | {
        contract: string;
        expiryValue: number;
      }
    | undefined;
  for (const mapping of matching.mappings) {
    const normalized = normalizeHistoricalContractCodeForTradingDate(
      GLASS,
      mapping.contract,
      mapping.tradingDate,
    );
    const expiryValue = normalized.expiryYear * 100 + normalized.expiryMonth;
    const direction = !previous
      ? 'initial'
      : expiryValue < previous.expiryValue
        ? 'backward'
        : expiryValue === previous.expiryValue
          ? 'same'
          : 'forward';
    audits.push({
      tradingDate: mapping.tradingDate,
      contract: normalized.contract,
      expiryYear: normalized.expiryYear,
      expiryMonth: normalized.expiryMonth,
      previousContract: previous?.contract,
      direction,
    });
    if (direction === 'backward') {
      violations.push(
        `${mapping.tradingDate} 主力合约到期年月异常倒退：`
        + `${previous!.contract} -> ${normalized.contract}`,
      );
    }
    previous = {
      contract: normalized.contract,
      expiryValue,
    };
  }
  return { audits, violations };
}

function matchingViolations(
  matching: DesktopMainContractExactMatchReport,
): string[] {
  const violations: string[] = [];
  const allowedMethods = new Set<DesktopMainContractDayAudit['method']>(
    THS_GLASS_MAIN_ALLOWED_MATCH_METHODS,
  );
  for (const day of matching.days) {
    if (day.status !== 'matched' || !day.selectedContract) {
      violations.push(
        `${day.tradingDate} 未取得唯一且允许的具体合约匹配`,
      );
      continue;
    }
    if (!allowedMethods.has(day.method)) {
      violations.push(
        `${day.tradingDate} 使用了禁止的匹配方法：${day.method}`,
      );
    }
  }
  if (matching.summary.heuristicFallbackMatches > 0) {
    violations.push('同花顺基准修复不得使用 heuristic-fallback');
  }
  return violations;
}

export function matchThsGlassMainContracts(
  benchmarkBars: readonly ThsBenchmarkFiveMinuteBar[],
  candidateSeries: readonly GlassContractCandidateSeries[],
  tradingDateValues: readonly string[],
  fallback?: DesktopMainContractFallbackEvidence,
): ThsGlassMainContractMatchReport {
  const matching = matchDesktopMainContractDays(
    benchmarkRecords(benchmarkBars, tradingDateValues),
    candidateRecords(candidateSeries),
    fallback,
    { heuristicFallback: 'disabled' },
  );
  const expiry = expirySequence(matching);
  const violations = [
    ...matchingViolations(matching),
    ...expiry.violations,
  ];
  return {
    schemaVersion: 1,
    instrumentId: 'glass_main',
    allowedMethods: [...THS_GLASS_MAIN_ALLOWED_MATCH_METHODS],
    matching,
    candidateSources: candidateSourceAudits(candidateSeries),
    expirySequence: expiry.audits,
    activation: {
      allowed: violations.length === 0,
      violations,
    },
  };
}

function assertRebuildableMatchReport(
  report: ThsGlassMainContractMatchReport,
): MainContractMapping[] {
  if (report.schemaVersion !== 1 || report.instrumentId !== 'glass_main') {
    throw new Error('同花顺玻璃主连匹配报告版本或品种无效');
  }
  if (!report.activation.allowed
    || report.activation.violations.length
    || report.matching.blocked
    || report.matching.affectedDates.length) {
    const reasons = report.activation.violations.length
      ? report.activation.violations.join('；')
      : report.matching.affectedDates.join('、');
    throw new Error(`同花顺玻璃主连匹配报告未通过激活门禁${reasons ? `：${reasons}` : ''}`);
  }
  if (report.matching.days.length === 0
    || report.matching.days.length !== report.matching.mappings.length
    || report.matching.summary.tradingDays !== report.matching.days.length
    || report.matching.summary.matchedDays !== report.matching.mappings.length) {
    throw new Error('同花顺玻璃主连匹配报告的交易日和映射数量不一致');
  }
  const allowedMethods = new Set<DesktopMainContractDayAudit['method']>(
    THS_GLASS_MAIN_ALLOWED_MATCH_METHODS,
  );
  const mappings = report.matching.mappings.map((mapping, index) => {
    const day = report.matching.days[index];
    if (day.status !== 'matched'
      || !day.selectedContract
      || !allowedMethods.has(day.method)
      || day.tradingDate !== mapping.tradingDate
      || day.selectedContract !== mapping.contract) {
      throw new Error(
        `同花顺玻璃主连 ${mapping.tradingDate} 的映射与匹配审计不一致`,
      );
    }
    const normalized = normalizeHistoricalContractCodeForTradingDate(
      GLASS,
      mapping.contract,
      mapping.tradingDate,
    );
    if (normalized.contract !== mapping.contract) {
      throw new Error(
        `同花顺玻璃主连 ${mapping.tradingDate} 的映射代码未规范化`,
      );
    }
    const previous = report.matching.mappings[index - 1];
    if (previous && mapping.tradingDate <= previous.tradingDate) {
      throw new Error('同花顺玻璃主连映射必须按交易日严格递增');
    }
    return { ...mapping };
  });
  return mappings;
}

function assertRolloverAuditsMatch(
  report: ThsGlassMainContractMatchReport,
  rollovers: readonly ContractRollover[],
): void {
  const auditRollovers = report.matching.days.flatMap(day => (
    day.rollover ? [{ ...day.rollover }] : []
  ));
  if (auditRollovers.length !== rollovers.length) {
    throw new Error('同花顺玻璃主连换月记录与匹配审计数量不一致');
  }
  for (let index = 0; index < rollovers.length; index += 1) {
    const audit = auditRollovers[index];
    const rollover = rollovers[index];
    if (audit.tradingDate !== rollover.tradingDate
      || audit.fromContract !== rollover.fromContract
      || audit.toContract !== rollover.toContract) {
      throw new Error(
        `同花顺玻璃主连 ${rollover.tradingDate} 的换月记录与匹配审计不一致`,
      );
    }
  }
}

export function rebuildThsGlassMainContractArtifacts(
  report: ThsGlassMainContractMatchReport,
  bars5: readonly Bar[],
): ThsGlassMainContractRebuildResult {
  const mappings = assertRebuildableMatchReport(report);
  const validatedBars = bars5.map(bar => ({ ...bar }));
  assertBarsValid(validatedBars, 5, GLASS.tradingSessions);
  const rollovers = detectContractRollovers(
    mappings,
    validatedBars,
    GLASS,
  );
  assertRolloverAuditsMatch(report, rollovers);
  return {
    mappings,
    rollovers: rollovers.map(rollover => ({ ...rollover })),
    matchAudit: structuredClone(report),
  };
}
