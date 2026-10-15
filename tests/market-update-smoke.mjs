import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts');
await mkdir(output, { recursive: true });
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-market-update-'));
const userData = process.env.MONEYCOMING_TEST_USER_DATA
  ? resolve(process.env.MONEYCOMING_TEST_USER_DATA)
  : join(sandbox, 'user-data');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;
const fixturePath = join(sandbox, 'edb-fixture.csv');
const source = await readFile(join(root, 'futures_investigation_20261009', 'edb_main_continuous_1m_raw.csv'), 'utf8');
const [header, ...sourceRows] = source.trim().split(/\r?\n/);
const overlapStartNano = BigInt(Date.parse('2026-10-08T00:00:00+08:00')) * 1_000_000n;
const overlapRows = sourceRows.filter(row => BigInt(row.split(',', 1)[0]) >= overlapStartNano);
const syntheticRows = Array.from({ length: 60 }, (_, index) => {
  const startMs = Date.parse('2026-10-12T09:00:00+08:00') + index * 60_000;
  const open = 3402 + Math.floor(index / 10);
  const openOi = 2_485_615 + index * 10;
  return [
    String(BigInt(startMs) * 1_000_000n),
    open,
    open + 2,
    open - 1,
    open + 1,
    100 + index,
    openOi,
    openOi + 10,
  ].join(',');
});
await writeFile(fixturePath, `${[header, ...overlapRows, ...syntheticRows].join('\n')}\n`, 'utf8');

async function launch(mode) {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: userData,
    MONEYCOMING_TEST_EDB_MODE: mode,
    MONEYCOMING_TEST_EDB_FIXTURE: fixturePath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = {
    args: executable ? [] : [root],
    env,
    timeout: 30_000,
  };
  if (executable) options.executablePath = executable;
  const app = await electron.launch(options);
  const page = await app.firstWindow();
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, `market-update-${mode}-before-show`);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, `market-update-${mode}-after-show`);
  await page.locator('html[data-ready="true"]').waitFor();
  return { app, page, offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow } };
}

async function frame(page) {
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function jump(page, date) {
  await page.getByTestId('date-input').fill(date);
  await page.getByTestId('date-jump').click();
  await frame(page);
}

const networkHits = { http: 0, webSocket: 0 };
const networkServer = createServer((_request, response) => {
  networkHits.http += 1;
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('renderer network should be blocked');
});
networkServer.on('upgrade', (_request, socket) => {
  networkHits.webSocket += 1;
  socket.destroy();
});
await new Promise((resolvePromise, reject) => {
  networkServer.once('error', reject);
  networkServer.listen(0, '127.0.0.1', resolvePromise);
});
const networkPort = networkServer.address().port;
const offscreenScenarios = [];

try {
  {
    const { app, page, offscreen } = await launch('fixture');
    offscreenScenarios.push({ mode: 'fixture', ...offscreen });
    try {
      assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
      assert.equal(await app.evaluate(({ BrowserWindow, session }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window.webContents.session === session.defaultSession;
      }), false);

      const rendererNetwork = await page.evaluate(async port => {
        const http = await fetch(`http://127.0.0.1:${port}/blocked`)
          .then(() => 'opened', () => 'blocked');
        const webSocket = await new Promise(resolveSocket => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/blocked`);
          const timeout = setTimeout(() => resolveSocket('timeout'), 1500);
          socket.onopen = () => {
            clearTimeout(timeout);
            socket.close();
            resolveSocket('opened');
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            resolveSocket('blocked');
          };
        });
        return { http, webSocket };
      }, networkPort);
      assert.deepEqual(rendererNetwork, { http: 'blocked', webSocket: 'blocked' });
      assert.deepEqual(networkHits, { http: 0, webSocket: 0 });

      await jump(page, '2026-02-05');
      await page.getByTestId('mode-60').click();
      await page.getByTestId('toggle-monday').click();
      await page.getByTestId('toggle-subcharts').click();
      await frame(page);
      const historicalStart = await page.locator('html').getAttribute('data-selected-start');
      assert.ok(historicalStart);
      assert.equal(await page.locator('html').getAttribute('data-mode'), '60');
      assert.equal(await page.getByTestId('toggle-monday').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('toggle-subcharts').getAttribute('aria-pressed'), 'true');

      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="succeeded"]').waitFor({ timeout: 30_000 });
      await page.locator('#counts', { hasText: '16,542' }).waitFor();
      assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
      assert.match(await page.locator('#market-update-status').innerText(), /5 分钟 \+12.*60 分钟 \+1/);
      assert.match(await page.locator('#market-update-status').innerText(), /数据源最新至 2026-10-12 10:00/);
      assert.match(await page.locator('#coverage').innerText(), /数据源最新至 2026-10-12 10:00/);
      assert.match(await page.locator('#last-time').innerText(), /2026-10-12 10:00/);
      assert.equal((await page.locator('#last-close').innerText()).replaceAll(',', ''), '3408');
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), historicalStart);
      assert.equal(await page.locator('html').getAttribute('data-mode'), '60');
      assert.equal(await page.getByTestId('toggle-monday').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('toggle-subcharts').getAttribute('aria-pressed'), 'true');

      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="up-to-date"]').waitFor({ timeout: 30_000 });
      assert.match(await page.locator('#market-update-status').innerText(), /已是数据源当前最新/);
      assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), historicalStart);
      if (process.env.MONEYCOMING_TEST_UPDATER === '1') {
        assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'up-to-date');
      }

      await page.getByTestId('latest').click();
      await frame(page);
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), null);
      assert.equal(await page.getByTestId('date-input').inputValue(), '2026-10-12');
      await page.screenshot({ path: resolve(output, 'market-update-success.png') });
    } finally {
      await app.close();
    }
  }

  {
    const { app, page, offscreen } = await launch('offline');
    offscreenScenarios.push({ mode: 'offline', ...offscreen });
    try {
      assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
      assert.match(await page.locator('#coverage').innerText(), /数据源最新至 2026-10-12 10:00/);
      assert.equal((await page.locator('#last-close').innerText()).replaceAll(',', ''), '3408');

      await jump(page, '2026-02-05');
      const historicalStart = await page.locator('html').getAttribute('data-selected-start');
      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="failed"]').waitFor({ timeout: 30_000 });
      assert.match(await page.locator('#market-update-status').innerText(), /更新失败/);
      assert.match(await page.locator('#market-update-status').innerText(), /当前数据未受影响/);
      assert.match(await page.locator('#counts').innerText(), /16,542.*1,439/);
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), historicalStart);
      await page.screenshot({ path: resolve(output, 'market-update-offline.png') });
    } finally {
      await app.close();
    }
  }

  console.log(JSON.stringify({
    passed: true,
    scenarios: ['renderer-network-blocked', 'success', 'up-to-date', 'restart-persistence', 'offline-preserves-snapshot'],
    offscreenScenarios,
  }));
} finally {
  await new Promise(resolvePromise => networkServer.close(resolvePromise));
  if (process.env.MONEYCOMING_KEEP_MARKET_UPDATE_SMOKE !== '1') {
    await rm(sandbox, { recursive: true, force: true });
  } else {
    console.log(`保留行情更新冒烟目录：${sandbox}`);
  }
}
