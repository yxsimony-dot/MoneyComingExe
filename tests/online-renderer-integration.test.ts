import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rendererSource = readFileSync('src/renderer/main.ts', 'utf8');

describe('online renderer integration', () => {
  it('keeps the visible chart modes limited to dual, 5-minute, and 60-minute', () => {
    expect(rendererSource.match(/data-mode="[^"]+"/g)).toEqual([
      'data-mode="dual"',
      'data-mode="5"',
      'data-mode="60"',
    ]);
    expect(rendererSource).not.toContain('data-mode="1"');
    expect(rendererSource).not.toContain('mode-1');
  });

  it('declares and loads the default instrument before restoring online preference', () => {
    const initializeStart = rendererSource.indexOf(
      'async function initializeMarketWorkspace()',
    );
    const loadIndex = rendererSource.indexOf(
      'await loadInstrument(DEFAULT_INSTRUMENT.id);',
      initializeStart,
    );
    const stateIndex = rendererSource.indexOf(
      'await window.market.getOnlineState()',
      initializeStart,
    );
    const preferenceIndex = rendererSource.indexOf(
      'readOnlineMarketPreference(localStorage)',
      initializeStart,
    );

    expect(rendererSource).toContain('loadDeclaredMarketSnapshot(');
    expect(loadIndex).toBeGreaterThan(initializeStart);
    expect(stateIndex).toBeGreaterThan(loadIndex);
    expect(preferenceIndex).toBeGreaterThan(stateIndex);
    expect(rendererSource).toContain(
      'await setOnlineMarketEnabled(preferredEnabled, false);',
    );
  });

  it('persists the toggle and subscribes before startup begins', () => {
    const onlineSubscription = rendererSource.indexOf(
      'const unsubscribeOnlineStates = window.market.onOnlineState',
    );
    const activationSubscription = rendererSource.indexOf(
      'const unsubscribeSnapshotActivations = window.market.onSnapshotActivated',
    );
    const startup = rendererSource.lastIndexOf('void initializeMarketWorkspace();');

    expect(rendererSource).toContain(
      'persistOnlineMarketPreference(localStorage, enabled)',
    );
    expect(onlineSubscription).toBeGreaterThan(0);
    expect(activationSubscription).toBeGreaterThan(onlineSubscription);
    expect(startup).toBeGreaterThan(activationSubscription);
    expect(rendererSource).toContain(
      'state.instrument !== requestedInstrument',
    );
  });

  it('deduplicates current snapshot activations and reloads without redeclaring', () => {
    expect(rendererSource).toContain('shouldReloadForSnapshotActivation(');
    expect(rendererSource).toContain('handledSnapshotActivations');
    expect(rendererSource).toContain(
      'void loadInstrument(event.instrument, true, false);',
    );
  });

  it('restarts the gate on network recovery and removes every new listener', () => {
    expect(rendererSource).toContain(
      'window.market.notifyNetworkRecovered()',
    );
    expect(rendererSource).toContain(
      "window.addEventListener('online', handleBrowserOnline)",
    );
    expect(rendererSource).toContain('unsubscribeOnlineStates();');
    expect(rendererSource).toContain('unsubscribeSnapshotActivations();');
    expect(rendererSource).toContain(
      "window.removeEventListener('online', handleBrowserOnline)",
    );
  });

  it('restores same-instrument chart and selection context without moving latest', () => {
    expect(rendererSource).toContain(
      'const refreshContext = sameInstrument ? captureMarketRefreshContext() : undefined;',
    );
    expect(rendererSource).toContain(
      'next.rollovers, !context',
    );
    expect(rendererSource).toContain('restoredLogicalRange(');
    expect(rendererSource).toContain('restorePriceScaleState(');
    expect(rendererSource).toContain('restorableBarIndex(');
    expect(rendererSource).toContain('refreshStrategyResults();');
  });

  it('keeps background one-minute bars in exact strategy and review inputs', () => {
    expect(rendererSource).toMatch(
      /entryLifecycle\(\s*entry,\s*dataset\.bars5,\s*dataset\.bars1,/,
    );
    expect(rendererSource).toContain(
      'dataset.bars5,\n    dataset.bars1,\n    dataset.definition,',
    );
    expect(rendererSource).toContain('根后台 1 分钟 K 线');
  });
});
