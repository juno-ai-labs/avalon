import { useQuery } from '@tanstack/react-query';
import type { SupportWorkspace } from '@rally/contracts';
import { useEffect } from 'react';
import { desktopBridge } from './platform';

/** How often Rally staff's list of Organizations that granted Rally access is reread. */
export const SUPPORT_WORKSPACES_REFRESH_MS = 10 * 60 * 1_000;

/**
 * The Organizations that granted Rally access, for the account menu of Rally
 * staff (`docs/impersonation.md`). Anybody else gets `null`, and the timer
 * stops for them. Staff, and a read that failed, reread in the background on
 * the timer rather than when the menu opens, so a new grant is already listed
 * when the menu appears instead of popping in under it. **View → Refresh
 * Organization List** rereads at once, for anybody.
 */
export function useSupportWorkspaces(
  accountId: string | undefined,
  listSupportWorkspaces: () => Promise<SupportWorkspace[] | null>,
) {
  const query = useQuery({
    queryKey: ['support-workspaces', accountId],
    queryFn: () => listSupportWorkspaces(),
    retry: false,
    staleTime: Infinity,
    refetchInterval: (current) => current.state.data === null ? false : SUPPORT_WORKSPACES_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  const { refetch } = query;
  useEffect(() => desktopBridge().onOrganizationListRefreshRequested(() => { void refetch(); }), [refetch]);
  return query;
}
