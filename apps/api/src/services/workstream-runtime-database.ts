import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import { hostedConversationParentKind } from "../durable-objects/workstream-object-storage";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { conversationObjectName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { WorkstreamProvisionInput } from "../durable-objects/workstream-identity-storage";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

/**
 * The regional work-stream identity anchor: the three routing columns the
 * `workstreams` table has kept since migration 0090 dropped its product
 * columns. Every caller writes it in a batch with the rows that route to it.
 */
export function regionalWorkstreamAnchorStatement(
  env: Pick<Env, "DB">,
  workspaceId: string,
  workstreamId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
     VALUES (?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(workstreamId, workspaceId);
}

/** Commit an anchor with related route statements in one batch. */
export async function writeRegionalWorkstreamAnchorBatch(
  env: Pick<Env, "DB">,
  input: { workspaceId: string; workstreamId: string },
  additionalStatements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return env.DB.batch([
    regionalWorkstreamAnchorStatement(env, input.workspaceId, input.workstreamId),
    ...additionalStatements,
  ]);
}

/** Reserve the regional route and open one empty authoritative work-stream object. */
export async function bootstrapWorkstreamRuntimeEnvironment(
  env: Env,
  workspaceId: string,
  parentId: string,
  parentKind: ConversationParentKind,
): Promise<Env> {
  const authority = await claimParentAnchor(env, workspaceId, parentId);
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)),
  );
  const response = await stub.bootstrapRuntime({
    workspaceId: asWorkspaceId(workspaceId),
    parentKind: hostedConversationParentKind(parentKind),
    parentId,
    generation: authority.generation,
  });
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_bootstrap_failed");
  }
  // Product operations now use typed object ports. The caller keeps its
  // original environment instead of receiving a database-shaped authority
  // overlay whose table-name matcher silently chose a destination.
  return env;
}

/**
 * Write a parent's D1 anchor and regional route, and claim its id against a
 * Channel create that names the same one. Opens no object: a Space is this
 * and nothing more, and a conversation parent is this plus its main object.
 */
export async function claimParentAnchor(
  env: Env,
  workspaceId: string,
  parentId: string,
): Promise<{ generation: number }> {
  const authority = await readWorkstreamAuthorityControl(env);
  const at = new Date().toISOString();
  // A Thread create named its own id and claimed it with a receipt while no
  // anchor had it. The read below is the other half of that claim: anchor
  // first, then refuse if a Thread's receipt already names the id. Threads
  // retired, so no receipt is written any more, but the rows already written
  // still hold their ids. The read rides in the anchor's batch.
  const results = await writeRegionalWorkstreamAnchorBatch(env, { workspaceId, workstreamId: parentId }, [
    parentRouteStatement(env, { workspaceId, parentId, generation: authority.generation, at }),
    env.DB.prepare(
      "SELECT 1 AS claimed FROM workstream_create_receipts WHERE workstream_id = ? LIMIT 1",
    ).bind(parentId),
  ]);
  if ((results[2]?.results?.length ?? 0) > 0) {
    throw new ApiError(409, "workstream_id_unavailable", "This conversation id is already claimed by a thread create");
  }
  return authority;
}

/**
 * A parent's active regional route at `generation`, for a caller writing it in
 * a batch after the parent's anchor.
 */
export function parentRouteStatement(
  env: Pick<Env, "DB" | "AVALON_REGION">,
  input: { workspaceId: string; parentId: string; generation: number; at: string },
): D1PreparedStatement {
  // `workstream_authority_routes` and the `workstreams` anchor are keyed by
  // parent id whatever the kind: every reader of the route (loop activation,
  // socket admission, the notification generation fence) keys on the same id,
  // and the D1 column keeps its name because D1 migrations are immutable.
  const { workspaceId, parentId: workstreamId, at } = input;
  return env.DB.prepare(
    `INSERT OR IGNORE INTO workstream_authority_routes
       (workspace_id, workstream_id, generation, object_name, state, stage_index,
        source_cursor, source_fence_sequence, source_hash, target_hash,
        row_counts_json, imported_at, verified_at, activated_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 'created_in_do', 'created_in_do',
             '{}', ?, ?, ?, ?)`,
  ).bind(
    workspaceId,
    workstreamId,
    input.generation,
    `${env.AVALON_REGION}:${workspaceId}:${workstreamId}`,
    at,
    at,
    at,
    at,
  );
}

/**
 * Open one empty authoritative child conversation under a parent that already
 * has its route.
 *
 * The regional route and the D1 anchor are per parent and were written when
 * the parent's main conversation was bootstrapped; a child needs only its own
 * object opened, knowing which substream it is.
 */
export async function bootstrapConversationChildRuntime(
  env: Env,
  workspaceId: string,
  parentKind: ConversationParentKind,
  parentId: string,
  substreamId: string,
): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), parentId, asSubstreamId(substreamId)),
  );
  const response = await stub.bootstrapRuntime({
    workspaceId: asWorkspaceId(workspaceId),
    parentKind: hostedConversationParentKind(parentKind),
    parentId,
    substreamId,
    generation: authority.generation,
  });
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "conversation_child_bootstrap_failed");
  }
}

/**
 * Pay the child object's cold schema cost without claiming an authority
 * generation. Confirmation performs the fenced authoritative bootstrap.
 */
export async function warmConversationChildRuntime(
  env: Env,
  workspaceId: string,
  parentId: string,
  substreamId: string,
): Promise<{
  objectId: string;
  authorityMode: "unclaimed" | "preparing" | "authoritative";
}> {
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), parentId, asSubstreamId(substreamId)),
  );
  return stub.wake();
}

/**
 * Write what a system-provisioned work stream is, on the object that owns it.
 *
 * The other half of {@link bootstrapWorkstreamRuntimeEnvironment}: that opens an
 * empty authoritative object, and this says what the work stream is and who can
 * see it. Automation, schedule, activity, and digest producers all use the same
 * typed identity operation rather than D1-shaped compatibility views.
 */
export async function provisionWorkstreamObject(
  env: Env,
  input: WorkstreamProvisionInput & { workspaceId: string; workstreamId: string; substreamId?: string },
): Promise<void> {
  const { substreamId, ...provision } = input;
  await createIdentityObjectPort(env, input.workspaceId, input.workstreamId, undefined, substreamId)
    .provision(provision);
}
