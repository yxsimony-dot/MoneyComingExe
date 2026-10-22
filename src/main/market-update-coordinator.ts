import {
  aggregateFiveMinuteBars,
  aggregateMinutes,
  assertBarsValid,
  assertMinuteRecordsValid,
  mergeBarsPreservingHistory,
  mergeMinuteHistory,
  reconcileBars,
  updateCounts,
} from '../domain/market-data';
import {
  detectContractRollovers,
  mergeMainContractMappings,
} from '../domain/contract-rollover';
import { formatBeijing, parseBeijing } from '../domain/time';
import {
  INSTRUMENT_IDS,
  instrumentDefinition,
  type InstrumentDefinition,
} from '../shared/instruments';
import type {
  ContractRollover,
  EdbMinuteRecord,
  Instrument,
  MainContractMapping,
  MarketSnapshotActivatedEvent,
  MarketUpdateAllResult,
  MarketUpdateCounts,
  MarketUpdateIntent,
  MarketUpdateState,
  PublicMarketUpdateError,
} from '../shared/types';
import type { LoadedMarketSnapshot, SnapshotCandidate } from './market-snapshot';
import { EdbClientError } from './edb-client';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const EMPTY_MINUTE_HISTORY_LOOKBACK_MS = 366 * DAY_MS;

export interface MarketUpdateCoordinatorOptions {
  loadSnapshot: (definition: InstrumentDefinition) => Promise<LoadedMarketSnapshot>;
  fetchMinutes: (
    definition: InstrumentDefinition,
    startMs: number,
    endMs: number,
  ) => Promise<EdbMinuteRecord[]>;
  fetchContractMappings: (
    definition: InstrumentDefinition,
    startMs: number,
    endMs: number,
  ) => Promise<MainContractMapping[]>;
  saveSnapshot: (
    definition: InstrumentDefinition,
    candidate: SnapshotCandidate,
    intent: MarketUpdateIntent,
    current: LoadedMarketSnapshot,
  ) => Promise<LoadedMarketSnapshot>;
  invalidate: (instrument: Instrument) => void;
  publish: (state: MarketUpdateState) => void;
  publishActivation?: (event: MarketSnapshotActivatedEvent) => void;
  now?: () => Date;
}

interface PendingOperation {
  intent: MarketUpdateIntent;
  promise: Promise<MarketUpdateState>;
  resolve: (state: MarketUpdateState) => void;
  reject: (error: unknown) => void;
}

interface OperationSlot {
  activeIntent: MarketUpdateIntent;
  activePromise: Promise<MarketUpdateState>;
  pending?: PendingOperation;
}

function publicError(error: unknown): PublicMarketUpdateError {
  const code: PublicMarketUpdateError['code'] = error instanceof EdbClientError
    ? error.code
    : error instanceof Error && /EDB|分钟|日线|行情|候选|合约|换月|匹配|对账|重叠|倒退|时间桶|OHLC/i.test(error.message)
        ? 'validation'
      : error instanceof Error && /快照|文件|目录|磁盘|ENOSPC|EACCES|EPERM/i.test(error.message)
        ? 'storage'
        : 'unexpected';
  if (error instanceof EdbClientError && code === 'network') {
    const status = /HTTP (\d{3})/.exec(error.message)?.[1];
    if (status) return { code, message: `EDB 返回 HTTP ${status}` };
    if (/超时/.test(error.message)) return { code, message: 'EDB 请求超时，请稍后重试' };
    return { code, message: '无法连接 EDB 数据源，请稍后重试' };
  }
  const messages: Record<PublicMarketUpdateError['code'], string> = {
    network: '无法连接 EDB 数据源，请稍后重试',
    'invalid-response': 'EDB 返回数据无效，请稍后重试',
    validation: 'EDB 行情校验失败，当前数据未受影响',
    storage: '行情快照保存失败，请检查磁盘后重试',
    unexpected: '行情更新失败，请稍后重试',
  };
  return { code, message: messages[code] };
}

