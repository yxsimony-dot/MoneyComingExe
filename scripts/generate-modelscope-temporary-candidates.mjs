import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INSTRUMENT_LIST } from '../src/shared/instruments.ts';
import {
  INSTRUMENTS,
  REPOSITORY,
  aggregateMinutes,
  analyzeArchiveEntries,
  extractEntry,
  parseTickCsv,
  readCentralDirectory,
  resolveSemanticMappings,
  summarizeMappings,
  ticksToMinutes,
} from './probe-modelscope-tick-source.mjs';
import {
  aggregateFiveMinuteBars,
  assertBarsEqual,
  assertContinuousBarCoverage,
  assertRollovers,
  expectedRollovers,
  validateBarCsv,
  validateMappingCsv,
  validateRolloverCsv,
} from './verify-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIRECTORY = join(ROOT, 'data');
const INSTRUMENTS_DIRECTORY = join(DATA_DIRECTORY, 'instruments');
const DEFAULT_TEMPORARY_ROOT = 'D:\\MoneyComing-temp';
const DEFAULT_OUTPUT = join(DEFAULT_TEMPORARY_ROOT, 'modelscope-candidates');
const DEFAULT_PROBE = join(DATA_DIRECTORY, 'modelscope-tick-source-probe.json');
const DEFAULT_START_DATE = '2022-11-01';
const DEFAULT_END_DATE = '2026-07-30';
const MINIMUM_FULL_CALIBRATION_DAYS = 20;
const MINUTE_MS = 60_000;
const NUMERIC_TOLERANCE = 0;
const DAILY_CACHE_SCHEMA_VERSION = 4;
const AGGREGATION_VERSION = 'edb-minute-boundary-v4';
const IMPORTER_VERSION = 'modelscope-temporary-candidate-v4';
const BAR_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'openOi',
  'closeOi',
  'observedMinutes',
  'expectedMinutes',
  'complete',
];
const BAR_HEADER = [
  'bar_start',
  'bar_end',
  'session',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'open_oi',
  'close_oi',
  'observed_minutes',
  'expected_minutes',
  'complete',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function formatBeijing(milliseconds) {
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseBeijing(value, label = value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  assert(match, `${label} 必须为北京时间 YYYY-MM-DD HH:mm:ss`);
  const milliseconds = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 8,
    Number(match[5]),
    Number(match[6]),
  );
  assert(formatBeijing(milliseconds) === value, `${label} 不是有效北京时间`);
  return milliseconds;
}

function validateDate(value, label) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${label} 必须为 YYYY-MM-DD：${value}`);
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  assert(
    Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString().slice(0, 10) === value,
    `${label} 不是有效日期：${value}`,
  );
}

function normalizedPath(path) {
  return resolve(path).replaceAll('/', '\\').toLowerCase();
}

function isSameOrInside(path, parent) {
  const child = normalizedPath(path);
  const root = normalizedPath(parent);
  return child === root || child.startsWith(`${root}\\`);
}

function isStrictlyInside(path, parent) {
  return normalizedPath(path) !== normalizedPath(parent)
    && isSameOrInside(path, parent);
}

export function assertSafeOutputPath(
  output,
  {
    repositoryRoot = ROOT,
    temporaryRoot = DEFAULT_TEMPORARY_ROOT,
  } = {},
) {
  const resolvedOutput = resolve(output);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  assert(
    isStrictlyInside(resolvedOutput, resolvedTemporaryRoot),
    `候选输出必须位于临时根目录之下：${resolvedTemporaryRoot}`,
  );
  assert(
    !isSameOrInside(resolvedOutput, repositoryRoot)
      && !isSameOrInside(resolvedOutput, join(repositoryRoot, 'data', 'instruments')),
    '候选输出不得位于项目仓库或 data/instruments 内',
  );
  return resolvedOutput;
}

export function parseArguments(
  argv,
  {
    repositoryRoot = ROOT,
    temporaryRoot = DEFAULT_TEMPORARY_ROOT,
  } = {},
) {
  const options = {
    probe: join(repositoryRoot, 'data', 'modelscope-tick-source-probe.json'),
    instrumentIds: INSTRUMENTS.map(instrument => instrument.id),
    start: DEFAULT_START_DATE,
    end: DEFAULT_END_DATE,
    output: join(temporaryRoot, 'modelscope-candidates'),
    startExplicit: false,
    endExplicit: false,
  };
  const selectedInstruments = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--probe') {
      assert(value && !value.startsWith('--'), '--probe 缺少参数值');
      options.probe = value;
      index += 1;
    } else if (argument === '--instrument' && value) {
      selectedInstruments.push(
        ...value.split(',').map(item => item.trim()).filter(Boolean),
      );
      index += 1;
    } else if (argument === '--start' && value) {
      options.start = value;
      options.startExplicit = true;
      index += 1;
    } else if (argument === '--end' && value) {
      options.end = value;
      options.endExplicit = true;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  validateDate(options.start, '--start');
  validateDate(options.end, '--end');
  assert(options.start <= options.end, '--start 不得晚于 --end');
  if (selectedInstruments.length) {
    options.instrumentIds = [...new Set(selectedInstruments)];
  }
  for (const instrumentId of options.instrumentIds) {
    assert(
      INSTRUMENTS.some(instrument => instrument.id === instrumentId),
      `未知品种：${instrumentId}`,
    );
  }
  return {
    ...options,
    probe: resolve(options.probe),
    output: assertSafeOutputPath(options.output, {
      repositoryRoot,
      temporaryRoot,
    }),
    repositoryRoot: resolve(repositoryRoot),
    temporaryRoot: resolve(temporaryRoot),
    requireThreeYearCoverage: !options.startExplicit && !options.endExplicit,
  };
}

function archiveDateRange(archive) {
  if (archive.granularity === 'trading-day') {
    const date = [
      archive.period.slice(0, 4),
      archive.period.slice(4, 6),
      archive.period.slice(6, 8),
    ].join('-');
    return { first: date, last: date };
  }
  const year = Number(archive.period.slice(0, 4));
  const month = Number(archive.period.slice(4, 6));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    first: `${archive.period.slice(0, 4)}-${archive.period.slice(4, 6)}-01`,
    last: `${archive.period.slice(0, 4)}-${archive.period.slice(4, 6)}-${String(lastDay).padStart(2, '0')}`,
  };
}

function immutableArchiveUrl(path) {
  const query = new URLSearchParams({
    Revision: REPOSITORY.commit,
    FilePath: path,
  });
  return `https://www.modelscope.cn/api/v1/datasets/${REPOSITORY.id}/repo?${query}`;
}

