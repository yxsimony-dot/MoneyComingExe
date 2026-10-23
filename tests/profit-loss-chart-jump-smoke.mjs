import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts');
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-profit-loss-jump-'));
const executablePath = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const env = {
  ...process.env,
  MONEYCOMING_TEST_MODE: '1',
  MONEYCOMING_TEST_USER_DATA: join(sandbox, 'user-data'),
  APPDATA: join(sandbox, 'appdata'),
  LOCALAPPDATA: join(sandbox, 'localappdata'),
};
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(output, { recursive: true });

const report = {
  packaged: Boolean(executablePath),
  offscreen: {},
  counts: {},
  completedJump: {},
  incompleteJump: {},
  invalidSource: {},
  refresh: {},
  narrowLayout: {},
  passed: false,
};

async function frame(page, count = 3) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
  }
}

async function diagnostics(page) {
  return page.evaluate(() => window.moneyComingTest.profitLossTradeJumpDiagnostics());
}

async function chartRange(page, period) {
  const range = await page.locator(`#card-${period}`).evaluate(element => ({
    from: Number(element.dataset.visibleFrom),
    to: Number(element.dataset.visibleTo),
    span: Number(element.dataset.visibleSpan),
  }));
  assert.ok(
    Object.values(range).every(Number.isFinite),
    `Invalid ${period}-minute chart range: ${JSON.stringify(range)}`,
  );
  return range;
}

function assertRangeEqual(actual, expected, label) {
  for (const key of ['from', 'to', 'span']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 0.01,
      `${label} ${key} changed: ${JSON.stringify({ actual, expected })}`,
    );
  }
}

async function setSessionExitMinutes(page, minutes) {
  await page.getByTestId('session-exit-minutes').evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, minutes);
  await frame(page, 6);
  assert.equal(
    await page.locator('html').getAttribute('data-session-exit-minutes'),
    String(minutes),
  );
}

async function setReviewDateRange(page, startDate, endDate) {
  await page.evaluate(({ startDate, endDate }) => {
    const start = document.querySelector('#review-start-date');
    const end = document.querySelector('#review-end-date');
    start.value = startDate;
    end.value = endDate;
    end.dispatchEvent(new Event('change', { bubbles: true }));
  }, { startDate, endDate });
  await frame(page, 6);
}

async function openReview(page) {
  await page.getByTestId('profit-loss-review').click();
  await page.locator('#review-dialog[open]').waitFor();
  await frame(page);
}

async function closeReview(page) {
  if (await page.locator('#review-dialog').evaluate(element => element.open)) {
    await page.getByTestId('review-done').click();
  }
}

async function locateButton(page, trade) {
  const selector = `[data-testid="review-trade-locate"][data-trade-kind="${trade.kind}"]`;
  const index = await page.locator(selector).evaluateAll(
    (buttons, tradeId) => buttons.findIndex(button => button.dataset.tradeId === tradeId),
    trade.tradeId,
  );
  assert.ok(index >= 0, `Missing locate button for ${trade.kind} trade ${trade.tradeId}`);
  return page.locator(selector).nth(index);
}

async function assertTradeButtons(page, current) {
  const buttons = page.getByTestId('review-trade-locate');
  const dom = await buttons.evaluateAll(elements => elements.map(element => ({
    tagName: element.tagName,
    type: element.getAttribute('type'),
    kind: element.dataset.tradeKind,
    tradeId: element.dataset.tradeId,
    sourceIndex: Number(element.dataset.sourceIndex),
    label: element.getAttribute('aria-label'),
    text: element.textContent?.trim(),
  })));
  const expected = [...current.completed, ...current.incomplete].map((trade, index) => ({
    tagName: 'BUTTON',
    type: 'button',
    kind: trade.kind,
    tradeId: trade.tradeId,
    sourceIndex: trade.sourceIndex,
    label: `定位第 ${index < current.completed.length
      ? index + 1
      : index - current.completed.length + 1} 笔${trade.kind === 'completed'
      ? '已完成'
      : '未完成'}交易的60分钟K线`,
    text: '定位',
  }));
  assert.deepEqual(dom, expected);
}

