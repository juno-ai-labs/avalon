import { File, Paths } from 'expo-file-system';
import { z } from 'zod';

/** The site each canvas last showed, by canonical URL, so reopening it from the
 * dashboard loads on its cookie at once instead of waiting for Home to mint and
 * redeem fresh access. Canonical URLs only, never a one-time open URL. */
const file = () => new File(Paths.document, 'rally-opened-sites.json');

const RememberedSchema = z.object({ scope: z.string(), resourceId: z.string(), version: z.number().int().positive(), canonicalUrl: z.string() });
export type RememberedSite = z.infer<typeof RememberedSchema>;
const RememberedSitesSchema = z.record(z.string(), RememberedSchema);

export function loadRememberedSites(): Record<string, RememberedSite> {
  try {
    const parsed = RememberedSitesSchema.safeParse(JSON.parse(file().textSync()));
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

export function saveRememberedSites(sites: Record<string, RememberedSite>): void {
  try {
    if (Object.keys(sites).length > 0) file().write(JSON.stringify(sites));
    else if (file().exists) file().delete();
  } catch { /* A missing copy only costs the next open its head start. */ }
}
