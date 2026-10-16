import { describe, expect, it, vi } from 'vitest';
import { aggregateMinutes, parseEdbMinuteCsv } from '../src/domain/market-data';
import { parseBeijing } from '../src/domain/time';
import { MarketUpdateCoordinator, requestStartFor } from '../src/main/market-update-coordinator';
import type { EdbMinuteRecord, MainContractMapping } from '../src/shared/types';

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
const initial = {
  source: 'builtin' as const,
  directory: 'baseline',
  bars1: minutes.slice(0, 60),
  bars5: aggregateMinutes(minutes.slice(0, 60), 5),
  bars60: aggregateMinutes(minutes.slice(0, 60), 60),
  rollovers: [],
  sourceLatestAt: '2026-10-09 10:00:00',
};

function setup(
  remote = minutes,
  mappings: MainContractMapping[] = [{ tradingDate: '2026-10-09', contract: 'm2701' }],
) {
  const published: string[] = [];
  const loadSnapshot = vi.fn(async () => initial);
  const fetchMinutes = vi.fn(async () => remote);
  const fetchContractMappings = vi.fn(async () => mappings);
  const invalidate = vi.fn();
  const saveSnapshot = vi.fn(async candidate => ({
    source: 'user' as const,
    directory: 'snapshot',
    bars1: candidate.bars1,
    bars5: candidate.bars5,
    bars60: candidate.bars60,
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
    publish: state => published.push(state.phase),
    now: () => new Date('2026-10-15T04:00:00.000Z'),
  });
  return {
    coordinator,
    loadSnapshot,
    fetchMinutes,
    fetchContractMappings,
    saveSnapshot,
    invalidate,
    published,
  };
}

describe('market update coordinator', () => {
  it('starts from a safe overlap before the last local minute and uses a year when minutes are absent', () => {
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
      .toBe(requestEnd - 366 * 24 * 60 * 60_000);
  });

  it('merges duplicate triggers into one network operation and publishes all phases', async () => {
    const fixture = setup();
    let release!: () => void;
    fixture.fetchMinutes.mockImplementation(() => new Promise(resolve => {
      release = () => resolve(minutes);
    }));
    const first = fixture.coordinator.update();
    const second = fixture.coordinator.update();
    await Promise.resolve();
    expect(fixture.fetchMinutes).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({
      phase: 'succeeded',
      counts: { added1: 60, added5: 12, added60: 1 },
      sourceLatestAt: '2026-10-09 11:15:00',
    });
    expect(fixture.published).toEqual(['fetching', 'validating', 'saving', 'succeeded']);
    expect(fixture.invalidate).toHaveBeenCalledOnce();
  });

  it('saves when only the reconstructed rollover mapping changes', async () => {
    const fixture = setup(minutes.slice(0, 60), [
      { tradingDate: '2026-10-08', contract: 'm2609' },
      { tradingDate: '2026-10-09', contract: 'm2701' },
    ]);
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
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
    expect(fixture.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      rollovers: [expect.objectContaining({
        tradingDate: '2026-10-09',
        time: '2026-10-09 09:00:00',
        fromContract: 'm2609',
        toContract: 'm2701',
      })],
    }));
  });

  it('reports up-to-date without writing a duplicate snapshot', async () => {
    const fixture = setup(minutes.slice(0, 60));
    await expect(fixture.coordinator.update()).resolves.toMatchObject({ phase: 'up-to-date' });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
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
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
      phase: 'succeeded',
      counts: { added1: 60, replaced1: 1, removed1: 0 },
    });
    const saved = fixture.saveSnapshot.mock.calls[0][0];
    expect(saved.bars1[0]).toEqual(old[0]);
    expect(saved.bars1.at(-1)?.start).toBe(minutes.at(-1)?.start);
  });

  it('rejects a non-overlapping remote minute window and preserves the current snapshot', async () => {
    const fixture = setup(minutes.slice(0, 30));
    fixture.fetchMinutes.mockResolvedValue(records(['2026-10-15 09:00:00']));
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it('rejects invalid minute or rebuilt-period candidates without saving', async () => {
    const fixture = setup();
    fixture.fetchMinutes.mockResolvedValue([
      minutes[0],
      { ...minutes[1], startMs: minutes[0].startMs },
    ]);
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
  });

  it('does not save when contract mapping validation fails', async () => {
    const fixture = setup();
    fixture.fetchContractMappings.mockRejectedValue(new Error('主连日线具体合约匹配存在歧义'));
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
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
    const state = await fixture.coordinator.update();
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
    await expect(fixture.coordinator.update()).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'validation' },
    });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});
