import { createHash } from 'node:crypto';

export const THS_KLINE_ENDPOINT = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline' as const;
export const THS_GLASS_MAIN_MARKET = '67' as const;
export const THS_GLASS_MAIN_CODE = 'FG9999' as const;
export const THS_FIVE_MINUTE_PERIOD = 'min_5' as const;
export const THS_PAGE_SIZE = 999 as const;
export const THS_KLINE_FIELDS = ['1', '7', '8', '9', '11', '13', '19'] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 500;

export interface ThsKlineRequest<Code extends string = string> {
  code_list: [{
    codes: [Code];
    market: typeof THS_GLASS_MAIN_MARKET;
  }];
  trade_class: 'intraday';
  time_period: typeof THS_FIVE_MINUTE_PERIOD;
  trade_date: -1;
  begin_time: -999;
  end_time: number;
  adjust_type: 'forward';
  gpid: 1;
}

export type ThsGlassMainRequest = ThsKlineRequest<typeof THS_GLASS_MAIN_CODE>;
export type ThsGlassContractRequest = ThsKlineRequest<string>;

export const THS_GLASS_MAIN_REQUEST: Readonly<ThsGlassMainRequest> = Object.freeze({
  code_list: [{
    codes: [THS_GLASS_MAIN_CODE],
    market: THS_GLASS_MAIN_MARKET,
  }] as [{
    codes: [typeof THS_GLASS_MAIN_CODE];
    market: typeof THS_GLASS_MAIN_MARKET;
  }],
  trade_class: 'intraday',
  time_period: THS_FIVE_MINUTE_PERIOD,
  trade_date: -1,
  begin_time: -999 as const,
  end_time: 0,
  adjust_type: 'forward',
  gpid: 1,
});

export type ThsFetch = (input: string, init: RequestInit) => Promise<Response>;

export class ThsMainClientError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'network' | 'invalid-response',
    message: string,
  ) {
    super(message);
    this.name = 'ThsMainClientError';
  }
}

export interface ThsRawKlineQuote<Code extends string = string> {
  market: typeof THS_GLASS_MAIN_MARKET;
  code: Code;
  delay: boolean;
  dataFields: typeof THS_KLINE_FIELDS;
  values: unknown[][];
}

export interface ThsRawKlinePage<Code extends string = string> {
  pageNumber: number;
  request: ThsKlineRequest<Code>;
  rawText: string;
  rawSha256: string;
  quote: ThsRawKlineQuote<Code>;
  firstCloseTimeMs?: number;
  lastCloseTimeMs?: number;
}

export type ThsPaginationTermination =
  | 'empty-page'
  | 'no-progress'
  | 'target-reached';

export interface ThsKlineHistory<Code extends string = string> {
  pages: ThsRawKlinePage<Code>[];
  termination: ThsPaginationTermination;
  firstCloseTimeMs?: number;
  lastCloseTimeMs?: number;
}

export type ThsGlassMainHistory = ThsKlineHistory<typeof THS_GLASS_MAIN_CODE>;

export interface ThsGlassContractHistory extends ThsKlineHistory<string> {
  sourceContract: string;
}

export interface ThsMainClientOptions {
  fetch: ThsFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
}

export interface FetchThsGlassMainHistoryOptions {
  request?: unknown;
  minimumCloseTimeMs?: number;
}

export interface FetchThsGlassContractHistoryOptions {
  minimumCloseTimeMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

export function assertThsGlassContractCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^FG\d{3,4}$/.test(value)) {
    throw new ThsMainClientError(
      'invalid-request',
      '同花顺具体合约只允许郑商所玻璃 FG 三位或四位到期代码',
    );
  }
  const expiry = value.slice(2);
  const month = Number(expiry.slice(-2));
  if (month < 1 || month > 12) {
    throw new ThsMainClientError(
      'invalid-request',
      `同花顺玻璃具体合约到期月份无效：${value}`,
    );
  }
}

