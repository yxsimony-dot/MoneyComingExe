import {
  aggregateMinutes,
  assertBarsValid,
  mergeBars,
  reconcileBars,
  updateCounts,
} from '../domain/market-data';
import { formatBeijing, parseBeijing } from '../domain/time';
import type {
  EdbMinuteRecord,
  MarketUpdateCounts,
  MarketUpdateState,
  PublicMarketUpdateError,
} from '../shared/types';
import type { LoadedMarketSnapshot, SnapshotCandidate } from './market-snapshot';
import { EdbClientError } from './edb-client';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export interface MarketUpdateCoordinatorOptions {
  loadSnapshot: () => Promise<LoadedMarketSnapshot>;
  fetchMinutes: (startMs: number, endMs: number) => Promise<EdbMinuteRecord[]>;
  saveSnapshot: (candidate: SnapshotCandidate) => Promise<LoadedMarketSnapshot>;
  invalidate: () => void;
  publish: (state: MarketUpdateState) => void;
  now?: () => Date;
}

function publicError(error: unknown): PublicMarketUpdateError {
  const code: PublicMarketUpdateError['code'] = error instanceof EdbClientError
    ? error.code
    : error instanceof Error && /EDB|分钟|行情|候选|对账|重叠|倒退|时间桶|OHLC/i.test(error.message)
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

function latestAt(snapshot: LoadedMarketSnapshot): number {
  return Math.max(snapshot.bars5.at(-1)?.endMs ?? 0, snapshot.bars60.at(-1)?.endMs ?? 0);
}

export function requestStartFor(snapshot: LoadedMarketSnapshot): number {
  const anchor = Math.max(snapshot.bars5.at(-1)?.startMs ?? 0, snapshot.bars60.at(-1)?.startMs ?? 0);
  if (!anchor) throw new Error('当前行情快照为空，无法执行增量更新');
  const date = formatBeijing(anchor).slice(0, 10);
  return parseBeijing(`${date} 00:00:00`) - DAY_MS;
}

function changed(counts: MarketUpdateCounts): boolean {
  return Object.values(counts).some(value => value > 0);
}

export class MarketUpdateCoordinator {
  private state: MarketUpdateState = { phase: 'idle' };
  private running?: Promise<MarketUpdateState>;
  private readonly now: () => Date;

  constructor(private readonly options: MarketUpdateCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getState(): MarketUpdateState {
    return structuredClone(this.state);
  }

  update(): Promise<MarketUpdateState> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<MarketUpdateState> {
    const startedAt = this.now().toISOString();
    try {
      const current = await this.options.loadSnapshot();
      const requestStartMs = requestStartFor(current);
      const requestEndMs = Math.floor(this.now().getTime() / MINUTE_MS) * MINUTE_MS;
      const localLatestMs = latestAt(current);
      this.transition({
        phase: 'fetching',
        startedAt,
        completedAt: undefined,
        localLatestAt: formatBeijing(localLatestMs),
        sourceLatestAt: undefined,
        snapshotUpdatedAt: current.snapshotUpdatedAt,
        counts: undefined,
        error: undefined,
      });
      const minutes = await this.options.fetchMinutes(requestStartMs, requestEndMs);
      if (!minutes.length) throw new Error('EDB 未返回可验证的重叠分钟数据');
      const sourceLatestMs = minutes.at(-1)!.startMs + MINUTE_MS;
      const sourceLatestAt = formatBeijing(sourceLatestMs);
      this.transition({ phase: 'validating', sourceLatestAt });
      const remote5 = aggregateMinutes(minutes, 5, sourceLatestMs);
      const remote60 = aggregateMinutes(minutes, 60, sourceLatestMs);
      const local5Starts = new Set(current.bars5.map(bar => bar.startMs));
      const local60Starts = new Set(current.bars60.map(bar => bar.startMs));
      if (!remote5.some(bar => local5Starts.has(bar.startMs))
        && !remote60.some(bar => local60Starts.has(bar.startMs))) {
        throw new Error('EDB 增量区间与当前快照没有可验证重叠');
      }
      const five = mergeBars(current.bars5, remote5, requestStartMs);
      const sixty = mergeBars(current.bars60, remote60, requestStartMs);
      assertBarsValid(five.bars, 5);
      assertBarsValid(sixty.bars, 60);
      reconcileBars(five.bars, sixty.bars);
      if ((five.bars.at(-1)?.endMs ?? 0) < (current.bars5.at(-1)?.endMs ?? 0)
        || (sixty.bars.at(-1)?.endMs ?? 0) < (current.bars60.at(-1)?.endMs ?? 0)) {
        throw new Error('候选行情时间倒退，已拒绝覆盖当前快照');
      }
      const counts = updateCounts(five, sixty);
      if (!changed(counts)) {
        this.transition({
          phase: 'up-to-date',
          completedAt: this.now().toISOString(),
          sourceLatestAt,
          counts,
          error: undefined,
        });
        return this.getState();
      }
      this.transition({ phase: 'saving', counts });
      const saved = await this.options.saveSnapshot({
        bars5: five.bars,
        bars60: sixty.bars,
        requestStart: formatBeijing(requestStartMs),
        requestEnd: formatBeijing(requestEndMs),
        sourceLatestAt,
      });
      this.options.invalidate();
      this.transition({
        phase: 'succeeded',
        completedAt: this.now().toISOString(),
        localLatestAt: formatBeijing(latestAt(saved)),
        sourceLatestAt,
        snapshotUpdatedAt: saved.snapshotUpdatedAt,
        counts,
        error: undefined,
      });
    } catch (error) {
      this.transition({
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: publicError(error),
      });
    }
    return this.getState();
  }

  private transition(patch: Partial<MarketUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.publish(this.getState());
  }
}
