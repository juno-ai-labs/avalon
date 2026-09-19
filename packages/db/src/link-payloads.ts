import { codeShaped, describeZodIssues } from '@rally/contracts/zod-diagnostics';
import type { z } from 'zod';
import { sha256Hex, type D1DatabaseLike } from './index';

/**
 * Opaque tokens for links people receive, and the JSON each one stands for.
 *
 * A link that spells out what it addresses tells whoever it was forwarded to
 * more than it tells its recipient: identifiers are the server's routing, and
 * publishing them describes a thing the reader may hold no access to. So the
 * URL carries a token, this table holds the rest, and the token's prefix says
 * which shape "the rest" has.
 *
 * The prefix is the type. `defineLinkPayload` pairs one with the schema that
 * prefix promises, and nothing is written or read without satisfying it, so a
 * token minted for one kind of link can never be presented as another even
 * though every kind shares this table.
 */
export interface LinkPayloadKind<Schema extends z.ZodType> {
  readonly prefix: string;
  readonly schema: Schema;
}

/** Short, lowercase, and free of the separator, so the first `_` always splits a token cleanly. */
const PREFIX = /^[a-z][a-z0-9]{1,11}$/u;

/** 256 bits, matching every other bearer secret in this tree: the token is what guards the payload. */
const TOKEN_BYTES = 32;

export function defineLinkPayload<Schema extends z.ZodType>(prefix: string, schema: Schema): LinkPayloadKind<Schema> {
  if (!PREFIX.test(prefix)) throw new Error(`Link payload prefix is invalid: ${prefix}`);
  return { prefix, schema };
}

function token(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

/**
 * Writes the payload and returns the token that reads it back.
 *
 * `expiresAt` is an ISO timestamp the row dies at, for a link whose subject has
 * an expiry of its own. Issuing also drops rows already past their own deadline,
 * so rows that carry one are swept by the writes that grow the table rather than
 * by a schedule nobody owns.
 *
 * **A row issued with `expiresAt: null` is never swept.** Nothing here can know
 * that the thing it addresses has been accepted, revoked or forgotten, so such a
 * row is retained until its issuer discards it by token. Reclaiming the rest
 * would mean deleting on `created_at` age, and that age is a retention number
 * the team sets rather than one this file invents.
 */
export async function issueLinkPayload<Schema extends z.ZodType>(
  db: D1DatabaseLike,
  kind: LinkPayloadKind<Schema>,
  payload: z.infer<Schema>,
  options: { expiresAt?: string | null } = {},
): Promise<string> {
  const parsed = kind.schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(codeShaped(`link_payload_invalid:${kind.prefix}:${describeZodIssues(parsed.error)}`));
  }
  const issued = token(kind.prefix);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO link_payloads (token_hash, type, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(issued), kind.prefix, JSON.stringify(parsed.data), now, options.expiresAt ?? null),
    db.prepare(`DELETE FROM link_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?`).bind(now),
  ]);
  return issued;
}

/**
 * Drops rows by the tokens that read them, for a caller that minted a link and
 * then did not send it.
 *
 * This is the only way a row is reclaimed before its own deadline, and it works
 * only here: a token is never stored, so nothing that holds the payload alone —
 * not the thing the link addresses, not a later revocation of it — can find the
 * row again. A caller that mints speculatively therefore owns cleaning up, for
 * as long as it still holds the token it minted.
 */
export async function discardLinkPayloads(db: D1DatabaseLike, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  const digests = await Promise.all(tokens.map((presented) => sha256Hex(presented)));
  await db.prepare(`DELETE FROM link_payloads WHERE token_hash IN (${digests.map(() => '?').join(', ')})`)
    .bind(...digests).run();
}

/**
 * What a token stands for, or null when this deployment cannot say.
 *
 * Null covers a token of another kind, one edited in transit, one this region
 * never issued and one whose row has expired. They are one answer deliberately:
 * telling them apart tells a holder something about a link they do not have.
 */
export async function openLinkPayload<Schema extends z.ZodType>(
  db: D1DatabaseLike,
  kind: LinkPayloadKind<Schema>,
  presented: string,
  now = new Date(),
): Promise<z.infer<Schema> | null> {
  if (!presented.startsWith(`${kind.prefix}_`)) return null;
  const row = await db.prepare(`SELECT payload FROM link_payloads
    WHERE token_hash = ? AND type = ? AND (expires_at IS NULL OR expires_at > ?)`)
    .bind(await sha256Hex(presented), kind.prefix, now.toISOString()).first<{ payload: string }>();
  if (!row) return null;
  // The row exists, so this deployment wrote it: whatever is wrong with it is
  // drift on our side, not a forged token. Reporting either as one more
  // unreadable token would hide a deploy that stopped honouring every link of
  // this kind already in an inbox — so a payload that is no longer JSON is
  // named the same way a payload that no longer fits its schema is.
  let stored: unknown;
  try {
    stored = JSON.parse(row.payload);
  } catch {
    throw new Error(codeShaped(`link_payload_drifted:${kind.prefix}:-root-:invalid_json`));
  }
  const parsed = kind.schema.safeParse(stored);
  if (parsed.success) return parsed.data;
  throw new Error(codeShaped(`link_payload_drifted:${kind.prefix}:${describeZodIssues(parsed.error)}`));
}
