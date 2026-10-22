import { tradingMinuteAt } from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import { instrumentDefinition } from '../shared/instruments';
import type {
  Instrument,
  MarketUpdateIntent,
  MarketUpdateState,
  OnlineMarketState,
  PublicMarketUpdateError,
} from '../shared/types';

const MINUTE_MS = 60_000;
const DEFAULT_PUBLISH_GRACE_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface OnlineSnapshotInfo {
  localMinuteLatestAt?: string;
  sourceLatestAt?: string;
  snapshotUpdatedAt?: string;
}

export interface OnlineMarketCoordinatorOptions {
  update: (
    instrument: Instrument,
    intent: MarketUpdateIntent,
  ) => Promise<MarketUpdateState>;
  loadSnapshot?: (instrument: Instrument) => Promise<OnlineSnapshotInfo>;
  publish: (state: OnlineMarketState) => void;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  publishGraceMs?: number;
}

function isSuccessfulUpdate(
  state: MarketUpdateState,
): state is MarketUpdateState & {
  phase: 'succeeded' | 'up-to-date';
  localMinuteLatestAt: string;
  sourceLatestAt: string;
} {
  if (!['succeeded', 'up-to-date'].includes(state.phase)
    || !state.localMinuteLatestAt
    || !state.sourceLatestAt) {
    return false;
  }
  try {
    return parseBeijing(state.localMinuteLatestAt)
      >= parseBeijing(state.sourceLatestAt);
  } catch {
    return false;
  }
}

function invalidGateError(): PublicMarketUpdateError {
  return {
    code: 'validation',
    message: '补齐结果未达到数据源最新闭合分钟，当前数据未受影响',
  };
}

function unexpectedError(): PublicMarketUpdateError {
  return {
    code: 'unexpected',
    message: '在线行情更新失败，请稍后重试',
  };
}

export function nextBeijingMinuteCheckMs(
  nowMs: number,
  publishGraceMs = DEFAULT_PUBLISH_GRACE_MS,
): number {
  if (!Number.isFinite(nowMs) || publishGraceMs < 0) {
    throw new Error('在线分钟调度时间无效');
  }
  return Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
    + MINUTE_MS
    + publishGraceMs;
}

export function isReliablySourceDelayed(
  instrument: Instrument,
  sourceLatestAt: string | undefined,
  requestEndAt: string | undefined,
): boolean {
  if (!sourceLatestAt || !requestEndAt) return false;
  try {
    const sourceLatestMs = parseBeijing(sourceLatestAt);
    const requestEndMs = parseBeijing(requestEndAt);
    if (sourceLatestMs >= requestEndMs) return false;
    const definition = instrumentDefinition(instrument);
    const sourceMinute = tradingMinuteAt(
      sourceLatestMs - MINUTE_MS,
      definition.tradingSessions,
    );
    const expectedMinute = tradingMinuteAt(
      requestEndMs - MINUTE_MS,
      definition.tradingSessions,
    );
    return sourceMinute.date === expectedMinute.date
      && sourceMinute.session === expectedMinute.session
      && sourceMinute.index < expectedMinute.index;
  } catch {
    return false;
  }
}

export class OnlineMarketCoordinator {
  private state: OnlineMarketState = {
    enabled: false,
    phase: 'disabled',
  };
  private generation = 0;
  private timer?: TimerHandle;
  private disposed = false;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<OnlineMarketCoordinatorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<OnlineMarketCoordinatorOptions['clearTimer']>;
  private readonly publishGraceMs: number;

