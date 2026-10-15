import { EDB_ENDPOINT } from './edb-client';

export const VIEWER_SESSION_PARTITION = 'persist:moneycoming-viewer';
export const TEST_VIEWER_SESSION_PARTITION = 'moneycoming-viewer-test';
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
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash
      && url.origin + url.pathname === EDB_ENDPOINT;
  } catch {
    return false;
  }
}
