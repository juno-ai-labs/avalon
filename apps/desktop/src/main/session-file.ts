import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_DATA_DIRECTORY = 'avalon-data';
const SESSION_FILE_NAME = 'desktop-session.bin';

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

export function storedSessionDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, SESSION_DATA_DIRECTORY);
}

export function storedSessionFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), SESSION_FILE_NAME);
}

export function legacyStoredSessionFilePath(userDataDirectory: string): string {
  return join(userDataDirectory, SESSION_FILE_NAME);
}

export async function writeStoredSessionFile(
  userDataDirectory: string,
  encryptedSession: Uint8Array,
): Promise<void> {
  await mkdir(storedSessionDirectory(userDataDirectory), { recursive: true, mode: 0o700 });
  await writeFile(storedSessionFilePath(userDataDirectory), encryptedSession, { mode: 0o600 });
}

export async function migrateLegacyStoredSessionFile(userDataDirectory: string): Promise<boolean> {
  try {
    await readFile(storedSessionFilePath(userDataDirectory));
    return false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const legacyPath = legacyStoredSessionFilePath(userDataDirectory);
  const encryptedSession = await readFile(legacyPath);
  await writeStoredSessionFile(userDataDirectory, encryptedSession);
  try {
    await unlink(legacyPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      // The new copy is authoritative. Logout removes both locations so a
      // legacy cleanup failure cannot revive an old session later.
    }
  }
  return true;
}

export async function readStoredSessionFile(userDataDirectory: string): Promise<Buffer> {
  try {
    return await readFile(storedSessionFilePath(userDataDirectory));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const encryptedSession = await readFile(legacyStoredSessionFilePath(userDataDirectory));
  try {
    await migrateLegacyStoredSessionFile(userDataDirectory);
  } catch {
    // Keep the user signed in from the legacy bytes. A later launch can retry
    // migration after a transient filesystem failure is resolved.
  }
  return encryptedSession;
}

export async function removeStoredSessionFiles(userDataDirectory: string): Promise<void> {
  let failure: unknown;
  for (const path of [
    storedSessionFilePath(userDataDirectory),
    legacyStoredSessionFilePath(userDataDirectory),
  ]) {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw failure;
}
