import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
  getAttachedSidekicks: vi.fn(),
  getWorkstreamSidekicks: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api, session: null }),
}));

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: {} }),
}));

vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketOpenContext: () => () => ({}),
  useRetainedWorkstreamSocket: retainedSocket,
}));

vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
}));

vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(),
    attachments: [],
    consume: vi.fn(),
    error: undefined,
    ready: [],
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    uploading: false,
  }),
}));

vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true,
    onScroll: vi.fn(),
    onWheel: vi.fn(),
    release: vi.fn(),
    scrollTo: vi.fn(),
    scrollToEnd: vi.fn(),
  }),
}));


import { WorkstreamScreen } from './workstream';
import { ApiError } from '../lib/api';
import { useUiStore } from '../lib/ui-store';
import type { WorkstreamBoot, WorkstreamDetail } from '../lib/types';

const workstreamId = '00000000-0000-7000-8000-000000000901';

function boot(): WorkstreamBoot {
  return {
    id: workstreamId,
    title: 'Investigate ENG-142',
    titleStatus: 'settled',
    harnessStatus: 'completed',
    scope: 'workspace',
    lastActivityAt: '2026-09-10T14:00:00.000Z',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    createdAt: '2026-09-10T14:00:00.000Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    transcript: {
      snapshotId: `snapshot-${workstreamId}`,
      snapshotThrough: 0,
      eventSequence: 0,
      snapshotAtUtc: '2026-09-10T14:00:00.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [],
      activities: [],
      activeActivities: [],
      pluginRuns: [],
      activeTurns: [],
      pendingInputs: [],
    },
  };
}

function renderScreen(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const { transcript, ...detail } = boot();
  queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
  queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${workstreamId}`]}>
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

/**
 * The refusal a viewer of a workspace-scoped room gets from the owned listing,
 * and what separates it from a failure.
 *
 * Both arrive at the same `catch`, and only one of them is an answer about the
 * person rather than about the room — the distinction the section's whole
 * behaviour here rests on, and the one a future narrowing of that `catch`
 * would quietly take away.
 */
describe('a work stream\u2019s own Sidekicks when the viewer may not list them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    api.getAttachedSidekicks.mockResolvedValue([
      { id: 'attached-1', name: 'Editorial guidance', description: 'Write clearly.', available: true },
    ]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('reads a refusal as a room with none, and still lists what the conversation loaded', async () => {
    api.getWorkstreamSidekicks.mockRejectedValue(
      new ApiError('You cannot list this room\u2019s automations', 403, 'automation_directory_access_denied'),
    );
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Editorial guidance' })).toBeVisible();
    // The refusal is about the viewer, so it never reaches the rail as text.
    expect(screen.queryByText(/cannot list/u)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still shows a failure that is about the room rather than the viewer', async () => {
    api.getWorkstreamSidekicks.mockRejectedValue(new ApiError('The service is unavailable.', 500));
    renderScreen();

    expect(await screen.findByText('The service is unavailable.')).toBeVisible();
    // And the half that did answer stays on screen under it.
    expect(screen.getByRole('button', { name: 'Editorial guidance' })).toBeVisible();
  });
});
