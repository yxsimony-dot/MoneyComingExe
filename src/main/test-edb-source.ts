import { readFile } from 'node:fs/promises';
import type { Session } from 'electron';
import { parseEdbMinuteCsv } from '../domain/market-data';
import { parseBeijing } from '../domain/time';
import { EDB_ENDPOINT } from './edb-client';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const DAILY_ROWS = [
  { tradingDate: '2025-12-03', contract: 'm2601', base: 3000 },
  { tradingDate: '2025-12-04', contract: 'm2605', base: 3010 },
  { tradingDate: '2026-04-08', contract: 'm2605', base: 3100 },
  { tradingDate: '2026-04-09', contract: 'm2609', base: 3110 },
  { tradingDate: '2026-08-07', contract: 'm2609', base: 3200 },
  { tradingDate: '2026-08-10', contract: 'm2701', base: 3210 },
] as const;

function serializeFixture(records: ReturnType<typeof parseEdbMinuteCsv>): string {
  return [
    HEADER,
    ...records.map(record => [
      record.datetimeNano,
      record.open,
      record.high,
      record.low,
      record.close,
      record.volume,
      record.openOi,
      record.closeOi,
    ].join(',')),
  ].join('\n');
}

function serializeDailyFixture(symbol: string, startMs: number, endMs: number): string {
  const rows = DAILY_ROWS.filter(row => {
    const timeMs = parseBeijing(`${row.tradingDate} 00:00:00`);
    return timeMs >= startMs
      && timeMs <= endMs
      && (symbol === 'KQ.m@DCE.m' || symbol === `DCE.${row.contract}`);
  });
  return [
    HEADER,
    ...rows.map((row) => {
      const open = symbol === 'KQ.m@DCE.m' ? row.base + 1 : row.base + 0.5;
      return [
        String(BigInt(Date.parse(`${row.tradingDate}T00:00:00Z`)) * 1_000_000n),
        open,
        row.base + 3,
        row.base,
        row.base + 2,
        row.base * 10,
        row.base * 100,
        row.base * 100 + 1,
      ].join(',');
    }),
  ].join('\n');
}

export async function installTestEdbSource(
  marketSession: Session,
  mode: string | undefined,
  fixturePath: string | undefined,
): Promise<void> {
  if (!mode) return;
  let fixture = '';
  if (mode === 'fixture') {
    if (!fixturePath) throw new Error('测试 EDB fixture 路径缺失');
    fixture = await readFile(fixturePath, 'utf8');
  } else if (mode !== 'offline') {
    throw new Error(`未知测试 EDB 模式：${mode}`);
  }
  const records = fixture ? parseEdbMinuteCsv(fixture, '测试 EDB fixture') : [];
  marketSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.origin + url.pathname !== EDB_ENDPOINT) {
      return new Response('Forbidden', { status: 403 });
    }
    if (mode === 'offline') {
      return new Response('Offline', { status: 503 });
    }
    const start = url.searchParams.get('start_time');
    const end = url.searchParams.get('end_time');
    if (!start || !end) return new Response('Bad range', { status: 400 });
    const startMs = parseBeijing(start);
    const endMs = parseBeijing(end);
    const period = url.searchParams.get('period');
    const symbol = url.searchParams.get('symbol');
    if (period === '86400' && symbol) {
      return new Response(serializeDailyFixture(symbol, startMs, endMs), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      });
    }
    if (period !== '60' || symbol !== 'KQ.m@DCE.m') {
      return new Response('Bad request', { status: 400 });
    }
    return new Response(
      serializeFixture(records.filter(record => record.startMs >= startMs && record.startMs <= endMs)),
      { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } },
    );
  });
}
