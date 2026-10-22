import type {
  Bar,
  ContractRollover,
  EdbDailyRecord,
  MainContractMapping,
} from '../shared/types';
import {
  instrumentDefinition,
  isConcreteContractCode,
  type ExchangeId,
  type Instrument,
} from '../shared/instruments';
import type { NormalizedContractFiveMinuteRecord } from './contract-history-import';
import { detectContractRollovers } from './contract-rollover';
import { assertBarsValid } from './market-data';
import { formatBeijing, parseBeijing } from './time';

export interface HistoricalContractDailySummary {
  instrumentId: Instrument;
  exchange: ExchangeId;
  tradingDate: string;
  contract: string;
  expiryYear: number;
  expiryMonth: number;
  firstStartMs: number;
  lastStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  endOpenInterest: number;
  barCount: number;
}

export interface HistoricalMainContractPolicy {
  /**
   * 0 表示进入交割月即排除；1 表示从交割月前一个自然月开始排除。
   */
  deliveryRestrictionMonthsBeforeExpiry?: number;
  /**
   * 只有提供非空审计原因的日期才允许到期月份倒退。
   */
  allowedExpiryRollbacks?: Readonly<Record<string, string>>;
}

export interface HistoricalMainContractCandidateDecision {
  contract: string;
  expiryYear: number;
  expiryMonth: number;
  endOpenInterest: number;
  totalVolume: number;
  eligible: boolean;
  rejectionReason?: string;
}

export interface HistoricalMainContractDecision {
  tradingDate: string;
  status: 'selected' | 'rejected';
  selectedContract?: string;
  candidates: HistoricalMainContractCandidateDecision[];
  reason?: string;
  expiryRollbackReason?: string;
}

export interface HistoricalMainContractSelection {
  instrumentId: Instrument;
  mappings: MainContractMapping[];
  decisions: HistoricalMainContractDecision[];
  blocked: boolean;
  affectedDates: string[];
}

export interface HistoricalMainCalibrationThresholds {
  minOverlapDays: number;
  maxContractMismatchDays: number;
  maxOhlcMismatchDays: number;
  maxRolloverMismatchDays: number;
  priceTolerance: number;
}

export interface HistoricalMainCalibrationDay {
  tradingDate: string;
  candidateContract: string;
  referenceContract: string;
  contractMatches: boolean;
  candidateOhlc?: Pick<HistoricalContractDailySummary, 'open' | 'high' | 'low' | 'close'>;
  referenceOhlc?: Pick<EdbDailyRecord, 'open' | 'high' | 'low' | 'close'>;
  ohlcDifferences?: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  ohlcMatches: boolean;
  candidateRollover: boolean;
  referenceRollover: boolean;
  rolloverMatches: boolean;
  issues: string[];
}

export interface HistoricalMainCalibrationReport {
  schemaVersion: 1;
  instrumentId: Instrument;
  overlap: {
    firstTradingDate?: string;
    lastTradingDate?: string;
    days: number;
  };
  thresholds: HistoricalMainCalibrationThresholds;
  days: HistoricalMainCalibrationDay[];
  affectedDates: {
    missingEvidence: string[];
    contractMismatch: string[];
    ohlcMismatch: string[];
    rolloverMismatch: string[];
  };
  counts: {
    missingEvidence: number;
    contractMismatch: number;
    ohlcMismatch: number;
    rolloverMismatch: number;
  };
  activation: {
    allowed: boolean;
    violations: string[];
  };
}

export interface StitchedHistoricalMainContract {
  bars5: Bar[];
  mappings: MainContractMapping[];
  rollovers: ContractRollover[];
}

export type HistoricalMainContractActivationResult =
  | {
      ok: true;
      candidate: StitchedHistoricalMainContract;
    }
  | {
      ok: false;
      mappings: MainContractMapping[];
      affectedDates: string[];
      reasons: string[];
    };

