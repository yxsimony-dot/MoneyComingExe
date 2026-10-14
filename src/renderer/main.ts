import './style.css';
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Logical, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { Anomaly, Bar, Dataset, Instrument, Period } from '../shared/types';
import { DEFAULT_ENTRY_RULES } from '../shared/entry-rules';
import { formatBeijing, locateDate, locateTime } from '../domain/time';
import { analyzeWeeklyRange, type WeeklyBreakout } from '../domain/weekly-range';
import { exponentialMovingAverage } from '../domain/ema';
import { analyzeWeeklyEntries, entryObservationLine, entryObservationWindow, selectWeeklyEntry, weeklyEntryMarkerId, type WeeklyEntry } from '../domain/weekly-entry';
import { childrenFor, linkedLogicalRange, parentFor } from '../domain/link';

const icons = {
  mark: '<svg viewBox="0 0 32 32" fill="none"><path d="M5 24V13l7 6 7-11 8 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 8h5v6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  grid: '<svg viewBox="0 0 18 18" fill="none"><rect x="2.5" y="3" width="5" height="12" rx="1"/><rect x="10.5" y="3" width="5" height="12" rx="1"/></svg>',
  calendar: '<svg viewBox="0 0 18 18" fill="none"><rect x="3" y="4" width="12" height="11" rx="2"/><path d="M6 2v4m6-4v4M3 8h12"/></svg>',
  latest: '<svg viewBox="0 0 18 18" fill="none"><path d="m6 4 5 5-5 5m8-11v12"/></svg>',
  info: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.5"/><path d="M9 8v5m0-8v1"/></svg>',
  link: '<svg viewBox="0 0 18 18" fill="none"><path d="m7 11 4-4M6 12l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0m2 0 1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0" transform="translate(1)"/></svg>',
  resetScale: '<svg viewBox="0 0 18 18" fill="none"><path d="M4 6V3m0 0h3M4 3l2.2 2.2a5 5 0 1 1-1.1 5.4"/><path d="M9 7v4m-2-2h4"/></svg>',
};
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-icon">${icons.mark}</span><span>MONEY<span class="brand-light">COMING</span><small>期货历史研究台</small></span></div>
    <div class="topbar-right"><span class="offline"><i></i> 离线工作区</span><button class="icon-button" id="source-info" data-testid="source-info" title="数据来源与使用说明" aria-label="数据来源与使用说明">${icons.info}</button></div>
  </header>
  <main>
    <section class="market-heading">
      <div><div class="eyebrow">DALIAN COMMODITY EXCHANGE <span>/</span> 大商所</div><div class="heading-line"><h1 id="instrument-name">豆粕主连</h1><span class="symbol" id="instrument-symbol">KQ.m@DCE.m</span><span class="history-label">历史行情</span></div><p class="subtitle" id="subtitle">从整体趋势，到每一根 K 线。</p></div>
      <div class="quote"><div class="quote-caption">样本末根收盘 <span>元 / 吨</span></div><div class="quote-line"><strong id="last-close">—</strong><span id="last-change">—</span></div><div class="quote-time" id="last-time">正在读取本地数据</div></div>
    </section>
    <section class="toolbar" aria-label="行情工具栏">
      <div class="toolbar-left"><label class="instrument-select"><span>品种</span><select id="instrument" data-testid="instrument" aria-label="选择标的"><option value="main_continuous">豆粕主连</option><option value="m2701">豆粕 2701</option></select></label><span class="divider"></span><div class="segmented" aria-label="图表布局"><button data-mode="dual" data-testid="mode-dual" aria-pressed="true" class="active">${icons.grid}双周期</button><button data-mode="5" data-testid="mode-5" aria-pressed="false">5 分钟</button><button data-mode="60" data-testid="mode-60" aria-pressed="false">60 分钟</button></div></div>
      <div class="toolbar-right"><button id="toggle-monday" data-testid="toggle-monday" class="button" aria-pressed="false" title="显示或隐藏周一前8根范围及第9根起的逐次新高、新低突破标记">周一8根标记</button><button id="toggle-subcharts" data-testid="toggle-subcharts" class="button" aria-pressed="false" title="隐藏或显示成交量与持仓量副图">只看K线</button><form id="date-form" novalidate><label class="date-field">${icons.calendar}<input id="date-input" data-testid="date-input" type="date" aria-label="定位日期（北京时间）" required /></label><button type="submit" data-testid="date-jump" class="button jump-button">定位</button></form><button id="latest" data-testid="latest" class="button">${icons.latest}最新</button></div>
    </section>
    <div id="error" class="error-banner" role="alert" hidden><span id="error-text"></span><button class="button" data-testid="retry" id="retry">重新加载</button><button id="dismiss-error" aria-label="关闭错误提示">×</button></div>
    <div class="workspace-meta"><span><i class="status-dot"></i><span id="coverage">正在加载完整历史数据…</span></span><span id="counts"></span></div>
    <section class="charts" id="charts" aria-label="历史K线图表"></section>
    <section class="selection-bar" id="selection-bar"><span class="link-icon">${icons.link}</span><div><span class="selection-label">双周期联动</span><span id="selection-text">点击任意 K 线，查看两个周期的对应区间</span></div><button class="quality-link" id="selected-anomaly" hidden>查看待核实说明 ↗</button><span class="navigation-hint">滚轮缩放 <span>·</span> 拖动浏览 <span>·</span> 点击联动</span></section>
  </main>
  <footer><div><span class="footer-brand">EDB</span><span>信易历史数据</span><span class="footer-separator">/</span><span id="quality-status">源价格 · 未自行复权</span></div><div><button id="attribution">Charts by TradingView</button><span class="footer-separator">/</span><span>北京时间 UTC+8</span></div></footer>
  <div class="loading-overlay" id="loading"><div class="loading-pulse">${icons.mark}</div><strong>正在载入行情</strong><span>读取本地完整历史数据</span></div>
  <dialog id="details-dialog"><div class="dialog-heading"><div><span class="eyebrow">DATA & PROVENANCE</span><h2>数据来源与质量</h2></div><button id="close-dialog" class="close-button" aria-label="关闭详情">×</button></div><div id="dialog-body"></div><div class="dialog-bottom"><span>仅浏览本地历史快照，无实时行情连接</span><button class="button primary" id="dialog-done">知道了</button></div></dialog>
  <div class="toast" id="toast" role="status" hidden></div>
