import { describe, expect, it } from 'vitest';
import { formatVersion, isNewerVersion, normalizeVersion } from '../src/shared/version';

describe('application version helpers', () => {
  it('normalizes and displays semantic versions', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(formatVersion('1.2.3')).toBe('v1.2.3');
    expect(normalizeVersion('not-a-version')).toBe('0.0.0');
  });

  it('only accepts a strictly newer semantic version', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
    expect(isNewerVersion('invalid', '1.0.0')).toBe(false);
  });
});
