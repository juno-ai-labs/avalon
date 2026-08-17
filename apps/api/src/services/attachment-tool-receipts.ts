import {
  WorkstreamReadResourceOutputSchema,
  WorkstreamSearchResourceOutputSchema,
  WorkstreamSummarizeResourceOutputSchema,
  WorkstreamViewResourceOutputSchema,
  type ExecutionPrincipal,
} from "@avalon/contracts";
import type { Env } from "../env";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";
import { regionalDatabase } from "./workstream-runtime-database";

interface ReceiptDependency {
  resourceId: string;
  derivativeSha256: string;
}

export type AttachmentReceiptReplayValidation = "not_attachment" | "valid" | "invalid";

export async function registerAttachmentToolReceipt(
  target: D1Database | Env,
  input: {
    workspaceId: string;
    invocationId: string;
    canonicalToolName: string;
    output: unknown;
  },
): Promise<void> {
  if (isEnv(target) && regionalDatabase(target) !== target.DB) {
    return registerObjectAttachmentToolReceipt(target, input);
  }
  const database = isEnv(target) ? target.DB : target;
  const dependencies = attachmentReceiptDependencies(input.canonicalToolName, input.output);
  if (dependencies.length === 0) return;
  const at = new Date().toISOString();
  const results = await database.batch(dependencies.map((dependency) => database.prepare(
    `INSERT INTO attachment_tool_receipts
      (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
     SELECT resource.workspace_id, resource.id, invocation.id, ?, ?
       FROM resources resource
       JOIN tool_invocations invocation
         ON invocation.id = ?
        AND invocation.workspace_id = resource.workspace_id
      WHERE resource.workspace_id = ?
        AND resource.id = ?
        AND resource.model_content_sha256 = ?
     ON CONFLICT(resource_id, tool_invocation_id)
     DO UPDATE SET derivative_sha256 = excluded.derivative_sha256`,
  ).bind(
    dependency.derivativeSha256,
    at,
    input.invocationId,
    input.workspaceId,
    dependency.resourceId,
    dependency.derivativeSha256,
  )));
  if (results.some((result) => (result.meta.changes ?? 0) === 0)) {
    await database.prepare(
      "DELETE FROM attachment_tool_receipts WHERE workspace_id = ? AND tool_invocation_id = ?",
    ).bind(input.workspaceId, input.invocationId).run();
    throw new Error("attachment_receipt_version_changed");
  }
}

export async function validateAttachmentToolReceiptReplay(
  target: D1Database | Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    invocationId: string;
    capability: string;
  },
): Promise<AttachmentReceiptReplayValidation> {
  if (isEnv(target) && regionalDatabase(target) !== target.DB) {
    return validateObjectAttachmentToolReceiptReplay(target, input);
  }
  const database = isEnv(target) ? target.DB : target;
  if (!input.capability.startsWith("workstream.resources.")) return "not_attachment";
  if (input.capability === "workstream.resources.list") return "invalid";
  const result = await database.prepare(
    `SELECT receipt.resource_id, receipt.derivative_sha256, resource.model_content_sha256,
            CASE WHEN EXISTS (
              SELECT 1
                FROM workstream_resources wr
                JOIN workstreams workstream
                  ON workstream.id = wr.workstream_id
                 AND workstream.workspace_id = receipt.workspace_id
               WHERE wr.workstream_id = ?3
                 AND wr.resource_id = receipt.resource_id
                 AND (resource.provider != 'avalon_note' OR EXISTS (
                   SELECT 1 FROM notes visible_note
                    WHERE visible_note.resource_id = resource.id
                      AND visible_note.workspace_id = receipt.workspace_id
                      AND visible_note.workspace_id = resource.workspace_id
                      AND visible_note.archived_at IS NULL
                      AND (visible_note.scope = 'workspace' OR visible_note.owner_user_id = ?4)
                 ))
            ) THEN 1 ELSE 0 END AS visible
       FROM attachment_tool_receipts receipt
       JOIN resources resource ON resource.id = receipt.resource_id
       JOIN tool_invocations invocation
         ON invocation.id = receipt.tool_invocation_id
        AND invocation.workspace_id = receipt.workspace_id
        AND invocation.workstream_id = ?3
        AND invocation.status = 'completed'
      WHERE receipt.workspace_id = ?1
        AND resource.workspace_id = receipt.workspace_id
        AND receipt.tool_invocation_id = ?2
      ORDER BY receipt.resource_id ASC`,
  ).bind(
    input.workspaceId,
    input.invocationId,
    input.workstreamId,
    input.principal.type === "user" ? input.principal.userId : null,
  ).all<{
    resource_id: string;
    derivative_sha256: string;
    model_content_sha256: string | null;
    visible: number;
  }>();
  const dependencies = result.results ?? [];
  if (dependencies.length === 0) return "invalid";
  return dependencies.every((dependency) =>
    dependency.visible === 1
    && dependency.model_content_sha256 === dependency.derivative_sha256
  ) ? "valid" : "invalid";
}

