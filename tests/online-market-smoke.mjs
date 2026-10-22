import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
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
const output = join(root, 'artifacts');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-online-market-'));
const fixture = await createMultiInstrumentFixture(join(sandbox, 'builtin-data'));
const primaryUserData = join(sandbox, 'primary-user-data');
const staleUserData = join(sandbox, 'stale-user-data');
const concurrentUserData = join(sandbox, 'concurrent-user-data');
await mkdir(output, { recursive: true });

const report = {
  passed: false,
  packaged: Boolean(executable),
  scenarios: [],
  offscreen: [],
  firstRun: {},
  restartFailure: {},
  sourceDelay: {},
  disable: {},
  staleSwitch: {},
  updateAllConcurrency: {},
};
const activeApps = new Set();
const pageErrors = [];

function testEnvironment({
  userData,
  mode = 'fixture',
  now,
  clockRate,
  delays = {},
  failures = {},
}) {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_BUILTIN_DATA: fixture.builtinDataDirectory,
    MONEYCOMING_TEST_USER_DATA: userData,
    MONEYCOMING_TEST_EDB_MODE: mode,
    MONEYCOMING_TEST_EDB_FIXTURE: fixture.remoteFixturePath,
    MONEYCOMING_TEST_EDB_PRICE_OFFSETS: JSON.stringify(fixture.priceOffsets),
    MONEYCOMING_TEST_EDB_DELAYS: JSON.stringify(delays),
    MONEYCOMING_TEST_EDB_FAILURES: JSON.stringify(failures),
    MONEYCOMING_TEST_NOW: now,
  };
  if (clockRate) {
    env.MONEYCOMING_TEST_ONLINE_CLOCK_RATE = String(clockRate);
  } else {
    delete env.MONEYCOMING_TEST_ONLINE_CLOCK_RATE;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function launchScenario(label, options) {
  const launchOptions = {
    ...(executable
      ? { executablePath: executable, args: [], cwd: sandbox }
      : { args: [root] }),
    env: testEnvironment(options),
    timeout: 30_000,
  };
  const app = await launchElectronTest(launchOptions);
  activeApps.add(app);
  const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(`${label}: ${error.message}`));
  const beforeShow = await assertElectronWindowOffscreen(
    app,
    `${label}-before-show`,
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const afterShow = await assertElectronWindowOffscreen(
    app,
    `${label}-after-show`,
  );
  report.offscreen.push({ label, beforeShow, afterShow });
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  return { app, page };
}

async function closeScenario(label, app) {
  report.offscreen.push({
    label: `${label}-close`,
    beforeClose: await assertElectronWindowOffscreen(app, `${label}-before-close`),
  });
  activeApps.delete(app);
  await app.close();
}

async function frame(page, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => (
      requestAnimationFrame(resolveFrame)
    )));
  }
}

async function testDiagnostics(app, action) {
  return app.evaluate((_electron, operation) => {
    const diagnostics = globalThis.__moneyComingTest;
    if (!diagnostics) throw new Error('MoneyComing test diagnostics are unavailable.');
    if (operation === 'clear') {
      diagnostics.clearDiagnostics();
      return null;
    }
    if (operation === 'edb') return diagnostics.getEdbRequests();
    if (operation === 'market') return diagnostics.getMarketStates();
    if (operation === 'online') return diagnostics.getOnlineStates();
    throw new Error(`Unknown diagnostics operation: ${operation}`);
  }, action);
}

function parseCounts(text) {
  const match = /5 分钟\s+([\d,]+)\s+根\s+\/\s+60 分钟\s+([\d,]+)\s+根/.exec(text);
  assert.ok(match, `无法解析周期数量：${text}`);
  return {
    bars5: Number(match[1].replaceAll(',', '')),
    bars60: Number(match[2].replaceAll(',', '')),
  };
}

async function counts(page) {
  return parseCounts(await page.locator('#counts').innerText());
}

