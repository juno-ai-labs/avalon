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
 * an expiry of its own; null keeps the row until whatever it points at refuses
 * it. Issuing also drops rows that are already past their own deadline, so the
 * table is swept by the writes that grow it rather than by a schedule.
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
  const parsed = kind.schema.safeParse(JSON.parse(row.payload));
  if (parsed.success) return parsed.data;
  // The row exists, so this deployment wrote it: the shape this prefix promises
  // has drifted from the shape it was written with. Reporting that as one more
  // unreadable token would hide a deploy that stopped honouring every link of
  // this kind already in an inbox.
  throw new Error(codeShaped(`link_payload_drifted:${kind.prefix}:${describeZodIssues(parsed.error)}`));
}
