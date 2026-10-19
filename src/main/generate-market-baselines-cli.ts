import { resolve } from 'node:path';
import { parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  instrumentDefinition,
  isInstrument,
  type InstrumentDefinition,
} from '../shared/instruments';
import { generateMarketBaselines } from './baseline-generator';
import {
  EdbClient,
} from './edb-client';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DEFAULT_CLOCK_SAFETY_MS = 10 * MINUTE_MS;

interface CliOptions {
  output: string;
  startMs: number;
  endMs: number;
  daysPerChunk: number;
  instruments: InstrumentDefinition[];
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`);
  return value;
}

function parseDateTime(value: string, option: string): number {
  try {
    return parseBeijing(value);
  } catch {
    throw new Error(`${option} 必须是 YYYY-MM-DD HH:mm:ss 北京时间`);
  }
}

function parseOptions(args: string[]): CliOptions {
  const nowMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  let output = resolve('data');
  let startMs = nowMs - 365 * DAY_MS + DEFAULT_CLOCK_SAFETY_MS;
  let endMs = nowMs;
  let daysPerChunk = 14;
  const selected: InstrumentDefinition[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--output') {
      output = resolve(valueAfter(args, index, option));
      index += 1;
    } else if (option === '--start') {
      startMs = parseDateTime(valueAfter(args, index, option), option);
      index += 1;
    } else if (option === '--end') {
      endMs = parseDateTime(valueAfter(args, index, option), option);
      index += 1;
    } else if (option === '--chunk-days') {
      daysPerChunk = Number(valueAfter(args, index, option));
      if (!Number.isInteger(daysPerChunk) || daysPerChunk <= 0) {
        throw new Error('--chunk-days 必须是正整数');
      }
      index += 1;
    } else if (option === '--instrument') {
      const id = valueAfter(args, index, option);
      if (!isInstrument(id)) throw new Error(`不支持的品种标识：${id}`);
      selected.push(instrumentDefinition(id));
      index += 1;
    } else {
      throw new Error(`未知参数：${option}`);
    }
  }
  return {
    output,
    startMs,
    endMs,
    daysPerChunk,
    instruments: selected.length ? selected : [...INSTRUMENT_LIST],
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new EdbClient({
    fetch: globalThis.fetch,
    timeoutMs: 60_000,
    maxResponseBytes: 32 * 1024 * 1024,
  });
  const report = await generateMarketBaselines({
    paths: {
      builtinDataDirectory: options.output,
      marketDataDirectory: resolve('.baseline-generator-user-data'),
      legacyBuiltinDataDirectory: resolve('futures_investigation_20261009'),
    },
    client,
    requestStartMs: options.startMs,
    requestEndMs: options.endMs,
    daysPerChunk: options.daysPerChunk,
    instruments: options.instruments,
    onProgress: (definition, phase) => {
      console.log(JSON.stringify({
        instrumentId: definition.id,
        name: definition.name,
        phase,
      }));
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
