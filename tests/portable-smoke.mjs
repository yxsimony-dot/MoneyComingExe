import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const workspace = resolve('.');
const originalPackage = resolve('release/win-unpacked');
const portable = resolve('artifacts/便携 验收/MoneyComing');
const reportPath = resolve('artifacts/portable.json');
const missingName = 'edb_main_continuous_5m.csv';
const missingPath = join(portable, 'data', missingName);
const heldPath = missingPath + '.portable-test-held';
const names = ['main_continuous', 'm2701'].flatMap(instrument => [5, 60].map(period => `edb_${instrument}_${period}m.csv`));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const report = {
  passed: false,
  executablePath: join(portable, 'MoneyComing.exe'),
  sourcePackage: originalPackage,
  cwd: tmpdir(),
  offlineScope: 'Playwright BrowserContext.setOffline(true) for the application browser context, followed by a renderer reload. This is scoped application-network emulation; the host network was not physically disconnected.',
  outboundRendererRequests: [],
  pageErrors: [],
  checks: {},
  csvHashes: [],
};
let app;
let held = false;
try {
  await mkdir(dirname(portable), { recursive: true });
  await cp(originalPackage, portable, { recursive: true });
  assert.equal((await stat(report.executablePath)).isFile(), true);
  await rename(missingPath, heldPath);
  held = true;
  const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: report.executablePath, args: [], cwd: report.cwd, env, timeout: 30000 });
  const context = app.context();
  context.on('request', request => {
    if (/^(?:https?|wss?):/.test(request.url())) report.outboundRendererRequests.push(request.url());
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    }
  });
  await context.setOffline(true);
  await page.reload();
  await page.locator('#error:not([hidden])').waitFor();
  const missingError = await page.locator('#error-text').innerText();
  assert.match(missingError, /edb_main_continuous_5m\.csv/);
  assert.match(missingError, /文件不存在/);
  assert.ok(missingError.includes(join(portable, 'data')));
  report.checks.missingCsvShowsActionablePath = true;
  report.missingFileError = missingError;
  await page.screenshot({ path: resolve('artifacts/portable-missing-data.png') });
  await rename(heldPath, missingPath);
  held = false;
  await page.locator('#retry').click();
  await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor();
  assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
  assert.equal(await page.locator('#error').isVisible(), false);
  report.checks.restoreAndRetryWithoutRestart = true;
  report.checks.mainLoadedOffline = true;
  await page.getByTestId('instrument').selectOption('m2701');
  await page.locator('html[data-instrument="m2701"]').waitFor();
  assert.match(await page.locator('#counts').innerText(), /11,793.*1,026/);
  report.checks.contractLoadedOffline = true;
  await page.getByTestId('source-info').click();
  assert.ok((await page.locator('.source-path code').innerText()).includes(join(portable, 'data')));
  await page.locator('#dialog-done').click();
  report.checks.chineseAndSpacePathWithUnrelatedCwd = true;
  await page.getByTestId('date-input').fill('2026-02-05');
  await page.getByTestId('date-jump').click();
  assert.equal(await page.locator('html').getAttribute('data-selected-start'), String(Date.parse('2026-02-05T09:00:00+08:00')));
  await page.getByTestId('mode-5').click();
  assert.equal(await page.locator('html').getAttribute('data-mode'), '5');
  await page.getByTestId('mode-dual').click();
  report.checks.offlineDateAndLayoutInteraction = true;
  await page.screenshot({ path: resolve('artifacts/portable-offline.png') });
  for (const name of names) {
    const sourceSha256 = await hash(join(workspace, 'futures_investigation_20261009', name));
    const packageSha256 = await hash(join(originalPackage, 'data', name));
    const portableSha256 = await hash(join(portable, 'data', name));
    assert.equal(packageSha256, sourceSha256, `Packaged data differs: ${name}`);
    assert.equal(portableSha256, sourceSha256, `Portable data differs after use: ${name}`);
    report.csvHashes.push({ name, sourceSha256, packageSha256, portableSha256, unchanged: true });
  }
  report.checks.allFourCsvHashesMatchSource = true;
  assert.deepEqual(report.outboundRendererRequests, []);
  assert.deepEqual(report.pageErrors, []);
  report.checks.noOutboundRendererRequestsObserved = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => { report.closeError = String(error); process.exitCode = 1; report.passed = false; });
  if (held) {
    await rename(heldPath, missingPath).catch(async () => { await copyFile(join(originalPackage, 'data', missingName), missingPath); });
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
