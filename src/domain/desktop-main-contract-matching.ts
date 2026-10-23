import {
  instrumentDefinition,
  type Instrument,
} from '../shared/instruments';
import type { MainContractMapping } from '../shared/types';
import type {
  HistoricalMainCalibrationDay,
  HistoricalMainCalibrationReport,
  HistoricalMainContractCandidateDecision,
  HistoricalMainContractSelection,
} from './historical-main-contract';

export type DesktopMainMatchValueField =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'amount'
  | 'volume'
  | 'openInterest';

export type DesktopMainMatchField = 'timestamp' | DesktopMainMatchValueField;

export type DesktopMainMismatchField = DesktopMainMatchField | 'rowCount';

export interface DesktopMainMismatchDifference {
  field: DesktopMainMismatchField;
  mainValue: number | string | null;
  candidateValue: number | string | null;
  absoluteDifference: number | null;
}

export interface DesktopMainMismatchSample {
  timestamp: string;
  fields: DesktopMainMismatchField[];
  differences: DesktopMainMismatchDifference[];
}

export interface DesktopMainMatchMinuteRecord {
  instrumentId: Instrument;
  tradingDate: string;
  contract?: string;
  timestamp: string;
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  amount: number | null;
  volume: number | null;
  openInterest: number | null;
}

export interface DesktopMainContractCandidateAudit {
  contract: string;
  mainRows: number;
  rows: number;
  exact: boolean;
  participatingFields: DesktopMainMatchField[];
  unavailableFields: DesktopMainMatchValueField[];
  mismatchFields: DesktopMainMismatchField[];
  mismatchRows: number;
  timestampMismatchRows: number;
  ohlcMismatchRows: number;
  optionalMismatchRows: number;
  fullyMatchingRows: number;
  fullFieldMatchRate: number;
  tradeStatisticsDifferences: {
    amount: DesktopMainTradeStatisticDifference;
    volume: DesktopMainTradeStatisticDifference;
  };
  mismatchSamples: DesktopMainMismatchSample[];
  firstMismatchTimestamp?: string;
}

export interface DesktopMainTradeStatisticDifference {
  absoluteDifference: number | null;
  candidateTotal: number | null;
  differenceRatio: number | null;
}

export type DesktopMainSourceVarianceRule =
  | 'general-limited-source-variance'
  | 'trade-statistics-only';

export interface DesktopMainContractSourceVarianceAudit {
  status: 'selected' | 'rejected';
  selectedContract?: string;
  selectedRule?: DesktopMainSourceVarianceRule;
  qualifyingContracts: string[];
  qualifyingCandidates: Array<{
    contract: string;
    rule: DesktopMainSourceVarianceRule;
  }>;
  segmentTradingDates: string[];
  previousExactMatch?: MainContractMapping;
  nextExactMatch?: MainContractMapping;
  thresholds: {
    minimumFullFieldMatchRate: number;
    maximumMismatchRows: number;
    maximumOhlcMismatchRows: number;
    maximumConsecutiveDays: number;
    tradeStatisticsOnly: {
      maximumMismatchRows: number;
      maximumVolumeDifferenceRatio: number;
      maximumAmountDifferenceRatio: number;
    };
  };
  issues: string[];
}

export interface DesktopMainContractRolloverBoundaryAudit {
  status: 'selected' | 'rejected';
  selectedContract?: string;
  selectedRule?: DesktopMainSourceVarianceRule;
  qualifyingContracts: string[];
  qualifyingCandidates: Array<{
    contract: string;
    rule: DesktopMainSourceVarianceRule;
  }>;
  previousExactMatch?: MainContractMapping;
  nextExactMatch?: MainContractMapping;
  candidateAnchor?: 'previous-exact' | 'next-exact';
  inferredRolloverTradingDate?: string;
  adjacentExpiry: {
    allowedCandidateMonths: number[];
    fromContract?: string;
    fromYearMonth?: string;
    toContract?: string;
    toYearMonth?: string;
    expectedNextYearMonth?: string;
    adjacentForward: boolean;
  };
  thresholds: DesktopMainContractSourceVarianceAudit['thresholds'];
  issues: string[];
}

export interface DesktopMainContractDayAudit {
  tradingDate: string;
  status: 'matched' | 'ambiguous';
  method:
    | 'exact-minute-sequence'
    | 'neighbor-confirmed-source-variance'
    | 'rollover-boundary-source-variance'
    | 'heuristic-fallback'
    | 'unresolved';
  selectedContract?: string;
  confidence: number;
  participatingFields: DesktopMainMatchField[];
  unavailableFields: DesktopMainMatchValueField[];
  candidates: DesktopMainContractCandidateAudit[];
  exactMatch: {
    status: 'unique' | 'zero' | 'multiple';
    matchingContracts: string[];
    reasons: string[];
  };
  sourceVariance?: DesktopMainContractSourceVarianceAudit;
  rolloverBoundarySourceVariance?: DesktopMainContractRolloverBoundaryAudit;
  heuristic: DesktopMainContractHeuristicAudit;
  rollover?: {
    tradingDate: string;
    fromContract: string;
    toContract: string;
  };
  ambiguityReasons: string[];
}

export interface DesktopMainContractExactMatchReport {
  schemaVersion: 6;
  instrumentId: Instrument;
  mappings: MainContractMapping[];
  days: DesktopMainContractDayAudit[];
  blocked: boolean;
  affectedDates: string[];
  summary: {
    tradingDays: number;
    matchedDays: number;
    uniqueExactMatches: number;
    sourceVarianceFallbackMatches: number;
    rolloverBoundarySourceVarianceMatches: number;
    heuristicFallbackMatches: number;
    zeroExactMatches: number;
    multipleExactMatches: number;
    uniqueExactMatchRate: number;
    minimumConfidence: number;
  };
}