export function assertThsGlassMainRequest(value: unknown): asserts value is ThsGlassMainRequest {
  if (!isRecord(value)
    || !exactKeys(value, [
      'code_list',
      'trade_class',
      'time_period',
      'trade_date',
      'begin_time',
      'end_time',
      'adjust_type',
      'gpid',
    ])
    || !Array.isArray(value.code_list)
    || value.code_list.length !== 1
    || !isRecord(value.code_list[0])
    || !exactKeys(value.code_list[0], ['codes', 'market'])
    || !isExactStringArray(value.code_list[0].codes, [THS_GLASS_MAIN_CODE])
    || value.code_list[0].market !== THS_GLASS_MAIN_MARKET
    || value.trade_class !== 'intraday'
    || value.time_period !== THS_FIVE_MINUTE_PERIOD
    || value.trade_date !== -1
    || value.begin_time !== -THS_PAGE_SIZE
    || value.end_time !== 0
    || value.adjust_type !== 'forward'
    || value.gpid !== 1) {
    throw new ThsMainClientError(
      'invalid-request',
      '同花顺修复只允许固定的玻璃主连 FG9999 五分钟请求',
    );
  }
}

function cloneRequest<Code extends string>(
  code: Code,
  endTime: number,
): ThsKlineRequest<Code> {
  return {
    code_list: [{
      codes: [code],
      market: THS_GLASS_MAIN_MARKET,
    }],
    trade_class: 'intraday',
    time_period: THS_FIVE_MINUTE_PERIOD,
    trade_date: -1,
    begin_time: -999,
    end_time: endTime,
    adjust_type: 'forward',
    gpid: 1,
  };
}

async function readLimitedResponse(response: Response, maximum: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new ThsMainClientError('invalid-response', '同花顺响应超过大小限制');
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximum) {
      throw new ThsMainClientError('invalid-response', '同花顺响应超过大小限制');
    }
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
      throw new ThsMainClientError('invalid-response', '同花顺响应超过大小限制');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function parsePage<Code extends string>(
  rawText: string,
  expectedCode: Code,
): ThsRawKlineQuote<Code> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ThsMainClientError('invalid-response', '同花顺响应不是有效 JSON');
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, ['status_code', 'data'])
    || parsed.status_code !== 0
    || !isRecord(parsed.data)
    || !exactKeys(parsed.data, ['quote_data'])
    || !Array.isArray(parsed.data.quote_data)
    || parsed.data.quote_data.length !== 1) {
    throw new ThsMainClientError('invalid-response', '同花顺响应顶层结构无效');
  }
  const quote = parsed.data.quote_data[0];
  if (!isRecord(quote)
    || !exactKeys(quote, ['market', 'code', 'delay', 'data_fields', 'value'])
    || quote.market !== THS_GLASS_MAIN_MARKET
    || quote.code !== expectedCode
    || typeof quote.delay !== 'boolean'
    || !isExactStringArray(quote.data_fields, THS_KLINE_FIELDS)
    || !Array.isArray(quote.value)
    || quote.value.length > THS_PAGE_SIZE) {
    throw new ThsMainClientError(
      'invalid-response',
      `同花顺玻璃代码 ${expectedCode} 响应结构无效`,
    );
  }
  const values = quote.value.map((row, index) => {
    if (!Array.isArray(row)
      || row.length !== THS_KLINE_FIELDS.length
      || !Number.isSafeInteger(row[0])
      || row[0] <= 0) {
      throw new ThsMainClientError(
        'invalid-response',
        `同花顺玻璃主连第 ${index + 1} 根记录结构无效`,
      );
    }
    return row;
  });
  return {
    market: THS_GLASS_MAIN_MARKET,
    code: expectedCode,
    delay: quote.delay,
    dataFields: THS_KLINE_FIELDS,
    values,
  };
}

function pageBoundary(values: unknown[][]): { first?: number; last?: number } {
  if (!values.length) return {};
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const row of values) {
    const timestamp = row[0] as number;
    first = Math.min(first, timestamp);
    last = Math.max(last, timestamp);
  }
  return { first, last };
}

export class ThsMainClient {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;

