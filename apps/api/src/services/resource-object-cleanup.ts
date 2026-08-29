import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";

function boundedCleanupErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (typeof candidate === "string" && /^[a-z0-9_.-]{1,120}$/iu.test(candidate)) {
    return candidate.toLowerCase();
  }
  return "r2_delete_failed";
}

/**
 * Hand an object back to the reaper after its publisher knows no pointer was
 * committed. An ambiguous database failure deliberately does not call this:
 * preserving an unreferenced object is recoverable, while deleting bytes a
 * committed pointer may name is not.
 */
export async function releaseStagedResourceObject(
  database: D1Database,
  workspaceId: string,
  objectRef: string,
): Promise<void> {
  await database.prepare(
    `UPDATE resource_object_deletion_outbox
        SET cleanup_eligible = 1, updated_at = ?
      WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
  ).bind(new Date().toISOString(), workspaceId, objectRef).run();
}

/**
 * Register cleanup ownership before an R2 put without duplicating the only
 * safe failure transition in every resource writer.
 *
 * Pointer publication remains caller-owned because its compare-and-swap and
 * ambiguity semantics differ by resource type. A failed put is unambiguous:
 * no later pointer can name bytes this call did not store, so cleanup may take
 * the staged row. Failure to release must not replace the storage error; the
 * durable staging row is the recoverable residue.
 */
export async function putStagedResourceObject(input: {
  database: D1Database;
  payloads: R2Bucket;
  objectRef: string;
  workspaceId: string;
  resourceId: string;
  objectKind: "original" | "derivative" | "receipt";
  value: ArrayBuffer | Uint8Array | string;
  options?: R2PutOptions;
  at: string;
}): Promise<void> {
  try {
    await input.database.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      input.objectRef,
      input.workspaceId,
      input.resourceId,
      input.objectKind,
      input.at,
      input.at,
    ).run();
  } catch (error) {
    // No put was attempted, so even a staging insert that committed before its
    // response was lost can be released without risking referenced bytes.
    await releaseStagedResourceObject(input.database, input.workspaceId, input.objectRef)
      .catch(() => undefined);
    throw error;
  }
  try {
    await input.payloads.put(input.objectRef, input.value, input.options);
  } catch (error) {
    await releaseStagedResourceObject(input.database, input.workspaceId, input.objectRef)
      .catch(() => undefined);
    throw error;
  }
}

/** The WorkspaceDO whose resource inventory a maintenance pass works over. */
function workspaceObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/** Returns how many outbox rows the pass retired; the alarm reads it as progress. */
export async function reapDeletedResourceObjects(env: Env, workspaceId: string): Promise<number> {
  const workspace = await workspaceObject(env, workspaceId);
  const pending = await workspace.listReapableResourceObjects({ workspaceId });
  let retired = 0;
  for (const object of pending.items) {
    try {
      // Whether a pointer still names the object and the retirement of its
      // row are one critical section in the object now; as two statements a
      // resource deletion could promote the row between them. The R2 delete
      // stays between the claim and the final retirement, because the row is
      // the durable record that bytes may still exist.
      const claim = await workspace.claimResourceObjectRemoval({
        workspaceId,
        objectRef: object.object_ref,
      });
      if (claim.outcome === "retired") {
        retired += 1;
        continue;
      }
      // A publisher owns this object until it either commits a resource
      // pointer or explicitly releases the row. The alarm can run between the
      // R2 put and that commit; treating "not active yet" as "abandoned"
      // deletes the bytes underneath the pointer the writer is about to save.
      if (claim.outcome !== "removable") continue;
      await env.PAYLOADS.delete(object.object_ref);
      const settled = await workspace.retireResourceObjectStaging({
        workspaceId,
        objectRef: object.object_ref,
      });
      if (settled.retired) retired += 1;
    } catch (error) {
      const reason = boundedCleanupErrorCode(error);
      await workspace.recordResourceObjectCleanupFailure({
        workspaceId,
        objectRef: object.object_ref,
        errorCode: truncateUtf16Safe(reason, 120),
      });
      logWarn(env, "resource_object_cleanup_failed", {
        resource_id: object.resource_id,
        object_kind: object.object_kind,
        reason,
      });
    }
  }
  return retired;
}

/**
 * Remove unattached upload drafts from one WorkspaceDO; its SQL trigger queues
 * R2 cleanup. Returns how many it removed, which the alarm reads as progress.
 */
export async function reapExpiredDraftResources(env: Env, workspaceId: string): Promise<number> {
  const { removed } = await (await workspaceObject(env, workspaceId))
    .reapExpiredDraftResources({ workspaceId });
  return removed;
}
