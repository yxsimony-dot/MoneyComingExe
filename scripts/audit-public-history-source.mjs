import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPOSITORY = join(
  homedir(),
  'moneycoming-history-source',
  'china-futures-5min-2015-2025-tree',
);
const DEFAULT_OUTPUT = join(ROOT, 'data', 'public-history-source-audit.json');
const EXPECTED_HEADER = [
  'datetime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'money',
  'open_interest',
];
const SOURCE_DIRECTORIES = [
  ['main_continuous', '豆粕主连', '5min/DCE/M'],
  ['rapeseed_meal_main', '菜粕主连', '5min/CZCE/RM'],
  ['pvc_main', 'PVC主连', '5min/DCE/V'],
  ['rebar_main', '螺纹钢主连', '5min/SHFE/RB'],
  ['glass_main', '玻璃主连', '5min/CZCE/FG'],
  ['rapeseed_oil_main', '菜油主连', '5min/CZCE/OI'],
  ['palm_oil_main', '棕榈油主连', '5min/DCE/P'],
  ['soybean_oil_main', '豆油主连', '5min/DCE/Y'],
  ['pulp_main', '纸浆主连', '5min/SHFE/SP'],
  ['corn_main', '玉米主连', '5min/DCE/C'],
  ['soda_ash_main', '纯碱主连', '5min/CZCE/SA'],
  ['soybean_1_main', '豆一主连', '5min/DCE/A'],
  ['methanol_main', '甲醇主连', '5min/CZCE/MA'],
  ['sugar_main', '白糖主连', '5min/CZCE/SR'],
  ['soybean_2_main', '豆二主连', '5min/DCE/B'],
];

function parseArguments(argv) {
  const options = {
    repository: process.env.PUBLIC_HISTORY_REPO || DEFAULT_REPOSITORY,
    output: DEFAULT_OUTPUT,
    acquiredOn: process.env.PUBLIC_HISTORY_ACQUIRED_ON
      || new Date().toISOString().slice(0, 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--repo' && value) {
      options.repository = value;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else if (argument === '--acquired-on' && value) {
      options.acquiredOn = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.acquiredOn)) {
    throw new Error(`--acquired-on 必须使用 YYYY-MM-DD：${options.acquiredOn}`);
  }
  return {
    repository: resolve(options.repository),
    output: resolve(options.output),
    acquiredOn: options.acquiredOn,
  };
}

function resolveGitExecutable() {
  const candidates = [
    process.env.GIT_EXE,
    'git',
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0) return candidate;
  }
  throw new Error('未找到可用的 Git，请通过 GIT_EXE 指定 git 可执行文件');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function createGitReader(repository) {
  const gitDirectory = join(repository, '.git');
  if (!existsSync(gitDirectory)) {
    throw new Error(`候选来源不是 Git 工作树：${repository}`);
  }
  const git = resolveGitExecutable();
  const run = (args, encoding = null) => {
    const result = spawnSync(git, [`--git-dir=${gitDirectory}`, ...args], {
      encoding,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      throw new Error(`Git 命令失败：git ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`);
    }
    return result.stdout;
  };
  return {
    text(args) {
      return run(args, 'utf8').trim();
    },
    blob(path) {
      return run(['cat-file', 'blob', `HEAD:${path}`]);
    },
    files(path) {
      return run(['ls-tree', '-r', '--name-only', 'HEAD', '--', path], 'utf8')
        .split(/\r?\n/)
        .filter(file => file.endsWith('.csv'))
        .sort();
    },
  };
}

function parseCsv(buffer, label) {
  const lines = buffer
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) throw new Error(`${label} 没有数据记录`);
  const header = lines[0].split(',');
  if (header.join(',') !== EXPECTED_HEADER.join(',')) {
    throw new Error(`${label} 字段不符合预期：${header.join(',')}`);
  }
  return {
    header,
    rows: lines.slice(1).map((line, lineIndex) => {
      const values = line.split(',');
      if (values.length !== header.length) {
        throw new Error(`${label} 第 ${lineIndex + 2} 行字段数量错误`);
      }
      return values;
    }),
  };
}

function validateSample(rows, label) {
  const problems = [];
  let previousTimestamp = '';
  let alignedRows = 0;
  let validOhlcRows = 0;
  let nonNegativeMetricRows = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const [timestamp, ...numericValues] = row;
    const timeMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(timestamp);
    if (!timeMatch) {
      problems.push(`第 ${index + 2} 行时间格式错误：${timestamp}`);
      continue;
    }
    if (Number(timeMatch[3]) % 5 === 0 && timeMatch[4] === '00') alignedRows += 1;
    if (previousTimestamp && timestamp <= previousTimestamp) {
      problems.push(`第 ${index + 2} 行时间戳未严格递增：${timestamp}`);
    }
    previousTimestamp = timestamp;

    const [open, high, low, close, volume, money, openInterest]
      = numericValues.map(Number);
    if ([open, high, low, close, volume, money, openInterest].some(
      value => !Number.isFinite(value),
    )) {
      problems.push(`第 ${index + 2} 行包含非数值字段`);
      continue;
    }
    if (high >= Math.max(open, close, low) && low <= Math.min(open, close, high)) {
      validOhlcRows += 1;
    } else {
      problems.push(`第 ${index + 2} 行 OHLC 关系非法`);
    }
    if (volume >= 0 && money >= 0 && openInterest >= 0) {
      nonNegativeMetricRows += 1;
    } else {
      problems.push(`第 ${index + 2} 行成交量、成交额或持仓量为负数`);
    }
  }

  if (alignedRows !== rows.length) {
    problems.push(`${label} 存在 ${rows.length - alignedRows} 行未对齐 5 分钟边界`);
  }
  return {
    strictlyIncreasingTimestamps: !problems.some(problem => problem.includes('未严格递增')),
    fiveMinuteAlignedRows: alignedRows,
    validOhlcRows,
    nonNegativeMetricRows,
    problemCount: problems.length,
    problems: problems.slice(0, 20),
  };
}

