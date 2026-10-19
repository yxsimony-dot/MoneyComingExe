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
interface MarketSnapshotMetadataBase {
  snapshotId: string;
  source: {
    provider: 'EDB';
    endpoint: 'https://edb.shinnytech.com/md/kline';
    symbol: string;
  };
  generatedAt: string;
  requestStart: string;
  requestEnd: string;
  sourceLatestAt: string;
}
export interface MarketSnapshotMetadataV1 extends MarketSnapshotMetadataBase {
  schemaVersion: 1;
  files: {
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV2 extends MarketSnapshotMetadataBase {
  schemaVersion: 2;
  files: {
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV3 extends MarketSnapshotMetadataBase {
  schemaVersion: 3;
  files: {
    bars1: SnapshotFileMetadata;
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
    rollovers: SnapshotFileMetadata;
  };
}
export interface MarketSnapshotMetadataV4 extends MarketSnapshotMetadataBase {
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
export type MarketSnapshotMetadata =
  | MarketSnapshotMetadataV1
  | MarketSnapshotMetadataV2
  | MarketSnapshotMetadataV3
  | MarketSnapshotMetadataV4;
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
  startedAt?: string;
  completedAt?: string;
  localLatestAt?: string;
  sourceLatestAt?: string;
  snapshotUpdatedAt?: string;
  counts?: MarketUpdateCounts;
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
  | 'two-attempts';
export interface MoneyComingTestAPI {
  showReactionScenario: (scenario: ReactionTestScenario, direction: WeeklyDirection, startMs: number) => void;
  clearReactionScenario: () => void;
  showEmptyProfitLossReview: () => void;
  selectThresholdComparisonEntry: () => boolean;
  selectPercentageComparisonEntry: () => boolean;
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