function minuteLatestMs(
  snapshot: Pick<LoadedMarketSnapshot, 'bars1'>,
): number | undefined {
  const lastMinute = snapshot.bars1.at(-1);
  return lastMinute ? lastMinute.startMs + MINUTE_MS : undefined;
}

function latestDataMs(
  snapshot: Pick<LoadedMarketSnapshot, 'bars1' | 'bars5' | 'bars60'>,
): number | undefined {
  const values = [
    minuteLatestMs(snapshot),
    snapshot.bars5.at(-1)?.endMs,
    snapshot.bars60.at(-1)?.endMs,
  ].filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

function formatted(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : formatBeijing(ms);
}

export function requestStartFor(
  snapshot: LoadedMarketSnapshot,
  requestEndMs = Date.now(),
  intent: MarketUpdateIntent = 'full',
): number {
  if (intent === 'tail') {
    const complete = snapshot.bars60.filter(bar => bar.complete);
    const anchor = complete.at(-2) ?? complete.at(-1);
    if (anchor) return anchor.startMs;
  }
  const lastMinute = snapshot.bars1.at(-1);
  if (!lastMinute) {
    const lastFive = snapshot.bars5.at(-1);
    if (lastFive) {
      const date = formatBeijing(lastFive.startMs).slice(0, 10);
      return parseBeijing(`${date} 00:00:00`) - DAY_MS;
    }
    return Math.floor(
      (requestEndMs - EMPTY_MINUTE_HISTORY_LOOKBACK_MS) / MINUTE_MS,
    ) * MINUTE_MS;
  }
  const date = formatBeijing(lastMinute.startMs).slice(0, 10);
  return parseBeijing(`${date} 00:00:00`) - DAY_MS;
}

function changed(counts: MarketUpdateCounts): boolean {
  return Object.values(counts).some(value => value > 0);
}

function intentPriority(intent: MarketUpdateIntent): number {
  return intent === 'full' ? 2 : 1;
}

function assertHistoryCoverageNotRegressed(
  current: LoadedMarketSnapshot['bars5'],
  candidate: LoadedMarketSnapshot['bars5'],
  period: 5 | 60,
): void {
  if (!current.length) return;
  const currentFirst = current[0];
  const currentLast = current.at(-1)!;
  const candidateFirst = candidate[0];
  const candidateLast = candidate.at(-1);
  if (!candidateFirst || !candidateLast
    || candidateFirst.startMs > currentFirst.startMs
    || candidateLast.endMs < currentLast.endMs
    || candidateLast.endMs - candidateFirst.startMs
      < currentLast.endMs - currentFirst.startMs) {
    throw new Error(`${period} 分钟候选历史覆盖范围倒退，已拒绝覆盖当前快照`);
  }
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function sameBar(
  left: LoadedMarketSnapshot['bars5'][number],
  right: LoadedMarketSnapshot['bars5'][number],
): boolean {
  return left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.session === right.session
    && sameNumber(left.open, right.open)
    && sameNumber(left.high, right.high)
    && sameNumber(left.low, right.low)
    && sameNumber(left.close, right.close)
    && sameNumber(left.volume, right.volume)
    && sameNumber(left.openOi, right.openOi)
    && sameNumber(left.closeOi, right.closeOi)
    && left.observedMinutes === right.observedMinutes
    && left.expectedMinutes === right.expectedMinutes
    && left.complete === right.complete;
}

function assertFiveMinuteOverlap(
  current: readonly LoadedMarketSnapshot['bars5'][number][],
  remote: readonly LoadedMarketSnapshot['bars5'][number][],
): void {
  if (!current.length) return;
  const currentByStart = new Map(current.map(bar => [bar.startMs, bar]));
  const overlap = remote.filter(bar => currentByStart.has(bar.startMs));
  if (!overlap.length
    || !overlap.some(bar => sameBar(currentByStart.get(bar.startMs)!, bar))) {
    throw new Error('EDB 增量区间与当前 5 分钟快照没有可验证重叠');
  }
}

function replacementCounts(
  current: readonly LoadedMarketSnapshot['bars60'][number][],
  candidate: readonly LoadedMarketSnapshot['bars60'][number][],
) {
  const currentByStart = new Map(current.map(bar => [bar.startMs, bar]));
  const candidateByStart = new Map(candidate.map(bar => [bar.startMs, bar]));
  return {
    bars: [...candidate],
    added: candidate.filter(bar => !currentByStart.has(bar.startMs)).length,
    replaced: candidate.filter(bar => {
      const previous = currentByStart.get(bar.startMs);
      return previous !== undefined && !sameBar(previous, bar);
    }).length,
    removed: current.filter(bar => !candidateByStart.has(bar.startMs)).length,
  };
}

function sameMappings(
  left: readonly MainContractMapping[],
  right: readonly MainContractMapping[],
): boolean {
  return left.length === right.length && left.every((mapping, index) => (
    mapping.tradingDate === right[index]?.tradingDate
    && mapping.contract === right[index]?.contract
  ));
}

function sameRollover(left: ContractRollover, right: ContractRollover): boolean {
  return left.tradingDate === right.tradingDate
    && left.timeMs === right.timeMs
    && left.fromContract === right.fromContract
    && left.toContract === right.toContract;
}

function rolloverCounts(
  current: ContractRollover[],
  next: ContractRollover[],
): Pick<MarketUpdateCounts, 'addedRollovers' | 'replacedRollovers' | 'removedRollovers'> {
  const currentByDate = new Map(current.map(rollover => [rollover.tradingDate, rollover]));
  const nextByDate = new Map(next.map(rollover => [rollover.tradingDate, rollover]));
  return {
    addedRollovers: next.filter(rollover => !currentByDate.has(rollover.tradingDate)).length,
    replacedRollovers: next.filter(rollover => {
      const previous = currentByDate.get(rollover.tradingDate);
      return previous !== undefined && !sameRollover(previous, rollover);
    }).length,
    removedRollovers: current.filter(rollover => !nextByDate.has(rollover.tradingDate)).length,
  };
}

export class MarketUpdateCoordinator {
  private readonly states = new Map<Instrument, MarketUpdateState>();
  private readonly slots = new Map<Instrument, OperationSlot>();
  private readonly mappingRefresh = new Map<
    Instrument,
    { beijingDate?: string; failed: boolean }
  >();
  private readonly now: () => Date;

  constructor(private readonly options: MarketUpdateCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getState(instrument: Instrument): MarketUpdateState {
    return structuredClone(
      this.states.get(instrument) ?? { instrument, phase: 'idle' },
    );
  }

  update(
    instrument: Instrument,
    intent: MarketUpdateIntent = 'full',
  ): Promise<MarketUpdateState> {
    const slot = this.slots.get(instrument);
    if (!slot) {
      const created = {} as OperationSlot;
      this.slots.set(instrument, created);
      return this.startOperation(created, instrument, intent);
    }
    if (slot.pending
      && intentPriority(slot.pending.intent) >= intentPriority(intent)) {
      return slot.pending.promise;
    }
    if (intentPriority(slot.activeIntent) >= intentPriority(intent)) {
      return slot.activePromise;
    }
    let resolve!: PendingOperation['resolve'];
    let reject!: PendingOperation['reject'];
    const promise = new Promise<MarketUpdateState>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    slot.pending = { intent, promise, resolve, reject };
    return promise;
  }

  async updateAll(
    instruments: readonly Instrument[] = INSTRUMENT_IDS,
  ): Promise<MarketUpdateAllResult> {
    const startedAt = this.now().toISOString();
    const results: MarketUpdateState[] = [];
    for (const instrument of instruments) {
      results.push(await this.update(instrument, 'full'));
    }
    return {
      startedAt,
      completedAt: this.now().toISOString(),
      results,
    };
  }

  private startOperation(
    slot: OperationSlot,
    instrument: Instrument,
    intent: MarketUpdateIntent,
  ): Promise<MarketUpdateState> {
    const operation = this.run(instrumentDefinition(instrument), intent);
    slot.activeIntent = intent;
    slot.activePromise = operation;
    void operation.then(
      () => this.advanceSlot(instrument, slot),
      () => this.advanceSlot(instrument, slot),
    );
    return operation;
  }

  private advanceSlot(instrument: Instrument, slot: OperationSlot): void {
    if (this.slots.get(instrument) !== slot) return;
    const pending = slot.pending;
    if (!pending) {
      this.slots.delete(instrument);
      return;
    }
    slot.pending = undefined;
    const operation = this.startOperation(slot, instrument, pending.intent);
    void operation.then(pending.resolve, pending.reject);
  }

  private async run(
    definition: InstrumentDefinition,
    intent: MarketUpdateIntent,
  ): Promise<MarketUpdateState> {
    const instrument = definition.id;
    const startedAt = this.now().toISOString();
    let mappingRefreshAttempted = false;
    try {
      const current = await this.options.loadSnapshot(definition);
      const requestEndMs = Math.floor(this.now().getTime() / MINUTE_MS) * MINUTE_MS;
      const requestStartMs = requestStartFor(current, requestEndMs, intent);
      const localMinuteLatestMs = minuteLatestMs(current);
      const localLatestMs = latestDataMs(current);
      this.transition(instrument, {
        phase: 'fetching',
        intent,
        startedAt,
        completedAt: undefined,
        localLatestAt: formatted(localLatestMs),
        localMinuteLatestAt: formatted(localMinuteLatestMs),
        sourceLatestAt: undefined,
        requestStartAt: formatBeijing(requestStartMs),
        requestEndAt: formatBeijing(requestEndMs),
        snapshotUpdatedAt: current.snapshotUpdatedAt,
        counts: undefined,
        error: undefined,
      });
      const responseMinutes = await this.options.fetchMinutes(
        definition,
        requestStartMs,
        requestEndMs,
      );
      const minutes = responseMinutes.filter(
        record => record.startMs + MINUTE_MS <= requestEndMs,
      );
      if (!minutes.length) throw new Error('EDB 未返回可验证的重叠分钟数据');
      assertMinuteRecordsValid(minutes, definition.tradingSessions);
      const sourceLatestMs = minutes.at(-1)!.startMs + MINUTE_MS;
      const sourceLatestAt = formatBeijing(sourceLatestMs);
      this.transition(instrument, { phase: 'validating', sourceLatestAt });
      if (current.bars1.length) {
        const localMinuteStarts = new Set(current.bars1.map(record => record.startMs));
        if (!minutes.some(record => localMinuteStarts.has(record.startMs))) {
          throw new Error('EDB 增量区间与当前分钟快照没有可验证重叠');
        }
      }
      const minuteMerge = mergeMinuteHistory(current.bars1, minutes);
      const rebuildMinutes = minuteMerge.records.filter(
        record => record.startMs >= requestStartMs,
      );
      const coverageEndMs = Math.max(
        sourceLatestMs,
        minuteLatestMs(current) ?? Number.NEGATIVE_INFINITY,
      );
      const rebuilt5 = aggregateMinutes(
        rebuildMinutes,
        5,
        coverageEndMs,
        definition.tradingSessions,
      ).filter(bar => bar.complete);
      if (!current.bars1.length) {
        assertFiveMinuteOverlap(current.bars5, rebuilt5);
      }
      const five = rebuilt5.length
        ? mergeBarsPreservingHistory(current.bars5, rebuilt5)
        : {
            bars: [...current.bars5],
            added: 0,
            replaced: 0,
            removed: 0,
          };
      assertBarsValid(five.bars, 5, definition.tradingSessions);
      const rebuilt60 = aggregateFiveMinuteBars(
        five.bars,
        definition.tradingSessions,
      ).filter(bar => bar.complete);
      const sixty = replacementCounts(current.bars60, rebuilt60);
      reconcileBars(five.bars, sixty.bars, definition.tradingSessions);
      assertHistoryCoverageNotRegressed(current.bars5, five.bars, 5);
      assertHistoryCoverageNotRegressed(current.bars60, sixty.bars, 60);
      const requestBeijingDate = formatBeijing(requestEndMs).slice(0, 10);
      const latestTradingDate = minuteMerge.records.at(-1)?.start.slice(0, 10);
      const mappingState = this.mappingRefresh.get(instrument);
      const needsMappingRefresh = intent === 'full'
        || !mappingState
        || mappingState.failed
        || mappingState.beijingDate !== requestBeijingDate
        || (
          latestTradingDate !== undefined
          && !current.mainContractMappings.some(
            mapping => mapping.tradingDate === latestTradingDate,
          )
        );
      let mappings = current.mainContractMappings;
      if (needsMappingRefresh) {
        mappingRefreshAttempted = true;
        const mappingStartMs = intent === 'tail'
          ? parseBeijing(`${requestBeijingDate} 00:00:00`) - DAY_MS
          : requestStartMs;
        const remoteMappings = await this.options.fetchContractMappings(
          definition,
          mappingStartMs,
          requestEndMs,
        );
        mappings = mergeMainContractMappings(
          current.mainContractMappings,
          remoteMappings,
          definition,
        );
        this.mappingRefresh.set(instrument, {
          beijingDate: requestBeijingDate,
          failed: false,
        });
      }
      const rollovers = detectContractRollovers(mappings, five.bars, definition);
      const counts = {
        ...updateCounts(minuteMerge, five, sixty),
        ...rolloverCounts(current.rollovers, rollovers),
      };
      const mappingsChanged = !sameMappings(current.mainContractMappings, mappings);
      if (!changed(counts) && !mappingsChanged) {
        this.transition(instrument, {
          phase: 'up-to-date',
          completedAt: this.now().toISOString(),
          localLatestAt: formatted(latestDataMs(current)),
          localMinuteLatestAt: formatted(minuteLatestMs(current)),
          sourceLatestAt,
          counts,
          error: undefined,
        });
        return this.getState(instrument);
      }
      this.transition(instrument, { phase: 'saving', counts });
      const saved = await this.options.saveSnapshot(
        definition,
        {
          bars1: minuteMerge.records,
          bars5: five.bars,
          bars60: sixty.bars,
          mainContractMappings: mappings,
          rollovers,
          requestStart: formatBeijing(requestStartMs),
          requestEnd: formatBeijing(requestEndMs),
          sourceLatestAt,
        },
        intent,
        current,
      );
      this.options.invalidate(instrument);
      if (!saved.snapshotUpdatedAt) {
        throw new Error('快照激活时间缺失');
      }
      this.transition(instrument, {
        phase: 'succeeded',
        completedAt: this.now().toISOString(),
        localLatestAt: formatted(latestDataMs(saved)),
        localMinuteLatestAt: formatted(minuteLatestMs(saved)),
        sourceLatestAt,
        snapshotUpdatedAt: saved.snapshotUpdatedAt,
        counts,
        error: undefined,
      });
      this.options.publishActivation?.({
        instrument,
        snapshotUpdatedAt: saved.snapshotUpdatedAt,
        counts: structuredClone(counts),
        mappingsChanged,
      });
    } catch (error) {
      if (mappingRefreshAttempted) {
        this.mappingRefresh.set(instrument, {
          ...this.mappingRefresh.get(instrument),
          failed: true,
        });
      }
      this.transition(instrument, {
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: publicError(error),
      });
    }
    return this.getState(instrument);
  }

  private transition(
    instrument: Instrument,
    patch: Partial<Omit<MarketUpdateState, 'instrument'>>,
  ): void {
    const state: MarketUpdateState = {
      ...this.getState(instrument),
      ...patch,
      instrument,
    };
    this.states.set(instrument, state);
    this.options.publish(structuredClone(state));
  }
}
