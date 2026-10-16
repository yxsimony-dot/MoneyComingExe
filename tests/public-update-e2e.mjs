import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';
import semver from 'semver';
import { parse, stringify } from 'yaml';
import { assetName, readOption } from '../scripts/release-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromTag = readOption('from', 'v1.0.1');
const toTag = readOption('to', 'v1.0.2');
const outputPath = resolve(readOption('output', join(root, 'artifacts', 'public-update-e2e.json')));
const outputDirectory = dirname(outputPath);
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-public-update-'));
const downloadDirectory = join(sandbox, 'downloads');
const installDirectory = join(sandbox, 'installed');
const appData = join(sandbox, 'appdata');
const localAppData = join(sandbox, 'localappdata');
const executable = join(installDirectory, 'MoneyComing.exe');
const appUpdatePath = join(installDirectory, 'resources', 'app-update.yml');

function versionFromTag(tag) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  assert.ok(semver.valid(version), `Invalid release tag: ${tag}`);
  return version;
}

const fromVersion = versionFromTag(fromTag);
const toVersion = versionFromTag(toTag);
assert.equal(semver.gt(toVersion, fromVersion), true, `${toTag} must be newer than ${fromTag}`);

const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

async function run(file, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd || sandbox,
      env: options.env || process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} timed out`));
    }, options.timeout || 180_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`${file} exited with code ${code}`));
    });
  });
}

async function removeTreeWithRetry(path, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) throw error;
      await wait(250);
    }
  }
}

async function waitForMissing(path, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for removal: ${path}`);
}

function releaseAssetUrl(tag, name) {
  return `https://github.com/yxsimony-dot/MoneyComingExe/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

async function anonymousFetch(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'MoneyComing-public-update-e2e' },
  });
  if (!response.ok) throw new Error(`Anonymous request failed ${response.status}: ${url}`);
  return response;
}

async function releaseMetadata(tag, expectedVersion) {
  const response = await anonymousFetch(releaseAssetUrl(tag, 'latest.yml'));
  const latest = parse(await response.text());
  assert.equal(latest.version, expectedVersion, `${tag} latest.yml version mismatch`);
  const installerName = assetName(latest.path || latest.files?.[0]?.url);
  assert.equal(installerName, `MoneyComing-Setup-${expectedVersion}-x64.exe`);
  return {
    version: latest.version,
    installerName,
    latestUrl: releaseAssetUrl(tag, 'latest.yml'),
    installerUrl: releaseAssetUrl(tag, installerName),
  };
}

async function downloadFile(url, destination) {
  const response = await anonymousFetch(url);
  assert.ok(response.body, `Missing response body: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  assert.equal((await stat(destination)).isFile(), true);
}

async function stopInstalledProcesses() {
  const escaped = executable.replaceAll("'", "''");
  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$target='${escaped}'; $items=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target }; if ($items) { Stop-Process -Id @($items.ProcessId) -Force; Start-Sleep -Milliseconds 750 }`,
  ], { timeout: 30_000 });
}

function productionEnvironment() {
  const environment = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MONEYCOMING_TEST_MODE;
  delete environment.MONEYCOMING_TEST_USER_DATA;
  delete environment.MONEYCOMING_TEST_UPDATER;
  delete environment.MONEYCOMING_TEST_UPDATE_MODE;
  delete environment.MONEYCOMING_TEST_UPDATE_VERSION;
  return environment;
}

const offscreenLaunches = [];

async function launchInstalled(label) {
  const app = await launchElectronTest({
    executablePath: executable,
    args: [],
    cwd: sandbox,
    env: productionEnvironment(),
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  const offscreen = await assertElectronWindowOffscreen(app, label);
  offscreenLaunches.push({ label, ...offscreen });
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 60_000 });
  return { app, page };
}

async function waitForUpdatePhase(page, expected, timeout = 120_000) {
  const phases = Array.isArray(expected) ? expected : [expected];
  await page.waitForFunction(
    values => values.includes(document.documentElement.dataset.updatePhase),
    phases,
    { timeout },
  );
  return page.evaluate(() => window.updates.getState());
}

async function waitForPackagedVersion(expectedVersion, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  const asarPath = join(installDirectory, 'resources', 'app.asar');
  while (Date.now() < deadline) {
    try {
      const manifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
      if (manifest.version === expectedVersion) return manifest.version;
    } catch {
      // The installer may be replacing app.asar while this poll is running.
    }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for installed version ${expectedVersion}`);
}

function progressSamples(states) {
  const samples = [];
  let lastBucket = -1;
  for (const state of states) {
    if (state.phase !== 'downloading' || !state.progress) continue;
    const bucket = Math.floor(state.progress.percent / 10);
    if (bucket === lastBucket && state.progress.percent < 100) continue;
    lastBucket = bucket;
    samples.push({
      percent: Math.round(state.progress.percent * 10) / 10,
      transferred: state.progress.transferred,
      total: state.progress.total,
      bytesPerSecond: state.progress.bytesPerSecond,
    });
  }
  return samples;
}

