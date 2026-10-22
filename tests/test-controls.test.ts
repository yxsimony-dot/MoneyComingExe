import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestClock,
  readTestControls,
} from '../src/main/test-controls';

afterEach(() => {
  vi.useRealTimers();
});

describe('test controls', () => {
  it('ignores all explicit controls outside test mode', () => {
    expect(readTestControls(false, {
      MONEYCOMING_TEST_BUILTIN_DATA: 'C:\\fixtures',
      MONEYCOMING_TEST_LOAD_FAILURES: '{"rebar_main":"failed"}',
      MONEYCOMING_TEST_NOW: '2026-10-20T08:00:00.000Z',
    })).toEqual({
      loadDelays: {},
      loadFailures: {},
      edbDelays: {},
      edbFailures: {},
      edbPriceOffsets: {},
    });
  });

  it('parses per-instrument controls in test mode', () => {
    expect(readTestControls(true, {
      MONEYCOMING_TEST_BUILTIN_DATA: ' C:\\fixtures ',
      MONEYCOMING_TEST_LOAD_DELAYS: '{"rebar_main":250}',
      MONEYCOMING_TEST_LOAD_FAILURES: '{"glass_main":" fixture unavailable "}',
      MONEYCOMING_TEST_EDB_DELAYS: '{"pvc_main":100}',
      MONEYCOMING_TEST_EDB_FAILURES: '{"corn_main":"offline"}',
      MONEYCOMING_TEST_EDB_PRICE_OFFSETS: '{"palm_oil_main":120.5}',
      MONEYCOMING_TEST_NOW: '2026-10-20T08:00:00.000Z',
      MONEYCOMING_TEST_ONLINE_CLOCK_RATE: '60',
    })).toEqual({
      builtinDataDirectory: 'C:\\fixtures',
      now: new Date('2026-10-20T08:00:00.000Z'),
      onlineClockRate: 60,
      loadDelays: { rebar_main: 250 },
      loadFailures: { glass_main: 'fixture unavailable' },
      edbDelays: { pvc_main: 100 },
      edbFailures: { corn_main: 'offline' },
      edbPriceOffsets: { palm_oil_main: 120.5 },
    });
  });

  it('rejects malformed, unknown and out-of-range controls', () => {
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_LOAD_DELAYS: '[]',
    })).toThrow('MONEYCOMING_TEST_LOAD_DELAYS 必须是 JSON 对象');
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_LOAD_DELAYS: '{"unknown":1}',
    })).toThrow('MONEYCOMING_TEST_LOAD_DELAYS 包含未知品种：unknown');
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_EDB_DELAYS: '{"rebar_main":60001}',
    })).toThrow('MONEYCOMING_TEST_EDB_DELAYS.rebar_main 数值无效');
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_EDB_FAILURES: '{"rebar_main":true}',
    })).toThrow('MONEYCOMING_TEST_EDB_FAILURES.rebar_main 必须是非空错误消息');
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_NOW: 'not-a-date',
    })).toThrow('MONEYCOMING_TEST_NOW 必须是有效日期时间');
    expect(() => readTestControls(true, {
      MONEYCOMING_TEST_ONLINE_CLOCK_RATE: '0',
    })).toThrow('MONEYCOMING_TEST_ONLINE_CLOCK_RATE 数值无效');
  });

  it('accelerates online time and scales one-shot timers together', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    const clock = createTestClock({
      now: new Date('2026-10-12T01:55:04.000Z'),
      onlineClockRate: 60,
    });
    const callback = vi.fn();

    const timer = clock.setTimer!(callback, 60_000);
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    expect(clock.now!().toISOString()).toBe('2026-10-12T01:56:03.940Z');
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(clock.now!().toISOString()).toBe('2026-10-12T01:56:04.000Z');
    clock.clearTimer!(timer);
  });
});
