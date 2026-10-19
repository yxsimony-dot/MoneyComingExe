import { describe, expect, it } from 'vitest';
import { INSTRUMENT_LIST, instrumentDefinition } from '../src/shared/instruments';
import {
  marketUpdateAllView,
  marketUpdateView,
} from '../src/renderer/market-update-view';
import type { Dataset, MarketUpdatePhase, MarketUpdateState } from '../src/shared/types';

const dataset = {
  instrument: 'main_continuous',
  definition: instrumentDefinition('main_continuous'),
  snapshotSource: 'user',
  sourceLatestAt: '2026-10-14 15:00:00',
  snapshotUpdatedAt: '2026-10-15T02:30:00.000Z',
} as Dataset;

function state(phase: MarketUpdatePhase): MarketUpdateState {
  return {
    instrument: 'main_continuous',
    phase,
    sourceLatestAt: '2026-10-14 15:00:00',
    snapshotUpdatedAt: '2026-10-15T02:30:00.000Z',
    counts: {
      added1: 60,
      replaced1: 2,
      removed1: 0,
      added5: 12,
      replaced5: 1,
      removed5: 0,
      added60: 1,
      replaced60: 0,
      removed60: 0,
      addedRollovers: 1,
      replacedRollovers: 0,
      removedRollovers: 0,
    },
    error: { code: 'network', message: '无法连接 EDB 数据源' },
  };
}

describe('market update view', () => {
  it.each([
    ['idle', '更新行情', false, 'neutral'],
    ['fetching', '正在下载', true, 'working'],
    ['validating', '正在校验', true, 'working'],
    ['saving', '正在保存', true, 'working'],
    ['succeeded', '再次更新', false, 'success'],
    ['up-to-date', '再次检查', false, 'neutral'],
    ['failed', '重试更新', false, 'danger'],
  ] as const)('maps %s to an accessible stable view', (phase, label, busy, tone) => {
    expect(marketUpdateView(state(phase), dataset)).toMatchObject({
      buttonLabel: label,
      busy,
      tone,
    });
  });

  it('reports exact source and local snapshot times without claiming today or realtime data', () => {
    const view = marketUpdateView(state('succeeded'), dataset);
    expect(view.statusText).toContain('1 分钟 +60 · 5 分钟 +12 · 60 分钟 +1');
    expect(view.statusText).toContain('修订 3');
    expect(view.statusText).toContain('换月映射 1');
    expect(view.statusText).toContain('数据源最新至 2026-10-14 15:00');
    expect(view.metadataText).toContain('本地快照：2026-10-15 10:30');
    expect(`${view.statusText} ${view.metadataText}`).not.toMatch(/今天|实时/);
  });

  it('makes failures retryable and states that the current data is preserved', () => {
    const view = marketUpdateView(state('failed'), dataset);
    expect(view.statusText).toBe('更新失败：无法连接 EDB 数据源。当前数据未受影响');
    expect(view.busy).toBe(false);
  });

  it('labels the built-in snapshot when no user snapshot exists', () => {
    const view = marketUpdateView(
      { instrument: 'main_continuous', phase: 'idle' },
      { ...dataset, snapshotSource: 'builtin', snapshotUpdatedAt: undefined },
    );
    expect(view.metadataText).toContain('本地快照：内置基线');
  });

  it('uses the current instrument name instead of a fixed soymeal label', () => {
    const view = marketUpdateView({
      instrument: 'rebar_main',
      phase: 'idle',
    });
    expect(view.statusText).toBe('更新 EDB 螺纹钢主连价格与换月映射');
  });
});

describe('market update all view', () => {
  it('shows every supported instrument before the first run', () => {
    const view = marketUpdateAllView();
    expect(view.items).toHaveLength(INSTRUMENT_LIST.length);
    expect(view.items.every(item => item.statusText === '等待更新')).toBe(true);
  });

  it('reports running progress and exposes all instrument rows', () => {
    const view = marketUpdateAllView([
      { instrument: 'main_continuous', phase: 'succeeded' },
      { instrument: 'rapeseed_meal_main', phase: 'up-to-date' },
      { instrument: 'pvc_main', phase: 'fetching' },
    ], true);
    expect(view).toMatchObject({
      buttonLabel: '正在更新全部',
      statusText: `正在串行更新全部品种 · 已完成 2/${INSTRUMENT_LIST.length}`,
      busy: true,
      tone: 'working',
    });
    expect(view.items).toHaveLength(INSTRUMENT_LIST.length);
    expect(view.items[2]).toMatchObject({
      instrument: 'pvc_main',
      name: 'PVC主连',
      statusText: '正在下载',
    });
  });

  it('distinguishes all-current, successful, and partially failed summaries', () => {
    const allCurrent = marketUpdateAllView(INSTRUMENT_LIST.map(definition => ({
      instrument: definition.id,
      phase: 'up-to-date' as const,
    })));
    expect(allCurrent.statusText).toBe(`全部 ${INSTRUMENT_LIST.length} 个品种已是数据源当前最新`);
    expect(allCurrent.tone).toBe('neutral');

    const succeeded = marketUpdateAllView(INSTRUMENT_LIST.map((definition, index) => ({
      instrument: definition.id,
      phase: index === 0 ? 'succeeded' as const : 'up-to-date' as const,
    })));
    expect(succeeded.statusText).toContain('更新 1');
    expect(succeeded.tone).toBe('success');

    const partial = marketUpdateAllView(INSTRUMENT_LIST.map((definition, index) => ({
      instrument: definition.id,
      phase: index === 3 ? 'failed' as const : 'succeeded' as const,
      error: index === 3
        ? { code: 'network' as const, message: '无法连接 EDB 数据源' }
        : undefined,
    })));
    expect(partial.statusText).toContain('失败 1');
    expect(partial.tone).toBe('danger');
    expect(partial.items[3].statusText).toBe('无法连接 EDB 数据源');
  });
});
