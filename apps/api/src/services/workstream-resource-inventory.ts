import {
  ATTACHMENT_KIND_ENTRIES,
  classifyAttachmentKind,
  type ExecutionPrincipal,
} from "@avalon/contracts";
import {
  loadVisibleWorkstreamResources,
  type VisibleWorkstreamResourceRow,
} from "./workstream-resource-visibility";

export const CHECKPOINT_TEMPLATE_VERSION = 1;

export function renderWorkstreamResourceInventory(input: {
  asOf: string;
  rows: readonly VisibleWorkstreamResourceRow[];
}): string {
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid resource inventory timestamp");
  const counts = new Map(ATTACHMENT_KIND_ENTRIES.map(({ kind }) => [kind, 0]));
  let messageAttachments = 0;
  for (const row of input.rows) {
    const kind = classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (row.message_attachment === 1) messageAttachments += 1;
  }
  const groups = ATTACHMENT_KIND_ENTRIES
    .map(({ kind }) => ({ kind, count: counts.get(kind) ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `- ${kind}: ${count}`);
  return [
    "# Authoritative work-stream resource inventory",
    `As of: ${asOf.toISOString()}`,
    `Visible resources: ${input.rows.length}`,
    `Message attachments: ${messageAttachments}`,
    groups.length > 0 ? "Groups:" : "Groups: none",
    ...groups,
    "",
    "Use workstream_list_resources with attachmentKind, limit, and cursor to list exact resources.",
    "Allowed attachmentKind values: image, markdown, pdf, document, spreadsheet, presentation, text, other.",
    "First page: { attachmentKind: \"<one allowed value>\", limit: 25 }. Continuation: { cursor: \"<nextCursor>\" }.",
    "Follow nextCursor until it is null when complete coverage is required.",
  ].join("\n");
}

export async function renderAuthorizedWorkstreamResourceInventory(
  database: D1Database,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    asOf?: string;
  },
): Promise<string> {
  const visible = await loadVisibleWorkstreamResources(database, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.principal,
  });
  return renderWorkstreamResourceInventory({
    asOf: input.asOf ?? new Date().toISOString(),
    rows: visible.rows,
  });
}
