import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
  getAttachedSidekicks: vi.fn(),
  getRecommendedSidekicks: vi.fn(),
  getSidekickRecommendationOptions: vi.fn(),
  setRecommendedSidekick: vi.fn(),
  getWorkstreamSidekicks: vi.fn(),
  removeAttachedSidekick: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());
const currentSession = vi.hoisted(() => vi.fn());

vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api, session: currentSession() }),
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
import { workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import type { WorkstreamBoot, WorkstreamDetail } from '../lib/types';

const workstreamId = '00000000-0000-7000-8000-000000000901';
const childId = '00000000-0000-7000-8000-000000000902';

function boot(participant = false): WorkstreamBoot {
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
    participants: participant ? [{ id: 'person', name: 'Person', email: 'person@example.com', role: 'member', timezone: 'UTC' }] : [],
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

function renderScreen(participant = false): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const { transcript, ...detail } = boot(participant);
  queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
  queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
  queryClient.setQueryData(workstreamDetailQueryKey(workstreamId, childId), detail);
  queryClient.setQueryData(orderedTranscriptQueryKey(workstreamId, childId), transcript);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${workstreamId}`]}>
          <Link to={`/workstreams/${workstreamId}?substream=${childId}`}>Switch child</Link>
          <Link to={`/workstreams/${workstreamId}`}>Switch main</Link>
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
    currentSession.mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockResolvedValue([]);
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: false, items: [] });
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

  it('does not carry a removal error into another substream', async () => {
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.removeAttachedSidekick.mockRejectedValue(new Error('Removal failed in main.'));
    renderScreen(true);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Editorial guidance' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from this substream' }));
    expect(await screen.findByText('That Sidekick couldn’t be removed.')).toBeVisible();
    expect(screen.queryByText('Removal failed in main.')).not.toBeInTheDocument();
    expect(api.removeAttachedSidekick).toHaveBeenCalledWith(workstreamId, 'attached-1', '0');
    fireEvent.click(screen.getByRole('link', { name: 'Switch child' }));
    expect(await screen.findByRole('button', { name: 'Editorial guidance' })).toBeVisible();
    expect(screen.queryByText('That Sidekick couldn’t be removed.')).not.toBeInTheDocument();
  });

  it('keeps an in-flight removal observable when Sidekick management is reopened', async () => {
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    const diagnostic = 'provider removal failed after management reopened';
    let rejectRemoval!: (reason: Error) => void;
    api.removeAttachedSidekick.mockReturnValue(new Promise((_resolve, reject) => { rejectRemoval = reject; }));
    renderScreen(true);

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Editorial guidance' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from this substream' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Editorial guidance' }));
    await act(async () => { rejectRemoval(new Error(diagnostic)); });

    expect(await screen.findByText('That Sidekick couldn’t be removed.')).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    expect(api.removeAttachedSidekick).toHaveBeenCalledTimes(1);
  });

  it.each([
    { attached: false, action: 'Recommend for this work stream', expected: 'That Sidekick couldn’t be recommended.' },
    { attached: true, action: 'Remove work stream recommendation', expected: 'That Sidekick recommendation couldn’t be removed.' },
  ])('reports a rejected $action as that action', async ({ attached, action, expected }) => {
    const diagnostic = `provider rejected recommendation attached=${attached}`;
    const recommendation = { id: 'attached-1', name: 'Editorial guidance', description: 'Write clearly.', available: true };
    api.getRecommendedSidekicks.mockResolvedValue(attached ? [recommendation] : []);
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: true, items: [{ ...recommendation, attached }] });
    api.setRecommendedSidekick.mockRejectedValue(new Error(diagnostic));
    renderScreen();

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Editorial guidance' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: action }));

    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    expect(api.setRecommendedSidekick).toHaveBeenCalledWith(workstreamId, 'attached-1', !attached, '0');
  });

  it('keeps recommendations shared and loaded rows local when switching substreams', async () => {
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockResolvedValue([{ id: 'shared', name: 'Shared guide', description: '', available: true }]);
    api.getAttachedSidekicks.mockImplementation((_id, _signal, substreamId) => Promise.resolve([
      { id: substreamId === childId ? 'child-local' : 'main-local', name: substreamId === childId ? 'Child guide' : 'Main guide', description: '', available: true },
    ]));
    renderScreen();
    expect(await screen.findByRole('button', { name: 'Main guide' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Shared guide' })).toHaveAttribute('aria-description', 'Recommended Sidekick');
    fireEvent.click(screen.getByRole('link', { name: 'Switch child' }));
    expect(await screen.findByRole('button', { name: 'Child guide' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Main guide' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shared guide' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Switch main' }));
    expect(await screen.findByRole('button', { name: 'Main guide' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Child guide' })).not.toBeInTheDocument();
  });

  it('checks recommendation eligibility for the selected child instead of reusing Main metadata', async () => {
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockImplementation((_id, _signal, substreamId) => Promise.resolve([
      { id: 'recommended', name: substreamId === childId ? 'Child recommendation' : 'Main recommendation', description: '', available: true },
    ]));
    renderScreen();
    expect(await screen.findByRole('button', { name: 'Main recommendation' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Switch child' }));
    expect(await screen.findByRole('button', { name: 'Child recommendation' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Main recommendation' })).not.toBeInTheDocument();
    expect(api.getRecommendedSidekicks).toHaveBeenCalledWith(workstreamId, expect.any(AbortSignal), childId);
  });

  it('uses scoped summaries for guests without opening the member authoring directory', async () => {
    currentSession.mockReturnValue({ user: { id: 'guest', name: 'Guest', email: 'guest@example.test' },
      workspace: { id: 'workspace', accessClass: 'guest', role: null } });
    api.getRecommendedSidekicks.mockResolvedValue([{ id: 'owned', name: 'Owned guide', description: '', available: true }]);
    renderScreen();
    expect(await screen.findByRole('button', { name: 'Owned guide' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Editorial guidance' })).toBeVisible();
    expect(api.getWorkstreamSidekicks).not.toHaveBeenCalled();
  });

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

    expect(await screen.findByText('Some Sidekick information may be out of date.')).toBeVisible();
    expect(screen.queryByText('The service is unavailable.')).not.toBeInTheDocument();
    // And the half that did answer stays on screen under it.
    expect(screen.getByRole('button', { name: 'Editorial guidance' })).toBeVisible();
  });

  it('keeps a management-options failure in the picker rather than misreporting the list', async () => {
    const diagnostic = 'INTERNAL ROUTER RESPONSE: requested API route does not exist';
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getAttachedSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockResolvedValue([]);
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getSidekickRecommendationOptions.mockRejectedValue(new Error(diagnostic));
    renderScreen(true);

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('Sidekick options couldn’t be loaded.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sidekicks couldn’t be loaded.')).not.toBeInTheDocument();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });
});
