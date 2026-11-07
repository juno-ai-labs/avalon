import type { ArtifactPinList, CanvasSidebarRow, ChannelStats, ContainerOrder, PersonalOrder, PinList, PinnedOrder, SpaceSnapshot } from '@rally/contracts';
import { useQuery, type InfiniteData, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import { sameContainer } from './personal-order';
import type { AutomationSummary, SpaceConversationSummary } from './types';

/**
 * The one receiver for the sidebar's two pushed lists.
 *
 * Both producers write through here — the `workspace_sidebar` connect payload
 * and every later `workspace_sidebar_list` push — because they are two senders of
 * one field family, and `docs/choosing-sockets-or-rest.md` asks for a single
 * receiver owning the ledger rather than a comparison at each call site. Two
 * handlers each deciding for themselves is how a batch that was read before a
 * write ends up overwriting the push that carried it.
 *
 * WorkspaceDO stamps a waterline per list, inside the transaction of the write
 * that earned it, so a strictly-greater test is a total order here. Equal is
 * not newer: a resumed automation writes its subscription and then its email
 * route, and only the second of those two pushes carries a higher number.
 */

export type SidebarList = 'automations' | 'canvases';
type SidebarWaterline = SidebarList | 'spaces';

/** The cache entries the shell reads these lists under. */
export const SIDEBAR_LIST_QUERY_KEYS = {
  automations: ['automations'],
  /** This viewer's Canvases (`workspace_canvas_list`); see docs/canvases.md. */
  canvases: ['canvases'],
} as const satisfies Record<SidebarList, readonly unknown[]>;

export const SPACES_QUERY_KEY = ['spaces'] as const;
export const INACTIVE_SPACES_QUERY_KEY = ['spaces-inactive'] as const;
/**
 * Whether the Organization has finished creating General and placing every
 * Channel in it.
 *
 * A cache entry rather than a field on either directory, because it travels
 * beside both of them on the connect payload and on every snapshot, and a copy
 * on each list would be two answers to one question. Absent until the first
 * payload arrives; `undefined` is "not answered yet", which the surfaces read
 * as ready so a build talking to a server without the cutover is not
 * permanently opening.
 */
export const SPACES_READY_QUERY_KEY = ['spaces-ready'] as const;

/**
 * Every list this viewer has arranged by hand, whatever contains it.
 *
 * One entry rather than one per container, because it arrives as one field on
 * the same payload the Space directories do and is applied under the same
 * waterline: three cache entries filled from one message would be three things
 * a stale message could half-apply. The surfaces read a missing answer as an
 * empty ordering, which draws every list in its natural order — what a client
 * talking to a server without this field should show.
 */
export const PERSONAL_ORDER_QUERY_KEY = ['personal-order'] as const;
/** All's Pinned order; see `PinnedOrderSchema`. */
export const PINNED_ORDER_QUERY_KEY = ['pinned-order'] as const;
/** Every pin this person has, each kind in their order: the Channels and Threads tabs' Pinned sections. */
export const PINS_QUERY_KEY = ['pins'] as const;
/** This person's pinned artifacts in their order: the Artifacts tab, and the Pinned tab's Artifacts part. */
export const ARTIFACT_PINS_QUERY_KEY = ['artifact-pins'] as const;
/** Each listed Channel's thread count and last activity, for the Channels tab. */
export const CHANNEL_STATS_QUERY_KEY = ['channel-stats'] as const;
/** The Threads tab's server list: threads and breakouts this person takes part in or pinned. */
export const MY_THREADS_QUERY_KEY = ['my-threads'] as const;
export interface ThreadNavigationPage {
  items: SpaceConversationSummary[];
  pinned?: SpaceConversationSummary[];
}

/** A confirmed local archive removes navigation copies before the socket evicts its marker. */
export function removeArchivedThreadNavigation(queryClient: QueryClient, threadId: string): void {
  const keep = (row: SpaceConversationSummary): boolean => row.id !== threadId && row.breakoutOf?.workstreamId !== threadId;
  queryClient.setQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY, (current) => current ? {
    ...current,
    pages: current.pages.map((page) => ({ ...page, items: page.items.filter(keep), pinned: page.pinned?.filter(keep) })),
  } : current);
}
/** The Activity tab's first page. */
export const ACTIVITY_QUERY_KEY = ['activity'] as const;
/** One Channel's feed. */
/**
 * A write this person made in another window: the whole pin list, or the
 * rows of the Channels whose read state moved (`workspace_navigation_state`).
 */
