import type { Env } from '../env';

/**
 * LIMIT UNSET — an untrusted caller can submit many distinct addresses and spend
 * the shared Resend budget. Origin validation and email deduplication do not stop
 * that. Bounds requests per edge IP per hour; trips with 429 before persistence
 * or mail. Choose from the mail budget / active hours and shared-office traffic.
 * Upper bound: +Infinity keeps the guard inert and writes no rate buckets.
 */
export const MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR = Number.POSITIVE_INFINITY;

/**
 * LIMIT UNSET — public callers can send large bodies that JSON/form parsing holds
 * in Worker memory. Origin/token checks do not bound bytes. Trips with 413 before
 * parsing. Choose from the email/token envelope size and concurrent request memory.
 * Upper bound: +Infinity skips the middleware entirely.
 */
export const MAX_PRIVATE_ACCESS_REQUEST_BYTES = Number.POSITIVE_INFINITY;

export async function admitAccessRequest(env: Env, address: string, limit: number, now = Date.now()): Promise<boolean> {
  if (!Number.isFinite(limit)) return true;
  // One-hour buckets define the unit of the operator-selected rate, not its cap.
  const bucket = Math.floor(now / 3_600_000);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  const subject = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('DELETE FROM access_request_rate_buckets WHERE bucket < ?').bind(bucket).run();
  const row = await env.DB.prepare(`INSERT INTO access_request_rate_buckets (subject_hash, bucket, count)
    VALUES (?, ?, 1) ON CONFLICT(subject_hash) DO UPDATE SET
    count = CASE WHEN bucket = excluded.bucket THEN count + 1 ELSE 1 END, bucket = excluded.bucket
    WHERE bucket <= excluded.bucket
    RETURNING count`).bind(subject, bucket).first<{ count: number }>();
  return row !== null && row.count <= limit;
}

/**
 * LIMIT UNSET — anonymous signups spend shared mail quota even across rotating
 * IPs. Per-IP limits do not bound aggregate mail. A full hourly budget defers
 * acknowledgement (the request stays pending) instead of losing the lead.
 * Derive from: provider quota reserved for acquisition / active hours.
 */
export const MAX_ACCESS_EMAILS_PER_HOUR = Number.POSITIVE_INFINITY;
/**
 * LIMIT UNSET — holders of timed links can open parallel R2 streams. IP limits
 * do not bound redistributed links. Trips with a retryable 429 before R2 I/O.
 * Derive from: acceptable download restarts per person per minute.
 */
export const MAX_DOWNLOAD_STARTS_PER_MINUTE = Number.POSITIVE_INFINITY;

export async function admitAccessEmail(env: Env, limit: number, now = Date.now()): Promise<boolean> {
  if (!Number.isFinite(limit)) return true;
  const bucket = Math.floor(now / 3_600_000);
  return await env.DB.prepare(`INSERT INTO access_email_budget (id, bucket, count) SELECT 1, ?, 1 WHERE ? > 0
    ON CONFLICT(id) DO UPDATE SET count = CASE WHEN bucket = excluded.bucket THEN count + 1 ELSE 1 END,
    bucket = excluded.bucket WHERE bucket <= excluded.bucket AND (bucket < excluded.bucket OR count < ?)
    RETURNING id`).bind(bucket, limit, limit).first() !== null;
}