export const DEFAULT_HISTORICAL_MAIN_CALIBRATION_THRESHOLDS:
HistoricalMainCalibrationThresholds = {
  minOverlapDays: 20,
  maxContractMismatchDays: 0,
  maxOhlcMismatchDays: 0,
  maxRolloverMismatchDays: 0,
  priceTolerance: 0,
};

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} 必须为 YYYY-MM-DD`);
  }
  parseBeijing(`${value} 00:00:00`);
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new Error(`${field} 缺失或不是有限数值`);
}

function expiryIndex(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`合约到期年月无效：${year}-${month}`);
  }
  return year * 12 + month - 1;
}

function tradingMonthIndex(tradingDate: string): number {
  assertDate(tradingDate, '交易日');
  return Number(tradingDate.slice(0, 4)) * 12 + Number(tradingDate.slice(5, 7)) - 1;
}

function recordKey(tradingDate: string, contract: string): string {
  return `${tradingDate}|${contract}`;
}

function assertRecordValid(record: NormalizedContractFiveMinuteRecord): void {
  assertDate(record.tradingDate, '交易日');
  if (!record.contract) throw new Error('合约代码缺失');
  if (!Number.isSafeInteger(record.startMs) || !Number.isSafeInteger(record.endMs)) {
    throw new Error(`${record.tradingDate} ${record.contract} 的时间戳缺失或无效`);
  }
  if (record.endMs <= record.startMs) {
    throw new Error(`${record.tradingDate} ${record.contract} 的时间范围无效`);
  }
  for (const [field, value] of [
    ['open', record.open],
    ['high', record.high],
    ['low', record.low],
    ['close', record.close],
    ['volume', record.volume],
    ['openInterest', record.openInterest],
  ] as const) {
    assertFinite(value, `${record.tradingDate} ${record.contract} ${field}`);
  }
  if (record.low > record.high
    || record.open < record.low
    || record.open > record.high
    || record.close < record.low
    || record.close > record.high) {
    throw new Error(`${record.tradingDate} ${record.contract} 的 OHLC 范围无效`);
  }
  if (record.volume < 0 || record.openInterest < 0) {
    throw new Error(`${record.tradingDate} ${record.contract} 的成交量或持仓量为负数`);
  }
  expiryIndex(record.expiryYear, record.expiryMonth);
}

export function summarizeHistoricalContractDays(
  records: readonly NormalizedContractFiveMinuteRecord[],
): HistoricalContractDailySummary[] {
  if (!records.length) throw new Error('合约级 5 分钟记录不能为空');
  const instrumentId = records[0].instrumentId;
  const groups = new Map<string, NormalizedContractFiveMinuteRecord[]>();
  for (const record of records) {
    assertRecordValid(record);
    if (record.instrumentId !== instrumentId) {
      throw new Error('一次历史主力汇总不得混入多个品种');
    }
    const key = recordKey(record.tradingDate, record.contract);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const summaries: HistoricalContractDailySummary[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.startMs - right.startMs);
    const first = group[0];
    for (let index = 0; index < group.length; index += 1) {
      const record = group[index];
      const previous = group[index - 1];
      if (previous && record.startMs <= previous.startMs) {
        throw new Error(`${record.tradingDate} ${record.contract} 存在重复或倒序 K 线`);
      }
      if (record.exchange !== first.exchange
        || record.expiryYear !== first.expiryYear
        || record.expiryMonth !== first.expiryMonth) {
        throw new Error(`${record.tradingDate} ${record.contract} 的合约元数据不一致`);
      }
    }
    const last = group.at(-1)!;
    summaries.push({
      instrumentId,
      exchange: first.exchange,
      tradingDate: first.tradingDate,
      contract: first.contract,
      expiryYear: first.expiryYear,
      expiryMonth: first.expiryMonth,
      firstStartMs: first.startMs,
      lastStartMs: last.startMs,
      open: first.open,
      high: Math.max(...group.map(record => record.high)),
      low: Math.min(...group.map(record => record.low)),
      close: last.close,
      totalVolume: group.reduce((sum, record) => sum + record.volume, 0),
      endOpenInterest: last.openInterest,
      barCount: group.length,
    });
  }
  return summaries.sort((left, right) => (
    left.tradingDate.localeCompare(right.tradingDate)
    || left.contract.localeCompare(right.contract)
  ));
}

function normalizedPolicy(policy: HistoricalMainContractPolicy): Required<HistoricalMainContractPolicy> {
  const deliveryRestrictionMonthsBeforeExpiry =
    policy.deliveryRestrictionMonthsBeforeExpiry ?? 0;
  if (!Number.isInteger(deliveryRestrictionMonthsBeforeExpiry)
    || deliveryRestrictionMonthsBeforeExpiry < 0) {
    throw new Error('交割限制提前月数必须为非负整数');
  }
  const allowedExpiryRollbacks = policy.allowedExpiryRollbacks ?? {};
  for (const [date, reason] of Object.entries(allowedExpiryRollbacks)) {
    assertDate(date, '允许倒退日期');
    if (!reason.trim()) throw new Error(`${date} 的到期月份倒退原因不能为空`);
  }
  return {
    deliveryRestrictionMonthsBeforeExpiry,
    allowedExpiryRollbacks,
  };
}

function rejectedDecision(
  tradingDate: string,
  candidates: HistoricalMainContractCandidateDecision[],
  reason: string,
): HistoricalMainContractDecision {
  return {
    tradingDate,
    status: 'rejected',
    candidates,
    reason,
  };
}

export function determineHistoricalMainContracts(
  summaries: readonly HistoricalContractDailySummary[],
  policy: HistoricalMainContractPolicy = {},
): HistoricalMainContractSelection {
  if (!summaries.length) throw new Error('合约日汇总不能为空');
  const normalized = normalizedPolicy(policy);
  const instrumentId = summaries[0].instrumentId;
  const definition = instrumentDefinition(instrumentId);
  const byDate = new Map<string, HistoricalContractDailySummary[]>();
  for (const summary of summaries) {
    assertDate(summary.tradingDate, '交易日');
    if (summary.instrumentId !== instrumentId) {
      throw new Error('一次历史主力判定不得混入多个品种');
    }
    if (summary.exchange !== definition.exchange) {
      throw new Error(`${summary.tradingDate} ${summary.contract} 的交易所与品种不一致`);
    }
    if (!summary.contract || summary.barCount <= 0 || !Number.isInteger(summary.barCount)) {
      throw new Error(`${summary.tradingDate} 的合约代码或 K 线数量缺失`);
    }
    for (const [field, value] of [
      ['endOpenInterest', summary.endOpenInterest],
      ['totalVolume', summary.totalVolume],
      ['open', summary.open],
      ['high', summary.high],
      ['low', summary.low],
      ['close', summary.close],
    ] as const) {
      assertFinite(value, `${summary.tradingDate} ${summary.contract} ${field}`);
    }
    expiryIndex(summary.expiryYear, summary.expiryMonth);
    const group = byDate.get(summary.tradingDate) ?? [];
    group.push(summary);
    byDate.set(summary.tradingDate, group);
  }

  const mappings: MainContractMapping[] = [];
  const decisions: HistoricalMainContractDecision[] = [];
  const affectedDates: string[] = [];
  let previousExpiry: number | undefined;
  let rollbackBlockedBy: string | undefined;

  for (const [tradingDate, dailySummaries] of [...byDate].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const duplicateContract = dailySummaries.find((summary, index) => (
      dailySummaries.findIndex(candidate => candidate.contract === summary.contract) !== index
    ));
    const restrictionStart = (summary: HistoricalContractDailySummary) => (
      expiryIndex(summary.expiryYear, summary.expiryMonth)
      - normalized.deliveryRestrictionMonthsBeforeExpiry
    );
    const currentMonth = tradingMonthIndex(tradingDate);
    const candidates = dailySummaries.map(summary => {
      const restricted = currentMonth >= restrictionStart(summary);
      return {
        contract: summary.contract,
        expiryYear: summary.expiryYear,
        expiryMonth: summary.expiryMonth,
        endOpenInterest: summary.endOpenInterest,
        totalVolume: summary.totalVolume,
        eligible: !restricted,
        rejectionReason: restricted ? '已进入交割限制窗口' : undefined,
      };
    });

    if (rollbackBlockedBy) {
      decisions.push(rejectedDecision(
        tradingDate,
        candidates,
        `此前 ${rollbackBlockedBy} 存在未解释的到期月份倒退`,
      ));
      affectedDates.push(tradingDate);
      continue;
    }
    if (duplicateContract) {
      decisions.push(rejectedDecision(
        tradingDate,
        candidates,
        `同一交易日存在重复候选合约：${duplicateContract.contract}`,
      ));
      affectedDates.push(tradingDate);
      continue;
    }

    const eligible = dailySummaries.filter(summary => currentMonth < restrictionStart(summary));
    if (!eligible.length) {
      decisions.push(rejectedDecision(
        tradingDate,
        candidates,
        '所有候选合约都已进入交割限制窗口',
      ));
      affectedDates.push(tradingDate);
      continue;
    }
    eligible.sort((left, right) => (
      right.endOpenInterest - left.endOpenInterest
      || right.totalVolume - left.totalVolume
      || expiryIndex(left.expiryYear, left.expiryMonth)
        - expiryIndex(right.expiryYear, right.expiryMonth)
    ));
    const selected = eligible[0];
    const selectedExpiry = expiryIndex(selected.expiryYear, selected.expiryMonth);
    const tied = eligible.filter(candidate => (
      candidate.endOpenInterest === selected.endOpenInterest
      && candidate.totalVolume === selected.totalVolume
      && expiryIndex(candidate.expiryYear, candidate.expiryMonth) === selectedExpiry
    ));
    if (tied.length !== 1) {
      decisions.push(rejectedDecision(
        tradingDate,
        candidates,
        `多个候选在持仓量、成交量和到期顺序上完全同分：`
        + tied.map(candidate => candidate.contract).join('、'),
      ));
      affectedDates.push(tradingDate);
      continue;
    }

    const rollbackReason = normalized.allowedExpiryRollbacks[tradingDate]?.trim();
    if (previousExpiry !== undefined && selectedExpiry < previousExpiry && !rollbackReason) {
      rollbackBlockedBy = tradingDate;
      decisions.push(rejectedDecision(
        tradingDate,
        candidates,
        `主力到期月份从 ${previousExpiry} 无解释倒退到 ${selectedExpiry}`,
      ));
      affectedDates.push(tradingDate);
      continue;
    }

    mappings.push({ tradingDate, contract: selected.contract });
    decisions.push({
      tradingDate,
      status: 'selected',
      selectedContract: selected.contract,
      candidates,
      expiryRollbackReason: rollbackReason || undefined,
    });
    previousExpiry = selectedExpiry;
  }

  return {
    instrumentId,
    mappings,
    decisions,
    blocked: affectedDates.length > 0,
    affectedDates,
  };
}

function indexedMappings(
  mappings: readonly MainContractMapping[],
  label: string,
): {
  rows: MainContractMapping[];
  byDate: Map<string, MainContractMapping>;
  rolloverDates: Set<string>;
} {
  const rows = [...mappings].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  const byDate = new Map<string, MainContractMapping>();
  const rolloverDates = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const mapping = rows[index];
    assertDate(mapping.tradingDate, `${label}交易日`);
    if (!mapping.contract) throw new Error(`${label}${mapping.tradingDate} 的合约代码缺失`);
    if (byDate.has(mapping.tradingDate)) throw new Error(`${label}交易日重复：${mapping.tradingDate}`);
    byDate.set(mapping.tradingDate, mapping);
    const previous = rows[index - 1];
    if (previous && previous.contract !== mapping.contract) {
      rolloverDates.add(mapping.tradingDate);
    }
  }
  return { rows, byDate, rolloverDates };
}

function normalizedThresholds(
  thresholds: Partial<HistoricalMainCalibrationThresholds>,
): HistoricalMainCalibrationThresholds {
  const result = {
    ...DEFAULT_HISTORICAL_MAIN_CALIBRATION_THRESHOLDS,
    ...thresholds,
  };
  for (const field of [
    'minOverlapDays',
    'maxContractMismatchDays',
    'maxOhlcMismatchDays',
    'maxRolloverMismatchDays',
  ] as const) {
    if (!Number.isInteger(result[field]) || result[field] < 0) {
      throw new Error(`${field} 必须为非负整数`);
    }
  }
  if (!Number.isFinite(result.priceTolerance) || result.priceTolerance < 0) {
    throw new Error('priceTolerance 必须为非负有限数值');
  }
  return result;
}

export function calibrateHistoricalMainContracts(
  instrumentId: Instrument,
  summaries: readonly HistoricalContractDailySummary[],
  candidateMappings: readonly MainContractMapping[],
  referenceMappings: readonly MainContractMapping[],
  referenceMainDaily: readonly EdbDailyRecord[],
  thresholdOverrides: Partial<HistoricalMainCalibrationThresholds> = {},
): HistoricalMainCalibrationReport {
  const thresholds = normalizedThresholds(thresholdOverrides);
  const candidate = indexedMappings(candidateMappings, '候选主力映射');
  const reference = indexedMappings(referenceMappings, 'EDB 主力映射');
  const summaryByKey = new Map<string, HistoricalContractDailySummary>();
  for (const summary of summaries) {
    if (summary.instrumentId !== instrumentId) {
      throw new Error('校准日汇总包含其他品种');
    }
    const key = recordKey(summary.tradingDate, summary.contract);
    if (summaryByKey.has(key)) throw new Error(`校准日汇总重复：${key}`);
    summaryByKey.set(key, summary);
  }
  const dailyByDate = new Map<string, EdbDailyRecord>();
  for (const row of referenceMainDaily) {
    if (dailyByDate.has(row.tradingDate)) {
      throw new Error(`EDB 主连日线交易日重复：${row.tradingDate}`);
    }
    dailyByDate.set(row.tradingDate, row);
  }

  const overlapDates = candidate.rows
    .map(mapping => mapping.tradingDate)
    .filter(date => reference.byDate.has(date));
  const days: HistoricalMainCalibrationDay[] = overlapDates.map(tradingDate => {
    const candidateMapping = candidate.byDate.get(tradingDate)!;
    const referenceMapping = reference.byDate.get(tradingDate)!;
    const summary = summaryByKey.get(recordKey(tradingDate, candidateMapping.contract));
    const referenceDaily = dailyByDate.get(tradingDate);
    const issues: string[] = [];
    if (!summary) issues.push('缺少候选合约日汇总');
    if (!referenceDaily) issues.push('缺少 EDB 主连日线');
    const ohlcDifferences = summary && referenceDaily
      ? {
          open: Math.abs(summary.open - referenceDaily.open),
          high: Math.abs(summary.high - referenceDaily.high),
          low: Math.abs(summary.low - referenceDaily.low),
          close: Math.abs(summary.close - referenceDaily.close),
        }
      : undefined;
    const ohlcMatches = ohlcDifferences !== undefined
      && Object.values(ohlcDifferences).every(value => value <= thresholds.priceTolerance);
    const candidateRollover = candidate.rolloverDates.has(tradingDate);
    const referenceRollover = reference.rolloverDates.has(tradingDate);
    return {
      tradingDate,
      candidateContract: candidateMapping.contract,
      referenceContract: referenceMapping.contract,
      contractMatches: candidateMapping.contract === referenceMapping.contract,
      candidateOhlc: summary && {
        open: summary.open,
        high: summary.high,
        low: summary.low,
        close: summary.close,
      },
      referenceOhlc: referenceDaily && {
        open: referenceDaily.open,
        high: referenceDaily.high,
        low: referenceDaily.low,
        close: referenceDaily.close,
      },
      ohlcDifferences,
      ohlcMatches,
      candidateRollover,
      referenceRollover,
      rolloverMatches: candidateRollover === referenceRollover,
      issues,
    };
  });

  const affectedDates = {
    missingEvidence: days.filter(day => day.issues.length).map(day => day.tradingDate),
    contractMismatch: days.filter(day => !day.contractMatches).map(day => day.tradingDate),
    ohlcMismatch: days.filter(day => !day.ohlcMatches).map(day => day.tradingDate),
    rolloverMismatch: days.filter(day => !day.rolloverMatches).map(day => day.tradingDate),
  };
  const counts = {
    missingEvidence: affectedDates.missingEvidence.length,
    contractMismatch: affectedDates.contractMismatch.length,
    ohlcMismatch: affectedDates.ohlcMismatch.length,
    rolloverMismatch: affectedDates.rolloverMismatch.length,
  };
  const violations: string[] = [];
  if (days.length < thresholds.minOverlapDays) {
    violations.push(`重叠交易日不足：${days.length} < ${thresholds.minOverlapDays}`);
  }
  if (counts.missingEvidence > 0) {
    violations.push(`存在 ${counts.missingEvidence} 个缺少校准证据的交易日`);
  }
  if (counts.contractMismatch > thresholds.maxContractMismatchDays) {
    violations.push(
      `主力合约差异超限：${counts.contractMismatch}`
      + ` > ${thresholds.maxContractMismatchDays}`,
    );
  }
  if (counts.ohlcMismatch > thresholds.maxOhlcMismatchDays) {
    violations.push(
      `OHLC 差异超限：${counts.ohlcMismatch} > ${thresholds.maxOhlcMismatchDays}`,
    );
  }
  if (counts.rolloverMismatch > thresholds.maxRolloverMismatchDays) {
    violations.push(
      `换月日期差异超限：${counts.rolloverMismatch}`
      + ` > ${thresholds.maxRolloverMismatchDays}`,
    );
  }

  return {
    schemaVersion: 1,
    instrumentId,
    overlap: {
      firstTradingDate: overlapDates[0],
      lastTradingDate: overlapDates.at(-1),
      days: days.length,
    },
    thresholds,
    days,
    affectedDates,
    counts,
    activation: {
      allowed: violations.length === 0,
      violations,
    },
  };
}

export function stitchHistoricalMainContract(
  records: readonly NormalizedContractFiveMinuteRecord[],
  mappings: readonly MainContractMapping[],
): StitchedHistoricalMainContract {
  if (!mappings.length) throw new Error('最终主力映射不能为空');
  const indexed = indexedMappings(mappings, '最终主力映射');
  const recordsByKey = new Map<string, NormalizedContractFiveMinuteRecord[]>();
  for (const record of records) {
    assertRecordValid(record);
    const key = recordKey(record.tradingDate, record.contract);
    const group = recordsByKey.get(key) ?? [];
    group.push(record);
    recordsByKey.set(key, group);
  }

  const bars5: Bar[] = [];
  const rollovers: ContractRollover[] = [];
  let instrumentId: Instrument | undefined;
  for (let index = 0; index < indexed.rows.length; index += 1) {
    const mapping = indexed.rows[index];
    const selectedRecords = recordsByKey.get(recordKey(
      mapping.tradingDate,
      mapping.contract,
    ));
    if (!selectedRecords?.length) {
      throw new Error(`${mapping.tradingDate} ${mapping.contract} 缺少实际 5 分钟记录`);
    }
    selectedRecords.sort((left, right) => left.startMs - right.startMs);
    if (instrumentId === undefined) instrumentId = selectedRecords[0].instrumentId;
    if (selectedRecords.some(record => record.instrumentId !== instrumentId)) {
      throw new Error('主连拼接不得混入多个品种');
    }
    for (const record of selectedRecords) {
      bars5.push({
        startMs: record.startMs,
        endMs: record.endMs,
        start: record.start,
        end: record.end,
        open: record.open,
        high: record.high,
        low: record.low,
        close: record.close,
        volume: record.volume,
        openOi: record.openInterest,
        closeOi: record.openInterest,
        session: record.session,
        observedMinutes: 5,
        expectedMinutes: 5,
        complete: true,
      });
    }
    const previous = indexed.rows[index - 1];
    if (previous && previous.contract !== mapping.contract) {
      const first = selectedRecords[0];
      rollovers.push({
        tradingDate: mapping.tradingDate,
        time: formatBeijing(first.startMs),
        timeMs: first.startMs,
        fromContract: previous.contract,
        toContract: mapping.contract,
      });
    }
  }
  bars5.sort((left, right) => left.startMs - right.startMs);
  for (let index = 1; index < bars5.length; index += 1) {
    if (bars5[index].startMs <= bars5[index - 1].startMs) {
      throw new Error(`主连拼接存在重复或倒序时间戳：${bars5[index].start}`);
    }
  }
  assertBarsValid(
    bars5,
    5,
    instrumentDefinition(instrumentId!).tradingSessions,
  );
  return {
    bars5,
    mappings: indexed.rows,
    rollovers,
  };
}

export function buildAuthoritativeDesktopMainContract(
  instrumentId: Instrument,
  bars5: readonly Bar[],
  mappings: readonly MainContractMapping[],
): StitchedHistoricalMainContract {
  if (!bars5.length) throw new Error('桌面主连 5 分钟价格序列不能为空');
  if (!mappings.length) throw new Error('桌面主连最终映射不能为空');
  const definition = instrumentDefinition(instrumentId);
  const indexed = indexedMappings(mappings, '桌面主连最终映射');
  for (const mapping of indexed.rows) {
    if (!isConcreteContractCode(definition, mapping.contract)) {
      throw new Error(
        `${mapping.tradingDate} 的合约代码不符合${definition.shortName}规则：`
        + mapping.contract,
      );
    }
    if (definition.exchange === 'CZCE'
      && !new RegExp(`^${definition.productCode}\\d{4}$`).test(mapping.contract)) {
      throw new Error(
        `${mapping.tradingDate} 的郑商所合约必须使用四位年份代码：`
        + mapping.contract,
      );
    }
  }
  assertBarsValid(bars5, 5, definition.tradingSessions);
  const preservedBars = [...bars5];
  return {
    bars5: preservedBars,
    mappings: indexed.rows,
    rollovers: detectContractRollovers(indexed.rows, preservedBars, definition),
  };
}

export function activateHistoricalMainContractCandidate(
  records: readonly NormalizedContractFiveMinuteRecord[],
  selection: HistoricalMainContractSelection,
  calibration: HistoricalMainCalibrationReport,
): HistoricalMainContractActivationResult {
  const reasons: string[] = [];
  if (selection.blocked) {
    reasons.push(`历史主力判定存在 ${selection.affectedDates.length} 个未确认交易日`);
  }
  if (calibration.instrumentId !== selection.instrumentId) {
    reasons.push('校准报告与主力判定品种不一致');
  }
  reasons.push(...calibration.activation.violations);
  const affectedDates = [...new Set([
    ...selection.affectedDates,
    ...calibration.affectedDates.missingEvidence,
    ...calibration.affectedDates.contractMismatch,
    ...calibration.affectedDates.ohlcMismatch,
    ...calibration.affectedDates.rolloverMismatch,
  ])].sort();
  if (reasons.length) {
    return {
      ok: false,
      mappings: selection.mappings,
      affectedDates,
      reasons,
    };
  }
  try {
    return {
      ok: true,
      candidate: stitchHistoricalMainContract(records, selection.mappings),
    };
  } catch (error) {
    return {
      ok: false,
      mappings: selection.mappings,
      affectedDates,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}
