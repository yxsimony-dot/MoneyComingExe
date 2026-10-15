import { parse } from 'yaml';
import { pathToFileURL } from 'node:url';
import { assetName, readOption, readPackageManifest } from './release-utils.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function anonymousFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MoneyComing-release-verifier',
      ...(init.headers || {}),
    },
  });
}

async function fetchWithRetry(url, init) {
  let response;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    response = await anonymousFetch(url, init);
    if (response.ok) return response;
    if (attempt < 6 && [404, 429, 502, 503, 504].includes(response.status)) await wait(attempt * 3000);
    else break;
  }
  throw new Error(`匿名请求失败 ${response?.status ?? 'unknown'}：${url}`);
}

export async function verifyPublicRelease() {
  const manifest = await readPackageManifest();
  const owner = readOption('owner', 'yxsimony-dot');
  const repo = readOption('repo', 'MoneyComingExe');
  const tag = readOption('tag', process.env.GITHUB_REF_NAME || `v${manifest.version}`);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`;
  const release = await (await fetchWithRetry(apiUrl)).json();
  if (release.draft || release.prerelease) throw new Error(`${tag} 不是公开稳定 Release`);

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const names = assets.map(asset => asset.name);
  if (names.some(name => name.toLowerCase().endsWith('.zip'))) throw new Error('公开 Release 不得包含 ZIP');
  const latestAsset = assets.find(asset => asset.name === 'latest.yml');
  if (!latestAsset) throw new Error('公开 Release 缺少 latest.yml');

  const latestResponse = await fetchWithRetry(latestAsset.browser_download_url, { headers: { Accept: 'application/octet-stream' } });
  const latest = parse(await latestResponse.text());
  if (latest.version !== manifest.version) throw new Error(`公开 latest.yml version ${latest.version} 与 ${manifest.version} 不一致`);
  const installerName = assetName(latest.path || latest.files?.[0]?.url);
  const installer = assets.find(asset => asset.name === installerName);
  if (!installer) throw new Error(`公开 Release 缺少 ${installerName}`);
  if (!assets.some(asset => asset.name === `${installerName}.blockmap`)) throw new Error(`公开 Release 缺少 ${installerName}.blockmap`);

  const installerResponse = await fetchWithRetry(installer.browser_download_url, {
    headers: { Accept: 'application/octet-stream', Range: 'bytes=0-0' },
  });
  const reader = installerResponse.body?.getReader();
  if (reader) {
    await reader.read();
    await reader.cancel();
  }

  console.log(JSON.stringify({
    valid: true,
    tag,
    release: release.html_url,
    assets: ['latest.yml', installerName, `${installerName}.blockmap`],
    anonymous: true,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyPublicRelease().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

