// src/main/online-tail-performance-cli.ts
import assert from "node:assert/strict";
import { createHash as createHash2 } from "node:crypto";
import {
  mkdir as mkdir2,
  mkdtemp,
  readFile as readFile3,
  readdir as readdir2,
  rm as rm2,
  stat as stat3,
  writeFile as writeFile2
} from "node:fs/promises";
import {
  arch,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem
} from "node:os";
import { join as join3, resolve } from "node:path";
import { performance as performance2 } from "node:perf_hooks";

// src/shared/instruments.ts
var INSTRUMENT_IDS = [
  "main_continuous",
  "rapeseed_meal_main",
  "pvc_main",
  "rebar_main",
  "glass_main",
  "rapeseed_oil_main",
  "palm_oil_main",
  "soybean_oil_main",
  "pulp_main",
  "corn_main",
  "soda_ash_main",
  "soybean_1_main",
  "methanol_main",
  "sugar_main",
  "soybean_2_main"
];
var STANDARD_TRADING_SESSIONS = [
  {
    id: "day",
    segments: [
      { startMinute: 9 * 60, endMinute: 10 * 60 + 15 },
      { startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 },
      { startMinute: 13 * 60 + 30, endMinute: 15 * 60 }
    ]
  },
  {
    id: "night",
    segments: [
      { startMinute: 21 * 60, endMinute: 23 * 60 }
    ]
  }
];
var ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
var ODD_MONTHS = [1, 3, 5, 7, 9, 11];
var DCE_MEAL_AND_SOYBEAN_OIL_MONTHS = [1, 3, 5, 7, 8, 9, 11, 12];
var RAPESEED_MEAL_MONTHS = [1, 3, 5, 7, 8, 9, 11];
function defineInstrument(definition) {
  return {
    ...definition,
    contractSymbolPrefix: `${definition.exchange}.`,
    parameterVersion: 1,
    tradingSessions: STANDARD_TRADING_SESSIONS
  };
}
var INSTRUMENT_DEFINITIONS = {
  main_continuous: defineInstrument({
    id: "main_continuous",
    name: "\u8C46\u7C95\u4E3B\u8FDE",
    shortName: "\u8C46\u7C95",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "m",
    mainSymbol: "KQ.m@DCE.m",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  rapeseed_meal_main: defineInstrument({
    id: "rapeseed_meal_main",
    name: "\u83DC\u7C95\u4E3B\u8FDE",
    shortName: "\u83DC\u7C95",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "RM",
    mainSymbol: "KQ.m@CZCE.RM",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: RAPESEED_MEAL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  pvc_main: defineInstrument({
    id: "pvc_main",
    name: "PVC\u4E3B\u8FDE",
    shortName: "PVC",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "v",
    mainSymbol: "KQ.m@DCE.v",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 5
  }),
  rebar_main: defineInstrument({
    id: "rebar_main",
    name: "\u87BA\u7EB9\u94A2\u4E3B\u8FDE",
    shortName: "\u87BA\u7EB9\u94A2",
    exchange: "SHFE",
    exchangeName: "\u4E0A\u671F\u6240",
    productCode: "rb",
    mainSymbol: "KQ.m@SHFE.rb",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  glass_main: defineInstrument({
    id: "glass_main",
    name: "\u73BB\u7483\u4E3B\u8FDE",
    shortName: "\u73BB\u7483",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "FG",
    mainSymbol: "KQ.m@CZCE.FG",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 20
  }),
  rapeseed_oil_main: defineInstrument({
    id: "rapeseed_oil_main",
    name: "\u83DC\u6CB9\u4E3B\u8FDE",
    shortName: "\u83DC\u6CB9",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "OI",
    mainSymbol: "KQ.m@CZCE.OI",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  palm_oil_main: defineInstrument({
    id: "palm_oil_main",
    name: "\u68D5\u6988\u6CB9\u4E3B\u8FDE",
    shortName: "\u68D5\u6988\u6CB9",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "p",
    mainSymbol: "KQ.m@DCE.p",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  soybean_oil_main: defineInstrument({
    id: "soybean_oil_main",
    name: "\u8C46\u6CB9\u4E3B\u8FDE",
    shortName: "\u8C46\u6CB9",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "y",
    mainSymbol: "KQ.m@DCE.y",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  pulp_main: defineInstrument({
    id: "pulp_main",
    name: "\u7EB8\u6D46\u4E3B\u8FDE",
    shortName: "\u7EB8\u6D46",
    exchange: "SHFE",
    exchangeName: "\u4E0A\u671F\u6240",
    productCode: "sp",
    mainSymbol: "KQ.m@SHFE.sp",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  corn_main: defineInstrument({
    id: "corn_main",
    name: "\u7389\u7C73\u4E3B\u8FDE",
    shortName: "\u7389\u7C73",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "c",
    mainSymbol: "KQ.m@DCE.c",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  soda_ash_main: defineInstrument({
    id: "soda_ash_main",
    name: "\u7EAF\u78B1\u4E3B\u8FDE",
    shortName: "\u7EAF\u78B1",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "SA",
    mainSymbol: "KQ.m@CZCE.SA",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 20
  }),
  soybean_1_main: defineInstrument({
    id: "soybean_1_main",
    name: "\u8C46\u4E00\u4E3B\u8FDE",
    shortName: "\u8C46\u4E00",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "a",
    mainSymbol: "KQ.m@DCE.a",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  methanol_main: defineInstrument({
    id: "methanol_main",
    name: "\u7532\u9187\u4E3B\u8FDE",
    shortName: "\u7532\u9187",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "MA",
    mainSymbol: "KQ.m@CZCE.MA",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  sugar_main: defineInstrument({
    id: "sugar_main",
    name: "\u767D\u7CD6\u4E3B\u8FDE",
    shortName: "\u767D\u7CD6",
    exchange: "CZCE",
    exchangeName: "\u90D1\u5546\u6240",
    productCode: "SR",
    mainSymbol: "KQ.m@CZCE.SR",
    contractCode: {
      expiryDigits: 3,
      productCase: "upper",
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  }),
  soybean_2_main: defineInstrument({
    id: "soybean_2_main",
    name: "\u8C46\u4E8C\u4E3B\u8FDE",
    shortName: "\u8C46\u4E8C",
    exchange: "DCE",
    exchangeName: "\u5927\u5546\u6240",
    productCode: "b",
    mainSymbol: "KQ.m@DCE.b",
    contractCode: {
      expiryDigits: 4,
      productCase: "lower",
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10
  })
};
var DEFAULT_INSTRUMENT = INSTRUMENT_DEFINITIONS.main_continuous;
var INSTRUMENT_LIST = INSTRUMENT_IDS.map((id) => INSTRUMENT_DEFINITIONS[id]);
function isInstrument(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INSTRUMENT_DEFINITIONS, value);
}
function instrumentDefinition(instrument) {
  return INSTRUMENT_DEFINITIONS[instrument];
}
function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isConcreteContractCode(definition, contract) {
  const expiryLength = definition.contractCode.expiryDigits;
  const match = new RegExp(
    `^${escapedRegExp(definition.productCode)}(\\d{${expiryLength}})$`
  ).exec(contract);
  if (!match) return false;
  const month = Number(match[1].slice(-2));
  return definition.contractCode.candidateMonths.includes(month);
}

// src/domain/time.ts
var BEIJING_OFFSET = 8 * 60 * 60 * 1e3;
function parseBeijing(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\+08:00)?$/.exec(text);
  if (!match) throw new Error(`\u65E0\u6548\u5317\u4EAC\u65F6\u95F4\uFF1A${text}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`\u65E0\u6548\u5317\u4EAC\u65F6\u95F4\uFF1A${text}`);
  }
  return date.getTime() - BEIJING_OFFSET;
}
function formatBeijing(ms) {
  const date = new Date(ms + BEIJING_OFFSET);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) throw new Error("\u65E0\u6548\u65F6\u95F4\u6233");
  return date.toISOString().slice(0, 19).replace("T", " ");
}
function lowerBoundStart(bars, ms) {
  let left = 0;
  let right = bars.length;
  while (left < right) {
    const middle = left + right >>> 1;
    if (bars[middle].startMs < ms) left = middle + 1;
    else right = middle;
  }
  return left;
}

// src/domain/market-data.ts
var MINUTE_MS = 6e4;
var NANO_PER_MINUTE = 60000000000n;
var REQUIRED_COLUMNS = [
  "datetime_nano",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "open_oi",
  "close_oi"
];
function splitCsvRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index++) {
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
    } else if (character === ",") {
      values.push(value);
      value = "";
      quoteClosed = false;
    } else if (character === '"' && !value && !quoteClosed) {
      quoted = true;
    } else if (character === '"' || quoteClosed) {
      throw new Error("CSV \u5F15\u53F7\u683C\u5F0F\u65E0\u6548");
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("CSV \u5F15\u53F7\u672A\u95ED\u5408");
  values.push(value);
  return values;
}
function finiteNumber(value, field) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error(`${field} \u5FC5\u987B\u4E3A\u975E\u7A7A\u6709\u9650\u6570\u503C`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} \u5FC5\u987B\u4E3A\u975E\u7A7A\u6709\u9650\u6570\u503C`);
  return parsed;
}
function sessionTotal(session) {
  return session.segments.reduce(
    (total, segment) => total + segment.endMinute - segment.startMinute,
    0
  );
}
function assertTradingSchedule(schedule) {
  const sessionIds = /* @__PURE__ */ new Set();
  for (const session of schedule) {
    if (sessionIds.has(session.id) || !session.segments.length) {
      throw new Error("\u4EA4\u6613\u65F6\u6BB5\u914D\u7F6E\u65E0\u6548");
    }
    sessionIds.add(session.id);
    let previousEnd = -1;
    for (const segment of session.segments) {
      if (!Number.isInteger(segment.startMinute) || !Number.isInteger(segment.endMinute) || segment.startMinute < 0 || segment.endMinute > 24 * 60 || segment.startMinute >= segment.endMinute || segment.startMinute < previousEnd) {
        throw new Error("\u4EA4\u6613\u65F6\u6BB5\u914D\u7F6E\u65E0\u6548");
      }
      previousEnd = segment.endMinute;
    }
  }
}
function tradingMinuteAt(ms, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  assertTradingSchedule(schedule);
  const text = formatBeijing(ms);
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (second !== 0 || ms % MINUTE_MS !== 0) throw new Error(`\u975E\u6574\u5206\u949F\u65F6\u95F4\uFF1A${text}`);
  const wallMinute2 = hour * 60 + minute;
  for (const session of schedule) {
    let base = 0;
    const total = sessionTotal(session);
    for (const segment of session.segments) {
      if (wallMinute2 >= segment.startMinute && wallMinute2 < segment.endMinute) {
        return {
          session: session.id,
          index: wallMinute2 - segment.startMinute + base,
          total,
          date: text.slice(0, 10)
        };
      }
      base += segment.endMinute - segment.startMinute;
    }
  }
  throw new Error(`\u975E\u4EA4\u6613\u5206\u949F\uFF1A${text}`);
}
function tradingSegmentMinuteAt(ms, schedule) {
  assertTradingSchedule(schedule);
  const text = formatBeijing(ms);
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (second !== 0 || ms % MINUTE_MS !== 0) throw new Error(`\u975E\u6574\u5206\u949F\u65F6\u95F4\uFF1A${text}`);
  const wallMinuteValue = hour * 60 + minute;
  for (const session of schedule) {
    for (let segmentIndex = 0; segmentIndex < session.segments.length; segmentIndex += 1) {
      const segment = session.segments[segmentIndex];
      if (wallMinuteValue >= segment.startMinute && wallMinuteValue < segment.endMinute) {
        return {
          session: session.id,
          segmentIndex,
          index: wallMinuteValue - segment.startMinute,
          total: segment.endMinute - segment.startMinute,
          startMinute: segment.startMinute,
          endMinute: segment.endMinute,
          date: text.slice(0, 10)
        };
      }
    }
  }
  throw new Error(`\u975E\u4EA4\u6613\u5206\u949F\uFF1A${text}`);
}
function wallMinute(sessionId, index, schedule) {
  const session = schedule.find((candidate) => candidate.id === sessionId);
  if (!session || index < 0 || index >= sessionTotal(session)) {
    throw new Error("\u4EA4\u6613\u5206\u949F\u7D22\u5F15\u8D85\u51FA\u4EA4\u6613\u65F6\u6BB5");
  }
  let remaining = index;
  for (const segment of session.segments) {
    const length = segment.endMinute - segment.startMinute;
    if (remaining < length) return segment.startMinute + remaining;
    remaining -= length;
  }
  throw new Error("\u4EA4\u6613\u5206\u949F\u7D22\u5F15\u8D85\u51FA\u4EA4\u6613\u65F6\u6BB5");
}
function dateStartUtcMs(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 60 * MINUTE_MS;
}
function parseEdbMinuteCsv(text, label = "EDB \u54CD\u5E94", schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  const fail = (line, reason) => {
    throw new Error(`${label} \u7B2C${line}\u884C\uFF1A${reason}`);
  };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) fail(1, "\u54CD\u5E94\u4E3A\u7A7A");
  let header;
  try {
    header = splitCsvRow(lines[0]);
  } catch (error) {
    return fail(1, error.message);
  }
  if (new Set(header).size !== header.length) fail(1, "\u5B58\u5728\u91CD\u590D\u5217");
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) fail(1, `\u7F3A\u5C11\u5217 ${column}`);
  }
  if (lines.length === 1) return [];
  const indexes = Object.fromEntries(
    REQUIRED_COLUMNS.map((column) => [column, header.indexOf(column)])
  );
  const records = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitCsvRow(lines[index]);
      if (fields.length !== header.length) throw new Error("\u5217\u6570\u4E0E\u8868\u5934\u4E0D\u4E00\u81F4");
      const field = (name) => fields[indexes[name]];
      const datetimeNano = field("datetime_nano");
      if (!/^\d+$/.test(datetimeNano)) throw new Error("datetime_nano \u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570");
      const nanos = BigInt(datetimeNano);
      if (nanos % NANO_PER_MINUTE !== 0n) throw new Error("datetime_nano \u5FC5\u987B\u5BF9\u9F50\u5230\u6574\u5206\u949F");
      const startMs = Number(nanos / 1000000n);
      if (!Number.isSafeInteger(startMs)) throw new Error("datetime_nano \u8D85\u51FA\u53EF\u652F\u6301\u8303\u56F4");
      tradingMinuteAt(startMs, schedule);
      const open = finiteNumber(field("open"), "open");
      const high = finiteNumber(field("high"), "high");
      const low = finiteNumber(field("low"), "low");
      const close = finiteNumber(field("close"), "close");
      if (low > high || open < low || open > high || close < low || close > high) {
        throw new Error("\u4EF7\u683C\u8303\u56F4\u9519\u8BEF\uFF1A\u5F00\u6536\u76D8\u5FC5\u987B\u5904\u4E8E\u6700\u4F4E\u4E0E\u6700\u9AD8\u4E4B\u95F4");
      }
      const volume = finiteNumber(field("volume"), "volume");
      const openOi = finiteNumber(field("open_oi"), "open_oi");
      const closeOi = finiteNumber(field("close_oi"), "close_oi");
      if (volume < 0) throw new Error("volume \u4E0D\u5F97\u4E3A\u8D1F\u6570");
      if (openOi < 0 || closeOi < 0) throw new Error("open_oi / close_oi \u4E0D\u5F97\u4E3A\u8D1F\u6570");
      const previous = records.at(-1);
      if (previous && startMs <= previous.startMs) throw new Error("\u65F6\u95F4\u6233\u91CD\u590D\u6216\u672A\u4E25\u683C\u9012\u589E");
      records.push({
        datetimeNano,
        startMs,
        start: formatBeijing(startMs),
        open,
        high,
        low,
        close,
        volume,
        openOi,
        closeOi
      });
    } catch (error) {
      fail(index + 1, error.message);
    }
  }
  return records;
}
function aggregateMinutes(records, period, coverageEndMs = records.length ? records.at(-1).startMs + MINUTE_MS : Number.NEGATIVE_INFINITY, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  const groups = /* @__PURE__ */ new Map();
  for (const record of records) {
    const minute = tradingMinuteAt(record.startMs, schedule);
    const bucket = Math.floor(minute.index / period);
    const key = `${minute.date}|${minute.session}|${bucket}`;
    const group = groups.get(key) ?? { minute, bucket, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const bars = [];
  for (const group of groups.values()) {
    const startIndex = group.bucket * period;
    const stopIndex = Math.min(startIndex + period, group.minute.total);
    const dayStart = dateStartUtcMs(group.minute.date);
    const startMs = dayStart + wallMinute(group.minute.session, startIndex, schedule) * MINUTE_MS;
    const endMs = dayStart + (wallMinute(group.minute.session, stopIndex - 1, schedule) + 1) * MINUTE_MS;
    if (endMs > coverageEndMs) continue;
    const part = group.records.sort((left, right) => left.startMs - right.startMs);
    bars.push({
      startMs,
      endMs,
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      open: part[0].open,
      high: Math.max(...part.map((record) => record.high)),
      low: Math.min(...part.map((record) => record.low)),
      close: part.at(-1).close,
      volume: part.reduce((sum, record) => sum + record.volume, 0),
      openOi: part[0].openOi,
      closeOi: part.at(-1).closeOi,
      session: group.minute.session,
      observedMinutes: part.length,
      expectedMinutes: stopIndex - startIndex,
      complete: part.length === stopIndex - startIndex
    });
  }
  return bars.sort((left, right) => left.startMs - right.startMs);
}
function aggregateFiveMinuteBars(bars5, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  assertBarsValid(bars5, 5, schedule);
  const groups = /* @__PURE__ */ new Map();
  for (const bar of bars5) {
    const minute = tradingSegmentMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / 60);
    const startIndex = bucket * 60;
    const stopIndex = Math.min(startIndex + 60, minute.total);
    const segmentEndMs = dateStartUtcMs(minute.date) + minute.endMinute * MINUTE_MS;
    if (bar.session !== minute.session || bar.startMs + 5 * MINUTE_MS !== bar.endMs || bar.endMs > segmentEndMs || minute.index % 5 !== 0 || (stopIndex - startIndex) % 5 !== 0) {
      throw new Error(`5 \u5206\u949F\u884C\u60C5\u4E0D\u80FD\u6309\u4EA4\u6613\u5206\u6BB5\u805A\u5408\uFF1A${bar.start}`);
    }
    const key = `${minute.date}|${minute.session}|${minute.segmentIndex}|${bucket}`;
    const group = groups.get(key) ?? { minute, bucket, bars: [] };
    group.bars.push(bar);
    groups.set(key, group);
  }
  const bars60 = [];
  for (const group of groups.values()) {
    const startIndex = group.bucket * 60;
    const stopIndex = Math.min(startIndex + 60, group.minute.total);
    const expectedMinutes = stopIndex - startIndex;
    const dayStart = dateStartUtcMs(group.minute.date);
    const startMs = dayStart + (group.minute.startMinute + startIndex) * MINUTE_MS;
    const endMs = dayStart + (group.minute.startMinute + stopIndex) * MINUTE_MS;
    const children = group.bars.sort((left, right) => left.startMs - right.startMs);
    const expectedChildren = expectedMinutes / 5;
    const contiguous = children.length === expectedChildren && children.every((bar, index) => bar.startMs === startMs + index * 5 * MINUTE_MS && bar.endMs === startMs + (index + 1) * 5 * MINUTE_MS);
    const observedMinutes = children.reduce((sum, bar) => sum + bar.observedMinutes, 0);
    bars60.push({
      startMs,
      endMs,
      start: formatBeijing(startMs),
      end: formatBeijing(endMs),
      open: children[0].open,
      high: Math.max(...children.map((bar) => bar.high)),
      low: Math.min(...children.map((bar) => bar.low)),
      close: children.at(-1).close,
      volume: children.reduce((sum, bar) => sum + bar.volume, 0),
      openOi: children[0].openOi,
      closeOi: children.at(-1).closeOi,
      session: group.minute.session,
      observedMinutes,
      expectedMinutes,
      complete: contiguous && observedMinutes === expectedMinutes && children.every((bar) => bar.complete)
    });
  }
  return bars60.sort((left, right) => left.startMs - right.startMs);
}
function equalNumber(left, right) {
  return Math.abs(left - right) <= 1e-9;
}
function sameMinuteRecord(left, right) {
  return left.datetimeNano === right.datetimeNano && left.startMs === right.startMs && left.start === right.start && equalNumber(left.open, right.open) && equalNumber(left.high, right.high) && equalNumber(left.low, right.low) && equalNumber(left.close, right.close) && equalNumber(left.volume, right.volume) && equalNumber(left.openOi, right.openOi) && equalNumber(left.closeOi, right.closeOi);
}
function assertMinuteRecordsValid(records, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    if (previous && record.startMs <= previous.startMs) {
      throw new Error("1 \u5206\u949F\u884C\u60C5\u5B58\u5728\u91CD\u590D\u6216\u672A\u4E25\u683C\u9012\u589E\u8BB0\u5F55");
    }
    if (!/^\d+$/.test(record.datetimeNano) || BigInt(record.datetimeNano) !== BigInt(record.startMs) * 1000000n || record.start !== formatBeijing(record.startMs)) {
      throw new Error(`1 \u5206\u949F\u884C\u60C5\u65F6\u95F4\u5B57\u6BB5\u4E0D\u4E00\u81F4\uFF1A${record.start}`);
    }
    tradingMinuteAt(record.startMs, schedule);
    if (![record.open, record.high, record.low, record.close, record.volume, record.openOi, record.closeOi].every(Number.isFinite)) {
      throw new Error(`1 \u5206\u949F\u884C\u60C5\u5B58\u5728\u975E\u6709\u9650\u6570\u503C\uFF1A${record.start}`);
    }
    if (record.low > record.high || record.open < record.low || record.open > record.high || record.close < record.low || record.close > record.high) {
      throw new Error(`1 \u5206\u949F\u884C\u60C5 OHLC \u8303\u56F4\u65E0\u6548\uFF1A${record.start}`);
    }
    if (record.volume < 0 || record.openOi < 0 || record.closeOi < 0) {
      throw new Error(`1 \u5206\u949F\u884C\u60C5\u6210\u4EA4\u91CF\u6216\u6301\u4ED3\u91CF\u4E3A\u8D1F\uFF1A${record.start}`);
    }
  }
}
function mergeMinuteHistory(local, remote) {
  assertMinuteRecordsValid(local);
  assertMinuteRecordsValid(remote);
  const recordsByStart = new Map(local.map((record) => [record.startMs, record]));
  let added = 0;
  let replaced = 0;
  for (const record of remote) {
    const existing = recordsByStart.get(record.startMs);
    if (!existing) added += 1;
    else if (!sameMinuteRecord(existing, record)) replaced += 1;
    recordsByStart.set(record.startMs, record);
  }
  const records = [...recordsByStart.values()].sort((left, right) => left.startMs - right.startMs);
  assertMinuteRecordsValid(records);
  return { records, added, replaced, removed: 0 };
}
function assertBarsValid(bars, period, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (previous && (bar.startMs <= previous.startMs || bar.startMs < previous.endMs)) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5\u5B58\u5728\u91CD\u590D\u3001\u5012\u5E8F\u6216\u91CD\u53E0\u8BB0\u5F55`);
    }
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.openOi, bar.closeOi].every(Number.isFinite)) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5\u5B58\u5728\u975E\u6709\u9650\u6570\u503C`);
    }
    if (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high || bar.close < bar.low || bar.close > bar.high) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5 OHLC \u8303\u56F4\u65E0\u6548`);
    }
    if (bar.volume < 0 || bar.openOi < 0 || bar.closeOi < 0) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5\u6210\u4EA4\u91CF\u6216\u6301\u4ED3\u91CF\u4E3A\u8D1F`);
    }
    const minute = tradingMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / period);
    const expectedStartIndex = bucket * period;
    const expectedStopIndex = Math.min(expectedStartIndex + period, minute.total);
    const dayStart = dateStartUtcMs(minute.date);
    const expectedStartMs = dayStart + wallMinute(minute.session, expectedStartIndex, schedule) * MINUTE_MS;
    const expectedEndMs = dayStart + (wallMinute(minute.session, expectedStopIndex - 1, schedule) + 1) * MINUTE_MS;
    if (bar.startMs !== expectedStartMs || bar.endMs !== expectedEndMs || bar.session !== minute.session) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5\u65F6\u95F4\u6876\u6216\u4EA4\u6613\u65F6\u6BB5\u65E0\u6548\uFF1A${bar.start}`);
    }
    if (bar.expectedMinutes !== expectedStopIndex - expectedStartIndex || !Number.isInteger(bar.observedMinutes) || bar.observedMinutes < 0 || bar.observedMinutes > bar.expectedMinutes || bar.complete !== (bar.observedMinutes === bar.expectedMinutes)) {
      throw new Error(`${period} \u5206\u949F\u884C\u60C5\u5B8C\u6574\u6027\u5B57\u6BB5\u65E0\u6548\uFF1A${bar.start}`);
    }
  }
}
function assertSegmentedSixtyMinuteBarsValid(bars, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (previous && (bar.startMs <= previous.startMs || bar.startMs < previous.endMs)) {
      throw new Error("60 \u5206\u949F\u884C\u60C5\u5B58\u5728\u91CD\u590D\u3001\u5012\u5E8F\u6216\u91CD\u53E0\u8BB0\u5F55");
    }
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.openOi, bar.closeOi].every(Number.isFinite)) {
      throw new Error("60 \u5206\u949F\u884C\u60C5\u5B58\u5728\u975E\u6709\u9650\u6570\u503C");
    }
    if (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high || bar.close < bar.low || bar.close > bar.high) {
      throw new Error("60 \u5206\u949F\u884C\u60C5 OHLC \u8303\u56F4\u65E0\u6548");
    }
    if (bar.volume < 0 || bar.openOi < 0 || bar.closeOi < 0) {
      throw new Error("60 \u5206\u949F\u884C\u60C5\u6210\u4EA4\u91CF\u6216\u6301\u4ED3\u91CF\u4E3A\u8D1F");
    }
    const minute = tradingSegmentMinuteAt(bar.startMs, schedule);
    const bucket = Math.floor(minute.index / 60);
    const expectedStartIndex = bucket * 60;
    const expectedStopIndex = Math.min(expectedStartIndex + 60, minute.total);
    const dayStart = dateStartUtcMs(minute.date);
    const expectedStartMs = dayStart + (minute.startMinute + expectedStartIndex) * MINUTE_MS;
    const expectedEndMs = dayStart + (minute.startMinute + expectedStopIndex) * MINUTE_MS;
    if (bar.startMs !== expectedStartMs || bar.endMs !== expectedEndMs || bar.session !== minute.session) {
      throw new Error(`60 \u5206\u949F\u884C\u60C5\u8DE8\u8D8A\u4F11\u606F\u6216\u4EA4\u6613\u65F6\u6BB5\u8FB9\u754C\uFF1A${bar.start}`);
    }
    const expectedMinutes = expectedStopIndex - expectedStartIndex;
    if (bar.expectedMinutes !== expectedMinutes || expectedMinutes % 5 !== 0 || !Number.isInteger(bar.observedMinutes) || bar.observedMinutes < 0 || bar.observedMinutes > bar.expectedMinutes || bar.complete !== (bar.observedMinutes === bar.expectedMinutes)) {
      throw new Error(`60 \u5206\u949F\u884C\u60C5\u5B8C\u6574\u6027\u5B57\u6BB5\u65E0\u6548\uFF1A${bar.start}`);
    }
  }
}
function reconcileLegacyBars(bars5, bars60) {
  let childIndex = 0;
  for (const parent of bars60) {
    while (childIndex < bars5.length && bars5[childIndex].endMs <= parent.startMs) childIndex += 1;
    const children = [];
    for (let index = childIndex; index < bars5.length && bars5[index].startMs < parent.endMs; index++) {
      const child = bars5[index];
      if (child.startMs >= parent.startMs && child.endMs <= parent.endMs) children.push(child);
    }
    if (!children.length) throw new Error(`60 \u5206\u949F\u884C\u60C5\u7F3A\u5C11 5 \u5206\u949F\u7EC4\u6210\u8BB0\u5F55\uFF1A${parent.start}`);
    const expected = {
      open: children[0].open,
      high: Math.max(...children.map((child) => child.high)),
      low: Math.min(...children.map((child) => child.low)),
      close: children.at(-1).close,
      volume: children.reduce((sum, child) => sum + child.volume, 0)
    };
    for (const field of ["open", "high", "low", "close", "volume"]) {
      if (!equalNumber(parent[field], expected[field])) {
        throw new Error(`5 \u5206\u949F\u4E0E 60 \u5206\u949F ${field} \u5BF9\u8D26\u4E0D\u4E00\u81F4\uFF1A${parent.start}`);
      }
    }
  }
}
function detectSixtyMinuteBarFormat(bars60, schedule = DEFAULT_INSTRUMENT.tradingSessions, ambiguousPreference = "segmented") {
  let segmentedError;
  let segmentedValid = false;
  try {
    assertSegmentedSixtyMinuteBarsValid(bars60, schedule);
    segmentedValid = true;
  } catch (error) {
    segmentedError = error;
  }
  let legacyValid = false;
  try {
    assertBarsValid(bars60, 60, schedule);
    legacyValid = true;
  } catch {
    if (segmentedValid) return "segmented";
    throw segmentedError;
  }
  if (segmentedValid && legacyValid) return ambiguousPreference;
  return legacyValid ? "legacy" : "segmented";
}
function sameBar(left, right) {
  return left.startMs === right.startMs && left.endMs === right.endMs && left.session === right.session && equalNumber(left.open, right.open) && equalNumber(left.high, right.high) && equalNumber(left.low, right.low) && equalNumber(left.close, right.close) && equalNumber(left.volume, right.volume) && equalNumber(left.openOi, right.openOi) && equalNumber(left.closeOi, right.closeOi) && left.observedMinutes === right.observedMinutes && left.expectedMinutes === right.expectedMinutes && left.complete === right.complete;
}
function reconcileBars(bars5, bars60, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  assertBarsValid(bars5, 5, schedule);
  assertSegmentedSixtyMinuteBarsValid(bars60, schedule);
  const rebuilt = aggregateFiveMinuteBars(bars5, schedule);
  const completeRebuilt = rebuilt.filter((bar) => bar.complete);
  if (bars60.length !== completeRebuilt.length) {
    throw new Error("5 \u5206\u949F\u4E0E 60 \u5206\u949F\u65F6\u95F4\u6876\u6570\u91CF\u4E0D\u4E00\u81F4");
  }
  let childIndex = 0;
  for (let index = 0; index < bars60.length; index += 1) {
    const parent = bars60[index];
    const expected = completeRebuilt[index];
    if (parent.startMs !== expected.startMs || parent.endMs !== expected.endMs || parent.session !== expected.session) {
      throw new Error(`5 \u5206\u949F\u4E0E 60 \u5206\u949F\u65F6\u95F4\u6876\u4E0D\u4E00\u81F4\uFF1A${parent.start}`);
    }
    const expectedChildren = parent.expectedMinutes / 5;
    const children = bars5.slice(childIndex, childIndex + expectedChildren);
    if (children.length !== expectedChildren || children.some((bar, childIndex2) => bar.startMs !== parent.startMs + childIndex2 * 5 * MINUTE_MS || bar.endMs !== parent.startMs + (childIndex2 + 1) * 5 * MINUTE_MS)) {
      throw new Error(`60 \u5206\u949F\u884C\u60C5\u7EC4\u6210 5 \u5206\u949F\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1A${parent.start}`);
    }
    childIndex += expectedChildren;
    for (const field of [
      "open",
      "high",
      "low",
      "close",
      "volume",
      "openOi",
      "closeOi"
    ]) {
      if (!equalNumber(parent[field], expected[field])) {
        throw new Error(`5 \u5206\u949F\u4E0E 60 \u5206\u949F ${field} \u5BF9\u8D26\u4E0D\u4E00\u81F4\uFF1A${parent.start}`);
      }
    }
    if (parent.observedMinutes !== expected.observedMinutes || parent.expectedMinutes !== expected.expectedMinutes || parent.complete !== expected.complete) {
      throw new Error(`5 \u5206\u949F\u4E0E 60 \u5206\u949F\u5B8C\u6574\u6027\u5BF9\u8D26\u4E0D\u4E00\u81F4\uFF1A${parent.start}`);
    }
  }
  if (childIndex === bars5.length) return;
  const trailing = rebuilt.at(-1);
  const trailingChildren = bars5.slice(childIndex);
  const validUnpublishedTail = trailing !== void 0 && !trailing.complete && trailingChildren.length < trailing.expectedMinutes / 5 && trailingChildren.every((bar, index) => bar.complete && bar.startMs === trailing.startMs + index * 5 * MINUTE_MS && bar.endMs === trailing.startMs + (index + 1) * 5 * MINUTE_MS);
  if (!validUnpublishedTail) {
    throw new Error("5 \u5206\u949F\u4E0E 60 \u5206\u949F\u65F6\u95F4\u6876\u6570\u91CF\u4E0D\u4E00\u81F4");
  }
}
function reconcileCompatibleBars(bars5, bars60, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  const format = detectSixtyMinuteBarFormat(bars60, schedule);
  if (format === "segmented") {
    reconcileBars(bars5, bars60, schedule);
  } else {
    assertBarsValid(bars5, 5, schedule);
    reconcileLegacyBars(bars5, bars60);
  }
  return format;
}
function mergeBars(local, replacement, switchPointMs) {
  const prefix = local.filter((bar) => bar.startMs < switchPointMs);
  const tail = replacement.filter((bar) => bar.startMs >= switchPointMs);
  const oldTail = local.filter((bar) => bar.startMs >= switchPointMs);
  const oldByStart = new Map(oldTail.map((bar) => [bar.startMs, bar]));
  const nextByStart = new Map(tail.map((bar) => [bar.startMs, bar]));
  return {
    bars: [...prefix, ...tail],
    added: tail.filter((bar) => !oldByStart.has(bar.startMs)).length,
    replaced: tail.filter((bar) => {
      const old = oldByStart.get(bar.startMs);
      return old !== void 0 && !sameBar(old, bar);
    }).length,
    removed: oldTail.filter((bar) => !nextByStart.has(bar.startMs)).length
  };
}
function updateCounts(minutes, five, sixty) {
  return {
    added1: minutes.added,
    replaced1: minutes.replaced,
    removed1: minutes.removed,
    added5: five.added,
    replaced5: five.replaced,
    removed5: five.removed,
    added60: sixty.added,
    replaced60: sixty.replaced,
    removed60: sixty.removed,
    addedRollovers: 0,
    replacedRollovers: 0,
    removedRollovers: 0
  };
}
function serializeBars(bars) {
  const header = "bar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete";
  const lines = bars.map((bar) => [
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
    bar.complete ? "True" : "False"
  ].join(","));
  return `\uFEFF${[header, ...lines].join("\r\n")}\r
`;
}
function serializeMinuteRecords(records, schedule = DEFAULT_INSTRUMENT.tradingSessions) {
  assertMinuteRecordsValid(records, schedule);
  const header = REQUIRED_COLUMNS.join(",");
  const lines = records.map((record) => [
    record.datetimeNano,
    record.open,
    record.high,
    record.low,
    record.close,
    record.volume,
    record.openOi,
    record.closeOi
  ].join(","));
  return `\uFEFF${[header, ...lines].join("\r\n")}\r
`;
}

// src/main/data-service.ts
import { readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { join as join2, dirname as dirname2 } from "node:path";

// src/domain/data.ts
var COLUMNS = ["bar_start", "bar_end", "session", "open", "high", "low", "close", "volume", "open_oi", "close_oi", "observed_minutes", "expected_minutes", "complete"];
function splitRow(line) {
  const result = [];
  let value = "";
  let quoted = false;
  let closed = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        value += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else value += char;
    } else if (char === ",") {
      result.push(value);
      value = "";
      closed = false;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (char === '"' || closed) throw new Error("CSV \u5F15\u53F7\u683C\u5F0F\u65E0\u6548");
    else value += char;
  }
  if (quoted) throw new Error("CSV \u5F15\u53F7\u672A\u95ED\u5408");
  result.push(value);
  return result;
}
function parseBars(text, filename) {
  const fail = (line, reason) => {
    throw new Error(`${filename} \u7B2C${line}\u884C\uFF1A${reason}`);
  };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) fail(1, "\u6587\u4EF6\u4E3A\u7A7A\uFF0C\u6CA1\u6709\u884C\u60C5\u8BB0\u5F55");
  let header;
  try {
    header = splitRow(lines[0]);
  } catch (error) {
    return fail(1, error.message);
  }
  if (new Set(header).size !== header.length) fail(1, "\u5B58\u5728\u91CD\u590D\u5217");
  for (const column of COLUMNS) if (!header.includes(column)) fail(1, `\u7F3A\u5C11\u5217 ${column}`);
  if (lines.length === 1) fail(2, "\u6CA1\u6709\u884C\u60C5\u8BB0\u5F55");
  const indexes = Object.fromEntries(COLUMNS.map((column) => [column, header.indexOf(column)]));
  const bars = [];
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitRow(lines[index]);
      if (fields.length !== header.length) throw new Error("\u5217\u6570\u4E0E\u8868\u5934\u4E0D\u4E00\u81F4");
      const field = (name) => fields[indexes[name]];
      const number = (name) => {
        const value = field(name);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
          throw new Error(`${name} \u5FC5\u987B\u4E3A\u975E\u7A7A\u6709\u9650\u6570\u503C`);
        }
        return Number(value);
      };
      const start = field("bar_start");
      const end = field("bar_end");
      const startMs = parseBeijing(start);
      const endMs = parseBeijing(end);
      if (startMs >= endMs) throw new Error("\u65F6\u95F4\u533A\u95F4\u5FC5\u987B\u6EE1\u8DB3\u5F00\u59CB\u65E9\u4E8E\u7ED3\u675F");
      const previous = bars.at(-1);
      if (previous && (startMs <= previous.startMs || startMs < previous.endMs)) throw new Error("\u65F6\u95F4\u987A\u5E8F\u9519\u8BEF\u3001\u91CD\u590D\u8BB0\u5F55\u6216\u533A\u95F4\u91CD\u53E0");
      const open = number("open");
      const high = number("high");
      const low = number("low");
      const close = number("close");
      if (low > high || open < low || open > high || close < low || close > high) throw new Error("\u4EF7\u683C\u8303\u56F4\u9519\u8BEF\uFF1A\u5F00\u6536\u76D8\u5FC5\u987B\u5904\u4E8E\u6700\u4F4E\u4E0E\u6700\u9AD8\u4E4B\u95F4");
      const volume = number("volume");
      const openOi = number("open_oi");
      const closeOi = number("close_oi");
      if (volume < 0) throw new Error("volume \u4E0D\u5F97\u4E3A\u8D1F\u6570");
      if (openOi < 0 || closeOi < 0) throw new Error("open_oi / close_oi \u4E0D\u5F97\u4E3A\u8D1F\u6570");
      const observedMinutes = number("observed_minutes");
      const expectedMinutes = number("expected_minutes");
      if (!Number.isInteger(observedMinutes) || !Number.isInteger(expectedMinutes) || observedMinutes < 0 || expectedMinutes <= 0 || observedMinutes > expectedMinutes) {
        throw new Error("observed_minutes / expected_minutes \u5FC5\u987B\u4E3A\u6709\u6548\u5206\u949F\u6570");
      }
      const completeValue = field("complete");
      if (completeValue !== "True" && completeValue !== "False") throw new Error("complete \u5FC5\u987B\u4E3A True \u6216 False");
      const complete = completeValue === "True";
      if (complete && observedMinutes !== expectedMinutes) throw new Error("complete \u4E0E\u7EC4\u6210\u5206\u949F\u6570\u4E0D\u4E00\u81F4");
      const session = field("session");
      if (session !== "day" && session !== "night") throw new Error("session \u5FC5\u987B\u4E3A day \u6216 night");
      bars.push({ start, end, startMs, endMs, open, high, low, close, volume, openOi, closeOi, observedMinutes, expectedMinutes, complete, session });
    } catch (error) {
      fail(index + 1, error.message);
    }
  }
  return bars;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("\u5BA1\u8BA1\u6587\u4EF6\u7ED3\u6784\u65E0\u6548");
  return value;
}
function parseAudit(text) {
  const root2 = object(JSON.parse(text.replace(/^\uFEFF/, "")));
  if (!Array.isArray(root2.anomalies)) throw new Error("\u5BA1\u8BA1\u6587\u4EF6\u7F3A\u5C11\u5F02\u5E38\u5217\u8868");
  return root2.anomalies.map((value, index) => {
    const anomaly = object(value);
    if (typeof anomaly.local_time !== "string" || typeof anomaly.title !== "string" || typeof anomaly.detail !== "string") {
      throw new Error(`\u5BA1\u8BA1\u6587\u4EF6\u7B2C${index + 1}\u6761\u5F02\u5E38\u7ED3\u6784\u65E0\u6548`);
    }
    return { timeMs: parseBeijing(anomaly.local_time), title: anomaly.title, detail: anomaly.detail };
  });
}

// src/main/market-snapshot.ts
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// src/domain/contract-rollover.ts
var ROLLOVER_COLUMNS = ["trading_date", "time", "from_contract", "to_contract"];
var MAPPING_COLUMNS = ["trading_date", "contract"];
function splitCsvRow2(line) {
  const values = [];
  let value = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index++) {
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
    } else if (character === ",") {
      values.push(value);
      value = "";
      quoteClosed = false;
    } else if (character === '"' && !value && !quoteClosed) {
      quoted = true;
    } else if (character === '"' || quoteClosed) {
      throw new Error("CSV \u5F15\u53F7\u683C\u5F0F\u65E0\u6548");
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("CSV \u5F15\u53F7\u672A\u95ED\u5408");
  values.push(value);
  return values;
}
function normalizedLines(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines;
}
function validateHeader(lines, columns, label) {
  if (!lines.length) throw new Error(`${label} \u7B2C1\u884C\uFF1A\u6587\u4EF6\u4E3A\u7A7A`);
  let header;
  try {
    header = splitCsvRow2(lines[0]);
  } catch (error) {
    throw new Error(`${label} \u7B2C1\u884C\uFF1A${error.message}`);
  }
  if (new Set(header).size !== header.length) throw new Error(`${label} \u7B2C1\u884C\uFF1A\u5B58\u5728\u91CD\u590D\u5217`);
  for (const column of columns) {
    if (!header.includes(column)) throw new Error(`${label} \u7B2C1\u884C\uFF1A\u7F3A\u5C11\u5217 ${column}`);
  }
  return {
    header,
    indexes: Object.fromEntries(columns.map((column) => [column, header.indexOf(column)]))
  };
}
function isConcreteContract(definition, contract) {
  return isConcreteContractCode(definition, contract);
}
function assertContract(contract, field, definition) {
  if (!isConcreteContract(definition, contract)) {
    throw new Error(`${field} \u5FC5\u987B\u4E3A${definition.shortName}\u53D7\u652F\u6301\u7684\u5177\u4F53\u5408\u7EA6\u4EE3\u7801`);
  }
}
function assertDate(date, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${field} \u5FC5\u987B\u4E3A YYYY-MM-DD`);
  parseBeijing(`${date} 00:00:00`);
}
function parseContractRollovers(text, label = "\u6362\u6708\u6587\u4EF6", definition = DEFAULT_INSTRUMENT) {
  const lines = normalizedLines(text);
  const { header, indexes } = validateHeader(lines, ROLLOVER_COLUMNS, label);
  const rollovers = [];
  const tradingDates = /* @__PURE__ */ new Set();
  for (let index = 1; index < lines.length; index++) {
    try {
      const fields = splitCsvRow2(lines[index]);
      if (fields.length !== header.length) throw new Error("\u5217\u6570\u4E0E\u8868\u5934\u4E0D\u4E00\u81F4");
      const field = (name) => fields[indexes[name]];
      const tradingDate = field("trading_date");
      const time = field("time");
      const fromContract = field("from_contract");
      const toContract = field("to_contract");
      assertDate(tradingDate, "trading_date");
      const timeMs = parseBeijing(time);
      assertContract(fromContract, "from_contract", definition);
      assertContract(toContract, "to_contract", definition);
      if (fromContract === toContract) throw new Error("\u65B0\u65E7\u5408\u7EA6\u4E0D\u5F97\u76F8\u540C");
      if (tradingDates.has(tradingDate)) throw new Error("\u4EA4\u6613\u65E5\u91CD\u590D");
      const previous = rollovers.at(-1);
      if (previous && (tradingDate <= previous.tradingDate || timeMs <= previous.timeMs)) {
        throw new Error("\u6362\u6708\u8BB0\u5F55\u5FC5\u987B\u6309\u4EA4\u6613\u65E5\u548C\u65F6\u95F4\u4E25\u683C\u9012\u589E");
      }
      tradingDates.add(tradingDate);
      rollovers.push({ tradingDate, time, timeMs, fromContract, toContract });
    } catch (error) {
      throw new Error(`${label} \u7B2C${index + 1}\u884C\uFF1A${error.message}`);
    }
  }
  return rollovers;
}
function serializeContractRollovers(rollovers, definition = DEFAULT_INSTRUMENT) {
  const parsed = parseContractRollovers([
    ROLLOVER_COLUMNS.join(","),
    ...rollovers.map((rollover) => [
      rollover.tradingDate,
      rollover.time,
      rollover.fromContract,
      rollover.toContract
    ].join(","))
  ].join("\n"), "\u6362\u6708\u6587\u4EF6", definition);
  const lines = parsed.map((rollover) => [
    rollover.tradingDate,
    rollover.time,
    rollover.fromContract,
    rollover.toContract
  ].join(","));
  return `\uFEFF${[ROLLOVER_COLUMNS.join(","), ...lines].join("\r\n")}\r
`;
}
function detectContractRollovers(mappings, bars5, definition = DEFAULT_INSTRUMENT) {
  const rollovers = [];
  for (let index = 1; index < mappings.length; index++) {
    const previous = mappings[index - 1];
    const current = mappings[index];
    assertDate(previous.tradingDate, "\u524D\u4E00\u4EA4\u6613\u65E5");
    assertDate(current.tradingDate, "\u5F53\u524D\u4EA4\u6613\u65E5");
    assertContract(previous.contract, "\u65E7\u5408\u7EA6", definition);
    assertContract(current.contract, "\u65B0\u5408\u7EA6", definition);
    if (current.tradingDate <= previous.tradingDate) throw new Error("\u4E3B\u529B\u5408\u7EA6\u6620\u5C04\u5FC5\u987B\u6309\u4EA4\u6613\u65E5\u4E25\u683C\u9012\u589E");
    if (current.contract === previous.contract) continue;
    const cutoff = parseBeijing(`${previous.tradingDate} 15:00:00`);
    const firstIndex = lowerBoundStart(bars5, cutoff + 1);
    const first = bars5[firstIndex];
    if (!first) throw new Error(`\u6362\u6708 ${current.tradingDate} \u7F3A\u5C11\u65B0\u4E3B\u529B\u9996\u6839 5 \u5206\u949F K \u7EBF`);
    const currentClose = parseBeijing(`${current.tradingDate} 15:00:00`);
    if (first.startMs > currentClose) {
      throw new Error(`\u6362\u6708 ${current.tradingDate} \u65E0\u6CD5\u5728\u5BF9\u5E94\u4EA4\u6613\u65E5\u5B9A\u4F4D\u9996\u6839 5 \u5206\u949F K \u7EBF`);
    }
    rollovers.push({
      tradingDate: current.tradingDate,
      time: formatBeijing(first.startMs),
      timeMs: first.startMs,
      fromContract: previous.contract,
      toContract: current.contract
    });
  }
  return rollovers;
}
function parseMainContractMappings(text, label = "\u4E3B\u529B\u6620\u5C04\u6587\u4EF6", definition = DEFAULT_INSTRUMENT) {
  const lines = normalizedLines(text);
  const { header, indexes } = validateHeader(lines, MAPPING_COLUMNS, label);
  const mappings = [];
  for (let index = 1; index < lines.length; index += 1) {
    try {
      const fields = splitCsvRow2(lines[index]);
      if (fields.length !== header.length) throw new Error("\u5217\u6570\u4E0E\u8868\u5934\u4E0D\u4E00\u81F4");
      const tradingDate = fields[indexes.trading_date];
      const contract = fields[indexes.contract];
      assertDate(tradingDate, "trading_date");
      assertContract(contract, "contract", definition);
      const previous = mappings.at(-1);
      if (previous && tradingDate <= previous.tradingDate) {
        throw new Error("\u4E3B\u529B\u6620\u5C04\u5FC5\u987B\u6309\u4EA4\u6613\u65E5\u4E25\u683C\u9012\u589E");
      }
      mappings.push({ tradingDate, contract });
    } catch (error) {
      throw new Error(`${label} \u7B2C${index + 1}\u884C\uFF1A${error.message}`);
    }
  }
  return mappings;
}
function serializeMainContractMappings(mappings, definition = DEFAULT_INSTRUMENT) {
  const parsed = parseMainContractMappings([
    MAPPING_COLUMNS.join(","),
    ...mappings.map((mapping) => `${mapping.tradingDate},${mapping.contract}`)
  ].join("\n"), "\u4E3B\u529B\u6620\u5C04\u6587\u4EF6", definition);
  return `\uFEFF${[
    MAPPING_COLUMNS.join(","),
    ...parsed.map((mapping) => `${mapping.tradingDate},${mapping.contract}`)
  ].join("\r\n")}\r
`;
}
function mergeMainContractMappings(local, remote, definition = DEFAULT_INSTRUMENT) {
  parseMainContractMappings(serializeMainContractMappings([...local], definition), "\u672C\u5730\u4E3B\u529B\u6620\u5C04", definition);
  parseMainContractMappings(serializeMainContractMappings([...remote], definition), "\u8FDC\u7AEF\u4E3B\u529B\u6620\u5C04", definition);
  const byDate = new Map(local.map((mapping) => [mapping.tradingDate, mapping]));
  for (const mapping of remote) byDate.set(mapping.tradingDate, mapping);
  return [...byDate.values()].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
}

// src/main/market-snapshot.ts
var SNAPSHOT_SCHEMA_VERSION = 4;
var ONE_MINUTE_FILE = "edb_main_continuous_1m_raw.csv";
var FIVE_MINUTE_FILE = "edb_main_continuous_5m.csv";
var SIXTY_MINUTE_FILE = "edb_main_continuous_60m.csv";
var ROLLOVER_FILE = "edb_main_continuous_rollovers.csv";
var MAPPING_FILE = "edb_main_contract_mapping.csv";
var METADATA_FILE = "metadata.json";
var ACTIVATED_FILE = "activated.json";
var POINTER_FILE = "current.json";
var SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;
var LEGACY_SCHEMA_VERSIONS = /* @__PURE__ */ new Set([1, 2, 3]);
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function assertSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_ID.test(value)) {
    throw new Error("\u5FEB\u7167\u6807\u8BC6\u65E0\u6548");
  }
}
function parseObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${label} JSON \u65E0\u6548`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} \u7ED3\u6784\u65E0\u6548`);
  }
  return parsed;
}
function fileMetadata(files, key) {
  const file = files[key];
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("\u5FEB\u7167\u6587\u4EF6\u5143\u6570\u636E\u65E0\u6548");
  }
  const record = file;
  if (typeof record.name !== "string" || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.rows !== "number" || !Number.isSafeInteger(record.rows) || record.rows < 0) {
    throw new Error("\u5FEB\u7167\u6587\u4EF6\u5143\u6570\u636E\u65E0\u6548");
  }
  return record;
}
function parseMetadata(text, expectedId, definition) {
  const value = parseObject(text, METADATA_FILE);
  const schemaVersion = value.schemaVersion;
  if (!LEGACY_SCHEMA_VERSIONS.has(schemaVersion) && schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("\u5FEB\u7167 schema \u4E0D\u53D7\u652F\u6301");
  }
  if (typeof value.snapshotId !== "string") throw new Error("\u5FEB\u7167\u6807\u8BC6\u65E0\u6548");
  assertSnapshotId(value.snapshotId);
  if (expectedId !== void 0 && value.snapshotId !== expectedId) {
    throw new Error("\u5FEB\u7167\u6807\u8BC6\u4E0E\u76EE\u5F55\u4E0D\u4E00\u81F4");
  }
  const source = value.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("\u5FEB\u7167\u6570\u636E\u6E90\u58F0\u660E\u65E0\u6548");
  }
  const sourceRecord = source;
  if (sourceRecord.provider !== "EDB" || sourceRecord.endpoint !== "https://edb.shinnytech.com/md/kline" || typeof sourceRecord.symbol !== "string") {
    throw new Error("\u5FEB\u7167\u6570\u636E\u6E90\u58F0\u660E\u65E0\u6548");
  }
  if (schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    if (value.instrumentId !== definition.id || value.mainSymbol !== definition.mainSymbol || value.parameterVersion !== definition.parameterVersion || sourceRecord.symbol !== definition.mainSymbol) {
      throw new Error("\u5FEB\u7167\u54C1\u79CD\u58F0\u660E\u4E0E\u5F53\u524D\u54C1\u79CD\u4E0D\u5339\u914D");
    }
  } else if (definition.id !== DEFAULT_INSTRUMENT.id || sourceRecord.symbol !== DEFAULT_INSTRUMENT.mainSymbol) {
    throw new Error("\u65E7\u7248\u5FEB\u7167\u4EC5\u652F\u6301\u8C46\u7C95\u4E3B\u8FDE");
  }
  const filesValue = value.files;
  if (!filesValue || typeof filesValue !== "object" || Array.isArray(filesValue)) {
    throw new Error("\u5FEB\u7167\u6587\u4EF6\u5143\u6570\u636E\u65E0\u6548");
  }
  const files = filesValue;
  fileMetadata(files, "bars5");
  fileMetadata(files, "bars60");
  if (schemaVersion >= 2) fileMetadata(files, "rollovers");
  if (schemaVersion >= 3) fileMetadata(files, "bars1");
  if (schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    fileMetadata(files, "mainContractMappings");
  }
  for (const field of ["generatedAt", "requestStart", "requestEnd", "sourceLatestAt"]) {
    if (typeof value[field] !== "string") throw new Error(`\u5FEB\u7167\u7F3A\u5C11 ${field}`);
  }
  parseBeijing(value.requestStart);
  parseBeijing(value.requestEnd);
  parseBeijing(value.sourceLatestAt);
  if (Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("\u5FEB\u7167\u751F\u6210\u65F6\u95F4\u65E0\u6548");
  }
  return value;
}
function instrumentBuiltinDirectory(paths2, definition) {
  return join(paths2.builtinDataDirectory, "instruments", definition.id);
}
function instrumentMarketDataDirectory(paths2, definition) {
  return join(paths2.marketDataDirectory, "instruments", definition.id);
}
function resolveInstrumentDataDirectories(paths2, definition) {
  return {
    builtin: instrumentBuiltinDirectory(paths2, definition),
    user: instrumentMarketDataDirectory(paths2, definition)
  };
}
function legacyBuiltinDirectory(paths2) {
  return paths2.legacyBuiltinDataDirectory ?? paths2.builtinDataDirectory;
}
function validateSnapshotData(definition, bars1, bars5, bars60) {
  assertMinuteRecordsValid(bars1, definition.tradingSessions);
  assertBarsValid(bars5, 5, definition.tradingSessions);
  reconcileCompatibleBars(bars5, bars60, definition.tradingSessions);
}
function deriveLegacyMappings(bars5, rollovers, definition) {
  if (!rollovers.length) return [];
  let initialDate = bars5[0]?.start.slice(0, 10) ?? rollovers[0].tradingDate;
  if (initialDate >= rollovers[0].tradingDate) {
    initialDate = formatBeijing(
      parseBeijing(`${rollovers[0].tradingDate} 00:00:00`) - 24 * 60 * 60 * 1e3
    ).slice(0, 10);
  }
  return parseMainContractMappings(serializeMainContractMappings([
    { tradingDate: initialDate, contract: rollovers[0].fromContract },
    ...rollovers.map((rollover) => ({
      tradingDate: rollover.tradingDate,
      contract: rollover.toContract
    }))
  ], definition), "\u65E7\u7248\u4E3B\u529B\u6620\u5C04", definition);
}
async function readRequiredFile(directory, name) {
  const path = join(directory, name);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = error.code;
    throw new Error(`${name}\uFF1A${code === "ENOENT" ? "\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8BF7\u6062\u590D data \u76EE\u5F55\u540E\u91CD\u8BD5" : "\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6"}\u3002
\u4F4D\u7F6E\uFF1A${path}`);
  }
}
async function readVerifiedFile(directory, metadata, expectedName) {
  if (metadata.name !== expectedName) throw new Error("\u5FEB\u7167\u6587\u4EF6\u540D\u4E0E\u5143\u6570\u636E\u4E0D\u4E00\u81F4");
  const text = await readFile(join(directory, expectedName), "utf8");
  if (sha256(text) !== metadata.sha256) throw new Error("\u5FEB\u7167\u6587\u4EF6\u54C8\u5E0C\u4E0D\u4E00\u81F4");
  return text;
}
async function loadMetadataSnapshotDirectory(directory, expectedId, definition, source, fallback) {
  const metadata = parseMetadata(
    await readFile(join(directory, METADATA_FILE), "utf8"),
    expectedId,
    definition
  );
  const files = metadata.files;
  const [fiveText, sixtyText] = await Promise.all([
    readVerifiedFile(directory, files.bars5, FIVE_MINUTE_FILE),
    readVerifiedFile(directory, files.bars60, SIXTY_MINUTE_FILE)
  ]);
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  if (bars5.length !== files.bars5.rows || bars60.length !== files.bars60.rows) {
    throw new Error("\u5FEB\u7167\u8BB0\u5F55\u6570\u4E0E\u5143\u6570\u636E\u4E0D\u4E00\u81F4");
  }
  let bars1;
  if (metadata.schemaVersion >= 3) {
    const oneText = await readVerifiedFile(directory, files.bars1, ONE_MINUTE_FILE);
    bars1 = parseEdbMinuteCsv(
      oneText,
      ONE_MINUTE_FILE,
      definition.tradingSessions
    );
    if (bars1.length !== files.bars1.rows) {
      throw new Error("\u5FEB\u7167 1 \u5206\u949F\u8BB0\u5F55\u6570\u4E0E\u5143\u6570\u636E\u4E0D\u4E00\u81F4");
    }
  } else {
    if (!fallback) throw new Error("\u65E7\u7248\u5FEB\u7167\u7F3A\u5C11\u53EF\u7528\u7684\u5185\u7F6E 1 \u5206\u949F\u57FA\u7EBF");
    bars1 = fallback.bars1;
  }
  let rollovers;
  if (metadata.schemaVersion >= 2) {
    const rolloverText = await readVerifiedFile(
      directory,
      files.rollovers,
      ROLLOVER_FILE
    );
    rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE, definition);
    if (rollovers.length !== files.rollovers.rows) {
      throw new Error("\u5FEB\u7167\u6362\u6708\u8BB0\u5F55\u6570\u4E0E\u5143\u6570\u636E\u4E0D\u4E00\u81F4");
    }
  } else {
    if (!fallback) throw new Error("\u65E7\u7248\u5FEB\u7167\u7F3A\u5C11\u53EF\u7528\u7684\u5185\u7F6E\u6362\u6708\u57FA\u7EBF");
    rollovers = fallback.rollovers;
  }
  let mainContractMappings;
  if (metadata.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    const mappingText = await readVerifiedFile(
      directory,
      files.mainContractMappings,
      MAPPING_FILE
    );
    mainContractMappings = parseMainContractMappings(
      mappingText,
      MAPPING_FILE,
      definition
    );
    if (mainContractMappings.length !== files.mainContractMappings.rows) {
      throw new Error("\u5FEB\u7167\u4E3B\u529B\u6620\u5C04\u8BB0\u5F55\u6570\u4E0E\u5143\u6570\u636E\u4E0D\u4E00\u81F4");
    }
  } else if (metadata.schemaVersion === 1 && fallback) {
    mainContractMappings = fallback.mainContractMappings;
  } else {
    mainContractMappings = deriveLegacyMappings(bars5, rollovers, definition);
  }
  validateSnapshotData(definition, bars1, bars5, bars60);
  return {
    source,
    directory,
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
    sourceLatestAt: metadata.sourceLatestAt,
    snapshotUpdatedAt: source === "user" ? metadata.generatedAt : void 0,
    metadata
  };
}
async function loadLegacyBuiltinSnapshot(directory, definition) {
  if (definition.id !== DEFAULT_INSTRUMENT.id) {
    throw new Error(`${definition.name} \u7F3A\u5C11\u6309\u54C1\u79CD\u9694\u79BB\u7684\u5185\u7F6E\u6570\u636E\u76EE\u5F55`);
  }
  const [oneText, fiveText, sixtyText, rolloverText] = await Promise.all([
    readRequiredFile(directory, ONE_MINUTE_FILE),
    readRequiredFile(directory, FIVE_MINUTE_FILE),
    readRequiredFile(directory, SIXTY_MINUTE_FILE),
    readRequiredFile(directory, ROLLOVER_FILE)
  ]);
  const bars1 = parseEdbMinuteCsv(
    oneText,
    ONE_MINUTE_FILE,
    definition.tradingSessions
  );
  const bars5 = parseBars(fiveText, FIVE_MINUTE_FILE);
  const bars60 = parseBars(sixtyText, SIXTY_MINUTE_FILE);
  const rollovers = parseContractRollovers(rolloverText, ROLLOVER_FILE, definition);
  validateSnapshotData(definition, bars1, bars5, bars60);
  return {
    source: "builtin",
    directory,
    bars1,
    bars5,
    bars60,
    mainContractMappings: deriveLegacyMappings(bars5, rollovers, definition),
    rollovers,
    sourceLatestAt: formatBeijing(Math.max(
      bars1.at(-1)?.startMs ?? 0,
      bars5.at(-1)?.endMs ?? 0,
      bars60.at(-1)?.endMs ?? 0
    ))
  };
}
async function loadBuiltinSnapshot(paths2, definition) {
  const directory = instrumentBuiltinDirectory(paths2, definition);
  try {
    return await loadMetadataSnapshotDirectory(
      directory,
      void 0,
      definition,
      "builtin"
    );
  } catch (error) {
    if (definition.id !== DEFAULT_INSTRUMENT.id) throw error;
    return loadLegacyBuiltinSnapshot(legacyBuiltinDirectory(paths2), definition);
  }
}
async function readCurrentPointer(directory) {
  const value = parseObject(
    await readFile(join(directory, POINTER_FILE), "utf8"),
    POINTER_FILE
  );
  if (![1, 2, 3, SNAPSHOT_SCHEMA_VERSION].includes(value.schemaVersion) || typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("\u5F53\u524D\u5FEB\u7167\u6307\u9488\u65E0\u6548");
  }
  assertSnapshotId(value.snapshotId);
  return value;
}
async function activatedSnapshotIds(directory) {
  const snapshots = join(directory, "snapshots");
  let entries;
  try {
    entries = await readdir(snapshots, { withFileTypes: true });
  } catch {
    return [];
  }
  const activated = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) continue;
    try {
      const marker = parseObject(
        await readFile(join(snapshots, entry.name, ACTIVATED_FILE), "utf8"),
        ACTIVATED_FILE
      );
      const activatedAt = typeof marker.activatedAt === "string" ? Date.parse(marker.activatedAt) : Number.NaN;
      if (Number.isNaN(activatedAt)) continue;
      activated.push({ id: entry.name, time: activatedAt });
    } catch {
    }
  }
  return activated.sort((left, right) => right.time - left.time).map((item) => item.id);
}
async function snapshotCandidates(directory) {
  const candidates = [];
  try {
    candidates.push((await readCurrentPointer(directory)).snapshotId);
  } catch {
  }
  for (const id of await activatedSnapshotIds(directory)) {
    if (!candidates.includes(id)) candidates.push(id);
  }
  return candidates;
}
async function firstValidUserSnapshot(directory, definition, builtin) {
  for (const snapshotId of await snapshotCandidates(directory)) {
    try {
      return await loadMetadataSnapshotDirectory(
        join(directory, "snapshots", snapshotId),
        snapshotId,
        definition,
        "user",
        builtin
      );
    } catch {
    }
  }
  return void 0;
}
function serializeCandidate(definition, candidate) {
  validateSnapshotData(
    definition,
    candidate.bars1,
    candidate.bars5,
    candidate.bars60
  );
  return {
    oneText: serializeMinuteRecords(
      candidate.bars1,
      definition.tradingSessions
    ),
    fiveText: serializeBars(candidate.bars5),
    sixtyText: serializeBars(candidate.bars60),
    rolloverText: serializeContractRollovers(candidate.rollovers, definition),
    mappingText: serializeMainContractMappings(
      candidate.mainContractMappings,
      definition
    )
  };
}
function buildMetadata(definition, snapshotId, candidate, generatedAt, serialized) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: definition.parameterVersion,
    source: {
      provider: "EDB",
      endpoint: "https://edb.shinnytech.com/md/kline",
      symbol: definition.mainSymbol
    },
    generatedAt,
    requestStart: candidate.requestStart,
    requestEnd: candidate.requestEnd,
    sourceLatestAt: candidate.sourceLatestAt,
    files: {
      bars1: {
        name: ONE_MINUTE_FILE,
        sha256: sha256(serialized.oneText),
        rows: candidate.bars1.length
      },
      bars5: {
        name: FIVE_MINUTE_FILE,
        sha256: sha256(serialized.fiveText),
        rows: candidate.bars5.length
      },
      bars60: {
        name: SIXTY_MINUTE_FILE,
        sha256: sha256(serialized.sixtyText),
        rows: candidate.bars60.length
      },
      rollovers: {
        name: ROLLOVER_FILE,
        sha256: sha256(serialized.rolloverText),
        rows: candidate.rollovers.length
      },
      mainContractMappings: {
        name: MAPPING_FILE,
        sha256: sha256(serialized.mappingText),
        rows: candidate.mainContractMappings.length
      }
    }
  };
}
async function writeSerializedSnapshot(directory, metadata, serialized) {
  await Promise.all([
    writeFile(join(directory, ONE_MINUTE_FILE), serialized.oneText, "utf8"),
    writeFile(join(directory, FIVE_MINUTE_FILE), serialized.fiveText, "utf8"),
    writeFile(join(directory, SIXTY_MINUTE_FILE), serialized.sixtyText, "utf8"),
    writeFile(join(directory, ROLLOVER_FILE), serialized.rolloverText, "utf8"),
    writeFile(join(directory, MAPPING_FILE), serialized.mappingText, "utf8"),
    writeFile(
      join(directory, METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}
`,
      "utf8"
    )
  ]);
}
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function migrateLegacyBuiltin(paths2) {
  if (!paths2.legacyBuiltinDataDirectory) return false;
  const target = instrumentBuiltinDirectory(paths2, DEFAULT_INSTRUMENT);
  if (await pathExists(target)) return false;
  const legacy = await loadLegacyBuiltinSnapshot(
    paths2.legacyBuiltinDataDirectory,
    DEFAULT_INSTRUMENT
  );
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const candidate = {
    bars1: legacy.bars1,
    bars5: legacy.bars5,
    bars60: legacy.bars60,
    mainContractMappings: legacy.mainContractMappings,
    rollovers: legacy.rollovers,
    requestStart: legacy.bars1[0]?.start ?? legacy.sourceLatestAt,
    requestEnd: legacy.sourceLatestAt,
    sourceLatestAt: legacy.sourceLatestAt
  };
  const serialized = serializeCandidate(DEFAULT_INSTRUMENT, candidate);
  const metadata = buildMetadata(
    DEFAULT_INSTRUMENT,
    "builtin-main_continuous",
    candidate,
    generatedAt,
    serialized
  );
  const parent = dirname(target);
  const staging = join(parent, `.migrating-main_continuous-${randomBytes(4).toString("hex")}`);
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(staging);
    await writeSerializedSnapshot(staging, metadata, serialized);
    await loadMetadataSnapshotDirectory(
      staging,
      void 0,
      DEFAULT_INSTRUMENT,
      "builtin"
    );
    await rename(staging, target);
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => void 0);
    if (await pathExists(target)) return false;
    throw error;
  }
}
async function writeCurrentPointer(directory, pointer) {
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.current-${pointer.snapshotId}-${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}
`, "utf8");
  await rename(temporary, join(directory, POINTER_FILE));
}
async function migrateLegacyUserSnapshot(paths2, builtin) {
  const target = instrumentMarketDataDirectory(paths2, DEFAULT_INSTRUMENT);
  if (await firstValidUserSnapshot(target, DEFAULT_INSTRUMENT, builtin)) {
    return false;
  }
  let pointer;
  try {
    pointer = await readCurrentPointer(paths2.marketDataDirectory);
  } catch {
    return false;
  }
  const source = join(
    paths2.marketDataDirectory,
    "snapshots",
    pointer.snapshotId
  );
  const legacy = await loadMetadataSnapshotDirectory(
    source,
    pointer.snapshotId,
    DEFAULT_INSTRUMENT,
    "user",
    builtin
  );
  const migratedId = `legacy-${pointer.snapshotId}`.slice(0, 100);
  assertSnapshotId(migratedId);
  const snapshots = join(target, "snapshots");
  const destination = join(snapshots, migratedId);
  const staging = join(target, `.migrating-${migratedId}`);
  await mkdir(snapshots, { recursive: true });
  if (!await pathExists(destination)) {
    await rm(staging, { recursive: true, force: true });
    try {
      await cp(source, staging, { recursive: true, errorOnExist: true });
      const metadataPath = join(staging, METADATA_FILE);
      const metadata = parseObject(await readFile(metadataPath, "utf8"), METADATA_FILE);
      metadata.snapshotId = migratedId;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}
`, "utf8");
      await writeFile(
        join(staging, ACTIVATED_FILE),
        `${JSON.stringify({ activatedAt: pointer.updatedAt }, null, 2)}
`,
        "utf8"
      );
      await loadMetadataSnapshotDirectory(
        staging,
        migratedId,
        DEFAULT_INSTRUMENT,
        "user",
        builtin
      );
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => void 0);
      if (!await pathExists(destination)) throw error;
    }
  }
  await loadMetadataSnapshotDirectory(
    destination,
    migratedId,
    DEFAULT_INSTRUMENT,
    "user",
    builtin
  );
  await writeCurrentPointer(target, {
    schemaVersion: legacy.metadata.schemaVersion,
    snapshotId: migratedId,
    updatedAt: pointer.updatedAt
  });
  return true;
}
async function migrateLegacySoymealData(paths2) {
  const builtinMigrated = await migrateLegacyBuiltin(paths2);
  const builtin = await loadBuiltinSnapshot(paths2, DEFAULT_INSTRUMENT);
  const userSnapshotMigrated = await migrateLegacyUserSnapshot(paths2, builtin);
  return { builtinMigrated, userSnapshotMigrated };
}
async function loadEffectiveSnapshot(paths2, definition) {
  if (definition.id === DEFAULT_INSTRUMENT.id && paths2.legacyBuiltinDataDirectory) {
    await migrateLegacySoymealData(paths2).catch(() => void 0);
  }
  const builtin = await loadBuiltinSnapshot(paths2, definition);
  const userDirectory = instrumentMarketDataDirectory(paths2, definition);
  return await firstValidUserSnapshot(userDirectory, definition, builtin) ?? builtin;
}
function defaultSnapshotId(now) {
  return `${now.toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(4).toString("hex")}`;
}
async function saveMarketSnapshot(paths2, definition, candidate, options = {}) {
  parseBeijing(candidate.requestStart);
  parseBeijing(candidate.requestEnd);
  parseBeijing(candidate.sourceLatestAt);
  const serializationStarted = performance.now();
  const serialized = serializeCandidate(definition, candidate);
  options.onTiming?.(
    "serialization",
    performance.now() - serializationStarted
  );
  const now = options.now?.() ?? /* @__PURE__ */ new Date();
  const snapshotId = options.idFactory?.() ?? defaultSnapshotId(now);
  assertSnapshotId(snapshotId);
  const marketDataDirectory = instrumentMarketDataDirectory(paths2, definition);
  const snapshotsDirectory = join(marketDataDirectory, "snapshots");
  const stagingDirectory = join(marketDataDirectory, `.staging-${snapshotId}`);
  const finalDirectory = join(snapshotsDirectory, snapshotId);
  const metadata = buildMetadata(
    definition,
    snapshotId,
    candidate,
    now.toISOString(),
    serialized
  );
  await mkdir(snapshotsDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await mkdir(stagingDirectory);
    const writeStarted = performance.now();
    await writeSerializedSnapshot(stagingDirectory, metadata, serialized);
    options.onTiming?.("write", performance.now() - writeStarted);
    const builtin = await loadBuiltinSnapshot(paths2, definition);
    const validationStarted = performance.now();
    await loadMetadataSnapshotDirectory(
      stagingDirectory,
      snapshotId,
      definition,
      "user",
      builtin
    );
    options.onTiming?.(
      "validation",
      performance.now() - validationStarted
    );
    const activationStarted = performance.now();
    await options.beforePointerSwitch?.();
    await rename(stagingDirectory, finalDirectory);
    const pointer = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      updatedAt: now.toISOString()
    };
    await writeCurrentPointer(marketDataDirectory, pointer);
    await writeFile(
      join(finalDirectory, ACTIVATED_FILE),
      `${JSON.stringify({ activatedAt: now.toISOString() })}
`,
      "utf8"
    );
    await cleanupSnapshots(paths2, definition, snapshotId);
    options.onTiming?.(
      "activation",
      performance.now() - activationStarted
    );
    const reloadStarted = performance.now();
    const loaded = await loadMetadataSnapshotDirectory(
      finalDirectory,
      snapshotId,
      definition,
      "user",
      builtin
    );
    options.onTiming?.("reload", performance.now() - reloadStarted);
    return loaded;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => void 0);
    throw error;
  }
}
async function writeBuiltinMarketSnapshot(paths2, definition, candidate, options = {}) {
  parseBeijing(candidate.requestStart);
  parseBeijing(candidate.requestEnd);
  parseBeijing(candidate.sourceLatestAt);
  const serialized = serializeCandidate(definition, candidate);
  const snapshotId = `builtin-${definition.id}`;
  const metadata = buildMetadata(
    definition,
    snapshotId,
    candidate,
    (options.now?.() ?? /* @__PURE__ */ new Date()).toISOString(),
    serialized
  );
  const finalDirectory = instrumentBuiltinDirectory(paths2, definition);
  const parentDirectory = dirname(finalDirectory);
  const nonce = randomBytes(4).toString("hex");
  const stagingDirectory = join(
    parentDirectory,
    `.staging-${definition.id}-${nonce}`
  );
  const backupDirectory = join(
    parentDirectory,
    `.backup-${definition.id}-${nonce}`
  );
  await mkdir(parentDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
  let backedUp = false;
  try {
    await mkdir(stagingDirectory);
    await writeSerializedSnapshot(stagingDirectory, metadata, serialized);
    await loadMetadataSnapshotDirectory(
      stagingDirectory,
      void 0,
      definition,
      "builtin"
    );
    await options.beforeCommit?.();
    if (await pathExists(finalDirectory)) {
      await rename(finalDirectory, backupDirectory);
      backedUp = true;
    }
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (backedUp && !await pathExists(finalDirectory)) {
        await rename(backupDirectory, finalDirectory);
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) {
      await rm(backupDirectory, { recursive: true, force: true });
      backedUp = false;
    }
    return loadMetadataSnapshotDirectory(
      finalDirectory,
      void 0,
      definition,
      "builtin"
    );
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => void 0);
    if (backedUp && !await pathExists(finalDirectory)) {
      await rename(backupDirectory, finalDirectory).catch(() => void 0);
      backedUp = false;
    }
    throw error;
  } finally {
    if (!backedUp) {
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => void 0);
    }
  }
}
async function cleanupSnapshots(paths2, definition, currentSnapshotId) {
  const marketDataDirectory = instrumentMarketDataDirectory(paths2, definition);
  const pointerId = currentSnapshotId ?? await readCurrentPointer(marketDataDirectory).then((pointer) => pointer.snapshotId).catch(() => void 0);
  const activated = await activatedSnapshotIds(marketDataDirectory);
  const keep = /* @__PURE__ */ new Set();
  if (pointerId) keep.add(pointerId);
  for (const id of activated) {
    keep.add(id);
    if (keep.size >= 2) break;
  }
  const snapshotsDirectory = join(marketDataDirectory, "snapshots");
  let entries;
  try {
    entries = await readdir(snapshotsDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name) || keep.has(entry.name)) {
      return;
    }
    await rm(join(snapshotsDirectory, entry.name), { recursive: true, force: true });
  }));
}

// src/main/data-service.ts
function createDataService(directoryOrPaths, marketDataDirectory) {
  const paths2 = typeof directoryOrPaths === "string" ? {
    builtinDataDirectory: directoryOrPaths,
    marketDataDirectory: marketDataDirectory ?? join2(directoryOrPaths, ".market-data")
  } : directoryOrPaths;
  return createService(paths2);
}
function createService(paths2) {
  const cache = /* @__PURE__ */ new Map();
  async function readFirst(pathsToTry) {
    let lastError;
    for (const path of pathsToTry) {
      try {
        return { path, text: await readFile2(path, "utf8") };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  function sharedPaths(name) {
    const candidates = [join2(paths2.builtinDataDirectory, name)];
    if (paths2.legacyBuiltinDataDirectory && paths2.legacyBuiltinDataDirectory !== paths2.builtinDataDirectory) {
      candidates.push(join2(paths2.legacyBuiltinDataDirectory, name));
    }
    return candidates;
  }
  return {
    async readEntryRules() {
      try {
        const { path } = await readFirst(sharedPaths("entry-rules.md"));
        const info = await stat2(path);
        if (info.size > 128 * 1024) return { ok: false, text: "", path, fallback: true, error: "\u89C4\u5219\u6587\u4EF6\u8D85\u8FC7128KB" };
        return { ok: true, text: await readFile2(path, "utf8"), path, modifiedAt: info.mtime.toISOString(), fallback: false };
      } catch (error) {
        const code = error.code;
        const path = sharedPaths("entry-rules.md")[0];
        return { ok: false, text: "", path, fallback: true, error: code === "ENOENT" ? "\u89C4\u5219\u6587\u4EF6\u4E0D\u5B58\u5728" : "\u89C4\u5219\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6" };
      }
    },
    async load(instrument, reload = false) {
      if (!isInstrument(instrument)) return { ok: false, error: "\u4E0D\u652F\u6301\u7684\u884C\u60C5\u6807\u7684" };
      if (reload) cache.delete(instrument);
      const cached = cache.get(instrument);
      if (cached) return { ok: true, data: cached };
      try {
        const definition = instrumentDefinition(instrument);
        const snapshot = await loadEffectiveSnapshot(paths2, definition);
        let auditAvailable = false;
        let anomalies = [];
        try {
          const instrumentDirectory = resolveInstrumentDataDirectories(paths2, definition).builtin;
          const auditPaths = [join2(instrumentDirectory, "cross_source_audit.json")];
          if (definition.id === "main_continuous") {
            auditPaths.push(...sharedPaths("cross_source_audit.json"));
          }
          anomalies = parseAudit((await readFirst([...new Set(auditPaths)])).text);
          auditAvailable = true;
        } catch {
        }
        const data = {
          instrument,
          definition,
          name: definition.name,
          symbol: definition.mainSymbol,
          bars1: snapshot.bars1,
          bars5: snapshot.bars5,
          bars60: snapshot.bars60,
          mainContractMappings: snapshot.mainContractMappings,
          rollovers: snapshot.rollovers,
          anomalies,
          auditAvailable,
          dataDirectory: snapshot.directory,
          snapshotSource: snapshot.source,
          sourceLatestAt: snapshot.sourceLatestAt,
          snapshotUpdatedAt: snapshot.snapshotUpdatedAt
        };
        cache.set(instrument, data);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "\u884C\u60C5\u6570\u636E\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5" };
      }
    },
    invalidate(instrument = "main_continuous") {
      cache.delete(instrument);
    },
    loadSnapshot(instrument) {
      if (!isInstrument(instrument)) {
        return Promise.reject(new Error("\u4E0D\u652F\u6301\u7684\u884C\u60C5\u6807\u7684"));
      }
      return loadEffectiveSnapshot(paths2, instrumentDefinition(instrument));
    },
    paths: paths2
  };
}

// src/main/edb-client.ts
var EDB_SYMBOL = DEFAULT_INSTRUMENT.mainSymbol;
var DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
var EdbClientError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EdbClientError";
  }
  code;
};

// src/main/market-update-coordinator.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
var MINUTE_MS2 = 6e4;
var EMPTY_MINUTE_HISTORY_LOOKBACK_MS = 366 * DAY_MS;
function publicError(error) {
  const code = error instanceof EdbClientError ? error.code : error instanceof Error && /EDB|分钟|日线|行情|候选|合约|换月|匹配|对账|重叠|倒退|时间桶|OHLC/i.test(error.message) ? "validation" : error instanceof Error && /快照|文件|目录|磁盘|ENOSPC|EACCES|EPERM/i.test(error.message) ? "storage" : "unexpected";
  if (error instanceof EdbClientError && code === "network") {
    const status = /HTTP (\d{3})/.exec(error.message)?.[1];
    if (status) return { code, message: `EDB \u8FD4\u56DE HTTP ${status}` };
    if (/超时/.test(error.message)) return { code, message: "EDB \u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" };
    return { code, message: "\u65E0\u6CD5\u8FDE\u63A5 EDB \u6570\u636E\u6E90\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" };
  }
  const messages = {
    network: "\u65E0\u6CD5\u8FDE\u63A5 EDB \u6570\u636E\u6E90\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
    "invalid-response": "EDB \u8FD4\u56DE\u6570\u636E\u65E0\u6548\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
    validation: "EDB \u884C\u60C5\u6821\u9A8C\u5931\u8D25\uFF0C\u5F53\u524D\u6570\u636E\u672A\u53D7\u5F71\u54CD",
    storage: "\u884C\u60C5\u5FEB\u7167\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u78C1\u76D8\u540E\u91CD\u8BD5",
    unexpected: "\u884C\u60C5\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"
  };
  return { code, message: messages[code] };
}
function minuteLatestMs(snapshot) {
  return (snapshot.bars1.at(-1)?.startMs ?? -MINUTE_MS2) + MINUTE_MS2;
}
function requestStartFor(snapshot, requestEndMs = Date.now(), intent = "full") {
  if (intent === "tail") {
    const complete = snapshot.bars60.filter((bar) => bar.complete);
    const anchor = complete.at(-2) ?? complete.at(-1);
    if (anchor) return anchor.startMs;
  }
  const lastMinute = snapshot.bars1.at(-1);
  if (!lastMinute) {
    return Math.floor(
      (requestEndMs - EMPTY_MINUTE_HISTORY_LOOKBACK_MS) / MINUTE_MS2
    ) * MINUTE_MS2;
  }
  const date = formatBeijing(lastMinute.startMs).slice(0, 10);
  return parseBeijing(`${date} 00:00:00`) - DAY_MS;
}
function changed(counts) {
  return Object.values(counts).some((value) => value > 0);
}
function intentPriority(intent) {
  return intent === "full" ? 2 : 1;
}
function assertHistoryCoverageNotRegressed(current, candidate, period) {
  if (!current.length) return;
  const currentFirst = current[0];
  const currentLast = current.at(-1);
  const candidateFirst = candidate[0];
  const candidateLast = candidate.at(-1);
  if (!candidateFirst || !candidateLast || candidateFirst.startMs > currentFirst.startMs || candidateLast.endMs < currentLast.endMs || candidateLast.endMs - candidateFirst.startMs < currentLast.endMs - currentFirst.startMs) {
    throw new Error(`${period} \u5206\u949F\u5019\u9009\u5386\u53F2\u8986\u76D6\u8303\u56F4\u5012\u9000\uFF0C\u5DF2\u62D2\u7EDD\u8986\u76D6\u5F53\u524D\u5FEB\u7167`);
  }
}
function sameMappings(left, right) {
  return left.length === right.length && left.every((mapping, index) => mapping.tradingDate === right[index]?.tradingDate && mapping.contract === right[index]?.contract);
}
function sameRollover(left, right) {
  return left.tradingDate === right.tradingDate && left.timeMs === right.timeMs && left.fromContract === right.fromContract && left.toContract === right.toContract;
}
function rolloverCounts(current, next) {
  const currentByDate = new Map(current.map((rollover) => [rollover.tradingDate, rollover]));
  const nextByDate = new Map(next.map((rollover) => [rollover.tradingDate, rollover]));
  return {
    addedRollovers: next.filter((rollover) => !currentByDate.has(rollover.tradingDate)).length,
    replacedRollovers: next.filter((rollover) => {
      const previous = currentByDate.get(rollover.tradingDate);
      return previous !== void 0 && !sameRollover(previous, rollover);
    }).length,
    removedRollovers: current.filter((rollover) => !nextByDate.has(rollover.tradingDate)).length
  };
}
var MarketUpdateCoordinator = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
  }
  options;
  states = /* @__PURE__ */ new Map();
  slots = /* @__PURE__ */ new Map();
  mappingRefresh = /* @__PURE__ */ new Map();
  now;
  getState(instrument) {
    return structuredClone(
      this.states.get(instrument) ?? { instrument, phase: "idle" }
    );
  }
  update(instrument, intent = "full") {
    const slot = this.slots.get(instrument);
    if (!slot) {
      const created = {};
      this.slots.set(instrument, created);
      return this.startOperation(created, instrument, intent);
    }
    if (slot.pending && intentPriority(slot.pending.intent) >= intentPriority(intent)) {
      return slot.pending.promise;
    }
    if (intentPriority(slot.activeIntent) >= intentPriority(intent)) {
      return slot.activePromise;
    }
    let resolve2;
    let reject;
    const promise = new Promise((accept, fail) => {
      resolve2 = accept;
      reject = fail;
    });
    slot.pending = { intent, promise, resolve: resolve2, reject };
    return promise;
  }
  async updateAll(instruments = INSTRUMENT_IDS) {
    const startedAt = this.now().toISOString();
    const results = [];
    for (const instrument of instruments) {
      results.push(await this.update(instrument, "full"));
    }
    return {
      startedAt,
      completedAt: this.now().toISOString(),
      results
    };
  }
  startOperation(slot, instrument, intent) {
    const operation = this.run(instrumentDefinition(instrument), intent);
    slot.activeIntent = intent;
    slot.activePromise = operation;
    void operation.then(
      () => this.advanceSlot(instrument, slot),
      () => this.advanceSlot(instrument, slot)
    );
    return operation;
  }
  advanceSlot(instrument, slot) {
    if (this.slots.get(instrument) !== slot) return;
    const pending = slot.pending;
    if (!pending) {
      this.slots.delete(instrument);
      return;
    }
    slot.pending = void 0;
    const operation = this.startOperation(slot, instrument, pending.intent);
    void operation.then(pending.resolve, pending.reject);
  }
  async run(definition, intent) {
    const instrument = definition.id;
    const startedAt = this.now().toISOString();
    let mappingRefreshAttempted = false;
    try {
      const current = await this.options.loadSnapshot(definition);
      const requestEndMs = Math.floor(this.now().getTime() / MINUTE_MS2) * MINUTE_MS2;
      const requestStartMs = requestStartFor(current, requestEndMs, intent);
      const localMinuteLatestMs = minuteLatestMs(current);
      this.transition(instrument, {
        phase: "fetching",
        intent,
        startedAt,
        completedAt: void 0,
        localLatestAt: formatBeijing(localMinuteLatestMs),
        localMinuteLatestAt: formatBeijing(localMinuteLatestMs),
        sourceLatestAt: void 0,
        requestStartAt: formatBeijing(requestStartMs),
        requestEndAt: formatBeijing(requestEndMs),
        snapshotUpdatedAt: current.snapshotUpdatedAt,
        counts: void 0,
        error: void 0
      });
      const responseMinutes = await this.options.fetchMinutes(
        definition,
        requestStartMs,
        requestEndMs
      );
      const minutes = responseMinutes.filter(
        (record) => record.startMs + MINUTE_MS2 <= requestEndMs
      );
      if (!minutes.length) throw new Error("EDB \u672A\u8FD4\u56DE\u53EF\u9A8C\u8BC1\u7684\u91CD\u53E0\u5206\u949F\u6570\u636E");
      assertMinuteRecordsValid(minutes, definition.tradingSessions);
      const sourceLatestMs = minutes.at(-1).startMs + MINUTE_MS2;
      const sourceLatestAt = formatBeijing(sourceLatestMs);
      this.transition(instrument, { phase: "validating", sourceLatestAt });
      if (current.bars1.length) {
        const localMinuteStarts = new Set(current.bars1.map((record) => record.startMs));
        if (!minutes.some((record) => localMinuteStarts.has(record.startMs))) {
          throw new Error("EDB \u589E\u91CF\u533A\u95F4\u4E0E\u5F53\u524D\u5206\u949F\u5FEB\u7167\u6CA1\u6709\u53EF\u9A8C\u8BC1\u91CD\u53E0");
        }
      }
      const minuteMerge = mergeMinuteHistory(current.bars1, minutes);
      const rebuildMinutes = minuteMerge.records.filter(
        (record) => record.startMs >= requestStartMs
      );
      const coverageEndMs = Math.max(sourceLatestMs, minuteLatestMs(current));
      const rebuilt5 = aggregateMinutes(
        rebuildMinutes,
        5,
        coverageEndMs,
        definition.tradingSessions
      ).filter((bar) => bar.complete);
      const sixtyMinuteFormat = detectSixtyMinuteBarFormat(
        current.bars60,
        definition.tradingSessions,
        "legacy"
      );
      const rebuilt60 = (sixtyMinuteFormat === "segmented" ? aggregateFiveMinuteBars(rebuilt5, definition.tradingSessions) : aggregateMinutes(
        rebuildMinutes,
        60,
        coverageEndMs,
        definition.tradingSessions
      )).filter((bar) => bar.complete);
      const five = rebuilt5.length ? mergeBars(
        current.bars5,
        rebuilt5,
        Math.max(requestStartMs, rebuilt5[0].startMs)
      ) : {
        bars: [...current.bars5],
        added: 0,
        replaced: 0,
        removed: 0
      };
      const sixty = rebuilt60.length ? mergeBars(
        current.bars60,
        rebuilt60,
        Math.max(requestStartMs, rebuilt60[0].startMs)
      ) : {
        bars: [...current.bars60],
        added: 0,
        replaced: 0,
        removed: 0
      };
      assertMinuteRecordsValid(minuteMerge.records, definition.tradingSessions);
      assertBarsValid(five.bars, 5, definition.tradingSessions);
      reconcileCompatibleBars(five.bars, sixty.bars, definition.tradingSessions);
      assertHistoryCoverageNotRegressed(current.bars5, five.bars, 5);
      assertHistoryCoverageNotRegressed(current.bars60, sixty.bars, 60);
      const requestBeijingDate = formatBeijing(requestEndMs).slice(0, 10);
      const latestTradingDate = minuteMerge.records.at(-1)?.start.slice(0, 10);
      const mappingState = this.mappingRefresh.get(instrument);
      const needsMappingRefresh = intent === "full" || !mappingState || mappingState.failed || mappingState.beijingDate !== requestBeijingDate || latestTradingDate !== void 0 && !current.mainContractMappings.some(
        (mapping) => mapping.tradingDate === latestTradingDate
      );
      let mappings = current.mainContractMappings;
      if (needsMappingRefresh) {
        mappingRefreshAttempted = true;
        const mappingStartMs = intent === "tail" ? parseBeijing(`${requestBeijingDate} 00:00:00`) - DAY_MS : requestStartMs;
        const remoteMappings = await this.options.fetchContractMappings(
          definition,
          mappingStartMs,
          requestEndMs
        );
        mappings = mergeMainContractMappings(
          current.mainContractMappings,
          remoteMappings,
          definition
        );
        this.mappingRefresh.set(instrument, {
          beijingDate: requestBeijingDate,
          failed: false
        });
      }
      const rollovers = detectContractRollovers(mappings, five.bars, definition);
      const counts = {
        ...updateCounts(minuteMerge, five, sixty),
        ...rolloverCounts(current.rollovers, rollovers)
      };
      const mappingsChanged = !sameMappings(current.mainContractMappings, mappings);
      if (!changed(counts) && !mappingsChanged) {
        this.transition(instrument, {
          phase: "up-to-date",
          completedAt: this.now().toISOString(),
          localLatestAt: formatBeijing(minuteLatestMs(current)),
          localMinuteLatestAt: formatBeijing(minuteLatestMs(current)),
          sourceLatestAt,
          counts,
          error: void 0
        });
        return this.getState(instrument);
      }
      this.transition(instrument, { phase: "saving", counts });
      const saved = await this.options.saveSnapshot(definition, {
        bars1: minuteMerge.records,
        bars5: five.bars,
        bars60: sixty.bars,
        mainContractMappings: mappings,
        rollovers,
        requestStart: formatBeijing(requestStartMs),
        requestEnd: formatBeijing(requestEndMs),
        sourceLatestAt
      });
      this.options.invalidate(instrument);
      if (!saved.snapshotUpdatedAt) {
        throw new Error("\u5FEB\u7167\u6FC0\u6D3B\u65F6\u95F4\u7F3A\u5931");
      }
      this.transition(instrument, {
        phase: "succeeded",
        completedAt: this.now().toISOString(),
        localLatestAt: formatBeijing(minuteLatestMs(saved)),
        localMinuteLatestAt: formatBeijing(minuteLatestMs(saved)),
        sourceLatestAt,
        snapshotUpdatedAt: saved.snapshotUpdatedAt,
        counts,
        error: void 0
      });
      this.options.publishActivation?.({
        instrument,
        snapshotUpdatedAt: saved.snapshotUpdatedAt,
        counts: structuredClone(counts),
        mappingsChanged
      });
    } catch (error) {
      if (mappingRefreshAttempted) {
        this.mappingRefresh.set(instrument, {
          ...this.mappingRefresh.get(instrument),
          failed: true
        });
      }
      this.transition(instrument, {
        phase: "failed",
        completedAt: this.now().toISOString(),
        error: publicError(error)
      });
    }
    return this.getState(instrument);
  }
  transition(instrument, patch) {
    const state = {
      ...this.getState(instrument),
      ...patch,
      instrument
    };
    this.states.set(instrument, state);
    this.options.publish(structuredClone(state));
  }
};

// src/main/online-tail-performance-cli.ts
var MINUTE_MS3 = 6e4;
var PERFORMANCE_THRESHOLD_MS = 2e4;
var SAMPLE_COUNT = 20;
var LONG_HISTORY_START = "2015-04-16";
var RECENT_MINUTE_START = "2025-10-13";
var BASELINE_END = "2026-10-09";
var MEASURED_DATE = "2026-10-12";
var CONTRACT = "m2701";
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function dateRange(start, end) {
  const dates = [];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let current = startMs; current <= endMs; current += 24 * 60 * MINUTE_MS3) {
    const day = new Date(current).getUTCDay();
    if (day >= 1 && day <= 5) dates.push(isoDate(current));
  }
  return dates;
}
function priceFields(index) {
  const open = 2500 + index % 1e3 * 0.1;
  const close = open + (index % 2 === 0 ? 0.2 : -0.2);
  return {
    open,
    high: Math.max(open, close) + 0.4,
    low: Math.min(open, close) - 0.4,
    close,
    volume: 10 + index % 90,
    openOi: 1e5 + index,
    closeOi: 100001 + index
  };
}
function generateFiveMinuteHistory(start, end) {
  const bars = [];
  let index = 0;
  for (const date of dateRange(start, end)) {
    const dayStartMs = parseBeijing(`${date} 00:00:00`);
    for (const session of DEFAULT_INSTRUMENT.tradingSessions) {
      for (const segment of session.segments) {
        for (let minute = segment.startMinute; minute < segment.endMinute; minute += 5) {
          const startMs = dayStartMs + minute * MINUTE_MS3;
          const endMs = startMs + 5 * MINUTE_MS3;
          bars.push({
            startMs,
            endMs,
            start: formatBeijing(startMs),
            end: formatBeijing(endMs),
            ...priceFields(index),
            session: session.id,
            observedMinutes: 5,
            expectedMinutes: 5,
            complete: true
          });
          index += 1;
        }
      }
    }
  }
  return bars;
}
function minuteRecord(startMs, index) {
  return {
    datetimeNano: (BigInt(startMs) * 1000000n).toString(),
    startMs,
    start: formatBeijing(startMs),
    ...priceFields(index)
  };
}
function generateMinuteHistory(start, end) {
  const records = [];
  let index = 0;
  for (const date of dateRange(start, end)) {
    const dayStartMs = parseBeijing(`${date} 00:00:00`);
    for (const session of DEFAULT_INSTRUMENT.tradingSessions) {
      for (const segment of session.segments) {
        for (let minute = segment.startMinute; minute < segment.endMinute; minute += 1) {
          records.push(minuteRecord(dayStartMs + minute * MINUTE_MS3, index));
          index += 1;
        }
      }
    }
  }
  return records;
}
function generateMeasuredMinutes(startIndex) {
  const dayStartMs = parseBeijing(`${MEASURED_DATE} 00:00:00`);
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => minuteRecord(dayStartMs + (9 * 60 + index) * MINUTE_MS3, startIndex + index));
}
async function directorySize(path) {
  const info = await stat3(path);
  if (info.isFile()) return info.size;
  let total = 0;
  for (const entry of await readdir2(path, { withFileTypes: true })) {
    total += await directorySize(join3(path, entry.name));
  }
  return total;
}
async function retainedSnapshotCount(paths2) {
  const directory = join3(
    paths2.marketDataDirectory,
    "instruments",
    DEFAULT_INSTRUMENT.id,
    "snapshots"
  );
  return (await readdir2(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
}
async function stagingDirectoryCount(paths2) {
  const directory = join3(
    paths2.marketDataDirectory,
    "instruments",
    DEFAULT_INSTRUMENT.id
  );
  return (await readdir2(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-")).length;
}
function percentile95(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}
function fixed(value) {
  return value.toFixed(2);
}
function requireTiming(value, label, sample) {
  if (value === void 0) {
    assert.fail(`\u6837\u672C ${sample} \u7F3A\u5C11 ${label} \u8BA1\u65F6`);
  }
  return value;
}
function markdownReport(report) {
  const p95 = report.summary.p95;
  return `# \u5728\u7EBF\u5C3E\u90E8\u66F4\u65B0\u6027\u80FD\u9A8C\u6536

## \u7ED3\u8BBA

- \u9A8C\u6536\u65F6\u95F4\uFF1A${report.generatedAt}
- \u7ED3\u679C\uFF1A${report.passed ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7"}
- \u53D1\u5E03\u51B3\u7B56\uFF1A${report.decision}
- \u6837\u672C\u6570\uFF1A${report.summary.sampleCount}
- \u7AEF\u5230\u7AEF p95\uFF1A${fixed(p95.endToEndMs)} ms
- \u95E8\u69DB\uFF1A\u4E25\u683C\u4F4E\u4E8E ${report.summary.thresholdMs} ms

## \u73AF\u5883

- \u64CD\u4F5C\u7CFB\u7EDF\uFF1A${report.environment.operatingSystem}
- Node.js\uFF1A${report.environment.node}
- CPU\uFF1A${report.environment.cpu}
- \u903B\u8F91\u5904\u7406\u5668\uFF1A${report.environment.logicalCpuCount}
- \u5185\u5B58\uFF1A${fixed(report.environment.totalMemoryGiB)} GiB

## \u56FA\u5B9A\u5939\u5177

- \u5939\u5177 SHA-256\uFF1A\`${report.fixture.sha256}\`
- \u8FDC\u7AEF\u5206\u949F\u8BB0\u5F55\uFF1A${report.fixture.remoteRows}
- \u57FA\u7EBF 1 \u5206\u949F\u8BB0\u5F55\uFF1A${report.fixture.bars1}
- \u57FA\u7EBF 5 \u5206\u949F\u8BB0\u5F55\uFF1A${report.fixture.bars5}
- \u57FA\u7EBF 60 \u5206\u949F\u8BB0\u5F55\uFF1A${report.fixture.bars60}

## p95 \u5206\u9636\u6BB5\u7ED3\u679C

| \u9636\u6BB5 | p95 (ms) |
| --- | ---: |
| \u4E0B\u8F7D/\u8BFB\u53D6\u4E0E\u89E3\u6790 | ${fixed(p95.downloadReadParseMs)} |
| \u805A\u5408\u4E0E\u5019\u9009\u6784\u5EFA | ${fixed(p95.aggregationMs)} |
| \u5E8F\u5217\u5316 | ${fixed(p95.serializationMs)} |
| \u6587\u4EF6\u5199\u5165 | ${fixed(p95.writeMs)} |
| \u5019\u9009\u6821\u9A8C | ${fixed(p95.validationMs)} |
| \u539F\u5B50\u6FC0\u6D3B\u4E0E\u6E05\u7406 | ${fixed(p95.activationMs)} |
| \u5FEB\u7167\u5185\u90E8\u91CD\u8F7D | ${fixed(p95.snapshotReloadMs)} |
| \u6570\u636E\u670D\u52A1\u91CD\u8F7D | ${fixed(p95.serviceReloadMs)} |
| \u7AEF\u5230\u7AEF | ${fixed(p95.endToEndMs)} |

## \u5B58\u50A8\u4E0E\u4E32\u884C\u6027

- \u9996\u4E2A\u6D4B\u91CF\u524D\u6D3B\u52A8\u5FEB\u7167\uFF1A${report.summary.baselineActiveSnapshotBytes} bytes
- \u6700\u7EC8\u6D3B\u52A8\u5FEB\u7167\uFF1A${report.summary.finalActiveSnapshotBytes} bytes
- \u9996\u4E2A\u6D4B\u91CF\u524D\u884C\u60C5\u76EE\u5F55\uFF1A${report.summary.baselineMarketDataBytes} bytes
- \u6700\u7EC8\u884C\u60C5\u76EE\u5F55\uFF1A${report.summary.finalMarketDataBytes} bytes
- \u5CF0\u503C\u884C\u60C5\u76EE\u5F55\uFF1A${report.summary.peakMarketDataBytes} bytes
- \u8FDE\u7EED\u8FD0\u884C\u6700\u7EC8\u78C1\u76D8\u589E\u957F\uFF1A${report.summary.diskGrowthBytes} bytes
- \u8FDE\u7EED\u8FD0\u884C\u5CF0\u503C\u78C1\u76D8\u589E\u957F\uFF1A${report.summary.peakDiskGrowthBytes} bytes
- \u6700\u5927\u5E76\u53D1\u66F4\u65B0\uFF1A${report.summary.maximumActiveUpdates}
- \u6700\u5927\u5E76\u53D1\u5019\u9009\u5199\u5165\uFF1A${report.summary.maximumActiveSaves}
- \u6700\u5927\u4FDD\u7559\u5FEB\u7167\u6570\uFF1A${report.summary.maximumRetainedSnapshots}
- \u9057\u7559 staging \u76EE\u5F55\uFF1A${report.summary.stagingDirectoryCount}

## \u65B9\u6CD5

\u573A\u666F\u4F7F\u7528\u751F\u4EA7 \`MarketUpdateCoordinator\`\u3001\`saveMarketSnapshot()\` \u548C\u6570\u636E\u670D\u52A1\u91CD\u8F7D\u8DEF\u5F84\u3002\u5939\u5177\u5305\u542B\u4ECE ${LONG_HISTORY_START} \u5230 ${BASELINE_END} \u7684\u76EE\u6807\u4F53\u91CF 5/60 \u5206\u949F\u5386\u53F2\uFF0C\u4EE5\u53CA\u4ECE ${RECENT_MINUTE_START} \u5F00\u59CB\u7684\u8FD1\u671F\u540E\u53F0 1 \u5206\u949F\u5C3E\u90E8\u3002\u5148\u6267\u884C\u4E00\u6B21\u5B8C\u6574\u8865\u9F50\u9884\u70ED\uFF0C\u518D\u6309\u5317\u4EAC\u65F6\u95F4 ${MEASURED_DATE} 09:01:05 \u81F3 09:20:05 \u4E32\u884C\u6267\u884C 20 \u6B21\u5355\u5206\u949F\u5C3E\u90E8\u66F4\u65B0\uFF1B\u6BCF\u8F6E\u7ED3\u675F\u5E76\u5B8C\u6210\u6570\u636E\u670D\u52A1\u91CD\u8F7D\u540E\u624D\u5F00\u59CB\u4E0B\u4E00\u8F6E\u3002
`;
}
var root = resolve(".");
var sandbox = await mkdtemp(join3(tmpdir(), "moneycoming-online-tail-performance-"));
assert.ok(resolve(sandbox).startsWith(resolve(tmpdir())));
var paths = {
  builtinDataDirectory: join3(sandbox, "builtin"),
  marketDataDirectory: join3(sandbox, "market-data")
};
var fixturePath = join3(sandbox, "remote-minute-tail.csv");
var artifactDirectory = join3(root, "artifacts");
var documentationPath = join3(root, "docs", "\u5728\u7EBF\u5C3E\u90E8\u6027\u80FD\u9A8C\u6536.md");
try {
  const recentMinutes = generateMinuteHistory(RECENT_MINUTE_START, BASELINE_END);
  const historicalBars5 = generateFiveMinuteHistory(
    LONG_HISTORY_START,
    "2025-10-10"
  );
  const recentBars5 = aggregateMinutes(
    recentMinutes,
    5,
    recentMinutes.at(-1).startMs + MINUTE_MS3,
    DEFAULT_INSTRUMENT.tradingSessions
  ).filter((bar) => bar.complete);
  const bars5 = [...historicalBars5, ...recentBars5];
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    DEFAULT_INSTRUMENT.tradingSessions
  ).filter((bar) => bar.complete);
  const sourceLatestAt = formatBeijing(recentMinutes.at(-1).startMs + MINUTE_MS3);
  const baselineCandidate = {
    bars1: recentMinutes,
    bars5,
    bars60,
    mainContractMappings: [
      { tradingDate: BASELINE_END, contract: CONTRACT }
    ],
    rollovers: [],
    requestStart: `${LONG_HISTORY_START} 09:00:00`,
    requestEnd: sourceLatestAt,
    sourceLatestAt
  };
  await writeBuiltinMarketSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    baselineCandidate,
    { now: () => /* @__PURE__ */ new Date("2026-10-09T15:00:00.000Z") }
  );
  const fridayNight = recentMinutes.filter((record) => record.start >= `${BASELINE_END} 21:00:00`);
  const measuredMinutes = generateMeasuredMinutes(recentMinutes.length);
  const remoteMinutes = [...fridayNight, ...measuredMinutes];
  const fixtureText = serializeMinuteRecords(
    remoteMinutes,
    DEFAULT_INSTRUMENT.tradingSessions
  );
  await writeFile2(fixturePath, fixtureText, "utf8");
  const fixtureSha256 = createHash2("sha256").update(fixtureText).digest("hex");
  const service = createDataService(paths);
  let now = /* @__PURE__ */ new Date("2026-10-12T09:00:05+08:00");
  let snapshotSequence = 0;
  let activeMeasurement;
  let activeUpdates = 0;
  let maximumActiveUpdates = 0;
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const publishedStates = [];
  const coordinator = new MarketUpdateCoordinator({
    loadSnapshot: (definition) => service.loadSnapshot(definition.id),
    fetchMinutes: async (_definition, startMs, endMs) => {
      const started = performance2.now();
      const parsed = parseEdbMinuteCsv(
        await readFile3(fixturePath, "utf8"),
        "\u56FA\u5B9A\u5728\u7EBF\u5C3E\u90E8\u6027\u80FD\u5939\u5177",
        DEFAULT_INSTRUMENT.tradingSessions
      ).filter((record) => record.startMs >= startMs && record.startMs < endMs);
      if (activeMeasurement) {
        activeMeasurement.downloadReadParseMs = performance2.now() - started;
        activeMeasurement.fetchCompletedAt = performance2.now();
      }
      return parsed;
    },
    fetchContractMappings: async () => [
      { tradingDate: MEASURED_DATE, contract: CONTRACT }
    ],
    saveSnapshot: async (definition, candidate) => {
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      if (activeMeasurement) {
        activeMeasurement.saveCount += 1;
        activeMeasurement.aggregationMs = performance2.now() - requireTiming(
          activeMeasurement.fetchCompletedAt,
          "fetchCompletedAt",
          activeMeasurement.sample
        );
      }
      const snapshotId = `performance-${String(++snapshotSequence).padStart(3, "0")}`;
      try {
        return await saveMarketSnapshot(paths, definition, candidate, {
          now: () => new Date(now.getTime()),
          idFactory: () => snapshotId,
          onTiming: (phase, durationMs) => {
            if (activeMeasurement) {
              activeMeasurement.savePhases[phase] = durationMs;
            }
          }
        });
      } finally {
        activeSaves -= 1;
      }
    },
    invalidate: (instrument) => service.invalidate(instrument),
    publish: (state) => publishedStates.push(state),
    now: () => new Date(now.getTime())
  });
  const warmup = await coordinator.update(DEFAULT_INSTRUMENT.id, "full");
  assert.equal(warmup.phase, "succeeded", JSON.stringify(warmup));
  const warmupLoad = await service.load(DEFAULT_INSTRUMENT.id, true);
  assert.equal(warmupLoad.ok, true);
  const baselineActiveSnapshotBytes = await directorySize(
    warmupLoad.data.dataDirectory
  );
  const baselineMarketDataBytes = await directorySize(paths.marketDataDirectory);
  const samples = [];
  for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
    const minuteText = String(sample).padStart(2, "0");
    now = /* @__PURE__ */ new Date(`${MEASURED_DATE}T09:${minuteText}:05+08:00`);
    const measurement = {
      sample,
      savePhases: {},
      saveCount: 0
    };
    activeMeasurement = measurement;
    activeUpdates += 1;
    maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
    const started = performance2.now();
    try {
      const state = await coordinator.update(DEFAULT_INSTRUMENT.id, "tail");
      const updateMs = performance2.now() - started;
      assert.equal(state.phase, "succeeded", JSON.stringify(state));
      assert.equal(state.intent, "tail");
      assert.equal(measurement.saveCount, 1);
      const serviceReloadStarted = performance2.now();
      const loaded = await service.load(DEFAULT_INSTRUMENT.id, true);
      const serviceReloadMs = performance2.now() - serviceReloadStarted;
      assert.equal(loaded.ok, true);
      assert.equal(
        loaded.data.bars1.length,
        recentMinutes.length + sample
      );
      const endToEndMs = performance2.now() - started;
      const activeSnapshotBytes = await directorySize(loaded.data.dataDirectory);
      const marketDataBytes = await directorySize(paths.marketDataDirectory);
      samples.push({
        sample,
        requestEndAt: formatBeijing(now.getTime()).slice(0, 16) + ":00",
        downloadReadParseMs: requireTiming(
          measurement.downloadReadParseMs,
          "downloadReadParseMs",
          sample
        ),
        aggregationMs: requireTiming(
          measurement.aggregationMs,
          "aggregationMs",
          sample
        ),
        serializationMs: requireTiming(
          measurement.savePhases.serialization,
          "serialization",
          sample
        ),
        writeMs: requireTiming(measurement.savePhases.write, "write", sample),
        validationMs: requireTiming(
          measurement.savePhases.validation,
          "validation",
          sample
        ),
        activationMs: requireTiming(
          measurement.savePhases.activation,
          "activation",
          sample
        ),
        snapshotReloadMs: requireTiming(
          measurement.savePhases.reload,
          "reload",
          sample
        ),
        serviceReloadMs,
        updateMs,
        endToEndMs,
        activeSnapshotBytes,
        marketDataBytes,
        retainedSnapshotCount: await retainedSnapshotCount(paths),
        snapshotUpdatedAt: state.snapshotUpdatedAt,
        sourceLatestAt: state.sourceLatestAt,
        added1: state.counts.added1,
        added5: state.counts.added5,
        added60: state.counts.added60
      });
    } finally {
      activeUpdates -= 1;
      activeMeasurement = void 0;
    }
  }
  const phaseKeys = [
    "downloadReadParseMs",
    "aggregationMs",
    "serializationMs",
    "writeMs",
    "validationMs",
    "activationMs",
    "snapshotReloadMs",
    "serviceReloadMs",
    "updateMs",
    "endToEndMs"
  ];
  const p95 = Object.fromEntries(
    phaseKeys.map((key) => [key, percentile95(samples.map((sample) => sample[key]))])
  );
  const finalSample = samples.at(-1);
  const peakMarketDataBytes = Math.max(
    baselineMarketDataBytes,
    ...samples.map((sample) => sample.marketDataBytes)
  );
  const stagingCount = await stagingDirectoryCount(paths);
  const allSucceeded = samples.length === SAMPLE_COUNT && samples.every((sample) => sample.added1 === 1);
  const passed = p95.endToEndMs < PERFORMANCE_THRESHOLD_MS && allSucceeded && maximumActiveUpdates === 1 && maximumActiveSaves === 1 && samples.every((sample) => sample.retainedSnapshotCount <= 2) && stagingCount === 0;
  const decision = passed ? "\u5B8C\u6574\u539F\u5B50\u5FEB\u7167\u8FBE\u5230\u6027\u80FD\u95E8\u69DB\uFF0C\u65E0\u9700\u5F15\u5165\u589E\u91CF\u5C42\u3002" : "\u5B8C\u6574\u539F\u5B50\u5FEB\u7167\u672A\u8FBE\u5230\u6027\u80FD\u95E8\u69DB\uFF0C\u53D1\u5E03\u524D\u5FC5\u987B\u5B9E\u73B0\u5DF2\u9A8C\u8BC1\u57FA\u7840\u5FEB\u7167\u3001\u6709\u754C\u5C3E\u90E8\u589E\u91CF\u548C\u5B9A\u671F\u538B\u5B9E\uFF0C\u5E76\u91CD\u65B0\u6D4B\u91CF\u3002";
  const report = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    passed,
    gate: {
      metric: "endToEndMs.p95",
      comparison: "<",
      thresholdMs: PERFORMANCE_THRESHOLD_MS,
      actualMs: p95.endToEndMs
    },
    environment: {
      operatingSystem: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryGiB: totalmem() / 2 ** 30
    },
    fixture: {
      path: fixturePath,
      sha256: fixtureSha256,
      remoteRows: remoteMinutes.length,
      fridayOverlapRows: fridayNight.length,
      measuredRows: measuredMinutes.length,
      historyStart: LONG_HISTORY_START,
      recentMinuteStart: RECENT_MINUTE_START,
      baselineEnd: BASELINE_END,
      bars1: recentMinutes.length,
      bars5: bars5.length,
      bars60: bars60.length
    },
    warmup: {
      intent: warmup.intent,
      phase: warmup.phase,
      sourceLatestAt: warmup.sourceLatestAt,
      snapshotUpdatedAt: warmup.snapshotUpdatedAt
    },
    summary: {
      sampleCount: SAMPLE_COUNT,
      thresholdMs: PERFORMANCE_THRESHOLD_MS,
      p95,
      baselineActiveSnapshotBytes,
      finalActiveSnapshotBytes: finalSample.activeSnapshotBytes,
      baselineMarketDataBytes,
      finalMarketDataBytes: finalSample.marketDataBytes,
      peakMarketDataBytes,
      diskGrowthBytes: finalSample.marketDataBytes - baselineMarketDataBytes,
      peakDiskGrowthBytes: peakMarketDataBytes - baselineMarketDataBytes,
      maximumActiveUpdates,
      maximumActiveSaves,
      maximumRetainedSnapshots: Math.max(
        ...samples.map((sample) => sample.retainedSnapshotCount)
      ),
      stagingDirectoryCount: stagingCount,
      publishedSucceededStates: publishedStates.filter(
        (state) => state.phase === "succeeded"
      ).length
    },
    samples,
    decision
  };
  const markdown = markdownReport(report);
  await mkdir2(artifactDirectory, { recursive: true });
  await mkdir2(resolve(documentationPath, ".."), { recursive: true });
  await writeFile2(
    join3(artifactDirectory, "online-tail-performance.json"),
    `${JSON.stringify(report, null, 2)}
`,
    "utf8"
  );
  await writeFile2(
    join3(artifactDirectory, "online-tail-performance.md"),
    markdown,
    "utf8"
  );
  await writeFile2(documentationPath, markdown, "utf8");
  console.log(JSON.stringify({
    passed,
    sampleCount: SAMPLE_COUNT,
    endToEndP95Ms: p95.endToEndMs,
    thresholdMs: PERFORMANCE_THRESHOLD_MS,
    maximumActiveSaves,
    diskGrowthBytes: report.summary.diskGrowthBytes,
    decision
  }));
  assert.equal(passed, true, decision);
} finally {
  await rm2(sandbox, { recursive: true, force: true });
}
