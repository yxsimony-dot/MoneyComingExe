import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { assetName, readOption } from '../scripts/release-utils.mjs';
import {
  REQUIRED_DATA,
  validatePackagedDataDirectory,
} from '../scripts/verify-release.mjs';

const root = process.cwd();
const releaseDirectory = resolve(readOption('dir', process.env.MONEYCOMING_RELEASE_DIR || 'release'));
const latest = parse(await readFile(join(releaseDirectory, 'latest.yml'), 'utf8'));
const installer = join(releaseDirectory, assetName(latest.path || latest.files?.[0]?.url));
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-nsis-'));
const installDirectory = join(sandbox, 'installed');
const appData = join(sandbox, 'appdata');
const localAppData = join(sandbox, 'localappdata');
const executable = join(installDirectory, 'MoneyComing.exe');
const installedDataDirectory = join(installDirectory, 'data');
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function dataFingerprint() {
  const result = {};
  for (const name of REQUIRED_DATA) {
    const path = join(installedDataDirectory, name);
    const info = await stat(path);
    result[name] = {
      bytes: info.size,
      sha256: await sha256(path),
    };
  }
  return result;
}
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

async function runPhase(name, operation) {
  const startedAt = Date.now();
  console.log(JSON.stringify({ phase: name, status: 'started' }));
  try {
    const result = await operation();
    console.log(JSON.stringify({
      phase: name,
      status: 'completed',
      durationMs: Date.now() - startedAt,
    }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      phase: name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      message: error?.message,
    }));
    throw error;
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

async function readJsonArtifact(name) {
  return JSON.parse(
    (await readFile(join(output, name), 'utf8')).replace(/^\uFEFF/, ''),
  );
}

let uninstaller;
try {
  await runPhase('install', () => run(installer, ['/S', `/D=${installDirectory}`]));
  assert.equal((await stat(executable)).isFile(), true);
  for (const name of REQUIRED_DATA) {
    assert.equal((await stat(join(installedDataDirectory, name))).isFile(), true, `缺少 data/${name}`);
  }
  const installedDataBefore = await dataFingerprint();
  const packagedDataBefore = await validatePackagedDataDirectory(
    installedDataDirectory,
    { allowLegacySchema4: true },
  );

  const environment = {
    ...process.env,
    MONEYCOMING_EXE: executable,
    MONEYCOMING_INSTALLER_SMOKE: '1',
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_APPDATA: appData,
    MONEYCOMING_TEST_LOCALAPPDATA: localAppData,
    MONEYCOMING_TEST_USER_DATA: join(appData, 'MoneyComing'),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MONEYCOMING_TEST_BUILTIN_DATA;
  await runPhase('app-smoke', () => run(process.execPath, [join(root, 'tests', 'app-smoke.mjs')], {
    cwd: root,
    env: environment,
    timeout: 180_000,
  }));
  await runPhase('real-baseline-offline-smoke', () => run(
    process.execPath,
    [join(root, 'tests', 'real-baseline-offline-smoke.mjs')],
    {
      cwd: root,
      env: environment,
      timeout: 600_000,
    },
  ));
  await runPhase('multi-instrument-smoke', () => run(
    process.execPath,
    [join(root, 'tests', 'multi-instrument-smoke.mjs')],
    {
      cwd: root,
      env: environment,
      timeout: 300_000,
    },
  ));
  await runPhase('online-market-smoke', () => run(
    process.execPath,
    [join(root, 'tests', 'online-market-smoke.mjs')],
    {
      cwd: root,
      env: environment,
      timeout: 600_000,
    },
  ));
  await runPhase('legacy-appdata-migration-smoke', () => run(
    process.execPath,
    [join(root, 'tests', 'legacy-appdata-migration-smoke.mjs')],
    {
      cwd: root,
      env: environment,
      timeout: 300_000,
    },
  ));
  const shortcutEnvironment = {
    ...environment,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  delete shortcutEnvironment.MONEYCOMING_TEST_MODE;
  delete shortcutEnvironment.MONEYCOMING_TEST_USER_DATA;
  delete shortcutEnvironment.MONEYCOMING_TEST_EDB_MODE;
  delete shortcutEnvironment.MONEYCOMING_TEST_UPDATER;
  delete shortcutEnvironment.MONEYCOMING_TEST_UPDATE_MODE;
  delete shortcutEnvironment.MONEYCOMING_TEST_UPDATE_VERSION;
  await runPhase('shortcut-smoke', () => run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'tests', 'shortcut-smoke.ps1'),
  ], {
    cwd: root,
    env: shortcutEnvironment,
    timeout: 120_000,
  }));
  const installedDataAfter = await dataFingerprint();
  assert.deepEqual(installedDataAfter, installedDataBefore, '验收流程不应修改安装目录 data');
  const packagedDataAfter = await validatePackagedDataDirectory(
    installedDataDirectory,
    { allowLegacySchema4: true },
  );

  const appSmoke = await readJsonArtifact('installer-app-smoke.json');
  const realBaseline = await readJsonArtifact('real-baseline-offline-smoke.json');
  const multiInstrument = await readJsonArtifact('multi-instrument-smoke.json');
  const onlineMarket = await readJsonArtifact('online-market-smoke.json');
  const legacyMigration = await readJsonArtifact('legacy-appdata-migration-smoke.json');
  const shortcut = await readJsonArtifact('shortcut.json');
  assert.equal(realBaseline.instruments.length, 15);
  assert.equal(multiInstrument.updateAll.items.length, 15);
  assert.equal(onlineMarket.packaged, true);
  assert.ok(onlineMarket.scenarios.includes('online-disable-stops-scheduling'));
  assert.equal(legacyMigration.migratedSnapshotId, 'legacy-old-global');
  assert.equal(shortcut.offscreen, true);

  const installerInfo = await stat(installer);
  const finalReport = {
    passed: true,
    installer: {
      path: installer,
      version: latest.version,
      bytes: installerInfo.size,
    },
    peakWorkingSetBytes: realBaseline.peakWorkingSetBytes,
    instruments: realBaseline.instruments.map(instrument => ({
      instrumentId: instrument.instrumentId,
      name: instrument.name,
      sourceLatestAt: instrument.sourceLatestAt,
      firstMinute: instrument.firstMinute,
      lastMinute: instrument.lastMinute,
    })),
    currentUpdate: multiInstrument.currentUpdate,
    updateAll: multiInstrument.updateAll,
    onlineMarket: {
      scenarios: onlineMarket.scenarios,
      firstRun: onlineMarket.firstRun,
      restartFailure: onlineMarket.restartFailure,
      sourceDelay: onlineMarket.sourceDelay,
      disable: onlineMarket.disable,
    },
    legacyMigration: {
      firstMinute: legacyMigration.firstMinute,
      migratedSnapshotId: legacyMigration.migratedSnapshotId,
      oldDataPreserved: legacyMigration.oldDataPreserved,
      idempotent: legacyMigration.idempotent,
    },
    packagedData: {
      before: {
        valid: packagedDataBefore.valid,
        instrumentCount: packagedDataBefore.instrumentCount,
      },
      after: {
        valid: packagedDataAfter.valid,
        instrumentCount: packagedDataAfter.instrumentCount,
      },
      requiredFileCount: REQUIRED_DATA.length,
      sha256Unchanged: true,
    },
    offscreen: {
      appSmoke: appSmoke.offscreen,
      realBaseline: realBaseline.offscreen,
      multiInstrument: multiInstrument.offscreen,
      onlineMarket: onlineMarket.offscreen,
      legacyMigration: legacyMigration.launches,
      shortcut: {
        windowBounds: shortcut.windowBounds,
        displayBounds: shortcut.displayBounds,
        offscreen: shortcut.offscreen,
      },
    },
    uninstalled: false,
  };

  const uninstallName = (await readdir(installDirectory)).find(name => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstallName, '安装目录缺少 NSIS 卸载程序');
  uninstaller = join(installDirectory, uninstallName);
  await runPhase('uninstall', () => run(uninstaller, ['/S'], { timeout: 180_000 }));
  await waitForMissing(executable);
  finalReport.uninstalled = true;
  await writeFile(
    join(output, 'final-install-acceptance.json'),
    `${JSON.stringify(finalReport, null, 2)}\n`,
    'utf8',
  );

  console.log(JSON.stringify(finalReport));
} finally {
  if (uninstaller) {
    await run(uninstaller, ['/S'], { timeout: 60_000 }).catch(() => undefined);
  }
  if (process.env.MONEYCOMING_KEEP_INSTALLER_SMOKE !== '1') {
    try {
      await removeTreeWithRetry(sandbox);
    } catch (error) {
      console.warn(JSON.stringify({
        warning: 'installer-smoke-cleanup-failed',
        sandbox,
        code: error?.code,
        message: error?.message,
      }));
    }
  } else {
    console.log(`保留安装冒烟目录：${sandbox}`);
  }
}