export function applyNavigationState(
  queryClient: QueryClient,
  state: { pins?: PinList | undefined; artifactPins?: ArtifactPinList | undefined; channelStats?: ChannelStats[] | undefined },
): void {
  if (state.pins) queryClient.setQueryData(PINS_QUERY_KEY, state.pins);
  if (state.artifactPins) queryClient.setQueryData(ARTIFACT_PINS_QUERY_KEY, state.artifactPins);
  const rows = state.channelStats;
  if (!rows || rows.length === 0) return;
  queryClient.setQueryData<ChannelStats[]>(CHANNEL_STATS_QUERY_KEY, (current) => {
    if (!current) return current;
    const changed = new Map(rows.map((row) => [row.channelId, row]));
    const merged = current.map((row) => changed.get(row.channelId) ?? row);
    const held = new Set(current.map((row) => row.channelId));
    return [...merged, ...rows.filter((row) => !held.has(row.channelId))];
  });
}

/** Every Channel feed held, the prefix each `channelFeedQueryKey` starts with. */
export const CHANNEL_FEEDS_QUERY_KEY = ['channel-feed'] as const;

export function channelFeedQueryKey(channelId: string): readonly ['channel-feed', string] {
  return ['channel-feed', channelId];
}

const SIDEBAR_LIST_WATERLINES_KEY = ['sidebar-list-waterlines'] as const;

/**
 * Keep the ledger for as long as the lists it orders.
 *
 * Nothing renders the waterlines, so no `useQuery` observes them and React
 * Query counts the entry as inactive the moment it is written — collectable
 * after `gcTime`, five minutes by default. The two lists survive because
 * `useSocketOwnedList` observes them; the ledger would quietly vanish under
 * them and reset the guard to -1, at which point the next list to arrive is
 * applied whatever its version. The lists still look right, so the only visible
 * symptom is the total order silently no longer holding — the one property this
 * module exists for.
 *
 * Pinned here rather than at provider setup, and before the first write, for
 * two reasons: a default only applies to a query built after it is set, and the
 * invariant belongs beside the code that depends on it instead of somewhere a
 * later provider can forget it.
 */
function pinWaterlineLedger(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(SIDEBAR_LIST_WATERLINES_KEY, { gcTime: Number.POSITIVE_INFINITY });
}

interface SidebarListItems {
  automations: AutomationSummary[];
  canvases: CanvasSidebarRow[];
}

/**
 * Replace one list if this version is newer than the one already applied.
 *
 * Returns whether it was applied, which is what the tests assert on: a dropped
 * duplicate and an applied update are otherwise indistinguishable from outside.
 */
export function applyVersionedSidebarList<K extends SidebarList>(
  queryClient: QueryClient,
  list: K,
  waterline: number,
  items: SidebarListItems[K],
): boolean {
  pinWaterlineLedger(queryClient);
  const waterlines = queryClient.getQueryData<Partial<Record<SidebarList, number>>>(
    SIDEBAR_LIST_WATERLINES_KEY,
  ) ?? {};
  // Seeded at -1 rather than 0: a workspace that has never written either table
  // is served waterline 0, and that first list still has to apply.
  if (waterline <= (waterlines[list] ?? -1)) return false;
  queryClient.setQueryData<Partial<Record<SidebarWaterline, number>>>(
    SIDEBAR_LIST_WATERLINES_KEY,
    (current = {}) => ({ ...current, [list]: waterline }),
  );
  queryClient.setQueryData<SidebarListItems[K]>(SIDEBAR_LIST_QUERY_KEYS[list], items);
  return true;
}

/**
 * Apply both Space directories only when their WorkspaceDO waterline is newer.
 *
 * One waterline for the pair, because WorkspaceDO reads both halves inside one
 * transaction and the contract refuses a snapshot whose two halves disagree: a
 * client that applied them separately could render a Space in both lists or in
 * neither.
 *
 * The ordering rides with it for the same reason and under the same test: a
 * write can be the write that moved it, and an older payload must not put the
 * previous arrangement back over a newer one.
 *
 * `spacesReady` rides with the snapshot rather than having a ledger of its own.
 * A write can be the write that finishes the cutover, so the flag is only ever
 * as current as the snapshot it arrived with, and applying it under the same
 * test is what stops an older payload putting the Organization-opening state
 * back.
 */
