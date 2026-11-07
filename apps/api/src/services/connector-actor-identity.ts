import { ExternalActorSchema, type ExternalActor } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../env";
import { withWorkspaceRuntimeDatabase, workspaceRegionalDatabase } from "./workspace-runtime-database";

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
  /** Attribution may resolve a guest, but it cannot automatically seat them. */
  accessClass?: "guest";
}

export interface ConnectorActorResolutionInput {
  actor: ExternalActor;
  verifiedEmail?: string | null;
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
  const [identity] = await resolveConnectorActorIdentities(env, workspaceId, [{
    actor: actorInput,
    ...(verifiedEmail === undefined ? {} : { verifiedEmail }),
  }]);
  return identity ?? null;
}

/**
 * Resolve a whole provider audience with one regional membership read and one
 * WorkspaceDO-local identity read.
 *
 * The precedence is the single-actor resolver's: an explicit Slack account
 * link, a stored connector identity, one unambiguous personal connection, then
 * one unambiguous verified-email member. `json_each` carries the variable-sized
 * input as one bound value, avoiding both SQLite's placeholder ceiling and an
 * N-by-three query fan-out for connector conversations.
 */
export async function resolveConnectorActorIdentities(
  env: Env,
  workspaceId: string,
  inputs: readonly ConnectorActorResolutionInput[],
): Promise<Array<ConnectorActorIdentity | null>> {
  if (inputs.length === 0) return [];
  const requested = inputs.map((input) => {
    const actor = ExternalActorSchema.parse(input.actor);
    return {
      provider: actor.provider,
      providerTenantId: actor.providerAccountId,
      providerUserId: actor.providerUserId,
      verifiedEmail: input.verifiedEmail?.trim().toLowerCase() || null,
    };
  });
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const regionalRows = await workspaceRegionalDatabase(env).prepare(
    `WITH requested AS (
       SELECT CAST(entry.key AS INTEGER) AS request_index,
              CAST(json_extract(entry.value, '$.verifiedEmail') AS TEXT) AS verified_email
       FROM json_each(?) entry
     ), active_members AS (
       SELECT user_id, role FROM workspace_members
       WHERE workspace_id = ? AND status = 'active'
     )
     SELECT -1 AS request_index, member.user_id, 'member' AS row_kind, member.role AS member_role
       FROM active_members member
     UNION ALL
     SELECT requested.request_index, MIN(user.id) AS user_id, 'email' AS row_kind, NULL AS member_role
       FROM requested
       JOIN users user ON lower(user.email) = requested.verified_email
       JOIN active_members member ON member.user_id = user.id
      WHERE requested.verified_email IS NOT NULL
      GROUP BY requested.request_index
     HAVING COUNT(DISTINCT user.id) = 1`,
  ).bind(JSON.stringify(requested), workspaceId).all<{
    request_index: number;
    user_id: string;
    row_kind: "member" | "email";
    member_role: string | null;
  }>();
  const memberIds = (regionalRows.results ?? [])
    .filter((row) => row.row_kind === "member")
    .map((row) => row.user_id);
  if (memberIds.length === 0) return inputs.map(() => null);
  const result = await env.DB.prepare(
    `WITH requested AS (
       SELECT CAST(entry.key AS INTEGER) AS request_index,
              CAST(json_extract(entry.value, '$.provider') AS TEXT) AS provider,
              CAST(json_extract(entry.value, '$.providerTenantId') AS TEXT) AS provider_tenant_id,
              CAST(json_extract(entry.value, '$.providerUserId') AS TEXT) AS provider_user_id,
              CAST(json_extract(entry.value, '$.verifiedEmail') AS TEXT) AS verified_email
       FROM json_each(?) entry
     ), active_members AS (
       SELECT CAST(value AS TEXT) AS user_id FROM json_each(?)
     ), candidate_rows AS (
       SELECT requested.request_index, link.user_id, 1 AS priority,
              'account_link' AS verification_source
       FROM requested
       JOIN slack_user_links link
         ON requested.provider = 'slack'
        AND link.slack_team_id = requested.provider_tenant_id
        AND link.slack_user_id = requested.provider_user_id
       JOIN active_members member ON member.user_id = link.user_id
       WHERE link.workspace_id = ? AND link.status = 'active'
       UNION ALL
       SELECT requested.request_index, identity.user_id, 2 AS priority,
              identity.verification_source
       FROM requested
       JOIN external_user_identities identity
         ON identity.provider = requested.provider
        AND identity.provider_tenant_id = requested.provider_tenant_id
        AND identity.provider_user_id = requested.provider_user_id
       JOIN active_members member ON member.user_id = identity.user_id
       WHERE identity.workspace_id = ?
       UNION ALL
       SELECT requested.request_index, connection.owner_user_id, 3 AS priority,
              'personal_connection' AS verification_source
       FROM requested
       JOIN connector_connections connection
         ON connection.connector_type = requested.provider
        AND json_type(connection.config_json, '$.providerUserId') IS NOT 'null'
        AND COALESCE(json_extract(connection.config_json, '$.providerUserId'), connection.provider_account_id)
            = requested.provider_user_id
        AND COALESCE(json_extract(connection.config_json, '$.providerTenantId'), connection.provider_account_id)
            = requested.provider_tenant_id
       JOIN active_members member ON member.user_id = connection.owner_user_id
       WHERE connection.workspace_id = ? AND connection.scope = 'personal'
         AND connection.status <> 'disabled' AND connection.owner_user_id IS NOT NULL
     ), distinct_candidates AS (
       SELECT DISTINCT request_index, user_id, priority, verification_source
       FROM candidate_rows
     ), counted AS (
       SELECT request_index, user_id, priority, verification_source,
              COUNT(*) OVER (PARTITION BY request_index, priority) AS tier_count
       FROM distinct_candidates
     ), ranked AS (
       SELECT request_index, user_id, verification_source,
              ROW_NUMBER() OVER (PARTITION BY request_index ORDER BY priority) AS choice
       FROM counted
       WHERE tier_count = 1
     )
     SELECT request_index, user_id, verification_source
     FROM ranked WHERE choice = 1`,
  ).bind(
    JSON.stringify(requested),
    JSON.stringify(memberIds),
    workspaceId,
    workspaceId,
    workspaceId,
  ).all<{
    request_index: number;
    user_id: string;
    verification_source: string;
  }>();
  const identities: Array<ConnectorActorIdentity | null> = inputs.map(() => null);
  for (const row of result.results ?? []) {
    const index = Number(row.request_index);
    if (!Number.isInteger(index) || index < 0 || index >= identities.length) continue;
    identities[index] = {
      userId: String(row.user_id),
      verification: storedVerification(String(row.verification_source)),
    };
  }
  for (const row of regionalRows.results ?? []) {
    if (row.row_kind !== "email") continue;
    const index = Number(row.request_index);
    if (!Number.isInteger(index) || index < 0 || index >= identities.length || identities[index]) continue;
    identities[index] = { userId: row.user_id, verification: "verified_email" };
  }
  const guests = new Set(regionalRows.results.filter((row) => row.row_kind === "member" && row.member_role === null)
    .map((row) => row.user_id));
  return identities.map((identity) => identity && guests.has(identity.userId)
    ? { ...identity, accessClass: "guest" as const } : identity);
}

/**
 * `external_user_identities` predates this resolver, and rows written by
 * Suggested Work's identity sync (retired) carry `personal_connector_oauth`
 * and `slack_user_link`. Map every vocabulary onto the strengths above so a
 * stored row is read back at the confidence it was recorded with.
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
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
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
