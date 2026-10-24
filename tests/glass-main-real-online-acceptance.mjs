import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'artifacts');
const realUserData = resolve(
  process.env.MONEYCOMING_REAL_USER_DATA
    ?? 'C:\\Users\\yangxiaoyuan\\AppData\\Roaming\\MoneyComing',
);
const realMarketData = join(realUserData, 'market-data');
const instrumentRoot = join(realMarketData, 'instruments', 'glass_main');
const snapshotsRoot = join(instrumentRoot, 'snapshots');
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-glass-main-real-'));
const testUserData = join(sandbox, 'user-data');
const reportPath = join(
  outputDirectory,
  'glass-main-real-online-acceptance.json',
);
const screenshotPath = join(
  outputDirectory,
  'glass-main-real-online-acceptance.png',
);

await mkdir(outputDirectory, { recursive: true });
await mkdir(testUserData, { recursive: true });
await symlink(realMarketData, join(testUserData, 'market-data'), 'junction');

const report = {
  passed: false,
  realUserData,
  marketDataLink: {
    path: join(testUserData, 'market-data'),
    target: realMarketData,
  },
  offscreen: [],
  offlineGui: {},
  before: {},
  fullGate: {},
  tailPoll: {},
  after: {},
  pageErrors: [],
};

let app;
let failure;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function snapshotState() {
  const pointer = await readJson(join(instrumentRoot, 'current.json'));
  const directory = join(snapshotsRoot, pointer.snapshotId);
  const metadataText = await readFile(join(directory, 'metadata.json'), 'utf8');
  return {
    pointer,
    directory,
    metadata: JSON.parse(metadataText),
    metadataSha256: sha256(metadataText),
  };
}

async function directoryFileHashes(directory) {
  const hashes = {};

  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        hashes[relative(directory, path).replaceAll('\\', '/')] = sha256(
          await readFile(path),
        );
      }
    }
  }

  await visit(directory);
  return hashes;
}

async function frame(page, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => (
      requestAnimationFrame(resolveFrame)
    )));
  }
}

async function diagnostics(action = 'all') {
  return app.evaluate((_electron, operation) => {
    const test = globalThis.__moneyComingTest;
    if (!test) throw new Error('MoneyComing test diagnostics are unavailable.');
    if (operation === 'clear') {
      test.clearDiagnostics();
      return null;
    }
    return {
      market: test.getMarketStates(),
      online: test.getOnlineStates(),
      dataService: test.getDataServiceDiagnostics(),
    };
  }, action);
}

async function waitForMarketState(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await diagnostics();
    const match = current.market.findLast(predicate);
    if (match) return { match, diagnostics: current };
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  const current = await diagnostics();
  throw new Error(
    `${label} timed out after ${timeoutMs}ms: ${JSON.stringify(current.market.slice(-10))}`,
  );
}

async function switchInstrument(page, instrument) {
  await page.locator('#instrument').evaluate((selector, value) => {
    selector.value = value;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  }, instrument);
  await page.waitForFunction(value => (
    document.documentElement.dataset.instrument === value
    && document.querySelector('#instrument')?.getAttribute('data-loaded') === value
    && document.documentElement.dataset.ready === 'true'
  ), instrument, { timeout: 60_000 });
  await frame(page, 4);
}

async function chartGeometry(page, period) {
  return page.locator(`#canvas-${period}`).evaluate(container => {
    const rectangle = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const canvases = Array.from(container.querySelectorAll('canvas'));
    return {
      width: rectangle.width,
      height: rectangle.height,
      display: style.display,
      visibility: style.visibility,
      canvasCount: canvases.length,
      paintedCanvases: canvases.filter(
        canvas => canvas.width > 0 && canvas.height > 0,
      ).length,
    };
  });
}

function assertChartRendered(period, geometry, message) {
  assert.ok(
    geometry.width > 0
      && geometry.height > 0
      && geometry.display !== 'none'
      && geometry.visibility !== 'hidden'
      && geometry.canvasCount > 0
      && geometry.paintedCanvases > 0,
    `${period} minute chart ${message}: ${JSON.stringify(geometry)}`,
  );
}

