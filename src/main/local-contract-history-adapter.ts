import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { Open, type File as ZipEntry } from 'unzipper';
import type {
  ContractFiveMinuteHistorySource,
  ContractFiveMinuteImportRecord,
  ContractHistoryPage,
  ContractHistoryPageRequest,
  ContractHistorySourceDescription,
  ContractHistorySourceFile,
  DesktopFuturesHistoryFile,
  DesktopFuturesHistoryPage,
  DesktopFuturesHistoryPageRequest,
  DesktopFuturesHistoryScanVisitor,
  DesktopFuturesHistorySource,
  DesktopFuturesMinuteRecord,
} from '../domain/contract-history-import';
import {
  instrumentDefinition,
  type InstrumentDefinition,
} from '../shared/instruments';

const SOURCE_COLUMNS = [
  'datetime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'money',
  'open_interest',
] as const;
const DEFAULT_PAGE_SIZE = 5_000;
const MAX_PAGE_SIZE = 10_000;
const DESKTOP_MAIN_COLUMNS = [
  'exchange',
  'symbol',
  'open',
  'close',
  'high',
  'low',
  'amount',
  'volume',
  'position',
  'bob',
  'eob',
  'type',
] as const;
const DESKTOP_CONTRACT_COLUMNS = [
  '日期',
  '开盘价',
  '最高价',
  '最低价',
  '收盘价',
  '成交额',
  '成交量',
  '持仓量',
] as const;

function splitCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        value += character;
      }
    } else if (character === ',') {
      values.push(value);
      value = '';
      quoteClosed = false;
    } else if (character === '"' && !value && !quoteClosed) {
      quoted = true;
    } else if (character === '"' || quoteClosed) {
      throw new Error('CSV 引号格式无效');
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  values.push(value);
  return values;
}

