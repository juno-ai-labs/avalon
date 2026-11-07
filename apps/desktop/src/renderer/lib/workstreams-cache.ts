import type { QueryClient } from '@tanstack/react-query';
import type { WorkstreamAppearance, WorkstreamAppearancePatch } from '@rally/contracts';
import type { WorkstreamDetail, WorkstreamSummary } from './types';
import { forgetConversation, forgetConversationParent } from './conversation-cache';

/** The one cache entry every work-stream list reader and writer shares. */
export const WORKSTREAMS_QUERY_KEY = ['workstreams'] as const;

/**
 * The detail entry a conversation renders from: the parent's own for Main, and
 * a child-addressed one for a private substream, so a child opened beside its
 * parent never overwrites the parent's row.
 */
export function workstreamDetailQueryKey(
  workstreamId: string,
  substreamId = '0',
): readonly ['workstream', string] | readonly ['substream-workstream', string, string] {
  return substreamId === '0'
    ? ['workstream', workstreamId]
    : ['substream-workstream', workstreamId, substreamId];
}

type WorkstreamRowUpdate = Partial<WorkstreamSummary>
  | (<T extends WorkstreamSummary>(row: T) => T);

type WorkstreamsCacheUpdate = WorkstreamSummary[]
  | ((current: WorkstreamSummary[] | undefined) => WorkstreamSummary[] | undefined);

function assertWorkstreamList(value: unknown): asserts value is WorkstreamSummary[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid workstreams cache value: expected a WorkstreamSummary array.');
  }
}

export function setCachedWorkstreams(
  queryClient: QueryClient,
  update: WorkstreamsCacheUpdate,
): void {
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) => {
    if (current !== undefined) assertWorkstreamList(current);
    const next = typeof update === 'function' ? update(current) : update;
    if (next !== undefined) assertWorkstreamList(next);
    return next;
  });
}

/**
 * The one write that may remove a pending row: the create's own confirm or
 * discard, and an authoritative eviction of that id. Every other write goes
 * through `setCachedWorkstreams`, whose job for a pending row is to keep it.
 */
function releasePendingWorkstreams(
  queryClient: QueryClient,
  update: (current: WorkstreamSummary[]) => WorkstreamSummary[],
): void {
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) => {
    if (current === undefined) return current;
    assertWorkstreamList(current);
    return update(current);
  });
}

/**
 * Apply one edit to both places a work stream is read from: its row in the
 * shared list, which the sidebar renders, and a detail entry, which the open
 * conversation renders. Writing one and not the other is how the header and
 * the sidebar come to disagree about the same work stream.
 *
 * Main updates reach both its sidebar row and detail entry. A nonzero
 * `substreamId` addresses only that child's detail: a child title, scope, or
 * viewer fact must never replace its parent's value in the sidebar.
 *
 * This is for unversioned facts: a REST response the caller just received, a
 * pushed event with no waterline of its own, a command receipt. Versioned
 * common and viewer state goes through `applyVersionedWorkstreamState`, whose
 * ledger decides whether a payload applies at all; a later payload from it
 * replaces these fields whole, so it always has the last word. The derived
 * unread pair is not recomputed here; a caller that moves viewer fields goes
 * through `patchCachedWorkstreamViewerState` in the state store, which does.
 * [`docs/choosing-sockets-or-rest.md`](../../../../../docs/choosing-sockets-or-rest.md)
 * holds the rule.
 */
export function patchCachedWorkstream(
  queryClient: QueryClient,
  workstreamId: string,
  update: WorkstreamRowUpdate,
  substreamId = '0',
): void {
  const apply = <T extends WorkstreamSummary>(row: T): T =>
    typeof update === 'function' ? update(row) : { ...row, ...update };
  if (substreamId === '0') setCachedWorkstreams(queryClient, (current) =>
    current?.map((workstream) => workstream.id === workstreamId ? apply(workstream) : workstream));
  queryClient.setQueryData<WorkstreamDetail>(workstreamDetailQueryKey(workstreamId, substreamId), (detail) =>
    detail ? apply(detail) : detail);
}

