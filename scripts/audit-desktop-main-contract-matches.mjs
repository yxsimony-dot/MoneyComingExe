import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = resolve(projectRoot, '.tmp', 'desktop-main-contract-audit');
const output = resolve(temporaryDirectory, 'cli.mjs');

await mkdir(temporaryDirectory, { recursive: true });
await build({
  entryPoints: [
    resolve(projectRoot, 'src', 'main', 'desktop-main-contract-audit-cli.ts'),
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
  const auditCli = await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
  await auditCli.runDesktopMainContractAudit(process.argv.slice(2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
