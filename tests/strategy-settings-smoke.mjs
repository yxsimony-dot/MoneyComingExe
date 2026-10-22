import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectronTest } from './electron-test-launch.mjs';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts');
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-strategy-settings-'));
const userData = process.env.MONEYCOMING_TEST_USER_DATA
  ? resolve(process.env.MONEYCOMING_TEST_USER_DATA)
  : join(sandbox, 'user-data');
const executablePath = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const expectedRulesFallback = process.env.MONEYCOMING_EXPECT_ENTRY_RULES_FALLBACK === '1';
const storageKey = 'moneycoming.entry-strategy-settings.v1';
await mkdir(output, { recursive: true });

async function launch(label) {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: userData,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectronTest({
    ...(executablePath
      ? { executablePath, args: [], cwd: process.env.TEMP }
      : { args: [root], cwd: root }),
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  const beforeShow = await assertElectronWindowOffscreen(app, `${label}-before-show`);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const afterShow = await assertElectronWindowOffscreen(app, `${label}-after-show`);
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  return { app, page, offscreen: { beforeShow, afterShow } };
}

async function frame(page, count = 3) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
  }
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  await frame(page);
}

async function storedSettings(page) {
  const raw = await page.evaluate(key => localStorage.getItem(key), storageKey);
  return raw === null ? null : JSON.parse(raw);
}

async function reviewDateRange(page) {
  return {
    startDate: await page.getByTestId('review-start-date').inputValue(),
    endDate: await page.getByTestId('review-end-date').inputValue(),
  };
}

function withReviewRange(settings, range) {
  return {
    ...settings,
    reviewStartDate: range.startDate,
    reviewEndDate: range.endDate,
  };
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

async function setStoredValueAndReload(page, raw) {
  await page.evaluate(
    ({ key, value }) => value === null
      ? localStorage.removeItem(key)
      : localStorage.setItem(key, value),
    { key: storageKey, value: raw },
  );
  await reload(page);
}

async function setTicks(page, ticks) {
  const input = page.getByTestId('reaction-ticks-input');
  const modalOpen = await page.locator('#review-dialog, #reaction-rules-dialog')
    .evaluateAll(elements => elements.some(element => element.open));
  if (modalOpen) {
    await input.evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, ticks);
  } else {
    await input.fill(String(ticks));
  }
  await frame(page);
  assert.equal(await page.locator('html').getAttribute('data-reaction-body-ticks'), String(ticks));
}

async function setPercent(page, percent) {
  const input = page.getByTestId('entry-percent-input');
  const modalOpen = await page.locator('#review-dialog, #reaction-rules-dialog')
    .evaluateAll(elements => elements.some(element => element.open));
  if (modalOpen) {
    await input.evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, percent);
  } else {
    await input.fill(String(percent));
  }
  await frame(page);
  assert.equal(await page.locator('html').getAttribute('data-entry-range-percent'), String(percent));
}

async function setOppositeCount(page, count) {
  const input = page.getByTestId('opposite-count-input');
  const modalOpen = await page.locator('#review-dialog, #reaction-rules-dialog')
    .evaluateAll(elements => elements.some(element => element.open));
  if (modalOpen) {
    await input.evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, count);
  } else {
    await input.fill(String(count));
  }
  await frame(page);
  assert.equal(await page.locator('html').getAttribute('data-opposite-candle-count'), String(count));
}

async function setSessionExitMinutes(page, minutes) {
  await page.getByTestId('session-exit-minutes').selectOption(String(minutes));
  await frame(page);
  assert.equal(
    await page.locator('html').getAttribute('data-session-exit-minutes'),
    String(minutes),
  );
}

async function dispatchInvalidInput(page, testid, value) {
  const input = page.getByTestId(testid);
  await input.focus();
  if (value === 'text') {
    await input.evaluate(element => {
      element.type = 'text';
      element.value = 'abc';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.type = 'number';
    });
  } else {
    await input.fill(value);
  }
  await frame(page);
}

async function pressInvalidEnter(page, testid, value) {
  const input = page.getByTestId(testid);
  await input.fill(value);
  await input.press('Enter');
  await frame(page);
}

async function chartRange(page, period) {
  const result = await page.locator(`#card-${period}`).evaluate(element => ({
    from: Number(element.dataset.visibleFrom),
    to: Number(element.dataset.visibleTo),
    span: Number(element.dataset.visibleSpan),
  }));
  assert.ok(Object.values(result).every(Number.isFinite), JSON.stringify({ period, result }));
  return result;
}

function assertRangeEqual(actual, expected, label) {
  for (const key of ['from', 'to', 'span']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 0.01,
      `${label} ${key}: ${JSON.stringify({ actual, expected })}`,
    );
  }
}