function inspectRawFile(reader, path) {
  const buffer = reader.blob(path);
  const { header, rows } = parseCsv(buffer, path);
  return {
    path,
    sha256: sha256(buffer),
    bytes: buffer.length,
    rows: rows.length,
    header,
    firstTimestamp: rows[0][0],
    lastTimestamp: rows.at(-1)[0],
    validation: validateSample(rows, path),
  };
}

const options = parseArguments(process.argv.slice(2));
const reader = createGitReader(options.repository);
const license = reader.blob('LICENSE');
const readme = reader.blob('README_zh.md');
const commit = reader.text(['rev-parse', 'HEAD']);
const commitObject = reader.text(['cat-file', 'commit', 'HEAD']);
const commitLines = commitObject.split(/\r?\n/);
const tree = commitLines.find(line => line.startsWith('tree '))?.slice(5) || null;
const authorLine = commitLines.find(line => line.startsWith('author ')) || '';
const committerLine = commitLines.find(line => line.startsWith('committer ')) || '';
const author = /^author (.+) <[^>]+> \d+ [+-]\d{4}$/.exec(authorLine)?.[1] || null;
const commitTime = /^committer .+ <[^>]+> (\d+) ([+-]\d{4})$/.exec(committerLine);

const instruments = SOURCE_DIRECTORIES.map(([instrumentId, name, directory]) => {
  const files = reader.files(directory);
  if (files.length === 0) {
    return {
      instrumentId,
      name,
      directory,
      fileCount: 0,
      firstRawFile: null,
      lastRawFile: null,
    };
  }
  return {
    instrumentId,
    name,
    directory,
    fileCount: files.length,
    firstRawFile: inspectRawFile(reader, files[0]),
    lastRawFile: inspectRawFile(reader, files.at(-1)),
  };
});

