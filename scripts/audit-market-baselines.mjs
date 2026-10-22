import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENT_LIST } from '../src/shared/instruments.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIRECTORY = join(ROOT, 'data');
const OUTPUT = join(DATA_DIRECTORY, 'history-extension-baseline-audit.json');

const FILES = {
  bars1: 'edb_main_continuous_1m_raw.csv',
  bars5: 'edb_main_continuous_5m.csv',
  bars60: 'edb_main_continuous_60m.csv',
  rollovers: 'edb_main_continuous_rollovers.csv',
  mainContractMappings: 'edb_main_contract_mapping.csv',
  metadata: 'metadata.json',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function csvRows(text, label) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);
  if (lines.length < 2) throw new Error(`${label} 没有数据记录`);
  const header = lines[0].split(',');
  return {
    header,
    rows: lines.slice(1).filter(Boolean).map(line => {
      const values = line.split(',');
      if (values.length !== header.length) {
        throw new Error(`${label} 存在无法审计的 CSV 行`);
      }
      return Object.fromEntries(header.map((column, index) => [column, values[index]]));
    }),
  };
}

function formatBeijing(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function periodSummary(buffer, key, label) {
  const { rows } = csvRows(buffer.toString('utf8'), label);
  const first = rows[0];
  const last = rows.at(-1);
  if (key === 'bars1') {
    return {
      file: FILES[key],
      sha256: sha256(buffer),
      rows: rows.length,
      first: formatBeijing(Number(BigInt(first.datetime_nano) / 1_000_000n)),
      last: formatBeijing(Number(BigInt(last.datetime_nano) / 1_000_000n)),
    };
  }
  return {
    file: FILES[key],
    sha256: sha256(buffer),
    rows: rows.length,
    first: first.bar_start,
    last: last.bar_end,
  };
}

function mappingSummary(buffer, label) {
  const { rows } = csvRows(buffer.toString('utf8'), label);
  return {
    file: FILES.mainContractMappings,
    sha256: sha256(buffer),
    rows: rows.length,
    firstTradingDate: rows[0].trading_date,
    lastTradingDate: rows.at(-1).trading_date,
    firstContract: rows[0].contract,
    lastContract: rows.at(-1).contract,
    distinctContracts: [...new Set(rows.map(row => row.contract))],
  };
}

function rolloverSummary(buffer, label) {
  const { rows } = csvRows(buffer.toString('utf8'), label);
  return {
    file: FILES.rollovers,
    sha256: sha256(buffer),
    rows: rows.length,
    first: rows.length ? {
      tradingDate: rows[0].trading_date,
      time: rows[0].time,
      fromContract: rows[0].from_contract,
      toContract: rows[0].to_contract,
    } : null,
    last: rows.length ? {
      tradingDate: rows.at(-1).trading_date,
      time: rows.at(-1).time,
      fromContract: rows.at(-1).from_contract,
      toContract: rows.at(-1).to_contract,
    } : null,
  };
}

async function auditInstrument(definition) {
  const directory = join(DATA_DIRECTORY, 'instruments', definition.id);
  const entries = await Promise.all(Object.entries(FILES).map(async ([key, name]) => {
    try {
      return [key, await readFile(join(directory, name))];
    } catch (error) {
      if (key === 'bars1' && error?.code === 'ENOENT') return [key, undefined];
      throw error;
    }
  }));
  const buffers = Object.fromEntries(entries);
  const metadata = JSON.parse(buffers.metadata.toString('utf8').replace(/^\uFEFF/, ''));

  return {
    instrumentId: definition.id,
    name: definition.name,
    mainSymbol: definition.mainSymbol,
    snapshotId: metadata.snapshotId,
    snapshotGeneratedAt: metadata.generatedAt,
    sourceLatestAt: metadata.sourceLatestAt,
    periods: {
      bars1: buffers.bars1
        ? periodSummary(buffers.bars1, 'bars1', `${definition.name} 1 分钟`)
        : null,
      bars5: periodSummary(buffers.bars5, 'bars5', `${definition.name} 5 分钟`),
      bars60: periodSummary(buffers.bars60, 'bars60', `${definition.name} 60 分钟`),
    },
    mainContractMappings: mappingSummary(
      buffers.mainContractMappings,
      `${definition.name} 主力映射`,
    ),
    rollovers: rolloverSummary(buffers.rollovers, `${definition.name} 换月记录`),
    metadata: {
      file: FILES.metadata,
      sha256: sha256(buffers.metadata),
      schemaVersion: metadata.schemaVersion,
      source: metadata.source,
    },
  };
}

const instruments = [];
for (const definition of INSTRUMENT_LIST) {
  instruments.push(await auditInstrument(definition));
}

const report = {
  schemaVersion: 1,
  purpose: 'history-extension-prechange-baseline',
  capturedAt: instruments
    .map(instrument => instrument.snapshotGeneratedAt)
    .sort()
    .at(-1),
  instrumentCount: instruments.length,
  instruments,
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`已生成历史扩展前基线审计：${OUTPUT}`);