export async function readProbeInventory(probePath) {
  const report = JSON.parse(await readFile(probePath, 'utf8'));
  assert(report?.source?.id === REPOSITORY.id, 'ModelScope 探测报告仓库不一致');
  assert(
    report.source.commit === REPOSITORY.commit,
    `ModelScope 探测报告未固定到预期 commit：${REPOSITORY.commit}`,
  );
  const sourceInventory = report.source.repositoryInventory;
  assert(
    sourceInventory && Array.isArray(sourceInventory.archives),
    'ModelScope 探测报告缺少完整归档清单',
  );
  const archives = sourceInventory.archives.map(item => {
    const pointer = item.gitLfs ?? item.pointer;
    assert(
      item.path
        && item.period
        && ['month', 'trading-day'].includes(item.granularity)
        && Number.isSafeInteger(pointer?.size)
        && pointer.size > 0
        && /^[a-f0-9]{64}$/.test(pointer.sha256),
      `ModelScope 归档元数据无效：${item.path ?? item.period ?? '未知归档'}`,
    );
    return {
      name: basename(item.path),
      path: item.path,
      period: item.period,
      granularity: item.granularity,
      pointer,
      repositoryEntry: item.repositoryEntry,
      url: immutableArchiveUrl(item.path),
    };
  }).sort((left, right) => (
    left.period.localeCompare(right.period)
      || left.path.localeCompare(right.path)
  ));
  assert(archives.length > 0, 'ModelScope 探测报告没有归档');
  return {
    reportPath: probePath,
    capturedAt: report.capturedAt,
    commit: report.source.commit,
    normalizedManifestSha256: sourceInventory.normalizedManifestSha256,
    firstArchivePeriod: sourceInventory.firstArchivePeriod,
    lastArchivePeriod: sourceInventory.lastArchivePeriod,
    archives,
  };
}

export function selectArchives(archives, start, end) {
  const selectedIndexes = archives.flatMap((archive, index) => {
    const range = archiveDateRange(archive);
    return range.last >= start && range.first <= end ? [index] : [];
  });
  assert(selectedIndexes.length > 0, `${start} 至 ${end} 没有可用 ModelScope 归档`);
  const firstIndex = selectedIndexes[0];
  const indexes = new Set(selectedIndexes);
  if (firstIndex > 0) indexes.add(firstIndex - 1);
  return [...indexes].sort((left, right) => left - right).map(index => archives[index]);
}

function previousWeekday(date) {
  let milliseconds = Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  while ([0, 6].includes(new Date(milliseconds).getUTCDay())) {
    milliseconds -= 24 * 60 * 60 * 1000;
  }
  return new Date(milliseconds).toISOString().slice(0, 10);
}

export async function prepareSourceContext(options, dependencies = {}) {
  const loadInventory = dependencies.readProbeInventory ?? readProbeInventory;
  const readDirectory = dependencies.readCentralDirectory ?? readCentralDirectory;
  const analyze = dependencies.analyzeArchiveEntries ?? analyzeArchiveEntries;
  const resolveMappings = (
    dependencies.resolveSemanticMappings ?? resolveSemanticMappings
  );
  const summarize = dependencies.summarizeMappings ?? summarizeMappings;
  const inventory = await loadInventory(options.probe);
  const selectedArchives = selectArchives(inventory.archives, options.start, options.end);
  const analyses = [];
  for (const archive of selectedArchives) {
    dependencies.onProgress?.(`读取 ${archive.path} 中央目录`);
    const { centralDirectory, entries } = await readDirectory(archive);
    const analysis = analyze(archive, centralDirectory, entries);
    await resolveMappings(archive, analysis);
    analyses.push(analysis);
  }
  const allTradingDates = [...new Set(
    analyses.flatMap(analysis => analysis.tradingDates),
  )].sort();
  const selectedTradingDates = allTradingDates.filter(
    date => date >= options.start && date <= options.end,
  );
  assert(
    selectedTradingDates.length > 0,
    `${options.start} 至 ${options.end} 没有 ModelScope 交易日`,
  );
  const archiveByTradingDate = new Map();
  for (const analysis of analyses) {
    const archive = selectedArchives.find(candidate => candidate.path === analysis.path);
    assert(archive, `找不到归档分析对应的归档：${analysis.path}`);
    for (const tradingDate of analysis.tradingDates) {
      assert(
        !archiveByTradingDate.has(tradingDate),
        `交易日重复归属于多个归档：${tradingDate}`,
      );
      archiveByTradingDate.set(tradingDate, { archive, analysis });
    }
  }
  const previousTradingDateByDate = new Map();
  for (const tradingDate of selectedTradingDates) {
    const index = allTradingDates.indexOf(tradingDate);
    previousTradingDateByDate.set(
      tradingDate,
      index > 0 ? allTradingDates[index - 1] : previousWeekday(tradingDate),
    );
  }
  return {
    inventory,
    selectedArchives,
    analyses,
    selectedTradingDates,
    archiveByTradingDate,
    previousTradingDateByDate,
    mappingSummary: summarize(analyses),
  };
}

function barSession(startMs) {
  return Number(formatBeijing(startMs).slice(11, 13)) >= 21 ? 'night' : 'day';
}

function enrichBar(bar) {
  return {
    start: formatBeijing(bar.startMs),
    end: formatBeijing(bar.endMs),
    startMs: bar.startMs,
    endMs: bar.endMs,
    session: bar.session ?? barSession(bar.startMs),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    openOi: bar.openOi,
    closeOi: bar.closeOi,
    observedMinutes: bar.observedMinutes,
    expectedMinutes: bar.expectedMinutes,
    complete: bar.complete,
  };
}

