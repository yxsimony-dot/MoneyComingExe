import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { Open } from 'unzipper';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_ROOT = join(
  process.env.USERPROFILE ?? homedir(),
  'Desktop',
  '期货数据',
  '期货分钟',
);
const DEFAULT_OUTPUT = join(
  PROJECT_ROOT,
  'data',
  'desktop-futures-history-audit.json',
);
const EXPECTED_MAIN_LAST_TIMESTAMP = '2026-10-14 14:59:00';
const MAIN_HEADER = [
  'exchange',
  'symbol',
  'open',
  'close',
  'high',
  'low',
  'amount',
  'volume',
  'position',
  'bob',
  'eob',
  'type',
];
const CONTRACT_HEADER = [
  '日期',
  '开盘价',
  '最高价',
  '最低价',
  '收盘价',
  '成交额',
  '成交量',
  '持仓量',
];
const TARGETS = [
  {
    instrumentId: 'main_continuous',
    name: '豆粕主连',
    exchange: 'DCE',
    productCode: 'M',
  },
  {
    instrumentId: 'pvc_main',
    name: 'PVC主连',
    exchange: 'DCE',
    productCode: 'V',
  },
  {
    instrumentId: 'palm_oil_main',
    name: '棕榈油主连',
    exchange: 'DCE',
    productCode: 'P',
  },
  {
    instrumentId: 'soybean_oil_main',
    name: '豆油主连',
    exchange: 'DCE',
    productCode: 'Y',
  },
  {
    instrumentId: 'corn_main',
    name: '玉米主连',
    exchange: 'DCE',
    productCode: 'C',
  },
  {
    instrumentId: 'soybean_1_main',
    name: '豆一主连',
    exchange: 'DCE',
    productCode: 'A',
  },
  {
    instrumentId: 'soybean_2_main',
    name: '豆二主连',
    exchange: 'DCE',
    productCode: 'B',
  },
  {
    instrumentId: 'rapeseed_meal_main',
    name: '菜粕主连',
    exchange: 'CZCE',
    productCode: 'RM',
  },
  {
    instrumentId: 'glass_main',
    name: '玻璃主连',
    exchange: 'CZCE',
    productCode: 'FG',
  },
  {
    instrumentId: 'rapeseed_oil_main',
    name: '菜油主连',
    exchange: 'CZCE',
    productCode: 'OI',
  },
  {
    instrumentId: 'soda_ash_main',
    name: '纯碱主连',
    exchange: 'CZCE',
    productCode: 'SA',
  },
  {
    instrumentId: 'methanol_main',
    name: '甲醇主连',
    exchange: 'CZCE',
    productCode: 'MA',
  },
  {
    instrumentId: 'sugar_main',
    name: '白糖主连',
    exchange: 'CZCE',
    productCode: 'SR',
  },
  {
    instrumentId: 'rebar_main',
    name: '螺纹钢主连',
    exchange: 'SHFE',
    productCode: 'RB',
  },
  {
    instrumentId: 'pulp_main',
    name: '纸浆主连',
    exchange: 'SHFE',
    productCode: 'SP',
  },
];

function parseArguments(argv) {
  const options = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    output: DEFAULT_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--source-root' && value) {
      options.sourceRoot = value;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  return {
    sourceRoot: resolve(options.sourceRoot),
    output: resolve(options.output),
  };
}

function portableRelative(root, path) {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`路径超出来源根目录：${path}`);
  }
  return value.split(sep).join('/');
}

function splitCsvRow(line) {
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
      throw new Error('CSV 引号格式无效');
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  values.push(value);
  return values;
}

function normalizedTimestamp(value, label) {
  const match =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\+08:00)?$/.exec(
      value,
    );
  if (!match) throw new Error(`${label} 时间格式无效：${value}`);
  return match[1];
}

