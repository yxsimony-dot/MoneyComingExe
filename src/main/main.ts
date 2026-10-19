import { app, BrowserWindow, ipcMain, protocol, net, session, shell, screen } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataService, resolveMarketDataPaths } from './data-service';
import { EdbClient, fetchEdbChunks, fetchEdbContractMappings } from './edb-client';
import { FakeUpdater, type FakeMode } from './fake-updater';
import { registerMarketUpdateIpc } from './market-update-ipc';
import { saveMarketSnapshot } from './market-snapshot';
import { MarketUpdateCoordinator } from './market-update-coordinator';
import { isOffscreenTestLaunch, windowPositionOptionsForLaunch } from './offscreen-window';
import {
  isAllowedMarketRequest,
  MARKET_REQUEST_URL_PATTERNS,
  MARKET_UPDATE_SESSION_PARTITION,
  PERSISTENT_TEST_VIEWER_SESSION_PARTITION,
  TEST_VIEWER_SESSION_PARTITION,
  VIEWER_BLOCKED_URL_PATTERNS,
  VIEWER_SESSION_PARTITION,
} from './network-policy';
import { installTestEdbSource } from './test-edb-source';
import { readTestControls, testDelay } from './test-controls';
import { isTrustedMainWindowEvent } from './trusted-ipc';
import { UpdateCoordinator, type UpdaterAdapter } from './update-coordinator';
import type { Instrument } from '../shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('MoneyComing');
const testMode = process.env.MONEYCOMING_TEST_MODE === '1';
const testControls = readTestControls(testMode);
const offscreenTestWindow = isOffscreenTestLaunch(
  testMode,
  process.argv,
  process.env.MONEYCOMING_TEST_WINDOW_OFFSCREEN === '1',
);
if (testMode && process.env.MONEYCOMING_TEST_USER_DATA) {
  app.setPath('userData', resolve(process.env.MONEYCOMING_TEST_USER_DATA));
}
let window: BrowserWindow | null = null;

