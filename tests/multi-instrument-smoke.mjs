import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';
import {
  createMultiInstrumentFixture,
  MULTI_INSTRUMENT_DEFINITIONS,
} from './multi-instrument-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-multi-instrument-'));
const fixture = await createMultiInstrumentFixture(join(sandbox, 'builtin-data'));
const userData = join(sandbox, 'user-data');
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });

const env = {
  ...process.env,
  MONEYCOMING_TEST_MODE: '1',
  MONEYCOMING_TEST_BUILTIN_DATA: fixture.builtinDataDirectory,
  MONEYCOMING_TEST_USER_DATA: userData,
  MONEYCOMING_TEST_EDB_MODE: 'fixture',
  MONEYCOMING_TEST_EDB_FIXTURE: fixture.remoteFixturePath,
  MONEYCOMING_TEST_EDB_PRICE_OFFSETS: JSON.stringify(fixture.priceOffsets),
  MONEYCOMING_TEST_LOAD_DELAYS: JSON.stringify({
    rapeseed_meal_main: 350,
    rebar_main: 20,
  }),
  MONEYCOMING_TEST_LOAD_FAILURES: JSON.stringify({
    pvc_main: '测试注入的 PVC 加载失败',
  }),
  MONEYCOMING_TEST_EDB_FAILURES: JSON.stringify({
    soda_ash_main: '测试注入的纯碱 EDB 失败',
  }),
};
delete env.ELECTRON_RUN_AS_NODE;

let app;
let failure;
const pageErrors = [];
const report = {
  passed: false,
  packaged: Boolean(executable),
  scenarios: [],
  currentUpdate: {},
  updateAll: {},
  offscreen: {},
};

function numberText(value) {
  return Number(value.replaceAll(',', ''));
}

async function frame(page, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
  }
}

async function requestInstrument(page, instrument) {
  await page.locator('#instrument').evaluate((selector, next) => {
    selector.value = next;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  }, instrument);
}

async function waitForInstrument(page, instrument) {
  await page.waitForFunction(next => (
    document.documentElement.dataset.instrument === next
    && document.querySelector('#instrument')?.getAttribute('data-loaded') === next
    && document.documentElement.dataset.ready === 'true'
  ), instrument);
  await frame(page);
}

async function switchInstrument(page, instrument) {
  await requestInstrument(page, instrument);
  await waitForInstrument(page, instrument);
}

async function jump(page, date) {
  await page.getByTestId('date-input').fill(date);
  await page.getByTestId('date-jump').click();
  await frame(page);
}

async function rolloverDiagnostics(page, period) {
  return {
    count: Number(await page.locator(`#card-${period}`).getAttribute('data-rollover-count')),
    labels: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-labels')),
    starts: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-starts')),
  };
}

async function assertRollover(page, label) {
  for (const period of [5, 60]) {
    assert.deepEqual(await rolloverDiagnostics(page, period), {
      count: 1,
      labels: [label],
      starts: ['2026-10-09 09:00'],
    });
  }
}