export interface DesktopMainContractFallbackEvidence {
  selection: HistoricalMainContractSelection;
  calibration: HistoricalMainCalibrationReport;
}

export type DesktopMainHeuristicFallbackPolicy = 'allowed' | 'disabled';

export interface DesktopMainContractMatchOptions {
  heuristicFallback?: DesktopMainHeuristicFallbackPolicy;
}

export interface DesktopMainContractAuditInput {
  tradingDate: string;
  candidates: readonly DesktopMainContractCandidateAudit[];
}

export interface DesktopMainContractHeuristicAudit {
  status: 'unavailable' | 'selected' | 'rejected';
  selectedContract?: string;
  candidates: HistoricalMainContractCandidateDecision[];
  disagreementWithExact: boolean;
  calibration: {
    allowed: boolean;
    overlapDays: number;
    day?: HistoricalMainCalibrationDay;
    violations: string[];
  };
  issues: string[];
}

const REQUIRED_VALUE_FIELDS = [
  'open',
  'high',
  'low',
  'close',
] as const satisfies readonly DesktopMainMatchValueField[];

const OPTIONAL_VALUE_FIELDS = [
  'amount',
  'volume',
  'openInterest',
] as const satisfies readonly DesktopMainMatchValueField[];

export const DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS = {
  minimumFullFieldMatchRate: 0.99,
  maximumMismatchRows: 3,
  maximumOhlcMismatchRows: 2,
  maximumConsecutiveDays: 2,
} as const;

export const DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS = {
  maximumMismatchRows: 5,
  maximumVolumeDifferenceRatio: 0.0005,
  maximumAmountDifferenceRatio: 0.0005,
} as const;

const MAX_MISMATCH_SAMPLES = 5;

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`交易日必须为 YYYY-MM-DD：${value}`);
  }
}

function assertRecordValid(
  record: DesktopMainMatchMinuteRecord,
  expectedInstrument: Instrument,
  requireContract: boolean,
): void {
  if (record.instrumentId !== expectedInstrument) {
    throw new Error('桌面主连精确匹配不得混入多个品种');
  }
  assertDate(record.tradingDate);
  if (requireContract && !record.contract?.trim()) {
    throw new Error(`${record.tradingDate} 的具体合约代码缺失`);
  }
  if (!Number.isSafeInteger(record.startMs)) {
    throw new Error(`${record.tradingDate} 的分钟时间戳无效`);
  }
  if (!record.timestamp.trim()) {
    throw new Error(`${record.tradingDate} 的分钟时间文本缺失`);
  }
  for (const field of REQUIRED_VALUE_FIELDS) {
    if (!Number.isFinite(record[field])) {
      throw new Error(`${record.tradingDate} ${field} 缺失或不是有限数值`);
    }
  }
  for (const field of OPTIONAL_VALUE_FIELDS) {
    const value = record[field];
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`${record.tradingDate} ${field} 不是有限数值`);
    }
  }
}

function groupedByDate(
  records: readonly DesktopMainMatchMinuteRecord[],
  expectedInstrument: Instrument,
): Map<string, DesktopMainMatchMinuteRecord[]> {
  const groups = new Map<string, DesktopMainMatchMinuteRecord[]>();
  for (const record of records) {
    assertRecordValid(record, expectedInstrument, false);
    if (record.contract !== undefined) {
      throw new Error(`${record.tradingDate} 的主连分钟记录不得携带具体合约代码`);
    }
    const group = groups.get(record.tradingDate) ?? [];
    group.push(record);
    groups.set(record.tradingDate, group);
  }
  for (const [tradingDate, group] of groups) {
    group.sort((left, right) => left.startMs - right.startMs);
    for (let index = 1; index < group.length; index += 1) {
      if (group[index].startMs <= group[index - 1].startMs) {
        throw new Error(`${tradingDate} 的主连分钟时间戳重复或倒序`);
      }
    }
  }
  return groups;
}

function candidatesByDate(
  records: readonly DesktopMainMatchMinuteRecord[],
  expectedInstrument: Instrument,
): Map<string, Map<string, DesktopMainMatchMinuteRecord[]>> {
  const groups = new Map<string, Map<string, DesktopMainMatchMinuteRecord[]>>();
  for (const record of records) {
    assertRecordValid(record, expectedInstrument, true);
    const contract = record.contract!.trim();
    const daily = groups.get(record.tradingDate) ?? new Map();
    const group = daily.get(contract) ?? [];
    group.push({ ...record, contract });
    daily.set(contract, group);
    groups.set(record.tradingDate, daily);
  }
  for (const [tradingDate, daily] of groups) {
    for (const [contract, group] of daily) {
      group.sort((left, right) => left.startMs - right.startMs);
      for (let index = 1; index < group.length; index += 1) {
        if (group[index].startMs <= group[index - 1].startMs) {
          throw new Error(`${tradingDate} ${contract} 的分钟时间戳重复或倒序`);
        }
      }
    }
  }
  return groups;
}

function fieldAvailable(
  records: readonly DesktopMainMatchMinuteRecord[],
  field: DesktopMainMatchValueField,
): boolean {
  return records.every(record => record[field] !== null);
}

function sameSourceNumber(
  field: DesktopMainMatchValueField,
  left: number | null,
  right: number | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (field === 'amount' && Math.abs(left - right) <= 0.0001) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 32;
}

