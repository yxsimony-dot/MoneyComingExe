import { describe, expect, it, vi } from 'vitest';
import { parseBeijing } from '../src/domain/time';
import {
  OnlineMarketCoordinator,
  isReliablySourceDelayed,
  nextBeijingMinuteCheckMs,
} from '../src/main/online-market-coordinator';
import type {
  Instrument,
  MarketUpdateIntent,
  MarketUpdateState,
  OnlineMarketState,
} from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeClock {
  nowMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, {
    at: number;
    callback: () => void;
  }>();

  constructor(start: string) {
    this.nowMs = parseBeijing(start);
  }

  now = () => new Date(this.nowMs);

  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.nowMs + delayMs,
      callback,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    this.timers.delete(handle as unknown as number);
  };

  timerCount(): number {
    return this.timers.size;
  }

  nextTimerAt(): number | undefined {
    return [...this.timers.values()]
      .map(timer => timer.at)
      .sort((left, right) => left - right)[0];
  }

  advanceTo(time: string): void {
    this.nowMs = parseBeijing(time);
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function successfulState(
  instrument: Instrument,
  intent: MarketUpdateIntent,
  overrides: Partial<MarketUpdateState> = {},
): MarketUpdateState {
  return {
    instrument,
    phase: 'up-to-date',
    intent,
    localMinuteLatestAt: '2026-10-20 10:05:00',
    sourceLatestAt: '2026-10-20 10:05:00',
    requestEndAt: '2026-10-20 10:05:00',
    snapshotUpdatedAt: '2026-10-20T02:05:01.000Z',
    ...overrides,
  };
}

function setup(
  update: (
    instrument: Instrument,
    intent: MarketUpdateIntent,
  ) => Promise<MarketUpdateState>,
  start = '2026-10-20 10:04:30',
) {
  const clock = new FakeClock(start);
  const published: OnlineMarketState[] = [];
  const loadSnapshot = vi.fn(async () => ({
    localMinuteLatestAt: '2026-10-20 10:00:00',
    sourceLatestAt: '2026-10-20 10:00:00',
    snapshotUpdatedAt: '2026-10-20T02:00:01.000Z',
  }));
  const coordinator = new OnlineMarketCoordinator({
    update,
    loadSnapshot,
    publish: state => published.push(state),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, coordinator, loadSnapshot, published };
}

describe('online market coordinator', () => {
  it('defaults to disabled and requires a full catch-up before scheduling tail polling', async () => {
    const gate = deferred<MarketUpdateState>();
    const update = vi.fn(() => gate.promise);
    const fixture = setup(update);

    expect(fixture.coordinator.getState()).toEqual({
      enabled: false,
      phase: 'disabled',
    });
    fixture.coordinator.declareCurrentInstrument('main_continuous');
    expect(update).not.toHaveBeenCalled();

    fixture.coordinator.setEnabled(true);
    expect(fixture.coordinator.getState()).toMatchObject({
      enabled: true,
      phase: 'catching-up',
      instrument: 'main_continuous',
    });
    expect(update).toHaveBeenCalledWith('main_continuous', 'full');
    expect(fixture.clock.timerCount()).toBe(0);

    gate.resolve(successfulState('main_continuous', 'full'));
    await flush();

    expect(fixture.coordinator.getState()).toMatchObject({
      phase: 'waiting',
      localMinuteLatestAt: '2026-10-20 10:05:00',
      sourceLatestAt: '2026-10-20 10:05:00',
      nextCheckAt: '2026-10-20 10:05:05',
    });
    expect(fixture.clock.timerCount()).toBe(1);
  });

  it('does not let a late local snapshot overwrite a completed full catch-up', async () => {
    const snapshot = deferred<{
      localMinuteLatestAt: string;
      sourceLatestAt: string;
      snapshotUpdatedAt: string;
    }>();
    const clock = new FakeClock('2026-10-20 10:04:30');
    const coordinator = new OnlineMarketCoordinator({
      update: async (instrument, intent) => successfulState(instrument, intent),
      loadSnapshot: () => snapshot.promise,
      publish: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    coordinator.declareCurrentInstrument('main_continuous');
    coordinator.setEnabled(true);
    await flush();
    expect(coordinator.getState()).toMatchObject({
      phase: 'waiting',
      localMinuteLatestAt: '2026-10-20 10:05:00',
      sourceLatestAt: '2026-10-20 10:05:00',
      snapshotUpdatedAt: '2026-10-20T02:05:01.000Z',
    });

    snapshot.resolve({
      localMinuteLatestAt: '2026-10-20 10:00:00',
      sourceLatestAt: '2026-10-20 10:00:00',
      snapshotUpdatedAt: '2026-10-20T02:00:01.000Z',
    });
    await flush();

    expect(coordinator.getState()).toMatchObject({
      phase: 'waiting',
      localMinuteLatestAt: '2026-10-20 10:05:00',
      sourceLatestAt: '2026-10-20 10:05:00',
      snapshotUpdatedAt: '2026-10-20T02:05:01.000Z',
    });
  });

  it('uses one-shot Beijing minute boundaries plus five seconds and never overlaps polls', async () => {
    const longPoll = deferred<MarketUpdateState>();
    const update = vi.fn((
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => intent === 'full'
      ? Promise.resolve(successfulState(instrument, intent))
      : longPoll.promise);
    const fixture = setup(update);

    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    await flush();
    expect(fixture.clock.nextTimerAt()).toBe(
      parseBeijing('2026-10-20 10:05:05'),
    );

    fixture.clock.advanceTo('2026-10-20 10:07:40');
    await flush();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith('main_continuous', 'tail');
    expect(fixture.coordinator.getState().phase).toBe('polling');
    expect(fixture.clock.timerCount()).toBe(0);

    fixture.clock.advanceTo('2026-10-20 10:10:00');
    await flush();
    expect(update).toHaveBeenCalledTimes(2);

    longPoll.resolve(successfulState('main_continuous', 'tail', {
      localMinuteLatestAt: '2026-10-20 10:10:00',
      sourceLatestAt: '2026-10-20 10:10:00',
      requestEndAt: '2026-10-20 10:10:00',
    }));
    await flush();
    expect(fixture.coordinator.getState().nextCheckAt)
      .toBe('2026-10-20 10:11:05');
    expect(fixture.clock.timerCount()).toBe(1);
  });

  it('isolates late old-instrument results and gives scheduling ownership to the new instrument', async () => {
    const oldGate = deferred<MarketUpdateState>();
    const update = vi.fn((
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => instrument === 'main_continuous'
      ? oldGate.promise
      : Promise.resolve(successfulState(instrument, intent)));
    const fixture = setup(update);

    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    fixture.coordinator.declareCurrentInstrument('rebar_main');
    await flush();

    expect(update.mock.calls).toEqual([
      ['main_continuous', 'full'],
      ['rebar_main', 'full'],
    ]);
    expect(fixture.coordinator.getState()).toMatchObject({
      instrument: 'rebar_main',
      phase: 'waiting',
    });

    oldGate.resolve(successfulState('main_continuous', 'full', {
      sourceLatestAt: '2026-10-20 10:30:00',
      localMinuteLatestAt: '2026-10-20 10:30:00',
    }));
    await flush();

    expect(fixture.coordinator.getState()).toMatchObject({
      instrument: 'rebar_main',
      sourceLatestAt: '2026-10-20 10:05:00',
    });
    expect(fixture.clock.timerCount()).toBe(1);
  });

  it('distinguishes reliable same-session source delay from breaks and weekends', async () => {
    expect(isReliablySourceDelayed(
      'main_continuous',
      '2026-10-20 10:03:00',
      '2026-10-20 10:05:00',
    )).toBe(true);
    expect(isReliablySourceDelayed(
      'main_continuous',
      '2026-10-20 10:15:00',
      '2026-10-20 10:30:00',
    )).toBe(false);
    expect(isReliablySourceDelayed(
      'main_continuous',
      '2026-10-16 15:00:00',
      '2026-10-19 09:01:00',
    )).toBe(false);

    const update = vi.fn(async (
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => successfulState(instrument, intent, {
      localMinuteLatestAt: '2026-10-20 10:03:00',
      sourceLatestAt: '2026-10-20 10:03:00',
      requestEndAt: '2026-10-20 10:05:00',
    }));
    const fixture = setup(update);
    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    await flush();

    expect(fixture.coordinator.getState()).toMatchObject({
      phase: 'source-delayed',
      sourceLatestAt: '2026-10-20 10:03:00',
      error: undefined,
    });
  });

  it('degrades on update errors and retries with full after the next boundary', async () => {
    const update = vi.fn(async (
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => update.mock.calls.length === 1
      ? {
          instrument,
          intent,
          phase: 'failed',
          error: {
            code: 'network',
            message: '无法连接 EDB 数据源，请稍后重试',
          },
        } as MarketUpdateState
      : successfulState(instrument, intent));
    const fixture = setup(update);

    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    await flush();
    expect(fixture.coordinator.getState()).toMatchObject({
      phase: 'degraded',
      error: { code: 'network' },
      nextCheckAt: '2026-10-20 10:05:05',
    });

    fixture.clock.advanceTo('2026-10-20 10:05:05');
    await flush();
    expect(update).toHaveBeenLastCalledWith('main_continuous', 'full');
    expect(fixture.coordinator.getState().phase).toBe('waiting');
  });

  it('forces a fresh full gate on network recovery and resume', async () => {
    const update = vi.fn(async (
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => successfulState(instrument, intent));
    const fixture = setup(update);
    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    await flush();

    fixture.coordinator.networkRecovered();
    await flush();
    fixture.coordinator.resume();
    await flush();

    expect(update.mock.calls.map(call => call[1])).toEqual([
      'full',
      'full',
      'full',
    ]);
    expect(fixture.clock.timerCount()).toBe(1);
  });

  it('cancels timers and suppresses late publications after disable or dispose', async () => {
    const tail = deferred<MarketUpdateState>();
    const update = vi.fn((
      instrument: Instrument,
      intent: MarketUpdateIntent,
    ) => intent === 'full'
      ? Promise.resolve(successfulState(instrument, intent))
      : tail.promise);
    const fixture = setup(update);
    fixture.coordinator.declareCurrentInstrument('main_continuous');
    fixture.coordinator.setEnabled(true);
    await flush();

    fixture.clock.advanceTo('2026-10-20 10:05:05');
    await flush();
    const publicationCount = fixture.published.length;
    fixture.coordinator.setEnabled(false);
    expect(fixture.clock.timerCount()).toBe(0);

    tail.resolve(successfulState('main_continuous', 'tail'));
    await flush();
    expect(fixture.coordinator.getState().phase).toBe('disabled');
    expect(fixture.published).toHaveLength(publicationCount + 1);

    fixture.coordinator.dispose();
    fixture.clock.advanceTo('2026-10-20 10:20:00');
    await flush();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('online minute scheduling', () => {
  it('always returns the next minute boundary plus the configured grace', () => {
    expect(nextBeijingMinuteCheckMs(
      parseBeijing('2026-10-20 09:59:59'),
    )).toBe(parseBeijing('2026-10-20 10:00:05'));
    expect(nextBeijingMinuteCheckMs(
      parseBeijing('2026-10-20 10:00:05'),
    )).toBe(parseBeijing('2026-10-20 10:01:05'));
  });
});