async function datasetSummary(page, protection) {
  return page.evaluate(async benchmarkProtection => {
    const result = await window.market.load('glass_main', true);
    if (!result.ok) throw new Error(result.error);
    const data = result.data;
    const encoder = new TextEncoder();
    const hash = async value => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(JSON.stringify(value)),
      );
      return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
    };
    const parseBeijing = value => Date.parse(
      `${value.slice(0, 10)}T${value.slice(11)}+08:00`,
    );
    const firstProtectedMs = parseBeijing(
      benchmarkProtection.bars5.firstStart,
    );
    const protectedEndMs = parseBeijing(
      benchmarkProtection.bars5.lastEnd,
    );
    const minuteProjection = record => [
      record.datetimeNano,
      record.startMs,
      record.start,
      record.open,
      record.high,
      record.low,
      record.close,
      record.volume,
      record.openOi,
      record.closeOi,
    ];
    const barProjection = bar => [
      bar.startMs,
      bar.endMs,
      bar.start,
      bar.end,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      bar.openOi,
      bar.closeOi,
      bar.session,
      bar.observedMinutes,
      bar.expectedMinutes,
      bar.complete,
    ];
    const mappingProjection = mapping => [
      mapping.tradingDate,
      mapping.contract,
    ];
    const rolloverProjection = rollover => [
      rollover.tradingDate,
      rollover.time,
      rollover.timeMs,
      rollover.fromContract,
      rollover.toContract,
    ];
    const protectedRows = {
      bars1: data.bars1.filter(record => (
        record.startMs >= firstProtectedMs
        && record.startMs + 60_000 <= protectedEndMs
      )),
      bars5: data.bars5.filter(bar => (
        bar.startMs >= firstProtectedMs
        && bar.endMs <= protectedEndMs
      )),
      bars60: data.bars60.filter(bar => (
        bar.startMs >= firstProtectedMs
        && bar.endMs <= protectedEndMs
      )),
      mappings: data.mainContractMappings.filter(mapping => (
        mapping.tradingDate >= benchmarkProtection.mappings.firstTradingDate
        && mapping.tradingDate <= benchmarkProtection.mappings.lastTradingDate
      )),
      rollovers: data.rollovers.filter(rollover => (
        rollover.tradingDate >= benchmarkProtection.rollovers.firstTradingDate
        && rollover.tradingDate <= benchmarkProtection.rollovers.lastTradingDate
      )),
    };
    const tailRows = {
      bars1: data.bars1.filter(record => record.startMs >= protectedEndMs),
      bars5: data.bars5.filter(bar => bar.startMs >= protectedEndMs),
      bars60: data.bars60.filter(bar => bar.startMs >= protectedEndMs),
      mappings: data.mainContractMappings.filter(mapping => (
        mapping.tradingDate > benchmarkProtection.mappings.lastTradingDate
      )),
      rollovers: data.rollovers.filter(rollover => (
        rollover.tradingDate > benchmarkProtection.rollovers.lastTradingDate
      )),
    };
    const range = (rows, start, end = start) => ({
      rows: rows.length,
      first: rows.length ? start(rows[0]) : undefined,
      last: rows.length ? end(rows.at(-1)) : undefined,
    });
    return {
      sourceLatestAt: data.sourceLatestAt,
      snapshotUpdatedAt: data.snapshotUpdatedAt,
      snapshotSource: data.snapshotSource,
      counts: {
        bars1: data.bars1.length,
        bars5: data.bars5.length,
        bars60: data.bars60.length,
        mappings: data.mainContractMappings.length,
        rollovers: data.rollovers.length,
      },
      ranges: {
        bars1: range(data.bars1, row => row.start),
        bars5: range(data.bars5, row => row.start, row => row.end),
        bars60: range(data.bars60, row => row.start, row => row.end),
        mappings: range(
          data.mainContractMappings,
          row => row.tradingDate,
        ),
        rollovers: range(data.rollovers, row => row.tradingDate),
      },
      protected: {
        counts: Object.fromEntries(
          Object.entries(protectedRows).map(([name, rows]) => [
            name,
            rows.length,
          ]),
        ),
        hashes: {
          bars1: await hash(protectedRows.bars1.map(minuteProjection)),
          bars5: await hash(protectedRows.bars5.map(barProjection)),
          bars60: await hash(protectedRows.bars60.map(barProjection)),
          mappings: await hash(
            protectedRows.mappings.map(mappingProjection),
          ),
          rollovers: await hash(
            protectedRows.rollovers.map(rolloverProjection),
          ),
        },
      },
      tail: {
        bars1: range(tailRows.bars1, row => row.start),
        bars5: range(tailRows.bars5, row => row.start, row => row.end),
        bars60: range(tailRows.bars60, row => row.start, row => row.end),
        mappings: range(tailRows.mappings, row => row.tradingDate),
        rollovers: range(tailRows.rollovers, row => row.tradingDate),
      },
    };
  }, protection);
}

