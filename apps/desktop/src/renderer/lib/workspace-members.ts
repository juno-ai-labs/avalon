import { useQuery } from '@tanstack/react-query';
import type { RallyApi } from './api';

export const WORKSPACE_MEMBERS_QUERY_KEY = ['workspace-members'] as const;
/** Under the members key, so a `member_directory` publication refreshes both. */
export const WORKSPACE_ROSTER_QUERY_KEY = ['workspace-members', 'roster'] as const;

/**
 * The people in the Organization, as this reader may see them: the member's
 * full roster, or a guest's (`GET /workspace/roster`), which carries no email,
 * timezone or membership bookkeeping and leaves out the other guests.
 *
 * The one read every surface that names or draws a person uses, so a feed, a
 * facepile or a byline shows a guest the same names a member sees. It is not a
 * picker's source: whom a guest may mention is the conversation's roster, and
 * naming somebody outside it would bring them in.
 */
export function useWorkspaceMembers(
  api: Pick<RallyApi, 'getWorkspaceMembers' | 'getWorkspaceRoster'> | null | undefined,
  { guest, enabled = true, staleTime = 60_000 }: { guest: boolean; enabled?: boolean; staleTime?: number },
) {
  return useQuery({
    queryKey: guest ? WORKSPACE_ROSTER_QUERY_KEY : WORKSPACE_MEMBERS_QUERY_KEY,
    queryFn: ({ signal }) => guest ? api!.getWorkspaceRoster(signal) : api!.getWorkspaceMembers(signal),
    enabled: Boolean(api) && enabled,
    staleTime,
  });
}
