import { describe, expect, it } from 'vitest';
import { EDB_ENDPOINT } from '../src/main/edb-client';
import {
  isAllowedMarketRequest,
  MARKET_UPDATE_SESSION_PARTITION,
  TEST_VIEWER_SESSION_PARTITION,
  VIEWER_BLOCKED_URL_PATTERNS,
  VIEWER_SESSION_PARTITION,
} from '../src/main/network-policy';

describe('Electron network session policy', () => {
  it('uses distinct dedicated viewer and market-update partitions', () => {
    expect(VIEWER_SESSION_PARTITION).toMatch(/^persist:/);
    expect(TEST_VIEWER_SESSION_PARTITION).not.toBe(MARKET_UPDATE_SESSION_PARTITION);
    expect(VIEWER_SESSION_PARTITION).not.toBe(MARKET_UPDATE_SESSION_PARTITION);
  });

  it('blocks renderer HTTP, HTTPS, and WebSocket schemes', () => {
    expect(VIEWER_BLOCKED_URL_PATTERNS).toEqual([
      'http://*/*',
      'https://*/*',
      'ws://*/*',
      'wss://*/*',
    ]);
  });

  it('allows only GET requests to the exact fixed EDB endpoint', () => {
    expect(isAllowedMarketRequest(`${EDB_ENDPOINT}?period=60`, 'GET')).toBe(true);
    expect(isAllowedMarketRequest('http://edb.shinnytech.com/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://edb.shinnytech.com/md/other', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://edb.shinnytech.com.evil.test/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://user@edb.shinnytech.com/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest(`${EDB_ENDPOINT}#fragment`, 'GET')).toBe(false);
    expect(isAllowedMarketRequest(EDB_ENDPOINT, 'POST')).toBe(false);
    expect(isAllowedMarketRequest('not a url', 'GET')).toBe(false);
  });
});
