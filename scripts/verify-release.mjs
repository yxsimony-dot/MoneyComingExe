import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';
import {
  assetName,
  listFiles,
  pathExists,
  readPackageManifest,
  readYamlFile,
  releaseDirectory,
  sha512Base64,
} from './release-utils.mjs';

const REQUIRED_DATA = [
  'edb_main_continuous_5m.csv',
  'edb_main_continuous_60m.csv',
  'summary.json',
  'cross_source_audit.json',
  'entry-rules.md',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function installerProductVersion(path) {
  if (process.platform !== 'win32') return undefined;
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:MONEYCOMING_INSTALLER).VersionInfo.ProductVersion'],
    { encoding: 'utf8', env: { ...process.env, MONEYCOMING_INSTALLER: path }, windowsHide: true },
  ).trim();
  return output || undefined;
}

export async function verifyRelease(directory = releaseDirectory()) {
  const manifest = await readPackageManifest();
  const files = await listFiles(directory);
  assert(files.length > 0, `发布目录不存在或为空：${directory}`);

  const zipFiles = files.filter(path => path.toLowerCase().endsWith('.zip'));
  assert(zipFiles.length === 0, `NSIS 发布目录不得包含 ZIP：${zipFiles.map(path => relative(directory, path)).join(', ')}`);

  const latestPath = join(directory, 'latest.yml');
  assert(await pathExists(latestPath), '发布目录缺少 latest.yml');
  const latest = await readYamlFile(latestPath);
  assert(latest.version === manifest.version, `latest.yml version ${latest.version} 与 package.json ${manifest.version} 不一致`);
  assert(Array.isArray(latest.files) && latest.files.length > 0, 'latest.yml 缺少 files 列表');

  const expectedInstaller = `MoneyComing-Setup-${manifest.version}-x64.exe`;
  const primaryName = assetName(latest.path || latest.files[0]?.url);
  assert(primaryName === expectedInstaller, `安装包命名不符合约定：${primaryName}`);
  const installerPath = join(directory, primaryName);
  assert(await pathExists(installerPath), `latest.yml 引用的安装包不存在：${primaryName}`);

  const metadataFile = latest.files.find(file => assetName(file.url) === primaryName);
  assert(metadataFile && typeof metadataFile.sha512 === 'string', `latest.yml 缺少 ${primaryName} 的 SHA-512`);
  const actualSha512 = await sha512Base64(installerPath);
  assert(actualSha512 === metadataFile.sha512, `${primaryName} SHA-512 与 latest.yml 不一致`);
  if (typeof latest.sha512 === 'string') {
    assert(actualSha512 === latest.sha512, 'latest.yml 顶层 SHA-512 与安装包不一致');
  }
  if (typeof metadataFile.size === 'number') {
    assert((await stat(installerPath)).size === metadataFile.size, `${primaryName} 文件大小与 latest.yml 不一致`);
  }

  const blockmapPath = `${installerPath}.blockmap`;
  assert(await pathExists(blockmapPath), `发布目录缺少 ${primaryName}.blockmap`);
  assert((await stat(blockmapPath)).size > 0, `${primaryName}.blockmap 为空`);

  const unpacked = join(directory, 'win-unpacked');
  const asarPath = join(unpacked, 'resources', 'app.asar');
  assert(await pathExists(asarPath), '缺少 win-unpacked/resources/app.asar，无法验收打包版本');
  const packagedManifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  assert(packagedManifest.version === manifest.version, `app.asar version ${packagedManifest.version} 与 package.json 不一致`);

  const appUpdatePath = join(unpacked, 'resources', 'app-update.yml');
  assert(await pathExists(appUpdatePath), '打包应用缺少 app-update.yml');
  const appUpdate = await readYamlFile(appUpdatePath);
  assert(appUpdate.provider === 'github', `app-update.yml provider 必须为 github，收到 ${appUpdate.provider}`);
  assert(appUpdate.owner === 'yxsimony-dot' && appUpdate.repo === 'MoneyComingExe', 'app-update.yml GitHub owner/repo 配置不正确');

  for (const name of REQUIRED_DATA) {
    const path = join(unpacked, 'data', name);
    assert(await pathExists(path), `安装包展开目录缺少 data/${name}`);
    assert((await stat(path)).size > 0, `data/${name} 为空`);
  }

  const productVersion = installerProductVersion(installerPath);
  if (productVersion) {
    assert(productVersion === manifest.version || productVersion.startsWith(`${manifest.version}.`), `安装包 ProductVersion ${productVersion} 与 ${manifest.version} 不一致`);
  }

  const result = {
    valid: true,
    version: manifest.version,
    installer: primaryName,
    installerProductVersion: productVersion,
    sha512: actualSha512,
    blockmap: `${primaryName}.blockmap`,
    requiredData: REQUIRED_DATA,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyRelease().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