function tradeStatisticDifference(
  main: readonly DesktopMainMatchMinuteRecord[],
  candidate: readonly DesktopMainMatchMinuteRecord[],
  field: 'amount' | 'volume',
): DesktopMainTradeStatisticDifference {
  if (!fieldAvailable(main, field) || !fieldAvailable(candidate, field)) {
    return {
      absoluteDifference: null,
      candidateTotal: null,
      differenceRatio: null,
    };
  }
  const sharedRows = Math.min(main.length, candidate.length);
  let absoluteDifference = 0;
  for (let index = 0; index < sharedRows; index += 1) {
    const mainValue = main[index][field]!;
    const candidateValue = candidate[index][field]!;
    if (!sameSourceNumber(field, mainValue, candidateValue)) {
      absoluteDifference += Math.abs(mainValue - candidateValue);
    }
  }
  const candidateTotal = candidate.reduce(
    (total, record) => total + Math.abs(record[field]!),
    0,
  );
  const differenceRatio = candidateTotal > 0
    ? absoluteDifference / candidateTotal
    : absoluteDifference === 0
      ? 0
      : null;
  return {
    absoluteDifference,
    candidateTotal,
    differenceRatio,
  };
}

export function compareDesktopMainContractCandidate(
  main: readonly DesktopMainMatchMinuteRecord[],
  contract: string,
  candidate: readonly DesktopMainMatchMinuteRecord[],
): DesktopMainContractCandidateAudit {
  const participatingFields: DesktopMainMatchField[] = [
    'timestamp',
    ...REQUIRED_VALUE_FIELDS,
  ];
  const unavailableFields: DesktopMainMatchValueField[] = [];
  for (const field of OPTIONAL_VALUE_FIELDS) {
    if (fieldAvailable(main, field) && fieldAvailable(candidate, field)) {
      participatingFields.push(field);
    } else {
      unavailableFields.push(field);
    }
  }

  const mismatchFields = new Set<DesktopMainMismatchField>();
  const mismatchSamples: DesktopMainMismatchSample[] = [];
  let firstMismatchTimestamp: string | undefined;
  let mismatchRows = 0;
  let timestampMismatchRows = 0;
  let ohlcMismatchRows = 0;
  let optionalMismatchRows = 0;
  let fullyMatchingRows = 0;
  if (main.length !== candidate.length) mismatchFields.add('rowCount');
  const sharedRows = Math.min(main.length, candidate.length);
  for (let index = 0; index < sharedRows; index += 1) {
    const mainRecord = main[index];
    const candidateRecord = candidate[index];
    const rowMismatchFields: DesktopMainMismatchField[] = [];
    const differences: DesktopMainMismatchDifference[] = [];
    if (mainRecord.startMs !== candidateRecord.startMs) {
      mismatchFields.add('timestamp');
      rowMismatchFields.push('timestamp');
      differences.push({
        field: 'timestamp',
        mainValue: mainRecord.timestamp,
        candidateValue: candidateRecord.timestamp,
        absoluteDifference: Math.abs(
          mainRecord.startMs - candidateRecord.startMs,
        ),
      });
      timestampMismatchRows += 1;
      firstMismatchTimestamp ??= mainRecord.timestamp;
    } else {
      let ohlcMismatch = false;
      let optionalMismatch = false;
      for (const field of participatingFields) {
        if (field === 'timestamp') continue;
        if (!sameSourceNumber(field, mainRecord[field], candidateRecord[field])) {
          mismatchFields.add(field);
          rowMismatchFields.push(field);
          differences.push({
            field,
            mainValue: mainRecord[field],
            candidateValue: candidateRecord[field],
            absoluteDifference: mainRecord[field] !== null
              && candidateRecord[field] !== null
              ? Math.abs(mainRecord[field] - candidateRecord[field])
              : null,
          });
          firstMismatchTimestamp ??= mainRecord.timestamp;
          if ((REQUIRED_VALUE_FIELDS as readonly DesktopMainMatchValueField[])
            .includes(field)) {
            ohlcMismatch = true;
          } else {
            optionalMismatch = true;
          }
        }
      }
      if (ohlcMismatch) ohlcMismatchRows += 1;
      if (optionalMismatch) optionalMismatchRows += 1;
    }
    if (rowMismatchFields.length) {
      mismatchRows += 1;
      if (mismatchSamples.length < MAX_MISMATCH_SAMPLES) {
        mismatchSamples.push({
          timestamp: mainRecord.timestamp,
          fields: rowMismatchFields,
          differences,
        });
      }
    } else {
      fullyMatchingRows += 1;
    }
  }
  if (main.length !== candidate.length) {
    const rowDifference = Math.abs(main.length - candidate.length);
    mismatchRows += rowDifference;
    firstMismatchTimestamp ??= main[sharedRows]?.timestamp
      ?? candidate[sharedRows]?.timestamp;
    if (mismatchSamples.length < MAX_MISMATCH_SAMPLES) {
      mismatchSamples.push({
        timestamp: main[sharedRows]?.timestamp
          ?? candidate[sharedRows]?.timestamp
          ?? 'unknown',
        fields: ['rowCount'],
        differences: [{
          field: 'rowCount',
          mainValue: main.length,
          candidateValue: candidate.length,
          absoluteDifference: Math.abs(main.length - candidate.length),
        }],
      });
    }
  }
  const comparisonRows = Math.max(main.length, candidate.length);

  return {
    contract,
    mainRows: main.length,
    rows: candidate.length,
    exact: mismatchFields.size === 0,
    participatingFields,
    unavailableFields,
    mismatchFields: [...mismatchFields],
    mismatchRows,
    timestampMismatchRows,
    ohlcMismatchRows,
    optionalMismatchRows,
    fullyMatchingRows,
    fullFieldMatchRate: comparisonRows
      ? fullyMatchingRows / comparisonRows
      : 0,
    tradeStatisticsDifferences: {
      amount: tradeStatisticDifference(main, candidate, 'amount'),
      volume: tradeStatisticDifference(main, candidate, 'volume'),
    },
    mismatchSamples,
    firstMismatchTimestamp,
  };
}