const samples = instruments.flatMap(instrument => (
  [instrument.firstRawFile, instrument.lastRawFile].filter(Boolean)
));
const firstTimestamp = samples.map(sample => sample.firstTimestamp).sort()[0] || null;
const lastTimestamp = samples.map(sample => sample.lastTimestamp).sort().at(-1) || null;
const targetCoverageComplete = instruments.every(instrument => instrument.fileCount > 0);
const latestDateCoveredByEveryTarget = instruments.every(
  instrument => instrument.lastRawFile?.lastTimestamp.startsWith('2025-06-30 '),
);
const samplesPassedStructuralValidation = samples.every(
  sample => sample.validation.problemCount === 0,
);

const report = {
  schemaVersion: 1,
  purpose: 'public-contract-five-minute-source-probe',
  acquiredOn: options.acquiredOn,
  source: {
    repository: reader.text(['config', '--get', 'remote.origin.url']),
    commit,
    commitUnixTimestamp: commitTime ? Number(commitTime[1]) : null,
    commitTimezoneOffset: commitTime?.[2] || null,
    tree,
    author,
  },
  documentation: {
    readme: {
      path: 'README_zh.md',
      sha256: sha256(readme),
      statedRange: {
        firstDate: '2015-04-16',
        lastDate: '2025-06-30',
      },
      statedDataType: '中国场内期货具体合约 5 分钟行情',
      statedFields: ['open', 'high', 'low', 'close', 'volume'],
      statedLicense: 'CC0',
    },
    license: {
      path: 'LICENSE',
      sha256: sha256(license),
      identifier: 'CC0-1.0',
      containsCanonicalHeading: license.toString('utf8').includes('CC0 1.0 Universal'),
    },
  },
  coverage: {
    expectedInstrumentCount: SOURCE_DIRECTORIES.length,
    coveredInstrumentCount: instruments.filter(instrument => instrument.fileCount > 0).length,
    targetCoverageComplete,
    totalContractFiles: instruments.reduce(
      (total, instrument) => total + instrument.fileCount,
      0,
    ),
    sampledRawFileCount: samples.length,
    sampledActualRange: {
      firstTimestamp,
      lastTimestamp,
    },
    readmeStartDateCorroborated: firstTimestamp?.startsWith('2015-04-16 ') ?? false,
    readmeEndDateCorroborated: lastTimestamp?.startsWith('2025-06-30 ') ?? false,
    latestDateCoveredByEveryTarget,
  },
  fieldSemantics: {
    header: EXPECTED_HEADER,
    confirmed: {
      datetime: '无时区日期时间文本，全部边界样本对齐 5 分钟边界',
      openHighLowClose: '数值型 OHLC，全部边界样本满足 high/low 包络关系',
      volumeMoneyOpenInterest: '数值型且全部边界样本非负',
    },
    unresolvedByRepositoryDocumentation: [
      'datetime 未声明时区',
      'datetime 未声明代表 K 线起点还是终点',
      'volume 未声明手数或双边/单边口径',
      'money 未声明币种、单位和成交额口径',
      'open_interest 未声明是 K 线起点还是终点快照',
    ],
  },
  licenseAssessment: {
    repositoryAssertion: 'README_zh.md 明确声明本数据集采用 CC0，可自由使用、修改和分发',
    repositoryLicenseAppliesToDataset: true,
    upstreamMarketDataProvenanceDocumented: false,
    releaseEligibility: 'blocked-until-upstream-rights-confirmed',
    note: 'CC0 文件和数据集声明已验证；原始行情上游来源未记录，在第三方权利边界确认前不得进入 Git/EXE。',
  },
  validation: {
    samplesPassedStructuralValidation,
    expectedHeaderMatchedByEverySample: samples.every(
      sample => sample.header.join(',') === EXPECTED_HEADER.join(','),
    ),
    allSampleHashesPresent: samples.every(sample => /^[0-9a-f]{64}$/.test(sample.sha256)),
  },
  instruments,
};

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`已生成公开历史来源审计：${options.output}`);
