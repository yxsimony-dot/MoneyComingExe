import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

// Independent oracle: group calendar weeks first, then compare each bar against
// the entire preceding prefix. Production uses a single running scan.
async function expectedFor(instrument) {
  const csv = await readFile(`futures_investigation_20261009/edb_${instrument}_60m.csv`, 'utf8');
  const rows = csv.trim().split(/\r?\n/).slice(1).map(line => {
    const c = line.split(',');
    return { start: c[0], startMs: Date.parse(c[0].replace(' ', 'T') + '+08:00'), high: +c[4], low: +c[5] };
  });
  const weeks = new Map();
  for (const bar of rows) {
    const localDate = new Date(bar.start.slice(0, 10) + 'T00:00:00Z');
    const day = localDate.getUTCDay();
    localDate.setUTCDate(localDate.getUTCDate() - (day + 6) % 7);
    const week = localDate.toISOString().slice(0, 10);
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week).push(bar);
  }
  const results = [];
  for (const [week, bars] of weeks) {
    if (!bars[0].start.startsWith(week)) continue;
    for (let i = 8; i < bars.length; i++) {
      const previousHigh = Math.max(...bars.slice(0, i).map(b => b.high));
      const previousLow = Math.min(...bars.slice(0, i).map(b => b.low));
      if (bars[i].high > previousHigh) results.push({ ...bars[i], direction: 'up', previous: previousHigh, value: bars[i].high });
      if (bars[i].low < previousLow) results.push({ ...bars[i], direction: 'down', previous: previousLow, value: bars[i].low });
    }
  }
  return results;
}

const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MONEYCOMING_EXE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [], cwd: process.env.TEMP } : { args: ['.'] }), env });
const errors = [];
const report = { packaged: !!executablePath, instruments: {}, passed: false };
try {
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'weekly-breakout-before-show');
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'weekly-breakout-after-show');
  await page.locator('html[data-ready="true"]').waitFor();
  const toggle = page.getByTestId('toggle-monday');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#card-60').getAttribute('data-breakout-up-count'), '0');
  await toggle.click();
  await page.getByTestId('mode-60').click();
  const instrument = 'main_continuous';
  const expected = await expectedFor(instrument);
    const up = expected.filter(b => b.direction === 'up').length;
    const down = expected.filter(b => b.direction === 'down').length;
    assert.equal(await page.locator('#card-60').getAttribute('data-breakout-up-count'), String(up));
    assert.equal(await page.locator('#card-60').getAttribute('data-breakout-down-count'), String(down));
    assert.equal(await page.locator('#card-5').getAttribute('data-breakout-up-count'), '0');
    assert.equal(await page.locator('#card-5').getAttribute('data-breakout-down-count'), '0');
  report.instruments[instrument] = { up, down };
    // Check two opposite signals through actual mouse hover on canvas.
    for (const direction of ['up', 'down']) {
      const candidate = expected.find(b => b.direction === direction && b.start > '2026-03-01');
      assert.ok(candidate);
      await page.getByTestId('date-input').fill(candidate.start.slice(0, 10));
      await page.getByTestId('date-jump').click();
      await frame();
      const box = await page.locator('#canvas-60').boundingBox();
      let found = false;
      for (let x = 3; x < box.width - 66; x += 4) {
        await page.mouse.move(box.x + x, box.y + 45);
        await frame();
        const state = await page.locator('#card-60').evaluate(card => ({ start: card.dataset.hoverStart, info: card.querySelector('.breakout-info').textContent, time: card.querySelector('.detail-time').textContent }));
        if (state.start !== String(candidate.startMs)) continue;
        const info = state.info;
        assert.ok(info.includes(direction === 'up' ? '新高' : '新低'), JSON.stringify({ instrument, candidate, state }));
        assert.ok(info.includes(String(candidate.previous)) && info.includes(String(candidate.value)), info);
        found = true; break;
      }
      assert.ok(found, `Hover ${instrument} ${candidate.start}`);
    }
  await page.getByTestId('toggle-subcharts').click();
  await page.getByTestId('date-input').fill('2026-09-07');
  await page.getByTestId('date-jump').click();
  await page.mouse.move(30, 30);
  await frame();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/weekly-breakouts.png') });
  const selected = await page.locator('html').getAttribute('data-selected-start');
  await toggle.click();
  assert.equal(await page.locator('#card-60').getAttribute('data-breakout-up-count'), '0');
  assert.equal(await page.locator('#card-60').getAttribute('data-breakout-down-count'), '0');
  assert.equal(await page.locator('#card-60 .breakout-info').isVisible(), false);
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), selected);
  await toggle.click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.getByTestId('mode-dual').click();
  await page.getByTestId('date-jump').click();
  await frame();
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve('artifacts/weekly-breakouts-dual-1100.png') });
  assert.deepEqual(errors, []);
  report.offscreen = { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow };
  report.passed = true;
  await writeFile('artifacts/weekly-breakouts.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await app.close(); }
