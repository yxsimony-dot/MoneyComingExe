import { launchElectronTest } from './electron-test-launch.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  assertElectronWindowOffscreen,
  negativeCoordinateGeometryFixture,
} from './electron-offscreen.mjs';

const output = resolve('artifacts');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const baselineReport = JSON.parse(
  readFileSync(new URL('../data/baseline-report.json', import.meta.url), 'utf8'),
);
const mainBaseline = baselineReport.instruments.find(
  instrument => instrument.instrumentId === 'main_continuous',
);
assert.ok(mainBaseline, 'Baseline report must contain main_continuous.');
const expectedMainCountPattern = new RegExp(
  `${mainBaseline.fiveMinuteRows.toLocaleString('en-US')}.*${mainBaseline.sixtyMinuteRows.toLocaleString('en-US')}`,
);
const mainBaselineDirectory = new URL('../data/instruments/main_continuous/', import.meta.url);
const readBaselineRows = filename => readFileSync(
  new URL(filename, mainBaselineDirectory),
  'utf8',
).trim().split(/\r?\n/).slice(1).map(line => line.split(','));
const rolloverRows = readBaselineRows('edb_main_continuous_rollovers.csv');
const sourceRows = readBaselineRows('edb_main_continuous_60m.csv');
const sourceRows5 = readBaselineRows('edb_main_continuous_5m.csv');
const toBeijingTimestamp = value => Date.parse(value.replace(' ', 'T') + '+08:00');
const childrenForParent = start => {
  const parent = sourceRows.find(row => row[0] === start);
  assert.ok(parent, `Expected 60m source row ${start}.`);
  const parentStart = toBeijingTimestamp(parent[0]);
  const parentEnd = toBeijingTimestamp(parent[1]);
  return sourceRows5.filter(row => {
    const childStart = toBeijingTimestamp(row[0]);
    return parentStart <= childStart && childStart < parentEnd;
  });
};
const expectedRolloverLabels = rolloverRows.map(
  ([, , fromContract, toContract]) => `主力换月：${fromContract} -> ${toContract}`,
);
const expectedRolloverStarts = rolloverRows.map(([, time]) => time.slice(0, 16));
const expectedRolloverCount = String(rolloverRows.length);
const sandbox = process.env.MONEYCOMING_TEST_USER_DATA
  ? undefined
  : await mkdtemp(join(tmpdir(), 'moneycoming-app-smoke-'));
const userData = process.env.MONEYCOMING_TEST_USER_DATA
  ? resolve(process.env.MONEYCOMING_TEST_USER_DATA)
  : join(sandbox, 'user-data');
