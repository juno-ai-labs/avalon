import { ScopeGrantSchema } from "@rally/contracts/scope-grants";
import { runInDurableObject } from "cloudflare:test";
import { asWorkspaceId, asUserId, asSubstreamId } from "@rally/contracts";
import type { ListVisiblePrivateChildrenRequest } from "@rally/contracts/conversation-parent";
import type { Env } from "../../src/env";
import type { HostedParent } from "../../src/durable-objects/hosted-parent";
import { workspaceDOName } from "../../src/durable-objects/names";

/**
 * The Organization object that hosts every Channel and Space parent in a
 * workspace. A test that used to address a `WorkstreamDO` or `SpaceDO` stub
 * addresses this one with the same method names.
 */
export function hostedParentStub(env: Env, workspaceId: string, region: string = "global") {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(region, asWorkspaceId(workspaceId))));
}

/** One Channel's shared directory, through the batch RPC production calls. */
export async function readSharedWorkstream(
  stub: ReturnType<typeof hostedParentStub>,
  { parentId, ...request }: Parameters<HostedParent["readSharedWorkstream"]>[0],
) {
  return (await stub.readSharedWorkstreams({ ...request, parentIds: [parentId] }))[0] ?? null;
}

/** One parent's Breakouts a person may open, through the batch RPC production calls. */
export async function listVisiblePrivateChildren(
  stub: ReturnType<typeof hostedParentStub>,
  { parentId, ...request }: ListVisiblePrivateChildrenRequest,
) {
  const { parents } = await stub.listVisiblePrivateChildrenForParents({ ...request, parentIds: [parentId] });
  return { children: parents[0]!.children };
}

/**
 * Runs `fn` inside the Organization object with the hosted parent for
 * `parentId`, for a test that reads or drives the parent's internals directly.
 * Every parent row is keyed by `parent_id`; filter by it.
 */
export async function withHostedParent<T>(
  stub: DurableObjectStub,
  parentId: string,
  fn: (parent: HostedParent, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, async (instance, state) => {
    const host = instance as unknown as { hostedParent(parentId: string): Promise<HostedParent> };
    return fn(await host.hostedParent(parentId), state);
  });
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
 * Runtime handoff fixtures provision a real SubstreamAgent instead. */
export async function seedParticipantGrants(
  env: Env, workspaceId: string, parentId: string, userIds: readonly string[], substreamId?: string,
): Promise<void> {
  const members = await env.DB.prepare("SELECT user_id, incarnation FROM workspace_members WHERE workspace_id = ?")
    .bind(workspaceId).all<{ user_id: string; incarnation: string }>();
  const incarnations = new Map(members.results.map((row) => [row.user_id, row.incarnation]));
  await withHostedParent(hostedParentStub(env, workspaceId), parentId, (_parent, state) => {
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
