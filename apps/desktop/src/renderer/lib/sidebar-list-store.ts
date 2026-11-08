import type { ActivityItem, CanvasSidebarRow } from '@rally/contracts';
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import type { AutomationSummary } from './types';

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

export type SidebarList = 'automations' | 'canvases' | 'activity';

/** One person's Activity as the socket keeps it: the newest page and how many of all of it are unseen. */
export interface ActivityList {
  unseenCount: number;
  items: ActivityItem[];
}

/** The cache entries the shell reads these lists under. */
export const SIDEBAR_LIST_QUERY_KEYS = {
  automations: ['automations'],
  /** This viewer's Canvases (`workspace_canvas_list`); see docs/canvases.md. */
  canvases: ['canvases'],
  /** This viewer's Activity (`workspace_activity_list`); see docs/activity.md. */
  activity: ['activity'],
} as const satisfies Record<SidebarList, readonly unknown[]>;

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
  activity: ActivityList;
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
  queryClient.setQueryData<Partial<Record<SidebarList, number>>>(
    SIDEBAR_LIST_WATERLINES_KEY,
    (current = {}) => ({ ...current, [list]: waterline }),
  );
  queryClient.setQueryData<SidebarListItems[K]>(SIDEBAR_LIST_QUERY_KEYS[list], items);
  return true;
}

/**
 * Whether the socket has applied this list in this session. A seed from the
 * local cache writes the list but never the ledger, so this is what tells a
 * mirror the list is the socket's rather than the disk's own copy back.
 */
export function sidebarListApplied(queryClient: QueryClient, list: SidebarList): boolean {
  return queryClient.getQueryData<Partial<Record<SidebarList, number>>>(SIDEBAR_LIST_WATERLINES_KEY)?.[list] !== undefined;
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
