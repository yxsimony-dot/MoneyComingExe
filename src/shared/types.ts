export type Instrument = 'main_continuous';
export type Period = 5 | 60;
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
export interface SnapshotFileMetadata {
  name: string;
  sha256: string;
  rows: number;
}
export interface MarketSnapshotMetadata {
  schemaVersion: 1;
  snapshotId: string;
  source: {
    provider: 'EDB';
    endpoint: 'https://edb.shinnytech.com/md/kline';
    symbol: 'KQ.m@DCE.m';
  };
  generatedAt: string;
  requestStart: string;
  requestEnd: string;
  sourceLatestAt: string;
  files: {
    bars5: SnapshotFileMetadata;
    bars60: SnapshotFileMetadata;
  };
}
export type SnapshotSource = 'builtin' | 'user';
export interface Anomaly {
  timeMs: number; title: string; detail: string;
}
export interface Dataset {
  instrument: Instrument; name: string; symbol: string;
  bars5: Bar[]; bars60: Bar[]; anomalies: Anomaly[];
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
  added5: number;
  replaced5: number;
  removed5: number;
  added60: number;
  replaced60: number;
  removed60: number;
}
export interface PublicMarketUpdateError {
  code: 'network' | 'invalid-response' | 'validation' | 'storage' | 'unexpected';
  message: string;
}
export interface MarketUpdateState {
  phase: MarketUpdatePhase;
  startedAt?: string;
  completedAt?: string;
  localLatestAt?: string;
  sourceLatestAt?: string;
  snapshotUpdatedAt?: string;
  counts?: MarketUpdateCounts;
  error?: PublicMarketUpdateError;
}
export interface MarketAPI {
  load: (instrument: Instrument, reload?: boolean) => Promise<LoadResult>;
  readEntryRules: () => Promise<EntryRulesResult>;
  openAttribution: () => Promise<void>;
  getUpdateState: () => Promise<MarketUpdateState>;
  update: () => Promise<MarketUpdateState>;
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
  | 'quarter-autoscale';
export interface MoneyComingTestAPI {
  showReactionScenario: (scenario: ReactionTestScenario, direction: WeeklyDirection, startMs: number) => void;
  clearReactionScenario: () => void;
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
