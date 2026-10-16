import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';
import { launchElectronTest } from './electron-test-launch.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-offscreen-production-'));
const output = resolve('artifacts');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const environment = {
  ...process.env,
  APPDATA: join(sandbox, 'appdata'),
  LOCALAPPDATA: join(sandbox, 'localappdata'),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.MONEYCOMING_TEST_MODE;
delete environment.MONEYCOMING_TEST_USER_DATA;
delete environment.MONEYCOMING_TEST_UPDATER;
delete environment.MONEYCOMING_TEST_UPDATE_MODE;
delete environment.MONEYCOMING_TEST_UPDATE_VERSION;

let app;
try {
  app = await launchElectronTest({
    ...(executable
      ? { executablePath: executable, args: [], cwd: sandbox }
      : { args: ['.'] }),
    env: environment,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  const offscreen = await assertElectronWindowOffscreen(app, 'production-mode-offscreen');
  const result = {
    passed: true,
    packaged: Boolean(executable),
    testMode: false,
    geometryOnlyTestMode: true,
    offscreen,
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'offscreen-production-mode.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
}
