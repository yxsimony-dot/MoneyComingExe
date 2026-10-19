import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_IDS,
  instrumentDefinition,
  isInstrument,
  type ExchangeId,
  type Instrument,
  type TradingSchedule,
} from '../src/shared/instruments';

interface ParameterAuditEntry {
  exchange: ExchangeId;
  productCode: string;
  mainSymbol: string;
  expiryDigits: 3 | 4;
  productCase: 'lower' | 'upper';
  candidateMonths: number[];
  priceTick: number;
  contractMultiplier: number;
  sessionProfile: string;
  sourceIds: string[];
}

interface ParameterAuditFixture {
  schemaVersion: 1;
  auditDate: string;
  sources: Record<string, { title: string; url: string }>;
  sessionProfiles: Record<string, TradingSchedule>;
  instruments: Record<Instrument, ParameterAuditEntry>;
}

const parameterAudit = JSON.parse(readFileSync(
  new URL('./fixtures/instrument-parameters.json', import.meta.url),
  'utf8',
)) as ParameterAuditFixture;

describe('instrument registry', () => {
  it('contains exactly fifteen stable and unique main-continuous instruments', () => {
    expect(INSTRUMENT_IDS).toHaveLength(15);
    expect(new Set(INSTRUMENT_IDS).size).toBe(15);
    expect(Object.keys(INSTRUMENT_DEFINITIONS)).toEqual([...INSTRUMENT_IDS]);
    expect(Object.values(INSTRUMENT_DEFINITIONS).map(definition => definition.mainSymbol)).toHaveLength(15);
    expect(new Set(Object.values(INSTRUMENT_DEFINITIONS).map(definition => definition.mainSymbol)).size).toBe(15);
  });

  it('preserves the soymeal compatibility id and required market parameters', () => {
    expect(DEFAULT_INSTRUMENT).toBe(INSTRUMENT_DEFINITIONS.main_continuous);
    expect(instrumentDefinition('main_continuous')).toMatchObject({
      id: 'main_continuous',
      name: '豆粕主连',
      exchange: 'DCE',
      exchangeName: '大商所',
      productCode: 'm',
      mainSymbol: 'KQ.m@DCE.m',
      priceTick: 1,
      contractMultiplier: 10,
    });
  });

  it('records contract formats, positive pricing parameters, and valid sessions for every product', () => {
    for (const definition of Object.values(INSTRUMENT_DEFINITIONS)) {
      expect(definition.contractSymbolPrefix).toBe(`${definition.exchange}.`);
      expect(definition.contractCode.expiryDigits).toBe(definition.exchange === 'CZCE' ? 3 : 4);
      expect(definition.contractCode.productCase).toBe(definition.exchange === 'CZCE' ? 'upper' : 'lower');
      expect(definition.contractCode.candidateMonths.length).toBeGreaterThan(0);
      expect(definition.priceTick).toBeGreaterThan(0);
      expect(definition.contractMultiplier).toBeGreaterThan(0);
      expect(definition.tradingSessions.map(session => session.id)).toEqual(['day', 'night']);
      expect(definition.tradingSessions[0].segments).toHaveLength(3);
      expect(definition.tradingSessions[1].segments).toHaveLength(1);
    }
    expect(INSTRUMENT_DEFINITIONS.pvc_main.contractMultiplier).toBe(5);
    expect(INSTRUMENT_DEFINITIONS.glass_main.contractMultiplier).toBe(20);
    expect(INSTRUMENT_DEFINITIONS.soda_ash_main.contractMultiplier).toBe(20);
    expect(INSTRUMENT_DEFINITIONS.palm_oil_main.priceTick).toBe(2);
    expect(INSTRUMENT_DEFINITIONS.soybean_oil_main.priceTick).toBe(2);
    expect(INSTRUMENT_DEFINITIONS.pulp_main.priceTick).toBe(2);
  });

  it('matches the fixed authoritative parameter audit for every product', () => {
    expect(parameterAudit.schemaVersion).toBe(1);
    expect(parameterAudit.auditDate).toBe('2026-10-19');
    expect(Object.keys(parameterAudit.instruments)).toEqual([...INSTRUMENT_IDS]);
    for (const id of INSTRUMENT_IDS) {
      const definition = INSTRUMENT_DEFINITIONS[id];
      const audited = parameterAudit.instruments[id];
      expect(definition).toMatchObject({
        exchange: audited.exchange,
        productCode: audited.productCode,
        mainSymbol: audited.mainSymbol,
        priceTick: audited.priceTick,
        contractMultiplier: audited.contractMultiplier,
      });
      expect(definition.contractCode).toMatchObject({
        expiryDigits: audited.expiryDigits,
        productCase: audited.productCase,
        candidateMonths: audited.candidateMonths,
      });
      expect(definition.tradingSessions).toEqual(
        parameterAudit.sessionProfiles[audited.sessionProfile],
      );
      expect(audited.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of audited.sourceIds) {
        const source = parameterAudit.sources[sourceId];
        expect(source, `${id} references unknown source ${sourceId}`).toBeDefined();
        expect(new URL(source.url).protocol).toBe('https:');
      }
    }
  });

  it('accepts only registered stable identifiers', () => {
    expect(isInstrument('main_continuous')).toBe(true);
    expect(isInstrument('rebar_main')).toBe(true);
    expect(isInstrument('m2701')).toBe(false);
    expect(isInstrument('../main_continuous')).toBe(false);
  });
});
