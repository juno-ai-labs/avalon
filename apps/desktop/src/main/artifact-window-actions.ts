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
    if (action.type === 'content') return {
      path: `${root}${action.version ? `/versions/${action.version}` : ''}/${action.original ? 'content' : 'preview'}`,
      method: 'GET', binary: true,
    };
    const [parentId, substreamId] = preview.annotationScope?.split(':') ?? [];
    const parent = IdSchema.safeParse(parentId);
    if (preview.editable !== true || !parent.success || substreamId !== '0') throw new Error('This artifact has no editable thread context');
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
