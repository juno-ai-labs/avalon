import { runWithTransientRetry } from './release-lib.mjs';

export function cloudflareErrorCodes(body) {
  if (!Array.isArray(body?.errors)) return 'none';
  const codes = body.errors
    .map((error) => error?.code)
    .filter((code) => Number.isSafeInteger(code));
  return codes.length > 0 ? codes.join(',') : 'none';
}

/**
 * Attempts at one `wrangler r2 object put` of any release object (immutable
 * payloads, channel manifests, receipts and the publication record) that the
 * Cloudflare API refused with a transient condition.
 *
 * Finite on purpose: an exhausted ceiling throws inside `withR2ReleaseLock`, so
 * the lock is released and a later re-run starts clean. A job timeout or a
 * cancelled run would instead leave the lock active and need manual recovery
 * (docs/runbook.md). 10 matches `verifyR2Hash` in the publisher, on the same
 * 1s-doubling, 30s-capped backoff (about 2.5 minutes of waiting); chosen in
 * review of #1567.
 */
export const R2_UPLOAD_MAX_ATTEMPTS = 10;

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
export async function runWranglerWithTransientRetry(options) {
  return await runWithTransientRetry({ ...options, isTransient: isTransientWranglerFailure });
}
