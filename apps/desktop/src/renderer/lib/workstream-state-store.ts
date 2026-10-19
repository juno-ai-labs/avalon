import type { WorkstreamStateVersion } from '@rally/contracts';
import type { QueryClient } from '@tanstack/react-query';

import type { WorkstreamDetail, WorkstreamSummary } from './types';
import {
  WORKSTREAMS_QUERY_KEY,
  evictCachedWorkstream,
  patchCachedWorkstream,
  setCachedWorkstreams,
} from './workstreams-cache';

export const WORKSTREAM_STATE_WATERLINES_KEY = ['workstream-state-waterlines'] as const;
export const WORKSPACE_DIRECTORY_WATERLINES_KEY = ['workspace-directory-waterlines'] as const;

type StoredWaterlines = WorkstreamStateVersion & { visible: boolean };

type WorkstreamPatch = Partial<WorkstreamSummary>;

export interface VersionedWorkstreamState {
  workstreamId: string;
  stateVersion: WorkstreamStateVersion;
  common: WorkstreamPatch;
  viewer: WorkstreamPatch;
  /** A complete row used when neither cache has seen a visible work stream yet. */
  seed?: WorkstreamSummary;
  visible: boolean;
}

export interface WorkstreamStateApplyResult {
  commonApplied: boolean;
  viewerApplied: boolean;
  /** The newest accepted listability, including a tombstone whose row is no longer cached. */
  visible: boolean;
}

export function workstreamSummaryState(workstream: WorkstreamSummary): {
  common: WorkstreamPatch;
  viewer: WorkstreamPatch;
  seed: WorkstreamSummary;
} {
  return {
    common: {
      id: workstream.id,
      title: workstream.title,
      titleStatus: workstream.titleStatus,
      appearance: workstream.appearance,
      objective: workstream.objective,
      emailAddress: workstream.emailAddress,
      createdByUserId: workstream.createdByUserId,
      harnessStatus: workstream.harnessStatus,
      latestAttentionSequenceNumber: workstream.latestAttentionSequenceNumber,
      lastActivityAt: workstream.lastActivityAt,
      createdAt: workstream.createdAt,
      updatedAt: workstream.updatedAt,
      archivedAt: workstream.archivedAt,
      preview: workstream.preview,
      scope: workstream.scope,
      systemKind: workstream.systemKind,
      nextPendingWakeup: workstream.nextPendingWakeup,
      participantUserIds: workstream.participantUserIds,
      participantExtraCount: workstream.participantExtraCount,
      // Common rather than viewer state: a Channel's Space placements are the
      // Organization's, not this reader's, and WorkspaceDO republishes the row
      // after every membership settlement. Without it here, a Channel added to
      // a Space stays under the Spaces it had until the whole directory is
      // read again.
      spaceIds: workstream.spaceIds,
      // Viewer-specific, but carried with the complete row because it is an
      // aggregate over child conversations rather than one of Main's fields.
      breakoutAttentionCount: workstream.breakoutAttentionCount,
    },
    viewer: {
      readThroughSequenceNumber: workstream.readThroughSequenceNumber,
      manualUnreadFromSequenceNumber: workstream.manualUnreadFromSequenceNumber,
      manualUnreadGeneration: workstream.manualUnreadGeneration,
      youAreMentioned: workstream.youAreMentioned,
      unseen: workstream.unseen,
      // Only when said: a child-owned response does not carry it, and must not
      // erase what the directory row said.
      ...(workstream.isParticipant !== undefined ? { isParticipant: workstream.isParticipant } : {}),
      // Viewer-specific: whether Main is this reader's. Carried as an explicit
      // `undefined` too, so a row whose Main became theirs drops the mark.
      mainWithheld: workstream.mainWithheld,
    },
    seed: workstream,
  };
}

/**
 * The unread pair every writer of viewer state has to agree on: `hasUnread` and
 * `firstUnreadSequenceNumber` are derived from the manual mark, the read
 * waterline, and the latest attention ordinal — never stored independently. Two
 * copies of this arithmetic is how a sidebar dot and a transcript divider come
 * to disagree about the same work stream, so the realtime feed's own attention
 * advance imports this rather than repeating it.
 */
export function withDerivedUnread<T extends WorkstreamSummary>(workstream: T): T {
  const manual = workstream.manualUnreadFromSequenceNumber;
  const seen = workstream.readThroughSequenceNumber;
  const latest = workstream.latestAttentionSequenceNumber;
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  return {
    ...workstream,
    hasUnread: firstUnread !== null,
    firstUnreadSequenceNumber: firstUnread,
  };
}

