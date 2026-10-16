import { launchElectronTest } from './electron-test-launch.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const parse = async (instrument, period) => (await readFile(`futures_investigation_20261009/edb_${instrument}_${period}m.csv`, 'utf8')).trim().split(/\r?\n/).slice(1).map(line => {
  const c = line.split(',');
  return { start: c[0], end: c[1], startMs: Date.parse(c[0].replace(' ', 'T') + '+08:00'), endMs: Date.parse(c[1].replace(' ', 'T') + '+08:00'),
    open: +c[3], high: +c[4], low: +c[5], close: +c[6], expected: +c[11], complete: c[12] === 'True' };
});

// Independent oracle: calendar-week buckets and direct child filtering, separate
// from the production single scan and running EMA module.
async function expectedFor(instrument) {
  const hours = await parse(instrument, 60); const five = await parse(instrument, 5);
  const ema = []; let value;
  for (const bar of hours) { value = value === undefined ? bar.close : bar.close * 2 / 21 + value * 19 / 21; ema.push(value); }
  const results = [];
  let week, active = false, ordinal = 0, high, low, waiting;
  for (let i = 0; i < hours.length; i++) {
    const bar = hours[i]; const date = new Date(bar.start.slice(0, 10) + 'T00:00:00Z'); const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (day + 6) % 7); const nextWeek = date.toISOString().slice(0, 10);
    if (nextWeek !== week) { week = nextWeek; active = bar.start.startsWith(week); ordinal = 0; high = -Infinity; low = Infinity; waiting = undefined; }
    if (!active) continue;
    ordinal++;
    if (ordinal <= 8) { high = Math.max(high, bar.high); low = Math.min(low, bar.low); continue; }
    const children = five.filter(child => child.startMs >= bar.startMs && child.endMs <= bar.endMs);
    const complete = children.length === bar.expected / 5 && children.every(child => child.complete)
      && Math.max(...children.map(child => child.high)) === bar.high && Math.min(...children.map(child => child.low)) === bar.low;
    if (!complete) {
      const up = bar.high > high, down = bar.low < low;
      waiting = up && down ? undefined : up ? 'long' : down ? 'short' : waiting;
      high = Math.max(high, bar.high); low = Math.min(low, bar.low); continue;
    }
    for (const child of children) {
      const up = child.high > high, down = child.low < low;
      if (up || down) { high = Math.max(high, child.high); low = Math.min(low, child.low); waiting = up && down ? undefined : up ? 'long' : 'short'; continue; }
      if (!waiting) continue;
      const midpoint = (high + low) / 2; const line = waiting === 'long' ? Math.min(midpoint, ema[i - 1]) : Math.max(midpoint, ema[i - 1]);
      if (child.low <= line && line <= child.high) { results.push({ direction: waiting, parent: bar, child, line, midpoint, ema: ema[i - 1] }); waiting = undefined; }
    }
  }
  return { entries: results, hours, five };
}

