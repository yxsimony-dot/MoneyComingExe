import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectronTest } from './electron-test-launch.mjs';
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
const legacyUpdateExpectations =
  process.env.MONEYCOMING_TEST_LEGACY_UPDATE_EXPECTATIONS === '1';
const fixturePath = join(sandbox, 'edb-fixture.csv');
const MINUTE_MS = 60_000;
const SEGMENTED_SCHEDULE = [
  {
    session: 'day',
    segments: [
      [9 * 60, 10 * 60 + 15],
      [10 * 60 + 30, 11 * 60 + 30],
      [13 * 60 + 30, 15 * 60],
    ],
  },
  {
    session: 'night',
    segments: [
      [21 * 60, 23 * 60],
    ],
  },
];

function parseBarRows(text, label) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines.shift()?.split(',');
  assert.ok(header?.length, `${label} 缺少表头`);
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
  for (const field of [
    'bar_start',
    'bar_end',
    'session',
    'observed_minutes',
    'expected_minutes',
    'complete',
  ]) {
    assert.ok(Number.isInteger(indexes[field]), `${label} 缺少 ${field}`);
  }
  return lines.filter(Boolean).map((line, rowIndex) => {
    const fields = line.split(',');
    assert.equal(fields.length, header.length, `${label} 第 ${rowIndex + 2} 行列数无效`);
    return {
      start: fields[indexes.bar_start],
      end: fields[indexes.bar_end],
      session: fields[indexes.session],
      observedMinutes: Number(fields[indexes.observed_minutes]),
      expectedMinutes: Number(fields[indexes.expected_minutes]),
      complete: fields[indexes.complete].toLowerCase() === 'true',
    };
  });
}

function beijingMs(value) {
  const parsed = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  assert.ok(Number.isFinite(parsed), `北京时间无效：${value}`);
  return parsed;
}

function segmentedSixtyMinuteStarts(fiveMinuteRows) {
  const groups = new Map();
  for (const bar of fiveMinuteRows) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):00$/.exec(bar.start);
    assert.ok(match, `5 分钟开始时间无效：${bar.start}`);
    const wallMinute = Number(match[2]) * 60 + Number(match[3]);
    const schedule = SEGMENTED_SCHEDULE.find(candidate => candidate.session === bar.session);
    assert.ok(schedule, `5 分钟交易时段无效：${bar.session}`);
    const segmentIndex = schedule.segments.findIndex(
      ([startMinute, endMinute]) => wallMinute >= startMinute && wallMinute < endMinute,
    );
    assert.ok(segmentIndex >= 0, `5 分钟不在交易分段内：${bar.start}`);
    const [segmentStart, segmentEnd] = schedule.segments[segmentIndex];
    const segmentOffset = wallMinute - segmentStart;
    const bucket = Math.floor(segmentOffset / 60);
    const bucketStartOffset = bucket * 60;
    const bucketEndOffset = Math.min(bucketStartOffset + 60, segmentEnd - segmentStart);
    assert.equal((bucketEndOffset - bucketStartOffset) % 5, 0);
    const startMs = beijingMs(`${match[1]} 00:00:00`)
      + (segmentStart + bucketStartOffset) * MINUTE_MS;
    const key = `${match[1]}|${bar.session}|${segmentIndex}|${bucket}`;
    const group = groups.get(key) ?? {
      startMs,
      endMs: beijingMs(`${match[1]} 00:00:00`)
        + (segmentStart + bucketEndOffset) * MINUTE_MS,
      bars: [],
    };
    group.bars.push(bar);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter(group => {
      const bars = group.bars.sort(
        (left, right) => beijingMs(left.start) - beijingMs(right.start),
      );
      const expectedChildren = (group.endMs - group.startMs) / (5 * MINUTE_MS);
      return bars.length === expectedChildren
        && bars.every((bar, index) => (
          beijingMs(bar.start) === group.startMs + index * 5 * MINUTE_MS
          && beijingMs(bar.end) === group.startMs + (index + 1) * 5 * MINUTE_MS
          && bar.observedMinutes === 5
          && bar.expectedMinutes === 5
          && bar.complete
        ));
    })
    .map(group => group.startMs)
    .sort((left, right) => left - right);
}

async function resolveBaselineDirectory() {
  const configured = process.env.MONEYCOMING_TEST_BUILTIN_DATA
    ? resolve(process.env.MONEYCOMING_TEST_BUILTIN_DATA)
    : undefined;
  const candidates = configured
    ? [
        join(configured, 'instruments', 'main_continuous'),
        join(configured, 'main_continuous'),
        configured,
      ]
    : [
        executable
          ? join(dirname(executable), 'data', 'instruments', 'main_continuous')
          : join(root, 'data', 'instruments', 'main_continuous'),
      ];

  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'metadata.json'));
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  throw new Error(
    `未找到行情更新测试基线 metadata.json：${candidates.join(', ')}`,
  );
}

