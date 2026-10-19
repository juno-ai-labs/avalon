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
/**
 * One page of the sidebar's list, as the subscribe answer and every later
 * `list_workstreams` request size it. The local cache persists this many rows
 * of the flat list, whatever browsing has appended past them.
 */
export const WORKSTREAM_PAGE_SIZE = 250;

export function setCachedWorkstreams(
  queryClient: QueryClient,
  update: WorkstreamsCacheUpdate,
): void {
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) => {
    if (current !== undefined) assertWorkstreamList(current);
    const next = typeof update === 'function' ? update(current) : update;
    if (next !== undefined) assertWorkstreamList(next);
    return keepPendingWorkstreams(current, next);
  });
}

/**
 * Keep every pending row of `current` pending in `next`.
 *
 * A pending row is a Channel this window has asked for and whose create has
 * not answered. A directory page, a connect payload or a refetch that replaces
 * the list would otherwise take it off screen while its create is in flight.
 *
 * The server can list the Channel before the create answers: its Space
 * placement publishes the row, and the conversation is written after that, so
 * for a moment the Channel is listed with a room that refuses connections. A
 * row for a pending id is therefore taken as the server's description of it,
 * and stays pending. It leaves pending only through
 * `releasePendingWorkstreams`: the create's confirm or discard, or an
 * eviction. The refetch writes its answer without going through
 * `setCachedWorkstreams`, so it calls this too.
 */
export function keepPendingWorkstreams(
  current: WorkstreamSummary[] | undefined,
  next: WorkstreamSummary[] | undefined,
): WorkstreamSummary[] | undefined {
  if (next === undefined || !current?.some((row) => row.pending)) return next;
  const pending = new Map(current.filter((row) => row.pending).map((row) => [row.id, row]));
  const listed = new Set(next.map((row) => row.id));
  const kept = [...pending.values()].filter((row) => !listed.has(row.id));
  const described = next.map((row) => {
    const held = pending.get(row.id);
    if (!held || row.pending) return row;
    return {
      ...row,
      pending: true as const,
      pendingListed: true as const,
      ...(held.pendingOrigin ? { pendingOrigin: held.pendingOrigin } : {}),
      ...(held.pendingOpening ? { pendingOpening: held.pendingOpening } : {}),
    };
  });
  return kept.length === 0 ? described : [...kept, ...described];
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
 * List a Channel under the id the caller has given it, before its create is
 * sent. The server creates it under the same id, so the row it lists later
 * describes this one in place: same key, same slot, nothing to reconcile. It
 * stays pending until the create confirms or discards it.
 * Without a chosen title it is `naming`, the skeleton the server's own row
 * shows until Rally names it.
 */
export function addPendingWorkstream(queryClient: QueryClient, input: {
  id: string;
  title?: string;
  /** What is creating it, when that is not the launcher; see `pendingOrigin`. */
  origin?: WorkstreamSummary['pendingOrigin'];
  spaceIds: string[];
  scope: WorkstreamSummary['scope'];
  harnessStatus: WorkstreamSummary['harnessStatus'];
  createdAt: string;
  /** Who started it and what they asked, so every surface shows it before the server answers. */
  createdByUserId?: string;
  objective?: string;
  /** The opening as the transcript draws it; see `pendingOpening`. */
  opening?: WorkstreamSummary['pendingOpening'];
  /**
   * The colour of the Channel it is started in. The server gives the thread
   * that colour at birth, so the row shows it now rather than the id-derived
   * one it would otherwise draw until the server's row arrives.
   */
  color?: NonNullable<WorkstreamAppearance['color']>;
}): void {
  const row: WorkstreamSummary = {
    id: input.id,
    title: input.title ?? '',
    titleStatus: input.title ? 'settled' : 'naming',
    harnessStatus: input.harnessStatus,
    scope: input.scope,
    spaceIds: input.spaceIds,
    createdAt: input.createdAt,
    lastActivityAt: input.createdAt,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    participantUserIds: [],
    participantExtraCount: 0,
    nextPendingWakeup: null,
    pinPosition: null,
    pending: true,
    ...(input.origin ? { pendingOrigin: input.origin } : {}),
    ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.opening ? { pendingOpening: input.opening } : {}),
    ...(input.color ? { appearance: { icon: null, color: input.color } } : {}),
  };
  setCachedWorkstreams(queryClient, (current) => [
    row,
    ...(current ?? []).filter((existing) => existing.id !== row.id),
  ]);
}

