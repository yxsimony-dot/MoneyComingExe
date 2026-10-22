import { describe, expect, it } from 'vitest';
// @ts-expect-error Probe scripts are executable ESM JavaScript modules.
import { buildProbeTargets, parseJsonpPayload, summarizeRows, TARGET_INSTRUMENTS } from '../scripts/probe-sina-futures-minute.mjs';

describe('Sina futures minute metadata probe', () => {
  it('uses four-digit specific contracts and compares CZCE three-digit aliases', () => {
    const targets = buildProbeTargets(
      TARGET_INSTRUMENTS.filter(
        (instrument: { instrumentId: string }) => (
          instrument.instrumentId === 'main_continuous'
          || instrument.instrumentId === 'rapeseed_meal_main'
        ),
      ),
      { year: 2025, month: 7 },
      { year: 2025, month: 9 },
    );
    expect(targets).toContainEqual(expect.objectContaining({
      instrumentId: 'main_continuous',
      symbol: 'M2509',
      symbolKind: 'specific-contract-four-digit',
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      instrumentId: 'rapeseed_meal_main',
      symbol: 'RM2509',
      symbolKind: 'specific-contract-four-digit',
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      instrumentId: 'rapeseed_meal_main',
      symbol: 'RM509',
      symbolKind: 'specific-contract-three-digit-alias',
    }));
  });

  it('parses arrays and null JSONP payloads without retaining wrapper text', () => {
    expect(parseJsonpPayload(
      '/* guard */\nvar _M2509_5=([{"d":"2025-08-15 13:50:00","c":"3073"}]);',
    )).toEqual([{ d: '2025-08-15 13:50:00', c: '3073' }]);
    expect(parseJsonpPayload('var _RM509_5=(null);')).toEqual([]);
    expect(() => parseJsonpPayload('not jsonp')).toThrow(/JSONP/);
  });

  it('summarizes only metadata needed to assess a target gap', () => {
    const summary = summarizeRows([
      {
        d: '2025-06-30 23:00:00',
        o: '3000',
        h: '3010',
        l: '2990',
        c: '3005',
        v: '1',
        p: '2',
      },
      {
        d: '2025-07-01 09:05:00',
        o: '3005',
        h: '3015',
        l: '3000',
        c: '3010',
        v: '3',
        p: '4',
      },
      {
        d: '2025-07-02 09:05:00',
        o: '3010',
        h: '3020',
        l: '3005',
        c: '3015',
        v: '5',
        p: '6',
      },
    ], {
      firstDate: '2025-07-01',
      lastDate: '2025-10-19',
    });
    expect(summary).toMatchObject({
      rowCount: 3,
      firstTimestamp: '2025-06-30 23:00:00',
      lastTimestamp: '2025-07-02 09:05:00',
      targetGap: {
        rowCount: 2,
        observedTradingDateCount: 2,
        overlaps: true,
        wholeGapCoveredBySingleResponse: false,
      },
      targetDates: ['2025-07-01', '2025-07-02'],
    });
    expect(summary).not.toHaveProperty('rows');
  });
});