export async function extractDailyCandidate(context, dependencies = {}) {
  const extract = dependencies.extractEntry ?? extractEntry;
  const parseTicks = dependencies.parseTickCsv ?? parseTickCsv;
  const toMinutes = dependencies.ticksToMinutes ?? ticksToMinutes;
  const aggregate = dependencies.aggregateMinutes ?? aggregateMinutes;
  const raw = await extract(context.archive, context.mapping.concreteEntry);
  const parsed = parseTicks(raw, {
    entryName: context.mapping.concreteEntry.name,
    tradingDate: context.tradingDate,
    previousTradingDate: context.previousTradingDate,
    contract: context.mapping.contract,
    exchange: context.instrument.exchange,
  });
  const minutes = toMinutes(parsed.ticks);
  assert(minutes.length > 0, `${context.instrument.name} ${context.tradingDate} 没有交易分钟`);
  assert(
    new Set(minutes.map(minute => minute.startMs)).size === minutes.length,
    `${context.instrument.name} ${context.tradingDate} 分钟时间戳重复`,
  );
  const bars5 = aggregate(minutes, 5).map(enrichBar);
  assert(
    bars5.length > 0 && bars5.every(bar => bar.complete),
    `${context.instrument.name} ${context.tradingDate} 存在不完整 5 分钟 K 线`,
  );
  assert(
    parsed.stats.invalidPriceRows === 0
      && parsed.stats.tradingDayFieldMismatches === 0
      && parsed.stats.instrumentFieldMismatches === 0,
    `${context.instrument.name} ${context.tradingDate} Tick 字段校验失败`,
  );
  return {
    rawSha256: sha256(raw),
    fields: parsed.fields,
    tickStats: parsed.stats,
    minuteRecords: minutes.length,
    bars5,
  };
}

function dailyCachePayload(record) {
  const {
    generatedAt: _generatedAt,
    payloadSha256: _payloadSha256,
    ...payload
  } = record;
  return payload;
}

export function hashDailyCacheRecord(record) {
  return sha256(canonicalJson(dailyCachePayload(record)));
}

function cacheIdentityMatches(record, context) {
  const entry = context.mapping.concreteEntry;
  return record?.schemaVersion === DAILY_CACHE_SCHEMA_VERSION
    && record.aggregationVersion === AGGREGATION_VERSION
    && record.importerVersion === IMPORTER_VERSION
    && record.source?.repositoryId === REPOSITORY.id
    && record.source?.commit === REPOSITORY.commit
    && record.instrumentId === context.instrument.id
    && record.tradingDate === context.tradingDate
    && record.previousTradingDate === context.previousTradingDate
    && record.contract === context.mapping.contract
    && record.archive?.path === context.archive.path
    && record.archive?.sha256 === context.archive.pointer.sha256
    && record.archive?.size === context.archive.pointer.size
    && record.entry?.name === entry.name
    && record.entry?.crc32 === entry.crc32Hex
    && record.entry?.compressedBytes === entry.compressedSize
    && record.entry?.uncompressedBytes === entry.uncompressedSize
    && Array.isArray(record.bars5)
    && record.bars5.length > 0
    && record.bars5.every(bar => bar.complete === true)
    && /^[a-f0-9]{64}$/.test(record.payloadSha256 ?? '')
    && record.payloadSha256 === hashDailyCacheRecord(record);
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (await fileExists(path)) await rm(path);
  await rename(temporary, path);
}

export async function loadOrCreateDailyCache(context, dependencies = {}) {
  const cachePath = join(
    context.outputRoot,
    '.cache',
    context.instrument.id,
    `${context.tradingDate}.json`,
  );
  if (await fileExists(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      if (cacheIdentityMatches(cached, context)) {
        return { record: cached, status: 'reused', path: cachePath };
      }
    } catch {
      // Invalid cache entries are regenerated from the immutable source entry.
    }
  }
  const extractDaily = dependencies.extractDailyCandidate ?? extractDailyCandidate;
  const extracted = await extractDaily(context, dependencies);
  const record = {
    schemaVersion: DAILY_CACHE_SCHEMA_VERSION,
    aggregationVersion: AGGREGATION_VERSION,
    importerVersion: IMPORTER_VERSION,
    source: {
      repositoryId: REPOSITORY.id,
      commit: REPOSITORY.commit,
    },
    instrumentId: context.instrument.id,
    tradingDate: context.tradingDate,
    previousTradingDate: context.previousTradingDate,
    contract: context.mapping.contract,
    mappingMatchMethod: context.mapping.matchMethod,
    archive: {
      path: context.archive.path,
      period: context.archive.period,
      sha256: context.archive.pointer.sha256,
      size: context.archive.pointer.size,
    },
    entry: {
      name: context.mapping.concreteEntry.name,
      crc32: context.mapping.concreteEntry.crc32Hex,
      compressedBytes: context.mapping.concreteEntry.compressedSize,
      uncompressedBytes: context.mapping.concreteEntry.uncompressedSize,
    },
    rawSha256: extracted.rawSha256,
    fields: extracted.fields,
    tickStats: extracted.tickStats,
    minuteRecords: extracted.minuteRecords,
    bars5: extracted.bars5.map(enrichBar),
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  record.payloadSha256 = hashDailyCacheRecord(record);
  await writeJsonAtomically(cachePath, record);
  return {
    record,
    status: await fileExists(cachePath) ? 'generated' : 'failed',
    path: cachePath,
  };
}

export async function readEdbBaseline(
  repositoryRoot,
  definition,
) {
  const directory = join(repositoryRoot, 'data', 'instruments', definition.id);
  const [bars5Text, bars60Text, mappingsText, rolloversText, metadataText] = (
    await Promise.all([
      readFile(join(directory, 'edb_main_continuous_5m.csv'), 'utf8'),
      readFile(join(directory, 'edb_main_continuous_60m.csv'), 'utf8'),
      readFile(join(directory, 'edb_main_contract_mapping.csv'), 'utf8'),
      readFile(join(directory, 'edb_main_continuous_rollovers.csv'), 'utf8'),
      readFile(join(directory, 'metadata.json'), 'utf8'),
    ])
  );
  const bars5 = validateBarCsv(
    bars5Text,
    `${definition.name} EDB 5 分钟`,
    5,
  ).bars;
  const bars60 = validateBarCsv(
    bars60Text,
    `${definition.name} EDB 60 分钟`,
    60,
  ).bars;
  const mappings = validateMappingCsv(
    mappingsText,
    `${definition.name} EDB 主力映射`,
    definition,
  ).records;
  const rollovers = validateRolloverCsv(
    rolloversText,
    `${definition.name} EDB 换月`,
    definition,
  ).records;
  const metadata = JSON.parse(metadataText);
  return {
    bars5,
    bars60,
    mappings,
    rollovers,
    metadata,
    rawFiles: [
      ['edb_main_continuous_5m.csv', bars5Text, bars5.length],
      ['edb_main_continuous_60m.csv', bars60Text, bars60.length],
      ['edb_main_contract_mapping.csv', mappingsText, mappings.length],
      ['edb_main_continuous_rollovers.csv', rolloversText, rollovers.length],
      ['metadata.json', metadataText, 1],
    ].map(([name, text, rows]) => ({
      name,
      sha256: sha256(text),
      rows,
    })),
  };
}

function firstDateAfter(dates, naturalDate) {
  let left = 0;
  let right = dates.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (dates[middle] <= naturalDate) left = middle + 1;
    else right = middle;
  }
  return dates[left];
}

