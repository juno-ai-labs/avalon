import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applicationIconFileName,
  parseApplicationIconId,
  type ApplicationIconId,
} from '../common/application-icons';

const applicationIconPreferenceFileName = 'application-icon.json';

interface StoredApplicationIcon {
  version: 1;
  icon: ApplicationIconId;
}

export function applicationIconPath(resourceDirectory: string, iconId: ApplicationIconId): string {
  return join(resourceDirectory, applicationIconFileName(iconId));
}

export function parseStoredApplicationIcon(value: unknown): ApplicationIconId | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as { version?: unknown; icon?: unknown };
  return stored.version === 1 ? parseApplicationIconId(stored.icon) : null;
}

export async function readStoredApplicationIcon(userDataDirectory: string): Promise<ApplicationIconId | null> {
  try {
    const encoded = await readFile(join(userDataDirectory, applicationIconPreferenceFileName), 'utf8');
    return parseStoredApplicationIcon(JSON.parse(encoded) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeStoredApplicationIcon(
  userDataDirectory: string,
  iconId: ApplicationIconId,
): Promise<void> {
  await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
  const preferencePath = join(userDataDirectory, applicationIconPreferenceFileName);
  const temporaryPath = `${preferencePath}.${process.pid}.${randomUUID()}.tmp`;
  const stored: StoredApplicationIcon = { version: 1, icon: iconId };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, preferencePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function clearStoredApplicationIcon(userDataDirectory: string): Promise<void> {
  await rm(join(userDataDirectory, applicationIconPreferenceFileName), { force: true });
}