  constructor(private readonly options: OnlineMarketCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => (
      setTimeout(callback, delayMs)
    ));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
    this.publishGraceMs = options.publishGraceMs ?? DEFAULT_PUBLISH_GRACE_MS;
  }

  getState(): OnlineMarketState {
    return structuredClone(this.state);
  }

  setEnabled(enabled: boolean): OnlineMarketState {
    if (this.disposed) return this.getState();
    if (!enabled) {
      this.generation += 1;
      this.cancelTimer();
      this.transition({
        enabled: false,
        phase: 'disabled',
        nextCheckAt: undefined,
        error: undefined,
      });
      return this.getState();
    }
    if (this.state.enabled) return this.getState();
    this.generation += 1;
    this.cancelTimer();
    this.transition({
      enabled: true,
      phase: 'catching-up',
      nextCheckAt: undefined,
      error: undefined,
    });
    this.startGate(this.generation);
    return this.getState();
  }

  declareCurrentInstrument(instrument: Instrument): OnlineMarketState {
    if (this.disposed || this.state.instrument === instrument) {
      return this.getState();
    }
    this.generation += 1;
    const generation = this.generation;
    this.cancelTimer();
    this.transition({
      phase: this.state.enabled ? 'catching-up' : 'disabled',
      instrument,
      localMinuteLatestAt: undefined,
      sourceLatestAt: undefined,
      snapshotUpdatedAt: undefined,
      nextCheckAt: undefined,
      error: undefined,
    });
    void this.loadSnapshot(instrument, generation);
    if (this.state.enabled) this.startGate(generation);
    return this.getState();
  }

  networkRecovered(): OnlineMarketState {
    this.restartGate();
    return this.getState();
  }

  resume(): OnlineMarketState {
    this.restartGate();
    return this.getState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.cancelTimer();
  }

  private restartGate(): void {
    if (this.disposed || !this.state.enabled || !this.state.instrument) return;
    this.generation += 1;
    const generation = this.generation;
    this.cancelTimer();
    this.transition({
      phase: 'catching-up',
      nextCheckAt: undefined,
      error: undefined,
    });
    this.startGate(generation);
  }

  private async loadSnapshot(
    instrument: Instrument,
    generation: number,
  ): Promise<void> {
    if (!this.options.loadSnapshot) return;
    try {
      const snapshot = await this.options.loadSnapshot(instrument);
      if (!this.isCurrent(generation, instrument)
        || this.state.phase !== 'catching-up') return;
      this.transition({
        localMinuteLatestAt: snapshot.localMinuteLatestAt,
        sourceLatestAt: snapshot.sourceLatestAt,
        snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
      });
    } catch {
      // The update gate owns failure reporting and last-valid-snapshot fallback.
    }
  }

  private startGate(generation: number): void {
    const instrument = this.state.instrument;
    if (!instrument) return;
    void this.run(instrument, generation, 'full');
  }

  private async run(
    instrument: Instrument,
    generation: number,
    intent: MarketUpdateIntent,
  ): Promise<void> {
    if (!this.isCurrent(generation, instrument)) return;
    this.transition({
      phase: intent === 'full' ? 'catching-up' : 'polling',
      nextCheckAt: undefined,
      error: undefined,
    });
    let result: MarketUpdateState;
    try {
      result = await this.options.update(instrument, intent);
    } catch {
      if (!this.isCurrent(generation, instrument)) return;
      this.degrade(unexpectedError(), generation);
      return;
    }
    if (!this.isCurrent(generation, instrument)) return;
    if (!isSuccessfulUpdate(result)) {
      this.degrade(
        result.phase === 'failed' && result.error
          ? result.error
          : invalidGateError(),
        generation,
      );
      return;
    }
    const completedAt = this.now().toISOString();
    const delayed = isReliablySourceDelayed(
      instrument,
      result.sourceLatestAt,
      result.requestEndAt,
    );
    this.transition({
      phase: delayed ? 'source-delayed' : 'waiting',
      localMinuteLatestAt: result.localMinuteLatestAt,
      sourceLatestAt: result.sourceLatestAt,
      snapshotUpdatedAt: result.snapshotUpdatedAt ?? this.state.snapshotUpdatedAt,
      lastSucceededAt: completedAt,
      error: undefined,
    });
    this.schedule(generation, 'tail');
  }

  private degrade(
    error: PublicMarketUpdateError,
    generation: number,
  ): void {
    this.transition({
      phase: 'degraded',
      error,
      nextCheckAt: undefined,
    });
    this.schedule(generation, 'full');
  }

  private schedule(
    generation: number,
    intent: MarketUpdateIntent,
  ): void {
    if (!this.isCurrent(generation, this.state.instrument)) return;
    const nowMs = this.now().getTime();
    const nextCheckMs = nextBeijingMinuteCheckMs(
      nowMs,
      this.publishGraceMs,
    );
    this.cancelTimer();
    this.transition({ nextCheckAt: formatBeijing(nextCheckMs) });
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      const instrument = this.state.instrument;
      if (!instrument || !this.isCurrent(generation, instrument)) return;
      void this.run(instrument, generation, intent);
    }, Math.max(0, nextCheckMs - nowMs));
  }

  private isCurrent(
    generation: number,
    instrument: Instrument | undefined,
  ): boolean {
    return !this.disposed
      && this.state.enabled
      && generation === this.generation
      && instrument !== undefined
      && instrument === this.state.instrument;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private transition(patch: Partial<OnlineMarketState>): void {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      ...patch,
    };
    this.options.publish(this.getState());
  }
}
