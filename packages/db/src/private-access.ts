import { DownloadGrantExpirySchema, type AccessRequestListItem } from '@rally/contracts/private-access';
import type { D1DatabaseLike } from './index';

export async function listAccessRequests(db: D1DatabaseLike): Promise<AccessRequestListItem[]> {
  const result = await db.prepare(`SELECT id, email, created_at AS createdAt,
    acknowledgement_status AS acknowledgementStatus, acknowledged_at AS acknowledgedAt
    FROM access_requests ORDER BY created_at DESC, id DESC`).all<AccessRequestListItem>();
  return result.results ?? [];
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
