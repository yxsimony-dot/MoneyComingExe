import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MONEYCOMING_EXE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'monday-highlight-before-show');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'monday-highlight-after-show');
  await page.locator('html[data-ready="true"]').waitFor();
  const toggle = page.getByTestId('toggle-monday');
  assert.equal(await toggle.count(), 1);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  const card60 = page.locator('#card-60');
  assert.equal(await card60.getAttribute('data-monday-count'), '0');
  assert.equal(await card60.locator('.monday-legend').isVisible(), false);
  assert.equal(await page.getByTestId('axis-reset-60').count(), 1);
  assert.equal(await page.getByTestId('axis-reset-5').count(), 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const beforeToggle = {
    from: Number(await card60.getAttribute('data-visible-from')),
    to: Number(await card60.getAttribute('data-visible-to')),
    priceSpan: Number(await card60.getAttribute('data-price-range-span')),
  };
  await toggle.click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterToggle = {
    from: Number(await card60.getAttribute('data-visible-from')),
    to: Number(await card60.getAttribute('data-visible-to')),
    priceSpan: Number(await card60.getAttribute('data-price-range-span')),
  };
  assert.ok(Math.abs(afterToggle.from - beforeToggle.from) < 0.01, JSON.stringify({ beforeToggle, afterToggle }));
  assert.ok(Math.abs(afterToggle.to - beforeToggle.to) < 0.01, JSON.stringify({ beforeToggle, afterToggle }));
  assert.ok(afterToggle.priceSpan <= beforeToggle.priceSpan * 1.05, JSON.stringify({ beforeToggle, afterToggle }));
  await page.getByTestId('axis-reset-60').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await card60.getAttribute('data-price-auto-scale'), 'true');
  await page.getByTestId('mode-60').click();
  await page.getByTestId('date-input').fill('2026-02-02');
  await page.getByTestId('date-jump').click();
  const selectedStart = await page.locator('html').getAttribute('data-selected-start');
  await toggle.click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedStart);
  assert.equal(await page.locator('#card-60').getAttribute('data-monday-count'), '0');
  await toggle.click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selectedStart);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mondayCount = Number(await page.locator('#card-60').getAttribute('data-monday-count'));
  assert.equal(mondayCount, 376);
  assert.equal(await page.locator('#card-5').getAttribute('data-monday-count'), '0');
  assert.match(await page.locator('.monday-legend').first().innerText(), /● 周一前8根/);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/monday-first-eight-60m.png') });
  await page.getByTestId('latest').click();
  assert.equal(Number(await page.locator('#card-60').getAttribute('data-monday-count')), mondayCount);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#card-60').getAttribute('data-monday-count'), '0');
  assert.equal(await page.locator('#card-60 .monday-legend').isVisible(), false);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click();
  await page.screenshot({ path: resolve('artifacts/monday-toggle-off.png') });
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  const result = {
    packaged: !!executablePath,
    mondayCount,
    fiveMinuteCount: 0,
    offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow },
    passed: true,
  };
  await writeFile('artifacts/monday-highlight.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
