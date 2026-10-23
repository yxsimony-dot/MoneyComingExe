import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';
import {
  createMultiInstrumentFixture,
  MULTI_INSTRUMENT_DEFINITIONS,
} from './multi-instrument-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureMode = process.argv.includes('--fixture');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const outputDirectory = join(root, 'artifacts');
const outputPath = join(
  outputDirectory,
  fixtureMode
    ? 'instrument-switch-performance-fixture.json'
    : 'instrument-switch-performance-baseline.json',
);
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-switch-performance-'));
const memorySampleIntervalMs = 50;
const switchTimeoutMs = fixtureMode ? 30_000 : 180_000;
const coldRunCount = 3;
const cachedRunCount = 3;
const pageErrors = [];
let app;
let fixture;
let failure;
let memoryMonitor;
let monitorRunning = false;
let activeMemoryPhase = 'startup';

await mkdir(outputDirectory, { recursive: true });

if (fixtureMode) {
  fixture = await createMultiInstrumentFixture(join(sandbox, 'builtin-data'));
}

const baselineDirectory = fixtureMode
  ? fixture.builtinDataDirectory
  : executable
    ? join(dirname(executable), 'data')
    : join(root, 'data');
const baselineReportPath = join(baselineDirectory, 'baseline-report.json');
const baselineReport = fixtureMode
  ? {
      generatedAt: 'fixture',
      instruments: MULTI_INSTRUMENT_DEFINITIONS.map(definition => ({
        instrumentId: definition.id,
        name: definition.name,
        status: 'succeeded',
        fiveMinuteRows: 24,
        sixtyMinuteRows: 2,
        periods: {
          bars5: {
            first: '2026-10-08 09:00:00',
            last: '2026-10-09 10:00:00',
            rows: 24,
          },
          bars60: {
            first: '2026-10-08 09:00:00',
            last: '2026-10-09 10:00:00',
            rows: 2,
          },
        },
      })),
    }
  : JSON.parse(await readFile(baselineReportPath, 'utf8'));

assert.equal(
  baselineReport.instruments.length,
  15,
  '性能基线必须包含 15 个品种',
);
assert.deepEqual(
  baselineReport.instruments.map(instrument => instrument.status),
  Array(15).fill('succeeded'),
  '性能基线中的 15 个品种必须全部生成成功',
);

function parseBeijing(value) {
  return Date.parse(`${value.replace(' ', 'T')}+08:00`);
}

if (!fixtureMode) {
  for (const instrument of baselineReport.instruments) {
    const first = parseBeijing(instrument.periods.bars5.first);
    const last = parseBeijing(instrument.periods.bars5.last);
    assert.ok(
      Number.isFinite(first) && Number.isFinite(last),
      `${instrument.name} 五分钟基线时间无效`,
    );
    assert.ok(
      last - first >= 365 * 4.9 * 24 * 60 * 60 * 1000,
      `${instrument.name} 五分钟基线未覆盖约五年`,
    );
    assert.ok(instrument.periods.bars5.rows > 0);
    assert.ok(instrument.periods.bars60.rows > 0);
  }
}

const environment = {
  ...process.env,
  APPDATA: join(sandbox, 'appdata'),
  LOCALAPPDATA: join(sandbox, 'localappdata'),
  MONEYCOMING_TEST_MODE: '1',
  MONEYCOMING_TEST_BUILTIN_DATA: baselineDirectory,
  MONEYCOMING_TEST_USER_DATA: join(sandbox, 'user-data'),
  MONEYCOMING_TEST_EDB_MODE: 'offline',
};
delete environment.ELECTRON_RUN_AS_NODE;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  passed: false,
  mode: fixtureMode ? 'fixture' : 'real-five-year-baseline',
  packaged: Boolean(executable),
  executablePath: executable,
  baselineDirectory,
  baselineReportPath: fixtureMode ? undefined : baselineReportPath,
  baselineGeneratedAt: baselineReport.generatedAt,
  machine: {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  configuration: {
    window: { width: 1440, height: 900 },
    coldRunCount,
    cachedRunCount,
    memorySampleIntervalMs,
    longTaskThresholdMs: 50,
  },
  startup: {},
  samples: {
    cold: [],
    cached: [],
  },
  memorySamples: [],
  summary: {},
  offscreen: {},
  errors: pageErrors,
};