export async function invalidateAttachmentToolReplay(
  target: D1Database | Env,
  workspaceId: string,
  invocationId: string,
): Promise<void> {
  if (isEnv(target) && regionalDatabase(target) !== target.DB) {
    return invalidateObjectAttachmentToolReplay(target, workspaceId, invocationId);
  }
  const database = isEnv(target) ? target.DB : target;
  const at = new Date().toISOString();
  await database.batch([
    database.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       SELECT output_ref, workspace_id, 'attachment-receipt:' || id, 'receipt', ?, ?
         FROM tool_invocations
        WHERE workspace_id = ? AND id = ? AND output_ref IS NOT NULL`,
    ).bind(at, at, workspaceId, invocationId),
    database.prepare(
      "DELETE FROM tool_invocations WHERE workspace_id = ? AND id = ?",
    ).bind(workspaceId, invocationId),
  ]);
}

function isEnv(target: D1Database | Env): target is Env {
  return "DB" in target;
}

async function registerObjectAttachmentToolReceipt(
  env: Env,
  input: {
    workspaceId: string;
    invocationId: string;
    canonicalToolName: string;
    output: unknown;
  },
): Promise<void> {
  const dependencies = attachmentReceiptDependencies(input.canonicalToolName, input.output);
  if (dependencies.length === 0) return;
  const invocation = await env.DB.prepare(
    `SELECT id FROM tool_invocations
      WHERE workspace_id = ? AND id = ?`,
  ).bind(input.workspaceId, input.invocationId).first<{ id: string }>();
  if (!invocation) throw new Error("attachment_receipt_version_changed");
  const regional = regionalDatabase(env);
  for (const dependency of dependencies) {
    const resource = await regional.prepare(
      `SELECT model_content_sha256 FROM resources
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, dependency.resourceId)
      .first<{ model_content_sha256: string | null }>();
    if (resource?.model_content_sha256 !== dependency.derivativeSha256) {
      await env.DB.prepare(
        "DELETE FROM attachment_tool_receipts WHERE workspace_id = ? AND tool_invocation_id = ?",
      ).bind(input.workspaceId, input.invocationId).run();
      throw new Error("attachment_receipt_version_changed");
    }
  }
  const at = Date.now();
  await env.DB.batch(dependencies.map((dependency) => env.DB.prepare(
    `INSERT INTO attachment_tool_receipts
       (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(resource_id, tool_invocation_id) DO UPDATE SET
       derivative_sha256 = excluded.derivative_sha256`,
  ).bind(
    input.workspaceId,
    dependency.resourceId,
    input.invocationId,
    dependency.derivativeSha256,
    at,
  )));
}

async function validateObjectAttachmentToolReceiptReplay(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    invocationId: string;
    capability: string;
  },
): Promise<AttachmentReceiptReplayValidation> {
  if (!input.capability.startsWith("workstream.resources.")) return "not_attachment";
  if (input.capability === "workstream.resources.list") return "invalid";
  const receipts = await env.DB.prepare(
    `SELECT receipt.resource_id, receipt.derivative_sha256
       FROM attachment_tool_receipts receipt
       JOIN tool_invocations invocation ON invocation.id = receipt.tool_invocation_id
      WHERE receipt.workspace_id = ? AND receipt.tool_invocation_id = ?
        AND invocation.workstream_id = ? AND invocation.status = 'completed'
      ORDER BY receipt.resource_id`,
  ).bind(input.workspaceId, input.invocationId, input.workstreamId).all<{
    resource_id: string;
    derivative_sha256: string;
  }>();
  const dependencies = receipts.results ?? [];
  if (dependencies.length === 0) return "invalid";
  const visible = await loadVisibleWorkstreamResourcesByIds(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.principal,
    resourceIds: dependencies.map((dependency) => dependency.resource_id),
  });
  const visibleIds = new Set(visible.map((resource) => resource.id));
  const regional = regionalDatabase(env);
  for (const dependency of dependencies) {
    if (!visibleIds.has(dependency.resource_id)) return "invalid";
    const resource = await regional.prepare(
      `SELECT model_content_sha256 FROM resources
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, dependency.resource_id)
      .first<{ model_content_sha256: string | null }>();
    if (resource?.model_content_sha256 !== dependency.derivative_sha256) return "invalid";
  }
  return "valid";
}

async function invalidateObjectAttachmentToolReplay(
  env: Env,
  workspaceId: string,
  invocationId: string,
): Promise<void> {
  const invocation = await env.DB.prepare(
    `SELECT output_ref FROM tool_invocations WHERE workspace_id = ? AND id = ?`,
  ).bind(workspaceId, invocationId).first<{ output_ref: string | null }>();
  if (invocation?.output_ref) {
    const at = new Date().toISOString();
    await regionalDatabase(env).prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'receipt', ?, ?)`,
    ).bind(
      invocation.output_ref,
      workspaceId,
      `attachment-receipt:${invocationId}`,
      at,
      at,
    ).run();
  }
  await env.DB.prepare(
    "DELETE FROM tool_invocations WHERE workspace_id = ? AND id = ?",
  ).bind(workspaceId, invocationId).run();
}

function attachmentReceiptDependencies(canonicalToolName: string, output: unknown): ReceiptDependency[] {
  if (canonicalToolName === "read_resource") {
    const parsed = WorkstreamReadResourceOutputSchema.safeParse(output);
    return parsed.success ? [{ resourceId: parsed.data.resourceId, derivativeSha256: parsed.data.version.sha256 }] : [];
  }
  if (canonicalToolName === "search_resource") {
    const parsed = WorkstreamSearchResourceOutputSchema.safeParse(output);
    return parsed.success ? [{ resourceId: parsed.data.resourceId, derivativeSha256: parsed.data.version.sha256 }] : [];
  }
  if (canonicalToolName === "summarize_resource") {
    const parsed = WorkstreamSummarizeResourceOutputSchema.safeParse(output);
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