function countsChanged(state) {
  return Object.values(state.counts ?? {}).some(value => value > 0);
}

function assertTerminalSuccess(state, label) {
  assert.ok(
    ['succeeded', 'up-to-date'].includes(state.phase),
    `${label} failed: ${JSON.stringify(state)}`,
  );
  assert.ok(state.localMinuteLatestAt, `${label} has no local minute latest time.`);
  assert.ok(state.sourceLatestAt, `${label} has no source latest time.`);
  assert.ok(
    state.localMinuteLatestAt >= state.sourceLatestAt,
    `${label} entered the online gate before catching up: ${JSON.stringify(state)}`,
  );
}

function assertProtectedDataUnchanged(before, after, label) {
  assert.deepEqual(
    after.protected.counts,
    before.protected.counts,
    `${label} changed protected row counts.`,
  );
  assert.deepEqual(
    after.protected.hashes,
    before.protected.hashes,
    `${label} changed protected data hashes.`,
  );
}

function assertTailStartsAfterProtection(summary, protection) {
  const boundary = protection.bars5.lastEnd;
  for (const period of ['bars1', 'bars5', 'bars60']) {
    const first = summary.tail[period].first;
    if (first !== undefined) {
      assert.ok(
        first >= boundary,
        `${period} tail starts before protection boundary: ${JSON.stringify(summary.tail[period])}`,
      );
    }
  }
  if (summary.tail.mappings.first !== undefined) {
    assert.ok(
      summary.tail.mappings.first > protection.mappings.lastTradingDate,
    );
  }
  if (summary.tail.rollovers.first !== undefined) {
    assert.ok(
      summary.tail.rollovers.first > protection.rollovers.lastTradingDate,
    );
  }
}

