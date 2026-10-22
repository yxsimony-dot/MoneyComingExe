import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import {
  INSTRUMENT_LIST,
  isConcreteContractCode,
} from '../src/shared/instruments.ts';
import {
  assetName,
  listFiles,
  pathExists,
  readPackageManifest,
  readYamlFile,
  releaseDirectory,
  sha512Base64,
} from './release-utils.mjs';

export const REQUIRED_INSTRUMENT_FILES = [
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'edb_main_continuous_rollovers.csv',
  'edb_main_contract_mapping.csv',
  'metadata.json',
];

export const OPTIONAL_INSTRUMENT_FILES = [
  'edb_main_continuous_1m_raw.csv',
];

export const REQUIRED_TOP_LEVEL_DATA = [
  'baseline-report.json',
  'baseline-validation-report.json',
  'entry-rules.md',
];

export const REQUIRED_DATA = [
  ...REQUIRED_TOP_LEVEL_DATA,
  ...INSTRUMENT_LIST.flatMap(definition => REQUIRED_INSTRUMENT_FILES.map(
    name => `instruments/${definition.id}/${name}`,
  )),
];

export const PACKAGED_USAGE_GUIDE = '使用说明.md';

const SNAPSHOT_FILE_KEYS = {
  'edb_main_continuous_1m_raw.csv': 'bars1',
  'edb_main_continuous_5m.csv': 'bars5',
  'edb_main_continuous_60m.csv': 'bars60',
  'edb_main_continuous_rollovers.csv': 'rollovers',
  'edb_main_contract_mapping.csv': 'mainContractMappings',
};

const MINUTE_COLUMNS = [
  'datetime_nano',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'open_oi',
  'close_oi',
];
const BAR_COLUMNS = [
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
const ROLLOVER_COLUMNS = ['trading_date', 'time', 'from_contract', 'to_contract'];
const MAPPING_COLUMNS = ['trading_date', 'contract'];
const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_THREE_YEAR_TRADING_DAYS = 600;
const MAXIMUM_TRADING_DATE_GAP_DAYS = 14;
const SPECIAL_MARKET_SUSPENSION_MINUTES = new Set([
  '2022-12-06 10:00:00',
  '2022-12-06 10:01:00',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function splitCsvRow(line, label) {
  const values = [];
  let value = '';
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        value += character;
      }
    } else if (character === ',') {
      values.push(value);
      value = '';
      quoteClosed = false;
    } else if (character === '"' && !value && !quoteClosed) {
      quoted = true;
    } else if (character === '"' || quoteClosed) {
      throw new Error(`${label} CSV 引号格式无效`);
    } else {
      value += character;
    }
  }
  assert(!quoted, `${label} CSV 引号未闭合`);
  values.push(value);
  return values;
}

function csvTable(text, label, requiredColumns, options = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  assert(lines.length > 0, `${label} 缺少 CSV 表头`);
  const header = splitCsvRow(lines[0], `${label} 第1行`);
  assert(new Set(header).size === header.length, `${label} 表头存在重复列`);
  for (const column of requiredColumns) {
    assert(header.includes(column), `${label} 缺少列 ${column}`);
  }
  if (!options.allowEmpty) {
    assert(lines.length > 1, `${label} 没有数据记录`);
  }
  const indexes = Object.fromEntries(requiredColumns.map(column => [column, header.indexOf(column)]));
  const rows = lines.slice(1).map((line, index) => {
    const fields = splitCsvRow(line, `${label} 第${index + 2}行`);
    assert(fields.length === header.length, `${label} 第${index + 2}行列数与表头不一致`);
    return Object.fromEntries(requiredColumns.map(column => [column, fields[indexes[column]]]));
  });
  return rows;
}

function finiteNumber(value, label) {
  assert(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value), `${label} 必须为有限数值`);
  const parsed = Number(value);
  assert(Number.isFinite(parsed), `${label} 必须为有限数值`);
  return parsed;
}

function priceRow(row, label) {
  const open = finiteNumber(row.open, `${label} open`);
  const high = finiteNumber(row.high, `${label} high`);
  const low = finiteNumber(row.low, `${label} low`);
  const close = finiteNumber(row.close, `${label} close`);
  const volume = finiteNumber(row.volume, `${label} volume`);
  const openOi = finiteNumber(row.open_oi, `${label} open_oi`);
  const closeOi = finiteNumber(row.close_oi, `${label} close_oi`);
  assert(low <= high && open >= low && open <= high && close >= low && close <= high, `${label} OHLC 范围无效`);
  assert(volume >= 0 && openOi >= 0 && closeOi >= 0, `${label} 成交量或持仓量为负`);
  return { open, high, low, close, volume, openOi, closeOi };
}

function beijingTime(value, label) {
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value), `${label} 时间格式无效`);
  const parsed = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  assert(Number.isFinite(parsed), `${label} 时间无效`);
  return parsed;
}

function formatBeijing(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function validateMinuteCsv(text, label) {
  const rows = csvTable(text, label, MINUTE_COLUMNS);
  let previous;
  const records = rows.map((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d+$/.test(row.datetime_nano), `${rowLabel} datetime_nano 必须为非负整数`);
    const nanos = BigInt(row.datetime_nano);
    assert(nanos % 60_000_000_000n === 0n, `${rowLabel} datetime_nano 未对齐整分钟`);
    assert(previous === undefined || nanos > previous, `${rowLabel} 时间戳重复或未严格递增`);
    const values = priceRow(row, rowLabel);
    const startMs = Number(nanos / 1_000_000n);
    previous = nanos;
    return {
      datetimeNano: row.datetime_nano,
      start: formatBeijing(startMs),
      startMs,
      ...values,
    };
  });
  return {
    rows: rows.length,
    firstMinute: formatBeijing(Number(BigInt(rows[0].datetime_nano) / 1_000_000n)),
    lastMinute: formatBeijing(Number(BigInt(rows.at(-1).datetime_nano) / 1_000_000n)),
    records,
  };
}

