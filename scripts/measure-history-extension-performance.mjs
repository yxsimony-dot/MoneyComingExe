import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { assertElectronWindowOffscreen } from '../tests/electron-offscreen.mjs';
import { launchElectronTest } from '../tests/electron-test-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const currentDataDirectory = join(root, 'data');
const instrumentDirectoryName = 'instruments';
const syntheticOffsetsDays = [-735, -371, -7, 0];
const outputDirectory = join(root, 'artifacts');
const executablePath = resolve(
  process.env.MONEYCOMING_EXE
    || join(root, 'release', 'win-unpacked', 'MoneyComing.exe'),
);
const packageManifest = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const installerPath = join(
  root,
  'release',
  `MoneyComing-Setup-${packageManifest.version}-x64.exe`,
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseBeijing(value, label) {
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    `${label} 时间格式无效`,
  );
  const parsed = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  assert.ok(Number.isFinite(parsed), `${label} 时间无效`);
  return parsed;
}

function formatBeijing(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function shiftBeijing(value, days, label) {
  return formatBeijing(parseBeijing(value, label) + days * 24 * 60 * 60 * 1000);
}

function extendBarCsv(text, label) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  assert.ok(lines.length > 1, `${label} 缺少行情记录`);
  const header = lines[0].split(',');
  const startIndex = header.indexOf('bar_start');
  const endIndex = header.indexOf('bar_end');
  assert.ok(startIndex >= 0 && endIndex >= 0, `${label} 缺少时间列`);
  const sourceRows = lines.slice(1).map((line, index) => {
    const fields = line.split(',');
    assert.equal(
      fields.length,
      header.length,
      `${label} 第 ${index + 2} 行列数不一致`,
    );
    return fields;
  });
  const rowsByStart = new Map();
  for (const offsetDays of syntheticOffsetsDays) {
    for (const source of sourceRows) {
      const fields = [...source];
      fields[startIndex] = shiftBeijing(
        fields[startIndex],
        offsetDays,
        `${label} bar_start`,
      );
      fields[endIndex] = shiftBeijing(
        fields[endIndex],
        offsetDays,
        `${label} bar_end`,
      );
      rowsByStart.set(fields[startIndex], fields.join(','));
    }
  }
  const rows = [...rowsByStart.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, line]) => line);
  return {
    text: `${[lines[0], ...rows].join('\n')}\n`,
    rows: rows.length,
    first: rows[0].split(',')[startIndex],
    last: rows.at(-1).split(',')[endIndex],
  };
}

async function extendInstrument(directory) {
  const metadataPath = join(directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const periods = [
    ['bars5', 'edb_main_continuous_5m.csv'],
    ['bars60', 'edb_main_continuous_60m.csv'],
  ];
  const summary = {
    instrumentId: metadata.instrumentId,
    periods: {},
  };
  for (const [key, expectedName] of periods) {
    const declared = metadata.files?.[key];
    assert.equal(
      declared?.name,
      expectedName,
      `${metadata.instrumentId} ${key} 文件声明无效`,
    );
    const path = join(directory, expectedName);
    const extended = extendBarCsv(
      await readFile(path, 'utf8'),
      `${metadata.instrumentId}/${expectedName}`,
    );
    await writeFile(path, extended.text, 'utf8');
    metadata.files[key] = {
      ...declared,
      rows: extended.rows,
      sha256: sha256(extended.text),
    };
    summary.periods[key] = {
      rows: extended.rows,
      first: extended.first,
      last: extended.last,
      bytes: Buffer.byteLength(extended.text),
    };
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return summary;
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory()
      ? await directorySize(path)
      : (await stat(path)).size;
  }
  return total;
}

async function gzipFileSize(path) {
  return new Promise((resolvePromise, reject) => {
    let bytes = 0;
    const source = createReadStream(path);
    const gzip = createGzip({ level: 9 });
    source.on('error', reject);
    gzip.on('error', reject);
    gzip.on('data', chunk => {
      bytes += chunk.length;
    });
    gzip.on('end', () => resolvePromise(bytes));
    source.pipe(gzip);
  });
}

async function compressedDirectorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory()
      ? await compressedDirectorySize(path)
      : await gzipFileSize(path);
  }
  return total;
}

const wait = milliseconds => new Promise(resolvePromise => {
  setTimeout(resolvePromise, milliseconds);
});