function heuristicAuditForDate(
  instrumentId: Instrument,
  tradingDate: string,
  exactContract: string | undefined,
  fallback: DesktopMainContractFallbackEvidence | undefined,
): DesktopMainContractHeuristicAudit {
  if (!fallback) {
    return {
      status: 'unavailable',
      candidates: [],
      disagreementWithExact: false,
      calibration: {
        allowed: false,
        overlapDays: 0,
        violations: ['未提供启发式选择和校准证据'],
      },
      issues: ['未提供启发式选择和校准证据'],
    };
  }

  const issues: string[] = [];
  if (fallback.selection.instrumentId !== instrumentId) {
    issues.push('启发式选择与桌面主连品种不一致');
  }
  if (fallback.calibration.instrumentId !== instrumentId) {
    issues.push('启发式校准与桌面主连品种不一致');
  }
  const decision = fallback.selection.decisions.find(
    item => item.tradingDate === tradingDate,
  );
  const calibrationDay = fallback.calibration.days.find(
    item => item.tradingDate === tradingDate,
  );
  if (!decision) issues.push('缺少该交易日的启发式选择结果');
  const selectedContract = decision?.selectedContract;
  if (decision?.status === 'rejected') {
    issues.push(decision.reason ?? '启发式选择被拒绝');
  }
  if (decision?.status === 'selected') {
    const mappings = fallback.selection.mappings.filter(
      item => item.tradingDate === tradingDate,
    );
    if (mappings.length !== 1 || mappings[0].contract !== selectedContract) {
      issues.push('启发式选择与主力映射结果不一致');
    }
  }
  if (calibrationDay?.issues.length) {
    issues.push(...calibrationDay.issues.map(issue => `校准证据：${issue}`));
  }
  const calibrationViolations = fallback.calibration.activation.violations;
  if (calibrationViolations.length) {
    issues.push(...calibrationViolations.map(reason => `校准未通过：${reason}`));
  }

  return {
    status: decision?.status === 'selected' && selectedContract
      ? 'selected'
      : 'rejected',
    selectedContract,
    candidates: decision?.candidates ?? [],
    disagreementWithExact: Boolean(
      exactContract
      && selectedContract
      && exactContract !== selectedContract,
    ),
    calibration: {
      allowed: fallback.calibration.instrumentId === instrumentId
        && fallback.calibration.activation.allowed,
      overlapDays: fallback.calibration.overlap.days,
      day: calibrationDay,
      violations: calibrationViolations,
    },
    issues,
  };
}

function uniqueUnavailableFields(
  candidates: readonly DesktopMainContractCandidateAudit[],
): DesktopMainMatchValueField[] {
  const unavailable = new Set<DesktopMainMatchValueField>();
  for (const candidate of candidates) {
    for (const field of candidate.unavailableFields) unavailable.add(field);
  }
  return [...unavailable];
}

function uniqueExactMapping(
  input: DesktopMainContractAuditInput | undefined,
): MainContractMapping | undefined {
  if (!input) return undefined;
  const exact = input.candidates.filter(candidate => candidate.exact);
  return exact.length === 1
    ? { tradingDate: input.tradingDate, contract: exact[0].contract }
    : undefined;
}

interface SourceVarianceThresholdMatch {
  candidate: DesktopMainContractCandidateAudit;
  rule: DesktopMainSourceVarianceRule;
}

function generalSourceVarianceThresholdMatches(
  candidate: DesktopMainContractCandidateAudit,
): boolean {
  return (
    candidate.mismatchRows > 0
    && !candidate.mismatchFields.includes('rowCount')
    && candidate.timestampMismatchRows === 0
    && candidate.fullFieldMatchRate
      >= DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS.minimumFullFieldMatchRate
    && candidate.mismatchRows
      <= DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS.maximumMismatchRows
    && candidate.ohlcMismatchRows
      <= DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS.maximumOhlcMismatchRows
  );
}

function tradeStatisticsOnlyThresholdMatches(
  candidate: DesktopMainContractCandidateAudit,
): boolean {
  const allowedMismatchFields = new Set<DesktopMainMismatchField>([
    'amount',
    'volume',
  ]);
  const amountRatio = candidate.tradeStatisticsDifferences.amount.differenceRatio;
  const volumeRatio = candidate.tradeStatisticsDifferences.volume.differenceRatio;
  return (
    candidate.mismatchRows > 0
    && candidate.mismatchRows
      <= DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS.maximumMismatchRows
    && candidate.timestampMismatchRows === 0
    && candidate.ohlcMismatchRows === 0
    && !candidate.unavailableFields.includes('amount')
    && !candidate.unavailableFields.includes('volume')
    && !candidate.unavailableFields.includes('openInterest')
    && candidate.mismatchFields.every(field => allowedMismatchFields.has(field))
    && amountRatio !== null
    && amountRatio
      <= DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS.maximumAmountDifferenceRatio
    && volumeRatio !== null
    && volumeRatio
      <= DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS.maximumVolumeDifferenceRatio
  );
}

