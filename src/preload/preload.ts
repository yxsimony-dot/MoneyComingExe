import { contextBridge, ipcRenderer } from 'electron';
import type { Instrument, MarketAPI, MarketUpdateState, UpdateAPI, UpdateState } from '../shared/types';
const api: MarketAPI = {
  load: (instrument: Instrument, reload = false) => ipcRenderer.invoke('market:load', instrument, reload),
  readEntryRules: () => ipcRenderer.invoke('market:entry-rules'),
  openAttribution: () => ipcRenderer.invoke('market:attribution'),
  getUpdateState: instrument => ipcRenderer.invoke('market:update-state', instrument),
  update: instrument => ipcRenderer.invoke('market:update', instrument),
  updateAll: () => ipcRenderer.invoke('market:update-all'),
  onUpdateState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: MarketUpdateState) => listener(state);
    ipcRenderer.on('market:update-state-changed', handler);
    return () => ipcRenderer.removeListener('market:update-state-changed', handler);
  },
  testMode: process.env.MONEYCOMING_TEST_MODE === '1',
};
contextBridge.exposeInMainWorld('market', api);

const updates: UpdateAPI = {
  getState: () => ipcRenderer.invoke('updates:get-state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  restartAndInstall: () => ipcRenderer.invoke('updates:restart-install'),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },
};
contextBridge.exposeInMainWorld('updates', updates);
