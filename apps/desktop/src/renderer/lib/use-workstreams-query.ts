import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebugEnabled } from './use-debug-enabled';
import { useWorkspaceSocket } from './workspace-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import type { WorkstreamAppearance } from '@rally/contracts';
import type { WorkstreamSummary } from './types';

/**
 * The one cache entry every work-stream list reads and every producer writes.
 *
 * It deliberately carries no parameters. Realtime transcript-turn handling,
 * renames and read-state callbacks all patch this entry directly with
 * `setQueryData`, so a key that varied with the caller's options would leave
 * those writes updating something nobody observes — the sidebar would sit on
 * stale unread counts and titles until the next socket event. Options change what the
 * fetcher asks for, never where the answer is stored.
 */
export { WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

const WORKSTREAM_PAGE_SIZE = 250;

/**
 * The query result every existing caller already reads, widened with paging.
 *
 * An intersection rather than an `interface … extends`: `UseQueryResult` is a
 * discriminated union over the pending, error and success shapes, and an
 * interface cannot extend one.
 */
export type WorkstreamsQuery = UseQueryResult<WorkstreamSummary[]> & {
  /** Whether the service reported a page after the ones already loaded. */
  hasMore: boolean;
  /** A page beyond the first is in flight. The first page is `isFetching`. */
  isFetchingMore: boolean;
  /** Load the next page and append it. A no-op when there is no next page. */
  fetchMore: () => void;
};

/**
 * The work-stream list, as every surface sees it.
 *
 * Debugging widens it to include system work streams — a digest run's
 * transcript and anything like it. That is a property of the request, not of
 * the identity of the list, which is why it stays out of the key.
 *
 * The first page is not fetched at all. Subscribing to the workspace socket is
 * answered with the whole sidebar unasked, and the provider writes it — so this
 * query exists for what a person's own action asks for afterwards: scrolling
 * past page one, turning Debug enabled on, and reloading after a pin.
 *
 * ## Why this pages by hand rather than with `useInfiniteQuery`
 *
 * `useInfiniteQuery` stores `{ pages, pageParams }` under its key. Eight call
 * sites across the realtime socket handlers and the app shell patch this entry
 * as a flat `WorkstreamSummary[]` with `setQueryData` — a rename, an unread
 * count, a pin reorder, a scope change. Adopting the paged shape would strand
 * every one of them silently: the write would land on a value nobody reads, and
 * the sidebar would sit stale until the next WorkspaceDO event. The flat array is the
 * contract those writers were built against, so paging is kept inside the
 * fetcher and the stored value never changes shape.
 *
 * Two rules follow from that, and they are what make a hand-rolled version
 * correct rather than merely simpler:
 *
 * - **A refetch reloads every page already on screen.** A durable WorkspaceDO
 *   invalidation triggers it, and a fetcher that returned only the first page
 *   would silently truncate the list under somebody who had scrolled.
 *   `pagesLoaded` is how many to walk.
 * - **`fetchMore` appends rather than refetching.** It asks for one page and
 *   merges it in, so reaching the bottom costs one request rather than
 *   re-reading everything above it.
 */
export function useWorkstreamsQuery(): WorkstreamsQuery {
  const { listWorkstreams, sidebarConnect } = useWorkspaceSocket();
  const queryClient = useQueryClient();
  const debugEnabled = useDebugEnabled();
  const pagesLoaded = useRef(1);
  const nextCursor = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const query = useQuery({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: async () => {
      const items: WorkstreamSummary[] = [];
      let cursor: string | undefined;
      let walked = 0;
      for (let page = 0; page < pagesLoaded.current; page += 1) {
        const result = await listWorkstreams({
          limit: WORKSTREAM_PAGE_SIZE,
          ...(cursor ? { before: cursor } : {}),
          includeSystem: debugEnabled,
        });
        items.push(...result.items);
        walked += 1;
        cursor = result.nextCursor ?? undefined;
        // The list shortened while it was open — archived elsewhere, or simply
        // fewer rows than when it was scrolled. Stop, and stop asking for pages
        // that are no longer there on every socket-triggered refresh from here on.
        if (!cursor) break;
      }
      pagesLoaded.current = walked;
      nextCursor.current = cursor ?? null;
      setHasMore(cursor != null);
      return mergeWorkstreams([], items);
    },
    // Not fetched on mount: the first page arrives unasked with the connect
    // payload, and asking for it as well is the round trip that payload exists
    // to remove. Enabled once one has landed, at which point the cache is
    // already populated and infinitely fresh — so nothing fetches until
    // something explicitly invalidates, which is the debug toggle or a pin.
    enabled: sidebarConnect !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Paging is the client's own position and the payload knows nothing about it.
  // Adopted only while page one is all that is loaded: a reader who has
  // scrolled holds a cursor further down the list, and taking the payload's
  // would make the next scroll re-fetch a page they already have.
  const observedConnect = useRef(0);
  useEffect(() => {
    if (!sidebarConnect || sidebarConnect.generation === observedConnect.current) return;
    observedConnect.current = sidebarConnect.generation;
    if (pagesLoaded.current !== 1) return;
    nextCursor.current = sidebarConnect.nextCursor;
    setHasMore(sidebarConnect.nextCursor !== null);
  }, [sidebarConnect]);

  const fetchMore = useCallback(() => {
    const cursor = nextCursor.current;
    if (cursor === null || isFetchingMore) return;
    setIsFetchingMore(true);
    void listWorkstreams({
      limit: WORKSTREAM_PAGE_SIZE,
      before: cursor,
      includeSystem: debugEnabled,
    })
      .then((page) => {
        // Counted before the merge so a socket-triggered refresh that lands between the two still
        // reloads this page rather than dropping it.
        pagesLoaded.current += 1;
        nextCursor.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
        setCachedWorkstreams(queryClient, (current) =>
          mergeWorkstreams(current ?? [], page.items));
      })
      // The cursor is deliberately left where it was, so scrolling to the
      // bottom again retries the same page. A failed page is not an empty one:
      // clearing it would end the list early and quietly.
      .catch(() => undefined)
      .finally(() => setIsFetchingMore(false));
  }, [debugEnabled, isFetchingMore, listWorkstreams, queryClient]);

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
    // Debugging changes which rows the list is made of, so the pages already
    // walked describe a different list. Start again from the first.
    pagesLoaded.current = 1;
    nextCursor.current = null;
    void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
  }, [debugEnabled, queryClient]);

  return { ...query, hasMore, isFetchingMore, fetchMore };
}

/**
 * The appearance a surface inside one work stream should paint with.
 *
 * The list row, not the cached detail, and the difference is visible. Both
 * receive the versioned projection, but only the row receives the unversioned
 * writes — the picker's receipt and the naming pass's generated icon — so the
 * row is never behind the detail and is ahead of it by the projection lag,
 * which is seconds. Reading it here is what lets a second surface move with
 * the sidebar row instead of trailing it, without writing the detail: that
 * entry is the picker's own preview signal and only the projection may move
 * it, per
 * [`docs/workstream-appearance.md`](../../../../../docs/workstream-appearance.md).
 *
 * `undefined` for a work stream with no row loaded — one opened by deep link
 * past the first page — so a caller falls back to whatever the detail carries.
 *
 * `select` narrows the subscription to the one work stream's appearance.
 * Without it every unread count, title and run state in the workspace would
 * re-render the screen holding this hook.
 */
export function useCachedWorkstreamAppearance(workstreamId: string): WorkstreamAppearance | undefined {
  return useQuery<WorkstreamSummary[] | undefined, Error, WorkstreamAppearance | undefined>({
    queryKey: WORKSTREAMS_QUERY_KEY,
    // Never fetches: the list has exactly one fetcher, in `useWorkstreamsQuery`
    // above. This is a read of what that one put there.
    queryFn: async () => undefined,
    enabled: false,
    select: (rows) => rows?.find((row) => row.id === workstreamId)?.appearance,
  }).data;
}

/**
 * `existing` followed by whatever in `incoming` is not already in it.
 *
 * A row can arrive twice legitimately: it moved between two page requests, so
 * it sat on both sides of the cursor. Keeping the copy already in the cache
 * rather than the newer one is deliberate — the cached row may carry a patch a
 * realtime handler applied while the page was in flight, and the next durable
 * workspace-directory invalidation reconciles the two.
 */
function mergeWorkstreams(
  existing: WorkstreamSummary[],
  incoming: WorkstreamSummary[],
): WorkstreamSummary[] {
  const seen = new Set(existing.map((workstream) => workstream.id));
  const merged = [...existing];
  for (const workstream of incoming) {
    if (seen.has(workstream.id)) continue;
    seen.add(workstream.id);
    merged.push(workstream);
  }
  return merged;
}
