import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const parse = async (instrument, period) => (await readFile(`futures_investigation_20261009/edb_${instrument}_${period}m.csv`, 'utf8')).trim().split(/\r?\n/).slice(1).map(line => {
  const c = line.split(',');
  return { start: c[0], end: c[1], startMs: Date.parse(c[0].replace(' ', 'T') + '+08:00'), endMs: Date.parse(c[1].replace(' ', 'T') + '+08:00'),
    high: +c[4], low: +c[5], close: +c[6], expected: +c[11], complete: c[12] === 'True' };
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
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env });
const report = { packaged: !!executablePath, instruments: {}, observations: {}, passed: false };
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  await page.locator('html[data-ready="true"]').waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const html = page.locator('html');
  const card60 = page.locator('#card-60');
  const card5 = page.locator('#card-5');
  const linkedOverlay = page.getByTestId('linked-hover-range');
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
    return { index, bars: five.slice(index, index + 16) };
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
    const observation = observationFor(entry, five);
    const lastIndex = observation.index + observation.bars.length - 1;
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
    assert.match(await page.locator('.selection-label').innerText(), /入场观察/);
    const selectionText = await page.locator('#selection-text').innerText();
    assert.match(selectionText, entry.direction === 'long' ? /多头/ : /空头/);
    assert.ok(selectionText.includes(entry.child.start.slice(0, 16)), selectionText);
    assert.match(selectionText, /回调线/);
    assert.ok(selectionText.includes(`${observation.bars.length} 根 5 分钟`), selectionText);
    const range = await chartRange(5);
    const expectedSpan = Math.min(five.length, Math.max(sourceSpan, observation.bars.length + 4));
    assert.ok(Math.abs(range.span - expectedSpan) < .05, JSON.stringify({ sourceSpan, expectedSpan, range }));
    assert.ok(range.from <= observation.index - .5 && range.to >= lastIndex + .5, JSON.stringify({ range, observation, lastIndex }));
    const nonTouchingFollowBars = observation.bars.slice(1).filter(bar => !(bar.low <= entry.line && entry.line <= bar.high));
    assert.ok(nonTouchingFollowBars.length > 0, `${entry.direction} fixture must prove follow bars are not price-filtered`);
    return { ...observation, nonTouchingFollowBars: nonTouchingFollowBars.length, range,
      lineDistinctValues: new Set(expectedLine.map(value => value.toFixed(8))).size };
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
  for (const instrument of ['main_continuous', 'm2701']) {
    const expected = await expectedFor(instrument);
    oracle[instrument] = expected;
    await page.getByTestId('instrument').selectOption(instrument);
    await page.locator(`html[data-instrument="${instrument}"]`).waitFor();
    const long = expected.entries.filter(entry => entry.direction === 'long').length;
    const short = expected.entries.filter(entry => entry.direction === 'short').length;
    assert.equal(await card60.getAttribute('data-entry-long-count'), String(long));
    assert.equal(await card60.getAttribute('data-entry-short-count'), String(short));
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
  }

  await page.getByTestId('instrument').selectOption('main_continuous');
  await page.locator('html[data-instrument="main_continuous"]').waitFor();
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
  await page.mouse.move(10, 10); await frame();
  await mkdir('artifacts', { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve('artifacts/entry-observation-long-1440.png') });
  const markerSelection = await clickConcreteMarker(longEntry, five);
  assert.equal(markerSelection.bars.length, 16);

  const shortSelection = await clickBody(shortEntry, five, 10);
  assert.ok(shortSelection.span < 20, `Expected a source span below the 20-bar observation minimum, got ${shortSelection.span}`);
  assert.ok(Math.abs(shortSelection.observation.range.span - 20) < .05);
  await page.setViewportSize({ width: 1100, height: 720 }); await frame();
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  const narrowFirst = Number(await card5.getAttribute('data-selection-first-index'));
  const narrowLast = Number(await card5.getAttribute('data-selection-last-index'));
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

  await clickBody(longEntry, five, 32);
  const leftCounts = {
    long: await card60.getAttribute('data-entry-long-count'),
    short: await card60.getAttribute('data-entry-short-count'),
  };
  await page.getByTestId('instrument').selectOption('m2701');
  await page.locator('html[data-instrument="m2701"]').waitFor(); await frame();
  assert.notEqual(await card5.getAttribute('data-selection-kind'), 'entry');
  assert.equal(await card5.getAttribute('data-observation-trigger-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-follow-count'), '0');
  assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'false');
  assert.equal(await card5.getAttribute('data-pullback-line-values'), null);
  assert.equal(await html.getAttribute('data-entry-direction'), null);
  assert.equal(await html.getAttribute('data-entry-pullback-line'), null);
  await page.getByTestId('instrument').selectOption('main_continuous');
  await page.locator('html[data-instrument="main_continuous"]').waitFor(); await frame();
  assert.deepEqual({
    long: await card60.getAttribute('data-entry-long-count'),
    short: await card60.getAttribute('data-entry-short-count'),
  }, leftCounts);
  await clickBody(longEntry, five, 32);
  await page.getByTestId('latest').click(); await frame();
  assert.equal(await card5.getAttribute('data-selection-kind'), 'none');
  assert.equal(await card5.getAttribute('data-selected-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-trigger-count'), '0');
  assert.equal(await card5.getAttribute('data-observation-follow-count'), '0');
  assert.equal(await card5.getAttribute('data-pullback-line-visible'), 'false');
  assert.equal(await card5.getAttribute('data-pullback-line-values'), null);
  assert.equal(await html.getAttribute('data-selection-kind'), null);
  assert.equal(await html.getAttribute('data-entry-direction'), null);
  assert.equal(await html.getAttribute('data-entry-pullback-line'), null);

  report.observations = {
    long: { trigger: longEntry.child.start, nonTouchingFollowBars: longSelection.observation.nonTouchingFollowBars,
      lineDistinctValues: longSelection.observation.lineDistinctValues },
    short: { trigger: shortEntry.child.start, nonTouchingFollowBars: shortSelection.observation.nonTouchingFollowBars,
      lineDistinctValues: shortSelection.observation.lineDistinctValues },
    normal: { parent: normalParent.start, children: normalChildren.length },
    datasetEndUnitCoverage: true,
  };

  await page.getByTestId('entry-rules').click(); await page.locator('#rules-dialog[open]').waitFor();
  assert.match(await page.locator('#rules-content').innerText(), /反向突破[\s\S]*同一5分钟极端情况/);
  assert.match(await page.locator('#rules-meta').innerText(), /修改文字不会自动改变标记算法/);
  assert.equal(await page.locator('#rules-content script').count(), 0);
  await page.screenshot({ path: resolve('artifacts/entry-rules.png') });
  await page.getByRole('button', { name: '知道了' }).last().click();
  await page.getByTestId('toggle-monday').click();
  assert.equal(await card60.getAttribute('data-entry-long-count'), '0');
  assert.equal(await card60.locator('.entry-info').isVisible(), false);
  assert.deepEqual(errors, []); report.passed = true;
  await writeFile('artifacts/entry-markers.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await app.close(); }
