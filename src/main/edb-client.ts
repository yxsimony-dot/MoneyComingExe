import { mergeMinuteChunks, parseEdbMinuteCsv } from '../domain/market-data';
import { formatBeijing } from '../domain/time';
import type { EdbMinuteRecord } from '../shared/types';

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
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new EdbClientError('invalid-response', 'EDB 请求时间范围无效');
    }
    const url = new URL(EDB_ENDPOINT);
    url.searchParams.set('period', '60');
    url.searchParams.set('symbol', EDB_SYMBOL);
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
    const text = await readLimitedResponse(response, this.maxResponseBytes);
    try {
      return parseEdbMinuteCsv(text, 'EDB 响应');
    } catch {
      throw new EdbClientError('invalid-response', 'EDB CSV 内容校验失败');
    }
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