export function validateBarCsv(text, label, period) {
  const rows = csvTable(text, label, BAR_COLUMNS);
  let previousEnd;
  const bars = rows.map((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    const startMs = beijingTime(row.bar_start, `${rowLabel} bar_start`);
    const endMs = beijingTime(row.bar_end, `${rowLabel} bar_end`);
    assert(endMs > startMs, `${rowLabel} 时间范围无效`);
    assert(previousEnd === undefined || startMs >= previousEnd, `${rowLabel} 时间重复、倒序或重叠`);
    assert(row.session === 'day' || row.session === 'night', `${rowLabel} session 无效`);
    const values = priceRow(row, rowLabel);
    const observed = finiteNumber(row.observed_minutes, `${rowLabel} observed_minutes`);
    const expected = finiteNumber(row.expected_minutes, `${rowLabel} expected_minutes`);
    assert(Number.isInteger(observed) && Number.isInteger(expected), `${rowLabel} 分钟数量必须为整数`);
    assert(observed > 0 && observed <= expected && expected > 0 && expected <= period, `${rowLabel} 分钟数量无效`);
    assert(row.complete === 'True' || row.complete === 'False', `${rowLabel} complete 无效`);
    assert((row.complete === 'True') === (observed === expected), `${rowLabel} complete 与分钟数量不一致`);
    assert(row.complete === 'True', `${rowLabel} 发布基线不得包含未完成 K 线`);
    previousEnd = endMs;
    return {
      start: row.bar_start,
      end: row.bar_end,
      startMs,
      endMs,
      session: row.session,
      observedMinutes: observed,
      expectedMinutes: expected,
      complete: true,
      ...values,
    };
  });
  return {
    rows: rows.length,
    firstStart: rows[0].bar_start,
    lastEnd: rows.at(-1).bar_end,
    bars,
  };
}

function validateContract(contract, definition, label) {
  assert(isConcreteContractCode(definition, contract), `${label} 合约代码无效`);
}

export function validateRolloverCsv(text, label, definition) {
  const rows = csvTable(text, label, ROLLOVER_COLUMNS, { allowEmpty: true });
  let previousDate = '';
  let previousTime;
  const records = rows.map((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date), `${rowLabel} trading_date 无效`);
    const time = beijingTime(row.time, `${rowLabel} time`);
    validateContract(row.from_contract, definition, `${rowLabel} from_contract`);
    validateContract(row.to_contract, definition, `${rowLabel} to_contract`);
    assert(row.from_contract !== row.to_contract, `${rowLabel} 新旧合约不得相同`);
    assert(row.trading_date > previousDate && (previousTime === undefined || time > previousTime), `${rowLabel} 换月记录未严格递增`);
    previousDate = row.trading_date;
    previousTime = time;
    return {
      tradingDate: row.trading_date,
      time: row.time,
      timeMs: time,
      fromContract: row.from_contract,
      toContract: row.to_contract,
    };
  });
  return { rows: rows.length, records };
}

export function validateMappingCsv(text, label, definition) {
  const rows = csvTable(text, label, MAPPING_COLUMNS);
  let previousDate = '';
  const records = rows.map((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date), `${rowLabel} trading_date 无效`);
    assert(row.trading_date > previousDate, `${rowLabel} 交易日重复或未严格递增`);
    validateContract(row.contract, definition, `${rowLabel} contract`);
    previousDate = row.trading_date;
    return {
      tradingDate: row.trading_date,
      contract: row.contract,
    };
  });
  return { rows: rows.length, records };
}

function equalNumber(left, right) {
  return Math.abs(left - right) <= 1e-9;
}

function dateStartMs(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
}

function sessionTotal(session) {
  return session.segments.reduce(
    (total, segment) => total + segment.endMinute - segment.startMinute,
    0,
  );
}

function tradingMinuteAt(milliseconds, schedule, label) {
  const text = formatBeijing(milliseconds);
  const wallMinute = Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16));
  for (const session of schedule) {
    let base = 0;
    const total = sessionTotal(session);
    for (let segmentIndex = 0; segmentIndex < session.segments.length; segmentIndex += 1) {
      const segment = session.segments[segmentIndex];
      if (wallMinute >= segment.startMinute && wallMinute < segment.endMinute) {
        return {
          date: text.slice(0, 10),
          session: session.id,
          segmentIndex,
          index: wallMinute - segment.startMinute + base,
          segmentIndexMinute: wallMinute - segment.startMinute,
          total,
          segmentStartMinute: segment.startMinute,
          segmentEndMinute: segment.endMinute,
        };
      }
      base += segment.endMinute - segment.startMinute;
    }
  }
  throw new Error(`${label} 不在品种交易时段内`);
}

function wallMinuteAt(sessionId, index, schedule, label) {
  const session = schedule.find(candidate => candidate.id === sessionId);
  assert(session && index >= 0 && index < sessionTotal(session), `${label} 交易分钟索引无效`);
  let remaining = index;
  for (const segment of session.segments) {
    const length = segment.endMinute - segment.startMinute;
    if (remaining < length) return segment.startMinute + remaining;
    remaining -= length;
  }
  throw new Error(`${label} 交易分钟索引无效`);
}

function expectedSessionMinutes(date, sessionId, startIndex, stopIndex, schedule, label) {
  let count = 0;
  for (let index = startIndex; index < stopIndex; index += 1) {
    const startMs = dateStartMs(date)
      + wallMinuteAt(sessionId, index, schedule, label) * 60_000;
    if (!SPECIAL_MARKET_SUSPENSION_MINUTES.has(formatBeijing(startMs))) count += 1;
  }
  return count;
}

function expectedWallMinutes(date, startMinute, stopMinute) {
  let count = 0;
  for (let minute = startMinute; minute < stopMinute; minute += 1) {
    const startMs = dateStartMs(date) + minute * 60_000;
    if (!SPECIAL_MARKET_SUSPENSION_MINUTES.has(formatBeijing(startMs))) count += 1;
  }
  return count;
}

function assertMinuteSchedule(records, definition) {
  for (const record of records) {
    tradingMinuteAt(record.startMs, definition.tradingSessions, `${definition.name} 1 分钟 ${record.start}`);
  }
}

function assertBarSchedule(bars, period, definition) {
  for (const bar of bars) {
    const label = `${definition.name} ${period} 分钟 ${bar.start}`;
    const minute = tradingMinuteAt(bar.startMs, definition.tradingSessions, label);
    let expectedStartMs;
    let expectedEndMs;
    let expectedMinutes;
    if (period === 5) {
      const bucket = Math.floor(minute.index / period);
      const startIndex = bucket * period;
      const stopIndex = Math.min(startIndex + period, minute.total);
      expectedStartMs = dateStartMs(minute.date)
        + wallMinuteAt(minute.session, startIndex, definition.tradingSessions, label) * 60_000;
      expectedEndMs = dateStartMs(minute.date)
        + (wallMinuteAt(minute.session, stopIndex - 1, definition.tradingSessions, label) + 1) * 60_000;
      expectedMinutes = expectedSessionMinutes(
        minute.date,
        minute.session,
        startIndex,
        stopIndex,
        definition.tradingSessions,
        label,
      );
    } else {
      const segmentLength = minute.segmentEndMinute - minute.segmentStartMinute;
      const bucket = Math.floor(minute.segmentIndexMinute / period);
      const startIndex = bucket * period;
      const stopIndex = Math.min(startIndex + period, segmentLength);
      expectedStartMs = dateStartMs(minute.date)
        + (minute.segmentStartMinute + startIndex) * 60_000;
      expectedEndMs = dateStartMs(minute.date)
        + (minute.segmentStartMinute + stopIndex) * 60_000;
      expectedMinutes = expectedWallMinutes(
        minute.date,
        minute.segmentStartMinute + startIndex,
        minute.segmentStartMinute + stopIndex,
      );
    }
    assert(
      bar.startMs === expectedStartMs
        && bar.endMs === expectedEndMs
        && bar.session === minute.session
        && bar.expectedMinutes === expectedMinutes
        && bar.observedMinutes === expectedMinutes,
      `${label} 时间桶、交易时段或分钟数量无效`,
    );
  }
}

