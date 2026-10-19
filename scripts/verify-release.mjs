import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import { INSTRUMENT_LIST } from '../src/shared/instruments.ts';
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
  'edb_main_continuous_1m_raw.csv',
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'edb_main_continuous_rollovers.csv',
  'edb_main_contract_mapping.csv',
  'metadata.json',
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

function csvTable(text, label, requiredColumns) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  assert(lines.length > 1, `${label} 没有数据记录`);
  const header = splitCsvRow(lines[0], `${label} 第1行`);
  assert(new Set(header).size === header.length, `${label} 表头存在重复列`);
  for (const column of requiredColumns) {
    assert(header.includes(column), `${label} 缺少列 ${column}`);
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
  rows.forEach((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d+$/.test(row.datetime_nano), `${rowLabel} datetime_nano 必须为非负整数`);
    const nanos = BigInt(row.datetime_nano);
    assert(nanos % 60_000_000_000n === 0n, `${rowLabel} datetime_nano 未对齐整分钟`);
    assert(previous === undefined || nanos > previous, `${rowLabel} 时间戳重复或未严格递增`);
    priceRow(row, rowLabel);
    previous = nanos;
  });
  return {
    rows: rows.length,
    firstMinute: formatBeijing(Number(BigInt(rows[0].datetime_nano) / 1_000_000n)),
    lastMinute: formatBeijing(Number(BigInt(rows.at(-1).datetime_nano) / 1_000_000n)),
  };
}

function validateBarCsv(text, label, period) {
  const rows = csvTable(text, label, BAR_COLUMNS);
  let previousEnd;
  rows.forEach((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    const start = beijingTime(row.bar_start, `${rowLabel} bar_start`);
    const end = beijingTime(row.bar_end, `${rowLabel} bar_end`);
    assert(end > start, `${rowLabel} 时间范围无效`);
    assert(previousEnd === undefined || start >= previousEnd, `${rowLabel} 时间重复、倒序或重叠`);
    assert(row.session === 'day' || row.session === 'night', `${rowLabel} session 无效`);
    priceRow(row, rowLabel);
    const observed = finiteNumber(row.observed_minutes, `${rowLabel} observed_minutes`);
    const expected = finiteNumber(row.expected_minutes, `${rowLabel} expected_minutes`);
    assert(Number.isInteger(observed) && Number.isInteger(expected), `${rowLabel} 分钟数量必须为整数`);
    assert(observed > 0 && observed <= expected && expected > 0 && expected <= period, `${rowLabel} 分钟数量无效`);
    assert(row.complete === 'True' || row.complete === 'False', `${rowLabel} complete 无效`);
    assert((row.complete === 'True') === (observed === expected), `${rowLabel} complete 与分钟数量不一致`);
    previousEnd = end;
  });
  return {
    rows: rows.length,
    firstStart: rows[0].bar_start,
    lastEnd: rows.at(-1).bar_end,
  };
}

function contractPattern(definition) {
  const escapedProduct = definition.productCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedProduct}\\d{${definition.contractCode.expiryDigits}}$`);
}

function validateContract(contract, definition, label) {
  assert(contractPattern(definition).test(contract), `${label} 合约代码无效`);
  const month = Number(contract.slice(-2));
  assert(definition.contractCode.candidateMonths.includes(month), `${label} 合约月份无效`);
}

function validateRolloverCsv(text, label, definition) {
  const rows = csvTable(text, label, ROLLOVER_COLUMNS);
  let previousDate = '';
  let previousTime;
  rows.forEach((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date), `${rowLabel} trading_date 无效`);
    const time = beijingTime(row.time, `${rowLabel} time`);
    validateContract(row.from_contract, definition, `${rowLabel} from_contract`);
    validateContract(row.to_contract, definition, `${rowLabel} to_contract`);
    assert(row.from_contract !== row.to_contract, `${rowLabel} 新旧合约不得相同`);
    assert(row.trading_date > previousDate && (previousTime === undefined || time > previousTime), `${rowLabel} 换月记录未严格递增`);
    previousDate = row.trading_date;
    previousTime = time;
  });
  return { rows: rows.length };
}

function validateMappingCsv(text, label, definition) {
  const rows = csvTable(text, label, MAPPING_COLUMNS);
  let previousDate = '';
  rows.forEach((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date), `${rowLabel} trading_date 无效`);
    assert(row.trading_date > previousDate, `${rowLabel} 交易日重复或未严格递增`);
    validateContract(row.contract, definition, `${rowLabel} contract`);
    previousDate = row.trading_date;
  });
  return { rows: rows.length };
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

function validateMetadata(metadata, definition) {
  const label = `${definition.name} metadata.json`;
  assert(metadata.schemaVersion === 4, `${label} schemaVersion 必须为 4`);
  assert(metadata.snapshotId === `builtin-${definition.id}`, `${label} snapshotId 与品种不一致`);
  assert(metadata.instrumentId === definition.id, `${label} instrumentId 与品种不一致`);
  assert(metadata.mainSymbol === definition.mainSymbol, `${label} mainSymbol 与注册表不一致`);
  assert(metadata.parameterVersion === definition.parameterVersion, `${label} parameterVersion 与注册表不一致`);
  assert(
    metadata.source?.provider === 'EDB'
      && metadata.source.endpoint === 'https://edb.shinnytech.com/md/kline'
      && metadata.source.symbol === definition.mainSymbol,
    `${label} 数据源声明无效`,
  );
  assert(Number.isFinite(Date.parse(metadata.generatedAt)), `${label} generatedAt 无效`);
  for (const field of ['requestStart', 'requestEnd', 'sourceLatestAt']) {
    beijingTime(metadata[field], `${label} ${field}`);
  }
  assert(
    metadata.files && typeof metadata.files === 'object' && !Array.isArray(metadata.files),
    `${label} files 无效`,
  );
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
    validateMetadata(metadata, definition);

    const summaries = {};
    for (const name of REQUIRED_INSTRUMENT_FILES.filter(file => file !== 'metadata.json')) {
      const relativeName = `data/instruments/${definition.id}/${name}`;
      const buffer = await readRequiredFile(join(directory, name), `${relativeName}（${definition.name}）`);
      const key = SNAPSHOT_FILE_KEYS[name];
      const declared = metadata.files[key];
      assert(declared && typeof declared === 'object', `${definition.name} metadata 缺少 ${key}`);
      assert(declared.name === name, `${definition.name} metadata 的 ${key} 文件名不一致`);
      assert(Number.isSafeInteger(declared.rows) && declared.rows > 0, `${definition.name} metadata 的 ${key} 行数无效`);
      assert(/^[a-f0-9]{64}$/.test(declared.sha256), `${definition.name} metadata 的 ${key} 哈希无效`);
      const actualHash = createHash('sha256').update(buffer).digest('hex');
      assert(actualHash === declared.sha256, `${definition.name} ${name} SHA-256 与 metadata 不一致`);
      const summary = validatePackagedData(name, buffer.toString('utf8'), definition);
      assert(summary.rows === declared.rows, `${definition.name} ${name} 行数与 metadata 不一致`);
      summaries[key] = summary;
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
    assert(
      Object.values(validated.checks ?? {}).length === 7
        && Object.values(validated.checks).every(value => value === true),
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
    assert(
      summaries.bars5.firstStart >= summaries.bars1.firstMinute
        && summaries.bars60.firstStart >= summaries.bars1.firstMinute
        && summaries.bars5.lastEnd <= metadata.sourceLatestAt
        && summaries.bars60.lastEnd <= metadata.sourceLatestAt,
      `${definition.name} 1/5/60 分钟时间范围不一致`,
    );
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