const wait = milliseconds => new Promise(resolvePromise => {
  setTimeout(resolvePromise, milliseconds);
});

function percentile(values, ratio) {
  assert.ok(values.length > 0, '百分位统计需要至少一个样本');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    count: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

function countersFor(diagnostics, instrumentId) {
  return diagnostics?.instruments?.[instrumentId] ?? {
    preparationStarted: 0,
    preparationCompleted: 0,
    preparationFailed: 0,
    cacheHits: 0,
  };
}

function subtractCounters(after, before) {
  return {
    preparationStarted: after.preparationStarted - before.preparationStarted,
    preparationCompleted: after.preparationCompleted - before.preparationCompleted,
    preparationFailed: after.preparationFailed - before.preparationFailed,
    cacheHits: after.cacheHits - before.cacheHits,
  };
}

async function frame(page, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => {
      requestAnimationFrame(resolveFrame);
    }));
  }
}

async function dataServiceDiagnostics() {
  return app.evaluate(() => globalThis.__moneyComingTest
    ?.getDataServiceDiagnostics());
}

async function sampleMemory(phase = activeMemoryPhase) {
  const sample = await app.evaluate(({ app: electronApp }) => {
    const processes = electronApp.getAppMetrics().map(metric => ({
      pid: metric.pid,
      type: metric.type,
      creationTime: metric.creationTime,
      cpuPercent: metric.cpu.percentCPUUsage,
      workingSetBytes: metric.memory.workingSetSize * 1024,
      peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
    }));
    return {
      totalWorkingSetBytes: processes.reduce(
        (total, process) => total + process.workingSetBytes,
        0,
      ),
      totalPeakWorkingSetBytes: processes.reduce(
        (total, process) => total + process.peakWorkingSetBytes,
        0,
      ),
      processes,
    };
  });
  report.memorySamples.push({
    sequence: report.memorySamples.length + 1,
    timestamp: new Date().toISOString(),
    phase,
    ...sample,
  });
  return sample;
}

async function monitorMemory() {
  while (monitorRunning) {
    await sampleMemory().catch(() => undefined);
    await wait(memorySampleIntervalMs);
  }
}

async function resetSwitchDiagnostics(page) {
  await page.evaluate(() => {
    window.moneyComingTest?.resetRendererPerformanceDiagnostics();
    const collector = window.__moneyComingLongTaskCollector;
    if (!collector) return;
    collector.entries.length = 0;
    collector.observer.takeRecords();
  });
}

async function collectLongTasks(page) {
  return page.evaluate(() => {
    const collector = window.__moneyComingLongTaskCollector;
    if (!collector) return [];
    collector.entries.push(...collector.observer.takeRecords().map(entry => ({
      name: entry.name,
      entryType: entry.entryType,
      startTime: entry.startTime,
      duration: entry.duration,
    })));
    const entries = collector.entries.map(entry => ({ ...entry }));
    collector.entries.length = 0;
    return entries;
  });
}

