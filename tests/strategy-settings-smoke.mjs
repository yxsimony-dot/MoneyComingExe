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
  const reviewOpen = await page.locator('#review-dialog').evaluate(element => element.open);
  if (reviewOpen) {
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
  const reviewOpen = await page.locator('#review-dialog').evaluate(element => element.open);
  if (reviewOpen) {
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
  comparisonEventStart: undefined,
  percentageComparisonEventStart: undefined,
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
  assert.equal(await page.getByTestId('reaction-ticks-label').innerText(), '最小入场K线浮动');
  assert.equal(await input.getAttribute('aria-label'), '最小入场K线浮动');
  const reactionRulesInfo = page.getByTestId('reaction-rules-info');
  const reactionRulesDialog = page.getByTestId('reaction-rules-dialog');
  assert.equal(await reactionRulesInfo.getAttribute('title'), '查看5分钟K线识别规则');
  assert.equal(await reactionRulesInfo.getAttribute('aria-label'), '查看5分钟K线识别规则');

  assert.equal(await panel.isHidden(), true);
  assert.equal(await reactionRulesInfo.isHidden(), true);
  assert.equal(await html.getAttribute('data-reaction-body-ticks'), '1');
  assert.equal(await html.getAttribute('data-entry-range-percent'), '25');
  assert.equal(await input.inputValue(), '1');
  assert.equal(await percentInput.inputValue(), '25');
  assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 1, entryRangePercent: 25 });

  for (const [raw, expected] of [
    [null, { reactionBodyTicks: 1, entryRangePercent: 25 }],
    ['{broken-json', { reactionBodyTicks: 1, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 0 }), { reactionBodyTicks: 1, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 21 }), { reactionBodyTicks: 1, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 7 }), { reactionBodyTicks: 7, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 12.5 }),
      { reactionBodyTicks: 7, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 7, entryRangePercent: 101 }),
      { reactionBodyTicks: 7, entryRangePercent: 25 }],
    [JSON.stringify({ reactionBodyTicks: 0, entryRangePercent: 80 }),
      { reactionBodyTicks: 1, entryRangePercent: 80 }],
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
    assert.deepEqual(await storedSettings(page), expected);
  }

  await setStoredValueAndReload(page, JSON.stringify({ reactionBodyTicks: 1, entryRangePercent: 25 }));
  await page.getByTestId('toggle-monday').click();
  await setTicks(page, 7);
  await setPercent(page, 37);
  assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 7, entryRangePercent: 37 });
  await reload(page);
  assert.equal(await page.locator('html').getAttribute('data-reaction-body-ticks'), '7');
  assert.equal(await page.locator('html').getAttribute('data-entry-range-percent'), '37');
  assert.equal(await page.getByTestId('reaction-ticks-input').inputValue(), '7');
  assert.equal(await page.getByTestId('entry-percent-input').inputValue(), '37');
  assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 7, entryRangePercent: 37 });

  await app.close();
  running = await launch('strategy-settings-restart');
  report.offscreen.push(running.offscreen);
  ({ app, page } = running);
  report.persistedTicks = Number(await page.locator('html').getAttribute('data-reaction-body-ticks'));
  report.persistedPercent = Number(await page.locator('html').getAttribute('data-entry-range-percent'));
  assert.equal(report.persistedTicks, 7);
  assert.equal(report.persistedPercent, 37);
  assert.equal(await page.getByTestId('entry-settings-panel').isHidden(), true);
  assert.equal(await page.getByTestId('reaction-ticks-input').inputValue(), '7');
  assert.equal(await page.getByTestId('entry-percent-input').inputValue(), '37');
  assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 7, entryRangePercent: 37 });

  const restartedPanel = page.getByTestId('entry-settings-panel');
  const restartedInput = page.getByTestId('reaction-ticks-input');
  const restartedDecrease = page.getByTestId('reaction-ticks-decrease');
  const restartedIncrease = page.getByTestId('reaction-ticks-increase');
  const restartedPercentInput = page.getByTestId('entry-percent-input');
  const restartedPercentDecrease = page.getByTestId('entry-percent-decrease');
  const restartedPercentIncrease = page.getByTestId('entry-percent-increase');
  const restartedReactionRulesInfo = page.getByTestId('reaction-rules-info');
  const restartedReactionRulesDialog = page.getByTestId('reaction-rules-dialog');
  const mondayToggle = page.getByTestId('toggle-monday');
  await mondayToggle.click();
  assert.equal(await restartedPanel.isVisible(), true);
  assert.equal(await restartedReactionRulesInfo.isVisible(), true);
  assert.equal(await restartedInput.inputValue(), '7');
  assert.equal(await restartedPercentInput.inputValue(), '37');
  const reactionRulesButtonBox = await restartedReactionRulesInfo.boundingBox();
  assert.ok(reactionRulesButtonBox);
  assert.ok(reactionRulesButtonBox.width <= 24, JSON.stringify(reactionRulesButtonBox));
  assert.ok(reactionRulesButtonBox.height <= 24, JSON.stringify(reactionRulesButtonBox));
  await restartedReactionRulesInfo.click();
  assert.equal(await restartedReactionRulesDialog.evaluate(element => element.open), true);
  assert.equal(await page.getByTestId('reaction-rules-current-ticks').innerText(), '7 tick');
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
    '被跳过的K线仍参与红框风险侧极值计算',
    '首轮和第二轮分别独立应用',
  ]) assert.match(initialReactionRulesText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  await mondayToggle.click();
  assert.equal(await restartedPanel.isVisible(), true);
  assert.equal(await restartedInput.inputValue(), '7');
  assert.equal(await restartedPercentInput.inputValue(), '37');

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
    assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 1, entryRangePercent: 37 });
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
    assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 1, entryRangePercent: 0 });
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

  await setPercent(page, 37);
  const instrumentBeforeReload = await page.locator('#instrument').inputValue();
  await page.locator('#instrument').evaluate(element =>
    element.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction(
    ({ instrument, percent }) =>
      document.querySelector('#instrument')?.value === instrument
      && document.documentElement.dataset.entryRangePercent === percent
      && document.documentElement.dataset.ready === 'true',
    { instrument: instrumentBeforeReload, percent: '37' },
  );
  await frame(page, 5);
  assert.equal(await restartedPercentInput.inputValue(), '37');
  assert.deepEqual(await storedSettings(page), { reactionBodyTicks: 1, entryRangePercent: 37 });

  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click();
  await frame(page, 5);
  const layout = await page.evaluate(() => {
    const selectors = [
      '.toolbar-left',
      '.toolbar-right',
      '#entry-settings-panel',
      '#reaction-rules-info',
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
    const groupSelectors = selectors.filter(selector => selector !== '#reaction-rules-info');
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
    const stepperRect = document.querySelector('#reaction-ticks-input')?.closest('.entry-setting-stepper')?.getBoundingClientRect();
    return {
      rectangles,
      overlaps,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
      inputFits: [...document.querySelectorAll('#entry-settings-panel input, #entry-settings-panel button, #entry-settings-panel dd')]
        .every(element => element.scrollWidth <= element.clientWidth),
      infoCompact: !!info && info.width <= 24 && info.height <= 24,
      infoStepperOverlap: !!info && !!stepperRect
        && info.left < stepperRect.right && info.right > stepperRect.left
        && info.top < stepperRect.bottom && info.bottom > stepperRect.top,
    };
  });
  assert.deepEqual(layout.overlaps, [], JSON.stringify(layout));
  assert.equal(layout.horizontalOverflow, false, JSON.stringify(layout));
  assert.equal(layout.inputFits, true, JSON.stringify(layout));
  assert.equal(layout.infoCompact, true, JSON.stringify(layout));
  assert.equal(layout.infoStepperOverlap, false, JSON.stringify(layout));
  await page.screenshot({ path: join(output, 'strategy-settings-1100.png') });

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