try {
  app = await launchElectronTest({
    ...(executable
      ? { executablePath: executable, args: [], cwd: sandbox }
      : { args: [root] }),
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  report.offscreen.beforeShow = await assertElectronWindowOffscreen(
    app,
    'multi-instrument-before-show',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  report.offscreen.afterShow = await assertElectronWindowOffscreen(
    app,
    'multi-instrument-after-show',
  );
  await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });

  const optionValues = await page.getByTestId('instrument').locator('option').evaluateAll(
    options => options.map(option => option.value),
  );
  const optionNames = await page.getByTestId('instrument').locator('option').allTextContents();
  assert.deepEqual(optionValues, MULTI_INSTRUMENT_DEFINITIONS.map(item => item.id));
  assert.deepEqual(optionNames, MULTI_INSTRUMENT_DEFINITIONS.map(item => item.name));
  assert.equal(optionNames.includes('豆粕2701'), false);
  assert.deepEqual(
    await page.locator('.segmented button[data-mode]').evaluateAll(
      buttons => buttons.map(button => button.dataset.mode),
    ),
    ['dual', '5', '60'],
  );
  assert.equal(await page.locator('[data-mode="1"], [data-testid="mode-1"]').count(), 0);
  report.scenarios.push('15-item-selector-and-visible-periods');

  await page.evaluate(() => window.moneyComingTest?.resetRendererPerformanceDiagnostics());
  await switchInstrument(page, 'soybean_1_main');
  const rendererDiagnostics = await page.evaluate(
    () => window.moneyComingTest?.rendererPerformanceDiagnostics(),
  );
  assert.ok(rendererDiagnostics);
  const switchRequest = rendererDiagnostics.events.find(
    event => event.type === 'switch-requested' && event.instrument === 'soybean_1_main',
  );
  assert.ok(switchRequest);
  assert.deepEqual(
    rendererDiagnostics.events
      .filter(event => event.requestId === switchRequest.requestId)
      .map(event => event.type),
    [
      'switch-requested',
      'loading-visible',
      'dataset-ready',
      'chart-commit',
      'strategy-summary-ready',
    ],
  );
  assert.ok(rendererDiagnostics.fullSetDataCalls.some(
    call => call.requestId === switchRequest.requestId && call.period === 5,
  ));
  assert.ok(rendererDiagnostics.fullSetDataCalls.some(
    call => call.requestId === switchRequest.requestId && call.period === 60,
  ));
  assert.deepEqual(
    rendererDiagnostics.strategyDerivations
      .filter(call => call.requestId === switchRequest.requestId)
      .map(call => call.source),
    ['chart', 'profit-loss'],
  );
  report.rendererDiagnostics = rendererDiagnostics;
  report.scenarios.push('renderer-switch-diagnostic-order');

  const initialSummary = {
    name: await page.locator('#instrument-name').innerText(),
    symbol: await page.locator('#instrument-symbol').innerText(),
    exchange: await page.locator('#exchange-name').innerText(),
    coverage: await page.locator('#coverage').innerText(),
    counts: await page.locator('#counts').innerText(),
    close: numberText(await page.locator('#last-close').innerText()),
  };
  await requestInstrument(page, 'rapeseed_meal_main');
  await requestInstrument(page, 'rebar_main');
  await waitForInstrument(page, 'rebar_main');
  await page.waitForTimeout(450);
  const rebar = fixture.expected.rebar_main;
  assert.equal(await page.locator('html').getAttribute('data-instrument'), 'rebar_main');
  assert.equal(await page.locator('#instrument-name').innerText(), rebar.name);
  assert.equal(await page.locator('#instrument-symbol').innerText(), rebar.mainSymbol);
  assert.equal(await page.locator('#exchange-name').innerText(), rebar.exchangeName);
  assert.match(await page.locator('#coverage').innerText(), /2026-10-08.*2026-10-09/);
  assert.match(await page.locator('#counts').innerText(), /24.*2/);
  assert.equal(numberText(await page.locator('#last-close').innerText()), rebar.initialLastClose);
  assert.notDeepEqual({
    name: await page.locator('#instrument-name').innerText(),
    symbol: await page.locator('#instrument-symbol').innerText(),
    exchange: await page.locator('#exchange-name').innerText(),
    coverage: await page.locator('#coverage').innerText(),
    counts: await page.locator('#counts').innerText(),
    close: numberText(await page.locator('#last-close').innerText()),
  }, initialSummary);
  report.scenarios.push('rapid-switch-commits-final-request');

  await switchInstrument(page, 'main_continuous');
  await jump(page, '2026-10-08');
  assert.ok(await page.locator('html').getAttribute('data-selected-start'));
  assert.equal(await page.locator('#card-5').getAttribute('data-selected-count'), '12');
  assert.equal(await page.locator('#card-60').getAttribute('data-selected-count'), '1');
  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await requestInstrument(page, 'rebar_main');
  await waitForInstrument(page, 'rebar_main');
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  assert.equal(await page.locator('#review-content').innerText(), '');
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), null);
  assert.equal(await page.locator('html').getAttribute('data-entry-direction'), null);
  assert.equal(await page.getByTestId('date-input').inputValue(), '2026-10-09');
  assert.equal(await page.locator('#card-5').getAttribute('data-selected-count'), '0');
  assert.equal(await page.locator('#card-60').getAttribute('data-selected-count'), '0');
  assert.equal(await page.locator('#card-5').getAttribute('data-linked-marker-count'), '0');
  assert.equal(await page.locator('#card-60').getAttribute('data-linked-marker-count'), '0');
  report.scenarios.push('instrument-switch-clears-transient-state');

  await switchInstrument(page, 'main_continuous');
  await assertRollover(page, '主力换月：m2609 -> m2701');
  await switchInstrument(page, 'rapeseed_meal_main');
  await assertRollover(page, '主力换月：RM609 -> RM701');
  await switchInstrument(page, 'soybean_2_main');
  for (const period of [5, 60]) {
    assert.deepEqual(await rolloverDiagnostics(page, period), {
      count: 0,
      labels: [],
      starts: [],
    });
  }
  report.scenarios.push('rollover-markers-and-switch-cleanup');

  await switchInstrument(page, 'main_continuous');
  await page.getByTestId('market-update').click();
  await page.locator('html[data-market-update-phase="succeeded"]').waitFor({ timeout: 30_000 });
  await page.locator('#counts', { hasText: '36' }).waitFor();
  assert.match(await page.locator('#counts').innerText(), /36.*3/);
  assert.match(await page.locator('#market-update-status').innerText(), /1 分钟 \+60.*5 分钟 \+12.*60 分钟 \+1/);
  assert.match(await page.locator('#coverage').innerText(), /2026-10-12/);
  assert.match(await page.locator('#last-time').innerText(), /2026-10-12 10:00/);
  assert.equal(
    numberText(await page.locator('#last-close').innerText()),
    fixture.expected.main_continuous.updatedLastClose,
  );
  report.currentUpdate.first = {
    phase: await page.locator('html').getAttribute('data-market-update-phase'),
    status: await page.locator('#market-update-status').innerText(),
    coverage: await page.locator('#coverage').innerText(),
    counts: await page.locator('#counts').innerText(),
  };
  await page.getByTestId('market-update').click();
  await page.locator('html[data-market-update-phase="up-to-date"]').waitFor({ timeout: 30_000 });
  assert.match(await page.locator('#market-update-status').innerText(), /已是数据源当前最新/);
  assert.match(await page.locator('#counts').innerText(), /36.*3/);
  report.currentUpdate.second = {
    phase: await page.locator('html').getAttribute('data-market-update-phase'),
    status: await page.locator('#market-update-status').innerText(),
    counts: await page.locator('#counts').innerText(),
  };
  report.scenarios.push('current-update-success-and-up-to-date');

  await page.getByTestId('market-update-all-entry').click();
  assert.equal(
    await page.locator('#market-update-all-dialog').evaluate(element => element.open),
    true,
  );
  await page.getByTestId('market-update-all').click();
  assert.equal(await page.getByTestId('market-update-all').isDisabled(), true);
  assert.equal(await page.getByTestId('market-update').isDisabled(), true);
  await page.waitForFunction(() => {
    const status = document.querySelector('#market-update-all-status')?.textContent ?? '';
    const button = document.querySelector('#market-update-all');
    return status.includes('全部品种更新完成') && button && !button.disabled;
  }, undefined, { timeout: 90_000 });
  const allItems = page.locator('#market-update-all-list li');
  assert.equal(await allItems.count(), MULTI_INSTRUMENT_DEFINITIONS.length);
  assert.equal(
    await page.locator('#market-update-all-list [data-instrument="soda_ash_main"]').getAttribute('data-tone'),
    'danger',
  );
  assert.equal(
    await page.locator('#market-update-all-list [data-instrument="soybean_2_main"]').getAttribute('data-tone'),
    'success',
  );
  assert.match(await page.locator('#market-update-all-status').innerText(), /失败 1/);
  assert.equal(await page.getByTestId('market-update-all').isDisabled(), false);
  assert.equal(await page.getByTestId('market-update').isDisabled(), false);
  report.updateAll = {
    status: await page.locator('#market-update-all-status').innerText(),
    items: await allItems.evaluateAll(items => items.map(item => ({
      instrumentId: item.getAttribute('data-instrument'),
      tone: item.getAttribute('data-tone'),
      text: item.textContent,
    }))),
    failedInstrumentId: 'soda_ash_main',
    laterSuccessfulInstrumentId: 'soybean_2_main',
  };
  report.scenarios.push('serial-update-all-continues-after-failure');
  await page.locator('#close-market-update-all').click();

  await page.getByTestId('profit-loss-review').click();
  assert.match(await page.locator('.review-note').innerText(), /当前品种：豆粕主连/);
  assert.match(await page.locator('.review-note').innerText(), /合约乘数 10/);
  assert.match(await page.locator('.review-note').innerText(), /100 万元/);
  assert.match(await page.locator('.review-note').innerText(), /10 倍理论名义杠杆/);
  assert.match(await page.locator('.review-note').innerText(), /整数手数/);
  assert.match(await page.locator('.review-note').innerText(), /不计算手续费和滑点/);
  await page.getByTestId('review-done').click();
  await switchInstrument(page, 'glass_main');
  await page.getByTestId('profit-loss-review').click();
  assert.match(await page.locator('.review-note').innerText(), /当前品种：玻璃主连/);
  assert.match(await page.locator('.review-note').innerText(), /合约乘数 20/);
  await page.getByTestId('review-done').click();
  report.scenarios.push('review-follows-instrument-parameters');

  const preserved = {
    instrument: await page.locator('html').getAttribute('data-instrument'),
    name: await page.locator('#instrument-name').innerText(),
    symbol: await page.locator('#instrument-symbol').innerText(),
    counts: await page.locator('#counts').innerText(),
    close: await page.locator('#last-close').innerText(),
  };
  await requestInstrument(page, 'pvc_main');
  await page.locator('#error:not([hidden])').waitFor();
  assert.equal(await page.getByTestId('instrument').inputValue(), preserved.instrument);
  assert.equal(await page.locator('html').getAttribute('data-instrument'), preserved.instrument);
  assert.equal(await page.locator('#instrument-name').innerText(), preserved.name);
  assert.equal(await page.locator('#instrument-symbol').innerText(), preserved.symbol);
  assert.equal(await page.locator('#counts').innerText(), preserved.counts);
  assert.equal(await page.locator('#last-close').innerText(), preserved.close);
  assert.match(await page.locator('#error-text').innerText(), /PVC主连加载失败/);
  assert.match(await page.locator('#error-text').innerText(), /当前仍显示玻璃主连/);
  assert.equal(await page.getByTestId('retry').isVisible(), true);
  report.scenarios.push('load-failure-preserves-current-dataset');

  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: join(output, 'multi-instrument-smoke.png') });
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  if (app) {
    try {
      report.offscreen.beforeClose = await assertElectronWindowOffscreen(
        app,
        'multi-instrument-before-close',
      );
    } catch (error) {
      failure ??= error;
    }
    await app.close().catch(error => {
      failure ??= error;
    });
  }
  await writeFile(
    join(output, 'multi-instrument-smoke.json'),
    `${JSON.stringify({ ...report, errors: pageErrors }, null, 2)}\n`,
    'utf8',
  );
  await rm(sandbox, { recursive: true, force: true });
}

if (failure) throw failure;
console.log(JSON.stringify(report));
