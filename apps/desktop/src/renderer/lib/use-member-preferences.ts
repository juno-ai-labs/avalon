import {
  DEFAULT_MEMBER_PREFERENCES,
  type MemberPreferences,
} from '@rally/contracts';
import { useQuery, type DefinedUseQueryResult } from '@tanstack/react-query';

import type { RallyApi } from './api';

/** Per Organization: the preferences are, and one must never show in another. */
export function memberPreferencesQueryKey(workspaceId: string): readonly unknown[] {
  return ['member-preferences', workspaceId];
}

/**
 * This person's display preferences in this Organization.
 *
 * The workspace socket writes this key from its answer to subscribe and
 * invalidates it on `viewer_preferences`, so a read normally costs nothing.
 * The defaults are a safe value to render, not a read: stamped at 0 so REST
 * covers the moment before the socket answers, then fresh until invalidated.
 */
export function useMemberPreferences(
  api: Pick<RallyApi, 'getMyPreferences'> | null,
  workspaceId: string,
): DefinedUseQueryResult<MemberPreferences> {
  return useQuery({
    queryKey: memberPreferencesQueryKey(workspaceId),
    queryFn: ({ signal }) => api!.getMyPreferences(signal),
    enabled: api !== null,
    initialData: DEFAULT_MEMBER_PREFERENCES,
    initialDataUpdatedAt: 0,
    staleTime: (query) => (query.state.dataUpdatedAt === 0 ? 0 : Number.POSITIVE_INFINITY),
  });
}
