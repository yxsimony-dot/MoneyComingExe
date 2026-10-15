import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, pathExists, readOption, releaseDirectory } from './release-utils.mjs';

const SOURCE_ROOTS = ['.github', 'docs', 'scripts', 'src', 'tests'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'README.md'];
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
];
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico']);

export function credentialMatches(buffer, sensitiveValues = []) {
  const text = buffer.toString('latin1');
  const matches = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) matches.push(match[0].slice(0, 12));
  }
  for (const value of sensitiveValues) {
    if (value.length >= 12 && buffer.includes(Buffer.from(value))) matches.push('环境凭据值');
  }
  return [...new Set(matches)];
}

async function sourceCandidates(root) {
  const files = [];
  for (const directory of SOURCE_ROOTS) {
    files.push(...await listFiles(join(root, directory)));
  }
  for (const name of SOURCE_FILES) {
    const path = join(root, name);
    if (await pathExists(path)) files.push(path);
  }
  return files;
}

export async function verifyCredentials() {
  const root = process.cwd();
  const artifactDirectory = resolve(readOption('dir', releaseDirectory()));
  const requireArtifacts = process.argv.includes('--require-artifacts');
  if (requireArtifacts && !await pathExists(artifactDirectory)) {
    throw new Error(`凭据扫描要求发布产物，但目录不存在：${artifactDirectory}`);
  }

  const sourceFiles = await sourceCandidates(root);
  const artifactFiles = await listFiles(artifactDirectory);
  const files = [...new Set([...sourceFiles, ...artifactFiles])]
    .filter(path => !SKIP_EXTENSIONS.has(extname(path).toLowerCase()));
  const sensitiveValues = ['GITHUB_TOKEN', 'GH_TOKEN']
    .map(name => process.env[name])
    .filter(value => typeof value === 'string' && value.length >= 12);
  const findings = [];

  for (const path of files) {
    const matches = credentialMatches(await readFile(path), sensitiveValues);
    if (matches.length) {
      findings.push({
        file: path.startsWith(root) ? relative(root, path) : basename(path),
        matches,
      });
    }
  }

  if (findings.length) {
    throw new Error(`检测到疑似 GitHub 凭据：${JSON.stringify(findings)}`);
  }
  console.log(JSON.stringify({
    valid: true,
    sourceFiles: sourceFiles.length,
    artifactFiles: artifactFiles.length,
    scannedFiles: files.length,
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyCredentials().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