  constructor(private readonly options: ThsMainClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(this.maxPages) || this.maxPages <= 0) {
      throw new ThsMainClientError('invalid-request', '同花顺最大分页数必须为正整数');
    }
  }

  async fetchGlassMainHistory(
    options: FetchThsGlassMainHistoryOptions = {},
  ): Promise<ThsGlassMainHistory> {
    const initialRequest = options.request ?? THS_GLASS_MAIN_REQUEST;
    assertThsGlassMainRequest(initialRequest);
    return this.fetchHistory(THS_GLASS_MAIN_CODE, options.minimumCloseTimeMs);
  }

  async fetchGlassContractHistory(
    sourceContract: string,
    options: FetchThsGlassContractHistoryOptions = {},
  ): Promise<ThsGlassContractHistory> {
    assertThsGlassContractCode(sourceContract);
    const history = await this.fetchHistory(
      sourceContract,
      options.minimumCloseTimeMs,
    );
    return {
      ...history,
      sourceContract,
    };
  }

  private async fetchHistory<Code extends string>(
    code: Code,
    minimumCloseTimeMs: number | undefined,
  ): Promise<ThsKlineHistory<Code>> {
    if (minimumCloseTimeMs !== undefined
      && (!Number.isSafeInteger(minimumCloseTimeMs)
        || minimumCloseTimeMs <= 0)) {
      throw new ThsMainClientError('invalid-request', '同花顺目标最早收盘时间无效');
    }

    const pages: ThsRawKlinePage<Code>[] = [];
    let endTime = 0;
    let previousFirst: number | undefined;
    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
      const request = cloneRequest(code, endTime);
      const page = await this.fetchPage(pageNumber, request);
      pages.push(page);
      if (!page.quote.values.length) {
        return this.historyResult(pages, 'empty-page');
      }
      if (previousFirst !== undefined
        && page.firstCloseTimeMs !== undefined
        && page.firstCloseTimeMs >= previousFirst) {
        return this.historyResult(pages, 'no-progress');
      }
      if (minimumCloseTimeMs !== undefined
        && page.firstCloseTimeMs !== undefined
        && page.firstCloseTimeMs <= minimumCloseTimeMs) {
        return this.historyResult(pages, 'target-reached');
      }
      previousFirst = page.firstCloseTimeMs;
      endTime = page.firstCloseTimeMs! - 1;
    }
    throw new ThsMainClientError(
      'invalid-response',
      `同花顺分页超过安全上限 ${this.maxPages}`,
    );
  }

  private historyResult<Code extends string>(
    pages: ThsRawKlinePage<Code>[],
    termination: ThsPaginationTermination,
  ): ThsKlineHistory<Code> {
    const nonEmpty = pages.filter(page => page.firstCloseTimeMs !== undefined);
    return {
      pages,
      termination,
      firstCloseTimeMs: nonEmpty.length
        ? Math.min(...nonEmpty.map(page => page.firstCloseTimeMs!))
        : undefined,
      lastCloseTimeMs: nonEmpty.length
        ? Math.max(...nonEmpty.map(page => page.lastCloseTimeMs!))
        : undefined,
    };
  }

  private async fetchPage<Code extends string>(
    pageNumber: number,
    request: ThsKlineRequest<Code>,
  ): Promise<ThsRawKlinePage<Code>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.options.fetch(THS_KLINE_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(request),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '同花顺请求超时'
        : '无法连接同花顺数据源';
      throw new ThsMainClientError('network', message);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ThsMainClientError('network', `同花顺返回 HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      throw new ThsMainClientError('invalid-response', '同花顺返回了非 JSON 内容');
    }
    const rawText = await readLimitedResponse(response, this.maxResponseBytes);
    const expectedCode = request.code_list[0].codes[0];
    const quote = parsePage(rawText, expectedCode);
    const boundary = pageBoundary(quote.values);
    return {
      pageNumber,
      request,
      rawText,
      rawSha256: createHash('sha256').update(rawText).digest('hex'),
      quote,
      firstCloseTimeMs: boundary.first,
      lastCloseTimeMs: boundary.last,
    };
  }
}
