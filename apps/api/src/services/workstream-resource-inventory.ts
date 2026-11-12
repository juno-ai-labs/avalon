import {
  ATTACHMENT_KIND_ENTRIES,
  classifyAttachmentKind,
  type ExecutionPrincipal,
} from "@rally/contracts";
import type { ConversationResourceLinks } from "./workstream-resource-visibility";
import {
  loadVisibleWorkstreamResourceInventory,
  type VisibleWorkstreamResourceRow,
} from "./workstream-resource-visibility";
import { renderWorkstreamResourceInventoryAggregate } from "@rally/prompts/api/resource-inventory";

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
      totalVisibleResources: input.rows.length,
      totalVisibleMessageAttachments: messageAttachments,
      groups: ATTACHMENT_KIND_ENTRIES.map(({ kind }) => ({ kind, count: counts.get(kind) ?? 0 })),
    },
  });
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
