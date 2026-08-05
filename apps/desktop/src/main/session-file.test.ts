import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacyStoredSessionFilePath,
  migrateLegacyStoredSessionFile,
  readStoredSessionFile,
  removeStoredSessionFiles,
  storedSessionDirectory,
  storedSessionFilePath,
  writeStoredSessionFile,
} from './session-file';

const temporaryDirectories: string[] = [];

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-session-file-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('desktop session file', () => {
  it('stores encrypted sessions in an app-owned userData subdirectory', async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const encrypted = Buffer.from('encrypted-session');

    await writeStoredSessionFile(userDataDirectory, encrypted);

    expect(storedSessionFilePath(userDataDirectory)).toBe(
      join(userDataDirectory, 'avalon-data', 'desktop-session.bin'),
    );
    await expect(readFile(storedSessionFilePath(userDataDirectory))).resolves.toEqual(encrypted);
    expect((await stat(storedSessionDirectory(userDataDirectory))).mode & 0o777).toBe(0o700);
    expect((await stat(storedSessionFilePath(userDataDirectory))).mode & 0o777).toBe(0o600);
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
});