/**
 * Show a person's own appearance choice on the sidebar row the moment Main has
 * acknowledged it, ahead of the projection that will carry it there.
 *
 * The list row only, and that goes for **every** unversioned appearance write,
 * a naming pass's generated icon included. The header renders the detail entry
 * under the picker's own preview, and `settled()` retires that preview as soon
 * as the detail's icon moves off the baseline it was taken against — to any
 * value, not only the one the person chose, because another person changing the
 * icon has to retire it too. So a write here of an icon nobody in this window
 * picked would retire a pending choice to the wrong glyph and hold it there
 * until the projection lands. The detail is the picker's own signal; only the
 * versioned projection may move it. Appearance is Main's, so
 * there is no substream to address. The merge mirrors Main's own
 * (`setAppearanceForAdmittedSocket`) because the receipt carries no payload;
 * the two bases can differ by the projection lag this write hides, and the
 * caller skips a receipt that crossed a reconnect because it may be a replay.
 * Why each of those is so, and what a receipt carrying the committed value
 * would change, is in
 * [`docs/workstream-appearance.md`](../../../../../docs/workstream-appearance.md).
 */
export function patchCachedWorkstreamAppearance(
  queryClient: QueryClient,
  workstreamId: string,
  patch: WorkstreamAppearancePatch,
): void {
  setCachedWorkstreams(queryClient, (current) => current?.map((row) => {
    if (row.id !== workstreamId) return row;
    const appearance: WorkstreamAppearance = { icon: null, color: null, ...row.appearance, ...patch };
    return { ...row, appearance };
  }));
}

/**
 * Put the icon a naming pass chose on the sidebar row, unless one is there.
 *
 * Row-only, for the reason above — the cached detail is the picker's signal and
 * only the versioned projection may move it.
 *
 * The condition is what the receipt-time write does not need. An event carries
 * an icon only when the object had none at the moment it renamed, so a row that
 * has one now holds something newer: a choice whose receipt already landed here.
 * The event can arrive after that receipt, because the two travel different
 * paths — the room socket and the Main command channel — so without the guard a
 * person's own icon flickers back to the generated one until the projection
 * lands. It is not a copy of the object's rule (that one is about what is
 * stored, and is authoritative); it is the ordering rule for an unversioned
 * write whose value is known-stale the moment anything else is present.
 */
export function patchCachedGeneratedIcon(
  queryClient: QueryClient,
  workstreamId: string,
  icon: NonNullable<WorkstreamAppearance['icon']>,
): void {
  setCachedWorkstreams(queryClient, (current) => current?.map((row) =>
    row.id === workstreamId && !row.appearance?.icon
      ? { ...row, appearance: { color: null, ...row.appearance, icon } }
      : row));
}

/**
 * Remove every per-work-stream cache entry when either room revokes access.
 *
 * The feed and control sockets can close independently. Keeping this boundary
 * shared prevents whichever one closes first from leaving transcript,
 * context, or recovery state visible until the other catches up.
 */
export function evictCachedWorkstream(
  queryClient: QueryClient,
  workstreamId: string,
): void {
  evictCachedWorkstreamContent(queryClient, workstreamId);
  // Through the release path: the server has said this Channel is gone, which
  // is as final for a row listed ahead of its create as for any other.
  releasePendingWorkstreams(queryClient, (current) =>
    current.filter((workstream) => workstream.id !== workstreamId));
}

