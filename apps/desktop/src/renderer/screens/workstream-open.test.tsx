import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
  renameSubstream: vi.fn(),
  resolveConversation: vi.fn(),
  setSubstreamArchived: vi.fn(),
  renameWorkstream: vi.fn(),
  archiveWorkstream: vi.fn(),
  setWorkstreamScope: vi.fn(),
  addParticipant: vi.fn(),
  addSubstreamParticipant: vi.fn(),
  removeSubstreamParticipant: vi.fn(),
  clientFeatureFlags: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getPeopleRanking: vi.fn(async () => ({ channel: [], organization: [] })),
  getConnections: vi.fn(),
  listScopeInvitations: vi.fn(),
  getScopeSharingOptions: vi.fn(),
  listManagedScopeGrants: vi.fn(),
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
vi.mock('../lib/collaboration-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationSessionModule>();
  return {
    useOptionalCollaborationSession: () => null,
    useCollaborationSession: () => ({ api, session: session.current }),
    useShellCapabilities: () => actual.shellCapabilities({ host: 'desktop', session: session.current as ClientSession | null }),
  };
});

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: {} }),
}));

vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketOpenContext: () => () => ({}),
  useRetainedWorkstreamSocket: retainedSocket,
}));

vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
  useOptionalWorkspaceSocket: () => null,
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
    isFollowing: () => true,
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
import { ApiError } from '../lib/api';
import { STOPPED_LABEL, STOPPING_LABEL } from '../components/agent-work-timing';
import { ConversationOpeningSkeleton, ConversationSurface } from './conversation-surface';
import { workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import { useUiStore } from '../lib/ui-store';
import { WorkstreamScreen } from './workstream';
import { ChannelPaneContextValue, type ChannelPaneContext } from '../lib/navigation-routes';
import type { HarnessRunMetadata, HarnessStatus, WorkstreamBoot, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import type * as CollaborationSessionModule from '../lib/collaboration-session';
import type { ClientSession } from '@rally/contracts/client-session';
import { asSpaceId, type SpaceDirectory } from '@rally/contracts';

const workstreamId = '00000000-0000-7000-8000-000000000650';

function recoveryBoot(overrides: Partial<WorkstreamBoot> = {}): WorkstreamBoot {
  return {
    id: workstreamId,
    title: 'Recovered channel',
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
    spaceIds: ['00000000-0000-7000-8000-000000000673'],
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
let locationInTest: ReturnType<typeof useLocation>;

/**
 * Opens a title pill's menu, as a pointer press on it does, and picks an item.
 * An item inside a level (People, More) is named by its path: each step is
 * picked in turn, the last one being the action.
 */
async function titleMenu(trigger: string | RegExp, item: string | readonly string[]): Promise<void> {
  fireEvent.pointerDown(await screen.findByRole('button', { name: trigger }), { button: 0, ctrlKey: false });
  for (const step of typeof item === 'string' ? [item] : item) {
    // A setting in More is a switch, not a plain item.
    fireEvent.click(await waitFor(() => screen.queryByRole('menuitem', { name: step })
      ?? screen.getByRole('menuitemcheckbox', { name: step })));
  }
}

/** A list a live row wrote; one seeded from the device has no version. */
const liveVersion = {
  commonEventId: '00000000-0000-7000-8000-000000000007',
  viewerEventId: '00000000-0000-7000-8001-000000000004',
  authorityGeneration: 1,
  commonWaterline: 7,
  viewerWaterline: 4,
};

function NavigationProbe(): null { navigateInTest = useNavigate(); locationInTest = useLocation(); return null; }

function renderScreen(seed?: (queryClient: QueryClient) => void, substreamId?: string, restored = false, initialPath = `/workstreams/${workstreamId}`, channelPane: ChannelPaneContext | null = null): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  seed?.(queryClient);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[{ pathname: initialPath,
          search: substreamId ? `?substream=${substreamId}` : '',
          state: restored ? { restoredBreakout: substreamId } : null }]}>
          <NavigationProbe />
          <ChannelPaneContextValue.Provider value={channelPane}>
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
            <Route element={<div>Parent channel</div>} path="/channels/:channelId" />
            <Route element={<WorkstreamScreen />} path="/channels/:channelId/threads/:id" />
            <Route element={<div>Settings</div>} path="/settings" />
          </Routes>
          </ChannelPaneContextValue.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('socket-first channel open', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    session.current = null;
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.listScopeInvitations.mockResolvedValue({ status: "ready", invitations: [] });
    api.getScopeSharingOptions.mockResolvedValue({ scopes: [], completeWorkstreamTargets: null });
    api.listManagedScopeGrants.mockResolvedValue({ status: "ready", grants: [] });
    retainedSocket.mockReturnValue({
      suggestions: [],
      activeCompaction: null, activeInferenceDelays: [],
      createMessage: vi.fn(),
      setAppearance: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: false,
      state: 'connecting',
      workspaceSocketState: 'connecting',
    });
  });

  it('returns a restored Breakout to Main when the live child directory no longer contains it', async () => {
    const missing = '00000000-0000-7000-8000-00000000066a';
    const parent = recoveryBoot();
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [], stateVersion: liveVersion });
    }, missing, true);
    await waitFor(() => expect(locationInTest.search).toBe(''));
  });

  it('keeps a restored Breakout that a child directory seeded from the device does not list', async () => {
    const created = '00000000-0000-7000-8000-00000000066a';
    const parent = recoveryBoot();
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [] });
    }, created, true);
    await screen.findByRole('textbox', { name: /message/iu });
    expect(locationInTest.search).toBe(`?substream=${created}`);
  });

  it('counts background agents only in the conversation that started them', async () => {
    const childId = '00000000-0000-7000-8000-00000000066a';
    const parent = recoveryBoot();
    const child = recoveryBoot({ title: 'Private investigation' });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [
        { substreamId: childId, title: child.title, createdByUserId: null, createdAt: child.createdAt, updatedAt: child.updatedAt },
      ] });
      cache.setQueryData(['workstream-background-agents', workstreamId], { [childId]: 2 });
    });
    await screen.findByRole('textbox', { name: /message/iu });
    expect(screen.queryByRole('status', { name: /background agents? running/u })).not.toBeInTheDocument();
    act(() => navigateInTest(`/workstreams/${workstreamId}?substream=${childId}`));
    expect(await screen.findByRole('status', { name: '2 background agents running' })).toBeInTheDocument();
  });

  it('uses only the selected guest conversation roster despite a cached organization directory', async () => {
    const member = { id: '00000000-0000-7000-8000-000000000661', name: 'Shared person', email: 'shared@example.test', timezone: 'UTC' };
    session.current = { user: member, workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: null, accessClass: 'guest' } };
    const childId = '00000000-0000-7000-8000-000000000662';
    const boot = recoveryBoot({ participants: [member] });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cache.setQueryData(workstreamDetailQueryKey(workstreamId, childId), boot);
    cache.setQueryData(orderedTranscriptQueryKey(workstreamId, childId), boot.transcript);
    cache.setQueryData(['workspace-members'], [{ ...member, id: 'hidden', name: 'Hidden organization person' }]);
    render(<Tooltip.Provider><QueryClientProvider client={cache}><MemoryRouter>
      <ConversationSurface parentKind="workstream" parentId={workstreamId} substreamId={childId}
        renderHeader={({ openParticipantDialog }) => <button onClick={openParticipantDialog}>People</button>} />
    </MemoryRouter></QueryClientProvider></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'People' }));
    expect(await screen.findByText('Shared person')).toBeVisible();
    expect(screen.queryByText('Hidden organization person')).not.toBeInTheDocument();
    expect(api.getWorkspaceMembers).not.toHaveBeenCalled();
    expect(api.getConnections).not.toHaveBeenCalled();
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

  async function mainMenu(action: string | readonly string[]): Promise<void> {
    await titleMenu('Thread menu: Recovered channel', action);
  }

  it.each(['make_public', 'rename', 'archive'] as const)('reports successful Main %s and never reports failed attempts', async (action) => {
    const boot = recoveryBoot();
    const report = vi.spyOn(desktopBridge(), 'reportTelemetryProductIntent').mockResolvedValue(undefined);
    const mutation = action === 'make_public' ? api.setWorkstreamScope : action === 'rename' ? api.renameWorkstream : api.archiveWorkstream;
    const diagnostic = `INTERNAL ROUTER RESPONSE: ${action} route does not exist`;
    mutation.mockRejectedValueOnce(new Error(diagnostic)).mockResolvedValue({ ...boot, scope: action === 'make_public' ? 'workspace' : 'personal' });
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    const label = action === 'make_public' ? ['More', 'Public to organization'] : action === 'rename' ? 'Rename' : ['More', 'Archive thread'];
    await mainMenu(label);
    if (action === 'rename') fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed parent' } });
    if (action !== 'make_public') fireEvent.click(screen.getByRole('button', { name: action === 'rename' ? 'Rename' : 'Archive' }));
    await screen.findByText(action === 'make_public'
      ? 'The thread couldn’t be made public. Try again.'
      : `The thread couldn’t be ${action === 'rename' ? 'renamed' : 'archived'}. Try again.`);
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
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

  it('makes a public Channel private and names what blocks it when a Space holds it public', async () => {
    const boot = recoveryBoot({ scope: 'workspace' });
    const report = vi.spyOn(desktopBridge(), 'reportTelemetryProductIntent').mockResolvedValue(undefined);
    api.setWorkstreamScope
      .mockRejectedValueOnce(new ApiError('scope locked', 409, 'channel_scope_locked_by_space'))
      .mockResolvedValue({ ...boot, scope: 'personal' });
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await mainMenu('More');
    const toggle = await screen.findByRole('menuitemcheckbox', { name: 'Public to organization' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await screen.findByText('An organization-wide channel still makes this thread public. Remove it from that channel first.');
    expect(api.setWorkstreamScope).toHaveBeenLastCalledWith(workstreamId, 'personal');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await mainMenu(['More', 'Public to organization']);
    await waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_action_completed', workstreamId, action: 'make_private', visibility: 'private',
    })));
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
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [
        { substreamId: childId, title: child.title, createdByUserId: null, createdAt: child.createdAt, updatedAt: child.updatedAt },
      ] });
    }, childId);
    await titleMenu('Breakout menu: Private investigation', action === 'rename' ? 'Rename' : ['More', 'Archive breakout']);
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
    await mainMenu(action === 'rename' ? 'Rename' : ['More', 'Archive thread']);
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
    await mainMenu('Copy link');
    await waitFor(() => expect(copy).toHaveBeenCalledOnce());
    if (next === 'navigate') act(() => navigateInTest('/workstreams/00000000-0000-7000-8000-000000000651'));
    else await mainMenu('Rename');
    await act(async () => rejectCopy(new Error('Clipboard unavailable')));
    expect(screen.queryByText('Clipboard unavailable')).not.toBeInTheDocument();
    if (next === 'rename') expect(screen.getByRole('dialog', { name: 'Rename thread' })).toBeVisible();
  });

  it('positions a laid-out opening before enabling automatic history requests', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    scrollTranscriptToEnd.mockImplementationOnce(() => { screen.getByRole('log').scrollTop = 1400; });
    const loadTranscriptRange = vi.fn().mockResolvedValue(undefined);
    retainedSocket.mockReturnValue({
      suggestions: [],
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

  it('tells Activity what is on screen once the thread is visible and focused, and only once while that holds', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    const boot = historyBoot();
    renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    await waitFor(() => expect(api.recordActivityEvents).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'read', subject: { kind: 'thread', threadId: workstreamId } }),
    ]));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 400)); });
    expect(api.recordActivityEvents).toHaveBeenCalledTimes(1);
  });

  it('shares pending requests across A to B to A and discards departed-visit restoration', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const other = '00000000-0000-7000-8000-000000000651';
    let resolveA = (): void => {};
    let resolveB = (): void => {};
    const loadA = vi.fn(() => new Promise<void>(resolve => { resolveA = resolve; }));
    const loadB = vi.fn(() => new Promise<void>(resolve => { resolveB = resolve; }));
    retainedSocket.mockImplementation((_api, id) => ({
      state: 'connected', workspaceSocketState: 'connected', suggestions: [], activeCompaction: null, activeInferenceDelays: [],
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
    const socket = { state: 'connecting', workspaceSocketState: 'connected', suggestions: [], activeCompaction: null, activeInferenceDelays: [],
      sendReady: false, requestSnapshot: vi.fn(), retryOpening: vi.fn(), loadTranscriptRange };
    retainedSocket.mockReturnValue(socket);
    const boot = historyBoot();
    const cache = renderScreen(cache => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });
    expect(await screen.findByText('Waiting to reconnect…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }));
    expect(socket.retryOpening).toHaveBeenCalledOnce();
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
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected', suggestions: [],
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
    expect(await screen.findByText('Newer messages couldn’t be loaded. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('Newer gap unavailable')).not.toBeInTheDocument();
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
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected', suggestions: [],
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
      suggestions: [],
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

  /** A breakout starts from a message, by its hover action: the newest message's. */
  async function startBreakoutFromLatestMessage(): Promise<void> {
    fireEvent.click((await screen.findAllByRole('button', { name: 'New breakout from this message' })).at(-1)!);
  }

  /** The feed draws only the rows its window holds, so the window is given a size. */
  function layOutFeedWindow(): void {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
  }

  function openConversation(count: number): QueryClient {
    layOutFeedWindow();
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
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New breakout', context: { parts: [] } });
    api.confirmSubstream.mockResolvedValue({
      substreamId: childId,
      title: 'Check the pricing page',
      opening: { turnId: 'turn-child-9', clientMessageId: 'client-9', createdAt: '2026-08-26T14:05:00.000Z' },
    });
    session.current = {
      user: { id: '00000000-0000-7000-8000-000000000671', name: 'Creator', email: 'creator@example.test' },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    layOutFeedWindow();
    const boot = conversationBoot(2);
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], { ...boot, modelOverride: 'x-ai/grok-4.6' });
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });

    await startBreakoutFromLatestMessage();
    const composer = await screen.findByRole('textbox', { name: 'What should this breakout work on?' });
    fireEvent.change(composer, { target: { value: 'Check the pricing page' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId]))
      .toMatchObject({ title: 'Check the pricing page' }));
    expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId])?.modelOverride)
      .toBeNull();
  });

  it('creates a breakout from the launch composer and seeds the conversation it opens', async () => {
    const childId = '00000000-0000-7000-8000-000000000670';
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New breakout', context: { parts: [] } });
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

    await startBreakoutFromLatestMessage();
    const composer = await screen.findByRole('textbox', { name: 'What should this breakout work on?' });
    fireEvent.change(composer, { target: { value: 'Check the pricing page' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.confirmSubstream).toHaveBeenCalled());
    expect(api.prepareSubstream).toHaveBeenCalledWith(workstreamId, {
      operationId: api.prepareSubstream.mock.calls[0]![1].operationId,
      throughTurnId: 'turn-2',
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

  it('releases a reserved child when the surface is left after a failed submit', async () => {
    // Nothing is reserved while the surface is merely open, but a submit that
    // got past `prepare` leaves a child id and a spent summary behind it, and
    // the surface stays open over them. Leaving is what gives them back.
    api.prepareSubstream.mockResolvedValue({
      operationId: 'op', substreamId: '00000000-0000-7000-8000-000000000674', title: 'New breakout', context: { parts: [] },
    });
    const diagnostic = 'INTERNAL ROUTER RESPONSE: breakout route does not exist';
    api.confirmSubstream.mockRejectedValue(new Error(diagnostic));
    api.cancelSubstream.mockResolvedValue(undefined);
    openConversation(1);
    await startBreakoutFromLatestMessage();
    const composer = await screen.findByRole('textbox', { name: 'What should this breakout work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('The breakout couldn’t be created. Try again.');
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    expect(api.cancelSubstream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel new breakout' }));
    await waitFor(() => expect(api.cancelSubstream)
      .toHaveBeenCalledWith(workstreamId, api.prepareSubstream.mock.calls[0]![1].operationId));
  });

  it('retries a lost creation under the same identity rather than making a second breakout', async () => {
    const childId = '00000000-0000-7000-8000-000000000673';
    // The failure this covers: the response is lost after the server committed.
    // A retry that minted fresh ids would reserve a second child and say the
    // same message twice; under the same ids both halves resume.
    api.prepareSubstream.mockResolvedValue({ operationId: 'op', substreamId: childId, title: 'New breakout', context: { parts: [] } });
    const diagnostic = 'INTERNAL ROUTER RESPONSE: confirmation route does not exist';
    api.confirmSubstream.mockRejectedValueOnce(new Error(diagnostic));
    api.confirmSubstream.mockResolvedValue({
      substreamId: childId,
      title: 'Look at the invoice',
      opening: { turnId: 'turn-child-1', clientMessageId: 'client-1', createdAt: '2026-08-26T14:05:00.000Z' },
    });
    openConversation(1);
    await startBreakoutFromLatestMessage();
    const composer = await screen.findByRole('textbox', { name: 'What should this breakout work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('The breakout couldn’t be created. Try again.');
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();

    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'What should this breakout work on?' }), { key: 'Enter' });
    await waitFor(() => expect(api.confirmSubstream).toHaveBeenCalledTimes(2));
    const [first, second] = api.confirmSubstream.mock.calls;
    expect(second![1]).toBe(first![1]);
    expect(second![2].clientMessageId).toBe(first![2].clientMessageId);
    expect(api.prepareSubstream.mock.calls[1]![1].operationId)
      .toBe(api.prepareSubstream.mock.calls[0]![1].operationId);
  });

  it('puts the message back in the composer when the breakout could not be created', async () => {
    const diagnostic = 'INTERNAL ROUTER RESPONSE: preparation route does not exist';
    api.prepareSubstream.mockRejectedValue(new Error(diagnostic));
    openConversation(1);
    await startBreakoutFromLatestMessage();
    const composer = await screen.findByRole('textbox', { name: 'What should this breakout work on?' });
    fireEvent.change(composer, { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('The breakout couldn’t be created. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'What should this breakout work on?' }))
      .toHaveValue('Look at the invoice'));
    expect(api.confirmSubstream).not.toHaveBeenCalled();
  });

  it('holds the breakout initial-context entry in the cache, which nothing renders', async () => {
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

    await screen.findByRole('button', { name: 'Breakout menu: Private child' });
    expect(client.getQueryCache()
      .find({ queryKey: substreamInitialContextQueryKey(workstreamId, childId) })
      ?.getObserversCount()).toBeGreaterThan(0);
  });

  it('draws the open breakout under its own name, not the one its parent still has for it', async () => {
    const childId = '00000000-0000-7000-8000-00000000066a';
    const sibling = '00000000-0000-7000-8000-00000000066b';
    const provisional = 'Generate new github pr header artifacts for the dashboard';
    const parent = recoveryBoot({ title: 'Investigate ENG-142' });
    // What the naming pass settled on, which the child's own room and its
    // snapshot both state, and which the header renders.
    const child = recoveryBoot({ title: 'New github pr header' });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
      // The parent's directory, mid-projection: its copy of both children is
      // still the line each was created from. The Channel menu is drawn from this.
      cache.setQueryData(['workstream-children', workstreamId], {
        privateChildren: [
          { substreamId: childId, title: provisional, createdByUserId: null, createdAt: '2026-08-26T14:00:00.000Z', updatedAt: '2026-08-26T14:00:00.000Z' },
          { substreamId: sibling, title: 'Draft the launch note', createdByUserId: null, createdAt: '2026-08-26T14:00:00.000Z', updatedAt: '2026-08-26T14:00:00.000Z' },
        ],
      });
    }, childId);

    expect(await screen.findByRole('button', { name: 'Breakout menu: New github pr header' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Thread menu: Investigate ENG-142' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Breakouts/u }));
    const breakoutRows = (): string[] => screen.getAllByRole('menuitem')
      .filter((item) => item.classList.contains('title-menu-breakout'))
      .map((item) => item.querySelector('.title-menu-item-copy')?.textContent ?? '');
    await waitFor(() => expect(breakoutRows()).toContain('New github pr header'));
    expect(breakoutRows()).not.toContain(provisional);
    // The row beside it is the parent's to state: nothing in this window is
    // subscribed to a substream it is not showing, so the directory is still
    // the best answer there is for it.
    expect(breakoutRows()).toContain('Draft the launch note');
    // The open one is marked as the one on screen.
    expect(screen.getAllByRole('menuitem').find((item) => item.getAttribute('aria-current') === 'true'))
      .toHaveTextContent('New github pr header');
    // And it follows the child, so a rename arriving while it is open moves the
    // row and the pill in the same frame.
    act(() => client.setQueryData(['substream-workstream', workstreamId, childId], { ...child, title: 'Renamed while open' }));
    await waitFor(() => expect(breakoutRows()).toContain('Renamed while open'));
    expect(screen.getByRole('button', { name: 'Breakout menu: Renamed while open' })).toBeInTheDocument();
  });

  it('opens the thread alone from its crumb, closing the breakout and the panel the breakout held', async () => {
    const childId = '00000000-0000-7000-8000-00000000066c';
    const parent = recoveryBoot({ title: 'Investigate ENG-142' });
    const child = recoveryBoot({ title: 'Rollout date' });
    // The breakout's panel takes the thread's slot, so the thread rides as its crumb.
    useUiStore.setState({ railOpen: true, railScope: `${workstreamId}:${childId}` });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    const crumb = await screen.findByRole('button', { name: 'Open thread: Investigate ENG-142' });
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, railScope: `${workstreamId}:${childId}` });
    fireEvent.click(crumb);

    await waitFor(() => expect(locationInTest.search).toBe(''));
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('keeps parent inventory in the Channel menu while the Breakout pill uses its own appearance', async () => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const member = { id: '00000000-0000-7000-8000-000000000661', name: 'Parent member', email: 'parent@example.test', timezone: 'UTC' };
    const newcomer = { ...member, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const artifact: WorkstreamResource = {
      id: '00000000-0000-7000-8000-000000000663', title: 'Parent artifact', resourceType: 'document', currentVersion: 1,
      direction: 'artifact', relationshipType: 'generated', refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported',
    };
    const parent = recoveryBoot({ participants: [member], resources: [artifact], appearance: { icon: 'rocket', color: 'purple' } });
    const child = recoveryBoot({ title: 'Private child', appearance: { icon: 'orbit', color: 'green' }, participants: [], resources: [{ ...artifact, id: 'child-artifact', title: 'Child artifact' }] });
    api.getWorkspaceMembers.mockResolvedValue([member, newcomer]);
    api.addParticipant.mockResolvedValue({ ...parent, participants: [member, newcomer] });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    expect(await screen.findByRole('button', { name: 'Breakout menu: Private child' })).toBeInTheDocument();
    // Like a thread's pill, the Breakout's pill icon is its appearance picker.
    expect(screen.getByRole('button', { name: 'Change Private child icon' })).toBeInTheDocument();
    act(() => client.setQueryData(['workstream', workstreamId], { ...parent, appearance: { icon: 'heart', color: 'blue' } }));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Thread menu: Recovered channel' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: /^People\s*1/u })).toBeInTheDocument();
    // The Channel's artifacts are in More, and they are the Channel's own.
    fireEvent.click(screen.getByRole('menuitem', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Parent artifact' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Child artifact' })).not.toBeInTheDocument();
    expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0');

    // Adding from the menu's People level adds to the main conversation.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowLeft' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add New member' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, newcomer.id));
    expect(client.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, childId])?.participants).toEqual([]);
  });

  it('saves the selected breakout appearance through that breakout connection', async () => {
    const childId = '00000000-0000-7000-8000-000000000665';
    const mainAppearance = vi.fn().mockResolvedValue(undefined);
    const childAppearance = vi.fn().mockResolvedValue(undefined);
    retainedSocket.mockImplementation((_api, _id, _enabled, _kind, substreamId) => ({
      activeCompaction: null,
      activeInferenceDelays: [],
      createMessage: vi.fn(),
      setAppearance: substreamId === childId ? childAppearance : mainAppearance,
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
      suggestions: [],
    }));
    const parent = recoveryBoot({ appearance: { icon: 'rocket', color: 'blue' } });
    const child = recoveryBoot({ title: 'Private child', appearance: { icon: 'orbit', color: 'green' } });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [{
        substreamId: childId,
        title: child.title,
        appearance: child.appearance,
        createdByUserId: null,
        createdAt: child.createdAt,
        updatedAt: child.createdAt,
      }] });
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    // The pill's own icon picker, like a thread pill's.
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Change Private child icon' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    await waitFor(() => expect(childAppearance).toHaveBeenCalledWith({ icon: 'rocket' }));
    expect(mainAppearance).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // And the menu's Icon submenu.
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Breakout menu: Private child' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Icon' }), { key: 'ArrowRight' });
    // The colour is the Channel's, so only the icon is offered.
    expect(screen.queryByRole('menuitemradio', { name: 'Purple' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Heart' }));
    await waitFor(() => expect(childAppearance).toHaveBeenCalledWith({ icon: 'heart' }));
    expect(mainAppearance).not.toHaveBeenCalled();
  });

  it('saves the Channel appearance chosen from its More', async () => {
    const mainAppearance = vi.fn().mockResolvedValue(undefined);
    retainedSocket.mockImplementation(() => ({
      activeCompaction: null,
      activeInferenceDelays: [],
      createMessage: vi.fn(),
      setAppearance: mainAppearance,
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
      suggestions: [],
    }));
    const boot = recoveryBoot({ appearance: { icon: 'rocket', color: 'blue' } });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], boot);
      cache.setQueryData(['ordered-transcript', workstreamId], boot.transcript);
    });

    await titleMenu('Thread menu: Recovered channel', 'More');
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Icon' }), { key: 'ArrowRight' });
    expect(screen.queryByRole('menuitemradio', { name: 'Purple' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Heart' }));
    await waitFor(() => expect(mainAppearance).toHaveBeenCalledWith({ icon: 'heart' }));
  });

  it('marks the Channel pill with the sidebar row\'s appearance, which a receipt moves first', async () => {
    const childId = '00000000-0000-7000-8000-000000000664';
    // The parent detail and the sidebar row disagree on purpose: this is the
    // window after a receipt has patched the row and before the versioned
    // projection reaches the detail. The pill is meant to be on the row.
    const parent = recoveryBoot({ appearance: { icon: 'rocket', color: 'purple' } });
    const child = recoveryBoot({ title: 'Private child' });
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      setCachedWorkstreams(cache, [{ ...parent, appearance: { icon: 'megaphone', color: 'teal' } }]);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    const channelTrigger = await screen.findByRole('button', { name: 'Change Recovered channel icon' });
    expect(channelTrigger.querySelector('.lucide-megaphone')).not.toBeNull();

    // The receipt-time writer itself, not a hand-rolled cache poke: it writes
    // the row and deliberately leaves the detail alone.
    act(() => patchCachedWorkstreamAppearance(client, workstreamId, { icon: 'heart', color: 'blue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change Recovered channel icon' })
      .querySelector('.lucide-heart')).not.toBeNull());
  });

  it.each(['0', '00000000-0000-7000-8000-000000000660'])('resolves %s before returning to its parent', async (childId) => {
    const channelId = '00000000-0000-7000-8000-000000000663';
    const parent = recoveryBoot({ spaceIds: [channelId] });
    const child = recoveryBoot({ title: 'Private child' });
    let finish!: () => void;
    api.resolveConversation.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    const label = childId === '0' ? 'Thread menu: Recovered channel' : 'Breakout menu: Private child';
    await titleMenu(label, childId === '0' ? 'Resolve Thread' : 'Resolve Breakout');
    expect(api.resolveConversation).toHaveBeenCalledWith(workstreamId, childId);
    expect(locationInTest.pathname).toBe(`/workstreams/${workstreamId}`);
    expect(locationInTest.search).toBe(`?substream=${childId}`);
    await act(async () => { finish(); });
    await waitFor(() => {
      expect(locationInTest.pathname).toBe(childId === '0' ? `/channels/${channelId}` : `/workstreams/${workstreamId}`);
      expect(locationInTest.search).toBe('');
    });
    expect(api.archiveWorkstream).not.toHaveBeenCalled();
    expect(api.setSubstreamArchived).not.toHaveBeenCalled();
  });

  it.each([
    { childId: '0', directoryCached: true },
    { childId: '0', directoryCached: false },
    { childId: '00000000-0000-7000-8000-000000000660', directoryCached: true },
  ])('keeps resolved conversation actions disabled for $childId (directory cached: $directoryCached)', async ({ childId, directoryCached }) => {
    const parent = recoveryBoot({ resolved: childId === '0' });
    const child = recoveryBoot({ title: 'Private child' });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      if (directoryCached) setCachedWorkstreams(cache, [parent]);
      cache.setQueryData<SpaceDirectory>(['spaces'], { waterline: 1, items: parent.spaceIds.map((id) => ({
        id: asSpaceId(id), name: 'Engineering', iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', reach: 'organization', status: 'active',
        systemRole: null, revision: 1, participants: [], channelCount: 1, attentionCount: 0,
        defaultResourceIds: [], defaultSidekickIds: [], createdAt: parent.createdAt, updatedAt: parent.createdAt,
      })) });
      cache.setQueryData(['workstream-children', workstreamId], { privateChildren: [{
        substreamId: childId, title: child.title, resolved: true,
        createdByUserId: null, createdAt: child.createdAt, updatedAt: child.createdAt,
      }] });
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    fireEvent.pointerDown(await screen.findByRole('button', {
      name: childId === '0' ? 'Thread menu: Recovered channel' : 'Breakout menu: Private child',
    }), { button: 0, ctrlKey: false });
    const resolve = await screen.findByRole('menuitem', { name: childId === '0' ? 'Resolve Thread' : 'Resolve Breakout' });
    expect(resolve).toHaveAttribute('aria-disabled', 'true');
    fireEvent.pointerMove(resolve, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      childId === '0' ? 'This thread is already resolved.' : 'This breakout is already resolved.',
    );
    if (childId === '0') {
      const merge = screen.getByRole('menuitem', { name: /^Merge to Engineering/u });
      expect(merge).toHaveAttribute('aria-disabled', 'true');
      fireEvent.pointerLeave(resolve, { pointerType: 'mouse' });
      fireEvent.pointerMove(merge, { pointerType: 'mouse' });
      expect(await screen.findByRole('tooltip')).toHaveTextContent('This thread is already resolved.');
      fireEvent.click(merge);
      expect(screen.queryByRole('textbox', { name: 'Merge note' })).not.toBeInTheDocument();
    }
    fireEvent.click(resolve);
    expect(api.resolveConversation).not.toHaveBeenCalled();
    expect(locationInTest.pathname).toBe(`/workstreams/${workstreamId}`);
    expect(locationInTest.search).toBe(`?substream=${childId}`);
  });

  it.each(['unmount', 'channel change'])('ignores a late resolution after %s', async (change) => {
    const channelA = '00000000-0000-7000-8000-000000000663';
    const channelB = '00000000-0000-7000-8000-000000000664';
    const parent = recoveryBoot({ spaceIds: [channelA, channelB] });
    let finish!: () => void;
    api.resolveConversation.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
    }, undefined, false, `/channels/${channelA}/threads/${workstreamId}`);
    await titleMenu('Thread menu: Recovered channel', 'Resolve Thread');
    const destination = change === 'unmount' ? '/settings' : `/channels/${channelB}/threads/${workstreamId}`;
    await act(async () => { await navigateInTest(destination); });
    await act(async () => { finish(); });
    expect(locationInTest.pathname).toBe(destination);
    if (change === 'channel change') {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Thread menu: Recovered channel' }), { button: 0, ctrlKey: false });
      expect(await screen.findByRole('menuitem', { name: 'Resolve Thread' })).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  it.each(['member', 'guest'])('keeps a child-only %s on the resolved non-first Breakout', async (accessClass) => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const firstId = '00000000-0000-7000-8000-000000000659';
    session.current = { user: { id: 'viewer', name: 'Viewer' }, workspace: { id: 'workspace', accessClass } };
    const child = recoveryBoot({ title: 'Private child' });
    api.resolveConversation.mockResolvedValue(undefined);
    renderScreen((cache) => {
      cache.setQueryData(['shared-navigation', undefined], { spaces: [], workstreams: [{ parentId: workstreamId,
        title: 'Parent', scope: 'personal', conversations: [firstId, childId].map((substreamId) => ({
          substreamId, title: 'Private child', scope: 'personal', archived: false,
        })),
      }] });
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    await titleMenu('Breakout menu: Private child', 'Resolve Breakout');
    await waitFor(() => expect(api.resolveConversation).toHaveBeenCalledWith(workstreamId, childId));
    expect(locationInTest.search).toBe(`?substream=${childId}`);
  });

  it('offers Resolve Thread to an admitted guest', async () => {
    session.current = { user: { id: 'viewer', name: 'Viewer' }, workspace: { id: 'workspace', accessClass: 'guest' } };
    const parent = recoveryBoot();
    api.resolveConversation.mockResolvedValue(undefined);
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
    });
    await titleMenu('Thread menu: Recovered channel', 'Resolve Thread');
    await waitFor(() => expect(api.resolveConversation).toHaveBeenCalledWith(workstreamId, '0'));
  });

  it.each(['0', '00000000-0000-7000-8000-000000000660'])('hides Resolve for archived conversation %s', async (childId) => {
    const parent = recoveryBoot(childId === '0' ? { archivedAt: '2026-10-20T00:00:00Z' } : {});
    const child = recoveryBoot({ title: 'Private child', archivedAt: '2026-10-20T00:00:00Z' });
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    fireEvent.pointerDown(await screen.findByRole('button', { name: childId === '0' ? 'Thread menu: Recovered channel' : 'Breakout menu: Private child' }), { button: 0, ctrlKey: false });
    await screen.findByRole('menuitem', { name: /^People/u });
    expect(screen.queryByRole('menuitem', { name: /^Resolve /u })).toBeNull();
  });

  it.each([
    [409, 'substream_archived', 'Restore this conversation before resolving it.'],
    [403, 'conversation_participant_required', 'You no longer have access to resolve this conversation.'],
    [404, 'substream_not_found', 'This conversation is no longer available.'],
  ] as const)('explains resolution refusal %s', async (status, code, message) => {
    const parent = recoveryBoot();
    api.resolveConversation.mockRejectedValue(new ApiError('server refusal', status, code));
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
    });
    await titleMenu('Thread menu: Recovered channel', 'Resolve Thread');
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(locationInTest.pathname).toBe(`/workstreams/${workstreamId}`);
  });

  it('stays in the conversation when resolution fails', async () => {
    const parent = recoveryBoot({ spaceIds: ['00000000-0000-7000-8000-000000000663'] });
    api.resolveConversation.mockRejectedValue(new Error('offline'));
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
    });
    await titleMenu('Thread menu: Recovered channel', 'Resolve Thread');
    expect(await screen.findByText('The thread couldn’t be resolved. Try again.')).toBeInTheDocument();
    expect(locationInTest.pathname).toBe(`/workstreams/${workstreamId}`);
  });

  it('manages the selected breakout roster without changing parent participants', async () => {
    const childId = '00000000-0000-7000-8000-000000000660';
    const creator = { id: '00000000-0000-7000-8000-000000000661', name: 'Creator', email: 'creator@example.test', timezone: 'UTC' };
    const newcomer = { ...creator, id: '00000000-0000-7000-8000-000000000662', name: 'New member', email: 'new@example.test' };
    const parent = recoveryBoot({ participants: [creator, newcomer] });
    const child = recoveryBoot({ title: 'Private child', participants: [creator] });
    api.getWorkspaceMembers.mockResolvedValue([creator, newcomer]);
    api.addSubstreamParticipant.mockResolvedValue(undefined);
    api.removeSubstreamParticipant.mockResolvedValue(undefined);
    const client = renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Breakout menu: Private child' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: /^People\s*1/u })).toBeInTheDocument();
    // Typing a known address and pressing Enter adds them, and the level stays open.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });
    fireEvent.change(search, { target: { value: newcomer.email } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(api.addSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id));
    expect(await screen.findByRole('button', { name: 'New member actions' })).toBeVisible();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'New member actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from breakout' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.removeSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id));
    expect(client.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.participants).toEqual([creator, newcomer]);
    expect(api.addParticipant).not.toHaveBeenCalled();
    expect(api.removeParticipant).not.toHaveBeenCalled();
  });

  it('removes someone from a breakout through its People dots menu only once confirmed', async () => {
    const childId = '00000000-0000-7000-8000-000000000665';
    const creator = { id: '00000000-0000-7000-8000-000000000661', name: 'Creator', email: 'creator@example.test', timezone: 'UTC' };
    const newcomer = { ...creator, id: '00000000-0000-7000-8000-000000000662', name: 'New member' };
    const parent = recoveryBoot({ participants: [creator, newcomer] });
    const child = recoveryBoot({ title: 'Private child', participants: [creator, newcomer] });
    api.getWorkspaceMembers.mockResolvedValue([creator, newcomer]);
    api.removeSubstreamParticipant.mockResolvedValue(undefined);
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['ordered-transcript', workstreamId], parent.transcript);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);

    const openRemove = async (): Promise<void> => {
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Breakout menu: Private child' }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'New member actions' }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from breakout' }));
    };

    await openRemove();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.removeSubstreamParticipant).not.toHaveBeenCalled();

    await openRemove();
    expect(await screen.findByRole('dialog', { name: 'Remove New member from the breakout?' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.removeSubstreamParticipant).toHaveBeenCalledWith(workstreamId, childId, newcomer.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    retainedSocket.mockReturnValue({ state: 'connected', workspaceSocketState: 'connected', suggestions: [], sendReady: true, createMessage, requestSnapshot: vi.fn() });
    api.getWorkspaceMembers.mockResolvedValue([creator, newcomer]);
    if (refused) api.addSubstreamParticipant.mockRejectedValue(new Error('Parent access required'));
    else api.addSubstreamParticipant.mockResolvedValue(undefined);
    renderScreen((cache) => {
      cache.setQueryData(['workstream', workstreamId], parent);
      cache.setQueryData(['substream-workstream', workstreamId, childId], child);
      cache.setQueryData(['substream-ordered-transcript', workstreamId, childId], child.transcript);
    }, childId);
    const composer = await screen.findByRole('textbox', { name: /^Message the thread|^Reply in Private child/u });
    await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalled());
    fireEvent.change(composer, { target: { value: 'Please ask @New member to review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add and mention' }));
    if (refused) {
      expect(await screen.findByText('The message couldn’t be sent. Try again.')).toBeInTheDocument();
      expect(screen.queryByText('Parent access required')).not.toBeInTheDocument();
      expect(createMessage).not.toHaveBeenCalled();
      expect(composer).toHaveValue('Please ask @New member to review.');
    } else {
      await waitFor(() => expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ confirmedParticipantUserIds: [] })));
    }
  });

  it('admits the feed while the snapshot is pending without starting REST boot readers', async () => {
    renderScreen();

    const status = screen.getByRole('status', { name: 'Opening channel…' });
    expect(status).toBeVisible();
    expect(status).not.toHaveAttribute('aria-busy');
    // No Channel sidebar any more: the placeholder is the feed and its pill.
    expect(document.querySelector('.conversation-opening-sidebar')).toBeNull();
    expect(document.querySelectorAll('.conversation-opening-message')).toHaveLength(3);
    expect(document.querySelector('.conversation-opening-composer')).not.toBeNull();
    expect(document.querySelector('[data-testid="thinking-orb"]')).toBeNull();
    expect(document.querySelector('.conversation-opening-header .title-pill-skeleton')).not.toBeNull();
    await waitFor(() => expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true, 'workstream', '0'));
  });

  it('uses the Sidekick header geometry for a Sidekick conversation wait', () => {
    render(<ConversationOpeningSkeleton label="Opening Sidekick…" parentKind="automation" />);

    expect(document.querySelector('.conversation-opening-feed')).toHaveClass('automation-screen');
    expect(document.querySelector('.conversation-opening-header')).toHaveClass('sidekick-conversation-heading', 'window-drag');
    expect(document.querySelector('.conversation-opening-sidebar')).toBeNull();
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
      suggestions: [],
    });

    renderScreen();

    await waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));
  });

  it('does not run payload effects until detail and transcript both belong to the route', async () => {
    const staleWorkstreamId = '00000000-0000-7000-8000-000000000649';
    const staleBoot = recoveryBoot({ id: staleWorkstreamId, title: 'Stale channel' });
    const { transcript: staleTranscript, ...staleDetail } = staleBoot;
    const queryClient = renderScreen((client) => {
      client.setQueryData<WorkstreamDetail>(['workstream', workstreamId], staleDetail);
      client.setQueryData(['ordered-transcript', workstreamId], staleTranscript);
    });

    expect(screen.getByRole('status', { name: 'Opening channel…' })).toBeVisible();
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
    const stoppedRunId = '00000000-0000-7000-8000-000000000660';
    const run = (status: HarnessRunMetadata['status']): HarnessRunMetadata => ({
      id: stoppedRunId,
      origin: 'member',
      status,
      startedAt: '2026-08-26T14:00:00.000Z',
      ...(status === 'running' ? {} : { completedAt: '2026-08-26T14:00:10.000Z' }),
      createdAt: '2026-08-26T14:00:00.000Z',
    });

    function stoppingScreen(overrides: Partial<WorkstreamBoot> = {}): QueryClient {
      const boot = recoveryBoot({
        harnessStatus: 'running',
        stopRequested: true,
        latestHarnessRunId: stoppedRunId,
        latestHarnessRun: run('running'),
        ...overrides,
      });
      const { transcript, ...detail } = boot;
      return renderScreen((queryClient) => {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
        queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
      });
    }

    /** Exactly what `applyHarnessStatus` writes: the status, and nothing else. */
    function statusFrame(queryClient: QueryClient, harnessStatus: HarnessStatus): void {
      act(() => {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, harnessStatus, stopRequested: false } : current);
      });
    }

    /**
     * The canonical snapshot behind that frame, with the run row settled.
     *
     * `harnessStatus` is `completed` either way, including for a stop:
     * `settleWorkstreamState` leaves a stopped run's work stream `idle`, and
     * this client reads `idle` as `completed`. A fixture that says `stopped`
     * here would be testing a payload the server does not send.
     */
    function settle(queryClient: QueryClient, runStatus: 'stopped' | 'completed'): void {
      const { transcript, ...detail } = recoveryBoot({
        harnessStatus: 'completed',
        stopRequested: false,
        latestHarnessRunId: stoppedRunId,
        latestHarnessRun: run(runStatus),
      });
      act(() => {
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

    // The same argument as the block comment above, one phase later: the
    // transition function and the indicator are each covered on their own, and
    // both stayed green through a version of this change whose arming cleared
    // itself before the settlement arrived — so the row never appeared at all,
    // and only a running client said so. This is the join.
    it('holds one region from the request through to the settled line', async () => {
      const queryClient = stoppingScreen();
      await act(async () => Promise.resolve());
      const region = screen.getByRole('status', { name: STOPPING_LABEL });
      expect(region.closest('.composer-dock')).not.toBeNull();
      expect(region.closest('.transcript-scroll')).toBeNull();

      // The status frame as a member stop actually sends it. It says
      // `completed`, not `stopped`, because a stop leaves the work stream
      // `idle` and this client reads `idle` as `completed` — so at this point
      // nothing on the client knows yet whether the run stopped or simply
      // finished. The dock used to go blank here, which is both a gap in the
      // answer and an unmount of the live region that carries it.
      statusFrame(queryClient, 'completed');
      await act(async () => Promise.resolve());
      expect(screen.getByRole('status', { name: STOPPING_LABEL })).toBe(region);

      // The snapshot behind it carries the run row, which is what says it was
      // a stop. Same node, new content: a live region inserted together with
      // its content is not reliably announced, and this row's reader is the
      // one who cannot see the dock.
      settle(queryClient, 'stopped');
      const settled = await screen.findByRole('status', { name: STOPPED_LABEL });
      expect(settled).toBe(region);
      expect(settled).toBeVisible();
      expect(screen.queryByRole('status', { name: STOPPING_LABEL })).not.toBeInTheDocument();
    });

    // The bug this whole change exists for is the notice outliving the stop
    // under later messages. The transition cannot express that half: a turn the
    // addressing classifier reads as human-only leaves every one of its inputs
    // unchanged, so only a rendered send shows it.
    it.each([
      ['accepted', true],
      ['rejected', false],
    ] as const)('clears on the next message this reader sends, when it is %s', async (_name, accepted) => {
      const createMessage = accepted
        ? vi.fn(async () => ({
          turnId: 'turn', clientMessageId: 'message',
          createdAt: '2026-08-26T14:01:00.000Z', deliveryState: 'queued',
        }))
        : vi.fn(async () => { throw new Error('send refused'); });
      retainedSocket.mockReturnValue({
        suggestions: [],
        activeCompaction: null, activeInferenceDelays: [], createMessage,
        requestSnapshot: vi.fn(), retryOpening: vi.fn(),
        sendReady: true, state: 'connected', workspaceSocketState: 'connected',
      });
      const queryClient = stoppingScreen();
      await act(async () => Promise.resolve());
      statusFrame(queryClient, 'completed');
      settle(queryClient, 'stopped');
      await screen.findByRole('status', { name: STOPPED_LABEL });

      const composer = await screen.findByRole('textbox', { name: /^Message /u });
      fireEvent.change(composer, { target: { value: 'thanks, picking this up tomorrow' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(createMessage).toHaveBeenCalled());

      if (accepted) {
        await waitFor(() => expect(screen.queryByRole('status', { name: STOPPED_LABEL })).not.toBeInTheDocument());
      } else {
        // The draft comes back and the conversation did not move on, so the
        // acknowledgement has to survive — and nothing could put it back, the
        // run being durably stopped by now.
        await screen.findByText('The message couldn’t be sent. Try again.');
        expect(screen.getByRole('status', { name: STOPPED_LABEL })).toBeVisible();
      }
    });

    it('says nothing to a reader who opens a conversation already stopped', async () => {
      // The run row is durable and the acknowledgement is not. Somebody who
      // was not in the room when the stop landed has no button press to have
      // been answered, and before this change they were shown one under every
      // later message in the transcript.
      const { transcript, ...detail } = recoveryBoot({
        harnessStatus: 'stopped',
        latestHarnessRunId: stoppedRunId,
        latestHarnessRun: run('stopped'),
      });
      renderScreen((queryClient) => {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
        queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
      });
      await act(async () => Promise.resolve());

      expect(screen.queryByRole('status', { name: STOPPED_LABEL })).not.toBeInTheDocument();
    });

    it('keeps a run that finished before the stop landed out of the dock', async () => {
      const queryClient = stoppingScreen();
      await act(async () => Promise.resolve());

      // Same ambiguous frame, and the run row behind it says the other thing:
      // the response finished before the stop reached a boundary, so there is
      // no stop to acknowledge and the region goes rather than settling.
      statusFrame(queryClient, 'completed');
      settle(queryClient, 'completed');

      await waitFor(() => expect(screen.queryByRole('status', { name: STOPPING_LABEL })).not.toBeInTheDocument());
      expect(screen.queryByRole('status', { name: STOPPED_LABEL })).not.toBeInTheDocument();
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
      suggestions: [],
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

  it.each(['channel route', 'standalone route'] as const)('ranks People using the %s rather than the first Thread placement', async (route) => {
    const firstChannel = '00000000-0000-7000-8000-000000000673';
    const currentChannel = '00000000-0000-7000-8000-000000000674';
    session.current = {
      user: { id: '00000000-0000-7000-8000-000000000671', name: 'Creator', email: 'creator@example.test' },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    const detail = recoveryBoot({ spaceIds: [firstChannel, currentChannel] });
    const pane: ChannelPaneContext | null = route === 'channel route' ? {
      channelId: currentChannel, crumb: { key: currentChannel, title: 'Current Channel', icon: null, label: 'Channel menu' },
      shifted: false, expanded: false, setExpanded: vi.fn(), setThreadUsesTwoPanes: vi.fn(),
    } : null;
    renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], detail.transcript);
    }, undefined, false, pane ? `/channels/${currentChannel}/threads/${workstreamId}` : `/workstreams/${workstreamId}`, pane);
    await titleMenu('Thread menu: Recovered channel', 'Add people');
    await waitFor(() => expect(api.getPeopleRanking).toHaveBeenCalledWith(pane ? currentChannel : null, expect.anything()));
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

    await titleMenu('Thread menu: Recovered channel', 'Add people');
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jordan' }));
    expect(await screen.findByText('That person couldn’t be added.')).toBeInTheDocument();
    expect(screen.queryByText('Adam cannot add Jordan')).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Katherine actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from thread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('That participant couldn’t be removed.')).toBeInTheDocument();
    expect(screen.queryByText('Adam cannot remove Katherine')).not.toBeInTheDocument();
    expect(screen.queryByText('That person couldn’t be added.')).not.toBeInTheDocument();
  });

  it('keeps the People level open after an add so another person can be added', async () => {
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

    await titleMenu('Thread menu: Recovered channel', 'Add people');
    fireEvent.click(await screen.findByRole('button', { name: 'Add Katherine' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, katherine.id));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jordan' }));
    await waitFor(() => expect(api.addParticipant).toHaveBeenCalledWith(workstreamId, jordan.id));
    expect(api.addParticipant).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Thread menu: Recovered channel, People' })).toBeInTheDocument();
  });

  it('leaves an organization-scoped room from the People level once confirmed', async () => {
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
    session.current = {
      user: { id: adam.id, name: adam.name, email: adam.email },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    const detail = recoveryBoot({ participants: [adam, katherine], scope: 'workspace' });
    api.getWorkspaceMembers.mockResolvedValue([adam, katherine]);
    api.removeParticipant.mockResolvedValue(undefined);
    const client = renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], detail.transcript);
    });

    await titleMenu('Thread menu: Recovered channel', 'Add people');
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Adam actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the thread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.removeParticipant).toHaveBeenCalledWith(workstreamId, adam.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(client.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.participants).toEqual([katherine]);
  });

  it('lands in the Channel’s Space after leaving a personal room whose socket closed first', async () => {
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
    session.current = {
      user: { id: adam.id, name: adam.name, email: adam.email },
      workspace: { id: '00000000-0000-7000-8000-000000000672', region: 'global', role: 'member' },
    };
    const detail = recoveryBoot({ participants: [adam, katherine], scope: 'personal' });
    api.getWorkspaceMembers.mockResolvedValue([adam, katherine]);
    // The server closes the reader's socket before it answers the DELETE, and
    // that close evicts the cached detail.
    const rendered: { client?: QueryClient } = {};
    api.removeParticipant.mockImplementation(() => {
      rendered.client?.removeQueries({ queryKey: ['workstream', workstreamId] });
      return Promise.resolve(undefined);
    });
    rendered.client = renderScreen((queryClient) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
      queryClient.setQueryData(['ordered-transcript', workstreamId], detail.transcript);
    });

    await titleMenu('Thread menu: Recovered channel', 'Add people');
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Adam actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the thread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(locationInTest?.pathname).toBe('/'));
    expect(locationInTest?.state).toEqual({
      skipWorkstreamIds: [workstreamId],
      spaceId: '00000000-0000-7000-8000-000000000673',
    });
  });

  it('retries the authoritative socket after the first attempt fails', async () => {
    const retryOpening = vi.fn();
    retainedSocket.mockReturnValue({
      suggestions: [],
      activeCompaction: null, activeInferenceDelays: [],
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening,
      sendReady: false,
      state: 'reconnecting',
      workspaceSocketState: 'connecting',
    });
    renderScreen();

    expect(await screen.findByText('Thread could not be opened')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(retryOpening).toHaveBeenCalledTimes(1);
  });

  it('shows the terminal error after all three timed opening attempts expire', async () => {
    retainedSocket.mockReturnValue({
      suggestions: [],
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

    expect(await screen.findByText('Thread could not be opened')).toBeInTheDocument();
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
  });

  it('paints a remembered transcript with a connecting card and blocks sending until the live snapshot lands', async () => {
    const createMessage = vi.fn();
    const socket = {
      activeCompaction: null, activeInferenceDelays: [], createMessage, requestSnapshot: vi.fn(), retryOpening: vi.fn(),
      sendReady: true, state: 'connecting', workspaceSocketState: 'connecting', suggestions: [],
    };
    retainedSocket.mockReturnValue(socket);
    const boot = recoveryBoot({ title: 'Remembered channel' });
    const { transcript, ...detail } = boot;
    const cache = renderScreen((client) => {
      client.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'local_cache');
      client.setQueryData(['workstream', workstreamId], detail);
      client.setQueryData(['ordered-transcript', workstreamId], transcript);
    });

    // The screen is not "Opening": the remembered conversation is on it.
    expect(screen.queryByText('Opening channel…')).not.toBeInTheDocument();
    expect(document.querySelector('.connecting-card')?.textContent ?? '').toContain('Connecting to Remembered channel…');
    const composer = screen.getByLabelText('Message Remembered channel');
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
      cache.setQueryData(['workstream', workstreamId], { ...detail, title: 'Live channel' });
    });

    await waitFor(() => expect(document.querySelector('.connecting-card')).toBeNull());
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(composer).toHaveValue('Typed while connecting');
  });

  it('keeps the remembered transcript and offers a retry on the card when the cached open times out', async () => {
    const retryOpening = vi.fn();
    retainedSocket.mockReturnValue({
      suggestions: [],
      activeCompaction: null, activeInferenceDelays: [], createMessage: vi.fn(), requestSnapshot: vi.fn(), retryOpening,
      openingError: 'The live connection timed out after 3 attempts.',
      sendReady: false, state: 'unavailable', workspaceSocketState: 'connecting',
    });
    const boot = recoveryBoot({ title: 'Remembered channel' });
    const { transcript, ...detail } = boot;
    renderScreen((client) => {
      client.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'local_cache');
      client.setQueryData(['workstream', workstreamId], detail);
      client.setQueryData(['ordered-transcript', workstreamId], transcript);
    });

    expect(screen.queryByText('Thread could not be opened')).not.toBeInTheDocument();
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryOpening).toHaveBeenCalledTimes(1);
  });

});