const env = {
  ...process.env,
  MONEYCOMING_TEST_MODE: '1',
  MONEYCOMING_TEST_USER_DATA: userData,
};
if (process.env.MONEYCOMING_TEST_APPDATA) {
  env.APPDATA = process.env.MONEYCOMING_TEST_APPDATA;
} else if (sandbox) {
  env.APPDATA = join(sandbox, 'appdata');
}
if (process.env.MONEYCOMING_TEST_LOCALAPPDATA) {
  env.LOCALAPPDATA = process.env.MONEYCOMING_TEST_LOCALAPPDATA;
} else if (sandbox) {
  env.LOCALAPPDATA = join(sandbox, 'localappdata');
}
delete env.ELECTRON_RUN_AS_NODE;
const started = performance.now();
const executablePath = process.env.MONEYCOMING_EXE;
installerSmokeRun: {
const app = await launchElectronTest({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env, timeout: 30000 });
const errors = [];
try {
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'app-smoke-before-show');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'app-smoke-after-show');
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await page.locator('html[data-ready="true"]').waitFor();
  await page.getByTestId('review-done').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const jump = async date => {
    await page.getByTestId('date-input').fill(date);
    await page.getByTestId('date-jump').click();
    await frame();
  };
  const setReviewDateRange = async (startDate, endDate) => {
    await page.evaluate(({ startDate, endDate }) => {
      const start = document.querySelector('#review-start-date');
      const end = document.querySelector('#review-end-date');
      start.value = startDate;
      end.value = endDate;
      end.dispatchEvent(new Event('change', { bubbles: true }));
    }, { startDate, endDate });
    await frame();
  };
  const beijingDateKey = timestamp => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const startupMs = performance.now() - started;
  await page.setViewportSize({ width: 1100, height: 720 });
  const compactLayout = await page.evaluate(() => {
    const rect = selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : undefined;
    };
    const update = document.querySelector('#update-entry');
    return {
      brand: rect('.brand'),
      controls: rect('.topbar-right'),
      update: rect('#update-entry'),
      source: rect('#source-info'),
      updateTextFits: update ? update.scrollWidth <= update.clientWidth : false,
    };
  });
  assert.ok(compactLayout.brand && compactLayout.controls && compactLayout.update && compactLayout.source);
  assert.ok(compactLayout.brand.right <= compactLayout.controls.left);
  assert.ok(compactLayout.update.right <= compactLayout.source.left);
  assert.ok(compactLayout.source.right <= 1100);
  assert.equal(compactLayout.updateTextFits, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(output, 'default-1440.png') });
  assert.match(await page.locator('#counts').innerText(), expectedMainCountPattern);
  const rolloverDiagnostics = async period => ({
    count: await page.locator(`#card-${period}`).getAttribute('data-rollover-count'),
    labels: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-labels')),
    starts: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-starts')),
  });
  const initialRolloverDiagnostics = {
    5: await rolloverDiagnostics(5),
    60: await rolloverDiagnostics(60),
  };
  assert.deepEqual(initialRolloverDiagnostics, {
    5: { count: expectedRolloverCount, labels: expectedRolloverLabels, starts: expectedRolloverStarts },
    60: { count: expectedRolloverCount, labels: expectedRolloverLabels, starts: expectedRolloverStarts },
  });
  assert.equal(await page.locator('#card-60').getAttribute('data-monday-count'), '0');
  assert.equal(await page.locator('#card-5').getAttribute('data-monday-count'), '0');
  assert.match(await page.locator('.monday-legend').first().innerText(), /● 周一前8根/);
  await page.getByTestId('toggle-monday').click();
  await frame();
  assert.deepEqual(await rolloverDiagnostics(5), initialRolloverDiagnostics[5]);
  assert.deepEqual(await rolloverDiagnostics(60), initialRolloverDiagnostics[60]);
  const initialDateDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  const fullReviewRange = {
    startDate: beijingDateKey(initialDateDiagnostics.rawBars5.firstStartMs),
    endDate: beijingDateKey(initialDateDiagnostics.rawBars5.lastStartMs),
  };
  await setReviewDateRange(fullReviewRange.startDate, fullReviewRange.endDate);
  const fullDateDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.equal(fullDateDiagnostics.reviewStartDate, fullReviewRange.startDate);
  assert.equal(fullDateDiagnostics.reviewEndDate, fullReviewRange.endDate);
  const completedDateAttempt = fullDateDiagnostics.attempts.find(attempt =>
    attempt.attemptNumber === 1
    && attempt.exitStartMs !== undefined
    && attempt.lineEndMs !== undefined);
  assert.ok(completedDateAttempt, 'Expected a completed first entry attempt for date-range checks');
  const reviewDate = completedDateAttempt.entryDate;
  await setReviewDateRange(reviewDate, reviewDate);
  const narrowedDateDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.deepEqual(narrowedDateDiagnostics.rawBars5, fullDateDiagnostics.rawBars5);
  assert.deepEqual(narrowedDateDiagnostics.rawBars60, fullDateDiagnostics.rawBars60);
  assert.ok(
    narrowedDateDiagnostics.visibleCandidateCount < fullDateDiagnostics.visibleCandidateCount,
    JSON.stringify({
      full: fullDateDiagnostics.visibleCandidateCount,
      narrowed: narrowedDateDiagnostics.visibleCandidateCount,
      reviewDate,
    }),
  );
  assert.ok(narrowedDateDiagnostics.visibleCandidateCount > 0);
  assert.ok(narrowedDateDiagnostics.attempts.length > 0);
  assert.ok(narrowedDateDiagnostics.attempts.every(attempt => attempt.entryDate === reviewDate));
  assert.ok(narrowedDateDiagnostics.visibleMarkerIds.includes(completedDateAttempt.markerId));

  const outsideStartMs = beijingDateKey(fullDateDiagnostics.rawBars60.firstStartMs) === reviewDate
    ? fullDateDiagnostics.rawBars60.lastStartMs
    : fullDateDiagnostics.rawBars60.firstStartMs;
  const outsideDate = beijingDateKey(outsideStartMs);
  assert.notEqual(outsideDate, reviewDate);
  await jump(outsideDate);
  assert.equal(
    beijingDateKey(Number(await page.locator('html').getAttribute('data-selected-start'))),
    outsideDate,
  );

  const selectedDateEntry = await page.evaluate(
    markerId => window.moneyComingTest.selectVisibleEntry(markerId),
    completedDateAttempt.markerId,
  );
  assert.equal(selectedDateEntry, true);
  await frame();
  const selectedMarkerAttempts = narrowedDateDiagnostics.attempts
    .filter(attempt => attempt.markerId === completedDateAttempt.markerId);
  const selectedAttempt = selectedMarkerAttempts.find(attempt =>
    attempt.attemptNumber === completedDateAttempt.attemptNumber);
  assert.ok(selectedAttempt);
  const selectedLifecycleLastStart = Math.max(
    ...selectedMarkerAttempts.map(attempt => attempt.analysisLastStartMs),
  );
  const selectedDateChartDiagnostics = await page.evaluate(attemptNumber => {
    const root = document.documentElement.dataset;
    const card = document.querySelector('#card-5').dataset;
    const prefix = `attempt${attemptNumber}`;
    return {
      selectionKind: root.selectionKind,
      lifecycleLastStart: root.entryLifecycleLastStart,
      analysisLastStart: card[`${prefix}AnalysisLastStart`],
      exitType: card[`${prefix}ExitType`],
      exitStart: card[`${prefix}ExitStart`],
      stopLossLineVisible: card[`${prefix}StopLossLineVisible`],
      stopLossLineLastStart: card[`${prefix}StopLossLineLastStart`],
      takeProfitLineVisible: card[`${prefix}TakeProfitLineVisible`],
      takeProfitLineLastStart: card[`${prefix}TakeProfitLineLastStart`],
      exitSignalLineEnd: card.exitSignalLineEnd,
      exitMarkerCount: Number(card.exitMarkerCount),
    };
  }, selectedAttempt.attemptNumber);
  assert.equal(selectedDateChartDiagnostics.selectionKind, 'entry');
  assert.equal(
    selectedDateChartDiagnostics.lifecycleLastStart,
    String(selectedLifecycleLastStart),
  );
  assert.equal(
    selectedDateChartDiagnostics.analysisLastStart,
    String(selectedAttempt.analysisLastStartMs),
  );
  assert.equal(selectedDateChartDiagnostics.exitType, selectedAttempt.exitType);
  assert.equal(selectedDateChartDiagnostics.exitStart, String(selectedAttempt.exitStartMs));
  assert.equal(selectedDateChartDiagnostics.stopLossLineVisible, 'true');
  assert.equal(
    selectedDateChartDiagnostics.stopLossLineLastStart,
    String(selectedAttempt.exitStartMs),
  );
  assert.equal(selectedDateChartDiagnostics.takeProfitLineVisible, 'true');
  assert.equal(
    selectedDateChartDiagnostics.takeProfitLineLastStart,
    String(selectedAttempt.exitStartMs),
  );
  assert.equal(
    selectedDateChartDiagnostics.exitSignalLineEnd,
    String(selectedAttempt.lineEndMs),
  );
  assert.ok(selectedDateChartDiagnostics.exitMarkerCount > 0);

  await setReviewDateRange(fullReviewRange.startDate, fullReviewRange.endDate);
  const restoredDateDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.deepEqual(restoredDateDiagnostics.rawBars5, fullDateDiagnostics.rawBars5);
  assert.deepEqual(restoredDateDiagnostics.rawBars60, fullDateDiagnostics.rawBars60);
  assert.equal(
    restoredDateDiagnostics.visibleCandidateCount,
    fullDateDiagnostics.visibleCandidateCount,
  );
  await page.getByTestId('toggle-monday').click();
  await frame();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'disabled');
  assert.equal(await page.locator('#app-version').innerText(), `v${manifest.version}`);
  const entryRulesButton = page.getByTestId('entry-rules');
  const reviewButton = page.getByTestId('profit-loss-review');
  assert.equal(await reviewButton.getAttribute('aria-label'), null);
  assert.equal(await reviewButton.innerText(), '盈亏情况');
  const toolbarButtonGeometry = await page.evaluate(() => {
    const entry = document.querySelector('#entry-rules')?.getBoundingClientRect();
    const review = document.querySelector('#profit-loss-review')?.getBoundingClientRect();
    return entry && review
      ? { entryRight: entry.right, reviewLeft: review.left, entryTop: entry.top, reviewTop: review.top }
      : undefined;
  });
  assert.ok(toolbarButtonGeometry);
  assert.ok(toolbarButtonGeometry.entryRight <= toolbarButtonGeometry.reviewLeft);
  assert.ok(Math.abs(toolbarButtonGeometry.entryTop - toolbarButtonGeometry.reviewTop) < 8);
  await reviewButton.click();
  await frame();
  assert.ok(await page.getByTestId('review-final-capital').isVisible());
  assert.match(await page.locator('.review-note').innerText(), /10 倍理论名义杠杆/);
  assert.ok((await page.locator('[data-testid="review-trade"], [data-testid="review-no-completed"]').count()) > 0);
  assert.equal(await page.getByTestId('review-incomplete-section').count(), 1);
  assert.ok((await page.locator('.review-status').count()) > 0);
  const reviewDialogGeometry = await page.evaluate(() => {
    const dialog = document.querySelector('#review-dialog');
    const content = document.querySelector('#review-content');
    if (!dialog || !content) return undefined;
    const rect = dialog.getBoundingClientRect();
    const style = getComputedStyle(content);
    return {
      right: rect.right,
      bottom: rect.bottom,
      overflowY: style.overflowY,
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
    };
  });
  assert.ok(reviewDialogGeometry);
  assert.ok(reviewDialogGeometry.right <= 1440);
  assert.ok(reviewDialogGeometry.bottom <= 900);
  assert.equal(reviewDialogGeometry.overflowY, 'auto');
  await page.getByTestId('review-done').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  await reviewButton.click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await page.getByTestId('close-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  await reviewButton.click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  const compactReviewGeometry = await page.evaluate(() => {
    const dialog = document.querySelector('#review-dialog');
    const content = document.querySelector('#review-content');
    if (!dialog || !content) return undefined;
    const rect = dialog.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      overflowY: getComputedStyle(content).overflowY,
    };
  });
  assert.ok(compactReviewGeometry);
  assert.ok(compactReviewGeometry.left >= 0);
  assert.ok(compactReviewGeometry.right <= 1100);
  assert.ok(compactReviewGeometry.top >= 0);
  assert.ok(compactReviewGeometry.bottom <= 720);
  assert.equal(compactReviewGeometry.overflowY, 'auto');
  await page.getByTestId('review-done').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  assert.equal(await entryRulesButton.innerText(), '入场规则');
  assert.equal(await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return false;
    } catch {
      return true;
    }
  }), true);
  await jump('2026-08-10');
  await page.screenshot({ path: resolve(output, 'rollover-1440.png') });
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  await page.screenshot({ path: resolve(output, 'rollover-1100.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame();
  assert.equal((await page.evaluate(() => window.market.load('../../secret'))).ok, false);
  if (process.env.MONEYCOMING_INSTALLER_SMOKE === '1') {
    assert.equal(executablePath ? true : false, true);
    assert.deepEqual(errors, []);
    const offscreenBeforeClose = await assertElectronWindowOffscreen(
      app,
      'app-smoke-before-close',
    );
    await writeFile(resolve(output, 'installer-app-smoke.json'), JSON.stringify({
      packaged: true,
      startupMs,
      errors,
      offscreen: {
        beforeShow: offscreenBeforeShow,
        afterShow: offscreenAfterShow,
        beforeClose: offscreenBeforeClose,
      },
      passed: true,
    }, null, 2));
    console.log(JSON.stringify({ packaged: true, installerSmoke: true, startupMs, passed: true }));
    break installerSmokeRun;
  }
  const linkedOverlay = page.getByTestId('linked-hover-range');
  const reactionOverlay = page.getByTestId('entry-reaction-range');
  assert.equal(await linkedOverlay.count(), 1);
  assert.equal(await linkedOverlay.isHidden(), true);
  assert.deepEqual(await linkedOverlay.evaluate(element => ({
    pointerEvents: getComputedStyle(element).pointerEvents,
    position: getComputedStyle(element).position,
    parentClass: element.parentElement?.className,
  })), { pointerEvents: 'none', position: 'absolute', parentClass: 'chart-container' });
  assert.equal(await reactionOverlay.count(), 1);
  assert.equal(await reactionOverlay.isHidden(), true);
  assert.deepEqual(await reactionOverlay.evaluate(element => ({
    pointerEvents: getComputedStyle(element).pointerEvents,
    position: getComputedStyle(element).position,
    parentClass: element.parentElement?.className,
    borderStyle: getComputedStyle(element).borderStyle,
  })), { pointerEvents: 'none', position: 'absolute', parentClass: 'chart-container', borderStyle: 'solid' });
  await jump('2020-01-01');
  assert.equal(
    await page.locator('html').getAttribute('data-selected-start'),
    String(Date.parse(sourceRows[0][0].replace(' ', 'T') + '+08:00')),
  );
  assert.match(await page.locator('#counts').innerText(), expectedMainCountPattern);
  assert.deepEqual(
    await page.getByTestId('instrument').locator('option').allTextContents(),
    ['豆粕主连', '菜粕主连', 'PVC主连', '螺纹钢主连', '玻璃主连', '菜油主连', '棕榈油主连', '豆油主连', '纸浆主连', '玉米主连', '纯碱主连', '豆一主连', '甲醇主连', '白糖主连', '豆二主连'],
  );
  await page.getByTestId('source-info').click();
  assert.equal(await page.locator('[data-anomaly-index]').count(), 0);
  await page.screenshot({ path: resolve(output, 'source-details.png') });
  await page.locator('#dialog-done').click();
  const focused = await page.locator('html').getAttribute('data-selected-start');
  for (const mode of ['5', '60', 'dual']) {
    await page.getByTestId(`mode-${mode}`).click();
    await frame();
    assert.equal(await page.locator('html').getAttribute('data-selected-start'), focused);
    await page.screenshot({ path: resolve(output, `mode-${mode}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  await page.screenshot({ path: resolve(output, 'compact-1100.png') });
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => document.body.scrollHeight > innerHeight), false);
  await jump('2026-02-07');
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), String(Date.parse('2026-02-09T09:00:00+08:00')));
  await jump('2030-01-01');
  assert.equal(
    await page.locator('html').getAttribute('data-child-count'),
    String(childrenForParent(sourceRows.at(-1)[0]).length),
  );
  await page.getByTestId('latest').click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), null);
  // Locate real candles through the visible crosshair, not a test-only chart API.
  await page.setViewportSize({ width: 1440, height: 900 });
  await jump('2026-02-05');
  const chartRange = async period => ({
    from: Number(await page.locator(`#card-${period}`).getAttribute('data-visible-from')),
    to: Number(await page.locator(`#card-${period}`).getAttribute('data-visible-to')),
    span: Number(await page.locator(`#card-${period}`).getAttribute('data-visible-span')),
  });
  const hoverParent = async start => {
    const target = String(Date.parse(start.replace(' ', 'T') + '+08:00'));
    const box = await page.locator('#canvas-60').boundingBox();
    const y = box.y + Math.min(35, box.height * .2);
    for (let x = 2; x < box.width - 65; x += 2) {
      await page.mouse.move(box.x + x, y);
      await frame();
      if (await linkedOverlay.getAttribute('data-first-start') !== target) continue;
      return { x: box.x + x, y, target };
    }
    assert.fail(`Visible 60m candle ${start}`);
  };
  const clickParent = async (start, children) => {
    const point = await hoverParent(start);
    await page.mouse.click(point.x, point.y);
    await frame();
    assert.equal(await page.locator('html').getAttribute('data-selected-start'), point.target);
    assert.equal(await page.locator('html').getAttribute('data-child-count'), String(children));
    assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
    assert.equal(await page.locator('#card-60').getAttribute('data-selected-count'), '1');
    assert.equal(
      await page.locator('#card-5').getAttribute('data-selected-count'),
      await page.locator('html').getAttribute('data-child-count'),
    );
    if (await page.locator('html').getAttribute('data-selection-kind') === 'linked') {
      assert.equal(await page.locator('#card-5').getAttribute('data-selected-count'), String(children));
    } else {
      assert.equal(
        await page.locator('#card-5').getAttribute('data-selected-count'),
        await page.locator('html').getAttribute('data-observation-count'),
      );
    }
    await page.mouse.move(10, 10);
    await frame();
    assert.equal(await linkedOverlay.isHidden(), true);
    assert.equal(await page.locator('html').getAttribute('data-selected-start'), point.target);
    const row = sourceRows.find(row => row[0] === start);
    for (const [field, index] of [['open', 3], ['high', 4], ['low', 5], ['close', 6], ['volume', 7], ['oi', 9]]) {
      const visible = Number((await page.locator(`#card-60 [data-value="${field}"]`).innerText()).replaceAll(',', ''));
      assert.equal(visible, Number(row[index]), `${start} ${field}`);
    }
  };

  const selectedBeforeHover = await page.locator('html').getAttribute('data-selected-start');
  const leftBeforeHover = await chartRange(60);
  const rightBeforeHover = await chartRange(5);
  const initialHoverStart = '2026-02-05 09:00:00';
  const initialHoverChildren = childrenForParent(initialHoverStart);
  assert.ok(initialHoverChildren.length > 0);
  await hoverParent(initialHoverStart);
  const initialHoverState = await linkedOverlay.evaluate(element => ({
    hidden: element.hidden,
    visible: element.dataset.visible,
    count: element.dataset.count,
    firstStart: element.dataset.firstStart,
    lastStart: element.dataset.lastStart,
    firstIndex: element.dataset.firstIndex,
    lastIndex: element.dataset.lastIndex,
    left: element.dataset.left,
    width: element.dataset.width,
  }));
  assert.equal(await linkedOverlay.isVisible(), true, JSON.stringify({ initialHoverState, leftBeforeHover, rightBeforeHover }));
  assert.equal(await linkedOverlay.getAttribute('data-count'), String(initialHoverChildren.length));
  assert.equal(await linkedOverlay.getAttribute('data-first-start'), String(toBeijingTimestamp(initialHoverStart)));
  assert.equal(
    await linkedOverlay.getAttribute('data-last-start'),
    String(toBeijingTimestamp(initialHoverChildren.at(-1)[0])),
  );
  assert.ok(Number(await linkedOverlay.getAttribute('data-width')) > 0);
  const overlayRect = await linkedOverlay.boundingBox();
  const containerRect = await page.locator('#card-5 .chart-container').boundingBox();
  const volumeTop = await page.locator('#card-5 .volume-label').evaluate(element => Number.parseFloat(element.style.top));
  assert.ok(overlayRect.height > 0 && overlayRect.height < containerRect.height);
  assert.ok(overlayRect.height <= volumeTop);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedBeforeHover);
  assert.equal(await page.locator('#card-60').getAttribute('data-selected-count'), '1');
  assert.equal(
    await page.locator('#card-5').getAttribute('data-selected-count'),
    await page.locator('html').getAttribute('data-child-count'),
  );
  if (await page.locator('html').getAttribute('data-selection-kind') === 'entry') {
    assert.equal(
      await page.locator('#card-5').getAttribute('data-selected-count'),
      await page.locator('html').getAttribute('data-observation-count'),
    );
  }
  assert.deepEqual(await chartRange(60), leftBeforeHover);
  assert.deepEqual(await chartRange(5), rightBeforeHover);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(output, 'linked-hover-1440.png') });

  const dualOverlayRect = await linkedOverlay.boundingBox();
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  assert.equal(await linkedOverlay.getAttribute('data-count'), String(initialHoverChildren.length));
  const compactOverlayRect = await linkedOverlay.boundingBox();
  assert.notDeepEqual([compactOverlayRect.width, compactOverlayRect.height], [dualOverlayRect.width, dualOverlayRect.height]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(output, 'linked-hover-1100.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame();

  const dualChartWidth = Number(await linkedOverlay.getAttribute('data-chart-width'));
  await page.evaluate(() => document.querySelector('[data-testid="mode-5"]').click());
  await frame();
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  assert.equal(await linkedOverlay.getAttribute('data-count'), String(initialHoverChildren.length));
  assert.ok(Number(await linkedOverlay.getAttribute('data-chart-width')) > dualChartWidth);
  assert.ok((await linkedOverlay.boundingBox()).width > 0);
  await page.evaluate(() => document.querySelector('[data-testid="mode-dual"]').click());
  await frame();
  const subchartHeight = (await linkedOverlay.boundingBox()).height;
  await page.evaluate(() => document.querySelector('[data-testid="toggle-subcharts"]').click());
  await frame();
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  assert.ok((await linkedOverlay.boundingBox()).height > subchartHeight);
  await page.evaluate(() => document.querySelector('[data-testid="toggle-subcharts"]').click());
  await frame();

  await page.mouse.move(10, 10);
  await frame();
  assert.equal(await linkedOverlay.isHidden(), true);
  assert.equal(await linkedOverlay.getAttribute('data-first-start'), null);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedBeforeHover);

  const zoomLeftTo = async (start, targetSpan) => {
    let point = await hoverParent(start);
    let span = (await chartRange(60)).span;
    let delta = -320;
    for (let attempt = 0; attempt < 20 && span > targetSpan; attempt++) {
      const before = span;
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, delta);
      await frame();
      span = (await chartRange(60)).span;
      if (attempt === 0 && span >= before) delta = -delta;
      point = await hoverParent(start);
    }
    return { point, span };
  };

  await jump('2026-02-05');
  const zoomStart = '2026-02-05 10:00:00';
  const linkedMinimumSpan = childrenForParent(zoomStart).length + 4;
  const zoomed = await zoomLeftTo(zoomStart, 34);
  assert.ok(zoomed.span >= 16 && zoomed.span <= 45, `Expected roughly 30 visible 60m bars, got ${zoomed.span}`);
  await page.mouse.click(zoomed.point.x, zoomed.point.y);
  await frame();
  const linkedSpan = (await chartRange(5)).span;
  assert.ok(
    Math.abs(linkedSpan - Math.max(zoomed.span, linkedMinimumSpan)) < .05,
    `Expected linked span ${Math.max(zoomed.span, linkedMinimumSpan)}, got ${linkedSpan}`,
  );
  const linkedRange = await chartRange(5);
  const firstIndex = Number(await linkedOverlay.getAttribute('data-first-index'));
  const lastIndex = Number(await linkedOverlay.getAttribute('data-last-index'));
  assert.ok(
    linkedRange.from <= firstIndex - .5 && linkedRange.to >= lastIndex + .5,
    JSON.stringify({ linkedRange, firstIndex, lastIndex }),
  );
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  assert.equal(
    await page.locator('#card-5').getAttribute('data-selected-count'),
    await page.locator('html').getAttribute('data-child-count'),
  );
  if (await page.locator('html').getAttribute('data-selection-kind') === 'entry') {
    assert.equal(
      await page.locator('#card-5').getAttribute('data-selected-count'),
      await page.locator('html').getAttribute('data-observation-count'),
    );
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(output, 'linked-click-zoom-1440.png') });

  const rangeBeforeHoverScan = await chartRange(5);
  const leftBox = await page.locator('#canvas-60').boundingBox();
  let foundClipped = false;
  let foundOffscreen = false;
  for (let x = 2; x < leftBox.width - 65 && (!foundClipped || !foundOffscreen); x += 4) {
    await page.mouse.move(leftBox.x + x, leftBox.y + 35);
    await frame();
    if (!await linkedOverlay.getAttribute('data-count')) continue;
    foundClipped ||= await linkedOverlay.getAttribute('data-clipped') === 'true';
    foundOffscreen ||= await linkedOverlay.getAttribute('data-visible') === 'false';
  }
  assert.equal(foundClipped, true, 'A partially visible child range must be clipped to the price pane');
  assert.equal(foundOffscreen, true, 'A fully offscreen child range must hide the overlay');
  assert.deepEqual(await chartRange(5), rangeBeforeHoverScan);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), zoomed.point.target);

  const tightlyZoomed = await zoomLeftTo(zoomStart, 9);
  assert.ok(tightlyZoomed.span < 12);
  await page.mouse.click(tightlyZoomed.point.x, tightlyZoomed.point.y);
  await frame();
  assert.ok(
    Math.abs((await chartRange(5)).span - Math.max(tightlyZoomed.span, linkedMinimumSpan)) < .05,
  );
  const tightRange = await chartRange(5);
  assert.ok(tightRange.from <= Number(await linkedOverlay.getAttribute('data-first-index')) - .5);
  assert.ok(tightRange.to >= Number(await linkedOverlay.getAttribute('data-last-index')) + .5);

  const fiveCanvas = page.locator('#canvas-5');
  let fiveBox = await fiveCanvas.boundingBox();
  const priceAxisX = fiveBox.x + fiveBox.width - 18;
  const priceAxisY = fiveBox.y + Math.max(55, fiveBox.height * .28);
  await page.mouse.move(priceAxisX, priceAxisY);
  await page.mouse.down();
  await page.mouse.move(priceAxisX, priceAxisY + 44, { steps: 12 });
  await page.mouse.up();
  await frame();
  assert.equal(await page.locator('#card-5').getAttribute('data-price-auto-scale'), 'false');

  await jump('2026-10-09');
  const targetStart = '2026-10-09 10:00:00';
  const targetChildren = childrenForParent(targetStart);
  const targetLow = Math.min(...targetChildren.map(row => Number(row[5])));
  const targetHigh = Math.max(...targetChildren.map(row => Number(row[4])));
  const manualPriceRange = {
    from: Number(await page.locator('#card-5').getAttribute('data-price-range-from')),
    to: Number(await page.locator('#card-5').getAttribute('data-price-range-to')),
  };
  assert.ok(
    manualPriceRange.to < targetLow || manualPriceRange.from > targetHigh,
    JSON.stringify({ manualPriceRange, targetLow, targetHigh }),
  );
  const correctedPoint = await hoverParent(targetStart);
  await page.mouse.click(correctedPoint.x, correctedPoint.y);
  await frame();
  await page.waitForFunction(() =>
    document.querySelector('#card-5')?.getAttribute('data-price-auto-scale') === 'true',
  );
  const correctedPriceRange = {
    from: Number(await page.locator('#card-5').getAttribute('data-price-range-from')),
    to: Number(await page.locator('#card-5').getAttribute('data-price-range-to')),
  };
  assert.equal(await page.locator('#card-5').getAttribute('data-price-auto-scale'), 'true');
  assert.ok(correctedPriceRange.from <= targetLow, JSON.stringify({ correctedPriceRange, targetLow, targetHigh }));
  assert.ok(correctedPriceRange.to >= targetHigh, JSON.stringify({ correctedPriceRange, targetLow, targetHigh }));
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  await page.mouse.move(10, 10);
  await frame();
  await page.screenshot({ path: resolve(output, 'linked-price-correction-1440.png') });
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  const compactCorrectedPriceRange = {
    from: Number(await page.locator('#card-5').getAttribute('data-price-range-from')),
    to: Number(await page.locator('#card-5').getAttribute('data-price-range-to')),
  };
  assert.ok(compactCorrectedPriceRange.from <= targetLow, JSON.stringify({ compactCorrectedPriceRange, targetLow, targetHigh }));
  assert.ok(compactCorrectedPriceRange.to >= targetHigh, JSON.stringify({ compactCorrectedPriceRange, targetLow, targetHigh }));
  await page.screenshot({ path: resolve(output, 'linked-price-correction-1100.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame();

  await page.mouse.move(10, 10);
  await jump('2020-01-01');
  const firstStart = sourceRows[0][0];
  const firstPoint = await hoverParent(firstStart);
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await frame();
  assert.ok(Math.abs((await chartRange(5)).from) < .05);
  await page.mouse.move(10, 10);
  await jump('2030-01-01');
  const lastStart = sourceRows.at(-1)[0];
  const lastPoint = await hoverParent(lastStart);
  await page.mouse.click(lastPoint.x, lastPoint.y);
  await frame();
  assert.ok(Math.abs((await chartRange(5)).to - sourceRows5.length) < .05);

  await jump('2026-02-05');
  const linkedSamples = [];
  for (const [start] of sourceRows.filter(row => row[0].startsWith('2026-02-05 ') && row[0] !== initialHoverStart)) {
    const children = childrenForParent(start).length;
    if (!linkedSamples.some(sample => sample.children === children)) linkedSamples.push({ start, children });
  }
  assert.ok(linkedSamples.length >= 3, `Expected varied linked intervals, got ${JSON.stringify(linkedSamples)}`);
  for (const { start, children } of linkedSamples.slice(0, 3)) {
    await clickParent(start, children);
  }
  const selectedBeforeLeave = await page.locator('html').getAttribute('data-selected-start');
  await hoverParent('2026-02-05 09:00:00');
  await page.mouse.move(5, 5);
  await frame();
  assert.equal(await linkedOverlay.isHidden(), true);
  assert.equal(await linkedOverlay.getAttribute('data-first-start'), null);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedBeforeLeave);
  await page.getByTestId('latest').click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  const box = await page.locator('#canvas-5').boundingBox();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .3);
  await page.mouse.click(box.x + box.width * .6, box.y + box.height * .3);
  assert.ok(await page.locator('html').getAttribute('data-selected-start'));
  await page.mouse.wheel(0, -300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .3, { steps: 30 });
  await page.mouse.up();
  await page.screenshot({ path: resolve(output, 'crosshair-1100.png') });
  await page.evaluate(() => window.moneyComingTest?.showEmptyProfitLossReview());
  assert.equal(await page.getByTestId('review-empty').isVisible(), true);
  await page.getByTestId('review-done').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), false);
  assert.deepEqual(errors, []);
  const offscreen = {
    beforeShow: offscreenBeforeShow,
    afterShow: offscreenAfterShow,
    negativeCoordinateSimulation: negativeCoordinateGeometryFixture(),
  };
  await writeFile(resolve(output, 'smoke.json'), JSON.stringify({
    packaged: !!executablePath,
    startupMs,
    errors,
    offscreen,
    passed: true,
  }, null, 2));
  await writeFile(resolve(output, 'offscreen-window.json'), JSON.stringify({
    packaged: !!executablePath,
    ...offscreen,
    passed: true,
  }, null, 2));
  console.log(JSON.stringify({ packaged: !!executablePath, startupMs, passed: true }));
} finally {
  await app.close();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
}
}
