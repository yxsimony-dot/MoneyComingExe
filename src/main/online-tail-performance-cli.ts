import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  arch,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem,
} from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  parseEdbMinuteCsv,
  serializeMinuteRecords,
} from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import { DEFAULT_INSTRUMENT } from '../shared/instruments';
import type {
  Bar,
  EdbMinuteRecord,
  MarketSnapshotMetadataV6,
  MarketUpdateState,
} from '../shared/types';
import { createDataService } from './data-service';
import {
  saveMarketSnapshot,
  writeBuiltinMarketSnapshot,
  type MarketDataPaths,
  type SaveSnapshotTimingPhase,
  type SnapshotCandidate,
} from './market-snapshot';
import { MarketUpdateCoordinator } from './market-update-coordinator';

const MINUTE_MS = 60_000;
const PERFORMANCE_THRESHOLD_MS = 20_000;
const COMPLETE_SNAPSHOT_BASELINE_P95_MS = 50_110.08;
const PRODUCTION_TAIL_COMPACTION_THRESHOLD = 64;
const SAMPLE_COUNT = 20;
const LONG_HISTORY_START = '2015-04-16';
const RECENT_MINUTE_START = '2025-10-13';
const BASELINE_END = '2026-10-09';
const MEASURED_DATE = '2026-10-12';
const CONTRACT = 'm2701';

interface SampleTiming {
  sample: number;
  requestEndAt: string;
  downloadReadParseMs: number;
  aggregationMs: number;
  serializationMs: number;
  writeMs: number;
  validationMs: number;
  activationMs: number;
  snapshotReloadMs: number;
  serviceReloadMs: number;
  updateMs: number;
  endToEndMs: number;
  activeSnapshotBytes: number;
  marketDataBytes: number;
  retainedSnapshotCount: number;
  snapshotUpdatedAt: string;
  sourceLatestAt: string;
  schemaVersion: 6;
  layerSequence: number;
  baseSnapshotId: string;
  replacementCutoff: string;
  added1: number;
  added5: number;
  added60: number;
}

interface ActiveMeasurement {
  sample: number;
  downloadReadParseMs?: number;
  fetchCompletedAt?: number;
  aggregationMs?: number;
  savePhases: Partial<Record<SaveSnapshotTimingPhase, number>>;
  saveCount: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let current = startMs; current <= endMs; current += 24 * 60 * MINUTE_MS) {
    const day = new Date(current).getUTCDay();
    if (day >= 1 && day <= 5) dates.push(isoDate(current));
  }
  return dates;
}

function wallTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
}

function priceFields(index: number) {
  const open = 2_500 + (index % 1_000) * 0.1;
  const close = open + (index % 2 === 0 ? 0.2 : -0.2);
  return {
    open,
    high: Math.max(open, close) + 0.4,
    low: Math.min(open, close) - 0.4,
    close,
    volume: 10 + index % 90,
    openOi: 100_000 + index,
    closeOi: 100_001 + index,
  };
}

function generateFiveMinuteHistory(start: string, end: string): Bar[] {
  const bars: Bar[] = [];
  let index = 0;
  for (const date of dateRange(start, end)) {
    const dayStartMs = parseBeijing(`${date} 00:00:00`);
    for (const session of DEFAULT_INSTRUMENT.tradingSessions) {
      for (const segment of session.segments) {
        for (
          let minute = segment.startMinute;
          minute < segment.endMinute;
          minute += 5
        ) {
          const startMs = dayStartMs + minute * MINUTE_MS;
          const endMs = startMs + 5 * MINUTE_MS;
          bars.push({
            startMs,
            endMs,
            start: formatBeijing(startMs),
            end: formatBeijing(endMs),
            ...priceFields(index),
            session: session.id,
            observedMinutes: 5,
            expectedMinutes: 5,
            complete: true,
          });
          index += 1;
        }
      }
    }
  }
  return bars;
}

function minuteRecord(startMs: number, index: number): EdbMinuteRecord {
  return {
    datetimeNano: (BigInt(startMs) * 1_000_000n).toString(),
    startMs,
    start: formatBeijing(startMs),
    ...priceFields(index),
  };
}

