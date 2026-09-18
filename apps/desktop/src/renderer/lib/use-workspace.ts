import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAppSession } from './app-session';
import { workspaceFromSession } from './session-workspace';
import type { Workspace } from './types';

/**
 * The one read of `GET /workspace`, and the one place its query key is spelled.
 *
 * **Every surface that needs the viewer's own role reads it through here.** The
 * role a person holds can now change while they are signed in — an
 * administrator can promote or demote them from Workspace settings — and the
 * copy on the desktop session does not move when it does. That copy is replaced
 * only by `bridge.refreshSession()`, which runs a minute before an access token
 * expires, so a surface reading `session.workspace.role` can be up to the whole
 * token window out of date.
 *
 * That was harmless while a role was fixed for the life of a membership. It is
 * not any more: the connector card gates its Connect button on the role, so a
 * teammate promoted precisely so they could connect a workspace account went on
 * being told they could not until their token rotated. This query is the copy
 * the `workspace_profile` sync topic invalidates, so it is the copy that moves
 * when the role does.
 *
 * The session's own workspace still seeds the first paint through
 * `placeholderData` — it is a placeholder, not a cache, exactly as
 * `session-workspace.ts` describes.
 */
export function useWorkspaceQuery(): UseQueryResult<Workspace> {
  const { api, session } = useAppSession();
  const placeholder = useMemo(() => workspaceFromSession(session) ?? undefined, [session]);
  return useQuery({
    queryKey: ['workspace', session?.workspace?.id, session?.user?.id],
    queryFn: ({ signal }) => api!.getWorkspace(signal),
    enabled: Boolean(api && session?.workspace && session.user),
    staleTime: 30_000,
    placeholderData: placeholder,
  });
}

/**
 * Whether the viewer may take an administrator action, for drawing purposes.
 *
 * Presentation only — every control it gates is refused server-side for a
 * member, and `auth.role` is resolved from `workspace_members` on every request.
 */
export function useViewerIsWorkspaceAdmin(): boolean {
  const role = useWorkspaceQuery().data?.currentUser.role;
  return role === 'owner' || role === 'admin';
}
