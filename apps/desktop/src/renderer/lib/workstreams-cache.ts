import type { QueryClient } from '@tanstack/react-query';
import type { WorkstreamDetail, WorkstreamSummary } from './types';
import { forgetConversation, forgetConversationParent } from './conversation-cache';

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

/**
 * Apply one edit to the detail entry a conversation renders from. A nonzero
 * `substreamId` addresses only that child's detail, so a child's title, scope
 * or viewer fact never replaces its parent's.
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
  queryClient.setQueryData<WorkstreamDetail>(workstreamDetailQueryKey(workstreamId, substreamId), (detail) =>
    detail ? apply(detail) : detail);
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
}

function evictCachedWorkstreamContent(
  queryClient: QueryClient,
  workstreamId: string,
): void {
  const queryPrefixes = [
    ['workstream', workstreamId],
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