let app;
let uninstaller;
let originalUpdateConfig;
try {
  await mkdir(downloadDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const source = await releaseMetadata(fromTag, fromVersion);
  const target = await releaseMetadata(toTag, toVersion);
  const sourceInstaller = join(downloadDirectory, source.installerName);
  await downloadFile(source.installerUrl, sourceInstaller);

  await run(sourceInstaller, ['/S', `/D=${installDirectory}`], { timeout: 240_000 });
  assert.equal((await stat(executable)).isFile(), true);
  assert.equal(await waitForPackagedVersion(fromVersion), fromVersion);

  originalUpdateConfig = await readFile(appUpdatePath, 'utf8');
  const brokenConfig = parse(originalUpdateConfig);
  brokenConfig.repo = `${brokenConfig.repo}-missing`;
  await writeFile(appUpdatePath, stringify(brokenConfig), 'utf8');

  const failureLaunch = await launchInstalled('public-update-check-failure');
  app = failureLaunch.app;
  const failurePage = failureLaunch.page;
  const failed = await waitForUpdatePhase(failurePage, 'failed');
  assert.equal(failed.error?.code, 'check-failed');
  assert.match(await failurePage.locator('#counts').innerText(), /\d/);
  await failurePage.getByTestId('update-entry').click();
  assert.equal(await failurePage.locator('#update-retry').isVisible(), true);
  await failurePage.screenshot({ path: join(outputDirectory, 'public-update-check-failure.png') });
  await app.close();
  app = undefined;

  await writeFile(appUpdatePath, originalUpdateConfig, 'utf8');

  const launched = await launchInstalled('public-update-source-version');
  app = launched.app;
  const page = launched.page;
  let available = await waitForUpdatePhase(page, ['available', 'failed']);
  for (let attempt = 1; available.phase === 'failed' && attempt <= 3; attempt += 1) {
    await wait(attempt * 3000);
    available = await page.evaluate(() => window.updates.check());
  }
  assert.equal(available.phase, 'available', JSON.stringify(available));
  assert.equal(available.currentVersion, fromVersion);
  assert.equal(available.availableVersion, toVersion);
  assert.equal(await page.locator('#app-version').innerText(), `v${fromVersion}`);
  assert.equal(await page.locator('#update-target').innerText(), `v${toVersion}`);

  await page.evaluate(() => {
    window.__moneyComingPublicUpdateStates = [];
    window.__moneyComingPublicUpdateStop = window.updates.onState(state => {
      window.__moneyComingPublicUpdateStates.push(JSON.parse(JSON.stringify(state)));
    });
  });
  await page.getByTestId('update-download').click();
  const downloaded = await waitForUpdatePhase(page, 'downloaded', 1_200_000);
  assert.equal(downloaded.availableVersion, toVersion);
  assert.equal(downloaded.progress?.percent, 100);
  const capturedStates = await page.evaluate(() => {
    window.__moneyComingPublicUpdateStop?.();
    return window.__moneyComingPublicUpdateStates;
  });
  const progress = progressSamples(capturedStates);
  assert.ok(progress.length > 0, 'No download progress was captured');
  await page.screenshot({ path: join(outputDirectory, 'public-update-downloaded.png') });

  const processExited = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('Application did not exit for update installation')), 240_000);
    app.process().once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
  const installingVisible = page.locator('html[data-update-phase="installing"]')
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  await page.getByTestId('update-install').click().catch(() => undefined);
  const [exitResult, installingStateRendered] = await Promise.all([processExited, installingVisible]);
  app = undefined;

  assert.equal(await waitForPackagedVersion(toVersion), toVersion);
  await stopInstalledProcesses();

  const updated = await launchInstalled('public-update-updated-version');
  app = updated.app;
  const updatedPage = updated.page;
  assert.equal(await updatedPage.locator('#app-version').innerText(), `v${toVersion}`);
  let finalState = await waitForUpdatePhase(updatedPage, ['up-to-date', 'failed']);
  for (let attempt = 1; finalState.phase === 'failed' && attempt <= 3; attempt += 1) {
    await wait(attempt * 3000);
    finalState = await updatedPage.evaluate(() => window.updates.check());
  }
  assert.equal(finalState.phase, 'up-to-date', JSON.stringify(finalState));
  await updatedPage.screenshot({ path: join(outputDirectory, 'public-update-complete.png') });
  await app.close();
  app = undefined;
  await stopInstalledProcesses();

  const uninstallName = (await readdir(installDirectory)).find(name => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstallName, 'Updated installation is missing the NSIS uninstaller');
  uninstaller = join(installDirectory, uninstallName);
  await run(uninstaller, ['/S'], { timeout: 180_000 });
  await waitForMissing(executable);

  const result = {
    passed: true,
    source: {
      tag: fromTag,
      version: fromVersion,
      latestUrl: source.latestUrl,
      installerUrl: source.installerUrl,
      anonymous: true,
    },
    target: {
      tag: toTag,
      version: toVersion,
      latestUrl: target.latestUrl,
      installerUrl: target.installerUrl,
      anonymous: true,
    },
    failureRecovery: {
      phase: failed.phase,
      errorCode: failed.error?.code,
      applicationRemainedUsable: true,
      retryAvailable: true,
      recoveredAfterConfigurationRestore: true,
    },
    update: {
      detectedVersion: available.availableVersion,
      progress,
      downloaded: downloaded.phase === 'downloaded',
      installingStateRendered,
      updaterProcessExit: exitResult,
      installedVersion: toVersion,
      relaunchedVersionLabel: `v${toVersion}`,
      finalPhase: finalState.phase,
    },
    offscreenLaunches,
    uninstalled: true,
    completedAt: new Date().toISOString(),
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close().catch(() => undefined);
  await stopInstalledProcesses().catch(() => undefined);
  if (originalUpdateConfig) {
    await writeFile(appUpdatePath, originalUpdateConfig, 'utf8').catch(() => undefined);
  }
  if (uninstaller) {
    await run(uninstaller, ['/S'], { timeout: 60_000 }).catch(() => undefined);
  }
  if (process.env.MONEYCOMING_KEEP_PUBLIC_UPDATE_E2E !== '1') {
    await removeTreeWithRetry(sandbox).catch(error => {
      console.warn(`Failed to clean public update sandbox: ${error instanceof Error ? error.message : error}`);
    });
  } else {
    console.log(`Public update sandbox retained at ${sandbox}`);
  }
}
