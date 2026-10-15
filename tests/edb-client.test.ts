import { describe, expect, it, vi } from 'vitest';
import { buildRequestChunks, EDB_COLUMNS, EDB_ENDPOINT, EDB_SYMBOL, EdbClient, fetchEdbChunks } from '../src/main/edb-client';
import { parseBeijing } from '../src/domain/time';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const nano = (time: string) => String(BigInt(parseBeijing(time)) * 1_000_000n);
const body = (time: string) => `${HEADER}\n${nano(time)},100,102,99,101,10,1000,1001\n`;

describe('fixed EDB client', () => {
  it('constructs only the fixed endpoint, symbol, period, columns, and headers', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(body('2026-10-09 09:00:00'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }));
    const client = new EdbClient({ fetch });
    await client.fetchRange(parseBeijing('2026-10-09 09:00:00'), parseBeijing('2026-10-09 10:00:00'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe(EDB_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      period: '60',
      symbol: EDB_SYMBOL,
      start_time: '2026-10-09 09:00:00',
      end_time: '2026-10-09 10:00:00',
      col: EDB_COLUMNS,
    });
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: '*/*' },
      redirect: 'error',
    });
  });

  it('accepts a one-minute inclusive request range', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(body('2026-10-09 09:00:00'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }));
    const client = new EdbClient({ fetch });
    const minute = parseBeijing('2026-10-09 09:00:00');
    await expect(client.fetchRange(minute, minute)).resolves.toHaveLength(1);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('start_time')).toBe('2026-10-09 09:00:00');
    expect(url.searchParams.get('end_time')).toBe('2026-10-09 09:00:00');
  });

  it.each([
    ['HTTP error', async () => new Response('no', { status: 403 }), /HTTP 403/],
    ['wrong content', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), /非 CSV/],
    ['invalid CSV', async () => new Response('bad', { status: 200 }), /内容校验失败/],
    ['oversized response', async () => new Response('x'.repeat(100), { status: 200 }), /大小限制/],
  ])('rejects %s', async (_name, fetch, pattern) => {
    const client = new EdbClient({ fetch, maxResponseBytes: 20 });
    await expect(client.fetchRange(1, 2)).rejects.toThrow(pattern);
  });

  it('times out without exposing response bodies', async () => {
    const fetch = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const client = new EdbClient({ fetch, timeoutMs: 5 });
    await expect(client.fetchRange(1, 2)).rejects.toThrow(/超时/);
  });
});

describe('EDB chunk planning', () => {
  it('builds one inclusive chunk for a single aligned minute', () => {
    const minute = parseBeijing('2026-10-09 09:00:00');
    expect(buildRequestChunks(minute, minute)).toEqual([{ startMs: minute, endMs: minute }]);
  });

  it('covers multi-chunk ranges without minute gaps or overlap', () => {
    const start = parseBeijing('2026-09-01 00:00:00');
    const end = parseBeijing('2026-10-15 12:00:00');
    const chunks = buildRequestChunks(start, end, 14);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].startMs).toBe(start);
    expect(chunks.at(-1)!.endMs).toBe(end);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].startMs - chunks[index - 1].endMs).toBe(60_000);
    }
  });

  it('deduplicates identical records returned at multiple chunk boundaries', async () => {
    const duplicate = (await new EdbClient({
      fetch: async () => new Response(body('2026-10-09 09:00:00'), { status: 200 }),
    }).fetchRange(1, 2))[0];
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([duplicate])
        .mockResolvedValueOnce([duplicate]),
    };
    const start = parseBeijing('2026-10-09 09:00:00');
    const result = await fetchEdbChunks(client, start, start + 24 * 60 * 60_000, 1);
    expect(client.fetchRange).toHaveBeenCalledTimes(2);
    expect(result).toEqual([duplicate]);
  });

  it('rejects conflicting records with the same datetime_nano', async () => {
    const first = (await new EdbClient({
      fetch: async () => new Response(body('2026-10-09 09:00:00'), { status: 200 }),
    }).fetchRange(1, 2))[0];
    const conflict = { ...first, close: first.close + 1 };
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([conflict]),
    };
    const start = parseBeijing('2026-10-09 09:00:00');
    await expect(fetchEdbChunks(client, start, start + 24 * 60 * 60_000, 1))
      .rejects.toThrow(/冲突记录/);
  });

  it('does not return partial data when a later chunk fails', async () => {
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('history boundary')),
    };
    const start = parseBeijing('2026-09-01 00:00:00');
    await expect(fetchEdbChunks(client, start, start + 20 * 24 * 60 * 60_000, 14)).rejects.toThrow(/boundary/);
  });
});
