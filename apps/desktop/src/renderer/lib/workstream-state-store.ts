import type { WorkstreamStateVersion } from '@rally/contracts';
import type { QueryClient } from '@tanstack/react-query';

import type { WorkstreamDetail, WorkstreamSummary } from './types';
import { evictCachedWorkstream, patchCachedWorkstream, setCachedWorkstreams } from './workstreams-cache';

export const WORKSTREAM_STATE_WATERLINES_KEY = ['workstream-state-waterlines'] as const;
export const WORKSPACE_DIRECTORY_WATERLINES_KEY = ['workspace-directory-waterlines'] as const;

type StoredWaterlines = WorkstreamStateVersion;

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
    },
    viewer: {
      readThroughSequenceNumber: workstream.readThroughSequenceNumber,
      manualUnreadFromSequenceNumber: workstream.manualUnreadFromSequenceNumber,
      manualUnreadGeneration: workstream.manualUnreadGeneration,
      youAreMentioned: workstream.youAreMentioned,
      unseen: workstream.unseen,
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
  const incomingIds = input.common.participantUserIds;
  // A control seed can claim an empty pile at a waterline the later
  // directory page shares. That page then looks like a duplicate and would
  // otherwise be dropped, leaving the row blank for the session.
  const canFillEmptyPile = input.visible
    && input.common.scope !== 'workspace'
    && incomingIds !== undefined
    && incomingIds.length > 0;
  if (!commonApplied && !viewerApplied && !canFillEmptyPile) {
    return { commonApplied, viewerApplied };
  }

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
      },
    }),
  );

  if (!input.visible) {
    evictCachedWorkstream(queryClient, input.workstreamId);
    return { commonApplied, viewerApplied };
  }

  const merge = <T extends WorkstreamSummary>(value: T): T => {
    const patched = {
      ...value,
      ...(commonApplied ? input.common : {}),
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
  return { commonApplied, viewerApplied };
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
  patchCachedWorkstream(queryClient, workstreamId, (row) => withDerivedUnread({ ...row, ...viewer }), substreamId);
}

/** Workspace-only fields use WorkspaceDO's own directory/page ordering. */
export function applyWorkspaceWorkstreamFields(
  queryClient: QueryClient,
  workstreamId: string,
  patch: Pick<WorkstreamSummary, 'pinPosition' | 'lastAccessedAt'>,
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
