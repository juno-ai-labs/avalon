import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalUserDataDirectory,
  supersededUserDataDirectories,
  userDataDirectoryForLaunch,
  type UserDataDirectoryOperations,
} from './user-data-path';

const appData = '/Users/member/Library/Application Support';

function operations(present: readonly string[]): UserDataDirectoryOperations & {
  renames: [string, string][];
} {
  const existing = new Set(present);
  const renames: [string, string][] = [];
  return {
    renames,
    exists: (path) => existing.has(path),
    rename: (from, to) => {
      renames.push([from, to]);
      existing.delete(from);
      existing.add(to);
    },
  };
}

describe('desktop user-data paths', () => {
  it('pins packaged credentials to the Rally namespace', () => {
    expect(canonicalUserDataDirectory(appData, true)).toBe(join(appData, 'Rally'));
  });

  it('keeps development isolated and names every superseded directory', () => {
    expect(canonicalUserDataDirectory(appData, false)).toBe(join(appData, 'Rally Development'));
    expect(supersededUserDataDirectories(appData, true)).toEqual([
      join(appData, 'Avalon'),
      join(appData, '@avalon', 'desktop'),
    ]);
    // The package-name directory was only ever written by a packaged build.
    expect(supersededUserDataDirectories(appData, false)).toEqual([
      join(appData, 'Avalon Development'),
    ]);
  });

  it('preserves an explicit user-data path for isolated packaged launches', () => {
    const isolated = operations([join(appData, 'Avalon')]);
    expect(userDataDirectoryForLaunch(appData, true, '/private/tmp/rally-smoke', isolated)).toBe(
      '/private/tmp/rally-smoke',
    );
    // An isolated launch must never adopt the installed profile's data.
    expect(isolated.renames).toEqual([]);
  });

  it('adopts the Avalon directory on the first launch after the rename', () => {
    const fs = operations([join(appData, 'Avalon')]);
    expect(userDataDirectoryForLaunch(appData, true, '', fs)).toBe(join(appData, 'Rally'));
    expect(fs.renames).toEqual([[join(appData, 'Avalon'), join(appData, 'Rally')]]);
  });

  it('adopts the package-name directory when no Avalon directory was written', () => {
    const fs = operations([join(appData, '@avalon', 'desktop')]);
    expect(userDataDirectoryForLaunch(appData, true, '', fs)).toBe(join(appData, 'Rally'));
    expect(fs.renames).toEqual([[join(appData, '@avalon', 'desktop'), join(appData, 'Rally')]]);
  });

  it('leaves an existing Rally directory alone rather than overwriting it', () => {
    const fs = operations([join(appData, 'Rally'), join(appData, 'Avalon')]);
    expect(userDataDirectoryForLaunch(appData, true, '', fs)).toBe(join(appData, 'Rally'));
    expect(fs.renames).toEqual([]);
  });

  it('is a no-op on a launch with nothing to adopt', () => {
    const fs = operations([]);
    expect(userDataDirectoryForLaunch(appData, true, '', fs)).toBe(join(appData, 'Rally'));
    expect(fs.renames).toEqual([]);
  });

  it('keeps reading the superseded directory when the rename fails', () => {
    const fs = operations([join(appData, 'Avalon')]);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    });
    // Signing someone out because a directory was busy is worse than running
    // from the old path and retrying on the next launch.
    expect(userDataDirectoryForLaunch(appData, true, '', fs)).toBe(join(appData, 'Avalon'));
    expect(rename).toHaveBeenCalledOnce();
  });

  it('resolves the canonical directory when no file-system access is available', () => {
    expect(userDataDirectoryForLaunch(appData, true, '')).toBe(join(appData, 'Rally'));
  });
});
