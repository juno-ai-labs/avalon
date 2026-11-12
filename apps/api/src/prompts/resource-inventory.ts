import { ATTACHMENT_KIND_ENTRIES } from "@rally/contracts";
import type { VisibleWorkstreamResourceInventory } from "../services/workstream-resource-visibility";

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
