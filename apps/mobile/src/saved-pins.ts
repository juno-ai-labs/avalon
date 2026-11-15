import { File, Paths } from 'expo-file-system';
import { z } from 'zod';
import { NativeArtifactSchema, PreparedCanvasSchema } from './protocol';
import type { PreparedPins } from './prepared-canvases';

/** The tab-bar pins' descriptors and canonical artifact URLs, so a pinned tab
 * can open on its cookie at launch without waiting for Home. Only canonical
 * URLs are kept: a one-time open URL is never written. One account at a time;
 * emptied with the directory on sign-out. */
const file = () => new File(Paths.document, 'rally-pins.json');

const SavedPinsSchema = z.object({
  entries: z.record(z.string(), z.object({ userId: z.string(), workspaceId: z.string(), canvas: PreparedCanvasSchema })),
  sessions: z.record(z.string(), z.object({
    scope: z.string(),
    artifact: NativeArtifactSchema.refine((artifact) => artifact.openUrl === artifact.canonicalUrl, 'only canonical URLs are saved'),
  })),
});

export function loadSavedPins(): PreparedPins | null {
  try {
    const parsed = SavedPinsSchema.safeParse(JSON.parse(file().textSync()));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function savePins(pins: PreparedPins): void {
  try {
    if (Object.keys(pins.entries).length > 0) file().write(JSON.stringify(pins));
    else if (file().exists) file().delete();
  } catch { /* A missing copy only costs the next launch its head start. */ }
}