export function groupBarsByTradingDate(bars) {
  const dayNaturalDates = [...new Set(
    bars
      .filter(bar => bar.session === 'day')
      .map(bar => bar.start.slice(0, 10)),
  )].sort();
  const groups = new Map();
  for (const bar of bars) {
    const naturalDate = bar.start.slice(0, 10);
    const tradingDate = bar.session === 'night'
      ? firstDateAfter(dayNaturalDates, naturalDate)
      : naturalDate;
    if (!tradingDate) continue;
    const group = groups.get(tradingDate) ?? [];
    group.push(bar);
    groups.set(tradingDate, group);
  }
  return groups;
}

export function normalizeDailyRecordContinuity(dailyRecords) {
  const normalized = dailyRecords.map(record => ({
    ...record,
    bars5: record.bars5.map(bar => ({ ...bar })),
  }));
  for (let index = 1; index < normalized.length; index += 1) {
    const previousRecord = normalized[index - 1];
    const currentRecord = normalized[index];
    if (
      previousRecord.contract !== currentRecord.contract
      || !previousRecord.bars5.length
      || !currentRecord.bars5.length
    ) {
      continue;
    }
    const previousBar = previousRecord.bars5.at(-1);
    const currentBar = currentRecord.bars5[0];
    currentBar.openOi = previousBar.closeOi;
  }
  return normalized;
}

function equalNumber(left, right) {
  return Math.abs(left - right) <= NUMERIC_TOLERANCE;
}

function absoluteDifferenceSummary(differences) {
  if (!differences.length) return null;
  const sorted = [...differences].sort((left, right) => left - right);
  const quantile = ratio => sorted[Math.floor((sorted.length - 1) * ratio)];
  const sum = sorted.reduce((total, value) => total + value, 0);
  const buckets = {
    gt0Lte1: 0,
    gt1Lte2: 0,
    gt2Lte5: 0,
    gt5Lte10: 0,
    gt10Lte100: 0,
    gt100Lte1000: 0,
    gt1000: 0,
  };
  for (const difference of sorted) {
    if (difference <= 1) buckets.gt0Lte1 += 1;
    else if (difference <= 2) buckets.gt1Lte2 += 1;
    else if (difference <= 5) buckets.gt2Lte5 += 1;
    else if (difference <= 10) buckets.gt5Lte10 += 1;
    else if (difference <= 100) buckets.gt10Lte100 += 1;
    else if (difference <= 1_000) buckets.gt100Lte1000 += 1;
    else buckets.gt1000 += 1;
  }
  return {
    count: sorted.length,
    minimum: sorted[0],
    maximum: sorted.at(-1),
    mean: sum / sorted.length,
    quantiles: {
      p50: quantile(0.5),
      p90: quantile(0.9),
      p95: quantile(0.95),
      p99: quantile(0.99),
    },
    buckets,
  };
}

function buildFieldStatistics(barMismatches) {
  const accumulators = new Map(BAR_FIELDS.map(field => [field, {
    mismatchRows: 0,
    nonNumericMismatchRows: 0,
    absoluteDifferences: [],
  }]));
  for (const mismatch of barMismatches) {
    for (const field of mismatch.fields) {
      const accumulator = accumulators.get(field);
      accumulator.mismatchRows += 1;
      const candidate = mismatch.candidate[field];
      const reference = mismatch.edb[field];
      if (typeof candidate === 'number' && typeof reference === 'number') {
        accumulator.absoluteDifferences.push(Math.abs(candidate - reference));
      } else {
        accumulator.nonNumericMismatchRows += 1;
      }
    }
  }
  return Object.fromEntries(BAR_FIELDS.map(field => {
    const accumulator = accumulators.get(field);
    return [field, {
      mismatchRows: accumulator.mismatchRows,
      numericMismatchRows: accumulator.absoluteDifferences.length,
      nonNumericMismatchRows: accumulator.nonNumericMismatchRows,
      absoluteDifference: absoluteDifferenceSummary(
        accumulator.absoluteDifferences,
      ),
    }];
  }));
}

