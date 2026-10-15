import { formatBeijing } from '../domain/time';
import type { Dataset, MarketUpdateState } from '../shared/types';

export type MarketUpdateTone = 'neutral' | 'working' | 'success' | 'warning' | 'danger';

export interface MarketUpdateView {
  buttonLabel: string;
  statusText: string;
  metadataText: string;
  busy: boolean;
  tone: MarketUpdateTone;
}

function minute(value?: string): string | undefined {
  return value?.trim() ? value.trim().slice(0, 16) : undefined;
}

function snapshotTime(value?: string): string {
  if (!value) return '内置基线';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? formatBeijing(time).slice(0, 16) : value.slice(0, 16);
}

function sourceLatest(state: MarketUpdateState, dataset?: Dataset): string | undefined {
  return minute(state.sourceLatestAt) ?? minute(dataset?.sourceLatestAt);
}

function metadata(state: MarketUpdateState, dataset?: Dataset): string {
  const latest = sourceLatest(state, dataset);
  const updatedAt = state.snapshotUpdatedAt ?? dataset?.snapshotUpdatedAt;
  return `${latest ? `数据源最新至 ${latest}` : '数据源截止时间待读取'} · 本地快照：${snapshotTime(updatedAt)}`;
}

function countSummary(state: MarketUpdateState): string {
  const counts = state.counts;
  if (!counts) return '更新完成';
  const main = `5 分钟 +${counts.added5} · 60 分钟 +${counts.added60}`;
  const revised = counts.replaced5 + counts.replaced60;
  const removed = counts.removed5 + counts.removed60;
  return `${main}${revised ? ` · 修订 ${revised}` : ''}${removed ? ` · 移除 ${removed}` : ''}`;
}

export function marketUpdateView(state: MarketUpdateState, dataset?: Dataset): MarketUpdateView {
  const metadataText = metadata(state, dataset);
  switch (state.phase) {
    case 'fetching':
      return { buttonLabel: '正在下载', statusText: '正在从 EDB 获取增量历史数据…', metadataText, busy: true, tone: 'working' };
    case 'validating':
      return { buttonLabel: '正在校验', statusText: '正在校验并重建 5 分钟、60 分钟行情…', metadataText, busy: true, tone: 'working' };
    case 'saving':
      return { buttonLabel: '正在保存', statusText: '正在原子保存新的本地快照…', metadataText, busy: true, tone: 'working' };
    case 'succeeded': {
      const latest = sourceLatest(state, dataset);
      return {
        buttonLabel: '再次更新',
        statusText: `已更新：${countSummary(state)}${latest ? `，数据源最新至 ${latest}` : ''}`,
        metadataText,
        busy: false,
        tone: 'success',
      };
    }
    case 'up-to-date': {
      const latest = sourceLatest(state, dataset);
      return {
        buttonLabel: '再次检查',
        statusText: `已是数据源当前最新${latest ? `：${latest}` : ''}`,
        metadataText,
        busy: false,
        tone: 'neutral',
      };
    }
    case 'failed':
      return {
        buttonLabel: '重试更新',
        statusText: `更新失败：${state.error?.message || '请稍后重试'}。当前数据未受影响`,
        metadataText,
        busy: false,
        tone: 'danger',
      };
    case 'idle':
      return {
        buttonLabel: '更新行情',
        statusText: '按需更新 EDB 豆粕主连历史数据',
        metadataText,
        busy: false,
        tone: 'neutral',
      };
  }
}
