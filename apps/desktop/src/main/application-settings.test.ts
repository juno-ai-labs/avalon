import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationSettingsFilePath,
  defaultStoredApplicationSettings,
  parseStoredApplicationSettings,
  readStoredApplicationSettings,
  updateStoredApplicationSettings,
  writeStoredApplicationSettings,
  type StoredApplicationSettings,
} from './application-settings';

const temporaryDirectories: string[] = [];

function settings(patch: Partial<StoredApplicationSettings>): StoredApplicationSettings {
  return { ...defaultStoredApplicationSettings, ...patch };
}

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rally-application-settings-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe('desktop application settings', () => {
  it('defaults every preference for missing or invalid values', () => {
    expect(parseStoredApplicationSettings(undefined)).toEqual(defaultStoredApplicationSettings);
    expect(parseStoredApplicationSettings({ version: 2, lockdownMode: true }))
      .toEqual(defaultStoredApplicationSettings);
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: 'yes' }))
      .toEqual(defaultStoredApplicationSettings);
  });

  it('keeps Lockdown mode when a preference predates the Developer section', () => {
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: true }))
      .toEqual(settings({ lockdownMode: true }));
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: true, debugEnabled: 'yes' }))
      .toEqual(settings({ lockdownMode: true }));
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, debugEnabled: true }))
      .toEqual(settings({ debugEnabled: true }));
  });

  it('reads a preference written before the menu bar item as menu bar on', () => {
    // Withdrawing the status item from every upgraded device would be the one
    // reading of a missing field nobody asked for.
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false }).menuBarEnabled)
      .toBe(true);
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, menuBarEnabled: 'no' }).menuBarEnabled)
      .toBe(true);
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, menuBarEnabled: false }).menuBarEnabled)
      .toBe(false);
  });

  it('only treats the login-item default as applied when it says so exactly', () => {
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false })
      .launchAtLoginDefaultApplied).toBe(false);
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, launchAtLoginDefaultApplied: 1 })
      .launchAtLoginDefaultApplied).toBe(false);
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false, launchAtLoginDefaultApplied: true })
      .launchAtLoginDefaultApplied).toBe(true);
  });

  it('migrates old files to default-on analytics without inventing pending synchronization', () => {
    expect(parseStoredApplicationSettings({ version: 1, lockdownMode: false })).toEqual(
      settings({ productAnalyticsEnabled: true, productAnalyticsPreferenceVersion: 0, productAnalyticsPreferencePending: false }),
    );
    expect(parseStoredApplicationSettings({
      version: 1,
      lockdownMode: false,
      productAnalyticsEnabled: false,
      productAnalyticsPreferenceVersion: 7,
      productAnalyticsPreferencePending: true,
    })).toEqual(settings({
      productAnalyticsEnabled: false,
      productAnalyticsPreferenceVersion: 7,
      productAnalyticsPreferencePending: true,
    }));
    expect(parseStoredApplicationSettings({
      version: 1,
      lockdownMode: false,
      productAnalyticsEnabled: 'no',
      productAnalyticsPreferenceVersion: -1,
      productAnalyticsPreferencePending: 'yes',
    })).toEqual(settings({
      productAnalyticsEnabled: true,
      productAnalyticsPreferenceVersion: 0,
      productAnalyticsPreferencePending: false,
    }));
  });

  it('persists preferences in an owner-readable application file', async () => {
    const directory = await temporaryUserDataDirectory();
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(defaultStoredApplicationSettings);

    await writeStoredApplicationSettings(directory, settings({ lockdownMode: true, debugEnabled: true }));

    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(settings({ lockdownMode: true, debugEnabled: true }));
    expect(JSON.parse(await readFile(applicationSettingsFilePath(directory), 'utf8')))
      .toEqual({
        version: 1,
        lockdownMode: true,
        debugEnabled: true,
        menuBarEnabled: true,
        launchAtLoginDefaultApplied: false,
        productAnalyticsEnabled: true,
        productAnalyticsPreferenceVersion: 0,
        productAnalyticsPreferencePending: false,
        themeChoice: { family: 'grok', mode: 'system' },
      });
    expect((await stat(applicationSettingsFilePath(directory))).mode & 0o777).toBe(0o600);
  });

  /**
   * The stored theme is the choice, not the appearance it resolves to. A file
   * naming a design this build does not have — or written before the field
   * existed — falls back to the default rather than to a family nothing can
   * draw.
   */
  it('reads back a stored theme choice, and refuses one it cannot draw', () => {
    const stored = (themeChoice: unknown): unknown => ({
      version: 1, lockdownMode: false, themeChoice,
    });

    expect(parseStoredApplicationSettings(stored({ family: 'air', mode: 'dark' })).themeChoice)
      .toEqual({ family: 'air', mode: 'dark' });
    expect(parseStoredApplicationSettings(stored({ family: 'sepia', mode: 'dark' })).themeChoice)
      .toEqual({ family: 'grok', mode: 'system' });
    expect(parseStoredApplicationSettings(stored(undefined)).themeChoice)
      .toEqual({ family: 'grok', mode: 'system' });
    // An appearance is not a choice: it cannot say which mode produced it.
    expect(parseStoredApplicationSettings(stored('air-dark')).themeChoice)
      .toEqual({ family: 'grok', mode: 'system' });
  });

  it('updates one preference without disturbing the others', async () => {
    const directory = await temporaryUserDataDirectory();
    await writeStoredApplicationSettings(directory, settings({ lockdownMode: true }));

    await updateStoredApplicationSettings(directory, { debugEnabled: true });
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(settings({ lockdownMode: true, debugEnabled: true }));

    await updateStoredApplicationSettings(directory, { menuBarEnabled: false });
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(settings({ lockdownMode: true, debugEnabled: true, menuBarEnabled: false }));

    await updateStoredApplicationSettings(directory, { lockdownMode: false });
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(settings({ debugEnabled: true, menuBarEnabled: false }));
  });

  it('keeps concurrent patches from different preference owners', async () => {
    const directory = await temporaryUserDataDirectory();
    await writeStoredApplicationSettings(directory, defaultStoredApplicationSettings);

    // Lockdown mode, the Developer section, and the menu bar item serialize
    // only against themselves, so their patches can land together. None may be
    // lost: an on-disk `lockdownMode: false` against a Lockdown envelope is
    // read at the next launch as an external downgrade, which deletes the
    // stored credentials.
    await Promise.all([
      updateStoredApplicationSettings(directory, { lockdownMode: true }),
      updateStoredApplicationSettings(directory, { debugEnabled: true }),
      updateStoredApplicationSettings(directory, { menuBarEnabled: false }),
    ]);

    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual(settings({ lockdownMode: true, debugEnabled: true, menuBarEnabled: false }));
  });
});
