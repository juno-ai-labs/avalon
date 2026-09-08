import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  addParticipant: vi.fn(),
  clientFeatureFlags: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  removeParticipant: vi.fn(),
  prepareSubstream: vi.fn(),
  cancelSubstream: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());
const scrollTranscriptToEnd = vi.hoisted(() => vi.fn());
const restoreTranscriptPosition = vi.hoisted(() => vi.fn());

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
    scrollTo: restoreTranscriptPosition,
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

let navigateInTest: ReturnType<typeof useNavigate>;
function NavigationProbe(): null { navigateInTest = useNavigate(); return null; }

function renderScreen(seed?: (queryClient: QueryClient) => void, substreamId?: string): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  seed?.(queryClient);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${workstreamId}${substreamId ? `?substream=${substreamId}` : ''}`]}>
          <NavigationProbe />
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
  afterEach(() => { vi.restoreAllMocks(); });
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

  function historyBoot(id = workstreamId): WorkstreamBoot {
    const boot = recoveryBoot({ id });
    boot.transcript.snapshotThrough = 10;
    boot.transcript.ranges = [{
      purpose: 'latest', requested: { startInclusive: 10, endExclusive: 11 },
      covered: { startInclusive: 10, endExclusive: 11 }, turns: [], activities: [], pluginRuns: [],
    }];
    return boot;
  }

  it('positions a laid-out opening before enabling automatic history requests', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    scrollTranscriptToEnd.mockImplementationOnce(() => { screen.getByRole('log').scrollTop = 1400; });
    const loadTranscriptRange = vi.fn().mockResolvedValue(undefined);
    retainedSocket.mockReturnValue({
      state: 'connected', workspaceSocketState: 'connected', activeCompaction: null,
      sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange,
    });
    const boot = historyBoot();
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await waitFor(() => expect(scrollTranscriptToEnd).toHaveBeenCalled());
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(loadTranscriptRange).not.toHaveBeenCalled();
  });

  it('shares pending requests across A to B to A and discards departed-visit restoration', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const other = '00000000-0000-7000-8000-000000000651';
    let resolveA = (): void => {};
    let resolveB = (): void => {};
    const loadA = vi.fn(() => new Promise<void>(resolve => { resolveA = resolve; }));
    const loadB = vi.fn(() => new Promise<void>(resolve => { resolveB = resolve; }));
    retainedSocket.mockImplementation((_api, id) => ({
      state: 'connected', workspaceSocketState: 'connected', activeCompaction: null,
      sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange: id === other ? loadB : loadA,
    }));
    const boots = [historyBoot(), historyBoot(other)];
    const cache = renderScreen(cache => {
      for (const boot of boots) {
        cache.setQueryData(['workstream', boot.id], boot);
        cache.setQueryData(['ordered-transcript', boot.id], boot.transcript);
      }
    });
    await waitFor(() => expect(loadA).toHaveBeenCalledOnce());
    act(() => navigateInTest('/workstreams/' + other));
    await waitFor(() => expect(loadB).toHaveBeenCalledOnce());
    act(() => navigateInTest('/workstreams/' + workstreamId));
    await screen.findByText('Loading earlier messages…');
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(loadA).toHaveBeenCalledOnce();
    await act(async () => {
      for (const boot of boots) cache.setQueryData(['ordered-transcript', boot.id], {
        ...boot.transcript, ranges: boot.transcript.ranges.map(range => ({
          ...range, covered: { startInclusive: 1, endExclusive: 11 },
        })),
      });
      resolveA(); resolveB();
    });
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(restoreTranscriptPosition).not.toHaveBeenCalled();
    expect(loadA).toHaveBeenCalledOnce();
  });

  it('shows reconnect status at an unloaded edge and resumes when connected', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const loadTranscriptRange = vi.fn().mockRejectedValue(new Error('offline test'));
    const socket = { state: 'connecting', workspaceSocketState: 'connected', activeCompaction: null,
      sendReady: false, requestSnapshot: vi.fn(), loadTranscriptRange };
    retainedSocket.mockReturnValue(socket);
    const boot = historyBoot();
    const cache = renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    expect(await screen.findByText('Waiting to reconnect…')).toBeInTheDocument();
    expect(loadTranscriptRange).not.toHaveBeenCalled();
    socket.state = 'connected';
    act(() => cache.setQueryData(['workstream', workstreamId], { ...boot, title: 'Reconnected' }));
    await waitFor(() => expect(loadTranscriptRange).toHaveBeenCalledOnce());
  });

  it('does not offer an older retry or block older paging after a newer-gap failure', async () => {
    const boot = historyBoot();
    boot.transcript.snapshotThrough = 30;
    boot.transcript.ranges.push({ ...boot.transcript.ranges[0]!,
      covered: { startInclusive: 30, endExclusive: 31 },
      requested: { startInclusive: 30, endExclusive: 31 },
    });
    const loadTranscriptRange = vi.fn().mockRejectedValue(new Error('Newer gap unavailable'));
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected',
      activeCompaction: null, sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange });
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await waitFor(() => expect(scrollTranscriptToEnd).toHaveBeenCalled());
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    log.scrollTop = 400;
    fireEvent.scroll(log);
    expect(await screen.findByText('Newer gap unavailable')).toBeInTheDocument();
    expect(loadTranscriptRange).toHaveBeenCalledWith(expect.objectContaining({
      range: { startInclusive: 11, endExclusive: 30 },
    }));
    expect(screen.queryByRole('button', { name: 'Retry loading earlier messages' })).not.toBeInTheDocument();
    log.scrollTop = 0;
    fireEvent.scroll(log);
    await waitFor(() => expect(loadTranscriptRange).toHaveBeenCalledWith(expect.objectContaining({
      range: { startInclusive: 1, endExclusive: 10 },
    })));
  });

  it.each([true, false])('bounds invisible history by canonical coverage (advances=%s)', async (advances) => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const boot = historyBoot();
    const loadTranscriptRange = vi.fn(async () => {
      if (advances) cache.setQueryData(['ordered-transcript', workstreamId], {
        ...boot.transcript, ranges: [{ ...boot.transcript.ranges[0]!,
          covered: { startInclusive: 1, endExclusive: 11 },
        }],
      });
    });
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected',
      activeCompaction: null, sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange });
    const cache = renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await waitFor(() => expect(loadTranscriptRange).toHaveBeenCalledOnce());
    if (!advances) expect(await screen.findByRole('button', { name: 'Retry loading earlier messages' })).toBeInTheDocument();
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(loadTranscriptRange).toHaveBeenCalledOnce();
    if (advances) expect(screen.queryByRole('button', { name: /earlier messages/ })).not.toBeInTheDocument();
  });

  it('automatically loads near the history edge and only offers a button after failure', async () => {
    const boot = recoveryBoot();
    boot.transcript.snapshotThrough = 10;
    boot.transcript.ranges = [{
      purpose: 'latest', requested: { startInclusive: 10, endExclusive: 11 },
      covered: { startInclusive: 10, endExclusive: 11 }, turns: [], activities: [], pluginRuns: [],
    }];
    const loadTranscriptRange = vi.fn().mockRejectedValue(new Error('History unavailable'));
    retainedSocket.mockReturnValue({
      activeCompaction: null, state: 'connected', workspaceSocketState: 'connected',
      requestSnapshot: vi.fn(), sendReady: true, loadTranscriptRange,
    });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 600 });
    expect(screen.queryByRole('button', { name: /earlier messages/i })).not.toBeInTheDocument();
    fireEvent.scroll(log);
    await waitFor(() => expect(loadTranscriptRange).toHaveBeenCalledOnce());
    const retry = await screen.findByRole('button', { name: 'Retry loading earlier messages' });
    fireEvent.scroll(log);
    expect(loadTranscriptRange).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    await waitFor(() => expect(loadTranscriptRange).toHaveBeenCalledTimes(2));
  });

  it('keeps preparation inputs stable while pending and cancels a failed attempt only once on edit', async () => {
    let rejectPreparation!: (error: Error) => void;
    api.prepareSubstream.mockImplementation(() => new Promise((_resolve, reject) => { rejectPreparation = reject; }));
    api.cancelSubstream.mockResolvedValue(undefined);
    const boot = recoveryBoot();
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.click(screen.getByRole('button', { name: 'Review context' }));
    expect(title).toBeDisabled();
    await act(async () => { rejectPreparation(new Error('Preparation failed')); });
    expect(title).toBeEnabled();
    expect(screen.getByText('Preparation failed')).toBeInTheDocument();
    fireEvent.change(title, { target: { value: 'Revised title' } });
    expect(screen.queryByText('Preparation failed')).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: 'Revised title again' } });
    expect(api.cancelSubstream).toHaveBeenCalledTimes(1);
    expect(api.cancelSubstream).toHaveBeenCalledWith(workstreamId, api.prepareSubstream.mock.calls[0]![1].operationId);
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

    expect(await screen.findByRole('button', { name: 'Manage work-stream participants' })).toHaveAccessibleDescription('Parent member');
    expect(screen.queryByRole('button', { name: 'Manage resources' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Parent artifact' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Child artifact' })).not.toBeInTheDocument();
    expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Manage work-stream participants' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add New member to work stream' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, newcomer.id));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage work-stream participants' })).toHaveAccessibleDescription('Parent member, New member'));
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
