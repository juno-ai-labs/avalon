import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  addParticipant: vi.fn(),
  clientFeatureFlags: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  removeParticipant: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());
const scrollTranscriptToEnd = vi.hoisted(() => vi.fn());

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
    scrollToEnd: scrollTranscriptToEnd,
  }),
}));

import { WorkstreamScreen } from './workstream';
import type { WorkstreamBoot, WorkstreamDetail, WorkstreamResource } from '../lib/types';

const workstreamId = '00000000-0000-7000-8000-000000000650';

function recoveryBoot(overrides: Partial<WorkstreamBoot> = {}): WorkstreamBoot {
  return {
    id: workstreamId,
    title: 'Recovered work stream',
    titleStatus: 'settled',
    harnessStatus: 'idle',
    scope: 'personal',
    lastActivityAt: '2026-08-26T14:00:00.000Z',
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
    createdAt: '2026-08-26T14:00:00.000Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    latestHarnessRunId: null,
    latestHarnessRun: null,
    transcript: {
      snapshotId: '00000000-0000-7000-8000-000000000777',
      snapshotThrough: 0,
      eventSequence: 0,
      snapshotAtUtc: '2026-08-26T14:00:00.000Z',
      ranges: [],
      activities: [],
      activeActivities: [],
      pluginRuns: [],
      activeTurns: [],
    },
    ...overrides,
  } as WorkstreamBoot;
}

function renderScreen(seed?: (queryClient: QueryClient) => void, substreamId?: string): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  seed?.(queryClient);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${workstreamId}${substreamId ? `?substream=${substreamId}` : ''}`]}>
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('socket-first work-stream open', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkspaceMembers.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: false,
      state: 'connecting',
      workspaceSocketState: 'connecting',
    });
  });

  it('keeps sidebar membership and management at the parent while a child is selected', async () => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const member = { id: '00000000-0000-7000-8000-000000000661', name: 'Parent member', email: 'parent@example.test', timezone: 'UTC' };
    const newcomer = { ...member, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const artifact: WorkstreamResource = {
      id: '00000000-0000-7000-8000-000000000663', title: 'Parent artifact', resourceType: 'document', currentVersion: 1,
      direction: 'artifact', relationshipType: 'generated', refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported',
    };
    const parent = recoveryBoot({ participants: [member], resources: [artifact] });
    const child = recoveryBoot({ title: 'Private child', participants: [], resources: [{ ...artifact, id: 'child-artifact', title: 'Child artifact' }] });
    api.getWorkspaceMembers.mockResolvedValue([member, newcomer]);
    api.addParticipant.mockResolvedValue({ ...parent, participants: [member, newcomer] });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    expect(await screen.findByRole('button', { name: 'Manage participants: Parent member' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage resources' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Parent artifact' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Child artifact' })).not.toBeInTheDocument();
    expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Manage work-stream participants' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add New member to work stream' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, newcomer.id));
    expect(await screen.findByRole('button', { name: 'Manage participants: New member' })).toBeInTheDocument();
    expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId])?.participants).toEqual([]);
  });

  it('admits the feed while the snapshot is pending without starting REST boot readers', async () => {
    renderScreen();

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await waitFor(() => expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0'));
  });

  it('requests a replacement snapshot when a retained socket outlives its base caches', async () => {
    const requestSnapshot = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot,
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
    });

    renderScreen();

    await waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));
  });

  it('does not run payload effects until detail and transcript both belong to the route', async () => {
    const staleWorkstreamId = '00000000-0000-7000-8000-000000000649';
    const staleBoot = recoveryBoot({ id: staleWorkstreamId, title: 'Stale work stream' });
    const { transcript: staleTranscript, ...staleDetail } = staleBoot;
    const queryClient = renderScreen((client) => {
      client.setQueryData<WorkstreamDetail>(['workstream', workstreamId], staleDetail);
      client.setQueryData(['ordered-transcript', workstreamId], staleTranscript);
    });

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(scrollTranscriptToEnd).not.toHaveBeenCalled();

    const currentBoot = recoveryBoot();
    const { transcript: currentTranscript, ...currentDetail } = currentBoot;
    act(() => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], currentDetail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], currentTranscript);
    });

    await waitFor(() => expect(scrollTranscriptToEnd).toHaveBeenCalledTimes(1));
  });

  it('does not flash the empty invitation while a new run is scheduled', async () => {
    const boot = recoveryBoot({ harnessStatus: 'scheduled' });
    const { transcript, ...detail } = boot;

    renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
    });

    expect(screen.queryByText('Ready to begin')).not.toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(screen.queryByText('Ready to begin')).not.toBeInTheDocument();
  });

  it('shows the error from the latest participant action', async () => {
    const adam = {
      id: '00000000-0000-7000-8000-000000000651',
      name: 'Adam',
      email: 'adam@example.test',
      timezone: 'America/Los_Angeles',
    };
    const katherine = {
      id: '00000000-0000-7000-8000-000000000652',
      name: 'Katherine',
      email: 'katherine@example.test',
      timezone: 'America/Los_Angeles',
    };
    const jordan = {
      id: '00000000-0000-7000-8000-000000000653',
      name: 'Jordan',
      email: 'jordan@example.test',
      timezone: 'America/Los_Angeles',
      status: 'active' as const,
    };
    const detail = recoveryBoot({ participants: [adam, katherine] });
    api.getWorkspaceMembers.mockResolvedValue([adam, katherine, jordan]);
    api.addParticipant.mockRejectedValue(new Error('Adam cannot add Jordan'));
    api.removeParticipant.mockRejectedValue(new Error('Adam cannot remove Katherine'));

    renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], detail.transcript);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Manage work-stream participants' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jordan to work stream' }));
    expect(await screen.findByText('Adam cannot add Jordan')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Katherine participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from work stream' }));

    expect(await screen.findByText('Adam cannot remove Katherine')).toBeInTheDocument();
    expect(screen.queryByText('Adam cannot add Jordan')).not.toBeInTheDocument();
  });

  it('retries the authoritative socket after the first attempt fails', async () => {
    const retryOpening = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening,
      sendReady: false,
      state: 'reconnecting',
      workspaceSocketState: 'connecting',
    });
    renderScreen();

    expect(await screen.findByText('Work stream could not be opened')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(retryOpening).toHaveBeenCalledTimes(1);
  });

  it('shows the terminal error after all three timed opening attempts expire', async () => {
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      openingError: 'The live connection timed out after 3 attempts.',
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: false,
      state: 'unavailable',
      workspaceSocketState: 'connecting',
    });

    renderScreen();

    expect(await screen.findByText('Work stream could not be opened')).toBeInTheDocument();
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
  });

});
