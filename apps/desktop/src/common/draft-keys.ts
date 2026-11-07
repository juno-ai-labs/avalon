import { desktopWorkspaceIdentityKey, type RallyRegion } from './desktop';

/**
 * Every composer that caches a draft names it here, so a text draft and its
 * attachments always agree on one key and no two surfaces can collide.
 */
export function workstreamDraftKey(region: RallyRegion, workspaceId: string, workstreamId: string, substreamId = '0'): string {
  const parentKey = `${workspaceDraftPrefix(region, workspaceId)}workstream:${workstreamId}`;
  return substreamId === '0' ? parentKey : `${parentKey}:substream:${substreamId}`;
}

/**
 * A Canvas's Chat. Its own family rather than the work-stream one: a Canvas is
 * a different parent, and naming it here keeps a Canvas draft out of every
 * reader that walks `workstream:` keys (legacy migration, the Breakout launcher).
 */
export function canvasDraftKey(region: RallyRegion, workspaceId: string, canvasId: string): string {
  return `${workspaceDraftPrefix(region, workspaceId)}canvas:${canvasId}`;
}

/**
 * The draft key of whichever conversation a surface draws, by its parent kind:
 * a Canvas's Chat is `canvas:<id>`, everything else (a Thread, a Breakout, a
 * Sidekick's shared conversation) the work-stream family it has always used.
 */
export function conversationDraftKey(
  region: RallyRegion,
  workspaceId: string,
  parentKind: string,
  parentId: string,
  substreamId = '0',
): string {
  return parentKind === 'canvas' ? canvasDraftKey(region, workspaceId, parentId)
    : workstreamDraftKey(region, workspaceId, parentId, substreamId);
}

/**
 * The annotation scope a conversation registers with main, which derives the
 * draft key back from it in `annotationDraftKeyForScope`.
 */
export function conversationAnnotationScope(parentKind: string, parentId: string, substreamId = '0'): string {
  return parentKind === 'canvas' ? `canvas:${parentId}` : `${parentId}:${substreamId}`;
}

/** Scoped by workspace: the launcher is one composer per workspace, not per device. */
export function newWorkstreamDraftKey(region: RallyRegion, workspaceId: string): string {
  return `${workspaceDraftPrefix(region, workspaceId)}new-workstream`;
}

/**
 * Scoped by workspace like the launcher, and then by the draft automation being
 * written when there is one. The builder is one screen serving many
 * conversations: sharing a single key across them would carry an unsent
 * sentence — and worse, staged attachments — from the draft it was typed in
 * into the next draft's turn.
 */
export function newAutomationDraftKey(
  region: RallyRegion,
  workspaceId: string,
  draftAutomationId?: string | null,
): string {
  return draftAutomationId
    ? `${workspaceDraftPrefix(region, workspaceId)}new-automation:${draftAutomationId}`
    : `${workspaceDraftPrefix(region, workspaceId)}new-automation`;
}

export function workspaceDraftPrefix(region: RallyRegion, workspaceId: string): string {
  return `workspace:${desktopWorkspaceIdentityKey(region, workspaceId)}:`;
}

/** Detached renderers receive a key derived from main's registered conversation scope. */
export function annotationDraftKeyForScope(region: RallyRegion, workspaceId: string, scope: string): string {
  const [parent = '', substream = '0'] = scope.split(':');
  if (parent === 'channel') return `${newWorkstreamDraftKey(region, workspaceId)}:space:${substream}`;
  if (parent === 'canvas') return canvasDraftKey(region, workspaceId, substream);
  return workstreamDraftKey(region, workspaceId, parent, substream);
}
