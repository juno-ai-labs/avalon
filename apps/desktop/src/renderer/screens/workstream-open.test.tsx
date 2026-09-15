import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  renameSubstream: vi.fn(),
  setSubstreamArchived: vi.fn(),
  renameWorkstream: vi.fn(),
  archiveWorkstream: vi.fn(),
  setWorkstreamScope: vi.fn(),
  addParticipant: vi.fn(),
  addSubstreamParticipant: vi.fn(),
  removeSubstreamParticipant: vi.fn(),
  clientFeatureFlags: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  removeParticipant: vi.fn(),
  prepareSubstream: vi.fn(),
  confirmSubstream: vi.fn(),
  cancelSubstream: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());
const scrollTranscriptToEnd = vi.hoisted(() => vi.fn());
const restoreTranscriptPosition = vi.hoisted(() => vi.fn());

/** Set by the tests that need a signed-in author; null everywhere else. */
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api, session: session.current }),
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
    leaseReady: vi.fn(async () => ({ leaseId: 'lease', attachments: [] })),
    commitLease: vi.fn(),
    restoreLease: vi.fn(),
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

import { patchCachedWorkstreamAppearance, setCachedWorkstreams } from '../lib/workstreams-cache';
import { workstreamFeedSourceQueryKey } from '../lib/telemetry';
import { substreamInitialContextQueryKey } from '../lib/use-workstream-socket';
import { desktopBridge } from '../lib/platform';
import { STOPPING_LABEL } from '../components/agent-work-timing';
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
    session.current = null;
    api.getWorkspaceMembers.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null, activeInferenceDelays: [],
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

  async function mainMenu(action: string): Promise<void> {
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Go to conversation: Recovered work stream' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: action }));
  }

  it.each(['make_public', 'rename', 'archive'] as const)('reports successful Main %s and never reports failed attempts', async (action) => {
    const boot = recoveryBoot();
    const report = vi.spyOn(desktopBridge(), 'reportTelemetryProductIntent').mockResolvedValue(undefined);
    const mutation = action === 'make_public' ? api.setWorkstreamScope : action === 'rename' ? api.renameWorkstream : api.archiveWorkstream;
    mutation.mockRejectedValueOnce(null).mockResolvedValue({ ...boot, scope: action === 'make_public' ? 'workspace' : 'personal' });
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    const label = action === 'make_public' ? 'Make public to workspace' : action === 'rename' ? 'Rename' : 'Archive work stream';
    await mainMenu(label);
    if (action === 'rename') fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed parent' } });
    if (action !== 'make_public') fireEvent.click(screen.getByRole('button', { name: action === 'rename' ? 'Rename' : 'Archive' }));
    await screen.findByText(action === 'make_public' ? 'The work stream could not be made public.' : `That work stream could not be ${action === 'rename' ? 'renamed' : 'archived'}.`);
    expect(report.mock.calls.filter(([event]) => event.kind === 'workstream_action_completed')).toHaveLength(0);
    if (action === 'make_public') {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await mainMenu(label);
    } else fireEvent.click(screen.getByRole('button', { name: action === 'rename' ? 'Rename' : 'Archive' }));
    await waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_action_completed', workstreamId, action, origin: 'ad_hoc', pinned: false,
    })));
    expect(mutation.mock.calls.every(([id]) => id === workstreamId)).toBe(true);
  });

  it.each(['rename', 'archive'] as const)('keeps Main and child %s targets separate while a child is selected', async (action) => {
    const childId = '00000000-0000-7000-8000-00000000066a';
    const parent = recoveryBoot();
    const child = recoveryBoot({ title: 'Private investigation' });
    api.renameWorkstream.mockResolvedValue(parent);
    api.archiveWorkstream.mockResolvedValue(parent);
    api.renameSubstream.mockResolvedValue(undefined);
    api.setSubstreamArchived.mockResolvedValue(undefined);
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [
        { substreamId: childId, title: child.title, createdByUserId: null, createdAt: child.createdAt, updatedAt: child.updatedAt },
      ] });
    }, childId);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Go to substream: Private investigation' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: action === 'rename' ? 'Rename' : 'Archive substream' }));
    if (action === 'rename') fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed child' } });
    fireEvent.click(screen.getByRole('button', { name: action === 'rename' ? 'Rename' : 'Archive' }));
    await waitFor(() => expect(action === 'rename' ? api.renameSubstream : api.setSubstreamArchived)
      .toHaveBeenCalledWith(workstreamId, childId, action === 'rename' ? 'Renamed child' : true));
    expect(api.renameWorkstream).not.toHaveBeenCalled();
    expect(api.archiveWorkstream).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Re-enter the child after archiving it: the directory fixture remains so
    // this isolates the row target from the currently selected conversation.
    act(() => navigateInTest(`/workstreams/${workstreamId}?substream=${childId}`));
    await mainMenu(action === 'rename' ? 'Rename' : 'Archive work stream');
    if (action === 'rename') fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed parent' } });
    fireEvent.click(screen.getByRole('button', { name: action === 'rename' ? 'Rename' : 'Archive' }));
    await waitFor(() => expect(action === 'rename' ? api.renameWorkstream : api.archiveWorkstream)
      .toHaveBeenCalledWith(...(action === 'rename' ? [workstreamId, 'Renamed parent'] : [workstreamId])));
    expect(action === 'rename' ? api.renameSubstream : api.setSubstreamArchived).toHaveBeenCalledOnce();
  });

  it.each(['navigate', 'rename'] as const)('discards a delayed copy failure after %s', async (next) => {
    session.current = {
      user: { id: '00000000-0000-7000-8000-000000000671', name: 'Creator', email: 'creator@example.test' },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    let rejectCopy: (error: Error) => void = () => {};
    const copy = vi.spyOn(desktopBridge(), 'copyText').mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectCopy = reject; }));
    const boot = recoveryBoot();
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await mainMenu('Copy work stream link');
    await waitFor(() => expect(copy).toHaveBeenCalledOnce());
    if (next === 'navigate') act(() => navigateInTest('/workstreams/00000000-0000-7000-8000-000000000651'));
    else await mainMenu('Rename');
    await act(async () => rejectCopy(new Error('Clipboard unavailable')));
    expect(screen.queryByText('Clipboard unavailable')).not.toBeInTheDocument();
    if (next === 'rename') expect(screen.getByRole('dialog', { name: 'Rename work stream' })).toBeVisible();
  });

  it('positions a laid-out opening before enabling automatic history requests', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    scrollTranscriptToEnd.mockImplementationOnce(() => { screen.getByRole('log').scrollTop = 1400; });
    const loadTranscriptRange = vi.fn().mockResolvedValue(undefined);
    retainedSocket.mockReturnValue({
      state: 'connected', workspaceSocketState: 'connected', activeCompaction: null, activeInferenceDelays: [],
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
      state: 'connected', workspaceSocketState: 'connected', activeCompaction: null, activeInferenceDelays: [],
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
    const socket = { state: 'connecting', workspaceSocketState: 'connected', activeCompaction: null, activeInferenceDelays: [],
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
      activeCompaction: null, activeInferenceDelays: [], sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange });
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
      activeCompaction: null, activeInferenceDelays: [], sendReady: true, requestSnapshot: vi.fn(), loadTranscriptRange });
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
      activeCompaction: null, activeInferenceDelays: [], state: 'connected', workspaceSocketState: 'connected',
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

  /** A main conversation with `count` settled turns, newest last. */
  function conversationBoot(count: number): WorkstreamBoot {
    const boot = recoveryBoot();
    boot.transcript.snapshotThrough = count;
    boot.transcript.ranges = [{
      purpose: 'latest',
      requested: { startInclusive: 1, endExclusive: count + 1 },
      covered: { startInclusive: 1, endExclusive: count + 1 },
      turns: Array.from({ length: count }, (_value, index) => ({
        transcriptSequence: index + 1,
        turnId: `turn-${index + 1}`,
        entryKind: 'conversation' as const,
        actor: 'assistant' as const,
        authorUserId: null,
        authorSnapshot: null,
        attentionOrdinal: index + 1,
        createdAtUtc: '2026-08-26T14:00:00.000Z',
        revision: 1,
        blocks: [{
          type: 'text' as const,
          blockId: `turn-${index + 1}:text:0`,
          blockIndex: 0,
          text: `Main turn ${index + 1}`,
          streaming: false,
        }],
        activityId: null,
      })),
      activities: [],
      pluginRuns: [],
    }];
    return boot;
  }

  function openConversation(count: number): QueryClient {
    const boot = conversationBoot(count);
    return renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
  }

  it('seeds the child with its own model pin rather than the parent it branched from', async () => {
    // The seed is built by spreading the parent's own detail, which carries a
    // pin of its own — so a child of a pinned work stream would open showing
    // the parent's model as its own until the room's snapshot corrected it,
    // which is exactly the inheritance creation refuses. The composer here
    // pins nothing, so the honest seed is null.
    const childId = '00000000-0000-7000-8000-000000000675';
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New substream', context: { parts: [] } });
    api.confirmSubstream.mockResolvedValue({
      substreamId: childId,
      title: 'Check the pricing page',
      opening: { turnId: 'turn-child-9', clientMessageId: 'client-9', createdAt: '2026-08-26T14:05:00.000Z' },
    });
    session.current = {
      user: { id: '00000000-0000-7000-8000-000000000671', name: 'Creator', email: 'creator@example.test' },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    const boot = conversationBoot(2);
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], { ...boot, modelOverride: 'x-ai/grok-4.6' });
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Check the pricing page' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId]))
      .toMatchObject({ title: 'Check the pricing page' }));
    expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId])?.modelOverride)
      .toBeNull();
  });

  it('creates a substream from the launch composer and seeds the conversation it opens', async () => {
    const childId = '00000000-0000-7000-8000-000000000670';
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New substream', context: { parts: [] } });
    api.confirmSubstream.mockResolvedValue({
      substreamId: childId,
      title: 'Check the pricing page',
      opening: { turnId: 'turn-child-1', clientMessageId: 'client-1', createdAt: '2026-08-26T14:05:00.000Z' },
    });
    session.current = {
      user: { id: '00000000-0000-7000-8000-000000000671', name: 'Creator', email: 'creator@example.test' },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    const client = openConversation(2);

    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Check the pricing page' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.confirmSubstream).toHaveBeenCalled());
    expect(api.prepareSubstream).toHaveBeenCalledWith(workstreamId, {
      operationId: api.prepareSubstream.mock.calls[0]![1].operationId,
      throughTurnId: null,
    });
    expect(api.confirmSubstream.mock.calls[0]![2]).toMatchObject({
      text: 'Check the pricing page',
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    });
    // Both halves of the destination, or its screen shows its opening state on
    // arrival despite everything about the turn being known here.
    await waitFor(() => expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId]))
      .toMatchObject({ title: 'Check the pricing page', titleStatus: 'naming' }));
    expect(client.getQueryData(['substream-ordered-transcript', workstreamId, childId])).toBeDefined();
  });

  it('holds a row in the rail for the substream being created, from the keystroke that creates it', async () => {
    // The wait is the two round trips of creation, and until this the rail said
    // nothing about it: the conversation on screen had no row, and the plus row
    // it was opened from was the only thing still claiming to be where the
    // reader was.
    const childId = '00000000-0000-7000-8000-000000000676';
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New substream', context: { parts: [] } });
    let confirm: () => void = () => undefined;
    api.confirmSubstream.mockReturnValue(new Promise((resolve) => {
      confirm = () => resolve({
        substreamId: childId,
        title: 'Check the pricing page',
        opening: { turnId: 'turn-child-8', clientMessageId: 'client-8', createdAt: '2026-08-26T14:05:00.000Z' },
      });
    }));
    openConversation(2);

    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const sidebar = screen.getByRole('complementary', { name: 'Work-stream sidebar' });
    expect(sidebar.querySelector('.workstream-pending-substream')).toBeNull();
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Check the pricing page' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(sidebar.querySelector('.workstream-pending-substream')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'New substream' })).not.toHaveAttribute('aria-current');
    confirm();
    // Gone once the substream exists: from here the rail draws the child's own
    // row from the parent's directory.
    await waitFor(() => expect(sidebar.querySelector('.workstream-pending-substream')).toBeNull());
  });

  it('drops the creating row as soon as the reserved child is published to the rail', async () => {
    // Readiness publishes the child from inside the confirmation, so the real
    // row can reach the rail before the response that navigates does. The
    // reserved id preparation answered with is what keeps that from being two
    // rows for one conversation.
    const childId = '00000000-0000-7000-8000-000000000677';
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New substream', context: { parts: [] } });
    // Never resolves: the window under test is the one before confirmation
    // answers, which is the only time both rows could be drawn.
    api.confirmSubstream.mockReturnValue(new Promise(() => undefined));
    const boot = conversationBoot(1);
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [
        { substreamId: childId, title: 'Retry budget failures', createdByUserId: null, createdAt: '2026-08-26T14:05:00.000Z', updatedAt: '2026-08-26T14:05:00.000Z' },
      ] });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Check the retry budget' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.confirmSubstream).toHaveBeenCalled());
    const sidebar = screen.getByRole('complementary', { name: 'Work-stream sidebar' });
    await waitFor(() => expect(sidebar.querySelector('.workstream-pending-substream')).toBeNull());
    expect(within(sidebar).getAllByRole('button', { name: /Retry budget failures/ })).toHaveLength(1);
  });

  it('shows no branch context when the substream is started from the sidebar', async () => {
    openConversation(3);
    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    expect(await screen.findByRole('textbox', { name: 'What should this substream work on?' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Branching from' })).not.toBeInTheDocument();
  });

  it('releases a reserved child when the surface is left after a failed submit', async () => {
    // Nothing is reserved while the surface is merely open, but a submit that
    // got past `prepare` leaves a child id and a spent summary behind it, and
    // the surface stays open over them. Leaving is what gives them back.
    api.prepareSubstream.mockResolvedValue({
      operationId: 'op', substreamId: '00000000-0000-7000-8000-000000000674', title: 'New substream', context: { parts: [] },
    });
    api.confirmSubstream.mockRejectedValue(new Error('The substream could not be created.'));
    api.cancelSubstream.mockResolvedValue(undefined);
    openConversation(1);
    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('The substream could not be created.');
    expect(api.cancelSubstream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel new substream' }));
    await waitFor(() => expect(api.cancelSubstream)
      .toHaveBeenCalledWith(workstreamId, api.prepareSubstream.mock.calls[0]![1].operationId));
  });

  it('retries a lost creation under the same identity rather than making a second substream', async () => {
    const childId = '00000000-0000-7000-8000-000000000673';
    // The failure this covers: the response is lost after the server committed.
    // A retry that minted fresh ids would reserve a second child and say the
    // same message twice; under the same ids both halves resume.
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New substream', context: { parts: [] } });
    api.confirmSubstream.mockRejectedValueOnce(new Error('The connection was lost.'));
    api.confirmSubstream.mockResolvedValue({
      substreamId: childId,
      title: 'Look at the invoice',
      opening: { turnId: 'turn-child-1', clientMessageId: 'client-1', createdAt: '2026-08-26T14:05:00.000Z' },
    });
    openConversation(1);
    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('The connection was lost.');

    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'What should this substream work on?' }), { key: 'Enter' });
    await waitFor(() => expect(api.confirmSubstream).toHaveBeenCalledTimes(2));
    const [first, second] = api.confirmSubstream.mock.calls;
    expect(second![1]).toBe(first![1]);
    expect(second![2].clientMessageId).toBe(first![2].clientMessageId);
    expect(api.prepareSubstream.mock.calls[1]![1].operationId)
      .toBe(api.prepareSubstream.mock.calls[0]![1].operationId);
  });

  it('puts the message back in the composer when the substream could not be created', async () => {
    api.prepareSubstream.mockRejectedValue(new Error('The context could not be prepared.'));
    openConversation(1);
    fireEvent.click(await screen.findByRole('button', { name: 'New substream' }));
    const composer = await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('The context could not be prepared.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'What should this substream work on?' }))
      .toHaveValue('Look at the invoice'));
    expect(api.confirmSubstream).not.toHaveBeenCalled();
  });

  it('holds the substream initial-context entry in the cache, which nothing renders', async () => {
    // The entry is written by the socket and read by `sendReady` and the
    // local-cache mirror, by key and never through a component. This observer
    // is the only thing keeping it: React Query collects an entry five minutes
    // after its last observer goes, and the two readers would then start
    // finding nothing — a substream that had been open a while would quietly
    // stop being able to send. Nothing on screen would show that, and the
    // surface's own comment is not enforcement, so this is.
    const childId = '00000000-0000-7000-8000-00000000066c';
    const child = recoveryBoot({ title: 'Private child' });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], recoveryBoot());
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    await screen.findByRole('heading', { name: 'Private child' });
    expect(client.getQueryCache()
      .find({ queryKey: substreamInitialContextQueryKey(workstreamId, childId) })
      ?.getObserversCount()).toBeGreaterThan(0);
  });

  it('draws the open substream under its own name, not the one its parent still has for it', async () => {
    const childId = '00000000-0000-7000-8000-00000000066a';
    const sibling = '00000000-0000-7000-8000-00000000066b';
    const provisional = 'Generate new github pr header artifacts for the dashboard';
    const parent = recoveryBoot({ title: 'Investigate ENG-142' });
    // What the naming pass settled on, which the child's own room and its
    // snapshot both state, and which the header renders.
    const child = recoveryBoot({ title: 'New github pr header' });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
      // The parent's directory, mid-projection: its copy of both children is
      // still the line each was created from. The rail is drawn from this.
      cache.setQueryData(['workstream-children', workstreamId], {
        privateChildren: [
          { substreamId: childId, title: provisional, createdByUserId: null, createdAt: '2026-08-26T14:00:00.000Z', updatedAt: '2026-08-26T14:00:00.000Z' },
          { substreamId: sibling, title: 'Draft the launch note', createdByUserId: null, createdAt: '2026-08-26T14:00:00.000Z', updatedAt: '2026-08-26T14:00:00.000Z' },
        ],
      });
    }, childId);

    expect(await screen.findByRole('heading', { name: 'New github pr header' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to substream: New github pr header' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Go to substream: ${provisional}` })).not.toBeInTheDocument();
    // The row beside it is the parent's to state: nothing in this window is
    // subscribed to a substream it is not showing, so the directory is still
    // the best answer there is for it.
    expect(screen.getByRole('button', { name: 'Go to substream: Draft the launch note' })).toBeInTheDocument();
    // And it follows the child, so a rename arriving while it is open moves the
    // row and the header in the same frame.
    act(() => client.setQueryData(['substream-workstream', workstreamId, childId], { ...child, title: 'Renamed while open' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go to substream: Renamed while open' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Renamed while open' })).toBeInTheDocument();
  });

  it('keeps parent participants in the sidebar while the title bar manages the selected conversation', async () => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const member = { id: '00000000-0000-7000-8000-000000000661', name: 'Parent member', email: 'parent@example.test', timezone: 'UTC' };
    const newcomer = { ...member, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const artifact: WorkstreamResource = {
      id: '00000000-0000-7000-8000-000000000663', title: 'Parent artifact', resourceType: 'document', currentVersion: 1,
      direction: 'artifact', relationshipType: 'generated', refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported',
    };
    const parent = recoveryBoot({ participants: [member], resources: [artifact], appearance: { icon: 'rocket', color: 'purple' } });
    const child = recoveryBoot({ title: 'Private child', participants: [], resources: [{ ...artifact, id: 'child-artifact', title: 'Child artifact' }] });
    api.getWorkspaceMembers.mockResolvedValue([member, newcomer]);
    api.addParticipant.mockResolvedValue({ ...parent, participants: [member, newcomer] });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    expect(await screen.findByRole('button', { name: 'Manage substream participants' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage work-stream participants' })).toHaveAccessibleDescription('Parent member');
    expect(screen.getByRole('heading', { name: 'Private child' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Private child' }).closest('header')!.querySelector('.lucide-rocket')).not.toBeNull();
    act(() => client.setQueryData(['workstream', workstreamId], { ...parent, appearance: { icon: 'heart', color: 'blue' } }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Private child' }).closest('header')!.querySelector('.lucide-heart')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Manage resources' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Parent artifact' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Child artifact' })).not.toBeInTheDocument();
    expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage work-stream participants' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Add New member to work stream' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, newcomer.id));
    expect(screen.getByRole('dialog', { name: 'Add a participant' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New member participant actions' })).toBeVisible();
    await waitFor(() => expect(
      screen.getAllByRole('button', { hidden: true, name: 'Manage work-stream participants' })[0],
    ).toHaveAccessibleDescription('Parent member, New member'));
    expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId])?.participants).toEqual([]);
  });

  it('marks the rail with the parent appearance and follows the sidebar row a receipt just moved', async () => {
    const childId = '00000000-0000-7000-8000-000000000664';
    // The parent detail and the sidebar row disagree on purpose: this is the
    // window after a receipt has patched the row and before the versioned
    // projection reaches the detail. The rail is meant to be on the row.
    const parent = recoveryBoot({ appearance: { icon: 'rocket', color: 'purple' } });
    const child = recoveryBoot({ title: 'Private child' });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      setCachedWorkstreams(cache, [{ ...parent, appearance: { icon: 'megaphone', color: 'teal' } }]);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    const rail = await screen.findByRole('complementary', { name: 'Work-stream sidebar' });
    const mark = (): Element | null => rail.querySelector('.workstream-mark');
    expect(mark()).toHaveClass('lucide-megaphone');
    expect(mark()).toHaveStyle({ color: 'var(--av-sys-color-project-teal)' });
    // The header stays on the detail, which the projection alone may move.
    expect(screen.getByRole('heading', { name: 'Private child' }).closest('header')!.querySelector('.lucide-rocket')).not.toBeNull();

    // The receipt-time writer itself, not a hand-rolled cache poke: it writes
    // the row and deliberately leaves the detail alone.
    act(() => patchCachedWorkstreamAppearance(client, workstreamId, { icon: 'heart', color: 'blue' }));
    await waitFor(() => expect(mark()).toHaveClass('lucide-heart'));
    expect(mark()).toHaveStyle({ color: 'var(--av-sys-color-project-blue)' });
    expect(screen.getByRole('heading', { name: 'Private child' }).closest('header')!.querySelector('.lucide-rocket')).not.toBeNull();
  });

  it('manages the selected substream roster without changing parent participants', async () => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const creator = { id: '00000000-0000-7000-8000-000000000661', name: 'Creator', email: 'creator@example.test', timezone: 'UTC' };
    const newcomer = { ...creator, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const parent = recoveryBoot({ participants: [creator, newcomer] });
    const child = recoveryBoot({ title: 'Private child', participants: [creator] });
    api.getWorkspaceMembers.mockResolvedValue([creator, newcomer]);
    api.addSubstreamParticipant.mockResolvedValue(undefined);
    api.removeSubstreamParticipant.mockResolvedValue(undefined);
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    const manage = await screen.findByRole('button', { name: 'Manage substream participants' });
    expect(manage).toHaveAccessibleDescription('Creator');
    expect(manage.closest('header')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Manage work-stream participants' })).toHaveAccessibleDescription('Creator, New member');
    fireEvent.click(manage);
    fireEvent.click(await screen.findByRole('button', { name: 'Add New member to substream' }));
    await waitFor(() => expect(api.addSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id));
    await waitFor(() => expect(manage).toHaveAccessibleDescription('Creator, New member'));
    expect(screen.getByRole('dialog', { name: 'Add a participant' })).toBeVisible();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'New member participant actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from substream' }));
    await waitFor(() => expect(api.removeSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id));
    await waitFor(() => expect(manage).toHaveAccessibleDescription('Creator'));
    expect(client.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.participants).toEqual([creator, newcomer]);
    expect(api.addParticipant).not.toHaveBeenCalled();
    expect(api.removeParticipant).not.toHaveBeenCalled();
  });

  it.each([false, true])('admits a mentioned person through child membership before sending (refused=%s)', async (refused) => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const creator = { id: '00000000-0000-7000-8000-000000000661', name: 'Creator', email: 'creator@example.test', timezone: 'UTC' };
    const newcomer = { ...creator, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const parent = recoveryBoot({ participants: [creator, newcomer] });
    const child = recoveryBoot({ title: 'Private child', participants: [creator] });
    const createMessage = vi.fn(async () => {
      expect(api.addSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id);
      return { turnId: 'turn', clientMessageId: 'message', createdAt: new Date().toISOString(), deliveryState: 'queued' };
    });
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected', sendReady: true, createMessage, requestSnapshot: vi.fn() });
    api.getWorkspaceMembers.mockResolvedValue([creator, newcomer]);
    if (refused) api.addSubstreamParticipant.mockRejectedValue(new Error('Parent access required'));
    else api.addSubstreamParticipant.mockResolvedValue(undefined);
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    const composer = await screen.findByRole('textbox', { name: 'Message the work stream' });
    await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalled());
    fireEvent.change(composer, { target: { value: 'Please ask @New member to review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add and mention' }));
    if (refused) {
      expect(await screen.findByText('Parent access required')).toBeInTheDocument();
      expect(createMessage).not.toHaveBeenCalled();
      expect(composer).toHaveValue('Please ask @New member to review.');
    } else {
      await waitFor(() => expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ confirmedParticipantUserIds: [] })));
    }
  });

  it('admits the feed while the snapshot is pending without starting REST boot readers', async () => {
    renderScreen();

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await waitFor(() => expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0'));
  });

  it('requests a replacement snapshot when a retained socket outlives its base caches', async () => {
    const requestSnapshot = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null, activeInferenceDelays: [],
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

  // The unit tests below this file cover `conversationShowsStoppingRow` and the
  // activity slot's order separately, and both stayed green through a version
  // of this change that rendered the acknowledgement where a scrolled-up reader
  // could never see it. Nothing joined the decision to a rendered surface, so
  // the one user-visible thing the change exists for was the part not covered.
  describe('a pending stop is acknowledged above the composer', () => {
    function stoppingScreen(overrides: Partial<WorkstreamBoot> = {}): void {
      const boot = recoveryBoot({ harnessStatus: 'running', stopRequested: true, ...overrides });
      const { transcript, ...detail } = boot;
      renderScreen((queryClient) => {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
        queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
      });
    }

    it('names the wait, in the dock rather than in the scrolling transcript', async () => {
      stoppingScreen();
      await act(async () => Promise.resolve());

      const row = screen.getByRole('status', { name: STOPPING_LABEL });
      expect(row).toBeVisible();
      // The placement is the fix, not a detail of it: `.transcript-scroll` stops
      // following once the reader scrolls up, so an acknowledgement inside it is
      // below the fold for exactly the person who pressed Stop while reading
      // history. Asserting the text alone passes in the box that hides it.
      expect(row.closest('.composer-dock')).not.toBeNull();
      expect(row.closest('.transcript-scroll')).toBeNull();
    });

    it('says nothing once the run it was waiting on has settled', async () => {
      stoppingScreen({ harnessStatus: 'stopped' });
      await act(async () => Promise.resolve());

      expect(screen.queryByRole('status', { name: STOPPING_LABEL })).not.toBeInTheDocument();
    });
  });

  it.each(['running', 'completed', 'different-run'] as const)('scopes the slowdown notice to the active response: %s', async (phase) => {
    const runId = '00000000-0000-7000-8000-000000000651';
    const delay = {
      harnessRunId: runId, executionId: runId,
      attemptId: '00000000-0000-7000-8000-000000000652',
      inferenceRequestId: '00000000-0000-7000-8000-000000000653', turnId: 'turn:delay',
    };
    retainedSocket.mockReturnValue({
      activeCompaction: null, activeInferenceDelays: [delay, { ...delay, inferenceRequestId: '00000000-0000-7000-8000-000000000654' }],
      createMessage: vi.fn(), requestSnapshot: vi.fn(), retryOpening: vi.fn(),
      sendReady: true, state: 'connected', workspaceSocketState: 'connected',
    });
    const { transcript, ...detail } = recoveryBoot({
      harnessStatus: phase === 'completed' ? 'completed' : 'running',
      latestHarnessRunId: phase === 'different-run' ? '00000000-0000-7000-8000-000000000655' : runId,
    });
    renderScreen((client) => {
      client.setQueryData(['workstream', workstreamId], detail);
      client.setQueryData(['ordered-transcript', workstreamId], transcript);
    });
    await act(async () => Promise.resolve());
    expect(screen.queryAllByText('The model is currently slowed down. Responses might take longer.'))
      .toHaveLength(phase === 'running' ? 1 : 0);
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

    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage work-stream participants' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jordan to work stream' }));
    expect(await screen.findByText('Adam cannot add Jordan')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a participant' })).toBeVisible();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Katherine participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from work stream' }));

    expect(await screen.findByText('Adam cannot remove Katherine')).toBeInTheDocument();
    expect(screen.queryByText('Adam cannot add Jordan')).not.toBeInTheDocument();
  });

  it('keeps the participant dialog open after an add so another person can be added', async () => {
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
    const detail = recoveryBoot({ participants: [adam] });
    api.getWorkspaceMembers.mockResolvedValue([adam, katherine, jordan]);
    api.addParticipant
      .mockResolvedValueOnce({ ...detail, participants: [adam, katherine] })
      .mockResolvedValueOnce({ ...detail, participants: [adam, katherine, jordan] });

    renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], detail.transcript);
    });

    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage work-stream participants' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Katherine to work stream' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, katherine.id));
    const dialog = screen.getByRole('dialog', { name: 'Add a participant' });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Jordan to work stream' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, jordan.id));
    expect(api.addParticipant).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog', { name: 'Add a participant' })).toBeVisible();
  });

  it('retries the authoritative socket after the first attempt fails', async () => {
    const retryOpening = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null, activeInferenceDelays: [],
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
      activeCompaction: null, activeInferenceDelays: [],
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

  it('paints a remembered transcript with a connecting card and blocks sending until the live snapshot lands', async () => {
    const createMessage = vi.fn();
    const socket = {
      activeCompaction: null, activeInferenceDelays: [], createMessage, requestSnapshot: vi.fn(), retryOpening: vi.fn(),
      sendReady: true, state: 'connecting', workspaceSocketState: 'connecting',
    };
    retainedSocket.mockReturnValue(socket);
    const boot = recoveryBoot({ title: 'Remembered work stream' });
    const { transcript, ...detail } = boot;
    const cache = renderScreen((client) => {
      client.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'local_cache');
      client.setQueryData(['workstream', workstreamId], detail);
      client.setQueryData(['ordered-transcript', workstreamId], transcript);
    });

    // The screen is not "Opening": the remembered conversation is on it.
    expect(screen.queryByText('Opening work stream…')).not.toBeInTheDocument();
    expect(document.querySelector('.connecting-card')?.textContent ?? '').toContain('Connecting to Remembered work stream…');
    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'Typed while connecting' } });
    // The button says why on its own label, for whoever cannot see the card.
    expect(screen.getByRole('button', { name: 'Send message, available once Rally connects' })).toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(createMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Typed while connecting');
    // The capsule composer has no footer, so the card carries the reason.
    expect(document.querySelector('.connecting-card')?.textContent ?? '').toContain('Sending is available once Rally connects');

    socket.state = 'connected';
    act(() => {
      cache.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'socket_snapshot');
      cache.setQueryData(['workstream', workstreamId], { ...detail, title: 'Live work stream' });
    });

    await waitFor(() => expect(document.querySelector('.connecting-card')).toBeNull());
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(composer).toHaveValue('Typed while connecting');
  });

  it('keeps the remembered transcript and offers a retry on the card when the cached open times out', async () => {
    const retryOpening = vi.fn();
    retainedSocket.mockReturnValue({
      activeCompaction: null, activeInferenceDelays: [], createMessage: vi.fn(), requestSnapshot: vi.fn(), retryOpening,
      openingError: 'The live connection timed out after 3 attempts.',
      sendReady: false, state: 'unavailable', workspaceSocketState: 'connecting',
    });
    const boot = recoveryBoot({ title: 'Remembered work stream' });
    const { transcript, ...detail } = boot;
    renderScreen((client) => {
      client.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'local_cache');
      client.setQueryData(['workstream', workstreamId], detail);
      client.setQueryData(['ordered-transcript', workstreamId], transcript);
    });

    expect(screen.queryByText('Work stream could not be opened')).not.toBeInTheDocument();
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryOpening).toHaveBeenCalledTimes(1);
  });

});
