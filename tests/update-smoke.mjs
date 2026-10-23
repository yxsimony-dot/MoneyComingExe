import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchElectronTest } from './electron-test-launch.mjs';
import semver from 'semver';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const output = resolve('artifacts');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const baselineReport = JSON.parse(
  await readFile(new URL('../data/baseline-report.json', import.meta.url), 'utf8'),
);
const mainBaseline = baselineReport.instruments.find(
  instrument => instrument.instrumentId === 'main_continuous',
);
assert.ok(mainBaseline, 'Baseline report must contain main_continuous.');
const assertMainCountsAtLeastBaseline = async page => {
  const text = await page.locator('#counts').innerText();
  const match = text.match(/^5\D+([\d,]+)\D+60\D+([\d,]+)/);
  assert.ok(match, `Expected main-continuous counts, got ${JSON.stringify(text)}.`);
  const fiveMinuteRows = Number(match[1].replaceAll(',', ''));
  const sixtyMinuteRows = Number(match[2].replaceAll(',', ''));
  assert.ok(
    fiveMinuteRows >= mainBaseline.fiveMinuteRows
      && sixtyMinuteRows >= mainBaseline.sixtyMinuteRows,
    JSON.stringify({
      actual: { fiveMinuteRows, sixtyMinuteRows },
      baseline: {
        fiveMinuteRows: mainBaseline.fiveMinuteRows,
        sixtyMinuteRows: mainBaseline.sixtyMinuteRows,
      },
    }),
  );
};
const currentVersion = manifest.version;
const targetVersion = semver.inc(currentVersion, 'patch');
assert.ok(targetVersion, `Invalid package version: ${currentVersion}`);

async function launch(mode) {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_UPDATER: '1',
    MONEYCOMING_TEST_UPDATE_MODE: mode,
    MONEYCOMING_TEST_UPDATE_VERSION: targetVersion,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectronTest({ args: ['.'], env, timeout: 30000 });
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
    assert.equal(await page.locator('#update-current').innerText(), `v${currentVersion}`);
    assert.equal(await page.locator('#update-target').innerText(), `v${targetVersion}`);
    await assertMainCountsAtLeastBaseline(page);

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
    await assertMainCountsAtLeastBaseline(page);
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