/**
 * Whether this payload's Space placements are news, on a row the waterline
 * ledger is about to reject.
 *
 * A placement is the Organization's fact about a Channel and changes nothing
 * the Channel's own authority projects, so WorkspaceDO republishes the row at
 * exactly the waterline it already had whenever the membership implied no
 * audience change — adding an already Organization-wide Channel to a second
 * Organization-wide Space is the ordinary case. The ledger reads that as a
 * duplicate and drops it, which left the Channel under the Spaces it had for
 * the rest of the session; the local cache then persisted that row, so a
 * reload did not repair it either. The empty-pile case beside this is the same
 * shape — a republication that is not newer and still carries something the
 * stored row does not have.
 *
 * Read off the row cache rather than the ledger, which holds waterlines and
 * not placements, and only from the branch that would otherwise stop: the
 * ordinary push has already applied its common half and never reaches here.
 * A payload from a superseded authority generation is still refused; its whole
 * epoch has been replaced.
 */
function carriesNewPlacements(
  queryClient: QueryClient,
  input: VersionedWorkstreamState,
  staleGeneration: boolean,
): boolean {
  const placements = input.common.spaceIds;
  if (!input.visible || staleGeneration || placements === undefined) return false;
  const held = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
    ?.find((item) => item.id === input.workstreamId)?.spaceIds;
  return held === undefined
    || held.length !== placements.length
    || placements.some((spaceId, index) => held[index] !== spaceId);
}

function carriesNewBreakoutAttentionCount(
  queryClient: QueryClient,
  input: VersionedWorkstreamState,
  staleGeneration: boolean,
): boolean {
  const count = input.common.breakoutAttentionCount;
  if (!input.visible || staleGeneration || count === undefined) return false;
  return queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
    ?.find((item) => item.id === input.workstreamId)?.breakoutAttentionCount !== count;
}

/**
 * Whether this payload says, for the first time, whether the reader takes
 * part in Main. A window that held the row before the server sent the field
 * gets the same waterlines back after it does, and would otherwise keep
 * counting a thread the reader is not in until the viewer half next moves.
 */
function carriesFirstParticipation(
  queryClient: QueryClient,
  input: VersionedWorkstreamState,
  staleGeneration: boolean,
): boolean {
  if (!input.visible || staleGeneration || input.viewer.isParticipant === undefined) return false;
  const held = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
    ?.find((item) => item.id === input.workstreamId);
  return held !== undefined && held.isParticipant === undefined;
}

/**
 * The one receiver for both WorkspaceDO and WorkstreamDO state sockets.
 *
 * Common and viewer rows advance independently. This is what makes a delayed
 * Queue delivery safe: a new viewer row cannot accidentally suppress a common
 * row the WorkspaceDO has not received yet, and vice versa.
 */
