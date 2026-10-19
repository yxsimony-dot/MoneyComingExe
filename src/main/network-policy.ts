import { EDB_ENDPOINT } from './edb-client';
import {
  definitionForContractSymbol,
  definitionForMainSymbol,
} from '../shared/instruments';
import { parseBeijing } from '../domain/time';

export const VIEWER_SESSION_PARTITION = 'persist:moneycoming-viewer';
export const TEST_VIEWER_SESSION_PARTITION = 'moneycoming-viewer-test';
export const PERSISTENT_TEST_VIEWER_SESSION_PARTITION = 'persist:moneycoming-viewer-test';
export const MARKET_UPDATE_SESSION_PARTITION = 'moneycoming-market-update';

export const VIEWER_BLOCKED_URL_PATTERNS = [
  'http://*/*',
  'https://*/*',
  'ws://*/*',
  'wss://*/*',
] as const;

export const MARKET_REQUEST_URL_PATTERNS = [
  'http://*/*',
  'https://*/*',
] as const;

export function isAllowedMarketRequest(rawUrl: string, method = 'GET'): boolean {
  if (method !== 'GET') return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:'
      || url.username
      || url.password
      || url.hash
      || url.origin + url.pathname !== EDB_ENDPOINT) {
      return false;
    }
    const allowedParameters = new Set(['period', 'symbol', 'start_time', 'end_time', 'col']);
    if ([...url.searchParams.keys()].some(key => !allowedParameters.has(key))) return false;
    if ([...allowedParameters].some(key => url.searchParams.getAll(key).length !== 1)) return false;
    const period = url.searchParams.get('period');
    const symbol = url.searchParams.get('symbol') ?? '';
    const start = url.searchParams.get('start_time') ?? '';
    const end = url.searchParams.get('end_time') ?? '';
    if (url.searchParams.get('col') !== 'open,high,low,close,volume,open_oi,close_oi') {
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start)
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(end)) {
      return false;
    }
    if (parseBeijing(start) > parseBeijing(end)) return false;
    return (period === '60' && definitionForMainSymbol(symbol) !== undefined)
      || (period === '86400'
        && (definitionForMainSymbol(symbol) !== undefined
          || definitionForContractSymbol(symbol) !== undefined));
  } catch {
    return false;
  }
}
