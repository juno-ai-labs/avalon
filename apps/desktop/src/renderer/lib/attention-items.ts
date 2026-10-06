import type { Workstream, WorkstreamAppearance } from '@rally/contracts';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { workstreamChildrenQueryKey, type WorkstreamChildDirectory } from './channel-viewer-state';
import { markerRank, readerMarkerStatus, type ReaderMarkerStatus } from './format';
import type { WorkstreamSummary } from './types';

type Breakout = NonNullable<Workstream['privateChildren']>[number];

/** Breakout lists by Channel id, as the Organization socket last wrote them. */
export type BreakoutLists = Readonly<Record<string, readonly Breakout[] | undefined>>;

/**
 * One conversation waiting for this reader: a Channel's Main or one of its
 * Breakouts. `substreamId` is null for Main.
 */
export interface AttentionItem {
  key: string;
  workstreamId: string;
  substreamId: string | null;
  title: string;
  /** The Channel a Breakout sits in; null for Main. */
  channelTitle: string | null;
  /** The Channel's, for Main and Breakout alike, as the Space dashboard draws them. */
  appearance?: WorkstreamAppearance;
  reason: ReaderMarkerStatus;
  at: string;
}

/** The route that opens an item: its Channel, with the Breakout selected. */
export function attentionItemPath(item: Pick<AttentionItem, 'workstreamId' | 'substreamId'>): string {
  const path = `/workstreams/${encodeURIComponent(item.workstreamId)}`;
  return item.substreamId === null ? path : `${path}?substream=${encodeURIComponent(item.substreamId)}`;
}

function mainIsViewers(workstream: WorkstreamSummary): boolean {
  return workstream.mainWithheld !== true
    && (!workstream.associativeSubstreamId || workstream.associativeSubstreamId === '0');
}

/**
 * Every conversation that is waiting for this reader, most urgent first and
 * newest first within a reason.
 *
 * Built from what the sidebar already holds, so opening the menu costs no
 * request: the Channel rows say whether Main is unseen, mentions the reader or
 * is unread, and each Channel's Breakout list says the same per Breakout. A
 * mention written by Rally sets the same flag as one written by a person.
 */
export function attentionItems(workstreams: readonly WorkstreamSummary[], breakouts: BreakoutLists): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const workstream of workstreams) {
    if (workstream.pending || workstream.archivedAt || workstream.systemKind) continue;
    const main = mainIsViewers(workstream) ? readerMarkerStatus(workstream) : null;
    if (main) {
      items.push({
        key: workstream.id,
        workstreamId: workstream.id,
        substreamId: null,
        title: workstream.title,
        channelTitle: null,
        ...(workstream.appearance ? { appearance: workstream.appearance } : {}),
        reason: main,
        at: workstream.lastActivityAt,
      });
    }
    for (const breakout of breakouts[workstream.id] ?? []) {
      const reason = readerMarkerStatus({ ...breakout, hasUnread: (breakout.unreadCount ?? 0) > 0 });
      if (!reason) continue;
      items.push({
        key: `${workstream.id}:${breakout.substreamId}`,
        workstreamId: workstream.id,
        substreamId: breakout.substreamId,
        title: breakout.title,
        channelTitle: workstream.title,
        ...(workstream.appearance ? { appearance: workstream.appearance } : {}),
        reason,
        at: breakout.lastActivityAt ?? breakout.updatedAt,
      });
    }
  }
  return items.sort((left, right) => markerRank(left.reason) - markerRank(right.reason)
    || Date.parse(right.at) - Date.parse(left.at)
    || left.title.localeCompare(right.title));
}

function breakoutListsOf(results: ReadonlyArray<{ data: WorkstreamChildDirectory | undefined }>): Array<readonly Breakout[] | undefined> {
  return results.map((result) => result.data?.privateChildren);
}

/**
 * The attention items for the sidebar's Channel rows, reading each Breakout
 * list from the cache the Organization socket writes. Only a Channel whose row
 * says a Breakout needs the reader is read, and nothing is fetched.
 */
export function useAttentionItems(workstreams: readonly WorkstreamSummary[]): AttentionItem[] {
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
    return attentionItems(workstreams, lists);
  }, [breakouts, withBreakouts, workstreams]);
}
