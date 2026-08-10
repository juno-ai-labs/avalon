import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const APPLICATION_SETTINGS_FILE_NAME = 'application-settings.json';

export interface StoredApplicationSettings {
  lockdownMode: boolean;
  debugEnabled: boolean;
}

interface StoredApplicationSettingsFile extends StoredApplicationSettings {
  version: 1;
}

export const defaultStoredApplicationSettings: StoredApplicationSettings = {
  lockdownMode: false,
  debugEnabled: false,
};

export function parseStoredApplicationSettings(value: unknown): StoredApplicationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultStoredApplicationSettings;
  }
  const candidate = value as { version?: unknown; lockdownMode?: unknown; debugEnabled?: unknown };
  if (candidate.version !== 1 || typeof candidate.lockdownMode !== 'boolean') {
    return defaultStoredApplicationSettings;
  }
  // Preferences written before the Developer section carry no debug field. An
  // unreadable value falls back to off rather than discarding Lockdown mode.
  return { lockdownMode: candidate.lockdownMode, debugEnabled: candidate.debugEnabled === true };
}

export function applicationSettingsFilePath(userDataDirectory: string): string {
  return join(userDataDirectory, APPLICATION_SETTINGS_FILE_NAME);
}

export async function readStoredApplicationSettings(
  userDataDirectory: string,
): Promise<StoredApplicationSettings> {
  try {
    const encoded = await readFile(applicationSettingsFilePath(userDataDirectory), 'utf8');
    return parseStoredApplicationSettings(JSON.parse(encoded) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) return defaultStoredApplicationSettings;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return defaultStoredApplicationSettings;
    }
    throw error;
  }
}

export async function writeStoredApplicationSettings(
  userDataDirectory: string,
  settings: StoredApplicationSettings,
): Promise<void> {
  await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
  const preferencePath = applicationSettingsFilePath(userDataDirectory);
  const temporaryPath = `${preferencePath}.${process.pid}.${randomUUID()}.tmp`;
  const stored: StoredApplicationSettingsFile = { version: 1, ...settings };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, preferencePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Rewrites one preference without disturbing the others. Lockdown mode and
 * the Developer preference share a file but not an owner, so neither may write
 * the whole document from its own state. */
export async function updateStoredApplicationSettings(
  userDataDirectory: string,
  patch: Partial<StoredApplicationSettings>,
): Promise<void> {
  const current = await readStoredApplicationSettings(userDataDirectory);
  await writeStoredApplicationSettings(userDataDirectory, { ...current, ...patch });
}
