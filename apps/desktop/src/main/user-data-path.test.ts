// @vitest-environment node
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalUserDataDirectory,
  legacyPackagedUserDataDirectory,
} from './user-data-path';

describe('desktop user-data paths', () => {
  it('pins packaged credentials to the Avalon namespace', () => {
    expect(canonicalUserDataDirectory('/Users/member/Library/Application Support', true)).toBe(
      join('/Users/member/Library/Application Support', 'Avalon'),
    );
  });

  it('keeps development isolated and identifies the early package-name path', () => {
    const appData = '/Users/member/Library/Application Support';
    expect(canonicalUserDataDirectory(appData, false)).toBe(join(appData, 'Avalon Development'));
    expect(legacyPackagedUserDataDirectory(appData)).toBe(join(appData, '@avalon', 'desktop'));
  });
});