async function waitForCounts(page, expected, timeout = 30_000) {
  await page.waitForFunction(
    target => {
      const text = document.querySelector('#counts')?.textContent ?? '';
      const match = /5 分钟\s+([\d,]+)\s+根\s+\/\s+60 分钟\s+([\d,]+)\s+根/.exec(text);
      if (!match) return false;
      return Number(match[1].replaceAll(',', '')) === target.bars5
        && Number(match[2].replaceAll(',', '')) === target.bars60;
    },
    expected,
    { timeout },
  );
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
  ), instrument, { timeout: 30_000 });
  await frame(page);
}

async function switchInstrument(page, instrument) {
  await requestInstrument(page, instrument);
  await waitForInstrument(page, instrument);
}

async function waitForOnlinePhase(page, phases, timeout = 30_000) {
  await page.waitForFunction(
    expected => expected.includes(
      document.documentElement.dataset.onlineMarketPhase ?? '',
    ),
    phases,
    { timeout },
  );
}

async function enableOnlineMarket(page) {
  const toggle = page.getByTestId('online-market-toggle');
  if (await toggle.isChecked()) return;
  await page.locator('.online-market-switch').click();
  await toggle.waitFor({ state: 'attached' });
}

async function jump(page, date) {
  await page.getByTestId('date-input').fill(date);
  await page.getByTestId('date-jump').click();
  await frame(page);
}

async function dragPriceAxis(page, period) {
  const box = await page.locator(`#canvas-${period}`).boundingBox();
  assert.ok(box);
  const x = box.x + box.width - 18;
  const y = box.y + Math.max(55, box.height * 0.28);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 44, { steps: 12 });
  await page.mouse.up();
  await frame(page);
  assert.equal(
    await page.locator(`#card-${period}`).getAttribute('data-price-auto-scale'),
    'false',
  );
}

async function zoomChart(page, period) {
  const box = await page.locator(`#canvas-${period}`).boundingBox();
  assert.ok(box);
  await page.mouse.move(
    box.x + box.width * 0.55,
    box.y + Math.max(55, box.height * 0.3),
  );
  await page.mouse.wheel(0, -260);
  await frame(page);
}

async function chartState(page, period) {
  const card = page.locator(`#card-${period}`);
  const attributes = await Promise.all([
    'data-visible-from',
    'data-visible-to',
    'data-price-auto-scale',
    'data-price-range-from',
    'data-price-range-to',
  ].map(name => card.getAttribute(name)));
  return {
    visibleFrom: Number(attributes[0]),
    visibleTo: Number(attributes[1]),
    priceAutoScale: attributes[2],
    priceFrom: Number(attributes[3]),
    priceTo: Number(attributes[4]),
  };
}

function assertNear(actual, expected, label, tolerance = 0.05) {
  assert.ok(
    Number.isFinite(actual)
      && Number.isFinite(expected)
      && Math.abs(actual - expected) <= tolerance,
    `${label} changed: ${JSON.stringify({ actual, expected, tolerance })}`,
  );
}

function assertChartStatePreserved(actual, expected, period) {
  assert.equal(actual.priceAutoScale, 'false');
  assert.equal(actual.priceAutoScale, expected.priceAutoScale);
  assertNear(actual.visibleFrom, expected.visibleFrom, `${period}m visibleFrom`);
  assertNear(actual.visibleTo, expected.visibleTo, `${period}m visibleTo`);
  assertNear(actual.priceFrom, expected.priceFrom, `${period}m priceFrom`, 0.001);
  assertNear(actual.priceTo, expected.priceTo, `${period}m priceTo`, 0.001);
}

function reviewMinuteCount(text) {
  const match = /和\s+([\d,]+)\s+根后台 1 分钟 K 线/.exec(text);
  assert.ok(match, `无法解析复盘后台 1 分钟数量：${text}`);
  return Number(match[1].replaceAll(',', ''));
}

