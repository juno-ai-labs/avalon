import type { QueryClient } from '@tanstack/react-query';
import type { AutomationSummary, NoteSummary } from './types';

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

export type SidebarList = 'automations' | 'notes';

/** The cache entries the shell reads these lists under. */
export const SIDEBAR_LIST_QUERY_KEYS = {
  automations: ['automations'],
  notes: ['notes'],
} as const satisfies Record<SidebarList, readonly unknown[]>;

const SIDEBAR_LIST_WATERLINES_KEY = ['sidebar-list-waterlines'] as const;

interface SidebarListItems {
  automations: AutomationSummary[];
  notes: NoteSummary[];
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
