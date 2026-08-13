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
  await database.batch(dependencies.map((dependency) => database.prepare(
    `INSERT INTO attachment_tool_receipts
      (resource_id, tool_invocation_id, derivative_sha256, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(resource_id, tool_invocation_id)
     DO UPDATE SET derivative_sha256 = excluded.derivative_sha256`,
  ).bind(dependency.resourceId, input.invocationId, dependency.derivativeSha256, at)));
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