function sameHeader(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

async function inspectCsvStream(input, options) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let bytes = 0;
  let header;
  let timestampIndex = -1;
  let rows = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let duplicateTimestampRows = 0;
  let descendingTimestampRows = 0;

  const processLine = rawLine => {
    const line = header ? rawLine : rawLine.replace(/^\uFEFF/, '');
    if (!header) {
      header = splitCsvRow(line);
      if (!sameHeader(header, options.expectedHeader)) {
        throw new Error(
          `${options.label} 表头不符合 ${options.format}：${header.join(',')}`,
        );
      }
      timestampIndex = header.indexOf(options.timestampColumn);
      return;
    }
    if (!line.trim()) return;
    const fields = splitCsvRow(line);
    if (fields.length !== header.length) {
      throw new Error(`${options.label} 第${rows + 2}行列数与表头不一致`);
    }
    const timestamp = normalizedTimestamp(
      fields[timestampIndex],
      `${options.label} 第${rows + 2}行`,
    );
    if (lastTimestamp === timestamp) duplicateTimestampRows += 1;
    if (lastTimestamp !== null && lastTimestamp > timestamp) {
      descendingTimestampRows += 1;
    }
    firstTimestamp ??= timestamp;
    lastTimestamp = timestamp;
    rows += 1;
  };

  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue);
    hash.update(chunk);
    bytes += chunk.length;
    pending += decoder.decode(chunk, { stream: true });
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
      pending = pending.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending.length) processLine(pending.replace(/\r$/, ''));
  if (!header) throw new Error(`${options.label} 文件为空`);

  return {
    format: options.format,
    sha256: hash.digest('hex'),
    bytes,
    rows,
    firstTimestamp,
    lastTimestamp,
    orderedAscending: descendingTimestampRows === 0,
    duplicateTimestampRows,
    descendingTimestampRows,
  };
}

async function inspectCsvFile(sourceRoot, path, options) {
  return {
    absolutePath: path,
    relativePath: portableRelative(sourceRoot, path),
    storage: 'csv',
    ...await inspectCsvStream(createReadStream(path), options),
  };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return {
    sha256: hash.digest('hex'),
    bytes,
  };
}

function contractFromFilename(filename) {
  return basename(filename, extname(filename));
}