const baselineDirectory = await resolveBaselineDirectory();
const metadata = JSON.parse(
  await readFile(join(baselineDirectory, 'metadata.json'), 'utf8'),
);
const initialBars5 = metadata.files?.bars5?.rows;
const initialBars60 = metadata.files?.bars60?.rows;
const initialBars1 = metadata.files?.bars1?.rows;
const rawMinuteName = metadata.files?.bars1?.name;
const fiveMinuteName = metadata.files?.bars5?.name;
const sixtyMinuteName = metadata.files?.bars60?.name;
assert.equal(metadata.schemaVersion, 4);
assert.ok(Number.isSafeInteger(initialBars5) && initialBars5 > 0);
assert.ok(Number.isSafeInteger(initialBars60) && initialBars60 > 0);
assert.ok(Number.isSafeInteger(initialBars1) && initialBars1 > 0);
assert.equal(typeof rawMinuteName, 'string');
assert.equal(typeof fiveMinuteName, 'string');
assert.equal(typeof sixtyMinuteName, 'string');
assert.match(metadata.sourceLatestAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

const source = await readFile(join(baselineDirectory, rawMinuteName), 'utf8');
const baselineFiveMinuteRows = parseBarRows(
  await readFile(join(baselineDirectory, fiveMinuteName), 'utf8'),
  '基线 5 分钟 CSV',
);
const legacySixtyMinuteRows = parseBarRows(
  await readFile(join(baselineDirectory, sixtyMinuteName), 'utf8'),
  '基线 60 分钟 CSV',
);
assert.equal(baselineFiveMinuteRows.length, initialBars5);
assert.equal(legacySixtyMinuteRows.length, initialBars60);
const canonicalBaselineSixtyStarts = segmentedSixtyMinuteStarts(baselineFiveMinuteRows);
assert.ok(canonicalBaselineSixtyStarts.length > initialBars60);
const [header, ...sourceRows] = source.trim().split(/\r?\n/);
const finalSourceFields = sourceRows.at(-1)?.split(',');
assert.equal(finalSourceFields?.length, 8);
const finalSourceStartMs = Number(BigInt(finalSourceFields[0]) / 1_000_000n);
const finalSourceClose = Number(finalSourceFields[4]);
assert.ok(Number.isFinite(finalSourceStartMs));
assert.ok(Number.isFinite(finalSourceClose));

const finalSourceDate = new Date(finalSourceStartMs + 8 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const overlapStartNano = BigInt(
  Date.parse(`${finalSourceDate}T00:00:00+08:00`) - 24 * 60 * 60 * 1000,
) * 1_000_000n;
const overlapRows = sourceRows.filter(row => BigInt(row.split(',', 1)[0]) >= overlapStartNano);

function nextWeekday(dateText) {
  const [year, month, day] = dateText.slice(0, 10).split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  do {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  } while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6);
  return candidate.toISOString().slice(0, 10);
}

function countPattern(bars5, bars60) {
  return new RegExp(
    `${bars5.toLocaleString('en-US')}.*${bars60.toLocaleString('en-US')}`,
  );
}

const syntheticDate = nextWeekday(metadata.sourceLatestAt);
const syntheticStartMs = Date.parse(`${syntheticDate}T09:00:00+08:00`);
const syntheticLatest = `${syntheticDate} 10:00`;
const syntheticBase = Math.ceil(finalSourceClose) + 10;
const expectedBars1 = initialBars1 + 60;
const expectedBars5 = initialBars5 + 12;
const syntheticSixtyStartMs = beijingMs(`${syntheticDate} 09:00:00`);
const expectedSixtyStarts = [...canonicalBaselineSixtyStarts, syntheticSixtyStartMs];
const legacySixtyStarts = new Set(
  legacySixtyMinuteRows.map(bar => beijingMs(bar.start)),
);
const expectedAdded60 = legacyUpdateExpectations
  ? 1
  : expectedSixtyStarts.filter(
    startMs => !legacySixtyStarts.has(startMs),
  ).length;
const expectedBars60 = legacyUpdateExpectations
  ? initialBars60 + expectedAdded60
  : expectedSixtyStarts.length;
const expectedFinalClose = syntheticBase + 6;
const syntheticRows = Array.from({ length: 60 }, (_, index) => {
  const startMs = syntheticStartMs + index * 60_000;
  const open = syntheticBase + Math.floor(index / 10);
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
    MONEYCOMING_TEST_NOW: `${syntheticDate}T16:00:00+08:00`,
  };
  if (process.env.MONEYCOMING_TEST_APPDATA) {
    env.APPDATA = process.env.MONEYCOMING_TEST_APPDATA;
  }
  if (process.env.MONEYCOMING_TEST_LOCALAPPDATA) {
    env.LOCALAPPDATA = process.env.MONEYCOMING_TEST_LOCALAPPDATA;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const options = {
    args: executable ? [] : [root],
    env,
    timeout: 30_000,
  };
  if (executable) options.executablePath = executable;
  const app = await launchElectronTest(options);
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

async function rolloverDiagnostics(page, period) {
  return {
    count: await page.locator(`#card-${period}`).getAttribute('data-rollover-count'),
    labels: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-labels')),
    starts: JSON.parse(await page.locator(`#card-${period}`).getAttribute('data-rollover-starts')),
  };
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
      assert.match(
        await page.locator('#counts').innerText(),
        countPattern(initialBars5, initialBars60),
      );
      const initialRollovers = {
        5: await rolloverDiagnostics(page, 5),
        60: await rolloverDiagnostics(page, 60),
      };
      assert.equal(initialRollovers[5].count, '3');
      assert.equal(initialRollovers[60].count, '3');
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
      assert.deepEqual(await rolloverDiagnostics(page, 5), initialRollovers[5]);
      assert.deepEqual(await rolloverDiagnostics(page, 60), initialRollovers[60]);

      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="succeeded"]').waitFor({ timeout: 30_000 });
      await page.locator('#counts', {
        hasText: expectedBars5.toLocaleString('en-US'),
      }).waitFor();
      assert.match(
        await page.locator('#counts').innerText(),
        countPattern(expectedBars5, expectedBars60),
      );
      assert.match(
        await page.locator('#market-update-status').innerText(),
        new RegExp(`5 分钟 \\+12.*60 分钟 \\+${expectedAdded60}`),
      );
      assert.ok((await page.locator('#market-update-status').innerText()).includes(syntheticLatest));
      assert.ok((await page.locator('#coverage').innerText()).includes(syntheticLatest));
      assert.ok((await page.locator('#last-time').innerText()).includes(syntheticLatest));
      assert.equal(
        Number((await page.locator('#last-close').innerText()).replaceAll(',', '')),
        expectedFinalClose,
      );
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), historicalStart);
      assert.equal(await page.locator('html').getAttribute('data-mode'), '60');
      assert.equal(await page.getByTestId('toggle-monday').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('toggle-subcharts').getAttribute('aria-pressed'), 'true');
      const updatedRollovers = {
        5: await rolloverDiagnostics(page, 5),
        60: await rolloverDiagnostics(page, 60),
      };
      assert.deepEqual(updatedRollovers[60], updatedRollovers[5]);
      const snapshotRoot = join(
        userData,
        'market-data',
        'instruments',
        'main_continuous',
      );
      const pointer = JSON.parse(
        await readFile(join(snapshotRoot, 'current.json'), 'utf8'),
      );
      assert.equal(typeof pointer.snapshotId, 'string');
      const snapshotMetadata = JSON.parse(
        await readFile(
          join(snapshotRoot, 'snapshots', pointer.snapshotId, 'metadata.json'),
          'utf8',
        ),
      );
      if (legacyUpdateExpectations) {
        assert.equal(snapshotMetadata.schemaVersion, 4);
      } else {
        assert.equal(pointer.schemaVersion, 5);
        assert.equal(snapshotMetadata.schemaVersion, 5);
      }
      assert.equal(snapshotMetadata.snapshotId, pointer.snapshotId);
      assert.equal(snapshotMetadata.files?.bars1?.rows, expectedBars1);
      assert.equal(snapshotMetadata.files?.bars5?.rows, expectedBars5);
      assert.equal(snapshotMetadata.files?.bars60?.rows, expectedBars60);

      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="up-to-date"]').waitFor({ timeout: 30_000 });
      assert.match(await page.locator('#market-update-status').innerText(), /已是数据源当前最新/);
      assert.match(
        await page.locator('#counts').innerText(),
        countPattern(expectedBars5, expectedBars60),
      );
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), historicalStart);
      assert.deepEqual(await rolloverDiagnostics(page, 5), updatedRollovers[5]);
      assert.deepEqual(await rolloverDiagnostics(page, 60), updatedRollovers[60]);
      if (process.env.MONEYCOMING_TEST_UPDATER === '1') {
        assert.equal(await page.locator('html').getAttribute('data-update-phase'), 'up-to-date');
      }

      await page.getByTestId('latest').click();
      await frame(page);
      assert.equal(await page.locator('html').getAttribute('data-selected-start'), null);
      assert.equal(await page.getByTestId('date-input').inputValue(), syntheticDate);
      await page.screenshot({ path: resolve(output, 'market-update-success.png') });
    } finally {
      await app.close();
    }
  }

  {
    const { app, page, offscreen } = await launch('offline');
    offscreenScenarios.push({ mode: 'offline', ...offscreen });
    try {
      assert.match(
        await page.locator('#counts').innerText(),
        countPattern(expectedBars5, expectedBars60),
      );
      assert.ok((await page.locator('#coverage').innerText()).includes(syntheticLatest));
      assert.equal(
        Number((await page.locator('#last-close').innerText()).replaceAll(',', '')),
        expectedFinalClose,
      );

      await jump(page, '2026-02-05');
      const historicalStart = await page.locator('html').getAttribute('data-selected-start');
      await page.getByTestId('market-update').click();
      await page.locator('html[data-market-update-phase="failed"]').waitFor({ timeout: 30_000 });
      assert.match(await page.locator('#market-update-status').innerText(), /更新失败/);
      assert.match(await page.locator('#market-update-status').innerText(), /当前数据未受影响/);
      assert.match(
        await page.locator('#counts').innerText(),
        countPattern(expectedBars5, expectedBars60),
      );
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
