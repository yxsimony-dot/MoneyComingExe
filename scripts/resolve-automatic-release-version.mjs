import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { gt, parse, prerelease, valid } from 'semver';
import { readOption, readPackageManifest } from './release-utils.mjs';

function stableVersion(value, label) {
  if (valid(value) !== value || prerelease(value) !== null) {
    throw new Error(`${label} must be a stable semantic version: ${value || '(empty)'}`);
  }
  return parse(value);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer: ${value || '(empty)'}`);
  }
  return parsed;
}

export function resolveAutomaticReleaseVersion({
  packageVersion,
  latestTag,
  runNumber,
  baseRunNumber,
}) {
  const manifestVersion = stableVersion(packageVersion, 'package version');
  const currentRun = positiveInteger(runNumber, 'run number');
  const firstAutomaticRun = positiveInteger(baseRunNumber, 'base run number');
  if (currentRun < firstAutomaticRun) {
    throw new Error(`run number ${currentRun} predates automatic release base ${firstAutomaticRun}`);
  }

  const patch = manifestVersion.patch + currentRun - firstAutomaticRun;
  if (!Number.isSafeInteger(patch)) throw new Error('automatic release patch exceeds safe integer range');
  const version = `${manifestVersion.major}.${manifestVersion.minor}.${patch}`;

  if (latestTag) {
    if (!latestTag.startsWith('v')) {
      throw new Error(`latest release tag must use v<semver>: ${latestTag}`);
    }
    const latestVersion = latestTag.slice(1);
    stableVersion(latestVersion, 'latest release version');
    if (!gt(version, latestVersion)) {
      throw new Error(
        `automatic version ${version} is not newer than ${latestVersion}; `
        + 'a newer workflow run already published this commit range',
      );
    }
  }

  return { version, tag: `v${version}` };
}

export async function main() {
  const manifest = await readPackageManifest();
  const result = resolveAutomaticReleaseVersion({
    packageVersion: manifest.version,
    latestTag: readOption('latest-tag', process.env.LATEST_RELEASE_TAG || ''),
    runNumber: readOption('run-number', process.env.GITHUB_RUN_NUMBER),
    baseRunNumber: readOption('base-run-number'),
  });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\n`,
      'utf8',
    );
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
