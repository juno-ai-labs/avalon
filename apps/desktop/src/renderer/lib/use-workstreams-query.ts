import { hashKey, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchThroughOwner } from './fetch-through-owner';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDebugEnabled } from './use-debug-enabled';
import { useWorkspaceSocket } from './workspace-socket';
import { keepPendingWorkstreams, setCachedWorkstreams, WORKSTREAM_PAGE_SIZE, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { WORKSTREAM_STATE_WATERLINES_KEY } from './workstream-state-store';
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

const activeRowsBySource = new WeakMap<WorkstreamSummary[], WorkstreamSummary[]>();

/** Preserve the raw archived marker for ordering while every directory reader sees only active rows. */
function activeWorkstreams(rows: WorkstreamSummary[]): WorkstreamSummary[];
function activeWorkstreams(rows: WorkstreamSummary[] | undefined): WorkstreamSummary[] | undefined;
function activeWorkstreams(rows: WorkstreamSummary[] | undefined): WorkstreamSummary[] | undefined {
  if (!rows) return undefined;
  const observed = activeRowsBySource.get(rows);
  if (observed) return observed;
  const active = rows.filter((workstream) => !workstream.archivedAt);
  activeRowsBySource.set(rows, active);
  return active;
}

const selectActiveWorkstreams = (rows: WorkstreamSummary[]): WorkstreamSummary[] =>
  activeWorkstreams(rows);

const WORKSTREAMS_QUERY_HASH = hashKey(WORKSTREAMS_QUERY_KEY);

/** Observe directory pushes without registering another pager or query function. */
export function useCachedWorkstreams(): WorkstreamSummary[] | undefined {
  const client = useQueryClient();
  // Only a change to this entry's data. Every other cache event, including the
  // ones a component raises by mounting an observer while it renders, would
  // reach this store mid-render and update the component holding it from there.
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe((event) => {
    if ((event.type === 'updated' || event.type === 'added' || event.type === 'removed')
      && event.query.queryHash === WORKSTREAMS_QUERY_HASH) onChange();
  }), [client]);
  const snapshot = useCallback(() => activeWorkstreams(
    client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY),
  ), [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}


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
 * When the connect payload says `channelsBySpace` it carried no Channel rows,
 * and this query's fetch is the walk of every Space instead
 * (`walkSpaceChannels`): the provider writes each page as it lands, and the
 * fetch ends by dropping a row it held before the walk that no Space returned.
 * There is no page beyond, so `hasMore` is false.
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
 *
 * `includeArchived` lets a list overlay retain archive tombstones from the socket.
 */
export function useWorkstreamsQuery({ includeArchived = false }: { includeArchived?: boolean } = {}): WorkstreamsQuery {
  const { listWorkstreams, sidebarConnect, walkSpaceChannels } = useWorkspaceSocket();
  const queryClient = useQueryClient();
  const debugEnabled = useDebugEnabled();
  const pagesLoaded = useRef(1);
  const nextCursor = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const query = useQuery({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const before = new Set((queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [])
        .filter((workstream) => !workstream.pending)
        .map((workstream) => workstream.id));
      const returned = await walkSpaceChannels(signal);
      if (returned !== null) {
        // System work streams sit in no Space; Debug adds the directory's.
        // They can be anywhere in its recency order, so every page is read.
        const system: WorkstreamSummary[] = [];
        for (let cursor: string | null | undefined = debugEnabled ? undefined : null; cursor !== null;) {
          const page = await listWorkstreams({
            limit: WORKSTREAM_PAGE_SIZE,
            ...(cursor ? { before: cursor } : {}),
            includeSystem: true,
          });
          system.push(...page.items.filter((workstream) => workstream.systemKind !== undefined));
          cursor = page.nextCursor;
        }
        pagesLoaded.current = 1;
        nextCursor.current = null;
        setHasMore(false);
        const listed = new Set([...returned, ...system.map((workstream) => workstream.id)]);
        const current = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [];
        const visibility = queryClient.getQueryData<Record<string, { visible: boolean }>>(
          WORKSTREAM_STATE_WATERLINES_KEY,
        ) ?? {};
        // The walk wrote every page as it landed. What is left is to drop a
        // row held before it that no Space returned: gone, or no longer
        // visible to this viewer. A row that arrived during the walk stays;
        // it was pushed after its Space was read.
        const kept = current.filter((workstream) => visibility[workstream.id]?.visible !== false
          && (workstream.pending || listed.has(workstream.id) || !before.has(workstream.id)));
        const keptIds = new Set(kept.map((workstream) => workstream.id));
        return keepPendingWorkstreams(current, [
          ...kept,
          ...system.filter((workstream) => !keptIds.has(workstream.id)),
        ])!;
      }
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
      const merged = mergeWorkstreams([], items);
      const current = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY);
      const resident = new Map((current ?? []).map((workstream) => [workstream.id, workstream]));
      const visibility = queryClient.getQueryData<Record<string, { visible: boolean }>>(
        WORKSTREAM_STATE_WATERLINES_KEY,
      ) ?? {};
      // Every page was fenced when it arrived, but an earlier page remains in
      // this local accumulator while later pages are awaited. Reconcile once
      // more at publication so an archive marker or tombstone that landed in
      // that interval cannot be overwritten by the stale accumulated object.
      const fetched = merged.flatMap((workstream) => {
        if (visibility[workstream.id]?.visible === false) return [];
        const held = resident.get(workstream.id);
        // A pending row is this window's stand-in for the row just fetched.
        return [held && !held.pending ? held : workstream];
      });
      // Written by the query rather than through `setCachedWorkstreams`, so the
      // rule that keeps a create in flight on screen is applied here too.
      return keepPendingWorkstreams(current, fetched)!;
    },
    // Not fetched on mount: the first page arrives unasked with the connect
    // payload, and asking for it as well is the round trip that payload exists
    // to remove. Enabled once one has landed, at which point the cache is
    // already populated and infinitely fresh — so nothing fetches until
    // something explicitly invalidates, which is the debug toggle or a pin.
    enabled: sidebarConnect !== null,
    staleTime: Number.POSITIVE_INFINITY,
    select: includeArchived ? undefined : selectActiveWorkstreams,
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
    // The connect payload and its first page can render before the passive
    // cursor-adoption effect. Sidebar layout restoration asks from a layout
    // effect, so page one must expose its cursor without waiting for that pass.
    const cursor = pagesLoaded.current === 1 && sidebarConnect
      ? sidebarConnect.nextCursor : nextCursor.current;
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
  }, [debugEnabled, isFetchingMore, listWorkstreams, queryClient, sidebarConnect]);

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

  return { ...query, hasMore: pagesLoaded.current === 1 && sidebarConnect
    ? sidebarConnect.nextCursor !== null : hasMore, isFetchingMore, fetchMore };
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
    queryFn: fetchThroughOwner,
    enabled: false,
    select: (rows) => rows?.find((row) => row.id === workstreamId)?.appearance,
  }).data;
}

/**
 * This Channel's directory row, as the sidebar holds it, or `undefined` when
 * the directory does not list it. Never fetches, for the reason above.
 */
export function useCachedWorkstreamSummary(workstreamId: string): WorkstreamSummary | undefined {
  return useQuery<WorkstreamSummary[] | undefined, Error, WorkstreamSummary | undefined>({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: fetchThroughOwner,
    enabled: false,
    select: (rows) => rows?.find((row) => row.id === workstreamId),
  }).data;
}

/**
 * The Channels this Channel sits in, as the directory holds them, or
 * `undefined` when the directory does not list it. The directory is what
 * placements are kept current in; a detail installed from the conversation's
 * own object carries none. Never fetches, for the reason above.
 */
export function useCachedWorkstreamPlacements(workstreamId: string): readonly string[] | undefined {
  return useQuery<WorkstreamSummary[] | undefined, Error, readonly string[] | undefined>({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: fetchThroughOwner,
    enabled: false,
    select: (rows) => rows?.find((row) => row.id === workstreamId)?.spaceIds,
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
