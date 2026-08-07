import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationSettingsFilePath,
  parseStoredApplicationSettings,
  readStoredApplicationSettings,
  writeStoredApplicationSettings,
} from './application-settings';

const temporaryDirectories: string[] = [];

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-application-settings-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe('desktop application settings', () => {
  it('defaults Lockdown mode to off for missing or invalid preferences', () => {
    expect(parseStoredApplicationSettings(undefined)).toEqual({ lockdownMode: false });
    expect(parseStoredApplicationSettings({ version: 2, lockdownMode: true }))
      .toEqual({ lockdownMode: false });
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: 'yes' }))
      .toEqual({ lockdownMode: false });
  });

  it('persists Lockdown mode in an owner-readable application preference', async () => {
    const directory = await temporaryUserDataDirectory();
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ lockdownMode: false });

    await writeStoredApplicationSettings(directory, { lockdownMode: true });

    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ lockdownMode: true });
    expect(JSON.parse(await readFile(applicationSettingsFilePath(directory), 'utf8')))
      .toEqual({ version: 1, lockdownMode: true });
    expect((await stat(applicationSettingsFilePath(directory))).mode & 0o777).toBe(0o600);
  });
});