/**
 * The create that listed this row failed. A row the server never described is
 * a Channel that does not exist, and goes. One it did describe exists anyway (a
 * create can fail after its Space placement commits, or its answer can be
 * lost), so it stays as the server described it. Answers whether it stayed.
 */
export function discardPendingWorkstream(queryClient: QueryClient, workstreamId: string): boolean {
  let kept = false;
  releasePendingWorkstreams(queryClient, (current) => current.flatMap((row) => {
    if (!(row.pending && row.id === workstreamId)) return [row];
    if (!row.pendingListed) return [];
    kept = true;
    return [settledRow(row)];
  }));
  return kept;
}

/**
 * The create answered: replace the pending row with the Channel as the server
 * created it, so the row is actionable now rather than at the next directory
 * push. A server row that already arrived is newer than the create response:
 * it is kept, and only stops being pending.
 *
 * Without `row` (a create made in another window, which hands over only the
 * id) the held row stops being pending as it is, and the next directory answer
 * describes it.
 *
 * Found by the id it was listed under rather than the answer's: a server from
 * before `workstreamId` existed creates the Channel under an id of its own,
 * and the row this window listed must not outlive the create either way.
 */
export function confirmPendingWorkstream(
  queryClient: QueryClient,
  pendingId: string,
  row?: WorkstreamSummary,
): void {
  releasePendingWorkstreams(queryClient, (current) => {
    const elsewhere = row !== undefined && row.id !== pendingId;
    const listedElsewhere = elsewhere && current.some((existing) => existing.id === row.id);
    return current.flatMap((existing) => {
      if (!(existing.pending && existing.id === pendingId)) return [existing];
      if (listedElsewhere) return [];
      if (row && (elsewhere || !existing.pendingListed)) return [row];
      return [settledRow(existing)];
    });
  });
}

/** The row without the client-only fields that say its create is in flight. */
function settledRow(row: WorkstreamSummary): WorkstreamSummary {
  const settled = { ...row };
  delete settled.pending;
  delete settled.pendingOrigin;
  delete settled.pendingOpening;
  delete settled.pendingListed;
  return settled;
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

/**
 * Keep a confirmed archive as a hidden directory marker until its versioned
 * tombstone arrives.
 *
 * Removing the row immediately leaves an empty slot that an older directory
 * page can seed while it is still in flight. The UI does not render archived
 * rows, but retaining this one lets the shared receiver compare that stale
 * page with a concrete newer fact instead of briefly resurrecting the Channel.
 * The authoritative tombstone later calls `evictCachedWorkstream` and removes
 * the marker altogether.
 */
export function holdCachedWorkstreamArchive(
  queryClient: QueryClient,
  archived: WorkstreamSummary,
): void {
  if (!archived.archivedAt) {
    // The archive route promises the committed archived row. If an older
    // server cannot supply that fact, retain the safe historical behavior.
    evictCachedWorkstream(queryClient, archived.id);
    return;
  }
  let archiveApplied = false;
  setCachedWorkstreams(queryClient, (current) => {
    const resident = current?.find((workstream) => workstream.id === archived.id);
    if (resident?.updatedAt && archived.updatedAt && resident.updatedAt > archived.updatedAt) {
      // Another client restored the Channel while this archive request was in
      // flight. Its newer committed row wins; hiding it here would consume the
      // already-delivered restore and leave no later event to reveal it again.
      return current;
    }
    archiveApplied = true;
    if (!current) return [archived];
    if (!current.some((workstream) => workstream.id === archived.id)) return [...current, archived];
    return current.map((workstream) => workstream.id === archived.id
      ? { ...workstream, archivedAt: archived.archivedAt, updatedAt: archived.updatedAt }
      : workstream);
  });
  if (archiveApplied) evictCachedWorkstreamContent(queryClient, archived.id);
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

/** Refresh page-one rows without truncating pages or debug rows already loaded. */
export function mergeCachedWorkstreamPage(
  queryClient: QueryClient,
  pageItems: WorkstreamSummary[],
): void {
  setCachedWorkstreams(queryClient, (current) => {
    if (current === undefined) return pageItems;
    const heldArchives = new Map(current
      .filter((workstream) => workstream.archivedAt)
      .map((workstream) => [workstream.id, workstream]));
    const refreshed = pageItems.map((workstream) => heldArchives.get(workstream.id) ?? workstream);
    const refreshedIds = new Set(pageItems.map((workstream) => workstream.id));
    return [
      ...refreshed,
      ...current.filter((workstream) => !refreshedIds.has(workstream.id)),
    ];
  });
}
