import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'sina-futures-minute-probe.json');
const NEW_ENDPOINT = (
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/'
  + 'var%20_{callback}=/InnerFuturesNewService.getFewMinLine'
);
const LEGACY_ENDPOINT = (
  'https://stock2.finance.sina.com.cn/futures/api/json.php/'
  + 'IndexService.getInnerFuturesMiniKLine5m'
);

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ODD_MONTHS = [1, 3, 5, 7, 9, 11];
const DCE_MEAL_AND_SOYBEAN_OIL_MONTHS = [1, 3, 5, 7, 8, 9, 11, 12];
const RAPESEED_MEAL_MONTHS = [1, 3, 5, 7, 8, 9, 11];

export const TARGET_INSTRUMENTS = [
  {
    instrumentId: 'main_continuous',
    displayName: '豆粕主连',
    exchange: 'DCE',
    productCode: 'm',
    candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-08' },
  },
  {
    instrumentId: 'rapeseed_meal_main',
    displayName: '菜粕主连',
    exchange: 'CZCE',
    productCode: 'RM',
    candidateMonths: RAPESEED_MEAL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'pvc_main',
    displayName: 'PVC主连',
    exchange: 'DCE',
    productCode: 'v',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'rebar_main',
    displayName: '螺纹钢主连',
    exchange: 'SHFE',
    productCode: 'rb',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'glass_main',
    displayName: '玻璃主连',
    exchange: 'CZCE',
    productCode: 'FG',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'rapeseed_oil_main',
    displayName: '菜油主连',
    exchange: 'CZCE',
    productCode: 'OI',
    candidateMonths: ODD_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'palm_oil_main',
    displayName: '棕榈油主连',
    exchange: 'DCE',
    productCode: 'p',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'soybean_oil_main',
    displayName: '豆油主连',
    exchange: 'DCE',
    productCode: 'y',
    candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'pulp_main',
    displayName: '纸浆主连',
    exchange: 'SHFE',
    productCode: 'sp',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'corn_main',
    displayName: '玉米主连',
    exchange: 'DCE',
    productCode: 'c',
    candidateMonths: ODD_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'soda_ash_main',
    displayName: '纯碱主连',
    exchange: 'CZCE',
    productCode: 'SA',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'soybean_1_main',
    displayName: '豆一主连',
    exchange: 'DCE',
    productCode: 'a',
    candidateMonths: ODD_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'methanol_main',
    displayName: '甲醇主连',
    exchange: 'CZCE',
    productCode: 'MA',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'sugar_main',
    displayName: '白糖主连',
    exchange: 'CZCE',
    productCode: 'SR',
    candidateMonths: ODD_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    instrumentId: 'soybean_2_main',
    displayName: '豆二主连',
    exchange: 'DCE',
    productCode: 'b',
    candidateMonths: ALL_MONTHS,
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
];

function parseYearMonth(value, optionName) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${optionName} 必须使用 YYYY-MM`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`${optionName} 月份超出范围`);
  return { year, month };
}

function parseArguments(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    timeoutMs: 20_000,
    concurrency: 4,
    requestDelayMs: 100,
    firstContractMonth: '2025-07',
    lastContractMonth: '2026-01',
    instrumentIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else if (argument === '--timeout-ms' && value) {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (argument === '--concurrency' && value) {
      options.concurrency = Number(value);
      index += 1;
    } else if (argument === '--request-delay-ms' && value) {
      options.requestDelayMs = Number(value);
      index += 1;
    } else if (argument === '--first-contract-month' && value) {
      options.firstContractMonth = value;
      index += 1;
    } else if (argument === '--last-contract-month' && value) {
      options.lastContractMonth = value;
      index += 1;
    } else if (argument === '--instrument' && value) {
      options.instrumentIds.push(value);
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms 必须是大于 0 的整数');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error('--concurrency 必须是大于 0 的整数');
  }
  if (!Number.isInteger(options.requestDelayMs) || options.requestDelayMs < 0) {
    throw new Error('--request-delay-ms 必须是非负整数');
  }
  const first = parseYearMonth(options.firstContractMonth, '--first-contract-month');
  const last = parseYearMonth(options.lastContractMonth, '--last-contract-month');
  if (first.year * 12 + first.month > last.year * 12 + last.month) {
    throw new Error('--first-contract-month 不得晚于 --last-contract-month');
  }
  const knownIds = new Set(TARGET_INSTRUMENTS.map(item => item.instrumentId));
  for (const instrumentId of options.instrumentIds) {
    if (!knownIds.has(instrumentId)) {
      throw new Error(`未知品种：${instrumentId}`);
    }
  }
  return {
    ...options,
    output: resolve(options.output),
    firstContractMonth: first,
    lastContractMonth: last,
  };
}

function enumerateMonths(first, last) {
  const result = [];
  let year = first.year;
  let month = first.month;
  while (year < last.year || (year === last.year && month <= last.month)) {
    result.push({ year, month });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

function fourDigitExpiry(year, month) {
  return `${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
}

function threeDigitExpiry(year, month) {
  return `${String(year).slice(-1)}${String(month).padStart(2, '0')}`;
}

export function buildProbeTargets(
  instruments = TARGET_INSTRUMENTS,
  firstContractMonth = { year: 2025, month: 7 },
  lastContractMonth = { year: 2026, month: 1 },
) {
  const contractMonths = enumerateMonths(firstContractMonth, lastContractMonth);
  return instruments.flatMap(instrument => {
    const productCode = instrument.productCode.toUpperCase();
    const targets = [{
      instrumentId: instrument.instrumentId,
      displayName: instrument.displayName,
      exchange: instrument.exchange,
      productCode: instrument.productCode,
      gap: instrument.gap,
      symbol: `${productCode}0`,
      symbolKind: 'main-continuous',
      contractMonth: null,
    }];
    for (const { year, month } of contractMonths) {
      if (!instrument.candidateMonths.includes(month)) continue;
      const contractMonth = `${year}-${String(month).padStart(2, '0')}`;
      targets.push({
        instrumentId: instrument.instrumentId,
        displayName: instrument.displayName,
        exchange: instrument.exchange,
        productCode: instrument.productCode,
        gap: instrument.gap,
        symbol: `${productCode}${fourDigitExpiry(year, month)}`,
        symbolKind: 'specific-contract-four-digit',
        contractMonth,
      });
      if (instrument.exchange === 'CZCE') {
        targets.push({
          instrumentId: instrument.instrumentId,
          displayName: instrument.displayName,
          exchange: instrument.exchange,
          productCode: instrument.productCode,
          gap: instrument.gap,
          symbol: `${productCode}${threeDigitExpiry(year, month)}`,
          symbolKind: 'specific-contract-three-digit-alias',
          contractMonth,
        });
      }
    }
    return targets;
  });
}

export function parseJsonpPayload(text) {
  const assignment = text.indexOf('=');
  const open = text.indexOf('(', assignment);
  const close = text.lastIndexOf(')');
  if (assignment < 0 || open < 0 || close <= open) {
    throw new Error('新浪响应不包含 JSONP 赋值');
  }
  const payload = JSON.parse(text.slice(open + 1, close));
  if (payload === null) return [];
  if (!Array.isArray(payload)) throw new Error('新浪 JSONP 主体不是数组');
  return payload;
}

function rowTimestamp(row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return typeof row.d === 'string' ? row.d : null;
  }
  if (Array.isArray(row)) return typeof row[0] === 'string' ? row[0] : null;
  return null;
}

