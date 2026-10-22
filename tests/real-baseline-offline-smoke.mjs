import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const baselineDirectory = executable
  ? join(dirname(executable), 'data')
  : join(root, 'data');
const baselineReport = JSON.parse(
  await readFile(join(baselineDirectory, 'baseline-report.json'), 'utf8'),
);
const instruments = baselineReport.instruments;
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-real-baseline-'));
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });

assert.equal(instruments.length, 15, 'Real baseline report must contain 15 instruments.');
assert.deepEqual(
  instruments.map(instrument => instrument.status),
  Array(15).fill('succeeded'),
  'Every real baseline must have succeeded during generation.',
);

const env = {
  ...process.env,
  MONEYCOMING_TEST_MODE: '1',
  MONEYCOMING_TEST_USER_DATA: join(sandbox, 'user-data'),
  MONEYCOMING_TEST_EDB_MODE: 'offline',
};
if (!executable) env.MONEYCOMING_TEST_BUILTIN_DATA = baselineDirectory;
delete env.ELECTRON_RUN_AS_NODE;

let app;
let failure;
const pageErrors = [];
const report = {
  passed: false,
  packaged: Boolean(executable),
  baselineDirectory,
  instruments: [],
  memorySamples: [],
  peakWorkingSetBytes: 0,
  offscreen: {},
};

async function frame(page, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
  }
}

async function switchInstrument(page, instrumentId) {
  await page.locator('#instrument').evaluate((selector, next) => {
    selector.value = next;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  }, instrumentId);
  await page.waitForFunction(next => (
    document.documentElement.dataset.ready === 'true'
    && document.documentElement.dataset.instrument === next
    && document.querySelector('#instrument')?.getAttribute('data-loaded') === next
  ), instrumentId, { timeout: 120_000 });
  await frame(page);
}

async function sampleMemory(instrumentId) {
  const sample = await app.evaluate(({ app: electronApp }) => {
    const metrics = electronApp.getAppMetrics().map(metric => ({
      pid: metric.pid,
      type: metric.type,
      workingSetBytes: metric.memory.workingSetSize * 1024,
    }));
    return {
      workingSetBytes: metrics.reduce((total, metric) => total + metric.workingSetBytes, 0),
      processes: metrics,
    };
  });
  report.memorySamples.push({ instrumentId, ...sample });
  report.peakWorkingSetBytes = Math.max(
    report.peakWorkingSetBytes,
    sample.workingSetBytes,
  );
}

async function reviewProfitLoss(page, expected) {
  await page.getByTestId('profit-loss-review').click();
  const dialog = page.getByTestId('review-dialog');
  const finalCapital = page.getByTestId('review-final-capital');
  await finalCapital.waitFor({ state: 'visible', timeout: 120_000 });

  assert.equal(await dialog.evaluate(element => element.open), true);
  assert.ok((await finalCapital.innerText()).trim().length > 0);

  const completedTrades = await page.getByTestId('review-trade').count();
  const noCompletedTrades = await page.getByTestId('review-no-completed').count();
  assert.ok(
    completedTrades > 0 || noCompletedTrades === 1,
    `${expected.name} must render completed trades or an explicit no-trades result.`,
  );

  const note = await page.locator('.review-note').innerText();
  assert.ok(
    note.includes(`当前品种：${expected.name}`),
    `${expected.name} profit/loss review must identify the active instrument.`,
  );

  const summary = {
    finalCapital: (await finalCapital.locator('strong').innerText()).trim(),
    totalPnlAndReturn: (await finalCapital.locator('em').innerText()).trim(),
    completedTrades,
    hasExplicitNoCompletedTrades: noCompletedTrades === 1,
    incompleteTrades: await page.getByTestId('review-incomplete-trade').count(),
  };

  await page.getByTestId('review-done').click();
  assert.equal(await dialog.evaluate(element => element.open), false);
  return summary;
}