app.whenReady().then(async () => {
  const rendererRoot = resolve(app.getAppPath(), 'dist');
  const viewerPartition = testMode
    ? process.env.MONEYCOMING_TEST_USER_DATA
      ? PERSISTENT_TEST_VIEWER_SESSION_PARTITION
      : TEST_VIEWER_SESSION_PARTITION
    : VIEWER_SESSION_PARTITION;
  const viewerSession = session.fromPartition(viewerPartition);
  viewerSession.protocol.handle('app', request => {
    const url = new URL(request.url);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const target = resolve(rendererRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (url.host !== 'viewer' || !target.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  viewerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  viewerSession.webRequest.onBeforeRequest(
    { urls: [...VIEWER_BLOCKED_URL_PATTERNS] },
    (_details, callback) => callback({ cancel: true }),
  );
  const marketSession = session.fromPartition(MARKET_UPDATE_SESSION_PARTITION);
  marketSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  marketSession.webRequest.onBeforeRequest(
    { urls: [...MARKET_REQUEST_URL_PATTERNS] },
    (details, callback) => callback({ cancel: !isAllowedMarketRequest(details.url, details.method) }),
  );
  if (testMode) {
    await installTestEdbSource(
      marketSession,
      process.env.MONEYCOMING_TEST_EDB_MODE,
      process.env.MONEYCOMING_TEST_EDB_FIXTURE,
      {
        delays: testControls.edbDelays,
        failures: testControls.edbFailures,
        priceOffsets: testControls.edbPriceOffsets,
      },
    );
  }
  const marketPaths = resolveMarketDataPaths(
    process.execPath,
    app.isPackaged,
    app.getAppPath(),
    app.getPath('userData'),
  );
  if (testControls.builtinDataDirectory) {
    const testDataDirectory = resolve(testControls.builtinDataDirectory);
    marketPaths.builtinDataDirectory = testDataDirectory;
    marketPaths.legacyBuiltinDataDirectory = testDataDirectory;
  }
  const service = createDataService(marketPaths);
  const edbClient = new EdbClient({
    fetch: (input, init) => marketSession.fetch(input, init) as unknown as Promise<Response>,
  });
  function trusted(event: Electron.IpcMainInvokeEvent): boolean {
    return isTrustedMainWindowEvent(event, window);
  }
  const marketCoordinator = new MarketUpdateCoordinator({
    loadSnapshot: definition => service.loadSnapshot(definition.id),
    fetchMinutes: (definition, startMs, endMs) => fetchEdbChunks(
      edbClient,
      definition,
      startMs,
      endMs,
    ),
    fetchContractMappings: (definition, startMs, endMs) => fetchEdbContractMappings(
      edbClient,
      definition,
      startMs,
      endMs,
    ),
    saveSnapshot: (definition, candidate) => saveMarketSnapshot(
      marketPaths,
      definition,
      candidate,
    ),
    invalidate: instrument => service.invalidate(instrument),
    publish: state => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('market:update-state-changed', state);
      }
    },
    now: testControls.now
      ? () => new Date(testControls.now!.getTime())
      : undefined,
  });
  ipcMain.handle('market:load', async (event, instrument: Instrument, reload: boolean) => {
    if (!trusted(event)) return { ok: false, error: '来源不受信任' };
    if (typeof instrument !== 'string' || (reload !== undefined && typeof reload !== 'boolean')) return { ok: false, error: '行情请求参数无效' };
    await testDelay(testControls.loadDelays[instrument]);
    const forcedFailure = testControls.loadFailures[instrument];
    if (forcedFailure) return { ok: false, error: forcedFailure };
    return service.load(instrument, reload === true);
  });
  ipcMain.handle('market:entry-rules', event => {
    if (!trusted(event)) return { ok: false, text: '', path: '', fallback: true, error: '来源不受信任' };
    return service.readEntryRules();
  });
  ipcMain.handle('market:attribution', async event => {
    if (trusted(event)) await shell.openExternal('https://www.tradingview.com/');
  });
  registerMarketUpdateIpc({
    ipc: ipcMain,
    coordinator: marketCoordinator,
    trusted,
  });

  const primaryDisplay = screen.getPrimaryDisplay();
  const area = primaryDisplay.workAreaSize;
  const windowSize = {
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
  };
  const windowPosition = windowPositionOptionsForLaunch(
    offscreenTestWindow,
    screen.getAllDisplays().map(display => display.bounds),
    windowSize,
    primaryDisplay.workArea.y,
  );
  window = new BrowserWindow({
    title: 'MoneyComing · 主连历史看盘', ...windowSize, ...windowPosition,
    minWidth: 1100, minHeight: 720, backgroundColor: '#101419', show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'build/preload.cjs'),
      partition: viewerPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const useTestUpdater = process.env.MONEYCOMING_TEST_UPDATER === '1';
  const updatesEnabled = (app.isPackaged && !testMode) || useTestUpdater;
  const updater: UpdaterAdapter = useTestUpdater
    ? new FakeUpdater((process.env.MONEYCOMING_TEST_UPDATE_MODE || 'available') as FakeMode)
    : autoUpdater as unknown as UpdaterAdapter;
  const coordinator = new UpdateCoordinator({
    updater,
    currentVersion: app.getVersion(),
    enabled: updatesEnabled,
    publish: state => {
      if (window && !window.isDestroyed()) window.webContents.send('updates:state', state);
    },
  });
  ipcMain.handle('updates:get-state', event => {
    if (!trusted(event)) throw new Error('来源不受信任');
    return coordinator.getState();
  });
  ipcMain.handle('updates:check', event => {
    if (!trusted(event)) throw new Error('来源不受信任');
    return coordinator.check('manual');
  });
  ipcMain.handle('updates:download', event => {
    if (!trusted(event)) throw new Error('来源不受信任');
    return coordinator.download();
  });
  ipcMain.handle('updates:restart-install', event => {
    if (!trusted(event)) throw new Error('来源不受信任');
    return coordinator.restartAndInstall();
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => {
    if (!testMode) window?.show();
    setTimeout(() => void coordinator.check('startup'), 500);
  });
  window.on('closed', () => { window = null; });
  window.loadURL('app://viewer/index.html');
}).catch(error => {
  console.error('MoneyComing failed to initialize:', error);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
