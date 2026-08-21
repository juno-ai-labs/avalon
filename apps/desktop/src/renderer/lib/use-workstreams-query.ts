import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebugEnabled } from './use-debug-enabled';
import { useWorkspaceSocket, type WorkstreamPage } from './workspace-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import type { AutomationSummary, NoteSummary, WorkstreamSummary } from './types';

/**
 * The one cache entry every work-stream list reads and every producer writes.
 *
 * It deliberately carries no parameters. Realtime `message_created` handling,
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
 * The first page is asked for as `list_sidebar`, which answers with the
 * automations and notes beside it and seeds their caches here — the whole
 * sidebar opens, and reopens, on one round trip. Those two lists have no
 * fetcher of their own: WorkspaceDO pushes them whole whenever it changes one
 * of their rows, and this is where they are seeded and re-seeded.
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
  const { listSidebar, listWorkstreams } = useWorkspaceSocket();
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
        // The first page is always the whole sidebar. Nothing else loads the
        // automations and notes now — no REST fetcher stands behind them — so
        // every reason this query reloads is also a reason they must be
        // reloaded: a cold start, a reconnect, a debug toggle. Later pages ask
        // for the directory alone.
        let result: WorkstreamPage;
        if (page === 0) {
          const batch = await listSidebar({
            limit: WORKSTREAM_PAGE_SIZE,
            includeSystem: debugEnabled,
          });
          // Written before this function returns, so React Query stores the
          // work streams in the same tick the other two lists land in. The
          // three arrive in one render rather than three, which is the whole
          // point of asking for them together. The keys are the ones the shell
          // reads them under; `use-workstreams-query.test.tsx` holds them to it.
          //
          // Safe against a push that lands mid-flight: WorkspaceDO reads this
          // batch and sends it before any later write can be applied, and the
          // socket preserves that order, so a newer pushed list always arrives
          // after the batch it supersedes.
          queryClient.setQueryData<AutomationSummary[]>(['automations'], batch.automations);
          queryClient.setQueryData<NoteSummary[]>(['notes'], batch.notes);
          result = batch;
        } else {
          result = await listWorkstreams({
            limit: WORKSTREAM_PAGE_SIZE,
            ...(cursor ? { before: cursor } : {}),
            includeSystem: debugEnabled,
          });
        }
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
    staleTime: Number.POSITIVE_INFINITY,
  });

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
