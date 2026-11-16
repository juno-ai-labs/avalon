import { File, Paths } from 'expo-file-system';
import { MobileSnapshotSchema, type MobileSnapshot } from './protocol';

/** The last directory Home delivered, kept on the device so launch need not wait
 * for Home's session, organization and socket before drawing. Titles and pins
 * are customer content: one account at a time, removed on sign-out. */
const file = () => new File(Paths.document, 'rally-directory.json');

export function loadSavedDirectory(): MobileSnapshot | null {
  try {
    const parsed = MobileSnapshotSchema.safeParse(JSON.parse(file().textSync()));
    // A copy from before this rule may hold Canvases from other Organizations.
    return parsed.success ? { ...parsed.data, sharedElsewhere: [] } : null;
  } catch { return null; }
}

/**
 * Canvases shared from other Organizations are never written: nothing about a
 * Canvas is kept outside its Organization (`docs/canvas-share-federation.md`),
 * so they show once Home's live snapshot arrives.
 */
export function saveDirectory(snapshot: MobileSnapshot | null): void {
  try {
    if (snapshot) file().write(JSON.stringify({ ...snapshot, sharedElsewhere: [] }));
    else if (file().exists) file().delete();
  } catch { /* A missing copy only costs the next launch its head start. */ }
}
