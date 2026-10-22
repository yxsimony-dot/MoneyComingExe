export const INSTRUMENT_IDS = [
  'main_continuous',
  'rapeseed_meal_main',
  'pvc_main',
  'rebar_main',
  'glass_main',
  'rapeseed_oil_main',
  'palm_oil_main',
  'soybean_oil_main',
  'pulp_main',
  'corn_main',
  'soda_ash_main',
  'soybean_1_main',
  'methanol_main',
  'sugar_main',
  'soybean_2_main',
] as const;

export type Instrument = typeof INSTRUMENT_IDS[number];
export type ExchangeId = 'DCE' | 'CZCE' | 'SHFE';
export type TradingSessionId = 'day' | 'night';

export interface TradingSessionSegment {
  startMinute: number;
  endMinute: number;
}

export interface TradingSessionDefinition {
  id: TradingSessionId;
  segments: readonly TradingSessionSegment[];
}

export type TradingSchedule = readonly TradingSessionDefinition[];

export interface ContractCodeDefinition {
  expiryDigits: 3 | 4;
  productCase: 'lower' | 'upper';
  candidateMonths: readonly number[];
  futureYearWindow: number;
}

export interface InstrumentDefinition {
  id: Instrument;
  name: string;
  shortName: string;
  exchange: ExchangeId;
  exchangeName: string;
  productCode: string;
  mainSymbol: `KQ.m@${ExchangeId}.${string}`;
  contractSymbolPrefix: `${ExchangeId}.`;
  contractCode: ContractCodeDefinition;
  priceTick: number;
  pricePrecision: number;
  contractMultiplier: number;
  tradingSessions: TradingSchedule;
  parameterVersion: 1;
}

const STANDARD_TRADING_SESSIONS: TradingSchedule = [
  {
    id: 'day',
    segments: [
      { startMinute: 9 * 60, endMinute: 10 * 60 + 15 },
      { startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 },
      { startMinute: 13 * 60 + 30, endMinute: 15 * 60 },
    ],
  },
  {
    id: 'night',
    segments: [
      { startMinute: 21 * 60, endMinute: 23 * 60 },
    ],
  },
] as const;

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const ODD_MONTHS = [1, 3, 5, 7, 9, 11] as const;
const DCE_MEAL_AND_SOYBEAN_OIL_MONTHS = [1, 3, 5, 7, 8, 9, 11, 12] as const;
const RAPESEED_MEAL_MONTHS = [1, 3, 5, 7, 8, 9, 11] as const;

function defineInstrument(
  definition: Omit<InstrumentDefinition, 'contractSymbolPrefix' | 'parameterVersion' | 'tradingSessions'>,
): InstrumentDefinition {
  return {
    ...definition,
    contractSymbolPrefix: `${definition.exchange}.`,
    parameterVersion: 1,
    tradingSessions: STANDARD_TRADING_SESSIONS,
  };
}

