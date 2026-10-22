import type {
  ExchangeId,
  Instrument,
  TradingSessionId,
} from '../shared/instruments';

export interface ContractFiveMinuteImportRecord {
  instrumentId: Instrument;
  sourceExchange: string;
  sourceContract: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number;
  provenance: {
    sourceId: string;
    relativePath: string;
    line: number;
  };
}

export interface NormalizedContractFiveMinuteRecord {
  instrumentId: Instrument;
  exchange: ExchangeId;
  contract: string;
  expiryYear: number;
  expiryMonth: number;
  startMs: number;
  start: string;
  endMs: number;
  end: string;
  tradingDate: string;
  session: TradingSessionId;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number;
  provenance: ContractFiveMinuteImportRecord['provenance'];
}

export interface ContractHistoryPageRequest {
  instrument: Instrument;
  contract: string;
  cursor?: string;
  pageSize?: number;
}

export interface ContractHistorySourceFile {
  relativePath: string;
  sha256: string;
  bytes: number;
  rows: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export type DesktopFuturesHistoryKind = 'main-continuous' | 'contract';

export interface DesktopFuturesMinuteRecord {
  instrumentId: Instrument;
  sourceExchange: string;
  sourceSymbol: string;
  kind: DesktopFuturesHistoryKind;
  timestamp: string;
  endTimestamp?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  amount: number | null;
  volume: number | null;
  openInterest: number | null;
  provenance: {
    sourceId: string;
    relativePath: string;
    line: number;
    archiveMember?: string;
  };
}

export interface DesktopFuturesHistoryFile extends ContractHistorySourceFile {
  format: 'desktop-main-continuous-v1' | 'desktop-contract-v1';
  storage: 'csv' | 'zip-member';
  archiveRelativePath?: string;
  archiveMember?: string;
  compressedBytes?: number;
}

export interface DesktopFuturesHistoryPageRequest {
  instrument: Instrument;
  contract?: string;
  cursor?: string;
  pageSize?: number;
}

export interface DesktopFuturesHistoryPage {
  records: DesktopFuturesMinuteRecord[];
  sourceFile: DesktopFuturesHistoryFile;
  nextCursor?: string;
}

export type DesktopFuturesHistoryScanVisitor = (
  record: DesktopFuturesMinuteRecord,
) => void | Promise<void>;

export interface DesktopFuturesHistorySource {
  readonly description: ContractHistorySourceDescription;
  listContracts(instrument: Instrument): Promise<string[]>;
  inspectMainFile(instrument: Instrument): Promise<DesktopFuturesHistoryFile>;
  inspectContractFile(
    request: Pick<DesktopFuturesHistoryPageRequest, 'instrument' | 'contract'>,
  ): Promise<DesktopFuturesHistoryFile>;
  readMainPage(
    request: Omit<DesktopFuturesHistoryPageRequest, 'contract'>,
  ): Promise<DesktopFuturesHistoryPage>;
  readContractPage(
    request: DesktopFuturesHistoryPageRequest & { contract: string },
  ): Promise<DesktopFuturesHistoryPage>;
  scanMainRecords(
    instrument: Instrument,
    visitor: DesktopFuturesHistoryScanVisitor,
  ): Promise<DesktopFuturesHistoryFile>;
  scanContractRecords(
    request: Pick<DesktopFuturesHistoryPageRequest, 'instrument' | 'contract'>,
    visitor: DesktopFuturesHistoryScanVisitor,
  ): Promise<DesktopFuturesHistoryFile>;
}

export interface ContractHistorySourceDescription {
  sourceId: string;
  sourceName: string;
  sourceVersion?: string;
  acquiredAt?: string;
  license: {
    identifier?: string;
    redistributionAllowed: boolean;
    conclusion: string;
  };
}

export interface ContractHistoryPage {
  records: ContractFiveMinuteImportRecord[];
  sourceFile: ContractHistorySourceFile;
  nextCursor?: string;
}

export interface ContractFiveMinuteHistorySource {
  readonly description: ContractHistorySourceDescription;
  listContracts(instrument: Instrument): Promise<string[]>;
  inspectFile(
    request: Pick<ContractHistoryPageRequest, 'instrument' | 'contract'>,
  ): Promise<ContractHistorySourceFile>;
  readPage(request: ContractHistoryPageRequest): Promise<ContractHistoryPage>;
}

export interface ContractHistoryImportReport {
  schemaVersion: 1;
  status: 'succeeded' | 'rejected';
  instrumentId: Instrument;
  sourceContract: string;
  normalizedContract?: string;
  source: ContractHistorySourceDescription;
  sourceFile?: ContractHistorySourceFile;
  sourceCoverage?: {
    firstTimestamp: string;
    lastTimestamp: string;
  };
  normalizedCoverage?: {
    firstTimestamp: string;
    lastTimestamp: string;
    firstTradingDate: string;
    lastTradingDate: string;
  };
  rows: {
    source: number;
    accepted: number;
    identicalDuplicatesRemoved: number;
  };
  toolVersion: string;
  rejectionReasons: string[];
}

export type ContractHistoryImportResult =
  | {
      ok: true;
      records: NormalizedContractFiveMinuteRecord[];
      report: ContractHistoryImportReport & { status: 'succeeded' };
    }
  | {
      ok: false;
      records: [];
      report: ContractHistoryImportReport & { status: 'rejected' };
    };