function generateMinuteHistory(start: string, end: string): EdbMinuteRecord[] {
  const records: EdbMinuteRecord[] = [];
  let index = 0;
  for (const date of dateRange(start, end)) {
    const dayStartMs = parseBeijing(`${date} 00:00:00`);
    for (const session of DEFAULT_INSTRUMENT.tradingSessions) {
      for (const segment of session.segments) {
        for (
          let minute = segment.startMinute;
          minute < segment.endMinute;
          minute += 1
        ) {
          records.push(minuteRecord(dayStartMs + minute * MINUTE_MS, index));
          index += 1;
        }
      }
    }
  }
  return records;
}

function generateMeasuredMinutes(startIndex: number): EdbMinuteRecord[] {
  const dayStartMs = parseBeijing(`${MEASURED_DATE} 00:00:00`);
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => (
    minuteRecord(dayStartMs + (9 * 60 + index) * MINUTE_MS, startIndex + index)
  ));
}

async function directorySize(path: string): Promise<number> {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await directorySize(join(path, entry.name));
  }
  return total;
}

async function retainedSnapshotCount(paths: MarketDataPaths): Promise<number> {
  const directory = join(
    paths.marketDataDirectory,
    'instruments',
    DEFAULT_INSTRUMENT.id,
    'snapshots',
  );
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .length;
}

async function stagingDirectoryCount(paths: MarketDataPaths): Promise<number> {
  const directory = join(
    paths.marketDataDirectory,
    'instruments',
    DEFAULT_INSTRUMENT.id,
  );
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('.staging-'))
    .length;
}