async function switchInstrument(page, kind, target, sequence) {
  const sampleId = `${kind}-${sequence}-${target.instrumentId}`;
  const fromInstrument = await page.locator('html').getAttribute('data-instrument');
  const diagnosticsBefore = await dataServiceDiagnostics();
  await resetSwitchDiagnostics(page);
  const memoryStartIndex = report.memorySamples.length;
  activeMemoryPhase = sampleId;
  const started = performance.now();

  await page.locator('#instrument').evaluate((selector, instrumentId) => {
    selector.value = instrumentId;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  }, target.instrumentId);
  await page.waitForFunction(instrumentId => (
    document.documentElement.dataset.ready === 'true'
    && document.documentElement.dataset.instrument === instrumentId
    && document.querySelector('#instrument')?.getAttribute('data-loaded') === instrumentId
  ), target.instrumentId, { timeout: switchTimeoutMs });
  await frame(page);
  await page.waitForTimeout(0);

  const durationMs = performance.now() - started;
  await sampleMemory(sampleId);
  const memoryEndIndex = report.memorySamples.length;
  const [rendererDiagnostics, diagnosticsAfter, longTasks] = await Promise.all([
    page.evaluate(() => window.moneyComingTest?.rendererPerformanceDiagnostics()),
    dataServiceDiagnostics(),
    collectLongTasks(page),
  ]);
  assert.ok(rendererDiagnostics, `${sampleId} 缺少渲染性能诊断`);
  assert.ok(diagnosticsBefore && diagnosticsAfter, `${sampleId} 缺少数据服务诊断`);

  const request = rendererDiagnostics.events.find(event => (
    event.type === 'switch-requested'
    && event.instrument === target.instrumentId
  ));
  assert.ok(request, `${sampleId} 缺少切换请求事件`);
  const events = rendererDiagnostics.events.filter(
    event => event.requestId === request.requestId,
  );
  assert.deepEqual(
    events.map(event => event.type),
    [
      'switch-requested',
      'loading-visible',
      'dataset-ready',
      'chart-commit',
      'strategy-summary-ready',
    ],
    `${sampleId} 渲染事件顺序无效`,
  );
  const eventTimes = Object.fromEntries(
    events.map(event => [event.type, event.timestampMs]),
  );
  const beforeCounters = countersFor(diagnosticsBefore, target.instrumentId);
  const afterCounters = countersFor(diagnosticsAfter, target.instrumentId);
  const serviceDelta = subtractCounters(afterCounters, beforeCounters);
  if (kind === 'cold') {
    assert.equal(
      serviceDelta.preparationStarted,
      1,
      `${sampleId} 冷切换必须触发一次逻辑数据准备`,
    );
  } else {
    assert.equal(
      serviceDelta.cacheHits,
      1,
      `${sampleId} 缓存切换必须命中一次完成缓存`,
    );
    assert.equal(
      serviceDelta.preparationStarted,
      0,
      `${sampleId} 缓存切换不得重新准备数据`,
    );
  }

  const memory = report.memorySamples.slice(memoryStartIndex, memoryEndIndex);
  const fullSetDataCalls = rendererDiagnostics.fullSetDataCalls.filter(
    call => call.requestId === request.requestId,
  );
  const strategyDerivations = rendererDiagnostics.strategyDerivations.filter(
    call => call.requestId === request.requestId,
  );
  return {
    id: sampleId,
    kind,
    sequence,
    fromInstrument,
    instrumentId: target.instrumentId,
    name: target.name,
    durationMs,
    renderer: {
      requestId: request.requestId,
      events,
      timingsMs: {
        loadingVisible: eventTimes['loading-visible'] - eventTimes['switch-requested'],
        datasetReady: eventTimes['dataset-ready'] - eventTimes['switch-requested'],
        chartCommit: eventTimes['chart-commit'] - eventTimes['switch-requested'],
        strategySummaryReady: (
          eventTimes['strategy-summary-ready'] - eventTimes['switch-requested']
        ),
      },
      fullSetDataCalls,
      strategyDerivations,
    },
    dataService: {
      before: diagnosticsBefore,
      after: diagnosticsAfter,
      delta: serviceDelta,
    },
    longTasks: {
      entries: longTasks,
      count: longTasks.length,
      maxDurationMs: Math.max(0, ...longTasks.map(entry => entry.duration)),
      totalDurationMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
    },
    memory: {
      sampleStartIndex: memoryStartIndex,
      sampleEndIndexExclusive: memoryEndIndex,
      peakWorkingSetBytes: Math.max(
        0,
        ...memory.map(item => item.totalWorkingSetBytes),
      ),
      samples: memory,
    },
  };
}