async function strategySnapshot(page) {
  return page.locator('#card-5').evaluate(element => Object.fromEntries(
    Object.entries(element.dataset)
      .filter(([key]) => /^(selection|lifecycle|attempt|reactionRange|quarterSignal|stopLossSignal|takeProfitSignal|riskTouchSignal|exitSignal|pullbackLine|trueEntryMarker|riskTouchMarker|exitMarker|secondTriggerMarker)/.test(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

async function panelSummary(page) {
  const panel = page.getByTestId('entry-settings-panel');
  return {
    finalCapital: await page.getByTestId('settings-final-capital').innerText(),
    returnRate: await page.getByTestId('settings-return-rate').innerText(),
    completedTrades: await page.getByTestId('settings-completed-trades').innerText(),
    raw: {
      finalCapital: await panel.getAttribute('data-final-capital'),
      returnRate: await panel.getAttribute('data-return-rate'),
      completedTrades: await panel.getAttribute('data-completed-trades'),
    },
  };
}

async function assertReviewMatchesPanel(page, summary) {
  assert.equal(await page.getByTestId('review-final-capital-metric').innerText(), summary.finalCapital);
  assert.equal(await page.getByTestId('review-return-rate').innerText(), summary.returnRate);
  assert.equal(
    await page.getByTestId('review-completed-trades').innerText(),
    summary.completedTrades.replace(/\s*笔$/, ''),
  );
}

const report = {
  packaged: Boolean(executablePath),
  offscreen: [],
  persistedTicks: undefined,
  persistedPercent: undefined,
  persistedOppositeCount: undefined,
  persistedSessionExitMinutes: undefined,
  persistedReviewRange: undefined,
  comparisonEventStart: undefined,
  percentageComparisonEventStart: undefined,
  oppositeComparisonEventStart: undefined,
  sessionExitComparisonEventStart: undefined,
  entryRulesFallback: undefined,
  passed: false,
};
let running;

try {
  running = await launch('strategy-settings-initial');
  report.offscreen.push(running.offscreen);
  let { app, page } = running;
  const html = page.locator('html');
  const panel = page.getByTestId('entry-settings-panel');
  const input = page.getByTestId('reaction-ticks-input');
  const decrease = page.getByTestId('reaction-ticks-decrease');
  const increase = page.getByTestId('reaction-ticks-increase');
  const percentInput = page.getByTestId('entry-percent-input');
  const percentDecrease = page.getByTestId('entry-percent-decrease');
  const percentIncrease = page.getByTestId('entry-percent-increase');
  const oppositeInput = page.getByTestId('opposite-count-input');
  const oppositeDecrease = page.getByTestId('opposite-count-decrease');
  const oppositeIncrease = page.getByTestId('opposite-count-increase');
  const sessionExitSelect = page.getByTestId('session-exit-minutes');
  const reviewStartInput = page.getByTestId('review-start-date');
  const reviewEndInput = page.getByTestId('review-end-date');
  const initialReviewRange = await reviewDateRange(page);
  let expectedReviewRange = initialReviewRange;
  assert.equal(await page.getByTestId('reaction-ticks-label').innerText(), '最小入场K线浮动');
  assert.equal(await input.getAttribute('aria-label'), '最小入场K线浮动');
  assert.equal(await page.getByTestId('opposite-count-label').innerText(), '连续反向K线数量');
  assert.equal(await oppositeInput.getAttribute('aria-label'), '连续反向K线数量');
  assert.equal(await reviewStartInput.getAttribute('type'), 'date');
  assert.equal(await reviewEndInput.getAttribute('type'), 'date');
  assert.match(initialReviewRange.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(initialReviewRange.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(initialReviewRange.startDate <= initialReviewRange.endDate);
  const reactionRulesInfo = page.getByTestId('reaction-rules-info');
  const reactionRulesDialog = page.getByTestId('reaction-rules-dialog');
  assert.equal(await reactionRulesInfo.getAttribute('title'), '查看5分钟K线识别规则');
  assert.equal(await reactionRulesInfo.getAttribute('aria-label'), '查看5分钟K线识别规则');

  assert.equal(await panel.isHidden(), true);
  assert.equal(await reactionRulesInfo.isHidden(), true);
  assert.equal(await html.getAttribute('data-reaction-body-ticks'), '1');
  assert.equal(await html.getAttribute('data-entry-range-percent'), '25');
  assert.equal(await html.getAttribute('data-opposite-candle-count'), '6');
  assert.equal(await html.getAttribute('data-session-exit-minutes'), '15');
  assert.equal(await input.inputValue(), '1');
  assert.equal(await percentInput.inputValue(), '25');
  assert.equal(await oppositeInput.inputValue(), '6');
  assert.equal(await sessionExitSelect.inputValue(), '15');
  assert.deepEqual(
    await sessionExitSelect.locator('option').evaluateAll(options =>
      options.map(option => ({ value: option.value, label: option.textContent }))),
    [
      { value: '0', label: '0 分钟（关闭）' },
      { value: '5', label: '5 分钟' },
      { value: '10', label: '10 分钟' },
      { value: '15', label: '15 分钟' },
      { value: '20', label: '20 分钟' },
      { value: '25', label: '25 分钟' },
      { value: '30', label: '30 分钟' },
    ],
  );
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 1,
    entryRangePercent: 25,
    oppositeCandleCount: 6,
    sessionExitMinutes: 15,
  }, expectedReviewRange));

  for (const [raw, expected] of [
    [null, { reactionBodyTicks: 1, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    ['{broken-json', { reactionBodyTicks: 1, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 0 }),
      { reactionBodyTicks: 1, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 21 }),
      { reactionBodyTicks: 1, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7 }),
      { reactionBodyTicks: 7, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 12.5 }),
      { reactionBodyTicks: 7, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 101 }),
      { reactionBodyTicks: 7, entryRangePercent: 25, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 0, entryRangePercent: 80 }),
      { reactionBodyTicks: 1, entryRangePercent: 80, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: -1 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 11 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 1.5 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 6, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 0 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 0, sessionExitMinutes: 15 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 10 }),
      { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 10, sessionExitMinutes: 15 }],
    [JSON.stringify({
      reactionBodyTicks: 7,
      entryRangePercent: 37,
      oppositeCandleCount: 4,
      sessionExitMinutes: 12,
    }), { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 4, sessionExitMinutes: 15 }],
    [JSON.stringify({
      reactionBodyTicks: 7,
      entryRangePercent: 37,
      oppositeCandleCount: 4,
      sessionExitMinutes: 20,
    }), { reactionBodyTicks: 7, entryRangePercent: 37, oppositeCandleCount: 4, sessionExitMinutes: 20 }],
  ]) {
    await setStoredValueAndReload(page, raw);
    assert.equal(
      await page.locator('html').getAttribute('data-reaction-body-ticks'),
      String(expected.reactionBodyTicks),
    );
    assert.equal(
      await page.locator('html').getAttribute('data-entry-range-percent'),
      String(expected.entryRangePercent),
    );
    assert.equal(
      await page.locator('html').getAttribute('data-opposite-candle-count'),
      String(expected.oppositeCandleCount),
    );
    assert.equal(
      await page.locator('html').getAttribute('data-session-exit-minutes'),
      String(expected.sessionExitMinutes),
    );
    assert.deepEqual(await storedSettings(page), withReviewRange(expected, initialReviewRange));
  }

  await setStoredValueAndReload(page, JSON.stringify({
    reactionBodyTicks: 1,
    entryRangePercent: 25,
    oppositeCandleCount: 6,
    sessionExitMinutes: 15,
  }));
  await page.getByTestId('toggle-monday').click();
  await setTicks(page, 7);
  await setPercent(page, 37);
  await setOppositeCount(page, 4);
  for (const minutes of [0, 5, 10, 15, 20, 25, 30]) {
    await setSessionExitMinutes(page, minutes);
  }
  await setSessionExitMinutes(page, 20);
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 7,
    entryRangePercent: 37,
    oppositeCandleCount: 4,
    sessionExitMinutes: 20,
  }, expectedReviewRange));
  await reload(page);
  assert.equal(await page.locator('html').getAttribute('data-reaction-body-ticks'), '7');
  assert.equal(await page.locator('html').getAttribute('data-entry-range-percent'), '37');
  assert.equal(await page.locator('html').getAttribute('data-opposite-candle-count'), '4');
  assert.equal(await page.locator('html').getAttribute('data-session-exit-minutes'), '20');
  assert.equal(await page.getByTestId('reaction-ticks-input').inputValue(), '7');
  assert.equal(await page.getByTestId('entry-percent-input').inputValue(), '37');
  assert.equal(await page.getByTestId('opposite-count-input').inputValue(), '4');
  assert.equal(await page.getByTestId('session-exit-minutes').inputValue(), '20');
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 7,
    entryRangePercent: 37,
    oppositeCandleCount: 4,
    sessionExitMinutes: 20,
  }, expectedReviewRange));

  if (await page.getByTestId('entry-settings-panel').isHidden()) {
    await page.getByTestId('toggle-monday').click();
    await frame(page);
  }
  assert.equal(await page.getByTestId('review-start-date').isVisible(), true);
  assert.equal(await page.getByTestId('review-end-date').isVisible(), true);
  const fullRangeDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.deepEqual(
    {
      startDate: fullRangeDiagnostics.reviewStartDate,
      endDate: fullRangeDiagnostics.reviewEndDate,
    },
    initialReviewRange,
  );
  const reviewDates = [...new Set(
    fullRangeDiagnostics.attempts
      .filter(attempt => attempt.exitStartMs !== undefined)
      .map(attempt => attempt.entryDate),
  )];
  assert.ok(reviewDates.length >= 2, 'Expected at least two completed-entry dates for range refresh coverage.');
  const [firstReviewDate, secondReviewDate] = reviewDates;

  await page.getByTestId('reaction-rules-info').click();
  assert.equal(await page.getByTestId('reaction-rules-dialog').evaluate(element => element.open), true);
  const refreshBeforeFirstRange = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setReviewDateRange(page, firstReviewDate, firstReviewDate);
  expectedReviewRange = { startDate: firstReviewDate, endDate: firstReviewDate };
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforeFirstRange,
  );
  assert.equal(await page.getByTestId('reaction-rules-dialog').evaluate(element => element.open), true);
  assert.equal(await page.getByTestId('reaction-rules-current-ticks').innerText(), '7 tick');
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 7,
    entryRangePercent: 37,
    oppositeCandleCount: 4,
    sessionExitMinutes: 20,
  }, expectedReviewRange));
  assert.equal(
    await page.getByTestId('settings-review-range').innerText(),
    `复盘日期：${firstReviewDate} 至 ${firstReviewDate}`,
  );
  const firstRangeDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.ok(firstRangeDiagnostics.visibleCandidateCount < fullRangeDiagnostics.visibleCandidateCount);
  assert.ok(firstRangeDiagnostics.attempts.length > 0);
  assert.ok(firstRangeDiagnostics.attempts.every(attempt => attempt.entryDate === firstReviewDate));
  await page.getByTestId('reaction-rules-done').click();

  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  assert.equal(
    await page.getByTestId('review-date-range').innerText(),
    `复盘日期：${firstReviewDate} 至 ${firstReviewDate}`,
  );
  await assertReviewMatchesPanel(page, await panelSummary(page));
  const refreshBeforeSecondRange = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setReviewDateRange(page, secondReviewDate, secondReviewDate);
  expectedReviewRange = { startDate: secondReviewDate, endDate: secondReviewDate };
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforeSecondRange,
  );
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  assert.equal(
    await page.getByTestId('review-date-range').innerText(),
    `复盘日期：${secondReviewDate} 至 ${secondReviewDate}`,
  );
  assert.equal(
    await page.getByTestId('settings-review-range').innerText(),
    `复盘日期：${secondReviewDate} 至 ${secondReviewDate}`,
  );
  const secondRangeDiagnostics = await page.evaluate(() =>
    window.moneyComingTest.strategyDateRangeDiagnostics());
  assert.ok(secondRangeDiagnostics.attempts.length > 0);
  assert.ok(secondRangeDiagnostics.attempts.every(attempt => attempt.entryDate === secondReviewDate));
  const secondRangeSummary = await panelSummary(page);
  await assertReviewMatchesPanel(page, secondRangeSummary);

  const refreshBeforeInvalidRange = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  const storedBeforeInvalidRange = await storedSettings(page);
  const reviewBeforeInvalidRange = await page.locator('#review-content').innerText();
  await setReviewDateRange(page, initialReviewRange.endDate, initialReviewRange.startDate);
  assert.equal(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
    refreshBeforeInvalidRange,
  );
  assert.deepEqual(await storedSettings(page), storedBeforeInvalidRange);
  assert.deepEqual(await reviewDateRange(page), expectedReviewRange);
  assert.equal(await page.getByTestId('review-date-error').innerText(), '开始日期不能晚于结束日期');
  assert.equal(await page.getByTestId('review-date-error').isVisible(), true);
  assert.equal(await page.getByTestId('review-start-date').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.getByTestId('review-end-date').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#review-content').innerText(), reviewBeforeInvalidRange);
  assert.deepEqual(await panelSummary(page), secondRangeSummary);
  await page.getByTestId('review-done').click();
  report.persistedReviewRange = expectedReviewRange;

  await app.close();
  running = await launch('strategy-settings-restart');
  report.offscreen.push(running.offscreen);
  ({ app, page } = running);
  report.persistedTicks = Number(await page.locator('html').getAttribute('data-reaction-body-ticks'));
  report.persistedPercent = Number(await page.locator('html').getAttribute('data-entry-range-percent'));
  report.persistedOppositeCount = Number(
    await page.locator('html').getAttribute('data-opposite-candle-count'),
  );
  report.persistedSessionExitMinutes = Number(
    await page.locator('html').getAttribute('data-session-exit-minutes'),
  );
  report.persistedReviewRange = await reviewDateRange(page);
  assert.equal(report.persistedTicks, 7);
  assert.equal(report.persistedPercent, 37);
  assert.equal(report.persistedOppositeCount, 4);
  assert.equal(report.persistedSessionExitMinutes, 20);
  assert.deepEqual(report.persistedReviewRange, expectedReviewRange);
  assert.equal(
    await page.locator('html').getAttribute('data-review-start-date'),
    expectedReviewRange.startDate,
  );
  assert.equal(
    await page.locator('html').getAttribute('data-review-end-date'),
    expectedReviewRange.endDate,
  );
  assert.equal(await page.getByTestId('entry-settings-panel').isHidden(), true);
  assert.equal(await page.getByTestId('reaction-ticks-input').inputValue(), '7');
  assert.equal(await page.getByTestId('entry-percent-input').inputValue(), '37');
  assert.equal(await page.getByTestId('opposite-count-input').inputValue(), '4');
  assert.equal(await page.getByTestId('session-exit-minutes').inputValue(), '20');
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 7,
    entryRangePercent: 37,
    oppositeCandleCount: 4,
    sessionExitMinutes: 20,
  }, expectedReviewRange));

  const restartedPanel = page.getByTestId('entry-settings-panel');
  const restartedInput = page.getByTestId('reaction-ticks-input');
  const restartedDecrease = page.getByTestId('reaction-ticks-decrease');
  const restartedIncrease = page.getByTestId('reaction-ticks-increase');
  const restartedPercentInput = page.getByTestId('entry-percent-input');
  const restartedPercentDecrease = page.getByTestId('entry-percent-decrease');
  const restartedPercentIncrease = page.getByTestId('entry-percent-increase');
  const restartedOppositeInput = page.getByTestId('opposite-count-input');
  const restartedOppositeDecrease = page.getByTestId('opposite-count-decrease');
  const restartedOppositeIncrease = page.getByTestId('opposite-count-increase');
  const restartedSessionExitSelect = page.getByTestId('session-exit-minutes');
  const restartedReactionRulesInfo = page.getByTestId('reaction-rules-info');
  const restartedReactionRulesDialog = page.getByTestId('reaction-rules-dialog');
  const mondayToggle = page.getByTestId('toggle-monday');
  await mondayToggle.click();
  assert.equal(await restartedPanel.isVisible(), true);
  assert.equal(await restartedReactionRulesInfo.isVisible(), true);
  assert.deepEqual(await reviewDateRange(page), expectedReviewRange);
  assert.equal(await restartedInput.inputValue(), '7');
  assert.equal(await restartedPercentInput.inputValue(), '37');
  assert.equal(await restartedOppositeInput.inputValue(), '4');
  assert.equal(await restartedSessionExitSelect.inputValue(), '20');
  await setReviewDateRange(page, initialReviewRange.startDate, initialReviewRange.endDate);
  expectedReviewRange = initialReviewRange;
  assert.deepEqual(await reviewDateRange(page), initialReviewRange);
  const reactionRulesButtonBox = await restartedReactionRulesInfo.boundingBox();
  assert.ok(reactionRulesButtonBox);
  assert.ok(reactionRulesButtonBox.width <= 24, JSON.stringify(reactionRulesButtonBox));
  assert.ok(reactionRulesButtonBox.height <= 24, JSON.stringify(reactionRulesButtonBox));
  await restartedReactionRulesInfo.click();
  assert.equal(await restartedReactionRulesDialog.evaluate(element => element.open), true);
  assert.equal(await page.getByTestId('reaction-rules-current-ticks').innerText(), '7 tick');
  assert.equal(
    await page.getByTestId('reaction-rules-current-opposite-count').innerText(),
    '4 根',
  );
  const initialReactionRulesText = await page.getByTestId('reaction-rules-content').innerText();
  for (const expected of [
    '做多',
    '收盘价 - 开盘价',
    '上影线 = 最高价 - 收盘价',
    '做空',
    '开盘价 - 收盘价',
    '下影线 = 收盘价 - 最低价',
    '方向侧影线 < 实体 × 2',
    '实体 × 2 ≤ 方向侧影线 < 实体 × 3',
    '方向侧影线 ≥ 实体 × 3',
    '这与连续反向动能导致的整次形态放弃不同',
    '做多候选向前统计阴线',
    '做空候选向前统计阳线',
    '数量达到或超过当前参数时立即终止当前形态',
    '0表示关闭',
    '允许越过本轮回调触发K线读取更早历史',
    '十字星不计数也不中断',
    '遇到与候选同方向的K线立即中断',
    '反向动能放弃',
    '不生成白色入场线或其他计划线',
    '不消耗正式机会',
    '做多使用放弃红框下沿',
    '做空使用上沿',
    '刚好相等也触发',
    '重启K线自身参与新搜索',
    '保留全部历史红框',
    '只有最新放弃红框的风险侧边界有效',
    '仅用于回看的触发前历史不进入红框',
    '首轮和第二轮共用当前参数',
  ]) assert.match(initialReactionRulesText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const refreshBeforeOpenRulesChange = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setOppositeCount(page, 5);
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforeOpenRulesChange,
  );
  assert.equal(
    await page.getByTestId('reaction-rules-current-opposite-count').innerText(),
    '5 根',
  );
  assert.match(
    await page.getByTestId('reaction-rules-content').innerText(),
    /当前达到或超过 5 根时立即放弃本次形态/,
  );
  await setOppositeCount(page, 4);
  for (const forbidden of ['60分钟', '止盈', '止损', '休市']) {
    assert.doesNotMatch(initialReactionRulesText, new RegExp(forbidden));
  }
  await page.getByTestId('close-reaction-rules').click();
  assert.equal(await restartedReactionRulesDialog.evaluate(element => element.open), false);

  await page.getByTestId('entry-rules').click();
  await page.locator('#rules-dialog[open]').waitFor();
  const entryRulesText = await page.locator('#rules-content').innerText();
  for (const expected of [
    '实体达标后只计算方向侧上影线 `high - close`',
    '实体达标后只计算方向侧下影线 `close - low`',
    '正好2倍属于风险侧入场',
    '正好3倍也必须跳过',
    '第二轮根据自己的最终方向反应K线独立决定使用当前百分比或风险侧边界',
    '不继承首轮的影线分类',
    '连续反向K线数量',
    '十字星不计数且不中断',
    '立即终止当前形态',
    '放弃红框',
    '不消耗首轮或第二轮正式交易机会',
    '只有最新放弃红框的风险侧边界有效',
    '首轮和第二轮',
  ]) assert.ok(entryRulesText.includes(expected), `完整入场规则缺少：${expected}`);
  const entryRulesMeta = await page.locator('#rules-meta').innerText();
  report.entryRulesFallback = entryRulesMeta.includes('正在显示内置确认版');
  if (expectedRulesFallback) {
    assert.equal(report.entryRulesFallback, true, entryRulesMeta);
  }
  await page.locator('#rules-done').click();
  assert.equal(await page.locator('#rules-dialog').evaluate(element => element.open), false);

  await mondayToggle.click();
  assert.equal(await restartedPanel.isHidden(), true);
  assert.equal(await restartedReactionRulesInfo.isHidden(), true);
  assert.equal(await restartedInput.inputValue(), '7');
  assert.equal(await restartedPercentInput.inputValue(), '37');
  assert.equal(await restartedOppositeInput.inputValue(), '4');
  assert.equal(await restartedSessionExitSelect.inputValue(), '20');
  await mondayToggle.click();
  assert.equal(await restartedPanel.isVisible(), true);
  assert.equal(await restartedInput.inputValue(), '7');
  assert.equal(await restartedPercentInput.inputValue(), '37');
  assert.equal(await restartedOppositeInput.inputValue(), '4');
  assert.equal(await restartedSessionExitSelect.inputValue(), '20');

  await setTicks(page, 1);
  await restartedReactionRulesInfo.click();
  assert.equal(await page.getByTestId('reaction-rules-current-ticks').innerText(), '1 tick');
  await page.getByTestId('reaction-rules-done').click();
  assert.equal(await restartedReactionRulesDialog.evaluate(element => element.open), false);
  await setTicks(page, 2);
  await restartedReactionRulesInfo.click();
  assert.equal(await page.getByTestId('reaction-rules-current-ticks').innerText(), '2 tick');
  await page.mouse.click(5, 5);
  assert.equal(await restartedReactionRulesDialog.evaluate(element => element.open), false);
  await setTicks(page, 1);
  assert.equal(await restartedDecrease.isDisabled(), true);
  assert.equal(await restartedIncrease.isDisabled(), false);
  const refreshBeforeInvalid = Number(await page.locator('html').getAttribute('data-strategy-refresh-count'));
  for (const invalid of ['', 'text', '1.5', '0', '21']) {
    await dispatchInvalidInput(page, 'reaction-ticks-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalid,
      `Invalid value ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.deepEqual(await storedSettings(page), withReviewRange({
      reactionBodyTicks: 1,
      entryRangePercent: 37,
      oppositeCandleCount: 4,
      sessionExitMinutes: 20,
    }, expectedReviewRange));
    await restartedInput.blur();
    await frame(page);
    assert.equal(await restartedInput.inputValue(), '1');
  }
  for (const invalid of ['', '1.5', '0', '21']) {
    await pressInvalidEnter(page, 'reaction-ticks-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalid,
      `Invalid Enter value ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.equal(await restartedInput.inputValue(), '1');
  }

  await restartedIncrease.click();
  await frame(page);
  assert.equal(await restartedInput.inputValue(), '2');
  await restartedDecrease.click();
  await frame(page);
  assert.equal(await restartedInput.inputValue(), '1');
  assert.equal(await restartedDecrease.isDisabled(), true);
  await setTicks(page, 20);
  assert.equal(await restartedIncrease.isDisabled(), true);
  assert.equal(await restartedDecrease.isDisabled(), false);
  await setTicks(page, 1);

  await setPercent(page, 0);
  assert.equal(await restartedPercentDecrease.isDisabled(), true);
  assert.equal(await restartedPercentIncrease.isDisabled(), false);
  const refreshBeforeInvalidPercent = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  for (const invalid of ['', 'text', '1.5', '-1', '101']) {
    await dispatchInvalidInput(page, 'entry-percent-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalidPercent,
      `Invalid percentage ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.deepEqual(await storedSettings(page), withReviewRange({
      reactionBodyTicks: 1,
      entryRangePercent: 0,
      oppositeCandleCount: 4,
      sessionExitMinutes: 20,
    }, expectedReviewRange));
    await restartedPercentInput.blur();
    await frame(page);
    assert.equal(await restartedPercentInput.inputValue(), '0');
  }
  for (const invalid of ['', '1.5', '-1', '101']) {
    await pressInvalidEnter(page, 'entry-percent-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalidPercent,
      `Invalid percentage Enter value ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.equal(await restartedPercentInput.inputValue(), '0');
  }

  await restartedPercentIncrease.click();
  await frame(page);
  assert.equal(await restartedPercentInput.inputValue(), '1');
  await restartedPercentDecrease.click();
  await frame(page);
  assert.equal(await restartedPercentInput.inputValue(), '0');
  assert.equal(await restartedPercentDecrease.isDisabled(), true);
  await setPercent(page, 100);
  assert.equal(await restartedPercentIncrease.isDisabled(), true);
  assert.equal(await restartedPercentDecrease.isDisabled(), false);
  await setPercent(page, 37);

  await setOppositeCount(page, 0);
  assert.equal(await restartedOppositeDecrease.isDisabled(), true);
  assert.equal(await restartedOppositeIncrease.isDisabled(), false);
  const refreshBeforeInvalidOpposite = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  for (const invalid of ['', 'text', '1.5', '-1', '11']) {
    await dispatchInvalidInput(page, 'opposite-count-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalidOpposite,
      `Invalid opposite count ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.deepEqual(await storedSettings(page), withReviewRange({
      reactionBodyTicks: 1,
      entryRangePercent: 37,
      oppositeCandleCount: 0,
      sessionExitMinutes: 20,
    }, expectedReviewRange));
    await restartedOppositeInput.blur();
    await frame(page);
    assert.equal(await restartedOppositeInput.inputValue(), '0');
  }
  for (const invalid of ['', '1.5', '-1', '11']) {
    await pressInvalidEnter(page, 'opposite-count-input', invalid);
    assert.equal(
      Number(await page.locator('html').getAttribute('data-strategy-refresh-count')),
      refreshBeforeInvalidOpposite,
      `Invalid opposite count Enter value ${JSON.stringify(invalid)} must not refresh the strategy`,
    );
    assert.equal(await restartedOppositeInput.inputValue(), '0');
  }

  await restartedOppositeIncrease.click();
  await frame(page);
  assert.equal(await restartedOppositeInput.inputValue(), '1');
  await restartedOppositeDecrease.click();
  await frame(page);
  assert.equal(await restartedOppositeInput.inputValue(), '0');
  assert.equal(await restartedOppositeDecrease.isDisabled(), true);
  await setOppositeCount(page, 10);
  assert.equal(await restartedOppositeIncrease.isDisabled(), true);
  assert.equal(await restartedOppositeDecrease.isDisabled(), false);
  await setOppositeCount(page, 4);

  const selected = await page.evaluate(() =>
    window.moneyComingTest?.selectThresholdComparisonEntry() ?? false);
  assert.equal(selected, true, 'Expected a historical entry whose lifecycle differs at 1 and 20 ticks.');
  await frame(page, 6);
  const selectedStart = await page.locator('html').getAttribute('data-selected-start');
  report.comparisonEventStart = selectedStart;
  assert.ok(selectedStart);
  const range60 = await chartRange(page, 60);
  const range5 = await chartRange(page, 5);
  const snapshot1 = await strategySnapshot(page);
  const summary1 = await panelSummary(page);
  assert.equal(summary1.raw.finalCapital !== null, true);
  assert.equal(summary1.raw.returnRate !== null, true);
  assert.equal(summary1.raw.completedTrades !== null, true);

  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await assertReviewMatchesPanel(page, summary1);

  const refreshBeforeValid = Number(await page.locator('html').getAttribute('data-strategy-refresh-count'));
  await setTicks(page, 20);
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count')) > refreshBeforeValid,
  );
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedStart);
  assertRangeEqual(await chartRange(page, 60), range60, '60-minute viewport after 20 ticks');
  assertRangeEqual(await chartRange(page, 5), range5, '5-minute viewport after 20 ticks');
  const snapshot20 = await strategySnapshot(page);
  const summary20 = await panelSummary(page);
  assert.notDeepEqual(snapshot20, snapshot1);
  assert.notDeepEqual(summary20.raw, summary1.raw);
  await assertReviewMatchesPanel(page, summary20);

  await setTicks(page, 1);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedStart);
  assertRangeEqual(await chartRange(page, 60), range60, '60-minute viewport after restoring 1 tick');
  assertRangeEqual(await chartRange(page, 5), range5, '5-minute viewport after restoring 1 tick');
  assert.deepEqual(await strategySnapshot(page), snapshot1);
  const restoredSummary = await panelSummary(page);
  assert.deepEqual(restoredSummary.raw, summary1.raw);
  await assertReviewMatchesPanel(page, restoredSummary);
  await page.getByTestId('review-done').click();

  await setTicks(page, 1);
  await setPercent(page, 0);
  const percentageSelected = await page.evaluate(() =>
    window.moneyComingTest?.selectPercentageComparisonEntry() ?? false);
  assert.equal(
    percentageSelected,
    true,
    'Expected a historical entry whose lifecycle differs at 0 and 100 percent.',
  );
  await frame(page, 6);
  const percentageSelectedStart = await page.locator('html').getAttribute('data-selected-start');
  report.percentageComparisonEventStart = percentageSelectedStart;
  assert.ok(percentageSelectedStart);
  const percentageRange60 = await chartRange(page, 60);
  const percentageRange5 = await chartRange(page, 5);
  const snapshot0 = await strategySnapshot(page);
  const summary0 = await panelSummary(page);
  assert.equal(await page.locator('html').getAttribute('data-entry-range-percent'), '0');

  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await assertReviewMatchesPanel(page, summary0);

  const refreshBeforePercent100 = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setPercent(page, 100);
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforePercent100,
  );
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), percentageSelectedStart);
  assertRangeEqual(await chartRange(page, 60), percentageRange60, '60-minute viewport after 100 percent');
  assertRangeEqual(await chartRange(page, 5), percentageRange5, '5-minute viewport after 100 percent');
  const snapshot100 = await strategySnapshot(page);
  const summary100 = await panelSummary(page);
  assert.notDeepEqual(snapshot100, snapshot0);
  assert.notDeepEqual(summary100.raw, summary0.raw);
  await assertReviewMatchesPanel(page, summary100);

  await setPercent(page, 0);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), percentageSelectedStart);
  assertRangeEqual(await chartRange(page, 60), percentageRange60, '60-minute viewport after restoring 0 percent');
  assertRangeEqual(await chartRange(page, 5), percentageRange5, '5-minute viewport after restoring 0 percent');
  assert.deepEqual(await strategySnapshot(page), snapshot0);
  const restoredPercentageSummary = await panelSummary(page);
  assert.deepEqual(restoredPercentageSummary.raw, summary0.raw);
  await assertReviewMatchesPanel(page, restoredPercentageSummary);
  await page.getByTestId('review-done').click();

  await setTicks(page, 1);
  await setPercent(page, 25);
  await setOppositeCount(page, 0);
  const oppositeSelected = await page.evaluate(() =>
    window.moneyComingTest?.selectOppositeComparisonEntry() ?? false);
  assert.equal(
    oppositeSelected,
    true,
    'Expected a historical entry whose lifecycle differs with opposite-candle filtering enabled.',
  );
  await frame(page, 6);
  const oppositeComparisonCount = Number(
    await page.locator('html').getAttribute('data-opposite-comparison-count'),
  );
  assert.ok(
    Number.isInteger(oppositeComparisonCount)
      && oppositeComparisonCount >= 1
      && oppositeComparisonCount <= 10,
    `Invalid comparison count: ${oppositeComparisonCount}`,
  );
  const oppositeSelectedStart = await page.locator('html').getAttribute('data-selected-start');
  report.oppositeComparisonEventStart = oppositeSelectedStart;
  assert.ok(oppositeSelectedStart);
  const oppositeRange60 = await chartRange(page, 60);
  const oppositeRange5 = await chartRange(page, 5);
  const oppositeSnapshot0 = await strategySnapshot(page);
  const oppositeSummary0 = await panelSummary(page);
  assert.equal(await page.locator('html').getAttribute('data-opposite-candle-count'), '0');

  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await assertReviewMatchesPanel(page, oppositeSummary0);

  const refreshBeforeOppositeEnabled = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setOppositeCount(page, oppositeComparisonCount);
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforeOppositeEnabled,
  );
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), oppositeSelectedStart);
  assertRangeEqual(
    await chartRange(page, 60),
    oppositeRange60,
    `60-minute viewport after ${oppositeComparisonCount} opposite candles`,
  );
  assertRangeEqual(
    await chartRange(page, 5),
    oppositeRange5,
    `5-minute viewport after ${oppositeComparisonCount} opposite candles`,
  );
  const oppositeSnapshotEnabled = await strategySnapshot(page);
  const oppositeSummaryEnabled = await panelSummary(page);
  assert.notDeepEqual(oppositeSnapshotEnabled, oppositeSnapshot0);
  assert.notDeepEqual(oppositeSummaryEnabled.raw, oppositeSummary0.raw);
  await assertReviewMatchesPanel(page, oppositeSummaryEnabled);

  await setOppositeCount(page, 0);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), oppositeSelectedStart);
  assertRangeEqual(await chartRange(page, 60), oppositeRange60, '60-minute viewport after restoring 0 opposite candles');
  assertRangeEqual(await chartRange(page, 5), oppositeRange5, '5-minute viewport after restoring 0 opposite candles');
  assert.deepEqual(await strategySnapshot(page), oppositeSnapshot0);
  const restoredOppositeSummary = await panelSummary(page);
  assert.deepEqual(restoredOppositeSummary.raw, oppositeSummary0.raw);
  await assertReviewMatchesPanel(page, restoredOppositeSummary);
  await page.getByTestId('review-done').click();

  await setTicks(page, 1);
  await setPercent(page, 25);
  await setOppositeCount(page, 0);
  await setSessionExitMinutes(page, 0);
  const sessionExitSelected = await page.evaluate(() =>
    window.moneyComingTest?.selectSessionExitComparisonEntry() ?? false);
  assert.equal(
    sessionExitSelected,
    true,
    'Expected a historical entry whose lifecycle differs when session exit is enabled.',
  );
  await frame(page, 6);
  const sessionExitComparisonMinutes = Number(
    await page.locator('html').getAttribute('data-session-exit-comparison-minutes'),
  );
  assert.ok(
    [5, 10, 15, 20, 25, 30].includes(sessionExitComparisonMinutes),
    `Invalid session exit comparison minutes: ${sessionExitComparisonMinutes}`,
  );
  const sessionExitSelectedStart = await page.locator('html').getAttribute('data-selected-start');
  report.sessionExitComparisonEventStart = sessionExitSelectedStart;
  assert.ok(sessionExitSelectedStart);
  const sessionExitRange60 = await chartRange(page, 60);
  const sessionExitRange5 = await chartRange(page, 5);
  const sessionExitSnapshot0 = await strategySnapshot(page);
  const sessionExitSummary0 = await panelSummary(page);

  await page.getByTestId('profit-loss-review').click();
  assert.equal(await page.locator('#review-dialog').evaluate(element => element.open), true);
  await assertReviewMatchesPanel(page, sessionExitSummary0);

  const refreshBeforeSessionExitEnabled = Number(
    await page.locator('html').getAttribute('data-strategy-refresh-count'),
  );
  await setSessionExitMinutes(page, sessionExitComparisonMinutes);
  assert.ok(
    Number(await page.locator('html').getAttribute('data-strategy-refresh-count'))
      > refreshBeforeSessionExitEnabled,
  );
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), sessionExitSelectedStart);
  assertRangeEqual(
    await chartRange(page, 60),
    sessionExitRange60,
    `60-minute viewport after ${sessionExitComparisonMinutes}-minute session exit`,
  );
  assertRangeEqual(
    await chartRange(page, 5),
    sessionExitRange5,
    `5-minute viewport after ${sessionExitComparisonMinutes}-minute session exit`,
  );
  const sessionExitSnapshotEnabled = await strategySnapshot(page);
  const sessionExitSummaryEnabled = await panelSummary(page);
  assert.notDeepEqual(sessionExitSnapshotEnabled, sessionExitSnapshot0);
  await assertReviewMatchesPanel(page, sessionExitSummaryEnabled);

  await setSessionExitMinutes(page, 0);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), sessionExitSelectedStart);
  assertRangeEqual(
    await chartRange(page, 60),
    sessionExitRange60,
    '60-minute viewport after disabling session exit',
  );
  assertRangeEqual(
    await chartRange(page, 5),
    sessionExitRange5,
    '5-minute viewport after disabling session exit',
  );
  assert.deepEqual(await strategySnapshot(page), sessionExitSnapshot0);
  const restoredSessionExitSummary = await panelSummary(page);
  assert.deepEqual(restoredSessionExitSummary.raw, sessionExitSummary0.raw);
  await assertReviewMatchesPanel(page, restoredSessionExitSummary);
  await page.getByTestId('review-done').click();

  await setOppositeCount(page, 4);
  await setPercent(page, 37);
  await setSessionExitMinutes(page, 20);
  const instrumentBeforeReload = await page.locator('#instrument').inputValue();
  const alternateInstrument = await page.locator('#instrument option').evaluateAll(
    (options, current) => {
      const option = options.find(candidate => candidate.value !== current);
      return option ? { value: option.value, label: option.textContent } : undefined;
    },
    instrumentBeforeReload,
  );
  assert.ok(alternateInstrument);
  const summaryBeforeInstrumentSwitch = await panelSummary(page);
  await page.locator('#instrument').selectOption(alternateInstrument.value);
  await page.waitForFunction(
    ({ instrument, percent, oppositeCount, sessionExitMinutes, startDate, endDate }) =>
      document.querySelector('#instrument')?.value === instrument
      && document.querySelector('#instrument')?.getAttribute('data-loaded') === instrument
      && document.documentElement.dataset.entryRangePercent === percent
      && document.documentElement.dataset.oppositeCandleCount === oppositeCount
      && document.documentElement.dataset.sessionExitMinutes === sessionExitMinutes
      && document.documentElement.dataset.reviewStartDate === startDate
      && document.documentElement.dataset.reviewEndDate === endDate
      && document.documentElement.dataset.ready === 'true',
    {
      instrument: alternateInstrument.value,
      percent: '37',
      oppositeCount: '4',
      sessionExitMinutes: '20',
      startDate: expectedReviewRange.startDate,
      endDate: expectedReviewRange.endDate,
    },
  );
  await frame(page, 5);
  assert.notEqual(await page.locator('#instrument').inputValue(), instrumentBeforeReload);
  assert.equal(await page.locator('#instrument-name').innerText(), alternateInstrument.label);
  assert.deepEqual(await reviewDateRange(page), expectedReviewRange);
  assert.equal(await restartedPercentInput.inputValue(), '37');
  assert.equal(await restartedOppositeInput.inputValue(), '4');
  assert.equal(await restartedSessionExitSelect.inputValue(), '20');
  assert.deepEqual(await storedSettings(page), withReviewRange({
    reactionBodyTicks: 1,
    entryRangePercent: 37,
    oppositeCandleCount: 4,
    sessionExitMinutes: 20,
  }, expectedReviewRange));
  const summaryAfterInstrumentSwitch = await panelSummary(page);
  assert.notDeepEqual(summaryAfterInstrumentSwitch.raw, summaryBeforeInstrumentSwitch.raw);
  await page.getByTestId('profit-loss-review').click();
  assert.equal(
    await page.getByTestId('review-date-range').innerText(),
    `复盘日期：${expectedReviewRange.startDate} 至 ${expectedReviewRange.endDate}`,
  );
  await assertReviewMatchesPanel(page, summaryAfterInstrumentSwitch);
  await page.getByTestId('review-done').click();

  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click();
  await setReviewDateRange(page, expectedReviewRange.endDate, expectedReviewRange.startDate);
  assert.equal(await page.getByTestId('review-date-error').isVisible(), true);
  await frame(page, 5);
  const layout = await page.evaluate(() => {
    const selectors = [
      '.toolbar-left',
      '.toolbar-right',
      '#entry-settings-panel',
      '#reaction-rules-info',
      '.entry-review-date-control',
      '#review-start-date',
      '#review-end-date',
      '#review-date-error',
      '#market-update-row',
    ];
    const rectangles = Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return [selector, rect ? {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      } : undefined];
    }));
    const groupSelectors = [
      '.toolbar-left',
      '.toolbar-right',
      '#entry-settings-panel',
      '#market-update-row',
    ];
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < groupSelectors.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groupSelectors.length; rightIndex += 1) {
        const left = rectangles[groupSelectors[leftIndex]];
        const right = rectangles[groupSelectors[rightIndex]];
        if (left && right
          && left.left < right.right && left.right > right.left
          && left.top < right.bottom && left.bottom > right.top) {
          overlaps.push([groupSelectors[leftIndex], groupSelectors[rightIndex]]);
        }
      }
    }
    const info = rectangles['#reaction-rules-info'];
    const controlRects = [...document.querySelectorAll('.entry-setting-control')]
      .map(element => element.getBoundingClientRect());
    const controlOverlaps = [];
    for (let leftIndex = 0; leftIndex < controlRects.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < controlRects.length; rightIndex += 1) {
        const left = controlRects[leftIndex];
        const right = controlRects[rightIndex];
        if (left.left < right.right && left.right > right.left
          && left.top < right.bottom && left.bottom > right.top) {
          controlOverlaps.push([leftIndex, rightIndex]);
        }
      }
    }
    const stepperRect = document.querySelector('#reaction-ticks-input')
      ?.closest('.entry-setting-stepper')?.getBoundingClientRect();
    const dateControl = rectangles['.entry-review-date-control'];
    const startDate = rectangles['#review-start-date'];
    const endDate = rectangles['#review-end-date'];
    const dateError = rectangles['#review-date-error'];
    const intersects = (left, right) => !!left && !!right
      && left.left < right.right && left.right > right.left
      && left.top < right.bottom && left.bottom > right.top;
    return {
      rectangles,
      overlaps,
      controlOverlaps,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
      inputFits: [...document.querySelectorAll('#entry-settings-panel input, #entry-settings-panel select, #entry-settings-panel button, #entry-settings-panel dd')]
        .every(element => element.scrollWidth <= element.clientWidth),
      infoCompact: !!info && info.width <= 24 && info.height <= 24,
      infoStepperOverlap: !!info && !!stepperRect
        && info.left < stepperRect.right && info.right > stepperRect.left
        && info.top < stepperRect.bottom && info.bottom > stepperRect.top,
      dateInputsOverlap: intersects(startDate, endDate),
      dateErrorOverlapsInput: intersects(dateError, startDate) || intersects(dateError, endDate),
      dateElementsInViewport: [dateControl, startDate, endDate, dateError].every(rect =>
        !!rect
        && rect.left >= 0
        && rect.right <= innerWidth
        && rect.top >= 0
        && rect.bottom <= innerHeight),
    };
  });
  assert.deepEqual(layout.overlaps, [], JSON.stringify(layout));
  assert.deepEqual(layout.controlOverlaps, [], JSON.stringify(layout));
  assert.equal(layout.horizontalOverflow, false, JSON.stringify(layout));
  assert.equal(layout.inputFits, true, JSON.stringify(layout));
  assert.equal(layout.infoCompact, true, JSON.stringify(layout));
  assert.equal(layout.infoStepperOverlap, false, JSON.stringify(layout));
  assert.equal(layout.dateInputsOverlap, false, JSON.stringify(layout));
  assert.equal(layout.dateErrorOverlapsInput, false, JSON.stringify(layout));
  assert.equal(layout.dateElementsInViewport, true, JSON.stringify(layout));
  await page.screenshot({ path: join(output, 'strategy-settings-1100.png') });
  await setReviewDateRange(page, expectedReviewRange.startDate, expectedReviewRange.endDate);
  assert.equal(await page.getByTestId('review-date-error').isHidden(), true);

  report.passed = true;
  await writeFile(
    join(output, 'strategy-settings.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(report));
} finally {
  if (running?.app) await running.app.close().catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
}
