import { describe, expect, it } from 'vitest';
import {
  assertBenchmarkProtectionUnchanged,
  benchmarkProtectionFingerprint,
  mergeBenchmarkProtectedMarketData,
} from '../src/domain/benchmark-protection';
import {
  detectContractRollovers,
} from '../src/domain/contract-rollover';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
} from '../src/domain/market-data';
import { formatBeijing, parseBeijing } from '../src/domain/time';
import { INSTRUMENT_DEFINITIONS } from '../src/shared/instruments';
import type {
  Bar,
  EdbMinuteRecord,
  MarketSnapshotBenchmarkProtection,
} from '../src/shared/types';

const GLASS = INSTRUMENT_DEFINITIONS.glass_main;
const MINUTE_MS = 60_000;

function minuteSequence(start: string, count: number): EdbMinuteRecord[] {
  const firstStartMs = parseBeijing(start);
  return Array.from({ length: count }, (_, index) => {
    const startMs = firstStartMs + index * MINUTE_MS;
    const open = 1_500 + index;
    return {
      datetimeNano: String(BigInt(startMs) * 1_000_000n),
      startMs,
      start: formatBeijing(startMs),
      open,
      high: open + 3,
      low: open - 2,
      close: open + 1,
      volume: 10 + index,
      openOi: 5_000 + index,
      closeOi: 5_001 + index,
    };
  });
}

function benchmarkBars(minutes: EdbMinuteRecord[]): Bar[] {
  const bars = aggregateMinutes(
    minutes,
    5,
    minutes.at(-1)!.startMs + MINUTE_MS,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  bars[0] = {
    ...bars[0],
    open: bars[0].open + 20,
    high: bars[0].high + 25,
    low: bars[0].low + 15,
    close: bars[0].close + 20,
    volume: bars[0].volume + 100,
  };
  return bars;
}

function protection(): MarketSnapshotBenchmarkProtection {
  return {
    provider: 'THS',
    reportRunId: 'benchmark-protection-test',
    sourceSegmentId: 'ths-fg9999',
    bars5: {
      firstStart: '2026-10-09 21:00:00',
      lastEnd: '2026-10-09 22:00:00',
      protectedFields: ['open', 'high', 'low', 'close', 'volume'],
    },
    bars60: {
      firstStart: '2026-10-09 21:00:00',
      lastEnd: '2026-10-09 22:00:00',
      derivedFrom: 'bars5',
    },
    mappings: {
      firstTradingDate: '2026-10-09',
      lastTradingDate: '2026-10-10',
    },
    rollovers: {
      firstTradingDate: '2026-10-10',
      lastTradingDate: '2026-10-10',
    },
    minutePolicy: 'preserved-audit-only',
    reportSha256: 'a'.repeat(64),
    redistribution: {
      allowed: false,
      conclusion: '测试基准仅限本机使用。',
    },
  };
}

function fixture() {
  const bars1 = minuteSequence('2026-10-09 21:00:00', 60);
  const bars5 = benchmarkBars(bars1);
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    GLASS.tradingSessions,
  ).filter(bar => bar.complete);
  const mainContractMappings = [
    { tradingDate: '2026-10-09', contract: 'FG2609' },
    { tradingDate: '2026-10-10', contract: 'FG2701' },
  ];
  const rollovers = detectContractRollovers(
    mainContractMappings,
    bars5,
    GLASS,
  );
  return {
    bars1,
    bars5,
    bars60,
    mainContractMappings,
    rollovers,
  };
}

