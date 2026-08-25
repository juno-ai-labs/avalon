import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_DATA_DIRECTORY = 'rally-data';
/**
 * Directory names written before the rename from Avalon.
 *
 * The same rule as everywhere else in the rename, applied one level down:
 * **writes go to the current directory; reads and deletes see every spelling.**
 * `migrateSupersededSessionDirectory` consolidates the current userData
 * directory on launch, but it cannot reach a *superseded userData* directory
 * that was left behind — and a credential in one of those is still a credential
 * on disk, which is why logout resolves these too rather than only the current
 * name.
 */
const SUPERSEDED_SESSION_DATA_DIRECTORIES: readonly string[] = Object.freeze(['avalon-data']);
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
  return join(userDataDirectory, SUPERSEDED_SESSION_DATA_DIRECTORIES[0]!);
}

/** Every session directory a read or a delete must consider, current first. */
export function storedSessionDirectories(userDataDirectory: string): readonly string[] {
  return Object.freeze([
    storedSessionDirectory(userDataDirectory),
    ...SUPERSEDED_SESSION_DATA_DIRECTORIES.map((name) => join(userDataDirectory, name)),
  ]);
}

function storedFilePaths(userDataDirectory: string, fileName: string): readonly string[] {
  return storedSessionDirectories(userDataDirectory).map((directory) => join(directory, fileName));
}

/** Read the first of `paths` that exists, preserving a non-ENOENT failure. */
async function readFirstExisting(paths: readonly string[]): Promise<Buffer> {
  let notFound: unknown;
  for (const path of paths) {
    try {
      return await readFile(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      notFound ??= error;
    }
  }
  throw notFound ?? Object.assign(new Error('No stored file exists'), { code: 'ENOENT' });
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
  return readFirstExisting(storedFilePaths(userDataDirectory, AUTH_FILE_NAME));
}

export async function readStoredProfileFile(userDataDirectory: string): Promise<Buffer> {
  return readFirstExisting(storedFilePaths(userDataDirectory, PROFILE_FILE_NAME));
}

export async function migrateLegacyStoredSessionFile(userDataDirectory: string): Promise<boolean> {
  try {
    await readFirstExisting(storedFilePaths(userDataDirectory, SESSION_FILE_NAME));
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
    return await readFirstExisting(storedFilePaths(userDataDirectory, SESSION_FILE_NAME));
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
  // The adoption rename can fail, in which case the launch runs *out of* a
  // superseded directory — and that directory is still in the list this is
  // called over. Recovering a directory into itself reads the session, then
  // deletes it as the now-migrated source: the one copy, gone, for exactly the
  // person the fallback exists to keep signed in.
  if (userDataDirectory === legacyUserDataDirectory) return false;
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
    ...storedFilePaths(userDataDirectory, SESSION_FILE_NAME),
    legacyStoredSessionFilePath(userDataDirectory),
    ...storedFilePaths(userDataDirectory, SESSION_TEMP_FILE_NAME),
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
    ...storedFilePaths(userDataDirectory, AUTH_FILE_NAME),
    ...storedFilePaths(userDataDirectory, AUTH_TEMP_FILE_NAME),
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
    ...storedFilePaths(userDataDirectory, PROFILE_FILE_NAME),
    ...storedFilePaths(userDataDirectory, PROFILE_TEMP_FILE_NAME),
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

/**
 * Overwrite a superseded copy that still exists, without creating one.
 *
 * A tombstone is the fallback for when deletion is refused but the file is
 * still writable, so it has to reach every location a read would find — a
 * tombstoned `rally-data/desktop-auth.bin` beside an untouched
 * `avalon-data/desktop-auth.bin` leaves the credential readable and reports
 * success. It deliberately does not create the file: a fresh install has no
 * superseded directory and must not gain one.
 */
async function tombstoneSupersededCopies(
  userDataDirectory: string,
  fileName: string,
  encryptedInvalidValue: Uint8Array,
): Promise<void> {
  const [, ...superseded] = storedFilePaths(userDataDirectory, fileName);
  await Promise.all(superseded.map(async (path) => {
    try {
      await stat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    await writeFile(path, encryptedInvalidValue, { mode: 0o600 });
  }));
}

export async function tombstoneStoredCredentialFiles(
  userDataDirectory: string,
  encryptedInvalidValue: Uint8Array,
): Promise<void> {
  await Promise.all([
    writeStoredAuthFile(userDataDirectory, encryptedInvalidValue),
    writeStoredSessionFile(userDataDirectory, encryptedInvalidValue),
    writeFile(legacyStoredSessionFilePath(userDataDirectory), encryptedInvalidValue, { mode: 0o600 }),
    tombstoneSupersededCopies(userDataDirectory, AUTH_FILE_NAME, encryptedInvalidValue),
    tombstoneSupersededCopies(userDataDirectory, SESSION_FILE_NAME, encryptedInvalidValue),
  ]);
}

export async function tombstoneStoredStateFiles(
  userDataDirectory: string,
  encryptedInvalidValue: Uint8Array,
): Promise<void> {
  await Promise.all([
    writeStoredProfileFile(userDataDirectory, encryptedInvalidValue),
    tombstoneSupersededCopies(userDataDirectory, PROFILE_FILE_NAME, encryptedInvalidValue),
    tombstoneStoredCredentialFiles(userDataDirectory, encryptedInvalidValue),
  ]);
}
