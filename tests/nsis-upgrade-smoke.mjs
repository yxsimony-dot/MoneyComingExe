import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { launchElectronTest } from './electron-test-launch.mjs';
import semver from 'semver';
import { parse } from 'yaml';
import { assetName } from '../scripts/release-utils.mjs';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oldReleaseDirectory = resolve(
  process.env.MONEYCOMING_OLD_RELEASE_DIR || join(root, 'release-upgrade-old'),
);
const newReleaseDirectory = resolve(
  process.env.MONEYCOMING_NEW_RELEASE_DIR || join(root, 'release'),
);
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-nsis-upgrade-'));
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });
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

function parseUiCounts(text) {
  const match = /5\D+?([\d,]+)\D+?60\D+?([\d,]+)/.exec(text);
  assert.ok(match, `无法解析周期数量：${text}`);
  return {
    bars5: Number(match[1].replaceAll(',', '')),
    bars60: Number(match[2].replaceAll(',', '')),
  };
}

function metadataPeriodRows(metadata, period) {
  return metadata.periods?.[period]?.rows ?? metadata.files?.[period]?.rows;
}

function metadataPeriodLast(metadata, period) {
  return metadata.periods?.[period]?.last ?? metadata.sourceLatestAt;
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
  const marketDirectory = join(
    userData,
    'market-data',
    'instruments',
    'main_continuous',
  );
  const pointerText = await readFile(join(marketDirectory, 'current.json'), 'utf8');
  const pointer = JSON.parse(pointerText);
  const snapshotDirectory = join(marketDirectory, 'snapshots', pointer.snapshotId);
  const files = {};
  for (const name of [
    'activated.json',
    'edb_main_continuous_1m_raw.csv',
    'edb_main_continuous_5m.csv',
    'edb_main_continuous_60m.csv',
    'edb_main_continuous_rollovers.csv',
    'edb_main_contract_mapping.csv',
    'metadata.json',
  ]) {
    try {
      files[name] = sha256(await readFile(join(snapshotDirectory, name)));
    } catch (error) {
      if (name === 'edb_main_continuous_1m_raw.csv' && error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
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
let result = { passed: false };
try {
  const oldInstaller = await installerFrom(oldReleaseDirectory);
  const newInstaller = await installerFrom(newReleaseDirectory);
  assert.equal(
    semver.gt(newInstaller.version, oldInstaller.version),
    true,
    `新版本 ${newInstaller.version} 必须高于旧版本 ${oldInstaller.version}`,
  );

  await run(oldInstaller.path, ['--force-run', '/S', `/D=${installDirectory}`]);
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
  delete baseEnvironment.MONEYCOMING_TEST_BUILTIN_DATA;
  await run(process.execPath, [join(root, 'tests', 'market-update-smoke.mjs')], {
    cwd: sandbox,
    env: {
      ...baseEnvironment,
      MONEYCOMING_TEST_BUILTIN_DATA: join(root, 'futures_investigation_20261009'),
      MONEYCOMING_TEST_LEGACY_UPDATE_EXPECTATIONS: '1',
    },
    timeout: 240_000,
  });
  const beforeUpgrade = await snapshotFingerprint();
  assert.equal(beforeUpgrade.metadata.sourceLatestAt, '2026-10-12 10:00:00');
  await stopInstalledProcesses();

  await run(newInstaller.path, ['--force-run', '/S', `/D=${installDirectory}`]);
  assert.equal((await stat(executable)).isFile(), true);
  const builtinMetadata = JSON.parse(await readFile(
    join(
      installDirectory,
      'data',
      'instruments',
      'main_continuous',
      'metadata.json',
    ),
    'utf8',
  ));
  const expectedSourceLatestAt = [
    builtinMetadata.sourceLatestAt,
    beforeUpgrade.metadata.sourceLatestAt,
  ].sort().at(-1);
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
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 120_000 });
  await page.locator('html[data-update-phase="up-to-date"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('#app-version').innerText(), `v${newInstaller.version}`);
  const countsAfterMigration = parseUiCounts(await page.locator('#counts').innerText());
  const coverageAfterMigration = await page.locator('#coverage').innerText();
  assert.match(coverageAfterMigration, /2021-10-18/);
  assert.match(coverageAfterMigration, new RegExp(expectedSourceLatestAt.slice(0, 16)));

  await page.getByTestId('market-update').click();
  await page.locator('html[data-market-update-phase="failed"]').waitFor({ timeout: 30_000 });
  assert.match(await page.locator('#market-update-status').innerText(), /更新失败/);
  assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'up-to-date');
  assert.deepEqual(
    parseUiCounts(await page.locator('#counts').innerText()),
    countsAfterMigration,
  );
  const offscreenBeforeClose = await assertElectronWindowOffscreen(
    app,
    'nsis-upgrade-before-close',
  );
  await app.close();
  app = undefined;
  await stopInstalledProcesses();

  const afterUpgrade = await snapshotFingerprint();
  assert.notEqual(afterUpgrade.snapshotId, beforeUpgrade.snapshotId);
  assert.ok(
    afterUpgrade.metadata.periods.bars5.first <= '2021-10-18 09:00:00',
    `5 分钟历史未扩展到 2021-10：${afterUpgrade.metadata.periods.bars5.first}`,
  );
  assert.ok(
    afterUpgrade.metadata.periods.bars60.first <= '2021-10-18 09:00:00',
    `60 分钟历史未扩展到 2021-10：${afterUpgrade.metadata.periods.bars60.first}`,
  );
  assert.ok(
    afterUpgrade.metadata.periods.bars5.last
      >= metadataPeriodLast(beforeUpgrade.metadata, 'bars5'),
    '升级后 5 分钟尾部不得早于旧用户快照',
  );
  assert.ok(
    afterUpgrade.metadata.periods.bars60.last
      >= metadataPeriodLast(beforeUpgrade.metadata, 'bars60'),
    '升级后 60 分钟尾部不得早于旧用户快照',
  );
  assert.equal(afterUpgrade.metadata.sourceLatestAt, expectedSourceLatestAt);
  assert.ok(
    afterUpgrade.metadata.periods.bars5.rows
      > metadataPeriodRows(beforeUpgrade.metadata, 'bars5'),
    '升级后 5 分钟行数应增加',
  );
  assert.ok(
    afterUpgrade.metadata.periods.bars60.rows
      > metadataPeriodRows(beforeUpgrade.metadata, 'bars60'),
    '升级后 60 分钟行数应增加',
  );
  assert.deepEqual(countsAfterMigration, {
    bars5: afterUpgrade.metadata.periods.bars5.rows,
    bars60: afterUpgrade.metadata.periods.bars60.rows,
  });

  app = await launchElectronTest({
    executablePath: executable,
    args: [],
    cwd: sandbox,
    env,
    timeout: 30_000,
  });
  const reopenedPage = await app.firstWindow();
  const offscreenBeforeReopen = await assertElectronWindowOffscreen(
    app,
    'nsis-upgrade-reopen-before-show',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterReopen = await assertElectronWindowOffscreen(
    app,
    'nsis-upgrade-reopen-after-show',
  );
  await reopenedPage.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  assert.deepEqual(
    parseUiCounts(await reopenedPage.locator('#counts').innerText()),
    countsAfterMigration,
  );
  await app.close();
  app = undefined;
  await stopInstalledProcesses();
  const afterReopen = await snapshotFingerprint();
  assert.deepEqual(afterReopen, afterUpgrade);

  const uninstallName = (await readdir(installDirectory)).find(name => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstallName, '升级后的安装目录缺少 NSIS 卸载程序');
  uninstaller = join(installDirectory, uninstallName);
  await run(uninstaller, ['/S'], { timeout: 180_000 });
  await waitForMissing(executable);

  result = {
    passed: true,
    oldVersion: oldInstaller.version,
    newVersion: newInstaller.version,
    snapshotId: afterUpgrade.snapshotId,
    snapshotMigrated: true,
    snapshotStableAfterReopen: true,
    updateStatesIndependent: true,
    offscreen: {
      beforeShow: offscreenBeforeShow,
      afterShow: offscreenAfterShow,
      beforeClose: offscreenBeforeClose,
      beforeReopen: offscreenBeforeReopen,
      afterReopen: offscreenAfterReopen,
    },
    uninstalled: true,
  };
  console.log(JSON.stringify(result));
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
  await writeFile(
    join(output, 'nsis-upgrade-smoke.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}
