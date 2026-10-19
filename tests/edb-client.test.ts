import { describe, expect, it, vi } from 'vitest';
import {
  buildRequestChunks,
  EDB_COLUMNS,
  EDB_ENDPOINT,
  EDB_SYMBOL,
  EdbClient,
  fetchEdbChunks,
  fetchEdbContractMappings,
} from '../src/main/edb-client';
import { parseBeijing } from '../src/domain/time';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
} from '../src/shared/instruments';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const nano = (time: string) => String(BigInt(parseBeijing(time)) * 1_000_000n);
const body = (time: string) => `${HEADER}\n${nano(time)},100,102,99,101,10,1000,1001\n`;
const dailyNano = (date: string) => String(BigInt(parseBeijing(`${date} 00:00:00`)) * 1_000_000n);
const dailyBody = (date: string, open = 100) => `${HEADER}\n${dailyNano(date)},${open},102,99,101,10,1000,1001\n`;

describe('fixed EDB client', () => {
  it('constructs only the fixed endpoint, symbol, period, columns, and headers', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(body('2026-10-09 09:00:00'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }));
    const client = new EdbClient({ fetch });
    await client.fetchRange(DEFAULT_INSTRUMENT, parseBeijing('2026-10-09 09:00:00'), parseBeijing('2026-10-09 10:00:00'));
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
    await expect(client.fetchRange(DEFAULT_INSTRUMENT, minute, minute)).resolves.toHaveLength(1);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('start_time')).toBe('2026-10-09 09:00:00');
    expect(url.searchParams.get('end_time')).toBe('2026-10-09 09:00:00');
  });

  it('constructs fixed daily requests for the main series and controlled concrete contracts', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(dailyBody('2026-08-10'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }));
    const client = new EdbClient({ fetch });
    const start = parseBeijing('2026-08-10 00:00:00');
    const end = parseBeijing('2026-08-10 23:59:00');
    await client.fetchMainDailyRange(DEFAULT_INSTRUMENT, start, end);
    await client.fetchContractDailyRange(DEFAULT_INSTRUMENT, 'm2701', start, end);
    const requests = fetch.mock.calls.map(([input, init]) => ({
      query: Object.fromEntries(new URL(input).searchParams),
      init,
    }));
    expect(requests).toEqual([
      {
        query: {
          period: '86400',
          symbol: EDB_SYMBOL,
          start_time: '2026-08-10 00:00:00',
          end_time: '2026-08-10 23:59:00',
          col: EDB_COLUMNS,
        },
        init: expect.objectContaining({ method: 'GET', headers: { Accept: '*/*' }, redirect: 'error' }),
      },
      {
        query: {
          period: '86400',
          symbol: 'DCE.m2701',
          start_time: '2026-08-10 00:00:00',
          end_time: '2026-08-10 23:59:00',
          col: EDB_COLUMNS,
        },
        init: expect.objectContaining({ method: 'GET', headers: { Accept: '*/*' }, redirect: 'error' }),
      },
    ]);
    await expect(client.fetchContractDailyRange(DEFAULT_INSTRUMENT, 'DCE.m2701', start, end)).rejects.toThrow(/受控/);
    await expect(client.fetchContractDailyRange(DEFAULT_INSTRUMENT, 'M2701', start, end)).rejects.toThrow(/受控/);
  });

  it('constructs registered CZCE daily requests with three-digit contracts', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(dailyBody('2026-01-05'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }));
    const client = new EdbClient({ fetch });
    const definition = INSTRUMENT_DEFINITIONS.rapeseed_meal_main;
    const start = parseBeijing('2026-01-05 00:00:00');
    await client.fetchMainDailyRange(definition, start, start);
    await client.fetchContractDailyRange(definition, 'RM601', start, start);
    expect(fetch.mock.calls.map(([input]) => new URL(input).searchParams.get('symbol'))).toEqual([
      'KQ.m@CZCE.RM',
      'CZCE.RM601',
    ]);
  });

  it.each([
    ['HTTP error', async () => new Response('no', { status: 403 }), /HTTP 403/],
    ['wrong content', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), /非 CSV/],
    ['invalid CSV', async () => new Response('bad', { status: 200 }), /内容校验失败/],
    ['oversized response', async () => new Response('x'.repeat(100), { status: 200 }), /大小限制/],
  ])('rejects %s', async (_name, fetch, pattern) => {
    const client = new EdbClient({ fetch, maxResponseBytes: 20 });
    await expect(client.fetchRange(DEFAULT_INSTRUMENT, 1, 2)).rejects.toThrow(pattern);
  });

  it('times out without exposing response bodies', async () => {
    const fetch = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const client = new EdbClient({ fetch, timeoutMs: 5 });
    await expect(client.fetchRange(DEFAULT_INSTRUMENT, 1, 2)).rejects.toThrow(/超时/);
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
    }).fetchRange(DEFAULT_INSTRUMENT, 1, 2))[0];
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([duplicate])
        .mockResolvedValueOnce([duplicate]),
    };
    const start = parseBeijing('2026-10-09 09:00:00');
    const result = await fetchEdbChunks(client, DEFAULT_INSTRUMENT, start, start + 24 * 60 * 60_000, 1);
    expect(client.fetchRange).toHaveBeenCalledTimes(2);
    expect(result).toEqual([duplicate]);
  });

  it('rejects conflicting records with the same datetime_nano', async () => {
    const first = (await new EdbClient({
      fetch: async () => new Response(body('2026-10-09 09:00:00'), { status: 200 }),
    }).fetchRange(DEFAULT_INSTRUMENT, 1, 2))[0];
    const conflict = { ...first, close: first.close + 1 };
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([conflict]),
    };
    const start = parseBeijing('2026-10-09 09:00:00');
    await expect(fetchEdbChunks(client, DEFAULT_INSTRUMENT, start, start + 24 * 60 * 60_000, 1))
      .rejects.toThrow(/冲突记录/);
  });

  it('does not return partial data when a later chunk fails', async () => {
    const client = {
      fetchRange: vi.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('history boundary')),
    };
    const start = parseBeijing('2026-09-01 00:00:00');
    await expect(fetchEdbChunks(client, DEFAULT_INSTRUMENT, start, start + 20 * 24 * 60 * 60_000, 14)).rejects.toThrow(/boundary/);
  });
});

