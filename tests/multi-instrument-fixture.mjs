import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BOM = '\uFEFF';
const CRLF = '\r\n';
const MINUTE_HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const BAR_HEADER = 'bar_start,bar_end,session,open,high,low,close,volume,open_oi,close_oi,observed_minutes,expected_minutes,complete';
const ROLLOVER_HEADER = 'trading_date,time,from_contract,to_contract';
const MAPPING_HEADER = 'trading_date,contract';

export const MULTI_INSTRUMENT_DEFINITIONS = [
  { id: 'main_continuous', name: '豆粕主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.m', productCode: 'm', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'rapeseed_meal_main', name: '菜粕主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.RM', productCode: 'RM', expiryDigits: 3, contractMultiplier: 10 },
  { id: 'pvc_main', name: 'PVC主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.v', productCode: 'v', expiryDigits: 4, contractMultiplier: 5 },
  { id: 'rebar_main', name: '螺纹钢主连', exchangeName: '上期所', mainSymbol: 'KQ.m@SHFE.rb', productCode: 'rb', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'glass_main', name: '玻璃主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.FG', productCode: 'FG', expiryDigits: 3, contractMultiplier: 20 },
  { id: 'rapeseed_oil_main', name: '菜油主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.OI', productCode: 'OI', expiryDigits: 3, contractMultiplier: 10 },
  { id: 'palm_oil_main', name: '棕榈油主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.p', productCode: 'p', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'soybean_oil_main', name: '豆油主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.y', productCode: 'y', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'pulp_main', name: '纸浆主连', exchangeName: '上期所', mainSymbol: 'KQ.m@SHFE.sp', productCode: 'sp', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'corn_main', name: '玉米主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.c', productCode: 'c', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'soda_ash_main', name: '纯碱主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.SA', productCode: 'SA', expiryDigits: 3, contractMultiplier: 20 },
  { id: 'soybean_1_main', name: '豆一主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.a', productCode: 'a', expiryDigits: 4, contractMultiplier: 10 },
  { id: 'methanol_main', name: '甲醇主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.MA', productCode: 'MA', expiryDigits: 3, contractMultiplier: 10 },
  { id: 'sugar_main', name: '白糖主连', exchangeName: '郑商所', mainSymbol: 'KQ.m@CZCE.SR', productCode: 'SR', expiryDigits: 3, contractMultiplier: 10 },
  { id: 'soybean_2_main', name: '豆二主连', exchangeName: '大商所', mainSymbol: 'KQ.m@DCE.b', productCode: 'b', expiryDigits: 4, contractMultiplier: 10 },
];

const LOCAL_DATES = ['2026-10-08', '2026-10-09'];
const REMOTE_DATES = [...LOCAL_DATES, '2026-10-12'];