function beijingMilliseconds(timestamp) {
  const milliseconds = Date.parse(`${timestamp.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`无法解析北京时间：${timestamp}`);
  }
  return milliseconds;
}

function exceedsThreeYears(firstTimestamp, lastTimestamp) {
  if (!firstTimestamp || !lastTimestamp) return false;
  const firstMs = beijingMilliseconds(firstTimestamp);
  const threshold = new Date(beijingMilliseconds(lastTimestamp));
  threshold.setUTCFullYear(threshold.getUTCFullYear() - 3);
  return firstMs < threshold.getTime();
}

async function locateInstrumentDirectory(sourceRoot, target) {
  const exchangeEntries = await readdir(sourceRoot, { withFileTypes: true });
  const exchangeEntry = exchangeEntries.find(entry => (
    entry.isDirectory()
    && entry.name.toUpperCase().startsWith(`${target.exchange}_`)
  ));
  if (!exchangeEntry) {
    throw new Error(`${target.name} 缺少交易所目录 ${target.exchange}_*`);
  }
  const exchangePath = resolve(sourceRoot, exchangeEntry.name);
  const productEntries = await readdir(exchangePath, { withFileTypes: true });
  const productEntry = productEntries.find(entry => (
    entry.isDirectory()
    && entry.name.split('_', 1)[0].toUpperCase() === target.productCode
  ));
  if (!productEntry) {
    throw new Error(`${target.name} 缺少品种目录 ${target.productCode}_*`);
  }
  return resolve(exchangePath, productEntry.name);
}

async function auditArchive(sourceRoot, archivePath) {
  const archiveHash = await hashFile(archivePath);
  const archive = await Open.file(archivePath);
  const fileMembers = archive.files.filter(member => member.type === 'File');
  const csvMembers = fileMembers
    .filter(member => extname(member.path).toLowerCase() === '.csv')
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const members = [];
  for (const member of csvMembers) {
    const inspected = await inspectCsvStream(member.stream(), {
      expectedHeader: CONTRACT_HEADER,
      timestampColumn: '日期',
      format: 'desktop-contract-v1',
      label: `${basename(archivePath)}!/${member.path}`,
    });
    members.push({
      contract: contractFromFilename(member.path),
      archiveMember: member.path,
      storage: 'zip-member',
      compressedBytes: member.compressedSize,
      centralDirectoryUncompressedBytes: member.uncompressedSize,
      ...inspected,
    });
  }
  return {
    absolutePath: archivePath,
    relativePath: portableRelative(sourceRoot, archivePath),
    storage: 'zip',
    ...archiveHash,
    totalMembers: archive.files.length,
    fileMembers: fileMembers.length,
    csvMembers: csvMembers.length,
    members,
  };
}

async function auditInstrument(sourceRoot, target) {
  const directory = await locateInstrumentDirectory(sourceRoot, target);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  const expectedMainName = `${target.productCode}主力连续.csv`.toUpperCase();
  const mainEntry = files.find(entry => entry.name.toUpperCase() === expectedMainName);
  if (!mainEntry) throw new Error(`${target.name} 缺少主连 CSV`);
  const archiveEntries = files.filter(entry => entry.name.toLowerCase().endsWith('_退市.zip'));
  if (archiveEntries.length !== 1) {
    throw new Error(`${target.name} 退市 ZIP 数量不是 1：${archiveEntries.length}`);
  }
  const currentEntries = files
    .filter(entry => (
      extname(entry.name).toLowerCase() === '.csv'
      && entry.name.toUpperCase() !== expectedMainName
    ))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));

  const mainContinuous = await inspectCsvFile(
    sourceRoot,
    resolve(directory, mainEntry.name),
    {
      expectedHeader: MAIN_HEADER,
      timestampColumn: 'bob',
      format: 'desktop-main-continuous-v1',
      label: `${target.name}主连`,
    },
  );
  const currentContracts = [];
  for (const entry of currentEntries) {
    const path = resolve(directory, entry.name);
    currentContracts.push({
      contract: contractFromFilename(entry.name),
      ...await inspectCsvFile(sourceRoot, path, {
        expectedHeader: CONTRACT_HEADER,
        timestampColumn: '日期',
        format: 'desktop-contract-v1',
        label: `${target.name}当前合约 ${entry.name}`,
      }),
    });
  }
  const retiredArchive = await auditArchive(
    sourceRoot,
    resolve(directory, archiveEntries[0].name),
  );
  const checks = {
    mainHasRows: mainContinuous.rows > 0,
    mainOrderedAscending:
      mainContinuous.orderedAscending
      && mainContinuous.duplicateTimestampRows === 0,
    mainExceedsThreeYears: exceedsThreeYears(
      mainContinuous.firstTimestamp,
      mainContinuous.lastTimestamp,
    ),
    mainLastTimestampMatches:
      mainContinuous.lastTimestamp === EXPECTED_MAIN_LAST_TIMESTAMP,
    hasCurrentContracts: currentContracts.length > 0,
    hasRetiredContracts: retiredArchive.csvMembers > 0,
    contractFilesOrderedAscending: [
      ...currentContracts,
      ...retiredArchive.members,
    ].every(file => file.orderedAscending && file.duplicateTimestampRows === 0),
  };
  const violations = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    instrumentId: target.instrumentId,
    name: target.name,
    exchange: target.exchange,
    productCode: target.productCode,
    directory: {
      absolutePath: directory,
      relativePath: portableRelative(sourceRoot, directory),
    },
    mainContinuous,
    currentContracts,
    retiredArchive,
    totals: {
      currentContractFiles: currentContracts.length,
      retiredContractFiles: retiredArchive.csvMembers,
      contractFiles: currentContracts.length + retiredArchive.csvMembers,
      contractRows: [...currentContracts, ...retiredArchive.members]
        .reduce((sum, file) => sum + file.rows, 0),
    },
    checks,
    status: violations.length ? 'failed' : 'passed',
    violations,
  };
}

async function sourceDocumentation(sourceRoot) {
  const path = resolve(sourceRoot, '数据说明.txt');
  const metadata = await hashFile(path);
  const text = await readFile(path, 'utf8');
  const valueFor = label => {
    const line = text.split(/\r?\n/).find(value => value.includes(label));
    return line?.split(':').slice(1).join(':').trim() ?? null;
  };
  return {
    absolutePath: path,
    relativePath: portableRelative(sourceRoot, path),
    ...metadata,
    declaredDatabase: valueFor('库 名 称'),
    declaredShape: valueFor('数据形态'),
    declaredCutoffDate: valueFor('数据截止日'),
    declaredCoverage: valueFor('覆盖范围'),
    declaredSource: valueFor('数据来源') || '数据1',
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rootStats = await stat(options.sourceRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`来源根路径不是目录：${options.sourceRoot}`);
  }
  const documentation = await sourceDocumentation(options.sourceRoot);
  const instruments = [];
  for (const [index, target] of TARGETS.entries()) {
    console.log(`[${index + 1}/${TARGETS.length}] 正在审计 ${target.name}...`);
    try {
      instruments.push(await auditInstrument(options.sourceRoot, target));
    } catch (error) {
      instruments.push({
        instrumentId: target.instrumentId,
        name: target.name,
        exchange: target.exchange,
        productCode: target.productCode,
        status: 'failed',
        violations: [
          error instanceof Error ? error.message : String(error),
        ],
      });
    }
  }

  const passedInstruments = instruments.filter(item => item.status === 'passed');
  const validationViolations = [];
  if (instruments.length !== TARGETS.length) {
    validationViolations.push(
      `品种数量不符合预期：${instruments.length} / ${TARGETS.length}`,
    );
  }
  for (const instrument of instruments) {
    for (const violation of instrument.violations) {
      validationViolations.push(`${instrument.name}：${violation}`);
    }
  }
  const report = {
    schemaVersion: 1,
    purpose: 'desktop-futures-history-audit',
    generatedAt: new Date().toISOString(),
    sourceRoot: options.sourceRoot,
    source: {
      sourceId: 'desktop-futures-minute-history',
      sourceName: '桌面期货分钟数据',
      sourceVersion: documentation.declaredCutoffDate
        ? `cutoff-${documentation.declaredCutoffDate}`
        : undefined,
      documentation,
      license: {
        redistributionAllowed: false,
        conclusion:
          '交付说明仅标注“数据1”，未提供允许提交到 Git 或随 EXE/安装包再分发的授权依据。',
      },
    },
    expectations: {
      targetInstrumentCount: TARGETS.length,
      minimumMainHistoryYearsExclusive: 3,
      expectedMainLastTimestamp: EXPECTED_MAIN_LAST_TIMESTAMP,
      formats: {
        mainContinuous: 'desktop-main-continuous-v1',
        contract: 'desktop-contract-v1',
      },
    },
    summary: {
      instrumentCount: instruments.length,
      passedInstruments: passedInstruments.length,
      failedInstruments: instruments.length - passedInstruments.length,
      mainRows: passedInstruments.reduce(
        (sum, item) => sum + item.mainContinuous.rows,
        0,
      ),
      contractFiles: passedInstruments.reduce(
        (sum, item) => sum + item.totals.contractFiles,
        0,
      ),
      contractRows: passedInstruments.reduce(
        (sum, item) => sum + item.totals.contractRows,
        0,
      ),
    },
    validation: {
      passed: validationViolations.length === 0,
      violations: validationViolations,
    },
    releaseEligibility: {
      allowed: false,
      violations: [
        '桌面数据缺少明确的再分发许可，不能写入 Git、内置基线、EXE 或安装包。',
      ],
    },
    instruments,
  };

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`桌面长期历史审计已写入：${options.output}`);
  if (!report.validation.passed) process.exitCode = 1;
}

await main();