function minuteMainRequests(requests) {
  const mainSymbols = new Set(
    MULTI_INSTRUMENT_DEFINITIONS.map(definition => definition.mainSymbol),
  );
  return requests.filter(request => (
    request.period === '60' && mainSymbols.has(request.symbol)
  ));
}

const networkHits = { http: 0, webSocket: 0 };
const networkServer = createServer((_request, response) => {
  networkHits.http += 1;
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('renderer network should be blocked');
});
networkServer.on('upgrade', (_request, socket) => {
  networkHits.webSocket += 1;
  socket.destroy();
});
await new Promise((resolvePromise, reject) => {
  networkServer.once('error', reject);
  networkServer.listen(0, '127.0.0.1', resolvePromise);
});
const networkPort = networkServer.address().port;

let failure;
try {
  {
    const { app, page } = await launchScenario('online-first-run', {
      userData: primaryUserData,
      now: '2026-10-12T09:55:04+08:00',
      clockRate: 20,
    });
    try {
      assert.deepEqual(await counts(page), { bars5: 24, bars60: 2 });
      assert.deepEqual(
        await page.locator('.segmented button[data-mode]').evaluateAll(
          buttons => buttons.map(button => button.dataset.mode),
        ),
        ['dual', '5', '60'],
      );
      assert.equal(
        await page.locator('[data-mode="1"], [data-testid="mode-1"]').count(),
        0,
      );
      await testDiagnostics(app, 'clear');
      await enableOnlineMarket(page);
      await waitForOnlinePhase(page, ['waiting']);
      await waitForCounts(page, { bars5: 35, bars60: 2 });

      const gateMarketStates = await testDiagnostics(app, 'market');
      const gateOnlineStates = await testDiagnostics(app, 'online');
      const gateMinuteRequests = minuteMainRequests(
        await testDiagnostics(app, 'edb'),
      ).filter(request => request.instrument === 'main_continuous');
      assert.equal(gateMarketStates.find(state => state.intent)?.intent, 'full');
      assert.equal(gateMinuteRequests[0]?.endAt, '2026-10-12 09:55:00');
      assert.ok(gateOnlineStates.some(state => state.phase === 'catching-up'));
      const waitingIndex = gateOnlineStates.findIndex(
        state => state.phase === 'waiting',
      );
      const pollingIndex = gateOnlineStates.findIndex(
        state => state.phase === 'polling',
      );
      assert.ok(waitingIndex >= 0);
      assert.ok(pollingIndex === -1 || pollingIndex > waitingIndex);

      const rendererNetwork = await page.evaluate(async port => {
        const http = await fetch(`http://127.0.0.1:${port}/blocked`)
          .then(() => 'opened', () => 'blocked');
        const webSocket = await new Promise(resolveSocket => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/blocked`);
          const timeout = setTimeout(() => resolveSocket('timeout'), 1500);
          socket.onopen = () => {
            clearTimeout(timeout);
            socket.close();
            resolveSocket('opened');
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            resolveSocket('blocked');
          };
        });
        return { http, webSocket };
      }, networkPort);
      assert.deepEqual(rendererNetwork, { http: 'blocked', webSocket: 'blocked' });
      assert.deepEqual(networkHits, { http: 0, webSocket: 0 });

      await jump(page, '2026-10-09');
      await zoomChart(page, 5);
      await zoomChart(page, 60);
      await dragPriceAxis(page, 5);
      await dragPriceAxis(page, 60);
      await page.getByTestId('profit-loss-review').click();
      assert.equal(
        await page.locator('#review-dialog').evaluate(element => element.open),
        true,
      );
      const beforeBackgroundOnly = {
        counts: await counts(page),
        strategyRefreshCount: Number(
          await page.locator('html').getAttribute('data-strategy-refresh-count'),
        ),
        selectedStart: await page.locator('html').getAttribute('data-selected-start'),
        mode: await page.locator('html').getAttribute('data-mode'),
        reviewMinutes: reviewMinuteCount(
          await page.locator('.review-summary-heading').innerText(),
        ),
        charts: {
          5: await chartState(page, 5),
          60: await chartState(page, 60),
        },
      };
      assert.ok(beforeBackgroundOnly.selectedStart);
      await page.waitForFunction(
        previous => Number(
          document.documentElement.dataset.strategyRefreshCount,
        ) > previous,
        beforeBackgroundOnly.strategyRefreshCount,
        { timeout: 20_000 },
      );
      await frame(page, 4);
      const afterBackgroundOnly = {
        counts: await counts(page),
        strategyRefreshCount: Number(
          await page.locator('html').getAttribute('data-strategy-refresh-count'),
        ),
        selectedStart: await page.locator('html').getAttribute('data-selected-start'),
        mode: await page.locator('html').getAttribute('data-mode'),
        reviewMinutes: reviewMinuteCount(
          await page.locator('.review-summary-heading').innerText(),
        ),
        charts: {
          5: await chartState(page, 5),
          60: await chartState(page, 60),
        },
      };
      assert.deepEqual(afterBackgroundOnly.counts, beforeBackgroundOnly.counts);
      assert.ok(
        afterBackgroundOnly.reviewMinutes > beforeBackgroundOnly.reviewMinutes,
      );
      assert.ok(
        afterBackgroundOnly.strategyRefreshCount
          > beforeBackgroundOnly.strategyRefreshCount,
      );
      assert.equal(
        afterBackgroundOnly.selectedStart,
        beforeBackgroundOnly.selectedStart,
      );
      assert.equal(afterBackgroundOnly.mode, beforeBackgroundOnly.mode);
      assert.equal(
        await page.locator('#review-dialog').evaluate(element => element.open),
        true,
      );
      assertChartStatePreserved(
        afterBackgroundOnly.charts[5],
        beforeBackgroundOnly.charts[5],
        5,
      );
      assertChartStatePreserved(
        afterBackgroundOnly.charts[60],
        beforeBackgroundOnly.charts[60],
        60,
      );

      await waitForCounts(page, { bars5: 36, bars60: 3 }, 30_000);
      await waitForOnlinePhase(page, ['waiting', 'source-delayed']);
      const automaticMarketStates = await testDiagnostics(app, 'market');
      assert.ok(automaticMarketStates.some(state => state.intent === 'tail'));
      assert.ok(automaticMarketStates.some(state => (
        state.intent === 'tail'
        && state.counts?.added5 === 1
        && state.counts?.added60 === 1
      )));
      report.firstRun = {
        gateRequest: gateMinuteRequests[0],
        backgroundOnly: {
          before: beforeBackgroundOnly,
          after: afterBackgroundOnly,
        },
        finalCounts: await counts(page),
        finalOnlinePhase: await page.locator('html').getAttribute(
          'data-online-market-phase',
        ),
      };
      report.scenarios.push(
        'full-gate-before-tail',
        'minute-close-background-refresh',
        'complete-5m-and-60m-publication',
        'viewport-price-selection-and-review-preserved',
        'renderer-network-blocked',
      );
      await page.screenshot({
        path: join(output, 'online-market-success.png'),
      });
    } finally {
      await closeScenario('online-first-run', app);
    }
  }

  {
    const { app, page } = await launchScenario('online-restart-offline', {
      userData: primaryUserData,
      mode: 'offline',
      now: '2026-10-12T10:01:04+08:00',
    });
    try {
      await waitForOnlinePhase(page, ['degraded']);
      assert.equal(await page.getByTestId('online-market-toggle').isChecked(), true);
      assert.deepEqual(await counts(page), { bars5: 36, bars60: 3 });
      assert.match(
        await page.locator('#online-market-status').innerText(),
        /更新失败|补齐失败/,
      );
      assert.match(
        await page.locator('#workspace-connectivity-label').innerText(),
        /离线快照可用/,
      );
      const marketStates = await testDiagnostics(app, 'market');
      assert.equal(marketStates.find(state => state.intent)?.intent, 'full');
      report.restartFailure = {
        counts: await counts(page),
        phase: await page.locator('html').getAttribute(
          'data-online-market-phase',
        ),
        status: await page.locator('#online-market-status').innerText(),
      };
      report.scenarios.push(
        'preference-restored-through-full-gate',
        'network-failure-keeps-last-valid-snapshot',
      );
      await page.screenshot({
        path: join(output, 'online-market-degraded.png'),
      });
    } finally {
      await closeScenario('online-restart-offline', app);
    }
  }

  {
    const { app, page } = await launchScenario('online-source-delayed', {
      userData: primaryUserData,
      now: '2026-10-12T10:05:04+08:00',
      clockRate: 60,
    });
    try {
      await waitForOnlinePhase(page, ['source-delayed']);
      assert.equal(await page.getByTestId('online-market-toggle').isChecked(), true);
      assert.deepEqual(await counts(page), { bars5: 36, bars60: 3 });
      assert.match(
        await page.locator('#online-market-status').innerText(),
        /数据源延迟/,
      );
      assert.match(
        await page.locator('#online-market-meta').innerText(),
        /10:00/,
      );
      report.sourceDelay = {
        counts: await counts(page),
        phase: await page.locator('html').getAttribute(
          'data-online-market-phase',
        ),
        metadata: await page.locator('#online-market-meta').innerText(),
      };
      report.scenarios.push('source-delay-distinct-from-failure');

      await testDiagnostics(app, 'clear');
      await page.locator('.online-market-switch').click();
      await waitForOnlinePhase(page, ['disabled']);
      assert.equal(await page.getByTestId('online-market-toggle').isChecked(), false);
      assert.deepEqual(await counts(page), { bars5: 36, bars60: 3 });
      assert.match(await page.locator('#online-market-status').innerText(), /离线/);
      await page.waitForTimeout(1_500);
      const disabledRequests = minuteMainRequests(await testDiagnostics(app, 'edb'));
      const disabledMarketStates = await testDiagnostics(app, 'market');
      const disabledOnlineStates = await testDiagnostics(app, 'online');
      assert.deepEqual(disabledRequests, []);
      assert.deepEqual(disabledMarketStates, []);
      assert.ok(disabledOnlineStates.some(state => state.phase === 'disabled'));
      assert.ok(disabledOnlineStates.every(state => state.phase === 'disabled'));
      report.disable = {
        counts: await counts(page),
        phase: await page.locator('html').getAttribute(
          'data-online-market-phase',
        ),
        status: await page.locator('#online-market-status').innerText(),
        requestsAfterDisable: disabledRequests.length,
        updateStatesAfterDisable: disabledMarketStates.length,
      };
      report.scenarios.push('online-disable-stops-scheduling');
    } finally {
      await closeScenario('online-source-delayed', app);
    }
  }

  {
    const { app, page } = await launchScenario('online-stale-switch', {
      userData: staleUserData,
      now: '2026-10-12T10:00:04+08:00',
      delays: { rapeseed_meal_main: 1_200 },
    });
    try {
      await switchInstrument(page, 'rebar_main');
      await enableOnlineMarket(page);
      await waitForOnlinePhase(page, ['waiting']);
      await testDiagnostics(app, 'clear');
      await requestInstrument(page, 'rapeseed_meal_main');
      await page.waitForTimeout(100);
      await requestInstrument(page, 'rebar_main');
      await waitForInstrument(page, 'rebar_main');
      await waitForOnlinePhase(page, ['waiting']);
      await page.waitForTimeout(1_400);
      assert.equal(
        await page.locator('html').getAttribute('data-instrument'),
        'rebar_main',
      );
      assert.equal(await page.getByTestId('instrument').inputValue(), 'rebar_main');
      assert.match(await page.locator('#instrument-name').innerText(), /螺纹钢/);
      const requests = minuteMainRequests(await testDiagnostics(app, 'edb'));
      assert.ok(requests.some(
        request => request.instrument === 'rapeseed_meal_main',
      ));
      assert.ok(requests.some(request => request.instrument === 'rebar_main'));
      const onlineStates = await testDiagnostics(app, 'online');
      assert.equal(onlineStates.at(-1)?.instrument, 'rebar_main');
      assert.notEqual(onlineStates.at(-1)?.phase, 'catching-up');
      report.staleSwitch = {
        requestInstruments: requests.map(request => request.instrument),
        finalOnlineState: onlineStates.at(-1),
        finalInstrument: await page.locator('html').getAttribute(
          'data-instrument',
        ),
      };
      report.scenarios.push(
        'current-instrument-switch',
        'late-old-instrument-result-isolated',
      );
    } finally {
      await closeScenario('online-stale-switch', app);
    }
  }

  {
    const { app, page } = await launchScenario('online-update-all', {
      userData: concurrentUserData,
      now: '2026-10-12T09:55:04+08:00',
      clockRate: 60,
      delays: { main_continuous: 1_600 },
      failures: { main_continuous: '测试注入的豆粕网络失败' },
    });
    try {
      await switchInstrument(page, 'rebar_main');
      await enableOnlineMarket(page);
      await waitForOnlinePhase(page, ['waiting']);
      await testDiagnostics(app, 'clear');
      await page.getByTestId('market-update-all-entry').click();
      await page.getByTestId('market-update-all').click();
      await page.waitForFunction(() => {
        const status = document.querySelector('#market-update-all-status')?.textContent ?? '';
        const button = document.querySelector('#market-update-all');
        return status.includes('全部品种更新完成')
          && button
          && !button.disabled;
      }, undefined, { timeout: 90_000 });
      assert.equal(
        await page.locator('html').getAttribute('data-instrument'),
        'rebar_main',
      );
      assert.match(
        await page.locator('#market-update-all-status').innerText(),
        /失败 1/,
      );
      const requests = minuteMainRequests(await testDiagnostics(app, 'edb'));
      const requestCounts = Object.fromEntries(
        MULTI_INSTRUMENT_DEFINITIONS.map(definition => [
          definition.id,
          requests.filter(request => request.instrument === definition.id).length,
        ]),
      );
      for (const definition of MULTI_INSTRUMENT_DEFINITIONS) {
        if (definition.id === 'rebar_main') {
          assert.ok(
            requestCounts[definition.id] >= 2,
            `当前在线品种应同时包含自动检查和全量更新：${JSON.stringify(requestCounts)}`,
          );
        } else {
          assert.equal(
            requestCounts[definition.id],
            1,
            `非当前品种不得被自动轮询：${JSON.stringify(requestCounts)}`,
          );
        }
      }
      const onlineStates = await testDiagnostics(app, 'online');
      assert.ok(onlineStates.length > 0);
      assert.ok(onlineStates.every(state => state.instrument === 'rebar_main'));
      report.updateAllConcurrency = {
        requestCounts,
        finalInstrument: await page.locator('html').getAttribute(
          'data-instrument',
        ),
        status: await page.locator('#market-update-all-status').innerText(),
      };
      report.scenarios.push(
        'update-all-concurrent-with-current-polling',
        'only-current-instrument-auto-polled',
      );
    } finally {
      await closeScenario('online-update-all', app);
    }
  }

  assert.deepEqual(pageErrors, []);
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  for (const app of activeApps) {
    await app.close().catch(error => {
      failure ??= error;
    });
  }
  await new Promise(resolvePromise => networkServer.close(resolvePromise));
  await writeFile(
    join(output, 'online-market-smoke.json'),
    `${JSON.stringify({ ...report, pageErrors }, null, 2)}\n`,
    'utf8',
  );
  if (process.env.MONEYCOMING_KEEP_ONLINE_MARKET_SMOKE !== '1') {
    await rm(sandbox, { recursive: true, force: true });
  } else {
    console.log(`保留在线行情冒烟目录：${sandbox}`);
  }
}

if (failure) throw failure;
console.log(JSON.stringify(report));
