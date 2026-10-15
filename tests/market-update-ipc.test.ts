import { describe, expect, it, vi } from 'vitest';
import { registerMarketUpdateIpc } from '../src/main/market-update-ipc';
import type { MarketUpdateState } from '../src/shared/types';

function setup() {
  const handlers = new Map<string, (event: never) => MarketUpdateState | Promise<MarketUpdateState>>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: never) => MarketUpdateState | Promise<MarketUpdateState>) => {
      handlers.set(channel, listener);
    }),
  };
  const coordinator = {
    getState: vi.fn(() => ({ phase: 'idle' }) as MarketUpdateState),
    update: vi.fn(async () => ({ phase: 'up-to-date' }) as MarketUpdateState),
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
  it('registers only semantic state and update operations', () => {
    const fixture = setup();
    expect([...fixture.handlers.keys()]).toEqual(['market:update-state', 'market:update']);
  });

  it.each(['missing window', 'foreign window', 'subframe', 'foreign origin'])(
    'rejects %s before starting network work',
    () => {
      const fixture = setup();
      expect(() => fixture.handlers.get('market:update')!({ trusted: false } as never))
        .toThrow('来源不受信任');
      expect(fixture.coordinator.update).not.toHaveBeenCalled();
    },
  );

  it('allows the trusted main viewer frame to query and trigger updates', async () => {
    const fixture = setup();
    expect(fixture.handlers.get('market:update-state')!({ trusted: true } as never))
      .toMatchObject({ phase: 'idle' });
    await expect(fixture.handlers.get('market:update')!({ trusted: true } as never))
      .resolves.toMatchObject({ phase: 'up-to-date' });
    expect(fixture.coordinator.update).toHaveBeenCalledOnce();
  });
});
