import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopLockdownSettings } from '../common/desktop';
import {
  defaultStoredApplicationSettings,
  readStoredApplicationSettings,
  updateStoredApplicationSettings,
  writeStoredApplicationSettings,
} from './application-settings';
import { LockdownModeController } from './lockdown-mode';
import {
  readStoredAuthFile,
  readStoredProfileFile,
  removeStoredCredentialFiles,
  writeStoredAuthFile,
  writeStoredProfileFile,
} from './session-file';
import {
  decryptSessionValue,
  encryptSessionValue,
  migrateStoredSessionEncryption,
  type SessionSafeStorage,
} from './session-encryption';

const temporaryDirectories: string[] = [];

async function temporaryUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rally-lockdown-mode-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

function mutableSafeStorage(initiallyAvailable = true): SessionSafeStorage & { available: boolean } {
  return {
    available: initiallyAvailable,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString: (value) => Buffer.from(`keystore:${value}`, 'utf8'),
    decryptString: (value) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('keystore:')) throw new Error('Invalid keystore value');
      return encoded.slice('keystore:'.length);
    },
  };
}

function serialRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

async function diskController(
  directory: string,
  safeStorage: SessionSafeStorage,
  options: {
    onChange?: (settings: DesktopLockdownSettings) => void;
    clearCredentials?: () => Promise<void>;
    recover?: () => Promise<void>;
    runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<LockdownModeController> {
  const values = [
    { credentialBearing: true, read: () => readStoredAuthFile(directory), write: (value: Uint8Array) => writeStoredAuthFile(directory, value) },
    { credentialBearing: false, read: () => readStoredProfileFile(directory), write: (value: Uint8Array) => writeStoredProfileFile(directory, value) },
  ];
  return new LockdownModeController({
    safeStorage,
    readSettings: () => readStoredApplicationSettings(directory),
    writeSettings: (settings) => updateStoredApplicationSettings(directory, settings),
    migrateSession: (mode, migrationOptions) =>
      migrateStoredSessionEncryption(values, mode, safeStorage, migrationOptions),
    recoverGlobalSessionWithoutKeystore: options.recover ?? vi.fn(async () => undefined),
    clearCredentialsForRelogin: options.clearCredentials
      ?? vi.fn(() => removeStoredCredentialFiles(directory)),
    runExclusive: options.runExclusive ?? (async (operation) => operation()),
    onChange: options.onChange ?? vi.fn(),
  });
}

describe('Lockdown mode controller', () => {
  it('migrates real auth and profile files in both directions through the app', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    await writeStoredAuthFile(directory, encryptSessionValue('auth', 'global', safeStorage));
    await writeStoredProfileFile(directory, encryptSessionValue('profile', 'global', safeStorage));
    const controller = await diskController(directory, safeStorage);
    await controller.initialize();

    await expect(controller.set(true)).resolves.toMatchObject({ lockdownMode: true });
    expect(decryptSessionValue(await readStoredAuthFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'auth', mode: 'lockdown' });
    expect(decryptSessionValue(await readStoredProfileFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'profile', mode: 'lockdown' });
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: false });

    await expect(controller.set(false)).resolves.toMatchObject({ lockdownMode: false });
    expect(decryptSessionValue(await readStoredAuthFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'auth', mode: 'global' });
    expect(decryptSessionValue(await readStoredProfileFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'profile', mode: 'global' });
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
  });

  it('forces re-login if the JSON preference is edited from on to off outside the app', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    await writeStoredAuthFile(directory, encryptSessionValue('auth', 'global', safeStorage));
    await writeStoredProfileFile(directory, encryptSessionValue('profile', 'global', safeStorage));
    const firstController = await diskController(directory, safeStorage);
    await firstController.initialize();
    await firstController.set(true);

    // Simulate an out-of-app edit. An authorized toggle would have migrated
    // both envelopes to global before it committed this preference.
    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
    const clearCredentials = vi.fn(() => removeStoredCredentialFiles(directory));
    const restartedController = await diskController(directory, safeStorage, { clearCredentials });

    await expect(restartedController.initialize()).resolves.toMatchObject({ lockdownMode: false });
    expect(clearCredentials).toHaveBeenCalledTimes(1);
    await expect(readStoredAuthFile(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readStoredProfileFile(directory)).resolves.toBeDefined();

    const repeatedClear = vi.fn(async () => undefined);
    const nextController = await diskController(directory, safeStorage, {
      clearCredentials: repeatedClear,
    });
    await nextController.initialize();
    expect(repeatedClear).not.toHaveBeenCalled();
    expect(decryptSessionValue(await readStoredProfileFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'profile', mode: 'global' });
  });

  it('migrates pre-setting safeStorage files to the default-off global mode at startup', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    await writeStoredAuthFile(directory, Buffer.from('keystore:legacy-auth'));
    await writeStoredProfileFile(directory, Buffer.from('keystore:legacy-profile'));
    const controller = await diskController(directory, safeStorage);

    await expect(controller.initialize()).resolves.toMatchObject({ lockdownMode: false });
    expect(decryptSessionValue(await readStoredAuthFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'legacy-auth', mode: 'global', legacy: false });
    expect(decryptSessionValue(await readStoredProfileFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'legacy-profile', mode: 'global', legacy: false });
  });

  it('automatically turns Lockdown off and clears credentials if the keystore disappears', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: false });
    const clearCredentials = vi.fn(async () => undefined);
    const onChange = vi.fn();
    const controller = await diskController(directory, safeStorage, { clearCredentials, onChange });
    await controller.initialize();
    safeStorage.available = false;

    await expect(controller.settings()).resolves.toEqual({
      lockdownMode: false,
      lockdownAvailable: false,
    });
    expect(clearCredentials).toHaveBeenCalledTimes(1);
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
    expect(onChange).toHaveBeenLastCalledWith({ lockdownMode: false, lockdownAvailable: false });
  });

  it('automatically turns Lockdown off and requires re-login at startup without a keystore', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage(false);
    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: false });
    const clearCredentials = vi.fn(async () => undefined);
    const controller = await diskController(directory, safeStorage, { clearCredentials });

    await expect(controller.initialize()).resolves.toEqual({
      lockdownMode: false,
      lockdownAvailable: false,
    });
    expect(clearCredentials).toHaveBeenCalledTimes(1);
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
  });

  it('uses loaded-session recovery when the in-app toggle disables Lockdown without a keystore', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    await writeStoredApplicationSettings(directory, { ...defaultStoredApplicationSettings, lockdownMode: true, debugEnabled: false });
    const recover = vi.fn(async () => undefined);
    const clearCredentials = vi.fn(async () => undefined);
    const controller = await diskController(directory, safeStorage, { clearCredentials, recover });
    await controller.initialize();
    safeStorage.available = false;

    await expect(controller.set(false)).resolves.toEqual({
      lockdownMode: false,
      lockdownAvailable: false,
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(clearCredentials).not.toHaveBeenCalled();
  });

  it('rejects enabling Lockdown when the keystore is unavailable', async () => {
    const directory = await temporaryUserDataDirectory();
    const controller = await diskController(directory, mutableSafeStorage(false));
    await controller.initialize();

    await expect(controller.set(true))
      .rejects.toThrow('Lockdown mode requires an available operating-system keystore');
    await expect(readStoredApplicationSettings(directory)).resolves.toEqual({ ...defaultStoredApplicationSettings, lockdownMode: false, debugEnabled: false });
  });

  it('serializes a session persist and a mode change through the shared mutation runner', async () => {
    const directory = await temporaryUserDataDirectory();
    const safeStorage = mutableSafeStorage();
    const runExclusive = serialRunner();
    const controller = await diskController(directory, safeStorage, { runExclusive });
    await controller.initialize();
    const events: string[] = [];
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    const persist = runExclusive(async () => {
      events.push('persist:start');
      await persistGate;
      await writeStoredAuthFile(
        directory,
        encryptSessionValue('new-auth', controller.encryptionMode(), safeStorage),
      );
      events.push('persist:end');
    });
    const toggle = controller.set(true).then(() => { events.push('toggle:end'); });

    await vi.waitFor(() => expect(events).toEqual(['persist:start']));
    releasePersist();
    await Promise.all([persist, toggle]);

    expect(events).toEqual(['persist:start', 'persist:end', 'toggle:end']);
    expect(decryptSessionValue(await readStoredAuthFile(directory), safeStorage))
      .toMatchObject({ plaintext: 'new-auth', mode: 'lockdown' });
  });
});
