import {
  DEFAULT_MEMBER_PREFERENCES,
  MemberPreferencesSchema,
  type MemberPreferences,
} from '@rally/contracts';
import { useQuery, type DefinedUseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { RallyApi } from './api';

/** Per Organization: the preferences are, and one must never show in another. */
export function memberPreferencesQueryKey(workspaceId: string): readonly unknown[] {
  return ['member-preferences', workspaceId];
}

function storageKey(workspaceId: string): string {
  return `rally:member-preferences:${workspaceId}`;
}

/**
 * The last answer this device saw, so a cold launch paints what the member
 * chose rather than the defaults and then flips. A convenience, never the
 * authority: the server's answer replaces it, and anything unreadable is the
 * defaults.
 */
function rememberedPreferences(workspaceId: string): MemberPreferences {
  try {
    const parsed = MemberPreferencesSchema.safeParse(
      JSON.parse(window.localStorage.getItem(storageKey(workspaceId)) ?? 'null'),
    );
    return parsed.success ? parsed.data : DEFAULT_MEMBER_PREFERENCES;
  } catch {
    return DEFAULT_MEMBER_PREFERENCES;
  }
}

/**
 * This person's display preferences in this Organization.
 *
 * The workspace socket writes this key from its answer to subscribe and
 * invalidates it on `viewer_preferences`, so a read normally costs nothing.
 * The remembered value is stamped at 0 so REST covers the moment before the
 * socket answers; a server answer is then fresh until invalidated.
 */
export function useMemberPreferences(
  api: Pick<RallyApi, 'getMyPreferences'> | null,
  workspaceId: string,
): DefinedUseQueryResult<MemberPreferences> {
  const query = useQuery({
    queryKey: memberPreferencesQueryKey(workspaceId),
    queryFn: ({ signal }) => api!.getMyPreferences(signal),
    enabled: api !== null,
    initialData: () => rememberedPreferences(workspaceId),
    initialDataUpdatedAt: 0,
    staleTime: (current) => (current.state.dataUpdatedAt === 0 ? 0 : Number.POSITIVE_INFINITY),
  });
  const answered = query.dataUpdatedAt > 0;
  useEffect(() => {
    if (!answered) return;
    try {
      window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(query.data));
    } catch {
      // Storage is a convenience; the server holds the preference.
    }
  }, [answered, query.data, workspaceId]);
  return query;
}
