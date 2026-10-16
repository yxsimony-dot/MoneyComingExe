import './style.css';
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, LineType, TickMarkType, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Logical, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { Anomaly, Bar, ContractRollover, Dataset, EdbMinuteRecord, Instrument, MarketUpdateState, Period, ReactionTestScenario, UpdateState } from '../shared/types';
import { DEFAULT_ENTRY_RULES } from '../shared/entry-rules';
import { MARKET_PRICE_TICK } from '../shared/market';
import { formatBeijing, locateDate, locateTime } from '../domain/time';
import { analyzeWeeklyRange, type WeeklyBreakout } from '../domain/weekly-range';
import { exponentialMovingAverage } from '../domain/ema';
import { locateRolloverBar } from '../domain/contract-rollover';
import {
  reviewProfitLoss,
  type ProfitLossReviewResult,
} from '../domain/profit-loss-review';
import {
  analyzeEntryExit,
  analyzeWeeklyEntries,
  entryLifecycle,
  entryObservationLine,
  entryQuarterSignal,
  entryReactionRange,
  entryStopLossSignal,
  entryTakeProfitSignal,
  selectWeeklyEntry,
  weeklyEntryMarkerId,
  type EntryExitAnalysis,
  type EntryLifecycle,
  type EntryLifecycleEndReason,
  type EntryQuarterSignal,
  type EntryReactionRange,
  type EntryStopLossSignal,
  type EntryTakeProfitSignal,
  type WeeklyEntry,
} from '../domain/weekly-entry';
import { childrenFor, linkedLogicalRange, parentFor } from '../domain/link';
import { marketUpdateView } from './market-update-view';

const icons = {
  mark: '<svg viewBox="0 0 32 32" fill="none"><path d="M5 24V13l7 6 7-11 8 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 8h5v6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  grid: '<svg viewBox="0 0 18 18" fill="none"><rect x="2.5" y="3" width="5" height="12" rx="1"/><rect x="10.5" y="3" width="5" height="12" rx="1"/></svg>',
  calendar: '<svg viewBox="0 0 18 18" fill="none"><rect x="3" y="4" width="12" height="11" rx="2"/><path d="M6 2v4m6-4v4M3 8h12"/></svg>',
  latest: '<svg viewBox="0 0 18 18" fill="none"><path d="m6 4 5 5-5 5m8-11v12"/></svg>',
  info: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.5"/><path d="M9 8v5m0-8v1"/></svg>',
  link: '<svg viewBox="0 0 18 18" fill="none"><path d="m7 11 4-4M6 12l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0m2 0 1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0" transform="translate(1)"/></svg>',
  resetScale: '<svg viewBox="0 0 18 18" fill="none"><path d="M4 6V3m0 0h3M4 3l2.2 2.2a5 5 0 1 1-1.1 5.4"/><path d="M9 7v4m-2-2h4"/></svg>',
  update: '<svg viewBox="0 0 18 18" fill="none"><path d="M14.5 7A6 6 0 0 0 4 4.5L2.5 6"/><path d="M2.5 2.5V6H6M3.5 11A6 6 0 0 0 14 13.5l1.5-1.5"/><path d="M15.5 15.5V12H12"/></svg>',
};
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-icon">${icons.mark}</span><span>MONEY<span class="brand-light">COMING</span><small>期货历史研究台</small></span></div>
    <div class="topbar-right"><span class="offline"><i></i> 离线工作区</span><button class="update-entry" id="update-entry" data-testid="update-entry" title="检查 MoneyComing 更新">${icons.update}<span id="app-version">v—</span><span id="update-entry-label">检查更新</span></button><button class="icon-button" id="source-info" data-testid="source-info" title="数据来源与使用说明" aria-label="数据来源与使用说明">${icons.info}</button></div>
  </header>
  <main>
    <section class="market-heading">
      <div><div class="eyebrow">DALIAN COMMODITY EXCHANGE <span>/</span> 大商所</div><div class="heading-line"><h1 id="instrument-name">豆粕主连</h1><span class="symbol" id="instrument-symbol">KQ.m@DCE.m</span><span class="history-label">历史行情</span></div><p class="subtitle" id="subtitle">从整体趋势，到每一根 K 线。</p></div>
      <div class="quote"><div class="quote-caption">样本末根收盘 <span>元 / 吨</span></div><div class="quote-line"><strong id="last-close">—</strong><span id="last-change">—</span></div><div class="quote-time" id="last-time">正在读取本地数据</div></div>
    </section>
    <section class="toolbar" aria-label="行情工具栏">
      <div class="toolbar-left"><label class="instrument-select"><span>品种</span><select id="instrument" data-testid="instrument" aria-label="选择标的"><option value="main_continuous">豆粕主连</option></select></label><span class="divider"></span><div class="segmented" aria-label="图表布局"><button data-mode="dual" data-testid="mode-dual" aria-pressed="true" class="active">${icons.grid}双周期</button><button data-mode="5" data-testid="mode-5" aria-pressed="false">5 分钟</button><button data-mode="60" data-testid="mode-60" aria-pressed="false">60 分钟</button></div></div>
      <div class="toolbar-right"><button id="toggle-monday" data-testid="toggle-monday" class="button" aria-pressed="false" title="显示或隐藏周一前8根范围及第9根起的逐次新高、新低突破标记">周一8根标记</button><button id="toggle-subcharts" data-testid="toggle-subcharts" class="button" aria-pressed="false" title="隐藏或显示成交量与持仓量副图">只看K线</button><form id="date-form" novalidate><label class="date-field">${icons.calendar}<input id="date-input" data-testid="date-input" type="date" aria-label="定位日期（北京时间）" required /></label><button type="submit" data-testid="date-jump" class="button jump-button">定位</button></form><button id="latest" data-testid="latest" class="button">${icons.latest}最新</button></div>
      <div class="market-update-row" id="market-update-row" data-tone="neutral">
        <div class="market-update-copy"><span id="market-update-status" role="status" aria-live="polite">按需更新 EDB 豆粕主连历史数据</span><small id="market-update-meta">正在读取本地快照信息</small></div>
        <button id="market-update" data-testid="market-update" class="button market-update-button" type="button">${icons.update}<span id="market-update-label">更新行情</span></button>
      </div>
    </section>
    <div id="error" class="error-banner" role="alert" hidden><span id="error-text"></span><button class="button" data-testid="retry" id="retry">重新加载</button><button id="dismiss-error" aria-label="关闭错误提示">×</button></div>
    <div class="workspace-meta"><span><i class="status-dot"></i><span id="coverage">正在加载完整历史数据…</span></span><span id="counts"></span></div>
    <section class="charts" id="charts" aria-label="历史K线图表"></section>
    <section class="selection-bar" id="selection-bar"><span class="link-icon">${icons.link}</span><div><span class="selection-label">双周期联动</span><span id="selection-text">点击任意 K 线，查看两个周期的对应区间</span></div><button class="quality-link" id="selected-anomaly" hidden>查看待核实说明 ↗</button><span class="navigation-hint">滚轮缩放 <span>·</span> 拖动浏览 <span>·</span> 点击联动</span></section>
  </main>
  <footer><div><span class="footer-brand">EDB</span><span>信易历史数据</span><span class="footer-separator">/</span><span id="quality-status">源价格 · 未自行复权</span></div><div><button id="attribution">Charts by TradingView</button><span class="footer-separator">/</span><span>北京时间 UTC+8</span></div></footer>
  <div class="loading-overlay" id="loading"><div class="loading-pulse">${icons.mark}</div><strong>正在载入行情</strong><span>读取本地完整历史数据</span></div>
  <dialog id="details-dialog"><div class="dialog-heading"><div><span class="eyebrow">DATA & PROVENANCE</span><h2>数据来源与质量</h2></div><button id="close-dialog" class="close-button" aria-label="关闭详情">×</button></div><div id="dialog-body"></div><div class="dialog-bottom"><span>仅浏览本地历史快照，无实时行情连接</span><button class="button primary" id="dialog-done">知道了</button></div></dialog>
  <dialog id="update-dialog" class="update-dialog" data-testid="update-dialog" aria-labelledby="update-title">
    <div class="dialog-heading"><div><span class="eyebrow">APPLICATION UPDATE</span><h2 id="update-title">检查更新</h2></div><button id="close-update" class="close-button" aria-label="关闭更新窗口">×</button></div>
    <div class="update-body">
      <div class="update-versions"><span><small>当前版本</small><strong id="update-current">v—</strong></span><i>→</i><span><small>可用版本</small><strong id="update-target">—</strong></span></div>
      <p id="update-message">正在读取版本信息…</p>
      <div class="update-progress" id="update-progress" hidden><div><span id="update-progress-label">0%</span><span id="update-speed"></span></div><div class="update-progress-track"><i id="update-progress-bar"></i></div></div>
      <div class="update-notes" id="update-notes" hidden></div>
      <div class="update-error" id="update-error" role="alert" hidden></div>
    </div>
    <div class="dialog-bottom update-actions"><button class="button" id="update-later">稍后</button><div><button class="button" id="update-retry" hidden>重试</button><button class="button primary" id="update-download" data-testid="update-download" hidden>立即下载</button><button class="button primary" id="update-install" data-testid="update-install" hidden>重启安装</button><button class="button primary" id="update-ok" hidden>知道了</button></div></div>
  </dialog>
  <div class="toast" id="toast" role="status" hidden></div>
`;

const entryButton = document.createElement('button');
entryButton.id = 'entry-rules'; entryButton.dataset.testid = 'entry-rules'; entryButton.className = 'button'; entryButton.textContent = '入场规则';
entryButton.title = '查看可编辑的突破回调入场规则';
document.querySelector<HTMLButtonElement>('#toggle-monday')!.title = '显示或隐藏每周前8根、逐次突破和回调入场标记';
document.querySelector('.toolbar-right')!.insertBefore(entryButton, document.querySelector('#toggle-subcharts'));
const reviewButton = document.createElement('button');
reviewButton.id = 'profit-loss-review';
reviewButton.dataset.testid = 'profit-loss-review';
reviewButton.className = 'button';
reviewButton.textContent = '盈亏情况';
reviewButton.title = '查看当前历史数据的盈亏复盘';
document.querySelector('.toolbar-right')!.insertBefore(reviewButton, document.querySelector('#toggle-subcharts'));
const rulesDialog = document.createElement('dialog');
rulesDialog.id = 'rules-dialog';
rulesDialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">ENTRY RULES</span><h2>突破回调入场规则</h2></div><button id="close-rules" class="close-button" aria-label="关闭入场规则">×</button></div><div class="rules-meta" id="rules-meta"></div><pre class="rules-content" id="rules-content"></pre><div class="dialog-bottom"><span>编辑 EXE 同级 data/entry-rules.md 后重新打开即可刷新文字</span><button class="button primary" id="rules-done">知道了</button></div>';
document.body.append(rulesDialog);
const reviewDialog = document.createElement('dialog');
reviewDialog.id = 'review-dialog';
reviewDialog.dataset.testid = 'review-dialog';
reviewDialog.setAttribute('aria-labelledby', 'review-title');
reviewDialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">PROFIT & LOSS REVIEW</span><h2 id="review-title">盈亏情况</h2></div><button id="close-review" data-testid="close-review" class="close-button" aria-label="关闭盈亏情况">×</button></div><div class="review-content" id="review-content"></div><div class="dialog-bottom"><span>固定按 1 手交易，不计算手续费和滑点</span><button class="button primary" id="review-done" data-testid="review-done">知道了</button></div>';
document.body.append(reviewDialog);

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`;
const timeKey = (bar: Bar) => (bar.endMs / 1000) as UTCTimestamp;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const shortTime = (ms: number) => formatBeijing(ms).slice(0, 16);
const sameDate = (bar: Bar) => formatBeijing(bar.startMs).slice(0, 10) === formatBeijing(bar.endMs).slice(0, 10);
const interval = (bar: Bar) => `${shortTime(bar.startMs)} — ${sameDate(bar) ? formatBeijing(bar.endMs).slice(11, 16) : shortTime(bar.endMs)}`;
const updateDialog = $('#update-dialog') as HTMLDialogElement;

let dataset: Dataset | undefined;
let mode: 'dual' | '5' | '60' = 'dual';
let subchartsVisible = true;
let mondayVisible = false;
let requestedInstrument: Instrument = 'main_continuous';
let requestId = 0;
let selected: { period: Period; bar: Bar } | undefined;
let crosshairSyncing = false;
let toastTimer: ReturnType<typeof setTimeout>;
let updateState: UpdateState | undefined;
let updateInteraction = false;
let updateActionRunning = false;
let marketUpdateState: MarketUpdateState = { phase: 'idle' };
let marketUpdateRequestRunning = false;
let reloadedMarketUpdateCompletion: string | undefined;

type ChartSelection =
  | { kind: 'linked'; bars: Bar[] }
  | {
      kind: 'entry';
      bars: Bar[];
      focusBars: Bar[];
      triggerStart: number;
      direction: WeeklyEntry['direction'];
      pullbackLine: number;
      entryCutoff: number;
      sessionEnd: number;
      forcedExitBar?: Bar;
      endReason: EntryLifecycleEndReason;
      reactionRange?: EntryReactionRange;
      quarterSignal?: EntryQuarterSignal;
      stopLossSignal?: EntryStopLossSignal;
      takeProfitSignal?: EntryTakeProfitSignal;
      exitAnalysis?: EntryExitAnalysis;
    };

function toast(message: string) {
  const element = $('#toast'); element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

function clearToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }

function renderMarketUpdateState(state = marketUpdateState): void {
  marketUpdateState = state;
  const view = marketUpdateView(state, dataset);
  const button = $('#market-update') as HTMLButtonElement;
  button.disabled = view.busy || marketUpdateRequestRunning;
  button.setAttribute('aria-busy', String(view.busy || marketUpdateRequestRunning));
  $('#market-update-label').textContent = view.buttonLabel;
  $('#market-update-status').textContent = view.statusText;
  $('#market-update-meta').textContent = view.metadataText;
  $('#market-update-row').dataset.tone = view.tone;
  document.documentElement.dataset.marketUpdatePhase = state.phase;
}

async function acceptMarketUpdateState(state: MarketUpdateState): Promise<void> {
  const shouldReload = state.phase === 'succeeded'
    && !!state.completedAt
    && state.completedAt !== reloadedMarketUpdateCompletion;
  if (shouldReload) reloadedMarketUpdateCompletion = state.completedAt;
  renderMarketUpdateState(state);
  if (!shouldReload) return;
  await loadInstrument(requestedInstrument, true);
  renderMarketUpdateState(state);
}