try {
  const before = await snapshotState();
  assert.equal(before.metadata.schemaVersion, 7);
  assert.equal(before.metadata.storage.kind, 'full');
  assert.equal(before.metadata.benchmarkProtection.provider, 'THS');
  const originalFullHashes = await directoryFileHashes(before.directory);
  report.before = {
    pointer: before.pointer,
    metadataSha256: before.metadataSha256,
    metadata: before.metadata,
    originalFullHashes,
  };

  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: testUserData,
  };
  delete env.MONEYCOMING_TEST_EDB_MODE;
  delete env.MONEYCOMING_TEST_EDB_FIXTURE;
  delete env.ELECTRON_RUN_AS_NODE;

  app = await launchElectronTest({
    args: [root],
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.pageErrors.push(error.message));

  report.offscreen.push(
    await assertElectronWindowOffscreen(
      app,
      'glass-main-real-before-show',
    ),
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  report.offscreen.push(
    await assertElectronWindowOffscreen(
      app,
      'glass-main-real-after-show',
    ),
  );

  await page.locator('html[data-ready="true"]').waitFor({ timeout: 60_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => {
    const toggle = document.querySelector('#online-market-toggle');
    return toggle instanceof HTMLInputElement
      && !toggle.disabled
      && document.documentElement.dataset.onlineMarketPhase === 'disabled';
  }, undefined, { timeout: 30_000 });
  assert.equal(
    await page.getByTestId('online-market-toggle').isChecked(),
    false,
    'The isolated acceptance profile must start offline.',
  );

  await switchInstrument(page, 'glass_main');
  const visibleModes = await page.locator(
    '.segmented button[data-mode]',
  ).evaluateAll(buttons => buttons.map(button => button.dataset.mode));
  assert.deepEqual(visibleModes, ['dual', '5', '60']);
  assert.equal(
    await page.locator('[data-mode="1"], [data-testid="mode-1"]').count(),
    0,
  );
  assert.equal(await page.locator('#card-5').count(), 1);
  assert.equal(await page.locator('#card-60').count(), 1);
  const initialCharts = {
    5: await chartGeometry(page, 5),
    60: await chartGeometry(page, 60),
  };
  for (const [period, geometry] of Object.entries(initialCharts)) {
    assertChartRendered(period, geometry, 'is not rendered');
  }

  await page.getByTestId('date-input').fill('2023-08-09');
  await page.getByTestId('date-jump').click();
  await frame(page, 4);
  const selectedStart = await page.locator('html').getAttribute(
    'data-selected-start',
  );
  assert.ok(selectedStart, 'Date jump did not select a bar.');

  const beforeDataset = await datasetSummary(
    page,
    before.metadata.benchmarkProtection,
  );
  assert.equal(beforeDataset.snapshotSource, 'user');
  report.offlineGui = {
    instrument: await page.locator('html').getAttribute('data-instrument'),
    mode: await page.locator('html').getAttribute('data-mode'),
    visibleModes,
    selectedDate: await page.getByTestId('date-input').inputValue(),
    selectedStart,
    charts: initialCharts,
  };
  report.before.dataset = beforeDataset;

  await diagnostics('clear');
  await page.locator('.online-market-switch').click();
  await page.getByTestId('online-market-toggle').waitFor({
    state: 'attached',
  });
  await page.waitForFunction(() => (
    document.querySelector('#online-market-toggle')?.checked === true
  ), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => {
    const phase = document.documentElement.dataset.onlineMarketPhase;
    return ['waiting', 'source-delayed', 'degraded'].includes(phase ?? '');
  }, undefined, { timeout: 240_000 });
  const gatePhase = await page.locator('html').getAttribute(
    'data-online-market-phase',
  );
  assert.notEqual(
    gatePhase,
    'degraded',
    await page.locator('#online-market-status').innerText(),
  );

  const fullResult = await waitForMarketState(
    state => state.instrument === 'glass_main'
      && state.intent === 'full'
      && ['succeeded', 'up-to-date', 'failed'].includes(state.phase),
    30_000,
    'glass_main full gate',
  );
  assert.equal(
    fullResult.diagnostics.market.find(state => state.intent)?.intent,
    'full',
  );
  assertTerminalSuccess(fullResult.match, 'glass_main full gate');
  const fullWaiting = fullResult.diagnostics.online.find(state => (
    state.instrument === 'glass_main'
    && ['waiting', 'source-delayed'].includes(state.phase)
  ));
  assert.ok(fullWaiting, 'Online waiting state was not published.');
  assert.ok(
    fullWaiting.localMinuteLatestAt >= fullWaiting.sourceLatestAt,
    `Online waiting was published before the source was caught up: ${JSON.stringify(fullWaiting)}`,
  );

  await page.waitForFunction(() => (
    document.documentElement.dataset.ready === 'true'
    && document.documentElement.dataset.instrument === 'glass_main'
  ), undefined, { timeout: 60_000 });
  await frame(page, 4);
  const afterFullSnapshot = await snapshotState();
  const afterFullDataset = await datasetSummary(
    page,
    before.metadata.benchmarkProtection,
  );
  assertProtectedDataUnchanged(beforeDataset, afterFullDataset, 'Full gate');
  assertTailStartsAfterProtection(
    afterFullDataset,
    before.metadata.benchmarkProtection,
  );
  assert.deepEqual(
    afterFullSnapshot.metadata.benchmarkProtection,
    before.metadata.benchmarkProtection,
  );
  if (countsChanged(fullResult.match)) {
    assert.notEqual(
      afterFullSnapshot.pointer.snapshotId,
      before.pointer.snapshotId,
      'A changed full update did not activate a new snapshot.',
    );
  }
  report.fullGate = {
    phase: gatePhase,
    terminalState: fullResult.match,
    waitingState: fullWaiting,
    pointer: afterFullSnapshot.pointer,
    metadataSha256: afterFullSnapshot.metadataSha256,
    storage: afterFullSnapshot.metadata.storage,
    dataset: afterFullDataset,
    diagnostics: fullResult.diagnostics,
  };

  const tailResult = await waitForMarketState(
    state => state.instrument === 'glass_main'
      && state.intent === 'tail'
      && ['succeeded', 'up-to-date', 'failed'].includes(state.phase),
    100_000,
    'glass_main next-minute tail poll',
  );
  assertTerminalSuccess(tailResult.match, 'glass_main next-minute tail poll');
  await page.waitForFunction(() => (
    ['waiting', 'source-delayed'].includes(
      document.documentElement.dataset.onlineMarketPhase ?? '',
    )
  ), undefined, { timeout: 30_000 });
  await page.waitForFunction(() => (
    document.documentElement.dataset.ready === 'true'
    && document.documentElement.dataset.instrument === 'glass_main'
  ), undefined, { timeout: 60_000 });
  await frame(page, 4);

  const after = await snapshotState();
  const afterDataset = await datasetSummary(
    page,
    before.metadata.benchmarkProtection,
  );
  assertProtectedDataUnchanged(beforeDataset, afterDataset, 'Tail poll');
  assertTailStartsAfterProtection(
    afterDataset,
    before.metadata.benchmarkProtection,
  );
  assert.deepEqual(
    after.metadata.benchmarkProtection,
    before.metadata.benchmarkProtection,
  );
  assert.equal(after.metadata.schemaVersion, 7);
  if (countsChanged(tailResult.match)) {
    assert.notEqual(
      after.pointer.snapshotId,
      afterFullSnapshot.pointer.snapshotId,
      'A changed tail poll did not activate a new snapshot.',
    );
    assert.equal(after.metadata.storage.kind, 'tail');
    assert.equal(
      after.metadata.storage.base.snapshotId,
      afterFullSnapshot.pointer.snapshotId,
    );
  } else {
    assert.equal(
      after.pointer.snapshotId,
      afterFullSnapshot.pointer.snapshotId,
      'An up-to-date tail poll unexpectedly changed the current pointer.',
    );
  }

  const originalFullHashesAfter = await directoryFileHashes(before.directory);
  assert.deepEqual(
    originalFullHashesAfter,
    originalFullHashes,
    'The activated THS full snapshot was modified in place.',
  );
  const originalDirectoryState = await stat(before.directory);
  assert.ok(originalDirectoryState.isDirectory());

  const finalSelectedStart = await page.locator('html').getAttribute(
    'data-selected-start',
  );
  assert.equal(
    finalSelectedStart,
    selectedStart,
    'Online refresh did not preserve the selected historical bar.',
  );
  assert.equal(await page.locator('html').getAttribute('data-mode'), 'dual');
  const finalCharts = {
    5: await chartGeometry(page, 5),
    60: await chartGeometry(page, 60),
  };
  for (const [period, geometry] of Object.entries(finalCharts)) {
    assertChartRendered(period, geometry, 'stopped rendering');
  }

  report.tailPoll = {
    terminalState: tailResult.match,
    finalOnlineState: tailResult.diagnostics.online.at(-1),
    diagnostics: tailResult.diagnostics,
  };
  report.after = {
    pointer: after.pointer,
    metadataSha256: after.metadataSha256,
    metadata: after.metadata,
    dataset: afterDataset,
    originalFullHashesAfter,
    gui: {
      instrument: await page.locator('html').getAttribute('data-instrument'),
      mode: await page.locator('html').getAttribute('data-mode'),
      selectedDate: await page.getByTestId('date-input').inputValue(),
      selectedStart: finalSelectedStart,
      charts: finalCharts,
      onlinePhase: await page.locator('html').getAttribute(
        'data-online-market-phase',
      ),
    },
  };

  await page.screenshot({ path: screenshotPath });
  await page.locator('.online-market-switch').click();
  await page.waitForFunction(() => (
    document.documentElement.dataset.onlineMarketPhase === 'disabled'
  ), undefined, { timeout: 10_000 });
  report.offscreen.push(
    await assertElectronWindowOffscreen(
      app,
      'glass-main-real-before-close',
    ),
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
} finally {
  if (app) {
    await app.close().catch(error => {
      failure ??= error;
    });
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const resolvedSandbox = resolve(sandbox);
  const resolvedTemp = resolve(tmpdir());
  assert.ok(
    resolvedSandbox.startsWith(`${resolvedTemp}\\`),
    `Refusing to remove non-temporary acceptance directory: ${resolvedSandbox}`,
  );
  await rm(resolvedSandbox, { recursive: true, force: true });
}

if (failure) throw failure;
console.log(JSON.stringify({
  passed: report.passed,
  reportPath,
  screenshotPath,
  beforeSnapshotId: report.before.pointer.snapshotId,
  afterSnapshotId: report.after.pointer.snapshotId,
  fullGate: report.fullGate.terminalState.phase,
  tailPoll: report.tailPoll.terminalState.phase,
}, null, 2));
