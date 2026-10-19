import { describe, expect, it } from 'vitest';
import {
  buildMainContractCandidates,
  detectContractRollovers,
  identifyMainContracts,
  locateRolloverBar,
  mergeContractRollovers,
  mergeMainContractMappings,
  parseContractRollovers,
  parseEdbDailyCsv,
  serializeContractRollovers,
} from '../src/domain/contract-rollover';
import { parseBeijing } from '../src/domain/time';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
} from '../src/shared/instruments';
import type { Bar, ContractRollover } from '../src/shared/types';

const DAILY_HEADER = 'datetime_nano,open,high,low,close,volume,open_oi,close_oi';
const dailyNano = (date: string) => String(BigInt(parseBeijing(`${date} 00:00:00`)) * 1_000_000n);
const dailyCsv = (rows: string[]) => `${DAILY_HEADER}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;

function dailyRow(
  date: string,
  values: [number, number, number, number, number, number, number],
): string {
  return [dailyNano(date), ...values].join(',');
}

function bar(start: string, minutes = 5): Bar {
  const startMs = parseBeijing(start);
  return {
    startMs,
    endMs: startMs + minutes * 60_000,
    start,
    end: '',
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 10,
    openOi: 1000,
    closeOi: 1001,
    session: start.slice(11, 13) === '21' ? 'night' : 'day',
    observedMinutes: minutes,
    expectedMinutes: minutes,
    complete: true,
  };
}

const knownRollovers: ContractRollover[] = [
  {
    tradingDate: '2025-12-04',
    time: '2025-12-03 21:00:00',
    timeMs: parseBeijing('2025-12-03 21:00:00'),
    fromContract: 'm2601',
    toContract: 'm2605',
  },
  {
    tradingDate: '2026-04-09',
    time: '2026-04-08 21:00:00',
    timeMs: parseBeijing('2026-04-08 21:00:00'),
    fromContract: 'm2605',
    toContract: 'm2609',
  },
  {
    tradingDate: '2026-08-10',
    time: '2026-08-07 21:00:00',
    timeMs: parseBeijing('2026-08-07 21:00:00'),
    fromContract: 'm2609',
    toContract: 'm2701',
  },
];

describe('rollover CSV', () => {
  it('round-trips known records and accepts a header-only empty file', () => {
    expect(parseContractRollovers(serializeContractRollovers(knownRollovers))).toEqual(knownRollovers);
    expect(parseContractRollovers('trading_date,time,from_contract,to_contract\n')).toEqual([]);
  });

  it.each([
    [
      'duplicate',
      'trading_date,time,from_contract,to_contract\n2026-08-10,2026-08-07 21:00:00,m2609,m2701\n2026-08-10,2026-08-08 09:00:00,m2701,m2705\n',
      /重复/,
    ],
    [
      'out of order',
      'trading_date,time,from_contract,to_contract\n2026-08-10,2026-08-07 21:00:00,m2609,m2701\n2026-04-09,2026-04-08 21:00:00,m2605,m2609\n',
      /严格递增/,
    ],
    [
      'invalid contract',
      'trading_date,time,from_contract,to_contract\n2026-08-10,2026-08-07 21:00:00,M2609,m2701\n',
      /豆粕受支持的具体合约代码/,
    ],
  ])('rejects %s records', (_name, text, pattern) => {
    expect(() => parseContractRollovers(text)).toThrow(pattern);
  });
});

describe('daily main-contract matching', () => {
  it('parses Beijing-midnight trading dates and matches HLC despite other field differences', () => {
    const main = parseEdbDailyCsv(dailyCsv([
      dailyRow('2026-08-10', [3149, 3152, 3127, 3140, 633897, 2160574, 2221189]),
    ]));
    const contract = parseEdbDailyCsv(dailyCsv([
      dailyRow('2026-08-10', [3148, 3152, 3127, 3140, 1, 2, 3]),
    ]));
    expect(main[0].tradingDate).toBe('2026-08-10');
    expect(identifyMainContracts(main, new Map([['m2701', contract]]))).toEqual([
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);
  });

  it('identifies the three fixed rollover samples', () => {
    const dates = ['2025-12-03', '2025-12-04', '2026-04-08', '2026-04-09', '2026-08-07', '2026-08-10'];
    const values = dates.map((date, index) => dailyRow(date, [100 + index, 110 + index, 90 + index, 105 + index, 1000 + index, 2000 + index, 3000 + index]));
    const main = parseEdbDailyCsv(dailyCsv(values));
    const contracts = new Map([
      ['m2601', parseEdbDailyCsv(dailyCsv([values[0]]))],
      ['m2605', parseEdbDailyCsv(dailyCsv([values[1], values[2]]))],
      ['m2609', parseEdbDailyCsv(dailyCsv([values[3], values[4]]))],
      ['m2701', parseEdbDailyCsv(dailyCsv([values[5]]))],
    ]);
    const mappings = identifyMainContracts(main, contracts);
    const bars = [
      bar('2025-12-03 21:00:00'),
      bar('2026-04-08 21:00:00'),
      bar('2026-08-07 21:00:00'),
    ];
    expect(detectContractRollovers(mappings, bars)).toEqual(knownRollovers);
  });

  it('fails on missing or ambiguous daily matches', () => {
    const row = dailyRow('2026-08-10', [3149, 3152, 3127, 3140, 633897, 2160574, 2221189]);
    const main = parseEdbDailyCsv(dailyCsv([row]));
    expect(() => identifyMainContracts(main, new Map())).toThrow(/缺失/);
    const matching = parseEdbDailyCsv(dailyCsv([row]));
    expect(() => identifyMainContracts(main, new Map([['m2609', matching], ['m2701', matching]]))).toThrow(/歧义/);
  });

  it('inherits only an isolated missing day bounded by the same contract', () => {
    const dates = ['2026-08-07', '2026-08-10', '2026-08-11'];
    const rows = dates.map((date, index) => dailyRow(
      date,
      [100 + index, 110 + index, 90 + index, 105 + index, 10, 20, 30],
    ));
    const main = parseEdbDailyCsv(dailyCsv(rows));
    const sameContract = parseEdbDailyCsv(dailyCsv([rows[0], rows[2]]));
    expect(identifyMainContracts(main, new Map([['m2701', sameContract]]))).toEqual([
      { tradingDate: dates[0], contract: 'm2701' },
      { tradingDate: dates[1], contract: 'm2701' },
      { tradingDate: dates[2], contract: 'm2701' },
    ]);
  });

  it.each([
    ['leading boundary', [undefined, 'm2701', 'm2701']],
    ['trailing boundary', ['m2701', 'm2701', undefined]],
    ['continuous gap', ['m2701', undefined, undefined, 'm2701']],
    ['gap across a real rollover', ['m2609', undefined, 'm2701']],
  ])('rejects a %s gap', (_name, contracts) => {
    const rows = contracts.map((_contract, index) => dailyRow(
      `2026-08-${String(10 + index).padStart(2, '0')}`,
      [100 + index, 110 + index, 90 + index, 105 + index, 10, 20, 30],
    ));
    const main = parseEdbDailyCsv(dailyCsv(rows));
    const candidates = new Map<string, ReturnType<typeof parseEdbDailyCsv>>();
    contracts.forEach((contract, index) => {
      if (!contract) return;
      candidates.set(contract, [
        ...(candidates.get(contract) ?? []),
        parseEdbDailyCsv(dailyCsv([rows[index]]))[0],
      ]);
    });
    expect(() => identifyMainContracts(main, candidates)).toThrow(/缺失/);
  });

  it('never inherits an ambiguous day even when neighbors use the same contract', () => {
    const rows = ['2026-08-10', '2026-08-11', '2026-08-12'].map((date, index) => dailyRow(
      date,
      [100 + index, 110 + index, 90 + index, 105 + index, 10, 20, 30],
    ));
    const main = parseEdbDailyCsv(dailyCsv(rows));
    const firstAndLast = parseEdbDailyCsv(dailyCsv([rows[0], rows[2]]));
    const ambiguous = parseEdbDailyCsv(dailyCsv([rows[1]]));
    expect(() => identifyMainContracts(main, new Map([
      ['m2701', [...firstAndLast, ...ambiguous]],
      ['m2705', ambiguous],
    ]))).toThrow(/歧义/);
  });
});

describe('rollover bar positioning', () => {
  it('uses the first bar strictly after the previous close for a night session', () => {
    const mappings = [
      { tradingDate: '2026-04-08', contract: 'm2605' },
      { tradingDate: '2026-04-09', contract: 'm2609' },
    ];
    const bars = [bar('2026-04-08 14:55:00'), bar('2026-04-08 21:00:00')];
    expect(detectContractRollovers(mappings, bars)[0].time).toBe('2026-04-08 21:00:00');
  });

  it('crosses a weekend and falls back to 09:00 when there is no night session', () => {
    const weekend = detectContractRollovers([
      { tradingDate: '2026-08-07', contract: 'm2609' },
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ], [bar('2026-08-07 14:55:00'), bar('2026-08-07 21:00:00')]);
    expect(weekend[0].time).toBe('2026-08-07 21:00:00');

    const dayOnly = detectContractRollovers([
      { tradingDate: '2026-10-14', contract: 'm2701' },
      { tradingDate: '2026-10-15', contract: 'm2705' },
    ], [bar('2026-10-14 14:55:00'), bar('2026-10-15 09:00:00')]);
    expect(dayOnly[0].time).toBe('2026-10-15 09:00:00');
  });

  it('maps 5m exactly and 60m to the first bar starting at or after rollover time', () => {
    const rollover = knownRollovers[2];
    expect(locateRolloverBar(rollover, [bar('2026-08-07 21:00:00')], 5)?.start).toBe('2026-08-07 21:00:00');
    expect(locateRolloverBar(rollover, [
      bar('2026-08-07 20:00:00', 60),
      bar('2026-08-07 21:00:00', 60),
    ], 60)?.start).toBe('2026-08-07 21:00:00');
  });
});

describe('controlled candidate generation', () => {
  it('uses the configured candidate months through the future window', () => {
    const definition = {
      ...DEFAULT_INSTRUMENT,
      contractCode: {
        ...DEFAULT_INSTRUMENT.contractCode,
        candidateMonths: [1, 5, 9],
      },
    };
    expect(buildMainContractCandidates(definition, '2025-10-09', '2026-10-15')).toEqual([
      'm2501', 'm2505', 'm2509',
      'm2601', 'm2605', 'm2609',
      'm2701', 'm2705', 'm2709',
    ]);
  });

  it('supports CZCE three-digit and DCE four-digit expiry formats', () => {
    expect(buildMainContractCandidates(
      {
        ...INSTRUMENT_DEFINITIONS.rapeseed_meal_main,
        contractCode: {
          ...INSTRUMENT_DEFINITIONS.rapeseed_meal_main.contractCode,
          candidateMonths: [1],
          futureYearWindow: 0,
        },
      },
      '2026-01-01',
      '2026-12-31',
    )).toEqual(['RM601']);
    expect(buildMainContractCandidates(
      {
        ...DEFAULT_INSTRUMENT,
        contractCode: {
          ...DEFAULT_INSTRUMENT.contractCode,
          candidateMonths: [1],
          futureYearWindow: 0,
        },
      },
      '2027-01-01',
      '2027-12-31',
    )).toEqual(['m2701']);
  });
});

describe('incremental mapping and rollover merge', () => {
  it('keeps historical mappings and rollovers while replacing overlap dates', () => {
    expect(mergeMainContractMappings([
      { tradingDate: '2026-04-08', contract: 'm2605' },
      { tradingDate: '2026-04-09', contract: 'm2609' },
    ], [
      { tradingDate: '2026-04-09', contract: 'm2609' },
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ])).toEqual([
      { tradingDate: '2026-04-08', contract: 'm2605' },
      { tradingDate: '2026-04-09', contract: 'm2609' },
      { tradingDate: '2026-08-10', contract: 'm2701' },
    ]);

    expect(mergeContractRollovers(knownRollovers.slice(0, 2), knownRollovers.slice(1))).toEqual(knownRollovers);
  });
});