export function applyVersionedSpaceSnapshot(
  queryClient: QueryClient,
  snapshot: SpaceSnapshot,
  ordering: PersonalOrder,
  spacesReady: boolean,
  /** All's Pinned order; a payload from a server without it reads as none. */
  pinnedOrder: PinnedOrder = [],
  /** Absent from a server before the navigation redesign; leaves what is held. */
  navigation: { pins?: PinList | undefined; artifactPins?: ArtifactPinList | undefined; channelStats?: ChannelStats[] | undefined } = {},
): boolean {
  pinWaterlineLedger(queryClient);
  // Not under the Space waterline: both are this person's own state, sent in
  // order on one socket, so the newest frame is the current one. Only the
  // connect payload carries Channel stats; a broadcast snapshot leaves them
  // out, and a Space change is when they may have moved, so they are read
  // again instead.
  if (navigation.pins) queryClient.setQueryData(PINS_QUERY_KEY, navigation.pins);
  // Only the connect payload carries them; a broadcast snapshot leaves what is held.
  if (navigation.artifactPins) queryClient.setQueryData(ARTIFACT_PINS_QUERY_KEY, navigation.artifactPins);
  if (navigation.channelStats) queryClient.setQueryData(CHANNEL_STATS_QUERY_KEY, navigation.channelStats);
  else void queryClient.invalidateQueries({ queryKey: CHANNEL_STATS_QUERY_KEY });
  const waterlines = queryClient.getQueryData<Partial<Record<SidebarWaterline, number>>>(
    SIDEBAR_LIST_WATERLINES_KEY,
  ) ?? {};
  if (snapshot.active.waterline <= (waterlines.spaces ?? -1)) return false;
  queryClient.setQueryData<Partial<Record<SidebarWaterline, number>>>(
    SIDEBAR_LIST_WATERLINES_KEY,
    (current = {}) => ({ ...current, spaces: snapshot.active.waterline }),
  );
  queryClient.setQueryData(SPACES_QUERY_KEY, snapshot.active);
  queryClient.setQueryData(INACTIVE_SPACES_QUERY_KEY, snapshot.inactive);
  queryClient.setQueryData(PERSONAL_ORDER_QUERY_KEY, ordering);
  queryClient.setQueryData(PINNED_ORDER_QUERY_KEY, pinnedOrder);
  queryClient.setQueryData(SPACES_READY_QUERY_KEY, spacesReady);
  return true;
}

/**
 * Put one container's newly written order in place without waiting for the
 * snapshot that carries it.
 *
 * The write answers with what the authority actually stored, and that answer is
 * the same state the republished snapshot is about to bring — so applying it
 * here is what keeps a dropped drag order from flashing the old arrangement in
 * the frame between the response and the socket message. It moves no waterline,
 * because it is not a snapshot: the republication that follows still applies
 * over it, and an older one is still refused.
 */
export function applyContainerOrder(
  queryClient: QueryClient,
  order: ContainerOrder,
  expectedCurrent?: PersonalOrder,
): void {
  queryClient.setQueryData<PersonalOrder>(PERSONAL_ORDER_QUERY_KEY, (current = []) => {
    if (expectedCurrent !== undefined && current !== expectedCurrent) return current;
    return [
      ...current.filter((entry) => !sameContainer(entry.container, order.container)),
      order,
    ];
  });
}

/**
 * Read a list the workspace socket owns and nothing here fetches.
 *
 * `useWorkstreamsQuery`'s opening batch seeds it and WorkspaceDO re-sends it
 * whole on every change, so there is no fetch to make and no staleness for
 * React Query to police. The query exists only to subscribe the caller to the
 * cache entry; the fetcher is unreachable and says so, because a silent
 * `undefined` from an accidentally enabled query would look like an empty
 * sidebar rather than a bug. Invalidating one of these keys does nothing by
 * design — the socket is the only *authority* for the contents.
 *
 * Subscribing is the point: a `getQueryData` read of the same entry returns the
 * same rows and never re-renders when the socket replaces them, so the caller
 * paints whatever it happened to hold until something unrelated re-renders it.
 */
export function useSocketOwnedList<T>(queryKey: readonly unknown[]): UseQueryResult<T[]> {
  return useQuery<T[]>({
    queryKey,
    queryFn: () => {
      throw new Error(`${String(queryKey[0])} is pushed by the organization socket, never fetched`);
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