`;

const entryButton = document.createElement('button');
entryButton.id = 'entry-rules'; entryButton.dataset.testid = 'entry-rules'; entryButton.className = 'button'; entryButton.textContent = '入场规则';
entryButton.title = '查看可编辑的突破回调入场规则';
document.querySelector<HTMLButtonElement>('#toggle-monday')!.title = '显示或隐藏每周前8根、逐次突破和回调入场标记';
document.querySelector('.toolbar-right')!.insertBefore(entryButton, document.querySelector('#toggle-subcharts'));
const rulesDialog = document.createElement('dialog');
rulesDialog.id = 'rules-dialog';
rulesDialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">ENTRY RULES</span><h2>突破回调入场规则</h2></div><button id="close-rules" class="close-button" aria-label="关闭入场规则">×</button></div><div class="rules-meta" id="rules-meta"></div><pre class="rules-content" id="rules-content"></pre><div class="dialog-bottom"><span>编辑 EXE 同级 data/entry-rules.md 后重新打开即可刷新文字</span><button class="button primary" id="rules-done">知道了</button></div>';
document.body.append(rulesDialog);

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`;
const timeKey = (bar: Bar) => (bar.endMs / 1000) as UTCTimestamp;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const shortTime = (ms: number) => formatBeijing(ms).slice(0, 16);
const sameDate = (bar: Bar) => formatBeijing(bar.startMs).slice(0, 10) === formatBeijing(bar.endMs).slice(0, 10);
const interval = (bar: Bar) => `${shortTime(bar.startMs)} — ${sameDate(bar) ? formatBeijing(bar.endMs).slice(11, 16) : shortTime(bar.endMs)}`;

let dataset: Dataset | undefined;
let mode: 'dual' | '5' | '60' = 'dual';
let subchartsVisible = true;
let mondayVisible = false;
let requestedInstrument: Instrument = 'main_continuous';
let requestId = 0;
let selected: { period: Period; bar: Bar } | undefined;
let crosshairSyncing = false;
let toastTimer: ReturnType<typeof setTimeout>;

