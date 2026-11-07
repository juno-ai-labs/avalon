import { IdSchema } from '@rally/contracts';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import type { DesktopArtifactWindowRequest } from '../common/desktop';
import { ArtifactWindowActionSchema, type ArtifactWindowAction } from '../common/artifact-window-actions';

/** Confinement comes from main's window record, never from the caller. */
type ArtifactActionRequest = {
  path: string; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; binary?: boolean;
};

/**
 * What a window action asks of the API, or, for Copy link, the Canvas the
 * link names: a link is minted in main from the Canvas link form and needs no
 * request (`docs/links.md`).
 */
export function artifactWindowActionRequest(
  preview: DesktopArtifactWindowRequest,
  raw: unknown,
): (ArtifactActionRequest | { canvasId: string }) & { action: ArtifactWindowAction } {
  const parsed = ArtifactWindowActionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(zodDiagnosticCode(parsed.error, 'artifact_window_action')!);
  const action = parsed.data;
  const target = (): ArtifactActionRequest | { canvasId: string } => {
    const root = `/resources/${encodeURIComponent(preview.resourceId)}`;
    if (action.type === 'read') return { path: root, method: 'GET' };
    if (action.type === 'pin-state') return { path: '/navigation/artifact-pins', method: 'GET' };
    if (action.type === 'versions') return { path: `${root}/versions`, method: 'GET' };
    if (action.type === 'open') return { path: `${root}/artifact/open`, method: 'POST' };
    if (action.type === 'data') return { path: `${root}/artifact/data`, method: 'GET' };
    if (action.type === 'table') return { path: `${root}/artifact/data/${encodeURIComponent(action.table)}`, method: 'GET' };
    if (action.type === 'site-preview') return { path: `${root}/versions/${action.version}/site-preview?path=${encodeURIComponent(action.pagePath)}`, method: 'GET', binary: true };
    if (action.type === 'content') return {
      path: `${root}${action.version ? `/versions/${action.version}` : ''}/${action.original ? 'content' : 'preview'}`,
      method: 'GET', binary: true,
    };
    // A Canvas's Chat registers `canvas:<canvasId>` (`conversationAnnotationScope`).
    // A Thread's scope (`<parentId>:<substreamId>`) names a conversation whose
    // routes are gone, so nothing below is built for it.
    const [first, second] = preview.annotationScope?.split(':') ?? [];
    const canvas = first === 'canvas' ? IdSchema.safeParse(second) : null;
    // A link opens the Canvas onto this artifact, which reading it is enough
    // to share.
    if (action.type === 'link') {
      if (!canvas?.success) throw new Error('This artifact has no Canvas to link to');
      return { canvasId: canvas.data };
    }
    if (preview.editable !== true || !canvas?.success) throw new Error('This artifact cannot be edited here');
    // A Canvas artifact's pin belongs to the Canvas, and has no route from a
    // detached window.
    if (action.type === 'pin') throw new Error('A Canvas artifact cannot be pinned from its own window; use the Canvas');
    const path = `/conversations/${canvas.data}/resources/${encodeURIComponent(preview.resourceId)}`;
    return action.type === 'rename' ? { path, method: 'PATCH', body: { title: action.title } } : { path, method: 'DELETE' };
  };
  return { ...target(), action };
}

/** Region is part of identity: UUIDs can recur in another deployment. */
export function artifactWindowSessionMatches(
  window: { userId: string; workspaceId: string; region?: string },
  session: { userId: string | null; workspaceId: string | null; region: string | null },
): boolean {
  return window.region !== undefined && window.region === session.region
    && window.userId === session.userId && window.workspaceId === session.workspaceId;
}