function evictCachedWorkstreamContent(
  queryClient: QueryClient,
  workstreamId: string,
): void {
  const queryPrefixes = [
    ['workstream', workstreamId],
    ['workstream-children', workstreamId],
    ['channel-rail', workstreamId],
    ['workstream-background-agents', workstreamId],
    ['ordered-transcript', workstreamId],
    ['transcript-overlays', workstreamId],
    ['workstream-feed-source', workstreamId],
    ['workstream-socket-snapshot-generation', workstreamId],
    ['workstream-context', workstreamId],
    ['terminal-workstream', workstreamId],
    ['substream-workstream', workstreamId],
    ['substream-initial-context', workstreamId],
    ['substream-ordered-transcript', workstreamId],
    ['substream-transcript-overlays', workstreamId],
    ['substream-workstream-feed-source', workstreamId],
    ['substream-workstream-socket-snapshot-generation', workstreamId],
  ] as const;
  for (const queryKey of queryPrefixes) {
    queryClient.removeQueries({ queryKey });
  }
  // The disk goes with the memory, or the next launch paints a transcript
  // the reader was shut out of. Every child under the parent goes too.
  forgetConversationParent(workstreamId);
}

/** Remove one independently addressed child without disturbing its parent. */
export function evictCachedSubstream(
  queryClient: QueryClient,
  workstreamId: string,
  substreamId: string,
): void {
  if (substreamId === '0') {
    evictCachedWorkstream(queryClient, workstreamId);
    return;
  }
  const queryKeys = [
    ['substream-workstream', workstreamId, substreamId],
    ['substream-initial-context', workstreamId, substreamId],
    ['substream-ordered-transcript', workstreamId, substreamId],
    ['substream-transcript-overlays', workstreamId, substreamId],
    ['substream-workstream-feed-source', workstreamId, substreamId],
    ['substream-workstream-socket-snapshot-generation', workstreamId, substreamId],
  ] as const;
  for (const queryKey of queryKeys) queryClient.removeQueries({ queryKey, exact: true });
  forgetConversation(workstreamId, substreamId);
}

/** Invalidate both main-room and independently addressed child detail rows. */
export async function invalidateCachedWorkstreamDetails(
  queryClient: QueryClient,
  workstreamId?: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: workstreamId ? ['workstream', workstreamId] : ['workstream'],
    }),
    queryClient.invalidateQueries({
      queryKey: workstreamId
        ? ['substream-workstream', workstreamId]
        : ['substream-workstream'],
    }),
  ]);
}


/**
 * Whether an answer is older than what the entry already holds. Read
 * acknowledgements carry no waterline and more than one can be in flight, so
 * the higher manual-unread generation wins, and within one generation the
 * higher read-through: both only move forward at the authority.
 */
function supersededViewerState(
  row: Pick<WorkstreamSummary, 'readThroughSequenceNumber' | 'manualUnreadGeneration'>,
  viewer: Pick<WorkstreamSummary, 'readThroughSequenceNumber' | 'manualUnreadGeneration'>,
): boolean {
  if (viewer.manualUnreadGeneration !== row.manualUnreadGeneration) {
    return viewer.manualUnreadGeneration < row.manualUnreadGeneration;
  }
  return viewer.readThroughSequenceNumber < row.readThroughSequenceNumber;
}

/**
 * Apply a read acknowledgement's answer to the conversation's detail: the
 * reader's own waterlines, and the unread pair derived from them.
 */
export function patchCachedWorkstreamViewerState(
  queryClient: QueryClient,
  workstreamId: string,
  summary: WorkstreamSummary,
  substreamId = '0',
): void {
  patchCachedWorkstream(queryClient, workstreamId, (row) => {
    if (supersededViewerState(row, summary)) return row;
    const next = {
      ...row,
      readThroughSequenceNumber: summary.readThroughSequenceNumber,
      manualUnreadFromSequenceNumber: summary.manualUnreadFromSequenceNumber,
      manualUnreadGeneration: summary.manualUnreadGeneration,
      youAreMentioned: summary.youAreMentioned,
      unseen: summary.unseen,
    };
    const manual = next.manualUnreadFromSequenceNumber;
    const latest = next.latestAttentionSequenceNumber;
    const seen = next.readThroughSequenceNumber;
    const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
    return { ...next, hasUnread: firstUnread !== null, firstUnreadSequenceNumber: firstUnread };
  }, substreamId);
}
