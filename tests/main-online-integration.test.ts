import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VIEWER_BLOCKED_URL_PATTERNS } from '../src/main/network-policy';

const mainSource = readFileSync('src/main/main.ts', 'utf8');

describe('main process online market integration', () => {
  it('keeps viewer and market traffic in distinct locked-down sessions', () => {
    expect(mainSource).toContain('session.fromPartition(viewerPartition)');
    expect(mainSource).toContain(
      'session.fromPartition(MARKET_UPDATE_SESSION_PARTITION)',
    );
    expect(mainSource).toContain(
      'fetch: (input, init) => marketSession.fetch(input, init)',
    );
    expect(mainSource).toContain('partition: viewerPartition');
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
    expect(VIEWER_BLOCKED_URL_PATTERNS).toEqual([
      'http://*/*',
      'https://*/*',
      'ws://*/*',
      'wss://*/*',
    ]);
  });

  it('assembles online updates, publications, IPC, resume, and cleanup', () => {
    expect(mainSource).toContain('new MarketUpdateCoordinator({');
    expect(mainSource).toContain('new OnlineMarketCoordinator({');
    expect(mainSource).toContain(
      "window.webContents.send('market:update-state-changed', state)",
    );
    expect(mainSource).toContain(
      "window.webContents.send('market:snapshot-activated', activated)",
    );
    expect(mainSource).toContain(
      "window.webContents.send('market:online-state-changed', state)",
    );
    expect(mainSource).toContain('registerMarketUpdateIpc({');
    expect(mainSource).toContain("powerMonitor.on('resume', handleResume)");
    expect(mainSource).toContain(
      "powerMonitor.removeListener('resume', handleResume)",
    );
    expect(mainSource).toContain('onlineCoordinator.dispose()');
  });
});
