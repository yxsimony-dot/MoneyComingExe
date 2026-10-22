import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'myquant-local-minute-probe.json');
const DATASET_DIRECTORY_NAME = '期货1分钟数据_MyQuant_整理';
const STANDARD_DIRECTORY_PREFIX = 'standard_csv_';
const TARGET_INSTRUMENTS = [
  {
    symbol: 'M0',
    instrumentId: 'main_continuous',
    displayName: '豆粕主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-08' },
  },
  {
    symbol: 'RM0',
    instrumentId: 'rapeseed_meal_main',
    displayName: '菜粕主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'V0',
    instrumentId: 'pvc_main',
    displayName: 'PVC主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'RB0',
    instrumentId: 'rebar_main',
    displayName: '螺纹钢主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'FG0',
    instrumentId: 'glass_main',
    displayName: '玻璃主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'OI0',
    instrumentId: 'rapeseed_oil_main',
    displayName: '菜油主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'P0',
    instrumentId: 'palm_oil_main',
    displayName: '棕榈油主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'Y0',
    instrumentId: 'soybean_oil_main',
    displayName: '豆油主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'SP0',
    instrumentId: 'pulp_main',
    displayName: '纸浆主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'C0',
    instrumentId: 'corn_main',
    displayName: '玉米主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'SA0',
    instrumentId: 'soda_ash_main',
    displayName: '纯碱主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'A0',
    instrumentId: 'soybean_1_main',
    displayName: '豆一主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'MA0',
    instrumentId: 'methanol_main',
    displayName: '甲醇主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'SR0',
    instrumentId: 'sugar_main',
    displayName: '白糖主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
  {
    symbol: 'B0',
    instrumentId: 'soybean_2_main',
    displayName: '豆二主连',
    gap: { firstDate: '2025-07-01', lastDate: '2025-10-19' },
  },
];