export function aggregateFiveMinuteBars(bars5, definition) {
  const groups = new Map();
  for (const bar of bars5) {
    const minute = tradingMinuteAt(
      bar.startMs,
      definition.tradingSessions,
      `${definition.name} 5 分钟 ${bar.start}`,
    );
    const bucket = Math.floor(minute.segmentIndexMinute / 60);
    const key = [
      minute.date,
      minute.session,
      minute.segmentIndex,
      bucket,
    ].join('|');
    const group = groups.get(key) ?? { minute, bucket, bars: [] };
    group.bars.push(bar);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => {
    const segmentLength = group.minute.segmentEndMinute - group.minute.segmentStartMinute;
    const startIndex = group.bucket * 60;
    const stopIndex = Math.min(startIndex + 60, segmentLength);
    const expectedMinutes = expectedWallMinutes(
      group.minute.date,
      group.minute.segmentStartMinute + startIndex,
      group.minute.segmentStartMinute + stopIndex,
    );
    const expectedChildren = (stopIndex - startIndex) / 5;
    const startMs = dateStartMs(group.minute.date)
      + (group.minute.segmentStartMinute + startIndex) * 60_000;
    const endMs = dateStartMs(group.minute.date)
      + (group.minute.segmentStartMinute + stopIndex) * 60_000;
    const children = group.bars.sort((left, right) => left.startMs - right.startMs);
    assert(
      children.length === expectedChildren
        && children.every((bar, index) => (
          bar.startMs === startMs + index * 5 * 60_000
          && bar.endMs === startMs + (index + 1) * 5 * 60_000
        )),
      `${definition.name} 5 分钟历史在 ${formatBeijing(startMs)} 存在未解释的 60 分钟组成缺口`,
    );
    const observedMinutes = children.reduce(
      (sum, bar) => sum + bar.observedMinutes,
      0,
    );
    return {
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      startMs,
      endMs,
      session: group.minute.session,
      open: children[0].open,
      high: Math.max(...children.map(bar => bar.high)),
      low: Math.min(...children.map(bar => bar.low)),
      close: children.at(-1).close,
      volume: children.reduce((sum, bar) => sum + bar.volume, 0),
      openOi: children[0].openOi,
      closeOi: children.at(-1).closeOi,
      observedMinutes,
      expectedMinutes,
      complete: observedMinutes === expectedMinutes
        && children.every(bar => bar.complete),
    };
  }).sort((left, right) => left.startMs - right.startMs);
}

export function assertBarsEqual(actual, expected, definition) {
  assert(actual.length === expected.length, `${definition.name} 5/60 分钟时间桶数量不一致`);
  const fields = [
    'startMs',
    'endMs',
    'session',
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
  actual.forEach((bar, index) => {
    const rebuilt = expected[index];
    for (const field of fields) {
      const matches = typeof bar[field] === 'number'
        ? equalNumber(bar[field], rebuilt[field])
        : bar[field] === rebuilt[field];
      assert(matches, `${definition.name} 60 分钟 ${field} 对账不一致：${bar.start}`);
    }
  });
}

function assertMinuteOverlap(records, bars5, definition) {
  assertMinuteSchedule(records, definition);
  let minuteIndex = 0;
  for (const bar of bars5) {
    while (records[minuteIndex]?.startMs < bar.startMs) minuteIndex += 1;
    let stopIndex = minuteIndex;
    while (records[stopIndex]?.startMs < bar.endMs) stopIndex += 1;
    const minutes = records.slice(minuteIndex, stopIndex);
    const complete = minutes.length === 5
      && minutes.every((minute, index) => minute.startMs === bar.startMs + index * 60_000);
    if (complete) {
      const expected = {
        open: minutes[0].open,
        high: Math.max(...minutes.map(minute => minute.high)),
        low: Math.min(...minutes.map(minute => minute.low)),
        close: minutes.at(-1).close,
        volume: minutes.reduce((sum, minute) => sum + minute.volume, 0),
        openOi: minutes[0].openOi,
        closeOi: minutes.at(-1).closeOi,
      };
      for (const field of Object.keys(expected)) {
        assert(
          equalNumber(bar[field], expected[field]),
          `${definition.name} 1 分钟与 5 分钟 ${field} 对账不一致：${bar.start}`,
        );
      }
    }
    minuteIndex = stopIndex;
  }
}

function subtractBeijingCalendarYears(value, years) {
  const local = new Date(beijingTime(value, value) + 8 * 60 * 60 * 1000);
  const targetYear = local.getUTCFullYear() - years;
  const targetMonth = local.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatBeijing(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(local.getUTCDate(), lastDay),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ) - 8 * 60 * 60 * 1000,
  );
}

function assertThreeYearCoverage(definition, label, first, last) {
  const boundary = subtractBeijingCalendarYears(last, 3);
  assert(
    beijingTime(first, `${definition.name} ${label}首条时间`) <= beijingTime(boundary, `${definition.name} ${label}三年边界`),
    `${definition.name} ${label}覆盖不足三个自然年：实际 ${first} 至 ${last}，至少需要从 ${boundary} 开始`,
  );
  return boundary;
}

function calendarDayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  assert(match, `交易日格式无效：${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const milliseconds = Date.UTC(year, month - 1, day);
  const parsed = new Date(milliseconds);
  assert(
    parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day,
    `交易日格式无效：${date}`,
  );
  return milliseconds / CALENDAR_DAY_MS;
}

function subtractCalendarYearsFromDate(date, years) {
  const [year, month, day] = date.split('-').map(Number);
  const targetYear = year - years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return [
    targetYear,
    String(month).padStart(2, '0'),
    String(Math.min(day, lastDay)).padStart(2, '0'),
  ].join('-');
}

function firstMappingAfter(mappings, naturalDate) {
  let left = 0;
  let right = mappings.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (mappings[middle].tradingDate <= naturalDate) left = middle + 1;
    else right = middle;
  }
  return mappings[left];
}

export function assertContinuousBarCoverage(
  definition,
  bars5,
  bars60,
  mappings,
  options = {},
) {
  assert(
    bars5.length > 0 && bars60.length > 0 && mappings.length > 0,
    `${definition.name} 缺少连续覆盖校验所需的 5/60 分钟行情或主力映射`,
  );
  const mappingDates = new Set();
  mappings.forEach((mapping, index) => {
    calendarDayNumber(mapping.tradingDate);
    assert(
      index === 0 || mapping.tradingDate > mappings[index - 1].tradingDate,
      `${definition.name} 主力映射交易日必须严格递增`,
    );
    mappingDates.add(mapping.tradingDate);
  });

  const represented = new Map();
  const mapBars = (bars, period) => {
    for (const bar of bars) {
      const minute = tradingMinuteAt(
        bar.startMs,
        definition.tradingSessions,
        `${definition.name} ${period} 分钟 ${bar.start}`,
      );
      let tradingDate;
      if (minute.session === 'day') {
        tradingDate = minute.date;
        assert(
          mappingDates.has(tradingDate),
          `${definition.name} ${period} 分钟日盘 K 线无法映射到主力交易日：${bar.start}`,
        );
      } else {
        const mapping = firstMappingAfter(mappings, minute.date);
        assert(
          mapping,
          `${definition.name} ${period} 分钟夜盘 K 线之后缺少主力交易日：${bar.start}`,
        );
        tradingDate = mapping.tradingDate;
      }
      const entry = represented.get(tradingDate) ?? {
        dayObserved: false,
        nightNaturalDates: new Set(),
      };
      if (minute.session === 'day') entry.dayObserved = true;
      else entry.nightNaturalDates.add(minute.date);
      represented.set(tradingDate, entry);
    }
  };
  mapBars(bars5, 5);
  mapBars(bars60, 60);

  const representedDates = [...represented.keys()].sort();
  assert(representedDates.length > 0, `${definition.name} 没有可映射的交易日`);
  const firstRepresentedDate = representedDates[0];
  const lastRepresentedDate = representedDates.at(-1);
  const representedMappings = mappings.filter(mapping => (
    mapping.tradingDate >= firstRepresentedDate
      && mapping.tradingDate <= lastRepresentedDate
  ));
  assert(
    representedMappings.length > 0
      && representedMappings[0].tradingDate === firstRepresentedDate
      && representedMappings.at(-1).tradingDate === lastRepresentedDate,
    `${definition.name} 主力映射未覆盖完整行情交易日范围：${firstRepresentedDate} 至 ${lastRepresentedDate}`,
  );

  for (let index = 1; index < representedMappings.length; index += 1) {
    const previous = representedMappings[index - 1].tradingDate;
    const current = representedMappings[index].tradingDate;
    const gapDays = calendarDayNumber(current) - calendarDayNumber(previous);
    assert(
      gapDays <= MAXIMUM_TRADING_DATE_GAP_DAYS,
      `${definition.name} 主力映射交易日间隔超过 ${MAXIMUM_TRADING_DATE_GAP_DAYS} 天：${previous} -> ${current}`,
    );
  }

  if (options.requireThreeYearCoverage !== false) {
    const requiredStartDate = subtractCalendarYearsFromDate(lastRepresentedDate, 3);
    const requiredWindowMappings = representedMappings.filter(mapping => (
      mapping.tradingDate >= requiredStartDate
    ));
    assert(
      requiredWindowMappings.length >= MINIMUM_THREE_YEAR_TRADING_DAYS,
      `${definition.name} 最近三年主力映射交易日不足 ${MINIMUM_THREE_YEAR_TRADING_DAYS} 日：`
        + `${requiredStartDate} 至 ${lastRepresentedDate} 仅 ${requiredWindowMappings.length} 日`,
    );
  }

  const bars5ByStart = new Map(bars5.map(bar => [bar.startMs, bar]));
  const bars60ByStart = new Map(bars60.map(bar => [bar.startMs, bar]));
  const assertExpected = (
    barsByStart,
    period,
    tradingDate,
    naturalDate,
    session,
    startMinute,
  ) => {
    const startMs = dateStartMs(naturalDate) + startMinute * 60_000;
    const bar = barsByStart.get(startMs);
    const sessionLabel = session.id === 'day' ? '日盘' : '夜盘';
    assert(
      bar,
      `${definition.name} ${tradingDate} ${sessionLabel}缺少 ${period} 分钟 K 线：${formatBeijing(startMs)}`,
    );
    assert(
      bar.complete && bar.observedMinutes === bar.expectedMinutes,
      `${definition.name} ${tradingDate} ${sessionLabel}${period} 分钟 K 线不完整：${formatBeijing(startMs)}`,
    );
  };
  const assertSession = (tradingDate, naturalDate, session) => {
    for (const segment of session.segments) {
      for (let minute = segment.startMinute; minute < segment.endMinute; minute += 5) {
        assertExpected(bars5ByStart, 5, tradingDate, naturalDate, session, minute);
      }
      for (let minute = segment.startMinute; minute < segment.endMinute; minute += 60) {
        assertExpected(bars60ByStart, 60, tradingDate, naturalDate, session, minute);
      }
    }
  };

  for (const mapping of representedMappings) {
    const entry = represented.get(mapping.tradingDate) ?? {
      dayObserved: false,
      nightNaturalDates: new Set(),
    };
    const isTrailingNightOnlyTradingDate = mapping.tradingDate === lastRepresentedDate
      && !entry.dayObserved
      && entry.nightNaturalDates.size > 0;
    for (const session of definition.tradingSessions) {
      if (session.id === 'day') {
        if (!isTrailingNightOnlyTradingDate) {
          assertSession(mapping.tradingDate, mapping.tradingDate, session);
        }
        continue;
      }
      assert(
        entry.nightNaturalDates.size <= 1,
        `${definition.name} ${mapping.tradingDate} 夜盘映射到多个自然日：`
          + [...entry.nightNaturalDates].sort().join('、'),
      );
      for (const naturalDate of entry.nightNaturalDates) {
        assertSession(mapping.tradingDate, naturalDate, session);
      }
    }
  }
}

function validatePeriod(value, label, expected) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} 覆盖元数据无效`);
  beijingTime(value.first, `${label} first`);
  beijingTime(value.last, `${label} last`);
  assert(
    value.first === expected.first
      && value.last === expected.last
      && value.rows === expected.rows,
    `${label} 覆盖元数据与实际文件不一致`,
  );
}