function percentile95(values: number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function requireTiming(
  value: number | undefined,
  label: string,
  sample: number,
): number {
  if (value === undefined) {
    assert.fail(`样本 ${sample} 缺少 ${label} 计时`);
  }
  return value;
}

async function readTailMetadata(
  directory: string,
): Promise<MarketSnapshotMetadataV6> {
  const value: unknown = JSON.parse(
    await readFile(join(directory, 'metadata.json'), 'utf8'),
  );
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const metadata = value as Record<string, unknown>;
  assert.equal(metadata.schemaVersion, 6, '测量快照必须使用 schema 6');
  assert.ok(
    Number.isSafeInteger(metadata.layerSequence)
      && (metadata.layerSequence as number) > 0,
    'schema 6 层序号无效',
  );
  assert.equal(typeof metadata.replacementCutoff, 'string');
  assert.ok(
    metadata.base
      && typeof metadata.base === 'object'
      && !Array.isArray(metadata.base),
    'schema 6 基础快照引用无效',
  );
  assert.equal(
    typeof (metadata.base as Record<string, unknown>).snapshotId,
    'string',
  );
  return value as MarketSnapshotMetadataV6;
}

function markdownReport(report: {
  generatedAt: string;
  passed: boolean;
  environment: {
    operatingSystem: string;
    node: string;
    cpu: string;
    logicalCpuCount: number;
    totalMemoryGiB: number;
  };
  fixture: {
    sha256: string;
    remoteRows: number;
    bars1: number;
    bars5: number;
    bars60: number;
  };
  summary: {
    sampleCount: number;
    thresholdMs: number;
    p95: Record<string, number>;
    baselineActiveSnapshotBytes: number;
    finalActiveSnapshotBytes: number;
    baselineMarketDataBytes: number;
    finalMarketDataBytes: number;
    peakMarketDataBytes: number;
    diskGrowthBytes: number;
    peakDiskGrowthBytes: number;
    maximumActiveUpdates: number;
    maximumActiveSaves: number;
    maximumRetainedSnapshots: number;
    stagingDirectoryCount: number;
  };
  strategy: {
    completeSnapshotBaselineP95Ms: number;
    schemaVersion: 6;
    baseSnapshotId: string;
    replacementCutoff: string;
    firstLayerSequence: number;
    finalLayerSequence: number;
    compactionThreshold: number;
  };
  decision: string;
}): string {
  const p95 = report.summary.p95;
  return `# 在线尾部更新性能验收

## 结论

- 验收时间：${report.generatedAt}
- 结果：${report.passed ? '通过' : '未通过'}
- 发布决策：${report.decision}
- 样本数：${report.summary.sampleCount}
- 端到端 p95：${fixed(p95.endToEndMs)} ms
- 门槛：严格低于 ${report.summary.thresholdMs} ms
- 原完整快照基线 p95：${fixed(report.strategy.completeSnapshotBaselineP95Ms)} ms（未通过）

## 环境

- 操作系统：${report.environment.operatingSystem}
- Node.js：${report.environment.node}
- CPU：${report.environment.cpu}
- 逻辑处理器：${report.environment.logicalCpuCount}
- 内存：${fixed(report.environment.totalMemoryGiB)} GiB

## 固定夹具

- 夹具 SHA-256：\`${report.fixture.sha256}\`
- 远端分钟记录：${report.fixture.remoteRows}
- 基线 1 分钟记录：${report.fixture.bars1}
- 基线 5 分钟记录：${report.fixture.bars5}
- 基线 60 分钟记录：${report.fixture.bars60}

## p95 分阶段结果

| 阶段 | p95 (ms) |
| --- | ---: |
| 下载/读取与解析 | ${fixed(p95.downloadReadParseMs)} |
| 聚合与候选构建 | ${fixed(p95.aggregationMs)} |
| 序列化 | ${fixed(p95.serializationMs)} |
| 文件写入 | ${fixed(p95.writeMs)} |
| 候选校验 | ${fixed(p95.validationMs)} |
| 原子激活与清理 | ${fixed(p95.activationMs)} |
| 快照内部重载 | ${fixed(p95.snapshotReloadMs)} |
| 数据服务重载 | ${fixed(p95.serviceReloadMs)} |
| 端到端 | ${fixed(p95.endToEndMs)} |

## 存储与串行性

- 首个测量前活动快照：${report.summary.baselineActiveSnapshotBytes} bytes
- 最终活动快照：${report.summary.finalActiveSnapshotBytes} bytes
- 首个测量前行情目录：${report.summary.baselineMarketDataBytes} bytes
- 最终行情目录：${report.summary.finalMarketDataBytes} bytes
- 峰值行情目录：${report.summary.peakMarketDataBytes} bytes
- 连续运行最终磁盘增长：${report.summary.diskGrowthBytes} bytes
- 连续运行峰值磁盘增长：${report.summary.peakDiskGrowthBytes} bytes
- 最大并发更新：${report.summary.maximumActiveUpdates}
- 最大并发候选写入：${report.summary.maximumActiveSaves}
- 最大保留快照数：${report.summary.maximumRetainedSnapshots}
- 遗留 staging 目录：${report.summary.stagingDirectoryCount}

## 快照策略

- 测量快照 schema：${report.strategy.schemaVersion}
- 已验证基础快照：\`${report.strategy.baseSnapshotId}\`
- 固定替换起点：${report.strategy.replacementCutoff}
- 测量层序号：${report.strategy.firstLayerSequence} 至 ${report.strategy.finalLayerSequence}
- 生产压实阈值：${report.strategy.compactionThreshold} 层
- 清理保留集合：当前快照、前一快照、schema 6 直接引用的 schema 5 基础快照

## 方法

场景使用生产 \`MarketUpdateCoordinator\`、\`saveMarketSnapshot()\` 和数据服务重载路径。夹具包含从 ${LONG_HISTORY_START} 到 ${BASELINE_END} 的目标体量 5/60 分钟历史，以及从 ${RECENT_MINUTE_START} 开始的近期后台 1 分钟尾部。完整补齐预热先生成一个经过完整校验的 schema 5 基础快照；随后按北京时间 ${MEASURED_DATE} 09:01:05 至 09:20:05 串行执行 20 次单分钟尾部更新，每次原子激活一个直接引用该基础快照的有界 schema 6 替换尾部，并在完成数据服务重载后才开始下一轮。生产路径在尾部层达到 ${PRODUCTION_TAIL_COMPACTION_THRESHOLD} 时压实回新的 schema 5 基础快照。
`;
}

const root = resolve('.');
const sandbox = await mkdtemp(join(tmpdir(), 'moneycoming-online-tail-performance-'));
assert.ok(resolve(sandbox).startsWith(resolve(tmpdir())));
const paths: MarketDataPaths = {
  builtinDataDirectory: join(sandbox, 'builtin'),
  marketDataDirectory: join(sandbox, 'market-data'),
};
const fixturePath = join(sandbox, 'remote-minute-tail.csv');
const artifactDirectory = join(root, 'artifacts');
const documentationPath = join(root, 'docs', '在线尾部性能验收.md');

try {
  const recentMinutes = generateMinuteHistory(RECENT_MINUTE_START, BASELINE_END);
  const historicalBars5 = generateFiveMinuteHistory(
    LONG_HISTORY_START,
    '2025-10-10',
  );
  const recentBars5 = aggregateMinutes(
    recentMinutes,
    5,
    recentMinutes.at(-1)!.startMs + MINUTE_MS,
    DEFAULT_INSTRUMENT.tradingSessions,
  ).filter(bar => bar.complete);
  const bars5 = [...historicalBars5, ...recentBars5];
  const bars60 = aggregateFiveMinuteBars(
    bars5,
    DEFAULT_INSTRUMENT.tradingSessions,
  ).filter(bar => bar.complete);
  const sourceLatestAt = formatBeijing(recentMinutes.at(-1)!.startMs + MINUTE_MS);
  const baselineCandidate: SnapshotCandidate = {
    bars1: recentMinutes,
    bars5,
    bars60,
    mainContractMappings: [
      { tradingDate: BASELINE_END, contract: CONTRACT },
    ],
    rollovers: [],
    requestStart: `${LONG_HISTORY_START} 09:00:00`,
    requestEnd: sourceLatestAt,
    sourceLatestAt,
  };
  await writeBuiltinMarketSnapshot(
    paths,
    DEFAULT_INSTRUMENT,
    baselineCandidate,
    { now: () => new Date('2026-10-09T15:00:00.000Z') },
  );

  const fridayNight = recentMinutes.filter(record => (
    record.start >= `${BASELINE_END} 21:00:00`
  ));
  const measuredMinutes = generateMeasuredMinutes(recentMinutes.length);
  const remoteMinutes = [...fridayNight, ...measuredMinutes];
  const fixtureText = serializeMinuteRecords(
    remoteMinutes,
    DEFAULT_INSTRUMENT.tradingSessions,
  );
  await writeFile(fixturePath, fixtureText, 'utf8');
  const fixtureSha256 = createHash('sha256').update(fixtureText).digest('hex');

  const service = createDataService(paths);
  let now = new Date('2026-10-12T09:00:05+08:00');
  let snapshotSequence = 0;
  let activeMeasurement: ActiveMeasurement | undefined;
  let activeUpdates = 0;
  let maximumActiveUpdates = 0;
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const publishedStates: MarketUpdateState[] = [];

  const coordinator = new MarketUpdateCoordinator({
    loadSnapshot: definition => service.loadSnapshot(definition.id),
    fetchMinutes: async (_definition, startMs, endMs) => {
      const started = performance.now();
      const parsed = parseEdbMinuteCsv(
        await readFile(fixturePath, 'utf8'),
        '固定在线尾部性能夹具',
        DEFAULT_INSTRUMENT.tradingSessions,
      ).filter(record => record.startMs >= startMs && record.startMs < endMs);
      if (activeMeasurement) {
        activeMeasurement.downloadReadParseMs = performance.now() - started;
        activeMeasurement.fetchCompletedAt = performance.now();
      }
      return parsed;
    },
    fetchContractMappings: async () => [
      { tradingDate: MEASURED_DATE, contract: CONTRACT },
    ],
    saveSnapshot: async (definition, candidate, intent, current) => {
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      if (activeMeasurement) {
        activeMeasurement.saveCount += 1;
        activeMeasurement.aggregationMs = performance.now()
          - requireTiming(
              activeMeasurement.fetchCompletedAt,
              'fetchCompletedAt',
              activeMeasurement.sample,
            );
      }
      const snapshotId = `performance-${String(++snapshotSequence).padStart(3, '0')}`;
      try {
        return await saveMarketSnapshot(paths, definition, candidate, {
          intent,
          current,
          now: () => new Date(now.getTime()),
          idFactory: () => snapshotId,
          onTiming: (phase, durationMs) => {
            if (activeMeasurement) {
              activeMeasurement.savePhases[phase] = durationMs;
            }
          },
        });
      } finally {
        activeSaves -= 1;
      }
    },
    invalidate: instrument => service.invalidate(instrument),
    publish: state => publishedStates.push(state),
    now: () => new Date(now.getTime()),
  });

  const warmup = await coordinator.update(DEFAULT_INSTRUMENT.id, 'full');
  assert.equal(warmup.phase, 'succeeded', JSON.stringify(warmup));
  const warmupLoad = await service.load(DEFAULT_INSTRUMENT.id, true);
  assert.equal(warmupLoad.ok, true);
  const warmupMetadata = JSON.parse(
    await readFile(join(warmupLoad.data.dataDirectory, 'metadata.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(warmupMetadata.schemaVersion, 5);
  const baselineActiveSnapshotBytes = await directorySize(
    warmupLoad.data.dataDirectory,
  );
  const baselineMarketDataBytes = await directorySize(paths.marketDataDirectory);

  const samples: SampleTiming[] = [];
  for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
    const minuteText = String(sample).padStart(2, '0');
    now = new Date(`${MEASURED_DATE}T09:${minuteText}:05+08:00`);
    const measurement: ActiveMeasurement = {
      sample,
      savePhases: {},
      saveCount: 0,
    };
    activeMeasurement = measurement;
    activeUpdates += 1;
    maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
    const started = performance.now();
    try {
      const state = await coordinator.update(DEFAULT_INSTRUMENT.id, 'tail');
      const updateMs = performance.now() - started;
      assert.equal(state.phase, 'succeeded', JSON.stringify(state));
      assert.equal(state.intent, 'tail');
      assert.equal(measurement.saveCount, 1);
      const serviceReloadStarted = performance.now();
      const loaded = await service.load(DEFAULT_INSTRUMENT.id, true);
      const serviceReloadMs = performance.now() - serviceReloadStarted;
      assert.equal(loaded.ok, true);
      assert.equal(
        loaded.data.bars1.length,
        recentMinutes.length + sample,
      );
      const endToEndMs = performance.now() - started;
      const metadata = await readTailMetadata(loaded.data.dataDirectory);
      assert.equal(metadata.layerSequence, sample);
      if (samples.length) {
        assert.equal(metadata.base.snapshotId, samples[0].baseSnapshotId);
        assert.equal(metadata.replacementCutoff, samples[0].replacementCutoff);
      }
      const activeSnapshotBytes = await directorySize(loaded.data.dataDirectory);
      const marketDataBytes = await directorySize(paths.marketDataDirectory);
      samples.push({
        sample,
        requestEndAt: formatBeijing(now.getTime()).slice(0, 16) + ':00',
        downloadReadParseMs: requireTiming(
          measurement.downloadReadParseMs,
          'downloadReadParseMs',
          sample,
        ),
        aggregationMs: requireTiming(
          measurement.aggregationMs,
          'aggregationMs',
          sample,
        ),
        serializationMs: requireTiming(
          measurement.savePhases.serialization,
          'serialization',
          sample,
        ),
        writeMs: requireTiming(measurement.savePhases.write, 'write', sample),
        validationMs: requireTiming(
          measurement.savePhases.validation,
          'validation',
          sample,
        ),
        activationMs: requireTiming(
          measurement.savePhases.activation,
          'activation',
          sample,
        ),
        snapshotReloadMs: requireTiming(
          measurement.savePhases.reload,
          'reload',
          sample,
        ),
        serviceReloadMs,
        updateMs,
        endToEndMs,
        activeSnapshotBytes,
        marketDataBytes,
        retainedSnapshotCount: await retainedSnapshotCount(paths),
        snapshotUpdatedAt: state.snapshotUpdatedAt!,
        sourceLatestAt: state.sourceLatestAt!,
        schemaVersion: metadata.schemaVersion,
        layerSequence: metadata.layerSequence,
        baseSnapshotId: metadata.base.snapshotId,
        replacementCutoff: metadata.replacementCutoff,
        added1: state.counts!.added1,
        added5: state.counts!.added5,
        added60: state.counts!.added60,
      });
    } finally {
      activeUpdates -= 1;
      activeMeasurement = undefined;
    }
  }

  const phaseKeys = [
    'downloadReadParseMs',
    'aggregationMs',
    'serializationMs',
    'writeMs',
    'validationMs',
    'activationMs',
    'snapshotReloadMs',
    'serviceReloadMs',
    'updateMs',
    'endToEndMs',
  ] as const;
  const p95 = Object.fromEntries(
    phaseKeys.map(key => [key, percentile95(samples.map(sample => sample[key]))]),
  ) as Record<typeof phaseKeys[number], number>;
  const finalSample = samples.at(-1)!;
  const peakMarketDataBytes = Math.max(
    baselineMarketDataBytes,
    ...samples.map(sample => sample.marketDataBytes),
  );
  const stagingCount = await stagingDirectoryCount(paths);
  const allSucceeded = samples.length === SAMPLE_COUNT
    && samples.every(sample => sample.added1 === 1);
  const schema6Verified = samples.every(sample => (
    sample.schemaVersion === 6
      && sample.layerSequence === sample.sample
      && sample.baseSnapshotId === samples[0].baseSnapshotId
      && sample.replacementCutoff === samples[0].replacementCutoff
  ));
  const passed = p95.endToEndMs < PERFORMANCE_THRESHOLD_MS
    && allSucceeded
    && schema6Verified
    && maximumActiveUpdates === 1
    && maximumActiveSaves === 1
    && samples.every(sample => sample.retainedSnapshotCount <= 3)
    && stagingCount === 0;
  const decision = passed
    ? '原完整快照性能未通过；已验证基础快照 + 有界 schema 6 尾部增量 + 定期 schema 5 压实方案通过性能门槛。'
    : '原完整快照性能未通过；已引入基础快照、schema 6 有界尾部增量和定期压实，但本次重新测量仍未通过发布门槛。';
  const firstSample = samples[0];
  const report = {
    generatedAt: new Date().toISOString(),
    passed,
    gate: {
      metric: 'endToEndMs.p95',
      comparison: '<',
      thresholdMs: PERFORMANCE_THRESHOLD_MS,
      actualMs: p95.endToEndMs,
    },
    environment: {
      operatingSystem: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryGiB: totalmem() / 2 ** 30,
    },
    fixture: {
      path: fixturePath,
      sha256: fixtureSha256,
      remoteRows: remoteMinutes.length,
      fridayOverlapRows: fridayNight.length,
      measuredRows: measuredMinutes.length,
      historyStart: LONG_HISTORY_START,
      recentMinuteStart: RECENT_MINUTE_START,
      baselineEnd: BASELINE_END,
      bars1: recentMinutes.length,
      bars5: bars5.length,
      bars60: bars60.length,
    },
    warmup: {
      intent: warmup.intent,
      phase: warmup.phase,
      sourceLatestAt: warmup.sourceLatestAt,
      snapshotUpdatedAt: warmup.snapshotUpdatedAt,
      schemaVersion: warmupMetadata.schemaVersion,
    },
    summary: {
      sampleCount: SAMPLE_COUNT,
      thresholdMs: PERFORMANCE_THRESHOLD_MS,
      p95,
      baselineActiveSnapshotBytes,
      finalActiveSnapshotBytes: finalSample.activeSnapshotBytes,
      baselineMarketDataBytes,
      finalMarketDataBytes: finalSample.marketDataBytes,
      peakMarketDataBytes,
      diskGrowthBytes: finalSample.marketDataBytes - baselineMarketDataBytes,
      peakDiskGrowthBytes: peakMarketDataBytes - baselineMarketDataBytes,
      maximumActiveUpdates,
      maximumActiveSaves,
      maximumRetainedSnapshots: Math.max(
        ...samples.map(sample => sample.retainedSnapshotCount),
      ),
      stagingDirectoryCount: stagingCount,
      publishedSucceededStates: publishedStates.filter(
        state => state.phase === 'succeeded',
      ).length,
    },
    strategy: {
      completeSnapshotBaselineP95Ms: COMPLETE_SNAPSHOT_BASELINE_P95_MS,
      schemaVersion: 6 as const,
      baseSnapshotId: firstSample.baseSnapshotId,
      replacementCutoff: firstSample.replacementCutoff,
      firstLayerSequence: firstSample.layerSequence,
      finalLayerSequence: finalSample.layerSequence,
      compactionThreshold: PRODUCTION_TAIL_COMPACTION_THRESHOLD,
    },
    samples,
    decision,
  };
  const markdown = markdownReport(report);
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(resolve(documentationPath, '..'), { recursive: true });
  await writeFile(
    join(artifactDirectory, 'online-tail-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(artifactDirectory, 'online-tail-performance.md'),
    markdown,
    'utf8',
  );
  await writeFile(documentationPath, markdown, 'utf8');
  console.log(JSON.stringify({
    passed,
    sampleCount: SAMPLE_COUNT,
    endToEndP95Ms: p95.endToEndMs,
    thresholdMs: PERFORMANCE_THRESHOLD_MS,
    maximumActiveSaves,
    diskGrowthBytes: report.summary.diskGrowthBytes,
    decision,
  }));
  assert.equal(passed, true, decision);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
