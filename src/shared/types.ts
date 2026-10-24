import type { Instrument, InstrumentDefinition } from './instruments';

export type { Instrument, InstrumentDefinition } from './instruments';
export type Period = 5 | 60;
export type MinuteDecisionGranularity = 'one-minute' | 'five-minute-fallback' | 'five-minute-close';
export interface Bar {
  startMs: number; endMs: number; start: string; end: string;
  open: number; high: number; low: number; close: number;
  volume: number; openOi: number; closeOi: number;
  session: 'day' | 'night'; observedMinutes: number; expectedMinutes: number; complete: boolean;
}
export interface EdbMinuteRecord {
  datetimeNano: string;
  startMs: number;
  start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openOi: number;
  closeOi: number;
}
export interface EdbDailyRecord {
  datetimeNano: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openOi: number;
  closeOi: number;
}
export interface MainContractMapping {
  tradingDate: string;
  contract: string;
}
export interface ContractRollover {
  tradingDate: string;
  time: string;
  timeMs: number;
  fromContract: string;
  toContract: string;
}
export interface SnapshotFileMetadata {
  name: string;
  sha256: string;
  rows: number;
}
interface MarketSnapshotMetadataCommon {
  snapshotId: string;
  generatedAt: string;
  requestStart: string;
  requestEnd: string;
  sourceLatestAt: string;
}
interface LegacyMarketSnapshotMetadataBase extends MarketSnapshotMetadataCommon {
  source: {
    provider: 'EDB';
    endpoint: 'https://edb.shinnytech.com/md/kline';
    symbol: string;
  };
}
export interface MarketSnapshotMetadataV1 extends LegacyMarketSnapshotMetadataBase {
  schemaVersion: 1;
  files: {
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV2 extends LegacyMarketSnapshotMetadataBase {
  schemaVersion: 2;
  files: {
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV3 extends LegacyMarketSnapshotMetadataBase {
  schemaVersion: 3;
  files: {
    bars1: SnapshotFileMetadata;
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV4 extends LegacyMarketSnapshotMetadataBase {
  schemaVersion: 4;
  instrumentId: Instrument;
  mainSymbol: InstrumentDefinition['mainSymbol'];
  parameterVersion: number;
  files: {
    bars1: SnapshotFileMetadata;
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
    mainContractMappings: SnapshotFileMetadata;
  };
}
export interface SnapshotPeriodMetadata {
  first: string;
  last: string;
  rows: number;
}
export type MarketSnapshotSourceKind =
  | 'desktop-main'
  | 'public-history'
  | 'gap-fill'
  | 'edb-tail'
  | 'benchmark-main'
  | 'legacy-migration'
  | 'test-fixture';
export interface MarketSnapshotRawSourceFile {
  name: string;
  sha256: string;
  rows: number;
}
export interface MarketSnapshotSourceSegment {
  sourceId: string;
  sourceName: string;
  kind: MarketSnapshotSourceKind;
  sourceVersion?: string;
  acquiredAt?: string;
  coverage: {
    first: string;
    last: string;
  };
  rawFiles: MarketSnapshotRawSourceFile[];
  importerVersion: string;
  license: {
    identifier?: string;
    redistributionAllowed: boolean;
    conclusion: string;
  };
}
export interface MarketSnapshotRedistribution {
  allowed: boolean;
  conclusion: string;
}
export interface MarketSnapshotMetadataV5 extends MarketSnapshotMetadataCommon {
  schemaVersion: 5;
  instrumentId: Instrument;
  mainSymbol: InstrumentDefinition['mainSymbol'];
  parameterVersion: number;
  source: {
    provider: 'EDB' | 'MIXED';
    endpoint?: 'https://edb.shinnytech.com/md/kline';
    symbol: string;
  };
  sourceSegments: MarketSnapshotSourceSegment[];
  redistribution: MarketSnapshotRedistribution;
  periods: {
    bars1?: SnapshotPeriodMetadata;
    bars5: SnapshotPeriodMetadata;
    bars60: SnapshotPeriodMetadata;
  };
  files: {
    bars1?: SnapshotFileMetadata;
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
    mainContractMappings: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV6 extends MarketSnapshotMetadataCommon {
  schemaVersion: 6;
  instrumentId: Instrument;
  mainSymbol: InstrumentDefinition['mainSymbol'];
  parameterVersion: number;
  source: MarketSnapshotMetadataV5['source'];
  sourceSegments: MarketSnapshotSourceSegment[];
  redistribution: MarketSnapshotRedistribution;
  base: {
    snapshotId: string;
    metadataSha256: string;
  };
  replacementCutoff: string;
  layerSequence: number;
  periods: MarketSnapshotMetadataV5['periods'];
  files: {
    bars1: SnapshotFileMetadata;
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
    mainContractMappings: SnapshotFileMetadata;
  };
}
export type BenchmarkProtectedBarField =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'volume';
export interface MarketSnapshotBenchmarkProtection {
  provider: 'THS';
  reportRunId: string;
  sourceSegmentId: string;
  bars5: {
    firstStart: string;
    lastEnd: string;
    protectedFields: BenchmarkProtectedBarField[];
  };
  bars60: {
    firstStart: string;
    lastEnd: string;
    derivedFrom: 'bars5';
  };
  mappings: {
    firstTradingDate: string;
    lastTradingDate: string;
  };
  rollovers: {
    firstTradingDate: string;
    lastTradingDate: string;
  };
  minutePolicy: 'preserved-audit-only';
  reportSha256: string;
  redistribution: MarketSnapshotRedistribution;
}
interface MarketSnapshotMetadataV7Base extends MarketSnapshotMetadataCommon {
  schemaVersion: 7;
  instrumentId: Instrument;
  mainSymbol: InstrumentDefinition['mainSymbol'];
  parameterVersion: number;
  source: MarketSnapshotMetadataV5['source'];
  sourceSegments: MarketSnapshotSourceSegment[];
  redistribution: MarketSnapshotRedistribution;
  periods: MarketSnapshotMetadataV5['periods'];
  benchmarkProtection: MarketSnapshotBenchmarkProtection;
}
export interface MarketSnapshotMetadataV7Full
  extends MarketSnapshotMetadataV7Base {
  storage: {
    kind: 'full';
  };
  files: MarketSnapshotMetadataV5['files'];
}
export interface MarketSnapshotMetadataV7Tail
  extends MarketSnapshotMetadataV7Base {
  storage: {
    kind: 'tail';
    base: {
      snapshotId: string;
      metadataSha256: string;
    };
    replacementCutoff: string;
    layerSequence: number;
  };
  files: MarketSnapshotMetadataV6['files'];
}
export type MarketSnapshotMetadataV7 =
  | MarketSnapshotMetadataV7Full
  | MarketSnapshotMetadataV7Tail;
export type MarketSnapshotMetadata =
  | MarketSnapshotMetadataV1
  | MarketSnapshotMetadataV2
  | MarketSnapshotMetadataV3
  | MarketSnapshotMetadataV4
  | MarketSnapshotMetadataV5
  | MarketSnapshotMetadataV6
  | MarketSnapshotMetadataV7;
export type SnapshotSource = 'builtin' | 'user';
export interface Anomaly {
  timeMs: number; title: string; detail: string;
}
export interface Dataset {
  instrument: Instrument; definition: InstrumentDefinition; name: string; symbol: string;
  bars1: EdbMinuteRecord[]; bars5: Bar[]; bars60: Bar[];
  mainContractMappings: MainContractMapping[]; rollovers: ContractRollover[]; anomalies: Anomaly[];
  auditAvailable: boolean; dataDirectory: string;
  snapshotSource: SnapshotSource;
  sourceLatestAt: string;
  snapshotUpdatedAt?: string;
}
export type LoadResult = { ok: true; data: Dataset } | { ok: false; error: string };
export type MarketUpdatePhase =
  | 'idle'
  | 'fetching'
  | 'validating'
  | 'saving'
  | 'succeeded'
  | 'up-to-date'
  | 'failed';
export type MarketUpdateIntent = 'full' | 'tail';
export interface MarketUpdateCounts {
  added1: number;
  replaced1: number;
  removed1: number;
  added5: number;
  replaced5: number;
  removed5: number;
  added60: number;
  replaced60: number;
  removed60: number;
  addedRollovers: number;
  replacedRollovers: number;
  removedRollovers: number;
}
export interface PublicMarketUpdateError {
  code: 'network' | 'invalid-response' | 'validation' | 'storage' | 'unexpected';
  message: string;
}
export interface MarketUpdateState {
  instrument: Instrument;
  phase: MarketUpdatePhase;
  intent?: MarketUpdateIntent;
  startedAt?: string;
  completedAt?: string;
  localLatestAt?: string;
  localMinuteLatestAt?: string;
  sourceLatestAt?: string;
  requestStartAt?: string;
  requestEndAt?: string;
  snapshotUpdatedAt?: string;
  counts?: MarketUpdateCounts;
  error?: PublicMarketUpdateError;
}
export interface MarketSnapshotActivatedEvent {
  instrument: Instrument;
  snapshotUpdatedAt: string;
  counts: MarketUpdateCounts;
  mappingsChanged: boolean;
}
export type OnlineMarketPhase =
  | 'disabled'
  | 'catching-up'
  | 'waiting'
  | 'polling'
  | 'source-delayed'
  | 'degraded';
export interface OnlineMarketState {
  enabled: boolean;
  phase: OnlineMarketPhase;
  instrument?: Instrument;
  localMinuteLatestAt?: string;
  sourceLatestAt?: string;
  snapshotUpdatedAt?: string;
  lastSucceededAt?: string;
  nextCheckAt?: string;
  error?: PublicMarketUpdateError;
}
export interface MarketUpdateAllResult {
  startedAt: string;
  completedAt: string;
  results: MarketUpdateState[];
}
export interface MarketAPI {
  load: (instrument: Instrument, reload?: boolean) => Promise<LoadResult>;
  readEntryRules: () => Promise<EntryRulesResult>;
  openAttribution: () => Promise<void>;
  getUpdateState: (instrument: Instrument) => Promise<MarketUpdateState>;
  update: (instrument: Instrument) => Promise<MarketUpdateState>;
  updateAll: () => Promise<MarketUpdateAllResult>;
  onUpdateState: (listener: (state: MarketUpdateState) => void) => () => void;
  getOnlineState: () => Promise<OnlineMarketState>;
  setOnlineEnabled: (enabled: boolean) => Promise<OnlineMarketState>;
  setCurrentInstrument: (instrument: Instrument) => Promise<OnlineMarketState>;
  notifyNetworkRecovered: () => Promise<OnlineMarketState>;
  onOnlineState: (listener: (state: OnlineMarketState) => void) => () => void;
  onSnapshotActivated: (
    listener: (event: MarketSnapshotActivatedEvent) => void,
  ) => () => void;
  testMode: boolean;
}
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'failed';
export type UpdateRequestReason = 'startup' | 'manual';
export type UpdateErrorCode =
  | 'disabled'
  | 'invalid-state'
  | 'check-failed'
  | 'download-failed'
  | 'verification-failed'
  | 'install-failed';
export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}
export interface PublicUpdateError {
  code: UpdateErrorCode;
  message: string;
}
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  currentVersionLabel: string;
  requestedBy?: UpdateRequestReason;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  progress?: UpdateProgress;
  error?: PublicUpdateError;
  checkedAt?: string;
}
export interface UpdateAPI {
  getState: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  restartAndInstall: () => Promise<UpdateState>;
  onState: (listener: (state: UpdateState) => void) => () => void;
}
export type ReactionTestScenario =
  | 'immediate'
  | 'doji-then-reaction'
  | 'no-reaction'
  | 'quarter-divisible'
  | 'quarter-non-divisible'
  | 'quarter-reaction-excluded'
  | 'quarter-wick-touch'
  | 'quarter-repeated-touch'
  | 'quarter-no-touch'
  | 'quarter-autoscale'
  | 'take-profit-entry-touch'
  | 'take-profit-later-touch'
  | 'take-profit-repeated-touch'
  | 'take-profit-no-touch'
  | 'exit-take-profit'
  | 'exit-stop-loss'
  | 'exit-stop-risk-same-bar'
  | 'exit-no-touch'
  | 'two-attempts'
  | 'multiple-abandonments';
export interface StrategyDateRangeBarDiagnostics {
  count: number;
  firstStartMs?: number;
  lastStartMs?: number;
}
export interface StrategyDateRangeAttemptDiagnostics {
  markerId: string;
  attemptNumber: number;
  entryStartMs: number;
  entryDate: string;
  analysisBarCount: number;
  analysisFirstStartMs?: number;
  analysisLastStartMs?: number;
  exitType?: 'take-profit' | 'stop-loss' | 'session-close';
  exitStartMs?: number;
  exitDate?: string;
  exitPrice?: number;
  exitGranularity?: MinuteDecisionGranularity;
  exitMinuteStartMs?: number;
  lineEndMs?: number;
}
export interface StrategyDateRangeDiagnostics {
  reviewStartDate?: string;
  reviewEndDate?: string;
  rawBars5: StrategyDateRangeBarDiagnostics;
  rawBars60: StrategyDateRangeBarDiagnostics;
  totalCandidateCount: number;
  visibleCandidateCount: number;
  visibleMarkerIds: string[];
  attempts: StrategyDateRangeAttemptDiagnostics[];
}
export interface ProfitLossTradeJumpDiagnostic {
  kind: 'completed' | 'incomplete';
  tradeId: string;
  sourceIndex: number;
  entryTimeMs: number;
  markerId?: string;
  barStartMs?: number;
  triggerStartMs?: number;
  sameBarOpportunityCount: number;
  lifecycleFocusCount?: number;
  lifecycleFocusFirstStartMs?: number;
  lifecycleFocusLastStartMs?: number;
}
export interface ProfitLossTradeJumpDiagnostics {
  mode: 'dual' | '5' | '60';
  completed: ProfitLossTradeJumpDiagnostic[];
  incomplete: ProfitLossTradeJumpDiagnostic[];
  backgroundMinuteCount: number;
  chartPeriods: Period[];
  center60StartMs?: number;
  jumpRequestCount: number;
  selection?: {
    period: Period;
    startMs: number;
    markerId?: string;
    source?: 'marker' | 'default';
  };
}
export type RendererSwitchDiagnosticEventType =
  | 'switch-requested'
  | 'loading-visible'
  | 'dataset-ready'
  | 'chart-commit'
  | 'strategy-summary-ready';
export interface RendererSwitchDiagnosticEvent {
  sequence: number;
  type: RendererSwitchDiagnosticEventType;
  requestId: number;
  instrument: Instrument;
  timestampMs: number;
}
export interface RendererFullSetDataDiagnostic {
  requestId: number;
  instrument: Instrument;
  period: Period;
  timestampMs: number;
}
export interface RendererStrategyDerivationDiagnostic {
  requestId: number;
  instrument: Instrument;
  source: 'shared';
  timestampMs: number;
}
export interface RendererPerformanceDiagnostics {
  events: RendererSwitchDiagnosticEvent[];
  fullSetDataCalls: RendererFullSetDataDiagnostic[];
  strategyDerivations: RendererStrategyDerivationDiagnostic[];
  fullSetDataCountByPeriod: Record<Period, number>;
  strategyDerivationCount: number;
  profitLossDetailGenerationCount: number;
}
export interface MoneyComingTestAPI {
  showReactionScenario: (scenario: ReactionTestScenario, direction: WeeklyDirection, startMs: number) => void;
  getFiveMinuteBarsFromEnd: (count: number) => { startIndex: number; bars: Bar[] };
  entryLifecycleAttemptCount: (triggerStartMs: number) => number;
  strategyDateRangeDiagnostics: () => StrategyDateRangeDiagnostics;
  rendererPerformanceDiagnostics: () => RendererPerformanceDiagnostics;
  resetRendererPerformanceDiagnostics: () => void;
  profitLossTradeJumpDiagnostics: () => ProfitLossTradeJumpDiagnostics;
  addProfitLossTradeMarkerDecoy: (sourceIndex: number) => {
    sourceMarkerId: string;
    decoyMarkerId: string;
    barStartMs: number;
  } | undefined;
  selectVisibleEntry: (markerId: string) => boolean;
  clearReactionScenario: () => void;
  showEmptyProfitLossReview: () => void;
  selectThresholdComparisonEntry: () => boolean;
  selectPercentageComparisonEntry: () => boolean;
  selectOppositeComparisonEntry: () => boolean;
  selectSessionExitComparisonEntry: () => boolean;
}
export type WeeklyDirection = 'long' | 'short';
export interface EntryRulesResult {
  ok: boolean;
  text: string;
  path: string;
  modifiedAt?: string;
  fallback: boolean;
  error?: string;
}
declare global {
  interface Window {
    market: MarketAPI;
    updates: UpdateAPI;
    moneyComingTest?: MoneyComingTestAPI;
  }
}
