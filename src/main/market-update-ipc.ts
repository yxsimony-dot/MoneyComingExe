import type { IpcMainInvokeEvent } from 'electron';
import { isInstrument } from '../shared/instruments';
import type {
  Instrument,
  MarketUpdateAllResult,
  MarketUpdateState,
} from '../shared/types';

type MarketUpdateIpcResult = MarketUpdateState | MarketUpdateAllResult;

export interface MarketUpdateIpc {
  handle(
    channel: string,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => MarketUpdateIpcResult | Promise<MarketUpdateIpcResult>,
  ): void;
}

export interface MarketUpdateIpcCoordinator {
  getState(instrument: Instrument): MarketUpdateState;
  update(instrument: Instrument): Promise<MarketUpdateState>;
  updateAll(): Promise<MarketUpdateAllResult>;
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
  const requireInstrument = (args: unknown[]): Instrument => {
    if (args.length !== 1 || !isInstrument(args[0])) {
      throw new Error('行情品种参数无效');
    }
    return args[0];
  };
  options.ipc.handle('market:update-state', (event, ...args) => {
    requireTrusted(event);
    return options.coordinator.getState(requireInstrument(args));
  });
  options.ipc.handle('market:update', (event, ...args) => {
    requireTrusted(event);
    return options.coordinator.update(requireInstrument(args));
  });
  options.ipc.handle('market:update-all', (event, ...args) => {
    requireTrusted(event);
    if (args.length) throw new Error('全量更新参数无效');
    return options.coordinator.updateAll();
  });
}
