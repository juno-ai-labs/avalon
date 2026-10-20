/**
 * The suggestion chip and the response card on the conversation surface
 * (docs/conversation-suggestions.md, docs/conversation-merge.md): where the
 * chip draws and for whom, how it ages out, what pressing it opens, and that
 * the composer never enters a merge mode. The snapshot is faked into the
 * query cache and the room socket is a double that hands the surface its
 * open suggestions.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
  dismissSuggestion: vi.fn(),
  mergeConversation: vi.fn(),
  mergeChannels: vi.fn(),
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
vi.mock('../lib/use-client-feature-flags', () => ({ useClientFeatureFlags: () => ({ data: {} }) }));
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
    addFiles: vi.fn(), attachments: [], consume: vi.fn(), error: undefined, ready: [],
    removeAttachment: vi.fn(), retryAttachment: vi.fn(), uploading: false,
  }),
}));
vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true, isFollowing: () => true, onScroll: vi.fn(), onWheel: vi.fn(), release: vi.fn(), scrollTo: vi.fn(), scrollToEnd: vi.fn(),
  }),
}));

import { WorkstreamScreen } from './workstream';
import { useUiStore } from '../lib/ui-store';
import { workstreamDraftKey } from '../lib/draft-keys';
import { readDraftText, clearAllDrafts } from '../lib/draft-cache';
import type { WorkstreamBoot, WorkstreamDetail } from '../lib/types';
import type * as CollaborationSessionModule from '../lib/collaboration-session';
import type { ClientSession } from '@rally/contracts/client-session';
import { asSpaceId, type ConversationSuggestion, type ConversationMergeChannels, type SpaceDirectory } from '@rally/contracts';

const threadId = '00000000-0000-7000-8000-000000000901';
const breakoutId = '00000000-0000-7000-8000-000000000902';
type Turn = WorkstreamBoot['transcript']['ranges'][number]['turns'][number];

function turn(sequence: number, actor: 'assistant' | 'human', text: string): Turn {
  return {
    transcriptSequence: sequence,
    turnId: `turn-${sequence}`,
    entryKind: 'conversation',
    actor,
    authorUserId: actor === 'human' ? 'member' : null,
    authorSnapshot: actor === 'human' ? { userId: 'member', displayName: 'Morgan', avatarUrl: null } : null,
    attentionOrdinal: sequence,
    createdAtUtc: `2026-10-18T10:00:0${sequence}.000Z`,
    revision: 1,
    blocks: [{ type: 'text', blockId: `turn-${sequence}:text:0`, blockIndex: 0, text, streaming: false, messageType: 'text' }],
    activityId: null,
  };
}

function boot(id: string, title: string, turns: Turn[]): WorkstreamBoot {
  const last = turns.length;
  return {
    id, title, titleStatus: 'settled', harnessStatus: 'completed', scope: 'personal',
    lastActivityAt: '2026-10-18T10:00:00.000Z', latestAttentionSequenceNumber: last, readThroughSequenceNumber: last,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
    nextPendingWakeup: null, pinPosition: null, participantUserIds: ['member'], participantExtraCount: 0, spaceIds: [],
    createdAt: '2026-10-18T10:00:00.000Z',
    participants: [{ id: 'member', name: 'Morgan', email: 'morgan@example.test', timezone: 'UTC' }],
    viewers: [], resources: [], connections: [], backgroundTasks: [], openElicitations: [],
    transcript: {
      snapshotId: `snapshot-${id}`, snapshotThrough: last, eventSequence: 0, snapshotAtUtc: '2026-10-18T10:00:00.000Z',
      unreadAnchorSequence: null, unreadReason: 'no_unread',
      ranges: turns.length ? [{
        purpose: 'latest',
        requested: { startInclusive: 1, endExclusive: last + 1 },
        covered: { startInclusive: 1, endExclusive: last + 1 },
        turns, activities: [], pluginRuns: [],
      }] : [],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    },
  };
}

function seed(queryClient: QueryClient, key: readonly unknown[], transcriptKey: readonly unknown[], value: WorkstreamBoot): void {
  const { transcript, ...detail } = value;
  queryClient.setQueryData<WorkstreamDetail>(key, detail);
  queryClient.setQueryData(transcriptKey, { ...transcript, snapshotId: `snapshot-${transcriptKey.join(':')}` });
}

const judged = 'Keep it. Annual customers churn at a third of the monthly rate.';
function suggestion(overrides: Partial<ConversationSuggestion> = {}): ConversationSuggestion {
  return {
    suggestionId: '00000000-0000-7000-8000-000000000911',
    kind: 'merge_up',
    judgedTurnId: 'turn-2',
    status: 'open',
    draft: { status: 'ready', text: 'Keep the annual discount: annual churn is a third of monthly.', subject: null },
    target: { kind: 'thread', id: threadId, title: 'Pricing' },
    ...overrides,
  };
}

function socket(suggestions: ConversationSuggestion[]): void {
  retainedSocket.mockReturnValue({
    activeCompaction: null, activeInferenceDelays: [], suggestions, createMessage: vi.fn(), requestSnapshot: vi.fn(),
    retryOpening: vi.fn(), sendReady: true, state: 'connected', workspaceSocketState: 'connected',
  });
}

function renderBreakout(turns: Turn[], suggestions: ConversationSuggestion[]): void {
  socket(suggestions);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  seed(queryClient, ['workstream', threadId], ['ordered-transcript', threadId], boot(threadId, 'Pricing', []));
  seed(queryClient, ['substream-workstream', threadId, breakoutId], ['substream-ordered-transcript', threadId, breakoutId], boot(threadId, 'Annual discount', turns));
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${threadId}?substream=${breakoutId}`]}>
          <Routes><Route element={<WorkstreamScreen />} path="/workstreams/:id" /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

function renderThread(turns: Turn[], suggestions: ConversationSuggestion[], configure?: (client: QueryClient) => void): void {
  socket(suggestions);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  seed(queryClient, ['workstream', threadId], ['ordered-transcript', threadId], boot(threadId, 'Pricing', turns));
  configure?.(queryClient);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${threadId}`]}>
          <Routes><Route element={<WorkstreamScreen />} path="/workstreams/:id" /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

const twoTurns = [turn(1, 'human', 'Should we keep the annual discount?'), turn(2, 'assistant', judged)];

describe('the suggestion chip', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllDrafts();
    session.current = { user: { id: 'member', email: 'member@example.test', name: 'Morgan' }, workspace: { id: 'workspace', region: 'global', accessClass: 'member' } };
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.mergeChannels.mockResolvedValue({ channels: [] });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    api.dismissSuggestion.mockResolvedValue({ suggestionId: '00000000-0000-7000-8000-000000000911', status: 'dismissed', replayed: false });
  });
  afterEach(() => { vi.restoreAllMocks(); });


  it.each([
    { name: 'replaced', channels: [{ id: '00000000-0000-7000-8000-000000000922', name: 'Board' }] },
    { name: 'removed', channels: [] },
  ])('closes an open merge card when its chosen Channel is $name, without changing its audience', async ({ channels }) => {
    let finish!: (value: ConversationMergeChannels) => void;
    api.mergeChannels.mockReturnValue(new Promise<ConversationMergeChannels>((resolve) => { finish = resolve; }));
    const gtm = asSpaceId('00000000-0000-7000-8000-000000000921');
    const board = asSpaceId('00000000-0000-7000-8000-000000000922');
    renderThread(twoTurns, [], (client) => {
      client.setQueryData<WorkstreamDetail>(['workstream', threadId], (held) => held ? { ...held, spaceIds: [gtm] } : held);
      client.setQueryData<SpaceDirectory>(['spaces'], { waterline: 1, items: [gtm, board].map((id, index) => ({
        id, name: index === 0 ? 'GTM' : 'Board', iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', reach: 'organization', status: 'active',
        systemRole: null, revision: 1, participants: [], channelCount: 1, attentionCount: 0,
        defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z',
      })) });
    });
    const row = (await screen.findByText(judged)).closest('[data-arrival-id]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Merge to GTM' }));
    const card = await screen.findByRole('article', { name: 'Merge to GTM' });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Merge note' }), { target: { value: 'Keep this draft for the selected audience.' } });
    await act(async () => { finish({ channels }); });
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Merge to GTM' })).toBeNull(), { timeout: 5000 });
    expect(screen.queryByRole('article', { name: 'Merge to Board' })).toBeNull();
    expect(api.mergeConversation).not.toHaveBeenCalled();
    expect((await readDraftText(`${workstreamDraftKey('global', 'workspace', threadId, '0')}:merge`))?.text)
      .toBe('Keep this draft for the selected audience.');
    if (channels.length) {
      fireEvent.click(within(row).getByRole('button', { name: 'Merge to Board' }));
      const reopened = await screen.findByRole('article', { name: 'Merge to Board' });
      expect(within(reopened).getByRole('textbox', { name: 'Merge note' })).toHaveValue(judged);
    }
  });

  it('draws a merge chip under the judged turn in a Breakout, with the drafted note as its excerpt', async () => {
    renderBreakout(twoTurns, [suggestion()]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    expect(chip.textContent).toContain('Merge to Pricing');
    expect(chip.textContent).toContain('This might be a good time to merge this back into Pricing.');
    expect(chip.textContent).toContain('“Keep the annual discount: annual churn is a third of monthly.”');
    // Under the judged turn: the chip's row follows that turn's row.
    const row = chip.closest('[data-arrival-id]');
    expect(row?.querySelector('.message-block')?.textContent).toContain(judged);
  });

  it('stays while two newer messages exist', async () => {
    renderBreakout([...twoTurns, turn(3, 'human', 'thanks'), turn(4, 'assistant', 'Any time.')], [suggestion()]);
    await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
  });

  it('is hidden once three newer messages exist, whatever the room still holds', async () => {
    renderBreakout([...twoTurns, turn(3, 'human', 'thanks'), turn(4, 'assistant', 'Any time.'), turn(5, 'human', 'one more')], [suggestion()]);
    await screen.findByText('one more');
    expect(screen.queryByRole('group', { name: 'Suggestion: merge to Pricing' })).toBeNull();
  });

  it('draws a skeleton with the action disabled while the draft is pending, and fills when it lands', async () => {
    renderBreakout(twoTurns, [suggestion({ draft: { status: 'pending', text: null, subject: null } })]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    expect(within(chip).getByRole('status', { name: 'Rally is drafting the words' })).toBeTruthy();
    expect(within(chip).getByRole('button', { name: 'Merge' })).toBeDisabled();
    expect(within(chip).getByRole('button', { name: 'Dismiss suggestion' })).toBeEnabled();
  });

  it('opens the response card in the chip\'s place with the drafted note, and the composer stays an ordinary composer', async () => {
    renderBreakout(twoTurns, [suggestion()]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    fireEvent.click(within(chip).getByRole('button', { name: 'Merge' }));
    const card = await screen.findByRole('article', { name: 'Merge to Pricing' });
    expect(within(card).getByRole('textbox', { name: 'Merge note' })).toHaveValue('Keep the annual discount: annual churn is a third of monthly.');
    expect(screen.queryByRole('group', { name: 'Suggestion: merge to Pricing' })).toBeNull();
    expect(card.closest('[data-arrival-id]')?.querySelector('.message-block')?.textContent).toContain(judged);
    expect(document.querySelector('.is-merge-composer')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Merge message' })).toBeNull();
  });

  it('merges from the card through the merge route with the card\'s words', async () => {
    api.mergeConversation.mockResolvedValue({ mergedInto: { kind: 'thread', id: threadId, title: 'Pricing' }, messageId: 'm1', replayed: false, sharedResourceIds: [] });
    renderBreakout(twoTurns, [suggestion()]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    fireEvent.click(within(chip).getByRole('button', { name: 'Merge' }));
    const card = await screen.findByRole('article', { name: 'Merge to Pricing' });
    fireEvent.click(within(card).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(api.mergeConversation).toHaveBeenCalledWith(threadId, expect.objectContaining({
      body: 'Keep the annual discount: annual churn is a third of monthly.', breakoutId,
    })));
  });

  it('a note that mentions somebody not in the personal Thread asks first, then merges with them added', async () => {
    api.getWorkspaceMembers.mockResolvedValue([
      { id: 'member', name: 'Morgan', email: 'morgan@example.test', status: 'active', role: 'owner', accessClass: 'member', timezone: 'UTC' },
      { id: 'priya', name: 'Priya', email: 'priya@example.test', status: 'active', role: 'member', accessClass: 'member', timezone: 'UTC' },
    ]);
    api.mergeConversation.mockResolvedValue({ mergedInto: { kind: 'thread', id: threadId, title: 'Pricing' }, messageId: 'm1', replayed: false, sharedResourceIds: [] });
    renderBreakout(twoTurns, [suggestion()]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    fireEvent.click(within(chip).getByRole('button', { name: 'Merge' }));
    const card = await screen.findByRole('article', { name: 'Merge to Pricing' });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Merge note' }), { target: { value: '@Priya the discount stays.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Merge' }));
    await screen.findByText('Add participant?');
    expect(api.mergeConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add and merge' }));
    await waitFor(() => expect(api.mergeConversation).toHaveBeenCalledWith(threadId, expect.objectContaining({
      body: '@Priya the discount stays.', breakoutId, confirmedParticipantUserIds: ['priya'],
    })));
  });

  it('the Merge hover action opens the same card under its turn, prefilled with the turn\'s words', async () => {
    renderBreakout(twoTurns, []);
    const judgedRow = (await screen.findByText(judged)).closest('[data-arrival-id]') as HTMLElement;
    fireEvent.click(within(judgedRow).getByRole('button', { name: 'Merge to thread' }));
    const card = await screen.findByRole('article', { name: 'Merge to Pricing' });
    expect(within(card).getByRole('textbox', { name: 'Merge note' })).toHaveValue(judged);
    expect(card.closest('[data-arrival-id]')?.querySelector('.message-block')?.textContent).toContain(judged);
  });

  it('dismiss hides the chip at once and tells the room', async () => {
    renderBreakout(twoTurns, [suggestion()]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: merge to Pricing' });
    fireEvent.click(within(chip).getByRole('button', { name: 'Dismiss suggestion' }));
    expect(screen.queryByRole('group', { name: 'Suggestion: merge to Pricing' })).toBeNull();
    await waitFor(() => expect(api.dismissSuggestion).toHaveBeenCalledWith(threadId, breakoutId, '00000000-0000-7000-8000-000000000911'));
  });

  it('shows no merge chip to a viewer who cannot merge: a Thread nobody can merge up', async () => {
    // A personal-scope Thread has no Channel to merge into, so the viewer has no
    // Merge action and sees no line, whatever the room holds.
    renderThread(twoTurns, [suggestion({ target: null })]);
    await screen.findByText(judged);
    expect(screen.queryByRole('group', { name: /Suggestion: merge/ })).toBeNull();
  });

  it('a breakout chip in a Thread opens the launch pane at the turn, seeded with the drafted prompt', async () => {
    renderThread(twoTurns, [suggestion({
      kind: 'start_breakout', target: null,
      draft: { status: 'ready', text: 'Work out whether a Starter tier makes sense at all.', subject: 'Starter tier' },
    })]);
    const chip = await screen.findByRole('group', { name: 'Suggestion: breakout Starter tier' });
    expect(chip.textContent).toContain('Breakout: Starter tier');
    expect(chip.textContent).toContain('Want to break this out?');
    fireEvent.click(within(chip).getByRole('button', { name: 'Start' }));
    await screen.findByText('New breakout from this message');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'What should this breakout work on?' }))
      .toHaveValue('Work out whether a Starter tier makes sense at all.'));
  });
});
