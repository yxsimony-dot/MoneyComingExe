import { describe, expect, it } from 'vitest';
import { EDB_COLUMNS, EDB_ENDPOINT } from '../src/main/edb-client';
import {
  isAllowedMarketRequest,
  MARKET_UPDATE_SESSION_PARTITION,
  PERSISTENT_TEST_VIEWER_SESSION_PARTITION,
  TEST_VIEWER_SESSION_PARTITION,
  VIEWER_BLOCKED_URL_PATTERNS,
  VIEWER_SESSION_PARTITION,
} from '../src/main/network-policy';

describe('Electron network session policy', () => {
  const request = (period: '60' | '86400', symbol: string) => {
    const url = new URL(EDB_ENDPOINT);
    url.searchParams.set('period', period);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('start_time', '2026-10-09 09:00:00');
    url.searchParams.set('end_time', '2026-10-09 10:00:00');
    url.searchParams.set('col', EDB_COLUMNS);
    return url.toString();
  };

  it('uses distinct dedicated viewer and market-update partitions', () => {
    expect(VIEWER_SESSION_PARTITION).toMatch(/^persist:/);
    expect(PERSISTENT_TEST_VIEWER_SESSION_PARTITION).toMatch(/^persist:/);
    expect(PERSISTENT_TEST_VIEWER_SESSION_PARTITION).not.toBe(VIEWER_SESSION_PARTITION);
    expect(PERSISTENT_TEST_VIEWER_SESSION_PARTITION).not.toBe(TEST_VIEWER_SESSION_PARTITION);
    expect(PERSISTENT_TEST_VIEWER_SESSION_PARTITION).not.toBe(MARKET_UPDATE_SESSION_PARTITION);
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

  it('allows only registered symbols through controlled GET requests', () => {
    expect(isAllowedMarketRequest(request('60', 'KQ.m@DCE.m'), 'GET')).toBe(true);
    expect(isAllowedMarketRequest(request('60', 'KQ.m@SHFE.rb'), 'GET')).toBe(true);
    expect(isAllowedMarketRequest(request('86400', 'CZCE.RM601'), 'GET')).toBe(true);
    expect(isAllowedMarketRequest(request('86400', 'DCE.m2701'), 'GET')).toBe(true);
    expect(isAllowedMarketRequest(request('60', 'KQ.m@DCE.unknown'), 'GET')).toBe(false);
    expect(isAllowedMarketRequest(request('86400', 'DCE.unknown2701'), 'GET')).toBe(false);
    expect(isAllowedMarketRequest(`${EDB_ENDPOINT}?period=60`, 'GET')).toBe(false);
    expect(isAllowedMarketRequest('http://edb.shinnytech.com/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://edb.shinnytech.com/md/other', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://edb.shinnytech.com.evil.test/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest('https://user@edb.shinnytech.com/md/kline', 'GET')).toBe(false);
    expect(isAllowedMarketRequest(`${EDB_ENDPOINT}#fragment`, 'GET')).toBe(false);
    expect(isAllowedMarketRequest(request('60', 'KQ.m@DCE.m'), 'POST')).toBe(false);
    expect(isAllowedMarketRequest('not a url', 'GET')).toBe(false);
  });
});
