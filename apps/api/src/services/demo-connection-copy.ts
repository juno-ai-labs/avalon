import { z } from "zod";

import type { Env } from "../env";
import { decryptVersionedCredentialValue } from "./connector-credential-envelope";
import { encryptString } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";

/**
 * Copying the template's connections into a new demo workspace.
 *
 * A demo answers a presenter's question for real, so the copies carry their
 * credentials rather than only the account label. That means re-encryption
 * rather than a row copy: the envelope's additional authenticated data is the
 * **connection ID**, not the workspace ID, so ciphertext moved to a new row
 * simply will not decrypt.
 *
 * The one trap here is the helper this reaches for.
 * `decryptVersionedConnectorCredentials` opportunistically re-encrypts under the
 * active key and writes the result back to the row it read, whenever the stored
 * key version is stale. Called on a template connection that is one rotation
 * behind, preparing a demo would silently rewrite the template's ciphertext, IV,
 * key version and `updated_at` — a write into the one workspace this whole
 * feature exists to leave alone. `decryptVersionedCredentialValue` is the
 * non-writing variant, takes the same arguments, and returns the same
 * plaintext. It is the only one this module may use, and the acceptance test
 * for it exercises the stale-key case specifically, because that is the only
 * case in which the difference shows.
 *
 * The copies are workspace-scoped. A presenter opens a demo as themselves and
 * owns none of the cast's connections, and a personal connection can be used
 * only by its owner — so personal copies would leave the presenter looking at a
 * workspace with no connectors at all.
 *
 * Which is also why a *personal* connection in the template is skipped rather
 * than copied. Rewriting one as workspace-scoped is the only way to make it
 * usable in the demo, and that hands one person's refresh token to everybody in
 * that workspace. The template's own owner can share it deliberately by
 * reconnecting it at workspace scope; nothing here may make that decision for
 * them. Skipped connections are returned rather than dropped, because "the demo
 * has no Slack" is something the operator needs to be told before the meeting
 * rather than during it.
 */

/** Columns that describe the connection rather than its history. */
const CLONED_COLUMNS = [
  "connector_type",
  "display_name",
  "provider_account_id",
  "granted_scopes_json",
  "config_json",
  "model_plugin_id",
] as const;

/** Why a template connection was left behind. */
export const SkippedConnectionSchema = z.strictObject({
  sourceConnectionId: z.string().min(1),
  connectorType: z.string().min(1),
  displayName: z.string(),
  reason: z.literal("personal_scope"),
});
export type SkippedConnection = z.infer<typeof SkippedConnectionSchema>;

export const CopiedConnectionSchema = z.strictObject({
  sourceConnectionId: z.string().min(1),
  destinationConnectionId: z.string().min(1),
  connectorType: z.string().min(1),
  displayName: z.string(),
  carriesCredentials: z.boolean(),
});
export type CopiedConnection = z.infer<typeof CopiedConnectionSchema>;

export interface ConnectionCopyResult {
  copied: CopiedConnection[];
  skipped: SkippedConnection[];
}

interface SourceConnectionRow {
  id: string;
  workspace_id: string;
  connector_type: string;
  scope: string;
  owner_user_id: string | null;
  status: string;
  provider_account_id: string | null;
  display_name: string;
  encrypted_credentials: string | null;
  credential_iv: string | null;
  credential_key_version: number | null;
  granted_scopes_json: string;
  config_json: string;
  model_plugin_id: string;
}

export interface ConnectionCopyInput {
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  /**
   * One handle per workspace, because they are two different authorities.
   *
   * `connector_connections` lives in each WorkspaceDO's own SQLite rather than
   * regional D1, so a single `env.DB` cannot see both sides of this copy. The
   * caller resolves each through `workspaceRuntimeDatabase`, which is also what
   * keeps the routing rule honest: nothing here joins across the two.
   */
  sourceDb: D1Database;
  destinationDb: D1Database;
  now: string;
}

/**
 * Copy every selected template connection into the destination workspace.
 *
 * Idempotent on the destination: a resumed preparation finds the connections
 * the first pass wrote — matched by their source's model plugin id, which is
 * unique per workspace — and does not create a second set beside them.
 */
