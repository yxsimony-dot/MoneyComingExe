import { pathToFileURL } from 'node:url';
import { valid, prerelease } from 'semver';
import { readOption, readPackageManifest } from './release-utils.mjs';

export function validateTagVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`正式发布标签必须使用 v<semver>，收到：${tag || '(空)'}`);
  }
  const tagVersion = tag.slice(1);
  if (valid(tagVersion) !== tagVersion || prerelease(tagVersion) !== null) {
    throw new Error(`正式发布标签必须是稳定语义化版本，收到：${tag}`);
  }
  if (valid(packageVersion) !== packageVersion) {
    throw new Error(`package.json version 不是有效语义化版本：${packageVersion}`);
  }
  if (tagVersion !== packageVersion) {
    throw new Error(`标签 ${tag} 与 package.json version ${packageVersion} 不一致`);
  }
  return tagVersion;
}

export async function main() {
  const manifest = await readPackageManifest();
  const tag = readOption('tag', process.env.GITHUB_REF_NAME);
  const version = validateTagVersion(tag, manifest.version);
  console.log(JSON.stringify({ valid: true, tag, version }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