function validateSourceSegments(metadata, definition, bars5) {
  const label = `${definition.name} metadata.json`;
  assert(Array.isArray(metadata.sourceSegments) && metadata.sourceSegments.length > 0, `${label} 缺少分段来源审计`);
  let earliest;
  let latest;
  for (const segment of metadata.sourceSegments) {
    assert(segment && typeof segment === 'object' && !Array.isArray(segment), `${label} 分段来源无效`);
    for (const field of ['sourceId', 'sourceName', 'importerVersion']) {
      assert(typeof segment[field] === 'string' && segment[field].trim(), `${label} 来源 ${field} 无效`);
    }
    assert(
      ['desktop-main', 'public-history', 'gap-fill', 'edb-tail', 'legacy-migration', 'test-fixture'].includes(segment.kind),
      `${label} 来源类型无效`,
    );
    if (segment.sourceVersion !== undefined) {
      assert(typeof segment.sourceVersion === 'string' && segment.sourceVersion.trim(), `${label} sourceVersion 无效`);
    }
    if (segment.acquiredAt !== undefined) {
      assert(Number.isFinite(Date.parse(segment.acquiredAt)), `${label} acquiredAt 无效`);
    }
    const firstMs = beijingTime(segment.coverage?.first, `${label} 来源首条时间`);
    const lastMs = beijingTime(segment.coverage?.last, `${label} 来源末条时间`);
    assert(firstMs <= lastMs, `${label} 来源覆盖范围无效`);
    earliest = earliest === undefined ? firstMs : Math.min(earliest, firstMs);
    latest = latest === undefined ? lastMs : Math.max(latest, lastMs);
    assert(Array.isArray(segment.rawFiles) && segment.rawFiles.length > 0, `${label} 来源原始文件审计无效`);
    for (const file of segment.rawFiles) {
      assert(
        typeof file?.name === 'string'
          && file.name.trim()
          && /^[a-f0-9]{64}$/.test(file.sha256)
          && Number.isSafeInteger(file.rows)
          && file.rows >= 0,
        `${label} 来源原始文件审计无效`,
      );
    }
    assert(segment.license && typeof segment.license === 'object', `${label} 来源授权结论无效`);
    assert(
      segment.license.redistributionAllowed === true,
      `${definition.name} 来源 ${segment.sourceName} 未确认允许随产品再分发`,
    );
    assert(
      typeof segment.license.conclusion === 'string' && segment.license.conclusion.trim(),
      `${label} 来源授权结论无效`,
    );
  }
  assert(
    earliest <= bars5[0].startMs && latest + 60_000 >= bars5.at(-1).endMs,
    `${label} 分段来源覆盖范围未覆盖完整 5 分钟基线`,
  );
  assert(
    metadata.redistribution?.allowed === true
      && typeof metadata.redistribution.conclusion === 'string'
      && metadata.redistribution.conclusion.trim(),
    `${definition.name} 顶层再分发结论不允许发布`,
  );
}

export function expectedRollovers(mappings, bars5, definition) {
  const result = [];
  for (let index = 1; index < mappings.length; index += 1) {
    const previous = mappings[index - 1];
    const current = mappings[index];
    if (previous.contract === current.contract) continue;
    const cutoff = beijingTime(`${previous.tradingDate} 15:00:00`, '前一交易日收盘');
    const first = bars5.find(bar => bar.startMs > cutoff);
    assert(first, `${definition.name} 换月 ${current.tradingDate} 缺少新主力首根 5 分钟 K 线`);
    assert(
      first.startMs <= beijingTime(`${current.tradingDate} 15:00:00`, '当前交易日收盘'),
      `${definition.name} 换月 ${current.tradingDate} 无法定位到对应交易日`,
    );
    result.push({
      tradingDate: current.tradingDate,
      time: first.start,
      timeMs: first.startMs,
      fromContract: previous.contract,
      toContract: current.contract,
    });
  }
  return result;
}

export function assertRollovers(actual, expected, definition) {
  assert(actual.length === expected.length, `${definition.name} 换月记录数量与主力映射不一致`);
  actual.forEach((rollover, index) => {
    assert(
      JSON.stringify(rollover) === JSON.stringify(expected[index]),
      `${definition.name} 换月记录与主力映射或首根 5 分钟 K 线不一致`,
    );
  });
}

function jsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} JSON 无法解析：${error.message}`);
  }
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须为 JSON 对象`);
  return value;
}

function validateEntryRules(text, label) {
  assert(text.trim().startsWith('# 每周突破回调入场规则'), `${label} 缺少规则标题`);
  for (const phrase of [
    '十五个主连品种',
    '主力换月',
    '1,000,000',
    '10倍理论名义杠杆',
    '不计手续费和滑点',
    '第一处实际出场',
  ]) {
    assert(text.includes(phrase), `${label} 缺少“${phrase}”说明`);
  }
  assert(
    text.includes('后台1分钟数据') || text.includes('后台 1 分钟数据'),
    `${label} 缺少后台 1 分钟说明`,
  );
  return { rows: undefined };
}

export function validateUsageGuide(text, label = PACKAGED_USAGE_GUIDE) {
  assert(text.trim().startsWith('# MoneyComing 多品种主连历史看盘'), `${label} 标题未更新`);
  for (const phrase of [
    '15 个主连品种',
    '1 分钟 K 线保存在后台',
    '主力换月：旧合约 -> 新合约',
    '1,000,000',
    '理论名义杠杆',
    '不计算手续费、滑点',
  ]) {
    assert(text.includes(phrase), `${label} 缺少“${phrase}”说明`);
  }
  return { rows: undefined };
}

export function validatePackagedData(name, text, definition) {
  switch (name) {
    case 'edb_main_continuous_1m_raw.csv':
      return validateMinuteCsv(text, name);
    case 'edb_main_continuous_5m.csv':
      return validateBarCsv(text, name, 5);
    case 'edb_main_continuous_60m.csv':
      return validateBarCsv(text, name, 60);
    case 'edb_main_continuous_rollovers.csv':
      assert(definition, `${name} 校验缺少品种定义`);
      return validateRolloverCsv(text, name, definition);
    case 'edb_main_contract_mapping.csv':
      assert(definition, `${name} 校验缺少品种定义`);
      return validateMappingCsv(text, name, definition);
    case 'metadata.json':
    case 'baseline-report.json':
    case 'baseline-validation-report.json':
      return jsonObject(text, name);
    case 'entry-rules.md':
      return validateEntryRules(text, name);
    default:
      throw new Error(`没有 data/${name} 的解析校验器`);
  }
}