function parseArguments(argv) {
  const options = {
    root: null,
    output: DEFAULT_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--root' && value) {
      options.root = value;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  return {
    root: options.root ? resolve(options.root) : null,
    output: resolve(options.output),
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveDatasetRoot(explicitRoot) {
  if (explicitRoot) {
    if (!(await pathExists(explicitRoot))) {
      throw new Error(`MyQuant 数据目录不存在：${explicitRoot}`);
    }
    return explicitRoot;
  }

  const desktop = join(homedir(), 'Desktop');
  const exact = join(desktop, DATASET_DIRECTORY_NAME);
  if (await pathExists(exact)) return exact;

  const entries = await readdir(desktop, { withFileTypes: true });
  const candidate = entries.find(entry => (
    entry.isDirectory()
    && entry.name.startsWith('期货1分钟数据_MyQuant')
  ));
  if (!candidate) {
    throw new Error(
      `桌面未找到 ${DATASET_DIRECTORY_NAME}，可用 --root 指定目录`,
    );
  }
  return join(desktop, candidate.name);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map(header => header.replace(/^\uFEFF/, ''));
  return rows.slice(1)
    .filter(values => values.some(item => item.length > 0))
    .map(values => Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    ));
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function datePart(timestamp) {
  return timestamp ? timestamp.slice(0, 10) : null;
}

function assessGap(firstTimestamp, lastTimestamp, gap) {
  const firstDate = datePart(firstTimestamp);
  const lastDate = datePart(lastTimestamp);
  const overlaps = Boolean(
    firstDate
    && lastDate
    && firstDate <= gap.lastDate
    && lastDate >= gap.firstDate
  );
  return {
    ...gap,
    overlaps,
    wholeGapCovered: Boolean(
      firstDate
      && lastDate
      && firstDate <= gap.firstDate
      && lastDate >= gap.lastDate
    ),
    beginsAfterGap: Boolean(firstDate && firstDate > gap.lastDate),
  };
}

async function findStandardDirectory(datasetRoot) {
  const entries = await readdir(datasetRoot, { withFileTypes: true });
  const directory = entries.find(entry => (
    entry.isDirectory()
    && entry.name.startsWith(STANDARD_DIRECTORY_PREFIX)
  ));
  if (!directory) {
    throw new Error(`MyQuant 数据目录缺少 ${STANDARD_DIRECTORY_PREFIX}* 子目录`);
  }
  return join(datasetRoot, directory.name);
}

async function summarizeInstrument(instrument, coverageRow, standardDirectory) {
  const csvPath = join(standardDirectory, `${instrument.symbol}.csv`);
  const csvPresent = await pathExists(csvPath);
  const fileStat = csvPresent ? await stat(csvPath) : null;
  const rows = Number(coverageRow?.rows ?? 0);
  const firstTimestamp = coverageRow?.first || null;
  const lastTimestamp = coverageRow?.last || null;
  return {
    ...instrument,
    coverageSummary: {
      rowPresent: Boolean(coverageRow),
      rows: Number.isFinite(rows) ? rows : 0,
      firstTimestamp,
      lastTimestamp,
      status: coverageRow?.status || 'MISSING',
    },
    csvMetadata: {
      fileName: basename(csvPath),
      exists: csvPresent,
      bytes: fileStat?.size ?? 0,
      modifiedAt: fileStat?.mtime.toISOString() ?? null,
      contentReadByProbe: false,
    },
    targetGap: assessGap(firstTimestamp, lastTimestamp, instrument.gap),
  };
}

export async function runProbe(options) {
  const datasetRoot = await resolveDatasetRoot(options.root);
  const readmePath = join(datasetRoot, 'README.md');
  const coveragePath = join(datasetRoot, 'coverage_summary.csv');
  const standardDirectory = await findStandardDirectory(datasetRoot);
  const [readme, coverageText] = await Promise.all([
    readFile(readmePath, 'utf8'),
    readFile(coveragePath, 'utf8'),
  ]);
  const coverageRows = parseCsv(coverageText);
  const coverageBySymbol = new Map(
    coverageRows.map(row => [row.symbol?.toUpperCase(), row]),
  );
  const instruments = await Promise.all(
    TARGET_INSTRUMENTS.map(instrument => summarizeInstrument(
      instrument,
      coverageBySymbol.get(instrument.symbol),
      standardDirectory,
    )),
  );
  const firstTimestamps = instruments
    .map(instrument => instrument.coverageSummary.firstTimestamp)
    .filter(Boolean)
    .sort();
  const lastTimestamps = instruments
    .map(instrument => instrument.coverageSummary.lastTimestamp)
    .filter(Boolean)
    .sort();
  const targetGapOverlappingInstrumentCount = instruments.filter(
    instrument => instrument.targetGap.overlaps,
  ).length;
  const targetGapCoveredInstrumentCount = instruments.filter(
    instrument => instrument.targetGap.wholeGapCovered,
  ).length;

  return {
    schemaVersion: 1,
    purpose: 'myquant-local-main-continuous-one-minute-probe',
    capturedAt: new Date().toISOString(),
    source: {
      name: '本机 MyQuant/gm.api 期货 1 分钟整理数据',
      provider: 'MyQuant',
      api: 'gm.api history(frequency="60s")',
      seriesKind: 'main-continuous',
      frequencyMinutes: 1,
      specificContractAttributionAvailable: false,
      datasetDirectoryName: basename(datasetRoot),
      standardDirectoryName: basename(standardDirectory),
      documentation: {
        readmeFile: 'README.md',
        readmeSha256: sha256(readme),
        coverageSummaryFile: 'coverage_summary.csv',
        coverageSummarySha256: sha256(coverageText),
      },
      observedAccountLimit: {
        recentNaturalDays: 180,
        documentedInDatasetReadme: (
          /most recent 180 natural days/i.test(readme)
        ),
        documentedEarliestStartDate: (
          readme.match(/start date cannot be earlier than\s+(\d{4}-\d{2}-\d{2})/i)
            ?.[1] ?? null
        ),
      },
    },
    inspectionPolicy: {
      readOnlyLocalInspection: true,
      rawCsvMarketRowsRead: false,
      rawCsvMarketRowsPersisted: false,
      standardizedCsvMarketRowsRead: false,
      standardizedCsvMarketRowsPersisted: false,
      coverageSummaryRead: true,
      documentationRead: true,
    },
    inventory: {
      coverageSummaryRowCount: coverageRows.length,
      targetInstrumentCount: TARGET_INSTRUMENTS.length,
      presentTargetInstrumentCount: instruments.filter(
        instrument => (
          instrument.coverageSummary.rowPresent
          && instrument.csvMetadata.exists
        ),
      ).length,
      nonEmptyTargetInstrumentCount: instruments.filter(
        instrument => instrument.coverageSummary.rows > 0,
      ).length,
      targetRowCount: instruments.reduce(
        (total, instrument) => total + instrument.coverageSummary.rows,
        0,
      ),
      firstTimestamp: firstTimestamps.at(0) ?? null,
      lastTimestamp: lastTimestamps.at(-1) ?? null,
    },
    coverage: {
      targetGapOverlappingInstrumentCount,
      targetGapCoveredInstrumentCount,
      allTargetSymbolsPresent: instruments.every(
        instrument => (
          instrument.coverageSummary.rowPresent
          && instrument.csvMetadata.exists
        ),
      ),
      targetGapCoverageConfirmed: (
        targetGapCoveredInstrumentCount === TARGET_INSTRUMENTS.length
      ),
      conclusion: (
        targetGapOverlappingInstrumentCount === 0
          ? '十五个目标品种的数据均晚于 2025-07 至 2025-10 的目标缺口，不能用于缺口回填。'
          : '部分数据与目标缺口存在时间重叠，但尚未证明全部品种完整覆盖。'
      ),
    },
    instruments,
    rights: {
      accountDownloadPermissionObserved: true,
      accountDownloadPermissionGrantsRedistributionRights: false,
      writtenMarketDataRedistributionAuthorizationFound: false,
      gitStoragePermissionConfirmed: false,
      packagedApplicationRedistributionPermissionConfirmed: false,
      derivedBarsRedistributionPermissionConfirmed: false,
      commercialUsePermissionConfirmed: false,
      conclusion: (
        '数据目录只记录账号可下载最近约 180 个自然日，没有提供允许将行情写入 Git、'
        + '随 EXE/安装包分发、分发派生 K 线或商业使用的书面授权。'
      ),
    },
    retention: {
      datasetCopiedIntoRepository: false,
      rawRowsPersisted: false,
      absoluteSourceFilePathsPersisted: false,
      summaryOnly: true,
    },
    releaseDecision: {
      technicalGapCoverageConfirmed: false,
      redistributionPermissionConfirmed: false,
      releasableGapSourceFound: false,
      baselineReplacementAllowed: false,
      task4_2MayBeMarkedComplete: false,
      releaseEligibility: (
        'blocked-post-gap-main-continuous-and-redistribution-rights-unconfirmed'
      ),
      note: (
        '该批 1 分钟主连数据从 2025-12-05 左右开始，晚于目标缺口，且不是具体合约级历史；'
        + '当前也没有行情再分发授权，因此只能保留摘要审计，不能替换发布基线。'
      ),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runProbe(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已生成 MyQuant 本地分钟数据探测摘要：${options.output}`);
  console.log(
    `目标品种 ${report.inventory.targetInstrumentCount}，`
    + `已发现 ${report.inventory.presentTargetInstrumentCount}，`
    + `目标缺口重叠 ${report.coverage.targetGapOverlappingInstrumentCount}`,
  );
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
