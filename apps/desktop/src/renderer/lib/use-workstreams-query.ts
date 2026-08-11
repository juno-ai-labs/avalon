import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAppSession } from './app-session';
import { useDebugEnabled } from './use-debug-enabled';
import type { WorkstreamSummary } from './types';

/**
 * The one cache entry every work-stream list reads and every producer writes.
 *
 * It deliberately carries no parameters. Realtime `message_created` handling,
 * renames and read-state callbacks all patch this entry directly with
 * `setQueryData`, so a key that varied with the caller's options would leave
 * those writes updating something nobody observes — the sidebar would sit on
 * stale unread counts and titles until the next poll. Options change what the
 * fetcher asks for, never where the answer is stored.
 */
export const WORKSTREAMS_QUERY_KEY = ['workstreams'] as const;

/**
 * The work-stream list, as every surface sees it.
 *
 * Debugging widens it to include system work streams — a digest run's
 * transcript and anything like it. That is a property of the request, not of
 * the identity of the list, which is why it stays out of the key.
 */
export function useWorkstreamsQuery(): UseQueryResult<WorkstreamSummary[]> {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const debugEnabled = useDebugEnabled();

  const query = useQuery({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getWorkstreams(signal, debugEnabled),
    enabled: Boolean(api),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // Since the key does not vary, toggling the preference has to ask for the
  // refetch itself. This has to be declared below `useQuery`: the query hands
  // its new fetcher to the observer from an effect of its own, and effects run
  // in declaration order, so invalidating first would refetch with the fetcher
  // for the preference that just changed. The first run is skipped so mounting
  // does not fire a second fetch on top of the query's own.
  const observedDebugEnabled = useRef(debugEnabled);
  useEffect(() => {
    if (observedDebugEnabled.current === debugEnabled) return;
    observedDebugEnabled.current = debugEnabled;
    void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
  }, [debugEnabled, queryClient]);

  return query;
}