function sourceVarianceThresholdMatches(
  input: DesktopMainContractAuditInput,
): SourceVarianceThresholdMatch[] {
  const matches: SourceVarianceThresholdMatch[] = [];
  for (const candidate of input.candidates) {
    if (generalSourceVarianceThresholdMatches(candidate)) {
      matches.push({
        candidate,
        rule: 'general-limited-source-variance',
      });
    } else if (tradeStatisticsOnlyThresholdMatches(candidate)) {
      matches.push({
        candidate,
        rule: 'trade-statistics-only',
      });
    }
  }
  return matches;
}

function sourceVarianceAuditForDate(
  inputs: readonly DesktopMainContractAuditInput[],
  inputIndex: number,
): DesktopMainContractSourceVarianceAudit {
  const input = inputs[inputIndex];
  const thresholdMatches = sourceVarianceThresholdMatches(input);
  let segmentStart = inputIndex;
  while (segmentStart > 0
    && !uniqueExactMapping(inputs[segmentStart - 1])) {
    segmentStart -= 1;
  }
  let segmentEnd = inputIndex;
  while (segmentEnd + 1 < inputs.length
    && !uniqueExactMapping(inputs[segmentEnd + 1])) {
    segmentEnd += 1;
  }
  const segment = inputs.slice(segmentStart, segmentEnd + 1);
  const segmentTradingDates = segment.map(item => item.tradingDate);
  const segmentThresholdMatches = segment.map(item => ({
    tradingDate: item.tradingDate,
    candidates: sourceVarianceThresholdMatches(item),
  }));
  const previousExactMatch = uniqueExactMapping(inputs[segmentStart - 1]);
  const nextExactMatch = uniqueExactMapping(inputs[segmentEnd + 1]);
  const issues: string[] = [];
  if (!previousExactMatch) {
    issues.push('差异段前一个实际交易日没有唯一逐字段精确匹配');
  }
  if (!nextExactMatch) {
    issues.push('差异段后一个实际交易日没有唯一逐字段精确匹配');
  }
  if (previousExactMatch
    && nextExactMatch
    && previousExactMatch.contract !== nextExactMatch.contract) {
    issues.push(
      `差异段前后相邻精确合约不一致：`
      + `${previousExactMatch.contract} -> ${nextExactMatch.contract}`,
    );
  }
  if (segment.length
    > DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS.maximumConsecutiveDays) {
    issues.push(
      `连续受限源差异段包含 ${segment.length} 个实际交易日，超过上限 `
      + `${DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS.maximumConsecutiveDays}`,
    );
  }
  for (const segmentDay of segmentThresholdMatches) {
    if (segmentDay.candidates.length !== 1) {
      issues.push(
        segmentDay.candidates.length
          ? `${segmentDay.tradingDate} 有多个候选满足受限源差异阈值：`
            + segmentDay.candidates
              .map(match => match.candidate.contract)
              .join('、')
          : `${segmentDay.tradingDate} 没有候选满足受限源差异阈值`,
      );
    }
  }
  const segmentSelections = segmentThresholdMatches
    .filter(item => item.candidates.length === 1)
    .map(item => ({
      tradingDate: item.tradingDate,
      contract: item.candidates[0].candidate.contract,
    }));
  const segmentContracts = new Set(
    segmentSelections.map(item => item.contract),
  );
  if (segmentContracts.size > 1) {
    issues.push(
      '差异段内候选合约不一致：'
      + segmentSelections
        .map(item => `${item.tradingDate}=${item.contract}`)
        .join('、'),
    );
  }
  if (thresholdMatches.length !== 1) {
    const currentIssue = issues.find(issue => issue.startsWith(input.tradingDate));
    if (!currentIssue) {
      issues.push(
        thresholdMatches.length
          ? `有多个候选满足受限源差异阈值：`
            + thresholdMatches
              .map(match => match.candidate.contract)
              .join('、')
          : '没有候选满足受限源差异阈值',
      );
    }
  }
  const selectedMatch = thresholdMatches.length === 1
    ? thresholdMatches[0]
    : undefined;
  const selected = selectedMatch?.candidate;
  if (selected
    && previousExactMatch
    && selected.contract !== previousExactMatch.contract) {
    issues.push(
      `候选 ${selected.contract} 与差异段前一交易日精确合约 `
      + `${previousExactMatch.contract} 不一致`,
    );
  }
  if (selected
    && nextExactMatch
    && selected.contract !== nextExactMatch.contract) {
    issues.push(
      `候选 ${selected.contract} 与差异段后一交易日精确合约 `
      + `${nextExactMatch.contract} 不一致`,
    );
  }
  return {
    status: selected && issues.length === 0 ? 'selected' : 'rejected',
    selectedContract: selected && issues.length === 0
      ? selected.contract
      : undefined,
    selectedRule: selected && issues.length === 0
      ? selectedMatch?.rule
      : undefined,
    qualifyingContracts: thresholdMatches.map(match => match.candidate.contract),
    qualifyingCandidates: thresholdMatches.map(match => ({
      contract: match.candidate.contract,
      rule: match.rule,
    })),
    segmentTradingDates,
    previousExactMatch,
    nextExactMatch,
    thresholds: {
      ...DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS,
      tradeStatisticsOnly: {
        ...DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS,
      },
    },
    issues,
  };
}

interface ContractExpiry {
  year: number;
  month: number;
  yearMonth: string;
  prefix: string;
}

function parseFourDigitContractExpiry(contract: string): ContractExpiry | undefined {
  const match = /^(.*?)(\d{2})(\d{2})$/.exec(contract);
  if (!match) return undefined;
  const year = Number(match[2]);
  const month = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return undefined;
  return {
    year,
    month,
    yearMonth: `${match[2]}${match[3]}`,
    prefix: match[1],
  };
}