function validateMetadata(metadata, definition, options = {}) {
  const label = `${definition.name} metadata.json`;
  const schemaSupported = metadata.schemaVersion === 5
    || (options.allowLegacySchema4 === true && metadata.schemaVersion === 4);
  assert(
    schemaSupported,
    `${label} schemaVersion 必须为 ${options.allowLegacySchema4 === true ? '4 或 5' : '5'}`,
  );
  assert(metadata.snapshotId === `builtin-${definition.id}`, `${label} snapshotId 与品种不一致`);
  assert(metadata.instrumentId === definition.id, `${label} instrumentId 与品种不一致`);
  assert(metadata.mainSymbol === definition.mainSymbol, `${label} mainSymbol 与注册表不一致`);
  assert(metadata.parameterVersion === definition.parameterVersion, `${label} parameterVersion 与注册表不一致`);
  if (metadata.schemaVersion === 4) {
    assert(
      metadata.source?.provider === 'EDB'
        && metadata.source.endpoint === 'https://edb.shinnytech.com/md/kline'
        && metadata.source.symbol === definition.mainSymbol,
      `${label} 数据源声明无效`,
    );
  } else {
    assert(
      ['EDB', 'MIXED'].includes(metadata.source?.provider)
        && metadata.source.symbol === definition.mainSymbol,
      `${label} 数据源声明无效`,
    );
    assert(
      metadata.source.endpoint === undefined
        || metadata.source.endpoint === 'https://edb.shinnytech.com/md/kline',
      `${label} 数据源端点无效`,
    );
  }
  assert(Number.isFinite(Date.parse(metadata.generatedAt)), `${label} generatedAt 无效`);
  for (const field of ['requestStart', 'requestEnd', 'sourceLatestAt']) {
    beijingTime(metadata[field], `${label} ${field}`);
  }
  assert(
    beijingTime(metadata.requestStart, `${label} requestStart`)
      <= beijingTime(metadata.requestEnd, `${label} requestEnd`),
    `${label} 请求时间范围无效`,
  );
  assert(
    metadata.files && typeof metadata.files === 'object' && !Array.isArray(metadata.files),
    `${label} files 无效`,
  );
  if (metadata.schemaVersion === 5) {
    assert(
      metadata.periods && typeof metadata.periods === 'object' && !Array.isArray(metadata.periods),
      `${label} periods 无效`,
    );
  }
}

function instrumentReportMap(report, label) {
  assert(report.schemaVersion === 1, `${label} schemaVersion 必须为 1`);
  assert(Array.isArray(report.instruments), `${label} instruments 必须为数组`);
  assert(report.instruments.length === INSTRUMENT_LIST.length, `${label} 必须包含 ${INSTRUMENT_LIST.length} 个品种`);
  const result = new Map();
  for (const item of report.instruments) {
    assert(item && typeof item === 'object' && !Array.isArray(item), `${label} 品种记录无效`);
    assert(typeof item.instrumentId === 'string', `${label} 品种记录缺少 instrumentId`);
    assert(!result.has(item.instrumentId), `${label} 重复品种 ${item.instrumentId}`);
    result.set(item.instrumentId, item);
  }
  for (const definition of INSTRUMENT_LIST) {
    assert(result.has(definition.id), `${label} 缺少品种 ${definition.name} (${definition.id})`);
  }
  return result;
}

async function readRequiredFile(path, label) {
  assert(await pathExists(path), `安装包数据缺少 ${label}`);
  const info = await stat(path);
  assert(info.isFile() && info.size > 0, `${label} 为空或不是文件`);
  return readFile(path);
}

function assertReportProvenance(report, metadata, definition, label) {
  assert(
    JSON.stringify(report.periods) === JSON.stringify(metadata.periods),
    `${definition.name} ${label} 的 periods 与 metadata 不一致`,
  );
  assert(
    JSON.stringify(report.sourceSegments) === JSON.stringify(metadata.sourceSegments),
    `${definition.name} ${label} 的 sourceSegments 与 metadata 不一致`,
  );
  assert(
    JSON.stringify(report.redistribution) === JSON.stringify(metadata.redistribution),
    `${definition.name} ${label} 的 redistribution 与 metadata 不一致`,
  );
}