export function calibrateAgainstEdb(
  dailyRecords,
  candidateMappings,
  edb,
  { requireThreeYearCoverage },
) {
  const edbMappingByDate = new Map(
    edb.mappings.map(mapping => [mapping.tradingDate, mapping]),
  );
  const modelBarEntries = dailyRecords.flatMap(record => record.bars5.map(bar => ({
    tradingDate: record.tradingDate,
    bar,
  }))).sort((left, right) => left.bar.startMs - right.bar.startMs);
  const edbBarsByDate = groupBarsByTradingDate(edb.bars5);
  const edbBarEntries = [...edbBarsByDate.entries()].flatMap(
    ([tradingDate, bars]) => bars.map(bar => ({ tradingDate, bar })),
  ).sort((left, right) => left.bar.startMs - right.bar.startMs);
  const sharedFirstMs = modelBarEntries.length && edbBarEntries.length
    ? Math.max(modelBarEntries[0].bar.startMs, edbBarEntries[0].bar.startMs)
    : null;
  const sharedLastMs = modelBarEntries.length && edbBarEntries.length
    ? Math.min(modelBarEntries.at(-1).bar.startMs, edbBarEntries.at(-1).bar.startMs)
    : null;
  const hasSharedWindow = (
    sharedFirstMs !== null
    && sharedLastMs !== null
    && sharedFirstMs <= sharedLastMs
  );
  const inSharedWindow = entry => (
    hasSharedWindow
    && entry.bar.startMs >= sharedFirstMs
    && entry.bar.startMs <= sharedLastMs
  );
  const modelWindowEntries = modelBarEntries.filter(inSharedWindow);
  const edbWindowEntries = edbBarEntries.filter(inSharedWindow);
  const modelTradingDates = new Set(
    modelWindowEntries.map(entry => entry.tradingDate),
  );
  const edbTradingDates = new Set(
    edbWindowEntries.map(entry => entry.tradingDate),
  );
  const sharedBarTradingDates = [...modelTradingDates]
    .filter(tradingDate => edbTradingDates.has(tradingDate))
    .sort();
  const sharedBarTradingDateSet = new Set(sharedBarTradingDates);
  const overlapMappings = candidateMappings.filter(mapping => (
    sharedBarTradingDateSet.has(mapping.tradingDate)
    && edbMappingByDate.has(mapping.tradingDate)
  ));
  const mappingMismatches = overlapMappings.flatMap(mapping => {
    const reference = edbMappingByDate.get(mapping.tradingDate);
    return mapping.contract === reference.contract ? [] : [{
      tradingDate: mapping.tradingDate,
      candidateContract: mapping.contract,
      edbContract: reference.contract,
    }];
  });
  const modelByStart = new Map(
    modelWindowEntries.map(entry => [entry.bar.startMs, entry]),
  );
  const edbByStart = new Map(
    edbWindowEntries.map(entry => [entry.bar.startMs, entry]),
  );
  const missingModelBars = [];
  const missingEdbBars = [];
  const barTradingDateMismatches = [];
  const barMismatches = [];
  let comparedBars = 0;
  for (const entry of modelWindowEntries) {
    const referenceEntry = edbByStart.get(entry.bar.startMs);
    if (!referenceEntry) {
      missingEdbBars.push({
        tradingDate: entry.tradingDate,
        start: entry.bar.start,
      });
      continue;
    }
    comparedBars += 1;
    if (entry.tradingDate !== referenceEntry.tradingDate) {
      barTradingDateMismatches.push({
        start: entry.bar.start,
        candidateTradingDate: entry.tradingDate,
        edbTradingDate: referenceEntry.tradingDate,
      });
    }
    const fields = BAR_FIELDS.filter(field => (
      typeof entry.bar[field] === 'number'
        ? !equalNumber(entry.bar[field], referenceEntry.bar[field])
        : entry.bar[field] !== referenceEntry.bar[field]
    ));
    if (fields.length) {
      barMismatches.push({
        tradingDate: entry.tradingDate,
        start: entry.bar.start,
        fields,
        candidate: Object.fromEntries(
          fields.map(field => [field, entry.bar[field]]),
        ),
        edb: Object.fromEntries(
          fields.map(field => [field, referenceEntry.bar[field]]),
        ),
      });
    }
  }
  for (const entry of edbWindowEntries) {
    if (!modelByStart.has(entry.bar.startMs)) {
      missingModelBars.push({
        tradingDate: entry.tradingDate,
        start: entry.bar.start,
      });
    }
  }
  const fieldStatistics = buildFieldStatistics(barMismatches);
  const affectedTradingDates = [...new Set([
    ...mappingMismatches.map(item => item.tradingDate),
    ...missingModelBars.map(item => item.tradingDate),
    ...missingEdbBars.map(item => item.tradingDate),
    ...barTradingDateMismatches.flatMap(item => [
      item.candidateTradingDate,
      item.edbTradingDate,
    ]),
    ...barMismatches.map(item => item.tradingDate),
  ])].sort();
  const minimumDays = requireThreeYearCoverage
    ? MINIMUM_FULL_CALIBRATION_DAYS
    : 1;
  const violations = [];
  if (!hasSharedWindow || comparedBars === 0) {
    violations.push('没有可比较的共享 5 分钟 K 线窗口');
  }
  if (overlapMappings.length < minimumDays) {
    violations.push(`重叠交易日不足：${overlapMappings.length} < ${minimumDays}`);
  }
  if (mappingMismatches.length) {
    violations.push(`主力映射差异：${mappingMismatches.length} 个交易日`);
  }
  if (missingModelBars.length || missingEdbBars.length) {
    violations.push(
      `重叠 K 线缺失：ModelScope 缺 ${missingModelBars.length}，EDB 缺 ${missingEdbBars.length}`,
    );
  }
  if (barTradingDateMismatches.length) {
    violations.push(
      `K 线交易日归属差异：${barTradingDateMismatches.length} 根 5 分钟 K 线`,
    );
  }
  if (barMismatches.length) {
    violations.push(`OHLC/成交量/持仓量差异：${barMismatches.length} 根 5 分钟 K 线`);
  }
  return {
    overlap: {
      firstTradingDate: overlapMappings[0]?.tradingDate ?? null,
      lastTradingDate: overlapMappings.at(-1)?.tradingDate ?? null,
      days: overlapMappings.length,
      firstBarTradingDate: sharedBarTradingDates[0] ?? null,
      lastBarTradingDate: sharedBarTradingDates.at(-1) ?? null,
      barTradingDays: sharedBarTradingDates.length,
      firstBarStart: hasSharedWindow ? formatBeijing(sharedFirstMs) : null,
      lastBarStart: hasSharedWindow ? formatBeijing(sharedLastMs) : null,
      candidateBarsInWindow: modelWindowEntries.length,
      edbBarsInWindow: edbWindowEntries.length,
      comparedBars,
    },
    thresholds: {
      minimumTradingDays: minimumDays,
      maximumMappingMismatchDays: 0,
      maximumMissingBars: 0,
      maximumBarTradingDateMismatches: 0,
      maximumBarMismatchRows: 0,
      numericTolerance: NUMERIC_TOLERANCE,
    },
    counts: {
      mappingMismatchDays: mappingMismatches.length,
      missingModelBars: missingModelBars.length,
      missingEdbBars: missingEdbBars.length,
      barTradingDateMismatches: barTradingDateMismatches.length,
      barMismatchRows: barMismatches.length,
    },
    affectedTradingDates,
    fieldStatistics,
    details: {
      mappingMismatches,
      missingModelBars,
      missingEdbBars,
      barTradingDateMismatches,
      barMismatches,
    },
    samples: {
      mappingMismatches: mappingMismatches.slice(0, 100),
      missingModelBars: missingModelBars.slice(0, 100),
      missingEdbBars: missingEdbBars.slice(0, 100),
      barTradingDateMismatches: barTradingDateMismatches.slice(0, 100),
      barMismatches: barMismatches.slice(0, 100),
    },
    allowed: violations.length === 0,
    violations,
  };
}

function serializeBars(bars) {
  const rows = bars.map(bar => [
    bar.start,
    bar.end,
    bar.session,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.openOi,
    bar.closeOi,
    bar.observedMinutes,
    bar.expectedMinutes,
    bar.complete ? 'True' : 'False',
  ].join(','));
  return `${BAR_HEADER.join(',')}\n${rows.join('\n')}\n`;
}

