export function cloudflareErrorCodes(body) {
  if (!Array.isArray(body?.errors)) return 'none';
  const codes = body.errors
    .map((error) => error?.code)
    .filter((code) => Number.isSafeInteger(code));
  return codes.length > 0 ? codes.join(',') : 'none';
}

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: attempts at one `wrangler r2 object put` of a release payload that
 *   the Cloudflare API refused with a transient condition.
 * Without it: a Cloudflare API outage keeps the publisher re-sending a ~180 MiB
 *   payload until the release job's own `timeout-minutes` (90, in
 *   `.github/workflows/release-desktop-macos.yml`) kills the runner. Checked
 *   2026-11-12: that job timeout is the only bound on this loop today.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: the publisher fails with the last attempt's Wrangler output, exactly
 *   as a single refused upload did before this retry existed.
 * Derive from: how long a Cloudflare API incident is worth waiting out on a
 *   held macOS runner against re-running the workflow, which is safe because a
 *   release that fails before publication leaves no tag (docs/runbook.md).
 */
export const R2_UPLOAD_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

const TRANSIENT_HTTP_STATUS = /- (?:429|5\d\d): /;
const TRANSIENT_NETWORK_FAILURE = /\b(?:fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|socket hang up)\b/;

/**
 * Whether a failed Wrangler command was refused by a condition a later attempt
 * can clear: a 429 or 5xx from the Cloudflare API (Wrangler prints
 * `Failed to fetch <path> - 504: Gateway Timeout`) or a dropped connection.
 * An authorization, validation or missing-bucket failure is not transient and
 * must fail the first time.
 */
export function isTransientWranglerFailure({ stdout = '', stderr = '' }) {
  const output = `${stdout}\n${stderr}`;
  return TRANSIENT_HTTP_STATUS.test(output) || TRANSIENT_NETWORK_FAILURE.test(output);
}

/**
 * Runs `attempt` until it exits zero, it fails non-transiently, or
 * `maxAttempts` is spent, backing off between attempts on the same schedule the
 * publisher's R2 reads use. Returns the last attempt's `{ code, stdout, stderr }`.
 */
export async function runWranglerWithTransientRetry({
  attempt,
  maxAttempts,
  sleep,
  onRetry = () => {},
}) {
  for (let index = 0; ; index += 1) {
    const result = await attempt();
    if (result.code === 0) return result;
    if (index + 1 >= maxAttempts || !isTransientWranglerFailure(result)) return result;
    const delay = Math.min(1_000 * 2 ** index, 30_000);
    onRetry({ attempt: index + 1, delay, result });
    await sleep(delay);
  }
}
