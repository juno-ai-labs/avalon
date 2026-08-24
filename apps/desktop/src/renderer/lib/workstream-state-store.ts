import type { WorkstreamStateVersion } from '@avalon/contracts';
import type { QueryClient } from '@tanstack/react-query';

import type { WorkstreamDetail, WorkstreamSummary } from './types';
import { setCachedWorkstreams } from './workstreams-cache';

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
      objective: workstream.objective,
      emailAddress: workstream.emailAddress,
      origin: workstream.origin,
      createdByUserId: workstream.createdByUserId,
      automationName: workstream.automationName,
      automationSubscriptionId: workstream.automationSubscriptionId,
      automationRunId: workstream.automationRunId,
      harnessStatus: workstream.harnessStatus,
      latestAttentionSequenceNumber: workstream.latestAttentionSequenceNumber,
      lastActivityAt: workstream.lastActivityAt,
      createdAt: workstream.createdAt,
      updatedAt: workstream.updatedAt,
      archivedAt: workstream.archivedAt,
      plannedFor: workstream.plannedFor,
      preview: workstream.preview,
      scope: workstream.scope,
      systemKind: workstream.systemKind,
      nextPendingWakeup: workstream.nextPendingWakeup,
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

function withDerivedUnread(workstream: WorkstreamSummary): WorkstreamSummary {
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
  if (!commonApplied && !viewerApplied) return { commonApplied, viewerApplied };

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
    setCachedWorkstreams(queryClient, (items) => items?.filter((item) => item.id !== input.workstreamId));
    queryClient.removeQueries({ queryKey: ['workstream', input.workstreamId], exact: true });
    return { commonApplied, viewerApplied };
  }

  const merge = <T extends WorkstreamSummary>(value: T): T => withDerivedUnread({
    ...value,
    ...(commonApplied ? input.common : {}),
    ...(viewerApplied ? input.viewer : {}),
  }) as T;
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

/** Workspace-only fields use WorkspaceDO's own directory/page ordering. */
export function applyWorkspaceWorkstreamFields(
  queryClient: QueryClient,
  workstreamId: string,
  patch: Pick<WorkstreamSummary, 'pinPosition'>,
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
