import { readFile } from 'node:fs/promises';
import type { Session } from 'electron';
import { parseEdbMinuteCsv } from '../domain/market-data';
import { parseBeijing } from '../domain/time';
import { EDB_ENDPOINT } from './edb-client';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';

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
    return new Response(
      serializeFixture(records.filter(record => record.startMs >= startMs && record.startMs <= endMs)),
      { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } },
    );
  });
}
