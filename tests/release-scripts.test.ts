import { readFile, readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUMENT, INSTRUMENT_LIST } from '../src/shared/instruments';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { prepareRelease } from '../scripts/prepare-release.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { credentialMatches } from '../scripts/verify-credentials.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { validateTagVersion } from '../scripts/verify-tag-version.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import * as verifyRelease from '../scripts/verify-release.mjs';

const {
  PACKAGED_USAGE_GUIDE,
  REQUIRED_DATA,
  REQUIRED_INSTRUMENT_FILES,
  validatePackagedData,
  validatePackagedDataDirectory,
  validateUsageGuide,
} = verifyRelease;

describe('release validation scripts', () => {
  it('accepts only a stable v<semver> tag matching package.json', () => {
    expect(validateTagVersion('v1.2.3', '1.2.3')).toBe('1.2.3');
    expect(() => validateTagVersion('v1.2.4', '1.2.3')).toThrow();
    expect(() => validateTagVersion('release-1.2.3', '1.2.3')).toThrow(/v<semver>/);
    expect(() => validateTagVersion('v1.2.3-beta.1', '1.2.3-beta.1')).toThrow();
  });

  it('detects real-shape GitHub credentials without flagging short test placeholders', () => {
    expect(credentialMatches(Buffer.from('ghp_abcdefghijklmnop'))).toEqual([]);
    expect(credentialMatches(Buffer.from(`ghp_${'a'.repeat(36)}`))).toEqual(['ghp_aaaaaaaa']);
    expect(credentialMatches(Buffer.from('artifact-secret'), ['artifact-secret'])).toHaveLength(1);
  });

  it('packages exactly the required market-data baselines without copying release history', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const marketData = manifest.build.extraFiles.find(
      (entry: { from?: string }) => entry.from === 'data',
    );
    expect(marketData?.filter).toEqual([
      'instruments/**/*',
      'baseline-report.json',
      'baseline-validation-report.json',
    ]);
    expect(manifest.build.extraFiles).toContainEqual({
      from: 'futures_investigation_20261009/entry-rules.md',
      to: 'data/entry-rules.md',
    });
    expect(manifest.build.extraFiles).toContainEqual({
      from: `docs/${PACKAGED_USAGE_GUIDE}`,
      to: PACKAGED_USAGE_GUIDE,
    });
    expect(manifest.build.files).toEqual(['build/**/*', 'dist/**/*', 'package.json']);
    expect(JSON.stringify(manifest.build)).not.toContain('release/**/*');
  });

  it('validates the packaged usage and entry-rule documentation contracts', async () => {
    const usageGuide = await readFile(join('docs', PACKAGED_USAGE_GUIDE), 'utf8');
    const entryRules = await readFile('futures_investigation_20261009/entry-rules.md', 'utf8');
    expect(() => validateUsageGuide(usageGuide)).not.toThrow();
    expect(() => validatePackagedData('entry-rules.md', entryRules)).not.toThrow();
    expect(() => validateUsageGuide('# 旧版豆粕说明')).toThrow(/标题未更新/);
    expect(() => validatePackagedData(
      'entry-rules.md',
      '# 每周突破回调入场规则\n后台1分钟数据\n第一处实际出场',
    )).toThrow(/十五个主连品种/);
  });

  it('cleans old installers and unpacked directories before packaging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-release-'));
    try {
      await mkdir(join(directory, 'win-unpacked'));
      await mkdir(join(directory, 'win-unpacked.tmp'));
      await writeFile(join(directory, 'win-unpacked', 'old.exe'), 'old');
      await writeFile(join(directory, 'win-unpacked.tmp', 'partial.exe'), 'partial');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe'), 'old');
      await writeFile(join(directory, 'MoneyComing-Setup-1.0.5-x64.exe.blockmap'), 'old');
      await writeFile(join(directory, 'latest.yml'), 'old');
      await writeFile(join(directory, 'builder-debug.yml'), 'old');
      await writeFile(join(directory, 'keep.txt'), 'keep');

      expect(await prepareRelease(directory)).toHaveLength(6);
      expect(await readdir(directory)).toEqual(['keep.txt']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('validates every registered instrument resource in the packaged data tree', async () => {
    expect(REQUIRED_DATA).toHaveLength(
      3 + INSTRUMENT_LIST.length * REQUIRED_INSTRUMENT_FILES.length,
    );
    for (const definition of INSTRUMENT_LIST) {
      for (const name of REQUIRED_INSTRUMENT_FILES) {
        expect(REQUIRED_DATA).toContain(`instruments/${definition.id}/${name}`);
      }
    }
    await expect(validatePackagedDataDirectory('data', {
      entryRulesPath: 'futures_investigation_20261009/entry-rules.md',
    })).resolves.toMatchObject({ valid: true, instrumentCount: 15 });
  }, 120_000);

  it('rejects a packaged data tree that is missing one registered instrument', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moneycoming-packaged-data-'));
    try {
      const instrumentsDirectory = join(directory, 'instruments');
      await mkdir(instrumentsDirectory, { recursive: true });
      for (const definition of INSTRUMENT_LIST) {
        if (definition.id !== 'soda_ash_main') {
          await mkdir(join(instrumentsDirectory, definition.id));
        }
      }
      await expect(validatePackagedDataDirectory(directory)).rejects.toThrow(
        /soda_ash_main|纯碱主连/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed packaged resources instead of accepting non-empty files', () => {
    expect(() => validatePackagedData(
      'edb_main_continuous_1m_raw.csv',
      'not,csv\n1,2\n',
    )).toThrow();
    expect(() => validatePackagedData(
      'edb_main_continuous_5m.csv',
      'not,csv\n1,2\n',
    )).toThrow();
    expect(() => validatePackagedData(
      'edb_main_continuous_rollovers.csv',
      'not,csv\n1,2\n',
      DEFAULT_INSTRUMENT,
    )).toThrow();
    expect(() => validatePackagedData('baseline-report.json', '{')).toThrow();
    expect(() => validatePackagedData('entry-rules.md', '# 空规则')).toThrow();
  });
});