function parseFiniteNumber(value: string, field: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error(`${field} 必须为非空有限数值`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} 必须为非空有限数值`);
  return parsed;
}

function parseOptionalFiniteNumber(value: string, field: string): number | null {
  return value.trim() ? parseFiniteNumber(value, field) : null;
}

function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new Error(`分页游标无效：${cursor}`);
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error(`分页游标超出范围：${cursor}`);
  return offset;
}

function pageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`pageSize 必须是 1 到 ${MAX_PAGE_SIZE} 的整数`);
  }
  return value;
}

function sourceProductCode(definition: InstrumentDefinition): string {
  return definition.productCode.toUpperCase();
}

function sourceDirectory(root: string, definition: InstrumentDefinition): string {
  return join(root, '5min', definition.exchange, sourceProductCode(definition));
}

function sourceContract(
  definition: InstrumentDefinition,
  value: string,
): string | undefined {
  const sourceProduct = sourceProductCode(definition);
  const expiryPattern = definition.exchange === 'CZCE' ? '\\d{3,4}' : '\\d{4}';
  const match = new RegExp(`^${sourceProduct}(${expiryPattern})$`, 'i').exec(value);
  if (!match) return undefined;
  const month = Number(match[1].slice(-2));
  if (!definition.contractCode.candidateMonths.includes(month)) return undefined;
  return `${sourceProduct}${match[1]}`;
}

function sourceContractFilename(
  definition: InstrumentDefinition,
  contract: string,
): string {
  const normalized = sourceContract(definition, contract);
  if (!normalized) {
    throw new Error(`${definition.name} 不支持合约代码：${contract}`);
  }
  return `${normalized}.csv`;
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || resolve(root, value) !== path) {
    throw new Error('合约历史文件超出来源目录');
  }
  return value.split(sep).join('/');
}

function parseRows(
  text: string,
  definition: InstrumentDefinition,
  contract: string,
  sourceId: string,
  path: string,
  root: string,
): ContractFiveMinuteImportRecord[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) throw new Error(`${basename(path)} 文件为空`);

  const header = splitCsvRow(lines[0]);
  if (new Set(header).size !== header.length) {
    throw new Error(`${basename(path)} 表头存在重复列`);
  }
  for (const column of SOURCE_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`${basename(path)} 缺少来源列 ${column}`);
    }
  }
  const indexes = Object.fromEntries(
    SOURCE_COLUMNS.map(column => [column, header.indexOf(column)]),
  ) as Record<typeof SOURCE_COLUMNS[number], number>;
  const sourcePath = relativePath(root, path);

  return lines.slice(1).map((line, index) => {
    try {
      const fields = splitCsvRow(line);
      if (fields.length !== header.length) throw new Error('列数与表头不一致');
      const field = (name: typeof SOURCE_COLUMNS[number]) => fields[indexes[name]];
      return {
        instrumentId: definition.id,
        sourceExchange: definition.exchange,
        sourceContract: contract,
        timestamp: field('datetime'),
        open: parseFiniteNumber(field('open'), 'open'),
        high: parseFiniteNumber(field('high'), 'high'),
        low: parseFiniteNumber(field('low'), 'low'),
        close: parseFiniteNumber(field('close'), 'close'),
        volume: parseFiniteNumber(field('volume'), 'volume'),
        openInterest: parseFiniteNumber(field('open_interest'), 'open_interest'),
        provenance: {
          sourceId,
          relativePath: sourcePath,
          line: index + 2,
        },
      };
    } catch (error) {
      throw new Error(
        `${basename(path)} 第${index + 2}行：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export interface LocalContractHistoryAdapterOptions {
  sourceId?: string;
  sourceName?: string;
  sourceVersion?: string;
  acquiredAt?: string;
  license?: ContractHistorySourceDescription['license'];
}

export class LocalContractHistoryAdapter implements ContractFiveMinuteHistorySource {
  readonly sourceRoot: string;
  readonly sourceId: string;
  readonly description: ContractHistorySourceDescription;
  private readonly fileCache = new Map<string, Promise<{
    text: string;
    metadata: ContractHistorySourceFile;
  }>>();

  constructor(sourceRoot: string, options: LocalContractHistoryAdapterOptions = {}) {
    this.sourceRoot = resolve(sourceRoot);
    this.sourceId = options.sourceId ?? 'local-contract-five-minute-csv';
    this.description = {
      sourceId: this.sourceId,
      sourceName: options.sourceName ?? '本地合约级 5 分钟 CSV',
      sourceVersion: options.sourceVersion,
      acquiredAt: options.acquiredAt,
      license: options.license ?? {
        redistributionAllowed: false,
        conclusion: '未提供可再分发授权结论。',
      },
    };
  }

  async listContracts(instrument: ContractHistoryPageRequest['instrument']): Promise<string[]> {
    const definition = instrumentDefinition(instrument);
    const directory = sourceDirectory(this.sourceRoot, definition);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
      .map(entry => sourceContract(definition, entry.name.slice(0, -4)))
      .filter((contract): contract is string => contract !== undefined)
      .sort();
  }

  private filePath(
    request: Pick<ContractHistoryPageRequest, 'instrument' | 'contract'>,
  ): {
    definition: InstrumentDefinition;
    path: string;
    contract: string;
  } {
    const definition = instrumentDefinition(request.instrument);
    const filename = sourceContractFilename(definition, request.contract);
    return {
      definition,
      path: resolve(sourceDirectory(this.sourceRoot, definition), filename),
      contract: filename.slice(0, -4),
    };
  }

  private loadFile(path: string): Promise<{ text: string; metadata: ContractHistorySourceFile }> {
    const cached = this.fileCache.get(path);
    if (cached) return cached;
    const pending = readFile(path).then(buffer => {
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/);
      while (lines.length && !lines.at(-1)?.trim()) lines.pop();
      const dataLines = lines.slice(1);
      const timestampAt = (index: number): string | null => {
        const line = dataLines[index];
        if (!line) return null;
        try {
          return splitCsvRow(line)[0] || null;
        } catch {
          return null;
        }
      };
      return {
        text,
        metadata: {
          relativePath: relativePath(this.sourceRoot, path),
          sha256: createHash('sha256').update(buffer).digest('hex'),
          bytes: buffer.length,
          rows: dataLines.length,
          firstTimestamp: timestampAt(0),
          lastTimestamp: timestampAt(dataLines.length - 1),
        },
      };
    });
    this.fileCache.set(path, pending);
    return pending;
  }

  async inspectFile(
    request: Pick<ContractHistoryPageRequest, 'instrument' | 'contract'>,
  ): Promise<ContractHistorySourceFile> {
    const { path } = this.filePath(request);
    return (await this.loadFile(path)).metadata;
  }

  async readPage(request: ContractHistoryPageRequest): Promise<ContractHistoryPage> {
    const { definition, path, contract } = this.filePath(request);
    const file = await this.loadFile(path);
    const records = parseRows(
      file.text,
      definition,
      contract,
      this.sourceId,
      path,
      this.sourceRoot,
    );
    const offset = pageOffset(request.cursor);
    const size = pageSize(request.pageSize);
    const page = records.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    return {
      records: page,
      sourceFile: file.metadata,
      nextCursor: nextOffset < records.length ? String(nextOffset) : undefined,
    };
  }
}