describe('EDB daily mapping fetch', () => {
  it('requests only generated candidates and returns a unique mapping', async () => {
    const client = {
      fetchMainDailyRange: vi.fn(async () => [{
        datetimeNano: dailyNano('2026-08-10'),
        tradingDate: '2026-08-10',
        open: 99,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
        openOi: 1000,
        closeOi: 1001,
      }]),
      fetchContractDailyRange: vi.fn(async (_definition, contract: string) => contract === 'm2701'
        ? [{
            datetimeNano: dailyNano('2026-08-10'),
            tradingDate: '2026-08-10',
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
            openOi: 1000,
            closeOi: 1001,
          }]
        : []),
    };
    const definition = {
      ...DEFAULT_INSTRUMENT,
      contractCode: {
        ...DEFAULT_INSTRUMENT.contractCode,
        candidateMonths: [1, 5, 9],
      },
    };
    await expect(fetchEdbContractMappings(client, definition, 1, 2)).resolves.toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
    expect(client.fetchContractDailyRange.mock.calls.map(call => call[1])).toEqual([
      'm2601', 'm2605', 'm2609', 'm2701', 'm2705', 'm2709',
    ]);
  });

  it('treats empty concrete-contract responses as non-matching candidates', async () => {
    const client = {
      fetchMainDailyRange: vi.fn(async () => [{
        datetimeNano: dailyNano('2026-08-10'),
        tradingDate: '2026-08-10',
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
        openOi: 1000,
        closeOi: 1001,
      }]),
      fetchContractDailyRange: vi.fn(async () => []),
    };
    await expect(fetchEdbContractMappings(client, {
      ...DEFAULT_INSTRUMENT,
      contractCode: {
        ...DEFAULT_INSTRUMENT.contractCode,
        candidateMonths: [1],
        futureYearWindow: 0,
      },
    }, 1, 2)).rejects.toThrow(/缺失/);
  });
});
