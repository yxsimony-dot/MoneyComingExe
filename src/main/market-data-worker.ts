import { parentPort } from 'node:worker_threads';
import {
  prepareSnapshotDirectoryForWorker,
  readAuditForWorker,
} from './market-data-preparation';
import type {
  MarketDataWorkerRequest,
  MarketDataWorkerResponse,
  SerializedWorkerError,
} from './market-data-worker-protocol';

if (!parentPort) {
  throw new Error('行情数据准备 Worker 缺少父线程端口');
}
const port = parentPort;

function serializeError(error: unknown): SerializedWorkerError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) };
  }
  const code = (error as NodeJS.ErrnoException).code;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(code ? { code } : {}),
  };
}

port.on('message', async (message: MarketDataWorkerRequest) => {
  let response: MarketDataWorkerResponse;
  try {
    const value = message.operation.type === 'load-snapshot-directory'
      ? await prepareSnapshotDirectoryForWorker(message.operation.request)
      : await readAuditForWorker(message.operation.paths);
    response = { id: message.id, ok: true, value };
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      error: serializeError(error),
    };
  }
  port.postMessage(response);
});
