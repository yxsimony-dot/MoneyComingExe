import { describe, expect, it, vi } from 'vitest';
import { registerMarketUpdateIpc } from '../src/main/market-update-ipc';
import type {
  Instrument,
  MarketUpdateAllResult,
  MarketUpdateState,
  OnlineMarketState,
} from '../src/shared/types';

function setup() {
  type HandlerResult =
    | MarketUpdateState
    | MarketUpdateAllResult
    | OnlineMarketState;
  type Handler = (event: never, ...args: unknown[]) => HandlerResult | Promise<HandlerResult>;
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    }),
  };
  const coordinator = {
    getState: vi.fn(instrument => ({ instrument, phase: 'idle' }) as MarketUpdateState),
    update: vi.fn(async instrument => ({ instrument, phase: 'up-to-date' }) as MarketUpdateState),
    updateAll: vi.fn(async () => ({
      startedAt: '2026-10-18T00:00:00.000Z',
      completedAt: '2026-10-18T00:01:00.000Z',
      results: [],
    })),
  };
  const online = {
    getState: vi.fn(() => ({
      enabled: false,
      phase: 'disabled',
    }) as OnlineMarketState),
    setEnabled: vi.fn((enabled: boolean) => ({
      enabled,
      phase: enabled ? 'catching-up' : 'disabled',
    }) as OnlineMarketState),
    declareCurrentInstrument: vi.fn((instrument: Instrument) => ({
      enabled: false,
      phase: 'disabled',
      instrument,
    }) as OnlineMarketState),
    networkRecovered: vi.fn(() => ({
      enabled: true,
      phase: 'catching-up',
      instrument: 'main_continuous',
    }) as OnlineMarketState),
  };
  const trusted = vi.fn((event: { trusted?: boolean }) => event.trusted === true);
  registerMarketUpdateIpc({
    ipc: ipc as never,
    coordinator,
    online,
    trusted: trusted as never,
  });
  return { handlers, ipc, coordinator, online };
}

describe('market update IPC', () => {
  it('registers only semantic market update and online lifecycle operations', () => {
    const fixture = setup();
    expect([...fixture.handlers.keys()]).toEqual([
      'market:update-state',
      'market:update',
      'market:update-all',
      'market:online-state',
      'market:online-enabled',
      'market:current-instrument',
      'market:network-recovered',
    ]);
  });

  it.each(['missing window', 'foreign window', 'subframe', 'foreign origin'])(
    'rejects %s before starting network work',
    () => {
      const fixture = setup();
      expect(() => fixture.handlers.get('market:update')!(
        { trusted: false } as never,
        'main_continuous',
      ))
        .toThrow('来源不受信任');
      expect(fixture.coordinator.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['market:update-state', []],
    ['market:update-state', ['unknown']],
    ['market:update-state', ['main_continuous', 'extra']],
    ['market:update', []],
    ['market:update', ['KQ.m@DCE.m']],
    ['market:update', ['https://edb.shinnytech.com/md/kline']],
    ['market:current-instrument', []],
    ['market:current-instrument', ['https://edb.shinnytech.com/md/kline']],
  ] as const)('rejects invalid arguments for %s', (channel, args) => {
    const fixture = setup();
    expect(() => fixture.handlers.get(channel)!(
      { trusted: true } as never,
      ...args,
    )).toThrow('行情品种参数无效');
    expect(fixture.coordinator.getState).not.toHaveBeenCalled();
    expect(fixture.coordinator.update).not.toHaveBeenCalled();
  });

  it.each([
    ['market:online-state', ['extra']],
    ['market:online-enabled', []],
    ['market:online-enabled', ['true']],
    ['market:online-enabled', [true, false]],
    ['market:network-recovered', ['https://example.test']],
  ] as const)('rejects non-semantic arguments for %s', (channel, args) => {
    const fixture = setup();
    expect(() => fixture.handlers.get(channel)!(
      { trusted: true } as never,
      ...args,
    )).toThrow();
    expect(fixture.online.setEnabled).not.toHaveBeenCalled();
    expect(fixture.online.networkRecovered).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied full-update lists', () => {
    const fixture = setup();
    expect(() => fixture.handlers.get('market:update-all')!(
      { trusted: true } as never,
      ['main_continuous'],
    )).toThrow('全量更新参数无效');
    expect(fixture.coordinator.updateAll).not.toHaveBeenCalled();
  });

  it('allows the trusted main viewer frame to query and trigger updates', async () => {
    const fixture = setup();
    expect(fixture.handlers.get('market:update-state')!(
      { trusted: true } as never,
      'rebar_main',
    )).toMatchObject({ instrument: 'rebar_main', phase: 'idle' });
    await expect(fixture.handlers.get('market:update')!(
      { trusted: true } as never,
      'pvc_main',
    )).resolves.toMatchObject({ instrument: 'pvc_main', phase: 'up-to-date' });
    await expect(fixture.handlers.get('market:update-all')!(
      { trusted: true } as never,
    )).resolves.toMatchObject({ results: [] });
    expect(fixture.coordinator.getState).toHaveBeenCalledWith('rebar_main');
    expect(fixture.coordinator.update).toHaveBeenCalledWith('pvc_main');
    expect(fixture.coordinator.updateAll).toHaveBeenCalledOnce();
  });

  it('allows the trusted main frame to control the online lifecycle', () => {
    const fixture = setup();
    expect(fixture.handlers.get('market:online-state')!(
      { trusted: true } as never,
    )).toMatchObject({ enabled: false, phase: 'disabled' });
    expect(fixture.handlers.get('market:current-instrument')!(
      { trusted: true } as never,
      'rebar_main',
    )).toMatchObject({ instrument: 'rebar_main' });
    expect(fixture.handlers.get('market:online-enabled')!(
      { trusted: true } as never,
      true,
    )).toMatchObject({ enabled: true, phase: 'catching-up' });
    expect(fixture.handlers.get('market:network-recovered')!(
      { trusted: true } as never,
    )).toMatchObject({ phase: 'catching-up' });
    expect(fixture.online.declareCurrentInstrument)
      .toHaveBeenCalledWith('rebar_main');
    expect(fixture.online.setEnabled).toHaveBeenCalledWith(true);
    expect(fixture.online.networkRecovered).toHaveBeenCalledOnce();
  });
});
