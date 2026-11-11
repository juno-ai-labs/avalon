import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import type { AutomationSummary } from './types';

/** This viewer's Sidekicks as the workspace socket keeps them; undefined until it has said. */
export function useSidekickList(): AutomationSummary[] | undefined {
  return useSocketOwnedList<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
}
