import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_DATA_DIRECTORY = 'rally-data';
/**
 * The directory name written before the rename from Avalon.
 *
 * Unlike the userData directory above it, this one is not adopted by a launch
 * that finds it — an install already carrying the current userData name keeps
 * writing here — so it is renamed explicitly, once, by
 * {@link migrateSupersededSessionDirectory}.
 */
const SUPERSEDED_SESSION_DATA_DIRECTORY = 'avalon-data';
const AUTH_FILE_NAME = 'desktop-auth.bin';
const AUTH_TEMP_FILE_NAME = 'desktop-auth.tmp';
const PROFILE_FILE_NAME = 'desktop-profile.bin';
const PROFILE_TEMP_FILE_NAME = 'desktop-profile.tmp';
const SESSION_FILE_NAME = 'desktop-session.bin';
const SESSION_TEMP_FILE_NAME = 'desktop-session.tmp';

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

export function storedSessionDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, SESSION_DATA_DIRECTORY);
}

export function supersededStoredSessionDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, SUPERSEDED_SESSION_DATA_DIRECTORY);
}

/**
 * Move the pre-rename session directory into place, if one is still there.
 *
 * A rename rather than a per-file copy: the three encrypted files have to move
 * together or a launch can read an authentication credential without the
 * profile bound to it, and the rename is the only operation that cannot leave
 * them half-moved. It is skipped once the current directory exists, so a
 * failure costs one signed-out launch and is retried by the next one rather
 * than overwriting a session that is already current.
 */
export async function migrateSupersededSessionDirectory(
  userDataDirectory: string,
): Promise<boolean> {
  const current = storedSessionDirectory(userDataDirectory);
  const superseded = supersededStoredSessionDirectory(userDataDirectory);
  try {
    await stat(current);
    return false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  try {
    await rename(superseded, current);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function storedSessionFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), SESSION_FILE_NAME);
}

export function storedAuthFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), AUTH_FILE_NAME);
}

export function storedProfileFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), PROFILE_FILE_NAME);
}

export function legacyStoredSessionFilePath(userDataDirectory: string): string {
  return join(userDataDirectory, SESSION_FILE_NAME);
}

function temporaryStoredSessionFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), SESSION_TEMP_FILE_NAME);
}

function temporaryStoredAuthFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), AUTH_TEMP_FILE_NAME);
}

function temporaryStoredProfileFilePath(userDataDirectory: string): string {
  return join(storedSessionDirectory(userDataDirectory), PROFILE_TEMP_FILE_NAME);
}

async function writeEncryptedFile(
  userDataDirectory: string,
  destinationPath: string,
  temporaryPath: string,
  encryptedValue: Uint8Array,
): Promise<void> {
  await mkdir(storedSessionDirectory(userDataDirectory), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, encryptedValue, { mode: 0o600 });
    // A downloaded update can ask the process to quit at any time. Rename only
    // after the complete encrypted payload is written to a sibling file so the
    // previous value remains readable until replacement is atomic.
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the write/rename failure for the caller.
    }
    throw error;
  }
}

export async function writeStoredAuthFile(
  userDataDirectory: string,
  encryptedAuth: Uint8Array,
): Promise<void> {
  await writeEncryptedFile(
    userDataDirectory,
    storedAuthFilePath(userDataDirectory),
    temporaryStoredAuthFilePath(userDataDirectory),
    encryptedAuth,
  );
}

export async function writeStoredProfileFile(
  userDataDirectory: string,
  encryptedProfile: Uint8Array,
): Promise<void> {
  await writeEncryptedFile(
    userDataDirectory,
    storedProfileFilePath(userDataDirectory),
    temporaryStoredProfileFilePath(userDataDirectory),
    encryptedProfile,
  );
}

export async function writeStoredSessionFile(
  userDataDirectory: string,
  encryptedSession: Uint8Array,
): Promise<void> {
  await writeEncryptedFile(
    userDataDirectory,
    storedSessionFilePath(userDataDirectory),
    temporaryStoredSessionFilePath(userDataDirectory),
    encryptedSession,
  );
}

export async function readStoredAuthFile(userDataDirectory: string): Promise<Buffer> {
  return readFile(storedAuthFilePath(userDataDirectory));
}

export async function readStoredProfileFile(userDataDirectory: string): Promise<Buffer> {
  return readFile(storedProfileFilePath(userDataDirectory));
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

export async function migrateLegacyUserDataStoredSessionFile(
  userDataDirectory: string,
  legacyUserDataDirectory: string,
): Promise<boolean> {
  try {
    await readStoredSessionFile(userDataDirectory);
    try {
      await removeStoredSessionFiles(legacyUserDataDirectory);
    } catch {
      // The canonical credential wins. Retry legacy cleanup on the next launch.
    }
    return false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const encryptedSession = await readStoredSessionFile(legacyUserDataDirectory);
  await writeStoredSessionFile(userDataDirectory, encryptedSession);
  try {
    await removeStoredSessionFiles(legacyUserDataDirectory);
  } catch {
    // The canonical copy is authoritative. A later launch can retry cleanup.
  }
  return true;
}

export async function removeStoredSessionFiles(userDataDirectory: string): Promise<void> {
  let failure: unknown;
  for (const path of [
    storedSessionFilePath(userDataDirectory),
    legacyStoredSessionFilePath(userDataDirectory),
    temporaryStoredSessionFilePath(userDataDirectory),
  ]) {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw failure;
}

export async function removeStoredCredentialFiles(userDataDirectory: string): Promise<void> {
  let failure: unknown;
  for (const path of [
    storedAuthFilePath(userDataDirectory),
    temporaryStoredAuthFilePath(userDataDirectory),
  ]) {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && failure === undefined) failure = error;
    }
  }
  try {
    await removeStoredSessionFiles(userDataDirectory);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
}

export async function removeStoredStateFiles(userDataDirectory: string): Promise<void> {
  let failure: unknown;
  for (const path of [
    storedProfileFilePath(userDataDirectory),
    temporaryStoredProfileFilePath(userDataDirectory),
  ]) {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && failure === undefined) failure = error;
    }
  }
  try {
    await removeStoredCredentialFiles(userDataDirectory);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
}

export async function tombstoneStoredCredentialFiles(
  userDataDirectory: string,
  encryptedInvalidValue: Uint8Array,
): Promise<void> {
  await Promise.all([
    writeStoredAuthFile(userDataDirectory, encryptedInvalidValue),
    writeStoredSessionFile(userDataDirectory, encryptedInvalidValue),
    writeFile(legacyStoredSessionFilePath(userDataDirectory), encryptedInvalidValue, { mode: 0o600 }),
  ]);
}

export async function tombstoneStoredStateFiles(
  userDataDirectory: string,
  encryptedInvalidValue: Uint8Array,
): Promise<void> {
  await Promise.all([
    writeStoredProfileFile(userDataDirectory, encryptedInvalidValue),
    tombstoneStoredCredentialFiles(userDataDirectory, encryptedInvalidValue),
  ]);
}
