import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacyStoredSessionFilePath,
  supersededStoredSessionDirectory,
  tombstoneStoredCredentialFiles,
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

  describe('the superseded session directory', () => {
    async function writeSuperseded(userDataDirectory: string, fileName: string, value: string): Promise<string> {
      const directory = supersededStoredSessionDirectory(userDataDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, fileName);
      await writeFile(path, Buffer.from(value), { mode: 0o600 });
      return path;
    }

    it('reads a credential and profile an earlier build left in avalon-data', async () => {
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeSuperseded(userDataDirectory, 'desktop-auth.bin', 'superseded-auth');
      await writeSuperseded(userDataDirectory, 'desktop-profile.bin', 'superseded-profile');
      await writeSuperseded(userDataDirectory, 'desktop-session.bin', 'superseded-session');

      expect((await readStoredAuthFile(userDataDirectory)).toString()).toBe('superseded-auth');
      expect((await readStoredProfileFile(userDataDirectory)).toString()).toBe('superseded-profile');
      expect((await readStoredSessionFile(userDataDirectory)).toString()).toBe('superseded-session');
    });

    it('prefers the current directory when both spellings hold a credential', async () => {
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeStoredAuthFile(userDataDirectory, Buffer.from('current-auth'));
      await writeSuperseded(userDataDirectory, 'desktop-auth.bin', 'superseded-auth');

      expect((await readStoredAuthFile(userDataDirectory)).toString()).toBe('current-auth');
    });

    it('erases a credential logout would otherwise leave behind in avalon-data', async () => {
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeStoredAuthFile(userDataDirectory, Buffer.from('current-auth'));
      const supersededAuth = await writeSuperseded(userDataDirectory, 'desktop-auth.bin', 'superseded-auth');
      const supersededProfile = await writeSuperseded(userDataDirectory, 'desktop-profile.bin', 'superseded-profile');
      const supersededSession = await writeSuperseded(userDataDirectory, 'desktop-session.bin', 'superseded-session');

      await removeStoredStateFiles(userDataDirectory);

      for (const path of [supersededAuth, supersededProfile, supersededSession]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(readStoredAuthFile(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('tombstones a superseded copy rather than leaving it readable', async () => {
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeStoredAuthFile(userDataDirectory, Buffer.from('current-auth'));
      const supersededAuth = await writeSuperseded(userDataDirectory, 'desktop-auth.bin', 'superseded-auth');

      await tombstoneStoredCredentialFiles(userDataDirectory, Buffer.from('{}'));

      expect((await readFile(supersededAuth)).toString()).toBe('{}');
    });

    it('does not create a superseded directory on an install that never had one', async () => {
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeStoredAuthFile(userDataDirectory, Buffer.from('current-auth'));

      await tombstoneStoredCredentialFiles(userDataDirectory, Buffer.from('{}'));

      await expect(stat(supersededStoredSessionDirectory(userDataDirectory)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the session when a directory is recovered into itself', async () => {
      // The adoption rename can fail, leaving the launch running out of a
      // superseded directory that is still in the recovery list. Recovering it
      // into itself used to read the session and then delete it as the source.
      const userDataDirectory = await temporaryUserDataDirectory();
      await writeStoredSessionFile(userDataDirectory, Buffer.from('encrypted-session'));

      expect(await migrateLegacyUserDataStoredSessionFile(userDataDirectory, userDataDirectory)).toBe(false);

      expect((await readStoredSessionFile(userDataDirectory)).toString()).toBe('encrypted-session');
    });

    it('recovers a session another userData directory holds under avalon-data', async () => {
      const current = await temporaryUserDataDirectory();
      const superseded = await temporaryUserDataDirectory();
      await writeSuperseded(superseded, 'desktop-session.bin', 'left-behind-session');

      expect(await migrateLegacyUserDataStoredSessionFile(current, superseded)).toBe(true);

      expect((await readStoredSessionFile(current)).toString()).toBe('left-behind-session');
      await expect(readStoredSessionFile(superseded)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
