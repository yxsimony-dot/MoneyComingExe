import { contextBridge, ipcRenderer } from 'electron';
import type {
  Instrument,
  MarketAPI,
  MarketSnapshotActivatedEvent,
  MarketUpdateState,
  OnlineMarketState,
  UpdateAPI,
  UpdateState,
} from '../shared/types';
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
  getOnlineState: () => ipcRenderer.invoke('market:online-state'),
  setOnlineEnabled: enabled => ipcRenderer.invoke('market:online-enabled', enabled),
  setCurrentInstrument: instrument => ipcRenderer.invoke(
    'market:current-instrument',
    instrument,
  ),
  notifyNetworkRecovered: () => ipcRenderer.invoke('market:network-recovered'),
  onOnlineState: listener => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: OnlineMarketState,
    ) => listener(state);
    ipcRenderer.on('market:online-state-changed', handler);
    return () => ipcRenderer.removeListener('market:online-state-changed', handler);
  },
  onSnapshotActivated: listener => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      activated: MarketSnapshotActivatedEvent,
    ) => listener(activated);
    ipcRenderer.on('market:snapshot-activated', handler);
    return () => ipcRenderer.removeListener('market:snapshot-activated', handler);
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
