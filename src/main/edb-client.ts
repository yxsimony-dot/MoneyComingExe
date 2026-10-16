import { mergeMinuteChunks, parseEdbMinuteCsv } from '../domain/market-data';
import {
  buildMainContractCandidates,
  identifyMainContracts,
  parseEdbDailyCsv,
} from '../domain/contract-rollover';
import { formatBeijing } from '../domain/time';
import type { EdbDailyRecord, EdbMinuteRecord, MainContractMapping } from '../shared/types';

export const EDB_ENDPOINT = 'https://edb.shinnytech.com/md/kline' as const;
export const EDB_SYMBOL = 'KQ.m@DCE.m' as const;
export const EDB_COLUMNS = 'open,high,low,close,volume,open_oi,close_oi' as const;
const MINUTE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export type EdbFetch = (input: string, init: RequestInit) => Promise<Response>;

export class EdbClientError extends Error {
  constructor(
    readonly code: 'network' | 'invalid-response',
    message: string,
  ) {
    super(message);
    this.name = 'EdbClientError';
  }
}

export interface EdbClientOptions {
  fetch: EdbFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function readLimitedResponse(response: Response, maximum: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new EdbClientError('invalid-response', 'EDB 响应超过大小限制');
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximum) throw new EdbClientError('invalid-response', 'EDB 响应超过大小限制');
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new EdbClientError('invalid-response', 'EDB 响应超过大小限制');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

export class EdbClient {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: EdbClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  async fetchRange(startMs: number, endMs: number): Promise<EdbMinuteRecord[]> {
    const text = await this.fetchCsv(EDB_SYMBOL, '60', startMs, endMs);
    try {
      return parseEdbMinuteCsv(text, 'EDB 响应');
    } catch {
      throw new EdbClientError('invalid-response', 'EDB CSV 内容校验失败');
    }
  }

  async fetchMainDailyRange(startMs: number, endMs: number): Promise<EdbDailyRecord[]> {
    return this.fetchDaily(EDB_SYMBOL, startMs, endMs);
  }

  async fetchContractDailyRange(
    contract: string,
    startMs: number,
    endMs: number,
  ): Promise<EdbDailyRecord[]> {
    if (!/^m\d{2}(?:01|05|09)$/.test(contract)) {
      throw new EdbClientError('invalid-response', 'EDB 具体合约不在受控豆粕候选范围内');
    }
    return this.fetchDaily(`DCE.${contract}`, startMs, endMs);
  }

  private async fetchDaily(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<EdbDailyRecord[]> {
    const text = await this.fetchCsv(symbol, '86400', startMs, endMs);
    try {
      return parseEdbDailyCsv(text, 'EDB 日线响应');
    } catch {
      throw new EdbClientError('invalid-response', 'EDB 日线 CSV 内容校验失败');
    }
  }

  private async fetchCsv(
    symbol: string,
    period: '60' | '86400',
    startMs: number,
    endMs: number,
  ): Promise<string> {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new EdbClientError('invalid-response', 'EDB 请求时间范围无效');
    }
    const url = new URL(EDB_ENDPOINT);
    url.searchParams.set('period', period);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('start_time', formatBeijing(startMs));
    url.searchParams.set('end_time', formatBeijing(endMs));
    url.searchParams.set('col', EDB_COLUMNS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.options.fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: '*/*' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      const timeoutMessage = error instanceof Error && error.name === 'AbortError' ? 'EDB 请求超时' : '无法连接 EDB 数据源';
      throw new EdbClientError('network', timeoutMessage);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new EdbClientError('network', `EDB 返回 HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new EdbClientError('invalid-response', 'EDB 返回了非 CSV 内容');
    }
    return readLimitedResponse(response, this.maxResponseBytes);
  }
}

export interface RequestChunk {
  startMs: number;
  endMs: number;
}

export function buildRequestChunks(startMs: number, endMs: number, daysPerChunk = 14): RequestChunk[] {
  if (!Number.isInteger(daysPerChunk) || daysPerChunk <= 0) throw new Error('分块天数必须为正整数');
  const first = Math.ceil(startMs / MINUTE_MS) * MINUTE_MS;
  const last = Math.floor(endMs / MINUTE_MS) * MINUTE_MS;
  if (first > last) return [];
  const span = daysPerChunk * 24 * 60 * MINUTE_MS;
  const chunks: RequestChunk[] = [];
  for (let cursor = first; cursor <= last;) {
    const chunkEnd = Math.min(cursor + span - MINUTE_MS, last);
    chunks.push({ startMs: cursor, endMs: chunkEnd });
    cursor = chunkEnd + MINUTE_MS;
  }
  return chunks;
}

export async function fetchEdbChunks(
  client: Pick<EdbClient, 'fetchRange'>,
  startMs: number,
  endMs: number,
  daysPerChunk = 14,
): Promise<EdbMinuteRecord[]> {
  const chunks: EdbMinuteRecord[][] = [];
  for (const chunk of buildRequestChunks(startMs, endMs, daysPerChunk)) {
    chunks.push(await client.fetchRange(chunk.startMs, chunk.endMs));
  }
  return mergeMinuteChunks(chunks);
}

export async function fetchEdbContractMappings(
  client: Pick<EdbClient, 'fetchMainDailyRange' | 'fetchContractDailyRange'>,
  startMs: number,
  endMs: number,
): Promise<MainContractMapping[]> {
  const main = await client.fetchMainDailyRange(startMs, endMs);
  if (!main.length) throw new Error('EDB 未返回主连日线数据');
  const contracts = buildMainContractCandidates(
    main[0].tradingDate,
    main.at(-1)!.tradingDate,
  );
  const candidates = new Map<string, EdbDailyRecord[]>();
  for (const contract of contracts) {
    candidates.set(contract, await client.fetchContractDailyRange(contract, startMs, endMs));
  }
  return identifyMainContracts(main, candidates);
}