export function applyVersionedWorkstreamState(
  queryClient: QueryClient,
  input: VersionedWorkstreamState,
): WorkstreamStateApplyResult {
  const ledger = queryClient.getQueryData<Record<string, StoredWaterlines>>(
    WORKSTREAM_STATE_WATERLINES_KEY,
  ) ?? {};
  const current = ledger[input.workstreamId];
  const newerGeneration = !current
    || input.stateVersion.authorityGeneration > current.authorityGeneration;
  const staleGeneration = current
    && input.stateVersion.authorityGeneration < current.authorityGeneration;
  const commonApplied = !staleGeneration && (newerGeneration
    || input.stateVersion.commonWaterline > current.commonWaterline);
  const viewerApplied = !staleGeneration && (newerGeneration
    || input.stateVersion.viewerWaterline > current.viewerWaterline);
  const visibilityApplied = !staleGeneration && (newerGeneration || !current || (
    input.stateVersion.commonWaterline >= current.commonWaterline
    && input.stateVersion.viewerWaterline >= current.viewerWaterline
  ));
  // A tombstone is listability authority, so none of the equal-version
  // exceptions below may turn its missing row into an empty cache slot to
  // seed. They repair fields on a visible row; they never restore one.
  if (!commonApplied && !viewerApplied && current?.visible === false) {
    return { commonApplied, viewerApplied, visible: false };
  }
  const incomingIds = input.common.participantUserIds;
  // A control seed can claim an empty pile at a waterline the later
  // directory page shares. That page then looks like a duplicate and would
  // otherwise be dropped, leaving the row blank for the session.
  const canFillEmptyPile = input.visible
    && input.common.scope !== 'workspace'
    && incomingIds !== undefined
    && incomingIds.length > 0;
  if (!commonApplied && !viewerApplied && !canFillEmptyPile
    && !carriesNewPlacements(queryClient, input, staleGeneration === true)
    && !carriesNewBreakoutAttentionCount(queryClient, input, staleGeneration === true)
    && !carriesFirstParticipation(queryClient, input, staleGeneration === true)) {
    return { commonApplied, viewerApplied, visible: current?.visible ?? input.visible };
  }

  // `visible` is a composite of the common row's archive/scope and the viewer
  // row's participation. Accept it only when neither half of the snapshot is
  // behind the half already accepted locally. Either waterline may advance on
  // its own while the other remains equal; what is unsafe is a snapshot that
  // combines one newer half with one stale half.
  const visible = visibilityApplied ? input.visible : current?.visible ?? input.visible;

  queryClient.setQueryData<Record<string, StoredWaterlines>>(
    WORKSTREAM_STATE_WATERLINES_KEY,
    (stored = {}) => ({
      ...stored,
      [input.workstreamId]: {
        commonEventId: commonApplied
          ? input.stateVersion.commonEventId
          : stored[input.workstreamId]?.commonEventId ?? input.stateVersion.commonEventId,
        viewerEventId: viewerApplied
          ? input.stateVersion.viewerEventId
          : stored[input.workstreamId]?.viewerEventId ?? null,
        authorityGeneration: input.stateVersion.authorityGeneration,
        commonWaterline: commonApplied
          ? input.stateVersion.commonWaterline
          : stored[input.workstreamId]?.commonWaterline ?? 0,
        viewerWaterline: viewerApplied
          ? input.stateVersion.viewerWaterline
          : stored[input.workstreamId]?.viewerWaterline ?? 0,
        visible,
      },
    }),
  );

  if (!visible) {
    evictCachedWorkstream(queryClient, input.workstreamId);
    return { commonApplied, viewerApplied, visible };
  }

  // A successful REST archive is held as a hidden row until the versioned
  // tombstone arrives. A directory page already in flight may carry a newer
  // version than this window had seen before the click, but it still predates
  // the archive response and must not clear that confirmed local fact.
  const heldArchive = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
    ?.find((item) => item.id === input.workstreamId)?.archivedAt;
  const restoresHeldArchive = heldArchive
    && visibilityApplied
    && Object.hasOwn(input.common, 'archivedAt')
    && input.common.archivedAt === undefined
    && typeof input.common.updatedAt === 'string'
    && input.common.updatedAt > heldArchive;
  if (heldArchive && !restoresHeldArchive) return { commonApplied, viewerApplied, visible };

  const merge = <T extends WorkstreamSummary>(value: T): T => {
    const {
      archivedAt: incomingArchivedAt,
      scope: incomingScope,
      ...nonVisibilityCommon
    } = input.common;
    const patched = {
      ...value,
      ...(commonApplied ? nonVisibilityCommon : {}),
      // Scope and archive state participate in the composite listability
      // decision above. Do not let one fresh common half change how the row is
      // filtered while its paired viewer half is stale; take these fields as
      // soon as a snapshot contains two current halves, even if the common
      // waterline itself was accepted from an earlier delivery.
      ...(visibilityApplied && Object.hasOwn(input.common, 'archivedAt')
        ? { archivedAt: incomingArchivedAt }
        : {}),
      ...(visibilityApplied && incomingScope !== undefined ? { scope: incomingScope } : {}),
      ...(viewerApplied ? input.viewer : {}),
    };
    // Control-socket seeds claim an empty pile at a waterline the later
    // directory page often shares. Without this, that page is rejected and
    // the row stays empty for the session. Workspace-scoped rows never carry
    // a pile — empty incoming `[]` does not fill, and a public row strips
    // leftover ids from when it was personal.
    const incomingPileIds = input.common.participantUserIds;
    if (
      !commonApplied
      && patched.scope !== 'workspace'
      && (patched.participantUserIds?.length ?? 0) === 0
      && incomingPileIds
      && incomingPileIds.length > 0
    ) {
      patched.participantUserIds = incomingPileIds;
      patched.participantExtraCount = input.common.participantExtraCount ?? 0;
    }
    if (patched.scope === 'workspace') {
      patched.participantUserIds = [];
      patched.participantExtraCount = 0;
    }
    // Described, not created: it stays pending until its create answers. See
    // `keepPendingWorkstreams`.
    if (commonApplied && patched.pending) patched.pendingListed = true;
    // The other half of `carriesNewPlacements`: the row is here, so take the
    // placements off it even though the rest of the common half is not this
    // payload's to write.
    if (!commonApplied && input.common.spaceIds !== undefined) {
      patched.spaceIds = input.common.spaceIds;
    }
    if (!commonApplied && input.common.breakoutAttentionCount !== undefined) {
      patched.breakoutAttentionCount = input.common.breakoutAttentionCount;
    }
    // The other half of `carriesFirstParticipation`: fill the field once, and
    // never let an equal-version row overwrite one already said.
    if (!viewerApplied && patched.isParticipant === undefined && input.viewer.isParticipant !== undefined) {
      patched.isParticipant = input.viewer.isParticipant;
    }
    // The other half of `carriesNewPlacements`: the row is here, so take the
    // placements off it even though the rest of the common half is not this
    // payload's to write.
    return withDerivedUnread(patched) as T;
  };
  setCachedWorkstreams(queryClient, (items) => {
    if (!items) return input.seed ? [merge(input.seed)] : items;
    const index = items.findIndex((item) => item.id === input.workstreamId);
    if (index === -1) return input.seed ? [merge(input.seed), ...items] : items;
    return items.map((item, itemIndex) => itemIndex === index ? merge(item) : item);
  });
  queryClient.setQueryData<WorkstreamDetail>(['workstream', input.workstreamId], (detail) => (
    detail ? merge(detail) : detail
  ));
  return { commonApplied, viewerApplied, visible };
}

