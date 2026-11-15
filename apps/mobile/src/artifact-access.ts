import { z } from 'zod';
import { CLIENT_CONTRACT_VERSION, RALLY_HEADERS } from '@rally/contracts/http-headers';
import type { MobileSnapshot, NativeArtifact, PreparedCanvas } from './protocol';

const AccessSchema = z.object({ openUrl: z.string(), canonicalUrl: z.string() });

/**
 * Fresh access to a pinned artifact, asked for directly rather than through
 * Home's page, so renewing a pin never waits for Home to boot.
 *
 * This is the one data request the native shell makes itself, and it is kept to
 * that: the same browser-transport endpoint the page calls, on the same
 * HttpOnly session cookie, which the platform shares between the WebViews and
 * this request. The browser route requires the app's `Origin` on a POST, a
 * cross-site browser check this first-party client meets by sending it. Any
 * failure returns null and the caller asks Home instead.
 */
export async function requestArtifactAccess(
  appUrl: string,
  directory: Pick<MobileSnapshot, 'workspacePath'>,
  canvas: PreparedCanvas,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeArtifact | null> {
  const [, , , region, workspaceId] = directory.workspacePath.split('/');
  if (!region || !workspaceId) return null;
  const origin = new URL(appUrl).origin;
  const path = `/regional/${encodeURIComponent(region)}/browser/api/${encodeURIComponent(workspaceId)}/resources/${encodeURIComponent(canvas.resourceId)}/artifact/open`;
  try {
    const response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', Origin: origin, [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION) },
    });
    if (!response.ok) return null;
    const access = AccessSchema.safeParse(await response.json());
    return access.success ? { ...canvas, openUrl: access.data.openUrl, canonicalUrl: access.data.canonicalUrl } : null;
  } catch { return null; }
}
