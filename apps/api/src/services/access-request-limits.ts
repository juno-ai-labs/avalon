import type { Env } from '../env';

/**
 * An untrusted caller can submit many distinct addresses and spend
 * the shared Resend budget. Origin validation and email deduplication do not stop
 * that. Bounds requests per edge IP per hour; trips with 429 before persistence
 * or mail. Team approved 10/hour on 2026-09-09: room for ten people sharing an
 * office address, assuming one signup each. Shared proxies may reach this cap.
 */
export const MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR = 10;

/**
 * Public callers can send large bodies that JSON/form parsing holds
 * in Worker memory. Origin/token checks do not bound bytes. Trips with 413 before
 * parsing. Team approved 8 KiB on 2026-09-09: space above a 2,048-character
 * Turnstile token plus an email and JSON envelope, not a capacity benchmark.
 */
export const MAX_PRIVATE_ACCESS_REQUEST_BYTES = 8 * 1024;

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
 * Anonymous signups spend shared mail quota even across rotating
 * IPs. Per-IP limits do not bound aggregate mail. A full hourly budget defers
 * acknowledgement (the request stays pending) instead of losing the lead.
 * Team approved 100/hour on 2026-09-09: up to 2,400 attempts/day. This acquisition
 * allowance includes retries and must leave provider quota for workspace mail.
 */
export const MAX_ACCESS_EMAILS_PER_HOUR = 100;
/**
 * Holders of timed links can open parallel R2 streams. IP limits
 * do not bound redistributed links. Trips with a retryable 429 before R2 I/O.
 * Team approved 5/minute on 2026-09-09: one initial start plus four restarts.
 * Already admitted streams may outlive the minute; this is not a traffic ceiling.
 */
export const MAX_DOWNLOAD_STARTS_PER_MINUTE = 5;

export async function admitAccessEmail(env: Env, limit: number, now = Date.now()): Promise<boolean> {
  if (!Number.isFinite(limit)) return true;
  const bucket = Math.floor(now / 3_600_000);
  return await env.DB.prepare(`INSERT INTO access_email_budget (id, bucket, count) SELECT 1, ?, 1 WHERE ? > 0
    ON CONFLICT(id) DO UPDATE SET count = CASE WHEN bucket = excluded.bucket THEN count + 1 ELSE 1 END,
    bucket = excluded.bucket WHERE bucket <= excluded.bucket AND (bucket < excluded.bucket OR count < ?)
    RETURNING id`).bind(bucket, limit, limit).first() !== null;
}
