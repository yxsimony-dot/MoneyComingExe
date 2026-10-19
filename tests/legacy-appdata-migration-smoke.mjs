import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : join(root, 'release', 'win-unpacked', 'MoneyComing.exe');
const installedDataDirectory = join(dirname(executable), 'data');
const sourceDirectory = join(installedDataDirectory, 'instruments', 'main_continuous');
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-legacy-migration-'));
const userData = join(sandbox, 'user-data');
const marketDataDirectory = join(userData, 'market-data');
const legacySnapshotDirectory = join(marketDataDirectory, 'snapshots', 'old-global');
const instrumentDirectory = join(
  marketDataDirectory,
  'instruments',
  'main_continuous',
);
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function treeFingerprint(directory) {
  const result = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result[relative(directory, path).replaceAll('\\', '/')] = sha256(await readFile(path));
      }
    }
  }
  await visit(directory);
  return result;
}

function firstMinuteFromCsv(text) {
  const first = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)[1].split(',', 1)[0];
  const milliseconds = Number(BigInt(first) / 1_000_000n);
  return new Date(milliseconds + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

await mkdir(dirname(legacySnapshotDirectory), { recursive: true });
await cp(sourceDirectory, legacySnapshotDirectory, { recursive: true });
const legacyMetadataPath = join(legacySnapshotDirectory, 'metadata.json');
const legacyMetadata = JSON.parse(await readFile(legacyMetadataPath, 'utf8'));
legacyMetadata.schemaVersion = 3;
legacyMetadata.snapshotId = 'old-global';
delete legacyMetadata.instrumentId;
delete legacyMetadata.mainSymbol;
delete legacyMetadata.parameterVersion;
delete legacyMetadata.files.mainContractMappings;
await writeFile(legacyMetadataPath, `${JSON.stringify(legacyMetadata, null, 2)}\n`, 'utf8');
await rm(join(legacySnapshotDirectory, 'edb_main_contract_mapping.csv'), { force: true });
const updatedAt = '2026-10-18T12:00:00.000Z';
await writeFile(
  join(legacySnapshotDirectory, 'activated.json'),
  `${JSON.stringify({ activatedAt: updatedAt }, null, 2)}\n`,
  'utf8',
);
await writeFile(
  join(marketDataDirectory, 'current.json'),
  `${JSON.stringify({ schemaVersion: 3, snapshotId: 'old-global', updatedAt }, null, 2)}\n`,
  'utf8',
);

const originalPointer = await readFile(join(marketDataDirectory, 'current.json'), 'utf8');
const originalSnapshot = await treeFingerprint(legacySnapshotDirectory);
const firstMinute = firstMinuteFromCsv(await readFile(
  join(legacySnapshotDirectory, 'edb_main_continuous_1m_raw.csv'),
  'utf8',
));
assert.ok(
  firstMinute <= '2025-10-09 21:00:00',
  `旧豆粕首根分钟数据晚于兼容边界：${firstMinute}`,
);

const report = {
  passed: false,
  executable,
  firstMinute,
  migratedSnapshotId: undefined,
  oldDataPreserved: false,
  idempotent: false,
  launches: [],
};
let failure;

async function launchAndVerify(index) {
  const env = {
    ...process.env,
    APPDATA: join(sandbox, 'appdata'),
    LOCALAPPDATA: join(sandbox, 'localappdata'),
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: userData,
    MONEYCOMING_TEST_EDB_MODE: 'offline',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MONEYCOMING_TEST_BUILTIN_DATA;
  const app = await launchElectronTest({
    executablePath: executable,
    args: [],
    cwd: sandbox,
    env,
    timeout: 60_000,
  });
  const launchReport = { index };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(120_000);
    launchReport.beforeShow = await assertElectronWindowOffscreen(
      app,
      `legacy-migration-${index}-before-show`,
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    });
    launchReport.afterShow = await assertElectronWindowOffscreen(
      app,
      `legacy-migration-${index}-after-show`,
    );
    await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor();
    assert.match(await page.locator('#coverage').innerText(), /2025-10-09.*2026-10-16/);
    assert.match(await page.locator('#counts').innerText(), /16,899.*1,470/);
  } finally {
    launchReport.beforeClose = await assertElectronWindowOffscreen(
      app,
      `legacy-migration-${index}-before-close`,
    );
    await app.close();
    report.launches.push(launchReport);
  }
}

try {
  await launchAndVerify(1);
  const firstPointer = JSON.parse(await readFile(join(instrumentDirectory, 'current.json'), 'utf8'));
  assert.equal(firstPointer.snapshotId, 'legacy-old-global');
  report.migratedSnapshotId = firstPointer.snapshotId;
  const firstSnapshotNames = (await readdir(join(instrumentDirectory, 'snapshots'), {
    withFileTypes: true,
  }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(firstSnapshotNames, ['legacy-old-global']);

  await launchAndVerify(2);
  const secondPointer = JSON.parse(await readFile(join(instrumentDirectory, 'current.json'), 'utf8'));
  assert.deepEqual(secondPointer, firstPointer);
  const secondSnapshotNames = (await readdir(join(instrumentDirectory, 'snapshots'), {
    withFileTypes: true,
  }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(secondSnapshotNames, firstSnapshotNames);
  report.idempotent = true;

  assert.equal(await readFile(join(marketDataDirectory, 'current.json'), 'utf8'), originalPointer);
  assert.deepEqual(await treeFingerprint(legacySnapshotDirectory), originalSnapshot);
  assert.equal((await stat(legacySnapshotDirectory)).isDirectory(), true);
  report.oldDataPreserved = true;
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  await writeFile(
    join(output, 'legacy-appdata-migration-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  if (process.env.MONEYCOMING_KEEP_LEGACY_MIGRATION_SMOKE !== '1') {
    await rm(sandbox, { recursive: true, force: true });
  } else {
    console.log(`保留旧 AppData 迁移冒烟目录：${sandbox}`);
  }
}

if (failure) throw failure;
console.log(JSON.stringify(report));
