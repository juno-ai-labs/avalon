import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacyStoredSessionFilePath,
  migrateLegacyUserDataStoredSessionFile,
  migrateLegacyStoredSessionFile,
  readStoredAuthFile,
  readStoredProfileFile,
  readStoredSessionFile,
  removeStoredCredentialFiles,
  removeStoredStateFiles,
  removeStoredSessionFiles,
  storedAuthFilePath,
  storedProfileFilePath,
  storedSessionDirectory,
  storedSessionFilePath,
  tombstoneStoredStateFiles,
  writeStoredAuthFile,
  writeStoredProfileFile,
  writeStoredSessionFile,
} from './session-file';

const temporaryDirectories: string[] = [];

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rally-session-file-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('desktop session file', () => {
  it('stores credentials and the disposable profile in independent encrypted files', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();

    await writeStoredAuthFile(userDataDirectory, Buffer.from('encrypted-auth'));
    await writeStoredProfileFile(userDataDirectory, Buffer.from('encrypted-profile'));

    expect(storedAuthFilePath(userDataDirectory)).toBe(
      join(userDataDirectory, 'rally-data', 'desktop-auth.bin'),
    );
    expect(storedProfileFilePath(userDataDirectory)).toBe(
      join(userDataDirectory, 'rally-data', 'desktop-profile.bin'),
    );
    await expect(readStoredAuthFile(userDataDirectory)).resolves.toEqual(Buffer.from('encrypted-auth'));
    await expect(readStoredProfileFile(userDataDirectory)).resolves.toEqual(Buffer.from('encrypted-profile'));
  });

  it('stores encrypted sessions in an app-owned userData subdirectory', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const encrypted = Buffer.from('encrypted-session');

    await writeStoredSessionFile(userDataDirectory, encrypted);

    expect(storedSessionFilePath(userDataDirectory)).toBe(
      join(userDataDirectory, 'rally-data', 'desktop-session.bin'),
    );
    await expect(readFile(storedSessionFilePath(userDataDirectory))).resolves.toEqual(encrypted);
    expect((await stat(storedSessionDirectory(userDataDirectory))).mode & 0o777).toBe(0o700);
    expect((await stat(storedSessionFilePath(userDataDirectory))).mode & 0o777).toBe(0o600);
  });

  it('atomically replaces an existing encrypted session', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeStoredSessionFile(userDataDirectory, Buffer.from('first-session'));

    await writeStoredSessionFile(userDataDirectory, Buffer.from('second-session'));

    await expect(readStoredSessionFile(userDataDirectory)).resolves.toEqual(Buffer.from('second-session'));
    await expect(readFile(join(storedSessionDirectory(userDataDirectory), 'desktop-session.tmp')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrates the legacy userData-root session without signing the user out', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const encrypted = Buffer.from('legacy-encrypted-session');
    await writeFile(legacyStoredSessionFilePath(userDataDirectory), encrypted, { mode: 0o600 });

    await expect(migrateLegacyStoredSessionFile(userDataDirectory)).resolves.toBe(true);
    await expect(migrateLegacyStoredSessionFile(userDataDirectory)).resolves.toBe(false);
    await expect(readStoredSessionFile(userDataDirectory)).resolves.toEqual(encrypted);
    await expect(readFile(storedSessionFilePath(userDataDirectory))).resolves.toEqual(encrypted);
    await expect(readFile(legacyStoredSessionFilePath(userDataDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes both current and legacy files on logout', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeStoredSessionFile(userDataDirectory, Buffer.from('current'));
    await writeFile(legacyStoredSessionFilePath(userDataDirectory), Buffer.from('legacy'), { mode: 0o600 });

    await removeStoredSessionFiles(userDataDirectory);

    await expect(readFile(storedSessionFilePath(userDataDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(legacyStoredSessionFilePath(userDataDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes split auth, profile cache, and every legacy session on logout', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeStoredAuthFile(userDataDirectory, Buffer.from('auth'));
    await writeStoredProfileFile(userDataDirectory, Buffer.from('profile'));
    await writeStoredSessionFile(userDataDirectory, Buffer.from('session'));
    await writeFile(legacyStoredSessionFilePath(userDataDirectory), Buffer.from('legacy'), { mode: 0o600 });

    await removeStoredStateFiles(userDataDirectory);

    await expect(readStoredAuthFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readStoredProfileFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readStoredSessionFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only credential-bearing files when a Lockdown transition requires re-login', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeStoredAuthFile(userDataDirectory, Buffer.from('auth'));
    await writeStoredProfileFile(userDataDirectory, Buffer.from('profile'));
    await writeStoredSessionFile(userDataDirectory, Buffer.from('session'));
    await writeFile(legacyStoredSessionFilePath(userDataDirectory), Buffer.from('legacy'), { mode: 0o600 });

    await removeStoredCredentialFiles(userDataDirectory);

    await expect(readStoredAuthFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readStoredSessionFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readStoredProfileFile(userDataDirectory)).resolves.toEqual(Buffer.from('profile'));
  });

  it('can invalidate every credential location when deletion is blocked', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const tombstone = Buffer.from('encrypted-invalid-value');

    await tombstoneStoredStateFiles(userDataDirectory, tombstone);

    await expect(readStoredAuthFile(userDataDirectory)).resolves.toEqual(tombstone);
    await expect(readStoredProfileFile(userDataDirectory)).resolves.toEqual(tombstone);
    await expect(readFile(storedSessionFilePath(userDataDirectory))).resolves.toEqual(tombstone);
    await expect(readFile(legacyStoredSessionFilePath(userDataDirectory))).resolves.toEqual(tombstone);
  });

  it('migrates the early package-name userData namespace', async () => {
    const canonicalDirectory = await temporaryUserDataDirectory();
    const legacyDirectory = await temporaryUserDataDirectory();
    const encrypted = Buffer.from('package-name-session');
    await writeStoredSessionFile(legacyDirectory, encrypted);

    await expect(
      migrateLegacyUserDataStoredSessionFile(canonicalDirectory, legacyDirectory),
    ).resolves.toBe(true);
    await expect(readStoredSessionFile(canonicalDirectory)).resolves.toEqual(encrypted);
    await expect(readStoredSessionFile(legacyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      migrateLegacyUserDataStoredSessionFile(canonicalDirectory, legacyDirectory),
    ).resolves.toBe(false);
  });

  it('removes a stale package-name credential when the canonical copy already exists', async () => {
    const canonicalDirectory = await temporaryUserDataDirectory();
    const legacyDirectory = await temporaryUserDataDirectory();
    await writeStoredSessionFile(canonicalDirectory, Buffer.from('canonical-session'));
    await writeStoredSessionFile(legacyDirectory, Buffer.from('stale-session'));

    await expect(
      migrateLegacyUserDataStoredSessionFile(canonicalDirectory, legacyDirectory),
    ).resolves.toBe(false);

    await expect(readStoredSessionFile(canonicalDirectory)).resolves.toEqual(Buffer.from('canonical-session'));
    await expect(readStoredSessionFile(legacyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
