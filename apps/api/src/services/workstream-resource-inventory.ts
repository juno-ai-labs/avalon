import {
  ATTACHMENT_KIND_ENTRIES,
  classifyAttachmentKind,
  type ExecutionPrincipal,
} from "@rally/contracts";
import type { ConversationResourceLinks } from "./workstream-resource-visibility";
import {
  loadVisibleWorkstreamResourceInventory,
  type VisibleWorkstreamResourceInventory,
  type VisibleWorkstreamResourceRow,
} from "./workstream-resource-visibility";

export const CHECKPOINT_TEMPLATE_VERSION = 1;

export function renderWorkstreamResourceInventory(input: {
  asOf: string;
  rows: readonly VisibleWorkstreamResourceRow[];
}): string {
  const counts = new Map(ATTACHMENT_KIND_ENTRIES.map(({ kind }) => [kind, 0]));
  let messageAttachments = 0;
  for (const row of input.rows) {
    const kind = classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (row.message_attachment === 1) messageAttachments += 1;
  }
  return renderWorkstreamResourceInventoryAggregate({
    asOf: input.asOf,
    inventory: {
      fingerprint: "render-only",
      totalVisibleResources: input.rows.length,
      totalVisibleMessageAttachments: messageAttachments,
      groups: ATTACHMENT_KIND_ENTRIES.map(({ kind }) => ({ kind, count: counts.get(kind) ?? 0 })),
    },
  });
}

export function renderWorkstreamResourceInventoryAggregate(input: {
  asOf: string;
  inventory: VisibleWorkstreamResourceInventory;
}): string {
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid resource inventory timestamp");
  const counts = new Map(input.inventory.groups.map(({ kind, count }) => [kind, count]));
  const groups = ATTACHMENT_KIND_ENTRIES
    .map(({ kind }) => ({ kind, count: counts.get(kind) ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `- ${kind}: ${count}`);
  return [
    "# Authoritative conversation resource inventory",
    `As of: ${asOf.toISOString()}`,
    `Visible resources: ${input.inventory.totalVisibleResources}`,
    `Message attachments: ${input.inventory.totalVisibleMessageAttachments}`,
    groups.length > 0 ? "Groups:" : "Groups: none",
    ...groups,
    "",
    "Use list_resources with attachmentKind and limit to list exact resources.",
    `Allowed attachmentKind values: ${ATTACHMENT_KIND_ENTRIES.map(({ kind }) => kind).join(", ")}.`,
    "First page: { attachmentKind: \"<one allowed value>\", limit: 25 }. Continue with list_resources_next({ pageId: \"<nextPageId>\" }).",
    "Follow nextPageId until it is null when complete coverage is required.",
  ].join("\n");
}

export async function renderAuthorizedWorkstreamResourceInventory(
  database: D1Database,
  attachments: ConversationResourceLinks,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    asOf?: string;
  },
): Promise<string> {
  const visible = await loadVisibleWorkstreamResourceInventory(database, attachments, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.principal,
  });
  return renderWorkstreamResourceInventoryAggregate({
    asOf: input.asOf ?? new Date().toISOString(),
    inventory: visible,
  });
}
