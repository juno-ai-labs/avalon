import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
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

vi.mock('../lib/collaboration-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationSessionModule>();
  return {
    useOptionalCollaborationSession: () => null,
    useCollaborationSession: () => ({ api, session: currentSession() }),
    useShellCapabilities: () => actual.shellCapabilities({ host: 'desktop', session: currentSession() }),
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
import { ApiError } from '../lib/api';
import { useUiStore } from '../lib/ui-store';
import { workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import type { WorkstreamAutomationSummary, WorkstreamBoot, WorkstreamDetail } from '../lib/types';
import type * as CollaborationSessionModule from '../lib/collaboration-session';

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
    spaceIds: [],
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

function renderScreenWithRail(rail: Record<string, unknown>): QueryClient {
  return renderScreen(false, undefined, rail);
}

function renderScreen(participant = false, cachedOwnedSidekicks?: WorkstreamAutomationSummary[], rail?: Record<string, unknown>): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const { transcript, ...detail } = boot(participant);
  queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail);
  queryClient.setQueryData(['ordered-transcript', workstreamId], transcript);
  queryClient.setQueryData(workstreamDetailQueryKey(workstreamId, childId), detail);
  queryClient.setQueryData(orderedTranscriptQueryKey(workstreamId, childId), transcript);
  if (cachedOwnedSidekicks) queryClient.setQueryData(['workstream-sidekicks', workstreamId], cachedOwnedSidekicks);
  if (rail) queryClient.setQueryData(['channel-rail', workstreamId], { railWaterline: 1, rail });
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
  return queryClient;
}

/**
 * The Channel's Sidekicks live in their own level of its title pill's menu,
 * opened from the root's Sidekicks row. Their rows are found by name rather
 * than as buttons: the desktop menu draws them without an open action, so they
 * are not buttons there.
 */
async function openChannelMenu(): Promise<void> {
  await openSidekicksIn('Thread menu: Investigate ENG-142');
}

/** The open Breakout's pill, beside Main's; its child detail carries the same title. */
async function openBreakoutMenu(): Promise<void> {
  await openSidekicksIn('Breakout menu: Investigate ENG-142');
}

async function openSidekicksIn(pill: string): Promise<void> {
  fireEvent.pointerDown(await screen.findByRole('button', { name: pill }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitem', { name: /^Sidekicks/u }));
}

/** Closes the open pane menu from its own pill, which toggles it whatever level it is on. */
async function closeMenu(pill: 'Thread' | 'Breakout'): Promise<void> {
  fireEvent.pointerDown(screen.getByRole('button', { name: new RegExp(`^${pill} menu: `, 'u') }), { button: 0, ctrlKey: false });
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

/** Opens the Breakout beside Main, as the split layout mounts both panes. */
async function openBreakoutBesideMain(): Promise<void> {
  fireEvent.click(screen.getByRole('link', { name: 'Switch child' }));
  expect(await screen.findByRole('button', { name: 'Breakout menu: Investigate ENG-142' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Thread menu: Investigate ENG-142' })).toBeVisible();
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
describe('a channel\u2019s own Sidekicks when the viewer may not list them', () => {
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
      suggestions: [],
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps an in-flight removal observable when Sidekick management is reopened', async () => {
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    const diagnostic = 'provider removal failed after management reopened';
    let rejectRemoval!: (reason: Error) => void;
    api.removeAttachedSidekick.mockReturnValue(new Promise((_resolve, reject) => { rejectRemoval = reject; }));
    renderScreen(true);
    await openChannelMenu();

    fireEvent.contextMenu(await screen.findByLabelText('Editorial guidance'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from this breakout' }));
    fireEvent.contextMenu(screen.getByLabelText('Editorial guidance'));
    await act(async () => { rejectRemoval(new Error(diagnostic)); });

    expect(await screen.findByText('That Sidekick couldn’t be removed.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    expect(api.removeAttachedSidekick).toHaveBeenCalledTimes(1);
  });

  it('removes a Sidekick from the Breakout only, and keeps its failure out of Main beside it', async () => {
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.removeAttachedSidekick.mockRejectedValue(new Error('Removal failed in the breakout.'));
    renderScreen(true);
    await openBreakoutBesideMain();

    await openBreakoutMenu();
    fireEvent.contextMenu(await screen.findByLabelText('Editorial guidance'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from this breakout' }));
    expect(await screen.findByText('That Sidekick couldn’t be removed.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText('Removal failed in the breakout.')).not.toBeInTheDocument();
    expect(api.removeAttachedSidekick).toHaveBeenCalledTimes(1);
    expect(api.removeAttachedSidekick).toHaveBeenCalledWith(workstreamId, 'attached-1', childId);
    await closeMenu('Breakout');

    await openChannelMenu();
    expect(await screen.findByLabelText('Editorial guidance')).toBeVisible();
    expect(screen.queryByText('That Sidekick couldn’t be removed.')).not.toBeInTheDocument();
  });

  it('lists each pane’s own loaded Sidekicks and the Channel’s shared recommendations with a Breakout beside Main', async () => {
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockResolvedValue([{ id: 'shared', name: 'Shared guide', description: '', available: true }]);
    api.getAttachedSidekicks.mockImplementation((_id, _signal, substreamId) => Promise.resolve([
      { id: substreamId === childId ? 'child-local' : 'main-local', name: substreamId === childId ? 'Child guide' : 'Main guide', description: '', available: true },
    ]));
    renderScreen();
    await openBreakoutBesideMain();

    await openChannelMenu();
    expect(await screen.findByLabelText('Main guide')).toBeVisible();
    expect(screen.getByLabelText('Shared guide')).toHaveAttribute('aria-description', 'Recommended Sidekick');
    expect(screen.queryByLabelText('Child guide')).not.toBeInTheDocument();
    await closeMenu('Thread');

    await openBreakoutMenu();
    expect(await screen.findByLabelText('Child guide')).toBeVisible();
    expect(screen.getByLabelText('Shared guide')).toHaveAttribute('aria-description', 'Recommended Sidekick');
    expect(screen.queryByLabelText('Main guide')).not.toBeInTheDocument();
  });

  it('reads the Breakout’s recommendations for the Breakout rather than reusing Main’s', async () => {
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getAttachedSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockImplementation((_id, _signal, substreamId) => Promise.resolve([
      { id: 'recommended', name: substreamId === childId ? 'Child recommendation' : 'Main recommendation', description: '', available: true },
    ]));
    renderScreen();
    await openBreakoutBesideMain();

    await openBreakoutMenu();
    expect(await screen.findByLabelText('Child recommendation')).toBeVisible();
    expect(screen.queryByLabelText('Main recommendation')).not.toBeInTheDocument();
    await closeMenu('Breakout');

    await openChannelMenu();
    expect(await screen.findByLabelText('Main recommendation')).toBeVisible();
    expect(screen.queryByLabelText('Child recommendation')).not.toBeInTheDocument();
    expect(api.getRecommendedSidekicks).toHaveBeenCalledWith(workstreamId, expect.any(AbortSignal), childId);
  });

  it.each([
    { attached: false, action: 'Recommend for this thread', expected: 'That Sidekick couldn’t be recommended.' },
    { attached: true, action: 'Remove thread recommendation', expected: 'That Sidekick recommendation couldn’t be removed.' },
  ])('reports a rejected $action as that action', async ({ attached, action, expected }) => {
    const diagnostic = `provider rejected recommendation attached=${attached}`;
    const recommendation = { id: 'attached-1', name: 'Editorial guidance', description: 'Write clearly.', available: true };
    api.getRecommendedSidekicks.mockResolvedValue(attached ? [recommendation] : []);
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: true, items: [{ ...recommendation, attached }] });
    api.setRecommendedSidekick.mockRejectedValue(new Error(diagnostic));
    renderScreen();
    await openChannelMenu();

    fireEvent.contextMenu(await screen.findByLabelText('Editorial guidance'));
    fireEvent.click(await screen.findByRole('menuitem', { name: action }));

    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
    expect(api.setRecommendedSidekick).toHaveBeenCalledWith(workstreamId, 'attached-1', !attached, '0');
  });

  it('takes Main\u2019s Sidekicks from the Channel rail without the REST reads', async () => {
    const rail = {
      workstreamId, railWaterline: 1, participantUserIds: [],
      sidekicks: {
        owned: [],
        recommended: [{ id: 'recommended-1', name: 'Rail guide', description: '', available: true }],
        attached: [{ id: 'attached-2', name: 'Rail attachment', description: '', available: true }],
      },
      resources: [],
    };
    renderScreenWithRail(rail);
    await openChannelMenu();
    expect(await screen.findByLabelText('Rail guide')).toBeVisible();
    expect(screen.getByLabelText('Rail attachment')).toBeVisible();
    expect(api.getWorkstreamSidekicks).not.toHaveBeenCalled();
    expect(api.getRecommendedSidekicks).not.toHaveBeenCalled();
    expect(api.getAttachedSidekicks).not.toHaveBeenCalled();
  });

  it('reads only the attachments over REST while Main has not reported them to the rail', async () => {
    renderScreenWithRail({
      workstreamId, railWaterline: 1, participantUserIds: [],
      sidekicks: { owned: [], recommended: [{ id: 'recommended-1', name: 'Rail guide', description: '', available: true }] },
      resources: [],
    });
    await openChannelMenu();
    expect(await screen.findByLabelText('Editorial guidance')).toBeVisible();
    expect(screen.getByLabelText('Rail guide')).toBeVisible();
    expect(api.getAttachedSidekicks).toHaveBeenCalled();
    expect(api.getWorkstreamSidekicks).not.toHaveBeenCalled();
    expect(api.getRecommendedSidekicks).not.toHaveBeenCalled();
  });

  it('reads all three over REST when the rail was answered without data', async () => {
    const queryClient = renderScreen();
    await openChannelMenu();
    act(() => queryClient.setQueryData(['channel-rail', workstreamId], { railWaterline: 1, rail: null }));
    expect(await screen.findByLabelText('Editorial guidance')).toBeVisible();
    await waitFor(() => expect(api.getRecommendedSidekicks).toHaveBeenCalled());
    expect(api.getWorkstreamSidekicks).toHaveBeenCalled();
  });

  it('reads a breakout\u2019s Sidekicks over REST even with Main\u2019s rail held', async () => {
    renderScreenWithRail({
      workstreamId, railWaterline: 1, participantUserIds: [],
      sidekicks: { owned: [], recommended: [], attached: [] },
      resources: [],
    });
    fireEvent.click(screen.getByRole('link', { name: 'Switch child' }));
    await waitFor(() => expect(api.getAttachedSidekicks).toHaveBeenCalledWith(workstreamId, expect.anything(), childId));
    await waitFor(() => expect(api.getRecommendedSidekicks).toHaveBeenCalledWith(workstreamId, expect.anything(), childId));
  });

  it('uses scoped summaries for guests without opening the member authoring directory', async () => {
    currentSession.mockReturnValue({ user: { id: 'guest', name: 'Guest', email: 'guest@example.test' },
      workspace: { id: 'workspace', accessClass: 'guest', role: null } });
    api.getRecommendedSidekicks.mockResolvedValue([{ id: 'owned', name: 'Owned guide', description: '', available: true }]);
    renderScreen();
    await openChannelMenu();
    expect(await screen.findByLabelText('Owned guide')).toBeVisible();
    expect(screen.getByLabelText('Editorial guidance')).toBeVisible();
    expect(api.getWorkstreamSidekicks).not.toHaveBeenCalled();
  });

  it('reads a refusal as a room with none, and still lists what the conversation loaded', async () => {
    api.getWorkstreamSidekicks.mockRejectedValue(
      new ApiError('You cannot list this room\u2019s automations', 403, 'automation_directory_access_denied'),
    );
    renderScreen();
    await openChannelMenu();

    expect(await screen.findByLabelText('Editorial guidance')).toBeVisible();
    // The refusal is about the viewer, so it never reaches the rail as text.
    expect(screen.queryByText(/cannot list/u)).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers a refresh row for a failed room read without writing warning copy into the sidebar', async () => {
    api.getWorkstreamSidekicks.mockRejectedValue(new ApiError('The service is unavailable.', 500));
    renderScreen();
    await openChannelMenu();

    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(screen.queryByText('Some Sidekick information may be out of date.')).not.toBeInTheDocument();
    expect(screen.queryByText('The service is unavailable.')).not.toBeInTheDocument();
    // And the half that did answer stays on screen under it.
    expect(screen.getByLabelText('Editorial guidance')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await vi.waitFor(() => expect(api.getWorkstreamSidekicks).toHaveBeenCalledTimes(2));
  });

  it('keeps cached Sidekick rows when a refresh fails', async () => {
    api.getWorkstreamSidekicks.mockRejectedValue(new ApiError('The service is unavailable.', 500));
    renderScreen(false, [{
      id: 'owned', name: 'Owned guide', description: 'Keep this visible.', loadable: true,
      status: 'active', updatedAt: '2026-09-21T00:00:00.000Z',
    }]);
    await openChannelMenu();

    expect(await screen.findByLabelText('Owned guide')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(screen.getByLabelText('Owned guide')).toBeVisible();
    expect(screen.getByLabelText('Editorial guidance')).toBeVisible();
  });

  it('keeps a management-options failure in the picker rather than misreporting the list', async () => {
    const diagnostic = 'INTERNAL ROUTER RESPONSE: requested API route does not exist';
    currentSession.mockReturnValue({ user: { id: 'person', name: 'Person', email: 'person@example.com' }, workspace: null });
    api.getAttachedSidekicks.mockResolvedValue([]);
    api.getRecommendedSidekicks.mockResolvedValue([]);
    api.getWorkstreamSidekicks.mockResolvedValue([]);
    api.getSidekickRecommendationOptions.mockRejectedValue(new Error(diagnostic));
    renderScreen(true);
    await openChannelMenu();

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('Sidekick options couldn’t be loaded.')).toBeVisible();
    expect(screen.queryByText('Sidekicks couldn’t be loaded.')).not.toBeInTheDocument();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });
});