type DesktopFormat = DesktopFuturesHistoryFile['format'];

interface DesktopSourceLocation {
  definition: InstrumentDefinition;
  format: DesktopFormat;
  storage: DesktopFuturesHistoryFile['storage'];
  path: string;
  archiveMember?: string;
  compressedBytes?: number;
  contract?: string;
}

interface DesktopPageState {
  input: ReadStream | ReturnType<ZipEntry['stream']>;
  reader: ReadLineInterface;
  iterator: AsyncIterator<string>;
  header: string[];
  indexes: Record<string, number>;
  offset: number;
  lineNumber: number;
}

function desktopTimestamp(value: string, field: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\+08:00)?$/.exec(value);
  if (!match) throw new Error(`${field} 不是北京时间秒级时间：${value}`);
  return match[1];
}

function desktopSourceContract(
  definition: InstrumentDefinition,
  value: string,
): string | undefined {
  const product = definition.productCode;
  const expiryPattern = definition.exchange === 'CZCE' ? '\\d{3,4}' : '\\d{4}';
  const match = new RegExp(
    `^${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${expiryPattern})$`,
    'i',
  ).exec(value.trim());
  if (!match) return undefined;
  const month = Number(match[1].slice(-2));
  if (!definition.contractCode.candidateMonths.includes(month)) return undefined;
  const normalizedProduct = definition.contractCode.productCase === 'upper'
    ? product.toUpperCase()
    : product.toLowerCase();
  return `${normalizedProduct}${match[1]}`;
}

function expectedDesktopColumns(format: DesktopFormat): readonly string[] {
  return format === 'desktop-main-continuous-v1'
    ? DESKTOP_MAIN_COLUMNS
    : DESKTOP_CONTRACT_COLUMNS;
}

function desktopIndexes(
  header: string[],
  format: DesktopFormat,
  label: string,
): Record<string, number> {
  if (new Set(header).size !== header.length) {
    throw new Error(`${label} 表头存在重复列`);
  }
  const indexes: Record<string, number> = {};
  for (const column of expectedDesktopColumns(format)) {
    const index = header.indexOf(column);
    if (index < 0) throw new Error(`${label} 缺少来源列 ${column}`);
    indexes[column] = index;
  }
  return indexes;
}

function desktopRecord(
  line: string,
  lineNumber: number,
  location: DesktopSourceLocation,
  sourceId: string,
  root: string,
  header: string[],
  indexes: Record<string, number>,
): DesktopFuturesMinuteRecord {
  const fields = splitCsvRow(line);
  if (fields.length !== header.length) throw new Error('列数与表头不一致');
  const field = (name: string) => fields[indexes[name]];
  const sourcePath = location.archiveMember
    ? `${relativePath(root, location.path)}!/${location.archiveMember}`
    : relativePath(root, location.path);
  const provenance = {
    sourceId,
    relativePath: sourcePath,
    line: lineNumber,
    archiveMember: location.archiveMember,
  };
  if (location.format === 'desktop-main-continuous-v1') {
    return {
      instrumentId: location.definition.id,
      sourceExchange: field('exchange'),
      sourceSymbol: field('symbol'),
      kind: 'main-continuous',
      timestamp: desktopTimestamp(field('bob'), 'bob'),
      endTimestamp: desktopTimestamp(field('eob'), 'eob'),
      open: parseFiniteNumber(field('open'), 'open'),
      high: parseFiniteNumber(field('high'), 'high'),
      low: parseFiniteNumber(field('low'), 'low'),
      close: parseFiniteNumber(field('close'), 'close'),
      amount: parseFiniteNumber(field('amount'), 'amount'),
      volume: parseFiniteNumber(field('volume'), 'volume'),
      openInterest: parseFiniteNumber(field('position'), 'position'),
      provenance,
    };
  }
  return {
    instrumentId: location.definition.id,
    sourceExchange: location.definition.exchange,
    sourceSymbol: location.contract!,
    kind: 'contract',
    timestamp: desktopTimestamp(field('日期'), '日期'),
    open: parseFiniteNumber(field('开盘价'), '开盘价'),
    high: parseFiniteNumber(field('最高价'), '最高价'),
    low: parseFiniteNumber(field('最低价'), '最低价'),
    close: parseFiniteNumber(field('收盘价'), '收盘价'),
    amount: parseOptionalFiniteNumber(field('成交额'), '成交额'),
    volume: parseOptionalFiniteNumber(field('成交量'), '成交量'),
    openInterest: parseOptionalFiniteNumber(field('持仓量'), '持仓量'),
    provenance,
  };
}