try {
  const started = performance.now();
  app = await launchElectronTest({
    ...(executable
      ? { executablePath: executable, args: [], cwd: sandbox }
      : { args: [root], cwd: root }),
    env: environment,
    timeout: switchTimeoutMs,
  });
  monitorRunning = true;
  memoryMonitor = monitorMemory();

  const page = await app.firstWindow();
  page.setDefaultTimeout(switchTimeoutMs);
  page.on('pageerror', error => pageErrors.push(error.message));
  report.offscreen.beforeShow = await assertElectronWindowOffscreen(
    app,
    'instrument-switch-performance-before-show',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.setSize(1440, 900);
    window.showInactive();
  });
  report.offscreen.afterShow = await assertElectronWindowOffscreen(
    app,
    'instrument-switch-performance-after-show',
  );
  await page.locator(
    'html[data-ready="true"][data-instrument="main_continuous"]',
  ).waitFor({ timeout: switchTimeoutMs });
  await frame(page);
  report.startup = {
    durationMs: performance.now() - started,
    instrumentId: 'main_continuous',
    dataService: await dataServiceDiagnostics(),
  };

  await page.evaluate(() => {
    const entries = [];
    const observer = new PerformanceObserver(list => {
      entries.push(...list.getEntries().map(entry => ({
        name: entry.name,
        entryType: entry.entryType,
        startTime: entry.startTime,
        duration: entry.duration,
      })));
    });
    observer.observe({ type: 'longtask', buffered: true });
    window.__moneyComingLongTaskCollector = { entries, observer };
  });
  await resetSwitchDiagnostics(page);

  const selectorOptions = await page.getByTestId('instrument').locator('option')
    .evaluateAll(options => options.map(option => ({
      instrumentId: option.value,
      name: option.textContent?.trim() || option.value,
    })));
  assert.deepEqual(
    selectorOptions,
    baselineReport.instruments.map(instrument => ({
      instrumentId: instrument.instrumentId,
      name: instrument.name,
    })),
    '性能脚本中的品种顺序必须与基线报告一致',
  );

  const coldTargets = selectorOptions.slice(1, coldRunCount + 1);
  for (const [index, target] of coldTargets.entries()) {
    report.samples.cold.push(
      await switchInstrument(page, 'cold', target, index + 1),
    );
  }
  const cachedTargets = [
    coldTargets[0],
    coldTargets[1],
    coldTargets[0],
  ].slice(0, cachedRunCount);
  for (const [index, target] of cachedTargets.entries()) {
    report.samples.cached.push(
      await switchInstrument(page, 'cached', target, index + 1),
    );
  }

  activeMemoryPhase = 'completed';
  await sampleMemory('completed');
  const allLongTasks = [
    ...report.samples.cold,
    ...report.samples.cached,
  ].flatMap(sample => sample.longTasks.entries.map(entry => ({
    sampleId: sample.id,
    ...entry,
  })));
  const coldDurations = report.samples.cold.map(sample => sample.durationMs);
  const cachedDurations = report.samples.cached.map(sample => sample.durationMs);
  report.summary = {
    cold: summarize(coldDurations),
    cached: summarize(cachedDurations),
    longTasks: {
      count: allLongTasks.length,
      maxDurationMs: Math.max(0, ...allLongTasks.map(entry => entry.duration)),
      entries: allLongTasks,
    },
    memory: {
      sampleCount: report.memorySamples.length,
      peakWorkingSetBytes: Math.max(
        ...report.memorySamples.map(sample => sample.totalWorkingSetBytes),
      ),
      source: 'electron.app.getAppMetrics',
    },
  };
  assert.deepEqual(pageErrors, []);
  report.offscreen.beforeClose = await assertElectronWindowOffscreen(
    app,
    'instrument-switch-performance-before-close',
  );
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  monitorRunning = false;
  await memoryMonitor;
  if (app) {
    await app.close().catch(error => {
      failure ??= error;
    });
  }
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(Array.isArray(parsed.samples?.cold), true);
  assert.equal(Array.isArray(parsed.samples?.cached), true);
  assert.equal(Array.isArray(parsed.memorySamples), true);
  await rm(sandbox, { recursive: true, force: true });
}

if (failure) throw failure;
console.log(JSON.stringify({
  passed: report.passed,
  mode: report.mode,
  coldMedianMs: report.summary.cold.medianMs,
  cachedMedianMs: report.summary.cached.medianMs,
  longTaskCount: report.summary.longTasks.count,
  peakWorkingSetBytes: report.summary.memory.peakWorkingSetBytes,
  output: outputPath,
}));
