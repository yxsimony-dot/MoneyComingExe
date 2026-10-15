import { describe, expect, it } from 'vitest';
import { marketUpdateView } from '../src/renderer/market-update-view';
import type { Dataset, MarketUpdatePhase, MarketUpdateState } from '../src/shared/types';

const dataset = {
  snapshotSource: 'user',
  sourceLatestAt: '2026-10-14 15:00:00',
  snapshotUpdatedAt: '2026-10-15T02:30:00.000Z',
} as Dataset;

function state(phase: MarketUpdatePhase): MarketUpdateState {
  return {
    phase,
    sourceLatestAt: '2026-10-14 15:00:00',
    snapshotUpdatedAt: '2026-10-15T02:30:00.000Z',
    counts: {
      added5: 12,
      replaced5: 1,
      removed5: 0,
      added60: 1,
      replaced60: 0,
      removed60: 0,
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
    expect(view.statusText).toContain('5 分钟 +12 · 60 分钟 +1');
    expect(view.statusText).toContain('修订 1');
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
      { phase: 'idle' },
      { ...dataset, snapshotSource: 'builtin', snapshotUpdatedAt: undefined },
    );
    expect(view.metadataText).toContain('本地快照：内置基线');
  });
});
