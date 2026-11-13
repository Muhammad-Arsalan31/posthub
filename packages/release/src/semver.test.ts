import { describe, expect, it } from 'vite-plus/test';
import { compareVersions, nextVersion } from './semver';

describe('nextVersion', () => {
  it('bumps by keyword', () => {
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  it('accepts an explicit higher version', () => {
    expect(nextVersion('0.0.0', '0.1.0')).toBe('0.1.0');
  });

  it('rejects versions that are not higher or not semver', () => {
    expect(() => nextVersion('1.2.3', '1.2.3')).toThrow(/higher/);
    expect(() => nextVersion('1.2.3', '1.0.9')).toThrow(/higher/);
    expect(() => nextVersion('1.2.3', 'v2')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => nextVersion('1.2.3', '01.0.0')).toThrow();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
  });
});