function expectedNextAllowedYearMonth(
  contract: ContractExpiry,
  candidateMonths: readonly number[],
): string | undefined {
  const months = [...new Set(candidateMonths)].sort((left, right) => left - right);
  const monthIndex = months.indexOf(contract.month);
  if (monthIndex < 0 || months.length === 0) return undefined;
  const nextMonth = months[(monthIndex + 1) % months.length];
  const nextYear = monthIndex === months.length - 1
    ? (contract.year + 1) % 100
    : contract.year;
  return `${String(nextYear).padStart(2, '0')}${String(nextMonth).padStart(2, '0')}`;
}

function rolloverBoundarySourceVarianceAuditForDate(
  instrumentId: Instrument,
  inputs: readonly DesktopMainContractAuditInput[],
  inputIndex: number,
): DesktopMainContractRolloverBoundaryAudit {
  const input = inputs[inputIndex];
  const previousExactMatch = uniqueExactMapping(inputs[inputIndex - 1]);
  const nextExactMatch = uniqueExactMapping(inputs[inputIndex + 1]);
  const thresholdMatches = sourceVarianceThresholdMatches(input);
  const allowedCandidateMonths = [
    ...instrumentDefinition(instrumentId).contractCode.candidateMonths,
  ];
  const fromExpiry = previousExactMatch
    ? parseFourDigitContractExpiry(previousExactMatch.contract)
    : undefined;
  const toExpiry = nextExactMatch
    ? parseFourDigitContractExpiry(nextExactMatch.contract)
    : undefined;
  const expectedNextYearMonth = fromExpiry
    ? expectedNextAllowedYearMonth(fromExpiry, allowedCandidateMonths)
    : undefined;
  const adjacentForward = Boolean(
    fromExpiry
    && toExpiry
    && fromExpiry.prefix === toExpiry.prefix
    && expectedNextYearMonth === toExpiry.yearMonth,
  );
  const issues: string[] = [];

  if (!previousExactMatch) {
    issues.push(
      inputIndex > 0
        ? '前一个实际交易日也未唯一精确匹配，换月边界差异不是单日'
        : '换月边界前一个实际交易日没有唯一逐字段精确匹配',
    );
  }
  if (!nextExactMatch) {
    issues.push(
      inputIndex + 1 < inputs.length
        ? '后一个实际交易日也未唯一精确匹配，换月边界差异不是单日'
        : '换月边界后一个实际交易日没有唯一逐字段精确匹配',
    );
  }
  if (previousExactMatch
    && nextExactMatch
    && previousExactMatch.contract === nextExactMatch.contract) {
    issues.push('换月边界前后精确锚点合约相同');
  }
  if (previousExactMatch && !fromExpiry) {
    issues.push(`前锚点合约不是规范四位到期代码：${previousExactMatch.contract}`);
  }
  if (nextExactMatch && !toExpiry) {
    issues.push(`后锚点合约不是规范四位到期代码：${nextExactMatch.contract}`);
  }
  if (previousExactMatch && nextExactMatch && !adjacentForward) {
    issues.push(
      `前后精确锚点不是允许月份序列中的相邻向后到期合约：`
      + `${previousExactMatch.contract} -> ${nextExactMatch.contract}`,
    );
  }
  if (thresholdMatches.length !== 1) {
    issues.push(
      thresholdMatches.length
        ? `有多个候选满足换月边界单日差异阈值：`
          + thresholdMatches.map(match => match.candidate.contract).join('、')
        : '没有候选满足换月边界单日差异阈值',
    );
  }

  const selectedMatch = thresholdMatches.length === 1
    ? thresholdMatches[0]
    : undefined;
  const selected = selectedMatch?.candidate;
  let candidateAnchor: DesktopMainContractRolloverBoundaryAudit['candidateAnchor'];
  if (selected && previousExactMatch && selected.contract === previousExactMatch.contract) {
    candidateAnchor = 'previous-exact';
  } else if (selected && nextExactMatch && selected.contract === nextExactMatch.contract) {
    candidateAnchor = 'next-exact';
  } else if (selected && previousExactMatch && nextExactMatch) {
    issues.push(
      `候选 ${selected.contract} 不属于任一换月边界精确锚点：`
      + `${previousExactMatch.contract}、${nextExactMatch.contract}`,
    );
  }

  const inferredRolloverTradingDate = candidateAnchor === 'previous-exact'
    ? nextExactMatch?.tradingDate
    : candidateAnchor === 'next-exact'
      ? input.tradingDate
      : undefined;
  const selectedSuccessfully = Boolean(
    selected
    && candidateAnchor
    && issues.length === 0,
  );

  return {
    status: selectedSuccessfully ? 'selected' : 'rejected',
    selectedContract: selectedSuccessfully ? selected?.contract : undefined,
    selectedRule: selectedSuccessfully ? selectedMatch?.rule : undefined,
    qualifyingContracts: thresholdMatches.map(match => match.candidate.contract),
    qualifyingCandidates: thresholdMatches.map(match => ({
      contract: match.candidate.contract,
      rule: match.rule,
    })),
    previousExactMatch,
    nextExactMatch,
    candidateAnchor,
    inferredRolloverTradingDate,
    adjacentExpiry: {
      allowedCandidateMonths,
      fromContract: previousExactMatch?.contract,
      fromYearMonth: fromExpiry?.yearMonth,
      toContract: nextExactMatch?.contract,
      toYearMonth: toExpiry?.yearMonth,
      expectedNextYearMonth,
      adjacentForward,
    },
    thresholds: {
      ...DESKTOP_MAIN_SOURCE_VARIANCE_THRESHOLDS,
      tradeStatisticsOnly: {
        ...DESKTOP_MAIN_TRADE_STATISTICS_ONLY_THRESHOLDS,
      },
    },
    issues,
  };
}

