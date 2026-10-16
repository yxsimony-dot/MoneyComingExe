import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectronTest } from './electron-test-launch.mjs';
import { parse } from 'yaml';
import { assetName } from '../scripts/release-utils.mjs';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oldReleaseDirectory = resolve(process.env.MONEYCOMING_OLD_RELEASE_DIR || join(root, 'release'));
const newReleaseDirectory = resolve(process.env.MONEYCOMING_NEW_RELEASE_DIR || join(root, 'release-upgrade-1.0.1'));
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-nsis-upgrade-'));
const installDirectory = join(sandbox, 'installed');
const appData = join(sandbox, 'appdata');
const localAppData = join(sandbox, 'localappdata');
const userData = join(appData, 'MoneyComing');
const executable = join(installDirectory, 'MoneyComing.exe');

async function installerFrom(directory) {
  const latest = parse(await readFile(join(directory, 'latest.yml'), 'utf8'));
  return {
    version: latest.version,
    path: join(directory, assetName(latest.path || latest.files?.[0]?.url)),
  };
}

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
      reject(new Error(`${file} 执行超时`));
    }, options.timeout || 180_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`${file} 退出码 ${code}`));
    });
  });
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

const sha256 = value => createHash('sha256').update(value).digest('hex');
const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

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
  throw new Error(`等待卸载删除文件超时：${path}`);
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

async function snapshotFingerprint() {
  const marketDirectory = join(userData, 'market-data');
  const pointerText = await readFile(join(marketDirectory, 'current.json'), 'utf8');
  const pointer = JSON.parse(pointerText);
  const snapshotDirectory = join(marketDirectory, 'snapshots', pointer.snapshotId);
  const files = {};
  for (const name of [
    'activated.json',
    'edb_main_continuous_5m.csv',
    'edb_main_continuous_60m.csv',
    'metadata.json',
  ]) {
    files[name] = sha256(await readFile(join(snapshotDirectory, name)));
  }
  return {
    snapshotId: pointer.snapshotId,
    pointerSha256: sha256(pointerText),
    files,
    metadata: JSON.parse(await readFile(join(snapshotDirectory, 'metadata.json'), 'utf8')),
  };
}

let app;
let uninstaller;
try {
  const oldInstaller = await installerFrom(oldReleaseDirectory);
  const newInstaller = await installerFrom(newReleaseDirectory);
  assert.equal(oldInstaller.version, '1.0.0');
  assert.equal(newInstaller.version, '1.0.1');

  await run(oldInstaller.path, ['/S', `/D=${installDirectory}`]);
  assert.equal((await stat(executable)).isFile(), true);
  const baseEnvironment = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    MONEYCOMING_EXE: executable,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: userData,
  };
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  await run(process.execPath, [join(root, 'tests', 'market-update-smoke.mjs')], {
    cwd: sandbox,
    env: baseEnvironment,
    timeout: 240_000,
  });
  const beforeUpgrade = await snapshotFingerprint();
  assert.equal(beforeUpgrade.metadata.sourceLatestAt, '2026-10-12 10:00:00');
  await stopInstalledProcesses();

  await run(newInstaller.path, ['/S', `/D=${installDirectory}`]);
  assert.equal((await stat(executable)).isFile(), true);
  const env = {
    ...baseEnvironment,
    MONEYCOMING_TEST_EDB_MODE: 'offline',
    MONEYCOMING_TEST_UPDATER: '1',
    MONEYCOMING_TEST_UPDATE_MODE: 'up-to-date',
  };
  app = await launchElectronTest({
    executablePath: executable,
    args: [],
    cwd: sandbox,
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'nsis-upgrade-before-show');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'nsis-upgrade-after-show');
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  await page.locator('html[data-update-phase="up-to-date"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('#app-version').innerText(), 'v1.0.1');
  assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
  assert.match(await page.locator('#coverage').innerText(), /数据源最新至 2026-10-12 10:00/);

  await page.getByTestId('market-update').click();
  await page.locator('html[data-market-update-phase="failed"]').waitFor({ timeout: 30_000 });
  assert.match(await page.locator('#market-update-status').innerText(), /更新失败/);
  assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'up-to-date');
  assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
  await app.close();
  app = undefined;
  await stopInstalledProcesses();

  const afterUpgrade = await snapshotFingerprint();
  assert.deepEqual(afterUpgrade, beforeUpgrade);

  const uninstallName = (await readdir(installDirectory)).find(name => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstallName, '升级后的安装目录缺少 NSIS 卸载程序');
  uninstaller = join(installDirectory, uninstallName);
  await run(uninstaller, ['/S'], { timeout: 180_000 });
  await waitForMissing(executable);

  console.log(JSON.stringify({
    passed: true,
    oldVersion: oldInstaller.version,
    newVersion: newInstaller.version,
    snapshotId: beforeUpgrade.snapshotId,
    snapshotPreserved: true,
    updateStatesIndependent: true,
    offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow },
    uninstalled: true,
  }));
} finally {
  if (app) await app.close().catch(() => undefined);
  await stopInstalledProcesses().catch(() => undefined);
  if (uninstaller) {
    await run(uninstaller, ['/S'], { timeout: 60_000 }).catch(() => undefined);
  }
  if (process.env.MONEYCOMING_KEEP_UPGRADE_SMOKE !== '1') {
    await removeTreeWithRetry(sandbox).catch(error => {
      console.warn(`升级冒烟临时目录清理失败：${error instanceof Error ? error.message : error}`);
    });
  } else {
    console.log(`保留升级冒烟目录：${sandbox}`);
  }
}
