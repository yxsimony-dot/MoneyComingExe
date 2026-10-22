import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  MarketAPI,
  MarketSnapshotActivatedEvent,
  MarketUpdateState,
  OnlineMarketState,
} from '../src/shared/types';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

let market: MarketAPI;

beforeAll(async () => {
  await import('../src/preload/preload');
  const exposure = electronMocks.exposeInMainWorld.mock.calls
    .find(([name]) => name === 'market');
  market = exposure?.[1] as MarketAPI;
});

describe('preload market API', () => {
  it('passes only registered instrument identifiers to semantic update channels', async () => {
    electronMocks.invoke.mockResolvedValue(undefined);

    await market.getUpdateState('rebar_main');
    await market.update('pvc_main');
    await market.updateAll();
    await market.getOnlineState();
    await market.setCurrentInstrument('corn_main');
    await market.setOnlineEnabled(true);
    await market.notifyNetworkRecovered();

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      1,
      'market:update-state',
      'rebar_main',
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      'market:update',
      'pvc_main',
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      'market:update-all',
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      4,
      'market:online-state',
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      5,
      'market:current-instrument',
      'corn_main',
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      6,
      'market:online-enabled',
      true,
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      7,
      'market:network-recovered',
    );
    const serialized = JSON.stringify(electronMocks.invoke.mock.calls);
    expect(serialized).not.toMatch(/start_time|end_time|authorization|cookie|file:|https?:/i);
  });

  it('subscribes to state events and removes the exact listener', () => {
    const listener = vi.fn();
    const unsubscribe = market.onUpdateState(listener);
    const handler = electronMocks.on.mock.calls.find(
      ([channel]) => channel === 'market:update-state-changed',
    )?.[1] as (
      event: Electron.IpcRendererEvent,
      state: MarketUpdateState,
    ) => void;
    const state: MarketUpdateState = {
      instrument: 'main_continuous',
      phase: 'fetching',
    };

    handler({} as Electron.IpcRendererEvent, state);
    expect(listener).toHaveBeenCalledWith(state);

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      'market:update-state-changed',
      handler,
    );
  });

  it('subscribes to online state and activation events with exact unsubscription', () => {
    const onlineListener = vi.fn();
    const activationListener = vi.fn();
    const unsubscribeOnline = market.onOnlineState(onlineListener);
    const unsubscribeActivation = market.onSnapshotActivated(activationListener);
    const onlineHandler = electronMocks.on.mock.calls.find(
      ([channel]) => channel === 'market:online-state-changed',
    )?.[1] as (
      event: Electron.IpcRendererEvent,
      state: OnlineMarketState,
    ) => void;
    const activationHandler = electronMocks.on.mock.calls.find(
      ([channel]) => channel === 'market:snapshot-activated',
    )?.[1] as (
      event: Electron.IpcRendererEvent,
      activated: MarketSnapshotActivatedEvent,
    ) => void;
    const onlineState: OnlineMarketState = {
      enabled: true,
      phase: 'waiting',
      instrument: 'corn_main',
    };
    const activated: MarketSnapshotActivatedEvent = {
      instrument: 'corn_main',
      snapshotUpdatedAt: '2026-10-20T02:05:01.000Z',
      counts: {
        added1: 1,
        replaced1: 0,
        removed1: 0,
        added5: 0,
        replaced5: 0,
        removed5: 0,
        added60: 0,
        replaced60: 0,
        removed60: 0,
        addedRollovers: 0,
        replacedRollovers: 0,
        removedRollovers: 0,
      },
      mappingsChanged: false,
    };

    onlineHandler({} as Electron.IpcRendererEvent, onlineState);
    activationHandler({} as Electron.IpcRendererEvent, activated);
    expect(onlineListener).toHaveBeenCalledWith(onlineState);
    expect(activationListener).toHaveBeenCalledWith(activated);

    unsubscribeOnline();
    unsubscribeActivation();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      'market:online-state-changed',
      onlineHandler,
    );
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      'market:snapshot-activated',
      activationHandler,
    );
  });
});
