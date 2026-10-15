import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { assertElectronWindowOffscreen } from './electron-offscreen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts');
const builtinDirectory = join(root, 'futures_investigation_20261009');
const fiveName = 'edb_main_continuous_5m.csv';
const sixtyName = 'edb_main_continuous_60m.csv';
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-market-update-live-'));
const userData = join(sandbox, 'user-data');
const executable = process.env.MONEYCOMING_EXE
  ? resolve(process.env.MONEYCOMING_EXE)
  : undefined;

await mkdir(output, { recursive: true });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileHash(path) {
  return sha256(await readFile(path));
}

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const header = headerLine.replace(/^\uFEFF/, '').split(',');
  return {
    header,
    rows: lines.map(line => {
      const values = line.split(',');
      return Object.fromEntries(header.map((name, index) => [name, values[index]]));
    }),
  };
}

function summarizeOverlap(before, after, requestStart) {
  const afterByStart = new Map(after.rows.map(row => [row.bar_start, row]));
  const fields = before.header.filter(field => field !== 'bar_start');
  const numericFields = new Set([
    'open',
    'high',
    'low',
    'close',
    'volume',
    'open_oi',
    'close_oi',
    'observed_minutes',
    'expected_minutes',
  ]);
  const equal = (field, left, right) => {
    if (numericFields.has(field)) return Number(left) === Number(right);
    if (field === 'complete') return left.toLowerCase() === right.toLowerCase();
    return left === right;
  };
  const comparisons = before.rows
    .filter(row => row.bar_start >= requestStart && afterByStart.has(row.bar_start))
    .map(row => {
      const next = afterByStart.get(row.bar_start);
      const changedFields = fields.filter(field => !equal(field, row[field], next[field]));
      return { barStart: row.bar_start, changedFields };
    });
  return {
    comparedRows: comparisons.length,
    identicalRows: comparisons.filter(item => item.changedFields.length === 0).length,
    changedRows: comparisons.filter(item => item.changedFields.length > 0).length,
    changedSamples: comparisons.filter(item => item.changedFields.length > 0).slice(0, 10),
  };
}

async function launch() {
  const env = {
    ...process.env,
    MONEYCOMING_TEST_MODE: '1',
    MONEYCOMING_TEST_USER_DATA: userData,
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
  const offscreenBeforeShow = await assertElectronWindowOffscreen(app, 'market-update-live-before-show');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const offscreenAfterShow = await assertElectronWindowOffscreen(app, 'market-update-live-after-show');
  await page.locator('html[data-ready="true"]').waitFor({ timeout: 30_000 });
  return { app, page, offscreen: { beforeShow: offscreenBeforeShow, afterShow: offscreenAfterShow } };
}

const builtinPaths = {
  bars5: join(builtinDirectory, fiveName),
  bars60: join(builtinDirectory, sixtyName),
};
const builtinTexts = {
  bars5: await readFile(builtinPaths.bars5, 'utf8'),
  bars60: await readFile(builtinPaths.bars60, 'utf8'),
};
const builtinHashesBefore = {
  bars5: await fileHash(builtinPaths.bars5),
  bars60: await fileHash(builtinPaths.bars60),
};
const before = {
  bars5: parseCsv(builtinTexts.bars5),
  bars60: parseCsv(builtinTexts.bars60),
};

let app;
try {
  const launched = await launch();
  app = launched.app;
  const { page } = launched;
  await page.getByTestId('market-update').click();
  await page.waitForFunction(() => {
    const phase = document.documentElement.dataset.marketUpdatePhase;
    return phase === 'succeeded' || phase === 'up-to-date' || phase === 'failed';
  }, undefined, { timeout: 120_000 });
  const phase = await page.locator('html').getAttribute('data-market-update-phase');
  const statusText = await page.locator('#market-update-status').innerText();
  assert.notEqual(phase, 'failed', statusText);
  await page.screenshot({ path: join(output, 'market-update-live.png') });
  await app.close();
  app = undefined;

  const marketDataDirectory = join(userData, 'market-data');
  const pointer = JSON.parse(await readFile(join(marketDataDirectory, 'current.json'), 'utf8'));
  const snapshotDirectory = join(marketDataDirectory, 'snapshots', pointer.snapshotId);
  const snapshotNames = await readdir(snapshotDirectory);
  const metadata = JSON.parse(await readFile(join(snapshotDirectory, 'metadata.json'), 'utf8'));
  const afterTexts = {
    bars5: await readFile(join(snapshotDirectory, fiveName), 'utf8'),
    bars60: await readFile(join(snapshotDirectory, sixtyName), 'utf8'),
  };
  const after = {
    bars5: parseCsv(afterTexts.bars5),
    bars60: parseCsv(afterTexts.bars60),
  };
  const builtinHashesAfter = {
    bars5: await fileHash(builtinPaths.bars5),
    bars60: await fileHash(builtinPaths.bars60),
  };
  const requestStart = metadata.requestStart;
  const result = {
    passed: true,
    executable: executable ?? 'development-electron',
    phase,
    statusText,
    offscreen: launched.offscreen,
    before: {
      bars5: {
        rows: before.bars5.rows.length,
        latest: before.bars5.rows.at(-1)?.bar_end,
      },
      bars60: {
        rows: before.bars60.rows.length,
        latest: before.bars60.rows.at(-1)?.bar_end,
      },
    },
    after: {
      bars5: {
        rows: after.bars5.rows.length,
        latest: after.bars5.rows.at(-1)?.bar_end,
      },
      bars60: {
        rows: after.bars60.rows.length,
        latest: after.bars60.rows.at(-1)?.bar_end,
      },
    },
    overlap: {
      bars5: summarizeOverlap(before.bars5, after.bars5, requestStart),
      bars60: summarizeOverlap(before.bars60, after.bars60, requestStart),
    },
    builtinHashesBefore,
    builtinHashesAfter,
    snapshot: {
      directory: snapshotDirectory,
      files: snapshotNames.sort(),
      metadata,
    },
  };

  assert.ok(after.bars5.rows.length >= before.bars5.rows.length);
  assert.ok(after.bars60.rows.length >= before.bars60.rows.length);
  assert.ok(after.bars5.rows.at(-1).bar_end >= before.bars5.rows.at(-1).bar_end);
  assert.ok(after.bars60.rows.at(-1).bar_end >= before.bars60.rows.at(-1).bar_end);
  assert.ok(result.overlap.bars5.comparedRows > 0);
  assert.ok(result.overlap.bars60.comparedRows > 0);
  assert.deepEqual(builtinHashesAfter, builtinHashesBefore);
  assert.deepEqual(metadata.source, {
    provider: 'EDB',
    endpoint: 'https://edb.shinnytech.com/md/kline',
    symbol: 'KQ.m@DCE.m',
  });
  assert.equal(JSON.stringify(metadata).toLowerCase().includes('sina'), false);
  assert.deepEqual(snapshotNames.sort(), [
    'activated.json',
    fiveName,
    'metadata.json',
    sixtyName,
  ].sort());

  await writeFile(
    join(output, 'market-update-live-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (process.env.MONEYCOMING_KEEP_LIVE_UPDATE !== '1') {
    await rm(sandbox, { recursive: true, force: true });
  } else {
    console.log(`保留真实行情更新目录：${sandbox}`);
  }
}
