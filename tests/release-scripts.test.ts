import { readFile, readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { prepareRelease } from '../scripts/prepare-release.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { credentialMatches } from '../scripts/verify-credentials.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { validateTagVersion } from '../scripts/verify-tag-version.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { REQUIRED_DATA, validatePackagedData } from '../scripts/verify-release.mjs';

describe('release validation scripts', () => {
  it('accepts only a stable v<semver> tag matching package.json', () => {
    expect(validateTagVersion('v1.2.3', '1.2.3')).toBe('1.2.3');
    expect(() => validateTagVersion('v1.2.4', '1.2.3')).toThrow(/不一致/);
    expect(() => validateTagVersion('release-1.2.3', '1.2.3')).toThrow(/v<semver>/);
    expect(() => validateTagVersion('v1.2.3-beta.1', '1.2.3-beta.1')).toThrow(/稳定语义化版本/);
  });

  it('detects real-shape GitHub credentials without flagging short test placeholders', () => {
    expect(credentialMatches(Buffer.from('ghp_abcdefghijklmnop'))).toEqual([]);
    expect(credentialMatches(Buffer.from(`ghp_${'a'.repeat(36)}`))).toEqual(['ghp_aaaaaaaa']);
    expect(credentialMatches(Buffer.from('artifact-secret'), ['artifact-secret'])).toEqual(['环境凭据值']);
  });

  it('packages exactly the required market-data baselines without copying release history', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const marketData = manifest.build.extraFiles.find(
      (entry: { from?: string }) => entry.from === 'futures_investigation_20261009',
    );
    expect(marketData?.filter).toEqual([
      'edb_*_1m_raw.csv',
      'edb_*_5m.csv',
      'edb_*_60m.csv',
      'edb_*_rollovers.csv',
      'summary.json',
      'cross_source_audit.json',
    ]);
    expect(manifest.build.files).toEqual(['build/**/*', 'dist/**/*', 'package.json']);
    expect(JSON.stringify(manifest.build)).not.toContain('release/**/*');
  });

  it('cleans old installers and the previous unpacked directory before packaging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-release-'));
    try {
      await mkdir(join(directory, 'win-unpacked'));
      await writeFile(join(directory, 'win-unpacked', 'old.exe'), 'old');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe'), 'old');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe.blockmap'), 'old');
      await writeFile(join(directory, 'latest.yml'), 'old');
      await writeFile(join(directory, 'builder-debug.yml'), 'old');
      await writeFile(join(directory, 'keep.txt'), 'keep');

      expect(await prepareRelease(directory)).toHaveLength(5);
      expect(await readdir(directory)).toEqual(['keep.txt']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses every data resource required in the packaged application', async () => {
    expect(REQUIRED_DATA).toEqual([
      'edb_main_continuous_1m_raw.csv',
      'edb_main_continuous_5m.csv',
      'edb_main_continuous_60m.csv',
      'edb_main_continuous_rollovers.csv',
      'summary.json',
      'cross_source_audit.json',
      'entry-rules.md',
    ]);
    for (const name of REQUIRED_DATA) {
      const text = await readFile(join('futures_investigation_20261009', name), 'utf8');
      expect(() => validatePackagedData(name, text)).not.toThrow();
    }
  });

  it('rejects malformed packaged resources instead of accepting non-empty files', () => {
    expect(() => validatePackagedData('edb_main_continuous_1m_raw.csv', 'not,csv\n1,2\n')).toThrow(/缺少列/);
    expect(() => validatePackagedData('edb_main_continuous_5m.csv', 'not,csv\n1,2\n')).toThrow(/缺少列/);
    expect(() => validatePackagedData('edb_main_continuous_rollovers.csv', 'not,csv\n1,2\n')).toThrow(/缺少列/);
    expect(() => validatePackagedData('summary.json', '{')).toThrow(/无法解析/);
    expect(() => validatePackagedData('entry-rules.md', '# 空规则')).toThrow(/规则标题/);
  });
});
