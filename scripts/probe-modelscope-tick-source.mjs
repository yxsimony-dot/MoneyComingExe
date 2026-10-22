import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'modelscope-tick-source-probe.json');
export const REPOSITORY = {
  id: 'ylzmota1/chinese-commodity',
  url: 'https://www.modelscope.cn/datasets/ylzmota1/chinese-commodity',
  gitUrl: 'https://www.modelscope.cn/datasets/ylzmota1/chinese-commodity.git',
  commit: '1f1e6cdcc8eea53e6b10cbd3f4a5209eb19acab6',
  uploader: {
    account: 'ylzmota1',
    email: 'ylzmota1@163.com',
    evidenceCommit: '52a15a8a00eef67c25755a2aa1a830741ec25755',
    evidenceCommitSubject: 'Upload 202211.zip',
  },
};
const GAP_ARCHIVE_PERIODS = [
  '202507',
  '202508',
  '202509',
  '202510',
];
const HISTORY_REPRESENTATIVE_PERIODS = [
  '202211',
  '202301',
  '202401',
  '202501',
];
export const INSTRUMENTS = [
  {
    id: 'main_continuous',
    name: '豆粕主连',
    exchange: 'DCE',
    productCode: 'm',
    expiryDigits: 4,
    gapEndDate: '2025-10-08',
  },
  {
    id: 'rapeseed_meal_main',
    name: '菜粕主连',
    exchange: 'CZCE',
    productCode: 'RM',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'pvc_main',
    name: 'PVC主连',
    exchange: 'DCE',
    productCode: 'v',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'rebar_main',
    name: '螺纹钢主连',
    exchange: 'SHFE',
    productCode: 'rb',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'glass_main',
    name: '玻璃主连',
    exchange: 'CZCE',
    productCode: 'FG',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'rapeseed_oil_main',
    name: '菜油主连',
    exchange: 'CZCE',
    productCode: 'OI',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'palm_oil_main',
    name: '棕榈油主连',
    exchange: 'DCE',
    productCode: 'p',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'soybean_oil_main',
    name: '豆油主连',
    exchange: 'DCE',
    productCode: 'y',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'pulp_main',
    name: '纸浆主连',
    exchange: 'SHFE',
    productCode: 'sp',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'corn_main',
    name: '玉米主连',
    exchange: 'DCE',
    productCode: 'c',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'soda_ash_main',
    name: '纯碱主连',
    exchange: 'CZCE',
    productCode: 'SA',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'soybean_1_main',
    name: '豆一主连',
    exchange: 'DCE',
    productCode: 'a',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'methanol_main',
    name: '甲醇主连',
    exchange: 'CZCE',
    productCode: 'MA',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'sugar_main',
    name: '白糖主连',
    exchange: 'CZCE',
    productCode: 'SR',
    expiryDigits: 3,
    gapEndDate: '2025-10-19',
  },
  {
    id: 'soybean_2_main',
    name: '豆二主连',
    exchange: 'DCE',
    productCode: 'b',
    expiryDigits: 4,
    gapEndDate: '2025-10-19',
  },
];
const GAP_START_DATE = '2025-07-01';
const SAMPLE_DEFAULTS = {
  instrumentId: 'main_continuous',
  startDate: '2025-08-11',
  endDate: '2025-08-15',
};
const REQUIRED_TICK_FIELDS = [
  'TradingDay',
  'InstrumentID',
  'UpdateTime',
  'UpdateMillisec',
  'LastPrice',
  'Volume',
  'OpenInterest',
];
const SEMANTIC_MAPPING_IGNORED_FIELDS = new Set(['AveragePrice']);
const SESSION_SEGMENTS = {
  day: [
    [9 * 60, 10 * 60 + 15],
    [10 * 60 + 30, 11 * 60 + 30],
    [13 * 60 + 30, 15 * 60],
  ],
  night: [
    [21 * 60, 23 * 60],
  ],
};
const MINUTE_MS = 60_000;
const CRC32_TABLE = buildCrc32Table();