try {
  app = await launchElectronTest({
    ...(executable
      ? { executablePath: executable, args: [], cwd: sandbox }
      : { args: [root] }),
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120_000);
  page.on('pageerror', error => pageErrors.push(error.message));

  report.offscreen.beforeShow = await assertElectronWindowOffscreen(
    app,
    'real-baseline-before-show',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  report.offscreen.afterShow = await assertElectronWindowOffscreen(
    app,
    'real-baseline-after-show',
  );

  await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor({
    timeout: 120_000,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  const selectorOptions = await page.getByTestId('instrument').locator('option').evaluateAll(
    options => options.map(option => ({ value: option.value, name: option.textContent })),
  );
  assert.deepEqual(
    selectorOptions,
    instruments.map(instrument => ({
      value: instrument.instrumentId,
      name: instrument.name,
    })),
  );
  assert.equal(selectorOptions.some(option => option.name === '豆粕2701'), false);
  assert.deepEqual(
    await page.locator('.segmented button[data-mode]').evaluateAll(
      buttons => buttons.map(button => button.dataset.mode),
    ),
    ['dual', '5', '60'],
  );
  assert.equal(await page.locator('[data-mode="1"], [data-testid="mode-1"]').count(), 0);

  for (const expected of instruments) {
    if (expected.instrumentId !== 'main_continuous') {
      await switchInstrument(page, expected.instrumentId);
    }
    const counts = await page.locator('#counts').innerText();
    const coverage = await page.locator('#coverage').innerText();
    const expectedCounts = `5 分钟 ${expected.fiveMinuteRows.toLocaleString('zh-CN')} 根    /    60 分钟 ${expected.sixtyMinuteRows.toLocaleString('zh-CN')} 根`;

    assert.equal(await page.locator('html').getAttribute('data-instrument'), expected.instrumentId);
    assert.equal(await page.getByTestId('instrument').getAttribute('data-loaded'), expected.instrumentId);
    assert.equal(await page.getByTestId('instrument').inputValue(), expected.instrumentId);
    assert.equal(await page.locator('#instrument-name').innerText(), expected.name);
    assert.equal(await page.locator('#instrument-symbol').innerText(), expected.mainSymbol);
    assert.equal(counts, expectedCounts);
    assert.match(coverage, new RegExp(expected.periods.bars5.first.slice(0, 10)));
    assert.match(coverage, new RegExp(expected.periods.bars5.last.slice(0, 10)));
    assert.match(coverage, new RegExp(expected.sourceLatestAt.slice(0, 16)));
    assert.equal(await page.locator('#error').isHidden(), true);

    const profitLoss = await reviewProfitLoss(page, expected);
    await sampleMemory(expected.instrumentId);
    report.instruments.push({
      instrumentId: expected.instrumentId,
      name: expected.name,
      firstFiveMinute: expected.periods.bars5.first,
      lastFiveMinute: expected.periods.bars5.last,
      sourceLatestAt: expected.sourceLatestAt,
      minuteRows: expected.minuteRows,
      fiveMinuteRows: expected.fiveMinuteRows,
      sixtyMinuteRows: expected.sixtyMinuteRows,
      profitLoss,
    });
  }

  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: join(output, 'real-baseline-offline-smoke.png') });
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  if (app) {
    try {
      report.offscreen.beforeClose = await assertElectronWindowOffscreen(
        app,
        'real-baseline-before-close',
      );
    } catch (error) {
      failure ??= error;
    }
    await app.close().catch(error => {
      failure ??= error;
    });
  }
  await writeFile(
    join(output, 'real-baseline-offline-smoke.json'),
    `${JSON.stringify({ ...report, errors: pageErrors }, null, 2)}\n`,
    'utf8',
  );
  await rm(sandbox, { recursive: true, force: true });
}

if (failure) throw failure;
console.log(JSON.stringify({
  passed: true,
  packaged: report.packaged,
  instrumentCount: report.instruments.length,
  peakWorkingSetBytes: report.peakWorkingSetBytes,
  lastSourceLatestAt: report.instruments.at(-1)?.sourceLatestAt,
}));
