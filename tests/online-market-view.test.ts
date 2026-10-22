import { describe, expect, it, vi } from 'vitest';
import { instrumentDefinition } from '../src/shared/instruments';
import type {
  MarketSnapshotActivatedEvent,
  OnlineMarketPhase,
  OnlineMarketState,
} from '../src/shared/types';
import {
  ONLINE_MARKET_ENABLED_STORAGE_KEY,
  VISIBLE_MARKET_MODES,
  loadDeclaredMarketSnapshot,
  onlineMarketView,
  onlinePreferenceFromValue,
  persistOnlineMarketPreference,
  readOnlineMarketPreference,
  restorableBarIndex,
  restoredLogicalRange,
  sanitizeOnlineError,
  shouldReloadForSnapshotActivation,
  snapshotActivationKey,
} from '../src/renderer/online-market-view';

function state(phase: OnlineMarketPhase): OnlineMarketState {
  return {
    enabled: phase !== 'disabled',
    phase,
    instrument: 'main_continuous',
    localMinuteLatestAt: '2026-10-20 10:04:00',
    sourceLatestAt: '2026-10-20 10:04:00',
    snapshotUpdatedAt: '2026-10-20T02:05:01.000Z',
    lastSucceededAt: '2026-10-20T02:05:01.000Z',
    nextCheckAt: '2026-10-20T02:06:05.000Z',
  };
}

function activation(
  instrument: MarketSnapshotActivatedEvent['instrument'],
  snapshotUpdatedAt: string,
): MarketSnapshotActivatedEvent {
  return {
    instrument,
    snapshotUpdatedAt,
    mappingsChanged: false,
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
  };
}

describe('online market preference and visible periods', () => {
  it('defaults to disabled and only accepts the exact persisted true value', () => {
    expect(onlinePreferenceFromValue(null)).toBe(false);
    expect(onlinePreferenceFromValue('')).toBe(false);
    expect(onlinePreferenceFromValue('TRUE')).toBe(false);
    expect(onlinePreferenceFromValue('true')).toBe(true);
    expect(readOnlineMarketPreference({ getItem: () => null })).toBe(false);
  });

  it('persists the preference without turning storage failures into runtime failures', () => {
    const values = new Map<string, string>();
    expect(persistOnlineMarketPreference({
      setItem: (key, value) => values.set(key, value),
    }, true)).toBe(true);
    expect(values.get(ONLINE_MARKET_ENABLED_STORAGE_KEY)).toBe('true');
    expect(persistOnlineMarketPreference({
      setItem: () => { throw new Error('storage unavailable'); },
    }, false)).toBe(false);
  });

  it('keeps the visible layout choices limited to dual, 5-minute, and 60-minute', () => {
    expect(VISIBLE_MARKET_MODES).toEqual(['dual', '5', '60']);
    expect(VISIBLE_MARKET_MODES).not.toContain('1');
  });
});

describe('online market state view', () => {
  it.each([
    ['disabled', '离线', 'neutral', false],
    ['catching-up', '正在补齐最新闭合分钟', 'working', true],
    ['waiting', '在线 · 等待下一分钟收盘', 'success', false],
    ['polling', '在线 · 正在检查闭合分钟', 'working', true],
    ['source-delayed', '数据源延迟', 'warning', false],
    ['degraded', '更新失败 · 离线快照可用', 'danger', false],
  ] as const)('maps %s to honest status text', (phase, statusText, tone, busy) => {
    expect(onlineMarketView(state(phase))).toMatchObject({
      statusText,
      tone,
      busy,
    });
  });

  it('does not call catching-up, source-delayed, or degraded states online', () => {
    for (const phase of ['catching-up', 'source-delayed', 'degraded'] as const) {
      expect(onlineMarketView(state(phase)).statusText).not.toContain('在线');
    }
  });

  it('shows the instrument and exact freshness timestamps', () => {
    const view = onlineMarketView(state('waiting'));
    expect(view.metadataText).toContain(instrumentDefinition('main_continuous').name);
    expect(view.metadataText).toContain('数据截止 2026-10-20 10:04');
    expect(view.metadataText).toContain('最近成功 2026-10-20 10:05');
    expect(view.metadataText).toContain('下次检查 2026-10-20 10:06');
  });

  it('sanitizes degraded errors before display', () => {
    const view = onlineMarketView({
      ...state('degraded'),
      error: {
        code: 'network',
        message: 'GET https://secret.example/token failed\nat C:\\Users\\name\\secret.txt',
      },
    });
    expect(view.metadataText).toContain('原因 GET 数据源 failed at 本地路径');
    expect(view.metadataText).not.toContain('secret.example');
    expect(view.metadataText).not.toContain('C:\\Users');
    expect(sanitizeOnlineError('  first\nsecond  ')).toBe('first second');
  });
});