export interface DesktopFuturesHistoryAdapterOptions
  extends LocalContractHistoryAdapterOptions {}

export class DesktopFuturesHistoryAdapter implements DesktopFuturesHistorySource {
  readonly sourceRoot: string;
  readonly sourceId: string;
  readonly description: ContractHistorySourceDescription;
  private readonly directoryCache = new Map<string, Promise<string>>();
  private readonly contractLocationCache =
    new Map<string, Promise<Map<string, DesktopSourceLocation>>>();
  private readonly zipCache = new Map<string, ReturnType<typeof Open.file>>();
  private readonly metadataCache =
    new Map<string, Promise<DesktopFuturesHistoryFile>>();
  private readonly pageStates = new Map<string, DesktopPageState>();

  constructor(sourceRoot: string, options: DesktopFuturesHistoryAdapterOptions = {}) {
    this.sourceRoot = resolve(sourceRoot);
    this.sourceId = options.sourceId ?? 'desktop-futures-minute-history';
    this.description = {
      sourceId: this.sourceId,
      sourceName: options.sourceName ?? '桌面期货分钟数据',
      sourceVersion: options.sourceVersion,
      acquiredAt: options.acquiredAt,
      license: options.license ?? {
        redistributionAllowed: false,
        conclusion: '数据说明仅标注“数据1”，未提供允许随产品再分发的授权依据。',
      },
    };
  }

  private async instrumentDirectory(
    definition: InstrumentDefinition,
  ): Promise<string> {
    const cached = this.directoryCache.get(definition.id);
    if (cached) return cached;
    const pending = (async () => {
      const exchangePrefix = `${definition.exchange}_`;
      const exchangeEntries = await readdir(this.sourceRoot, { withFileTypes: true });
      const exchangeDirectory = exchangeEntries.find(entry => (
        entry.isDirectory() && entry.name.startsWith(exchangePrefix)
      ));
      if (!exchangeDirectory) {
        throw new Error(`${definition.name} 缺少交易所目录 ${exchangePrefix}*`);
      }
      const exchangePath = resolve(this.sourceRoot, exchangeDirectory.name);
      const productPrefix = `${definition.productCode.toUpperCase()}_`;
      const productEntries = await readdir(exchangePath, { withFileTypes: true });
      const productDirectory = productEntries.find(entry => (
        entry.isDirectory() && entry.name.toUpperCase().startsWith(productPrefix)
      ));
      if (!productDirectory) {
        throw new Error(`${definition.name} 缺少品种目录 ${productPrefix}*`);
      }
      return resolve(exchangePath, productDirectory.name);
    })();
    this.directoryCache.set(definition.id, pending);
    return pending;
  }

  private async zipDirectory(path: string) {
    const cached = this.zipCache.get(path);
    if (cached) return cached;
    const pending = Open.file(path);
    this.zipCache.set(path, pending);
    return pending;
  }

  private locationKey(location: DesktopSourceLocation): string {
    return location.archiveMember
      ? `${location.path}!/${location.archiveMember}`
      : location.path;
  }

  private async mainLocation(
    instrument: DesktopFuturesHistoryPageRequest['instrument'],
  ): Promise<DesktopSourceLocation> {
    const definition = instrumentDefinition(instrument);
    const directory = await this.instrumentDirectory(definition);
    const path = resolve(
      directory,
      `${definition.productCode.toUpperCase()}主力连续.csv`,
    );
    return {
      definition,
      format: 'desktop-main-continuous-v1',
      storage: 'csv',
      path,
    };
  }

