import { formatBeijing } from '../domain/time';
import { INSTRUMENT_LIST, instrumentDefinition } from '../shared/instruments';
import type { Dataset, MarketUpdateState } from '../shared/types';

export type MarketUpdateTone = 'neutral' | 'working' | 'success' | 'warning' | 'danger';

export interface MarketUpdateView {
  buttonLabel: string;
  statusText: string;
  metadataText: string;
  busy: boolean;
  tone: MarketUpdateTone;
}

export interface MarketUpdateAllItemView {
  instrument: MarketUpdateState['instrument'];
  name: string;
  statusText: string;
  tone: MarketUpdateTone;
}

export interface MarketUpdateAllView {
  buttonLabel: string;
  statusText: string;
  busy: boolean;
  tone: MarketUpdateTone;
  items: MarketUpdateAllItemView[];
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
  const main = `1 分钟 +${counts.added1} · 5 分钟 +${counts.added5} · 60 分钟 +${counts.added60}`;
  const revised = counts.replaced1 + counts.replaced5 + counts.replaced60;
  const removed = counts.removed1 + counts.removed5 + counts.removed60;
  const rolloverChanges = counts.addedRollovers + counts.replacedRollovers + counts.removedRollovers;
  return `${main}${revised ? ` · 修订 ${revised}` : ''}${removed ? ` · 移除 ${removed}` : ''}${rolloverChanges ? ` · 换月映射 ${rolloverChanges}` : ''}`;
}

export function marketUpdateView(state: MarketUpdateState, dataset?: Dataset): MarketUpdateView {
  const metadataText = metadata(state, dataset);
  const definition = dataset?.instrument === state.instrument
    ? dataset.definition
    : instrumentDefinition(state.instrument);
  switch (state.phase) {
    case 'fetching':
      return { buttonLabel: '正在下载', statusText: '正在从 EDB 获取价格与主力合约日线…', metadataText, busy: true, tone: 'working' };
    case 'validating':
      return { buttonLabel: '正在校验', statusText: '正在校验价格并重建主力换月映射…', metadataText, busy: true, tone: 'working' };
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
        statusText: `更新 EDB ${definition.name}价格与换月映射`,
        metadataText,
        busy: false,
        tone: 'neutral',
      };
  }
}

function allItemView(state: MarketUpdateState): MarketUpdateAllItemView {
  const name = instrumentDefinition(state.instrument).name;
  switch (state.phase) {
    case 'fetching':
      return { instrument: state.instrument, name, statusText: '正在下载', tone: 'working' };
    case 'validating':
      return { instrument: state.instrument, name, statusText: '正在校验', tone: 'working' };
    case 'saving':
      return { instrument: state.instrument, name, statusText: '正在保存', tone: 'working' };
    case 'succeeded':
      return { instrument: state.instrument, name, statusText: countSummary(state), tone: 'success' };
    case 'up-to-date':
      return { instrument: state.instrument, name, statusText: '已是最新', tone: 'neutral' };
    case 'failed':
      return {
        instrument: state.instrument,
        name,
        statusText: state.error?.message || '更新失败',
        tone: 'danger',
      };
    case 'idle':
      return { instrument: state.instrument, name, statusText: '等待更新', tone: 'neutral' };
  }
}

export function marketUpdateAllView(
  states: readonly MarketUpdateState[] = [],
  busy = false,
): MarketUpdateAllView {
  const stateByInstrument = new Map(states.map(state => [state.instrument, state]));
  const items = INSTRUMENT_LIST.map(definition => allItemView(
    stateByInstrument.get(definition.id) ?? {
      instrument: definition.id,
      phase: 'idle',
    },
  ));
  if (busy) {
    const completed = states.filter(state => (
      state.phase === 'succeeded'
      || state.phase === 'up-to-date'
      || state.phase === 'failed'
    )).length;
    return {
      buttonLabel: '正在更新全部',
      statusText: `正在串行更新全部品种 · 已完成 ${completed}/${INSTRUMENT_LIST.length}`,
      busy: true,
      tone: 'working',
      items,
    };
  }
  if (!states.length) {
    return {
      buttonLabel: '更新全部品种',
      statusText: `依次更新 ${INSTRUMENT_LIST.length} 个主连品种`,
      busy: false,
      tone: 'neutral',
      items,
    };
  }
  const succeeded = states.filter(state => state.phase === 'succeeded').length;
  const upToDate = states.filter(state => state.phase === 'up-to-date').length;
  const failed = states.filter(state => state.phase === 'failed').length;
  if (failed) {
    return {
      buttonLabel: '再次更新全部',
      statusText: `全部品种更新完成 · 更新 ${succeeded} · 已是最新 ${upToDate} · 失败 ${failed}`,
      busy: false,
      tone: 'danger',
      items,
    };
  }
  if (!succeeded && upToDate === INSTRUMENT_LIST.length) {
    return {
      buttonLabel: '再次检查全部',
      statusText: `全部 ${INSTRUMENT_LIST.length} 个品种已是数据源当前最新`,
      busy: false,
      tone: 'neutral',
      items,
    };
  }
  return {
    buttonLabel: '再次更新全部',
    statusText: `全部品种更新完成 · 更新 ${succeeded} · 已是最新 ${upToDate}`,
    busy: false,
    tone: 'success',
    items,
  };
}
