import { ExternalActorSchema, type ExternalActor } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { Env } from "../env";

/**
 * How a provider identity was mapped to an Avalon member, strongest first. The
 * value is stored as `external_user_identities.verification_source` so the
 * mapping is auditable and reusable by every connector.
 */
export type ConnectorActorVerification =
  | "account_link"
  | "personal_connection"
  | "verified_email";

export interface ConnectorActorIdentity {
  userId: string;
  verification: ConnectorActorVerification;
}

/**
 * Resolves the Avalon member behind a connector's external actor. This is the
 * one mapping every connector uses — Slack today, Linear and the rest as their
 * agent surfaces land — so a work stream started from a connected tool is
 * attributed to the person who started it instead of appearing ownerless.
 *
 * It is deliberately attribution-only. A resolved member does not authenticate
 * the actor, does not authorize that member's personal connections, and never
 * changes an execution principal; a provider identity Avalon cannot map stays
 * unresolved rather than being guessed.
 */
export async function resolveConnectorActorIdentity(
  env: Env,
  workspaceId: string,
  actorInput: ExternalActor,
  verifiedEmail?: string | null,
): Promise<ConnectorActorIdentity | null> {
  const actor = ExternalActorSchema.parse(actorInput);
  const linked = await env.DB.prepare(
    `SELECT i.user_id, i.verification_source FROM external_user_identities i
     JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = i.user_id
     WHERE i.workspace_id = ? AND i.provider = ? AND i.provider_tenant_id = ?
       AND i.provider_user_id = ? AND wm.status = 'active'
     LIMIT 1`,
  ).bind(workspaceId, actor.provider, actor.providerAccountId, actor.providerUserId)
    .first<{ user_id: string; verification_source: string }>();
  if (linked) {
    return {
      userId: String(linked.user_id),
      verification: storedVerification(String(linked.verification_source)),
    };
  }

  // A healthy personal connection is that member's own provider account, so an
  // actor matching it is that member by the same authorization they granted.
  // Connections are matched on the normalized identity every OAuth callback
  // writes to `config_json` — `provider_account_id` is provider-shaped
  // (`<team>:<user>` for Slack, an organization for Linear) and is not the
  // actor's identity on its own.
  const personal = await env.DB.prepare(
    `SELECT c.owner_user_id FROM connector_connections c
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = c.owner_user_id
     WHERE c.workspace_id = ? AND c.connector_type = ? AND c.scope = 'personal'
       AND c.status = 'healthy' AND c.owner_user_id IS NOT NULL AND wm.status = 'active'
       AND COALESCE(json_extract(c.config_json, '$.providerUserId'), c.provider_account_id) = ?
       AND COALESCE(json_extract(c.config_json, '$.providerTenantId'), c.provider_account_id) = ?
     LIMIT 2`,
  ).bind(workspaceId, actor.provider, actor.providerUserId, actor.providerAccountId)
    .all<{ owner_user_id: string }>();
  const personalMatches = personal.results ?? [];
  if (personalMatches.length === 1 && personalMatches[0]) {
    return { userId: String(personalMatches[0].owner_user_id), verification: "personal_connection" };
  }

  const email = verifiedEmail?.trim().toLowerCase();
  if (!email) return null;
  // Exactly one active member may claim an address. An ambiguous or unknown
  // address resolves to nobody rather than to a plausible member.
  const matches = await env.DB.prepare(
    `SELECT u.id FROM users u
     JOIN workspace_members wm ON wm.user_id = u.id
     WHERE wm.workspace_id = ? AND wm.status = 'active' AND lower(u.email) = ?
     LIMIT 2`,
  ).bind(workspaceId, email).all<{ id: string }>();
  const emailMatches = matches.results ?? [];
  if (emailMatches.length !== 1 || !emailMatches[0]) return null;
  return { userId: String(emailMatches[0].id), verification: "verified_email" };
}

/**
 * `external_user_identities` predates this resolver and has other writers:
 * `syncVerifiedIdentityDirectory` records `personal_connector_oauth` and
 * `slack_user_link`. Map every vocabulary onto the strengths above so a stored
 * row is read back at the confidence it was recorded with, whoever wrote it.
 */
function storedVerification(source: string): ConnectorActorVerification {
  if (source === "verified_email") return "verified_email";
  if (source === "personal_connection" || source === "personal_connector_oauth") {
    return "personal_connection";
  }
  return "account_link";
}

/**
 * Persists a provider lookup that has no other durable home, so later work by
 * the same provider identity — in any connector surface — reuses it.
 *
 * Only a `verified_email` resolution is worth storing. The stronger tiers are
 * already derivable: an account link is a stored row or a `slack_user_links`
 * entry the directory sync republishes, and a personal connection is the
 * connection row itself. Re-recording them would add a write to every inbound
 * provider message, churn the `updated_at` ordering the opportunity directory
 * reads, and overwrite another writer's label with a synonym of it.
 *
 * The upsert is monotonic for the same reason the caller is narrow: an address
 * can legitimately belong to a member other than the one that provider identity
 * is linked to, so a weaker observation must never retarget a stored mapping.
 */
export async function recordConnectorActorIdentity(
  env: Env,
  workspaceId: string,
  actorInput: ExternalActor,
  identity: ConnectorActorIdentity,
  verifiedEmail?: string | null,
): Promise<void> {
  if (identity.verification !== "verified_email") return;
  const actor = ExternalActorSchema.parse(actorInput);
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO external_user_identities
     (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
      handle, email, display_name, verification_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider, provider_tenant_id, provider_user_id) DO UPDATE SET
       user_id = excluded.user_id,
       email = COALESCE(excluded.email, external_user_identities.email),
       display_name = COALESCE(excluded.display_name, external_user_identities.display_name),
       verification_source = excluded.verification_source,
       updated_at = excluded.updated_at
     WHERE excluded.verification_source != 'verified_email'
        OR external_user_identities.verification_source = 'verified_email'`,
  ).bind(
    newId(),
    workspaceId,
    identity.userId,
    actor.provider,
    actor.providerAccountId,
    actor.providerUserId,
    verifiedEmail?.trim().toLowerCase() ?? null,
    actor.displayName,
    identity.verification,
    at,
    at,
  ).run();
}