  private async contractLocations(
    instrument: DesktopFuturesHistoryPageRequest['instrument'],
  ): Promise<Map<string, DesktopSourceLocation>> {
    const cached = this.contractLocationCache.get(instrument);
    if (cached) return cached;
    const pending = (async () => {
      const definition = instrumentDefinition(instrument);
      const directory = await this.instrumentDirectory(definition);
      const entries = await readdir(directory, { withFileTypes: true });
      const locations = new Map<string, DesktopSourceLocation>();
      const add = (contract: string, location: DesktopSourceLocation) => {
        const key = contract.toUpperCase();
        if (locations.has(key)) {
          throw new Error(`${definition.name} 的具体合约重复：${contract}`);
        }
        locations.set(key, location);
      };
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.csv') continue;
        if (entry.name.toLowerCase().endsWith('主力连续.csv')) continue;
        const contract = desktopSourceContract(
          definition,
          basename(entry.name, extname(entry.name)),
        );
        if (!contract) continue;
        add(contract, {
          definition,
          format: 'desktop-contract-v1',
          storage: 'csv',
          path: resolve(directory, entry.name),
          contract,
        });
      }
      const archiveEntry = entries.find(entry => (
        entry.isFile() && entry.name.toLowerCase().endsWith('_退市.zip')
      ));
      if (!archiveEntry) throw new Error(`${definition.name} 缺少退市合约 ZIP`);
      const archivePath = resolve(directory, archiveEntry.name);
      const archive = await this.zipDirectory(archivePath);
      for (const member of archive.files) {
        if (member.type !== 'File' || extname(member.path).toLowerCase() !== '.csv') {
          continue;
        }
        const contract = desktopSourceContract(
          definition,
          basename(member.path, extname(member.path)),
        );
        if (!contract) continue;
        add(contract, {
          definition,
          format: 'desktop-contract-v1',
          storage: 'zip-member',
          path: archivePath,
          archiveMember: member.path,
          compressedBytes: member.compressedSize,
          contract,
        });
      }
      return locations;
    })();
    this.contractLocationCache.set(instrument, pending);
    return pending;
  }

  async listContracts(
    instrument: DesktopFuturesHistoryPageRequest['instrument'],
  ): Promise<string[]> {
    const locations = await this.contractLocations(instrument);
    return [...locations.values()]
      .map(location => location.contract!)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  private async contractLocation(
    request: Pick<DesktopFuturesHistoryPageRequest, 'instrument' | 'contract'>,
  ): Promise<DesktopSourceLocation> {
    if (!request.contract) throw new Error('具体合约代码不能为空');
    const definition = instrumentDefinition(request.instrument);
    const normalized = desktopSourceContract(definition, request.contract);
    if (!normalized) {
      throw new Error(`${definition.name} 不支持合约代码：${request.contract}`);
    }
    const location = (await this.contractLocations(request.instrument))
      .get(normalized.toUpperCase());
    if (!location) throw new Error(`${definition.name} 找不到具体合约：${normalized}`);
    return location;
  }

  private async inputStream(
    location: DesktopSourceLocation,
  ): Promise<DesktopPageState['input']> {
    if (!location.archiveMember) return createReadStream(location.path);
    const archive = await this.zipDirectory(location.path);
    const member = archive.files.find(file => file.path === location.archiveMember);
    if (!member) {
      throw new Error(`${basename(location.path)} 缺少成员 ${location.archiveMember}`);
    }
    return member.stream();
  }

  private async inspectLocation(
    location: DesktopSourceLocation,
  ): Promise<DesktopFuturesHistoryFile> {
    const key = this.locationKey(location);
    const cached = this.metadataCache.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const input = await this.inputStream(location);
      const hash = createHash('sha256');
      let bytes = 0;
      input.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buffer);
        bytes += buffer.length;
      });
      const reader = createInterface({ input, crlfDelay: Infinity });
      let header: string[] | undefined;
      let indexes: Record<string, number> | undefined;
      let rows = 0;
      let firstTimestamp: string | null = null;
      let lastTimestamp: string | null = null;
      for await (const rawLine of reader) {
        const line = header ? rawLine : rawLine.replace(/^\uFEFF/, '');
        if (!header) {
          header = splitCsvRow(line);
          indexes = desktopIndexes(header, location.format, basename(key));
          continue;
        }
        if (!line.trim()) continue;
        const fields = splitCsvRow(line);
        if (fields.length !== header.length) {
          throw new Error(`${basename(key)} 第${rows + 2}行：列数与表头不一致`);
        }
        const timestampColumn = location.format === 'desktop-main-continuous-v1'
          ? 'bob'
          : '日期';
        const timestamp = desktopTimestamp(
          fields[indexes![timestampColumn]],
          timestampColumn,
        );
        firstTimestamp ??= timestamp;
        lastTimestamp = timestamp;
        rows += 1;
      }
      if (!header) throw new Error(`${basename(key)} 文件为空`);
      return {
        relativePath: location.archiveMember
          ? `${relativePath(this.sourceRoot, location.path)}!/${location.archiveMember}`
          : relativePath(this.sourceRoot, location.path),
        sha256: hash.digest('hex'),
        bytes,
        rows,
        firstTimestamp,
        lastTimestamp,
        format: location.format,
        storage: location.storage,
        archiveRelativePath: location.archiveMember
          ? relativePath(this.sourceRoot, location.path)
          : undefined,
        archiveMember: location.archiveMember,
        compressedBytes: location.compressedBytes,
      };
    })();
    this.metadataCache.set(key, pending);
    return pending;
  }

  async inspectMainFile(
    instrument: DesktopFuturesHistoryPageRequest['instrument'],
  ): Promise<DesktopFuturesHistoryFile> {
    return this.inspectLocation(await this.mainLocation(instrument));
  }

  async inspectContractFile(
    request: Pick<DesktopFuturesHistoryPageRequest, 'instrument' | 'contract'>,
  ): Promise<DesktopFuturesHistoryFile> {
    return this.inspectLocation(await this.contractLocation(request));
  }

  private async scanLocation(
    location: DesktopSourceLocation,
    visitor: DesktopFuturesHistoryScanVisitor,
  ): Promise<DesktopFuturesHistoryFile> {
    const key = this.locationKey(location);
    const input = await this.inputStream(location);
    const hash = createHash('sha256');
    let bytes = 0;
    input.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      bytes += buffer.length;
    });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let header: string[] | undefined;
    let indexes: Record<string, number> | undefined;
    let rows = 0;
    let lineNumber = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    try {
      for await (const rawLine of reader) {
        lineNumber += 1;
        const line = header ? rawLine : rawLine.replace(/^\uFEFF/, '');
        if (!header) {
          header = splitCsvRow(line);
          indexes = desktopIndexes(header, location.format, basename(key));
          continue;
        }
        if (!line.trim()) continue;
        let record: DesktopFuturesMinuteRecord;
        try {
          record = desktopRecord(
            line,
            lineNumber,
            location,
            this.sourceId,
            this.sourceRoot,
            header,
            indexes!,
          );
        } catch (error) {
          throw new Error(
            `${basename(key)} 第${lineNumber}行：`
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        firstTimestamp ??= record.timestamp;
        lastTimestamp = record.timestamp;
        rows += 1;
        const visitResult = visitor(record);
        if (
          visitResult
          && typeof (visitResult as PromiseLike<void>).then === 'function'
        ) {
          await visitResult;
        }
      }
    } finally {
      reader.close();
      input.destroy();
    }
    if (!header) throw new Error(`${basename(key)} 文件为空`);
    const metadata: DesktopFuturesHistoryFile = {
      relativePath: location.archiveMember
        ? `${relativePath(this.sourceRoot, location.path)}!/${location.archiveMember}`
        : relativePath(this.sourceRoot, location.path),
      sha256: hash.digest('hex'),
      bytes,
      rows,
      firstTimestamp,
      lastTimestamp,
      format: location.format,
      storage: location.storage,
      archiveRelativePath: location.archiveMember
        ? relativePath(this.sourceRoot, location.path)
        : undefined,
      archiveMember: location.archiveMember,
      compressedBytes: location.compressedBytes,
    };
    this.metadataCache.set(key, Promise.resolve(metadata));
    return metadata;
  }

  async scanMainRecords(
    instrument: DesktopFuturesHistoryPageRequest['instrument'],
    visitor: DesktopFuturesHistoryScanVisitor,
  ): Promise<DesktopFuturesHistoryFile> {
    return this.scanLocation(await this.mainLocation(instrument), visitor);
  }

  async scanContractRecords(
    request: Pick<DesktopFuturesHistoryPageRequest, 'instrument' | 'contract'>,
    visitor: DesktopFuturesHistoryScanVisitor,
  ): Promise<DesktopFuturesHistoryFile> {
    return this.scanLocation(await this.contractLocation(request), visitor);
  }

  private closePageState(key: string): void {
    const state = this.pageStates.get(key);
    if (!state) return;
    state.reader.close();
    state.input.destroy();
    this.pageStates.delete(key);
  }

  private async newPageState(
    location: DesktopSourceLocation,
  ): Promise<DesktopPageState> {
    const input = await this.inputStream(location);
    const reader = createInterface({ input, crlfDelay: Infinity });
    const iterator = reader[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      reader.close();
      input.destroy();
      throw new Error(`${basename(this.locationKey(location))} 文件为空`);
    }
    const header = splitCsvRow(first.value.replace(/^\uFEFF/, ''));
    return {
      input,
      reader,
      iterator,
      header,
      indexes: desktopIndexes(header, location.format, basename(this.locationKey(location))),
      offset: 0,
      lineNumber: 1,
    };
  }

  private async pageStateAt(
    location: DesktopSourceLocation,
    offset: number,
  ): Promise<DesktopPageState> {
    const key = this.locationKey(location);
    let state = this.pageStates.get(key);
    if (!state || state.offset > offset) {
      this.closePageState(key);
      state = await this.newPageState(location);
      this.pageStates.set(key, state);
    }
    while (state.offset < offset) {
      const next = await state.iterator.next();
      if (next.done) {
        this.closePageState(key);
        throw new Error(`分页游标超出来源记录数量：${offset}`);
      }
      state.lineNumber += 1;
      if (!next.value.trim()) continue;
      state.offset += 1;
    }
    return state;
  }

  private async readLocationPage(
    location: DesktopSourceLocation,
    cursor: string | undefined,
    requestedPageSize: number | undefined,
  ): Promise<DesktopFuturesHistoryPage> {
    const offset = pageOffset(cursor);
    const size = pageSize(requestedPageSize);
    const metadata = await this.inspectLocation(location);
    if (offset > metadata.rows) {
      throw new Error(`分页游标超出来源记录数量：${offset}`);
    }
    if (offset === metadata.rows) {
      this.closePageState(this.locationKey(location));
      return { records: [], sourceFile: metadata };
    }
    const state = await this.pageStateAt(location, offset);
    const records: DesktopFuturesMinuteRecord[] = [];
    while (records.length < size && state.offset < metadata.rows) {
      const next = await state.iterator.next();
      if (next.done) break;
      state.lineNumber += 1;
      if (!next.value.trim()) continue;
      try {
        records.push(desktopRecord(
          next.value,
          state.lineNumber,
          location,
          this.sourceId,
          this.sourceRoot,
          state.header,
          state.indexes,
        ));
      } catch (error) {
        this.closePageState(this.locationKey(location));
        throw new Error(
          `${basename(this.locationKey(location))} 第${state.lineNumber}行：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      state.offset += 1;
    }
    if (state.offset !== offset + records.length) {
      throw new Error('分页读取状态与返回记录数量不一致');
    }
    const nextCursor = state.offset < metadata.rows ? String(state.offset) : undefined;
    if (!nextCursor) this.closePageState(this.locationKey(location));
    return {
      records,
      sourceFile: metadata,
      nextCursor,
    };
  }

  async readMainPage(
    request: Omit<DesktopFuturesHistoryPageRequest, 'contract'>,
  ): Promise<DesktopFuturesHistoryPage> {
    return this.readLocationPage(
      await this.mainLocation(request.instrument),
      request.cursor,
      request.pageSize,
    );
  }

  async readContractPage(
    request: DesktopFuturesHistoryPageRequest & { contract: string },
  ): Promise<DesktopFuturesHistoryPage> {
    return this.readLocationPage(
      await this.contractLocation(request),
      request.cursor,
      request.pageSize,
    );
  }
}
