import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import os from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = resolve(process.env.MONEYCOMING_EXE || 'release/win-unpacked/MoneyComing.exe');
const runs = [];
for (let run = 0; run < 3; run++) {
  const start = performance.now();
  const app = await electron.launch({ executablePath, args: [], env, cwd: os.tmpdir() });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setBackgroundThrottling(false);
      win.setSize(1440, 900);
      win.show();
    });
    await page.locator('html[data-ready="true"]').waitFor();
    const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await painted();
    const startupMs = performance.now() - start;
    const switchTo = async instrument => {
      await page.getByTestId('instrument').selectOption(instrument);
      await page.locator(`html[data-instrument="${instrument}"]`).waitFor();
      await painted();
    };
    await switchTo('m2701');
    await switchTo('main_continuous');
    const cachedStart = performance.now();
    await switchTo('m2701');
    const cachedSwitchMs = performance.now() - cachedStart;
    await page.evaluate(() => {
      window.measuredLongTasks = [];
      window.longTaskObserver = new PerformanceObserver(list => window.measuredLongTasks.push(...list.getEntries().map(e => e.duration)));
      window.longTaskObserver.observe({ type: 'longtask' });
    });
    const box = await page.locator('#canvas-5').boundingBox();
    const y = box.y + box.height * .3;
    await page.mouse.move(box.x + box.width * .65, y);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(box.x + box.width * (i % 2 ? .65 : .25), y, { steps: 20 });
    }
    await page.mouse.up();
    await painted();
    const dragLongTasksMs = await page.evaluate(() => { window.longTaskObserver.disconnect(); return window.measuredLongTasks; });
    const maxDragLongTaskMs = Math.max(0, ...dragLongTasksMs);
    const metrics = { run: run + 1, startupMs, cachedSwitchMs, maxDragLongTaskMs, dragLongTasksMs };
    runs.push(metrics);
    console.log(JSON.stringify(metrics));
  } finally { await app.close(); }
}
await mkdir('artifacts', { recursive: true });
const result = { executablePath, os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemoryGiB: os.totalmem() / 2 ** 30, runs, notes: 'Process launch to ready plus two animation frames; cached switch includes Playwright control overhead. Long Tasks API records tasks >=50ms; 0 means none observed. Same-machine repeated starts, not OS cold boot.' };
await writeFile('artifacts/performance.json', JSON.stringify(result, null, 2));
assert.ok(runs.every(r => r.startupMs <= 5000 && r.cachedSwitchMs <= 1000 && r.maxDragLongTaskMs <= 200), JSON.stringify(result));