async function assertNarrowLayout(page) {
  await page.setViewportSize({ width: 760, height: 720 });
  await frame(page, 5);
  const layout = await page.evaluate(() => {
    const intersects = (left, right) => (
      left.left < right.right
      && left.right > right.left
      && left.top < right.bottom
      && left.bottom > right.top
    );
    const inspect = (row, kind) => {
      const title = row.querySelector('.review-trade-heading > strong');
      const status = row.querySelector('.review-status');
      const button = row.querySelector('[data-testid="review-trade-locate"]');
      const detail = kind === 'completed'
        ? row.querySelector('.review-trade-grid')
        : row.querySelector('p');
      const actions = row.querySelector('.review-trade-actions');
      const rowRect = row.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        kind,
        titleActionsOverlap: intersects(titleRect, actionsRect),
        statusButtonOverlap: intersects(statusRect, buttonRect),
        headingDetailOverlap: intersects(
          {
            left: Math.min(titleRect.left, actionsRect.left),
            right: Math.max(titleRect.right, actionsRect.right),
            top: Math.min(titleRect.top, actionsRect.top),
            bottom: Math.max(titleRect.bottom, actionsRect.bottom),
          },
          detailRect,
        ),
        rowOverflow: row.scrollWidth > row.clientWidth,
        actionOutsideRow: actionsRect.left < rowRect.left || actionsRect.right > rowRect.right,
        textOverflow: [...row.querySelectorAll('strong, span, b, p, button')]
          .some(element => element.scrollWidth > element.clientWidth + 1),
      };
    };
    return {
      rows: [
        ...[...document.querySelectorAll('[data-testid="review-trade"]')]
          .map(row => inspect(row, 'completed')),
        ...[...document.querySelectorAll('[data-testid="review-incomplete-trade"]')]
          .map(row => inspect(row, 'incomplete')),
      ],
      dialogOverflow: document.querySelector('#review-dialog').scrollWidth
        > document.querySelector('#review-dialog').clientWidth,
    };
  });
  assert.ok(layout.rows.some(row => row.kind === 'completed'));
  assert.ok(layout.rows.some(row => row.kind === 'incomplete'));
  for (const row of layout.rows) {
    assert.equal(row.titleActionsOverlap, false, JSON.stringify(row));
    assert.equal(row.statusButtonOverlap, false, JSON.stringify(row));
    assert.equal(row.headingDetailOverlap, false, JSON.stringify(row));
    assert.equal(row.rowOverflow, false, JSON.stringify(row));
    assert.equal(row.actionOutsideRow, false, JSON.stringify(row));
    assert.equal(row.textOverflow, false, JSON.stringify(row));
  }
  assert.equal(layout.dialogOverflow, false, JSON.stringify(layout));
  report.narrowLayout = layout;
  await page.screenshot({ path: join(output, 'profit-loss-chart-jump-760.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame(page, 5);
}

let app;
const pageErrors = [];
try {
  app = await launchElectronTest({
    ...(executablePath
      ? { executablePath, args: [], cwd: sandbox }
      : { args: [root], cwd: root }),
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  report.offscreen.beforeShow = await assertElectronWindowOffscreen(
    app,
    'profit-loss-chart-jump-before-show',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  report.offscreen.afterShow = await assertElectronWindowOffscreen(
    app,
    'profit-loss-chart-jump-after-show',
  );
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame(page, 5);

  await setSessionExitMinutes(page, 0);
  await openReview(page);
  const initial = await diagnostics(page);
  assert.ok(initial.completed.length > 0, 'Expected completed trades.');
  assert.ok(initial.incomplete.length > 0, 'Expected incomplete trades.');
  assert.equal(
    await page.locator('[data-testid="review-trade"] [data-testid="review-trade-locate"]').count(),
    initial.completed.length,
  );
  assert.equal(
    await page.locator('[data-testid="review-incomplete-trade"] [data-testid="review-trade-locate"]').count(),
    initial.incomplete.length,
  );
  assert.equal(await page.getByTestId('review-trade-jump-error').getAttribute('role'), 'alert');
  assert.equal(
    await page.getByTestId('review-trade-jump-error').getAttribute('aria-live'),
    'assertive',
  );
  assert.equal(await page.getByTestId('review-trade-jump-error').isHidden(), true);
  await assertTradeButtons(page, initial);
  report.counts = {
    completed: initial.completed.length,
    incomplete: initial.incomplete.length,
    backgroundMinuteCount: initial.backgroundMinuteCount,
  };
  await assertNarrowLayout(page);

  await closeReview(page);
  await page.getByTestId('mode-5').click();
  await frame(page);
  assert.equal(await page.locator('html').getAttribute('data-mode'), '5');
  await openReview(page);
  const beforeCompletedJump = await diagnostics(page);
  const completedTrade = beforeCompletedJump.completed.find(
    trade => trade.markerId && trade.barStartMs !== undefined && trade.lifecycleFocusCount,
  );
  assert.ok(completedTrade, 'Expected a completed trade with a visible lifecycle.');
  const decoy = await page.evaluate(
    sourceIndex => window.moneyComingTest.addProfitLossTradeMarkerDecoy(sourceIndex),
    completedTrade.sourceIndex,
  );
  assert.ok(decoy);
  assert.equal(decoy.sourceMarkerId, completedTrade.markerId);
  const afterDecoy = await diagnostics(page);
  const completedWithDecoy = afterDecoy.completed.find(
    trade => trade.tradeId === completedTrade.tradeId,
  );
  assert.ok(completedWithDecoy);
  assert.ok(
    completedWithDecoy.sameBarOpportunityCount > 1,
    JSON.stringify(completedWithDecoy),
  );
  const completedButton = await locateButton(page, completedTrade);
  const completedRequestCount = afterDecoy.jumpRequestCount;
  await completedButton.click();
  await page.waitForFunction(
    ({ markerId, startMs }) => (
      !document.querySelector('#review-dialog').open
      && document.documentElement.dataset.mode === 'dual'
      && document.documentElement.dataset.selectedStart === String(startMs)
      && document.documentElement.dataset.entryMarkerId === markerId
    ),
    { markerId: completedTrade.markerId, startMs: completedTrade.barStartMs },
  );
  await frame(page, 6);
  const afterCompletedJump = await diagnostics(page);
  assert.equal(afterCompletedJump.jumpRequestCount, completedRequestCount + 1);
  assert.equal(afterCompletedJump.mode, 'dual');
  assert.deepEqual(afterCompletedJump.chartPeriods, [60, 5]);
  assert.deepEqual(afterCompletedJump.selection, {
    period: 60,
    startMs: completedTrade.barStartMs,
    markerId: completedTrade.markerId,
    source: 'marker',
  });
  assert.equal(afterCompletedJump.center60StartMs, completedTrade.barStartMs);
  assert.equal(afterCompletedJump.backgroundMinuteCount, initial.backgroundMinuteCount);
  assert.equal(await page.locator('#card-60').isVisible(), true);
  assert.equal(await page.locator('#card-5').isVisible(), true);
  assert.equal(await page.locator('#card-1, [data-mode="1"], [data-testid="mode-1"]').count(), 0);
  assert.equal(
    await page.locator('html').getAttribute('data-entry-focus-count'),
    String(completedTrade.lifecycleFocusCount),
  );
  assert.equal(
    await page.locator('html').getAttribute('data-entry-focus-first-start'),
    String(completedTrade.lifecycleFocusFirstStartMs),
  );
  assert.equal(
    await page.locator('html').getAttribute('data-entry-focus-last-start'),
    String(completedTrade.lifecycleFocusLastStartMs),
  );
  assert.equal(await page.locator('html').getAttribute('data-entry-selection-source'), 'marker');
  assert.equal(await page.locator('html').getAttribute('data-entry-marker-id'), completedTrade.markerId);
  report.completedJump = {
    tradeId: completedTrade.tradeId,
    sourceIndex: completedTrade.sourceIndex,
    markerId: completedTrade.markerId,
    decoyMarkerId: decoy.decoyMarkerId,
    barStartMs: completedTrade.barStartMs,
    center60StartMs: afterCompletedJump.center60StartMs,
    sameBarOpportunityCount: completedWithDecoy.sameBarOpportunityCount,
  };

  await openReview(page);
  const beforeIncompleteJump = await diagnostics(page);
  const incompleteTrade = beforeIncompleteJump.incomplete.find(
    trade => trade.markerId && trade.barStartMs !== undefined && trade.lifecycleFocusCount,
  );
  assert.ok(incompleteTrade, 'Expected an incomplete trade with a visible lifecycle.');
  const incompleteButton = await locateButton(page, incompleteTrade);
  const incompleteRequestCount = beforeIncompleteJump.jumpRequestCount;
  await incompleteButton.focus();
  await incompleteButton.press('Enter');
  await page.waitForFunction(
    ({ markerId, startMs }) => (
      !document.querySelector('#review-dialog').open
      && document.documentElement.dataset.mode === 'dual'
      && document.documentElement.dataset.selectedStart === String(startMs)
      && document.documentElement.dataset.entryMarkerId === markerId
    ),
    { markerId: incompleteTrade.markerId, startMs: incompleteTrade.barStartMs },
  );
  await frame(page, 6);
  const afterIncompleteJump = await diagnostics(page);
  assert.equal(afterIncompleteJump.jumpRequestCount, incompleteRequestCount + 1);
  assert.deepEqual(afterIncompleteJump.selection, {
    period: 60,
    startMs: incompleteTrade.barStartMs,
    markerId: incompleteTrade.markerId,
    source: 'marker',
  });
  assert.equal(afterIncompleteJump.center60StartMs, incompleteTrade.barStartMs);
  assert.equal(afterIncompleteJump.backgroundMinuteCount, initial.backgroundMinuteCount);
  report.incompleteJump = {
    tradeId: incompleteTrade.tradeId,
    sourceIndex: incompleteTrade.sourceIndex,
    markerId: incompleteTrade.markerId,
    barStartMs: incompleteTrade.barStartMs,
    keyboard: 'Enter',
  };

  await page.getByTestId('mode-60').click();
  await frame(page);
  await openReview(page);
  const invalidTrade = (await diagnostics(page)).completed[0];
  assert.ok(invalidTrade);
  const invalidButton = await locateButton(page, invalidTrade);
  await invalidButton.evaluate(element => {
    element.dataset.sourceIndex = '-1';
  });
  const beforeInvalid = {
    diagnostics: await diagnostics(page),
    ranges: {
      60: await chartRange(page, 60),
      5: await chartRange(page, 5),
    },
  };
  await invalidButton.click();
  await frame(page, 5);
  const afterInvalid = {
    diagnostics: await diagnostics(page),
    ranges: {
      60: await chartRange(page, 60),
      5: await chartRange(page, 5),
    },
  };
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  assert.equal(await page.getByTestId('review-trade-jump-error').isVisible(), true);
  assert.match(await page.getByTestId('review-trade-jump-error').innerText(), /无法定位.*准确来源机会/);
  assert.equal(afterInvalid.diagnostics.mode, beforeInvalid.diagnostics.mode);
  assert.deepEqual(afterInvalid.diagnostics.selection, beforeInvalid.diagnostics.selection);
  assert.equal(
    afterInvalid.diagnostics.center60StartMs,
    beforeInvalid.diagnostics.center60StartMs,
  );
  assert.equal(
    afterInvalid.diagnostics.jumpRequestCount,
    beforeInvalid.diagnostics.jumpRequestCount + 1,
  );
  assertRangeEqual(afterInvalid.ranges[60], beforeInvalid.ranges[60], 'invalid 60-minute');
  assertRangeEqual(afterInvalid.ranges[5], beforeInvalid.ranges[5], 'invalid 5-minute');
  report.invalidSource = {
    mode: afterInvalid.diagnostics.mode,
    selection: afterInvalid.diagnostics.selection,
    error: await page.getByTestId('review-trade-jump-error').innerText(),
  };

  const initialDateDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  const fullRange = {
    startDate: initialDateDiagnostics.reviewStartDate,
    endDate: initialDateDiagnostics.reviewEndDate,
  };
  const refreshDate = initialDateDiagnostics.attempts.find(
    attempt => attempt.entryDate,
  )?.entryDate;
  assert.ok(fullRange.startDate && fullRange.endDate && refreshDate);
  const refreshCountBefore = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setSessionExitMinutes(page, 5);
  await setReviewDateRange(page, refreshDate, refreshDate);
  await setReviewDateRange(page, fullRange.startDate, fullRange.endDate);
  await setSessionExitMinutes(page, 0);
  const refreshCountAfter = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  assert.ok(refreshCountAfter >= refreshCountBefore + 4);
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  assert.equal(await page.getByTestId('review-trade-jump-error').isHidden(), true);
  const refreshed = await diagnostics(page);
  assert.ok(refreshed.completed.length > 0);
  assert.ok(refreshed.incomplete.length > 0);
  await assertTradeButtons(page, refreshed);
  const refreshedTrade = refreshed.completed[0];
  const refreshedButton = await locateButton(page, refreshedTrade);
  const refreshedRequestCount = refreshed.jumpRequestCount;
  await refreshedButton.click();
  await page.waitForFunction(
    ({ markerId, startMs }) => (
      !document.querySelector('#review-dialog').open
      && document.documentElement.dataset.selectedStart === String(startMs)
      && document.documentElement.dataset.entryMarkerId === markerId
    ),
    { markerId: refreshedTrade.markerId, startMs: refreshedTrade.barStartMs },
  );
  await frame(page, 5);
  const afterRefreshJump = await diagnostics(page);
  assert.equal(afterRefreshJump.jumpRequestCount, refreshedRequestCount + 1);
  assert.deepEqual(afterRefreshJump.selection, {
    period: 60,
    startMs: refreshedTrade.barStartMs,
    markerId: refreshedTrade.markerId,
    source: 'marker',
  });
  report.refresh = {
    refreshCountBefore,
    refreshCountAfter,
    tradeId: refreshedTrade.tradeId,
    sourceIndex: refreshedTrade.sourceIndex,
    jumpRequestDelta: afterRefreshJump.jumpRequestCount - refreshedRequestCount,
  };

  report.offscreen.beforeClose = await assertElectronWindowOffscreen(
    app,
    'profit-loss-chart-jump-before-close',
  );
  assert.deepEqual(pageErrors, []);
  report.pageErrors = pageErrors;
  report.passed = true;
} finally {
  if (app) await app.close().catch(() => undefined);
  await writeFile(
    join(output, 'profit-loss-chart-jump.json'),
    `${JSON.stringify({ ...report, pageErrors }, null, 2)}\n`,
    'utf8',
  );
  await rm(sandbox, { recursive: true, force: true });
}

console.log(JSON.stringify(report));