function percentile(values, percentileValue) {
  assert.ok(values.length > 0, '百分位数计算需要样本');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

async function measureScenario(label, builtinDataDirectory) {
  const sandbox = await mkdtemp(join(tmpdir(), `moneycoming-history-${label}-`));
  const environment = {
    ...process.env,
    APPDATA: join(sandbox, 'appdata'),
    LOCALAPPDATA: join(sandbox, 'localappdata'),
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_BUILTIN_DATA: builtinDataDirectory,
    MONEYCOMING_TEST_USER_DATA: join(sandbox, 'user-data'),
    MONEYCOMING_TEST_EDB_MODE: 'offline',
  };
  delete environment.ELECTRON_RUN_AS_NODE;

  const result = {
    label,
    builtinDataDirectory,
    startupMs: 0,
    startupPeakWorkingSetBytes: 0,
    peakWorkingSetBytes: 0,
    switchPeakWorkingSetBytes: 0,
    memorySamples: [],
    switches: [],
    switchSummary: {},
    offscreen: {},
  };
  const started = performance.now();
  let app;
  let monitorRunning = false;
  let startupComplete = false;
  let memoryMonitor;

  async function sampleMemory(phase) {
    const sample = await app.evaluate(({ app: electronApp }) => {
      const processes = electronApp.getAppMetrics().map(metric => ({
        pid: metric.pid,
        type: metric.type,
        workingSetBytes: metric.memory.workingSetSize * 1024,
      }));
      return {
        workingSetBytes: processes.reduce(
          (total, process) => total + process.workingSetBytes,
          0,
        ),
        processes,
      };
    });
    result.memorySamples.push({
      phase,
      elapsedMs: performance.now() - started,
      ...sample,
    });
    result.peakWorkingSetBytes = Math.max(
      result.peakWorkingSetBytes,
      sample.workingSetBytes,
    );
    if (startupComplete) {
      result.switchPeakWorkingSetBytes = Math.max(
        result.switchPeakWorkingSetBytes,
        sample.workingSetBytes,
      );
    } else {
      result.startupPeakWorkingSetBytes = Math.max(
        result.startupPeakWorkingSetBytes,
        sample.workingSetBytes,
      );
    }
  }

  async function monitorMemory() {
    while (monitorRunning) {
      await sampleMemory(startupComplete ? 'switching' : 'startup').catch(
        () => undefined,
      );
      await wait(50);
    }
  }

  async function frame(page, count = 2) {
    for (let index = 0; index < count; index += 1) {
      await page.evaluate(() => new Promise(resolveFrame => {
        requestAnimationFrame(resolveFrame);
      }));
    }
  }

  try {
    app = await launchElectronTest({
      executablePath,
      args: [],
      cwd: sandbox,
      env: environment,
      timeout: 120_000,
    });
    monitorRunning = true;
    memoryMonitor = monitorMemory();
    const page = await app.firstWindow();
    page.setDefaultTimeout(120_000);
    result.offscreen.beforeShow = await assertElectronWindowOffscreen(
      app,
      `${label}-before-show`,
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    });
    result.offscreen.afterShow = await assertElectronWindowOffscreen(
      app,
      `${label}-after-show`,
    );
    await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor();
    await frame(page);
    result.startupMs = performance.now() - started;
    await sampleMemory('startup-ready');
    startupComplete = true;

    const instruments = await page.getByTestId('instrument').locator('option').evaluateAll(
      options => options.map(option => ({
        instrumentId: option.value,
        name: option.textContent?.trim() || option.value,
      })),
    );
    assert.equal(instruments.length, 15, `${label} 必须包含 15 个品种`);
    const switchOrder = [...instruments.slice(1), instruments[0]];
    for (const instrument of switchOrder) {
      const switchStarted = performance.now();
      await page.getByTestId('instrument').evaluate((selector, instrumentId) => {
        selector.value = instrumentId;
        selector.dispatchEvent(new Event('change', { bubbles: true }));
      }, instrument.instrumentId);
      await page.waitForFunction(instrumentId => (
        document.documentElement.dataset.ready === 'true'
        && document.documentElement.dataset.instrument === instrumentId
        && document.querySelector('#instrument')?.getAttribute('data-loaded') === instrumentId
      ), instrument.instrumentId);
      await frame(page);
      const durationMs = performance.now() - switchStarted;
      await sampleMemory(`switch-${instrument.instrumentId}`);
      result.switches.push({
        ...instrument,
        durationMs,
      });
    }
    const switchDurations = result.switches.map(item => item.durationMs);
    result.switchSummary = {
      count: switchDurations.length,
      minMs: Math.min(...switchDurations),
      medianMs: percentile(switchDurations, 0.5),
      p95Ms: percentile(switchDurations, 0.95),
      maxMs: Math.max(...switchDurations),
    };
    result.offscreen.beforeClose = await assertElectronWindowOffscreen(
      app,
      `${label}-before-close`,
    );
    return result;
  } finally {
    monitorRunning = false;
    await memoryMonitor;
    if (app) await app.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
}

function difference(synthetic, current) {
  return synthetic - current;
}

function bytes(value) {
  return `${value.toLocaleString('zh-CN')} B`;
}

function milliseconds(value) {
  return `${value.toFixed(1)} ms`;
}

function markdownReport(report) {
  const current = report.performance.current;
  const synthetic = report.performance.syntheticThreeYear;
  return `# 三年以上 5/60 分钟基线性能评估

生成时间：${report.generatedAt}

## 结论

- 本报告中的三年数据是把当前真实 5/60 分钟 K 线按整周日期偏移后生成的合成压力数据，仅用于测量体积和性能。
- 合成数据不是历史行情，不包含真实的早期主力映射与换月事实，不能替换发布基线，也不能用于交易、回测或对外分发。
- 当前真实基线仍未满足十五个品种 5/60 分钟至少三年的发布门槛。

## 数据体积

| 指标 | 当前基线 | 三年合成基线 | 差异 |
| --- | ---: | ---: | ---: |
| data 目录 | ${bytes(report.storage.currentDataBytes)} | ${bytes(report.storage.syntheticDataBytes)} | ${bytes(report.storage.syntheticDataBytes - report.storage.currentDataBytes)} |
| instruments 目录 | ${bytes(report.storage.currentInstrumentBytes)} | ${bytes(report.storage.syntheticInstrumentBytes)} | ${bytes(report.storage.syntheticInstrumentBytes - report.storage.currentInstrumentBytes)} |
| 当前安装包 | ${bytes(report.storage.currentInstallerBytes)} | - | - |
| 三年安装包估算 | - | ${bytes(report.storage.estimatedSyntheticInstallerBytes)} | ${bytes(report.storage.estimatedSyntheticInstallerBytes - report.storage.currentInstallerBytes)} |

安装包估算使用当前与合成 instruments 目录逐文件 gzip 体积差作为压缩增量代理，不等同于正式 NSIS 构建结果。

## 运行性能

| 指标 | 当前基线 | 三年合成基线 | 差异 |
| --- | ---: | ---: | ---: |
| 启动到 data-ready | ${milliseconds(current.startupMs)} | ${milliseconds(synthetic.startupMs)} | ${milliseconds(synthetic.startupMs - current.startupMs)} |
| 启动峰值 working set | ${bytes(current.startupPeakWorkingSetBytes)} | ${bytes(synthetic.startupPeakWorkingSetBytes)} | ${bytes(synthetic.startupPeakWorkingSetBytes - current.startupPeakWorkingSetBytes)} |
| 全程峰值 working set | ${bytes(current.peakWorkingSetBytes)} | ${bytes(synthetic.peakWorkingSetBytes)} | ${bytes(synthetic.peakWorkingSetBytes - current.peakWorkingSetBytes)} |
| 15 次切换中位数 | ${milliseconds(current.switchSummary.medianMs)} | ${milliseconds(synthetic.switchSummary.medianMs)} | ${milliseconds(synthetic.switchSummary.medianMs - current.switchSummary.medianMs)} |
| 15 次切换 P95 | ${milliseconds(current.switchSummary.p95Ms)} | ${milliseconds(synthetic.switchSummary.p95Ms)} | ${milliseconds(synthetic.switchSummary.p95Ms - current.switchSummary.p95Ms)} |
| 15 次切换最大值 | ${milliseconds(current.switchSummary.maxMs)} | ${milliseconds(synthetic.switchSummary.maxMs)} | ${milliseconds(synthetic.switchSummary.maxMs - current.switchSummary.maxMs)} |

## 环境

- 可执行文件：\`${report.executablePath}\`
- 操作系统：${report.machine.os}
- CPU：${report.machine.cpu}
- 逻辑处理器：${report.machine.logicalCpus}
- 物理内存：${(report.machine.totalMemoryBytes / 2 ** 30).toFixed(2)} GiB
- 合成日期偏移：${report.syntheticMethod.offsetDays.map(value => `${value} 天`).join('、')}
- 窗口验收：当前与合成两次运行在首次显示前、显示后和关闭前均验证为完全离屏
`;
}

assert.equal(process.platform, 'win32', '该性能验收脚本当前只支持 Windows');
assert.equal((await stat(executablePath)).isFile(), true, `缺少可执行文件：${executablePath}`);
assert.equal((await stat(installerPath)).isFile(), true, `缺少安装包：${installerPath}`);

await mkdir(outputDirectory, { recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), 'moneycoming-history-extension-'));
const syntheticDataDirectory = join(temporaryRoot, 'data');
let report;
try {
  await cp(currentDataDirectory, syntheticDataDirectory, { recursive: true });
  const instrumentRoot = join(syntheticDataDirectory, instrumentDirectoryName);
  const instrumentEntries = (await readdir(instrumentRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.equal(instrumentEntries.length, 15, '合成基线必须包含 15 个品种');
  const syntheticInstruments = [];
  for (const entry of instrumentEntries) {
    syntheticInstruments.push(await extendInstrument(join(instrumentRoot, entry.name)));
  }

  const [
    currentDataBytes,
    syntheticDataBytes,
    currentInstrumentBytes,
    syntheticInstrumentBytes,
    currentCompressedInstrumentBytes,
    syntheticCompressedInstrumentBytes,
    installerInfo,
  ] = await Promise.all([
    directorySize(currentDataDirectory),
    directorySize(syntheticDataDirectory),
    directorySize(join(currentDataDirectory, instrumentDirectoryName)),
    directorySize(join(syntheticDataDirectory, instrumentDirectoryName)),
    compressedDirectorySize(join(currentDataDirectory, instrumentDirectoryName)),
    compressedDirectorySize(join(syntheticDataDirectory, instrumentDirectoryName)),
    stat(installerPath),
  ]);

  const current = await measureScenario('current', currentDataDirectory);
  const syntheticThreeYear = await measureScenario(
    'synthetic-three-year',
    syntheticDataDirectory,
  );
  const estimatedSyntheticInstallerBytes = Math.round(
    installerInfo.size
      + syntheticCompressedInstrumentBytes
      - currentCompressedInstrumentBytes,
  );

  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: 'three-year-five-sixty-minute-performance-estimate',
    executablePath,
    installerPath,
    machine: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    syntheticMethod: {
      disclaimer: '合成数据仅用于性能压力评估，不是真实行情，不能替换发布基线。',
      offsetDays: syntheticOffsetsDays,
      unchangedOneMinuteData: true,
      generatedInSystemTemporaryDirectory: true,
      instruments: syntheticInstruments,
    },
    storage: {
      currentDataBytes,
      syntheticDataBytes,
      dataDifferenceBytes: difference(syntheticDataBytes, currentDataBytes),
      currentInstrumentBytes,
      syntheticInstrumentBytes,
      instrumentDifferenceBytes: difference(
        syntheticInstrumentBytes,
        currentInstrumentBytes,
      ),
      currentCompressedInstrumentBytes,
      syntheticCompressedInstrumentBytes,
      currentInstallerBytes: installerInfo.size,
      estimatedSyntheticInstallerBytes,
      estimatedInstallerDifferenceBytes: difference(
        estimatedSyntheticInstallerBytes,
        installerInfo.size,
      ),
      installerEstimateMethod: '当前安装包 + 合成与当前 instruments 目录逐文件 gzip 体积差',
    },
    performance: {
      current,
      syntheticThreeYear,
      differences: {
        startupMs: difference(syntheticThreeYear.startupMs, current.startupMs),
        startupPeakWorkingSetBytes: difference(
          syntheticThreeYear.startupPeakWorkingSetBytes,
          current.startupPeakWorkingSetBytes,
        ),
        peakWorkingSetBytes: difference(
          syntheticThreeYear.peakWorkingSetBytes,
          current.peakWorkingSetBytes,
        ),
        switchMedianMs: difference(
          syntheticThreeYear.switchSummary.medianMs,
          current.switchSummary.medianMs,
        ),
        switchP95Ms: difference(
          syntheticThreeYear.switchSummary.p95Ms,
          current.switchSummary.p95Ms,
        ),
        switchMaxMs: difference(
          syntheticThreeYear.switchSummary.maxMs,
          current.switchSummary.maxMs,
        ),
      },
    },
  };
  await writeFile(
    join(outputDirectory, 'history-extension-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(outputDirectory, 'history-extension-performance.md'),
    markdownReport(report),
    'utf8',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  generatedAt: report.generatedAt,
  currentDataBytes: report.storage.currentDataBytes,
  syntheticDataBytes: report.storage.syntheticDataBytes,
  currentStartupMs: report.performance.current.startupMs,
  syntheticStartupMs: report.performance.syntheticThreeYear.startupMs,
  currentSwitchP95Ms: report.performance.current.switchSummary.p95Ms,
  syntheticSwitchP95Ms: report.performance.syntheticThreeYear.switchSummary.p95Ms,
  currentPeakWorkingSetBytes: report.performance.current.peakWorkingSetBytes,
  syntheticPeakWorkingSetBytes: report.performance.syntheticThreeYear.peakWorkingSetBytes,
  output: basename(join(outputDirectory, 'history-extension-performance.json')),
}));
