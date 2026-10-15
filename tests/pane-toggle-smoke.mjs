import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MONEYCOMING_EXE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'pane-toggle-before-show');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'pane-toggle-after-show');
  await page.locator('html[data-ready="true"]').waitFor();
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const heights = () => page.locator('#canvas-60 canvas').evaluateAll(nodes => [...new Set(nodes.map(n => n.getBoundingClientRect()).filter(r => r.width > 100 && r.height > 30).map(r => r.height))]);
  const before = Math.max(...await heights());
  const button = page.getByTestId('toggle-subcharts');
  assert.equal(await button.count(), 1, 'toolbar must offer the subchart toggle');
  await button.click();
  await frames();
  assert.equal(await button.innerText(), '显示副图');
  assert.equal(await page.locator('#card-60 .volume-label').isVisible(), false);
  assert.equal(await page.locator('#card-5 .oi-label').isVisible(), false);
  assert.ok(Math.max(...await heights()) > before * 1.3, 'price pane must reclaim removed pane space');
  await page.getByTestId('date-input').fill('2026-02-02');
  await page.getByTestId('date-jump').click();
  const selected = await page.locator('html').getAttribute('data-selected-start');
  await page.getByTestId('mode-60').click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selected);
  assert.equal(await page.locator('#card-60 .volume-label').isVisible(), false);
  await page.mouse.move(5, 5);
  await frames();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/candles-only.png') });
  for (let i = 0; i < 3; i++) {
    await button.click(); await frames();
    assert.equal(await page.locator('#card-60 .volume-label').isVisible(), true);
    assert.equal(await page.locator('#card-60 .oi-label').isVisible(), true);
    assert.equal(await page.locator('html').getAttribute('data-selected-start'), selected);
    await button.click(); await frames();
  }
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click();
  await frames();
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve('artifacts/candles-only-dual-1100.png') });
  await button.click(); await frames();
  assert.equal(await page.locator('#card-5 .volume-label').isVisible(), true);
  assert.ok(Math.max(...await heights()) > 50);
  await page.screenshot({ path: resolve('artifacts/subcharts-restored.png') });
  assert.deepEqual(errors, []);
  await writeFile('artifacts/pane-toggle.json', JSON.stringify({
    packaged: !!executablePath,
    offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow },
    passed: true,
    errors,
  }, null, 2));
  console.log('Subchart toggle: passed');
} finally { await app.close(); }
