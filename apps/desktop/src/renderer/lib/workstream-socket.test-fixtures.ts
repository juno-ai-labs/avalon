import type { WorkstreamBoot } from './types';

export function emptyTranscriptSnapshot(): WorkstreamBoot['transcript'] {
  return {
    snapshotId: '00000000-0000-7000-8000-000000000777',
    snapshotThrough: 0,
    eventSequence: 0,
    snapshotAtUtc: '2026-07-31T19:00:00.000Z',
    unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [], pendingInputs: [],
  };
}

export function wireWorkstreamDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-7000-8000-000000000091',
    workspaceId: '00000000-0000-7000-8000-000000000001',
    title: 'Wire channel',
    objective: 'Wire objective',
    createdByUserId: null,
    harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-07-31T19:00:00.000Z',
    createdAt: '2026-07-31T19:00:00.000Z',
    updatedAt: '2026-07-31T19:00:00.000Z',
    archivedAt: null,
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    openElicitations: [],
    latestHarnessRunId: null,
    ...overrides,
  };
}

export function snapshotFrame(input: {
  sequence: number;
  reason?: 'initial' | 'reconciliation' | 'history_unavailable';
  workstream?: Record<string, unknown>;
  transcript?: WorkstreamBoot['transcript'];
  pendingInputChunkCount?: number;
}): Record<string, unknown> {
  return {
    type: 'snapshot',
    reason: input.reason ?? 'initial',
    sequence: input.sequence,
    occurredAt: '2026-07-31T19:20:00.000Z',
    workstream: wireWorkstreamDetail(input.workstream),
    transcript: input.transcript ?? emptyTranscriptSnapshot(),
    pendingInputChunkCount: input.pendingInputChunkCount ?? 0,
    activeStreams: [],
    activeCompaction: null,
  };
}
