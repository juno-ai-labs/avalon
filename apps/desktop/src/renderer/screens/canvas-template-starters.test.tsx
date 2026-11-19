import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkstreamBoot } from '../lib/types';
import type * as UseWorkstreamSocketModule from '../lib/use-workstream-socket';

/*
 * An empty Canvas's templates as a person uses them: the real conversation
 * surface and composer with the Canvas's starters under it, down to the
 * conversation socket's `createMessage`. Only the socket and the REST reads
 * are doubles.
 */

const CANVAS = '00000000-0000-7000-8000-000000000c61';

const api = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ id: 'w', name: 'Team', region: 'global', timezone: 'UTC', modelSelectorVisible: false, currentUser: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC' } })),
  getWorkspaceMembers: vi.fn(async () => []),
  getConnections: vi.fn(async () => []),
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
}));
const createMessage = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api, session: { user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test' }, workspace: { id: 'w', region: 'global', role: 'member' } } }),
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));
vi.mock('../lib/use-client-feature-flags', () => ({ useClientFeatureFlags: () => ({ data: {} }) }));
vi.mock('../lib/use-workstream-socket', async (importOriginal) => ({
  ...await importOriginal<typeof UseWorkstreamSocketModule>(),
  useWorkstreamSocket: () => ({
    activeCompaction: null, activeInferenceDelays: [], createMessage,
    requestSnapshot: vi.fn(), retryOpening: vi.fn(), loadTranscriptRange: vi.fn(async () => undefined),
    sendReady: true, state: 'connected', workspaceSocketState: 'connected',
  }),
}));
vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
  useOptionalWorkspaceSocket: () => null,
}));
vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(), attachments: [], consume: vi.fn(),
    leaseReady: vi.fn(async () => ({ leaseId: 'lease', attachments: [] })),
    commitLease: vi.fn(), restoreLease: vi.fn(), error: undefined, ready: [],
    removeAttachment: vi.fn(), retryAttachment: vi.fn(), uploading: false,
  }),
}));
vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true, isFollowing: () => true, onScroll: vi.fn(), onWheel: vi.fn(),
    release: vi.fn(), scrollTo: vi.fn(), scrollToEnd: vi.fn(),
  }),
}));

import { CanvasTemplateStarters } from '../components/canvas-template-picker';
import { ConversationSurface } from './conversation-surface';

function emptyCanvas(): WorkstreamBoot {
  return {
    id: CANVAS, title: 'Untitled Canvas', titleStatus: 'settled', harnessStatus: 'completed', scope: 'workspace',
    lastActivityAt: '2026-11-12T09:00:00.000Z', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
    nextPendingWakeup: null, pinPosition: null, spaceIds: [], participantUserIds: [], participantExtraCount: 0,
    createdAt: '2026-11-12T09:00:00.000Z', participants: [], viewers: [], resources: [], connections: [],
    backgroundTasks: [], openElicitations: [],
    transcript: {
      snapshotId: '00000000-0000-7000-8000-000000000c69', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-11-12T09:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread',
      ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    },
  } as WorkstreamBoot;
}

function renderCanvas(withStarters = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const conversation = emptyCanvas();
  queryClient.setQueryData(['workstream', CANVAS], conversation);
  queryClient.setQueryData(['ordered-transcript', CANVAS], conversation.transcript);
  render(<Tooltip.Provider><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[`/canvases/${CANVAS}`]}>
      <ConversationSurface
        parentId={CANVAS}
        parentKind="canvas"
        renderStarters={withStarters ? ({ send, disabled }) => <CanvasTemplateStarters disabled={disabled} onStart={send} /> : undefined}
        substreamId="0"
      />
    </MemoryRouter>
  </QueryClientProvider></Tooltip.Provider>);
}

describe("an empty Canvas's templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    createMessage.mockResolvedValue({ turnId: 'turn', clientMessageId: 'message', createdAt: '2026-11-12T09:01:00.000Z', deliveryState: 'queued' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens on Popular, one template from each group and naming who it is for, with every group in view', async () => {
    renderCanvas();
    const starters = await screen.findByRole('region', { name: 'Start from a template' });
    const groups = within(starters).getByRole('group', { name: 'Template group' });
    expect(within(groups).getAllByRole('button').map((button) => button.textContent))
      .toEqual([
        'Popular', 'Wholesalers', 'Agencies', 'Legal teams', 'Accountants', 'Recruiters', 'Brokers', 'Event planners',
        'Developers', 'Product managers', 'Parents',
      ]);
    expect(within(groups).getByRole('button', { name: 'Popular', pressed: true })).toBeInTheDocument();
    expect(within(starters).getAllByRole('listitem').map((card) => card.textContent)).toEqual([
      'Order boardTurn order emails into a board of what is new, quoted, confirmed and shipped.For wholesalers',
      'Client wallSee which clients are waiting on you, and for how long.For agencies',
      'Legal docketTrack every legal request by whose turn it is, and for how many days.For legal teams',
      'Client document checklistTick off the documents each client owes you as they arrive by email.For accountants',
      'Recruiting deskSee every intro between a candidate and a client, and whose reply it is waiting on.For recruiters',
      'Today’s follow-upsA list of who is waiting on you today, longest wait first.For brokers',
      'Event countdownOne page for an event: every vendor’s state and what is due before the date.For event planners',
      'PR dashboardSee open pull requests and highlight the ones that have gone stale.For developers',
      'Granola feature requestsCollect requests from customer interviews and let your team vote.For product managers',
      'School notifications and calendarTurn school email into a notification list and calendar.For parents',
    ]);

    fireEvent.click(within(groups).getByRole('button', { name: 'Parents' }));
    expect(within(starters).getAllByRole('button', { name: /calendar|grocery/u }).map((card) => card.querySelector('.canvas-template-title')?.textContent))
      .toEqual(['School notifications and calendar', 'Shared grocery list', 'Family calendar feed']);
  });

  it("sends a picked template's prompt as the Chat's first message, and puts the templates away", async () => {
    renderCanvas();
    const starters = await screen.findByRole('region', { name: 'Start from a template' });
    // Popular shows each group's first template; this one is its group's second.
    fireEvent.click(within(starters).getByRole('button', { name: 'Recruiters' }));
    fireEvent.click(within(starters).getByRole('button', { name: /^Recruiting market map/u }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(1));
    expect(createMessage.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/^Build a recruiting market map in this Canvas\. Ask me these two questions/u),
      mentions: [],
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Start from a template' })).toBeNull());
    expect(screen.queryByText('Ready to begin')).toBeNull();
  });

  it('offers none where the host gives none', async () => {
    renderCanvas(false);
    expect(await screen.findByText('Ready to begin')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start from a template' })).toBeNull();
  });
});