export function resolveDesktopMainContractAudits(
  instrumentId: Instrument,
  auditInputs: readonly DesktopMainContractAuditInput[],
  fallback?: DesktopMainContractFallbackEvidence,
  options: DesktopMainContractMatchOptions = {},
): DesktopMainContractExactMatchReport {
  const heuristicFallbackAllowed = options.heuristicFallback !== 'disabled';
  const inputs = [...auditInputs]
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
    .map(input => ({
      tradingDate: input.tradingDate,
      candidates: [...input.candidates]
        .sort((left, right) => left.contract.localeCompare(right.contract, 'en')),
    }));
  const days: DesktopMainContractDayAudit[] = [];
  const mappings: MainContractMapping[] = [];
  const affectedDates: string[] = [];
  let uniqueExactMatches = 0;
  let sourceVarianceFallbackMatches = 0;
  let rolloverBoundarySourceVarianceMatches = 0;
  let heuristicFallbackMatches = 0;
  let zeroExactMatches = 0;
  let multipleExactMatches = 0;
  const seenDates = new Set<string>();

  for (const input of inputs) {
    assertDate(input.tradingDate);
    if (seenDates.has(input.tradingDate)) {
      throw new Error(`桌面主连候选审计交易日重复：${input.tradingDate}`);
    }
    seenDates.add(input.tradingDate);
    const duplicateContract = input.candidates.find((candidate, index) => (
      input.candidates.findIndex(
        item => item.contract === candidate.contract,
      ) !== index
    ));
    if (duplicateContract) {
      throw new Error(
        `${input.tradingDate} 的桌面主连候选审计合约重复：`
        + duplicateContract.contract,
      );
    }
  }

  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const input = inputs[inputIndex];
    const tradingDate = input.tradingDate;
    const candidates = input.candidates;
    const exact = candidates.filter(candidate => candidate.exact);
    if (exact.length === 1) {
      const selected = exact[0];
      const heuristic = heuristicAuditForDate(
        instrumentId,
        tradingDate,
        selected.contract,
        fallback,
      );
      mappings.push({ tradingDate, contract: selected.contract });
      uniqueExactMatches += 1;
      days.push({
        tradingDate,
        status: 'matched',
        method: 'exact-minute-sequence',
        selectedContract: selected.contract,
        confidence: 1,
        participatingFields: selected.participatingFields,
        unavailableFields: selected.unavailableFields,
        candidates,
        exactMatch: {
          status: 'unique',
          matchingContracts: [selected.contract],
          reasons: [],
        },
        heuristic,
        ambiguityReasons: [],
      });
      continue;
    }

    if (exact.length > 1) {
      multipleExactMatches += 1;
      const ambiguityReasons = [
        `多个具体合约与主连分钟序列精确一致：${exact.map(item => item.contract).join('、')}`,
      ];
      affectedDates.push(tradingDate);
      days.push({
        tradingDate,
        status: 'ambiguous',
        method: 'unresolved',
        confidence: 0,
        participatingFields: exact[0]?.participatingFields ?? [],
        unavailableFields: uniqueUnavailableFields(exact),
        candidates,
        exactMatch: {
          status: 'multiple',
          matchingContracts: exact.map(item => item.contract),
          reasons: ambiguityReasons,
        },
        heuristic: heuristicAuditForDate(
          instrumentId,
          tradingDate,
          undefined,
          fallback,
        ),
        ambiguityReasons,
      });
      continue;
    }

    zeroExactMatches += 1;
    const exactReasons = [
      candidates.length
        ? '没有具体合约与主连分钟序列精确一致'
        : '没有同源具体合约分钟记录',
    ];
    const sourceVariance = sourceVarianceAuditForDate(inputs, inputIndex);
    const sourceVarianceCandidate = sourceVariance.selectedContract
      ? candidates.find(
          candidate => candidate.contract === sourceVariance.selectedContract,
        )
      : undefined;
    if (sourceVariance.status === 'selected' && sourceVarianceCandidate) {
      mappings.push({
        tradingDate,
        contract: sourceVarianceCandidate.contract,
      });
      sourceVarianceFallbackMatches += 1;
      days.push({
        tradingDate,
        status: 'matched',
        method: 'neighbor-confirmed-source-variance',
        selectedContract: sourceVarianceCandidate.contract,
        confidence: sourceVarianceCandidate.fullFieldMatchRate,
        participatingFields: sourceVarianceCandidate.participatingFields,
        unavailableFields: sourceVarianceCandidate.unavailableFields,
        candidates,
        exactMatch: {
          status: 'zero',
          matchingContracts: [],
          reasons: exactReasons,
        },
        sourceVariance,
        heuristic: heuristicAuditForDate(
          instrumentId,
          tradingDate,
          sourceVarianceCandidate.contract,
          fallback,
        ),
        ambiguityReasons: [],
      });
      continue;
    }
    const rolloverBoundarySourceVariance
      = rolloverBoundarySourceVarianceAuditForDate(
        instrumentId,
        inputs,
        inputIndex,
      );
    const rolloverBoundaryCandidate
      = rolloverBoundarySourceVariance.selectedContract
        ? candidates.find(candidate => (
            candidate.contract === rolloverBoundarySourceVariance.selectedContract
          ))
        : undefined;
    if (rolloverBoundarySourceVariance.status === 'selected'
      && rolloverBoundaryCandidate) {
      mappings.push({
        tradingDate,
        contract: rolloverBoundaryCandidate.contract,
      });
      rolloverBoundarySourceVarianceMatches += 1;
      days.push({
        tradingDate,
        status: 'matched',
        method: 'rollover-boundary-source-variance',
        selectedContract: rolloverBoundaryCandidate.contract,
        confidence: rolloverBoundaryCandidate.fullFieldMatchRate,
        participatingFields: rolloverBoundaryCandidate.participatingFields,
        unavailableFields: rolloverBoundaryCandidate.unavailableFields,
        candidates,
        exactMatch: {
          status: 'zero',
          matchingContracts: [],
          reasons: exactReasons,
        },
        sourceVariance,
        rolloverBoundarySourceVariance,
        heuristic: heuristicAuditForDate(
          instrumentId,
          tradingDate,
          rolloverBoundaryCandidate.contract,
          fallback,
        ),
        ambiguityReasons: [],
      });
      continue;
    }
    const heuristic = heuristicAuditForDate(
      instrumentId,
      tradingDate,
      undefined,
      fallback,
    );
    const fallbackCandidate = heuristic.selectedContract
      ? candidates.find(candidate => candidate.contract === heuristic.selectedContract)
      : undefined;
    if (heuristic.status === 'selected'
      && heuristicFallbackAllowed
      && heuristic.calibration.allowed
      && heuristic.issues.length === 0
      && fallbackCandidate) {
      mappings.push({
        tradingDate,
        contract: heuristic.selectedContract!,
      });
      heuristicFallbackMatches += 1;
      days.push({
        tradingDate,
        status: 'matched',
        method: 'heuristic-fallback',
        selectedContract: heuristic.selectedContract,
        confidence: 0.5,
        participatingFields: fallbackCandidate.participatingFields,
        unavailableFields: fallbackCandidate.unavailableFields,
        candidates,
        exactMatch: {
          status: 'zero',
          matchingContracts: [],
          reasons: exactReasons,
        },
        heuristic,
        ambiguityReasons: [],
      });
      continue;
    }

    const ambiguityReasons = [...exactReasons];
    ambiguityReasons.push(...sourceVariance.issues.map(
      issue => `受限源差异兜底未通过：${issue}`,
    ));
    ambiguityReasons.push(...rolloverBoundarySourceVariance.issues.map(
      issue => `换月边界源差异兜底未通过：${issue}`,
    ));
    if (heuristic.selectedContract && !fallbackCandidate) {
      ambiguityReasons.push(
        `启发式选择 ${heuristic.selectedContract} 缺少同源分钟候选记录`,
      );
    }
    if (!heuristicFallbackAllowed) {
      ambiguityReasons.push(
        '当前匹配策略禁止 heuristic-fallback 作为激活依据',
      );
    }
    ambiguityReasons.push(...heuristic.issues);
    affectedDates.push(tradingDate);
    days.push({
      tradingDate,
      status: 'ambiguous',
      method: 'unresolved',
      confidence: 0,
      participatingFields: fallbackCandidate?.participatingFields ?? [],
      unavailableFields: fallbackCandidate?.unavailableFields
        ?? uniqueUnavailableFields(candidates),
      candidates,
      exactMatch: {
        status: 'zero',
        matchingContracts: [],
        reasons: exactReasons,
      },
      sourceVariance,
      rolloverBoundarySourceVariance,
      heuristic,
      ambiguityReasons,
    });
  }

  let previousMapping: MainContractMapping | undefined;
  for (const day of days) {
    if (day.status !== 'matched' || !day.selectedContract) continue;
    const mapping = {
      tradingDate: day.tradingDate,
      contract: day.selectedContract,
    };
    if (previousMapping && previousMapping.contract !== mapping.contract) {
      day.rollover = {
        tradingDate: mapping.tradingDate,
        fromContract: previousMapping.contract,
        toContract: mapping.contract,
      };
    }
    previousMapping = mapping;
  }

  return {
    schemaVersion: 6,
    instrumentId,
    mappings,
    days,
    blocked: affectedDates.length > 0,
    affectedDates,
    summary: {
      tradingDays: days.length,
      matchedDays: mappings.length,
      uniqueExactMatches,
      sourceVarianceFallbackMatches,
      rolloverBoundarySourceVarianceMatches,
      heuristicFallbackMatches,
      zeroExactMatches,
      multipleExactMatches,
      uniqueExactMatchRate: days.length ? uniqueExactMatches / days.length : 0,
      minimumConfidence: days.length
        ? Math.min(...days.map(day => day.confidence))
        : 0,
    },
  };
}

export function matchDesktopMainContractDays(
  mainRecords: readonly DesktopMainMatchMinuteRecord[],
  contractRecords: readonly DesktopMainMatchMinuteRecord[],
  fallback?: DesktopMainContractFallbackEvidence,
  options: DesktopMainContractMatchOptions = {},
): DesktopMainContractExactMatchReport {
  if (!mainRecords.length) throw new Error('桌面主连分钟记录不能为空');
  const instrumentId = mainRecords[0].instrumentId;
  const mainByDate = groupedByDate(mainRecords, instrumentId);
  const contractByDate = candidatesByDate(contractRecords, instrumentId);
  const auditInputs = [...mainByDate].map(([tradingDate, main]) => ({
    tradingDate,
    candidates: [...(contractByDate.get(tradingDate) ?? new Map())]
      .map(([contract, records]) => (
        compareDesktopMainContractCandidate(main, contract, records)
      )),
  }));
  return resolveDesktopMainContractAudits(
    instrumentId,
    auditInputs,
    fallback,
    options,
  );
}
