/**
 * Every composer that caches a draft names it here, so a text draft and its
 * attachments always agree on one key and no two surfaces can collide.
 */
export function workstreamDraftKey(workspaceId: string, workstreamId: string): string {
  return `workspace:${workspaceId}:workstream:${workstreamId}`;
}

/** Scoped by workspace: the launcher is one composer per workspace, not per device. */
export function newWorkstreamDraftKey(workspaceId: string): string {
  return `workspace:${workspaceId}:new-workstream`;
}

/**
 * Scoped by workspace like the launcher, and then by the draft automation being
 * written when there is one. The builder is one screen serving many
 * conversations: sharing a single key across them would carry an unsent
 * sentence — and worse, staged attachments — from the draft it was typed in
 * into the next draft's turn.
 */
export function newAutomationDraftKey(workspaceId: string, draftAutomationId?: string | null): string {
  return draftAutomationId
    ? `workspace:${workspaceId}:new-automation:${draftAutomationId}`
    : `workspace:${workspaceId}:new-automation`;
}
