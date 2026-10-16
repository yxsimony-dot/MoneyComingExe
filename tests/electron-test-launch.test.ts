import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The shared Electron launcher is an executable ESM JavaScript module.
import { electronTestLaunchOptions, OFFSCREEN_TEST_ARGUMENT, OFFSCREEN_TEST_ENVIRONMENT_VARIABLE } from './electron-test-launch.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));

describe('shared Electron test launcher', () => {
  it('always appends the offscreen argument and geometry-only environment marker', () => {
    const options = electronTestLaunchOptions({
      args: ['.'],
      env: { MONEYCOMING_TEST_MODE: '0' },
    });

    expect(options.args).toEqual(['.', OFFSCREEN_TEST_ARGUMENT]);
    expect(options.env.MONEYCOMING_TEST_MODE).toBe('0');
    expect(options.env[OFFSCREEN_TEST_ENVIRONMENT_VARIABLE]).toBe('1');
  });

  it('preserves an explicit production-like environment without restoring deleted test flags', () => {
    const options = electronTestLaunchOptions({ env: { APPDATA: 'isolated' } });
    expect(options.env).toEqual({
      APPDATA: 'isolated',
      [OFFSCREEN_TEST_ENVIRONMENT_VARIABLE]: '1',
    });
  });

  it('does not duplicate an existing offscreen argument', () => {
    expect(electronTestLaunchOptions({
      args: ['.', OFFSCREEN_TEST_ARGUMENT],
    }).args).toEqual(['.', OFFSCREEN_TEST_ARGUMENT]);
  });

  it('prevents GUI tests from bypassing the shared launcher', async () => {
    const files = (await readdir(testsDirectory))
      .filter(name => name.endsWith('.mjs') && name !== 'electron-test-launch.mjs');
    const violations = [];

    for (const name of files) {
      const source = await readFile(join(testsDirectory, name), 'utf8');
      if (/_electron\s+as\s+electron|electron\.launch\s*\(/.test(source)) violations.push(name);
    }

    expect(violations).toEqual([]);
  });

  it('keeps direct shortcut launches on the same offscreen rule', async () => {
    const source = await readFile(join(testsDirectory, 'shortcut-smoke.ps1'), 'utf8');
    expect(source).toContain("$testArguments = '--test-window-offscreen'");
  });
});
