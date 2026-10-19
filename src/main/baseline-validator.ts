import { isDeepStrictEqual } from 'node:util';
import {
  detectContractRollovers,
} from '../domain/contract-rollover';
import {
  aggregateMinutes,
} from '../domain/market-data';
import { parseBeijing } from '../domain/time';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../shared/instruments';
import {
  loadEffectiveSnapshot,
  type MarketDataPaths,
} from './market-snapshot';

export const BASELINE_VALIDATION_REPORT_FILE = 'baseline-validation-report.json';

export interface BaselineValidationInstrumentReport {
  instrumentId: InstrumentDefinition['id'];
  name: string;
  firstMinute: string;
  lastMinute: string;
  sourceLatestAt: string;
  minuteRows: number;
  fiveMinuteRows: number;
  sixtyMinuteRows: number;
  mappingRows: number;
  rolloverRows: number;
  checks: {
    metadataAndHashes: true;
    minuteRecords: true;
    rebuiltFiveMinuteBars: true;
    rebuiltSixtyMinuteBars: true;
    crossPeriodReconciliation: true;
    mainContractMappings: true;
    rolloverLocations: true;
  };
}

export interface BaselineValidationReport {
  schemaVersion: 1;
  validatedAt: string;
  instruments: BaselineValidationInstrumentReport[];
}

export interface BaselineValidatorOptions {
  paths: MarketDataPaths;
  instruments?: readonly InstrumentDefinition[];
  now?: () => Date;
  onProgress?: (definition: InstrumentDefinition) => void;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
}

export async function validateMarketBaselines(
  options: BaselineValidatorOptions,
): Promise<BaselineValidationReport> {
  const report: BaselineValidationReport = {
    schemaVersion: 1,
    validatedAt: (options.now?.() ?? new Date()).toISOString(),
    instruments: [],
  };

  for (const definition of options.instruments ?? INSTRUMENT_LIST) {
    options.onProgress?.(definition);
    const snapshot = await loadEffectiveSnapshot(options.paths, definition);
    if (snapshot.source !== 'builtin') {
      throw new Error(`${definition.name} 验收时意外加载了用户快照`);
    }
    if (!snapshot.bars1.length || !snapshot.bars5.length || !snapshot.bars60.length) {
      throw new Error(`${definition.name} 基线缺少必要行情`);
    }
    if (!snapshot.mainContractMappings.length) {
      throw new Error(`${definition.name} 缺少主力合约日映射`);
    }

    const sourceLatestMs = parseBeijing(snapshot.sourceLatestAt);
    const rebuilt5 = aggregateMinutes(
      snapshot.bars1,
      5,
      sourceLatestMs,
      definition.tradingSessions,
    );
    const rebuilt60 = aggregateMinutes(
      snapshot.bars1,
      60,
      sourceLatestMs,
      definition.tradingSessions,
    );
    assertEqual(
      snapshot.bars5,
      rebuilt5,
      `${definition.name} 的 5 分钟数据无法由 1 分钟基线精确重建`,
    );
    assertEqual(
      snapshot.bars60,
      rebuilt60,
      `${definition.name} 的 60 分钟数据无法由 1 分钟基线精确重建`,
    );

    const detectedRollovers = detectContractRollovers(
      snapshot.mainContractMappings,
      snapshot.bars5,
      definition,
    );
    assertEqual(
      snapshot.rollovers,
      detectedRollovers,
      `${definition.name} 的换月记录与日映射或首根 5 分钟 K 线不一致`,
    );

    report.instruments.push({
      instrumentId: definition.id,
      name: definition.name,
      firstMinute: snapshot.bars1[0].start,
      lastMinute: snapshot.bars1.at(-1)!.start,
      sourceLatestAt: snapshot.sourceLatestAt,
      minuteRows: snapshot.bars1.length,
      fiveMinuteRows: snapshot.bars5.length,
      sixtyMinuteRows: snapshot.bars60.length,
      mappingRows: snapshot.mainContractMappings.length,
      rolloverRows: snapshot.rollovers.length,
      checks: {
        metadataAndHashes: true,
        minuteRecords: true,
        rebuiltFiveMinuteBars: true,
        rebuiltSixtyMinuteBars: true,
        crossPeriodReconciliation: true,
        mainContractMappings: true,
        rolloverLocations: true,
      },
    });
  }

  return report;
}
