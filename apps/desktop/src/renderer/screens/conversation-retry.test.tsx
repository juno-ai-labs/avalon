import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessRunMetadata, WorkstreamBoot } from '../lib/types';
import type * as UseWorkstreamSocketModule from '../lib/use-workstream-socket';
import { applyHarnessStatus } from '../lib/use-workstream-socket';

/*
 * A Canvas's Chat after a failed run, as a person retries it: the real
 * conversation surface and its failure notice, with only the conversation
 * socket and the session as doubles. The socket's `retryHarness` answers with
 * the new run's id, as the `retry_harness` command does.
 */

const CANVAS = '00000000-0000-7000-8000-000000000c61';
const FIRST_RUN = '00000000-0000-7000-8000-000000000c62';
const RETRY_RUN = '00000000-0000-7000-8000-000000000c63';

const api = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ id: 'w', name: 'Team', region: 'global', timezone: 'UTC', modelSelectorVisible: false, currentUser: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC' } })),
  getWorkspaceMembers: vi.fn(async () => []),
  getConnections: vi.fn(async () => []),
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
}));
const retryHarness = vi.hoisted(() => vi.fn());
const requestSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api, session: { user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test' }, workspace: { id: 'w', region: 'global', role: 'member' } } }),
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));
vi.mock('../lib/use-client-feature-flags', () => ({ useClientFeatureFlags: () => ({ data: {} }) }));
vi.mock('../lib/use-workstream-socket', async (importOriginal) => ({
  ...await importOriginal<typeof UseWorkstreamSocketModule>(),
  useWorkstreamSocket: () => ({
    activeCompaction: null, activeInferenceDelays: [], createMessage: vi.fn(), retryHarness,
    requestSnapshot, retryOpening: vi.fn(), loadTranscriptRange: vi.fn(async () => undefined),
    sendReady: true, state: 'connected', workspaceSocketState: 'connected',
  }),
}));
vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
  useOptionalWorkspaceSocket: () => null,
}));
vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(), attachments: [], consume: vi.fn(),
    leaseReady: vi.fn(async () => ({ leaseId: 'lease', attachments: [] })),
    commitLease: vi.fn(), restoreLease: vi.fn(), error: undefined, ready: [],
    removeAttachment: vi.fn(), retryAttachment: vi.fn(), uploading: false,
  }),
}));
vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true, isFollowing: () => true, onScroll: vi.fn(), onWheel: vi.fn(),
    release: vi.fn(), scrollTo: vi.fn(), scrollToEnd: vi.fn(),
  }),
}));

import { ConversationSurface } from './conversation-surface';

function failedRun(id: string): HarnessRunMetadata {
  return {
    id, origin: 'message', status: 'failed', requestId: id,
    error: { code: 'run_state_persistence_failed', message: 'Rally could not complete this run.' },
    startedAt: '2026-11-13T19:01:06.000Z', completedAt: '2026-11-13T19:01:07.000Z', createdAt: '2026-11-13T19:01:06.000Z',
  };
}

function boot(run: HarnessRunMetadata): WorkstreamBoot {
  return {
    id: CANVAS, title: 'Ibuprofen dose tracker', titleStatus: 'settled', harnessStatus: 'failed', scope: 'workspace',
    latestHarnessRunId: run.id, latestHarnessRun: run,
    lastActivityAt: '2026-11-13T19:00:00.000Z', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
    nextPendingWakeup: null, pinPosition: null, spaceIds: [], participantUserIds: [], participantExtraCount: 0,
    createdAt: '2026-11-13T18:57:42.000Z', participants: [], viewers: [], resources: [], connections: [],
    backgroundTasks: [], openElicitations: [],
    transcript: {
      snapshotId: '00000000-0000-7000-8000-000000000c69', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-11-13T19:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread',
      ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    },
  } as WorkstreamBoot;
}

function renderCanvas(conversation: WorkstreamBoot): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['workstream', CANVAS], conversation);
  queryClient.setQueryData(['ordered-transcript', CANVAS], conversation.transcript);
  render(<Tooltip.Provider><ErrorNoticeProvider><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[`/canvases/${CANVAS}`]}>
      <Routes><Route path="/canvases/:id" element={<ConversationSurface parentId={CANVAS} parentKind="canvas" substreamId="0" />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider></ErrorNoticeProvider></Tooltip.Provider>);
  return queryClient;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('retrying a failed run', () => {
  it('reports a Retry that fails before any snapshot showed it running', async () => {
    const queryClient = renderCanvas(boot(failedRun(FIRST_RUN)));
    // A stored failure on open offers its details without interrupting.
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // The server's order: the command's receipt, then the drain's `running`
    // status frame (which changes only the status, so the cached run is still
    // the old one), then the snapshot carrying the new run, already failed.
    retryHarness.mockResolvedValue({ harnessRunId: RETRY_RUN });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await act(async () => {
      applyHarnessStatus(queryClient, CANVAS, 'running');
    });
    // The screen has drawn the run as running: the failure controls are gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    await act(async () => {
      queryClient.setQueryData(['workstream', CANVAS], boot(failedRun(RETRY_RUN)));
    });

    const notice = await screen.findByRole('alertdialog', { name: 'Run failed' });
    expect(notice.textContent).toContain(RETRY_RUN);
  });
});