type ChartSelection =
  | { kind: 'linked'; bars: Bar[] }
  | { kind: 'entry'; bars: Bar[]; triggerStart: number; direction: WeeklyEntry['direction']; pullbackLine: number };

function toast(message: string) {
  const element = $('#toast'); element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

function clearToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }

class MarketChart {
  readonly element: HTMLElement;
  readonly chart: IChartApi;
  readonly candle: ISeriesApi<'Candlestick'>;
  private volume?: ISeriesApi<'Histogram'>;
  private oi?: ISeriesApi<'Line'>;
  private ema20?: ISeriesApi<'Line'>;
  private entryPullback?: ISeriesApi<'Line'>;
  private emaByStart = new Map<number, number>();
  readonly markers: ISeriesMarkersPluginApi<Time>;
  bars: Bar[] = [];
  private byTime = new Map<number, Bar>();
  private selection?: ChartSelection;
  private selectedDetail?: Bar;
  private anomalies: Anomaly[] = [];
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
    }
    this.chartHost.addEventListener('mouseenter', () => { this.pointerInside = true; });
    this.chartHost.addEventListener('wheel', () => { this.focusedLogicalRange = undefined; }, { passive: true });
    this.chartHost.addEventListener('pointerdown', () => { this.focusedLogicalRange = undefined; });
    this.chartHost.addEventListener('pointermove', (event) => {
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
    this.candle = this.chart.addSeries(CandlestickSeries, { upColor: '#ef646e', downColor: '#28b59c', borderUpColor: '#ef646e', borderDownColor: '#28b59c', wickUpColor: '#ef646e', wickDownColor: '#28b59c', priceFormat: { type: 'price', precision: 0, minMove: 1 }, priceLineColor: '#697689', priceLineStyle: 2 });
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
      this.element.dataset.pullbackLineStyle = 'solid';
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
    });
  }

  setData(bars: Bar[], anomalies: Anomaly[], bars5: Bar[] = []) {
    this.clearHoverRange();
    this.bars = bars; this.anomalies = anomalies; this.selection = undefined; this.selectedDetail = undefined; this.focusedLogicalRange = undefined;
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
  focusBars(bars: Bar[], targetSpan = 120) {
    const firstIndex = this.bars.indexOf(bars[0]);
    const lastIndex = this.bars.indexOf(bars.at(-1)!);
    const range = linkedLogicalRange(targetSpan, firstIndex, lastIndex, this.bars.length);
    if (range) {
      this.focusedLogicalRange = range;
      this.chart.timeScale().setVisibleLogicalRange(range);
    }
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
  highlight(bars: Bar[], focused?: Bar) {
    this.selection = bars.length ? { kind: 'linked', bars } : undefined;
    if (!bars.length) this.focusedLogicalRange = undefined;
    this.selectedDetail = focused || bars[0];
    this.updateSelectionDiagnostics();
    this.drawEntryPullback();
    this.drawMarkers();
    this.details(this.selectionOrLast());
  }
  highlightEntry(bars: Bar[], entry: WeeklyEntry) {
    this.selection = bars.length ? {
      kind: 'entry', bars, triggerStart: entry.triggerBar.startMs,
      direction: entry.direction, pullbackLine: entry.pullbackLine,
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
    } else {
      delete this.element.dataset.selectionDirection;
      delete this.element.dataset.selectionTriggerStart;
      delete this.element.dataset.selectionPullbackLine;
      delete this.element.dataset.selectionFirstIndex;
      delete this.element.dataset.selectionLastIndex;
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
  }
  drawMarkers() {
    const markers: SeriesMarker<Time>[] = [];
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
    this.element.dataset.linkedMarkerCount = String(markers.filter(marker => marker.id?.startsWith('selected-')).length);
    this.element.dataset.observationTriggerCount = String(markers.filter(marker => marker.id?.startsWith('observation-trigger-')).length);
    this.element.dataset.observationFollowCount = String(markers.filter(marker => marker.id?.startsWith('observation-follow-')).length);
  }
}

const charts = { 60: new MarketChart(60), 5: new MarketChart(5) };

function clearCrosshairs() {
  crosshairSyncing = true;
  try { charts[60].chart.clearCrosshairPosition(); charts[5].chart.clearCrosshairPosition(); }
  finally { crosshairSyncing = false; }
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
  const observation = entry ? entryObservationWindow(entry.triggerBar, dataset.bars5) : [];
  charts[60].highlight(parent ? [parent] : []);
  if (entry && observation.length) charts[5].highlightEntry(observation, entry);
  else charts[5].highlight(children, period === 5 ? bar : undefined);
  if (parent && (period === 5 || moveBoth)) charts[60].focus(parent);
  const focusBars = entry ? observation : children;
  if (focusBars.length && (period === 60 || moveBoth)) {
    if (period === 60) charts[5].focusBars(focusBars, sourceSpan);
    else charts[5].focus(bar);
  }
  const expected = parent ? parent.expectedMinutes / 5 : 0;
  const complete = !!parent && children.length === expected && children.every(child => child.complete);
  const observationMissing = !!entry && !observation.length;
  $('.selection-label').textContent = entry ? '入场观察' : '双周期联动';
  $('#selection-text').textContent = entry
    ? observation.length
      ? `${entry.direction === 'long' ? '多头' : '空头'}  ·  触发 ${shortTime(entry.triggerBar.startMs)}  ·  回调线 ${number(entry.pullbackLine)}  ·  ${observation.length} 根 5 分钟${observation.length < 16 ? '  ·  已到数据末尾' : ''}`
      : `${entry.direction === 'long' ? '多头' : '空头'}  ·  触发记录不在当前5分钟数据中，联动不完整`
    : parent ? `${interval(parent)}  ·  ${children.length} 根 5 分钟  /  ${parent.expectedMinutes} 个交易分钟${complete ? '' : '  ·  联动不完整'}` : '未找到包含该 K 线的 60 分钟区间，联动不完整';
  $('#selection-bar').classList.toggle('incomplete', entry ? observationMissing : !complete);
  const anomaly = dataset.anomalies.find(a => a.timeMs >= (parent || bar).startMs && a.timeMs < (parent || bar).endMs);
  $('#selected-anomaly').hidden = !anomaly;
  $('#selected-anomaly').onclick = () => showDetails(anomaly);
  document.documentElement.dataset.selectedStart = String(bar.startMs);
  document.documentElement.dataset.selectedEnd = String(bar.endMs);
  document.documentElement.dataset.childCount = String(entry ? observation.length : children.length);
  document.documentElement.dataset.selectionKind = entry ? 'entry' : 'linked';
  if (entry) {
    document.documentElement.dataset.entryDirection = entry.direction;
    document.documentElement.dataset.entryTriggerStart = String(entry.triggerBar.startMs);
    document.documentElement.dataset.entryPullbackLine = String(entry.pullbackLine);
    document.documentElement.dataset.observationCount = String(observation.length);
    document.documentElement.dataset.entrySelectionSource = hoveredObjectId === weeklyEntryMarkerId(entry) ? 'marker' : 'default';
  } else {
    delete document.documentElement.dataset.entryDirection;
    delete document.documentElement.dataset.entryTriggerStart;
    delete document.documentElement.dataset.entryPullbackLine;
    delete document.documentElement.dataset.observationCount;
    delete document.documentElement.dataset.entrySelectionSource;
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
  $('#subtitle').textContent = next.instrument === 'main_continuous' ? '主力连续合约 · 源价格展示，未自行复权' : '豆粕 2027 年 01 月合约 · 历史价格与成交持仓';
  $('#quality-status').textContent = !next.auditAvailable ? '异常提示资料未加载' : next.instrument === 'main_continuous' ? '源价格 · 未自行复权' : `${next.anomalies.length} 处已知待核实记录`;
  $('#quality-status').classList.toggle('amber', !next.auditAvailable || next.anomalies.length > 0);
  const first = next.bars5[0], last = next.bars5.at(-1)!;
  $('#coverage').textContent = `${formatBeijing(first.startMs).slice(0, 10)} — ${formatBeijing(last.endMs).slice(0, 10)}`;
  $('#counts').textContent = `5 分钟 ${number(next.bars5.length)} 根    /    60 分钟 ${number(next.bars60.length)} 根`;
  $('#last-close').textContent = number(last.close);
  $('#last-close').className = last.close >= last.open ? 'up' : 'down';
  $('#last-change').textContent = `${signed(last.close - last.open)}  (${signed((last.close - last.open) / last.open * 100)}%)`;
  $('#last-change').className = last.close >= last.open ? 'up' : 'down';
  $('#last-time').textContent = `${shortTime(last.endMs)} · 较末根开盘`;
  charts[60].setData(next.bars60, next.anomalies, next.bars5); charts[5].setData(next.bars5, next.anomalies);
  $('.selection-label').textContent = '双周期联动';
  $('#selection-text').textContent = '点击任意 K 线，查看两个周期的对应区间'; $('#selected-anomaly').hidden = true;
  $('#selection-bar').classList.remove('incomplete');
  delete document.documentElement.dataset.selectedStart; delete document.documentElement.dataset.selectedEnd; delete document.documentElement.dataset.childCount;
  delete document.documentElement.dataset.selectionKind; delete document.documentElement.dataset.entryDirection;
  delete document.documentElement.dataset.entryTriggerStart; delete document.documentElement.dataset.entryPullbackLine;
  delete document.documentElement.dataset.observationCount;
  delete document.documentElement.dataset.entrySelectionSource;
  if (focusTime !== undefined) {
    const index = locateTime(next.bars5, focusTime);
    selectBar(5, next.bars5[index], true);
    if (focusTime < first.startMs || focusTime >= last.endMs) toast(`新标的范围不同，已定位至 ${shortTime(next.bars5[index].startMs)}`);
  }
  ($('#date-input') as HTMLInputElement).value = formatBeijing((selected as { bar: Bar } | undefined)?.bar.startMs || last.startMs).slice(0, 10);
  document.documentElement.dataset.instrument = next.instrument;
  document.documentElement.dataset.ready = 'true';
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
    $('#error-text').textContent = `${instrument === 'm2701' ? '豆粕 2701' : '豆粕主连'}加载失败：${error instanceof Error ? error.message : String(error)}${dataset ? `。当前仍显示${dataset.name}。` : ''}`;
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
  body.innerHTML = `<div class="source-card"><span class="source-avatar">E</span><div><strong>信易 EDB · 本地历史快照</strong><p>${escapeHtml(dataset?.name || '豆粕行情')} · CSV 源价格 · 离线读取</p></div><span class="tag">只读</span></div>
    <dl class="source-grid"><div><dt>数据区间（北京时间）</dt><dd>${first && last ? `${shortTime(first.startMs)} → ${shortTime(last.endMs)}` : '尚未加载'}</dd></div><div><dt>数据规模</dt><dd>5 分钟 ${number(dataset?.bars5.length || 0)} 根 · 60 分钟 ${number(dataset?.bars60.length || 0)} 根</dd></div></dl>
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
  ($('#date-input') as HTMLInputElement).value = formatBeijing(dataset.bars5.at(-1)!.startMs).slice(0, 10);
});
$('#retry').addEventListener('click', () => void loadInstrument(requestedInstrument, true));
$('#dismiss-error').addEventListener('click', () => { $('#error').hidden = true; });
$('#source-info').addEventListener('click', () => showDetails());
$('#entry-rules').addEventListener('click', () => void showEntryRules());
$('#attribution').addEventListener('click', () => void window.market.openAttribution());
for (const selector of ['#close-dialog', '#dialog-done']) $(selector).addEventListener('click', () => ($('#details-dialog') as HTMLDialogElement).close());
$('#details-dialog').addEventListener('click', event => { if (event.target === $('#details-dialog')) ($('#details-dialog') as HTMLDialogElement).close(); });
for (const selector of ['#close-rules', '#rules-done']) $(selector).addEventListener('click', () => ($('#rules-dialog') as HTMLDialogElement).close());
$('#rules-dialog').addEventListener('click', event => { if (event.target === $('#rules-dialog')) ($('#rules-dialog') as HTMLDialogElement).close(); });
setMode('dual');
void loadInstrument('main_continuous');
