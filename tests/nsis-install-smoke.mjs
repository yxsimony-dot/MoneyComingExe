import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { assetName, readOption } from '../scripts/release-utils.mjs';

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

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function dataFingerprint() {
  const result = {};
  for (const name of [
    'edb_main_continuous_5m.csv',
    'edb_main_continuous_60m.csv',
    'summary.json',
    'cross_source_audit.json',
    'entry-rules.md',
  ]) {
    const path = join(installedDataDirectory, name);
    const info = await stat(path);
    result[name] = {
      bytes: info.size,
      modifiedAt: info.mtimeMs,
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

let uninstaller;
try {
  await runPhase('install', () => run(installer, ['/S', `/D=${installDirectory}`]));
  assert.equal((await stat(executable)).isFile(), true);
  for (const name of [
    'edb_main_continuous_5m.csv',
    'edb_main_continuous_60m.csv',
    'summary.json',
    'cross_source_audit.json',
    'entry-rules.md',
  ]) {
    assert.equal((await stat(join(installedDataDirectory, name))).isFile(), true, `缺少 data/${name}`);
  }
  const installedDataBefore = await dataFingerprint();

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
  await runPhase('app-smoke', () => run(process.execPath, [join(root, 'tests', 'app-smoke.mjs')], {
    cwd: root,
    env: environment,
    timeout: 180_000,
  }));
  await runPhase('market-update-smoke', () => run(process.execPath, [join(root, 'tests', 'market-update-smoke.mjs')], {
    cwd: sandbox,
    env: {
      ...environment,
      MONEYCOMING_TEST_UPDATER: '1',
      MONEYCOMING_TEST_UPDATE_MODE: 'up-to-date',
    },
    timeout: 240_000,
  }));
  const installedDataAfter = await dataFingerprint();
  assert.deepEqual(installedDataAfter, installedDataBefore, '行情更新不应修改安装目录 data');
  const pointer = JSON.parse(await readFile(join(appData, 'MoneyComing', 'market-data', 'current.json'), 'utf8'));
  assert.equal(typeof pointer.snapshotId, 'string');

  const uninstallName = (await readdir(installDirectory)).find(name => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstallName, '安装目录缺少 NSIS 卸载程序');
  uninstaller = join(installDirectory, uninstallName);
  await runPhase('uninstall', () => run(uninstaller, ['/S'], { timeout: 180_000 }));
  await waitForMissing(executable);

  console.log(JSON.stringify({
    passed: true,
    installer,
    installDirectory,
    launchedFrom: sandbox,
    userSnapshot: pointer.snapshotId,
    installedDataUnchanged: true,
    uninstalled: true,
  }));
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
