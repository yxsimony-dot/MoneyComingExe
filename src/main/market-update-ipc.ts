import type { IpcMainInvokeEvent } from 'electron';
import { isInstrument } from '../shared/instruments';
import type {
  Instrument,
  MarketUpdateAllResult,
  MarketUpdateState,
  OnlineMarketState,
} from '../shared/types';

type MarketUpdateIpcResult =
  | MarketUpdateState
  | MarketUpdateAllResult
  | OnlineMarketState;

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

export interface OnlineMarketIpcCoordinator {
  getState(): OnlineMarketState;
  setEnabled(enabled: boolean): OnlineMarketState;
  declareCurrentInstrument(instrument: Instrument): OnlineMarketState;
  networkRecovered(): OnlineMarketState;
}

export interface RegisterMarketUpdateIpcOptions {
  ipc: MarketUpdateIpc;
  coordinator: MarketUpdateIpcCoordinator;
  online: OnlineMarketIpcCoordinator;
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
  options.ipc.handle('market:online-state', (event, ...args) => {
    requireTrusted(event);
    if (args.length) throw new Error('在线状态参数无效');
    return options.online.getState();
  });
  options.ipc.handle('market:online-enabled', (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1 || typeof args[0] !== 'boolean') {
      throw new Error('在线模式参数无效');
    }
    return options.online.setEnabled(args[0]);
  });
  options.ipc.handle('market:current-instrument', (event, ...args) => {
    requireTrusted(event);
    return options.online.declareCurrentInstrument(requireInstrument(args));
  });
  options.ipc.handle('market:network-recovered', (event, ...args) => {
    requireTrusted(event);
    if (args.length) throw new Error('网络恢复参数无效');
    return options.online.networkRecovered();
  });
}
