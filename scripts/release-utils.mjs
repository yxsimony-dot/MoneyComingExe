import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';

export function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function readPackageManifest(root = process.cwd()) {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(directory) {
  const result = [];
  if (!await pathExists(directory)) return result;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function readYamlFile(path) {
  const value = parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${basename(path)} 不是有效的 YAML 对象`);
  }
  return value;
}

export async function sha512Base64(path) {
  const hash = createHash('sha512');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', reject);
  });
  return hash.digest('base64');
}

export function releaseDirectory() {
  return resolve(readOption('dir', process.env.MONEYCOMING_RELEASE_DIR || 'release'));
}

export function assetName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('更新元数据缺少资源文件名');
  const normalized = value.replaceAll('\\', '/');
  const name = basename(normalized);
  if (name !== normalized || name === '.' || name === '..') {
    throw new Error(`更新资源必须是发布目录中的文件名：${value}`);
  }
  return name;
}

