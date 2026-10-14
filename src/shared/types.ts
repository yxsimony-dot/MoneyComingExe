export type Instrument = 'main_continuous' | 'm2701';
export type Period = 5 | 60;
export interface Bar {
  startMs: number; endMs: number; start: string; end: string;
  open: number; high: number; low: number; close: number;
  volume: number; openOi: number; closeOi: number;
  session: 'day' | 'night'; observedMinutes: number; expectedMinutes: number; complete: boolean;
}
export interface Anomaly {
  timeMs: number; title: string; detail: string;
}
export interface Dataset {
  instrument: Instrument; name: string; symbol: string;
  bars5: Bar[]; bars60: Bar[]; anomalies: Anomaly[];
  auditAvailable: boolean; dataDirectory: string;
}
export type LoadResult = { ok: true; data: Dataset } | { ok: false; error: string };
export interface MarketAPI {
  load: (instrument: Instrument, reload?: boolean) => Promise<LoadResult>;
  readEntryRules: () => Promise<EntryRulesResult>;
  openAttribution: () => Promise<void>;
}
export interface EntryRulesResult {
  ok: boolean;
  text: string;
  path: string;
  modifiedAt?: string;
  fallback: boolean;
  error?: string;
}
declare global { interface Window { market: MarketAPI; } }