export function summarizeRows(rows, gap) {
  const timestamps = rows
    .map(rowTimestamp)
    .filter(timestamp => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp))
    .sort();
  const targetTimestamps = timestamps.filter(timestamp => (
    timestamp.slice(0, 10) >= gap.firstDate
    && timestamp.slice(0, 10) <= gap.lastDate
  ));
  const targetDates = [...new Set(targetTimestamps.map(timestamp => timestamp.slice(0, 10)))];
  const fields = rows.length > 0 && rows[0] && typeof rows[0] === 'object'
    ? (
        Array.isArray(rows[0])
          ? ['timestamp', 'open', 'high', 'low', 'close', 'volume']
          : Object.keys(rows[0]).sort()
      )
    : [];
  return {
    rowCount: rows.length,
    timestampCount: timestamps.length,
    fields,
    firstTimestamp: timestamps.at(0) ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    targetGap: {
      ...gap,
      rowCount: targetTimestamps.length,
      observedTradingDateCount: targetDates.length,
      firstObservedTimestamp: targetTimestamps.at(0) ?? null,
      lastObservedTimestamp: targetTimestamps.at(-1) ?? null,
      overlaps: targetTimestamps.length > 0,
      wholeGapCoveredBySingleResponse: (
        targetTimestamps.at(0)?.slice(0, 10) <= gap.firstDate
        && targetTimestamps.at(-1)?.slice(0, 10) >= gap.lastDate
      ),
    },
    targetDates,
  };
}

