import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rendererSource = readFileSync('src/renderer/main.ts', 'utf8');
const strategyDerivationsSource = readFileSync(
  'src/renderer/strategy-derivations.ts',
  'utf8',
);
const performanceSource = readFileSync(
  'tests/instrument-switch-performance.mjs',
  'utf8',
);

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
    expect(rendererSource).toMatch(
      /const refreshContext = sameInstrument\s+\? fallbackForRequest\?\.context\s+: undefined;/,
    );
    expect(rendererSource).toMatch(
      /await charts\[60\]\.setData\(\s*derivations\.periods\[60\],\s*next\.anomalies,\s*!context,\s*yieldControl,\s*recordDiagnostics \? diagnosticRequest : undefined,\s*\);/,
    );
    expect(rendererSource).toMatch(
      /await charts\[5\]\.setData\(\s*derivations\.periods\[5\],\s*next\.anomalies,\s*!context,\s*yieldControl,\s*recordDiagnostics \? diagnosticRequest : undefined,\s*\);/,
    );
    expect(rendererSource).toContain('restoredLogicalRange(');
    expect(rendererSource).toContain('restorePriceScaleState(');
    expect(rendererSource).toContain('restorableBarIndex(');
    expect(rendererSource).toContain('refreshStrategyResults();');
  });

  it('yields after the full candle commit before moving the viewport', () => {
    expect(rendererSource).toMatch(
      /this\.candle\.setData\([\s\S]*?\);\s*await yieldControl\(\);\s*if \(moveToLatest\) this\.latest\(\);/,
    );
  });

  it('finishes the cached strategy summary without an extra timer yield', () => {
    expect(rendererSource).toMatch(
      /function refreshStrategyResults\([\s\S]*?\): void \{/,
    );
    expect(rendererSource).toMatch(
      /refreshStrategyResults\(\s*strategyDerivations,\s*recordDiagnostics \? diagnosticRequest : undefined,\s*\);/,
    );
    const refreshStart = rendererSource.indexOf('function refreshStrategyResults(');
    const refreshEnd = rendererSource.indexOf(
      '\nfunction validIntegerSetting(',
      refreshStart,
    );
    expect(rendererSource.slice(refreshStart, refreshEnd)).not.toContain(
      'yieldControl',
    );
  });

  it('fails only for renderer tasks strictly over the 50ms contract', () => {
    expect(performanceSource).toContain('const longTaskThresholdMs = 50;');
    expect(performanceSource).toMatch(
      /observedLongTasks\.filter\(\s*entry => entry\.duration > longTaskThresholdMs,\s*\)/,
    );
    expect(performanceSource).not.toMatch(
      /entry\.duration >= longTaskThresholdMs/,
    );
  });

  it('overlaps cached Dataset IPC with releasing the previous chart data', () => {
    const loadInstrumentStart = rendererSource.indexOf('async function loadInstrument(');
    const loadPromiseIndex = rendererSource.indexOf(
      'const resultPromise = loadDeclaredMarketSnapshot(',
      loadInstrumentStart,
    );
    const releaseIndex = rendererSource.indexOf(
      'charts[60].releaseData();',
      loadPromiseIndex,
    );
    const awaitResultIndex = rendererSource.indexOf(
      'const result = await resultPromise;',
      releaseIndex,
    );

    expect(loadPromiseIndex).toBeGreaterThan(loadInstrumentStart);
    expect(releaseIndex).toBeGreaterThan(loadPromiseIndex);
    expect(awaitResultIndex).toBeGreaterThan(releaseIndex);
    expect(rendererSource).toContain(
      'if (!sameInstrument && !releasedMarketFallback && fallbackForRequest) {',
    );
    expect(rendererSource).toContain(
      'let chartsMayNeedRestore = Boolean(releasedMarketFallback);',
    );
  });

  it('restores the last successful dataset after a final switch failure', () => {
    expect(rendererSource).toContain(
      'const fallbackForRequest = releasedMarketFallback ?? (dataset ? {',
    );
    expect(rendererSource).toContain(
      'releasedMarketFallback = fallbackForRequest;',
    );
    expect(rendererSource).toContain(
      'await restoreMarketFallback(fallback, diagnosticRequest);',
    );
    expect(rendererSource).toMatch(
      /await renderDataset\(\s*fallback\.dataset,\s*fallback\.context,\s*diagnosticRequest,\s*false,\s*\);/,
    );
    expect(rendererSource).toContain(
      'discardedDatasets.forEach(releaseDatasetDerivations);',
    );
    expect(rendererSource).toContain(
      'releaseDatasetDerivations(obsoleteFallback.dataset);',
    );
  });

  it('keeps background one-minute bars in exact strategy and review inputs', () => {
    expect(strategyDerivationsSource).toMatch(
      /entryLifecycle\(\s*entry,\s*dataset\.bars5,\s*dataset\.bars1,/,
    );
    expect(rendererSource).toContain('reviewProfitLossLifecycles(');
    expect(rendererSource).toContain('derivations.candidates');
    expect(rendererSource).toContain('根后台 1 分钟 K 线');
  });

  it('builds profit-loss detail DOM only while the review is open or requested', () => {
    expect(rendererSource).toContain(
      'if (reviewDialog.open) renderProfitLossReview(result);',
    );
    expect(rendererSource).toContain('profitLossDetailGenerationCount += 1;');
    expect(rendererSource).toContain(
      "reviewButton.addEventListener('click', () => showProfitLossReview());",
    );
  });
});
