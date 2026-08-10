import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationSettingsFilePath,
  parseStoredApplicationSettings,
  readStoredApplicationSettings,
  updateStoredApplicationSettings,
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
  it('defaults every preference to off for missing or invalid values', () => {
    expect(parseStoredApplicationSettings(undefined))
      .toEqual({ lockdownMode: false, debugEnabled: false });
    expect(parseStoredApplicationSettings({ version: 2, lockdownMode: true }))
      .toEqual({ lockdownMode: false, debugEnabled: false });
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: 'yes' }))
      .toEqual({ lockdownMode: false, debugEnabled: false });
  });

  it('keeps Lockdown mode when a preference predates the Developer section', () => {
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: true }))
      .toEqual({ lockdownMode: true, debugEnabled: false });
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: true, debugEnabled: 'yes' }))
      .toEqual({ lockdownMode: true, debugEnabled: false });
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, debugEnabled: true }))
      .toEqual({ lockdownMode: false, debugEnabled: true });
  });

  it('persists preferences in an owner-readable application file', async () => {
    const directory = await temporaryUserDataDirectory();
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ lockdownMode: false, debugEnabled: false });

    await writeStoredApplicationSettings(directory, { lockdownMode: true, debugEnabled: true });

    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ lockdownMode: true, debugEnabled: true });
    expect(JSON.parse(await readFile(applicationSettingsFilePath(directory), 'utf8')))
      .toEqual({ version: 1, lockdownMode: true, debugEnabled: true });
    expect((await stat(applicationSettingsFilePath(directory))).mode & 0o777).toBe(0o600);
  });

  it('updates one preference without disturbing the other', async () => {
    const directory = await temporaryUserDataDirectory();
    await writeStoredApplicationSettings(directory, { lockdownMode: true, debugEnabled: false });

    await updateStoredApplicationSettings(directory, { debugEnabled: true });
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ lockdownMode: true, debugEnabled: true });

    await updateStoredApplicationSettings(directory, { lockdownMode: false });
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ lockdownMode: false, debugEnabled: true });
  });
});
