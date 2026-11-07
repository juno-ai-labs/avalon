import { IdSchema } from '@rally/contracts';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import type { DesktopArtifactWindowRequest } from '../common/desktop';
import { ArtifactWindowActionSchema, type ArtifactWindowAction } from '../common/artifact-window-actions';

/** Confinement comes from main's window record, never from the caller. */
type ArtifactActionRequest = {
  path: string; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; binary?: boolean;
};

export function artifactWindowActionRequest(preview: DesktopArtifactWindowRequest, raw: unknown): ArtifactActionRequest & { action: ArtifactWindowAction } {
  const parsed = ArtifactWindowActionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(zodDiagnosticCode(parsed.error, 'artifact_window_action')!);
  const action = parsed.data;
  const target = (): ArtifactActionRequest => {
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
    // A Canvas's Chat registers `canvas:<canvasId>` (`conversationAnnotationScope`);
    // everything else `<parentId>:<substreamId>`.
    const [first, second] = preview.annotationScope?.split(':') ?? [];
    const canvas = first === 'canvas';
    const parent = IdSchema.safeParse(canvas ? second : first);
    if (preview.editable !== true || !parent.success || (!canvas && second !== '0')) throw new Error('This artifact cannot be edited here');
    if (canvas && (action.type === 'link' || action.type === 'pin')) {
      // A Canvas artifact's pin and link belong to the Canvas, not a thread;
      // neither has a route from a detached window yet (plan step B-5).
      throw new Error(`A Canvas artifact cannot be ${action.type === 'pin' ? 'pinned' : 'linked'} from its own window; use the Canvas`);
    }
    if (action.type === 'link') return { path: `/workstreams/${parent.data}/link-spaces`, method: 'GET' };
    if (action.type === 'pin') return {
      path: `/navigation/artifact-pins/${encodeURIComponent(preview.resourceId)}`,
      method: action.pinned ? 'PUT' : 'DELETE', ...(action.pinned ? { body: { threadId: parent.data } } : {}),
    };
    const path = `/conversations/${parent.data}/resources/${encodeURIComponent(preview.resourceId)}`;
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
