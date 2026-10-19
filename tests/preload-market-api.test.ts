import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MarketAPI, MarketUpdateState } from '../src/shared/types';

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
});
