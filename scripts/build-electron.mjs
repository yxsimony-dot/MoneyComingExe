import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('build', { recursive: true });
await Promise.all(['main/main','preload/preload'].map(async entry => {
  await build({
    entryPoints: [`src/${entry}.ts`],
    outfile: `build/${entry.split('/').at(-1)}.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'electron-updater'],
    sourcemap: false,
  });
}));