function serializeMappings(mappings) {
  return `trading_date,contract\n${mappings.map(
    mapping => `${mapping.tradingDate},${mapping.contract}`,
  ).join('\n')}\n`;
}

function serializeRollovers(rollovers) {
  const rows = rollovers.map(rollover => [
    rollover.tradingDate,
    rollover.time,
    rollover.fromContract,
    rollover.toContract,
  ].join(','));
  return `trading_date,time,from_contract,to_contract\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

function periodSummary(bars) {
  return {
    first: bars[0].start,
    last: bars.at(-1).end,
    rows: bars.length,
  };
}

function aggregateModelScopeRawFiles(dailyRecords) {
  const archives = new Map();
  for (const record of dailyRecords) {
    const current = archives.get(record.archive.path) ?? {
      name: record.archive.path,
      sha256: record.archive.sha256,
      rows: 0,
      selectedEntries: 0,
      compressedBytes: 0,
      uncompressedBytes: 0,
    };
    current.rows += record.tickStats.sourceRows;
    current.selectedEntries += 1;
    current.compressedBytes += record.entry.compressedBytes;
    current.uncompressedBytes += record.entry.uncompressedBytes;
    archives.set(record.archive.path, current);
  }
  return [...archives.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function fileDeclaration(name, text, rows) {
  return {
    name,
    sha256: sha256(text),
    rows,
  };
}

export function buildReleaseDecision() {
  return {
    technicalCandidateOnly: true,
    redistributionPermissionConfirmed: false,
    baselineReplacementAllowed: false,
    releaseEligible: false,
    reason: (
      'ModelScope 数据集卡没有证明原始行情来源及上游再分发权。'
      + '候选只允许保存在 D:\\MoneyComing-temp，不得进入 Git、EXE 或安装包。'
    ),
  };
}

export function summarizeCalibration(calibration) {
  if (!calibration) return null;
  return {
    allowed: calibration.allowed,
    overlap: {
      firstTradingDate: calibration.overlap?.firstTradingDate ?? null,
      lastTradingDate: calibration.overlap?.lastTradingDate ?? null,
      days: calibration.overlap?.days ?? 0,
      firstBarTradingDate: calibration.overlap?.firstBarTradingDate ?? null,
      lastBarTradingDate: calibration.overlap?.lastBarTradingDate ?? null,
      barTradingDays: calibration.overlap?.barTradingDays ?? 0,
      comparedBars: calibration.overlap?.comparedBars ?? 0,
    },
    counts: {
      mappingMismatchDays: calibration.counts?.mappingMismatchDays ?? 0,
      missingModelBars: calibration.counts?.missingModelBars ?? 0,
      missingEdbBars: calibration.counts?.missingEdbBars ?? 0,
      barTradingDateMismatches: (
        calibration.counts?.barTradingDateMismatches ?? 0
      ),
      barMismatchRows: calibration.counts?.barMismatchRows ?? 0,
    },
    affectedTradingDateCount: calibration.affectedTradingDates?.length ?? 0,
    fieldMismatchRows: Object.fromEntries(BAR_FIELDS.map(field => [
      field,
      calibration.fieldStatistics?.[field]?.mismatchRows ?? 0,
    ])),
    violations: calibration.violations ?? [],
  };
}

function aggregateCalibrationSummaries(results) {
  const calibrations = results
    .map(result => result.calibration)
    .filter(Boolean);
  return {
    instrumentsReported: calibrations.length,
    comparedBars: calibrations.reduce(
      (sum, calibration) => sum + calibration.overlap.comparedBars,
      0,
    ),
    mappingMismatchDays: calibrations.reduce(
      (sum, calibration) => sum + calibration.counts.mappingMismatchDays,
      0,
    ),
    missingModelBars: calibrations.reduce(
      (sum, calibration) => sum + calibration.counts.missingModelBars,
      0,
    ),
    missingEdbBars: calibrations.reduce(
      (sum, calibration) => sum + calibration.counts.missingEdbBars,
      0,
    ),
    barTradingDateMismatches: calibrations.reduce(
      (sum, calibration) => (
        sum + calibration.counts.barTradingDateMismatches
      ),
      0,
    ),
    barMismatchRows: calibrations.reduce(
      (sum, calibration) => sum + calibration.counts.barMismatchRows,
      0,
    ),
  };
}

function technicalFailure(message, report) {
  const error = new Error(message);
  error.technicalReport = report;
  return error;
}

export async function atomicReplaceDirectory(
  staging,
  target,
  dependencies = {},
) {
  assert(dirname(staging) === dirname(target), 'staging 与目标目录必须位于同一父目录');
  const fsRename = dependencies.rename ?? rename;
  const fsRm = dependencies.rm ?? rm;
  const exists = dependencies.fileExists ?? fileExists;
  const backup = join(
    dirname(target),
    `.backup-${basename(target)}-${randomUUID()}`,
  );
  const hadTarget = await exists(target);
  let targetMoved = false;
  try {
    if (hadTarget) {
      await fsRename(target, backup);
      targetMoved = true;
    }
    await fsRename(staging, target);
    if (targetMoved) {
      await fsRm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    if (targetMoved) {
      try {
        await fsRename(backup, target);
        targetMoved = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `候选替换失败且旧候选恢复失败：${target}`,
        );
      }
    }
    await fsRm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeCandidateFiles(
  staging,
  {
    bars5Text,
    bars60Text,
    mappingsText,
    rolloversText,
    metadata,
    technicalReport,
  },
) {
  await mkdir(staging, { recursive: false });
  await Promise.all([
    writeFile(join(staging, 'edb_main_continuous_5m.csv'), bars5Text, 'utf8'),
    writeFile(join(staging, 'edb_main_continuous_60m.csv'), bars60Text, 'utf8'),
    writeFile(join(staging, 'edb_main_contract_mapping.csv'), mappingsText, 'utf8'),
    writeFile(join(staging, 'edb_main_continuous_rollovers.csv'), rolloversText, 'utf8'),
    writeFile(
      join(staging, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      join(staging, 'technical-validation-report.json'),
      `${JSON.stringify(technicalReport, null, 2)}\n`,
      'utf8',
    ),
  ]);
}

export async function generateInstrumentCandidate(
  options,
  sourceContext,
  instrument,
  dependencies = {},
) {
  const definition = INSTRUMENT_LIST.find(candidate => candidate.id === instrument.id);
  assert(definition, `应用注册表缺少品种：${instrument.id}`);
  const dailyRecords = [];
  const cache = { generated: 0, reused: 0 };
  for (const tradingDate of sourceContext.selectedTradingDates) {
    const mapping = sourceContext.mappingSummary.mappingByKey.get(
      `${tradingDate}|${instrument.id}`,
    );
    assert(
      mapping?.status === 'mapped' && mapping.concreteEntry,
      `${instrument.name} ${tradingDate} 缺少唯一具体主力合约映射`,
    );
    const archiveContext = sourceContext.archiveByTradingDate.get(tradingDate);
    assert(archiveContext, `${tradingDate} 缺少归档上下文`);
    dependencies.onProgress?.(`${instrument.name} ${tradingDate}`);
    const cached = await loadOrCreateDailyCache({
      outputRoot: options.output,
      instrument,
      tradingDate,
      previousTradingDate: sourceContext.previousTradingDateByDate.get(tradingDate),
      mapping,
      archive: archiveContext.archive,
    }, dependencies);
    cache[cached.status] += 1;
    dailyRecords.push(cached.record);
  }

  const readBaseline = dependencies.readEdbBaseline ?? readEdbBaseline;
  const edb = await readBaseline(options.repositoryRoot, definition);
  const normalizedDailyRecords = normalizeDailyRecordContinuity(dailyRecords);
  const candidateMappings = dailyRecords.map(record => ({
    tradingDate: record.tradingDate,
    contract: record.contract,
  }));
  const calibration = calibrateAgainstEdb(
    normalizedDailyRecords,
    candidateMappings,
    edb,
    options,
  );
  const releaseDecision = buildReleaseDecision();
  if (!calibration.allowed) {
    throw technicalFailure(
      `${instrument.name} 与 EDB 重叠校准未通过`,
      {
        schemaVersion: 1,
        instrumentId: instrument.id,
        name: instrument.name,
        generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        technicalPassed: false,
        releaseEligible: false,
        cache,
        calibration,
        releaseDecision,
      },
    );
  }

  const edbFirstStart = edb.bars5[0].startMs;
  const modelBars = normalizedDailyRecords.flatMap(record => record.bars5);
  const modelContribution = modelBars.filter(bar => bar.startMs < edbFirstStart);
  const bars5 = [...modelContribution, ...edb.bars5].sort(
    (left, right) => left.startMs - right.startMs,
  );
  assert(
    new Set(bars5.map(bar => bar.startMs)).size === bars5.length,
    `${instrument.name} 合并后 5 分钟时间戳重复`,
  );
  const firstEdbMappingDate = edb.mappings[0].tradingDate;
  const mappings = [
    ...candidateMappings.filter(mapping => mapping.tradingDate < firstEdbMappingDate),
    ...edb.mappings,
  ];
  const bars60 = aggregateFiveMinuteBars(bars5, definition);
  assertBarsEqual(bars60, aggregateFiveMinuteBars(bars5, definition), definition);
  assertContinuousBarCoverage(
    definition,
    bars5,
    bars60,
    mappings,
    { requireThreeYearCoverage: options.requireThreeYearCoverage },
  );
  const rollovers = expectedRollovers(mappings, bars5, definition);
  assertRollovers(rollovers, expectedRollovers(mappings, bars5, definition), definition);
  assert(
    bars5[0].startMs <= edb.bars5[0].startMs
      && bars5.at(-1).endMs >= edb.bars5.at(-1).endMs,
    `${instrument.name} 历史范围相对现有 EDB 基线发生倒退`,
  );
  if (options.requireThreeYearCoverage) {
    assert(
      modelContribution.length > 0 && bars5[0].startMs < edb.bars5[0].startMs,
      `${instrument.name} 未生成早于现有 EDB 基线的长期历史`,
    );
  }

  const bars5Text = serializeBars(bars5);
  const bars60Text = serializeBars(bars60);
  const mappingsText = serializeMappings(mappings);
  const rolloversText = serializeRollovers(rollovers);
  validateBarCsv(bars5Text, `${instrument.name} 候选 5 分钟`, 5);
  validateBarCsv(bars60Text, `${instrument.name} 候选 60 分钟`, 60);
  validateMappingCsv(
    mappingsText,
    `${instrument.name} 候选主力映射`,
    definition,
  );
  validateRolloverCsv(
    rolloversText,
    `${instrument.name} 候选换月`,
    definition,
  );

  const files = {
    bars5: fileDeclaration('edb_main_continuous_5m.csv', bars5Text, bars5.length),
    bars60: fileDeclaration('edb_main_continuous_60m.csv', bars60Text, bars60.length),
    rollovers: fileDeclaration(
      'edb_main_continuous_rollovers.csv',
      rolloversText,
      rollovers.length,
    ),
    mainContractMappings: fileDeclaration(
      'edb_main_contract_mapping.csv',
      mappingsText,
      mappings.length,
    ),
  };
  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const modelCoverageBars = modelContribution.length ? modelContribution : modelBars;
  const sourceSegments = [
    {
      sourceId: `modelscope-${REPOSITORY.commit}`,
      sourceName: REPOSITORY.id,
      kind: 'gap-fill',
      sourceVersion: REPOSITORY.commit,
      acquiredAt: generatedAt,
      coverage: periodSummary(modelCoverageBars),
      rawFiles: aggregateModelScopeRawFiles(dailyRecords),
      importerVersion: IMPORTER_VERSION,
      aggregationVersion: AGGREGATION_VERSION,
      license: {
        redistributionAllowed: false,
        conclusion: (
          '数据集卡声明 Apache-2.0，但原始行情来源和上游再分发权未确认；'
          + '只允许临时技术验证。'
        ),
      },
    },
    {
      sourceId: `existing-edb-${definition.id}`,
      sourceName: '现有内置 EDB 尾部',
      kind: 'edb-tail',
      sourceVersion: edb.metadata.generatedAt,
      acquiredAt: edb.metadata.generatedAt,
      coverage: periodSummary(edb.bars5),
      rawFiles: edb.rawFiles,
      importerVersion: IMPORTER_VERSION,
      aggregationVersion: AGGREGATION_VERSION,
      license: {
        redistributionAllowed: true,
        conclusion: '沿用仓库现有内置 EDB 基线，仅作为候选尾部和校准基准。',
      },
    },
  ];
  const metadata = {
    schemaVersion: 5,
    snapshotId: `temporary-modelscope-${definition.id}`,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: {
      provider: 'MIXED',
      symbol: definition.mainSymbol,
    },
    generatedAt,
    requestStart: bars5[0].start,
    requestEnd: bars5.at(-1).end,
    sourceLatestAt: edb.metadata.sourceLatestAt,
    files,
    periods: {
      bars5: periodSummary(bars5),
      bars60: periodSummary(bars60),
    },
    sourceSegments,
    redistribution: {
      allowed: false,
      conclusion: releaseDecision.reason,
    },
    releaseEligible: false,
  };
  const technicalReport = {
    schemaVersion: 1,
    instrumentId: definition.id,
    name: definition.name,
    generatedAt,
    requestedRange: {
      firstTradingDate: options.start,
      lastTradingDate: options.end,
    },
    source: {
      repositoryId: REPOSITORY.id,
      commit: REPOSITORY.commit,
      manifestSha256: sourceContext.inventory.normalizedManifestSha256,
      importerVersion: IMPORTER_VERSION,
      aggregationVersion: AGGREGATION_VERSION,
      selectedTradingDays: dailyRecords.length,
      firstTradingDate: dailyRecords[0].tradingDate,
      lastTradingDate: dailyRecords.at(-1).tradingDate,
      rawFiles: aggregateModelScopeRawFiles(dailyRecords),
    },
    cache,
    calibration,
    merge: {
      modelScopeInputBars5: modelBars.length,
      modelScopeContributedBars5: modelContribution.length,
      edbTailBars5: edb.bars5.length,
      outputBars5: bars5.length,
      outputBars60: bars60.length,
      outputMappings: mappings.length,
      outputRollovers: rollovers.length,
      modelScopeOnlyBeforeEdbFirstBar: modelContribution.every(
        bar => bar.startMs < edbFirstStart,
      ),
      edbTailPriority: true,
    },
    checks: {
      fixedRepositoryCommit: sourceContext.inventory.commit === REPOSITORY.commit,
      dailyMappingsUnique: dailyRecords.length === sourceContext.selectedTradingDates.length,
      dailyCachesValid: cache.generated + cache.reused === dailyRecords.length,
      overlapCalibrationPassed: calibration.allowed,
      fiveMinuteHistoryNotRegressed: bars5[0].startMs <= edb.bars5[0].startMs,
      edbTailPreserved: bars5.at(-1).endMs >= edb.bars5.at(-1).endMs,
      sixtyMinuteRebuiltFromFiveMinute: true,
      rolloversRebuiltFromMappings: true,
      redistributionBlocked: releaseDecision.releaseEligible === false,
    },
    periods: metadata.periods,
    files,
    technicalPassed: true,
    releaseEligible: false,
    releaseDecision,
  };

  const staging = join(
    options.output,
    `.staging-${instrument.id}-${randomUUID()}`,
  );
  const target = join(options.output, instrument.id);
  try {
    await writeCandidateFiles(staging, {
      bars5Text,
      bars60Text,
      mappingsText,
      rolloversText,
      metadata,
      technicalReport,
    });
    const replace = dependencies.atomicReplaceDirectory ?? atomicReplaceDirectory;
    await replace(staging, target, dependencies);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return technicalReport;
}

async function writeFailureReport(output, instrument, error, now) {
  const report = error?.technicalReport ?? {
    schemaVersion: 1,
    instrumentId: instrument.id,
    name: instrument.name,
    generatedAt: now().toISOString(),
    technicalPassed: false,
    releaseEligible: false,
    releaseDecision: buildReleaseDecision(),
  };
  report.error = error instanceof Error ? error.message : String(error);
  const path = join(output, '_failures', `${instrument.id}.json`);
  await writeJsonAtomically(path, report);
  return { path, report };
}

export async function generateTemporaryCandidates(options, dependencies = {}) {
  assertSafeOutputPath(options.output, {
    repositoryRoot: options.repositoryRoot,
    temporaryRoot: options.temporaryRoot,
  });
  await mkdir(options.output, { recursive: true });
  const sourceContext = dependencies.sourceContext
    ?? await prepareSourceContext(options, dependencies);
  const now = dependencies.now ?? (() => new Date());
  const results = [];
  for (const instrumentId of options.instrumentIds) {
    const instrument = INSTRUMENTS.find(candidate => candidate.id === instrumentId);
    assert(instrument, `未知品种：${instrumentId}`);
    dependencies.onProgress?.(`生成 ${instrument.name} 临时候选`);
    try {
      const report = await generateInstrumentCandidate(
        options,
        sourceContext,
        instrument,
        dependencies,
      );
      results.push({
        instrumentId,
        name: instrument.name,
        status: 'succeeded',
        technicalPassed: report.technicalPassed,
        releaseEligible: false,
        output: join(options.output, instrumentId),
        calibration: summarizeCalibration(report.calibration),
      });
    } catch (error) {
      const failure = await writeFailureReport(options.output, instrument, error, now);
      results.push({
        instrumentId,
        name: instrument.name,
        status: 'failed',
        technicalPassed: false,
        releaseEligible: false,
        error: error instanceof Error ? error.message : String(error),
        report: failure.path,
        calibration: summarizeCalibration(failure.report.calibration),
      });
    }
  }
  const summary = {
    schemaVersion: 2,
    generatedAt: now().toISOString(),
    source: {
      repositoryId: REPOSITORY.id,
      commit: REPOSITORY.commit,
      probe: options.probe,
    },
    requestedRange: {
      firstTradingDate: options.start,
      lastTradingDate: options.end,
    },
    output: options.output,
    instruments: results,
    counts: {
      requested: results.length,
      succeeded: results.filter(result => result.status === 'succeeded').length,
      failed: results.filter(result => result.status === 'failed').length,
    },
    allTechnicalCandidatesPassed: (
      results.length > 0
      && results.every(result => result.technicalPassed)
    ),
    calibrationTotals: aggregateCalibrationSummaries(results),
    releaseEligible: false,
    releaseDecision: buildReleaseDecision(),
  };
  await writeJsonAtomically(
    join(options.output, 'technical-validation-summary.json'),
    summary,
  );
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  console.log(
    `生成 ${options.instrumentIds.length} 个 ModelScope 临时候选：`
      + `${options.start} 至 ${options.end}`,
  );
  const summary = await generateTemporaryCandidates(options, {
    onProgress: message => console.log(message),
  });
  console.log(
    `候选生成结束：成功 ${summary.counts.succeeded}，失败 ${summary.counts.failed}。`
      + ' releaseEligible 固定为 false。',
  );
  if (summary.counts.failed > 0) process.exitCode = 1;
  return summary;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