export async function validatePackagedDataDirectory(dataDirectory, options = {}) {
  const expectedIds = INSTRUMENT_LIST.map(definition => definition.id).sort();
  const instrumentsDirectory = join(dataDirectory, 'instruments');
  assert(await pathExists(instrumentsDirectory), '安装包数据缺少 instruments 目录');
  const actualIds = (await readdir(instrumentsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert(
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `安装包品种目录不完整：期望 ${expectedIds.join(', ')}；实际 ${actualIds.join(', ') || '无'}`,
  );

  const entryRulesBuffer = await readRequiredFile(
    options.entryRulesPath ?? join(dataDirectory, 'entry-rules.md'),
    'data/entry-rules.md',
  );
  validatePackagedData('entry-rules.md', entryRulesBuffer.toString('utf8'));

  const baselineReport = validatePackagedData(
    'baseline-report.json',
    (await readRequiredFile(join(dataDirectory, 'baseline-report.json'), 'data/baseline-report.json')).toString('utf8'),
  );
  const validationReport = validatePackagedData(
    'baseline-validation-report.json',
    (await readRequiredFile(
      join(dataDirectory, 'baseline-validation-report.json'),
      'data/baseline-validation-report.json',
    )).toString('utf8'),
  );
  const baselineById = instrumentReportMap(baselineReport, 'baseline-report.json');
  const validationById = instrumentReportMap(validationReport, 'baseline-validation-report.json');

  const instruments = [];
  for (const definition of INSTRUMENT_LIST) {
    const directory = join(instrumentsDirectory, definition.id);
    const metadataBuffer = await readRequiredFile(
      join(directory, 'metadata.json'),
      `data/instruments/${definition.id}/metadata.json（${definition.name}）`,
    );
    const metadata = validatePackagedData('metadata.json', metadataBuffer.toString('utf8'), definition);
    validateMetadata(metadata, definition, options);

    const summaries = {};
    for (const name of REQUIRED_INSTRUMENT_FILES.filter(file => file !== 'metadata.json')) {
      const relativeName = `data/instruments/${definition.id}/${name}`;
      const buffer = await readRequiredFile(join(directory, name), `${relativeName}（${definition.name}）`);
      const key = SNAPSHOT_FILE_KEYS[name];
      const declared = metadata.files[key];
      assert(declared && typeof declared === 'object', `${definition.name} metadata 缺少 ${key}`);
      assert(declared.name === name, `${definition.name} metadata 的 ${key} 文件名不一致`);
      assert(
        Number.isSafeInteger(declared.rows)
          && declared.rows >= 0
          && (key === 'rollovers' || declared.rows > 0),
        `${definition.name} metadata 的 ${key} 行数无效`,
      );
      assert(/^[a-f0-9]{64}$/.test(declared.sha256), `${definition.name} metadata 的 ${key} 哈希无效`);
      const actualHash = createHash('sha256').update(buffer).digest('hex');
      assert(actualHash === declared.sha256, `${definition.name} ${name} SHA-256 与 metadata 不一致`);
      const summary = validatePackagedData(name, buffer.toString('utf8'), definition);
      assert(summary.rows === declared.rows, `${definition.name} ${name} 行数与 metadata 不一致`);
      summaries[key] = summary;
    }

    const minuteName = OPTIONAL_INSTRUMENT_FILES[0];
    const minutePath = join(directory, minuteName);
    const minuteDeclared = metadata.files.bars1;
    if (metadata.schemaVersion === 4) {
      assert(minuteDeclared !== undefined, `${definition.name} schema 4 metadata 缺少 bars1`);
    }
    if (minuteDeclared !== undefined) {
      assert(
        minuteDeclared
          && typeof minuteDeclared === 'object'
          && minuteDeclared.name === minuteName
          && Number.isSafeInteger(minuteDeclared.rows)
          && minuteDeclared.rows > 0
          && /^[a-f0-9]{64}$/.test(minuteDeclared.sha256),
        `${definition.name} metadata 的 bars1 无效`,
      );
      const minuteBuffer = await readRequiredFile(
        minutePath,
        `data/instruments/${definition.id}/${minuteName}（${definition.name}）`,
      );
      assert(
        createHash('sha256').update(minuteBuffer).digest('hex') === minuteDeclared.sha256,
        `${definition.name} ${minuteName} SHA-256 与 metadata 不一致`,
      );
      summaries.bars1 = validatePackagedData(
        minuteName,
        minuteBuffer.toString('utf8'),
        definition,
      );
      assert(
        summaries.bars1.rows === minuteDeclared.rows,
        `${definition.name} ${minuteName} 行数与 metadata 不一致`,
      );
    } else {
      assert(
        !await pathExists(minutePath),
        `${definition.name} 存在未在 metadata 声明的 ${minuteName}`,
      );
      summaries.bars1 = {
        rows: 0,
        firstMinute: undefined,
        lastMinute: undefined,
        records: [],
      };
    }

    let bars5Boundary;
    let bars60Boundary;
    if (metadata.schemaVersion === 5) {
      assertBarSchedule(summaries.bars5.bars, 5, definition);
      assertBarSchedule(summaries.bars60.bars, 60, definition);
      const rebuiltBars60 = aggregateFiveMinuteBars(summaries.bars5.bars, definition);
      assertBarsEqual(summaries.bars60.bars, rebuiltBars60, definition);
      assertMinuteOverlap(summaries.bars1.records, summaries.bars5.bars, definition);
      assertRollovers(
        summaries.rollovers.records,
        expectedRollovers(
          summaries.mainContractMappings.records,
          summaries.bars5.bars,
          definition,
        ),
        definition,
      );
      bars5Boundary = assertThreeYearCoverage(
        definition,
        '5 分钟',
        summaries.bars5.firstStart,
        summaries.bars5.lastEnd,
      );
      bars60Boundary = assertThreeYearCoverage(
        definition,
        '60 分钟',
        summaries.bars60.firstStart,
        summaries.bars60.lastEnd,
      );
      assertContinuousBarCoverage(
        definition,
        summaries.bars5.bars,
        summaries.bars60.bars,
        summaries.mainContractMappings.records,
      );
      validatePeriod(metadata.periods.bars5, `${definition.name} 5 分钟`, {
        first: summaries.bars5.firstStart,
        last: summaries.bars5.lastEnd,
        rows: summaries.bars5.rows,
      });
      validatePeriod(metadata.periods.bars60, `${definition.name} 60 分钟`, {
        first: summaries.bars60.firstStart,
        last: summaries.bars60.lastEnd,
        rows: summaries.bars60.rows,
      });
      if (summaries.bars1.rows > 0) {
        validatePeriod(metadata.periods.bars1, `${definition.name} 1 分钟`, {
          first: summaries.bars1.firstMinute,
          last: summaries.bars1.lastMinute,
          rows: summaries.bars1.rows,
        });
      } else {
        assert(metadata.periods.bars1 === undefined, `${definition.name} 不应声明空的 1 分钟覆盖`);
      }
      validateSourceSegments(metadata, definition, summaries.bars5.bars);
    }
    assert(
      summaries.bars5.lastEnd <= metadata.sourceLatestAt
        && summaries.bars60.lastEnd <= metadata.sourceLatestAt
        && (summaries.bars1.lastMinute === undefined
          || summaries.bars1.lastMinute <= metadata.sourceLatestAt),
      `${definition.name} 行情末端晚于 sourceLatestAt`,
    );
    if (metadata.schemaVersion === 4) {
      assert(
        summaries.bars5.firstStart >= summaries.bars1.firstMinute
          && summaries.bars60.firstStart >= summaries.bars1.firstMinute,
        `${definition.name} schema 4 的 1/5/60 分钟时间范围不一致`,
      );
    }

    const baseline = baselineById.get(definition.id);
    const validated = validationById.get(definition.id);
    assert(
      baseline.name === definition.name
        && baseline.mainSymbol === definition.mainSymbol
        && baseline.status === 'succeeded',
      `${definition.name} baseline-report.json 记录无效`,
    );
    assert(validated.name === definition.name, `${definition.name} baseline-validation-report.json 名称无效`);
    const checks = Object.values(validated.checks ?? {});
    assert(
      checks.length > 0 && checks.every(value => value === true),
      `${definition.name} baseline-validation-report.json 未通过全部校验`,
    );
    for (const [field, key] of [
      ['minuteRows', 'bars1'],
      ['fiveMinuteRows', 'bars5'],
      ['sixtyMinuteRows', 'bars60'],
      ['mappingRows', 'mainContractMappings'],
      ['rolloverRows', 'rollovers'],
    ]) {
      assert(baseline[field] === summaries[key].rows, `${definition.name} baseline-report.json 的 ${field} 不一致`);
      assert(validated[field] === summaries[key].rows, `${definition.name} baseline-validation-report.json 的 ${field} 不一致`);
    }
    assert(
      baseline.firstMinute === summaries.bars1.firstMinute
        && validated.firstMinute === summaries.bars1.firstMinute,
      `${definition.name} 首分钟时间与报告不一致`,
    );
    assert(
      baseline.lastMinute === summaries.bars1.lastMinute
        && validated.lastMinute === summaries.bars1.lastMinute,
      `${definition.name} 末分钟时间与报告不一致`,
    );
    assert(
      baseline.sourceLatestAt === metadata.sourceLatestAt
        && validated.sourceLatestAt === metadata.sourceLatestAt,
      `${definition.name} 数据源截止时间与报告不一致`,
    );
    if (metadata.schemaVersion === 5) {
      assert(
        validated.coverageBoundaries?.bars5 === bars5Boundary
          && validated.coverageBoundaries?.bars60 === bars60Boundary,
        `${definition.name} baseline-validation-report.json 的三年覆盖边界不一致`,
      );
      assertReportProvenance(baseline, metadata, definition, 'baseline-report.json');
      assertReportProvenance(
        validated,
        metadata,
        definition,
        'baseline-validation-report.json',
      );
    }
    instruments.push({
      instrumentId: definition.id,
      name: definition.name,
      sourceLatestAt: metadata.sourceLatestAt,
      rows: {
        minute: summaries.bars1.rows,
        fiveMinute: summaries.bars5.rows,
        sixtyMinute: summaries.bars60.rows,
      },
    });
  }

  return {
    valid: true,
    instrumentCount: instruments.length,
    instruments,
    requiredData: REQUIRED_DATA,
  };
}

function installerProductVersion(path) {
  if (process.platform !== 'win32') return undefined;
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:MONEYCOMING_INSTALLER).VersionInfo.ProductVersion'],
    { encoding: 'utf8', env: { ...process.env, MONEYCOMING_INSTALLER: path }, windowsHide: true },
  ).trim();
  return output || undefined;
}

