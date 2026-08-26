import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  clientFeatureFlags: vi.fn(),
  getMessagePage: vi.fn(),
  getWorkstreamContext: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkstream: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());
const scrollTranscriptToEnd = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api, session: null }),
}));

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: { hypersightEnabled: false } }),
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

vi.mock('../lib/use-block-dashboard-sockets', () => ({
  useBlockDashboardSockets: () => new Map(),
}));

import { WorkstreamScreen } from './workstream';
import {
  workstreamFeedSourceQueryKey,
  workstreamRecoveryFeedQueryKey,
  workstreamSocketSnapshotGenerationQueryKey,
} from '../lib/telemetry';
import type { Message, WorkstreamBoot, WorkstreamDetail } from '../lib/types';

const workstreamId = '00000000-0000-7000-8000-000000000650';

function recoveryBoot(overrides: Partial<WorkstreamBoot> = {}): WorkstreamBoot {
  return {
    id: workstreamId,
    title: 'Recovered work stream',
    titleStatus: 'settled',
    origin: 'ad_hoc',
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
    createdAt: '2026-08-26T14:00:00.000Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    suggestions: [],
    latestHarnessRunId: null,
    latestHarnessRun: null,
    automationRuns: [],
    messageFeed: { items: [], nextCursor: null, newerCursor: null },
    resumeFeed: null,
    ...overrides,
  } as WorkstreamBoot;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => { resolve = next; }),
    resolve,
  };
}

function renderScreen(seed?: (queryClient: QueryClient) => void): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  seed?.(queryClient);
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
  return queryClient;
}

describe('socket-first work-stream open', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkstreamContext.mockResolvedValue({ backgroundTasks: [], automationRuns: [] });
    api.getWorkspaceMembers.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      requestSnapshot: vi.fn(),
      sendReady: false,
      state: 'connecting',
      workspaceSocketState: 'connecting',
    });
  });

  it('admits the feed while the snapshot is pending without starting REST boot readers', async () => {
    renderScreen();

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await waitFor(() => expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true));
    expect(api.getWorkstream).not.toHaveBeenCalled();
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });

  it('requests a replacement snapshot when a retained socket outlives its base caches', async () => {
    const requestSnapshot = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      requestSnapshot,
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
    });

    renderScreen();

    await waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));
    expect(api.getWorkstream).not.toHaveBeenCalled();
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });

  it('does not run payload effects until detail and transcript both belong to the route', async () => {
    const staleWorkstreamId = '00000000-0000-7000-8000-000000000649';
    const staleBoot = recoveryBoot({ id: staleWorkstreamId, title: 'Stale work stream' });
    const { messageFeed: _staleFeed, resumeFeed: _staleResume, ...staleDetail } = staleBoot;
    void _staleFeed;
    void _staleResume;
    const queryClient = renderScreen((client) => {
      client.setQueryData<WorkstreamDetail>(['workstream', workstreamId], staleDetail);
      client.setQueryData<Message[]>(['messages', workstreamId], [{
        id: 'stale-message',
        workstreamId: staleWorkstreamId,
      } as Message]);
    });

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(api.getWorkstreamContext).not.toHaveBeenCalled();
    expect(scrollTranscriptToEnd).not.toHaveBeenCalled();

    const currentBoot = recoveryBoot();
    const { messageFeed: _currentFeed, resumeFeed: _currentResume, ...currentDetail } = currentBoot;
    void _currentFeed;
    void _currentResume;
    act(() => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], currentDetail);
      queryClient.setQueryData<Message[]>(['messages', workstreamId], []);
    });

    await waitFor(() => expect(api.getWorkstreamContext).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(scrollTranscriptToEnd).toHaveBeenCalledTimes(1));
  });

  it('offers REST recovery after the first socket attempt fails', async () => {
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      requestSnapshot: vi.fn(),
      sendReady: false,
      state: 'reconnecting',
      workspaceSocketState: 'connecting',
    });
    api.getWorkstream.mockRejectedValue(new Error('recovery unavailable'));
    renderScreen();

    expect(await screen.findByText('Work stream could not be opened')).toBeInTheDocument();
    expect(api.getWorkstream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(api.getWorkstream).toHaveBeenCalledTimes(1));
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });

  it('keeps legacy page recovery distinct from socket snapshots', async () => {
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      requestSnapshot: vi.fn(),
      sendReady: false,
      state: 'reconnecting',
      workspaceSocketState: 'connecting',
    });
    api.getWorkstream.mockResolvedValue(recoveryBoot({
      messageFeed: undefined,
      resumeFeed: null,
    }));
    api.getMessagePage.mockResolvedValue({ items: [], nextCursor: null, newerCursor: null });
    const queryClient = renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(api.getMessagePage).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('legacy_page');
    expect(queryClient.getQueryData(workstreamRecoveryFeedQueryKey(workstreamId))).toBeUndefined();
    expect(queryClient.getQueryData(['workstream', workstreamId])).not.toHaveProperty('messageFeed');
    expect(queryClient.getQueryData(['workstream', workstreamId])).not.toHaveProperty('resumeFeed');
    await waitFor(() => expect(api.getWorkstreamContext).toHaveBeenCalledTimes(1));
  });

  it('keeps a newer socket snapshot when REST recovery resolves late', async () => {
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      requestSnapshot: vi.fn(),
      sendReady: true,
      state: 'reconnecting',
      workspaceSocketState: 'connecting',
    });
    const recovery = deferred<WorkstreamBoot>();
    api.getWorkstream.mockReturnValue(recovery.promise);
    const queryClient = renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.getWorkstream).toHaveBeenCalledTimes(1));

    const socketDetail = recoveryBoot({ title: 'Canonical socket title' });
    const { messageFeed: _messageFeed, resumeFeed: _resumeFeed, ...detail } = socketDetail;
    void _messageFeed;
    void _resumeFeed;
    act(() => {
      queryClient.setQueryData(workstreamSocketSnapshotGenerationQueryKey(workstreamId), 1);
      queryClient.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'socket_snapshot');
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['messages', workstreamId], []);
      queryClient.setQueryData(['messages-cursor', workstreamId], 'socket-older');
      queryClient.setQueryData(['messages-newer-cursor', workstreamId], 'socket-newer');
    });
    await act(async () => {
      recovery.resolve(recoveryBoot({ title: 'Stale REST title' }));
      await recovery.promise;
    });

    await waitFor(() => expect(api.getWorkstreamContext).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.title)
      .toBe('Canonical socket title');
    expect(queryClient.getQueryData(['messages', workstreamId])).toEqual([]);
    expect(queryClient.getQueryData(['messages-cursor', workstreamId])).toBe('socket-older');
    expect(queryClient.getQueryData(['messages-newer-cursor', workstreamId])).toBe('socket-newer');
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('socket_snapshot');
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });
});
