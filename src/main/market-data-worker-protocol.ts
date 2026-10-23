import type { TimeSeriesIndexMetadata } from '../domain/time-index';
import type { Anomaly } from '../shared/types';
import type {
  LoadedMarketSnapshot,
  SnapshotDirectoryLoadRequest,
} from './market-snapshot';

export interface SnapshotTimeIndexMetadata {
  bars1: TimeSeriesIndexMetadata;
  bars5: TimeSeriesIndexMetadata;
  bars60: TimeSeriesIndexMetadata;
}

export interface PreparedSnapshotDirectory {
  snapshot: LoadedMarketSnapshot;
  timeIndexes: SnapshotTimeIndexMetadata;
}

export type MarketDataWorkerOperation =
  | {
      type: 'load-snapshot-directory';
      request: SnapshotDirectoryLoadRequest;
    }
  | {
      type: 'load-audit';
      paths: string[];
    };

export interface MarketDataWorkerRequest {
  id: number;
  operation: MarketDataWorkerOperation;
}

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export type MarketDataWorkerValue =
  | PreparedSnapshotDirectory
  | Anomaly[];

export type MarketDataWorkerResponse =
  | {
      id: number;
      ok: true;
      value: MarketDataWorkerValue;
    }
  | {
      id: number;
      ok: false;
      error: SerializedWorkerError;
    };