export async function verifyRelease(directory = releaseDirectory()) {
  const manifest = await readPackageManifest();
  const files = await listFiles(directory);
  assert(files.length > 0, `发布目录不存在或为空：${directory}`);

  const zipFiles = files.filter(path => path.toLowerCase().endsWith('.zip'));
  assert(zipFiles.length === 0, `NSIS 发布目录不得包含 ZIP：${zipFiles.map(path => relative(directory, path)).join(', ')}`);

  const latestPath = join(directory, 'latest.yml');
  assert(await pathExists(latestPath), '发布目录缺少 latest.yml');
  const latest = await readYamlFile(latestPath);
  assert(latest.version === manifest.version, `latest.yml version ${latest.version} 与 package.json ${manifest.version} 不一致`);
  assert(Array.isArray(latest.files) && latest.files.length > 0, 'latest.yml 缺少 files 列表');

  const expectedInstaller = `MoneyComing-Setup-${manifest.version}-x64.exe`;
  const primaryName = assetName(latest.path || latest.files[0]?.url);
  assert(primaryName === expectedInstaller, `安装包命名不符合约定：${primaryName}`);
  const installerPath = join(directory, primaryName);
  assert(await pathExists(installerPath), `latest.yml 引用的安装包不存在：${primaryName}`);

  const metadataFile = latest.files.find(file => assetName(file.url) === primaryName);
  assert(metadataFile && typeof metadataFile.sha512 === 'string', `latest.yml 缺少 ${primaryName} 的 SHA-512`);
  const actualSha512 = await sha512Base64(installerPath);
  assert(actualSha512 === metadataFile.sha512, `${primaryName} SHA-512 与 latest.yml 不一致`);
  if (typeof latest.sha512 === 'string') {
    assert(actualSha512 === latest.sha512, 'latest.yml 顶层 SHA-512 与安装包不一致');
  }
  if (typeof metadataFile.size === 'number') {
    assert((await stat(installerPath)).size === metadataFile.size, `${primaryName} 文件大小与 latest.yml 不一致`);
  }

  const blockmapPath = `${installerPath}.blockmap`;
  assert(await pathExists(blockmapPath), `发布目录缺少 ${primaryName}.blockmap`);
  assert((await stat(blockmapPath)).size > 0, `${primaryName}.blockmap 为空`);

  const unpacked = join(directory, 'win-unpacked');
  const asarPath = join(unpacked, 'resources', 'app.asar');
  assert(await pathExists(asarPath), '缺少 win-unpacked/resources/app.asar，无法验收打包版本');
  const packagedManifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  assert(packagedManifest.version === manifest.version, `app.asar version ${packagedManifest.version} 与 package.json 不一致`);

  const appUpdatePath = join(unpacked, 'resources', 'app-update.yml');
  assert(await pathExists(appUpdatePath), '打包应用缺少 app-update.yml');
  const appUpdate = await readYamlFile(appUpdatePath);
  assert(appUpdate.provider === 'github', `app-update.yml provider 必须为 github，收到 ${appUpdate.provider}`);
  assert(appUpdate.owner === 'yxsimony-dot' && appUpdate.repo === 'MoneyComingExe', 'app-update.yml GitHub owner/repo 配置不正确');

  const packagedUsageGuide = await readRequiredFile(
    join(unpacked, PACKAGED_USAGE_GUIDE),
    PACKAGED_USAGE_GUIDE,
  );
  const sourceUsageGuide = await readRequiredFile(
    join('docs', PACKAGED_USAGE_GUIDE),
    `docs/${PACKAGED_USAGE_GUIDE}`,
  );
  validateUsageGuide(packagedUsageGuide.toString('utf8'));
  assert(
    createHash('sha256').update(packagedUsageGuide).digest('hex')
      === createHash('sha256').update(sourceUsageGuide).digest('hex'),
    `安装包根目录 ${PACKAGED_USAGE_GUIDE} 与 docs/${PACKAGED_USAGE_GUIDE} 不一致`,
  );

  const packagedData = await validatePackagedDataDirectory(join(unpacked, 'data'));
  const productVersion = installerProductVersion(installerPath);
  if (productVersion) {
    assert(productVersion === manifest.version || productVersion.startsWith(`${manifest.version}.`), `安装包 ProductVersion ${productVersion} 与 ${manifest.version} 不一致`);
  }

  const result = {
    valid: true,
    version: manifest.version,
    installer: primaryName,
    installerProductVersion: productVersion,
    sha512: actualSha512,
    blockmap: `${primaryName}.blockmap`,
    instrumentCount: packagedData.instrumentCount,
    usageGuide: PACKAGED_USAGE_GUIDE,
    requiredData: REQUIRED_DATA,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyRelease().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