const updatePhaseLabels: Record<UpdateState['phase'], string> = {
  disabled: '更新不可用',
  idle: '检查更新',
  checking: '正在检查更新',
  'up-to-date': '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载更新',
  downloaded: '更新已准备好',
  installing: '正在启动安装',
  failed: '更新未完成',
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function setUpdateDialogOpen(open: boolean): void {
  if (open && !updateDialog.open) updateDialog.showModal();
  if (!open && updateDialog.open) updateDialog.close();
}

function updateMessage(state: UpdateState): string {
  switch (state.phase) {
    case 'disabled': return '开发模式和普通自动化测试不会连接生产更新源。';
    case 'idle': return '手动检查 GitHub Releases 上的最新稳定版本。';
    case 'checking': return '正在检查最新稳定版本，行情浏览可以继续使用。';
    case 'up-to-date': return `当前 ${state.currentVersionLabel} 已是最新版本。`;
    case 'available': return `新版本 v${state.availableVersion} 已发布。下载只会在你确认后开始。`;
    case 'downloading': return `正在下载 v${state.availableVersion}。下载失败不会影响当前版本。`;
    case 'downloaded': return `v${state.availableVersion} 已下载并通过完整性校验，可在你确认后重启安装。`;
    case 'installing': return '正在退出当前版本并启动安装程序…';
    case 'failed': return '当前版本仍可正常使用。你可以稍后重试更新操作。';
  }
}

function renderUpdateState(state: UpdateState): void {
  updateState = state;
  $('#app-version').textContent = state.currentVersionLabel;
  $('#update-entry').dataset.phase = state.phase;
  $('#update-entry-label').textContent = state.phase === 'available'
    ? `可更新 v${state.availableVersion}`
    : state.phase === 'downloading'
      ? `${Math.round(state.progress?.percent || 0)}%`
      : state.phase === 'downloaded'
        ? '等待安装'
        : state.phase === 'checking'
          ? '检查中'
          : '检查更新';
  $('#update-title').textContent = updatePhaseLabels[state.phase];
  $('#update-current').textContent = state.currentVersionLabel;
  $('#update-target').textContent = state.availableVersion ? `v${state.availableVersion}` : '—';
  $('#update-message').textContent = updateMessage(state);

  const progress = state.progress;
  $('#update-progress').hidden = !progress || !['downloading', 'downloaded'].includes(state.phase);
  if (progress) {
    const percent = Math.max(0, Math.min(100, progress.percent));
    $('#update-progress-label').textContent = `${Math.round(percent)}% · ${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`;
    $('#update-speed').textContent = state.phase === 'downloading' && progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/s` : '';
    ($('#update-progress-bar') as HTMLElement).style.width = `${percent}%`;
  }

  const notes = state.releaseNotes?.trim();
  $('#update-notes').hidden = !notes;
  $('#update-notes').textContent = notes || '';
  $('#update-error').hidden = !state.error || state.error.code === 'disabled';
  $('#update-error').textContent = state.error?.code === 'disabled' ? '' : state.error?.message || '';

  $('#update-retry').hidden = state.phase !== 'failed';
  $('#update-download').hidden = state.phase !== 'available';
  $('#update-install').hidden = state.phase !== 'downloaded';
  $('#update-ok').hidden = state.phase !== 'up-to-date' && state.phase !== 'disabled';
  $('#update-later').hidden = state.phase === 'checking' || state.phase === 'installing' || state.phase === 'up-to-date' || state.phase === 'disabled';
  document.querySelectorAll<HTMLButtonElement>('#update-dialog button').forEach(button => {
    button.disabled = updateActionRunning && !['close-update', 'update-later'].includes(button.id);
  });

  const important = state.phase === 'available' || state.phase === 'downloaded';
  const activeFlow = updateInteraction || updateDialog.open;
  if (important || (activeFlow && state.phase !== 'idle')) setUpdateDialogOpen(true);
  if (!activeFlow && state.requestedBy === 'startup' && ['up-to-date', 'failed'].includes(state.phase)) setUpdateDialogOpen(false);
  document.documentElement.dataset.updatePhase = state.phase;
}

async function runUpdateAction(action: 'check' | 'download' | 'install'): Promise<void> {
  if (updateActionRunning) return;
  updateInteraction = true;
  updateActionRunning = true;
  if (updateState) renderUpdateState(updateState);
  try {
    const state = action === 'check'
      ? await window.updates.check()
      : action === 'download'
        ? await window.updates.download()
        : await window.updates.restartAndInstall();
    renderUpdateState(state);
  } catch (error) {
    $('#update-title').textContent = '更新请求失败';
    $('#update-message').textContent = '当前版本仍可正常使用。';
    $('#update-error').textContent = error instanceof Error ? error.message : String(error);
    $('#update-error').hidden = false;
    setUpdateDialogOpen(true);
  } finally {
    updateActionRunning = false;
    if (updateState) renderUpdateState(updateState);
  }
}

class MarketChart {
  readonly element: HTMLElement;
  readonly chart: IChartApi;
  readonly candle: ISeriesApi<'Candlestick'>;
  private volume?: ISeriesApi<'Histogram'>;
  private oi?: ISeriesApi<'Line'>;
  private ema20?: ISeriesApi<'Line'>;
  private entryPullback?: ISeriesApi<'Line'>;
  private entryQuarter?: ISeriesApi<'Line'>;
  private entryStopLoss?: ISeriesApi<'Line'>;
  private entryTakeProfit?: ISeriesApi<'Line'>;
  private emaByStart = new Map<number, number>();
  readonly markers: ISeriesMarkersPluginApi<Time>;
  bars: Bar[] = [];
  private byTime = new Map<number, Bar>();
  private selection?: ChartSelection;
  private selectedDetail?: Bar;
  private anomalies: Anomaly[] = [];
  private rollovers: ContractRollover[] = [];
  private chartHost: HTMLElement;
  private lastDetail?: Bar;
  private pointerInside = false;
  private mondayHighlights = new Set<number>();
  private weeklyBreakouts: WeeklyBreakout[] = [];
  private breakoutsByStart = new Map<number, WeeklyBreakout[]>();
  private weeklyEntries: WeeklyEntry[] = [];
  private entriesByStart = new Map<number, WeeklyEntry[]>();
  private indexByStart = new Map<number, number>();
  private hoverRange?: { first: Bar; last: Bar };
  private hoverOverlay?: HTMLElement;
  private hoverRenderFrame?: number;
  private reactionOverlay?: HTMLElement;
  private reactionRenderFrame?: number;
  private focusedLogicalRange?: { from: number; to: number };

  constructor(readonly period: Period) {
    this.element = document.createElement('article');
    this.element.className = 'chart-card'; this.element.id = `card-${period}`;
    this.element.dataset.testid = `chart-${period}`;
    this.element.innerHTML = `<div class="chart-heading"><div class="chart-title"><span class="period-icon ${period === 60 ? 'macro' : 'micro'}">${period === 60 ? '60' : '5'}<small>MIN</small></span><div><h2>${period} 分钟 <span>${period === 60 ? '趋势视图' : '细节视图'}</span></h2><div class="chart-caption">K 线 · 成交量 · 持仓量</div></div></div><div class="chart-heading-tools"><button type="button" class="chart-axis-reset" data-testid="axis-reset-${period}" title="恢复自动价格范围；右侧价格轴可上下拖动调整，双击也可复位" aria-label="${period}分钟图恢复自动价格范围">${icons.resetScale}</button><div class="chart-summary"><strong class="detail-close">—</strong><span class="detail-session">—</span></div></div></div>
      <div class="bar-details"><div class="detail-time">—</div><div class="ohlc"><span>开 <b data-value="open">—</b></span><span>高 <b data-value="high">—</b></span><span>低 <b data-value="low">—</b></span><span>收 <b data-value="close">—</b></span></div><div class="breakout-info" hidden></div><div class="entry-info" hidden></div></div>
      <div class="chart-container"><div class="chart-host" id="canvas-${period}"></div><div class="pane-label volume-label">成交量 <b data-value="volume">—</b><span>手</span></div><div class="pane-label oi-label">持仓量 <b data-value="oi">—</b><span>手</span><span class="oi-delta">仓差 <b data-value="delta">—</b></span></div></div><div class="chart-bottom"><span class="bar-count">—</span><span class="monday-legend" style="color:#f0b35c;font-size:9px;white-space:nowrap" hidden><span>● 周一前8根</span> <span style="color:#62c6ff">↑ 新高</span> <span style="color:#dc94ff">↓ 新低</span> <span style="color:#74e2a6">↑ 多入场</span> <span style="color:#ff9d82">↓ 空入场</span></span><span class="bar-completeness">时间按自然日显示</span></div>`;
    $('#charts').append(this.element);
    this.chartHost = this.element.querySelector('.chart-host')!;
    if (period === 5) {
      this.hoverOverlay = document.createElement('div');
      this.hoverOverlay.className = 'linked-hover-range';
      this.hoverOverlay.dataset.testid = 'linked-hover-range';
      this.hoverOverlay.setAttribute('aria-hidden', 'true');
      this.hoverOverlay.hidden = true;
      this.chartHost.after(this.hoverOverlay);
      this.reactionOverlay = document.createElement('div');
      this.reactionOverlay.className = 'entry-reaction-range';
      this.reactionOverlay.dataset.testid = 'entry-reaction-range';
      this.reactionOverlay.dataset.present = 'false';
      this.reactionOverlay.dataset.visible = 'false';
      this.reactionOverlay.setAttribute('aria-hidden', 'true');
      this.reactionOverlay.hidden = true;
      this.chartHost.after(this.reactionOverlay);
    }
    this.chartHost.addEventListener('mouseenter', () => { this.pointerInside = true; });
    this.chartHost.addEventListener('wheel', () => {
      this.focusedLogicalRange = undefined;
      this.scheduleReactionRangeRender();
    }, { passive: true });
    this.chartHost.addEventListener('pointerdown', () => {
      this.focusedLogicalRange = undefined;
      this.scheduleReactionRangeRender();
    });
    this.chartHost.addEventListener('pointerup', () => {
      this.scheduleScaleDiagnostics();
      this.scheduleReactionRangeRender();
      requestAnimationFrame(() => this.scheduleReactionRangeRender());
    });
    this.chartHost.addEventListener('dblclick', () => {
      this.scheduleScaleDiagnostics();
      this.scheduleReactionRangeRender();
      requestAnimationFrame(() => this.scheduleReactionRangeRender());
    });
    this.chartHost.addEventListener('pointermove', (event) => {
      this.scheduleReactionRangeRender();
      if (this.period !== 60) return;
      if (!dataset) { charts[5].clearHoverRange(); return; }
      const x = event.clientX - this.chartHost.getBoundingClientRect().left;
      const timeScale = this.chart.timeScale();
      const logical = x >= 0 && x <= timeScale.width() ? timeScale.coordinateToLogical(x) : null;
      const index = logical === null ? -1 : Math.round(Number(logical));
      const bar = index >= 0 && index < this.bars.length ? this.bars[index] : undefined;
      charts[5].setHoverRange(bar ? childrenFor(bar, dataset.bars5) : []);
    });
    this.chartHost.addEventListener('mouseleave', () => {
      this.pointerInside = false;
      if (this.period === 60 && !this.element.hidden) charts[5].clearHoverRange();
    });
    this.chart = createChart(this.chartHost, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#121923' }, textColor: '#7f8d9f', fontFamily: 'Consolas, "Microsoft YaHei UI", sans-serif', fontSize: 11, attributionLogo: false, panes: { separatorColor: '#263140', separatorHoverColor: '#3b495b', enableResize: false } },
      grid: { vertLines: { color: '#1a2330' }, horzLines: { color: '#1e2834' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#7f91a4', labelBackgroundColor: '#394858', style: 2 }, horzLine: { color: '#7f91a4', labelBackgroundColor: '#394858', style: 2 } },
      rightPriceScale: { borderColor: '#27313e', minimumWidth: 64, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: '#27313e', timeVisible: true, secondsVisible: false, rightOffset: 5, minBarSpacing: 1, barSpacing: 6, tickMarkFormatter: (time: Time, type: TickMarkType) => {
        const text = formatBeijing(Number(time) * 1000);
        return type === TickMarkType.Year ? text.slice(0, 4) : type === TickMarkType.Month || type === TickMarkType.DayOfMonth ? text.slice(5, 10) : text.slice(11, 16);
      } },
      localization: { locale: 'zh-CN', timeFormatter: (time: Time) => shortTime(Number(time) * 1000) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });
    this.candle = this.chart.addSeries(CandlestickSeries, { upColor: '#ef646e', downColor: '#28b59c', borderUpColor: '#ef646e', borderDownColor: '#28b59c', wickUpColor: '#ef646e', wickDownColor: '#28b59c', priceFormat: { type: 'price', precision: 0, minMove: MARKET_PRICE_TICK }, priceLineColor: '#697689', priceLineStyle: 2 });
    if (period === 60) {
      this.ema20 = this.chart.addSeries(LineSeries, {
        color: '#e8edf5', lineWidth: 2, priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3,
      }, 0);
      this.element.querySelector('.ohlc')!.insertAdjacentHTML('beforeend', '<span class="ema-readout" title="EMA20：α=2/21，以数据首根收盘价为初值，包含当前K线并连续递推">EMA20 <b data-value="ema20">—</b></span>');
    } else {
      this.entryPullback = this.chart.addSeries(LineSeries, {
        color: '#47d990', lineWidth: 2, lineStyle: LineStyle.Solid, priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
        pointMarkersVisible: false, title: '回调',
      }, 0);
      this.entryQuarter = this.chart.addSeries(LineSeries, {
        color: '#ffffff', lineWidth: 2, lineStyle: LineStyle.Solid, priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 0, minMove: MARKET_PRICE_TICK },
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        pointMarkersVisible: false, title: '',
        autoscaleInfoProvider: () => null,
      }, 0);
      this.entryStopLoss = this.chart.addSeries(LineSeries, {
        color: '#f4c95d', lineWidth: 2, lineStyle: LineStyle.Solid, priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 0, minMove: MARKET_PRICE_TICK },
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        pointMarkersVisible: false, title: '',
        autoscaleInfoProvider: () => null,
      }, 0);
      this.entryTakeProfit = this.chart.addSeries(LineSeries, {
        color: '#4fc3f7', lineWidth: 2, lineStyle: LineStyle.Solid, lineType: LineType.WithSteps,
        priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 0, minMove: MARKET_PRICE_TICK },
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        pointMarkersVisible: false, title: '',
        autoscaleInfoProvider: () => null,
      }, 0);
      this.element.dataset.pullbackLineStyle = 'solid';
      this.element.dataset.quarterLineStyle = 'solid';
      this.element.dataset.quarterLineColor = '#ffffff';
      this.element.dataset.quarterLineAutoScale = 'false';
      this.element.dataset.stopLossLineStyle = 'solid';
      this.element.dataset.stopLossLineColor = '#f4c95d';
      this.element.dataset.stopLossLineWidth = '2';
      this.element.dataset.stopLossLineAutoScale = 'false';
      this.element.dataset.takeProfitLineStyle = 'solid';
      this.element.dataset.takeProfitLineType = 'with-steps';
      this.element.dataset.takeProfitLineColor = '#4fc3f7';
      this.element.dataset.takeProfitLineWidth = '2';
      this.element.dataset.takeProfitLineAutoScale = 'false';
    }
    this.setSubchartsVisible(true);
    this.markers = createSeriesMarkers(this.candle, [], { zOrder: 'top', autoScale: false });
    this.element.querySelector<HTMLButtonElement>('.chart-axis-reset')!.addEventListener('click', () => this.resetPriceScale());
    this.chart.subscribeClick((event) => {
      if (!event.time) return;
      const bar = this.byTime.get(Number(event.time));
      if (!bar) return;
      const hoveredObjectId = typeof event.hoveredObjectId === 'string' ? event.hoveredObjectId : undefined;
      selectBar(this.period, bar, false, hoveredObjectId);
      if (typeof event.hoveredObjectId === 'string' && event.hoveredObjectId.startsWith('anomaly')) showDetails(this.anomalies.find(a => a.timeMs >= bar.startMs && a.timeMs < bar.endMs));
    });
    this.chart.subscribeCrosshairMove((event) => {
      // Scale/layout changes also emit crosshair events. They are not user intent,
      // and re-broadcasting them would let two different viewports overwrite reads.
      if (crosshairSyncing) return;
      const bar = event.time ? this.byTime.get(Number(event.time)) : undefined;
      if (!event.sourceEvent && event.time !== undefined) {
        // A real pointer can land on a different bar when the viewport resizes.
        // Keep its own values accurate without re-broadcasting synthetic motion.
        if (this.pointerInside) this.details(bar || this.selectionOrLast());
        return;
      }
      this.details(bar || this.selectionOrLast());
      if (!dataset) return;
      const other = this.period === 60 ? charts[5] : charts[60];
      crosshairSyncing = true;
      try {
        if (bar) {
          const matched = this.period === 5 ? parentFor(bar, dataset.bars60) : childrenFor(bar, dataset.bars5)[0];
          const coordinate = matched ? other.chart.timeScale().timeToCoordinate(timeKey(matched)) : null;
          if (matched && coordinate !== null && coordinate >= 0 && coordinate <= other.chart.timeScale().width()) {
            other.chart.setCrosshairPosition(matched.close, timeKey(matched), other.candle); other.details(matched);
          } else {
            // Lightweight Charts clamps an offscreen synthetic crosshair to an
            // unrelated boundary candle, so keep it cleared until visible.
            other.chart.clearCrosshairPosition(); other.details(other.selectionOrLast());
          }
        } else { other.chart.clearCrosshairPosition(); other.details(other.selectionOrLast()); }
      } finally { crosshairSyncing = false; }
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) {
        this.element.dataset.visibleFrom = String(Number(range.from));
        this.element.dataset.visibleTo = String(Number(range.to));
        this.element.dataset.visibleSpan = String(Number(range.to) - Number(range.from));
      } else {
        delete this.element.dataset.visibleFrom;
        delete this.element.dataset.visibleTo;
        delete this.element.dataset.visibleSpan;
      }
      this.scheduleHoverRangeRender();
      this.scheduleReactionRangeRender();
    });
    new ResizeObserver(() => {
      this.layoutPanes();
      const range = this.focusedLogicalRange;
      if (range) requestAnimationFrame(() => requestAnimationFrame(() => this.chart.timeScale().setVisibleLogicalRange(range)));
    }).observe(this.chartHost);
  }

  setSubchartsVisible(visible: boolean) {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (visible && !this.volume) {
      this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
      this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.27, bottom: 0.02 } });
      this.oi = this.chart.addSeries(LineSeries, { color: '#88a9cb', lineWidth: 1, priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3 }, 2);
      this.oi.priceScale().applyOptions({ scaleMargins: { top: 0.3, bottom: 0.14 } });
      this.updateSubchartData();
      this.chart.panes().forEach((pane, index) => pane.setStretchFactor(index === 0 ? 0.64 : 0.18));
    } else if (!visible && this.volume) {
      if (this.oi) this.chart.removeSeries(this.oi);
      this.chart.removeSeries(this.volume);
      this.oi = undefined; this.volume = undefined;
      this.chart.panes()[0].setStretchFactor(1);
    }
    this.element.querySelectorAll<HTMLElement>('.pane-label').forEach(label => { label.hidden = !visible; });
    this.element.querySelector('.chart-caption')!.textContent = `${this.period === 60 ? 'K 线 · EMA20' : 'K 线'}${visible ? ' · 成交量 · 持仓量' : ''}`;
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
    this.layoutPanes();
  }

  private updateSubchartData() {
    this.volume?.setData(this.bars.map(bar => ({ time: timeKey(bar), value: bar.volume, color: bar.close >= bar.open ? '#ef646e88' : '#28b59c88' })));
    this.oi?.setData(this.bars.map(bar => ({ time: timeKey(bar), value: bar.closeOi })));
  }

  layoutPanes() {
    // Observe after the chart's own ResizeObserver has committed the pane sizes.
    requestAnimationFrame(() => {
      const panes = this.chart.panes();
      const priceHeight = panes[0]?.getHeight() || 0;
      const volumeHeight = panes[1]?.getHeight() || 0;
      (this.element.querySelector('.volume-label') as HTMLElement).style.top = `${priceHeight + 7}px`;
      (this.element.querySelector('.oi-label') as HTMLElement).style.top = `${priceHeight + volumeHeight + 8}px`;
      this.scheduleHoverRangeRender();
      this.scheduleReactionRangeRender();
    });
  }

  setData(bars: Bar[], anomalies: Anomaly[], bars5: Bar[] = [], rollovers: ContractRollover[] = []) {
    this.clearHoverRange();
    this.bars = bars; this.anomalies = anomalies; this.rollovers = rollovers; this.selection = undefined; this.selectedDetail = undefined; this.focusedLogicalRange = undefined;
    this.indexByStart = new Map(bars.map((bar, index) => [bar.startMs, index]));
    this.updateSelectionDiagnostics();
    this.drawEntryPullback();
    const weekly = this.period === 60 ? analyzeWeeklyRange(bars) : { seedBars: [], breakouts: [] };
    this.mondayHighlights = new Set(weekly.seedBars.map(bar => bar.startMs));
    this.weeklyBreakouts = weekly.breakouts;
    this.breakoutsByStart = new Map();
    for (const signal of this.weeklyBreakouts) {
      const signals = this.breakoutsByStart.get(signal.bar.startMs) || [];
      signals.push(signal); this.breakoutsByStart.set(signal.bar.startMs, signals);
    }
    this.byTime = new Map(bars.map(bar => [Number(timeKey(bar)), bar]));
    const average = exponentialMovingAverage(bars, 20);
    this.emaByStart = new Map(average.map(point => [point.bar.startMs, point.value]));
    this.ema20?.setData(average.map(point => ({ time: timeKey(point.bar), value: point.value })));
    this.element.dataset.emaCount = String(this.ema20?.data().length || 0);
    const entryAnalysis = this.period === 60 ? analyzeWeeklyEntries(bars, bars5, average) : { entries: [], incompleteHours: 0 };
    this.weeklyEntries = entryAnalysis.entries;
    this.entriesByStart = new Map();
    for (const entry of this.weeklyEntries) {
      const entries = this.entriesByStart.get(entry.bar.startMs) || [];
      entries.push(entry); this.entriesByStart.set(entry.bar.startMs, entries);
    }
    this.element.dataset.entryIncompleteHours = String(entryAnalysis.incompleteHours);
    this.updateMondayVisibility();
    this.updateSubchartData();
    this.element.querySelector('.bar-count')!.textContent = `完整载入 ${number(bars.length)} 根`;
    this.details(bars.at(-1)); this.latest();
    requestAnimationFrame(() => this.layoutPanes());
  }

  getWeeklyEntries(): readonly WeeklyEntry[] {
    return this.weeklyEntries;
  }

  updateMondayVisibility() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const priceScale = this.chart.priceScale('right');
    const manualPriceRange = priceScale.options().autoScale ? null : priceScale.getVisibleRange();
    this.element.dataset.mondayCount = String(mondayVisible ? this.mondayHighlights.size : 0);
    this.element.querySelector<HTMLElement>('.monday-legend')!.hidden = !mondayVisible || this.period !== 60;
    this.candle.setData(this.bars.map(bar => {
      const monday = mondayVisible && this.mondayHighlights.has(bar.startMs);
      return {
        time: timeKey(bar), open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        ...(monday ? { borderColor: '#ffd27a', wickColor: '#ffd27a' } : {}),
      };
    }));
    this.drawMarkers();
    this.updateBreakoutInfo(this.lastDetail);
    this.updateEntryInfo(this.lastDetail);
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
    if (manualPriceRange) priceScale.setVisibleRange(manualPriceRange);
    this.scheduleScaleDiagnostics();
  }

  private updateBreakoutInfo(bar?: Bar) {
    const info = this.element.querySelector<HTMLElement>('.breakout-info')!;
    info.hidden = !mondayVisible || this.period !== 60;
    if (info.hidden) return;
    const signals = bar ? this.breakoutsByStart.get(bar.startMs) || [] : [];
    info.textContent = signals.length ? signals.map(signal => `${signal.direction === 'up' ? '↑ 新高' : '↓ 新低'} ${signal.previousBoundary} → ${signal.value}`).join('  ·  ')
      : bar && this.mondayHighlights.has(bar.startMs) ? '前8根形成初始范围 · 第9根起判断突破'
      : '本根无突破标记';
    info.title = info.textContent;
  }

  private updateEntryInfo(bar?: Bar) {
    const info = this.element.querySelector<HTMLElement>('.entry-info')!;
    const entries = bar ? this.entriesByStart.get(bar.startMs) || [] : [];
    info.hidden = !mondayVisible || this.period !== 60 || !entries.length;
    if (info.hidden) { info.textContent = ''; return; }
    info.textContent = entries.map(entry => `${entry.direction === 'long' ? '多头入场' : '空头入场'} ${shortTime(entry.triggerBar.startMs)} · 回调线 ${number(entry.pullbackLine)} · 中点 ${number(entry.midpoint)} · EMA20 ${number(entry.ema20)} · 范围 ${number(entry.boundaryLow)}–${number(entry.boundaryHigh)}`).join('  |  ');
    info.title = info.textContent;
  }

  details(bar?: Bar) {
    if (!bar || this.lastDetail === bar) return;
    this.lastDetail = bar;
    this.updateBreakoutInfo(bar);
    this.updateEntryInfo(bar);
    if (this.ema20) {
      const value = this.emaByStart.get(bar.startMs);
      this.element.querySelector('[data-value="ema20"]')!.textContent = value === undefined ? '—' : number(value);
    }
    const isUp = bar.close >= bar.open;
    this.element.querySelector('.detail-time')!.textContent = interval(bar);
    const close = this.element.querySelector('.detail-close')!;
    close.textContent = number(bar.close); close.className = `detail-close ${isUp ? 'up' : 'down'}`;
    this.element.querySelector('.detail-session')!.textContent = `${bar.session === 'night' ? '夜盘' : '日盘'} · ${bar.expectedMinutes} 分钟`;
    for (const key of ['open', 'high', 'low', 'close'] as const) this.element.querySelector(`[data-value="${key}"]`)!.textContent = number(bar[key]);
    this.element.querySelector('[data-value="volume"]')!.textContent = number(bar.volume);
    this.element.querySelector('[data-value="volume"]')!.setAttribute('title', number(bar.volume));
    this.element.querySelector('[data-value="oi"]')!.textContent = number(bar.closeOi);
    this.element.querySelector('[data-value="oi"]')!.setAttribute('title', number(bar.closeOi));
    const delta = this.element.querySelector('[data-value="delta"]')!;
    delta.textContent = signed(bar.closeOi - bar.openOi); delta.className = bar.closeOi >= bar.openOi ? 'up' : 'down';
    this.element.querySelector('.bar-completeness')!.textContent = `组成分钟 ${bar.observedMinutes}/${bar.expectedMinutes} · ${bar.complete ? '齐全' : '不完整'}`;
    this.element.dataset.hoverStart = String(bar.startMs); this.element.dataset.hoverEnd = String(bar.endMs);
  }

  selectionOrLast() { return this.selectedDetail || this.bars.at(-1); }
  entryFor(bar: Bar, markerId?: string) {
    return selectWeeklyEntry(this.entriesByStart.get(bar.startMs) || [], markerId);
  }
  centerTime() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const index = range ? Math.round((range.from + range.to) / 2) : this.bars.length - 1;
    return this.bars[Math.max(0, Math.min(this.bars.length - 1, index))]?.startMs;
  }
  visibleLogicalSpan() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const span = range ? Number(range.to) - Number(range.from) : Number.NaN;
    return Number.isFinite(span) && span > 0 ? span : undefined;
  }
  resetPriceScale() {
    this.chart.priceScale('right').setAutoScale(true);
    this.scheduleScaleDiagnostics();
    this.scheduleReactionRangeRender();
    this.refreshReactionRangeForFrames();
  }
  private scheduleScaleDiagnostics() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const priceScale = this.chart.priceScale('right');
      const range = priceScale.getVisibleRange();
      this.element.dataset.priceAutoScale = String(priceScale.options().autoScale);
      if (!range) {
        delete this.element.dataset.priceRangeFrom;
        delete this.element.dataset.priceRangeTo;
        delete this.element.dataset.priceRangeSpan;
        return;
      }
      this.element.dataset.priceRangeFrom = String(range.from);
      this.element.dataset.priceRangeTo = String(range.to);
      this.element.dataset.priceRangeSpan = String(range.to - range.from);
    }));
  }
  latest() {
    this.focusedLogicalRange = undefined;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, this.bars.length - 120), to: this.bars.length + 4 });
  }
  focus(bar: Bar) {
    this.focusBars([bar]);
  }
  focusBars(bars: Bar[], targetSpan = 120, ensurePriceVisible = false) {
    const firstIndex = this.bars.indexOf(bars[0]);
    const lastIndex = this.bars.indexOf(bars.at(-1)!);
    const range = linkedLogicalRange(targetSpan, firstIndex, lastIndex, this.bars.length);
    if (range) {
      this.focusedLogicalRange = range;
      this.chart.timeScale().setVisibleLogicalRange(range);
      if (ensurePriceVisible) this.ensureBarsVisibleOnPriceScale(bars);
      this.scheduleReactionRangeRender();
      this.refreshReactionRangeForFrames();
    }
  }
  private ensureBarsVisibleOnPriceScale(bars: Bar[]) {
    const priceScale = this.chart.priceScale('right');
    if (priceScale.options().autoScale) {
      this.scheduleScaleDiagnostics();
      return;
    }
    const low = Math.min(...bars.map(bar => bar.low));
    const high = Math.max(...bars.map(bar => bar.high));
    requestAnimationFrame(() => {
      const visibleRange = priceScale.getVisibleRange();
      if (!visibleRange || visibleRange.from > low || visibleRange.to < high) {
        priceScale.setAutoScale(true);
      }
      this.scheduleScaleDiagnostics();
      this.scheduleReactionRangeRender();
      this.refreshReactionRangeForFrames();
    });
  }
  setHoverRange(bars: Bar[]) {
    if (!this.hoverOverlay) return;
    const first = bars[0], last = bars.at(-1);
    if (!first || !last) { this.clearHoverRange(); return; }
    this.hoverRange = { first, last };
    this.hoverOverlay.dataset.firstStart = String(first.startMs);
    this.hoverOverlay.dataset.lastStart = String(last.startMs);
    this.hoverOverlay.dataset.count = String(bars.length);
    this.scheduleHoverRangeRender();
  }
  clearHoverRange() {
    this.hoverRange = undefined;
    if (this.hoverRenderFrame !== undefined) {
      cancelAnimationFrame(this.hoverRenderFrame);
      this.hoverRenderFrame = undefined;
    }
    if (!this.hoverOverlay) return;
    this.hideHoverOverlay();
    delete this.hoverOverlay.dataset.firstStart;
    delete this.hoverOverlay.dataset.lastStart;
    delete this.hoverOverlay.dataset.count;
  }
  private scheduleHoverRangeRender() {
    if (!this.hoverOverlay || !this.hoverRange || this.hoverRenderFrame !== undefined) return;
    this.hoverRenderFrame = requestAnimationFrame(() => {
      this.hoverRenderFrame = undefined;
      this.renderHoverRange();
    });
  }
  private renderHoverRange() {
    if (!this.hoverOverlay || !this.hoverRange) return;
    const firstIndex = this.indexByStart.get(this.hoverRange.first.startMs);
    const lastIndex = this.indexByStart.get(this.hoverRange.last.startMs);
    const timeScale = this.chart.timeScale();
    const chartWidth = timeScale.width();
    const priceHeight = this.chart.panes()[0]?.getHeight() || 0;
    if (firstIndex === undefined || lastIndex === undefined || chartWidth <= 0 || priceHeight <= 0) {
      this.hideHoverOverlay();
      return;
    }
    const firstCoordinate = timeScale.logicalToCoordinate(firstIndex as Logical);
    const lastCoordinate = timeScale.logicalToCoordinate(lastIndex as Logical);
    if (firstCoordinate === null || lastCoordinate === null) {
      this.hideHoverOverlay();
      return;
    }
    const adjacentCoordinate = timeScale.logicalToCoordinate((firstIndex + 1) as Logical);
    const spacing = lastIndex > firstIndex
      ? Math.abs(lastCoordinate - firstCoordinate) / (lastIndex - firstIndex)
      : adjacentCoordinate === null ? 0 : Math.abs(adjacentCoordinate - firstCoordinate);
    if (!(spacing > 0)) {
      this.hideHoverOverlay();
      return;
    }
    const rawLeft = Math.min(firstCoordinate, lastCoordinate) - spacing / 2;
    const rawRight = Math.max(firstCoordinate, lastCoordinate) + spacing / 2;
    if (rawRight <= 0 || rawLeft >= chartWidth) {
      this.hideHoverOverlay();
      return;
    }
    const left = Math.max(0, rawLeft);
    const right = Math.min(chartWidth, rawRight);
    if (right <= left) {
      this.hideHoverOverlay();
      return;
    }
    this.hoverOverlay.style.transform = `translateX(${left}px)`;
    this.hoverOverlay.style.width = `${right - left}px`;
    this.hoverOverlay.style.height = `${priceHeight}px`;
    this.hoverOverlay.hidden = false;
    this.hoverOverlay.dataset.visible = 'true';
    this.hoverOverlay.dataset.left = String(left);
    this.hoverOverlay.dataset.width = String(right - left);
    this.hoverOverlay.dataset.height = String(priceHeight);
    this.hoverOverlay.dataset.chartWidth = String(chartWidth);
    this.hoverOverlay.dataset.clipped = String(rawLeft < 0 || rawRight > chartWidth);
    this.hoverOverlay.dataset.firstIndex = String(firstIndex);
    this.hoverOverlay.dataset.lastIndex = String(lastIndex);
  }
  private hideHoverOverlay() {
    if (!this.hoverOverlay) return;
    this.hoverOverlay.hidden = true;
    this.hoverOverlay.dataset.visible = 'false';
    delete this.hoverOverlay.dataset.left;
    delete this.hoverOverlay.dataset.width;
    delete this.hoverOverlay.dataset.height;
    delete this.hoverOverlay.dataset.chartWidth;
    delete this.hoverOverlay.dataset.clipped;
    delete this.hoverOverlay.dataset.firstIndex;
    delete this.hoverOverlay.dataset.lastIndex;
  }
  private scheduleReactionRangeRender() {
    if (!this.reactionOverlay || this.selection?.kind !== 'entry' || !this.selection.reactionRange || this.reactionRenderFrame !== undefined) return;
    this.reactionRenderFrame = requestAnimationFrame(() => {
      this.reactionRenderFrame = undefined;
      this.renderReactionRange();
    });
  }
  private refreshReactionRangeForFrames(remaining = 4) {
    if (remaining <= 0) return;
    requestAnimationFrame(() => {
      this.renderReactionRange();
      this.refreshReactionRangeForFrames(remaining - 1);
    });
  }
  private renderReactionRange() {
    const range = this.selection?.kind === 'entry' ? this.selection.reactionRange : undefined;
    if (!this.reactionOverlay || !range) {
      this.hideReactionOverlay();
      return;
    }
    const firstIndex = this.indexByStart.get(range.extremeBar.startMs);
    const lastIndex = this.indexByStart.get(range.reactionBar.startMs);
    const timeScale = this.chart.timeScale();
    const chartWidth = timeScale.width();
    const priceHeight = this.chart.panes()[0]?.getHeight() || 0;
    if (firstIndex === undefined || lastIndex === undefined || chartWidth <= 0 || priceHeight <= 0) {
      this.hideReactionOverlay();
      return;
    }
    const firstCoordinate = timeScale.logicalToCoordinate(firstIndex as Logical);
    const lastCoordinate = timeScale.logicalToCoordinate(lastIndex as Logical);
    const highCoordinate = this.candle.priceToCoordinate(range.high);
    const lowCoordinate = this.candle.priceToCoordinate(range.low);
    if (firstCoordinate === null || lastCoordinate === null || highCoordinate === null || lowCoordinate === null) {
      this.hideReactionOverlay();
      return;
    }
    const adjacentCoordinate = timeScale.logicalToCoordinate((lastIndex + 1) as Logical)
      ?? timeScale.logicalToCoordinate((firstIndex - 1) as Logical);
    const spacing = lastIndex > firstIndex
      ? Math.abs(lastCoordinate - firstCoordinate) / (lastIndex - firstIndex)
      : adjacentCoordinate === null ? 0 : Math.abs(adjacentCoordinate - firstCoordinate);
    if (!(spacing > 0)) {
      this.hideReactionOverlay();
      return;
    }
    const rawLeft = Math.min(firstCoordinate, lastCoordinate) - spacing / 2;
    const rawRight = Math.max(firstCoordinate, lastCoordinate) + spacing / 2;
    const rawTop = Math.min(highCoordinate, lowCoordinate);
    const rawBottom = Math.max(highCoordinate, lowCoordinate);
    if (rawRight <= 0 || rawLeft >= chartWidth || rawBottom <= 0 || rawTop >= priceHeight) {
      this.hideReactionOverlay();
      return;
    }
    const left = Math.max(0, rawLeft);
    const right = Math.min(chartWidth, rawRight);
    const top = Math.max(0, rawTop);
    const bottom = Math.min(priceHeight, rawBottom);
    if (right <= left || bottom <= top) {
      this.hideReactionOverlay();
      return;
    }
    this.reactionOverlay.style.transform = `translate(${left}px, ${top}px)`;
    this.reactionOverlay.style.width = `${right - left}px`;
    this.reactionOverlay.style.height = `${bottom - top}px`;
    this.reactionOverlay.hidden = false;
    this.reactionOverlay.dataset.visible = 'true';
    this.reactionOverlay.dataset.left = String(left);
    this.reactionOverlay.dataset.top = String(top);
    this.reactionOverlay.dataset.width = String(right - left);
    this.reactionOverlay.dataset.height = String(bottom - top);
    this.reactionOverlay.dataset.chartWidth = String(chartWidth);
    this.reactionOverlay.dataset.priceHeight = String(priceHeight);
    this.reactionOverlay.dataset.clippedX = String(rawLeft < 0 || rawRight > chartWidth);
    this.reactionOverlay.dataset.clippedY = String(rawTop < 0 || rawBottom > priceHeight);
    this.reactionOverlay.dataset.clipped = String(rawLeft < 0 || rawRight > chartWidth || rawTop < 0 || rawBottom > priceHeight);
  }
  private hideReactionOverlay() {
    if (!this.reactionOverlay) return;
    this.reactionOverlay.hidden = true;
    this.reactionOverlay.dataset.visible = 'false';
    for (const key of ['left', 'top', 'width', 'height', 'chartWidth', 'priceHeight', 'clippedX', 'clippedY', 'clipped']) {
      delete this.reactionOverlay.dataset[key];
    }
  }
  private clearReactionOverlay() {
    if (this.reactionRenderFrame !== undefined) {
      cancelAnimationFrame(this.reactionRenderFrame);
      this.reactionRenderFrame = undefined;
    }
    this.hideReactionOverlay();
    if (!this.reactionOverlay) return;
    this.reactionOverlay.dataset.present = 'false';
    for (const key of ['direction', 'firstStart', 'lastStart', 'extremeStart', 'reactionStart', 'firstIndex', 'lastIndex', 'high', 'low']) {
      delete this.reactionOverlay.dataset[key];
    }
  }
  private updateReactionRangeDiagnostics() {
    const range = this.selection?.kind === 'entry' ? this.selection.reactionRange : undefined;
    if (!this.reactionOverlay || !range) {
      this.clearReactionOverlay();
      return;
    }
    const firstIndex = this.indexByStart.get(range.extremeBar.startMs);
    const lastIndex = this.indexByStart.get(range.reactionBar.startMs);
    this.reactionOverlay.dataset.present = 'true';
    this.reactionOverlay.dataset.direction = range.direction;
    this.reactionOverlay.dataset.firstStart = String(range.extremeBar.startMs);
    this.reactionOverlay.dataset.lastStart = String(range.reactionBar.startMs);
    this.reactionOverlay.dataset.extremeStart = String(range.extremeBar.startMs);
    this.reactionOverlay.dataset.reactionStart = String(range.reactionBar.startMs);
    this.reactionOverlay.dataset.firstIndex = String(firstIndex ?? -1);
    this.reactionOverlay.dataset.lastIndex = String(lastIndex ?? -1);
    this.reactionOverlay.dataset.high = String(range.high);
    this.reactionOverlay.dataset.low = String(range.low);
    this.scheduleReactionRangeRender();
  }
  highlight(bars: Bar[], focused?: Bar) {
    this.selection = bars.length ? { kind: 'linked', bars } : undefined;
    if (!bars.length) this.focusedLogicalRange = undefined;
    this.selectedDetail = focused || bars[0];
    this.updateSelectionDiagnostics();
    this.drawEntryPullback();
    this.drawMarkers();
    this.details(this.selectionOrLast());
  }
  highlightEntry(lifecycleOrBars: EntryLifecycle | Bar[], entry: WeeklyEntry, minutes: readonly EdbMinuteRecord[] = []) {
    const lifecycle = Array.isArray(lifecycleOrBars)
      ? (() => {
          const bars = lifecycleOrBars;
          const reactionRange = bars.length ? entryReactionRange(entry.direction, bars) : undefined;
          const quarterSignal = reactionRange ? entryQuarterSignal(reactionRange, bars, MARKET_PRICE_TICK) : undefined;
          const stopLossSignal = reactionRange ? entryStopLossSignal(reactionRange, MARKET_PRICE_TICK) : undefined;
          const takeProfitSignal = reactionRange && quarterSignal
            ? entryTakeProfitSignal(reactionRange, bars, quarterSignal, MARKET_PRICE_TICK)
            : undefined;
          const exitAnalysis = reactionRange && quarterSignal && stopLossSignal && takeProfitSignal
            ? analyzeEntryExit(reactionRange, bars, minutes, quarterSignal, stopLossSignal, takeProfitSignal)
            : undefined;
          return {
            analysisBars: bars,
            focusBars: bars.slice(0, 16),
            entryCutoff: Number.POSITIVE_INFINITY,
            sessionEnd: Number.POSITIVE_INFINITY,
            forcedExitBar: undefined,
            reactionRange,
            quarterSignal,
            stopLossSignal,
            takeProfitSignal,
            exitAnalysis,
            endReason: exitAnalysis?.exitSignal?.type ?? 'data-end',
          } satisfies EntryLifecycle;
        })()
      : lifecycleOrBars;
    const bars = lifecycle.analysisBars;
    this.selection = bars.length ? {
      kind: 'entry', bars, focusBars: lifecycle.focusBars, triggerStart: entry.triggerBar.startMs,
      direction: entry.direction, pullbackLine: entry.pullbackLine,
      entryCutoff: lifecycle.entryCutoff,
      sessionEnd: lifecycle.sessionEnd,
      forcedExitBar: lifecycle.forcedExitBar,
      endReason: lifecycle.endReason,
      reactionRange: lifecycle.reactionRange,
      quarterSignal: lifecycle.quarterSignal,
      stopLossSignal: lifecycle.stopLossSignal,
      takeProfitSignal: lifecycle.takeProfitSignal,
      exitAnalysis: lifecycle.exitAnalysis,
    } : undefined;
    if (!bars.length) this.focusedLogicalRange = undefined;
    this.selectedDetail = bars[0];
    this.updateSelectionDiagnostics();
    this.drawEntryPullback();
    this.drawMarkers();
    this.details(this.selectionOrLast());
  }
  private updateSelectionDiagnostics() {
    const selection = this.selection;
    this.element.dataset.selectedCount = String(selection?.bars.length || 0);
    this.element.dataset.selectionKind = selection?.kind || 'none';
    if (selection?.kind === 'entry') {
      this.element.dataset.selectionDirection = selection.direction;
      this.element.dataset.selectionTriggerStart = String(selection.triggerStart);
      this.element.dataset.selectionPullbackLine = String(selection.pullbackLine);
      this.element.dataset.selectionFirstIndex = String(this.indexByStart.get(selection.bars[0].startMs) ?? -1);
      this.element.dataset.selectionLastIndex = String(this.indexByStart.get(selection.bars.at(-1)!.startMs) ?? -1);
      this.element.dataset.lifecycleEndReason = selection.endReason;
      this.element.dataset.lifecycleEntryCutoff = String(selection.entryCutoff);
      this.element.dataset.lifecycleSessionEnd = String(selection.sessionEnd);
      this.element.dataset.lifecycleForcedExitStart = selection.forcedExitBar
        ? String(selection.forcedExitBar.startMs)
        : '';
      this.element.dataset.lifecycleFocusCount = String(selection.focusBars.length);
      this.element.dataset.lifecycleFocusFirstIndex = String(selection.focusBars.length
        ? this.indexByStart.get(selection.focusBars[0].startMs) ?? -1
        : -1);
      this.element.dataset.lifecycleFocusLastIndex = String(selection.focusBars.length
        ? this.indexByStart.get(selection.focusBars.at(-1)!.startMs) ?? -1
        : -1);
      this.element.dataset.reactionRangePresent = String(!!selection.reactionRange);
      this.element.dataset.quarterSignalPresent = String(!!selection.quarterSignal);
      this.element.dataset.stopLossSignalPresent = String(!!selection.stopLossSignal);
      this.element.dataset.takeProfitSignalPresent = String(!!selection.takeProfitSignal);
      this.element.dataset.exitAnalysisPresent = String(!!selection.exitAnalysis);
      this.element.dataset.riskTouchSignalPresent = String(!!selection.exitAnalysis?.riskTouchSignal);
      this.element.dataset.exitSignalPresent = String(!!selection.exitAnalysis?.exitSignal);
      if (selection.reactionRange) {
        this.element.dataset.reactionRangeDirection = selection.reactionRange.direction;
        this.element.dataset.reactionRangeFirstStart = String(selection.reactionRange.extremeBar.startMs);
        this.element.dataset.reactionRangeLastStart = String(selection.reactionRange.reactionBar.startMs);
        this.element.dataset.reactionRangeExtremeStart = String(selection.reactionRange.extremeBar.startMs);
        this.element.dataset.reactionRangeReactionStart = String(selection.reactionRange.reactionBar.startMs);
        this.element.dataset.reactionRangeFirstIndex = String(this.indexByStart.get(selection.reactionRange.extremeBar.startMs) ?? -1);
        this.element.dataset.reactionRangeLastIndex = String(this.indexByStart.get(selection.reactionRange.reactionBar.startMs) ?? -1);
        this.element.dataset.reactionRangeHigh = String(selection.reactionRange.high);
        this.element.dataset.reactionRangeLow = String(selection.reactionRange.low);
      } else {
        for (const key of ['reactionRangeDirection', 'reactionRangeFirstStart', 'reactionRangeLastStart', 'reactionRangeExtremeStart',
          'reactionRangeReactionStart', 'reactionRangeFirstIndex', 'reactionRangeLastIndex', 'reactionRangeHigh', 'reactionRangeLow']) {
          delete this.element.dataset[key];
        }
      }
      if (selection.quarterSignal) {
        const signal = selection.quarterSignal;
        this.element.dataset.quarterSignalDirection = signal.direction;
        this.element.dataset.quarterSignalPrice = String(signal.price);
        this.element.dataset.quarterSignalTick = String(signal.tick);
        this.element.dataset.quarterSignalRangeTicks = String(signal.rangeTicks);
        this.element.dataset.quarterSignalQuarterTicks = String(signal.quarterTicks);
        this.element.dataset.quarterSignalLineStart = String(signal.lineStartBar.startMs);
        this.element.dataset.quarterSignalReactionStart = String(signal.reactionBar.startMs);
        this.element.dataset.quarterSignalSearchStart = signal.searchStartBar ? String(signal.searchStartBar.startMs) : '';
        this.element.dataset.quarterSignalEntryStart = signal.entryBar ? String(signal.entryBar.startMs) : '';
        this.element.dataset.quarterSignalLineStartIndex = String(this.indexByStart.get(signal.lineStartBar.startMs) ?? -1);
        this.element.dataset.quarterSignalReactionIndex = String(this.indexByStart.get(signal.reactionBar.startMs) ?? -1);
        this.element.dataset.quarterSignalSearchStartIndex = String(signal.searchStartBar
          ? this.indexByStart.get(signal.searchStartBar.startMs) ?? -1
          : -1);
        this.element.dataset.quarterSignalEntryIndex = String(signal.entryBar
          ? this.indexByStart.get(signal.entryBar.startMs) ?? -1
          : -1);
      } else {
        for (const key of ['quarterSignalDirection', 'quarterSignalPrice', 'quarterSignalTick', 'quarterSignalRangeTicks',
          'quarterSignalQuarterTicks', 'quarterSignalLineStart', 'quarterSignalReactionStart', 'quarterSignalSearchStart',
          'quarterSignalEntryStart', 'quarterSignalLineStartIndex', 'quarterSignalReactionIndex',
          'quarterSignalSearchStartIndex', 'quarterSignalEntryIndex']) {
          delete this.element.dataset[key];
        }
      }
      if (selection.stopLossSignal) {
        const signal = selection.stopLossSignal;
        this.element.dataset.stopLossSignalDirection = signal.direction;
        this.element.dataset.stopLossSignalPrice = String(signal.price);
        this.element.dataset.stopLossSignalTick = String(signal.tick);
        this.element.dataset.stopLossSignalRangeTicks = String(signal.rangeTicks);
        this.element.dataset.stopLossSignalStopTicks = String(signal.stopTicks);
        this.element.dataset.stopLossSignalLineStart = String(signal.lineStartBar.startMs);
        this.element.dataset.stopLossSignalLineStartIndex = String(this.indexByStart.get(signal.lineStartBar.startMs) ?? -1);
      } else {
        for (const key of ['stopLossSignalDirection', 'stopLossSignalPrice', 'stopLossSignalTick', 'stopLossSignalRangeTicks',
          'stopLossSignalStopTicks', 'stopLossSignalLineStart', 'stopLossSignalLineStartIndex']) {
          delete this.element.dataset[key];
        }
      }
      if (selection.takeProfitSignal) {
        const signal = selection.takeProfitSignal;
        this.element.dataset.takeProfitSignalDirection = signal.direction;
        this.element.dataset.takeProfitSignalTick = String(signal.tick);
        this.element.dataset.takeProfitSignalRangeTicks = String(signal.rangeTicks);
        this.element.dataset.takeProfitSignalTargetTicks = String(signal.targetTicks);
        this.element.dataset.takeProfitSignalDefaultPrice = String(signal.defaultPrice);
        this.element.dataset.takeProfitSignalAdjustedPrice = String(signal.adjustedPrice);
        this.element.dataset.takeProfitSignalLineStart = String(signal.lineStartBar.startMs);
        this.element.dataset.takeProfitSignalEntryStart = signal.entryBar ? String(signal.entryBar.startMs) : '';
        this.element.dataset.takeProfitSignalRiskTouchStart = signal.riskTouchBar ? String(signal.riskTouchBar.startMs) : '';
        this.element.dataset.takeProfitSignalLineStartIndex = String(this.indexByStart.get(signal.lineStartBar.startMs) ?? -1);
        this.element.dataset.takeProfitSignalEntryIndex = String(signal.entryBar
          ? this.indexByStart.get(signal.entryBar.startMs) ?? -1
          : -1);
        this.element.dataset.takeProfitSignalRiskTouchIndex = String(signal.riskTouchBar
          ? this.indexByStart.get(signal.riskTouchBar.startMs) ?? -1
          : -1);
      } else {
        for (const key of ['takeProfitSignalDirection', 'takeProfitSignalTick', 'takeProfitSignalRangeTicks',
          'takeProfitSignalTargetTicks', 'takeProfitSignalDefaultPrice', 'takeProfitSignalAdjustedPrice',
          'takeProfitSignalLineStart', 'takeProfitSignalEntryStart', 'takeProfitSignalRiskTouchStart',
          'takeProfitSignalLineStartIndex', 'takeProfitSignalEntryIndex', 'takeProfitSignalRiskTouchIndex']) {
          delete this.element.dataset[key];
        }
      }
      if (selection.exitAnalysis?.riskTouchSignal) {
        const signal = selection.exitAnalysis.riskTouchSignal;
        this.element.dataset.riskTouchSignalStart = String(signal.bar.startMs);
        this.element.dataset.riskTouchSignalIndex = String(this.indexByStart.get(signal.bar.startMs) ?? -1);
        this.element.dataset.riskTouchSignalGranularity = signal.granularity;
        this.element.dataset.riskTouchSignalMinuteStart = signal.minute ? String(signal.minute.startMs) : '';
      } else {
        for (const key of ['riskTouchSignalStart', 'riskTouchSignalIndex', 'riskTouchSignalGranularity',
          'riskTouchSignalMinuteStart']) {
          delete this.element.dataset[key];
        }
      }
      if (selection.exitAnalysis?.exitSignal) {
        const signal = selection.exitAnalysis.exitSignal;
        this.element.dataset.exitSignalType = signal.type;
        this.element.dataset.exitSignalPrice = String(signal.price);
        this.element.dataset.exitSignalStart = String(signal.bar.startMs);
        this.element.dataset.exitSignalIndex = String(this.indexByStart.get(signal.bar.startMs) ?? -1);
        this.element.dataset.exitSignalGranularity = signal.granularity;
        this.element.dataset.exitSignalMinuteStart = signal.minute ? String(signal.minute.startMs) : '';
        this.element.dataset.exitSignalLineEnd = String(signal.lineEndMs);
      } else {
        for (const key of ['exitSignalType', 'exitSignalPrice', 'exitSignalStart', 'exitSignalIndex',
          'exitSignalGranularity', 'exitSignalMinuteStart', 'exitSignalLineEnd']) {
          delete this.element.dataset[key];
        }
      }
    } else {
      delete this.element.dataset.selectionDirection;
      delete this.element.dataset.selectionTriggerStart;
      delete this.element.dataset.selectionPullbackLine;
      delete this.element.dataset.selectionFirstIndex;
      delete this.element.dataset.selectionLastIndex;
      delete this.element.dataset.lifecycleEndReason;
      delete this.element.dataset.lifecycleEntryCutoff;
      delete this.element.dataset.lifecycleSessionEnd;
      delete this.element.dataset.lifecycleForcedExitStart;
      delete this.element.dataset.lifecycleFocusCount;
      delete this.element.dataset.lifecycleFocusFirstIndex;
      delete this.element.dataset.lifecycleFocusLastIndex;
      delete this.element.dataset.reactionRangePresent;
      delete this.element.dataset.quarterSignalPresent;
      delete this.element.dataset.stopLossSignalPresent;
      delete this.element.dataset.takeProfitSignalPresent;
      delete this.element.dataset.exitAnalysisPresent;
      delete this.element.dataset.riskTouchSignalPresent;
      delete this.element.dataset.exitSignalPresent;
      for (const key of ['reactionRangeDirection', 'reactionRangeFirstStart', 'reactionRangeLastStart', 'reactionRangeExtremeStart',
        'reactionRangeReactionStart', 'reactionRangeFirstIndex', 'reactionRangeLastIndex', 'reactionRangeHigh', 'reactionRangeLow']) {
        delete this.element.dataset[key];
      }
      for (const key of ['quarterSignalDirection', 'quarterSignalPrice', 'quarterSignalTick', 'quarterSignalRangeTicks',
        'quarterSignalQuarterTicks', 'quarterSignalLineStart', 'quarterSignalReactionStart', 'quarterSignalSearchStart',
        'quarterSignalEntryStart', 'quarterSignalLineStartIndex', 'quarterSignalReactionIndex',
        'quarterSignalSearchStartIndex', 'quarterSignalEntryIndex']) {
        delete this.element.dataset[key];
      }
      for (const key of ['stopLossSignalDirection', 'stopLossSignalPrice', 'stopLossSignalTick', 'stopLossSignalRangeTicks',
        'stopLossSignalStopTicks', 'stopLossSignalLineStart', 'stopLossSignalLineStartIndex']) {
        delete this.element.dataset[key];
      }
      for (const key of ['takeProfitSignalDirection', 'takeProfitSignalTick', 'takeProfitSignalRangeTicks',
        'takeProfitSignalTargetTicks', 'takeProfitSignalDefaultPrice', 'takeProfitSignalAdjustedPrice',
        'takeProfitSignalLineStart', 'takeProfitSignalEntryStart', 'takeProfitSignalRiskTouchStart',
        'takeProfitSignalLineStartIndex', 'takeProfitSignalEntryIndex', 'takeProfitSignalRiskTouchIndex']) {
        delete this.element.dataset[key];
      }
      for (const key of ['riskTouchSignalStart', 'riskTouchSignalIndex', 'riskTouchSignalGranularity',
        'riskTouchSignalMinuteStart', 'exitSignalType', 'exitSignalPrice', 'exitSignalStart', 'exitSignalIndex',
        'exitSignalGranularity', 'exitSignalMinuteStart', 'exitSignalLineEnd']) {
        delete this.element.dataset[key];
      }
    }
    this.updateReactionRangeDiagnostics();
  }
  private drawEntryQuarter() {
    if (!this.entryQuarter) return;
    const selection = this.selection;
    const signal = selection?.kind === 'entry' ? selection.quarterSignal : undefined;
    const lineStartIndex = selection?.kind === 'entry' && signal
      ? selection.bars.findIndex(bar => bar.startMs === signal.lineStartBar.startMs)
      : -1;
    const lineBars = selection?.kind === 'entry' && lineStartIndex >= 0
      ? selection.bars.slice(lineStartIndex)
      : [];
    if (!signal || !lineBars.length) {
      this.entryQuarter.setData([]);
      this.element.dataset.quarterLineVisible = 'false';
      for (const key of ['quarterLinePrice', 'quarterLineTick', 'quarterLineQuarterTicks', 'quarterLinePointCount',
        'quarterLineFirstStart', 'quarterLineLastStart', 'quarterLineFirstIndex', 'quarterLineLastIndex']) {
        delete this.element.dataset[key];
      }
      return;
    }

    this.entryQuarter.setData(lineBars.map(bar => ({ time: timeKey(bar), value: signal.price })));
    this.element.dataset.quarterLineVisible = 'true';
    this.element.dataset.quarterLinePrice = String(signal.price);
    this.element.dataset.quarterLineTick = String(signal.tick);
    this.element.dataset.quarterLineQuarterTicks = String(signal.quarterTicks);
    this.element.dataset.quarterLinePointCount = String(lineBars.length);
    this.element.dataset.quarterLineFirstStart = String(lineBars[0].startMs);
    this.element.dataset.quarterLineLastStart = String(lineBars.at(-1)!.startMs);
    this.element.dataset.quarterLineFirstIndex = String(this.indexByStart.get(lineBars[0].startMs) ?? -1);
    this.element.dataset.quarterLineLastIndex = String(this.indexByStart.get(lineBars.at(-1)!.startMs) ?? -1);
  }
  private drawEntryStopLoss() {
    if (!this.entryStopLoss) return;
    const selection = this.selection;
    const signal = selection?.kind === 'entry' ? selection.stopLossSignal : undefined;
    const lineStartIndex = selection?.kind === 'entry' && signal
      ? selection.bars.findIndex(bar => bar.startMs === signal.lineStartBar.startMs)
      : -1;
    const lineEndMs = selection?.kind === 'entry' ? selection.exitAnalysis?.exitSignal?.lineEndMs : undefined;
    const lineBars = selection?.kind === 'entry' && lineStartIndex >= 0
      ? selection.bars.slice(lineStartIndex).filter(bar => lineEndMs === undefined || bar.endMs <= lineEndMs)
      : [];
    if (!signal || !lineBars.length) {
      this.entryStopLoss.setData([]);
      this.element.dataset.stopLossLineVisible = 'false';
      for (const key of ['stopLossLinePrice', 'stopLossLineTick', 'stopLossLineStopTicks', 'stopLossLinePointCount',
        'stopLossLineFirstStart', 'stopLossLineLastStart', 'stopLossLineFirstIndex', 'stopLossLineLastIndex']) {
        delete this.element.dataset[key];
      }
      return;
    }

    this.entryStopLoss.setData(lineBars.map(bar => ({ time: timeKey(bar), value: signal.price })));
    this.element.dataset.stopLossLineVisible = 'true';
    this.element.dataset.stopLossLinePrice = String(signal.price);
    this.element.dataset.stopLossLineTick = String(signal.tick);
    this.element.dataset.stopLossLineStopTicks = String(signal.stopTicks);
    this.element.dataset.stopLossLinePointCount = String(lineBars.length);
    this.element.dataset.stopLossLineFirstStart = String(lineBars[0].startMs);
    this.element.dataset.stopLossLineLastStart = String(lineBars.at(-1)!.startMs);
    this.element.dataset.stopLossLineFirstIndex = String(this.indexByStart.get(lineBars[0].startMs) ?? -1);
    this.element.dataset.stopLossLineLastIndex = String(this.indexByStart.get(lineBars.at(-1)!.startMs) ?? -1);
  }
  private drawEntryTakeProfit() {
    if (!this.entryTakeProfit) return;
    const selection = this.selection;
    const signal = selection?.kind === 'entry' ? selection.takeProfitSignal : undefined;
    const lineStartIndex = selection?.kind === 'entry' && signal
      ? selection.bars.findIndex(bar => bar.startMs === signal.lineStartBar.startMs)
      : -1;
    const lineEndMs = selection?.kind === 'entry' ? selection.exitAnalysis?.exitSignal?.lineEndMs : undefined;
    const lineBars = selection?.kind === 'entry' && lineStartIndex >= 0
      ? selection.bars.slice(lineStartIndex).filter(bar => lineEndMs === undefined || bar.endMs <= lineEndMs)
      : [];
    if (!signal || !lineBars.length) {
      this.entryTakeProfit.setData([]);
      this.element.dataset.takeProfitLineVisible = 'false';
      for (const key of ['takeProfitLineDefaultPrice', 'takeProfitLineAdjustedPrice', 'takeProfitLineTick',
        'takeProfitLineRangeTicks', 'takeProfitLineTargetTicks', 'takeProfitLinePointCount', 'takeProfitLineFirstStart',
        'takeProfitLineLastStart', 'takeProfitLineFirstIndex', 'takeProfitLineLastIndex', 'takeProfitLineValues',
        'takeProfitLineSwitchStart', 'takeProfitLineSwitchIndex']) {
        delete this.element.dataset[key];
      }
      return;
    }

    const riskTouchBar = selection?.kind === 'entry' ? selection.exitAnalysis?.riskTouchSignal?.bar : undefined;
    const values = lineBars.map(bar => riskTouchBar && bar.startMs >= riskTouchBar.startMs
      ? signal.adjustedPrice
      : signal.defaultPrice);
    this.entryTakeProfit.setData(lineBars.map((bar, index) => ({ time: timeKey(bar), value: values[index] })));
    this.element.dataset.takeProfitLineVisible = 'true';
    this.element.dataset.takeProfitLineDefaultPrice = String(signal.defaultPrice);
    this.element.dataset.takeProfitLineAdjustedPrice = String(signal.adjustedPrice);
    this.element.dataset.takeProfitLineTick = String(signal.tick);
    this.element.dataset.takeProfitLineRangeTicks = String(signal.rangeTicks);
    this.element.dataset.takeProfitLineTargetTicks = String(signal.targetTicks);
    this.element.dataset.takeProfitLinePointCount = String(lineBars.length);
    this.element.dataset.takeProfitLineFirstStart = String(lineBars[0].startMs);
    this.element.dataset.takeProfitLineLastStart = String(lineBars.at(-1)!.startMs);
    this.element.dataset.takeProfitLineFirstIndex = String(this.indexByStart.get(lineBars[0].startMs) ?? -1);
    this.element.dataset.takeProfitLineLastIndex = String(this.indexByStart.get(lineBars.at(-1)!.startMs) ?? -1);
    this.element.dataset.takeProfitLineValues = JSON.stringify(values);
    if (riskTouchBar) {
      this.element.dataset.takeProfitLineSwitchStart = String(riskTouchBar.startMs);
      this.element.dataset.takeProfitLineSwitchIndex = String(this.indexByStart.get(riskTouchBar.startMs) ?? -1);
    } else {
      delete this.element.dataset.takeProfitLineSwitchStart;
      delete this.element.dataset.takeProfitLineSwitchIndex;
    }
  }
  private drawEntryPullback() {
    if (!this.entryPullback) return;
    const selection = this.selection;
    if (selection?.kind !== 'entry') {
      this.entryPullback.setData([]);
      this.element.dataset.pullbackLineVisible = 'false';
      delete this.element.dataset.pullbackLineValue;
      delete this.element.dataset.pullbackLinePointCount;
      delete this.element.dataset.pullbackLineValues;
      delete this.element.dataset.pullbackLineFirstValue;
      delete this.element.dataset.pullbackLineLastValue;
      this.drawEntryQuarter();
      this.drawEntryStopLoss();
      this.drawEntryTakeProfit();
      this.scheduleReactionRangeRender();
      return;
    }
    const points = entryObservationLine(selection, selection.bars, this.emaByStart);
    const values = points.map(point => point.value);
    this.entryPullback.applyOptions({ color: selection.direction === 'long' ? '#47d990' : '#ff8066' });
    this.entryPullback.setData(points.map(point => ({ time: timeKey(point.bar), value: point.value })));
    this.element.dataset.pullbackLineVisible = String(points.length > 0);
    this.element.dataset.pullbackLinePointCount = String(points.length);
    this.element.dataset.pullbackLineValues = JSON.stringify(values);
    if (values.length) {
      this.element.dataset.pullbackLineValue = String(values.at(-1));
      this.element.dataset.pullbackLineFirstValue = String(values[0]);
      this.element.dataset.pullbackLineLastValue = String(values.at(-1));
    } else {
      delete this.element.dataset.pullbackLineValue;
      delete this.element.dataset.pullbackLineFirstValue;
      delete this.element.dataset.pullbackLineLastValue;
    }
    this.drawEntryQuarter();
    this.drawEntryStopLoss();
    this.drawEntryTakeProfit();
    this.scheduleReactionRangeRender();
  }
  showReactionTestScenario(scenario: ReactionTestScenario, direction: WeeklyEntry['direction'], startMs: number) {
    if (!window.market.testMode || this.period !== 5) return;
    const firstIndex = this.indexByStart.get(startMs);
    if (firstIndex === undefined) return;
    const source = this.bars.slice(firstIndex, firstIndex + 16);
    if (!source.length) return;
    const directional = (bar: Bar, target: 'reaction' | 'opposite' | 'doji'): Bar => {
      const midpoint = (bar.high + bar.low) / 2;
      const rising = target === 'reaction' ? direction === 'long' : direction === 'short';
      return {
        ...bar,
        open: target === 'doji' ? midpoint : rising ? bar.low : bar.high,
        close: target === 'doji' ? midpoint : rising ? bar.high : bar.low,
      };
    };
    const controlledQuarterScenario = scenario.startsWith('quarter-')
      || scenario.startsWith('take-profit-')
      || scenario.startsWith('exit-');
    const rangeTicks = scenario === 'quarter-divisible' ? 12 : 11;
    const base = Math.round(source[0].close / 20) * 20 + (scenario === 'quarter-autoscale' ? 10_000 : 0);
    const quarterPrice = direction === 'long'
      ? base + Math.ceil(rangeTicks / 4)
      : base + rangeTicks - Math.ceil(rangeTicks / 4);
    const takeProfitControlled = (bar: Bar, index: number): Bar | undefined => {
      if (!scenario.startsWith('take-profit-')) return undefined;
      const sameBarRiskTouch = scenario === 'take-profit-entry-touch' && index === 2;
      const preEntryRiskTouch = scenario === 'take-profit-later-touch' && index === 2;
      const entryOffset = scenario === 'take-profit-later-touch' ? 3 : 2;
      const laterRiskTouch = scenario === 'take-profit-later-touch'
        ? index === 5
        : scenario === 'take-profit-repeated-touch'
          ? index === 4 || index === 6
          : false;
      if (direction === 'long') {
        if (preEntryRiskTouch) {
          return { ...bar, open: base + 1, high: quarterPrice - 1, low: base, close: base + 1 };
        }
        if (index === entryOffset) {
          return {
            ...bar,
            open: base + 6,
            high: base + 8,
            low: sameBarRiskTouch ? base : quarterPrice,
            close: base + 7,
          };
        }
        return {
          ...bar,
          open: base + 6,
          high: base + 8,
          low: laterRiskTouch ? base : base + 5,
          close: base + 7,
        };
      }
      if (preEntryRiskTouch) {
        return { ...bar, open: base + rangeTicks - 1, high: base + rangeTicks, low: quarterPrice + 1, close: base + rangeTicks - 1 };
      }
      if (index === entryOffset) {
        return {
          ...bar,
          open: base + rangeTicks - 6,
          high: sameBarRiskTouch ? base + rangeTicks : quarterPrice,
          low: base + rangeTicks - 8,
          close: base + rangeTicks - 7,
        };
      }
      return {
        ...bar,
        open: base + rangeTicks - 6,
        high: laterRiskTouch ? base + rangeTicks : base + rangeTicks - 5,
        low: base + rangeTicks - 8,
        close: base + rangeTicks - 7,
      };
    };
    const exitControlled = (bar: Bar, index: number): Bar | undefined => {
      if (!scenario.startsWith('exit-') || index < 2) return undefined;
      const takeProfitExit = scenario === 'exit-take-profit' && index === 4;
      const laterStopTouch = scenario === 'exit-take-profit' && index === 6;
      const priorRiskTouch = scenario === 'exit-stop-loss' && index === 3;
      const stopExit = (scenario === 'exit-stop-loss' || scenario === 'exit-stop-risk-same-bar') && index === 4;
      if (direction === 'long') {
        if (index === 2) return { ...bar, open: base + 6, high: base + 8, low: quarterPrice, close: base + 7 };
        if (takeProfitExit) return { ...bar, open: base + 7, high: base + rangeTicks * 3, low: base + 5, close: base + 8 };
        if (priorRiskTouch) return { ...bar, open: base + 6, high: base + 8, low: base, close: base + 7 };
        if (stopExit || laterStopTouch) return { ...bar, open: base + 6, high: base + 8, low: base - Math.ceil(rangeTicks * 0.75), close: base + 5 };
        return { ...bar, open: base + 6, high: base + 8, low: base + 5, close: base + 7 };
      }
      if (index === 2) {
        return {
          ...bar,
          open: base + rangeTicks - 6,
          high: quarterPrice,
          low: base + rangeTicks - 8,
          close: base + rangeTicks - 7,
        };
      }
      if (takeProfitExit) {
        return {
          ...bar,
          open: base + rangeTicks - 7,
          high: base + rangeTicks - 5,
          low: base - rangeTicks * 2,
          close: base + rangeTicks - 8,
        };
      }
      if (priorRiskTouch) {
        return {
          ...bar,
          open: base + rangeTicks - 6,
          high: base + rangeTicks,
          low: base + rangeTicks - 8,
          close: base + rangeTicks - 7,
        };
      }
      if (stopExit || laterStopTouch) {
        return {
          ...bar,
          open: base + rangeTicks - 6,
          high: base + rangeTicks + Math.ceil(rangeTicks * 0.75),
          low: base + rangeTicks - 8,
          close: base + rangeTicks - 5,
        };
      }
      return {
        ...bar,
        open: base + rangeTicks - 6,
        high: base + rangeTicks - 5,
        low: base + rangeTicks - 8,
        close: base + rangeTicks - 7,
      };
    };
    const controlled = (bar: Bar, index: number): Bar => {
      if (direction === 'long') {
        if (index === 0) return { ...bar, open: base + 3, high: base + 4, low: base, close: base + 1 };
        if (index === 1) return { ...bar, open: base + 2, high: base + rangeTicks, low: base + 1, close: base + rangeTicks - 1 };
        const exitBar = exitControlled(bar, index);
        if (exitBar) return exitBar;
        const takeProfitBar = takeProfitControlled(bar, index);
        if (takeProfitBar) return takeProfitBar;
        const touch = scenario === 'quarter-wick-touch'
          ? index === 2
          : scenario === 'quarter-repeated-touch'
            ? index === 2 || index === 4
            : scenario === 'quarter-no-touch'
              ? false
              : index === 3;
        return {
          ...bar,
          open: base + 6,
          high: base + 8,
          low: touch ? quarterPrice : base + 5,
          close: base + 7,
        };
      }
      if (index === 0) return { ...bar, open: base + rangeTicks - 3, high: base + rangeTicks, low: base + rangeTicks - 4, close: base + rangeTicks - 1 };
      if (index === 1) return { ...bar, open: base + rangeTicks - 2, high: base + rangeTicks - 1, low: base, close: base + 1 };
      const exitBar = exitControlled(bar, index);
      if (exitBar) return exitBar;
      const takeProfitBar = takeProfitControlled(bar, index);
      if (takeProfitBar) return takeProfitBar;
      const touch = scenario === 'quarter-wick-touch'
        ? index === 2
        : scenario === 'quarter-repeated-touch'
          ? index === 2 || index === 4
          : scenario === 'quarter-no-touch'
            ? false
            : index === 3;
      return {
        ...bar,
        open: base + rangeTicks - 6,
        high: touch ? quarterPrice : base + rangeTicks - 5,
        low: base + rangeTicks - 8,
        close: base + rangeTicks - 7,
      };
    };
    const bars = source.map((bar, index) => {
      if (controlledQuarterScenario) return controlled(bar, index);
      if (scenario === 'immediate') return directional(bar, index === 0 ? 'reaction' : 'opposite');
      if (scenario === 'doji-then-reaction') {
        return directional(bar, index === 0 ? 'doji' : index === 1 ? 'opposite' : index === 2 ? 'reaction' : 'opposite');
      }
      return directional(bar, index % 2 ? 'opposite' : 'doji');
    });
    const triggerBar = bars[0];
    this.focusBars(source, 20);
    this.highlightEntry(bars, {
      bar: triggerBar,
      triggerBar,
      direction,
      boundaryHigh: triggerBar.high,
      boundaryLow: triggerBar.low,
      midpoint: (triggerBar.high + triggerBar.low) / 2,
      ema20: this.emaByStart.get(triggerBar.startMs) ?? triggerBar.close,
      pullbackLine: triggerBar.close,
      weekStart: formatBeijing(triggerBar.startMs).slice(0, 10),
    });
  }
  drawMarkers() {
    const markers: SeriesMarker<Time>[] = [];
    const rolloverMarkers = this.rollovers.flatMap(rollover => {
      const bar = locateRolloverBar(rollover, this.bars, this.period);
      if (!bar) return [];
      const label = `主力换月：${rollover.fromContract} -> ${rollover.toContract}`;
      return [{
        marker: {
          time: timeKey(bar),
          position: 'aboveBar' as const,
          color: '#ffdf55',
          shape: 'arrowDown' as const,
          text: label,
          size: 3,
          id: `rollover-${rollover.tradingDate}-${rollover.fromContract}-${rollover.toContract}`,
        },
        label,
        start: shortTime(bar.startMs),
      }];
    });
    markers.push(...rolloverMarkers.map(item => item.marker));
    const selection = this.selection;
    if (selection?.kind === 'linked') {
      markers.push(...selection.bars.map((bar) => ({ time: timeKey(bar), position: 'belowBar' as const, color: '#e2b36a', shape: 'square' as const, size: 0.6, id: `selected-${bar.startMs}` })));
    } else if (selection?.kind === 'entry') {
      const long = selection.direction === 'long';
      const trigger = selection.bars[0];
      markers.push({
        time: timeKey(trigger), position: long ? 'belowBar' : 'aboveBar',
        color: long ? '#47d990' : '#ff8066', shape: long ? 'arrowUp' : 'arrowDown',
        text: long ? '多' : '空', size: 1.2, id: `observation-trigger-${selection.direction}-${trigger.startMs}`,
      });
      markers.push(...selection.bars.slice(1).map(bar => ({
        time: timeKey(bar), position: long ? 'belowBar' as const : 'aboveBar' as const,
        color: long ? '#74e2a688' : '#ff9d8288', shape: 'square' as const, size: 0.45,
        id: `observation-follow-${selection.direction}-${selection.triggerStart}-${bar.startMs}`,
      })));
      const trueEntry = selection.quarterSignal?.entryBar;
      const riskTouch = selection.exitAnalysis?.riskTouchSignal?.bar;
      const exit = selection.exitAnalysis?.exitSignal;
      const showRiskTouch = !!riskTouch
        && !(exit?.type === 'stop-loss' && exit.bar.startMs === riskTouch.startMs);
      const sameEntryRiskTouch = showRiskTouch && !!trueEntry && trueEntry.startMs === riskTouch.startMs;
      if (showRiskTouch) {
        markers.push({
          time: timeKey(riskTouch), position: long ? 'belowBar' : 'aboveBar',
          color: '#4fc3f7', shape: 'square',
          text: `${long ? '触底' : '触顶'}${sameEntryRiskTouch ? '·入场' : ''}`, size: 0.3,
          id: `take-profit-risk-touch-${selection.direction}-${selection.triggerStart}-${riskTouch.startMs}`,
        });
      }
      if (trueEntry) {
        markers.push({
          time: timeKey(trueEntry), position: long ? 'belowBar' : 'aboveBar',
          color: '#ffffff', shape: long ? 'arrowUp' : 'arrowDown',
          text: sameEntryRiskTouch ? undefined : '入场', size: 1.1,
          id: `true-entry-${selection.direction}-${selection.triggerStart}-${trueEntry.startMs}`,
        });
      }
      if (exit) {
        const takeProfit = exit.type === 'take-profit';
        const sessionClose = exit.type === 'session-close';
        const above = sessionClose ? long : long ? takeProfit : !takeProfit;
        const text = takeProfit ? '止盈出场' : sessionClose ? '休市出场' : '止损出场';
        markers.push({
          time: timeKey(exit.bar),
          position: above ? 'aboveBar' : 'belowBar',
          color: takeProfit ? '#4fc3f7' : sessionClose ? '#dc94ff' : '#f4c95d',
          shape: long ? 'arrowDown' : 'arrowUp',
          text,
          size: 1.15,
          id: `actual-exit-${exit.type}-${selection.direction}-${selection.triggerStart}-${exit.bar.startMs}`,
        });
      }
    }
    if (this.period === 60 && mondayVisible) {
      for (const bar of this.bars) {
        if (this.mondayHighlights.has(bar.startMs)) markers.push({ time: timeKey(bar), position: 'belowBar', color: '#f0b35c', shape: 'circle', size: 0.8, id: `monday-${bar.startMs}` });
      }
      for (const signal of this.weeklyBreakouts) {
        const up = signal.direction === 'up';
        markers.push({ time: timeKey(signal.bar), position: up ? 'aboveBar' : 'belowBar',
          color: up ? '#62c6ff' : '#dc94ff', shape: up ? 'arrowUp' : 'arrowDown', size: 1,
          id: `breakout-${signal.direction}-${signal.bar.startMs}` });
      }
      for (const entry of this.weeklyEntries) {
        const long = entry.direction === 'long';
        markers.push({ time: timeKey(entry.bar), position: long ? 'belowBar' : 'aboveBar',
          color: long ? '#74e2a6' : '#ff9d82', shape: long ? 'arrowUp' : 'arrowDown', text: long ? '多' : '空', size: 1,
          id: weeklyEntryMarkerId(entry) });
      }
    }
    for (const anomaly of this.anomalies) {
      const bar = this.bars.find(candidate => candidate.startMs <= anomaly.timeMs && anomaly.timeMs < candidate.endMs);
      if (bar) markers.push({ time: timeKey(bar), position: 'aboveBar', color: '#f0bd72', shape: 'arrowDown', text: '待核实', size: 1, id: `anomaly-${anomaly.timeMs}` });
    }
    this.markers.setMarkers(markers.sort((a, b) => Number(a.time) - Number(b.time)));
    this.element.dataset.breakoutUpCount = String(markers.filter(marker => marker.id?.startsWith('breakout-up-')).length);
    this.element.dataset.breakoutDownCount = String(markers.filter(marker => marker.id?.startsWith('breakout-down-')).length);
    this.element.dataset.entryLongCount = String(markers.filter(marker => marker.id?.startsWith('entry-long-')).length);
    this.element.dataset.entryShortCount = String(markers.filter(marker => marker.id?.startsWith('entry-short-')).length);
    this.element.dataset.entryMarkerIds = JSON.stringify(markers
      .filter(marker => marker.id?.startsWith('entry-'))
      .map(marker => marker.id));
    this.element.dataset.rolloverCount = String(rolloverMarkers.length);
    this.element.dataset.rolloverLabels = JSON.stringify(rolloverMarkers.map(item => item.label));
    this.element.dataset.rolloverStarts = JSON.stringify(rolloverMarkers.map(item => item.start));
    this.element.dataset.linkedMarkerCount = String(markers.filter(marker => marker.id?.startsWith('selected-')).length);
    this.element.dataset.observationTriggerCount = String(markers.filter(marker => marker.id?.startsWith('observation-trigger-')).length);
    this.element.dataset.observationFollowCount = String(markers.filter(marker => marker.id?.startsWith('observation-follow-')).length);
    const trueEntryMarkers = markers.filter(marker => marker.id?.startsWith('true-entry-'));
    this.element.dataset.trueEntryMarkerCount = String(trueEntryMarkers.length);
    if (trueEntryMarkers.length) {
      this.element.dataset.trueEntryMarkerId = String(trueEntryMarkers[0].id);
      this.element.dataset.trueEntryMarkerStart = String(selection?.kind === 'entry' ? selection.quarterSignal?.entryBar?.startMs : '');
      this.element.dataset.trueEntryMarkerDirection = String(selection?.kind === 'entry' ? selection.direction : '');
      this.element.dataset.trueEntryMarkerPosition = String(trueEntryMarkers[0].position);
    } else {
      delete this.element.dataset.trueEntryMarkerId;
      delete this.element.dataset.trueEntryMarkerStart;
      delete this.element.dataset.trueEntryMarkerDirection;
      delete this.element.dataset.trueEntryMarkerPosition;
    }
    const riskTouchMarkers = markers.filter(marker => marker.id?.startsWith('take-profit-risk-touch-'));
    this.element.dataset.riskTouchMarkerCount = String(riskTouchMarkers.length);
    if (riskTouchMarkers.length) {
      this.element.dataset.riskTouchMarkerId = String(riskTouchMarkers[0].id);
      this.element.dataset.riskTouchMarkerStart = String(selection?.kind === 'entry'
        ? selection.exitAnalysis?.riskTouchSignal?.bar.startMs
        : '');
      this.element.dataset.riskTouchMarkerDirection = String(selection?.kind === 'entry' ? selection.direction : '');
      this.element.dataset.riskTouchMarkerPosition = String(riskTouchMarkers[0].position);
      this.element.dataset.riskTouchMarkerText = String(riskTouchMarkers[0].text);
    } else {
      delete this.element.dataset.riskTouchMarkerId;
      delete this.element.dataset.riskTouchMarkerStart;
      delete this.element.dataset.riskTouchMarkerDirection;
      delete this.element.dataset.riskTouchMarkerPosition;
      delete this.element.dataset.riskTouchMarkerText;
    }
    const exitMarkers = markers.filter(marker => marker.id?.startsWith('actual-exit-'));
    this.element.dataset.exitMarkerCount = String(exitMarkers.length);
    if (exitMarkers.length) {
      const exit = selection?.kind === 'entry' ? selection.exitAnalysis?.exitSignal : undefined;
      this.element.dataset.exitMarkerId = String(exitMarkers[0].id);
      this.element.dataset.exitMarkerText = String(exitMarkers[0].text);
      this.element.dataset.exitMarkerStart = String(exit?.bar.startMs ?? '');
      this.element.dataset.exitMarkerPosition = String(exitMarkers[0].position);
    } else {
      delete this.element.dataset.exitMarkerId;
      delete this.element.dataset.exitMarkerText;
      delete this.element.dataset.exitMarkerStart;
      delete this.element.dataset.exitMarkerPosition;
    }
  }
}

const charts = { 60: new MarketChart(60), 5: new MarketChart(5) };
if (window.market.testMode) {
  window.moneyComingTest = {
    showReactionScenario: (scenario, direction, startMs) => charts[5].showReactionTestScenario(scenario, direction, startMs),
    clearReactionScenario: () => charts[5].highlight([]),
    showEmptyProfitLossReview: () => {
      dataset = undefined;
      renderProfitLossReview();
      if (!reviewDialog.open) reviewDialog.showModal();
    },
  };
}

function clearCrosshairs() {
  crosshairSyncing = true;
  try { charts[60].chart.clearCrosshairPosition(); charts[5].chart.clearCrosshairPosition(); }
  finally { crosshairSyncing = false; }
}

const lifecycleEndLabels: Record<EntryLifecycleEndReason, string> = {
  'take-profit': '止盈出场',
  'stop-loss': '止损出场',
  'session-close': '休市出场',
  'no-entry-session-end': '未入场，已到休市',
  'data-end': '数据暂未覆盖生命周期终点',
};

const rootLifecycleDiagnosticKeys = [
  'entryLifecycleEndReason',
  'entryLifecycleFirstStart',
  'entryLifecycleLastStart',
  'entryLifecycleEntryCutoff',
  'entryLifecycleSessionEnd',
  'entryLifecycleForcedExitStart',
  'entryFocusCount',
  'entryFocusFirstStart',
  'entryFocusLastStart',
] as const;

function clearRootLifecycleDiagnostics(): void {
  for (const key of rootLifecycleDiagnosticKeys) delete document.documentElement.dataset[key];
}

function selectBar(period: Period, bar: Bar, moveBoth = false, hoveredObjectId?: string) {
  if (!dataset) return;
  const sourceSpan = period === 60 ? charts[60].visibleLogicalSpan() ?? 120 : undefined;
  clearToast();
  clearCrosshairs();
  selected = { period, bar };
  const parent = period === 60 ? bar : parentFor(bar, dataset.bars60);
  const children = parent ? childrenFor(parent, dataset.bars5) : [bar];
  const entry = period === 60 ? charts[60].entryFor(bar, hoveredObjectId) : undefined;
  const lifecycle = entry ? entryLifecycle(entry, dataset.bars5, dataset.bars1) : undefined;
  charts[60].highlight(parent ? [parent] : []);
  if (entry && lifecycle?.analysisBars.length) charts[5].highlightEntry(lifecycle, entry);
  else charts[5].highlight(children, period === 5 ? bar : undefined);
  if (parent && (period === 5 || moveBoth)) charts[60].focus(parent);
  const focusBars = entry ? lifecycle?.focusBars ?? [] : children;
  if (focusBars.length && (period === 60 || moveBoth)) {
    if (period === 60) charts[5].focusBars(focusBars, sourceSpan, true);
    else charts[5].focus(bar);
  }
  const expected = parent ? parent.expectedMinutes / 5 : 0;
  const complete = !!parent && children.length === expected && children.every(child => child.complete);
  const observationMissing = !!entry && !lifecycle?.analysisBars.length;
  $('.selection-label').textContent = entry ? '入场观察' : '双周期联动';
  $('#selection-text').textContent = entry
    ? lifecycle?.analysisBars.length
      ? `${entry.direction === 'long' ? '多头' : '空头'}  ·  触发 ${shortTime(entry.triggerBar.startMs)}  ·  回调线 ${number(entry.pullbackLine)}  ·  生命周期 ${lifecycle.analysisBars.length} 根 5 分钟  ·  ${lifecycleEndLabels[lifecycle.endReason]}`
      : `${entry.direction === 'long' ? '多头' : '空头'}  ·  触发记录不在当前5分钟数据中，联动不完整`
    : parent ? `${interval(parent)}  ·  ${children.length} 根 5 分钟  /  ${parent.expectedMinutes} 个交易分钟${complete ? '' : '  ·  联动不完整'}` : '未找到包含该 K 线的 60 分钟区间，联动不完整';
  $('#selection-bar').classList.toggle('incomplete', entry
    ? observationMissing || lifecycle?.endReason === 'data-end'
    : !complete);
  const anomaly = dataset.anomalies.find(a => a.timeMs >= (parent || bar).startMs && a.timeMs < (parent || bar).endMs);
  $('#selected-anomaly').hidden = !anomaly;
  $('#selected-anomaly').onclick = () => showDetails(anomaly);
  document.documentElement.dataset.selectedStart = String(bar.startMs);
  document.documentElement.dataset.selectedEnd = String(bar.endMs);
  document.documentElement.dataset.childCount = String(entry ? lifecycle?.analysisBars.length ?? 0 : children.length);
  document.documentElement.dataset.selectionKind = entry ? 'entry' : 'linked';
  if (entry && lifecycle) {
    document.documentElement.dataset.entryDirection = entry.direction;
    document.documentElement.dataset.entryTriggerStart = String(entry.triggerBar.startMs);
    document.documentElement.dataset.entryPullbackLine = String(entry.pullbackLine);
    document.documentElement.dataset.observationCount = String(lifecycle.analysisBars.length);
    document.documentElement.dataset.entrySelectionSource = hoveredObjectId === weeklyEntryMarkerId(entry) ? 'marker' : 'default';
    document.documentElement.dataset.entryLifecycleEndReason = lifecycle.endReason;
    document.documentElement.dataset.entryLifecycleFirstStart = lifecycle.analysisBars.length
      ? String(lifecycle.analysisBars[0].startMs)
      : '';
    document.documentElement.dataset.entryLifecycleLastStart = lifecycle.analysisBars.length
      ? String(lifecycle.analysisBars.at(-1)!.startMs)
      : '';
    document.documentElement.dataset.entryLifecycleEntryCutoff = String(lifecycle.entryCutoff);
    document.documentElement.dataset.entryLifecycleSessionEnd = String(lifecycle.sessionEnd);
    document.documentElement.dataset.entryLifecycleForcedExitStart = lifecycle.forcedExitBar
      ? String(lifecycle.forcedExitBar.startMs)
      : '';
    document.documentElement.dataset.entryFocusCount = String(lifecycle.focusBars.length);
    document.documentElement.dataset.entryFocusFirstStart = lifecycle.focusBars.length
      ? String(lifecycle.focusBars[0].startMs)
      : '';
    document.documentElement.dataset.entryFocusLastStart = lifecycle.focusBars.length
      ? String(lifecycle.focusBars.at(-1)!.startMs)
      : '';
  } else {
    delete document.documentElement.dataset.entryDirection;
    delete document.documentElement.dataset.entryTriggerStart;
    delete document.documentElement.dataset.entryPullbackLine;
    delete document.documentElement.dataset.observationCount;
    delete document.documentElement.dataset.entrySelectionSource;
    clearRootLifecycleDiagnostics();
  }
}

function setMode(next: typeof mode) {
  mode = next;
  $('#charts').dataset.mode = next;
  charts[60].element.hidden = next === '5'; charts[5].element.hidden = next === '60';
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === next; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  document.documentElement.dataset.mode = mode;
  requestAnimationFrame(() => { charts[60].layoutPanes(); charts[5].layoutPanes(); });
}

function renderDataset(next: Dataset, focusTime?: number) {
  clearCrosshairs();
  dataset = next; selected = undefined;
  $('#instrument-name').textContent = next.name;
  $('#instrument-symbol').textContent = next.symbol;
  $('#subtitle').textContent = '主力连续合约 · 源价格展示，未自行复权';
  $('#quality-status').textContent = !next.auditAvailable ? '异常提示资料未加载' : next.anomalies.length ? `${next.anomalies.length} 处已知待核实记录` : '源价格 · 未自行复权';
  $('#quality-status').classList.toggle('amber', !next.auditAvailable || next.anomalies.length > 0);
  const first = next.bars5[0], last = next.bars5.at(-1)!;
  $('#coverage').textContent = `${formatBeijing(first.startMs).slice(0, 10)} — ${formatBeijing(last.endMs).slice(0, 10)} · 数据源最新至 ${next.sourceLatestAt.slice(0, 16)}`;
  $('#counts').textContent = `5 分钟 ${number(next.bars5.length)} 根    /    60 分钟 ${number(next.bars60.length)} 根`;
  $('#last-close').textContent = number(last.close);
  $('#last-close').className = last.close >= last.open ? 'up' : 'down';
  $('#last-change').textContent = `${signed(last.close - last.open)}  (${signed((last.close - last.open) / last.open * 100)}%)`;
  $('#last-change').className = last.close >= last.open ? 'up' : 'down';
  $('#last-time').textContent = `${shortTime(last.endMs)} · 较末根开盘`;
  charts[60].setData(next.bars60, next.anomalies, next.bars5, next.rollovers); charts[5].setData(next.bars5, next.anomalies, [], next.rollovers);
  if (reviewDialog.open) renderProfitLossReview();
  $('.selection-label').textContent = '双周期联动';
  $('#selection-text').textContent = '点击任意 K 线，查看两个周期的对应区间'; $('#selected-anomaly').hidden = true;
  $('#selection-bar').classList.remove('incomplete');
  delete document.documentElement.dataset.selectedStart; delete document.documentElement.dataset.selectedEnd; delete document.documentElement.dataset.childCount;
  delete document.documentElement.dataset.selectionKind; delete document.documentElement.dataset.entryDirection;
  delete document.documentElement.dataset.entryTriggerStart; delete document.documentElement.dataset.entryPullbackLine;
  delete document.documentElement.dataset.observationCount;
  delete document.documentElement.dataset.entrySelectionSource;
  clearRootLifecycleDiagnostics();
  if (focusTime !== undefined) {
    const index = locateTime(next.bars5, focusTime);
    selectBar(5, next.bars5[index], true);
    if (focusTime < first.startMs || focusTime >= last.endMs) toast(`新标的范围不同，已定位至 ${shortTime(next.bars5[index].startMs)}`);
  }
  ($('#date-input') as HTMLInputElement).value = formatBeijing((selected as { bar: Bar } | undefined)?.bar.startMs || last.startMs).slice(0, 10);
  document.documentElement.dataset.instrument = next.instrument;
  document.documentElement.dataset.ready = 'true';
  renderMarketUpdateState();
}

async function loadInstrument(instrument: Instrument, reload = false) {
  clearToast();
  charts[5].clearHoverRange();
  const currentRequest = ++requestId;
  requestedInstrument = instrument;
  const focusTime = selected?.bar.startMs ?? (dataset ? charts[mode === '60' ? 60 : 5].centerTime() : undefined);
  $('#loading').hidden = false;
  $('#error').hidden = true;
  try {
    const result = await window.market.load(instrument, reload);
    if (currentRequest !== requestId) return;
    if (!result.ok) throw new Error(result.error);
    renderDataset(result.data, focusTime);
    $('#instrument').setAttribute('data-loaded', instrument);
    $('#instrument').querySelector<HTMLOptionElement>(`option[value="${instrument}"]`)!.selected = true;
  } catch (error) {
    if (currentRequest !== requestId) return;
    $('#error-text').textContent = `豆粕主连加载失败：${error instanceof Error ? error.message : String(error)}${dataset ? `。当前仍显示${dataset.name}。` : ''}`;
    $('#error').hidden = false;
    if (dataset) $('#instrument').querySelector<HTMLOptionElement>(`option[value="${dataset.instrument}"]`)!.selected = true;
    else $('#coverage').textContent = '行情未加载 · 请检查 EXE 同级 data 文件夹后重试';
  } finally {
    if (currentRequest === requestId) $('#loading').hidden = true;
  }
}

function showDetails(focused?: Anomaly) {
  const body = $('#dialog-body');
  const anomalies = dataset?.anomalies || [];
  const first = dataset?.bars5[0], last = dataset?.bars5.at(-1);
  const snapshotUpdatedAt = dataset?.snapshotUpdatedAt
    ? formatBeijing(new Date(dataset.snapshotUpdatedAt).getTime()).slice(0, 16)
    : '内置基线';
  body.innerHTML = `<div class="source-card"><span class="source-avatar">E</span><div><strong>信易 EDB · 本地历史快照</strong><p>${escapeHtml(dataset?.name || '豆粕行情')} · CSV 源价格 · 离线读取</p></div><span class="tag">只读</span></div>
    <dl class="source-grid"><div><dt>数据区间（北京时间）</dt><dd>${first && last ? `${shortTime(first.startMs)} → ${shortTime(last.endMs)}` : '尚未加载'}</dd></div><div><dt>数据源截止</dt><dd>${dataset?.sourceLatestAt ? `数据源最新至 ${escapeHtml(dataset.sourceLatestAt.slice(0, 16))}` : '尚未读取'}</dd></div><div><dt>本地快照</dt><dd>${snapshotUpdatedAt}</dd></div><div><dt>数据规模</dt><dd>5 分钟 ${number(dataset?.bars5.length || 0)} 根 · 60 分钟 ${number(dataset?.bars60.length || 0)} 根</dd></div></dl>
    <div class="notice"><strong>分钟齐全 ≠ 价格准确</strong><p>“组成分钟”仅说明该区间的分钟数是否齐全，不代表原始价格可靠。展示保留 EDB 原值，未拼接新浪行情，也未自行复权。</p><p>60 分钟按交易分钟累计，跳过盘中休息；日盘末段为 45 分钟。夜盘按实际自然日显示。</p></div>
    <h3 class="anomaly-heading">已知待核实记录 <span>${anomalies.length}</span></h3>
    ${!dataset?.auditAvailable ? '<p class="empty-note amber">异常提示资料未加载。行情可正常浏览，但本次不能提供完整的已知异常提示。</p>' : !anomalies.length ? '<p class="empty-note">当前标的没有已导入的具体异常点。未标记不代表数据已通过价格真实性验证。</p>' : anomalies.map((anomaly, index) => `<div class="anomaly-item ${focused === anomaly ? 'focused' : ''}"><span class="anomaly-dot">!</span><div><strong>${escapeHtml(anomaly.title)}</strong><p>${escapeHtml(anomaly.detail)}</p><button class="text-button" data-anomaly-index="${index}">定位到 ${shortTime(anomaly.timeMs)} ↗</button></div></div>`).join('')}
    <div class="source-path"><span>本地数据目录</span><code>${escapeHtml(dataset?.dataDirectory || 'EXE 同级 data 文件夹')}</code></div>`;
  body.querySelectorAll<HTMLButtonElement>('[data-anomaly-index]').forEach(button => button.addEventListener('click', () => {
    if (!dataset) return;
    const anomaly = anomalies[Number(button.dataset.anomalyIndex)];
    const bar = dataset.bars5[locateTime(dataset.bars5, anomaly.timeMs)];
    setMode('dual'); selectBar(5, bar, true); ($('#date-input') as HTMLInputElement).value = formatBeijing(bar.startMs).slice(0, 10);
    $('#details-dialog').closest('dialog')!.close();
  }));
  const dialog = $('#details-dialog') as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  if (focused) body.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
}

async function showEntryRules() {
  const result = await window.market.readEntryRules();
  $('#rules-content').textContent = result.ok && result.text.trim() ? result.text : DEFAULT_ENTRY_RULES;
  const modified = result.modifiedAt ? ` · 修改时间 ${shortTime(new Date(result.modifiedAt).getTime())}` : '';
  $('#rules-meta').textContent = `${result.fallback ? `正在显示内置确认版 · ${result.error || '外部文件不可用'}` : '正在显示外部规则文件'} · ${result.path || 'data/entry-rules.md'}${modified} · 修改文字不会自动改变标记算法`;
  const dialog = $('#rules-dialog') as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

const reviewMoney = (value: number) => `${number(value)} 元`;
const reviewSignedMoney = (value: number) => `${signed(value)} 元`;
const reviewPercent = (value: number) => `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
const reviewDirection = (direction: WeeklyEntry['direction']) => direction === 'long' ? '做多' : '做空';
const reviewExitLabel = (type: ProfitLossReviewResult['completedTrades'][number]['exitType']) => ({
  'take-profit': '止盈出场',
  'stop-loss': '止损出场',
  'session-close': '休市出场',
}[type]);
const reviewGranularityLabel = (granularity: ProfitLossReviewResult['completedTrades'][number]['granularity']) =>
  granularity === 'one-minute' ? '1 分钟判定' : '5 分钟回退';

function reviewMetric(label: string, value: string, testid?: string, tone?: string): string {
  return `<div class="review-metric"${tone ? ` data-tone="${tone}"` : ''}><span>${label}</span><strong${testid ? ` data-testid="${testid}"` : ''}>${value}</strong></div>`;
}

function renderProfitLossReview(): void {
  const content = $('#review-content');
  if (!dataset) {
    content.innerHTML = '<div class="review-empty" data-testid="review-empty"><strong>行情数据尚未加载</strong><p>请先等待行情加载完成，或点击“重试”后再打开盈亏情况。</p></div>';
    return;
  }

  const result = reviewProfitLoss(charts[60].getWeeklyEntries(), dataset.bars5, dataset.bars1);
  const stats = result.statistics;
  const tradeRows = result.completedTrades.map((trade, index) => {
    const resultClass = trade.cashPnl > 0 ? 'win' : trade.cashPnl < 0 ? 'loss' : 'flat';
    return `<li class="review-trade review-${resultClass}" data-testid="review-trade" data-exit-type="${trade.exitType}">
      <div class="review-trade-heading"><strong>#${index + 1} ${reviewDirection(trade.direction)}</strong><span class="review-status review-status-${resultClass}">${reviewExitLabel(trade.exitType)}</span></div>
      <div class="review-trade-grid">
        <span>入场时间 <b>${shortTime(trade.entryTimeMs)}</b></span><span>入场价 <b>${number(trade.entryPrice)}</b></span>
        <span>出场时间 <b>${shortTime(trade.exitTimeMs)}</b></span><span>出场价 <b>${number(trade.exitPrice)}</b></span>
        <span>判定来源 <b>${reviewGranularityLabel(trade.granularity)}</b></span><span>价格盈亏 <b>${reviewSignedMoney(trade.pricePnl)}</b></span>
      </div>
      <div class="review-trade-pnl"><span>资金盈亏</span><strong>${reviewSignedMoney(trade.cashPnl)}</strong><small>累计资金 ${reviewMoney(trade.capitalAfter)}</small></div>
    </li>`;
  }).join('');
  const incompleteRows = result.incompleteTrades.map((trade, index) =>
    `<li class="review-incomplete" data-testid="review-incomplete-trade"><div><strong>#${index + 1} ${reviewDirection(trade.direction)}</strong><span class="review-status review-status-incomplete">未完成</span></div><p>入场 ${shortTime(trade.entryTimeMs)} · 价格 ${number(trade.entryPrice)} · ${trade.lifecycleEndReason === 'data-end' ? '数据到达末尾，尚未出现出场信号' : '生命周期尚未完成'}</p></li>`,
  ).join('');

  content.innerHTML = `<div class="review-summary">
    <div class="review-summary-heading"><div><span class="eyebrow">CURRENT DATASET</span><h3>复盘结果</h3><p>基于 ${number(stats.candidateCount)} 个历史入场候选，${number(dataset.bars5.length)} 根 5 分钟 K 线和 ${number(dataset.bars1.length)} 根 1 分钟 K 线。</p></div><span class="review-capital-result" data-testid="review-final-capital"><small>最终资金</small><strong>${reviewMoney(result.finalCapital)}</strong><em>${reviewSignedMoney(result.totalPnl)} · ${reviewPercent(result.returnRate)}</em></span></div>
    <div class="review-metrics review-capital-metrics">
      ${reviewMetric('初始资金', reviewMoney(result.initialCapital), 'review-initial-capital')}
      ${reviewMetric('最终资金', reviewMoney(result.finalCapital), 'review-final-capital-metric', result.totalPnl >= 0 ? 'positive' : 'negative')}
      ${reviewMetric('总盈亏', reviewSignedMoney(result.totalPnl), 'review-total-pnl', result.totalPnl >= 0 ? 'positive' : 'negative')}
      ${reviewMetric('收益率', reviewPercent(result.returnRate), 'review-return-rate', result.returnRate >= 0 ? 'positive' : 'negative')}
    </div>
  </div>
  <section class="review-section"><h3>交易统计</h3><div class="review-metrics">
    ${reviewMetric('有效入场', number(stats.validEntryCount))}
    ${reviewMetric('已完成交易', number(stats.completedTradeCount))}
    ${reviewMetric('盈利交易', number(stats.winningTradeCount), undefined, 'positive')}
    ${reviewMetric('亏损交易', number(stats.losingTradeCount), undefined, 'negative')}
    ${reviewMetric('持平交易', number(stats.flatTradeCount), undefined, 'flat')}
    ${reviewMetric('胜率', reviewPercent(stats.winRate))}
    ${reviewMetric('止盈出场', number(stats.takeProfitCount), undefined, 'take-profit')}
    ${reviewMetric('止损出场', number(stats.stopLossCount), undefined, 'stop-loss')}
    ${reviewMetric('休市出场', number(stats.sessionCloseCount), undefined, 'session-close')}
    ${reviewMetric('忽略候选', number(stats.ignoredNoEntryCount))}
  </div></section>
  <section class="review-section"><h3>盈亏质量</h3><div class="review-metrics">
    ${reviewMetric('累计盈利', reviewSignedMoney(stats.cumulativeProfit), undefined, 'positive')}
    ${reviewMetric('累计亏损', reviewSignedMoney(stats.cumulativeLoss), undefined, 'negative')}
    ${reviewMetric('平均盈利', reviewMoney(stats.averageProfit), undefined, 'positive')}
    ${reviewMetric('平均亏损', reviewMoney(stats.averageLoss), undefined, 'negative')}
    ${reviewMetric('盈亏比', stats.profitLossRatio === null ? '无亏损' : `${number(stats.profitLossRatio)} : 1`)}
    ${reviewMetric('最大回撤', reviewMoney(stats.maxDrawdown), undefined, 'negative')}
    ${reviewMetric('最大回撤率', reviewPercent(stats.maxDrawdownRate), undefined, 'negative')}
    ${reviewMetric('最大连胜', number(stats.maxConsecutiveWins), undefined, 'positive')}
    ${reviewMetric('最大连亏', number(stats.maxConsecutiveLosses), undefined, 'negative')}
  </div></section>
  <section class="review-section"><div class="review-section-heading"><h3>逐笔交易</h3><span>${number(stats.completedTradeCount)} 笔</span></div>
    ${tradeRows ? `<ol class="review-trades" data-testid="review-trade-list">${tradeRows}</ol>` : '<p class="review-empty review-empty-inline" data-testid="review-no-completed">当前数据没有已完成交易。</p>'}
  </section>
  <section class="review-section" data-testid="review-incomplete-section"><div class="review-section-heading"><h3>未完成交易</h3><span>${number(stats.incompleteTradeCount)} 笔</span></div>
    ${incompleteRows ? `<ul class="review-incomplete-list">${incompleteRows}</ul>` : '<p class="review-empty review-empty-inline" data-testid="review-no-incomplete">没有未完成交易。</p>'}
  </section>
  <div class="review-note"><strong>判定口径</strong><span>每个有效入场独立按 1 手计算，豆粕合约乘数为 10；不计算手续费和滑点。止盈、止损优先使用完整的 1 分钟 K 线判定，缺少完整分钟时回退到 5 分钟 K 线。</span></div>`;
}

function showProfitLossReview(): void {
  renderProfitLossReview();
  if (!reviewDialog.open) reviewDialog.showModal();
}

$('#instrument').addEventListener('change', () => void loadInstrument(($('#instrument') as HTMLSelectElement).value as Instrument));
$('#toggle-monday').addEventListener('click', () => {
  mondayVisible = !mondayVisible;
  charts[60].updateMondayVisibility();
  $('#toggle-monday').setAttribute('aria-pressed', String(mondayVisible));
  $('#toggle-monday').classList.toggle('primary', mondayVisible);
});
$('#toggle-subcharts').addEventListener('click', () => {
  subchartsVisible = !subchartsVisible;
  clearCrosshairs();
  charts[60].setSubchartsVisible(subchartsVisible);
  charts[5].setSubchartsVisible(subchartsVisible);
  $('#toggle-subcharts').textContent = subchartsVisible ? '只看K线' : '显示副图';
  $('#toggle-subcharts').setAttribute('aria-pressed', String(!subchartsVisible));
});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode as typeof mode)));
$('#date-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!dataset) { toast('请先加载行情数据'); return; }
  const input = $('#date-input') as HTMLInputElement;
  try {
    const index = locateDate(dataset.bars5, input.value);
    const bar = dataset.bars5[index];
    selectBar(5, bar, true); input.classList.remove('invalid'); input.removeAttribute('aria-invalid');
    toast(`已定位至 ${shortTime(bar.startMs)}（北京时间）`);
  } catch {
    input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); toast('请输入有效日期，例如 2026-02-05'); input.focus();
  }
});
$('#latest').addEventListener('click', () => {
  if (!dataset) return;
  clearToast();
  clearCrosshairs();
  selected = undefined; charts[60].highlight([]); charts[5].highlight([]); charts[60].latest(); charts[5].latest();
  $('.selection-label').textContent = '双周期联动';
  $('#selection-text').textContent = '已回到样本最新位置 · 点击 K 线进行双周期联动'; $('#selected-anomaly').hidden = true;
  $('#selection-bar').classList.remove('incomplete');
  delete document.documentElement.dataset.selectedStart; delete document.documentElement.dataset.selectedEnd; delete document.documentElement.dataset.childCount;
  delete document.documentElement.dataset.selectionKind; delete document.documentElement.dataset.entryDirection;
  delete document.documentElement.dataset.entryTriggerStart; delete document.documentElement.dataset.entryPullbackLine;
  delete document.documentElement.dataset.observationCount;
  delete document.documentElement.dataset.entrySelectionSource;
  clearRootLifecycleDiagnostics();
  ($('#date-input') as HTMLInputElement).value = formatBeijing(dataset.bars5.at(-1)!.startMs).slice(0, 10);
});
$('#retry').addEventListener('click', () => void loadInstrument(requestedInstrument, true));
$('#dismiss-error').addEventListener('click', () => { $('#error').hidden = true; });
$('#source-info').addEventListener('click', () => showDetails());
$('#entry-rules').addEventListener('click', () => void showEntryRules());
reviewButton.addEventListener('click', () => showProfitLossReview());
$('#attribution').addEventListener('click', () => void window.market.openAttribution());
$('#market-update').addEventListener('click', () => {
  if (marketUpdateRequestRunning || ['fetching', 'validating', 'saving'].includes(marketUpdateState.phase)) return;
  marketUpdateRequestRunning = true;
  renderMarketUpdateState();
  void window.market.update()
    .then(state => acceptMarketUpdateState(state))
    .catch(() => acceptMarketUpdateState({
      ...marketUpdateState,
      phase: 'failed',
      completedAt: new Date().toISOString(),
      error: { code: 'unexpected', message: '更新请求未完成，请稍后重试' },
    }))
    .finally(() => {
      marketUpdateRequestRunning = false;
      renderMarketUpdateState();
    });
});
$('#update-entry').addEventListener('click', () => {
  updateInteraction = true;
  setUpdateDialogOpen(true);
  if (!updateState || ['idle', 'up-to-date'].includes(updateState.phase)) void runUpdateAction('check');
  else renderUpdateState(updateState);
});
$('#update-download').addEventListener('click', () => void runUpdateAction('download'));
$('#update-install').addEventListener('click', () => void runUpdateAction('install'));
$('#update-retry').addEventListener('click', () => {
  const code = updateState?.error?.code;
  void runUpdateAction(code === 'download-failed' || code === 'verification-failed' ? 'download' : code === 'install-failed' ? 'install' : 'check');
});
for (const selector of ['#close-update', '#update-later', '#update-ok']) $(selector).addEventListener('click', () => {
  updateInteraction = false;
  setUpdateDialogOpen(false);
});
updateDialog.addEventListener('click', event => {
  if (event.target === updateDialog) {
    updateInteraction = false;
    setUpdateDialogOpen(false);
  }
});
for (const selector of ['#close-dialog', '#dialog-done']) $(selector).addEventListener('click', () => ($('#details-dialog') as HTMLDialogElement).close());
$('#details-dialog').addEventListener('click', event => { if (event.target === $('#details-dialog')) ($('#details-dialog') as HTMLDialogElement).close(); });
for (const selector of ['#close-rules', '#rules-done']) $(selector).addEventListener('click', () => ($('#rules-dialog') as HTMLDialogElement).close());
$('#rules-dialog').addEventListener('click', event => { if (event.target === $('#rules-dialog')) ($('#rules-dialog') as HTMLDialogElement).close(); });
for (const selector of ['#close-review', '#review-done']) $(selector).addEventListener('click', () => reviewDialog.close());
reviewDialog.addEventListener('click', event => { if (event.target === reviewDialog) reviewDialog.close(); });
const unsubscribeUpdates = window.updates.onState(renderUpdateState);
const unsubscribeMarketUpdates = window.market.onUpdateState(state => {
  void acceptMarketUpdateState(state);
});
window.addEventListener('beforeunload', () => {
  unsubscribeUpdates();
  unsubscribeMarketUpdates();
}, { once: true });
void window.updates.getState().then(renderUpdateState).catch(() => {
  $('#app-version').textContent = 'v—';
  $('#update-entry-label').textContent = '更新不可用';
});
void window.market.getUpdateState().then(state => acceptMarketUpdateState(state)).catch(() => {
  renderMarketUpdateState({
    phase: 'failed',
    error: { code: 'unexpected', message: '无法读取行情更新状态' },
  });
});
setMode('dual');
void loadInstrument('main_continuous');
