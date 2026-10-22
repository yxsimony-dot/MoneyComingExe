import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = resolve(projectRoot, '.tmp', 'desktop-temporary-candidates');
const output = resolve(temporaryDirectory, 'cli.mjs');

await mkdir(temporaryDirectory, { recursive: true });
await build({
  entryPoints: [
    resolve(projectRoot, 'src', 'main', 'desktop-temporary-candidate-cli.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: output,
  logLevel: 'silent',
});

try {
  const candidateCli = await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
  await candidateCli.runDesktopTemporaryCandidateCli(process.argv.slice(2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