export const INSTRUMENT_DEFINITIONS: Readonly<Record<Instrument, InstrumentDefinition>> = {
  main_continuous: defineInstrument({
    id: 'main_continuous',
    name: '豆粕主连',
    shortName: '豆粕',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'm',
    mainSymbol: 'KQ.m@DCE.m',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  rapeseed_meal_main: defineInstrument({
    id: 'rapeseed_meal_main',
    name: '菜粕主连',
    shortName: '菜粕',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'RM',
    mainSymbol: 'KQ.m@CZCE.RM',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: RAPESEED_MEAL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  pvc_main: defineInstrument({
    id: 'pvc_main',
    name: 'PVC主连',
    shortName: 'PVC',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'v',
    mainSymbol: 'KQ.m@DCE.v',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 5,
  }),
  rebar_main: defineInstrument({
    id: 'rebar_main',
    name: '螺纹钢主连',
    shortName: '螺纹钢',
    exchange: 'SHFE',
    exchangeName: '上期所',
    productCode: 'rb',
    mainSymbol: 'KQ.m@SHFE.rb',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  glass_main: defineInstrument({
    id: 'glass_main',
    name: '玻璃主连',
    shortName: '玻璃',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'FG',
    mainSymbol: 'KQ.m@CZCE.FG',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 20,
  }),
  rapeseed_oil_main: defineInstrument({
    id: 'rapeseed_oil_main',
    name: '菜油主连',
    shortName: '菜油',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'OI',
    mainSymbol: 'KQ.m@CZCE.OI',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  palm_oil_main: defineInstrument({
    id: 'palm_oil_main',
    name: '棕榈油主连',
    shortName: '棕榈油',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'p',
    mainSymbol: 'KQ.m@DCE.p',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  soybean_oil_main: defineInstrument({
    id: 'soybean_oil_main',
    name: '豆油主连',
    shortName: '豆油',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'y',
    mainSymbol: 'KQ.m@DCE.y',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: DCE_MEAL_AND_SOYBEAN_OIL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  pulp_main: defineInstrument({
    id: 'pulp_main',
    name: '纸浆主连',
    shortName: '纸浆',
    exchange: 'SHFE',
    exchangeName: '上期所',
    productCode: 'sp',
    mainSymbol: 'KQ.m@SHFE.sp',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 2,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  corn_main: defineInstrument({
    id: 'corn_main',
    name: '玉米主连',
    shortName: '玉米',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'c',
    mainSymbol: 'KQ.m@DCE.c',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  soda_ash_main: defineInstrument({
    id: 'soda_ash_main',
    name: '纯碱主连',
    shortName: '纯碱',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'SA',
    mainSymbol: 'KQ.m@CZCE.SA',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 20,
  }),
  soybean_1_main: defineInstrument({
    id: 'soybean_1_main',
    name: '豆一主连',
    shortName: '豆一',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'a',
    mainSymbol: 'KQ.m@DCE.a',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  methanol_main: defineInstrument({
    id: 'methanol_main',
    name: '甲醇主连',
    shortName: '甲醇',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'MA',
    mainSymbol: 'KQ.m@CZCE.MA',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  sugar_main: defineInstrument({
    id: 'sugar_main',
    name: '白糖主连',
    shortName: '白糖',
    exchange: 'CZCE',
    exchangeName: '郑商所',
    productCode: 'SR',
    mainSymbol: 'KQ.m@CZCE.SR',
    contractCode: {
      expiryDigits: 3,
      productCase: 'upper',
      candidateMonths: ODD_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
  soybean_2_main: defineInstrument({
    id: 'soybean_2_main',
    name: '豆二主连',
    shortName: '豆二',
    exchange: 'DCE',
    exchangeName: '大商所',
    productCode: 'b',
    mainSymbol: 'KQ.m@DCE.b',
    contractCode: {
      expiryDigits: 4,
      productCase: 'lower',
      candidateMonths: ALL_MONTHS,
      futureYearWindow: 1,
    },
    priceTick: 1,
    pricePrecision: 0,
    contractMultiplier: 10,
  }),
};

export const DEFAULT_INSTRUMENT = INSTRUMENT_DEFINITIONS.main_continuous;
export const INSTRUMENT_LIST = INSTRUMENT_IDS.map(id => INSTRUMENT_DEFINITIONS[id]);

export function isInstrument(value: unknown): value is Instrument {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(INSTRUMENT_DEFINITIONS, value);
}

export function instrumentDefinition(instrument: Instrument): InstrumentDefinition {
  return INSTRUMENT_DEFINITIONS[instrument];
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isConcreteContractCode(
  definition: InstrumentDefinition,
  contract: string,
): boolean {
  const expiryPattern = definition.exchange === 'CZCE'
    ? '\\d{3,4}'
    : `\\d{${definition.contractCode.expiryDigits}}`;
  const match = new RegExp(
    `^${escapedRegExp(definition.productCode)}(${expiryPattern})$`,
  ).exec(contract);
  if (!match) return false;
  const month = Number(match[1].slice(-2));
  return definition.contractCode.candidateMonths.includes(month);
}

export function definitionForMainSymbol(symbol: string): InstrumentDefinition | undefined {
  return INSTRUMENT_LIST.find(definition => definition.mainSymbol === symbol);
}

export function definitionForContractSymbol(symbol: string): InstrumentDefinition | undefined {
  return INSTRUMENT_LIST.find(definition => (
    symbol.startsWith(definition.contractSymbolPrefix)
    && isConcreteContractCode(
      definition,
      symbol.slice(definition.contractSymbolPrefix.length),
    )
  ));
}