function csv(header, rows) {
  return `${BOM}${[header, ...rows].join(CRLF)}${CRLF}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function minuteTime(date, minute) {
  return `${date} 09:${String(minute).padStart(2, '0')}:00`;
}

function minuteStartMs(date, minute) {
  return Date.parse(`${date}T09:${String(minute).padStart(2, '0')}:00+08:00`);
}

function minuteRecords(dates, baseOffset = 0) {
  return dates.flatMap((date, dateIndex) => Array.from({ length: 60 }, (_, minute) => {
    const open = 3000 + baseOffset + dateIndex * 10 + Math.floor(minute / 10);
    const openOi = 100_000 + dateIndex * 1_000 + minute * 10;
    return {
      datetimeNano: String(BigInt(minuteStartMs(date, minute)) * 1_000_000n),
      start: minuteTime(date, minute),
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: 100 + minute,
      openOi,
      closeOi: openOi + 10,
    };
  }));
}

function serializeMinutes(records) {
  return csv(MINUTE_HEADER, records.map(record => [
    record.datetimeNano,
    record.open,
    record.high,
    record.low,
    record.close,
    record.volume,
    record.openOi,
    record.closeOi,
  ].join(',')));
}

function barEnd(date, endMinute) {
  if (endMinute === 60) return `${date} 10:00:00`;
  return minuteTime(date, endMinute);
}

function aggregate(records, period) {
  const bars = [];
  for (let offset = 0; offset < records.length; offset += 60) {
    const day = records.slice(offset, offset + 60);
    const date = day[0].start.slice(0, 10);
    for (let start = 0; start < 60; start += period) {
      const part = day.slice(start, start + period);
      bars.push({
        start: minuteTime(date, start),
        end: barEnd(date, start + period),
        open: part[0].open,
        high: Math.max(...part.map(record => record.high)),
        low: Math.min(...part.map(record => record.low)),
        close: part.at(-1).close,
        volume: part.reduce((sum, record) => sum + record.volume, 0),
        openOi: part[0].openOi,
        closeOi: part.at(-1).closeOi,
        observedMinutes: period,
        expectedMinutes: period,
      });
    }
  }
  return bars;
}

function serializeBars(bars) {
  return csv(BAR_HEADER, bars.map(bar => [
    bar.start,
    bar.end,
    'day',
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.openOi,
    bar.closeOi,
    bar.observedMinutes,
    bar.expectedMinutes,
    'True',
  ].join(',')));
}

function contract(definition, expiry) {
  const suffix = definition.expiryDigits === 3 ? expiry.slice(1) : expiry;
  return `${definition.productCode}${suffix}`;
}

function rolloverData(definition) {
  const oldContract = contract(definition, '2609');
  const newContract = contract(definition, '2701');
  const hasRollover = definition.id === 'main_continuous'
    || definition.id === 'rapeseed_meal_main';
  return {
    rollovers: hasRollover
      ? csv(ROLLOVER_HEADER, [`2026-10-09,2026-10-09 09:00:00,${oldContract},${newContract}`])
      : csv(ROLLOVER_HEADER, []),
    mappings: csv(MAPPING_HEADER, [
      `2026-10-08,${oldContract}`,
      `2026-10-09,${hasRollover ? newContract : oldContract}`,
    ]),
    rolloverRows: hasRollover ? 1 : 0,
  };
}

async function writeInstrumentSnapshot(root, definition, index) {
  const records = minuteRecords(LOCAL_DATES, index * 100);
  const bars5 = aggregate(records, 5);
  const bars60 = aggregate(records, 60);
  const rollover = rolloverData(definition);
  const files = {
    bars1: {
      name: 'edb_main_continuous_1m_raw.csv',
      text: serializeMinutes(records),
      rows: records.length,
    },
    bars5: {
      name: 'edb_main_continuous_5m.csv',
      text: serializeBars(bars5),
      rows: bars5.length,
    },
    bars60: {
      name: 'edb_main_continuous_60m.csv',
      text: serializeBars(bars60),
      rows: bars60.length,
    },
    rollovers: {
      name: 'edb_main_continuous_rollovers.csv',
      text: rollover.rollovers,
      rows: rollover.rolloverRows,
    },
    mainContractMappings: {
      name: 'edb_main_contract_mapping.csv',
      text: rollover.mappings,
      rows: 2,
    },
  };
  const directory = join(root, 'instruments', definition.id);
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.values(files).map(file => (
    writeFile(join(directory, file.name), file.text, 'utf8')
  )));
  const metadata = {
    schemaVersion: 4,
    snapshotId: `builtin-${definition.id}`,
    instrumentId: definition.id,
    mainSymbol: definition.mainSymbol,
    parameterVersion: 1,
    source: {
      provider: 'EDB',
      endpoint: 'https://edb.shinnytech.com/md/kline',
      symbol: definition.mainSymbol,
    },
    generatedAt: '2026-10-18T00:00:00.000Z',
    requestStart: '2026-10-08 09:00:00',
    requestEnd: '2026-10-09 10:00:00',
    sourceLatestAt: '2026-10-09 10:00:00',
    files: Object.fromEntries(Object.entries(files).map(([key, file]) => [
      key,
      { name: file.name, sha256: sha256(file.text), rows: file.rows },
    ])),
  };
  await writeFile(
    join(directory, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}

export async function createMultiInstrumentFixture(root) {
  await mkdir(root, { recursive: true });
  await Promise.all(MULTI_INSTRUMENT_DEFINITIONS.map(
    (definition, index) => writeInstrumentSnapshot(root, definition, index),
  ));
  const remoteFixturePath = join(root, 'edb-remote-1m.csv');
  await writeFile(
    remoteFixturePath,
    serializeMinutes(minuteRecords(REMOTE_DATES)),
    'utf8',
  );
  return {
    builtinDataDirectory: root,
    remoteFixturePath,
    priceOffsets: Object.fromEntries(MULTI_INSTRUMENT_DEFINITIONS.map(
      (definition, index) => [definition.id, index * 100],
    )),
    expected: Object.fromEntries(MULTI_INSTRUMENT_DEFINITIONS.map(
      (definition, index) => [definition.id, {
        ...definition,
        initialLastClose: 3000 + index * 100 + 10 + 6,
        updatedLastClose: 3000 + index * 100 + 20 + 6,
      }],
    )),
  };
}
