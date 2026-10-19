import { describe, expect, it, vi } from 'vitest';
import { registerMarketUpdateIpc } from '../src/main/market-update-ipc';
import type {
  MarketUpdateAllResult,
  MarketUpdateState,
} from '../src/shared/types';

function setup() {
  type HandlerResult = MarketUpdateState | MarketUpdateAllResult;
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
  const trusted = vi.fn((event: { trusted?: boolean }) => event.trusted === true);
  registerMarketUpdateIpc({
    ipc: ipc as never,
    coordinator,
    trusted: trusted as never,
  });
  return { handlers, ipc, coordinator };
}

describe('market update IPC', () => {
  it('registers only semantic state, current update, and full update operations', () => {
    const fixture = setup();
    expect([...fixture.handlers.keys()]).toEqual([
      'market:update-state',
      'market:update',
      'market:update-all',
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
  ] as const)('rejects invalid arguments for %s', (channel, args) => {
    const fixture = setup();
    expect(() => fixture.handlers.get(channel)!(
      { trusted: true } as never,
      ...args,
    )).toThrow('行情品种参数无效');
    expect(fixture.coordinator.getState).not.toHaveBeenCalled();
    expect(fixture.coordinator.update).not.toHaveBeenCalled();
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
});
