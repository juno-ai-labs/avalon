import {
  WorkstreamReadResourceOutputSchema,
  WorkstreamSearchResourceOutputSchema,
  WorkstreamSummarizeResourceOutputSchema,
  WorkstreamViewResourceOutputSchema,
} from "@avalon/contracts";

interface ReceiptDependency {
  resourceId: string;
  derivativeSha256: string;
}

export type AttachmentReceiptReplayValidation = "not_attachment" | "valid" | "invalid";

export async function registerAttachmentToolReceipt(
  database: D1Database,
  input: {
    invocationId: string;
    canonicalToolName: string;
    output: unknown;
  },
): Promise<void> {
  const dependencies = attachmentReceiptDependencies(input.canonicalToolName, input.output);
  if (dependencies.length === 0) return;
  const at = new Date().toISOString();
  const results = await database.batch(dependencies.map((dependency) => database.prepare(
    `INSERT INTO attachment_tool_receipts
      (resource_id, tool_invocation_id, derivative_sha256, created_at)
     SELECT id, ?, ?, ? FROM resources
      WHERE id = ? AND model_content_sha256 = ?
     ON CONFLICT(resource_id, tool_invocation_id)
     DO UPDATE SET derivative_sha256 = excluded.derivative_sha256`,
  ).bind(
    input.invocationId,
    dependency.derivativeSha256,
    at,
    dependency.resourceId,
    dependency.derivativeSha256,
  )));
  if (results.some((result) => (result.meta.changes ?? 0) === 0)) {
    await database.prepare(
      "DELETE FROM attachment_tool_receipts WHERE tool_invocation_id = ?",
    ).bind(input.invocationId).run();
    throw new Error("attachment_receipt_version_changed");
  }
}

export async function validateAttachmentToolReceiptReplay(
  database: D1Database,
  input: {
    invocationId: string;
    capability: string;
    visibleResourceIds: ReadonlySet<string>;
  },
): Promise<AttachmentReceiptReplayValidation> {
  if (!input.capability.startsWith("workstream.resources.")) return "not_attachment";
  if (input.capability === "workstream.resources.list") return "invalid";
  const result = await database.prepare(
    `SELECT receipt.resource_id, receipt.derivative_sha256, resource.model_content_sha256
       FROM attachment_tool_receipts receipt
       JOIN resources resource ON resource.id = receipt.resource_id
      WHERE receipt.tool_invocation_id = ?
      ORDER BY receipt.resource_id ASC`,
  ).bind(input.invocationId).all<{
    resource_id: string;
    derivative_sha256: string;
    model_content_sha256: string | null;
  }>();
  const dependencies = result.results ?? [];
  if (dependencies.length === 0) return "invalid";
  return dependencies.every((dependency) =>
    input.visibleResourceIds.has(dependency.resource_id)
    && dependency.model_content_sha256 === dependency.derivative_sha256
  ) ? "valid" : "invalid";
}

export async function invalidateAttachmentToolReplay(
  database: D1Database,
  invocationId: string,
): Promise<void> {
  const at = new Date().toISOString();
  await database.batch([
    database.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, resource_id, object_kind, created_at, updated_at)
       SELECT output_ref, 'attachment-receipt:' || id, 'receipt', ?, ?
         FROM tool_invocations WHERE id = ? AND output_ref IS NOT NULL`,
    ).bind(at, at, invocationId),
    database.prepare("DELETE FROM tool_invocations WHERE id = ?").bind(invocationId),
  ]);
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
    return parsed.success
      ? parsed.data.items.flatMap((item) => item.status === "included" && item.version
        ? [{ resourceId: item.resourceId, derivativeSha256: item.version.sha256 }]
        : [])
      : [];
  }
  return [];
}

export const __attachmentToolReceiptTesting = { attachmentReceiptDependencies };
