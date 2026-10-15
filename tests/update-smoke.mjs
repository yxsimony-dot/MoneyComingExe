import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const output = resolve('artifacts');
await mkdir(output, { recursive: true });

async function launch(mode) {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_UPDATER: '1',
    MONEYCOMING_TEST_UPDATE_MODE: mode,
    MONEYCOMING_TEST_UPDATE_VERSION: '1.0.1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, timeout: 30000 });
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, `update-${mode}-before-show`);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, `update-${mode}-after-show`);
  await page.locator('html[data-ready="true"]').waitFor();
  return { app, page, offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow } };
}

const offscreenScenarios = [];
{
  const { app, page, offscreen } = await launch('available');
  offscreenScenarios.push({ mode: 'available', ...offscreen });
  try {
    await page.locator('html[data-update-phase="available"]').waitFor();
    assert.equal(await page.getByTestId('update-dialog').isVisible(), true);
    assert.equal(await page.locator('#update-current').innerText(), 'v1.0.0');
    assert.equal(await page.locator('#update-target').innerText(), 'v1.0.1');
    assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);

    await page.locator('#update-later').click();
    assert.equal(await page.getByTestId('update-dialog').isHidden(), true);
    await page.waitForTimeout(150);
    assert.equal((await page.evaluate(() => window.updates.getState())).phase, 'available');

    await page.getByTestId('update-entry').click();
    await page.evaluate(() => {
      window.__moneyComingUpdatePhases = [];
      const root = document.documentElement;
      const observer = new MutationObserver(() => {
        window.__moneyComingUpdatePhases.push(root.dataset.updatePhase);
        if (root.dataset.updatePhase === 'downloaded') observer.disconnect();
      });
      observer.observe(root, { attributes: true, attributeFilter: ['data-update-phase'] });
    });
    await page.getByTestId('update-download').click();
    await page.locator('html[data-update-phase="downloaded"]').waitFor();
    const phases = await page.evaluate(() => window.__moneyComingUpdatePhases);
    assert.ok(phases.includes('downloading'), JSON.stringify(phases));
    assert.match(await page.locator('#update-progress-label').innerText(), /^100%/);
    assert.equal(await page.getByTestId('update-install').isVisible(), true);

    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(blocked, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');

    await page.getByTestId('update-install').click();
    await page.locator('html[data-update-phase="installing"]').waitFor();
    await page.screenshot({ path: resolve(output, 'update-installing.png') });
  } finally {
    await app.close();
  }
}

{
  const { app, page, offscreen } = await launch('up-to-date');
  offscreenScenarios.push({ mode: 'up-to-date', ...offscreen });
  try {
    await page.locator('html[data-update-phase="up-to-date"]').waitFor();
    assert.equal(await page.getByTestId('update-dialog').isHidden(), true);
    await page.getByTestId('update-entry').click();
    await page.waitForFunction(async () => {
      const state = await window.updates.getState();
      return state.requestedBy === 'manual' && state.phase === 'up-to-date';
    });
    assert.equal(await page.getByTestId('update-dialog').isVisible(), true);
    assert.match(await page.locator('#update-message').innerText(), /已是最新版本/);
  } finally {
    await app.close();
  }
}

{
  const { app, page, offscreen } = await launch('check-fail');
  offscreenScenarios.push({ mode: 'check-fail', ...offscreen });
  try {
    await page.locator('html[data-update-phase="failed"]').waitFor();
    assert.equal(await page.getByTestId('update-dialog').isHidden(), true);
    assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
    await page.getByTestId('update-entry').click();
    assert.equal(await page.getByTestId('update-dialog').isVisible(), true);
    assert.match(await page.locator('#update-error').innerText(), /更新源不可用/);
    assert.equal(await page.locator('#update-retry').isVisible(), true);
  } finally {
    await app.close();
  }
}

const result = {
  passed: true,
  scenarios: ['available', 'up-to-date', 'check-fail'],
  offscreenScenarios,
};
await writeFile(resolve(output, 'update.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
