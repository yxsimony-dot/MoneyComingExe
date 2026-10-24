import { readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

export interface BenchmarkReleaseAuditRoot {
  directory: string;
  label?: string;
}

export interface BenchmarkReleaseAuditResult {
  directories: number;
  files: number;
  jsonFiles: number;
}

const THS_REPORT_FILES = new Set([
  'activation.json',
  'contract-matching.json',
  'field-diff.json',
  'minute-reconciliation.json',
  'report-manifest.json',
]);

function displayPath(root: BenchmarkReleaseAuditRoot, path: string): string {
  const relativePath = relative(resolve(root.directory), path).split(sep).join('/');
  return `${root.label ?? root.directory}/${relativePath}`;
}

function isKnownThsRepairPath(path: string): boolean {
  const normalized = path.split(sep).join('/').toLowerCase();
  const name = basename(normalized);
  return /(?:^|\/)repairs\/glass_main(?:\/|$)/.test(normalized)
    || /(?:^|\/)raw\/pages\/[^/]+\.json$/.test(normalized)
    || (
      /(?:^|\/)reports\/[^/]+$/.test(normalized)
      && THS_REPORT_FILES.has(name)
    )
    || name === 'ths_fg9999_5m.csv';
}

function containsThsRepairPayload(text: string): boolean {
  const compact = text.replace(/\s+/g, '').toLowerCase();
  return compact.includes('quota-h.10jqka.com.cn')
    || compact.includes('"provider":"ths"')
    || (
      compact.includes('fg9999')
      && (
        compact.includes('min_5')
        || compact.includes('"market":"67"')
        || compact.includes('"market":67')
      )
    );
}

function assertJsonDistributionSafe(
  value: unknown,
  label: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDistributionSafe(item, label);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const license = record.license;
  if (
    record.kind === 'benchmark-main'
    && (
      !license
      || typeof license !== 'object'
      || (license as Record<string, unknown>).redistributionAllowed !== true
    )
  ) {
    throw new Error(`${label} 包含未获再分发授权的 benchmark-main 来源`);
  }

  const protection = record.benchmarkProtection;
  if (
    protection
    && typeof protection === 'object'
    && (protection as Record<string, unknown>).provider === 'THS'
  ) {
    throw new Error(`${label} 包含仅限本机使用的 THS 基准保护 metadata`);
  }

  for (const child of Object.values(record)) {
    assertJsonDistributionSafe(child, label);
  }
}

async function listFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function auditBenchmarkReleaseIsolation(
  roots: readonly BenchmarkReleaseAuditRoot[],
): Promise<BenchmarkReleaseAuditResult> {
  let directoryCount = 0;
  let fileCount = 0;
  let jsonFileCount = 0;

  for (const root of roots) {
    const directory = resolve(root.directory);
    const files = await listFiles(directory);
    if (!files.length) continue;
    directoryCount += 1;
    fileCount += files.length;

    for (const path of files) {
      const label = displayPath({ ...root, directory }, path);
      if (isKnownThsRepairPath(path)) {
        throw new Error(`${label} 是同花顺原始、规范化或修复报告文件，禁止进入发布资源`);
      }
      if (!path.toLowerCase().endsWith('.json')) continue;

      jsonFileCount += 1;
      const text = await readFile(path, 'utf8');
      let value: unknown;
      try {
        value = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} JSON 无法解析：${message}`);
      }
      assertJsonDistributionSafe(value, label);
      if (containsThsRepairPayload(text)) {
        throw new Error(`${label} 包含同花顺 FG9999 修复材料，禁止进入发布资源`);
      }
    }
  }

  return {
    directories: directoryCount,
    files: fileCount,
    jsonFiles: jsonFileCount,
  };
}
