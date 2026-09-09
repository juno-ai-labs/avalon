import type { QueryClient } from '@tanstack/react-query';
import type { WorkstreamAppearance, WorkstreamAppearancePatch } from '@rally/contracts';
import type { WorkstreamDetail, WorkstreamSummary } from './types';

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

/**
 * The only write boundary for the shared flat work-stream list.
 *
 * React Query's `setQueryData` infers its generic from the value being written,
 * not from the query key. Calling it directly therefore permits a page object
 * to be stored under a key whose readers independently expect an array. This
 * wrapper binds the key to the array at compile time, and the small runtime
 * invariant catches a cast or other type escape at the corrupting write rather
 * than at a later `.map` or `.filter` in the sidebar.
 */
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
 * The list row only: the header renders the detail entry under the picker's
 * own preview, which the picker retires once the detail carries the choice, so
 * writing the detail here would retire that preview on the receipt and expose
 * the header to an older projection still in flight. Appearance is Main's, so
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
  const queryPrefixes = [
    ['workstream', workstreamId],
    ['workstream-children', workstreamId],
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
  setCachedWorkstreams(queryClient, (current) =>
    current?.filter((workstream) => workstream.id !== workstreamId));
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

/** Refresh page-one rows without truncating pages or debug rows already loaded. */
export function mergeCachedWorkstreamPage(
  queryClient: QueryClient,
  pageItems: WorkstreamSummary[],
): void {
  setCachedWorkstreams(queryClient, (current) => {
    if (current === undefined) return pageItems;
    const refreshedIds = new Set(pageItems.map((workstream) => workstream.id));
    return [
      ...pageItems,
      ...current.filter((workstream) => !refreshedIds.has(workstream.id)),
    ];
  });
}
