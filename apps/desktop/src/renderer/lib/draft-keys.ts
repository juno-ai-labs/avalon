/**
 * Every composer that caches a draft names it here, so a text draft and its
 * attachments always agree on one key and no two surfaces can collide.
 */
export function workstreamDraftKey(workstreamId: string): string {
  return `workstream:${workstreamId}`;
}

/** Scoped by workspace: the launcher is one composer per workspace, not per device. */
export function newWorkstreamDraftKey(workspaceId: string): string {
  return `new-workstream:${workspaceId}`;
}

export function newAutomationDraftKey(workspaceId: string): string {
  return `new-automation:${workspaceId}`;
}
