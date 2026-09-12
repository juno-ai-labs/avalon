import { ACCESS_PAGE_SIZE, DownloadGrantExpirySchema, type AccessRequestListItem, type DownloadGrantListItem } from '@rally/contracts/private-access';
import type { D1DatabaseLike } from './index';

export async function listAccessRequests(db: D1DatabaseLike, query = '', before?: string): Promise<AccessRequestListItem[]> {
  const result = await db.prepare(`SELECT id, email, created_at AS createdAt,
    acknowledgement_status AS acknowledgementStatus, acknowledged_at AS acknowledgedAt,
    acknowledgement_first_attempt_at AS firstAttemptAt, acknowledgement_generation AS generation
    FROM access_requests WHERE instr(email, ?) > 0
    AND (? IS NULL OR (created_at, id) < (SELECT created_at, id FROM access_requests WHERE id = ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(query.toLowerCase(), before ?? null, before ?? null, ACCESS_PAGE_SIZE + 1).all<AccessRequestListItem>();
  return result.results ?? [];
}

export async function listDownloadGrants(db: D1DatabaseLike, query = '', before?: string): Promise<DownloadGrantListItem[]> {
  // A grant's source_id points at whichever table its source names: an
  // access_requests row for 'manual'/'access_invitation', a
  // workspace_invitations row for 'workspace_invitation'. Both joins are
  // needed so a workspace-invitation grant is attributable and searchable by
  // email instead of always rendering as an unattributed standalone link.
  const result = await db.prepare(`SELECT g.id, COALESCE(r.email, wi.email) AS email, g.created_at AS createdAt,
    g.expires_at AS expiresAt, g.used_at AS usedAt, g.revoked_at AS revokedAt
    FROM download_grants g
    LEFT JOIN access_requests r ON r.id = g.source_id AND g.source IN ('manual', 'access_invitation')
    LEFT JOIN workspace_invitations wi ON wi.id = g.source_id AND g.source = 'workspace_invitation'
    WHERE (? = '' OR instr(COALESCE(r.email, wi.email), ?) > 0 OR g.id = ?)
    AND (? IS NULL OR (g.created_at, g.id) < (SELECT created_at, id FROM download_grants WHERE id = ?))
    ORDER BY g.created_at DESC, g.id DESC LIMIT ?`)
    .bind(query, query.toLowerCase(), query, before ?? null, before ?? null, ACCESS_PAGE_SIZE + 1).all<DownloadGrantListItem>();
  return result.results ?? [];
}

export async function revokeDownloadGrant(db: D1DatabaseLike, id: string): Promise<boolean> {
  return await db.prepare(`UPDATE download_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? RETURNING id`)
    .bind(new Date().toISOString(), id).first() !== null;
}

/** A distributed cap per known grant, without creating rows for attacker tokens. */
export async function admitDownloadStart(db: D1DatabaseLike, token: string, limit: number, now = Date.now()): Promise<boolean> {
  if (!Number.isFinite(limit)) return true;
  const bucket = Math.floor(now / 60_000);
  return await db.prepare(`UPDATE download_grants SET start_bucket = ?,
    start_count = CASE WHEN start_bucket = ? THEN start_count + 1 ELSE 1 END
    WHERE token_hash = ? AND start_bucket <= ? AND (start_bucket < ? OR start_count < ?)
    AND revoked_at IS NULL AND ((expires_at IS NULL AND used_at IS NULL) OR expires_at > ?)
    RETURNING id`).bind(bucket, bucket, await hashDownloadToken(token), bucket, bucket, limit, new Date(now).toISOString()).first() !== null;
}

export type DownloadGrantSource = 'manual' | 'access_invitation' | 'workspace_invitation';

export async function hashDownloadToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Shared issuer for Ace and email producers. Attribution never changes bearer authority. */
export async function issueDownloadGrant(db: D1DatabaseLike, input: {
  source: DownloadGrantSource;
  sourceId?: string;
  createdBy: string;
  expiresAt?: string;
}): Promise<{ id: string; token: string; expiresAt: string | null }> {
  const expiresAt = input.expiresAt === undefined ? null : DownloadGrantExpirySchema.parse(input.expiresAt);
  // 256-bit entropy, matching the API's existing randomToken default.
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO download_grants
    (id, token_hash, source, source_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, await hashDownloadToken(token), input.source, input.sourceId ?? null,
      input.createdBy, new Date().toISOString(), expiresAt).run();
  return { id, token, expiresAt };
}

export function downloadGrantUrl(token: string, siteOrigin = 'https://rallywith.ai'): string {
  const url = new URL('/download/', siteOrigin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

/** Atomic admission: single-use claims once, timed grants admit until their deadline. */
export async function redeemDownloadGrant(db: D1DatabaseLike, token: string): Promise<boolean> {
  const tokenHash = await hashDownloadToken(token);
  const now = new Date().toISOString();
  const row = await db.prepare(`UPDATE download_grants SET used_at = COALESCE(used_at, ?)
    WHERE token_hash = ? AND revoked_at IS NULL
      AND ((expires_at IS NULL AND used_at IS NULL) OR expires_at > ?) RETURNING id`)
    .bind(now, tokenHash, now).first<{ id: string }>();
  return row !== null;
}

export async function availableDownloadGrantExists(db: D1DatabaseLike, token: string): Promise<boolean> {
  const tokenHash = await hashDownloadToken(token);
  return await db.prepare(`SELECT id FROM download_grants
    WHERE token_hash = ? AND revoked_at IS NULL
      AND ((expires_at IS NULL AND used_at IS NULL) OR expires_at > ?)`)
    .bind(tokenHash, new Date().toISOString()).first() !== null;
}
