import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'release');

export const removableReleaseFile = name =>
  name === 'builder-debug.yml' ||
  name === 'latest.yml' ||
  /^MoneyComing-Setup-.*-x64\.exe(?:\.blockmap)?$/.test(name);

export const removableReleaseDirectory = name => name === 'win-unpacked';

function checkedChild(directory, name) {
  const target = resolve(directory, name);
  if (dirname(target) !== directory) {
    throw new Error(`Refusing to remove release entry outside target directory: ${target}`);
  }
  return target;
}

export async function prepareRelease(directory = releaseDirectory) {
  const targetDirectory = resolve(directory);
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
  await Promise.all(oldArtifacts.map(entry =>
    rm(checkedChild(targetDirectory, entry.name), { recursive: entry.isDirectory(), force: true }),
  ));

  console.log(`Prepared release directory: removed ${oldArtifacts.length} old artifact(s).`);
  return oldArtifacts.map(entry => entry.name);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (dirname(releaseDirectory) !== root) {
    throw new Error(`Refusing to clean release directory outside project root: ${releaseDirectory}`);
  }
  await prepareRelease();
}
