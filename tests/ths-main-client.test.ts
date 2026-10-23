import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  THS_GLASS_MAIN_REQUEST,
  THS_KLINE_ENDPOINT,
  ThsMainClient,
} from '../src/main/ths-main-client';

const fixture = (name: string) => readFileSync(`tests/fixtures/ths/${name}`, 'utf8');
const jsonResponse = (text: string) => new Response(text, {
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

describe('fixed THS glass main client', () => {
  it('uses only the fixed endpoint and request and hashes the raw first page', async () => {
    const raw = fixture('fg9999-page-latest.json');
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => jsonResponse(raw));
    const client = new ThsMainClient({ fetch });

    const result = await client.fetchGlassMainHistory({
      minimumCloseTimeMs: 1790230200000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(input).toBe(THS_KLINE_ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
      },
      redirect: 'error',
    });
    expect(JSON.parse(init.body as string)).toEqual(THS_GLASS_MAIN_REQUEST);
    expect(result).toMatchObject({
      termination: 'target-reached',
      firstCloseTimeMs: 1790230200000,
      lastCloseTimeMs: 1790230500000,
    });
    expect(result.pages[0].rawText).toBe(raw);
    expect(result.pages[0].rawSha256).toBe(
      createHash('sha256').update(raw).digest('hex'),
    );
  });

  it('paginates backward with the previous earliest timestamp minus one millisecond', async () => {
    const latest = fixture('fg9999-page-latest.json');
    const previous = fixture('fg9999-page-previous.json');
    const empty = fixture('fg9999-page-empty.json');
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(latest))
      .mockResolvedValueOnce(jsonResponse(previous))
      .mockResolvedValueOnce(jsonResponse(empty));
    const client = new ThsMainClient({ fetch });

    const result = await client.fetchGlassMainHistory();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body as string).end_time))
      .toEqual([0, 1790230199999, 1790229599999]);
    expect(result.termination).toBe('empty-page');
    expect(result.pages).toHaveLength(3);
    expect(result.firstCloseTimeMs).toBe(1790229600000);
    expect(result.lastCloseTimeMs).toBe(1790230500000);
  });

  it('stops safely when a later page does not move to an earlier timestamp', async () => {
    const latest = fixture('fg9999-page-latest.json');
    const fetch = vi.fn(async () => jsonResponse(latest));
    const client = new ThsMainClient({ fetch });

    const result = await client.fetchGlassMainHistory();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.termination).toBe('no-progress');
    expect(result.pages).toHaveLength(2);
  });

  it.each([
    ['market', {
      ...THS_GLASS_MAIN_REQUEST,
      code_list: [{ codes: ['FG9999'], market: '68' }],
    }],
    ['code', {
      ...THS_GLASS_MAIN_REQUEST,
      code_list: [{ codes: ['FG8888'], market: '67' }],
    }],
    ['period', { ...THS_GLASS_MAIN_REQUEST, time_period: 'min_1' }],
    ['endpoint-like extra parameter', { ...THS_GLASS_MAIN_REQUEST, url: 'https://example.test' }],
    ['initial cursor', { ...THS_GLASS_MAIN_REQUEST, end_time: 1 }],
  ])('rejects an altered %s request', async (_name, request) => {
    const fetch = vi.fn();
    const client = new ThsMainClient({ fetch });
    await expect(client.fetchGlassMainHistory({ request })).rejects.toThrow(/只允许固定/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP error', async () => new Response('no', { status: 403 }), /HTTP 403/],
    ['wrong content type', async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }), /非 JSON/],
    ['invalid JSON', async () => jsonResponse('{'), /有效 JSON/],
    ['invalid response shape', async () => jsonResponse('{"status_code":1,"data":{}}'), /顶层结构/],
    ['oversized response', async () => jsonResponse('x'.repeat(2_000)), /大小限制/],
  ])('rejects %s', async (_name, fetch, pattern) => {
    const client = new ThsMainClient({ fetch, maxResponseBytes: 1_000 });
    await expect(client.fetchGlassMainHistory()).rejects.toThrow(pattern);
  });

  it('times out without exposing a partial page', async () => {
    const fetch = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
    const client = new ThsMainClient({ fetch, timeoutMs: 5 });
    await expect(client.fetchGlassMainHistory()).rejects.toThrow(/超时/);
  });
});

describe('fixed THS glass contract client', () => {
  it('uses the same fixed endpoint and request semantics for FG309', async () => {
    const raw = fixture('fg309-page-2023.json');
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => (
      jsonResponse(raw)
    ));
    const client = new ThsMainClient({ fetch });

    const result = await client.fetchGlassContractHistory('FG309', {
      minimumCloseTimeMs: 1691543100000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(input).toBe(THS_KLINE_ENDPOINT);
    expect(JSON.parse(init.body as string)).toEqual({
      ...THS_GLASS_MAIN_REQUEST,
      code_list: [{
        codes: ['FG309'],
        market: '67',
      }],
    });
    expect(result).toMatchObject({
      sourceContract: 'FG309',
      termination: 'target-reached',
      firstCloseTimeMs: 1691543100000,
      lastCloseTimeMs: 1691543400000,
      pages: [{
        rawSha256: createHash('sha256').update(raw).digest('hex'),
        quote: {
          market: '67',
          code: 'FG309',
        },
      }],
    });
  });

  it('paginates a specific contract from the previous earliest close minus one millisecond', async () => {
    const latest = JSON.parse(fixture('fg309-page-2023.json'));
    const previous = structuredClone(latest);
    previous.data.quote_data[0].value = previous.data.quote_data[0].value.map(
      (row: unknown[]) => [Number(row[0]) - 600_000, ...row.slice(1)],
    );
    const empty = structuredClone(latest);
    empty.data.quote_data[0].value = [];
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(latest)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(previous)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(empty)));
    const client = new ThsMainClient({ fetch });

    const result = await client.fetchGlassContractHistory('FG309');

    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body as string).end_time))
      .toEqual([0, 1691543099999, 1691542499999]);
    expect(result.termination).toBe('empty-page');
    expect(result.firstCloseTimeMs).toBe(1691542500000);
    expect(result.lastCloseTimeMs).toBe(1691543400000);
  });

  it('rejects a response whose contract code differs from the request', async () => {
    const raw = fixture('fg309-page-2023.json')
      .replace('"code":"FG309"', '"code":"FG2309"');
    const client = new ThsMainClient({
      fetch: async () => jsonResponse(raw),
    });

    await expect(client.fetchGlassContractHistory('FG309'))
      .rejects.toThrow(/FG309 响应结构无效/);
  });

  it.each([
    'SA309',
    'FG30',
    'FG300',
    'FG1313',
    'FG9999',
    'fg309',
  ])('rejects invalid or non-specific contract code %s', async sourceContract => {
    const fetch = vi.fn();
    const client = new ThsMainClient({ fetch });

    await expect(client.fetchGlassContractHistory(sourceContract))
      .rejects.toThrow(/具体合约|到期月份/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
