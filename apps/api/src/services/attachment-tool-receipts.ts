import {
  WorkstreamReadResourceOutputSchema,
  WorkstreamViewResourceOutputSchema,
  type ExecutionPrincipal,
} from "@rally/contracts";
import { z } from "zod";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import { createToolReceiptObjectPort } from "../runtime/tool-receipt-port";
import type { Env } from "../env";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";

interface ReceiptDependency {
  resourceId: string;
  derivativeSha256: string;
}

export type AttachmentReceiptReplayValidation = "not_attachment" | "valid" | "invalid";

/**
 * Which resource versions a replayable attachment read depended on, and whether
 * they still hold.
 *
 * Two things about this module are easy to get wrong and expensive to get wrong.
 *
 * **The digest comparison is the only invalidation there is.** D1 migration 0073
 * carried a trigger that deleted these receipts eagerly whenever a resource's
 * `model_content_sha256` changed. It has no successor and cannot have one:
 * receipts live in the work-stream object and resources live in the workspace
 * object, so no trigger spans them. Comparing at read time is now the whole
 * mechanism. Simplifying it away puts a stale derivative in front of the model.
 *
 * **The read and the write cannot be one transaction, and never were.** The
 * digest lives in the workspace object; the receipt rows live here. This checks
 * the first, writes the second, and re-checks — which is why
 * `clearAttachmentDependencies` exists as its own operation rather than being
 * folded into the write it compensates for.
 *
 * An earlier version of this file carried a second implementation of all three
 * functions, selected by comparing a routed database to its regional backing. That arm read
 * `model_content_sha256` through `_runtime_resources`, which fabricates it as
 * `NULL` — and was widely believed, including by this repository's own PRD, to
 * mean the comparison always failed. It never ran: the guard is false for every
 * routed environment by construction, and migration 0090 dropped the tables it
 * named. It is deleted rather than converted.
 */
interface ReceiptTarget {
  workspaceId: string;
  workstreamId: string;
}

function port(env: Env, target: ReceiptTarget, override?: ToolReceiptObjectPort): ToolReceiptObjectPort {
  return override ?? createToolReceiptObjectPort(env, target.workspaceId, target.workstreamId);
}

export async function registerAttachmentToolReceipt(
  env: Env,
  input: ReceiptTarget & {
    invocationId: string;
    expectedOutputRef: string;
    canonicalToolName: string;
    output: unknown;
  },
  receipts: ToolReceiptObjectPort = createToolReceiptObjectPort(
    env,
    input.workspaceId,
    input.workstreamId,
  ),
): Promise<void> {
  const dependencies = attachmentReceiptDependencies(input.canonicalToolName, input.output);
  if (dependencies.length === 0) return;

  const recorded = await receipts.recordAttachmentDependencies({
    workspaceId: input.workspaceId,
    effectIntentId: input.invocationId,
    dependencies,
    expectedOutputRef: input.expectedOutputRef,
    now: Date.now(),
  });
  if (recorded === "receipt_missing") throw new Error("attachment_receipt_version_changed");

  // The digests are re-read after the rows land, not before. Reading first would
  // not make this atomic — the digest is in another object either way — and
  // checking after means a version that moved during the write is caught by the
  // same code path as one that moved before it.
  for (const dependency of dependencies) {
    const resource = await env.DB.prepare(
      `SELECT model_content_sha256 FROM resources
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, dependency.resourceId)
      .first<{ model_content_sha256: string | null }>();
    if (resource?.model_content_sha256 !== dependency.derivativeSha256) {
      // All of them, not just this one: a multi-image `view_resource` replay is
      // only valid if every dependency still holds, so a partial receipt would
      // be worse than none.
      await receipts.clearAttachmentDependencies({
        workspaceId: input.workspaceId,
        effectIntentId: input.invocationId,
        expectedOutputRef: input.expectedOutputRef,
      });
      throw new Error("attachment_receipt_version_changed");
    }
  }
}

export async function validateAttachmentToolReceiptReplay(
  env: Env,
  input: ReceiptTarget & {
    principal: ExecutionPrincipal;
    invocationId: string;
    capability: string;
  },
  receipts?: ToolReceiptObjectPort,
): Promise<AttachmentReceiptReplayValidation> {
  if (!input.capability.startsWith("workstream.resources.")) return "not_attachment";
  // A listing names no resource, so it records no dependency and can never be
  // proved still-current.
  if (input.capability === "workstream.resources.list") return "invalid";

  const dependencies = await port(env, input, receipts).attachmentDependencies({
    workspaceId: input.workspaceId,
    effectIntentId: input.invocationId,
  });
  // Empty means either "no dependencies recorded" or "the receipt has not
  // completed". The caller must not be able to tell those apart: neither is
  // replayable.
  if (dependencies.length === 0) return "invalid";

  const visible = await loadVisibleWorkstreamResourcesByIds(
    env.DB,
    createConversationResourceLinks(env, input.workspaceId, input.workstreamId, undefined, undefined, input.principal),
    {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      principal: input.principal,
      resourceIds: dependencies.map((dependency) => dependency.resourceId),
    },
  );
  const visibleIds = new Set(visible.map((resource) => resource.id));
  for (const dependency of dependencies) {
    if (!visibleIds.has(dependency.resourceId)) return "invalid";
    const resource = await env.DB.prepare(
      `SELECT model_content_sha256 FROM resources
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, dependency.resourceId)
      .first<{ model_content_sha256: string | null }>();
    if (resource?.model_content_sha256 !== dependency.derivativeSha256) return "invalid";
  }
  return "valid";
}