const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MONEYCOMING_EXE;
const app = await launchElectronTest({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env });
const report = { packaged: !!executablePath, instruments: {}, observations: {}, passed: false };
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'entry-marker-smoke-before-show');
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'entry-marker-smoke-after-show');
  await page.locator('html[data-ready="true"]').waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const html = page.locator('html');
  const card60 = page.locator('#card-60');
  const card5 = page.locator('#card-5');
  const linkedOverlay = page.getByTestId('linked-hover-range');
  const reactionOverlay = page.getByTestId('entry-reaction-range');
  const chartRange = period => page.locator(`#card-${period}`).evaluate(element => ({
    from: Number(element.dataset.visibleFrom),
    to: Number(element.dataset.visibleTo),
    span: Number(element.dataset.visibleSpan),
  }));
  const jump = async date => {
    await page.getByTestId('date-input').fill(date);
    await page.getByTestId('date-jump').click();
    await frame();
  };
  const childrenFor = (parent, five) => five.filter(child => child.startMs >= parent.startMs && child.endMs <= parent.endMs);
  const observationFor = (entry, five) => {
    const index = five.findIndex(bar => bar.startMs === entry.child.startMs);
    assert.ok(index >= 0, `Missing trigger ${entry.child.start}`);
    return { index };
  };
  const sessionPolicyFor = bar => {
    const date = bar.start.slice(0, 10);
    const night = bar.start.slice(11, 16) >= '20:00';
    const boundary = wallTime => Date.parse(`${date}T${wallTime}:00+08:00`);
    return night
      ? {
          entryCutoff: boundary('22:45'),
          sessionEnd: boundary('23:00'),
          forcedExitStart: boundary('22:40'),
        }
      : {
          entryCutoff: boundary('14:45'),
          sessionEnd: boundary('15:00'),
          forcedExitStart: boundary('14:40'),
        };
  };
  const reactionRangeFor = (direction, bars) => {
    const reactionOffset = bars.findIndex(bar => direction === 'long' ? bar.close > bar.open : bar.close < bar.open);
    if (reactionOffset < 0) return undefined;
    const reaction = bars[reactionOffset];
    let extremeOffset = 0;
    for (let index = 1; index <= reactionOffset; index++) {
      if (direction === 'long' ? bars[index].low < bars[extremeOffset].low : bars[index].high > bars[extremeOffset].high) {
        extremeOffset = index;
      }
    }
    const extreme = bars[extremeOffset];
    return direction === 'long'
      ? { reaction, extreme, reactionOffset, extremeOffset, high: reaction.high, low: extreme.low }
      : { reaction, extreme, reactionOffset, extremeOffset, high: extreme.high, low: reaction.low };
  };
  const quarterSignalFor = (direction, bars, reaction, entryCutoff) => {
    if (!reaction) return undefined;
    const rangeTicks = Math.round(reaction.high - reaction.low);
    const quarterTicks = Math.ceil(rangeTicks / 4);
    const price = direction === 'long'
      ? reaction.low + quarterTicks
      : reaction.high - quarterTicks;
    const searchStartOffset = reaction.reactionOffset + 1 < bars.length
      ? reaction.reactionOffset + 1
      : undefined;
    const entryOffset = bars.findIndex((bar, index) => index > reaction.reactionOffset
      && bar.startMs < entryCutoff && bar.low <= price && price <= bar.high);
    return {
      price,
      tick: 1,
      rangeTicks,
      quarterTicks,
      lineStartOffset: reaction.extremeOffset,
      reactionOffset: reaction.reactionOffset,
      searchStartOffset,
      entryOffset: entryOffset >= 0 ? entryOffset : undefined,
    };
  };
  const lifecycleRootAttributes = [
    'data-entry-lifecycle-end-reason',
    'data-entry-lifecycle-first-start',
    'data-entry-lifecycle-last-start',
    'data-entry-lifecycle-entry-cutoff',
    'data-entry-lifecycle-session-end',
    'data-entry-lifecycle-forced-exit-start',
    'data-entry-focus-count',
    'data-entry-focus-first-start',
    'data-entry-focus-last-start',
  ];
  const lifecycleCardAttributes = [
    'data-lifecycle-end-reason',
    'data-lifecycle-entry-cutoff',
    'data-lifecycle-session-end',
    'data-lifecycle-forced-exit-start',
    'data-lifecycle-focus-count',
    'data-lifecycle-focus-first-index',
    'data-lifecycle-focus-last-index',
  ];
  const assertLifecycleDiagnosticsAbsent = async (root = true) => {
    if (root) {
      for (const name of lifecycleRootAttributes) assert.equal(await html.getAttribute(name), null, name);
    }
    for (const name of lifecycleCardAttributes) assert.equal(await card5.getAttribute(name), null, name);
  };
  const stopLossSignalFor = (direction, reaction) => {
    if (!reaction) return undefined;
    const rangeTicks = Math.round(reaction.high - reaction.low);
    const stopTicks = Math.ceil(rangeTicks * 0.75);
    const price = direction === 'long'
      ? reaction.low - stopTicks
      : reaction.high + stopTicks;
    return {
      price,
      tick: 1,
      rangeTicks,
      stopTicks,
      lineStartOffset: reaction.extremeOffset,
    };
  };
  const takeProfitSignalFor = (direction, bars, reaction, quarter) => {
    if (!reaction || !quarter) return undefined;
    const rangeTicks = Math.round(reaction.high - reaction.low);
    const targetTicks = rangeTicks * 2;
    const defaultPrice = direction === 'long'
      ? reaction.high + targetTicks
      : reaction.low - targetTicks;
    const adjustedPrice = direction === 'long' ? reaction.high : reaction.low;
    let riskTouchOffset;
    if (quarter.entryOffset !== undefined) {
      riskTouchOffset = bars.findIndex((bar, index) => index >= quarter.entryOffset
        && (direction === 'long' ? bar.low <= reaction.low : bar.high >= reaction.high));
      if (riskTouchOffset < 0) riskTouchOffset = undefined;
    }
    return {
      tick: 1,
      rangeTicks,
      targetTicks,
      defaultPrice,
      adjustedPrice,
      lineStartOffset: reaction.extremeOffset,
      entryOffset: quarter.entryOffset,
      riskTouchOffset,
    };
  };
  const ema20ByStart = bars => {
    const result = new Map(); let value;
    for (const bar of bars) {
      value = value === undefined ? bar.close : value + 2 / 21 * (bar.close - value);
      result.set(bar.startMs, value);
    }
    return result;
  };
  const findParentPoint = async parent => {
    const target = String(parent.startMs);
    const box = await page.locator('#canvas-60').boundingBox();
    assert.ok(box);
    const y = box.y + Math.min(35, box.height * .15);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await page.waitForTimeout(80);
      let first; let last;
      for (let offset = 2; offset < box.width - 66; offset += 2) {
        await page.mouse.move(box.x + offset, y);
        await frame();
        if (await linkedOverlay.getAttribute('data-first-start') === target) {
          first ??= offset; last = offset;
        } else if (first !== undefined && offset > last + 4) {
          break;
        }
      }
      if (first === undefined || last === undefined) continue;
      for (const offset of [Math.round((first + last) / 2), first, last]) {
        const x = box.x + offset;
        await page.mouse.move(x, y);
        await frame();
        if (await linkedOverlay.getAttribute('data-first-start') === target) return { x, y, box, target };
      }
    }
    assert.fail(`Visible 60m candle ${parent.start}`);
  };
  const zoomLeftTo = async (parent, targetSpan) => {
    let point = await findParentPoint(parent);
    let span = (await chartRange(60)).span;
    let delta = -320;
    for (let attempt = 0; attempt < 20 && span > targetSpan; attempt++) {
      const before = span;
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, delta);
      await frame();
      span = (await chartRange(60)).span;
      if (attempt === 0 && span >= before) delta = -delta;
      point = await findParentPoint(parent);
    }
    return { point, span };
  };
  const assertEntrySelection = async (entry, five, source, sourceSpan) => {
    const { index } = observationFor(entry, five);
    const selectedCount = Number(await card5.getAttribute('data-selected-count'));
    assert.ok(Number.isInteger(selectedCount) && selectedCount > 0, `Invalid lifecycle count ${selectedCount}`);
    const bars = five.slice(index, index + selectedCount);
    assert.equal(bars.length, selectedCount, `Lifecycle extends beyond available data for ${entry.child.start}`);
    const focusCount = Number(await card5.getAttribute('data-lifecycle-focus-count'));
    const focusFirstIndex = Number(await card5.getAttribute('data-lifecycle-focus-first-index'));
    const focusLastIndex = Number(await card5.getAttribute('data-lifecycle-focus-last-index'));
    const focusBars = bars.slice(0, focusCount);
    assert.equal(focusBars.length, focusCount);
    assert.equal(focusFirstIndex, index);
    assert.equal(focusLastIndex, index + focusCount - 1);
    assert.ok(focusCount <= 16);
    const policy = sessionPolicyFor(entry.child);
    const forcedExitBar = five.find((bar, barIndex) =>
      barIndex >= index && bar.startMs === policy.forcedExitStart && bar.complete);
    const endReason = await card5.getAttribute('data-lifecycle-end-reason');
    const observation = { index, bars, focusBars, focusFirstIndex, focusLastIndex, endReason };
    const lastIndex = observation.index + observation.bars.length - 1;
    const reaction = reactionRangeFor(entry.direction, observation.bars);
    const quarter = quarterSignalFor(entry.direction, observation.bars, reaction, policy.entryCutoff);
    const stopLoss = stopLossSignalFor(entry.direction, reaction);
    const takeProfit = takeProfitSignalFor(entry.direction, observation.bars, reaction, quarter);
    assert.equal(await html.getAttribute('data-selection-kind'), 'entry');
    assert.equal(await html.getAttribute('data-entry-direction'), entry.direction);
    assert.equal(await html.getAttribute('data-entry-trigger-start'), String(entry.child.startMs));
    assert.ok(Math.abs(Number(await html.getAttribute('data-entry-pullback-line')) - entry.line) < 0.0001);
    assert.equal(await html.getAttribute('data-observation-count'), String(observation.bars.length));
    assert.equal(await html.getAttribute('data-entry-selection-source'), source);
    assert.equal(await card5.getAttribute('data-selection-kind'), 'entry');
    assert.equal(await card5.getAttribute('data-selection-direction'), entry.direction);
    assert.equal(await card5.getAttribute('data-selection-trigger-start'), String(entry.child.startMs));
    assert.ok(Math.abs(Number(await card5.getAttribute('data-selection-pullback-line')) - entry.line) < 0.0001);
    assert.equal(await card5.getAttribute('data-selected-count'), String(observation.bars.length));
    assert.equal(await card5.getAttribute('data-selection-first-index'), String(observation.index));
    assert.equal(await card5.getAttribute('data-selection-last-index'), String(lastIndex));
    assert.equal(await html.getAttribute('data-entry-lifecycle-end-reason'), endReason);
    assert.equal(await html.getAttribute('data-entry-lifecycle-first-start'), String(observation.bars[0].startMs));
    assert.equal(await html.getAttribute('data-entry-lifecycle-last-start'), String(observation.bars.at(-1).startMs));
    assert.equal(await html.getAttribute('data-entry-lifecycle-entry-cutoff'), String(policy.entryCutoff));
    assert.equal(await html.getAttribute('data-entry-lifecycle-session-end'), String(policy.sessionEnd));
    assert.equal(await html.getAttribute('data-entry-lifecycle-forced-exit-start'),
      forcedExitBar ? String(forcedExitBar.startMs) : '');
    assert.equal(await html.getAttribute('data-entry-focus-count'), String(focusCount));
    assert.equal(await html.getAttribute('data-entry-focus-first-start'), String(focusBars[0].startMs));
    assert.equal(await html.getAttribute('data-entry-focus-last-start'), String(focusBars.at(-1).startMs));
    assert.equal(await card5.getAttribute('data-lifecycle-entry-cutoff'), String(policy.entryCutoff));
    assert.equal(await card5.getAttribute('data-lifecycle-session-end'), String(policy.sessionEnd));
    assert.equal(await card5.getAttribute('data-lifecycle-forced-exit-start'),
      forcedExitBar ? String(forcedExitBar.startMs) : '');
    assert.equal(await card5.getAttribute('data-linked-marker-count'), '0');
    assert.equal(await card5.getAttribute('data-observation-trigger-count'), '1');
    assert.equal(await card5.getAttribute('data-observation-follow-count'), String(observation.bars.length - 1));
    assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-pullback-line-style'), 'solid');
    const emaByStart = ema20ByStart(five);
    const expectedLine = observation.bars.map(bar => entry.direction === 'long'
      ? Math.min(entry.line, emaByStart.get(bar.startMs))
      : Math.max(entry.line, emaByStart.get(bar.startMs)));
    const actualLine = JSON.parse(await card5.getAttribute('data-pullback-line-values'));
    assert.equal(actualLine.length, expectedLine.length);
    actualLine.forEach((value, index) => assert.ok(Math.abs(value - expectedLine[index]) < 0.0001,
      JSON.stringify({ direction: entry.direction, index, value, expected: expectedLine[index] })));
    assert.ok(Math.abs(Number(await card5.getAttribute('data-pullback-line-value')) - expectedLine.at(-1)) < 0.0001);
    assert.ok(Math.abs(Number(await card5.getAttribute('data-pullback-line-first-value')) - expectedLine[0]) < 0.0001);
    assert.ok(Math.abs(Number(await card5.getAttribute('data-pullback-line-last-value')) - expectedLine.at(-1)) < 0.0001);
    assert.equal(await card5.getAttribute('data-pullback-line-point-count'), String(observation.bars.length));
    assert.equal(await card5.getAttribute('data-reaction-range-present'), String(!!reaction));
    assert.equal(await card5.getAttribute('data-quarter-signal-present'), String(!!quarter));
    assert.equal(await card5.getAttribute('data-stop-loss-signal-present'), String(!!stopLoss));
    assert.equal(await card5.getAttribute('data-take-profit-signal-present'), String(!!takeProfit));
    assert.equal(await reactionOverlay.getAttribute('data-present'), String(!!reaction));
    if (reaction) {
      const firstIndex = observation.index + reaction.extremeOffset;
      const reactionIndex = observation.index + reaction.reactionOffset;
      assert.equal(await card5.getAttribute('data-reaction-range-direction'), entry.direction);
      assert.equal(await card5.getAttribute('data-reaction-range-first-start'), String(reaction.extreme.startMs));
      assert.equal(await card5.getAttribute('data-reaction-range-last-start'), String(reaction.reaction.startMs));
      assert.equal(await card5.getAttribute('data-reaction-range-extreme-start'), String(reaction.extreme.startMs));
      assert.equal(await card5.getAttribute('data-reaction-range-reaction-start'), String(reaction.reaction.startMs));
      assert.equal(await card5.getAttribute('data-reaction-range-first-index'), String(firstIndex));
      assert.equal(await card5.getAttribute('data-reaction-range-last-index'), String(reactionIndex));
      assert.equal(Number(await card5.getAttribute('data-reaction-range-high')), reaction.high);
      assert.equal(Number(await card5.getAttribute('data-reaction-range-low')), reaction.low);
      assert.equal(await reactionOverlay.getAttribute('data-direction'), entry.direction);
      assert.equal(await reactionOverlay.getAttribute('data-first-start'), String(reaction.extreme.startMs));
      assert.equal(await reactionOverlay.getAttribute('data-last-start'), String(reaction.reaction.startMs));
      assert.equal(await reactionOverlay.getAttribute('data-extreme-start'), String(reaction.extreme.startMs));
      assert.equal(await reactionOverlay.getAttribute('data-reaction-start'), String(reaction.reaction.startMs));
      assert.equal(await reactionOverlay.getAttribute('data-first-index'), String(firstIndex));
      assert.equal(await reactionOverlay.getAttribute('data-last-index'), String(reactionIndex));
      assert.equal(Number(await reactionOverlay.getAttribute('data-high')), reaction.high);
      assert.equal(Number(await reactionOverlay.getAttribute('data-low')), reaction.low);
      try {
        await reactionOverlay.waitFor({ state: 'visible', timeout: 1000 });
      } catch {
        assert.fail(JSON.stringify({
          expectedIndexes: [firstIndex, reactionIndex],
          expectedPrices: [reaction.low, reaction.high],
          visibleRange: await chartRange(5),
          priceAutoScale: await card5.getAttribute('data-price-auto-scale'),
          priceRange: [
            Number(await card5.getAttribute('data-price-range-from')),
            Number(await card5.getAttribute('data-price-range-to')),
          ],
          reactionGeometry: await reactionOverlay.evaluate(element => ({ ...element.dataset })),
        }));
      }
      assert.equal(await reactionOverlay.getAttribute('data-visible'), 'true');
      const box = await reactionOverlay.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, JSON.stringify({ direction: entry.direction, box }));
      assert.equal(await card5.getAttribute('data-quarter-signal-direction'), entry.direction);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-price')), quarter.price);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-tick')), quarter.tick);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-range-ticks')), quarter.rangeTicks);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-quarter-ticks')), quarter.quarterTicks);
      assert.equal(await card5.getAttribute('data-quarter-signal-line-start'), String(observation.bars[quarter.lineStartOffset].startMs));
      assert.equal(await card5.getAttribute('data-quarter-signal-reaction-start'), String(observation.bars[quarter.reactionOffset].startMs));
      assert.equal(await card5.getAttribute('data-quarter-signal-search-start'),
        quarter.searchStartOffset === undefined ? '' : String(observation.bars[quarter.searchStartOffset].startMs));
      assert.equal(await card5.getAttribute('data-quarter-signal-entry-start'),
        quarter.entryOffset === undefined ? '' : String(observation.bars[quarter.entryOffset].startMs));
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-line-start-index')), observation.index + quarter.lineStartOffset);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-reaction-index')), observation.index + quarter.reactionOffset);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-search-start-index')),
        quarter.searchStartOffset === undefined ? -1 : observation.index + quarter.searchStartOffset);
      assert.equal(Number(await card5.getAttribute('data-quarter-signal-entry-index')),
        quarter.entryOffset === undefined ? -1 : observation.index + quarter.entryOffset);
      assert.equal(await card5.getAttribute('data-quarter-line-visible'), 'true');
      assert.equal(await card5.getAttribute('data-quarter-line-style'), 'solid');
      assert.equal(await card5.getAttribute('data-quarter-line-color'), '#ffffff');
      assert.equal(await card5.getAttribute('data-quarter-line-auto-scale'), 'false');
      assert.equal(Number(await card5.getAttribute('data-quarter-line-price')), quarter.price);
      assert.equal(Number(await card5.getAttribute('data-quarter-line-tick')), quarter.tick);
      assert.equal(Number(await card5.getAttribute('data-quarter-line-quarter-ticks')), quarter.quarterTicks);
      assert.equal(Number(await card5.getAttribute('data-quarter-line-point-count')), observation.bars.length - quarter.lineStartOffset);
      assert.equal(await card5.getAttribute('data-quarter-line-first-start'), String(observation.bars[quarter.lineStartOffset].startMs));
      assert.equal(await card5.getAttribute('data-quarter-line-last-start'), String(observation.bars.at(-1).startMs));
      assert.equal(Number(await card5.getAttribute('data-quarter-line-first-index')), observation.index + quarter.lineStartOffset);
      assert.equal(Number(await card5.getAttribute('data-quarter-line-last-index')), lastIndex);
      assert.equal(await card5.getAttribute('data-stop-loss-signal-direction'), entry.direction);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-price')), stopLoss.price);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-tick')), stopLoss.tick);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-range-ticks')), stopLoss.rangeTicks);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-stop-ticks')), stopLoss.stopTicks);
      assert.equal(await card5.getAttribute('data-stop-loss-signal-line-start'),
        String(observation.bars[stopLoss.lineStartOffset].startMs));
      assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-line-start-index')),
        observation.index + stopLoss.lineStartOffset);
      assert.equal(await card5.getAttribute('data-stop-loss-line-visible'), 'true');
      assert.equal(await card5.getAttribute('data-stop-loss-line-style'), 'solid');
      assert.equal(await card5.getAttribute('data-stop-loss-line-color'), '#f4c95d');
      assert.equal(await card5.getAttribute('data-stop-loss-line-width'), '2');
      assert.equal(await card5.getAttribute('data-stop-loss-line-auto-scale'), 'false');
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-price')), stopLoss.price);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-tick')), stopLoss.tick);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-stop-ticks')), stopLoss.stopTicks);
      const exitLineEndAttribute = await card5.getAttribute('data-exit-signal-line-end');
      const exitLineEndMs = exitLineEndAttribute === null ? undefined : Number(exitLineEndAttribute);
      const exitType = await card5.getAttribute('data-exit-signal-type');
      const exitStartAttribute = await card5.getAttribute('data-exit-signal-start');
      const exitStart = exitStartAttribute === null ? undefined : Number(exitStartAttribute);
      const riskTouchStartAttribute = await card5.getAttribute('data-risk-touch-signal-start');
      const riskTouchStart = riskTouchStartAttribute === null ? undefined : Number(riskTouchStartAttribute);
      const riskTouchOffset = riskTouchStart === undefined
        ? undefined
        : observation.bars.findIndex(bar => bar.startMs === riskTouchStart);
      if (riskTouchStart !== undefined) {
        assert.ok(riskTouchOffset >= 0, `Risk touch bar ${riskTouchStart} must be inside the observation window`);
      }
      const stopLossBars = observation.bars
        .slice(stopLoss.lineStartOffset)
        .filter(bar => exitLineEndMs === undefined || bar.endMs <= exitLineEndMs);
      assert.ok(stopLossBars.length > 0);
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-point-count')), stopLossBars.length);
      assert.equal(await card5.getAttribute('data-stop-loss-line-first-start'),
        String(stopLossBars[0].startMs));
      assert.equal(await card5.getAttribute('data-stop-loss-line-last-start'), String(stopLossBars.at(-1).startMs));
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-first-index')),
        observation.index + observation.bars.indexOf(stopLossBars[0]));
      assert.equal(Number(await card5.getAttribute('data-stop-loss-line-last-index')),
        observation.index + observation.bars.indexOf(stopLossBars.at(-1)));
      const takeProfitBars = observation.bars
        .slice(takeProfit.lineStartOffset)
        .filter(bar => exitLineEndMs === undefined || bar.endMs <= exitLineEndMs);
      const takeProfitValues = takeProfitBars.map(bar => {
        return riskTouchStart !== undefined && bar.startMs >= riskTouchStart
          ? takeProfit.adjustedPrice
          : takeProfit.defaultPrice;
      });
      assert.equal(await card5.getAttribute('data-take-profit-signal-direction'), entry.direction);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-tick')), takeProfit.tick);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-range-ticks')), takeProfit.rangeTicks);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-target-ticks')), takeProfit.targetTicks);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-default-price')), takeProfit.defaultPrice);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-adjusted-price')), takeProfit.adjustedPrice);
      assert.equal(await card5.getAttribute('data-take-profit-signal-line-start'),
        String(observation.bars[takeProfit.lineStartOffset].startMs));
      assert.equal(await card5.getAttribute('data-take-profit-signal-entry-start'),
        takeProfit.entryOffset === undefined ? '' : String(observation.bars[takeProfit.entryOffset].startMs));
      assert.equal(await card5.getAttribute('data-take-profit-signal-risk-touch-start'),
        takeProfit.riskTouchOffset === undefined ? '' : String(observation.bars[takeProfit.riskTouchOffset].startMs));
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-line-start-index')),
        observation.index + takeProfit.lineStartOffset);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-entry-index')),
        takeProfit.entryOffset === undefined ? -1 : observation.index + takeProfit.entryOffset);
      assert.equal(Number(await card5.getAttribute('data-take-profit-signal-risk-touch-index')),
        takeProfit.riskTouchOffset === undefined ? -1 : observation.index + takeProfit.riskTouchOffset);
      assert.equal(await card5.getAttribute('data-take-profit-line-visible'), 'true');
      assert.equal(await card5.getAttribute('data-take-profit-line-style'), 'solid');
      assert.equal(await card5.getAttribute('data-take-profit-line-type'), 'with-steps');
      assert.equal(await card5.getAttribute('data-take-profit-line-color'), '#4fc3f7');
      assert.equal(await card5.getAttribute('data-take-profit-line-width'), '2');
      assert.equal(await card5.getAttribute('data-take-profit-line-auto-scale'), 'false');
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-default-price')), takeProfit.defaultPrice);
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-adjusted-price')), takeProfit.adjustedPrice);
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-tick')), takeProfit.tick);
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-range-ticks')), takeProfit.rangeTicks);
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-target-ticks')), takeProfit.targetTicks);
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-point-count')), takeProfitBars.length);
      assert.equal(await card5.getAttribute('data-take-profit-line-first-start'),
        String(takeProfitBars[0].startMs));
      assert.equal(await card5.getAttribute('data-take-profit-line-last-start'), String(takeProfitBars.at(-1).startMs));
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-first-index')),
        observation.index + observation.bars.indexOf(takeProfitBars[0]));
      assert.equal(Number(await card5.getAttribute('data-take-profit-line-last-index')),
        observation.index + observation.bars.indexOf(takeProfitBars.at(-1)));
      assert.deepEqual(JSON.parse(await card5.getAttribute('data-take-profit-line-values')), takeProfitValues);
      assert.equal(await card5.getAttribute('data-take-profit-line-switch-start'),
        riskTouchStart === undefined ? null : String(riskTouchStart));
      assert.equal(await card5.getAttribute('data-take-profit-line-switch-index'),
        riskTouchOffset === undefined ? null : String(observation.index + riskTouchOffset));
      assert.equal(await card5.getAttribute('data-true-entry-marker-count'), quarter.entryOffset === undefined ? '0' : '1');
      if (quarter.entryOffset === undefined) {
        assert.equal(await card5.getAttribute('data-true-entry-marker-id'), null);
        assert.equal(await card5.getAttribute('data-true-entry-marker-start'), null);
        assert.equal(await card5.getAttribute('data-true-entry-marker-direction'), null);
        assert.equal(await card5.getAttribute('data-true-entry-marker-position'), null);
      } else {
        const entryBar = observation.bars[quarter.entryOffset];
        assert.equal(await card5.getAttribute('data-true-entry-marker-id'),
          `true-entry-${entry.direction}-${entry.child.startMs}-${entryBar.startMs}`);
        assert.equal(await card5.getAttribute('data-true-entry-marker-start'), String(entryBar.startMs));
        assert.equal(await card5.getAttribute('data-true-entry-marker-direction'), entry.direction);
        assert.equal(await card5.getAttribute('data-true-entry-marker-position'), entry.direction === 'long' ? 'belowBar' : 'aboveBar');
      }
      const showRiskMarker = riskTouchStart !== undefined
        && !(exitType === 'stop-loss' && exitStart === riskTouchStart);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), showRiskMarker ? '1' : '0');
      if (!showRiskMarker) {
        assert.equal(await card5.getAttribute('data-risk-touch-marker-id'), null);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-start'), null);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-direction'), null);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-position'), null);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-text'), null);
      } else {
        const riskTouchBar = observation.bars[riskTouchOffset];
        assert.equal(await card5.getAttribute('data-risk-touch-marker-id'),
          `take-profit-risk-touch-${entry.direction}-${entry.child.startMs}-${riskTouchBar.startMs}`);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-start'), String(riskTouchBar.startMs));
        assert.equal(await card5.getAttribute('data-risk-touch-marker-direction'), entry.direction);
        assert.equal(await card5.getAttribute('data-risk-touch-marker-position'),
          entry.direction === 'long' ? 'belowBar' : 'aboveBar');
        assert.equal(await card5.getAttribute('data-risk-touch-marker-text'),
          `${entry.direction === 'long' ? '触底' : '触顶'}${
            riskTouchOffset === quarter.entryOffset ? '·入场' : ''
          }`);
      }
      assert.equal(await card5.getAttribute('data-exit-marker-count'), exitStart === undefined ? '0' : '1');
      assert.equal(await card5.getAttribute('data-exit-marker-start'),
        exitStart === undefined ? null : String(exitStart));
      if (exitStart !== undefined) {
        assert.equal(exitStart, observation.bars.at(-1).startMs);
        const expectedExitText = exitType === 'take-profit'
          ? '止盈出场'
          : exitType === 'session-close'
            ? '休市出场'
            : '止损出场';
        assert.equal(await card5.getAttribute('data-exit-marker-text'), expectedExitText);
      }
      if (exitType === 'session-close') {
        assert.ok(forcedExitBar, `Missing forced-exit bar for ${entry.child.start}`);
        assert.equal(endReason, 'session-close');
        assert.equal(exitStart, forcedExitBar.startMs);
        assert.equal(Number(await card5.getAttribute('data-exit-signal-price')), forcedExitBar.close);
        assert.equal(await card5.getAttribute('data-exit-signal-granularity'), 'five-minute-close');
        assert.equal(await card5.getAttribute('data-exit-signal-line-end'), String(forcedExitBar.endMs));
        assert.match(await card5.getAttribute('data-exit-marker-id'), /^actual-exit-session-close-/);
        assert.equal(await card5.getAttribute('data-exit-marker-count'), '1');
      }
    } else {
      assert.equal(await reactionOverlay.isHidden(), true);
      assert.equal(await reactionOverlay.getAttribute('data-visible'), 'false');
      assert.equal(await reactionOverlay.getAttribute('data-direction'), null);
      assert.equal(await card5.getAttribute('data-quarter-line-visible'), 'false');
      assert.equal(await card5.getAttribute('data-quarter-line-price'), null);
      assert.equal(await card5.getAttribute('data-stop-loss-line-visible'), 'false');
      assert.equal(await card5.getAttribute('data-stop-loss-line-price'), null);
      assert.equal(await card5.getAttribute('data-take-profit-line-visible'), 'false');
      assert.equal(await card5.getAttribute('data-take-profit-line-default-price'), null);
      assert.equal(await card5.getAttribute('data-true-entry-marker-count'), '0');
      assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), '0');
    }
    assert.match(await page.locator('.selection-label').innerText(), /入场观察/);
    const selectionText = await page.locator('#selection-text').innerText();
    assert.match(selectionText, entry.direction === 'long' ? /多头/ : /空头/);
    assert.ok(selectionText.includes(entry.child.start.slice(0, 16)), selectionText);
    assert.match(selectionText, /回调线/);
    assert.ok(selectionText.includes(`${observation.bars.length} 根 5 分钟`), selectionText);
    const range = await chartRange(5);
    const expectedSpan = Math.min(five.length, Math.max(sourceSpan, observation.focusBars.length + 4));
    assert.ok(Math.abs(range.span - expectedSpan) < .05, JSON.stringify({ sourceSpan, expectedSpan, range }));
    assert.ok(range.from <= focusFirstIndex - .5 && range.to >= focusLastIndex + .5,
      JSON.stringify({ range, focusFirstIndex, focusLastIndex, lastIndex }));
    const nonTouchingFollowBars = observation.bars.slice(1).filter(bar => !(bar.low <= entry.line && entry.line <= bar.high));
    assert.ok(nonTouchingFollowBars.length > 0, `${entry.direction} fixture must prove follow bars are not price-filtered`);
    return { ...observation, reaction, nonTouchingFollowBars: nonTouchingFollowBars.length, range,
      lineDistinctValues: new Set(expectedLine.map(value => value.toFixed(8))).size, quarter, stopLoss, takeProfit };
  };
  const clickBody = async (entry, five, targetSpan) => {
    await jump(entry.parent.start.slice(0, 10));
    const { point, span } = await zoomLeftTo(entry.parent, targetSpan);
    const leftBefore = await chartRange(60);
    await page.mouse.click(point.x, point.box.y + point.box.height * .42);
    await frame();
    assert.deepEqual(await chartRange(60), leftBefore);
    return { point, span, observation: await assertEntrySelection(entry, five, 'default', span) };
  };
  const clickConcreteMarker = async (entry, five) => {
    const point = await findParentPoint(entry.parent);
    const volumeTop = Number.parseFloat(await card60.locator('.volume-label').evaluate(element => element.style.top));
    const priceHeight = Number.isFinite(volumeTop) ? volumeTop - 7 : point.box.height * .64;
    for (let offset = 3; offset < priceHeight - 3; offset += 2) {
      await html.evaluate(element => { delete element.dataset.entrySelectionSource; });
      await page.mouse.click(point.x, point.box.y + offset);
      await frame();
      if (await html.getAttribute('data-entry-selection-source') !== 'marker') continue;
      assert.equal(await html.getAttribute('data-entry-trigger-start'), String(entry.child.startMs));
      return assertEntrySelection(entry, five, 'marker', (await chartRange(60)).span);
    }
    assert.fail(`Clickable entry marker ${entry.direction} ${entry.parent.start}`);
  };

  assert.equal(await card60.getAttribute('data-entry-long-count'), '0');
  await page.getByTestId('toggle-monday').click();
  await page.getByTestId('mode-60').click();
  const oracle = {};
  const instrument = 'main_continuous';
  const expected = await expectedFor(instrument);
  oracle[instrument] = expected;
    const long = expected.entries.filter(entry => entry.direction === 'long').length;
    const short = expected.entries.filter(entry => entry.direction === 'short').length;
    assert.equal(await card60.getAttribute('data-entry-long-count'), String(long));
    assert.equal(await card60.getAttribute('data-entry-short-count'), String(short));
    const expected60EntryMarkerIds = expected.entries
      .map(entry => `entry-${entry.direction}-${entry.child.startMs}`);
    const original60EntryMarkerIds = JSON.parse(await card60.getAttribute('data-entry-marker-ids'));
    assert.deepEqual(original60EntryMarkerIds, expected60EntryMarkerIds);
    assert.equal(await card5.getAttribute('data-entry-long-count'), '0');
    for (const direction of ['long', 'short']) {
      const entry = expected.entries.find(item => item.direction === direction && item.parent.start > '2026-03-01'); assert.ok(entry);
      await jump(entry.parent.start.slice(0, 10));
      const point = await findParentPoint(entry.parent);
      await page.mouse.move(point.x, point.y); await frame();
      const info = await card60.locator('.entry-info').innerText();
      assert.ok(info.includes(direction === 'long' ? '多头入场' : '空头入场'), info);
      const shownLine = Number(info.match(/回调线 ([\d,.]+)/)?.[1].replaceAll(',', ''));
      assert.ok(Math.abs(shownLine - entry.line) < 0.006, info);
    }
  report.instruments[instrument] = { long, short, conservativeSkippedHours: Number(await card60.getAttribute('data-entry-incomplete-hours')) };
  await page.getByTestId('mode-dual').click();
  const { entries, hours, five } = oracle.main_continuous;
  const longEntry = entries.find(entry => entry.direction === 'long' && entry.parent.start > '2026-03-01');
  const shortEntry = entries.find(entry => entry.direction === 'short' && entry.parent.start > '2026-03-01');
  assert.ok(longEntry && shortEntry);

  await jump(longEntry.parent.start.slice(0, 10));
  const persistentBeforeHover = await html.getAttribute('data-selected-start');
  const rightBeforeHover = await chartRange(5);
  const longPoint = await findParentPoint(longEntry.parent);
  const longChildren = childrenFor(longEntry.parent, five);
  assert.equal(await linkedOverlay.getAttribute('data-count'), String(longChildren.length));
  assert.equal(await linkedOverlay.getAttribute('data-first-start'), String(longChildren[0].startMs));
  assert.equal(await linkedOverlay.getAttribute('data-last-start'), String(longChildren.at(-1).startMs));
  assert.equal(await html.getAttribute('data-selected-start'), persistentBeforeHover);
  assert.deepEqual(await chartRange(5), rightBeforeHover);
  await page.mouse.move(longPoint.x, longPoint.y); await frame();

  const longSelection = await clickBody(longEntry, five, 32);
  assert.ok(longSelection.span >= 20 && longSelection.span <= 45, `Expected source span around 32, got ${longSelection.span}`);
  assert.ok(longSelection.observation.reaction, 'Long entry must expose a first reaction range');
  await page.mouse.move(10, 10); await frame();
  await mkdir('artifacts', { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-observation-long-1440.png') });
  const markerSelection = await clickConcreteMarker(longEntry, five);
  assert.equal(markerSelection.bars.length, longSelection.observation.bars.length);
  assert.equal(markerSelection.endReason, longSelection.observation.endReason);
  const reactionGeometry = async () => reactionOverlay.evaluate(element => ({
    present: element.dataset.present,
    visible: element.dataset.visible,
    firstIndex: element.dataset.firstIndex,
    lastIndex: element.dataset.lastIndex,
    left: Number(element.dataset.left),
    top: Number(element.dataset.top),
    width: Number(element.dataset.width),
    height: Number(element.dataset.height),
    chartWidth: Number(element.dataset.chartWidth),
    clipped: element.dataset.clipped,
  }));
  const quarterDiagnostics = async () => ({
    visible: await card5.getAttribute('data-quarter-line-visible'),
    price: await card5.getAttribute('data-quarter-line-price'),
    firstStart: await card5.getAttribute('data-quarter-line-first-start'),
    lastStart: await card5.getAttribute('data-quarter-line-last-start'),
    pointCount: await card5.getAttribute('data-quarter-line-point-count'),
    searchStart: await card5.getAttribute('data-quarter-signal-search-start'),
    entryStart: await card5.getAttribute('data-quarter-signal-entry-start'),
    markerId: await card5.getAttribute('data-true-entry-marker-id'),
  });
  const stopLossDiagnostics = async () => ({
    visible: await card5.getAttribute('data-stop-loss-line-visible'),
    direction: await card5.getAttribute('data-stop-loss-signal-direction'),
    price: await card5.getAttribute('data-stop-loss-line-price'),
    tick: await card5.getAttribute('data-stop-loss-line-tick'),
    stopTicks: await card5.getAttribute('data-stop-loss-line-stop-ticks'),
    firstStart: await card5.getAttribute('data-stop-loss-line-first-start'),
    lastStart: await card5.getAttribute('data-stop-loss-line-last-start'),
    firstIndex: await card5.getAttribute('data-stop-loss-line-first-index'),
    lastIndex: await card5.getAttribute('data-stop-loss-line-last-index'),
    pointCount: await card5.getAttribute('data-stop-loss-line-point-count'),
  });
  const takeProfitDiagnostics = async () => ({
    visible: await card5.getAttribute('data-take-profit-line-visible'),
    direction: await card5.getAttribute('data-take-profit-signal-direction'),
    defaultPrice: await card5.getAttribute('data-take-profit-line-default-price'),
    adjustedPrice: await card5.getAttribute('data-take-profit-line-adjusted-price'),
    tick: await card5.getAttribute('data-take-profit-line-tick'),
    rangeTicks: await card5.getAttribute('data-take-profit-line-range-ticks'),
    targetTicks: await card5.getAttribute('data-take-profit-line-target-ticks'),
    entryStart: await card5.getAttribute('data-take-profit-signal-entry-start'),
    riskTouchStart: await card5.getAttribute('data-take-profit-signal-risk-touch-start'),
    firstStart: await card5.getAttribute('data-take-profit-line-first-start'),
    lastStart: await card5.getAttribute('data-take-profit-line-last-start'),
    firstIndex: await card5.getAttribute('data-take-profit-line-first-index'),
    lastIndex: await card5.getAttribute('data-take-profit-line-last-index'),
    pointCount: await card5.getAttribute('data-take-profit-line-point-count'),
    values: await card5.getAttribute('data-take-profit-line-values'),
    switchStart: await card5.getAttribute('data-take-profit-line-switch-start'),
    switchIndex: await card5.getAttribute('data-take-profit-line-switch-index'),
    markerId: await card5.getAttribute('data-risk-touch-marker-id'),
    markerStart: await card5.getAttribute('data-risk-touch-marker-start'),
    markerText: await card5.getAttribute('data-risk-touch-marker-text'),
  });
  const assertQuarterAbsent = async signalPresent => {
    assert.equal(await card5.getAttribute('data-quarter-signal-present'), signalPresent);
    assert.equal(await card5.getAttribute('data-quarter-line-visible'), 'false');
    for (const name of [
      'data-quarter-signal-direction',
      'data-quarter-signal-price',
      'data-quarter-signal-tick',
      'data-quarter-signal-range-ticks',
      'data-quarter-signal-quarter-ticks',
      'data-quarter-signal-line-start',
      'data-quarter-signal-reaction-start',
      'data-quarter-signal-search-start',
      'data-quarter-signal-entry-start',
      'data-quarter-line-price',
      'data-quarter-line-tick',
      'data-quarter-line-quarter-ticks',
      'data-quarter-line-point-count',
      'data-quarter-line-first-start',
      'data-quarter-line-last-start',
      'data-true-entry-marker-id',
      'data-true-entry-marker-start',
      'data-true-entry-marker-direction',
      'data-true-entry-marker-position',
    ]) {
      assert.equal(await card5.getAttribute(name), null, name);
    }
    assert.equal(await card5.getAttribute('data-true-entry-marker-count'), '0');
  };
  const assertStopLossAbsent = async signalPresent => {
    assert.equal(await card5.getAttribute('data-stop-loss-signal-present'), signalPresent);
    assert.equal(await card5.getAttribute('data-stop-loss-line-visible'), 'false');
    for (const name of [
      'data-stop-loss-signal-direction',
      'data-stop-loss-signal-price',
      'data-stop-loss-signal-tick',
      'data-stop-loss-signal-range-ticks',
      'data-stop-loss-signal-stop-ticks',
      'data-stop-loss-signal-line-start',
      'data-stop-loss-signal-line-start-index',
      'data-stop-loss-line-price',
      'data-stop-loss-line-tick',
      'data-stop-loss-line-stop-ticks',
      'data-stop-loss-line-point-count',
      'data-stop-loss-line-first-start',
      'data-stop-loss-line-last-start',
      'data-stop-loss-line-first-index',
      'data-stop-loss-line-last-index',
    ]) {
      assert.equal(await card5.getAttribute(name), null, name);
    }
  };
  const assertTakeProfitAbsent = async signalPresent => {
    assert.equal(await card5.getAttribute('data-take-profit-signal-present'), signalPresent);
    assert.equal(await card5.getAttribute('data-take-profit-line-visible'), 'false');
    for (const name of [
      'data-take-profit-signal-direction',
      'data-take-profit-signal-tick',
      'data-take-profit-signal-range-ticks',
      'data-take-profit-signal-target-ticks',
      'data-take-profit-signal-default-price',
      'data-take-profit-signal-adjusted-price',
      'data-take-profit-signal-line-start',
      'data-take-profit-signal-entry-start',
      'data-take-profit-signal-risk-touch-start',
      'data-take-profit-signal-line-start-index',
      'data-take-profit-signal-entry-index',
      'data-take-profit-signal-risk-touch-index',
      'data-take-profit-line-default-price',
      'data-take-profit-line-adjusted-price',
      'data-take-profit-line-tick',
      'data-take-profit-line-range-ticks',
      'data-take-profit-line-target-ticks',
      'data-take-profit-line-point-count',
      'data-take-profit-line-first-start',
      'data-take-profit-line-last-start',
      'data-take-profit-line-first-index',
      'data-take-profit-line-last-index',
      'data-take-profit-line-values',
      'data-take-profit-line-switch-start',
      'data-take-profit-line-switch-index',
      'data-risk-touch-marker-id',
      'data-risk-touch-marker-start',
      'data-risk-touch-marker-direction',
      'data-risk-touch-marker-position',
      'data-risk-touch-marker-text',
    ]) {
      assert.equal(await card5.getAttribute(name), null, name);
    }
    assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), '0');
  };
  const fiveCanvas = page.locator('#canvas-5');
  let fiveBox = await fiveCanvas.boundingBox();
  assert.ok(fiveBox);
  const initialReactionGeometry = await reactionGeometry();
  const initialQuarterDiagnostics = await quarterDiagnostics();
  const initialStopLossDiagnostics = await stopLossDiagnostics();
  const initialTakeProfitDiagnostics = await takeProfitDiagnostics();
  await page.mouse.move(fiveBox.x + fiveBox.width * .5, fiveBox.y + fiveBox.height * .35);
  await page.mouse.wheel(0, -280);
  await frame();
  const zoomedReactionGeometry = await reactionGeometry();
  assert.equal(zoomedReactionGeometry.present, 'true');
  assert.equal(zoomedReactionGeometry.visible, 'true');
  assert.equal(zoomedReactionGeometry.firstIndex, initialReactionGeometry.firstIndex);
  assert.equal(zoomedReactionGeometry.lastIndex, initialReactionGeometry.lastIndex);
  assert.notEqual(zoomedReactionGeometry.width, initialReactionGeometry.width);
  assert.deepEqual(await quarterDiagnostics(), initialQuarterDiagnostics);
  assert.deepEqual(await stopLossDiagnostics(), initialStopLossDiagnostics);
  assert.deepEqual(await takeProfitDiagnostics(), initialTakeProfitDiagnostics);

  const dragFiveMinutes = async delta => {
    fiveBox = await fiveCanvas.boundingBox();
    const startX = fiveBox.x + 5;
    const y = fiveBox.y + fiveBox.height * .35;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + delta, y, { steps: 20 });
    await page.mouse.up();
    await frame();
  };
  const distanceToHalfClip = zoomedReactionGeometry.chartWidth
    - (zoomedReactionGeometry.left + zoomedReactionGeometry.width)
    + zoomedReactionGeometry.width / 2;
  await dragFiveMinutes(distanceToHalfClip);
  let clippedReactionGeometry = await reactionGeometry();
  for (let attempt = 0; attempt < 4 && clippedReactionGeometry.visible === 'true' && clippedReactionGeometry.clipped !== 'true'; attempt++) {
    const rightGap = Math.max(0, clippedReactionGeometry.chartWidth
      - (clippedReactionGeometry.left + clippedReactionGeometry.width));
    await dragFiveMinutes(Math.max(16, rightGap + clippedReactionGeometry.width * .55));
    clippedReactionGeometry = await reactionGeometry();
  }
  assert.equal(clippedReactionGeometry.present, 'true');
  assert.equal(clippedReactionGeometry.visible, 'true');
  assert.equal(clippedReactionGeometry.clipped, 'true', JSON.stringify({ zoomedReactionGeometry, clippedReactionGeometry }));
  assert.equal(clippedReactionGeometry.firstIndex, initialReactionGeometry.firstIndex);
  assert.equal(clippedReactionGeometry.lastIndex, initialReactionGeometry.lastIndex);
  let offscreenReactionGeometry = clippedReactionGeometry;
  for (let attempt = 0; attempt < 4 && offscreenReactionGeometry.visible !== 'false'; attempt++) {
    await dragFiveMinutes(Math.max(18, offscreenReactionGeometry.width + 12));
    offscreenReactionGeometry = await reactionGeometry();
  }
  assert.equal(offscreenReactionGeometry.present, 'true');
  assert.equal(offscreenReactionGeometry.visible, 'false');
  assert.equal(offscreenReactionGeometry.firstIndex, initialReactionGeometry.firstIndex);
  assert.equal(offscreenReactionGeometry.lastIndex, initialReactionGeometry.lastIndex);
  assert.deepEqual(await quarterDiagnostics(), initialQuarterDiagnostics);
  assert.deepEqual(await stopLossDiagnostics(), initialStopLossDiagnostics);
  assert.deepEqual(await takeProfitDiagnostics(), initialTakeProfitDiagnostics);

  await clickBody(longEntry, five, 32);
  fiveBox = await fiveCanvas.boundingBox();
  const beforePriceDrag = await reactionGeometry();
  const priceAxisX = fiveBox.x + fiveBox.width - 18;
  const priceAxisY = fiveBox.y + Math.max(55, fiveBox.height * .28);
  await page.mouse.move(priceAxisX, priceAxisY);
  await page.mouse.down();
  await page.mouse.move(priceAxisX, priceAxisY + 44, { steps: 12 });
  await page.mouse.up();
  await frame();
  const afterPriceDrag = await reactionGeometry();
  assert.equal(afterPriceDrag.present, 'true');
  assert.equal(afterPriceDrag.visible, 'true');
  assert.ok(afterPriceDrag.top !== beforePriceDrag.top || afterPriceDrag.height !== beforePriceDrag.height);
  assert.equal(await card5.getAttribute('data-price-auto-scale'), 'false');
  assert.deepEqual(await quarterDiagnostics(), initialQuarterDiagnostics);
  assert.deepEqual(await stopLossDiagnostics(), initialStopLossDiagnostics);
  assert.deepEqual(await takeProfitDiagnostics(), initialTakeProfitDiagnostics);
  await page.getByTestId('axis-reset-5').click();
  await frame();
  assert.equal(await card5.getAttribute('data-price-auto-scale'), 'true');
  assert.equal(await reactionOverlay.getAttribute('data-visible'), 'true');
  assert.deepEqual(await quarterDiagnostics(), initialQuarterDiagnostics);
  assert.deepEqual(await stopLossDiagnostics(), initialStopLossDiagnostics);
  assert.deepEqual(await takeProfitDiagnostics(), initialTakeProfitDiagnostics);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-reaction-interactions-1440.png') });

  const shortSelection = await clickBody(shortEntry, five, 10);
  assert.ok(shortSelection.span < 20, `Expected a source span below the 20-bar observation minimum, got ${shortSelection.span}`);
  assert.ok(Math.abs(shortSelection.observation.range.span - 20) < .05);
  assert.ok(shortSelection.observation.reaction, 'Short entry must expose a first reaction range');
  const shortStopLossDiagnostics = await stopLossDiagnostics();
  const shortTakeProfitDiagnostics = await takeProfitDiagnostics();
  await page.setViewportSize({ width: 1100, height: 720 }); await frame();
  assert.deepEqual(await stopLossDiagnostics(), shortStopLossDiagnostics);
  assert.deepEqual(await takeProfitDiagnostics(), shortTakeProfitDiagnostics);
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  const narrowFirst = Number(await card5.getAttribute('data-lifecycle-focus-first-index'));
  const narrowLast = Number(await card5.getAttribute('data-lifecycle-focus-last-index'));
  let narrowRange = await chartRange(5);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (Math.abs(narrowRange.span - 20) < .05 && narrowRange.from <= narrowFirst - .5 && narrowRange.to >= narrowLast + .5) break;
    await page.waitForTimeout(50);
    narrowRange = await chartRange(5);
  }
  assert.ok(Math.abs(narrowRange.span - 20) < .05, JSON.stringify({ narrowRange, narrowFirst, narrowLast }));
  assert.ok(narrowRange.from <= narrowFirst - .5 && narrowRange.to >= narrowLast + .5, JSON.stringify({ narrowRange, narrowFirst, narrowLast }));
  await page.mouse.move(10, 10); await frame();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-observation-short-1100.png') });

  const scenarioIndex = observationFor(longEntry, five).index;
  const scenarioStart = five[scenarioIndex].startMs;
  const showScenario = async (scenario, direction, startIndex = scenarioIndex) => {
    const startMs = five[startIndex].startMs;
    await page.evaluate(({ scenario, direction, scenarioStart }) => {
      window.moneyComingTest.showReactionScenario(scenario, direction, scenarioStart);
    }, { scenario, direction, scenarioStart: startMs });
    await frame();
    return { startIndex, startMs, count: Math.min(16, five.length - startIndex) };
  };
  const assertControlledQuarterScenario = async ({
    scenario,
    direction,
    startIndex = scenarioIndex,
    entryOffset = scenario === 'quarter-no-touch' ? undefined
      : ['quarter-wick-touch', 'quarter-repeated-touch', 'take-profit-entry-touch',
          'take-profit-repeated-touch', 'take-profit-no-touch'].includes(scenario) ? 2 : 3,
    expectVisibleRange = true,
  }) => {
    const shown = await showScenario(scenario, direction, startIndex);
    const rangeTicks = scenario === 'quarter-divisible' ? 12 : 11;
    const quarterTicks = Math.ceil(rangeTicks / 4);
    const stopTicks = Math.ceil(rangeTicks * 0.75);
    const targetTicks = rangeTicks * 2;
    const base = Math.round(five[startIndex].close / 20) * 20 + (scenario === 'quarter-autoscale' ? 10_000 : 0);
    const price = direction === 'long' ? base + quarterTicks : base + rangeTicks - quarterTicks;
    const stopPrice = direction === 'long' ? base - stopTicks : base + rangeTicks + stopTicks;
    const defaultTakeProfitPrice = direction === 'long'
      ? base + rangeTicks + targetTicks
      : base - targetTicks;
    const adjustedTakeProfitPrice = direction === 'long' ? base + rangeTicks : base;
    const riskTouchOffset = scenario === 'take-profit-entry-touch' ? 2
      : scenario === 'take-profit-later-touch' ? 5
        : scenario === 'take-profit-repeated-touch' ? 4
          : undefined;
    const reactionStart = five[startIndex + 1].startMs;
    const searchStart = shown.count > 2 ? five[startIndex + 2].startMs : undefined;
    const entryStart = entryOffset === undefined ? undefined : five[startIndex + entryOffset].startMs;
    const riskTouchStart = riskTouchOffset === undefined ? undefined : five[startIndex + riskTouchOffset].startMs;
    const lastStart = five[startIndex + shown.count - 1].startMs;

    assert.equal(await card5.getAttribute('data-selection-kind'), 'entry');
    assert.equal(await card5.getAttribute('data-selection-direction'), direction);
    assert.equal(await card5.getAttribute('data-selected-count'), String(shown.count));
    assert.equal(await card5.getAttribute('data-observation-trigger-count'), '1');
    assert.equal(await card5.getAttribute('data-observation-follow-count'), String(shown.count - 1));
    assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-reaction-range-present'), 'true');
    assert.equal(await reactionOverlay.getAttribute('data-present'), 'true');
    assert.equal(await reactionOverlay.getAttribute('data-direction'), direction);
    assert.equal(await reactionOverlay.getAttribute('data-first-start'), String(shown.startMs));
    assert.equal(await reactionOverlay.getAttribute('data-reaction-start'), String(reactionStart));
    assert.equal(await reactionOverlay.getAttribute('data-first-index'), String(startIndex));
    assert.equal(await reactionOverlay.getAttribute('data-last-index'), String(startIndex + 1));
    if (expectVisibleRange) {
      assert.equal(await reactionOverlay.getAttribute('data-visible'), 'true');
      assert.ok((await reactionOverlay.boundingBox()).width > 0);
    }

    assert.equal(await card5.getAttribute('data-quarter-signal-present'), 'true');
    assert.equal(await card5.getAttribute('data-quarter-signal-direction'), direction);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-price')), price);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-range-ticks')), rangeTicks);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-quarter-ticks')), quarterTicks);
    assert.equal(await card5.getAttribute('data-quarter-signal-line-start'), String(shown.startMs));
    assert.equal(await card5.getAttribute('data-quarter-signal-reaction-start'), String(reactionStart));
    assert.equal(await card5.getAttribute('data-quarter-signal-search-start'), searchStart === undefined ? '' : String(searchStart));
    assert.equal(await card5.getAttribute('data-quarter-signal-entry-start'), entryStart === undefined ? '' : String(entryStart));
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-line-start-index')), startIndex);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-reaction-index')), startIndex + 1);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-search-start-index')),
      searchStart === undefined ? -1 : startIndex + 2);
    assert.equal(Number(await card5.getAttribute('data-quarter-signal-entry-index')),
      entryOffset === undefined ? -1 : startIndex + entryOffset);

    assert.equal(await card5.getAttribute('data-quarter-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-quarter-line-style'), 'solid');
    assert.equal(await card5.getAttribute('data-quarter-line-color'), '#ffffff');
    assert.equal(await card5.getAttribute('data-quarter-line-auto-scale'), 'false');
    assert.equal(Number(await card5.getAttribute('data-quarter-line-price')), price);
    assert.equal(Number(await card5.getAttribute('data-quarter-line-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-quarter-line-quarter-ticks')), quarterTicks);
    assert.equal(Number(await card5.getAttribute('data-quarter-line-point-count')), shown.count);
    assert.equal(await card5.getAttribute('data-quarter-line-first-start'), String(shown.startMs));
    assert.equal(await card5.getAttribute('data-quarter-line-last-start'), String(lastStart));
    assert.equal(Number(await card5.getAttribute('data-quarter-line-first-index')), startIndex);
    assert.equal(Number(await card5.getAttribute('data-quarter-line-last-index')), startIndex + shown.count - 1);

    assert.equal(await card5.getAttribute('data-stop-loss-signal-present'), 'true');
    assert.equal(await card5.getAttribute('data-stop-loss-signal-direction'), direction);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-price')), stopPrice);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-range-ticks')), rangeTicks);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-stop-ticks')), stopTicks);
    assert.equal(await card5.getAttribute('data-stop-loss-signal-line-start'), String(shown.startMs));
    assert.equal(Number(await card5.getAttribute('data-stop-loss-signal-line-start-index')), startIndex);
    assert.equal(await card5.getAttribute('data-stop-loss-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-stop-loss-line-style'), 'solid');
    assert.equal(await card5.getAttribute('data-stop-loss-line-color'), '#f4c95d');
    assert.equal(await card5.getAttribute('data-stop-loss-line-width'), '2');
    assert.equal(await card5.getAttribute('data-stop-loss-line-auto-scale'), 'false');
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-price')), stopPrice);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-stop-ticks')), stopTicks);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-point-count')), shown.count);
    assert.equal(await card5.getAttribute('data-stop-loss-line-first-start'), String(shown.startMs));
    assert.equal(await card5.getAttribute('data-stop-loss-line-last-start'), String(lastStart));
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-first-index')), startIndex);
    assert.equal(Number(await card5.getAttribute('data-stop-loss-line-last-index')), startIndex + shown.count - 1);

    const takeProfitValues = Array.from({ length: shown.count }, (_, index) =>
      riskTouchOffset !== undefined && index >= riskTouchOffset
        ? adjustedTakeProfitPrice
        : defaultTakeProfitPrice);
    assert.equal(await card5.getAttribute('data-take-profit-signal-present'), 'true');
    assert.equal(await card5.getAttribute('data-take-profit-signal-direction'), direction);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-range-ticks')), rangeTicks);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-target-ticks')), targetTicks);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-default-price')), defaultTakeProfitPrice);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-adjusted-price')), adjustedTakeProfitPrice);
    assert.equal(await card5.getAttribute('data-take-profit-signal-line-start'), String(shown.startMs));
    assert.equal(await card5.getAttribute('data-take-profit-signal-entry-start'),
      entryStart === undefined ? '' : String(entryStart));
    assert.equal(await card5.getAttribute('data-take-profit-signal-risk-touch-start'),
      riskTouchStart === undefined ? '' : String(riskTouchStart));
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-line-start-index')), startIndex);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-entry-index')),
      entryOffset === undefined ? -1 : startIndex + entryOffset);
    assert.equal(Number(await card5.getAttribute('data-take-profit-signal-risk-touch-index')),
      riskTouchOffset === undefined ? -1 : startIndex + riskTouchOffset);
    assert.equal(await card5.getAttribute('data-take-profit-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-take-profit-line-style'), 'solid');
    assert.equal(await card5.getAttribute('data-take-profit-line-type'), 'with-steps');
    assert.equal(await card5.getAttribute('data-take-profit-line-color'), '#4fc3f7');
    assert.equal(await card5.getAttribute('data-take-profit-line-width'), '2');
    assert.equal(await card5.getAttribute('data-take-profit-line-auto-scale'), 'false');
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-default-price')), defaultTakeProfitPrice);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-adjusted-price')), adjustedTakeProfitPrice);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-tick')), 1);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-range-ticks')), rangeTicks);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-target-ticks')), targetTicks);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-point-count')), shown.count);
    assert.equal(await card5.getAttribute('data-take-profit-line-first-start'), String(shown.startMs));
    assert.equal(await card5.getAttribute('data-take-profit-line-last-start'), String(lastStart));
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-first-index')), startIndex);
    assert.equal(Number(await card5.getAttribute('data-take-profit-line-last-index')), startIndex + shown.count - 1);
    assert.deepEqual(JSON.parse(await card5.getAttribute('data-take-profit-line-values')), takeProfitValues);
    assert.equal(await card5.getAttribute('data-take-profit-line-switch-start'),
      riskTouchStart === undefined ? null : String(riskTouchStart));
    assert.equal(await card5.getAttribute('data-take-profit-line-switch-index'),
      riskTouchOffset === undefined ? null : String(startIndex + riskTouchOffset));

    assert.equal(await card5.getAttribute('data-true-entry-marker-count'), entryStart === undefined ? '0' : '1');
    if (entryStart === undefined) {
      assert.equal(await card5.getAttribute('data-true-entry-marker-id'), null);
      assert.equal(await card5.getAttribute('data-true-entry-marker-start'), null);
      assert.equal(await card5.getAttribute('data-true-entry-marker-direction'), null);
      assert.equal(await card5.getAttribute('data-true-entry-marker-position'), null);
    } else {
      assert.equal(await card5.getAttribute('data-true-entry-marker-id'),
        `true-entry-${direction}-${shown.startMs}-${entryStart}`);
      assert.equal(await card5.getAttribute('data-true-entry-marker-start'), String(entryStart));
      assert.equal(await card5.getAttribute('data-true-entry-marker-direction'), direction);
      assert.equal(await card5.getAttribute('data-true-entry-marker-position'), direction === 'long' ? 'belowBar' : 'aboveBar');
    }
    assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), riskTouchStart === undefined ? '0' : '1');
    if (riskTouchStart === undefined) {
      assert.equal(await card5.getAttribute('data-risk-touch-marker-id'), null);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-start'), null);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-direction'), null);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-position'), null);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-text'), null);
    } else {
      assert.equal(await card5.getAttribute('data-risk-touch-marker-id'),
        `take-profit-risk-touch-${direction}-${shown.startMs}-${riskTouchStart}`);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-start'), String(riskTouchStart));
      assert.equal(await card5.getAttribute('data-risk-touch-marker-direction'), direction);
      assert.equal(await card5.getAttribute('data-risk-touch-marker-position'),
        direction === 'long' ? 'belowBar' : 'aboveBar');
      assert.equal(await card5.getAttribute('data-risk-touch-marker-text'),
        `${direction === 'long' ? '触底' : '触顶'}${riskTouchStart === entryStart ? '·入场' : ''}`);
    }
    assert.equal(await card5.getAttribute('data-stop-trigger-marker-count'), null);
    assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
    assert.equal(await card5.getAttribute('data-position-size'), null);
    assert.equal(await card5.getAttribute('data-take-profit-price'), null);
    assert.deepEqual(JSON.parse(await card60.getAttribute('data-entry-marker-ids')), original60EntryMarkerIds);
    return {
      ...shown,
      rangeTicks,
      quarterTicks,
      stopTicks,
      targetTicks,
      base,
      price,
      stopPrice,
      defaultTakeProfitPrice,
      adjustedTakeProfitPrice,
      reactionStart,
      searchStart,
      entryStart,
      riskTouchStart,
      lastStart,
    };
  };
  for (const direction of ['long', 'short']) {
    await showScenario('immediate', direction);
    assert.equal(await card5.getAttribute('data-reaction-range-present'), 'true');
    assert.equal(await reactionOverlay.getAttribute('data-present'), 'true');
    assert.equal(await reactionOverlay.getAttribute('data-direction'), direction);
    assert.equal(await reactionOverlay.getAttribute('data-first-start'), String(scenarioStart));
    assert.equal(await reactionOverlay.getAttribute('data-last-start'), String(scenarioStart));
    assert.equal(await reactionOverlay.getAttribute('data-first-index'), String(scenarioIndex));
    assert.equal(await reactionOverlay.getAttribute('data-last-index'), String(scenarioIndex));
    assert.equal(await reactionOverlay.getAttribute('data-visible'), 'true');
    assert.ok((await reactionOverlay.boundingBox()).width > 0);
  }
  await showScenario('doji-then-reaction', 'long');
  assert.equal(await reactionOverlay.getAttribute('data-present'), 'true');
  assert.equal(await reactionOverlay.getAttribute('data-reaction-start'), String(five[scenarioIndex + 2].startMs));
  assert.equal(await reactionOverlay.getAttribute('data-last-index'), String(scenarioIndex + 2));
  assert.ok(Number(await reactionOverlay.getAttribute('data-first-index')) >= scenarioIndex);
  assert.ok(Number(await reactionOverlay.getAttribute('data-first-index')) < scenarioIndex + 2);
  await showScenario('no-reaction', 'short');
  assert.equal(await card5.getAttribute('data-reaction-range-present'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-present'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-visible'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-direction'), null);
  assert.equal(await reactionOverlay.isHidden(), true);
  assert.equal(await card5.getAttribute('data-observation-trigger-count'), '1');
  assert.equal(await card5.getAttribute('data-observation-follow-count'), '15');
  assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'true');
  await assertQuarterAbsent('false');
  await assertStopLossAbsent('false');
  await assertTakeProfitAbsent('false');

  await page.setViewportSize({ width: 1440, height: 900 }); await frame();
  for (const direction of ['long', 'short']) {
    await assertControlledQuarterScenario({ scenario: 'quarter-divisible', direction });
    await assertControlledQuarterScenario({ scenario: 'quarter-non-divisible', direction });
    const excluded = await assertControlledQuarterScenario({ scenario: 'quarter-reaction-excluded', direction });
    assert.ok(direction === 'long'
      ? excluded.base + 1 <= excluded.price && excluded.price <= excluded.base + excluded.rangeTicks
      : excluded.base <= excluded.price && excluded.price <= excluded.base + excluded.rangeTicks - 1);
    assert.equal(excluded.entryStart, five[scenarioIndex + 3].startMs);
    const wick = await assertControlledQuarterScenario({ scenario: 'quarter-wick-touch', direction });
    assert.equal(wick.entryStart, five[scenarioIndex + 2].startMs);
    const repeated = await assertControlledQuarterScenario({ scenario: 'quarter-repeated-touch', direction });
    assert.equal(repeated.entryStart, five[scenarioIndex + 2].startMs);
    assert.equal(await card5.getAttribute('data-true-entry-marker-count'), '1');
    const noTouch = await assertControlledQuarterScenario({ scenario: 'quarter-no-touch', direction });
    assert.equal(noTouch.entryStart, undefined);
    assert.equal(await card5.getAttribute('data-stop-loss-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-take-profit-line-visible'), 'true');
    assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), '0');
  }

  for (const direction of ['long', 'short']) {
    const entryTouch = await assertControlledQuarterScenario({ scenario: 'take-profit-entry-touch', direction });
    assert.equal(entryTouch.entryStart, five[scenarioIndex + 2].startMs);
    assert.equal(entryTouch.riskTouchStart, entryTouch.entryStart);
    const laterTouch = await assertControlledQuarterScenario({ scenario: 'take-profit-later-touch', direction });
    assert.equal(laterTouch.entryStart, five[scenarioIndex + 3].startMs);
    assert.equal(laterTouch.riskTouchStart, five[scenarioIndex + 5].startMs);
    assert.notEqual(laterTouch.riskTouchStart, five[scenarioIndex + 2].startMs);
    const repeatedTouch = await assertControlledQuarterScenario({ scenario: 'take-profit-repeated-touch', direction });
    assert.equal(repeatedTouch.entryStart, five[scenarioIndex + 2].startMs);
    assert.equal(repeatedTouch.riskTouchStart, five[scenarioIndex + 4].startMs);
    assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), '1');
    const noRiskTouch = await assertControlledQuarterScenario({ scenario: 'take-profit-no-touch', direction });
    assert.equal(noRiskTouch.entryStart, five[scenarioIndex + 2].startMs);
    assert.equal(noRiskTouch.riskTouchStart, undefined);
  }

  const assertControlledExitScenario = async ({ scenario, direction }) => {
    const shown = await showScenario(scenario, direction);
    const exitOffset = scenario === 'exit-no-touch' ? undefined : 4;
    const exitType = scenario === 'exit-take-profit' ? 'take-profit'
      : exitOffset === undefined ? undefined : 'stop-loss';
    const riskTouchOffset = scenario === 'exit-stop-loss' ? 3 : undefined;
    const expectedLineCount = exitOffset === undefined ? shown.count : exitOffset + 1;
    const expectedLineLastStart = five[scenarioIndex + (exitOffset ?? shown.count - 1)].startMs;
    const expectedExitStart = exitOffset === undefined ? undefined : five[scenarioIndex + exitOffset].startMs;
    const expectedRiskStart = riskTouchOffset === undefined ? undefined : five[scenarioIndex + riskTouchOffset].startMs;

    assert.equal(await card5.getAttribute('data-exit-analysis-present'), 'true');
    assert.equal(await card5.getAttribute('data-exit-signal-present'), String(exitOffset !== undefined));
    assert.equal(await card5.getAttribute('data-exit-marker-count'), exitOffset === undefined ? '0' : '1');
    assert.equal(await card5.getAttribute('data-quarter-line-point-count'), String(shown.count));
    assert.equal(await card5.getAttribute('data-quarter-line-last-start'),
      String(five[scenarioIndex + shown.count - 1].startMs));
    assert.equal(await card5.getAttribute('data-stop-loss-line-point-count'), String(expectedLineCount));
    assert.equal(await card5.getAttribute('data-stop-loss-line-last-start'), String(expectedLineLastStart));
    assert.equal(await card5.getAttribute('data-take-profit-line-point-count'), String(expectedLineCount));
    assert.equal(await card5.getAttribute('data-take-profit-line-last-start'), String(expectedLineLastStart));
    assert.equal(await card5.getAttribute('data-risk-touch-marker-count'), riskTouchOffset === undefined ? '0' : '1');
    assert.equal(await card5.getAttribute('data-risk-touch-marker-start'),
      expectedRiskStart === undefined ? null : String(expectedRiskStart));

    if (exitOffset === undefined) {
      for (const attribute of ['data-exit-signal-type', 'data-exit-signal-price', 'data-exit-signal-start',
        'data-exit-signal-index', 'data-exit-signal-granularity', 'data-exit-signal-line-end',
        'data-exit-marker-id', 'data-exit-marker-text', 'data-exit-marker-start', 'data-exit-marker-position']) {
        assert.equal(await card5.getAttribute(attribute), null);
      }
    } else {
      const expectedText = exitType === 'take-profit' ? '止盈出场' : '止损出场';
      const expectedPrice = direction === 'long'
        ? exitType === 'take-profit'
          ? Math.round(five[scenarioIndex].close / 20) * 20 + 33
          : Math.round(five[scenarioIndex].close / 20) * 20 - 9
        : exitType === 'take-profit'
          ? Math.round(five[scenarioIndex].close / 20) * 20 - 22
          : Math.round(five[scenarioIndex].close / 20) * 20 + 20;
      assert.equal(await card5.getAttribute('data-exit-signal-type'), exitType);
      assert.equal(Number(await card5.getAttribute('data-exit-signal-price')), expectedPrice);
      assert.equal(await card5.getAttribute('data-exit-signal-start'), String(expectedExitStart));
      assert.equal(Number(await card5.getAttribute('data-exit-signal-index')), scenarioIndex + exitOffset);
      assert.equal(await card5.getAttribute('data-exit-signal-granularity'), 'five-minute-fallback');
      assert.equal(await card5.getAttribute('data-exit-signal-line-end'),
        String(five[scenarioIndex + exitOffset].endMs));
      assert.match(await card5.getAttribute('data-exit-marker-id'), new RegExp(`^actual-exit-${exitType}-${direction}-`));
      assert.equal(await card5.getAttribute('data-exit-marker-text'), expectedText);
      assert.equal(await card5.getAttribute('data-exit-marker-start'), String(expectedExitStart));
      assert.equal(await card5.getAttribute('data-exit-marker-position'),
        direction === 'long'
          ? exitType === 'take-profit' ? 'aboveBar' : 'belowBar'
          : exitType === 'take-profit' ? 'belowBar' : 'aboveBar');
    }
    return { shown, exitOffset, exitType, expectedExitStart, expectedRiskStart };
  };

  for (const direction of ['long', 'short']) {
    const takeProfitExit = await assertControlledExitScenario({ scenario: 'exit-take-profit', direction });
    assert.equal(takeProfitExit.expectedExitStart, five[scenarioIndex + 4].startMs);
    const stopLossExit = await assertControlledExitScenario({ scenario: 'exit-stop-loss', direction });
    assert.equal(stopLossExit.expectedRiskStart, five[scenarioIndex + 3].startMs);
    const sameBarStop = await assertControlledExitScenario({ scenario: 'exit-stop-risk-same-bar', direction });
    assert.equal(sameBarStop.expectedRiskStart, undefined);
    assert.equal(await card5.getAttribute('data-risk-touch-marker-text'), null);
    const noExit = await assertControlledExitScenario({ scenario: 'exit-no-touch', direction });
    assert.equal(noExit.exitOffset, undefined);
  }

  await assertControlledExitScenario({ scenario: 'exit-take-profit', direction: 'long' });
  await assertControlledExitScenario({ scenario: 'exit-no-touch', direction: 'short' });
  assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
  assert.equal(await card5.getAttribute('data-exit-signal-present'), 'false');

  await assertControlledQuarterScenario({ scenario: 'take-profit-entry-touch', direction: 'long' });
  await page.mouse.move(10, 10); await frame();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-take-profit-entry-touch-long-1440.png') });
  await assertControlledQuarterScenario({ scenario: 'take-profit-later-touch', direction: 'short' });
  await page.mouse.move(10, 10); await frame();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-take-profit-later-touch-short-1440.png') });

  await assertControlledQuarterScenario({ scenario: 'quarter-non-divisible', direction: 'long' });
  await page.mouse.move(10, 10); await frame();
  await page.screenshot({ path: resolve('artifacts/entry-quarter-long-entry-1440.png') });
  await page.screenshot({ path: resolve('artifacts/entry-stop-loss-long-1440.png') });
  await assertControlledQuarterScenario({ scenario: 'quarter-no-touch', direction: 'short' });
  await page.mouse.move(10, 10); await frame();
  await page.screenshot({ path: resolve('artifacts/entry-quarter-short-no-entry-1440.png') });
  await page.screenshot({ path: resolve('artifacts/entry-stop-loss-short-1440.png') });

  const endScenarioIndex = five.length - 5;
  const shortened = await assertControlledQuarterScenario({
    scenario: 'quarter-non-divisible',
    direction: 'long',
    startIndex: endScenarioIndex,
  });
  assert.equal(shortened.count, 5);
  assert.equal(shortened.lastStart, five.at(-1).startMs);
  assert.equal(Number(await card5.getAttribute('data-stop-loss-line-point-count')), 5);
  assert.equal(await card5.getAttribute('data-stop-loss-line-last-start'), String(five.at(-1).startMs));
  assert.equal(Number(await card5.getAttribute('data-take-profit-line-point-count')), 5);
  assert.equal(await card5.getAttribute('data-take-profit-line-last-start'), String(five.at(-1).startMs));

  const autoscale = await assertControlledQuarterScenario({
    scenario: 'quarter-autoscale',
    direction: 'long',
    expectVisibleRange: false,
  });
  await page.waitForTimeout(100); await frame();
  const autoscalePriceRange = {
    from: Number(await card5.getAttribute('data-price-range-from')),
    to: Number(await card5.getAttribute('data-price-range-to')),
    span: Number(await card5.getAttribute('data-price-range-span')),
  };
  assert.ok(autoscalePriceRange.span < 1000, JSON.stringify({ autoscale, autoscalePriceRange }));
  assert.ok(autoscale.price > autoscalePriceRange.to + 5000, JSON.stringify({ autoscale, autoscalePriceRange }));
  assert.ok(autoscale.stopPrice > autoscalePriceRange.to + 5000, JSON.stringify({ autoscale, autoscalePriceRange }));
  assert.ok(autoscale.defaultTakeProfitPrice > autoscalePriceRange.to + 5000,
    JSON.stringify({ autoscale, autoscalePriceRange }));
  assert.equal(await card5.getAttribute('data-stop-loss-line-auto-scale'), 'false');
  assert.equal(await card5.getAttribute('data-take-profit-line-auto-scale'), 'false');
  await page.mouse.move(10, 10); await frame();
  await page.screenshot({ path: resolve('artifacts/entry-quarter-autoscale-1440.png') });
  await page.screenshot({ path: resolve('artifacts/entry-stop-loss-offscreen-1440.png') });

  await page.setViewportSize({ width: 1100, height: 720 }); await frame();
  await assertControlledQuarterScenario({ scenario: 'quarter-wick-touch', direction: 'short' });
  await page.mouse.move(10, 10); await frame();
  await page.screenshot({ path: resolve('artifacts/entry-quarter-short-entry-1100.png') });
  await page.screenshot({ path: resolve('artifacts/entry-stop-loss-short-1100.png') });
  await assertControlledQuarterScenario({ scenario: 'quarter-no-touch', direction: 'long' });
  await page.mouse.move(10, 10); await frame();
  await page.screenshot({ path: resolve('artifacts/entry-quarter-long-no-entry-1100.png') });
  await page.screenshot({ path: resolve('artifacts/entry-stop-loss-long-1100.png') });
  await assertControlledQuarterScenario({ scenario: 'take-profit-entry-touch', direction: 'short' });
  await page.mouse.move(10, 10); await frame();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-take-profit-entry-touch-short-1100.png') });
  await assertControlledQuarterScenario({ scenario: 'take-profit-later-touch', direction: 'long' });
  await page.mouse.move(10, 10); await frame();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-take-profit-later-touch-long-1100.png') });

  await page.evaluate(() => window.moneyComingTest.clearReactionScenario());
  await frame();
  assert.equal(await card5.getAttribute('data-selection-kind'), 'none');
  await assertLifecycleDiagnosticsAbsent(false);
  assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
  assert.equal(await card5.getAttribute('data-exit-signal-present'), null);
  assert.equal(await card5.getAttribute('data-exit-signal-line-end'), null);
  assert.equal(await reactionOverlay.getAttribute('data-present'), 'false');
  await assertQuarterAbsent(null);
  await assertStopLossAbsent(null);
  await assertTakeProfitAbsent(null);

  const entryParents = new Set(entries.map(entry => entry.parent.startMs));
  const normalParent = hours.find(parent => parent.start > '2026-03-01' && !entryParents.has(parent.startMs)
    && childrenFor(parent, five).length === parent.expected / 5);
  assert.ok(normalParent);
  await page.setViewportSize({ width: 1440, height: 900 }); await frame();
  await jump(normalParent.start.slice(0, 10));
  const normalPoint = await findParentPoint(normalParent);
  const normalChildren = childrenFor(normalParent, five);
  assert.equal(await linkedOverlay.getAttribute('data-count'), String(normalChildren.length));
  await page.mouse.click(normalPoint.x, normalPoint.box.y + normalPoint.box.height * .42);
  await frame();
  assert.equal(await html.getAttribute('data-selection-kind'), 'linked');
  assert.equal(await html.getAttribute('data-entry-direction'), null);
  assert.equal(await html.getAttribute('data-entry-pullback-line'), null);
  assert.equal(await html.getAttribute('data-entry-selection-source'), null);
  assert.equal(await card5.getAttribute('data-selection-kind'), 'linked');
  await assertLifecycleDiagnosticsAbsent();
  assert.equal(await card5.getAttribute('data-selected-count'), String(normalChildren.length));
  assert.equal(await card5.getAttribute('data-linked-marker-count'), String(normalChildren.length));
  assert.equal(await card5.getAttribute('data-observation-trigger-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-follow-count'), '0');
  assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'false');
  assert.equal(await card5.getAttribute('data-pullback-line-value'), null);
  assert.equal(await card5.getAttribute('data-pullback-line-point-count'), null);
  assert.equal(await card5.getAttribute('data-pullback-line-values'), null);
  assert.equal(await card5.getAttribute('data-pullback-line-first-value'), null);
  assert.equal(await card5.getAttribute('data-pullback-line-last-value'), null);
  assert.equal(await card5.getAttribute('data-reaction-range-present'), null);
  assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
  assert.equal(await card5.getAttribute('data-exit-signal-present'), null);
  assert.equal(await card5.getAttribute('data-exit-signal-line-end'), null);
  assert.equal(await reactionOverlay.getAttribute('data-present'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-visible'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-direction'), null);
  assert.equal(await reactionOverlay.isHidden(), true);
  await assertQuarterAbsent(null);
  await assertStopLossAbsent(null);
  await assertTakeProfitAbsent(null);
  assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
  assert.equal(await card5.getAttribute('data-exit-signal-present'), null);
  assert.equal(await card5.getAttribute('data-exit-signal-line-end'), null);
  assert.deepEqual(JSON.parse(await card60.getAttribute('data-entry-marker-ids')), original60EntryMarkerIds);

  await page.locator('#instrument').evaluate(element => element.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction(() => document.querySelector('#card-5')?.dataset.selectionKind === 'linked');
  await frame();
  await assertQuarterAbsent(null);
  await assertStopLossAbsent(null);
  await assertTakeProfitAbsent(null);
  assert.deepEqual(JSON.parse(await card60.getAttribute('data-entry-marker-ids')), original60EntryMarkerIds);

  await clickBody(longEntry, five, 32);
  await page.getByTestId('latest').click(); await frame();
  assert.equal(await card5.getAttribute('data-selection-kind'), 'none');
  await assertLifecycleDiagnosticsAbsent();
  assert.equal(await card5.getAttribute('data-selected-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-trigger-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-follow-count'), '0');
  assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'false');
  assert.equal(await card5.getAttribute('data-pullback-line-values'), null);
  assert.equal(await reactionOverlay.getAttribute('data-present'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-visible'), 'false');
  assert.equal(await reactionOverlay.getAttribute('data-direction'), null);
  assert.equal(await html.getAttribute('data-selection-kind'), null);
  assert.equal(await html.getAttribute('data-entry-direction'), null);
  assert.equal(await html.getAttribute('data-entry-pullback-line'), null);
  assert.equal(await card5.getAttribute('data-exit-marker-count'), '0');
  assert.equal(await card5.getAttribute('data-exit-signal-present'), null);
  assert.equal(await card5.getAttribute('data-exit-signal-line-end'), null);
  await assertQuarterAbsent(null);
  await assertStopLossAbsent(null);
  await assertTakeProfitAbsent(null);
  assert.deepEqual(JSON.parse(await card60.getAttribute('data-entry-marker-ids')), original60EntryMarkerIds);

  report.observations = {
    long: { trigger: longEntry.child.start, nonTouchingFollowBars: longSelection.observation.nonTouchingFollowBars,
      lineDistinctValues: longSelection.observation.lineDistinctValues, reactionOffset: longSelection.observation.reaction.reactionOffset },
    short: { trigger: shortEntry.child.start, nonTouchingFollowBars: shortSelection.observation.nonTouchingFollowBars,
      lineDistinctValues: shortSelection.observation.lineDistinctValues, reactionOffset: shortSelection.observation.reaction.reactionOffset },
    normal: { parent: normalParent.start, children: normalChildren.length },
    edgeScenarios: [
      'immediate-long',
      'immediate-short',
      'doji-then-reaction',
      'no-reaction',
      'quarter-divisible-long-short',
      'quarter-non-divisible-long-short',
      'quarter-reaction-excluded-long-short',
      'quarter-wick-touch-long-short',
      'quarter-repeated-touch-long-short',
      'quarter-no-touch-long-short',
      'quarter-autoscale-long',
      'stop-loss-long-short',
      'stop-loss-no-entry',
      'stop-loss-shortened-window',
      'stop-loss-autoscale-isolation',
      'take-profit-entry-touch-long-short',
      'take-profit-later-touch-long-short',
      'take-profit-repeated-touch-long-short',
      'take-profit-no-touch-long-short',
      'take-profit-shortened-window',
      'take-profit-autoscale-isolation',
      'exit-take-profit-long-short',
      'exit-stop-loss-long-short',
      'exit-stop-risk-same-bar-long-short',
      'exit-no-touch-long-short',
    ],
    datasetEndObservationCount: shortened.count,
    sixtyMinuteMarkerIdsStable: true,
  };

  await page.getByTestId('entry-rules').click(); await page.locator('#rules-dialog[open]').waitFor();
  assert.match(await page.locator('#rules-content').innerText(), /反向突破[\s\S]*同一5分钟极端情况/);
  assert.match(await page.locator('#rules-content').innerText(), /rangeTicks = round[\s\S]*多头白线为3023，空头白线为3028/);
  assert.match(await page.locator('#rules-content').innerText(), /不再以“触发K线及后续15根”为分析上限[\s\S]*14:45或22:45开始及之后的K线禁止新入场/);
  assert.match(await page.locator('#rules-content').innerText(), /以该根5分钟K线收盘价生成唯一的“休市出场”[\s\S]*初始5分钟视口仍只使用触发附近最多16根的紧凑范围/);
  assert.match(await page.locator('#rules-content').innerText(), /首次方向反应K线的下一根5分钟K线[\s\S]*四分之一白线首次合格触碰即真正入场/);
  assert.match(await page.locator('#rules-content').innerText(), /stopTicks = ceil\(rangeTicks × 0\.75\)[\s\S]*多头止损为3011，空头止损为3040/);
  assert.match(await page.locator('#rules-content').innerText(), /明黄色实线[\s\S]*不参与价格轴自动缩放/);
  assert.match(await page.locator('#rules-content').innerText(), /targetTicks = rangeTicks × 2[\s\S]*多头默认止盈为3053，空头默认止盈为2998/);
  assert.match(await page.locator('#rules-content').innerText(), /第一根触碰白色入场线的1分钟K线开始持仓检测[\s\S]*该分钟之前发生的风险侧、止盈或止损触碰全部忽略/);
  assert.match(await page.locator('#rules-content').innerText(), /多头首次满足[\s\S]*空头首次满足[\s\S]*后续重复触碰不再调整目标/);
  assert.match(await page.locator('#rules-content').innerText(), /#4fc3f7[\s\S]*2像素亮蓝色阶梯实线[\s\S]*两条计划线都不参与价格轴自动缩放/);
  assert.match(await page.locator('#rules-content').innerText(), /后台1分钟数据[\s\S]*不显示1分钟图表、周期按钮或可见数据面板/);
  assert.match(await page.locator('#rules-content').innerText(), /恰好对应5根唯一、连续、有序的1分钟K线[\s\S]*只对该根使用5分钟保守规则[\s\S]*下一根5分钟K线重新独立验证/);
  assert.match(await page.locator('#rules-content').innerText(), /入场与止损同单元发生则确认入场后立即止损[\s\S]*持仓后止损与任何其他事件同单元发生时止损优先/);
  assert.match(await page.locator('#rules-content').innerText(), /只记录第一处“止盈出场”“止损出场”或“休市出场”[\s\S]*立即结束本次生命周期/);
  assert.match(await page.locator('#rules-content').innerText(), /完整1分钟证据优先[\s\S]*止盈或止损优先于休市出场/);
  assert.match(await page.locator('#rules-content').innerText(), /止盈线与止损线共用生命周期终点[\s\S]*截止到终点5分钟K线并包含该根/);
  assert.match(await page.locator('#rules-content').innerText(), /白色四分之一入场指标线[\s\S]*都使用同一个生命周期终点/);
  assert.match(await page.locator('#rules-meta').innerText(), /修改文字不会自动改变标记算法/);
  assert.equal(await page.locator('#rules-content script').count(), 0);
  assert.equal(await page.locator('[data-mode="1"], #card-1').count(), 0);
  await page.screenshot({ path: resolve('artifacts/entry-rules.png') });
  await page.getByRole('button', { name: '知道了' }).last().click();
  await page.getByTestId('toggle-monday').click();
  assert.equal(await card60.getAttribute('data-entry-long-count'), '0');
  assert.equal(await card60.locator('.entry-info').isVisible(), false);
  assert.deepEqual(errors, []); report.passed = true;
  report.offscreen = { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow };
  await writeFile('artifacts/entry-markers.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await app.close(); }
