import { formatBeijing } from '../domain/time';
import { instrumentDefinition } from '../shared/instruments';
import type {
  Instrument,
  LoadResult,
  MarketAPI,
  MarketSnapshotActivatedEvent,
  OnlineMarketState,
} from '../shared/types';
import type { MarketUpdateTone } from './market-update-view';

export const ONLINE_MARKET_ENABLED_STORAGE_KEY = 'moneycoming.online-market-enabled.v1';
export const VISIBLE_MARKET_MODES = ['dual', '5', '60'] as const;
export type VisibleMarketMode = typeof VISIBLE_MARKET_MODES[number];

export interface OnlineMarketView {
  checked: boolean;
  busy: boolean;
  statusText: string;
  metadataText: string;
  tone: MarketUpdateTone;
}

export interface NumericLogicalRange {
  from: number;
  to: number;
}

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

function sourceMinute(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace('T', ' ').slice(0, 16) : undefined;
}

function instant(value?: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp)
    ? formatBeijing(timestamp).slice(0, 16)
    : sourceMinute(value);
}

export function sanitizeOnlineError(message?: string): string | undefined {
  if (!message?.trim()) return undefined;
  const sanitized = message
    .replace(/https?:\/\/\S+/gi, '数据源')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '本地路径')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

export function onlineMarketView(state: OnlineMarketState): OnlineMarketView {
  const definition = state.instrument ? instrumentDefinition(state.instrument) : undefined;
  const cutoff = sourceMinute(state.sourceLatestAt ?? state.localMinuteLatestAt);
  const metadata = [
    definition?.name ?? '当前品种待读取',
    cutoff ? `数据截止 ${cutoff}` : '数据截止待读取',
  ];
  const lastSucceededAt = instant(state.lastSucceededAt);
  const nextCheckAt = instant(state.nextCheckAt);
  if (lastSucceededAt) metadata.push(`最近成功 ${lastSucceededAt}`);
  if (nextCheckAt) metadata.push(`下次检查 ${nextCheckAt}`);
  const error = sanitizeOnlineError(state.error?.message);
  if (state.phase === 'degraded' && error) metadata.push(`原因 ${error}`);

  const base = {
    checked: state.enabled,
    metadataText: metadata.join(' · '),
  };
  switch (state.phase) {
    case 'disabled':
      return { ...base, busy: false, statusText: '离线', tone: 'neutral' };
    case 'catching-up':
      return {
        ...base,
        busy: true,
        statusText: '正在补齐最新闭合分钟',
        tone: 'working',
      };
    case 'waiting':
      return {
        ...base,
        busy: false,
        statusText: '在线 · 等待下一分钟收盘',
        tone: 'success',
      };
    case 'polling':
      return {
        ...base,
        busy: true,
        statusText: '在线 · 正在检查闭合分钟',
        tone: 'working',
      };
    case 'source-delayed':
      return {
        ...base,
        busy: false,
        statusText: '数据源延迟',
        tone: 'warning',
      };
    case 'degraded':
      return {
        ...base,
        busy: false,
        statusText: '更新失败 · 离线快照可用',
        tone: 'danger',
      };
  }
}

export function onlinePreferenceFromValue(value: string | null): boolean {
  return value === 'true';
}

export function readOnlineMarketPreference(storage: StorageReader): boolean {
  try {
    return onlinePreferenceFromValue(storage.getItem(ONLINE_MARKET_ENABLED_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function persistOnlineMarketPreference(
  storage: StorageWriter,
  enabled: boolean,
): boolean {
  try {
    storage.setItem(ONLINE_MARKET_ENABLED_STORAGE_KEY, String(enabled));
    return true;
  } catch {
    return false;
  }
}

export function snapshotActivationKey(
  event: Pick<MarketSnapshotActivatedEvent, 'instrument' | 'snapshotUpdatedAt'>,
): string {
  return `${event.instrument}:${event.snapshotUpdatedAt}`;
}

export function shouldReloadForSnapshotActivation(
  event: MarketSnapshotActivatedEvent,
  currentInstrument: Instrument,
  handledKeys: Set<string>,
  maximumRemembered = 200,
): boolean {
  const key = snapshotActivationKey(event);
  if (handledKeys.has(key)) return false;
  handledKeys.add(key);
  while (handledKeys.size > maximumRemembered) {
    const oldest = handledKeys.values().next().value as string | undefined;
    if (!oldest) break;
    handledKeys.delete(oldest);
  }
  return event.instrument === currentInstrument;
}

export async function loadDeclaredMarketSnapshot(
  market: Pick<MarketAPI, 'setCurrentInstrument' | 'load'>,
  instrument: Instrument,
  reload = false,
  declareCurrent = true,
): Promise<LoadResult> {
  if (declareCurrent) await market.setCurrentInstrument(instrument);
  return market.load(instrument, reload);
}

function nearestIndex(starts: readonly number[], target: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] === target) return middle;
    if (starts[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  if (low <= 0) return 0;
  if (low >= starts.length) return starts.length - 1;
  return target - starts[low - 1] <= starts[low] - target ? low - 1 : low;
}

export function restoredLogicalRange(
  range: NumericLogicalRange | undefined,
  centerTime: number | undefined,
  barStarts: readonly number[],
): NumericLogicalRange | undefined {
  if (!range || !barStarts.length) return undefined;
  const from = Number(range.from);
  const to = Number(range.to);
  const span = to - from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || span <= 0) return undefined;

  const lastIndex = barStarts.length - 1;
  if (to >= 0 && from <= lastIndex) return { from, to };
  if (centerTime === undefined) return undefined;

  const centerIndex = nearestIndex(barStarts, centerTime);
  let nextFrom = centerIndex - span / 2;
  let nextTo = nextFrom + span;
  const minimum = 0;
  const maximum = lastIndex + 4;
  if (nextFrom < minimum) {
    nextTo += minimum - nextFrom;
    nextFrom = minimum;
  }
  if (nextTo > maximum) {
    nextFrom -= nextTo - maximum;
    nextTo = maximum;
  }
  return {
    from: Math.max(minimum, nextFrom),
    to: Math.min(maximum, nextTo),
  };
}

export function restorableBarIndex(
  bars: readonly { startMs: number }[],
  startMs: number,
): number | undefined {
  if (!bars.length) return undefined;
  return nearestIndex(bars.map(bar => bar.startMs), startMs);
}
