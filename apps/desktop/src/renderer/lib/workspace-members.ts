import { useQuery } from '@tanstack/react-query';
import type { RallyApi } from './api';

export const WORKSPACE_MEMBERS_QUERY_KEY = ['workspace-members'] as const;

/**
 * The people in the Organization, for members and guests alike: every active
 * person, guests included. The one read every surface that names or draws a
 * person uses, so a feed, a facepile or a byline shows a guest the names a
 * member sees.
 *
 * It is not a guest's mention picker. Naming somebody outside a conversation
 * brings them in, so a guest mentions from the conversation's own roster.
 */
export function useWorkspaceMembers(
  api: Pick<RallyApi, 'getWorkspaceMembers'> | null | undefined,
  { enabled = true, staleTime = 60_000 }: { enabled?: boolean; staleTime?: number } = {},
) {
  return useQuery({
    queryKey: WORKSPACE_MEMBERS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api) && enabled,
    staleTime,
  });
}
