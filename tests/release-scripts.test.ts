import { describe, expect, it } from 'vitest';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { credentialMatches } from '../scripts/verify-credentials.mjs';
// @ts-expect-error Release scripts are executable ESM JavaScript modules.
import { validateTagVersion } from '../scripts/verify-tag-version.mjs';

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
});

