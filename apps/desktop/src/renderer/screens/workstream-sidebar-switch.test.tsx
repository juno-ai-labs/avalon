import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
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
import { useUiStore } from '../lib/ui-store';
import type { WorkstreamBoot, WorkstreamDetail } from '../lib/types';

const firstWorkstreamId = '00000000-0000-7000-8000-000000000801';
const secondWorkstreamId = '00000000-0000-7000-8000-000000000802';

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
        Switch work stream
      </button>
    </>
  );
}

function renderScreen(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  seedWorkstream(queryClient, firstWorkstreamId, 'First work stream');
  seedWorkstream(queryClient, secondWorkstreamId, 'Second work stream');
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${firstWorkstreamId}`]}>
          <WorkstreamRouteControls />
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

function switchWorkstream(): void {
  // Route changes can arrive outside the modal (e.g. a native deep link).
  fireEvent.click(screen.getByRole('button', { name: 'Switch work stream', hidden: true }));
}


describe('the right sidebar does not follow a work-stream switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no layout; exercise the expanded sidebar's conversation link.
    // Compact mode deliberately omits that redundant navigation row.
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
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('closes the inspector rail, and drops the document it was showing', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Go to conversation: First work stream', current: 'page' });
    expect(screen.getByRole('complementary', { name: 'Work-stream sidebar' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: First work stream', current: 'page' }));
    expect(screen.getByRole('log')).toHaveFocus();

    act(() => { useUiStore.setState({ railOpen: true, inspector: { type: 'resource', id: 'resource-in-the-first-stream' } }); });

    switchWorkstream();

    await screen.findByRole('button', { name: 'Go to conversation: Second work stream', current: 'page' });
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('does not offer resource management before or after switching work streams', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Go to conversation: First work stream', current: 'page' });
    expect(screen.queryByRole('button', { name: 'Manage resources' })).toBeNull();
    act(() => switchWorkstream());
    await screen.findByRole('button', { name: 'Go to conversation: Second work stream', current: 'page' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage resources' })).toBeNull();
  });

  // A route switch must not run the rail's close animation over another work
  // stream's transcript, with the shell holding that stream's feed narrow for
  // as long as it lasted.
  it('keeps the retained inspector dormant even with stale open state and across a route switch', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Go to conversation: First work stream', current: 'page' });
    act(() => { useUiStore.setState({ railOpen: true, inspector: null }); });
    expect(document.querySelector('.rail-surface')).toBeNull();

    switchWorkstream();

    await screen.findByRole('button', { name: 'Go to conversation: Second work stream', current: 'page' });
    expect(document.querySelector('.rail-surface')).toBeNull();
    // What AppShell lays the feed out against, so a leaking value here reserves
    // the sidebar's width over a work stream that has no sidebar.
    expect(useUiStore.getState().railLeaving).toBe(false);
  });

});
