import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBeijing } from '../src/domain/time';
import { EDB_ENDPOINT } from '../src/main/edb-client';
import { installTestEdbSource } from '../src/main/test-edb-source';
import { INSTRUMENT_LIST } from '../src/shared/instruments';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

function requestUrl(
  symbol: string,
  period: '60' | '86400',
  start: string,
  end: string,
): string {
  const url = new URL(EDB_ENDPOINT);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('period', period);
  url.searchParams.set('start_time', start);
  url.searchParams.set('end_time', end);
  return url.toString();
}

describe('test EDB source', () => {
  it('serves every registered main symbol and rejects unknown symbols', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-edb-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'minutes.csv');
    const nano = String(
      BigInt(parseBeijing('2026-10-09 09:00:00')) * 1_000_000n,
    );
    await writeFile(
      fixturePath,
      [
        'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
        `${nano},3000,3002,2999,3001,10,1000,1001`,
      ].join('\n'),
      'utf8',
    );

    let handler!: (request: { url: string }) => Promise<Response> | Response;
    const marketSession = {
      protocol: {
        handle: vi.fn((_scheme, callback) => {
          handler = callback;
        }),
      },
    } as unknown as Session;
    await installTestEdbSource(marketSession, 'fixture', fixturePath);

    for (const definition of INSTRUMENT_LIST) {
      const minuteResponse = await handler({
        url: requestUrl(
          definition.mainSymbol,
          '60',
          '2026-10-09 09:00:00',
          '2026-10-09 09:01:00',
        ),
      });
      expect(minuteResponse.status, definition.mainSymbol).toBe(200);

      const expiry = definition.contractCode.expiryDigits === 3 ? '601' : '2601';
      const contractResponse = await handler({
        url: requestUrl(
          `${definition.contractSymbolPrefix}${definition.productCode}${expiry}`,
          '86400',
          '2025-12-03 00:00:00',
          '2025-12-04 00:00:00',
        ),
      });
      expect(contractResponse.status, definition.id).toBe(200);
      expect(await contractResponse.text()).toContain(
        'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
      );
    }

    const unknownResponse = await handler({
      url: requestUrl(
        'KQ.m@DCE.unknown',
        '60',
        '2026-10-09 09:00:00',
        '2026-10-09 09:01:00',
      ),
    });
    expect(unknownResponse.status).toBe(400);
  });

  it('applies instrument-specific delays, failures and minute price offsets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-edb-controls-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'minutes.csv');
    const nano = String(
      BigInt(parseBeijing('2026-10-09 09:00:00')) * 1_000_000n,
    );
    await writeFile(
      fixturePath,
      [
        'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
        `${nano},3000,3002,2999,3001,10,1000,1001`,
      ].join('\n'),
      'utf8',
    );

    let handler!: (request: { url: string }) => Promise<Response> | Response;
    const marketSession = {
      protocol: {
        handle: vi.fn((_scheme, callback) => {
          handler = callback;
        }),
      },
    } as unknown as Session;
    await installTestEdbSource(marketSession, 'fixture', fixturePath, {
      delays: { main_continuous: 20 },
      failures: { rebar_main: '模拟螺纹钢 EDB 失败' },
      priceOffsets: { main_continuous: 125 },
    });

    const startedAt = Date.now();
    const soymealResponse = await handler({
      url: requestUrl(
        'KQ.m@DCE.m',
        '60',
        '2026-10-09 09:00:00',
        '2026-10-09 09:01:00',
      ),
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect(await soymealResponse.text()).toContain(
      `${nano},3125,3127,3124,3126,10,1000,1001`,
    );

    const failedResponse = await handler({
      url: requestUrl(
        'KQ.m@SHFE.rb',
        '60',
        '2026-10-09 09:00:00',
        '2026-10-09 09:01:00',
      ),
    });
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.text()).toBe('模拟螺纹钢 EDB 失败');
  });

  it('derives uniquely matching daily rows for future fixture dates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-edb-future-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'minutes.csv');
    const nano = String(
      BigInt(parseBeijing('2026-10-19 09:00:00')) * 1_000_000n,
    );
    await writeFile(
      fixturePath,
      [
        'datetime_nano,open,high,low,close,volume,open_oi,close_oi',
        `${nano},3400,3402,3399,3401,10,1000,1001`,
      ].join('\n'),
      'utf8',
    );

    let handler!: (request: { url: string }) => Promise<Response> | Response;
    const marketSession = {
      protocol: {
        handle: vi.fn((_scheme, callback) => {
          handler = callback;
        }),
      },
    } as unknown as Session;
    await installTestEdbSource(marketSession, 'fixture', fixturePath);

    const mainResponse = await handler({
      url: requestUrl(
        'KQ.m@DCE.m',
        '86400',
        '2026-10-19 00:00:00',
        '2026-10-19 23:59:00',
      ),
    });
    const matchingResponse = await handler({
      url: requestUrl(
        'DCE.m2701',
        '86400',
        '2026-10-19 00:00:00',
        '2026-10-19 23:59:00',
      ),
    });
    const otherResponse = await handler({
      url: requestUrl(
        'DCE.m2703',
        '86400',
        '2026-10-19 00:00:00',
        '2026-10-19 23:59:00',
      ),
    });
    const mainRow = (await mainResponse.text()).trim().split(/\r?\n/)[1].split(',');
    const matchingRow = (await matchingResponse.text()).trim().split(/\r?\n/)[1].split(',');
    expect(mainRow.slice(2, 5)).toEqual(matchingRow.slice(2, 5));
    expect((await otherResponse.text()).trim().split(/\r?\n/)).toHaveLength(1);
  });
});
