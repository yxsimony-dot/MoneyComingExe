import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  shell,
  screen,
  powerMonitor,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatBeijing } from '../domain/time';
import {
  createDataService,
  resolveMarketDataPaths,
  type DataServiceDiagnostics,
} from './data-service';
import { createWorkerMarketDataPreparation } from './market-data-preparation';
import { EdbClient, fetchEdbChunks, fetchEdbContractMappings } from './edb-client';
import { FakeUpdater, type FakeMode } from './fake-updater';
import { registerMarketUpdateIpc } from './market-update-ipc';
import { saveMarketSnapshot } from './market-snapshot';
import { MarketUpdateCoordinator } from './market-update-coordinator';
import { OnlineMarketCoordinator } from './online-market-coordinator';
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
import {
  installTestEdbSource,
  type TestEdbRequestRecord,
} from './test-edb-source';
import { createTestClock, readTestControls, testDelay } from './test-controls';
import { isTrustedMainWindowEvent } from './trusted-ipc';
import { UpdateCoordinator, type UpdaterAdapter } from './update-coordinator';
import type {
  Instrument,
  MarketUpdateState,
  OnlineMarketState,
} from '../shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('MoneyComing');
const testMode = process.env.MONEYCOMING_TEST_MODE === '1';
const testControls = readTestControls(testMode);
const testClock = createTestClock(testControls);
const testDiagnostics = testMode
  ? {
      edbRequests: [] as TestEdbRequestRecord[],
      marketStates: [] as MarketUpdateState[],
      onlineStates: [] as OnlineMarketState[],
    }
  : undefined;
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
        onRequest: request => testDiagnostics?.edbRequests.push(
          structuredClone(request),
        ),
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
  const workerScriptPath = app.isPackaged
    ? join(
        process.resourcesPath,
        'app.asar.unpacked',
        'build',
        'market-data-worker.cjs',
      )
    : join(app.getAppPath(), 'build', 'market-data-worker.cjs');
  const service = createDataService(marketPaths, {
    testMode,
    preparationBackend: createWorkerMarketDataPreparation(workerScriptPath),
  });
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
    saveSnapshot: (definition, candidate, intent, current) => saveMarketSnapshot(
      marketPaths,
      definition,
      candidate,
      { intent, current },
    ),
    invalidate: instrument => service.invalidate(instrument),
    publish: state => {
      testDiagnostics?.marketStates.push(structuredClone(state));
      if (window && !window.isDestroyed()) {
        window.webContents.send('market:update-state-changed', state);
      }
    },
    publishActivation: activated => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('market:snapshot-activated', activated);
      }
    },
    now: testClock.now,
  });
  const onlineCoordinator = new OnlineMarketCoordinator({
    update: (instrument, intent) => marketCoordinator.update(instrument, intent),
    loadSnapshot: async instrument => {
      const snapshot = await service.loadSnapshot(instrument);
      const lastMinute = snapshot.bars1.at(-1);
      return {
        localMinuteLatestAt: lastMinute
          ? formatBeijing(lastMinute.startMs + 60_000)
          : snapshot.sourceLatestAt,
        sourceLatestAt: snapshot.sourceLatestAt,
        snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
      };
    },
    publish: state => {
      testDiagnostics?.onlineStates.push(structuredClone(state));
      if (window && !window.isDestroyed()) {
        window.webContents.send('market:online-state-changed', state);
      }
    },
    now: testClock.now,
    setTimer: testClock.setTimer,
    clearTimer: testClock.clearTimer,
  });
  if (testDiagnostics) {
    const scope = globalThis as typeof globalThis & {
      __moneyComingTest?: {
        clearDiagnostics: () => void;
        getEdbRequests: () => TestEdbRequestRecord[];
        getMarketStates: () => MarketUpdateState[];
        getOnlineStates: () => OnlineMarketState[];
        getDataServiceDiagnostics: () => DataServiceDiagnostics | undefined;
      };
    };
    scope.__moneyComingTest = {
      clearDiagnostics: () => {
        testDiagnostics.edbRequests.length = 0;
        testDiagnostics.marketStates.length = 0;
        testDiagnostics.onlineStates.length = 0;
      },
      getEdbRequests: () => structuredClone(testDiagnostics.edbRequests),
      getMarketStates: () => structuredClone(testDiagnostics.marketStates),
      getOnlineStates: () => structuredClone(testDiagnostics.onlineStates),
      getDataServiceDiagnostics: () => service.getTestDiagnostics?.(),
    };
  }
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
    online: onlineCoordinator,
    trusted,
  });
  const handleResume = () => onlineCoordinator.resume();
  powerMonitor.on('resume', handleResume);

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
  let runtimeDisposed = false;
  const disposeRuntime = () => {
    if (runtimeDisposed) return;
    runtimeDisposed = true;
    powerMonitor.removeListener('resume', handleResume);
    onlineCoordinator.dispose();
    void service.dispose();
  };
  app.once('before-quit', disposeRuntime);
  window.on('closed', () => {
    disposeRuntime();
    window = null;
  });
  window.loadURL('app://viewer/index.html');
}).catch(error => {
  console.error('MoneyComing failed to initialize:', error);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