function parseArguments(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    sampleInstrumentIds: [SAMPLE_DEFAULTS.instrumentId],
    sampleAllInstruments: false,
    sampleStartDate: SAMPLE_DEFAULTS.startDate,
    sampleEndDate: SAMPLE_DEFAULTS.endDate,
    sampleDates: null,
    scanAllCentralDirectories: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else if (argument === '--sample-instrument' && value) {
      options.sampleInstrumentIds = [value];
      index += 1;
    } else if (argument === '--sample-all-instruments') {
      options.sampleAllInstruments = true;
    } else if (argument === '--sample-start' && value) {
      options.sampleStartDate = value;
      index += 1;
    } else if (argument === '--sample-end' && value) {
      options.sampleEndDate = value;
      index += 1;
    } else if (argument === '--sample-dates' && value) {
      options.sampleDates = [...new Set(
        value.split(',').map(date => date.trim()).filter(Boolean),
      )].sort();
      index += 1;
    } else if (argument === '--scan-all-central-directories') {
      options.scanAllCentralDirectories = true;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  if (options.sampleAllInstruments) {
    options.sampleInstrumentIds = INSTRUMENTS.map(instrument => instrument.id);
  }
  if (options.sampleDates?.length) {
    options.sampleStartDate = options.sampleDates[0];
    options.sampleEndDate = options.sampleDates.at(-1);
  }
  for (const [name, value] of [
    ['--sample-start', options.sampleStartDate],
    ['--sample-end', options.sampleEndDate],
    ...(options.sampleDates ?? []).map(date => ['--sample-dates', date]),
  ]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} 必须使用 YYYY-MM-DD：${value}`);
    }
  }
  if (options.sampleStartDate > options.sampleEndDate) {
    throw new Error('--sample-start 不得晚于 --sample-end');
  }
  for (const instrumentId of options.sampleInstrumentIds) {
    if (!INSTRUMENTS.some(instrument => instrument.id === instrumentId)) {
      throw new Error(`未知样本品种：${instrumentId}`);
    }
  }
  return {
    ...options,
    output: resolve(options.output),
  };
}

function repositoryTreeUrl(pageNumber, pageSize) {
  const query = new URLSearchParams({
    Revision: 'master',
    Recursive: 'True',
    PageNumber: String(pageNumber),
    PageSize: String(pageSize),
  });
  return `https://www.modelscope.cn/api/v1/datasets/${REPOSITORY.id}/repo/tree?${query}`;
}

function archiveUrl(path) {
  const query = new URLSearchParams({
    Revision: 'master',
    FilePath: path,
  });
  return `https://www.modelscope.cn/api/v1/datasets/${REPOSITORY.id}/repo?${query}`;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function request(url, init, label) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          accept: '*/*',
          'user-agent': 'MoneyComing ModelScope Tick source probe/1',
          ...init?.headers,
        },
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`${label} 请求失败（已尝试 ${maxAttempts} 次）`, { cause: error });
      }
      console.warn(
        `${label} 请求失败，准备重试 ${attempt}/${maxAttempts - 1}：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(1_500 * (2 ** (attempt - 1)));
      continue;
    }

    if (response.ok) return response;
    const retryable = response.status === 408
      || response.status === 429
      || response.status >= 500;
    await response.body?.cancel();
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`${label} 返回 HTTP ${response.status}`);
    }
    console.warn(`${label} 返回 HTTP ${response.status}，准备重试 ${attempt}/${maxAttempts - 1}...`);
    await sleep(1_500 * (2 ** (attempt - 1)));
  }
  throw new Error(`${label} 请求重试状态异常`);
}

function archivePeriod(name) {
  const match = /^(\d{6}|\d{8})\.zip$/i.exec(name);
  return match?.[1] ?? null;
}

function normalizeRepositoryArchive(file) {
  const period = archivePeriod(file.Name);
  if (!period
    || file.Type !== 'blob'
    || file.IsLFS !== true
    || !Number.isSafeInteger(file.Size)
    || file.Size <= 0
    || !/^[0-9a-f]{64}$/i.test(file.Sha256 ?? '')) {
    throw new Error(`仓库树包含无效归档元数据：${file.Path ?? file.Name ?? '未知文件'}`);
  }
  return {
    name: file.Name,
    path: file.Path,
    period,
    granularity: period.length === 6 ? 'month' : 'trading-day',
    pointer: {
      version: 'https://git-lfs.github.com/spec/v1',
      sha256: file.Sha256.toLowerCase(),
      size: file.Size,
    },
    repositoryEntry: {
      revision: file.Revision,
      committerName: file.CommitterName,
      committedAt: Number.isFinite(file.CommittedDate)
        ? new Date(file.CommittedDate * 1000).toISOString()
        : null,
    },
  };
}

export async function fetchRepositoryInventory() {
  const pageSize = 200;
  let pageNumber = 1;
  let totalCount = null;
  const files = [];
  do {
    const response = await request(
      repositoryTreeUrl(pageNumber, pageSize),
      undefined,
      `仓库树第 ${pageNumber} 页`,
    );
    const payload = await response.json();
    if (payload.Code !== 200 || !Array.isArray(payload.Data?.Files)) {
      throw new Error(`仓库树第 ${pageNumber} 页响应结构无效`);
    }
    totalCount ??= Number(payload.TotalCount ?? payload.Data.TotalCount);
    files.push(...payload.Data.Files);
    pageNumber += 1;
  } while (Number.isFinite(totalCount) && files.length < totalCount);

  const archives = files
    .filter(file => (
      file.Type === 'blob'
      && file.IsLFS === true
      && archivePeriod(file.Name)
    ))
    .map(normalizeRepositoryArchive)
    .sort((left, right) => (
      left.period.localeCompare(right.period)
      || left.path.localeCompare(right.path)
    ));
  if (!archives.length) throw new Error('仓库树未发现 Tick ZIP 归档');

  const manifest = archives.map(archive => [
    archive.path,
    archive.period,
    archive.pointer.size,
    archive.pointer.sha256,
    archive.repositoryEntry.revision,
  ].join(',')).join('\n');
  const yearly = Object.entries(Object.groupBy(
    archives,
    archive => archive.period.slice(0, 4),
  )).map(([year, entries]) => ({
    year,
    archiveCount: entries.length,
    firstArchivePath: entries[0].path,
    lastArchivePath: entries.at(-1).path,
    totalBytes: entries.reduce((sum, archive) => sum + archive.pointer.size, 0),
  }));
  return {
    api: {
      endpoint: repositoryTreeUrl(1, pageSize),
      revision: 'master',
      recursive: true,
      reportedTreeEntryCount: totalCount,
      fetchedTreeEntryCount: files.length,
    },
    archiveCount: archives.length,
    monthlyArchiveCount: archives.filter(
      archive => archive.granularity === 'month',
    ).length,
    dailyArchiveCount: archives.filter(
      archive => archive.granularity === 'trading-day',
    ).length,
    totalBytes: archives.reduce((sum, archive) => sum + archive.pointer.size, 0),
    firstArchivePeriod: archives[0].period,
    firstArchivePath: archives[0].path,
    lastArchivePeriod: archives.at(-1).period,
    lastArchivePath: archives.at(-1).path,
    normalizedManifestSha256: sha256Text(manifest),
    yearly,
    archives,
  };
}

function previousMonthPeriod(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function selectProbeArchives(inventory, options) {
  const { scanAllCentralDirectories } = options;
  if (scanAllCentralDirectories) return inventory.archives;
  const samplePeriods = [...new Set(
    (options.sampleDates ?? [options.sampleStartDate, options.sampleEndDate])
      .map(date => date.slice(0, 7).replace('-', '')),
  )];
  const requestedPeriods = [...new Set([
    ...HISTORY_REPRESENTATIVE_PERIODS,
    ...GAP_ARCHIVE_PERIODS,
    ...samplePeriods,
    ...samplePeriods.map(previousMonthPeriod),
  ])].sort();
  return requestedPeriods.map(period => {
    const archive = inventory.archives.find(candidate => candidate.period === period);
    if (!archive) throw new Error(`仓库树缺少探测归档：${period}`);
    return archive;
  });
}

async function inspectArchiveHeaders(archive) {
  const url = archiveUrl(archive.path);
  const response = await request(url, { method: 'HEAD' }, `${archive.path} HEAD`);
  const contentLength = Number(response.headers.get('content-length'));
  const objectSha256 = (
    response.headers.get('x-oss-hash-value')
    ?? response.headers.get('x-linked-etag')
    ?? ''
  ).toLowerCase();
  if (contentLength !== archive.pointer.size) {
    throw new Error(`${archive.path} 远程大小与仓库树元数据不一致`);
  }
  if (objectSha256 !== archive.pointer.sha256) {
    throw new Error(`${archive.path} 远程 SHA-256 与仓库树元数据不一致`);
  }
  if (response.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') {
    throw new Error(`${archive.path} 不支持 HTTP Range`);
  }
  return {
    ...archive,
    url,
    remote: {
      contentLength,
      sha256: objectSha256,
      acceptRanges: true,
      lastModified: response.headers.get('last-modified'),
      etag: response.headers.get('etag'),
    },
  };
}

async function fetchRange(archive, start, end, label) {
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || end >= archive.pointer.size) {
    throw new Error(`${archive.name} Range 越界：${start}-${end}`);
  }
  const response = await request(archive.url, {
    headers: {
      range: `bytes=${start}-${end}`,
    },
  }, `${archive.name} ${label}`);
  if (response.status !== 206) {
    throw new Error(`${archive.name} ${label} 未返回 HTTP 206`);
  }
  const contentRange = response.headers.get('content-range');
  const expectedRange = `bytes ${start}-${end}/${archive.pointer.size}`;
  if (contentRange !== expectedRange) {
    throw new Error(
      `${archive.name} ${label} Content-Range 不一致：${contentRange ?? '缺失'}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== end - start + 1) {
    throw new Error(`${archive.name} ${label} 返回字节数不一致`);
  }
  return buffer;
}