export async function copyTemplateConnections(
  env: Env,
  input: ConnectionCopyInput,
): Promise<ConnectionCopyResult> {
  const sources = await readSourceConnections(input);
  const copied: CopiedConnection[] = [];
  const skipped: SkippedConnection[] = [];

  for (const source of sources) {
    if (source.scope !== "workspace") {
      skipped.push(SkippedConnectionSchema.parse({
        sourceConnectionId: source.id,
        connectorType: source.connector_type,
        displayName: source.display_name,
        reason: "personal_scope",
      }));
      continue;
    }
    const existing = await input.destinationDb.prepare(
      `SELECT id, encrypted_credentials FROM connector_connections
        WHERE workspace_id = ? AND model_plugin_id = ? AND status <> 'disabled'`,
    ).bind(input.destinationWorkspaceId, source.model_plugin_id)
      .first<{ id: string; encrypted_credentials: string | null }>();
    if (existing) {
      copied.push(CopiedConnectionSchema.parse({
        sourceConnectionId: source.id,
        destinationConnectionId: existing.id,
        connectorType: source.connector_type,
        displayName: source.display_name,
        // Read, not assumed. A resumed pass that reported credentials it never
        // looked at would tell an operator the demo can answer a question it
        // cannot.
        carriesCredentials: existing.encrypted_credentials !== null,
      }));
      continue;
    }

    const destinationId = uuidV7();
    const envelope = await reEncryptForDestination(env, source, destinationId);

    await input.destinationDb.prepare(
      `INSERT INTO connector_connections (
         id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, model_plugin_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'workspace', NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    ).bind(
      destinationId,
      input.destinationWorkspaceId,
      source.connector_type,
      source.provider_account_id,
      source.display_name,
      envelope?.ciphertext ?? null,
      envelope?.iv ?? null,
      envelope?.keyVersion ?? null,
      source.granted_scopes_json,
      // The template's own health, not an assertion of it. A connection that
      // needs reconnecting copies as one, so the operator finds out while
      // preparing rather than mid-demo.
      source.status,
      source.config_json,
      source.model_plugin_id,
      input.now,
      input.now,
    ).run();

    copied.push(CopiedConnectionSchema.parse({
      sourceConnectionId: source.id,
      destinationConnectionId: destinationId,
      connectorType: source.connector_type,
      displayName: source.display_name,
      carriesCredentials: envelope !== null,
    }));
  }

  return { copied, skipped };
}

async function readSourceConnections(
  input: ConnectionCopyInput,
): Promise<SourceConnectionRow[]> {
  const columns = ["id", "workspace_id", "scope", "owner_user_id", "status", "encrypted_credentials",
    "credential_iv", "credential_key_version", ...CLONED_COLUMNS].join(", ");
  const all = await input.sourceDb.prepare(
    `SELECT ${columns} FROM connector_connections
      WHERE workspace_id = ? AND status <> 'disabled'
      ORDER BY id`,
  ).bind(input.sourceWorkspaceId).all<SourceConnectionRow>();
  return all.results ?? [];
}

/**
 * Decrypt under the source's identity, re-encrypt under the destination's.
 *
 * The non-writing decrypt is the requirement, not an implementation detail —
 * see this module's header. A source with no credential material copies as a
 * connection with none rather than failing: a template connection can legally
 * be mid-setup, and a demo without that one provider is a better outcome than a
 * preparation that cannot finish.
 */
async function reEncryptForDestination(
  env: Env,
  source: SourceConnectionRow,
  destinationConnectionId: string,
): Promise<{ ciphertext: string; iv: string; keyVersion: number } | null> {
  if (!source.encrypted_credentials || !source.credential_iv) return null;
  const plaintext = await decryptVersionedCredentialValue(
    env,
    {
      encrypted_credentials: source.encrypted_credentials,
      credential_iv: source.credential_iv,
      credential_key_version: source.credential_key_version,
    },
    // The source's own id: what the envelope was sealed against.
    source.id,
  );
  const replacement = await encryptString(
    plaintext,
    env.CONNECTOR_CREDENTIALS_KEY,
    // The destination's id, which is what makes the copy a different envelope
    // rather than the same bytes in a new row.
    destinationConnectionId,
  );
  return {
    ciphertext: replacement.ciphertext,
    iv: replacement.iv,
    keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
  };
}