describe('instrument declaration and snapshot activation', () => {
  it('declares the target instrument before loading its local snapshot', async () => {
    const calls: string[] = [];
    const market = {
      setCurrentInstrument: vi.fn(async instrument => {
        calls.push(`declare:${instrument}`);
        return state('catching-up');
      }),
      load: vi.fn(async instrument => {
        calls.push(`load:${instrument}`);
        return { ok: false as const, error: 'fixture' };
      }),
    };

    await loadDeclaredMarketSnapshot(market, 'rebar_main');

    expect(calls).toEqual(['declare:rebar_main', 'load:rebar_main']);
  });

  it('can reload an activated snapshot without redeclaring the current instrument', async () => {
    const market = {
      setCurrentInstrument: vi.fn(async () => state('waiting')),
      load: vi.fn(async () => ({ ok: false as const, error: 'fixture' })),
    };

    await loadDeclaredMarketSnapshot(market, 'main_continuous', true, false);

    expect(market.setCurrentInstrument).not.toHaveBeenCalled();
    expect(market.load).toHaveBeenCalledWith('main_continuous', true);
  });

  it('deduplicates by instrument and snapshot time and ignores other instruments', () => {
    const handled = new Set<string>();
    const current = activation('main_continuous', '2026-10-20T02:05:01.000Z');
    const other = activation('rebar_main', '2026-10-20T02:05:02.000Z');

    expect(snapshotActivationKey(current)).toBe(
      'main_continuous:2026-10-20T02:05:01.000Z',
    );
    expect(shouldReloadForSnapshotActivation(current, 'main_continuous', handled)).toBe(true);
    expect(shouldReloadForSnapshotActivation(current, 'main_continuous', handled)).toBe(false);
    expect(shouldReloadForSnapshotActivation(other, 'main_continuous', handled)).toBe(false);
    expect(handled).toContain(snapshotActivationKey(other));
  });
});

describe('same-instrument refresh context', () => {
  it('keeps an in-range logical viewport exact when only background minutes change', () => {
    const starts = Array.from({ length: 100 }, (_, index) => index * 300_000);
    expect(restoredLogicalRange(
      { from: 20.5, to: 42.5 },
      starts[31],
      starts,
    )).toEqual({ from: 20.5, to: 42.5 });
  });

  it('uses the saved center time when the old logical range is outside new bounds', () => {
    const starts = Array.from({ length: 20 }, (_, index) => index * 300_000);
    expect(restoredLogicalRange(
      { from: 80, to: 90 },
      starts[10],
      starts,
    )).toEqual({ from: 5, to: 15 });
  });

  it('restores the nearest selected bar when an exact timestamp is unavailable', () => {
    const bars = [
      { startMs: 1_000 },
      { startMs: 2_000 },
      { startMs: 3_000 },
    ];
    expect(restorableBarIndex(bars, 2_000)).toBe(1);
    expect(restorableBarIndex(bars, 2_600)).toBe(2);
  });
});