describe('benchmark-protected market data merge', () => {
  it('audits protected overlap while only exposing bars after the boundary', () => {
    const current = fixture();
    const changedProtectedMinute = {
      ...current.bars1[10],
      open: current.bars1[10].open + 40,
      high: current.bars1[10].high + 40,
      low: current.bars1[10].low + 40,
      close: current.bars1[10].close + 40,
    };
    const tailMinutes = minuteSequence('2026-10-09 22:00:00', 60);
    const result = mergeBenchmarkProtectedMarketData({
      definition: GLASS,
      current,
      incomingMinutes: [changedProtectedMinute, ...tailMinutes],
      remoteMappings: [
        { tradingDate: '2026-10-10', contract: 'FG2705' },
        { tradingDate: '2026-10-11', contract: 'FG2701' },
      ],
      protection: protection(),
      rebuildStartMs: parseBeijing('2026-10-09 21:00:00'),
      coverageEndMs: parseBeijing('2026-10-09 23:00:00'),
    });

    expect(result.bars1.find(record => (
      record.startMs === changedProtectedMinute.startMs
    ))).toEqual(changedProtectedMinute);
    expect(result.minuteReconciliation?.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          barStartMs: parseBeijing('2026-10-09 21:10:00'),
        }),
      ]),
    );
    expect(result.bars5.slice(0, current.bars5.length))
      .toEqual(current.bars5);
    expect(result.bars60[0]).toEqual(current.bars60[0]);
    expect(result.mainContractMappings.slice(0, 2))
      .toEqual(current.mainContractMappings);
    expect(result.rollovers[0]).toEqual(current.rollovers[0]);
    expect(result.bars5[current.bars5.length].start)
      .toBe('2026-10-09 22:00:00');
    expect(result.bars5).toHaveLength(24);
    expect(result.bars60.map(bar => [bar.start, bar.end])).toEqual([
      ['2026-10-09 21:00:00', '2026-10-09 22:00:00'],
      ['2026-10-09 22:00:00', '2026-10-09 23:00:00'],
    ]);
    expect(result.protectedMappingAudit).toEqual({
      protectedRemoteRows: 1,
      matchingRows: 0,
      differingRows: 1,
      differences: [{
        tradingDate: '2026-10-10',
        protectedContract: 'FG2701',
        incomingContract: 'FG2705',
      }],
    });
    expect(result.protectionFingerprint?.before)
      .toBe(result.protectionFingerprint?.after);
    expect(result.counts).toMatchObject({
      added1: 60,
      replaced1: 1,
      added5: 12,
      replaced5: 0,
      added60: 1,
      replaced60: 0,
    });
  });

  it('changes the fingerprint and rejects an intentional protected mutation', () => {
    const current = fixture();
    const changed = {
      ...current,
      bars5: current.bars5.map((bar, index) => (
        index === 0 ? { ...bar, volume: bar.volume + 1 } : bar
      )),
    };
    const metadata = protection();

    expect(benchmarkProtectionFingerprint(current, metadata))
      .not.toBe(benchmarkProtectionFingerprint(changed, metadata));
    expect(() => assertBenchmarkProtectionUnchanged(
      metadata,
      current,
      changed,
    )).toThrow('受保护 5 分钟字段');
  });

  it('completes a boundary 60-minute bucket from protected prefix and EDB tail', () => {
    const bars1 = minuteSequence('2026-10-09 21:00:00', 90);
    const bars5 = benchmarkBars(bars1);
    const bars60 = aggregateFiveMinuteBars(
      bars5,
      GLASS.tradingSessions,
    ).filter(bar => bar.complete);
    const mainContractMappings = [
      { tradingDate: '2026-10-09', contract: 'FG2609' },
      { tradingDate: '2026-10-10', contract: 'FG2701' },
    ];
    const current = {
      bars1,
      bars5,
      bars60,
      mainContractMappings,
      rollovers: detectContractRollovers(
        mainContractMappings,
        bars5,
        GLASS,
      ),
    };
    const metadata = {
      ...protection(),
      bars5: {
        ...protection().bars5,
        lastEnd: '2026-10-09 22:30:00',
      },
    };
    const tailMinutes = minuteSequence('2026-10-09 22:30:00', 30);

    const result = mergeBenchmarkProtectedMarketData({
      definition: GLASS,
      current,
      incomingMinutes: tailMinutes,
      remoteMappings: [],
      protection: metadata,
      rebuildStartMs: parseBeijing('2026-10-09 21:00:00'),
      coverageEndMs: parseBeijing('2026-10-09 23:00:00'),
    });

    expect(current.bars60).toHaveLength(1);
    expect(result.bars60).toHaveLength(2);
    expect(result.bars60[0]).toEqual(current.bars60[0]);
    expect(result.bars5.filter(bar => (
      bar.startMs >= parseBeijing('2026-10-09 22:00:00')
      && bar.endMs <= parseBeijing('2026-10-09 22:30:00')
    ))).toEqual(current.bars5.slice(-6));
    expect(result.bars60[1]).toEqual(
      aggregateFiveMinuteBars(
        result.bars5,
        GLASS.tradingSessions,
      ).filter(bar => bar.complete)[1],
    );
    expect(result.bars60[1]).toMatchObject({
      start: '2026-10-09 22:00:00',
      end: '2026-10-09 23:00:00',
      observedMinutes: 60,
      expectedMinutes: 60,
      complete: true,
    });
    expect(result.protectionFingerprint?.before)
      .toBe(result.protectionFingerprint?.after);
  });

  it('keeps the existing unprotected merge behavior available to other instruments', () => {
    const current = fixture();
    const tailMinutes = minuteSequence('2026-10-09 22:00:00', 60);
    const result = mergeBenchmarkProtectedMarketData({
      definition: GLASS,
      current,
      incomingMinutes: tailMinutes,
      remoteMappings: [],
      rebuildStartMs: parseBeijing('2026-10-09 22:00:00'),
      coverageEndMs: parseBeijing('2026-10-09 23:00:00'),
    });

    expect(result.bars5).toHaveLength(24);
    expect(result.bars60).toHaveLength(2);
    expect(result.minuteReconciliation).toBeUndefined();
    expect(result.protectionFingerprint).toBeUndefined();
  });
});
