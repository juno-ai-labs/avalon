import { ScopeGrantSchema } from "@rally/contracts/scope-grants";
import { runInDurableObject } from "cloudflare:test";
import { asWorkspaceId, asUserId, asSubstreamId } from "@rally/contracts";
import type { Env } from "../../src/env";
import { workspaceDOName } from "../../src/durable-objects/names";

/**
 * The Organization object, which hosts every Canvas's and Sidekick's parent
 * in a workspace (and once hosted every Channel's and Space's).
 */
export function hostedParentStub(env: Env, workspaceId: string, region: string = "global") {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(region, asWorkspaceId(workspaceId))));
}

/**
 * A Channel's directory row, the copy a hosted parent reads its title, scope
 * and archive state from. A fixture that writes a parent's own
 * `parent_metadata` row writes this beside it; changing scope or archive
 * state means changing this row.
 */
export function insertChannelRow(
  state: DurableObjectState,
  workstreamId: string,
  title: string,
  scope: "personal" | "workspace" = "personal",
): void {
  state.storage.sql.exec(`INSERT INTO channels
    (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
     title, description, preview, scope, exact_state, last_activity_at,
     origin_type, title_status, latest_attention_ordinal,
     unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
    VALUES (?, 1, 1, ?, 'hash', ?, '', '', ?, 'idle', 0, 'ad_hoc', 'settled', 0, 0, 0, 0, 0)`,
    workstreamId, `event:${workstreamId}`, title, scope);
}

/** Canonical grant setup for directory-only fixtures with no conversation source.
 * Runtime handoff fixtures provision a real AgentLoopDO instead. */
export async function seedParticipantGrants(
  env: Env, workspaceId: string, parentId: string, userIds: readonly string[], substreamId?: string,
): Promise<void> {
  const members = await env.DB.prepare("SELECT user_id, incarnation FROM workspace_members WHERE workspace_id = ?")
    .bind(workspaceId).all<{ user_id: string; incarnation: string }>();
  const incarnations = new Map(members.results.map((row) => [row.user_id, row.incarnation]));
  await runInDurableObject(hostedParentStub(env, workspaceId), (_instance, state) => {
    for (const rawUserId of userIds) {
      const userId = asUserId(rawUserId);
      const incarnation = incarnations.get(userId);
      if (!incarnation) throw new Error("fixture_membership_incarnation_missing");
      const target = substreamId === undefined ? { kind: "workstream" as const, workspaceId: asWorkspaceId(workspaceId), parentId }
        : { kind: "conversation" as const, workspaceId: asWorkspaceId(workspaceId), parentId, substreamId: asSubstreamId(substreamId) };
      const grant = ScopeGrantSchema.parse({ id: crypto.randomUUID(), userId, target, active: true, revision: 1, membershipIncarnation: incarnation });
      // A settled directory fixture: grant rows are present without inventing
      // in-flight delivery jobs or a conversation source these reads never use.
      state.storage.sql.exec(`INSERT INTO parent_grants(parent_id,user_id,scope_kind,substream_id,grant_json)
        VALUES (?,?,?,?,?) ON CONFLICT(parent_id,user_id,scope_kind,substream_id) DO UPDATE SET grant_json=excluded.grant_json`,
        parentId, userId, target.kind, substreamId ?? "", JSON.stringify(grant));
    }
  });
}