function newEndpointUrl(symbol) {
  const callback = `_${symbol}_5_${Date.now()}`;
  const base = NEW_ENDPOINT.replace('{callback}', callback);
  return `${base}?symbol=${encodeURIComponent(symbol)}&type=5`;
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/plain, application/javascript, application/json, */*',
      referer: 'https://vip.stock.finance.sina.com.cn/',
      'user-agent': 'MoneyComing Sina futures minute metadata probe/1',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { response, text };
}

async function probeTarget(target, timeoutMs) {
  const url = newEndpointUrl(target.symbol);
  try {
    const { response, text } = await fetchText(url, timeoutMs);
    const rows = parseJsonpPayload(text);
    const summary = summarizeRows(rows, target.gap);
    return {
      ...target,
      probeStatus: 'success',
      request: {
        intervalMinutes: 5,
        endpointFamily: 'InnerFuturesNewService.getFewMinLine',
      },
      response: {
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        rowCount: summary.rowCount,
        timestampCount: summary.timestampCount,
        fields: summary.fields,
        firstTimestamp: summary.firstTimestamp,
        lastTimestamp: summary.lastTimestamp,
      },
      targetGap: summary.targetGap,
      targetDates: summary.targetDates,
    };
  } catch (error) {
    return {
      ...target,
      probeStatus: 'failed',
      request: {
        intervalMinutes: 5,
        endpointFamily: 'InnerFuturesNewService.getFewMinLine',
      },
      response: {
        httpStatus: null,
        rowCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
      },
      targetGap: {
        ...target.gap,
        rowCount: 0,
        observedTradingDateCount: 0,
        firstObservedTimestamp: null,
        lastObservedTimestamp: null,
        overlaps: false,
        wholeGapCoveredBySingleResponse: false,
      },
      targetDates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mapWithConcurrency(items, concurrency, requestDelayMs, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (requestDelayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, requestDelayMs));
      }
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function probeLegacySymbol(symbol, gap, timeoutMs) {
  const url = `${LEGACY_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`;
  try {
    const { response, text } = await fetchText(url, timeoutMs);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('旧接口主体不是数组');
    const summary = summarizeRows(rows, gap);
    return {
      symbol,
      probeStatus: 'success',
      response: {
        httpStatus: response.status,
        rowCount: summary.rowCount,
        fields: summary.fields,
        firstTimestamp: summary.firstTimestamp,
        lastTimestamp: summary.lastTimestamp,
      },
      targetGap: summary.targetGap,
    };
  } catch (error) {
    return {
      symbol,
      probeStatus: 'failed',
      response: {
        httpStatus: null,
        rowCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
      },
      targetGap: {
        ...gap,
        rowCount: 0,
        observedTradingDateCount: 0,
        firstObservedTimestamp: null,
        lastObservedTimestamp: null,
        overlaps: false,
        wholeGapCoveredBySingleResponse: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeInstrument(instrument, results) {
  const instrumentResults = results.filter(
    result => result.instrumentId === instrument.instrumentId,
  );
  const targetDates = [...new Set(instrumentResults.flatMap(result => result.targetDates))].sort();
  const successful = instrumentResults.filter(result => result.probeStatus === 'success');
  const overlapping = successful.filter(result => result.targetGap.overlaps);
  const fourDigit = instrumentResults.filter(
    result => result.symbolKind === 'specific-contract-four-digit',
  );
  const aliases = instrumentResults.filter(
    result => result.symbolKind === 'specific-contract-three-digit-alias',
  );
  const compact = result => {
    const { targetDates: ignored, gap: ignoredGap, ...persisted } = result;
    return persisted;
  };
  return {
    instrumentId: instrument.instrumentId,
    displayName: instrument.displayName,
    exchange: instrument.exchange,
    productCode: instrument.productCode,
    targetGap: instrument.gap,
    requestedSymbolCount: instrumentResults.length,
    successfulSymbolCount: successful.length,
    gapOverlappingSymbolCount: overlapping.length,
    observedGapTradingDateCount: targetDates.length,
    firstObservedGapDate: targetDates.at(0) ?? null,
    lastObservedGapDate: targetDates.at(-1) ?? null,
    candidateWindowsReachBothCalendarBoundaries: (
      targetDates.at(0) <= instrument.gap.firstDate
      && targetDates.at(-1) >= instrument.gap.lastDate
    ),
    technicalGapCompletenessConfirmed: false,
    technicalGapCompletenessReason: (
      '接口每个代码只返回短滚动窗口；跨合约观察到日期不等于已验证的逐交易时段完整主连，'
      + '且仍需每日主力映射和缺行校验。'
    ),
    mainContinuousProbe: compact(
      instrumentResults.find(result => result.symbolKind === 'main-continuous'),
    ),
    fourDigitContractProbes: fourDigit.map(compact),
    czceThreeDigitAliasProbes: aliases.map(compact),
  };
}

export async function runProbe(options) {
  const selected = options.instrumentIds.length > 0
    ? TARGET_INSTRUMENTS.filter(item => options.instrumentIds.includes(item.instrumentId))
    : TARGET_INSTRUMENTS;
  const targets = buildProbeTargets(
    selected,
    options.firstContractMonth,
    options.lastContractMonth,
  );
  const results = await mapWithConcurrency(
    targets,
    options.concurrency,
    options.requestDelayMs,
    target => probeTarget(target, options.timeoutMs),
  );
  const soybeanGap = TARGET_INSTRUMENTS[0].gap;
  const rapeseedMealGap = TARGET_INSTRUMENTS[1].gap;
  const legacy = await Promise.all([
    probeLegacySymbol('M0', soybeanGap, options.timeoutMs),
    probeLegacySymbol('M2509', soybeanGap, options.timeoutMs),
    probeLegacySymbol('RM2509', rapeseedMealGap, options.timeoutMs),
  ]);
  const instruments = selected.map(instrument => summarizeInstrument(instrument, results));
  const successfulResponses = results.filter(result => result.probeStatus === 'success');
  const gapOverlappingResponses = successfulResponses.filter(result => result.targetGap.overlaps);
  return {
    schemaVersion: 1,
    purpose: 'sina-futures-specific-contract-five-minute-window-probe',
    capturedAt: new Date().toISOString(),
    source: {
      name: '新浪财经期货分钟接口',
      newEndpointFamily: 'InnerFuturesNewService.getFewMinLine',
      legacyEndpointFamily: 'IndexService.getInnerFuturesMiniKLine5m',
      intervalMinutes: 5,
      accessMode: '公开 HTTP 元数据探测',
    },
    requestPlan: {
      firstContractMonth: (
        `${options.firstContractMonth.year}-`
        + `${String(options.firstContractMonth.month).padStart(2, '0')}`
      ),
      lastContractMonth: (
        `${options.lastContractMonth.year}-`
        + `${String(options.lastContractMonth.month).padStart(2, '0')}`
      ),
      instrumentCount: selected.length,
      symbolCount: targets.length,
      concurrency: options.concurrency,
      requestDelayMs: options.requestDelayMs,
      timeoutMs: options.timeoutMs,
      czceFourDigitAndThreeDigitAliasesCompared: true,
    },
    totals: {
      requestedSymbolCount: targets.length,
      successfulResponseCount: successfulResponses.length,
      failedResponseCount: results.length - successfulResponses.length,
      nonEmptyResponseCount: successfulResponses.filter(
        result => result.response.rowCount > 0,
      ).length,
      gapOverlappingResponseCount: gapOverlappingResponses.length,
    },
    instruments,
    legacyEndpointChecks: legacy,
    rights: {
      clientLibraryRequired: false,
      returnedMarketDataRedistributionPermissionConfirmed: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      conclusion: (
        '公开可访问不等于获得行情再分发权；未取得新浪或上游行情权利方的书面授权，'
        + '本探测结果不能作为内置数据来源。'
      ),
    },
    retention: {
      rawResponsesPersisted: false,
      rawRowsPersisted: false,
      timestampsPersisted: '仅保存每个响应和目标缺口的首末时间',
      summaryOnly: true,
    },
    releaseDecision: {
      technicalGapCoverageConfirmed: false,
      redistributionPermissionConfirmed: false,
      releasableGapSourceFound: false,
      baselineReplacementAllowed: false,
      task4_2MayBeMarkedComplete: false,
      note: (
        '具体合约短窗口可用于技术核验，但不能证明目标主连缺口逐交易时段完整，'
        + '且没有商业 EXE 再分发授权。'
      ),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runProbe(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已生成新浪期货分钟窗口探测报告：${options.output}`);
  console.log(
    `品种 ${report.requestPlan.instrumentCount}，请求 ${report.totals.requestedSymbolCount}，`
    + `非空响应 ${report.totals.nonEmptyResponseCount}，缺口重叠 ${report.totals.gapOverlappingResponseCount}`,
  );
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
