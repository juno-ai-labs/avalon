import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { attentionItems, type AttentionItem, type Breakout } from './attention-ranking';
import { workstreamChildrenQueryKey, type WorkstreamChildDirectory } from './channel-viewer-state';
import type { WorkstreamSummary } from './types';

export { attentionItems, type AttentionItem, type BreakoutLists } from './attention-ranking';

/** The route that opens an item: its Channel, with the Breakout selected. */
export function attentionItemPath(item: Pick<AttentionItem, 'workstreamId' | 'substreamId'>): string {
  const path = `/workstreams/${encodeURIComponent(item.workstreamId)}`;
  return item.substreamId === null ? path : `${path}?substream=${encodeURIComponent(item.substreamId)}`;
}

function breakoutListsOf(results: ReadonlyArray<{ data: WorkstreamChildDirectory | undefined }>): Array<readonly Breakout[] | undefined> {
  return results.map((result) => result.data?.privateChildren);
}

/**
 * The attention items for the sidebar's Channel rows, reading each Breakout
 * list from the cache the Organization socket writes. Only a Channel whose row
 * says a Breakout needs the reader is read, and nothing is fetched.
 *
 * `breakoutListsLoaded` is false while any of those lists has not arrived:
 * the items then leave its Breakouts out, so their count is a floor rather
 * than the number.
 */
export function useAttentionItems(workstreams: readonly WorkstreamSummary[]): {
  items: AttentionItem[];
  breakoutListsLoaded: boolean;
} {
  const withBreakouts = useMemo(
    () => workstreams.filter((workstream) => (workstream.breakoutAttentionCount ?? 0) > 0).map((workstream) => workstream.id),
    [workstreams],
  );
  const breakouts = useQueries({
    queries: withBreakouts.map((id) => ({
      queryKey: workstreamChildrenQueryKey(id),
      queryFn: async (): Promise<WorkstreamChildDirectory | undefined> => undefined,
      enabled: false,
    })),
    combine: breakoutListsOf,
  });
  return useMemo(() => {
    const lists: Record<string, readonly Breakout[] | undefined> = {};
    withBreakouts.forEach((id, index) => { lists[id] = breakouts[index]; });
    return {
      items: attentionItems(workstreams, lists),
      breakoutListsLoaded: breakouts.every((list) => list !== undefined),
    };
  }, [breakouts, withBreakouts, workstreams]);
}
