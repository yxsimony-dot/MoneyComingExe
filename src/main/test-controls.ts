import { isInstrument } from '../shared/instruments';
import type { Instrument } from '../shared/types';

export type InstrumentNumberControls = Partial<Record<Instrument, number>>;
export type InstrumentFailureControls = Partial<Record<Instrument, string>>;

export interface TestControls {
  builtinDataDirectory?: string;
  now?: Date;
  onlineClockRate?: number;
  loadDelays: InstrumentNumberControls;
  loadFailures: InstrumentFailureControls;
  edbDelays: InstrumentNumberControls;
  edbFailures: InstrumentFailureControls;
  edbPriceOffsets: InstrumentNumberControls;
}

export interface TestClock {
  now?: () => Date;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} 必须是有效日期时间`);
  }
  return parsed;
}

function parseOptionalNumber(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 数值无效`);
  }
  return parsed;
}

function parseObject(
  value: string | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function parseNumberControls(
  value: string | undefined,
  label: string,
  options: { integer: boolean; minimum: number; maximum: number },
): InstrumentNumberControls {
  const result: InstrumentNumberControls = {};
  for (const [instrument, raw] of Object.entries(parseObject(value, label))) {
    if (!isInstrument(instrument)) {
      throw new Error(`${label} 包含未知品种：${instrument}`);
    }
    if (typeof raw !== 'number'
      || !Number.isFinite(raw)
      || (options.integer && !Number.isInteger(raw))
      || raw < options.minimum
      || raw > options.maximum) {
      throw new Error(`${label}.${instrument} 数值无效`);
    }
    result[instrument] = raw;
  }
  return result;
}

function parseFailureControls(
  value: string | undefined,
  label: string,
): InstrumentFailureControls {
  const result: InstrumentFailureControls = {};
  for (const [instrument, raw] of Object.entries(parseObject(value, label))) {
    if (!isInstrument(instrument)) {
      throw new Error(`${label} 包含未知品种：${instrument}`);
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`${label}.${instrument} 必须是非空错误消息`);
    }
    result[instrument] = raw.trim();
  }
  return result;
}

export function readTestControls(
  testMode: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): TestControls {
  if (!testMode) {
    return {
      loadDelays: {},
      loadFailures: {},
      edbDelays: {},
      edbFailures: {},
      edbPriceOffsets: {},
    };
  }
  const onlineClockRate = parseOptionalNumber(
    environment.MONEYCOMING_TEST_ONLINE_CLOCK_RATE,
    'MONEYCOMING_TEST_ONLINE_CLOCK_RATE',
    1,
    600,
  );
  return {
    builtinDataDirectory: environment.MONEYCOMING_TEST_BUILTIN_DATA?.trim() || undefined,
    now: parseDate(environment.MONEYCOMING_TEST_NOW, 'MONEYCOMING_TEST_NOW'),
    ...(onlineClockRate === undefined ? {} : { onlineClockRate }),
    loadDelays: parseNumberControls(
      environment.MONEYCOMING_TEST_LOAD_DELAYS,
      'MONEYCOMING_TEST_LOAD_DELAYS',
      { integer: true, minimum: 0, maximum: 60_000 },
    ),
    loadFailures: parseFailureControls(
      environment.MONEYCOMING_TEST_LOAD_FAILURES,
      'MONEYCOMING_TEST_LOAD_FAILURES',
    ),
    edbDelays: parseNumberControls(
      environment.MONEYCOMING_TEST_EDB_DELAYS,
      'MONEYCOMING_TEST_EDB_DELAYS',
      { integer: true, minimum: 0, maximum: 60_000 },
    ),
    edbFailures: parseFailureControls(
      environment.MONEYCOMING_TEST_EDB_FAILURES,
      'MONEYCOMING_TEST_EDB_FAILURES',
    ),
    edbPriceOffsets: parseNumberControls(
      environment.MONEYCOMING_TEST_EDB_PRICE_OFFSETS,
      'MONEYCOMING_TEST_EDB_PRICE_OFFSETS',
      { integer: false, minimum: -1_000_000, maximum: 1_000_000 },
    ),
  };
}

export function createTestClock(
  controls: Pick<TestControls, 'now' | 'onlineClockRate'>,
): TestClock {
  if (!controls.now) return {};
  if (!controls.onlineClockRate) {
    return {
      now: () => new Date(controls.now!.getTime()),
    };
  }
  const rate = controls.onlineClockRate;
  const testStartedAtMs = controls.now.getTime();
  const realStartedAtMs = Date.now();
  return {
    now: () => new Date(
      testStartedAtMs + (Date.now() - realStartedAtMs) * rate,
    ),
    setTimer: (callback, delayMs) => setTimeout(
      callback,
      Math.max(0, delayMs / rate),
    ),
    clearTimer: handle => clearTimeout(handle),
  };
}

export function testDelay(milliseconds: number | undefined): Promise<void> {
  return milliseconds
    ? new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
    : Promise.resolve();
}
