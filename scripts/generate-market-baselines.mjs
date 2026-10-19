import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const output = join(tmpdir(), `moneycoming-baseline-generator-${process.pid}.mjs`);

try {
  await build({
    entryPoints: ['src/main/generate-market-baselines-cli.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
  });
  await import(pathToFileURL(output).href);
} finally {
  await rm(output, { force: true });
}
