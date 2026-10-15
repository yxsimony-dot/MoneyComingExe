import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  assertElectronWindowOffscreen,
  negativeCoordinateGeometryFixture,
} from './electron-offscreen.mjs';

const output = resolve('artifacts');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const started = performance.now();
const executablePath = process.env.MONEYCOMING_EXE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env, timeout: 30000 });
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
  await page.locator('html[data-ready="true"]').waitFor();
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
  assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
  assert.equal(await page.locator('#card-60').getAttribute('data-monday-count'), '0');
  assert.equal(await page.locator('#card-5').getAttribute('data-monday-count'), '0');
  assert.match(await page.locator('.monday-legend').first().innerText(), /● 周一前8根/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'disabled');
  assert.equal(await page.locator('#app-version').innerText(), `v${manifest.version}`);
  assert.equal(await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return false;
    } catch {
      return true;
    }
  }), true);
  assert.equal((await page.evaluate(() => window.market.load('../../secret'))).ok, false);
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
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const jump = async date => {
    await page.getByTestId('date-input').fill(date);
    await page.getByTestId('date-jump').click();
    await frame();
  };
  await jump('2020-01-01');
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), String(Date.parse('2025-10-09T21:00:00+08:00')));
  assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
  assert.deepEqual(await page.getByTestId('instrument').locator('option').allTextContents(), ['豆粕主连']);
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
  assert.equal(await page.locator('html').getAttribute('data-child-count'), '9');
  await page.getByTestId('latest').click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), null);
  // Locate real candles through the visible crosshair, not a test-only chart API.
  await page.setViewportSize({ width: 1440, height: 900 });
  await jump('2026-02-05');
  const sourceRows = readFileSync('futures_investigation_20261009/edb_main_continuous_60m.csv', 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(','));
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
  await hoverParent('2026-02-05 09:00:00');
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
  assert.equal(await linkedOverlay.getAttribute('data-count'), '12');
  assert.equal(await linkedOverlay.getAttribute('data-first-start'), String(Date.parse('2026-02-05T09:00:00+08:00')));
  assert.equal(await linkedOverlay.getAttribute('data-last-start'), String(Date.parse('2026-02-05T09:55:00+08:00')));
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
  } else {
    assert.equal(await page.locator('#card-5').getAttribute('data-selected-count'), '12');
  }
  assert.deepEqual(await chartRange(60), leftBeforeHover);
  assert.deepEqual(await chartRange(5), rightBeforeHover);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(output, 'linked-hover-1440.png') });

  const dualOverlayRect = await linkedOverlay.boundingBox();
  await page.setViewportSize({ width: 1100, height: 720 });
  await frame();
  assert.equal(await linkedOverlay.getAttribute('data-visible'), 'true');
  assert.equal(await linkedOverlay.getAttribute('data-count'), '12');
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
  assert.equal(await linkedOverlay.getAttribute('data-count'), '12');
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
  const zoomed = await zoomLeftTo('2026-02-05 10:00:00', 34);
  assert.ok(zoomed.span >= 16 && zoomed.span <= 45, `Expected roughly 30 visible 60m bars, got ${zoomed.span}`);
  await page.mouse.click(zoomed.point.x, zoomed.point.y);
  await frame();
  const linkedSpan = (await chartRange(5)).span;
  assert.ok(Math.abs(linkedSpan - Math.max(zoomed.span, 16)) < .05, `Expected linked span ${zoomed.span}, got ${linkedSpan}`);
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
  } else {
    assert.equal(await page.locator('#card-5').getAttribute('data-selected-count'), '12');
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

  const tightlyZoomed = await zoomLeftTo('2026-02-05 10:00:00', 9);
  assert.ok(tightlyZoomed.span < 12);
  await page.mouse.click(tightlyZoomed.point.x, tightlyZoomed.point.y);
  await frame();
  assert.ok(Math.abs((await chartRange(5)).span - 16) < .05);
  const tightRange = await chartRange(5);
  assert.ok(tightRange.from <= Number(await linkedOverlay.getAttribute('data-first-index')) - .5);
  assert.ok(tightRange.to >= Number(await linkedOverlay.getAttribute('data-last-index')) + .5);

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
  assert.ok(Math.abs((await chartRange(5)).to - 16530) < .05);

  await jump('2026-02-05');
  for (const [time, count] of [['10:00:00', 12], ['11:15:00', 12], ['14:15:00', 9]]) {
    await clickParent('2026-02-05 ' + time, count);
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
} finally { await app.close(); }
