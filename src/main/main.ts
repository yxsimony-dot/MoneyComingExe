import { app, BrowserWindow, ipcMain, protocol, net, session, shell, screen } from 'electron';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataService, resolveDataDirectory } from './data-service';
import type { Instrument } from '../shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('MoneyComing');
let window: BrowserWindow | null = null;

app.whenReady().then(() => {
  const rendererRoot = resolve(app.getAppPath(), 'dist');
  protocol.handle('app', request => {
    const url = new URL(request.url);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const target = resolve(rendererRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (url.host !== 'viewer' || !target.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const service = createDataService(resolveDataDirectory(process.execPath, app.isPackaged, app.getAppPath()));
  function trusted(event: Electron.IpcMainInvokeEvent): boolean {
    return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('app://viewer/');
  }
  ipcMain.handle('market:load', (event, instrument: Instrument, reload: boolean) => {
    if (!trusted(event)) return { ok: false, error: '来源不受信任' };
    if (typeof instrument !== 'string' || (reload !== undefined && typeof reload !== 'boolean')) return { ok: false, error: '行情请求参数无效' };
    return service.load(instrument, reload === true);
  });
  ipcMain.handle('market:entry-rules', event => {
    if (!trusted(event)) return { ok: false, text: '', path: '', fallback: true, error: '来源不受信任' };
    return service.readEntryRules();
  });
  ipcMain.handle('market:attribution', async event => {
    if (trusted(event)) await shell.openExternal('https://www.tradingview.com/');
  });

  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    title: 'MoneyComing · 豆粕历史看盘', width: Math.min(1440, area.width), height: Math.min(900, area.height),
    minWidth: 1100, minHeight: 720, backgroundColor: '#101419', show: false,
    webPreferences: { preload: join(app.getAppPath(), 'build/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => { if (process.env.MONEYCOMING_TEST_MODE !== '1') window?.show(); });
  window.on('closed', () => { window = null; });
  window.loadURL('app://viewer/index.html');
});
app.on('window-all-closed', () => app.quit());
