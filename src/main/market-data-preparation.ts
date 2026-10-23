import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import {
  primeTimeIndexForRecords,
  timeIndexMetadataForRecords,
} from '../domain/time-index';
import { parseAudit } from '../domain/data';
import type { Anomaly } from '../shared/types';
import {
  prepareSnapshotDirectory,
  type LoadedMarketSnapshot,
  type SnapshotDirectoryLoadRequest,
} from './market-snapshot';
import type {
  MarketDataWorkerOperation,
  MarketDataWorkerRequest,
  MarketDataWorkerResponse,
  MarketDataWorkerValue,
  PreparedSnapshotDirectory,
  SerializedWorkerError,
  SnapshotTimeIndexMetadata,
} from './market-data-worker-protocol';

export interface MarketDataPreparationBackend {
  loadSnapshotDirectory(
    request: SnapshotDirectoryLoadRequest,
  ): Promise<LoadedMarketSnapshot>;
  loadAudit(paths: string[]): Promise<Anomaly[]>;
  dispose(): Promise<void>;
}

export type MarketDataWorkerFactory = (scriptPath: string) => Worker;

function snapshotTimeIndexes(
  snapshot: LoadedMarketSnapshot,
): SnapshotTimeIndexMetadata {
  return {
    bars1: timeIndexMetadataForRecords(snapshot.bars1),
    bars5: timeIndexMetadataForRecords(snapshot.bars5),
    bars60: timeIndexMetadataForRecords(snapshot.bars60),
  };
}

function primeSnapshotTimeIndexes(
  prepared: PreparedSnapshotDirectory,
): LoadedMarketSnapshot {
  const { snapshot, timeIndexes } = prepared;
  primeTimeIndexForRecords(snapshot.bars1, timeIndexes.bars1);
  primeTimeIndexForRecords(snapshot.bars5, timeIndexes.bars5);
  primeTimeIndexForRecords(snapshot.bars60, timeIndexes.bars60);
  return snapshot;
}

async function readFirst(paths: string[]): Promise<string> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('没有可读取的审计文件');
}

export function createLocalMarketDataPreparation():
MarketDataPreparationBackend {
  return {
    async loadSnapshotDirectory(request) {
      const snapshot = await prepareSnapshotDirectory(request);
      snapshotTimeIndexes(snapshot);
      return snapshot;
    },
    async loadAudit(paths) {
      return parseAudit(await readFirst(paths));
    },
    async dispose() {},
  };
}

function workerError(serialized: SerializedWorkerError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  error.stack = serialized.stack ?? error.stack;
  if (serialized.code) {
    (error as NodeJS.ErrnoException).code = serialized.code;
  }
  return error;
}

export function createWorkerMarketDataPreparation(
  scriptPath: string,
  workerFactory: MarketDataWorkerFactory = path => new Worker(path),
): MarketDataPreparationBackend {
  let worker: Worker | undefined;
  let nextRequestId = 1;
  let disposed = false;
  const pending = new Map<number, {
    resolve: (value: MarketDataWorkerValue) => void;
    reject: (error: Error) => void;
  }>();

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function currentWorker(): Worker {
    if (disposed) throw new Error('行情数据准备 Worker 已关闭');
    if (worker) return worker;
    const created = workerFactory(scriptPath);
    worker = created;
    created.on('message', (response: MarketDataWorkerResponse) => {
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.ok) request.resolve(response.value);
      else request.reject(workerError(response.error));
    });
    created.on('error', error => {
      if (worker !== created) return;
      worker = undefined;
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
    created.on('exit', code => {
      if (worker !== created) return;
      worker = undefined;
      if (pending.size || code !== 0) {
        rejectPending(new Error(`行情数据准备 Worker 异常退出（代码 ${code}）`));
      }
    });
    return created;
  }

  function request(operation: MarketDataWorkerOperation): Promise<MarketDataWorkerValue> {
    const target = currentWorker();
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message: MarketDataWorkerRequest = { id, operation };
      try {
        target.postMessage(message);
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    async loadSnapshotDirectory(snapshotRequest) {
      const value = await request({
        type: 'load-snapshot-directory',
        request: snapshotRequest,
      });
      return primeSnapshotTimeIndexes(value as PreparedSnapshotDirectory);
    },
    async loadAudit(paths) {
      return await request({ type: 'load-audit', paths }) as Anomaly[];
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      rejectPending(new Error('行情数据准备 Worker 已关闭'));
      const active = worker;
      worker = undefined;
      if (active) await active.terminate();
    },
  };
}

export async function prepareSnapshotDirectoryForWorker(
  request: SnapshotDirectoryLoadRequest,
): Promise<PreparedSnapshotDirectory> {
  const snapshot = await prepareSnapshotDirectory(request);
  return {
    snapshot,
    timeIndexes: snapshotTimeIndexes(snapshot),
  };
}

export async function readAuditForWorker(paths: string[]): Promise<Anomaly[]> {
  return parseAudit(await readFirst(paths));
}