function findSignatureBackwards(buffer, signature) {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function safeZip64Number(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} 超出 JavaScript 安全整数范围`);
  }
  return Number(value);
}

function readZip64Values(extra, sentinels, label) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const valueStart = cursor + 4;
    const valueEnd = valueStart + size;
    if (valueEnd > extra.length) throw new Error(`${label} ZIP extra 越界`);
    if (id === 0x0001) {
      let valueCursor = valueStart;
      const result = {};
      for (const field of ['uncompressedSize', 'compressedSize', 'localHeaderOffset']) {
        if (!sentinels[field]) continue;
        if (valueCursor + 8 > valueEnd) {
          throw new Error(`${label} ZIP64 ${field} 缺失`);
        }
        result[field] = safeZip64Number(
          extra.readBigUInt64LE(valueCursor),
          `${label} ZIP64 ${field}`,
        );
        valueCursor += 8;
      }
      return result;
    }
    cursor = valueEnd;
  }
  return {};
}

function decodeZipFilename(buffer, utf8) {
  return new TextDecoder(utf8 ? 'utf-8' : 'gb18030', { fatal: true }).decode(buffer);
}

export async function readCentralDirectory(archive) {
  const tailLength = Math.min(128 * 1024, archive.pointer.size);
  const tailStart = archive.pointer.size - tailLength;
  const tail = await fetchRange(
    archive,
    tailStart,
    archive.pointer.size - 1,
    'EOCD',
  );
  const eocdOffset = findSignatureBackwards(tail, 0x06054b50);
  if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
    throw new Error(`${archive.name} 未找到有效 EOCD`);
  }
  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDisk = tail.readUInt16LE(eocdOffset + 6);
  const diskEntries = tail.readUInt16LE(eocdOffset + 8);
  const totalEntries = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff) {
    throw new Error(`${archive.name} 使用了不支持的多卷或 ZIP64 EOCD`);
  }
  const central = await fetchRange(
    archive,
    centralOffset,
    centralOffset + centralSize - 1,
    'central-directory',
  );
  const entries = [];
  let cursor = 0;
  while (cursor < central.length) {
    if (cursor + 46 > central.length
      || central.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`${archive.name} 中央目录结构无效：${cursor}`);
    }
    const flags = central.readUInt16LE(cursor + 8);
    const compressionMethod = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    const compressed32 = central.readUInt32LE(cursor + 20);
    const uncompressed32 = central.readUInt32LE(cursor + 24);
    const filenameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const localOffset32 = central.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + filenameLength + extraLength + commentLength;
    if (recordEnd > central.length) {
      throw new Error(`${archive.name} 中央目录记录越界：${cursor}`);
    }
    const filenameBytes = central.subarray(cursor + 46, cursor + 46 + filenameLength);
    const extra = central.subarray(
      cursor + 46 + filenameLength,
      cursor + 46 + filenameLength + extraLength,
    );
    const zip64 = readZip64Values(extra, {
      uncompressedSize: uncompressed32 === 0xffffffff,
      compressedSize: compressed32 === 0xffffffff,
      localHeaderOffset: localOffset32 === 0xffffffff,
    }, archive.name);
    entries.push({
      name: decodeZipFilename(filenameBytes, (flags & 0x0800) !== 0),
      flags,
      compressionMethod,
      crc32,
      crc32Hex: crc32.toString(16).padStart(8, '0'),
      compressedSize: zip64.compressedSize ?? compressed32,
      uncompressedSize: zip64.uncompressedSize ?? uncompressed32,
      localHeaderOffset: zip64.localHeaderOffset ?? localOffset32,
    });
    cursor = recordEnd;
  }
  if (entries.length !== totalEntries) {
    throw new Error(
      `${archive.name} 中央目录条目数不一致：${entries.length}/${totalEntries}`,
    );
  }
  return {
    centralDirectory: {
      entryCount: totalEntries,
      size: centralSize,
      offset: centralOffset,
    },
    entries,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseEntryIdentity(archive, entry) {
  const normalized = entry.name.replaceAll('\\', '/');
  const monthlyMatch = /^(\d{6})\/(\d{8})\/([^/]+)$/.exec(normalized);
  if (monthlyMatch) {
    const [, archiveMonth, dateCompact, basename] = monthlyMatch;
    if (archive.granularity !== 'month'
      || archiveMonth !== archive.period
      || !dateCompact.startsWith(archiveMonth)
      || !basename.endsWith(`_${dateCompact}.csv`)) {
      return undefined;
    }
    return {
      archiveMonth,
      tradingDate: (
        `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`
      ),
      dateCompact,
      basename,
    };
  }

  const dailyMatch = /^([^/]+_(\d{8})\.csv)$/.exec(normalized);
  if (!dailyMatch
    || archive.granularity !== 'trading-day'
    || dailyMatch[2] !== archive.period) {
    return undefined;
  }
  const [, basename, dateCompact] = dailyMatch;
  return {
    archiveMonth: dateCompact.slice(0, 6),
    tradingDate: (
      `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`
    ),
    dateCompact,
    basename,
  };
}

function mainFilename(instrument, dateCompact) {
  return `${instrument.productCode}主力连续_${dateCompact}.csv`;
}

function concreteFilenamePattern(instrument, dateCompact) {
  return new RegExp(
    `^(${escapeRegExp(instrument.productCode)}\\d{${instrument.expiryDigits}})_`
    + `${dateCompact}\\.csv$`,
  );
}

function sameStoredPayload(left, right) {
  return left.crc32 === right.crc32
    && left.compressedSize === right.compressedSize
    && left.uncompressedSize === right.uncompressedSize;
}

function mappingIssue(mapping) {
  return {
    tradingDate: mapping.tradingDate,
    instrumentId: mapping.instrumentId,
    mainFileCount: mapping.mainEntries.length,
    concreteFileCount: mapping.concreteCandidates.length,
    matchingConcreteCount: mapping.semanticMatchingConcreteCount ?? 0,
  };
}

export function analyzeArchiveEntries(archive, centralDirectory, entries) {
  const tradingDates = new Set();
  const byDate = new Map();
  let directoryEntryCount = 0;
  let recognizedDataFileCount = 0;
  let unrecognizedFileCount = 0;
  const unrecognizedFileSamples = [];
  for (const entry of entries) {
    const normalizedName = entry.name.replaceAll('\\', '/');
    if (normalizedName.endsWith('/')) {
      directoryEntryCount += 1;
      continue;
    }
    const identity = parseEntryIdentity(archive, entry);
    if (!identity) {
      unrecognizedFileCount += 1;
      if (unrecognizedFileSamples.length < 20) {
        unrecognizedFileSamples.push(entry.name);
      }
      continue;
    }
    recognizedDataFileCount += 1;
    tradingDates.add(identity.tradingDate);
    const dateEntries = byDate.get(identity.tradingDate) ?? [];
    dateEntries.push({ ...entry, identity });
    byDate.set(identity.tradingDate, dateEntries);
  }
  const dates = [...tradingDates].sort();
  const mappings = [];
  const fileCounts = Object.fromEntries(
    INSTRUMENTS.map(instrument => [
      instrument.id,
      { mainFiles: 0, concreteFiles: 0 },
    ]),
  );
  for (const tradingDate of dates) {
    const dateCompact = tradingDate.replaceAll('-', '');
    const dateEntries = byDate.get(tradingDate) ?? [];
    for (const instrument of INSTRUMENTS) {
      const expectedMain = mainFilename(instrument, dateCompact);
      const concretePattern = concreteFilenamePattern(instrument, dateCompact);
      const mainEntries = dateEntries.filter(
        entry => entry.identity.basename === expectedMain,
      );
      const concreteEntries = dateEntries.flatMap(entry => {
        const match = concretePattern.exec(entry.identity.basename);
        return match ? [{ ...entry, contract: match[1] }] : [];
      });
      fileCounts[instrument.id].mainFiles += mainEntries.length;
      fileCounts[instrument.id].concreteFiles += concreteEntries.length;
      const matchedConcrete = mainEntries.length === 1
        ? concreteEntries.filter(entry => sameStoredPayload(entry, mainEntries[0]))
        : [];
      const status = (
        mainEntries.length === 1 && matchedConcrete.length === 1
          ? 'mapped'
          : 'ambiguous'
      );
      mappings.push({
        tradingDate,
        instrumentId: instrument.id,
        status,
        contract: matchedConcrete[0]?.contract ?? null,
        mainEntry: mainEntries[0] ?? null,
        concreteEntry: matchedConcrete[0] ?? null,
        mainEntries,
        concreteCandidates: concreteEntries,
        matchMethod: status === 'mapped' ? 'identical-stored-payload' : null,
        semanticMatchingConcreteCount: matchedConcrete.length,
      });
    }
  }
  const issues = mappings
    .filter(mapping => mapping.status !== 'mapped')
    .map(mappingIssue);
  return {
    name: archive.name,
    path: archive.path,
    period: archive.period,
    pointer: archive.pointer,
    repositoryEntry: archive.repositoryEntry,
    remote: archive.remote,
    centralDirectory,
    entryLayout: {
      directoryEntryCount,
      recognizedDataFileCount,
      unrecognizedFileCount,
      unrecognizedFileSamples,
      allCentralDirectoryEntriesAccountedFor: (
        directoryEntryCount + recognizedDataFileCount + unrecognizedFileCount
        === centralDirectory.entryCount
      ),
    },
    tradingDates: dates,
    firstTradingDate: dates[0] ?? null,
    lastTradingDate: dates.at(-1) ?? null,
    fileCounts,
    mappings,
    issues,
  };
}

function semanticMappingSignature(buffer, entryName) {
  const text = new TextDecoder('gb18030').decode(buffer).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) throw new Error(`${entryName} CSV 为空`);
  const header = splitCsvRow(lines[0]).map(value => value.trim());
  const retainedIndexes = header.flatMap((field, index) => (
    SEMANTIC_MAPPING_IGNORED_FIELDS.has(field) ? [] : [index]
  ));
  const hash = createHash('sha256');
  hash.update(retainedIndexes.map(index => header[index]).join('\u001f'));
  hash.update('\n');
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = splitCsvRow(lines[lineIndex]);
    if (fields.length !== header.length) {
      throw new Error(`${entryName} 第 ${lineIndex + 1} 行列数不一致`);
    }
    hash.update(retainedIndexes.map(index => fields[index]).join('\u001f'));
    hash.update('\n');
  }
  return {
    rowCount: lines.length - 1,
    sha256: hash.digest('hex'),
  };
}

export async function resolveSemanticMappings(archive, analysis) {
  const candidates = analysis.mappings.filter(mapping => (
    mapping.status !== 'mapped'
    && mapping.mainEntries.length === 1
    && mapping.concreteCandidates.length > 0
  ));
  for (const mapping of candidates) {
    const mainSignature = semanticMappingSignature(
      await extractEntry(archive, mapping.mainEntries[0]),
      mapping.mainEntries[0].name,
    );
    const semanticMatches = [];
    for (const concreteEntry of mapping.concreteCandidates) {
      const concreteSignature = semanticMappingSignature(
        await extractEntry(archive, concreteEntry),
        concreteEntry.name,
      );
      if (concreteSignature.rowCount === mainSignature.rowCount
        && concreteSignature.sha256 === mainSignature.sha256) {
        semanticMatches.push(concreteEntry);
      }
    }
    mapping.semanticMatchingConcreteCount = semanticMatches.length;
    if (semanticMatches.length === 1) {
      mapping.status = 'mapped';
      mapping.contract = semanticMatches[0].contract;
      mapping.concreteEntry = semanticMatches[0];
      mapping.matchMethod = 'semantic-csv-excluding-average-price';
    }
  }
  analysis.issues = analysis.mappings
    .filter(mapping => mapping.status !== 'mapped')
    .map(mappingIssue);
  analysis.mappingMatchMethods = Object.fromEntries(
    Object.entries(Object.groupBy(
      analysis.mappings.filter(mapping => mapping.status === 'mapped'),
      mapping => mapping.matchMethod,
    )).map(([method, mappings]) => [method, mappings.length]),
  );
}

function periodDate(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const day = period.length === 8 ? Number(period.slice(6, 8)) : 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function archiveStructureSummary(analysis) {
  const instruments = INSTRUMENTS.map(instrument => {
    const counts = analysis.fileCounts[instrument.id];
    return {
      instrumentId: instrument.id,
      name: instrument.name,
      mainFiles: counts.mainFiles,
      concreteFiles: counts.concreteFiles,
      mainFileForEveryTradingDay: (
        analysis.tradingDates.length > 0
        && counts.mainFiles === analysis.tradingDates.length
      ),
      concreteFilesPresent: counts.concreteFiles > 0,
    };
  });
  return {
    path: analysis.path,
    period: analysis.period,
    firstTradingDate: analysis.firstTradingDate,
    lastTradingDate: analysis.lastTradingDate,
    tradingDays: analysis.tradingDates.length,
    mappingIssueCount: analysis.issues.length,
    mappingMatchMethods: analysis.mappingMatchMethods,
    entryLayout: analysis.entryLayout,
    allEntriesRecognized: (
      analysis.entryLayout.allCentralDirectoryEntriesAccountedFor
      && analysis.entryLayout.unrecognizedFileCount === 0
      && analysis.entryLayout.recognizedDataFileCount > 0
    ),
    allInstrumentMainFilesPresent: instruments.every(
      instrument => instrument.mainFileForEveryTradingDay,
    ),
    allInstrumentConcreteFilesPresent: instruments.every(
      instrument => instrument.concreteFilesPresent,
    ),
    allDailyMainMappingsUnique: analysis.issues.length === 0,
    instruments,
  };
}

function summarizeHistoricalStructure(
  inventory,
  archiveAnalyses,
  scanAllCentralDirectories,
) {
  const analysisByPeriod = new Map(
    archiveAnalyses.map(analysis => [analysis.period, analysis]),
  );
  const representativeArchives = HISTORY_REPRESENTATIVE_PERIODS.map(period => {
    const analysis = analysisByPeriod.get(period);
    if (!analysis) throw new Error(`缺少历史代表归档分析：${period}`);
    return archiveStructureSummary(analysis);
  });
  const scannedArchives = archiveAnalyses.map(archiveStructureSummary);
  const firstDate = periodDate(inventory.firstArchivePeriod);
  const threeYearsAfterFirst = new Date(firstDate);
  threeYearsAfterFirst.setUTCFullYear(threeYearsAfterFirst.getUTCFullYear() + 3);
  const inventorySpansAtLeastThreeYears = (
    periodDate(inventory.lastArchivePeriod) >= threeYearsAfterFirst
  );
  const allRepresentativeArchivesConsistent = representativeArchives.every(
    archive => (
      archive.tradingDays > 0
      && archive.allEntriesRecognized
      && archive.allInstrumentMainFilesPresent
      && archive.allInstrumentConcreteFilesPresent
      && archive.allDailyMainMappingsUnique
    ),
  );
  const allInventoryCentralDirectoriesScanned = (
    scanAllCentralDirectories
    && archiveAnalyses.length === inventory.archiveCount
  );
  const allScannedArchivesConsistent = scannedArchives.every(archive => (
    archive.tradingDays > 0
    && archive.allEntriesRecognized
    && archive.allInstrumentMainFilesPresent
    && archive.allInstrumentConcreteFilesPresent
    && archive.allDailyMainMappingsUnique
  ));
  return {
    inventoryFirstArchivePeriod: inventory.firstArchivePeriod,
    inventoryLastArchivePeriod: inventory.lastArchivePeriod,
    inventorySpansAtLeastThreeYears,
    representativePeriods: HISTORY_REPRESENTATIVE_PERIODS,
    representativeArchives,
    allRepresentativeArchivesConsistent,
    scannedCentralDirectoryCount: archiveAnalyses.length,
    allInventoryCentralDirectoriesScanned,
    allScannedArchivesConsistent,
    threeYearCoveragePotentialConfirmed: (
      inventorySpansAtLeastThreeYears
      && allRepresentativeArchivesConsistent
    ),
    threeYearContinuousStructureConfirmed: (
      inventorySpansAtLeastThreeYears
      && allInventoryCentralDirectoriesScanned
      && allScannedArchivesConsistent
    ),
    conclusion: (
      allInventoryCentralDirectoriesScanned
        ? '已扫描完整仓库清单中的全部 ZIP 中央目录，可继续按授权结论决定是否提取并生成长期 K 线。'
        : '仓库清单跨越三年以上，四个年度代表归档结构一致；尚未扫描每个归档，结论仅为长期覆盖潜力。'
    ),
  };
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function summarizeSelectedEntries(mappings) {
  const selected = mappings.filter(
    mapping => mapping.status === 'mapped' && mapping.concreteEntry,
  );
  return {
    entryCount: selected.length,
    compressedBytes: selected.reduce(
      (sum, mapping) => sum + mapping.concreteEntry.compressedSize,
      0,
    ),
    uncompressedBytes: selected.reduce(
      (sum, mapping) => sum + mapping.concreteEntry.uncompressedSize,
      0,
    ),
    estimatedRangeRequestBytes: selected.reduce(
      (sum, mapping) => sum + 30 + mapping.concreteEntry.compressedSize,
      0,
    ),
  };
}

export function summarizeMappings(archiveAnalyses) {
  const allDates = [...new Set(
    archiveAnalyses.flatMap(archive => archive.tradingDates),
  )].sort();
  const mappings = archiveAnalyses
    .flatMap(archive => archive.mappings)
    .sort((left, right) => (
      left.tradingDate.localeCompare(right.tradingDate)
      || left.instrumentId.localeCompare(right.instrumentId)
    ));
  const mappingByKey = new Map(
    mappings.map(mapping => [
      `${mapping.tradingDate}|${mapping.instrumentId}`,
      mapping,
    ]),
  );
  const normalizedMapping = mappings.map(mapping => (
    `${mapping.tradingDate},${mapping.instrumentId},${mapping.status},`
    + `${mapping.contract ?? ''},${mapping.matchMethod ?? ''},`
    + `${mapping.concreteEntry?.crc32Hex ?? ''}`
  )).join('\n');
  const instruments = INSTRUMENTS.map(instrument => {
    const instrumentMappings = mappings.filter(
      mapping => mapping.instrumentId === instrument.id,
    );
    const targetDates = allDates.filter(
      date => date >= GAP_START_DATE && date <= instrument.gapEndDate,
    );
    const targetMappings = targetDates.map(
      date => mappingByKey.get(`${date}|${instrument.id}`),
    );
    const missingDates = targetDates.filter((date, index) => (
      !targetMappings[index] || targetMappings[index].status !== 'mapped'
    ));
    const validMappings = targetMappings.filter(
      mapping => mapping?.status === 'mapped',
    );
    const contractSpans = [];
    const rollovers = [];
    for (const mapping of validMappings) {
      const previousSpan = contractSpans.at(-1);
      if (!previousSpan || previousSpan.contract !== mapping.contract) {
        if (previousSpan) {
          rollovers.push({
            tradingDate: mapping.tradingDate,
            fromContract: previousSpan.contract,
            toContract: mapping.contract,
          });
        }
        contractSpans.push({
          contract: mapping.contract,
          firstTradingDate: mapping.tradingDate,
          lastTradingDate: mapping.tradingDate,
          tradingDays: 1,
        });
      } else {
        previousSpan.lastTradingDate = mapping.tradingDate;
        previousSpan.tradingDays += 1;
      }
    }
    return {
      instrumentId: instrument.id,
      name: instrument.name,
      productCode: instrument.productCode,
      requiredGap: {
        firstDate: GAP_START_DATE,
        lastDate: instrument.gapEndDate,
      },
      expectedArchiveTradingDays: targetDates.length,
      mappedTradingDays: validMappings.length,
      firstMappedTradingDate: validMappings[0]?.tradingDate ?? null,
      lastMappedTradingDate: validMappings.at(-1)?.tradingDate ?? null,
      missingOrAmbiguousTradingDates: missingDates,
      technicallyCovered: (
        targetDates.length > 0
        && targetDates[0] === GAP_START_DATE
        && missingDates.length === 0
      ),
      fullHistorySelection: {
        firstTradingDate: instrumentMappings[0]?.tradingDate ?? null,
        lastTradingDate: instrumentMappings.at(-1)?.tradingDate ?? null,
        ...summarizeSelectedEntries(instrumentMappings),
      },
      gapSelection: summarizeSelectedEntries(validMappings),
      contractSpans,
      rollovers,
    };
  });
  return {
    archiveTradingDays: allDates.length,
    firstArchiveTradingDate: allDates[0] ?? null,
    lastArchiveTradingDate: allDates.at(-1) ?? null,
    normalizedDailyMappingSha256: sha256Text(normalizedMapping),
    fullHistorySelection: summarizeSelectedEntries(mappings),
    instruments,
    allTargetGapsTechnicallyCovered: instruments.every(
      instrument => instrument.technicallyCovered,
    ),
    mappingByKey,
  };
}

export async function extractEntry(archive, entry) {
  const localHeader = await fetchRange(
    archive,
    entry.localHeaderOffset,
    entry.localHeaderOffset + 29,
    `local-header ${entry.name}`,
  );
  if (localHeader.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`${archive.name} 本地文件头签名无效：${entry.name}`);
  }
  const compressionMethod = localHeader.readUInt16LE(8);
  const filenameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  if (compressionMethod !== entry.compressionMethod) {
    throw new Error(`${archive.name} 压缩方法不一致：${entry.name}`);
  }
  const dataStart = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const compressed = entry.compressedSize === 0
    ? Buffer.alloc(0)
    : await fetchRange(
      archive,
      dataStart,
      dataStart + entry.compressedSize - 1,
      `entry ${entry.name}`,
    );
  let uncompressed;
  if (entry.compressionMethod === 0) uncompressed = compressed;
  else if (entry.compressionMethod === 8) uncompressed = inflateRawSync(compressed);
  else throw new Error(`不支持的 ZIP 压缩方法 ${entry.compressionMethod}：${entry.name}`);
  if (uncompressed.length !== entry.uncompressedSize) {
    throw new Error(`${archive.name} 解压大小不一致：${entry.name}`);
  }
  const actualCrc32 = crc32(uncompressed);
  if (actualCrc32 !== entry.crc32) {
    throw new Error(`${archive.name} CRC32 不一致：${entry.name}`);
  }
  return uncompressed;
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function splitCsvRow(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === ',') {
      values.push(value);
      value = '';
    } else if (character === '"') {
      quoted = true;
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  values.push(value);
  return values;
}

function finiteNumber(value, field, lineNumber) {
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed)) {
    throw new Error(`Tick CSV 第 ${lineNumber} 行 ${field} 不是有限数值`);
  }
  return parsed;
}

function sessionAtMinute(wallMinute) {
  for (const [session, segments] of Object.entries(SESSION_SEGMENTS)) {
    let base = 0;
    const total = segments.reduce(
      (sum, [start, end]) => sum + end - start,
      0,
    );
    for (const [start, end] of segments) {
      if (wallMinute >= start && wallMinute < end) {
        return {
          session,
          index: base + wallMinute - start,
          total,
        };
      }
      base += end - start;
    }
  }
  return undefined;
}

function sessionAtExactClose(wallMinute, second) {
  if (second !== 0) return undefined;
  for (const [session, segments] of Object.entries(SESSION_SEGMENTS)) {
    if (segments.some(([, end]) => wallMinute === end)) {
      return { session };
    }
  }
  return undefined;
}

function isSessionSegmentStart(wallMinute) {
  return Object.values(SESSION_SEGMENTS).some(segments => (
    segments.some(([start]) => wallMinute === start)
  ));
}

function wallMinuteAtIndex(session, index) {
  const segments = SESSION_SEGMENTS[session];
  let remaining = index;
  for (const [start, end] of segments) {
    const length = end - start;
    if (remaining < length) return start + remaining;
    remaining -= length;
  }
  throw new Error(`${session} 交易分钟索引越界：${index}`);
}

function beijingTimestampMs(date, hour, minute, second, millisecond) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(
    year,
    month - 1,
    day,
    hour - 8,
    minute,
    second,
    millisecond,
  );
}

function formatBeijing(ms) {
  const date = new Date(ms + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseTickCsv(buffer, context) {
  if (!['DCE', 'CZCE', 'SHFE'].includes(context.exchange)) {
    throw new Error(`${context.entryName} 缺少有效交易所上下文`);
  }
  const text = new TextDecoder('gb18030').decode(buffer).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) throw new Error(`${context.entryName} CSV 为空`);
  const header = splitCsvRow(lines[0]).map(value => value.trim());
  for (const field of REQUIRED_TICK_FIELDS) {
    if (!header.includes(field)) throw new Error(`${context.entryName} 缺少字段 ${field}`);
  }
  const indexes = Object.fromEntries(
    REQUIRED_TICK_FIELDS.map(field => [field, header.indexOf(field)]),
  );
  const stats = {
    sourceRows: lines.length - 1,
    acceptedTicks: 0,
    filteredOutsideTradingSession: 0,
    invalidPriceRows: 0,
    tradingDayFieldMismatches: 0,
    tradingDayFieldUsesPreviousSessionDate: 0,
    observedTradingDayFields: {
      day: {},
      night: {},
    },
    instrumentFieldMismatches: 0,
    duplicateTimestamps: 0,
    cumulativeVolumeResets: 0,
    sessionCloseTicksReassigned: 0,
    exactMinuteBoundarySnapshotsReassigned: 0,
  };
  const ticks = [];
  let previousTimestamp = null;
  let previousCumulativeVolume = null;
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = splitCsvRow(lines[lineIndex]);
    if (fields.length !== header.length) {
      throw new Error(`${context.entryName} 第 ${lineIndex + 1} 行列数不一致`);
    }
    const field = name => fields[indexes[name]].trim();
    const updateTime = /^(\d{2}):(\d{2}):(\d{2})$/.exec(field('UpdateTime'));
    if (!updateTime) {
      throw new Error(`${context.entryName} 第 ${lineIndex + 1} 行 UpdateTime 无效`);
    }
    const hour = Number(updateTime[1]);
    const minute = Number(updateTime[2]);
    const second = Number(updateTime[3]);
    const wallMinute = hour * 60 + minute;
    const regularSession = sessionAtMinute(wallMinute);
    const exactCloseSession = sessionAtExactClose(wallMinute, second);
    const session = regularSession ?? exactCloseSession;
    if (!session) {
      stats.filteredOutsideTradingSession += 1;
      continue;
    }
    const lastPrice = finiteNumber(field('LastPrice'), 'LastPrice', lineIndex + 1);
    const cumulativeVolume = finiteNumber(field('Volume'), 'Volume', lineIndex + 1);
    const openInterest = finiteNumber(
      field('OpenInterest'),
      'OpenInterest',
      lineIndex + 1,
    );
    const updateMillisec = finiteNumber(
      field('UpdateMillisec'),
      'UpdateMillisec',
      lineIndex + 1,
    );
    if (
      !Number.isInteger(updateMillisec)
      || updateMillisec < 0
      || updateMillisec > 999
    ) {
      throw new Error(
        `${context.entryName} 第 ${lineIndex + 1} 行 UpdateMillisec 必须是 0 至 999 的整数`,
      );
    }
    if (lastPrice <= 0 || cumulativeVolume < 0 || openInterest < 0) {
      stats.invalidPriceRows += 1;
      continue;
    }
    const tradingDayField = field('TradingDay');
    const observedTradingDays = stats.observedTradingDayFields[session.session];
    observedTradingDays[tradingDayField] = (
      observedTradingDays[tradingDayField] ?? 0
    ) + 1;
    const canonicalTradingDay = context.tradingDate.replaceAll('-', '');
    const previousSessionDate = context.previousTradingDate?.replaceAll('-', '');
    const usesPreviousSessionDate = (
      session.session === 'night'
      && previousSessionDate
      && tradingDayField === previousSessionDate
    );
    if (usesPreviousSessionDate) {
      stats.tradingDayFieldUsesPreviousSessionDate += 1;
    } else if (tradingDayField !== canonicalTradingDay) {
      stats.tradingDayFieldMismatches += 1;
    }
    if (field('InstrumentID') !== context.contract) {
      stats.instrumentFieldMismatches += 1;
    }
    const naturalDate = session.session === 'night'
      ? context.previousTradingDate
      : context.tradingDate;
    if (!naturalDate) {
      throw new Error(`${context.entryName} 缺少夜盘自然日依据`);
    }
    let timestampMs = beijingTimestampMs(
      naturalDate,
      hour,
      minute,
      second,
      Math.trunc(updateMillisec),
    );
    if (!regularSession && exactCloseSession) {
      timestampMs = beijingTimestampMs(
        naturalDate,
        hour,
        minute,
        0,
        0,
      ) - 1;
      stats.sessionCloseTicksReassigned += 1;
    } else if (
      context.exchange === 'SHFE'
      && second === 0
      && updateMillisec === 0
      && !isSessionSegmentStart(wallMinute)
    ) {
      // SHFE整分钟快照通常是上一采样区间的结束状态。
      timestampMs -= 1;
      stats.exactMinuteBoundarySnapshotsReassigned += 1;
    }
    if (previousTimestamp === timestampMs) stats.duplicateTimestamps += 1;
    let volumeDelta;
    if (previousCumulativeVolume === null) {
      volumeDelta = cumulativeVolume;
    } else if (cumulativeVolume >= previousCumulativeVolume) {
      volumeDelta = cumulativeVolume - previousCumulativeVolume;
    } else {
      stats.cumulativeVolumeResets += 1;
      volumeDelta = cumulativeVolume;
    }
    previousTimestamp = timestampMs;
    previousCumulativeVolume = cumulativeVolume;
    stats.acceptedTicks += 1;
    ticks.push({
      timestampMs,
      lastPrice,
      volumeDelta,
      openInterest,
      session: session.session,
    });
  }
  return {
    stats,
    ticks,
    fields: header,
  };
}

export function ticksToMinutes(ticks) {
  const minutes = new Map();
  for (const tick of ticks) {
    const startMs = Math.floor(tick.timestampMs / MINUTE_MS) * MINUTE_MS;
    const existing = minutes.get(startMs);
    if (!existing) {
      minutes.set(startMs, {
        startMs,
        open: tick.lastPrice,
        high: tick.lastPrice,
        low: tick.lastPrice,
        close: tick.lastPrice,
        volume: tick.volumeDelta,
        openOi: tick.openInterest,
        closeOi: tick.openInterest,
      });
    } else {
      existing.high = Math.max(existing.high, tick.lastPrice);
      existing.low = Math.min(existing.low, tick.lastPrice);
      existing.close = tick.lastPrice;
      existing.volume += tick.volumeDelta;
      existing.closeOi = tick.openInterest;
    }
  }
  const ordered = [...minutes.values()].sort(
    (left, right) => left.startMs - right.startMs,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    current.openOi = previous.closeOi;
    if (current.startMs === previous.startMs + MINUTE_MS) {
      current.open = previous.close;
      current.high = Math.max(current.high, current.open);
      current.low = Math.min(current.low, current.open);
    }
  }
  return ordered;
}

export function aggregateMinutes(minutes, period) {
  const groups = new Map();
  for (const minute of minutes) {
    const text = formatBeijing(minute.startMs);
    const wallMinute = Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16));
    const tradingMinute = sessionAtMinute(wallMinute);
    if (!tradingMinute) throw new Error(`非交易分钟：${text}`);
    const date = text.slice(0, 10);
    const bucket = Math.floor(tradingMinute.index / period);
    const key = `${date}|${tradingMinute.session}|${bucket}`;
    const group = groups.get(key) ?? {
      date,
      session: tradingMinute.session,
      bucket,
      total: tradingMinute.total,
      minutes: [],
    };
    group.minutes.push(minute);
    groups.set(key, group);
  }
  const bars = [];
  for (const group of groups.values()) {
    group.minutes.sort((left, right) => left.startMs - right.startMs);
    const startIndex = group.bucket * period;
    const stopIndex = Math.min(startIndex + period, group.total);
    const [year, month, day] = group.date.split('-').map(Number);
    const dateStartMs = Date.UTC(year, month - 1, day) - 8 * 60 * MINUTE_MS;
    const startMs = dateStartMs
      + wallMinuteAtIndex(group.session, startIndex) * MINUTE_MS;
    const endMs = dateStartMs
      + (wallMinuteAtIndex(group.session, stopIndex - 1) + 1) * MINUTE_MS;
    const part = group.minutes;
    bars.push({
      startMs,
      endMs,
      open: part[0].open,
      high: Math.max(...part.map(item => item.high)),
      low: Math.min(...part.map(item => item.low)),
      close: part.at(-1).close,
      volume: part.reduce((sum, item) => sum + item.volume, 0),
      openOi: part[0].openOi,
      closeOi: part.at(-1).closeOi,
      observedMinutes: part.length,
      expectedMinutes: stopIndex - startIndex,
      complete: part.length === stopIndex - startIndex,
    });
  }
  return bars.sort((left, right) => left.startMs - right.startMs);
}

function equalNumber(left, right) {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9;
}

function reconcileFiveAndSixty(bars5, bars60) {
  const mismatches = [];
  for (const parent of bars60) {
    const children = bars5.filter(
      child => child.startMs >= parent.startMs && child.endMs <= parent.endMs,
    );
    if (!children.length) {
      mismatches.push({
        start: formatBeijing(parent.startMs),
        fields: ['children'],
      });
      continue;
    }
    const expected = {
      open: children[0].open,
      high: Math.max(...children.map(child => child.high)),
      low: Math.min(...children.map(child => child.low)),
      close: children.at(-1).close,
      volume: children.reduce((sum, child) => sum + child.volume, 0),
      openOi: children[0].openOi,
      closeOi: children.at(-1).closeOi,
    };
    const fields = Object.keys(expected).filter(
      field => !equalNumber(parent[field], expected[field]),
    );
    if (fields.length) {
      mismatches.push({
        start: formatBeijing(parent.startMs),
        fields,
      });
    }
  }
  return mismatches;
}

function hashBars(bars) {
  return sha256Text(bars.map(bar => [
    formatBeijing(bar.startMs),
    formatBeijing(bar.endMs),
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.openOi,
    bar.closeOi,
    bar.observedMinutes,
    bar.expectedMinutes,
    bar.complete,
  ].join(',')).join('\n'));
}

function findArchiveForTradingDate(tradingDate, archives, archiveAnalyses) {
  const matchingAnalyses = archiveAnalyses.filter(
    analysis => analysis.tradingDates.includes(tradingDate),
  );
  if (matchingAnalyses.length !== 1) {
    throw new Error(
      `${tradingDate} 应唯一归属于一个已扫描归档，实际 ${matchingAnalyses.length} 个`,
    );
  }
  const analysis = matchingAnalyses[0];
  const archive = archives.find(candidate => candidate.path === analysis.path);
  if (!archive) {
    throw new Error(`找不到样本归属归档：${analysis.path}`);
  }
  return { archive, analysis };
}

async function probeSample(
  options,
  instrument,
  archives,
  archiveAnalyses,
  mappingSummary,
) {
  const allTradingDates = [...new Set(
    archiveAnalyses.flatMap(archive => archive.tradingDates),
  )].sort();
  const sampleDates = options.sampleDates?.length
    ? options.sampleDates
    : allTradingDates.filter(
      date => date >= options.sampleStartDate && date <= options.sampleEndDate,
    );
  const unavailableDates = sampleDates.filter(date => !allTradingDates.includes(date));
  if (unavailableDates.length) {
    throw new Error(`样本交易日不在已扫描归档中：${unavailableDates.join(', ')}`);
  }
  const perFile = [];
  const allMinutes = [];
  for (const tradingDate of sampleDates) {
    const mapping = mappingSummary.mappingByKey.get(
      `${tradingDate}|${instrument.id}`,
    );
    if (!mapping || mapping.status !== 'mapped' || !mapping.concreteEntry) {
      throw new Error(`${instrument.name} ${tradingDate} 缺少可抽取的主力具体合约`);
    }
    const { archive, analysis } = findArchiveForTradingDate(
      tradingDate,
      archives,
      archiveAnalyses,
    );
    const dateIndex = allTradingDates.indexOf(tradingDate);
    const previousTradingDate = dateIndex > 0 ? allTradingDates[dateIndex - 1] : null;
    const raw = await extractEntry(archive, mapping.concreteEntry);
    const parsed = parseTickCsv(raw, {
      entryName: mapping.concreteEntry.name,
      tradingDate,
      previousTradingDate,
      contract: mapping.contract,
      exchange: instrument.exchange,
    });
    const minutes = ticksToMinutes(parsed.ticks);
    allMinutes.push(...minutes);
    perFile.push({
      tradingDate,
      previousTradingDate,
      contract: mapping.contract,
      mappingMatchMethod: mapping.matchMethod,
      archivePath: analysis.path,
      entry: mapping.concreteEntry.name,
      compressedBytes: mapping.concreteEntry.compressedSize,
      uncompressedBytes: mapping.concreteEntry.uncompressedSize,
      crc32: mapping.concreteEntry.crc32Hex,
      fields: parsed.fields,
      ...parsed.stats,
      minuteRecords: minutes.length,
      firstMinute: minutes.length ? formatBeijing(minutes[0].startMs) : null,
      lastMinute: minutes.length ? formatBeijing(minutes.at(-1).startMs) : null,
    });
  }
  allMinutes.sort((left, right) => left.startMs - right.startMs);
  const bars5 = aggregateMinutes(allMinutes, 5);
  const bars60 = aggregateMinutes(allMinutes, 60);
  const reconciliationMismatches = reconcileFiveAndSixty(bars5, bars60);
  const duplicateMinuteTimestamps = allMinutes.length
    - new Set(allMinutes.map(minute => minute.startMs)).size;
  return {
    instrumentId: instrument.id,
    instrumentName: instrument.name,
    requestedRange: {
      firstDate: options.sampleStartDate,
      lastDate: options.sampleEndDate,
    },
    sampledTradingDates: sampleDates,
    files: perFile,
    totals: {
      files: perFile.length,
      sourceRows: perFile.reduce((sum, file) => sum + file.sourceRows, 0),
      acceptedTicks: perFile.reduce((sum, file) => sum + file.acceptedTicks, 0),
      filteredOutsideTradingSession: perFile.reduce(
        (sum, file) => sum + file.filteredOutsideTradingSession,
        0,
      ),
      invalidPriceRows: perFile.reduce((sum, file) => sum + file.invalidPriceRows, 0),
      duplicateTickTimestamps: perFile.reduce(
        (sum, file) => sum + file.duplicateTimestamps,
        0,
      ),
      duplicateMinuteTimestamps,
      cumulativeVolumeResets: perFile.reduce(
        (sum, file) => sum + file.cumulativeVolumeResets,
        0,
      ),
      sessionCloseTicksReassigned: perFile.reduce(
        (sum, file) => sum + file.sessionCloseTicksReassigned,
        0,
      ),
      tradingDayFieldMismatches: perFile.reduce(
        (sum, file) => sum + file.tradingDayFieldMismatches,
        0,
      ),
      tradingDayFieldUsesPreviousSessionDate: perFile.reduce(
        (sum, file) => sum + file.tradingDayFieldUsesPreviousSessionDate,
        0,
      ),
      instrumentFieldMismatches: perFile.reduce(
        (sum, file) => sum + file.instrumentFieldMismatches,
        0,
      ),
      minuteRecords: allMinutes.length,
      bars5: bars5.length,
      completeBars5: bars5.filter(bar => bar.complete).length,
      bars60: bars60.length,
      completeBars60: bars60.filter(bar => bar.complete).length,
      fiveSixtyReconciliationMismatches: reconciliationMismatches.length,
    },
    derivedHashes: {
      bars5Sha256: hashBars(bars5),
      bars60Sha256: hashBars(bars60),
    },
    reconciliationMismatches,
    aggregationRules: {
      folderDateIsCanonicalTradingDay: true,
      nightNaturalDateUsesPreviousScannedTradingDay: true,
      tickTradingDayMayUseCanonicalOrPreviousNightSessionDate: true,
      sessionsAreEndExclusive: true,
      exactSessionCloseTicksBelongToPreviousMinute: true,
      exactSessionCloseBoundaries: [
        '10:15:00',
        '11:30:00',
        '15:00:00',
        '23:00:00',
      ],
      sessionCloseTicksAdvanceCumulativeVolumeAnchor: true,
      filteredSessions: [
        '09:00-10:15',
        '10:30-11:30',
        '13:30-15:00',
        '21:00-23:00',
      ],
      volumeUsesCumulativeTickDeltas: true,
      minuteOpenUsesPreviousCloseOnlyWhenWallClockMinuteIsContinuous: true,
      sessionBreakMinuteOpenUsesFirstTick: true,
      minuteOpenInterestUsesPreviousObservedMinuteCloseOpenInterest: true,
      inheritedOpenParticipatesInHighLow: true,
      barCloseOpenInterestUsesFinalTick: true,
      duplicateTickOrderUsesSourceRowOrder: true,
      sixtyMinuteBucketsUseProjectTradingMinuteIndex: true,
    },
    retention: {
      rawTickFilesPersisted: false,
      extractedTickRowsPersisted: false,
      derivedBarsPersisted: false,
      summaryAndHashesOnly: true,
    },
  };
}

function samplePassed(sample) {
  return (
    sample.totals.files > 0
    && sample.totals.minuteRecords > 0
    && sample.totals.bars5 > 0
    && sample.totals.bars60 > 0
    && sample.totals.invalidPriceRows === 0
    && sample.totals.duplicateMinuteTimestamps === 0
    && sample.totals.tradingDayFieldMismatches === 0
    && sample.totals.instrumentFieldMismatches === 0
    && sample.totals.fiveSixtyReconciliationMismatches === 0
  );
}

function summarizeSampleSuite(samples, options) {
  const totals = {
    instruments: samples.length,
    files: 0,
    compressedBytes: 0,
    uncompressedBytes: 0,
    sourceRows: 0,
    acceptedTicks: 0,
    filteredOutsideTradingSession: 0,
    invalidPriceRows: 0,
    duplicateTickTimestamps: 0,
    duplicateMinuteTimestamps: 0,
    cumulativeVolumeResets: 0,
    sessionCloseTicksReassigned: 0,
    tradingDayFieldMismatches: 0,
    tradingDayFieldUsesPreviousSessionDate: 0,
    instrumentFieldMismatches: 0,
    minuteRecords: 0,
    bars5: 0,
    completeBars5: 0,
    bars60: 0,
    completeBars60: 0,
    fiveSixtyReconciliationMismatches: 0,
  };
  for (const sample of samples) {
    totals.files += sample.totals.files;
    totals.compressedBytes += sample.files.reduce(
      (sum, file) => sum + file.compressedBytes,
      0,
    );
    totals.uncompressedBytes += sample.files.reduce(
      (sum, file) => sum + file.uncompressedBytes,
      0,
    );
    for (const field of [
      'sourceRows',
      'acceptedTicks',
      'filteredOutsideTradingSession',
      'invalidPriceRows',
      'duplicateTickTimestamps',
      'duplicateMinuteTimestamps',
      'cumulativeVolumeResets',
      'sessionCloseTicksReassigned',
      'tradingDayFieldMismatches',
      'tradingDayFieldUsesPreviousSessionDate',
      'instrumentFieldMismatches',
      'minuteRecords',
      'bars5',
      'completeBars5',
      'bars60',
      'completeBars60',
      'fiveSixtyReconciliationMismatches',
    ]) {
      totals[field] += sample.totals[field];
    }
  }
  const instruments = samples.map(sample => ({
    instrumentId: sample.instrumentId,
    instrumentName: sample.instrumentName,
    passed: samplePassed(sample),
    files: sample.totals.files,
    sampledTradingDates: sample.sampledTradingDates,
    bars5: sample.totals.bars5,
    completeBars5: sample.totals.completeBars5,
    bars60: sample.totals.bars60,
    completeBars60: sample.totals.completeBars60,
    invalidPriceRows: sample.totals.invalidPriceRows,
    duplicateMinuteTimestamps: sample.totals.duplicateMinuteTimestamps,
    tradingDayFieldMismatches: sample.totals.tradingDayFieldMismatches,
    tradingDayFieldUsesPreviousSessionDate: (
      sample.totals.tradingDayFieldUsesPreviousSessionDate
    ),
    instrumentFieldMismatches: sample.totals.instrumentFieldMismatches,
    fiveSixtyReconciliationMismatches: (
      sample.totals.fiveSixtyReconciliationMismatches
    ),
    derivedHashes: sample.derivedHashes,
  }));
  return {
    requestedInstrumentIds: options.sampleInstrumentIds,
    requestedRange: {
      firstDate: options.sampleStartDate,
      lastDate: options.sampleEndDate,
    },
    requestedTradingDates: options.sampleDates,
    totals,
    instruments,
    passedInstrumentCount: instruments.filter(instrument => instrument.passed).length,
    allSamplesPassed: instruments.length > 0 && instruments.every(
      instrument => instrument.passed,
    ),
    samples,
    retention: {
      rawTickFilesPersisted: false,
      extractedTickRowsPersisted: false,
      derivedBarsPersisted: false,
      summaryAndHashesOnly: true,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  console.log('读取 ModelScope 仓库树...');
  const repositoryInventory = await fetchRepositoryInventory();
  const archivesToProbe = selectProbeArchives(
    repositoryInventory,
    options,
  );
  const inspectedArchives = [];
  for (const archive of archivesToProbe) {
    console.log(`检查 ${archive.path} 远程元数据...`);
    inspectedArchives.push(await inspectArchiveHeaders(archive));
  }

  const archiveAnalyses = [];
  for (const archive of inspectedArchives) {
    console.log(`读取 ${archive.path} 中央目录...`);
    const { centralDirectory, entries } = await readCentralDirectory(archive);
    const analysis = analyzeArchiveEntries(archive, centralDirectory, entries);
    await resolveSemanticMappings(archive, analysis);
    archiveAnalyses.push(analysis);
  }

  const mappingSummary = summarizeMappings(archiveAnalyses);
  const historicalStructure = summarizeHistoricalStructure(
    repositoryInventory,
    archiveAnalyses,
    options.scanAllCentralDirectories,
  );
  console.log(
    `抽取 ${options.sampleInstrumentIds.length} 个品种 `
    + `${options.sampleStartDate} 至 ${options.sampleEndDate} 有限样本...`,
  );
  const samples = [];
  for (const instrumentId of options.sampleInstrumentIds) {
    const instrument = INSTRUMENTS.find(candidate => candidate.id === instrumentId);
    console.log(`抽取 ${instrument.name} 样本...`);
    samples.push(await probeSample(
      options,
      instrument,
      inspectedArchives,
      archiveAnalyses,
      mappingSummary,
    ));
  }
  const sample = samples[0];
  const sampleSuite = summarizeSampleSuite(samples, options);

  const report = {
  schemaVersion: 3,
  purpose: 'modelscope-chinese-commodity-tick-gap-source-probe',
  capturedAt: new Date().toISOString(),
  source: {
    ...REPOSITORY,
    repositoryInventory: {
      api: repositoryInventory.api,
      archiveCount: repositoryInventory.archiveCount,
      monthlyArchiveCount: repositoryInventory.monthlyArchiveCount,
      dailyArchiveCount: repositoryInventory.dailyArchiveCount,
      totalBytes: repositoryInventory.totalBytes,
      firstArchivePeriod: repositoryInventory.firstArchivePeriod,
      firstArchivePath: repositoryInventory.firstArchivePath,
      lastArchivePeriod: repositoryInventory.lastArchivePeriod,
      lastArchivePath: repositoryInventory.lastArchivePath,
      normalizedManifestSha256: repositoryInventory.normalizedManifestSha256,
      yearly: repositoryInventory.yearly,
      archives: repositoryInventory.archives.map(archive => ({
        path: archive.path,
        name: archive.name,
        period: archive.period,
        granularity: archive.granularity,
        gitLfs: archive.pointer,
        repositoryEntry: archive.repositoryEntry,
      })),
    },
    datasetCard: {
      declaredLicense: 'Apache License 2.0',
      description: '期货tick',
      defaultTemplateOnly: true,
      upstreamMarketDataSourceDocumented: false,
      upstreamRedistributionRightsDocumented: false,
    },
  },
  target: {
    instrumentCount: INSTRUMENTS.length,
    gapStartDate: GAP_START_DATE,
    nonSoybeanMealGapEndDate: '2025-10-19',
    soybeanMealGapEndDate: '2025-10-08',
  },
  archives: archiveAnalyses.map(archive => ({
    name: archive.name,
    path: archive.path,
    period: archive.period,
    gitLfs: archive.pointer,
    repositoryEntry: archive.repositoryEntry,
    remote: archive.remote,
    centralDirectory: archive.centralDirectory,
    entryLayout: archive.entryLayout,
    firstTradingDate: archive.firstTradingDate,
    lastTradingDate: archive.lastTradingDate,
    tradingDays: archive.tradingDates.length,
    fileCounts: archive.fileCounts,
    mappingIssueCount: archive.issues.length,
    mappingMatchMethods: archive.mappingMatchMethods,
    mappingIssues: archive.issues,
  })),
  coverage: {
    archiveTradingDays: mappingSummary.archiveTradingDays,
    firstArchiveTradingDate: mappingSummary.firstArchiveTradingDate,
    lastArchiveTradingDate: mappingSummary.lastArchiveTradingDate,
    normalizedDailyMappingSha256: mappingSummary.normalizedDailyMappingSha256,
    instruments: mappingSummary.instruments,
    allTargetGapsTechnicallyCovered: (
      mappingSummary.allTargetGapsTechnicallyCovered
    ),
  },
  historicalStructure,
  sample,
  sampleSuite,
  rights: {
    repositoryLicenseClaimPresent: true,
    repositoryLicenseIdentifier: 'Apache-2.0',
    repositoryLicenseAppliesToFilesAsClaimedByCard: true,
    upstreamMarketDataProvenanceDocumented: false,
    upstreamMarketDataRedistributionAuthorityDocumented: false,
    gitStorageAllowedForMarketData: false,
    packagedApplicationRedistributionAllowed: false,
    commercialUseAllowedForMarketData: false,
    conclusion: (
      '数据集卡声明 Apache-2.0，但没有说明原始行情来源、取得方式或上游分发权。'
      + '在权利链获得明确书面确认前，技术探测结果只能用于临时质量验证。'
    ),
  },
  releaseDecision: {
    technicalGapCoverageConfirmed: mappingSummary.allTargetGapsTechnicallyCovered,
    technicalThreeYearCoveragePotentialConfirmed: (
      historicalStructure.threeYearCoveragePotentialConfirmed
    ),
    technicalThreeYearContinuousStructureConfirmed: (
      historicalStructure.threeYearContinuousStructureConfirmed
    ),
    boundedAggregationSamplePassed: (
      sampleSuite.allSamplesPassed
    ),
    redistributionPermissionConfirmed: false,
    baselineReplacementAllowed: false,
    task4_2MayBeMarkedComplete: false,
    reason: (
      '目标日期和十五品种的具体合约、每日主力映射可以技术性覆盖，'
      + '仓库清单及年度代表归档也证明存在三年以上历史覆盖潜力；'
      + '但缺少原始行情来源和再分发权利链，不能进入 Git、EXE 或安装包。'
    ),
  },
  retention: {
    fullArchivesDownloaded: false,
    centralDirectoriesOnlyForProbedArchives: true,
    probedArchiveCount: archiveAnalyses.length,
    rawTickFilesPersisted: false,
    reportContainsRawTickRows: false,
    reportContainsDerivedBarRows: false,
  },
  };

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已生成 ModelScope Tick 来源探测：${options.output}`);
  return report;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
