import { contextBridge, ipcRenderer } from 'electron';
import type { Instrument, MarketAPI } from '../shared/types';
const api: MarketAPI = {
  load: (instrument: Instrument, reload = false) => ipcRenderer.invoke('market:load', instrument, reload),
  readEntryRules: () => ipcRenderer.invoke('market:entry-rules'),
  openAttribution: () => ipcRenderer.invoke('market:attribution'),
};
contextBridge.exposeInMainWorld('market', api);