/**
 * Take the viewer half of a REST response the caller just received — a read
 * acknowledgement, an unread mark — and nothing else from it.
 *
 * Those responses are a whole `WorkstreamSummary` from Main's row, and spreading
 * one over the caches would also write its common fields (appearance, harness
 * status, scope) through an unversioned path, where a response computed before
 * a later change and delivered after it puts the older value back. Only the
 * viewer fields are the response's own news, so only they are taken, and the
 * derived unread pair is recomputed here rather than copied, per the rule on
 * `withDerivedUnread`.
 */
export function patchCachedWorkstreamViewerState(
  queryClient: QueryClient,
  workstreamId: string,
  summary: WorkstreamSummary,
  substreamId = '0',
): void {
  const { viewer } = workstreamSummaryState(summary);
  patchCachedWorkstream(queryClient, workstreamId, (row) => (
    supersededViewerState(row, summary) ? row : withDerivedUnread({ ...row, ...viewer })
  ), substreamId);
}

/**
 * Whether an answer is older than what the entry already holds.
 *
 * These responses have no waterline of their own, and more than one can be in
 * flight: the read acknowledgement is debounced at 250ms and keyed on the
 * sequence it carries, so a slower round trip for an earlier position can land
 * after a later one. Applied in arrival order, the earlier answer rolls the
 * waterline back and the unread divider returns above a message that has been
 * read, until something else moves it again.
 *
 * Both fields only move forward at the authority, which is what lets arrival
 * order be corrected here rather than fenced upstream: `seen_attention_ordinal`
 * is written with `MAX`, and the manual-unread generation is a version that
 * only increments. So within one generation the higher read-through is the
 * later answer, and across generations the higher generation is, whatever its
 * read-through says. A mark-unread does not lower the read-through; it raises
 * the generation, which is why the two are compared in that order rather than
 * together.
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

/** Workspace-only fields use WorkspaceDO's own directory/page ordering. */
export function applyWorkspaceWorkstreamFields(
  queryClient: QueryClient,
  workstreamId: string,
  patch: Pick<WorkstreamSummary, 'pinPosition' | 'spacePins' | 'lastAccessedAt'>,
  directoryWaterline: number,
): boolean {
  const waterlines = queryClient.getQueryData<Record<string, number>>(
    WORKSPACE_DIRECTORY_WATERLINES_KEY,
  ) ?? {};
  if (directoryWaterline <= (waterlines[workstreamId] ?? -1)) return false;
  queryClient.setQueryData<Record<string, number>>(
    WORKSPACE_DIRECTORY_WATERLINES_KEY,
    (current = {}) => ({ ...current, [workstreamId]: directoryWaterline }),
  );
  setCachedWorkstreams(queryClient, (items) => items?.map((item) => (
    item.id === workstreamId ? { ...item, ...patch } : item
  )));
  return true;
}
