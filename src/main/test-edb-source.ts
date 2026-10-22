import { readFile } from 'node:fs/promises';
import type { Session } from 'electron';
import { parseEdbMinuteCsv } from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  definitionForContractSymbol,
  definitionForMainSymbol,
  type InstrumentDefinition,
} from '../shared/instruments';
import { EDB_ENDPOINT } from './edb-client';
import {
  testDelay,
  type InstrumentFailureControls,
  type InstrumentNumberControls,
} from './test-controls';
import type { Instrument } from '../shared/types';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const DAILY_ROWS = [
  { tradingDate: '2025-12-03', expiry: '2601', base: 3000 },
  { tradingDate: '2025-12-04', expiry: '2605', base: 3010 },
  { tradingDate: '2026-04-08', expiry: '2605', base: 3100 },
  { tradingDate: '2026-04-09', expiry: '2609', base: 3110 },
  { tradingDate: '2026-08-07', expiry: '2609', base: 3200 },
  { tradingDate: '2026-08-10', expiry: '2701', base: 3210 },
  { tradingDate: '2026-10-08', expiry: '2609', base: 3300 },
  { tradingDate: '2026-10-09', expiry: '2701', base: 3310 },
  { tradingDate: '2026-10-12', expiry: '2701', base: 3320 },
] as const;

interface DailyFixtureRow {
  tradingDate: string;
  expiry: string;
  base: number;
}

export interface TestEdbRequestRecord {
  instrument: Instrument;
  symbol: string;
  period: string | null;
  startAt: string;
  endAt: string;
}

function dynamicFixtureExpiry(
  definition: InstrumentDefinition,
  tradingDate: string,
): string {
  const tradingYear = Number(tradingDate.slice(0, 4));
  const tradingMonth = Number(tradingDate.slice(5, 7));
  const latestStatic = [...DAILY_ROWS]
    .reverse()
    .find(row => row.tradingDate <= tradingDate);
  if (latestStatic) {
    const expiryYear = 2000 + Number(latestStatic.expiry.slice(0, 2));
    const expiryMonth = Number(latestStatic.expiry.slice(2));
    if (expiryYear * 12 + expiryMonth >= tradingYear * 12 + tradingMonth) {
      return latestStatic.expiry;
    }
  }
  const candidateMonth = definition.contractCode.candidateMonths
    .find(month => month >= tradingMonth);
  const expiryYear = candidateMonth === undefined ? tradingYear + 1 : tradingYear;
  const expiryMonth = candidateMonth
    ?? definition.contractCode.candidateMonths[0];
  return `${String(expiryYear).slice(-2)}${String(expiryMonth).padStart(2, '0')}`;
}

function dailyRowsForFixture(
  records: ReturnType<typeof parseEdbMinuteCsv>,
  definition: InstrumentDefinition,
): DailyFixtureRow[] {
  const rows = new Map<string, DailyFixtureRow>(
    DAILY_ROWS.map(row => [row.tradingDate, { ...row }]),
  );
  for (const record of records) {
    const tradingDate = formatBeijing(record.startMs).slice(0, 10);
    if (rows.has(tradingDate)) continue;
    const dayNumber = Math.floor(
      parseBeijing(`${tradingDate} 00:00:00`) / 86_400_000,
    );
    rows.set(tradingDate, {
      tradingDate,
      expiry: dynamicFixtureExpiry(definition, tradingDate),
      base: 3400 + Math.abs(dayNumber % 100),
    });
  }
  return [...rows.values()]
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
}

function serializeFixture(
  records: ReturnType<typeof parseEdbMinuteCsv>,
  priceOffset = 0,
): string {
  return [
    HEADER,
    ...records.map(record => [
      record.datetimeNano,
      record.open + priceOffset,
      record.high + priceOffset,
      record.low + priceOffset,
      record.close + priceOffset,
      record.volume,
      record.openOi,
      record.closeOi,
    ].join(',')),
  ].join('\n');
}

function fixtureContract(
  definition: InstrumentDefinition,
  expiry: string,
): string {
  const suffix = definition.contractCode.expiryDigits === 3
    ? expiry.slice(1)
    : expiry;
  return `${definition.productCode}${suffix}`;
}

function serializeDailyFixture(
  symbol: string,
  definition: InstrumentDefinition,
  main: boolean,
  startMs: number,
  endMs: number,
  records: ReturnType<typeof parseEdbMinuteCsv>,
): string {
  const rows = dailyRowsForFixture(records, definition).filter(row => {
    const timeMs = parseBeijing(`${row.tradingDate} 00:00:00`);
    return timeMs >= startMs
      && timeMs <= endMs
      && (main || symbol === `${definition.contractSymbolPrefix}${fixtureContract(definition, row.expiry)}`);
  });
  return [
    HEADER,
    ...rows.map((row) => {
      const open = main ? row.base + 1 : row.base + 0.5;
      return [
        String(BigInt(Date.parse(`${row.tradingDate}T00:00:00+08:00`)) * 1_000_000n),
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
  controls: {
    delays?: InstrumentNumberControls;
    failures?: InstrumentFailureControls;
    priceOffsets?: InstrumentNumberControls;
    onRequest?: (request: TestEdbRequestRecord) => void;
  } = {},
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
  marketSession.protocol.handle('https', async request => {
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
    const mainDefinition = symbol ? definitionForMainSymbol(symbol) : undefined;
    const contractDefinition = symbol ? definitionForContractSymbol(symbol) : undefined;
    const definition = mainDefinition ?? contractDefinition;
    if (definition) {
      controls.onRequest?.({
        instrument: definition.id,
        symbol: symbol!,
        period,
        startAt: start,
        endAt: end,
      });
      await testDelay(controls.delays?.[definition.id]);
      const forcedFailure = controls.failures?.[definition.id];
      if (forcedFailure) return new Response(forcedFailure, { status: 503 });
    }
    if (period === '86400' && symbol) {
      if (!definition) return new Response('Bad symbol', { status: 400 });
      return new Response(serializeDailyFixture(
        symbol,
        definition,
        mainDefinition !== undefined,
        startMs,
        endMs,
        records,
      ), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      });
    }
    if (period !== '60' || !symbol || !mainDefinition) {
      return new Response('Bad request', { status: 400 });
    }
    return new Response(
      serializeFixture(
        records.filter(record => record.startMs >= startMs && record.startMs <= endMs),
        controls.priceOffsets?.[mainDefinition.id],
      ),
      { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } },
    );
  });
}
