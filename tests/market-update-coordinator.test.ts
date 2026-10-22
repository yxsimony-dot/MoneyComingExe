import { describe, expect, it, vi } from 'vitest';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  parseEdbMinuteCsv,
} from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import { EdbClientError } from '../src/main/edb-client';
import { MarketUpdateCoordinator, requestStartFor } from '../src/main/market-update-coordinator';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
  type InstrumentDefinition,
} from '../src/shared/instruments';
import type { LoadedMarketSnapshot, SnapshotCandidate } from '../src/main/market-snapshot';
import type {
  EdbMinuteRecord,
  MainContractMapping,
  MarketSnapshotActivatedEvent,
  MarketUpdateIntent,
  MarketUpdateState,
} from '../src/shared/types';

const HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const nano = (time: string) => String(BigInt(parseBeijing(time)) * 1_000_000n);
function records(times: string[]): EdbMinuteRecord[] {
  return parseEdbMinuteCsv([
    HEADER,
    ...times.map((time, index) => `${nano(time)},${100 + index},${102 + index},${99 + index},${101 + index},10,1000,1001`),
  ].join('\n'));
}
const minuteTimes = [
  ...Array.from({ length: 75 }, (_, index) => {
    const total = 9 * 60 + index;
    return `2026-10-09 ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
  }),
  ...Array.from({ length: 45 }, (_, index) => {
    const total = 10 * 60 + 30 + index;
    return `2026-10-09 ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
  }),
];
const minutes = records(minuteTimes);
const previousMinutes = records(minuteTimes.map(time => time.replace(
  '2026-10-09',
  '2026-10-08',
)));
const initial: LoadedMarketSnapshot = {
  source: 'builtin' as const,
  directory: 'baseline',
  bars1: minutes.slice(0, 60),
  bars5: aggregateMinutes(minutes.slice(0, 60), 5),
  bars60: aggregateMinutes(minutes.slice(0, 60), 60),
  mainContractMappings: [{ tradingDate: '2026-10-09', contract: 'm2701' }],
  rollovers: [],
  sourceLatestAt: '2026-10-09 10:00:00',
};
const longPeriodSnapshot: LoadedMarketSnapshot = {
  ...initial,
  bars5: [
    ...aggregateMinutes(previousMinutes, 5),
    ...initial.bars5,
  ],
  bars60: aggregateFiveMinuteBars([
    ...aggregateMinutes(previousMinutes, 5),
    ...initial.bars5,
  ]).filter(bar => bar.complete),
};

interface SetupOptions {
  now?: () => Date;
  publishActivation?: (event: MarketSnapshotActivatedEvent) => void;
}

function setup(
  remote = minutes,
  mappings: MainContractMapping[] = [{ tradingDate: '2026-10-09', contract: 'm2701' }],
  options: SetupOptions = {},
) {
  const published: string[] = [];
  const publishedStates: MarketUpdateState[] = [];
  const publishActivation = options.publishActivation ?? vi.fn();
  const loadSnapshot = vi.fn(async (
    _definition: InstrumentDefinition,
  ): Promise<LoadedMarketSnapshot> => initial);
  const fetchMinutes = vi.fn(async (
    _definition: InstrumentDefinition,
    _startMs: number,
    _endMs: number,
  ) => remote);
  const fetchContractMappings = vi.fn(async (
    _definition: InstrumentDefinition,
    _startMs: number,
    _endMs: number,
  ) => mappings);
  const invalidate = vi.fn();
  const saveSnapshot = vi.fn(async (
    _definition: InstrumentDefinition,
    candidate: SnapshotCandidate,
  ): Promise<LoadedMarketSnapshot> => ({
    source: 'user' as const,
    directory: 'snapshot',
    bars1: candidate.bars1,
    bars5: candidate.bars5,
    bars60: candidate.bars60,
    mainContractMappings: candidate.mainContractMappings,
    rollovers: candidate.rollovers,
    sourceLatestAt: candidate.sourceLatestAt,
    snapshotUpdatedAt: '2026-10-15T04:00:00.000Z',
  }));
  const coordinator = new MarketUpdateCoordinator({
    loadSnapshot,
    fetchMinutes,
    fetchContractMappings,
    saveSnapshot,
    invalidate,
    publish: state => {
      published.push(`${state.instrument}:${state.phase}`);
      publishedStates.push(structuredClone(state));
    },
    publishActivation,
    now: options.now ?? (() => new Date('2026-10-15T04:00:00.000Z')),
  });
  return {
    coordinator,
    loadSnapshot,
    fetchMinutes,
    fetchContractMappings,
    saveSnapshot,
    invalidate,
    publishActivation,
    published,
    publishedStates,
  };
}

