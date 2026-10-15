import type { IpcMainInvokeEvent } from 'electron';
import type { MarketUpdateState } from '../shared/types';

export interface MarketUpdateIpc {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent) => MarketUpdateState | Promise<MarketUpdateState>,
  ): void;
}

export interface MarketUpdateIpcCoordinator {
  getState(): MarketUpdateState;
  update(): Promise<MarketUpdateState>;
}

export interface RegisterMarketUpdateIpcOptions {
  ipc: MarketUpdateIpc;
  coordinator: MarketUpdateIpcCoordinator;
  trusted: (event: IpcMainInvokeEvent) => boolean;
}

export function registerMarketUpdateIpc(options: RegisterMarketUpdateIpcOptions): void {
  const requireTrusted = (event: IpcMainInvokeEvent) => {
    if (!options.trusted(event)) throw new Error('来源不受信任');
  };
  options.ipc.handle('market:update-state', event => {
    requireTrusted(event);
    return options.coordinator.getState();
  });
  options.ipc.handle('market:update', event => {
    requireTrusted(event);
    return options.coordinator.update();
  });
}
