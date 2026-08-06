import { join } from 'node:path';

const PRODUCTION_DIRECTORY_NAME = 'Avalon';
const DEVELOPMENT_DIRECTORY_NAME = 'Avalon Development';

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

/** The package name was used by early builds before Avalon pinned userData. */
export function legacyPackagedUserDataDirectory(appDataDirectory: string): string {
  return join(appDataDirectory, '@avalon', 'desktop');
}
