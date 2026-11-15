import { z } from 'zod';
import { CLIENT_CONTRACT_VERSION, RALLY_HEADERS } from '@rally/contracts/http-headers';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import type { MobileSnapshot, NativeArtifact, PreparedCanvas } from './protocol';

const AccessSchema = z.object({ openUrl: z.string(), canonicalUrl: z.string() });

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: milliseconds the native shell waits for fresh pin access before it
 *   asks Home instead.
 * Without it: a request held by a captive portal or a stalled network waits the
 *   platform default (about 60 s on iOS) before Home is asked, so the pin shows a
 *   spinner that long. Checked 2026-11-15: nothing upstream bounds this fetch.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: the request aborts, the failure is recorded as `timed_out`, and the
 *   caller asks Home, as for any other failure.
 * Derive from: the 500 ms open target against Home's own boot time; a timeout
 *   shorter than Home's answer only adds a second request.
 */
export const ARTIFACT_ACCESS_TIMEOUT_MS = Number.POSITIVE_INFINITY;

/**
 * Fresh access to a pinned artifact, asked for directly rather than through
 * Home's page, so renewing a pin never waits for Home to boot.
 *
 * This is the one data request the native shell makes itself, and it is kept to
 * that: the same browser-transport endpoint the page calls, on the same
 * HttpOnly session cookie, which the platform shares between the WebViews and
 * this request. The browser route requires the app's `Origin` on a POST, a
 * cross-site browser check this first-party client meets by sending it. Any
 * failure returns null, after reporting its reason code, and the caller asks
 * Home instead.
 */
export async function requestArtifactAccess(
  appUrl: string,
  directory: Pick<MobileSnapshot, 'workspacePath'>,
  canvas: PreparedCanvas,
  { fetchImpl = fetch, report = () => undefined, timeoutMs = ARTIFACT_ACCESS_TIMEOUT_MS }: {
    fetchImpl?: typeof fetch; report?: (reason: string) => void; timeoutMs?: number;
  } = {},
): Promise<NativeArtifact | null> {
  const fail = (reason: string) => { report(reason); return null; };
  const [, , , region, workspaceId] = directory.workspacePath.split('/');
  if (!region || !workspaceId) return fail('workspace_path_invalid');
  const origin = new URL(appUrl).origin;
  const path = `/regional/${encodeURIComponent(region)}/browser/api/${encodeURIComponent(workspaceId)}/resources/${encodeURIComponent(canvas.resourceId)}/artifact/open`;
  const signal = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', Origin: origin, [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION) },
      signal,
    });
  } catch (error) {
    return fail(error instanceof DOMException && error.name === 'TimeoutError' ? 'timed_out' : 'network_error');
  }
  if (!response.ok) return fail(`http_${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { return fail('reply_not_json'); }
  const access = AccessSchema.safeParse(body);
  if (!access.success) return fail(zodDiagnosticCode(access.error, 'artifact_access') ?? 'artifact_access_invalid');
  return { ...canvas, openUrl: access.data.openUrl, canonicalUrl: access.data.canonicalUrl };
}