describe('market update coordinator', () => {
  it('starts from a safe overlap before the last local minute or five-minute bar', () => {
    expect(requestStartFor(initial)).toBe(parseBeijing('2026-10-08 00:00:00'));
    const monday = {
      ...initial,
      bars1: records(['2026-10-12 09:00:00']),
      bars5: initial.bars5.map((bar, index) => ({
        ...bar,
        startMs: parseBeijing('2026-10-12 09:00:00') + index * 5 * 60_000,
      })),
      bars60: initial.bars60.map((bar, index) => ({
        ...bar,
        startMs: parseBeijing('2026-10-12 09:00:00') + index * 60 * 60_000,
      })),
    };
    expect(requestStartFor(monday)).toBe(parseBeijing('2026-10-11 00:00:00'));
    const requestEnd = parseBeijing('2026-10-15 12:00:00');
    expect(requestStartFor({ ...initial, bars1: [] }, requestEnd))
      .toBe(parseBeijing('2026-10-08 00:00:00'));
    expect(requestStartFor({
      ...initial,
      bars1: [],
      bars5: [],
      bars60: [],
    }, requestEnd)).toBe(requestEnd - 366 * 24 * 60 * 60_000);
  });

  it('updates a long five-minute snapshot without minute history and omits a fake 1970 state', async () => {
    const fixture = setup();
    fixture.loadSnapshot.mockResolvedValue({
      ...longPeriodSnapshot,
      bars1: [],
    });

    await expect(
      fixture.coordinator.update('main_continuous'),
    ).resolves.toMatchObject({
      phase: 'succeeded',
      requestStartAt: '2026-10-08 00:00:00',
      localLatestAt: '2026-10-09 11:15:00',
      localMinuteLatestAt: '2026-10-09 11:15:00',
      counts: {
        removed5: 0,
        removed60: 0,
      },
    });

    expect(fixture.published[0]).toBe('main_continuous:fetching');
    expect(fixture.publishedStates[0]).toMatchObject({
      localLatestAt: '2026-10-09 10:00:00',
      localMinuteLatestAt: undefined,
    });
    expect(JSON.stringify(fixture.publishedStates[0])).not.toContain('1970');
    const saved = fixture.saveSnapshot.mock.calls[0][1];
    expect(saved.bars5[0]).toEqual(longPeriodSnapshot.bars5[0]);
    expect(saved.bars60).toEqual(
      aggregateFiveMinuteBars(saved.bars5).filter(bar => bar.complete),
    );
  });

  it('starts tail updates at the previous complete 60-minute bucket', () => {
    const complete = {
      ...initial,
      bars1: minutes,
      bars5: aggregateMinutes(minutes, 5),
      bars60: aggregateMinutes(minutes, 60),
    };
    expect(complete.bars60).toHaveLength(2);
    expect(requestStartFor(
      complete,
      parseBeijing('2026-10-09 11:16:00'),
      'tail',
    )).toBe(complete.bars60[0].startMs);
  });

  it('defaults manual updates to full intent and exposes the actual request bounds', async () => {
    const fixture = setup(minutes.slice(0, 60));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'up-to-date',
      intent: 'full',
      requestStartAt: '2026-10-08 00:00:00',
      requestEndAt: '2026-10-15 12:00:00',
      localMinuteLatestAt: '2026-10-09 10:00:00',
      sourceLatestAt: '2026-10-09 10:00:00',
    });
  });

  it('excludes a forming minute at the request boundary', async () => {
    const forming = records(['2026-10-09 10:01:00']);
    const fixture = setup(
      [...minutes.slice(0, 61), ...forming],
      [{ tradingDate: '2026-10-09', contract: 'm2701' }],
      { now: () => new Date('2026-10-09T02:01:30.000Z') },
    );

    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'succeeded',
      requestEndAt: '2026-10-09 10:01:00',
      sourceLatestAt: '2026-10-09 10:01:00',
      counts: { added1: 1 },
    });

    const saved = fixture.saveSnapshot.mock.calls[0][1];
    expect(saved.bars1.at(-1)?.start).toBe('2026-10-09 10:00:00');
    expect(saved.bars1).not.toContainEqual(expect.objectContaining({
      start: '2026-10-09 10:01:00',
    }));
  });

  it.each(['full', 'tail'] as const)(
    'preserves long 5/60-minute history when a %s update only has a recent minute tail',
    async (intent: MarketUpdateIntent) => {
      const fixture = setup();
      fixture.loadSnapshot.mockResolvedValue(longPeriodSnapshot);

      await expect(
        fixture.coordinator.update('main_continuous', intent),
      ).resolves.toMatchObject({
        phase: 'succeeded',
        counts: {
          removed5: 0,
          removed60: 0,
        },
      });

      const saved = fixture.saveSnapshot.mock.calls[0][1];
      expect(saved.bars5[0]).toEqual(longPeriodSnapshot.bars5[0]);
      expect(saved.bars60[0]).toEqual(longPeriodSnapshot.bars60[0]);
      expect(saved.bars5.at(-1)!.endMs)
        .toBeGreaterThanOrEqual(longPeriodSnapshot.bars5.at(-1)!.endMs);
      expect(saved.bars60.at(-1)!.endMs)
        .toBeGreaterThanOrEqual(longPeriodSnapshot.bars60.at(-1)!.endMs);
      expect(saved.bars5.at(-1)!.endMs - saved.bars5[0].startMs)
        .toBeGreaterThanOrEqual(
          longPeriodSnapshot.bars5.at(-1)!.endMs
            - longPeriodSnapshot.bars5[0].startMs,
        );
      expect(saved.bars60.at(-1)!.endMs - saved.bars60[0].startMs)
        .toBeGreaterThanOrEqual(
          longPeriodSnapshot.bars60.at(-1)!.endMs
            - longPeriodSnapshot.bars60[0].startMs,
        );
    },
  );

  it('stores an added closed minute without publishing incomplete 5/60-minute bars', async () => {
    const fixture = setup(minutes.slice(0, 61));
    await expect(
      fixture.coordinator.update('main_continuous', 'tail'),
    ).resolves.toMatchObject({
      phase: 'succeeded',
      counts: {
        added1: 1,
        added5: 0,
        added60: 0,
      },
    });

    const saved = fixture.saveSnapshot.mock.calls[0][1];
    expect(saved.bars1).toHaveLength(61);
    expect(saved.bars5).toEqual(initial.bars5);
    expect(saved.bars60).toEqual(initial.bars60);
    expect(saved.bars5.every(bar => bar.complete)).toBe(true);
    expect(saved.bars60.every(bar => bar.complete)).toBe(true);
  });

  it('merges duplicate triggers into one network operation and publishes all phases', async () => {
    const fixture = setup();
    let release!: () => void;
    fixture.fetchMinutes.mockImplementation(() => new Promise(resolve => {
      release = () => resolve(minutes);
    }));
    const first = fixture.coordinator.update('main_continuous');
    const second = fixture.coordinator.update('main_continuous');
    await Promise.resolve();
    expect(fixture.fetchMinutes).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({
      phase: 'succeeded',
      counts: { added1: 60, added5: 12, added60: 1 },
      sourceLatestAt: '2026-10-09 11:15:00',
    });
    expect(fixture.published).toEqual([
      'main_continuous:fetching',
      'main_continuous:validating',
      'main_continuous:saving',
      'main_continuous:succeeded',
    ]);
    expect(fixture.invalidate).toHaveBeenCalledWith('main_continuous');
    expect(fixture.loadSnapshot).toHaveBeenCalledWith(DEFAULT_INSTRUMENT);
    expect(fixture.fetchMinutes).toHaveBeenCalledWith(
      DEFAULT_INSTRUMENT,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('queues one full update behind a running tail and never writes candidates concurrently', async () => {
    const fixture = setup();
    let releaseTail!: () => void;
    let fetchCalls = 0;
    fixture.fetchMinutes.mockImplementation(() => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise(resolve => {
          releaseTail = () => resolve(minutes);
        });
      }
      return Promise.resolve(minutes);
    });
    let activeSaves = 0;
    let maximumActiveSaves = 0;
    fixture.saveSnapshot.mockImplementation(async (
      _definition: InstrumentDefinition,
      candidate: SnapshotCandidate,
    ) => {
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      await Promise.resolve();
      activeSaves -= 1;
      return {
        source: 'user',
        directory: 'snapshot',
        bars1: candidate.bars1,
        bars5: candidate.bars5,
        bars60: candidate.bars60,
        mainContractMappings: candidate.mainContractMappings,
        rollovers: candidate.rollovers,
        sourceLatestAt: candidate.sourceLatestAt,
        snapshotUpdatedAt: `2026-10-15T04:00:0${fetchCalls}.000Z`,
      };
    });

    const tail = fixture.coordinator.update('main_continuous', 'tail');
    const reusedTail = fixture.coordinator.update('main_continuous', 'tail');
    const full = fixture.coordinator.update('main_continuous', 'full');
    const reusedFull = fixture.coordinator.update('main_continuous', 'full');

    expect(reusedTail).toBe(tail);
    expect(reusedFull).toBe(full);
    expect(full).not.toBe(tail);
    await vi.waitFor(() => {
      expect(fixture.fetchMinutes).toHaveBeenCalledTimes(1);
    });

    releaseTail();
    await expect(tail).resolves.toMatchObject({ intent: 'tail', phase: 'succeeded' });
    await expect(full).resolves.toMatchObject({ intent: 'full', phase: 'succeeded' });
    expect(fixture.fetchMinutes).toHaveBeenCalledTimes(2);
    expect(fixture.saveSnapshot).toHaveBeenCalledTimes(2);
    expect(maximumActiveSaves).toBe(1);
  });

  it('saves when only the reconstructed rollover mapping changes', async () => {
    const fixture = setup(minutes.slice(0, 60), [
      { tradingDate: '2026-10-08', contract: 'm2609' },
      { tradingDate: '2026-10-09', contract: 'm2701' },
    ]);
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      instrument: 'main_continuous',
      phase: 'succeeded',
      counts: {
        added1: 0,
        added5: 0,
        added60: 0,
        addedRollovers: 1,
        replacedRollovers: 0,
        removedRollovers: 0,
      },
    });
    expect(fixture.saveSnapshot).toHaveBeenCalledWith(
      DEFAULT_INSTRUMENT,
      expect.objectContaining({
      mainContractMappings: [
        { tradingDate: '2026-10-08', contract: 'm2609' },
        { tradingDate: '2026-10-09', contract: 'm2701' },
      ],
      rollovers: [expect.objectContaining({
        tradingDate: '2026-10-09',
        time: '2026-10-09 09:00:00',
        fromContract: 'm2609',
        toContract: 'm2701',
      })],
      }),
      'full',
      initial,
    );
  });

  it('reuses same-day tail mappings but refreshes them after the Beijing date changes', async () => {
    let now = new Date('2026-10-15T04:00:00.000Z');
    const fixture = setup(
      minutes.slice(0, 60),
      [{ tradingDate: '2026-10-09', contract: 'm2701' }],
      { now: () => now },
    );

    await fixture.coordinator.update('main_continuous', 'tail');
    await fixture.coordinator.update('main_continuous', 'tail');
    expect(fixture.fetchContractMappings).toHaveBeenCalledTimes(1);

    now = new Date('2026-10-16T04:00:00.000Z');
    await fixture.coordinator.update('main_continuous', 'tail');
    expect(fixture.fetchContractMappings).toHaveBeenCalledTimes(2);
  });

  it('retries a tail mapping refresh after the previous refresh failed', async () => {
    const fixture = setup(minutes.slice(0, 60));
    fixture.fetchContractMappings.mockRejectedValueOnce(
      new Error('主连日线具体合约匹配失败'),
    );

    await expect(
      fixture.coordinator.update('main_continuous', 'tail'),
    ).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    await expect(
      fixture.coordinator.update('main_continuous', 'tail'),
    ).resolves.toMatchObject({
      phase: 'up-to-date',
    });
    expect(fixture.fetchContractMappings).toHaveBeenCalledTimes(2);
  });

  it('refreshes same-day tail mappings when the latest trading date is missing', async () => {
    const fixture = setup(minutes.slice(0, 60));
    await fixture.coordinator.update('main_continuous', 'tail');
    fixture.loadSnapshot.mockResolvedValue({
      ...initial,
      mainContractMappings: [],
    });

    await expect(
      fixture.coordinator.update('main_continuous', 'tail'),
    ).resolves.toMatchObject({
      phase: 'succeeded',
    });
    expect(fixture.fetchContractMappings).toHaveBeenCalledTimes(2);
    expect(fixture.saveSnapshot).toHaveBeenCalledWith(
      DEFAULT_INSTRUMENT,
      expect.objectContaining({
        mainContractMappings: [
          { tradingDate: '2026-10-09', contract: 'm2701' },
        ],
      }),
      'tail',
      expect.objectContaining({
        mainContractMappings: [],
      }),
    );
  });

  it('reports up-to-date without writing a duplicate snapshot', async () => {
    const fixture = setup(minutes.slice(0, 60));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      instrument: 'main_continuous',
      phase: 'up-to-date',
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
  });

  it('preserves historical contract mappings outside the fetched overlap', async () => {
    const fixture = setup(minutes.slice(0, 60), [
      { tradingDate: '2026-10-09', contract: 'm2701' },
      { tradingDate: '2026-10-10', contract: 'm2701' },
    ]);
    fixture.loadSnapshot.mockResolvedValue({
      ...initial,
      mainContractMappings: [
        { tradingDate: '2026-09-30', contract: 'm2701' },
        { tradingDate: '2026-10-09', contract: 'm2701' },
      ],
    });

    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'succeeded',
    });

    expect(fixture.saveSnapshot).toHaveBeenCalledWith(
      DEFAULT_INSTRUMENT,
      expect.objectContaining({
        mainContractMappings: [
          { tradingDate: '2026-09-30', contract: 'm2701' },
          { tradingDate: '2026-10-09', contract: 'm2701' },
          { tradingDate: '2026-10-10', contract: 'm2701' },
        ],
      }),
      'full',
      expect.objectContaining({
        mainContractMappings: [
          { tradingDate: '2026-09-30', contract: 'm2701' },
          { tradingDate: '2026-10-09', contract: 'm2701' },
        ],
      }),
    );
  });

  it('preserves minutes outside the remote rolling window while revising overlap and appending', async () => {
    const old = records(['2026-10-08 21:00:00']);
    const local = [...old, ...minutes.slice(0, 60)];
    const fixture = setup([
      { ...minutes[59], close: minutes[59].close + 0.25, high: minutes[59].high + 0.25 },
      ...minutes.slice(60),
    ]);
    fixture.loadSnapshot.mockResolvedValue({
      ...initial,
      bars1: local,
    });
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'succeeded',
      counts: { added1: 60, replaced1: 1, removed1: 0 },
    });
    const saved = fixture.saveSnapshot.mock.calls[0][1];
    expect(saved.bars1[0]).toEqual(old[0]);
    expect(saved.bars1.at(-1)?.start).toBe(minutes.at(-1)?.start);
  });

  it('rejects a non-overlapping remote minute window and preserves the current snapshot', async () => {
    const fixture = setup(minutes.slice(0, 30));
    fixture.fetchMinutes.mockResolvedValue(records(['2026-10-15 09:00:00']));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['network', new EdbClientError('network', 'EDB 请求超时')],
    ['invalid-response', new EdbClientError('invalid-response', 'EDB 响应缺少列')],
  ] as const)('keeps the active snapshot on %s failures', async (code, error) => {
    const fixture = setup();
    fixture.fetchMinutes.mockRejectedValue(error);
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.publishActivation).not.toHaveBeenCalled();
  });

  it('rejects invalid minute or rebuilt-period candidates without saving', async () => {
    const fixture = setup();
    fixture.fetchMinutes.mockResolvedValue([
      minutes[0],
      { ...minutes[1], startMs: minutes[0].startMs },
    ]);
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a candidate whose rebuilt periods would shorten the active history', async () => {
    const fixture = setup(minutes.slice(0, 60));
    fixture.loadSnapshot.mockResolvedValue({
      ...initial,
      bars5: aggregateMinutes(minutes, 5),
      bars60: aggregateMinutes(minutes, 60),
    });

    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.publishActivation).not.toHaveBeenCalled();
  });

  it('does not save when contract mapping validation fails', async () => {
    const fixture = setup();
    fixture.fetchContractMappings.mockRejectedValue(new Error('主连日线具体合约匹配存在歧义'));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it('publishes a fixed public failure without paths, URLs, response bodies, or stacks', async () => {
    const fixture = setup();
    const error = new Error('EDB response body: secret-token at C:\\Users\\name\\secret.txt https://edb.shinnytech.com/private');
    error.stack = 'STACK C:\\Users\\name\\source.ts:99 secret-token';
    fixture.fetchMinutes.mockRejectedValue(error);
    const state = await fixture.coordinator.update('main_continuous');
    expect(state.phase).toBe('failed');
    expect(state.error).toEqual({
      code: 'validation',
      message: 'EDB 行情校验失败，当前数据未受影响',
    });
    expect(JSON.stringify(state)).not.toMatch(/Users|https:\/\/|secret-token|STACK|response body/);
  });

  it('does not save or invalidate when the EDB history boundary interrupts a later chunk', async () => {
    const fixture = setup();
    fixture.fetchMinutes.mockRejectedValue(new Error('EDB history boundary'));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it('reports storage failure and keeps the current cache active when saving fails', async () => {
    const fixture = setup();
    fixture.saveSnapshot.mockRejectedValue(new Error('快照目录写入失败'));
    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      instrument: 'main_continuous',
      phase: 'failed',
      error: { code: 'storage' },
    });
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it('publishes activation only after a changed snapshot is saved and invalidated', async () => {
    const publishActivation = vi.fn();
    const fixture = setup(
      minutes,
      [{ tradingDate: '2026-10-09', contract: 'm2701' }],
      { publishActivation },
    );

    await expect(fixture.coordinator.update('main_continuous')).resolves.toMatchObject({
      phase: 'succeeded',
    });
    expect(publishActivation).toHaveBeenCalledWith({
      instrument: 'main_continuous',
      snapshotUpdatedAt: '2026-10-15T04:00:00.000Z',
      counts: expect.objectContaining({
        added1: 60,
        added5: 12,
        added60: 1,
      }),
      mappingsChanged: false,
    });
    expect(fixture.invalidate.mock.invocationCallOrder[0])
      .toBeLessThan(publishActivation.mock.invocationCallOrder[0]);
  });

  it('does not publish activation for unchanged data or save failures', async () => {
    const unchanged = setup(minutes.slice(0, 60));
    await unchanged.coordinator.update('main_continuous');
    expect(unchanged.publishActivation).not.toHaveBeenCalled();

    const failedSave = setup();
    failedSave.saveSnapshot.mockRejectedValue(new Error('快照目录写入失败'));
    await failedSave.coordinator.update('main_continuous');
    expect(failedSave.publishActivation).not.toHaveBeenCalled();
  });

  it('keeps different instrument operations, phases, errors, and cutoffs isolated', async () => {
    const fixture = setup();
    let releaseSoymeal!: () => void;
    fixture.loadSnapshot.mockImplementation(async definition => ({
      ...initial,
      mainContractMappings: definition.id === 'main_continuous'
        ? initial.mainContractMappings
        : [],
    }));
    fixture.fetchMinutes.mockImplementation(definition => {
      if (definition.id === 'rebar_main') {
        return Promise.reject(new Error('EDB 螺纹钢行情校验失败'));
      }
      return new Promise(resolve => {
        releaseSoymeal = () => resolve(minutes);
      });
    });

    const soymeal = fixture.coordinator.update('main_continuous');
    const rebar = fixture.coordinator.update('rebar_main');
    await expect(rebar).resolves.toMatchObject({
      instrument: 'rebar_main',
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.coordinator.getState('main_continuous')).toMatchObject({
      instrument: 'main_continuous',
      phase: 'fetching',
      sourceLatestAt: undefined,
    });
    expect(fixture.coordinator.getState('rebar_main').error).toBeDefined();

    releaseSoymeal();
    await expect(soymeal).resolves.toMatchObject({
      instrument: 'main_continuous',
      phase: 'succeeded',
      sourceLatestAt: '2026-10-09 11:15:00',
    });
    expect(fixture.coordinator.getState('rebar_main')).toMatchObject({
      instrument: 'rebar_main',
      phase: 'failed',
    });
  });

  it('updates all instruments serially and continues after a failed result', async () => {
    const fixture = setup();
    let active = 0;
    let maximumActive = 0;
    const order: Array<[string, MarketUpdateIntent | undefined]> = [];
    vi.spyOn(fixture.coordinator, 'update').mockImplementation(async (
      instrument,
      intent,
    ) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push([instrument, intent]);
      await Promise.resolve();
      active -= 1;
      return {
        instrument,
        phase: instrument === 'rebar_main' ? 'failed' : 'succeeded',
        error: instrument === 'rebar_main'
          ? { code: 'validation', message: '校验失败' }
          : undefined,
      } as MarketUpdateState;
    });

    const result = await fixture.coordinator.updateAll([
      'main_continuous',
      'rebar_main',
      'pvc_main',
    ]);
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      ['main_continuous', 'full'],
      ['rebar_main', 'full'],
      ['pvc_main', 'full'],
    ]);
    expect(result.results.map(state => [state.instrument, state.phase])).toEqual([
      ['main_continuous', 'succeeded'],
      ['rebar_main', 'failed'],
      ['pvc_main', 'succeeded'],
    ]);
    expect(result.startedAt).toBe('2026-10-15T04:00:00.000Z');
    expect(result.completedAt).toBe('2026-10-15T04:00:00.000Z');
  });

  it('passes the selected definition to storage and EDB operations', async () => {
    const fixture = setup(minutes.slice(0, 60), []);
    fixture.loadSnapshot.mockResolvedValue({
      ...initial,
      mainContractMappings: [],
    });
    await fixture.coordinator.update('rebar_main');
    expect(fixture.loadSnapshot).toHaveBeenCalledWith(
      INSTRUMENT_DEFINITIONS.rebar_main,
    );
    expect(fixture.fetchMinutes).toHaveBeenCalledWith(
      INSTRUMENT_DEFINITIONS.rebar_main,
      expect.any(Number),
      expect.any(Number),
    );
    expect(fixture.fetchContractMappings).toHaveBeenCalledWith(
      INSTRUMENT_DEFINITIONS.rebar_main,
      expect.any(Number),
      expect.any(Number),
    );
  });
});
