import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MONEYCOMING_EXE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env });
const report = { packaged: !!executablePath, instruments: {}, passed: false };
try {
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'ema-smoke-before-show');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'ema-smoke-after-show');
  await page.locator('html[data-ready="true"]').waitFor();
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#card-60 [data-value="ema20"]').count(), 1);
  assert.equal(await page.locator('#card-5 [data-value="ema20"]').count(), 0);
  const instrument = 'main_continuous';
  const loaded = await page.evaluate(i => window.market.load(i), instrument);
  assert.ok(loaded.ok);
  const bars = loaded.data.bars60;
    // Independent closed-form expansion, not the production recurrence.
    const expected = index => bars[0].close * (19 / 21) ** index + bars.slice(1, index + 1).reduce((sum, b, j) => sum + (2 / 21) * b.close * (19 / 21) ** (index - j - 1), 0);
    const checkReadout = async () => {
      const state = await page.locator('#card-60').evaluate(card => ({ start: +card.dataset.hoverStart, text: card.querySelector('[data-value="ema20"]').textContent, count: +card.dataset.emaCount }));
      const index = bars.findIndex(b => b.startMs === state.start);
      assert.ok(index >= 0);
      assert.equal(state.count, bars.length);
      assert.ok(Math.abs(Number(state.text.replaceAll(',', '')) - expected(index)) < 0.006, JSON.stringify(state));
      return state;
    };
    await page.getByTestId('latest').click();
    await page.mouse.move(5, 5); await frame();
    const latest = await checkReadout();
    await page.getByTestId('date-input').fill('2020-01-01');
    await page.getByTestId('date-jump').click();
    await page.mouse.move(5, 5); await frame();
    assert.equal((await checkReadout()).start, bars[0].startMs);
    await page.getByTestId('date-input').fill('2026-09-07');
    await page.getByTestId('date-jump').click();
    await page.mouse.move(5, 5); await frame();
    await checkReadout();
    await page.getByTestId('mode-60').click(); await frame();
    const box = await page.locator('#canvas-60').boundingBox();
    for (const fraction of [0.3, 0.5, 0.7]) {
      await page.mouse.move(box.x + box.width * fraction, box.y + 50);
      await frame(); await checkReadout();
    }
    await page.mouse.move(5, 5);
    for (const control of ['toggle-subcharts', 'toggle-monday', 'toggle-subcharts', 'toggle-monday']) {
      await page.getByTestId(control).click(); await frame(); await checkReadout();
    }
  report.instruments[instrument] = latest;
  await mkdir('artifacts', { recursive: true });
  await page.getByTestId('toggle-subcharts').click();
  await page.getByTestId('toggle-monday').click();
  await frame();
  await page.screenshot({ path: 'artifacts/ema20-single.png' });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click(); await frame();
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  const ohlcFits = await page.locator('#card-60 .ohlc').evaluate(node => node.scrollWidth <= node.clientWidth);
  assert.ok(ohlcFits, 'OHLC and EMA readout must fit at 1100px');
  await page.screenshot({ path: 'artifacts/ema20-dual-1100.png' });
  assert.deepEqual(errors, []);
  report.offscreen = { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow };
  report.passed = true;
  await writeFile('artifacts/ema20.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await app.close(); }
