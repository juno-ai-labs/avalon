import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
const retainedSocket = vi.hoisted(() => vi.fn());

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
    scrollTo: vi.fn(),
    scrollToEnd: vi.fn(),
  }),
}));


import { WorkstreamScreen } from './workstream';
import { useUiStore } from '../lib/ui-store';
import type { WorkstreamBoot, WorkstreamDetail } from '../lib/types';
import type * as CollaborationSessionModule from '../lib/collaboration-session';
import type { ClientSession } from '@rally/contracts/client-session';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { asSubstreamId } from '@rally/contracts';
import { conversationDirectoryQueryKey } from '../lib/conversation-directory';
import { ChannelPaneContextValue, OPEN_EXPANDED, type ChannelPaneContext } from '../lib/navigation-routes';

const firstWorkstreamId = '00000000-0000-7000-8000-000000000801';
const secondWorkstreamId = '00000000-0000-7000-8000-000000000802';
const breakoutId = asSubstreamId('00000000-0000-7000-8000-000000000803');

function boot(id: string, title: string): WorkstreamBoot {
  return {
    id,
    title,
    titleStatus: 'settled',
    harnessStatus: 'completed',
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
    spaceIds: [],
    createdAt: '2026-08-26T14:00:00.000Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    transcript: {
      snapshotId: `snapshot-${id}`,
      snapshotThrough: 0,
      eventSequence: 0,
      snapshotAtUtc: '2026-08-26T14:00:00.000Z',
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

function seedWorkstream(queryClient: QueryClient, id: string, title: string): void {
  const { transcript, ...detail } = boot(id, title);
  queryClient.setQueryData<WorkstreamDetail>(['workstream', id], detail);
  queryClient.setQueryData(['ordered-transcript', id], transcript);
}

function WorkstreamRouteControls(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => void navigate(`/workstreams/${secondWorkstreamId}`)} type="button">
        Switch channel
      </button>
      <button onClick={() => void navigate(`/workstreams/${firstWorkstreamId}?substream=${breakoutId}`)} type="button">
        Reopen breakout
      </button>
    </>
  );
}

function renderScreen(child = false, directory?: SharedNavigationDirectory, channelPane: ChannelPaneContext | null = null, state: unknown = null, substreamId: string = breakoutId): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  if (directory) queryClient.setQueryData(conversationDirectoryQueryKey(undefined), directory);
  seedWorkstream(queryClient, firstWorkstreamId, 'First channel');
  seedWorkstream(queryClient, secondWorkstreamId, 'Second channel');
  if (child) {
    const { transcript, ...detail } = boot(firstWorkstreamId, 'Shared child');
    queryClient.setQueryData(['substream-workstream', firstWorkstreamId, substreamId], detail);
    queryClient.setQueryData(['substream-ordered-transcript', firstWorkstreamId, substreamId], transcript);
  }
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[{ pathname: `/workstreams/${firstWorkstreamId}`, search: child ? `?substream=${substreamId}` : '', state }]}>
          <WorkstreamRouteControls />
          <ChannelPaneContextValue.Provider value={channelPane}>
            <Routes>
              <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
            </Routes>
          </ChannelPaneContextValue.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

function switchWorkstream(): void {
  // Route changes can arrive outside the modal (e.g. a native deep link).
  fireEvent.click(screen.getByRole('button', { name: 'Switch channel', hidden: true }));
}


describe('the right sidebar does not follow a channel switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.current = null;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
      suggestions: [],
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('does not show or retain Main for somebody whose conversations leave it out', async () => {
    session.current = { user: { id: 'guest', email: 'guest@example.test' }, workspace: { id: 'workspace', region: 'global', accessClass: 'guest' } };
    renderScreen(true, {
      spaces: [],
      workstreams: [{
        parentId: firstWorkstreamId, title: 'First channel', scope: 'personal', archived: false,
        conversations: [{ substreamId: breakoutId, title: 'Shared child', scope: 'personal', archived: false }],
      }],
    });
    await screen.findByRole('button', { name: 'Breakout menu: Shared child' });
    expect(screen.queryByRole('button', { name: /^Channel menu:/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close breakout' })).not.toBeInTheDocument();
    expect(retainedSocket).toHaveBeenCalledWith(api, firstWorkstreamId, false, 'workstream', '0');
  });

  it('keeps the Thread rendered when a Breakout URL has a malformed ID', async () => {
    renderScreen(true, undefined, null, null, 'malformed');
    expect(await screen.findByRole('button', { name: 'Thread menu: First channel' })).toBeVisible();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('expands a breakout over its thread and puts it back', async () => {
    renderScreen(true);
    await screen.findByRole('button', { name: 'Breakout menu: Shared child' });
    // Each conversation on screen has its own composer.
    expect(screen.getAllByRole('textbox')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Breakout menu: Shared child' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('opens a breakout expanded over its thread when the sidebar opened it', async () => {
    renderScreen(true, undefined, null, OPEN_EXPANDED);
    await screen.findByRole('button', { name: 'Breakout menu: Shared child' });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('opens a breakout beside its thread again after it was closed while expanded', async () => {
    renderScreen(true);
    await screen.findByRole('button', { name: 'Breakout menu: Shared child' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close breakout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen breakout', hidden: true }));

    await screen.findByRole('button', { name: 'Breakout menu: Shared child' });
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('offers a thread beside its Channel Expand, and Collapse once expanded', async () => {
    const setExpanded = vi.fn();
    const pane = (expanded: boolean): ChannelPaneContext => ({
      channelId: 'channel',
      crumb: { key: 'channel', icon: null, title: 'Outbound', label: 'Open Outbound' },
      shifted: expanded,
      setThreadUsesTwoPanes: vi.fn(),
      expanded,
      setExpanded,
    });
    renderScreen(false, undefined, pane(false));
    await screen.findByRole('button', { name: 'Thread menu: First channel' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(setExpanded).toHaveBeenLastCalledWith(true);
    cleanup();

    renderScreen(false, undefined, pane(true));
    await screen.findByRole('button', { name: 'Thread menu: First channel' });
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(setExpanded).toHaveBeenLastCalledWith(false);
  });

  it('closes the inspector rail, and drops the document it was showing', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Thread menu: First channel' });

    act(() => { useUiStore.setState({ railOpen: true, inspector: { type: 'resource', id: 'resource-in-the-first-stream' } }); });

    switchWorkstream();

    await screen.findByRole('button', { name: 'Thread menu: Second channel' });
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('does not offer resource management before or after switching channels', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Thread menu: First channel' });
    expect(screen.queryByRole('button', { name: 'Manage resources' })).toBeNull();
    act(() => switchWorkstream());
    await screen.findByRole('button', { name: 'Thread menu: Second channel' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage resources' })).toBeNull();
  });

  // A route switch must not run the rail's close animation over another work
  // stream's transcript, with the shell holding that stream's feed narrow for
  // as long as it lasted.
  it('keeps the retained inspector dormant even with stale open state and across a route switch', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Thread menu: First channel' });
    act(() => { useUiStore.setState({ railOpen: true, inspector: null }); });
    expect(document.querySelector('.rail-surface')).toBeNull();

    switchWorkstream();

    await screen.findByRole('button', { name: 'Thread menu: Second channel' });
    expect(document.querySelector('.rail-surface')).toBeNull();
    // What AppShell lays the feed out against, so a leaking value here reserves
    // the sidebar's width over a work stream that has no sidebar.
    expect(useUiStore.getState().railLeaving).toBe(false);
  });

});
