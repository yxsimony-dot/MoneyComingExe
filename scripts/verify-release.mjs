import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import {
  assetName,
  listFiles,
  pathExists,
  readPackageManifest,
  readYamlFile,
  releaseDirectory,
  sha512Base64,
} from './release-utils.mjs';

export const REQUIRED_DATA = [
  'edb_main_continuous_1m_raw.csv',
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'edb_main_continuous_rollovers.csv',
  'summary.json',
  'cross_source_audit.json',
  'entry-rules.md',
];

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
}

function validateRolloverCsv(text, label) {
  const rows = csvTable(text, label, ROLLOVER_COLUMNS);
  let previousDate = '';
  let previousTime;
  rows.forEach((row, index) => {
    const rowLabel = `${label} 第${index + 2}行`;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date), `${rowLabel} trading_date 无效`);
    const time = beijingTime(row.time, `${rowLabel} time`);
    assert(/^m\d{4}$/.test(row.from_contract) && /^m\d{4}$/.test(row.to_contract), `${rowLabel} 合约代码无效`);
    assert(row.from_contract !== row.to_contract, `${rowLabel} 新旧合约不得相同`);
    assert(row.trading_date > previousDate && (previousTime === undefined || time > previousTime), `${rowLabel} 换月记录未严格递增`);
    previousDate = row.trading_date;
    previousTime = time;
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

export function validatePackagedData(name, text) {
  switch (name) {
    case 'edb_main_continuous_1m_raw.csv':
      validateMinuteCsv(text, name);
      break;
    case 'edb_main_continuous_5m.csv':
      validateBarCsv(text, name, 5);
      break;
    case 'edb_main_continuous_60m.csv':
      validateBarCsv(text, name, 60);
      break;
    case 'edb_main_continuous_rollovers.csv':
      validateRolloverCsv(text, name);
      break;
    case 'summary.json': {
      const summary = jsonObject(text, name);
      assert(Number.isInteger(summary.edb?.main_continuous?.one_minute_rows)
        && summary.edb.main_continuous.one_minute_rows > 0, `${name} 缺少有效的一分钟行数`);
      break;
    }
    case 'cross_source_audit.json': {
      const audit = jsonObject(text, name);
      assert(Array.isArray(audit.anomalies), `${name} anomalies 必须为数组`);
      break;
    }
    case 'entry-rules.md':
      assert(text.trim().startsWith('# 每周突破回调入场规则'), `${name} 缺少规则标题`);
      assert(text.includes('后台1分钟数据') && text.includes('第一处实际出场'), `${name} 缺少分钟或实际出场规则`);
      break;
    default:
      throw new Error(`没有 data/${name} 的解析校验器`);
  }
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

  for (const name of REQUIRED_DATA) {
    const path = join(unpacked, 'data', name);
    assert(await pathExists(path), `安装包展开目录缺少 data/${name}`);
    assert((await stat(path)).size > 0, `data/${name} 为空`);
    validatePackagedData(name, await readFile(path, 'utf8'));
  }

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
