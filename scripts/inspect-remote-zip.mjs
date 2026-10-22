import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const DEFAULT_TAIL_BYTES = 128 * 1024;

function parseArguments(argv) {
  const options = {
    url: '',
    output: '',
    label: 'remote-zip',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--url' && value) {
      options.url = value;
      index += 1;
    } else if (argument === '--output' && value) {
      options.output = resolve(value);
      index += 1;
    } else if (argument === '--label' && value) {
      options.label = value;
      index += 1;
    } else {
      throw new Error(`不支持的参数：${argument}`);
    }
  }

  if (!options.url) {
    throw new Error('必须通过 --url 提供远程 ZIP 地址');
  }
  return options;
}

async function request(url, init, label) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...init,
    headers: {
      'User-Agent': 'MoneyComing-source-audit/1.0',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${label} 请求失败：HTTP ${response.status}`);
  }
  return response;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 无效：${value ?? '缺失'}`);
  }
  return parsed;
}

async function inspectHeaders(url) {
  const response = await request(url, { method: 'HEAD' }, 'HEAD');
  const bytes = positiveInteger(response.headers.get('content-length'), 'Content-Length');
  const acceptRanges = response.headers.get('accept-ranges');
  if (acceptRanges?.toLowerCase() !== 'bytes') {
    throw new Error(`远程对象不支持 HTTP Range：${acceptRanges ?? '缺失'}`);
  }
  return {
    resolvedUrl: response.url,
    bytes,
    acceptRanges,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    linkedSha256: response.headers.get('x-linked-etag'),
    lastModified: response.headers.get('last-modified'),
  };
}

async function fetchRange(url, start, end, totalBytes, label) {
  if (start < 0 || end < start || end >= totalBytes) {
    throw new Error(`${label} Range 越界：${start}-${end}/${totalBytes}`);
  }
  const response = await request(url, {
    headers: {
      Range: `bytes=${start}-${end}`,
    },
  }, label);
  if (response.status !== 206) {
    throw new Error(`${label} 未返回 HTTP 206`);
  }
  const expectedRange = `bytes ${start}-${end}/${totalBytes}`;
  if (response.headers.get('content-range') !== expectedRange) {
    throw new Error(
      `${label} Content-Range 不一致：${response.headers.get('content-range') ?? '缺失'}`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== end - start + 1) {
    throw new Error(`${label} 返回字节数不一致`);
  }
  return body;
}

function findEndOfCentralDirectory(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) {
      return offset;
    }
  }
  throw new Error('未找到有效 ZIP EOCD');
}

function decodeFileName(buffer, flags) {
  const utf8 = (flags & 0x0800) !== 0;
  return buffer.toString(utf8 ? 'utf8' : 'latin1');
}

function parseCentralDirectory(buffer, expectedEntries) {
  const entries = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`ZIP 中央目录结构无效：${cursor}`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) {
      throw new Error(`ZIP 中央目录记录越界：${cursor}`);
    }
    entries.push({
      path: decodeFileName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags),
      compressionMethod,
      crc32: crc32.toString(16).padStart(8, '0'),
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
      isDirectory: buffer[cursor + 46 + nameLength - 1] === 0x2f,
    });
    cursor = end;
  }
  if (entries.length !== expectedEntries) {
    throw new Error(`ZIP 中央目录条目数不一致：${entries.length}/${expectedEntries}`);
  }
  return entries;
}

function summarize(entries) {
  const extensions = {};
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;

  for (const entry of entries) {
    compressedBytes += entry.compressedBytes;
    uncompressedBytes += entry.uncompressedBytes;
    if (entry.isDirectory) {
      directoryCount += 1;
      continue;
    }
    fileCount += 1;
    const basename = entry.path.split('/').at(-1) ?? '';
    const extensionIndex = basename.lastIndexOf('.');
    const extension = extensionIndex >= 0
      ? basename.slice(extensionIndex).toLowerCase()
      : '(none)';
    extensions[extension] = (extensions[extension] ?? 0) + 1;
  }

  return {
    entryCount: entries.length,
    fileCount,
    directoryCount,
    compressedBytes,
    uncompressedBytes,
    extensionCounts: Object.fromEntries(
      Object.entries(extensions).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

const options = parseArguments(process.argv.slice(2));
const remote = await inspectHeaders(options.url);
const tailLength = Math.min(DEFAULT_TAIL_BYTES, remote.bytes);
const tailStart = remote.bytes - tailLength;
const tail = await fetchRange(
  remote.resolvedUrl,
  tailStart,
  remote.bytes - 1,
  remote.bytes,
  'ZIP 尾部',
);
const eocdOffset = findEndOfCentralDirectory(tail);
if (
  eocdOffset >= 20
  && tail.readUInt32LE(eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE
) {
  throw new Error('暂不支持 ZIP64 中央目录');
}
const diskNumber = tail.readUInt16LE(eocdOffset + 4);
const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
const totalEntries = tail.readUInt16LE(eocdOffset + 10);
const centralDirectoryBytes = tail.readUInt32LE(eocdOffset + 12);
const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
if (
  diskNumber !== 0
  || centralDirectoryDisk !== 0
  || entriesOnDisk !== totalEntries
) {
  throw new Error('暂不支持多卷 ZIP');
}
const centralDirectory = await fetchRange(
  remote.resolvedUrl,
  centralDirectoryOffset,
  centralDirectoryOffset + centralDirectoryBytes - 1,
  remote.bytes,
  'ZIP 中央目录',
);
const entries = parseCentralDirectory(centralDirectory, totalEntries);
const report = {
  schemaVersion: 1,
  purpose: 'remote-zip-directory-inspection',
  capturedAt: new Date().toISOString(),
  label: options.label,
  sourceUrl: options.url,
  remote,
  summary: summarize(entries),
  entries,
  retention: {
    remoteArchiveDownloaded: false,
    rawFileContentsPersisted: false,
    centralDirectoryOnly: true,
  },
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  await writeFile(options.output, output, 'utf8');
  console.log(`已写入 ${options.output}`);
} else {
  process.stdout.write(output);
}
