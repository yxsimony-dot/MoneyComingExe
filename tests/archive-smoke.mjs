import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const zip = JSON.parse(await readFile('artifacts/zip.json', 'utf8'));
const executablePath = join(zip.extractedTo, 'MoneyComing.exe');
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
assert.equal(await hash(executablePath), await hash('release/win-unpacked/MoneyComing.exe'));
assert.equal(await hash(join(zip.extractedTo, 'resources/app.asar')), await hash('release/win-unpacked/resources/app.asar'));
const env = { ...process.env, MONEYCOMING_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, args: [], env, cwd: process.env.TEMP });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.showInactive(); });
  await page.locator('html[data-ready="true"][data-instrument="main_continuous"]').waitFor();
  assert.match(await page.locator('#counts').innerText(), /16,530.*1,438/);
  const loaded = await page.evaluate(() => window.market.load('m2701'));
  assert.ok(loaded.ok);
  assert.equal(loaded.data.bars5.length, 11793);
  assert.equal(loaded.data.bars60.length, 1026);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: resolve('artifacts/zip-startup.png') });
  await writeFile('artifacts/zip-startup.json', JSON.stringify({ passed: true, executablePath, exeAndAsarMatchPackage: true, mainRows: [16530, 1438], contractRows: [11793, 1026] }, null, 2));
  console.log('Extracted ZIP application started and loaded both instruments successfully.');
} finally { await app.close(); }
