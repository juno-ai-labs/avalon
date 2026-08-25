import { join } from 'node:path';

const PRODUCTION_DIRECTORY_NAME = 'Rally';
const DEVELOPMENT_DIRECTORY_NAME = 'Rally Development';

/**
 * Directory names earlier builds stored user data under, newest first.
 *
 * `Avalon` is the product's previous name. `@avalon/desktop` — the package name
 * this workspace carried before it became `@rally/desktop` — is where builds
 * stored user data before userData was pinned at all. Both are still read, and
 * the first one found is adopted.
 */
const SUPERSEDED_PRODUCTION_DIRECTORY_NAMES: readonly string[] = Object.freeze(['Avalon']);
const SUPERSEDED_DEVELOPMENT_DIRECTORY_NAMES: readonly string[] = Object.freeze(['Avalon Development']);
const SUPERSEDED_PACKAGE_DIRECTORY_SEGMENTS: readonly string[] = Object.freeze(['@avalon', 'desktop']);

/**
 * Keep desktop credentials in a bundle-stable namespace. Electron normally
 * derives userData from app.name, which package metadata or an early imported
 * dependency can observe before app.setName() runs.
 */
export function canonicalUserDataDirectory(appDataDirectory: string, isPackaged: boolean): string {
  return join(
    appDataDirectory,
    isPackaged ? PRODUCTION_DIRECTORY_NAME : DEVELOPMENT_DIRECTORY_NAME,
  );
}

/**
 * Every directory an earlier build may have written, newest first.
 *
 * Logout and the Lockdown relogin path clear all of them: a credential left in
 * a directory nothing reads any more is still a credential on disk, and it is
 * the copy nobody would think to look for.
 */
export function supersededUserDataDirectories(
  appDataDirectory: string,
  isPackaged: boolean,
): readonly string[] {
  const renamed = isPackaged
    ? SUPERSEDED_PRODUCTION_DIRECTORY_NAMES
    : SUPERSEDED_DEVELOPMENT_DIRECTORY_NAMES;
  return Object.freeze([
    ...renamed.map((name) => join(appDataDirectory, name)),
    // The package-name directory was only ever written by packaged builds.
    ...(isPackaged ? [join(appDataDirectory, ...SUPERSEDED_PACKAGE_DIRECTORY_SEGMENTS)] : []),
  ]);
}

/** The file-system primitives {@link userDataDirectoryForLaunch} needs. */
export interface UserDataDirectoryOperations {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

/**
 * Resolve the directory this launch stores user data in, adopting an earlier
 * build's directory when the rename left one behind.
 *
 * The rename from Avalon to Rally moves the whole userData directory rather
 * than migrating the files inside it. Everything a launch depends on lives
 * there — the Chromium profile, IndexedDB, application settings, the telemetry
 * spool, composer drafts, the encrypted session — and a per-file migration
 * would have to enumerate all of it correctly to avoid silently signing people
 * out or losing their drafts. One directory rename is atomic on the same
 * volume, carries what nobody thought to list, and is idempotent: after it, the
 * canonical directory exists and this is a no-op forever.
 *
 * When the rename fails, the superseded directory is used *as* userData rather
 * than starting empty. A launch that cannot move its own data is still a launch
 * that can read it, and signing someone out because a directory was busy is a
 * worse outcome than running from the old path and retrying next time.
 */
export function userDataDirectoryForLaunch(
  appDataDirectory: string,
  isPackaged: boolean,
  explicitUserDataDirectory: string,
  operations?: UserDataDirectoryOperations,
): string {
  // An explicit Chromium override — release verification, the packaged smoke
  // test — must never be redirected, and must never adopt anything.
  if (explicitUserDataDirectory) return explicitUserDataDirectory;

  const canonical = canonicalUserDataDirectory(appDataDirectory, isPackaged);
  if (!operations || operations.exists(canonical)) return canonical;

  for (const superseded of supersededUserDataDirectories(appDataDirectory, isPackaged)) {
    if (!operations.exists(superseded)) continue;
    try {
      operations.rename(superseded, canonical);
      return canonical;
    } catch {
      return superseded;
    }
  }
  return canonical;
}
