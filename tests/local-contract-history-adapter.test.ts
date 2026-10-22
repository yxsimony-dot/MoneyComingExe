import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopFuturesHistoryAdapter,
  LocalContractHistoryAdapter,
} from '../src/main/local-contract-history-adapter';
import {
  INSTRUMENT_LIST,
  type InstrumentDefinition,
} from '../src/shared/instruments';

const HEADER = 'datetime,open,high,low,close,volume,money,open_interest';
const DESKTOP_MAIN_HEADER =
  'exchange,symbol,open,close,high,low,amount,volume,position,bob,eob,type';
const DESKTOP_CONTRACT_HEADER =
  '日期,开盘价,最高价,最低价,收盘价,成交额,成交量,持仓量';
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), '合约历史适配器-'));
  temps.push(root);
  const directory = join(root, '5min', 'DCE', 'M');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'M2601.csv'), [
    HEADER,
    '2025-07-01 09:00:00,3000,3002,2999,3001,10,30010,1000',
    '2025-07-01 09:05:00,3001,3003,3000,3002,11,33022,1001',
    '2025-07-01 09:10:00,3002,3004,3001,3003,12,36036,1002',
  ].join('\n'));
  await writeFile(join(directory, 'M2605.csv'), [
    HEADER,
    '2025-07-01 09:00:00,3100,3102,3099,3101,20,62020,2000',
  ].join('\n'));
  await writeFile(join(directory, 'README.txt'), 'ignored');
  return root;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function singleFileZip(filename: string, text: string): Buffer {
  const name = Buffer.from(filename, 'utf8');
  const contents = Buffer.from(text, 'utf8');
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(contents.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(contents.length, 20);
  centralHeader.writeUInt32LE(contents.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);

  const local = Buffer.concat([localHeader, name, contents]);
  const central = Buffer.concat([centralHeader, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function fixtureContract(
  definition: InstrumentDefinition,
  expiry = definition.exchange === 'CZCE' ? '601' : '2601',
): string {
  const product = definition.contractCode.productCase === 'upper'
    ? definition.productCode.toUpperCase()
    : definition.productCode.toLowerCase();
  return `${product}${expiry}`;
}

async function writeDesktopInstrument(
  root: string,
  definition: InstrumentDefinition,
  options: {
    mainRows?: string[];
    currentContract?: string;
    currentRows?: string[];
    archivedContract?: string;
    archivedRows?: string[];
  } = {},
): Promise<string> {
  const exchangeDirectory = join(root, `${definition.exchange}_测试交易所`);
  const productCode = definition.productCode.toUpperCase();
  const directory = join(exchangeDirectory, `${productCode}_${definition.shortName}`);
  await mkdir(directory, { recursive: true });
  const mainRows = options.mainRows ?? [
    `${definition.exchange},${productCode}主力连续,100,101,102,99,1000,10,20,`
      + '2023-01-03 09:00:00+08:00,2023-01-03 09:01:00+08:00,14',
  ];
  await writeFile(
    join(directory, `${productCode}主力连续.csv`),
    `\uFEFF${[DESKTOP_MAIN_HEADER, ...mainRows].join('\n')}`,
  );
  if (options.currentContract) {
    await writeFile(
      join(directory, `${options.currentContract}.csv`),
      `\uFEFF${[
        DESKTOP_CONTRACT_HEADER,
        ...(options.currentRows ?? []),
      ].join('\r\n')}`,
    );
  }
  const archivedContract = options.archivedContract ?? fixtureContract(definition);
  await writeFile(
    join(directory, `${productCode}_${definition.shortName}_退市.zip`),
    singleFileZip(
      `${archivedContract}.csv`,
      `\uFEFF${[
        DESKTOP_CONTRACT_HEADER,
        ...(options.archivedRows ?? [
          '2023-01-03 09:00:00,100,102,99,101,,10,20',
        ]),
      ].join('\r\n')}`,
    ),
  );
  return directory;
}

async function desktopSourceFixture() {
  const root = await mkdtemp(join(tmpdir(), '桌面期货历史适配器-'));
  temps.push(root);
  const definition = INSTRUMENT_LIST.find(item => item.id === 'main_continuous')!;
  const directory = await writeDesktopInstrument(root, definition, {
    mainRows: [
      'DCE,M主力连续,3000,3001,3002,2999,30010,10,1000,'
        + '2025-07-01 09:00:00+08:00,2025-07-01 09:01:00+08:00,14',
      'DCE,M主力连续,3001,3002,3003,3000,33022,11,1001,'
        + '2025-07-01 09:01:00+08:00,2025-07-01 09:02:00+08:00,14',
      'DCE,M主力连续,3002,3003,3004,3001,36036,12,1002,'
        + '2025-07-01 09:02:00+08:00,2025-07-01 09:03:00+08:00,14',
    ],
    currentContract: 'm2701',
    currentRows: [
      '2026-01-16 21:00:00,2900,2916,2900,2902,2381270,82,82',
      '2026-01-16 21:01:00,2901,2903,2901,2901,3162230,109,191',
    ],
    archivedContract: 'm2609',
    archivedRows: [
      '2025-01-02 09:00:00,2800,2802,2799,2801,,2,11460',
      '2025-01-02 09:01:00,2801,2803,2800,2802,56040,20,11461',
      '2025-01-02 09:02:00,2802,2804,2801,2803,58863,21,11462',
    ],
  });
  return { root, directory };
}

describe('local contract five-minute history adapter', () => {
  it('lists registered contracts and pages a selected instrument/contract', async () => {
    const root = await sourceFixture();
    const adapter = new LocalContractHistoryAdapter(root, {
      sourceId: 'fixture-public-history',
      sourceName: '公开历史夹具',
      sourceVersion: 'fixture-v1',
      license: {
        identifier: 'fixture-license',
        redistributionAllowed: true,
        conclusion: '测试夹具允许再分发。',
      },
    });

    expect(await adapter.listContracts('main_continuous')).toEqual([
      'M2601',
      'M2605',
    ]);
    expect(adapter.description).toEqual({
      sourceId: 'fixture-public-history',
      sourceName: '公开历史夹具',
      sourceVersion: 'fixture-v1',
      acquiredAt: undefined,
      license: {
        identifier: 'fixture-license',
        redistributionAllowed: true,
        conclusion: '测试夹具允许再分发。',
      },
    });

    const first = await adapter.readPage({
      instrument: 'main_continuous',
      contract: 'M2601',
      pageSize: 2,
    });
    expect(first.nextCursor).toBe('2');
    expect(first.sourceFile).toMatchObject({
      relativePath: '5min/DCE/M/M2601.csv',
      rows: 3,
      firstTimestamp: '2025-07-01 09:00:00',
      lastTimestamp: '2025-07-01 09:10:00',
    });
    expect(first.sourceFile.bytes).toBeGreaterThan(0);
    expect(first.sourceFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await adapter.inspectFile({
      instrument: 'main_continuous',
      contract: 'M2601',
    })).toEqual(first.sourceFile);
    expect(first.records).toEqual([
      {
        instrumentId: 'main_continuous',
        sourceExchange: 'DCE',
        sourceContract: 'M2601',
        timestamp: '2025-07-01 09:00:00',
        open: 3000,
        high: 3002,
        low: 2999,
        close: 3001,
        volume: 10,
        openInterest: 1000,
        provenance: {
          sourceId: 'fixture-public-history',
          relativePath: '5min/DCE/M/M2601.csv',
          line: 2,
        },
      },
      {
        instrumentId: 'main_continuous',
        sourceExchange: 'DCE',
        sourceContract: 'M2601',
        timestamp: '2025-07-01 09:05:00',
        open: 3001,
        high: 3003,
        low: 3000,
        close: 3002,
        volume: 11,
        openInterest: 1001,
        provenance: {
          sourceId: 'fixture-public-history',
          relativePath: '5min/DCE/M/M2601.csv',
          line: 3,
        },
      },
    ]);
    expect(Object.keys(first.records[0])).not.toContain('money');

    const second = await adapter.readPage({
      instrument: 'main_continuous',
      contract: 'M2601',
      cursor: first.nextCursor,
      pageSize: 2,
    });
    expect(second.records.map(record => record.timestamp)).toEqual([
      '2025-07-01 09:10:00',
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects contracts from another instrument, bad cursors, and source schema leaks', async () => {
    const root = await sourceFixture();
    const adapter = new LocalContractHistoryAdapter(root);

    await expect(adapter.readPage({
      instrument: 'main_continuous',
      contract: 'V2601',
    })).rejects.toThrow(/不支持合约代码/);
    await expect(adapter.readPage({
      instrument: 'main_continuous',
      contract: 'M2601',
      cursor: '../1',
    })).rejects.toThrow(/分页游标无效/);

    const brokenDirectory = join(root, '5min', 'DCE', 'V');
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(join(brokenDirectory, 'V2601.csv'), [
      'datetime,open,high,low,close,volume,money',
      '2025-07-01 09:00:00,6000,6002,5999,6001,10,60010',
    ].join('\n'));
    await expect(adapter.readPage({
      instrument: 'pvc_main',
      contract: 'V2601',
    })).rejects.toThrow(/缺少来源列 open_interest/);
  });
});

describe('desktop futures minute history adapter', () => {
  it('streams and pages the main-continuous CSV without losing source metadata', async () => {
    const { root } = await desktopSourceFixture();
    const adapter = new DesktopFuturesHistoryAdapter(root, {
      acquiredAt: '2026-10-21',
    });

    const first = await adapter.readMainPage({
      instrument: 'main_continuous',
      pageSize: 2,
    });
    expect(first.nextCursor).toBe('2');
    expect(first.sourceFile).toMatchObject({
      relativePath: 'DCE_测试交易所/M_豆粕/M主力连续.csv',
      rows: 3,
      firstTimestamp: '2025-07-01 09:00:00',
      lastTimestamp: '2025-07-01 09:02:00',
      format: 'desktop-main-continuous-v1',
      storage: 'csv',
    });
    expect(first.sourceFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.records.map(record => [
      record.kind,
      record.timestamp,
      record.endTimestamp,
      record.close,
    ])).toEqual([
      ['main-continuous', '2025-07-01 09:00:00', '2025-07-01 09:01:00', 3001],
      ['main-continuous', '2025-07-01 09:01:00', '2025-07-01 09:02:00', 3002],
    ]);

    const second = await adapter.readMainPage({
      instrument: 'main_continuous',
      cursor: first.nextCursor,
      pageSize: 2,
    });
    expect(second.records.map(record => record.timestamp)).toEqual([
      '2025-07-01 09:02:00',
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads current CSV and retired ZIP members without extracting the archive', async () => {
    const { root, directory } = await desktopSourceFixture();
    const before = await readdir(directory);
    const adapter = new DesktopFuturesHistoryAdapter(root);

    expect(await adapter.listContracts('main_continuous')).toEqual([
      'm2609',
      'm2701',
    ]);
    const current = await adapter.readContractPage({
      instrument: 'main_continuous',
      contract: 'm2701',
      pageSize: 10,
    });
    expect(current.sourceFile.storage).toBe('csv');
    expect(current.records.map(record => record.timestamp)).toEqual([
      '2026-01-16 21:00:00',
      '2026-01-16 21:01:00',
    ]);

    const archivedFirst = await adapter.readContractPage({
      instrument: 'main_continuous',
      contract: 'm2609',
      pageSize: 2,
    });
    expect(archivedFirst.sourceFile).toMatchObject({
      storage: 'zip-member',
      archiveRelativePath: 'DCE_测试交易所/M_豆粕/M_豆粕_退市.zip',
      archiveMember: 'm2609.csv',
      rows: 3,
      firstTimestamp: '2025-01-02 09:00:00',
      lastTimestamp: '2025-01-02 09:02:00',
    });
    expect(archivedFirst.records[0]).toMatchObject({
      sourceSymbol: 'm2609',
      amount: null,
      volume: 2,
      openInterest: 11460,
      provenance: {
        relativePath: 'DCE_测试交易所/M_豆粕/M_豆粕_退市.zip!/m2609.csv',
        archiveMember: 'm2609.csv',
      },
    });
    const archivedSecond = await adapter.readContractPage({
      instrument: 'main_continuous',
      contract: 'm2609',
      cursor: archivedFirst.nextCursor,
      pageSize: 2,
    });
    expect(archivedSecond.records).toHaveLength(1);
    expect(archivedSecond.nextCursor).toBeUndefined();
    expect(await readdir(directory)).toEqual(before);
    expect(await readdir(directory)).not.toContain('m2609.csv');
  });

  it('scans main CSV and retired ZIP members in one pass with matching metadata', async () => {
    const { root, directory } = await desktopSourceFixture();
    const before = await readdir(directory);
    const adapter = new DesktopFuturesHistoryAdapter(root);
    const mainTimestamps: string[] = [];
    const mainFile = await adapter.scanMainRecords(
      'main_continuous',
      record => {
        mainTimestamps.push(record.timestamp);
      },
    );
    expect(mainTimestamps).toEqual([
      '2025-07-01 09:00:00',
      '2025-07-01 09:01:00',
      '2025-07-01 09:02:00',
    ]);
    expect(mainFile).toEqual(
      await adapter.inspectMainFile('main_continuous'),
    );

    const archivedRows: Array<{
      timestamp: string;
      sourceSymbol: string;
      relativePath: string;
    }> = [];
    const archivedFile = await adapter.scanContractRecords({
      instrument: 'main_continuous',
      contract: 'm2609',
    }, async record => {
      await Promise.resolve();
      archivedRows.push({
        timestamp: record.timestamp,
        sourceSymbol: record.sourceSymbol,
        relativePath: record.provenance.relativePath,
      });
    });
    expect(archivedRows).toEqual([
      {
        timestamp: '2025-01-02 09:00:00',
        sourceSymbol: 'm2609',
        relativePath: 'DCE_测试交易所/M_豆粕/M_豆粕_退市.zip!/m2609.csv',
      },
      {
        timestamp: '2025-01-02 09:01:00',
        sourceSymbol: 'm2609',
        relativePath: 'DCE_测试交易所/M_豆粕/M_豆粕_退市.zip!/m2609.csv',
      },
      {
        timestamp: '2025-01-02 09:02:00',
        sourceSymbol: 'm2609',
        relativePath: 'DCE_测试交易所/M_豆粕/M_豆粕_退市.zip!/m2609.csv',
      },
    ]);
    expect(archivedFile).toEqual(await adapter.inspectContractFile({
      instrument: 'main_continuous',
      contract: 'm2609',
    }));
    expect(await readdir(directory)).toEqual(before);
    expect(await readdir(directory)).not.toContain('m2609.csv');
  });

  it('discovers all fifteen configured instruments in the desktop directory layout', async () => {
    const root = await mkdtemp(join(tmpdir(), '桌面期货十五品种-'));
    temps.push(root);
    for (const definition of INSTRUMENT_LIST) {
      await writeDesktopInstrument(root, definition);
    }
    const adapter = new DesktopFuturesHistoryAdapter(root);

    for (const definition of INSTRUMENT_LIST) {
      const mainFile = await adapter.inspectMainFile(definition.id);
      const contracts = await adapter.listContracts(definition.id);
      expect(mainFile.rows, definition.name).toBe(1);
      expect(contracts, definition.name).toEqual([fixtureContract(definition)]);
    }
  });
});