export async function invalidateAttachmentToolReplay(
  env: Env,
  input: ReceiptTarget & { invocationId: string },
  receipts?: ToolReceiptObjectPort,
): Promise<void> {
  // Delete first, then queue the payload. The routed version enqueued the
  // outbox row from inside the same batch that deleted the receipt, so a failed
  // delete stranded a deletion request against a receipt that still existed.
  const discarded = await port(env, input, receipts).discardReceipt({
    workspaceId: input.workspaceId,
    effectIntentId: input.invocationId,
  });
  if (!discarded.outputRef) return;
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO resource_object_deletion_outbox
       (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
     VALUES (?, ?, ?, 'receipt', ?, ?)`,
  ).bind(
    discarded.outputRef,
    input.workspaceId,
    `attachment-receipt:${input.invocationId}`,
    at,
    at,
  ).run();
}


function attachmentReceiptDependencies(canonicalToolName: string, output: unknown): ReceiptDependency[] {
  if (["read_resource", "read_resource_next", "read_resource_previous", "search_resource", "summarize_resource"].includes(canonicalToolName)) {
    // Receipt dependencies are independent of the model-facing pagination
    // envelope. This also accepts completed receipts from before page IDs.
    const parsed = z.object({ resourceId: WorkstreamReadResourceOutputSchema.shape.resourceId,
      version: WorkstreamReadResourceOutputSchema.shape.version,
    }).safeParse(output);
    return parsed.success ? [{ resourceId: parsed.data.resourceId, derivativeSha256: parsed.data.version.sha256 }] : [];
  }
  if (canonicalToolName === "view_resource") {
    const parsed = WorkstreamViewResourceOutputSchema.safeParse(output);
    // A mixed result discloses metadata for skipped resources as well as bytes
    // for included images. Do not make that JSON replayable unless every input
    // has a derivative dependency that can be reauthorized.
    return parsed.success && parsed.data.items.every((item) => item.status === "included" && item.version)
      ? parsed.data.items.flatMap((item) => item.status === "included" && item.version
        ? [{ resourceId: item.resourceId, derivativeSha256: item.version.sha256 }]
        : [])
      : [];
  }
  return [];
}

export const __attachmentToolReceiptTesting = { attachmentReceiptDependencies };
