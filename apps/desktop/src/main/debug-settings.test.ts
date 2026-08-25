import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultStoredApplicationSettings,
  readStoredApplicationSettings,
  updateStoredApplicationSettings,
  writeStoredApplicationSettings,
} from './application-settings';
import { DebugSettingsController } from './debug-settings';

const temporaryDirectories: string[] = [];

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rally-debug-settings-'));
  temporaryDirectories.push(directory);
  return directory;
}

function diskController(
  directory: string,
  onChange: (debugEnabled: boolean) => void = vi.fn(),
): DebugSettingsController {
  return new DebugSettingsController({
    readSettings: () => readStoredApplicationSettings(directory),
    writeSettings: (settings) => updateStoredApplicationSettings(directory, settings),
    onChange,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe('debug settings controller', () => {
  it('starts off and reads the stored preference at startup', async () => {
    const directory = await temporaryUserDataDirectory();
    await expect(diskController(directory).initialize()).resolves.toBe(false);

    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: true });
    const controller = diskController(directory);

    await expect(controller.initialize()).resolves.toBe(true);
    expect(controller.enabled()).toBe(true);
  });

  it('persists a change and announces it once', async () => {
    const directory = await temporaryUserDataDirectory();
    const onChange = vi.fn();
    const controller = diskController(directory, onChange);
    await controller.initialize();

    await expect(controller.set(true)).resolves.toBe(true);
    await expect(controller.set(true)).resolves.toBe(true);

    expect(onChange.mock.calls).toEqual([[true]]);
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: true });
  });

  it('never writes Lockdown mode while changing the Developer preference', async () => {
    const directory = await temporaryUserDataDirectory();
    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: false });
    const controller = diskController(directory);
    await controller.initialize();

    await controller.set(true);

    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: true });
  });

  it('serializes concurrent toggles so the last one wins on disk', async () => {
    const directory = await temporaryUserDataDirectory();
    const controller = diskController(directory);
    await controller.initialize();

    await Promise.all([controller.set(true), controller.set(false), controller.set(true)]);

    expect(controller.enabled()).toBe(true);
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: true });
  });

  it('rejects a non-boolean value without touching the stored preference', async () => {
    const directory = await temporaryUserDataDirectory();
    const onChange = vi.fn();
    const controller = diskController(directory, onChange);
    await controller.initialize();

    await expect(controller.set('yes')).rejects.toThrow('Invalid Debug enabled value');

    expect(controller.enabled()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    await expect(readStoredApplicationSettings(directory))
      .resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
  });
});
