import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from './app-session';
import { SIDEBAR_LIST_QUERY_KEYS } from './sidebar-list-store';
import { useWorkspaceSocket } from './workspace-socket';
import type { NoteSummary } from './types';

/** One screenful and then some, matching the page the socket's payload carries. */
const NOTE_PAGE_SIZE = 250;

export const NOTES_QUERY_KEY = SIDEBAR_LIST_QUERY_KEYS.notes;

export type NotesQuery = UseQueryResult<NoteSummary[]> & {
  /** Whether the service reported a page after the ones already loaded. */
  hasMore: boolean;
  /** A page beyond the first is in flight. */
  isFetchingMore: boolean;
  /** Load the next page and append it. A no-op when there is no next page. */
  fetchMore: () => void;
};

/**
 * The note list, paged the way the work-stream list beside it is paged.
 *
 * Notes used to be a socket-owned list with no fetcher at all: WorkspaceDO
 * pushed the newest 250 and that was the whole of what the product could show.
 * That made 250 a *ceiling* rather than a page — note 251 was unreachable from
 * the UI, which mattered the moment a grouping's **Archive all** could select
 * rows the reader had no way to see. Paging it removes the ceiling, so the
 * batch surface can go back to naming the complete server-side total the way it
 * does for work streams.
 *
 * The shape deliberately copies `useWorkstreamsQuery`, including paging by hand
 * rather than with `useInfiniteQuery`, and for the same reason: the socket's
 * versioned applier and `onChangeNoteScope` both write this cache entry as a
 * flat `NoteSummary[]` with `setQueryData`. Adopting the `{ pages, pageParams }`
 * shape would strand those writers silently — the write would land on a value
 * nobody reads and the sidebar would sit stale until the next push.
 *
 * Two rules follow, and they are what make the hand-rolled version correct:
 *
 * - **A refetch reloads every page already on screen.** `pagesLoaded` is how
 *   many to walk. A fetcher that returned only the first page would truncate
 *   the list under somebody who had scrolled — which is exactly what the
 *   archive-triggered invalidation would otherwise do.
 * - **`fetchMore` appends rather than refetching.** Reaching the bottom costs
 *   one request, not a re-read of everything above it.
 */
export function useNotesQuery(): NotesQuery {
  const { api } = useAppSession();
  const { sidebarConnect } = useWorkspaceSocket();
  const queryClient = useQueryClient();
  const pagesLoaded = useRef(1);
  const nextCursor = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const query = useQuery({
    queryKey: NOTES_QUERY_KEY,
    queryFn: async () => {
      const items: NoteSummary[] = [];
      let cursor: string | undefined;
      let walked = 0;
      for (let page = 0; page < pagesLoaded.current; page += 1) {
        const result = await api!.getNotes({ limit: NOTE_PAGE_SIZE, before: cursor });
        items.push(...result.items);
        walked += 1;
        cursor = result.nextCursor ?? undefined;
        // The list shortened while it was open — archived here or elsewhere.
        // Stop, and stop asking for pages that are no longer there.
        if (!cursor) break;
      }
      pagesLoaded.current = walked;
      nextCursor.current = cursor ?? null;
      setHasMore(cursor != null);
      return items;
    },
    // Not fetched on mount: the first page arrives unasked with the connect
    // payload, and asking for it again is the round trip that payload exists to
    // remove. Enabled once one has landed, at which point the cache is already
    // populated and infinitely fresh — so nothing fetches until something
    // explicitly invalidates it.
    enabled: sidebarConnect !== null && Boolean(api),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Paging is the client's own position and the payload knows nothing about it.
  // Adopted only while page one is all that is loaded: a reader who has
  // scrolled holds a cursor further down, and taking the payload's would make
  // the next scroll re-fetch a page they already have.
  const observedConnect = useRef(0);
  useEffect(() => {
    if (!sidebarConnect || sidebarConnect.generation === observedConnect.current) return;
    observedConnect.current = sidebarConnect.generation;
    if (pagesLoaded.current !== 1) return;
    nextCursor.current = sidebarConnect.notesNextCursor;
    setHasMore(sidebarConnect.notesNextCursor !== null);
  }, [sidebarConnect]);

  const fetchMore = useCallback(() => {
    const cursor = nextCursor.current;
    if (cursor === null || isFetchingMore || !api) return;
    setIsFetchingMore(true);
    void api.getNotes({ limit: NOTE_PAGE_SIZE, before: cursor })
      .then((page) => {
        // Counted before the merge so a push that lands between the two still
        // reloads this page rather than dropping it.
        pagesLoaded.current += 1;
        nextCursor.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
        queryClient.setQueryData<NoteSummary[]>(NOTES_QUERY_KEY, (current) => {
          const arrived = new Set(page.items.map((note) => note.id));
          return [...(current ?? []).filter((note) => !arrived.has(note.id)), ...page.items];
        });
      })
      // The cursor is deliberately left where it was, so scrolling to the
      // bottom again retries the same page. A failed page is not an empty one:
      // clearing it would end the list early and quietly.
      .catch(() => undefined)
      .finally(() => setIsFetchingMore(false));
  }, [api, isFetchingMore, queryClient]);

  return { ...query, hasMore, isFetchingMore, fetchMore };
}
