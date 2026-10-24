import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditBenchmarkReleaseIsolation } from '../src/main/benchmark-release-audit.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'release');

export const removableReleaseFile = name =>
  name === 'builder-debug.yml' ||
  name === 'latest.yml' ||
  /^MoneyComing-Setup-.*-x64\.exe(?:\.blockmap)?$/.test(name);

export const removableReleaseDirectory = name =>
  name === 'win-unpacked' || name === 'win-unpacked.tmp';

function checkedChild(directory, name) {
  const target = resolve(directory, name);
  if (dirname(target) !== directory) {
    throw new Error(`Refusing to remove release entry outside target directory: ${target}`);
  }
  return target;
}

export async function prepareRelease(directory = releaseDirectory, options = {}) {
  const targetDirectory = resolve(directory);
  const projectRoot = resolve(options.projectRoot ?? root);
  let entries = [];
  try {
    entries = await readdir(targetDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const oldArtifacts = entries.filter(entry =>
    (entry.isFile() && removableReleaseFile(entry.name))
    || (entry.isDirectory() && removableReleaseDirectory(entry.name)),
  );
  for (const entry of oldArtifacts) {
    const target = checkedChild(targetDirectory, entry.name);
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await rm(target, { recursive: entry.isDirectory(), force: true });
        break;
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
      }
    }
  }

  await auditBenchmarkReleaseIsolation([
    { directory: join(projectRoot, 'data'), label: 'data' },
    { directory: join(projectRoot, 'build'), label: 'build' },
    { directory: join(projectRoot, 'dist'), label: 'dist' },
    { directory: targetDirectory, label: '发布暂存目录' },
  ]);

  console.log(`Prepared release directory: removed ${oldArtifacts.length} old artifact(s).`);
  return oldArtifacts.map(entry => entry.name);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (dirname(releaseDirectory) !== root) {
    throw new Error(`Refusing to clean release directory outside project root: ${releaseDirectory}`);
  }
  await prepareRelease();
}
