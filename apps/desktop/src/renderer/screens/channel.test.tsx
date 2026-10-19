import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, parsePath, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ChannelStats, MemoryReview, MemoryReviewFact } from '@rally/contracts';
import { OPEN_EXPANDED, revealChannelMessageState } from '../lib/navigation-routes';
import { useUiStore } from '../lib/ui-store';
import { CHANNEL_STATS_QUERY_KEY } from '../lib/sidebar-list-store';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { ChannelScreen } from './channel';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
  getChannelFeed: vi.fn(),
  getResource: vi.fn(),
  getResourcePreviewContent: vi.fn(async () => new Blob(['The model, in full.'], { type: 'text/markdown' })),
  getWorkspaceMembers: vi.fn(async () => []),
  getWorkspaceInvitees: vi.fn(async () => []),
  archiveSpace: vi.fn(),
  updateSpacePresentation: vi.fn(),
  updateSpaceAudience: vi.fn(),
  acknowledgeChannelRead: vi.fn(),
  getChannelMemory: vi.fn<(spaceId: string, signal?: AbortSignal) => Promise<MemoryReview>>(async () => ({ facts: [] })),
  forgetChannelMemory: vi.fn(async (_spaceId: string, factId: string) => ({ factId, retractedAt: '2026-10-19T12:00:00.000Z' })),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: null }) }));
const spaces = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces, inactive: { data: undefined } }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }), useCachedWorkstreamAppearance: () => undefined }));
vi.mock('../components/channel-composer', () => ({
  ChannelComposer: ({ threadOpen }: { threadOpen?: boolean }) => <div data-thread-open={String(threadOpen)}>composer</div>,
}));
// The thread pane, with the Channel crumb it would draw once it is off screen
// and the button that expands it over the Channel.
vi.mock('./workstream', async () => {
  const { OPEN_EXPANDED, useChannelPane } = await import('../lib/navigation-routes');
  const { Link: RouterLink } = await import('react-router-dom');
  return {
    WorkstreamScreen: () => {
      const pane = useChannelPane();
      return <div>thread pane{pane && <>
        <RouterLink to="/channels/outbound/threads/secret">Next thread</RouterLink>
        <RouterLink state={OPEN_EXPANDED} to="/channels/outbound/threads/secret">Sidebar thread</RouterLink>
        <RouterLink state={OPEN_EXPANDED} to="/channels/outbound/threads/plan?substream=child">Sidebar breakout</RouterLink>
        <button onClick={pane.crumb.onSelect} type="button">Channel crumb</button>
        {/* As the real header: Collapse while expanded, Expand while beside the Channel, neither once shifted. */}
        {(pane.expanded || !pane.shifted) && <button onClick={() => pane.setExpanded(!pane.expanded)} type="button">{pane.expanded ? 'Collapse' : 'Expand'}</button>}
        <button onClick={() => pane.setThreadUsesTwoPanes(true)} type="button">Open breakout</button>
        <button onClick={() => pane.setThreadUsesTwoPanes(false)} type="button">Close breakout</button>
      </>}</div>;
    },
  };
});

const workspace: Workspace = {
  id: 'org', name: 'Rally', region: 'enterprise', timezone: 'UTC',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', timezone: 'UTC', role: 'member', accessClass: 'member' },
};

function outbound(reach: 'organization' | 'participant' | 'through_channel', scope: 'workspace' | 'individual' = 'workspace') {
  return { waterline: 1, items: [{
    id: 'outbound', name: 'Outbound', iconKey: 'briefcase', colorKey: 'blue', scope, status: 'active',
    systemRole: null, revision: 1, reach, participants: [], channelCount: 2, attentionCount: 0,
    defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }] };
}

const plan: WorkstreamSummary = {
  id: 'plan', title: 'Q4 plan', objective: 'A four-week outbound setup plan.', titleStatus: 'settled', scope: 'workspace',
  harnessStatus: 'completed', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
  nextPendingWakeup: null, participantUserIds: [], participantExtraCount: 0, spaceIds: ['outbound'], pinPosition: null,
  lastActivityAt: '2026-10-02T00:00:00.000Z',
};

function outboundStats(overrides: Partial<ChannelStats> = {}): ChannelStats {
  return {
    channelId: 'outbound', threadCount: 2, newThreadCount: 1, lastActivityAt: '2026-10-03T00:00:00.000Z',
    latestAttentionSequenceNumber: 2, readThroughSequenceNumber: 1, firstUnreadSequenceNumber: 2, hasUnread: true,
    ...overrides,
  };
}

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-state={JSON.stringify(location.state)} data-testid="location">{location.pathname}</div>;
}

function renderChannel(path = '/channels/outbound', seed: (client: QueryClient) => void = () => undefined, state: unknown = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  const view = render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={[{ ...parsePath(path), state }]}>
      <Routes><Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" /></Routes>
      <Routes><Route element={<Location />} path="*" /></Routes>
      <Link to="/channels/outbound/threads/plan">Plain link to Q4 plan</Link>
    </MemoryRouter>
  </Tooltip.Provider></QueryClientProvider>);
  return { ...view, client };
}

describe('a Channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spaces.data = outbound('organization');
    // Placement 2 is a private thread this reader is not in: not a row, but
    // the page's latest number still carries it.
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 2, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
    ] });
  });

  it('lists its threads down to now, beside the composer', async () => {
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    const rows = await feed.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('A four-week outbound setup plan.');
    expect(within(rows[0]!).getByRole('button', { name: 'Q4 plan' })).toBeInTheDocument();
    expect(screen.getByText('composer')).toBeInTheDocument();
  });

  it('lists the Channel’s own facts in its pill’s Memory level, read only once the level opens', async () => {
    const remembered = (factId: string, text: string, removable: boolean): MemoryReviewFact => ({
      factId, subjectKind: 'channel', subjectTitle: 'Outbound', kind: 'standing', text,
      validFrom: null, validUntil: null, recordedAt: '2026-10-01T12:00:00.000Z', conflict: false, derivedFrom: 'person',
      source: { kind: 'thread', workstreamId: 'plan', title: 'Q4 plan' }, removable,
    });
    api.getChannelMemory.mockResolvedValue({ facts: [
      remembered('f1', 'Outbound targets mid-market accounts.', true),
      remembered('f2', 'Demos run on Thursdays.', true),
    ] });
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });

    const level = await screen.findByRole('menuitem', { name: /^Memory/u });
    expect(api.getChannelMemory).not.toHaveBeenCalled();
    fireEvent.click(level);

    expect(await screen.findByText('Outbound targets mid-market accounts.')).toBeInTheDocument();
    expect(api.getChannelMemory).toHaveBeenCalledWith('outbound', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Demos run on Thursdays.”' }));
    await waitFor(() => expect(screen.queryByText('Demos run on Thursdays.')).toBeNull());
    expect(api.forgetChannelMemory).toHaveBeenCalledWith('outbound', 'f2');

    // A fact's source opens its thread, and the menu closes.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Q4 plan' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/workstreams/plan'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a thread expanded over the Channel from its chip, and Collapse puts it beside the Channel', async () => {
    renderChannel();
    fireEvent.click(await screen.findByRole('button', { name: 'Q4 plan' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/plan');
    expect(await screen.findByText('thread pane')).toBeVisible();
    expect(screen.getByText('composer')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByText('composer')).toBeVisible();
  });

  it('opens the Channel alone from its crumb, leaving the thread and its breakout', async () => {
    renderChannel('/channels/outbound/threads/plan?substream=rollout');

    fireEvent.click(await screen.findByRole('button', { name: 'Channel crumb' }));

    expect(screen.getByTestId('location')).toHaveTextContent(/^\/channels\/outbound$/u);
    expect(screen.queryByText('thread pane')).toBeNull();
  });

  it('expands a thread over the Channel and puts it back, and opens the next thread beside it', async () => {
    renderChannel('/channels/outbound/threads/plan');
    expect(await screen.findByText('composer')).toBeVisible();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand' }));
    expect(screen.getByText('composer')).not.toBeVisible();
    expect(screen.getByText('thread pane')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByText('composer')).toBeVisible();

    // Another thread opened from the expanded one comes up beside the Channel.
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('link', { name: 'Next thread' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/secret');
    expect(screen.getByText('composer')).toBeVisible();
  });

  it('opens a thread expanded over the Channel when the sidebar opened it, and the next one too', async () => {
    renderChannel('/channels/outbound/threads/plan', undefined, OPEN_EXPANDED);
    expect(await screen.findByText('thread pane')).toBeVisible();
    expect(screen.getByText('composer')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByText('composer')).toBeVisible();

    fireEvent.click(screen.getByRole('link', { name: 'Sidebar thread' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/secret');
    expect(screen.getByText('composer')).not.toBeVisible();

    // A sidebar open onto the thread already open expands it again.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByText('composer')).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Sidebar thread' }));
    expect(screen.getByText('composer')).not.toBeVisible();
  });

  it('opens a thread beside the Channel again after it was closed while expanded', async () => {
    renderChannel('/channels/outbound/threads/plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Channel crumb' }));
    fireEvent.click(screen.getByRole('link', { name: 'Plain link to Q4 plan' }));

    expect(await screen.findByText('thread pane')).toBeVisible();
    expect(screen.getByText('composer')).toBeVisible();
  });

  it('holds the expansion while the thread has a breakout open, so closing it returns to the thread expanded', async () => {
    renderChannel('/channels/outbound/threads/plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open breakout' }));
    // Split with its breakout, the thread offers neither Expand nor Collapse.
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
    expect(screen.getByText('composer')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close breakout' }));
    expect(screen.getByText('composer')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('leaves a thread beside the Channel when the sidebar opens one of its breakouts expanded', async () => {
    renderChannel('/channels/outbound/threads/plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Open breakout' }));
    fireEvent.click(screen.getByRole('link', { name: 'Sidebar breakout' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close breakout' }));
    expect(screen.getByText('composer')).toBeVisible();
  });

  it('returns to the Channel and the thread when a breakout closes on a thread opened beside it', async () => {
    renderChannel('/channels/outbound/threads/plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Open breakout' }));
    expect(screen.getByText('composer')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close breakout' }));
    expect(screen.getByText('composer')).toBeVisible();
  });

  it('hands the composer focus and paste back while a thread is open beside it', async () => {
    renderChannel();
    expect(await screen.findByText('composer')).toHaveAttribute('data-thread-open', 'false');
    fireEvent.click(await screen.findByRole('button', { name: 'Q4 plan' }));
    expect(await screen.findByText('composer')).toHaveAttribute('data-thread-open', 'true');
  });

  it('marks each day the feed crosses once, above its first thread', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T15:00:00.000Z', attentionSequenceNumber: 3, thread: { ...plan, id: 'later' } },
      { kind: 'thread', placedAt: '2026-10-02T14:00:00.000Z', attentionSequenceNumber: 2, thread: plan },
      { kind: 'thread', placedAt: '2026-09-20T12:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, id: 'earlier' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    await feed.findAllByRole('listitem');
    expect(feed.getAllByRole('separator')).toHaveLength(2);
  });

  it('keeps the same date in different years apart', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2025-10-02T12:00:00.000Z', attentionSequenceNumber: 2, thread: plan },
      { kind: 'thread', placedAt: '2024-10-02T12:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, id: 'earlier' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    await feed.findAllByRole('listitem');
    expect(feed.getAllByRole('separator')).toHaveLength(2);
  });

  it('draws a Channel message as its author speaking, Rally or a member, in time order among the threads', async () => {
    const alex = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    api.getWorkspaceMembers.mockResolvedValueOnce([
      { id: alex, name: 'Casey Lane', email: 'alex@rally.test', role: 'member' },
    ] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'message', placedAt: '2026-10-02T02:00:00.000Z', message: { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60', author: { kind: 'member', userId: alex }, body: 'Kicking off **Q4**' } },
      { kind: 'thread', placedAt: '2026-10-02T01:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
      { kind: 'message', placedAt: '2026-10-02T00:00:00.000Z', message: { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61', author: { kind: 'rally' }, body: 'Welcome to the Channel' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    const rows = await feed.findAllByRole('listitem');
    // Oldest first, reading down to now.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Welcome to the Channel'),
      expect.stringContaining('Q4 plan'),
      expect.stringContaining('Kicking off Q4'),
    ]);
    expect(rows[0]).toHaveTextContent('Rally');
    await waitFor(() => expect(rows[2]).toHaveTextContent('Casey Lane'));
    expect(within(rows[2]!).getByText('Q4', { selector: 'strong' })).toBeInTheDocument();
  });

  it('draws a thread’s merge with its thread, a quote, and its embeds', async () => {
    const mergeId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62';
    api.getWorkspaceMembers.mockResolvedValueOnce([workspace.currentUser] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: {
        id: mergeId,
        author: { kind: 'member', userId: 'me' },
        body: 'Shipped. See [Price model](resource://res-1).',
        merge: {
          threadId: plan.id,
          title: 'Q4 plan',
          summary: 'Plan the quarter\nand more',
          embeds: [{ id: 'res-1', title: 'Price model', kind: 'document' }],
        },
      } },
      { kind: 'thread', placedAt: '2026-10-02T01:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    const rows = await feed.findAllByRole('listitem');
    // The merge is at the bottom, when it was merged.
    const merge = within(rows[1]!);
    expect(merge.getByRole('button', { name: 'Q4 plan' })).toBeVisible();
    expect(merge.getByText('Plan the quarter')).toBeVisible();
    expect(merge.getByText('Price model')).toBeVisible();
    await waitFor(() => expect(merge.getByRole('article', { name: 'Q4 plan, merged by Me' })).toHaveTextContent(/merged by\s*Me/u));
    expect(merge.getByRole('article', { name: 'Q4 plan, merged by Me' })).toHaveClass('merge-message');
    expect(merge.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('draws a merge from a thread the reader cannot open as from a private thread, with nothing to open', async () => {
    api.getWorkspaceMembers.mockResolvedValueOnce([workspace.currentUser] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: {
        id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a66',
        author: { kind: 'member', userId: 'me' },
        body: 'Discounts over 20% now need finance sign-off.',
        merge: { threadId: plan.id, title: '', summary: null, embeds: [], private: true },
      } },
    ] });
    renderChannel();
    const merge = within((await screen.findByText('Discounts over 20% now need finance sign-off.')).closest('li')!);
    await waitFor(() => expect(merge.getByRole('article', { name: 'A private thread, merged by Me' })).toBeVisible());
    expect(merge.getByText('Private thread')).toBeVisible();
    expect(merge.queryByRole('button', { name: 'Private thread' })).toBeNull();
    expect(merge.queryByRole('button', { name: /request access/iu })).toBeNull();
  });

  it('scrolls and moves focus to a merged thread’s card from the merge’s quote, and opens the thread when the card is not loaded', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    api.getWorkspaceMembers.mockResolvedValueOnce([workspace.currentUser] as never);
    const mergeOf = (id: string, threadId: string, summary: string) => ({ id, author: { kind: 'member', userId: 'me' }, body: 'Done.', merge: { threadId, title: 'Q4 plan', summary, embeds: [] } });
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 4, items: [
      { kind: 'message', placedAt: '2026-10-02T04:00:00.000Z', attentionSequenceNumber: 4, message: mergeOf('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a64', 'older', 'An older thread') },
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: mergeOf('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a65', plan.id, 'Plan the quarter') },
      { kind: 'thread', placedAt: '2026-10-02T01:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    fireEvent.click(await feed.findByRole('button', { name: 'Plan the quarter' }));
    // Oldest first: the thread's card is the first row.
    expect(scrollIntoView.mock.contexts).toEqual([feed.getAllByRole('listitem')[0]]);
    expect(scrollIntoView.mock.contexts[0]).toHaveTextContent('A four-week outbound setup plan.');
    expect(within(feed.getAllByRole('listitem')[0]!).getByRole('button', { name: /Q4 plan/u })).toHaveFocus();
    fireEvent.click(feed.getByRole('button', { name: 'An older thread' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/older'));
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('brings into view the merge a navigation opened it onto', async () => {
    const mergeId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a63';
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: {
        id: mergeId,
        author: { kind: 'member', userId: 'me' },
        body: 'Shipped.',
        merge: { threadId: plan.id, title: 'Q4 plan', summary: null, embeds: [] },
      } },
      { kind: 'thread', placedAt: '2026-10-02T01:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
    ] });
    // jsdom does not scroll, so the call is the observable.
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    renderChannel('/channels/outbound', undefined, revealChannelMessageState(mergeId));
    const merge = await screen.findByText('Shipped.');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' }));
    expect(scrollIntoView.mock.contexts[0]).toBe(merge.closest('li'));
  });

  it('waits for a merge the feed has yet to list, then brings it into view once', async () => {
    const mergeId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a64';
    const thread = { kind: 'thread' as const, placedAt: '2026-10-02T01:00:00.000Z', attentionSequenceNumber: 1, thread: plan };
    api.getChannelFeed.mockResolvedValueOnce({ nextCursor: null, latestAttentionSequenceNumber: 1, items: [thread] });
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: {
        id: mergeId,
        author: { kind: 'member', userId: 'me' },
        body: 'Landed later.',
        merge: { threadId: plan.id, title: 'Q4 plan', summary: null, embeds: [] },
      } },
      thread,
    ] });
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    const { client } = renderChannel('/channels/outbound', undefined, revealChannelMessageState(mergeId));
    await screen.findByRole('button', { name: 'Q4 plan' });
    expect(scrollIntoView).not.toHaveBeenCalled();
    await client.invalidateQueries();
    const merge = await screen.findByText('Landed later.');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' }));
    expect(scrollIntoView.mock.contexts[0]).toBe(merge.closest('li'));
    await client.invalidateQueries();
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('waits for a repeat merge to move to the bottom before bringing it into view', async () => {
    const mergeId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a65';
    const merge = (placedAt: string, attentionSequenceNumber: number) => ({ kind: 'message' as const, placedAt, attentionSequenceNumber, message: {
      id: mergeId,
      author: { kind: 'member' as const, userId: 'me' },
      body: 'Merged again.',
      merge: { threadId: plan.id, title: 'Q4 plan', summary: null, embeds: [] },
    } });
    const thread = { kind: 'thread' as const, placedAt: '2026-10-02T02:00:00.000Z', attentionSequenceNumber: 2, thread: plan };
    // The first merge, cached above a newer thread; the repeat moves it to the bottom.
    api.getChannelFeed.mockResolvedValueOnce({ nextCursor: null, latestAttentionSequenceNumber: 2, items: [thread, merge('2026-10-02T01:00:00.000Z', 1)] });
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [merge('2026-10-02T03:00:00.000Z', 3), thread] });
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    const { client } = renderChannel('/channels/outbound', undefined, revealChannelMessageState(mergeId));
    await screen.findByText('Merged again.');
    expect(scrollIntoView).not.toHaveBeenCalled();
    await client.invalidateQueries();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' }));
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByText('Merged again.').closest('li'));
  });

  it('pages back to an older merge a divider asks for, then brings it into view and lights it', async () => {
    const mergeId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a66';
    const thread = { kind: 'thread' as const, placedAt: '2026-10-02T02:00:00.000Z', attentionSequenceNumber: 2, thread: plan };
    // The newest page holds only a later thread; the merge is a page back.
    api.getChannelFeed.mockImplementation(async (_channelId: string, cursor: string | null) => cursor === null
      ? { nextCursor: 'older', latestAttentionSequenceNumber: 2, items: [thread] }
      : { nextCursor: null, latestAttentionSequenceNumber: 2, items: [{ kind: 'message', placedAt: '2026-10-01T01:00:00.000Z', attentionSequenceNumber: 1, message: {
        id: mergeId,
        author: { kind: 'member', userId: 'me' },
        body: 'Merged last week.',
        merge: { threadId: plan.id, title: 'Q4 plan', summary: null, embeds: [] },
      } }] });
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    renderChannel('/channels/outbound', undefined, revealChannelMessageState(mergeId, { searchHistory: true }));
    const merge = await screen.findByText('Merged last week.');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' }));
    expect(scrollIntoView.mock.contexts[0]).toBe(merge.closest('li'));
    expect(merge.closest('li')?.classList.contains('is-focused')).toBe(true);
  });

  it('opens an artifact a merge cites, by its alias, in the Channel’s own panel', async () => {
    api.getWorkspaceMembers.mockResolvedValueOnce([workspace.currentUser] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, latestAttentionSequenceNumber: 3, items: [
      { kind: 'message', placedAt: '2026-10-02T03:00:00.000Z', attentionSequenceNumber: 3, message: {
        id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a63',
        author: { kind: 'member', userId: 'me' },
        body: 'Shipped. See [Price model](resource://calm-river-quiet-lamp).',
        merge: {
          threadId: plan.id,
          title: 'Q4 plan',
          summary: null,
          embeds: [{ id: 'res-1', slug: 'calm-river-quiet-lamp', title: 'Price model', kind: 'document' }],
        },
      } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    api.getResource.mockResolvedValue({
      id: 'res-1', slug: 'calm-river-quiet-lamp', title: 'Price model', resourceType: 'generated_file', provider: 'avalon_generated',
      mimeType: 'text/markdown', contentAvailable: true, currentVersion: 1, updatedAt: '2026-10-02T03:00:00.000Z',
      refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported', relationshipType: 'generated', direction: 'artifact',
    });
    fireEvent.click(await feed.findByText('Price model'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/artifacts/res-1'));
    // The Channel stays, and the artifact opens beside it, read by its id.
    expect(screen.getByRole('list', { name: 'Outbound feed' })).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'Resource: Price model' })).toBeInTheDocument();
    expect(api.getResource).toHaveBeenCalledWith('res-1');
  });

  it('expands the artifact over the Channel and collapses it back, as a thread’s panel does', async () => {
    api.getResource.mockResolvedValue({
      id: 'res-1', title: 'Price model', resourceType: 'generated_file', provider: 'avalon_generated',
      mimeType: 'text/markdown', contentAvailable: true, currentVersion: 1, updatedAt: '2026-10-02T03:00:00.000Z',
      refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported', relationshipType: 'generated', direction: 'artifact',
    });
    // Wide enough for the panel to sit beside the Channel.
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_800);
    onTestFinished(() => width.mockRestore());
    renderChannel('/channels/outbound/artifacts/res-1');
    await screen.findByRole('complementary', { name: 'Resource: Price model' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(await screen.findByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(useUiStore.getState().railExpanded).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(await screen.findByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(useUiStore.getState().railExpanded).toBe(false);
  });

  it('says so when the artifact it opens cannot be read', async () => {
    api.getResource.mockRejectedValue(new Error('resource_not_shared'));
    renderChannel('/channels/outbound/artifacts/res-9');
    expect(await screen.findByText('Item unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/channels\/outbound$/u));
  });

  it('names somebody it cannot look up as someone, not Rally', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, createdByUserId: 'gone' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Outbound feed' }));
    expect((await feed.findAllByRole('listitem'))[0]).toHaveTextContent('Someone');
  });

  it('renders a thread’s summary as its message would, a member named in it as a mention chip', async () => {
    const alex = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    api.getWorkspaceMembers.mockResolvedValueOnce([
      { id: alex, name: 'Casey Lane', email: 'alex@rally.test', role: 'member' },
    ] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, objective: '@Casey Lane @Nobody here are the **mockups**' } },
    ] });
    const { container } = renderChannel();
    await waitFor(() => expect(container.querySelector('.conversation-card-summary .mention-chip')).not.toBeNull());
    const summary = container.querySelector('.conversation-card-summary')!;
    expect(summary.querySelectorAll('.mention-chip')).toHaveLength(1);
    expect(summary.querySelector('.mention-chip')).toHaveAttribute('data-person-id', alex);
    expect(summary.querySelector('.mention-chip-label')).toHaveTextContent('Casey Lane');
    expect(summary.querySelector('strong')).toHaveTextContent('mockups');
    expect(summary).toHaveTextContent('Casey Lane @Nobody here are the mockups');
  });

  it('chips a member’s typed address in a thread’s summary, and draws a task list without its checkboxes', async () => {
    api.getWorkspaceMembers.mockResolvedValueOnce([
      { id: 'alex', name: 'Casey Lane', email: 'alex@rally.test', role: 'member' },
    ] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, objective: 'Ask @alex@rally.test\n\n- [ ] Follow up' } },
    ] });
    const { container } = renderChannel();
    await waitFor(() => expect(container.querySelector('.conversation-card-summary .mention-chip')).not.toBeNull());
    const summary = container.querySelector('.conversation-card-summary')!;
    expect(summary.querySelector('.mention-chip')).toHaveAttribute('data-person-id', 'alex');
    expect(summary).toHaveTextContent('Follow up');
    expect(summary.querySelector('input')).toBeNull();
  });

  it('offers no composer to somebody who reaches the Channel only through a thread in it', async () => {
    spaces.data = outbound('through_channel');
    renderChannel();
    await screen.findByRole('list', { name: 'Outbound feed' });
    expect(screen.queryByText('composer')).not.toBeInTheDocument();
  });

  describe('importing', () => {
    const openBrowserImport = vi.fn(async () => undefined);
    beforeEach(() => vi.stubGlobal('rally', { openBrowserImport }));
    afterEach(() => vi.unstubAllGlobals());

    it('imports from Claude or ChatGPT into this Channel alone, from its header', async () => {
      renderChannel();
      fireEvent.click(await screen.findByRole('button', { name: 'Import from Claude or ChatGPT' }));
      expect(openBrowserImport).toHaveBeenCalledWith({ spaces: [{ id: 'outbound', name: 'Outbound' }], spaceLocked: true });
    });

    it('offers no import to somebody who cannot start a thread in the Channel', async () => {
      spaces.data = outbound('through_channel');
      renderChannel();
      await screen.findByRole('list', { name: 'Outbound feed' });
      expect(screen.queryByRole('button', { name: 'Import from Claude or ChatGPT' })).toBeNull();
    });
  });

  it('archives from its title menu after asking, and leaves for the landing', async () => {
    api.archiveSpace.mockResolvedValue({ ...outbound('organization').items[0], status: 'archived' });
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive channel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/u));
    expect(api.archiveSpace).toHaveBeenCalledWith('outbound');
  });

  it('saves an icon and a colour picked from its mark one after the other, the second keeping the first', async () => {
    const first = Promise.withResolvers<unknown>();
    api.updateSpacePresentation
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_id: string, input: object) => ({ ...outbound('organization').items[0], ...input }));
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Change Outbound icon and color' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Green' }));

    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledTimes(1));
    expect(api.updateSpacePresentation).toHaveBeenLastCalledWith('outbound', { name: 'Outbound', iconKey: 'rocket', colorKey: 'blue' });
    first.resolve({ ...outbound('organization').items[0], iconKey: 'rocket' });
    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledTimes(2));
    expect(api.updateSpacePresentation).toHaveBeenLastCalledWith('outbound', { name: 'Outbound', iconKey: 'rocket', colorKey: 'green' });
  });

  it('renames after an icon pick still saving without sending the old icon back', async () => {
    const first = Promise.withResolvers<unknown>();
    api.updateSpacePresentation
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_id: string, input: object) => ({ ...outbound('organization').items[0], ...input }));
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Change Outbound icon and color' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Outreach' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    first.resolve({ ...outbound('organization').items[0], iconKey: 'rocket' });
    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledTimes(2));
    expect(api.updateSpacePresentation).toHaveBeenLastCalledWith('outbound', { name: 'Outreach', iconKey: 'rocket', colorKey: 'blue' });
  });

  it('starts a pick on another Channel from that Channel, not from one still saving on the last', async () => {
    const outboundRow = outbound('organization').items[0]!;
    const growth = { ...outboundRow, id: 'growth', name: 'Growth', iconKey: 'flag', colorKey: 'green' };
    spaces.data = { waterline: 1, items: [outboundRow, growth] };
    const first = Promise.withResolvers<unknown>();
    api.updateSpacePresentation
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_id: string, input: object) => ({ ...growth, ...input }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <MemoryRouter initialEntries={['/channels/outbound']}>
        <Link to="/channels/growth">to growth</Link>
        <Routes><Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" /></Routes>
      </MemoryRouter>
    </Tooltip.Provider></QueryClientProvider>);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Change Outbound icon and color' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('link', { name: 'to growth' }));
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Change Growth icon and color' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));

    first.resolve({ ...outboundRow, iconKey: 'rocket' });
    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledTimes(2));
    expect(api.updateSpacePresentation).toHaveBeenLastCalledWith('growth', { name: 'Growth', iconKey: 'flag', colorKey: 'purple' });
  });

  it('renames General from its title menu, which only refuses archiving it or making it private', async () => {
    const general = { ...outbound('organization').items[0]!, systemRole: 'general' };
    spaces.data = { waterline: 1, items: [general] };
    api.updateSpacePresentation.mockImplementation(async (_id: string, input: object) => ({ ...general, ...input }));
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Everyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledWith('outbound', { name: 'Everyone', iconKey: 'briefcase', colorKey: 'blue' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Channel menu:/u }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    await screen.findByRole('menuitem', { name: 'Icon' });
    expect([...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim()))
      .toEqual(['Icon', 'Pinned in my sidebar']);
  });

  it('offers a Personal Channel no people, no audience switch and no archive', async () => {
    spaces.data = { waterline: 1, items: [{ ...outbound('participant').items[0]!, scope: 'individual' }] };
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole('menuitem', { name: 'Add people' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'More' }));
    await screen.findByRole('menuitem', { name: 'Icon' });
    expect([...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim()))
      .toEqual(['Icon', 'Pinned in my sidebar']);
  });

  it('offers its icon and colour in More, beside its settings', async () => {
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));

    await screen.findByRole('menuitem', { name: 'Icon' });
    expect([...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim()))
      .toEqual(['Icon', 'Pinned in my sidebar', 'Public to organization', 'Archive channel']);
  });

  it('makes the Channel private by turning off Public to organization, keeping the person who did it in it', async () => {
    api.updateSpaceAudience.mockImplementation(async () => ({ ...outbound('organization').items[0], scope: 'personal' }));
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    const toggle = await screen.findByRole('menuitemcheckbox', { name: 'Public to organization' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateSpaceAudience).toHaveBeenCalledWith('outbound', { scope: 'personal', participantUserIds: ['me'] }));
  });

  it('lets a participant leave a private Channel, which leaves their list', async () => {
    const colleague = { id: 'jordan', name: 'Jordan', email: 'jordan@rally.test', timezone: 'UTC' };
    const participants = [{ userId: 'me' }, { userId: 'jordan' }];
    spaces.data = { ...outbound('participant'), items: [{ ...outbound('participant').items[0], scope: 'personal', participants }] };
    api.getWorkspaceMembers.mockResolvedValue([workspace.currentUser, colleague] as never);
    api.updateSpaceAudience.mockResolvedValue(null);
    const { client } = renderChannel('/channels/outbound', (seeded) => seeded.setQueryData(['spaces'], spaces.data));
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Me actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the channel' }));
    expect(await screen.findByRole('heading', { name: 'Leave the channel?' })).toBeInTheDocument();
    expect(api.updateSpaceAudience).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(api.updateSpaceAudience).toHaveBeenCalledWith('outbound', { scope: 'personal', participantUserIds: ['jordan'] }));
    await waitFor(() => expect(client.getQueryData<{ items: unknown[] }>(['spaces'])?.items).toEqual([]));
    // The navigation away is rendered after the cache write commits, so it is
    // waited for too: asserting it in the same tick failed under a loaded full run.
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('/channels/outbound'));
  });

  it('closes a leave still being asked when another Channel opens, so it cannot leave that one', async () => {
    const colleague = { id: 'jordan', name: 'Jordan', email: 'jordan@rally.test', timezone: 'UTC' };
    const row = { ...outbound('participant').items[0]!, scope: 'personal', participants: [{ userId: 'me' }, { userId: 'jordan' }] };
    spaces.data = { waterline: 1, items: [row, { ...row, id: 'growth', name: 'Growth' }] };
    api.getWorkspaceMembers.mockResolvedValue([workspace.currentUser, colleague] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider>
      <MemoryRouter initialEntries={['/channels/outbound']}>
        <Link to="/channels/growth">to growth</Link>
        <Routes><Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" /></Routes>
      </MemoryRouter>
    </Tooltip.Provider></QueryClientProvider>);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Me actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the channel' }));
    expect(await screen.findByRole('heading', { name: 'Leave the channel?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'to growth', hidden: true }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Leave the channel?' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Channel menu: Growth' })).toBeInTheDocument();
    expect(api.updateSpaceAudience).not.toHaveBeenCalled();
  });

  it('keeps a participant in the Channel when they cancel leaving it', async () => {
    const colleague = { id: 'jordan', name: 'Jordan', email: 'jordan@rally.test', timezone: 'UTC' };
    spaces.data = { ...outbound('participant'), items: [{
      ...outbound('participant').items[0], scope: 'personal', participants: [{ userId: 'me' }, { userId: 'jordan' }],
    }] };
    api.getWorkspaceMembers.mockResolvedValue([workspace.currentUser, colleague] as never);
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Me actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the channel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Leave the channel?' })).toBeNull());
    expect(api.updateSpaceAudience).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound');
  });

  describe('read in a focused window', () => {
    const restore: Array<() => void> = [];
    beforeEach(() => {
      const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      restore.push(() => focus.mockRestore(), () => visibility.mockRestore());
    });
    afterEach(() => {
      restore.splice(0).forEach((undo) => undo());
    });

    it('acknowledges its newest placement when that is past the read position, and keeps the answer', async () => {
      api.acknowledgeChannelRead.mockResolvedValue(outboundStats({
        readThroughSequenceNumber: 2, firstUnreadSequenceNumber: null, hasUnread: false,
      }));
      const { client } = renderChannel('/channels/outbound', (seeded) => seeded.setQueryData(CHANNEL_STATS_QUERY_KEY, [outboundStats()]));

      await waitFor(() => expect(api.acknowledgeChannelRead).toHaveBeenCalledWith('outbound', 2));
      expect(api.acknowledgeChannelRead).toHaveBeenCalledTimes(1);
      // The same read, told to Activity, which settles the starts it covers.
      expect(api.recordActivityEvents).toHaveBeenCalledWith([
        { kind: 'read', subject: { kind: 'channel', channelId: 'outbound' }, through: 2 },
      ]);
      await waitFor(() => expect(client.getQueryData<ChannelStats[]>(CHANNEL_STATS_QUERY_KEY)?.[0])
        .toMatchObject({ readThroughSequenceNumber: 2, hasUnread: false }));
    });

    it('acknowledges nothing for a Channel already read through its newest placement, and still tells Activity once', async () => {
      renderChannel('/channels/outbound', (seeded) => seeded.setQueryData(CHANNEL_STATS_QUERY_KEY, [outboundStats({
        readThroughSequenceNumber: 2, firstUnreadSequenceNumber: null, hasUnread: false,
      })]));

      await screen.findByRole('button', { name: 'Q4 plan' });
      // Past the acknowledgement's debounce, so a send would have happened.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(api.acknowledgeChannelRead).not.toHaveBeenCalled();
      // Read elsewhere, or before Activity kept waterlines: Activity still owes the read.
      expect(api.recordActivityEvents).toHaveBeenCalledTimes(1);
      expect(api.recordActivityEvents).toHaveBeenCalledWith([
        { kind: 'read', subject: { kind: 'channel', channelId: 'outbound' }, through: 2 },
      ]);
    });

    it('puts the dot back when the read was not recorded, and does not try again', async () => {
      api.acknowledgeChannelRead.mockRejectedValue(new Error('offline'));
      const { client } = renderChannel('/channels/outbound', (seeded) => seeded.setQueryData(CHANNEL_STATS_QUERY_KEY, [outboundStats()]));

      await waitFor(() => expect(api.acknowledgeChannelRead).toHaveBeenCalledWith('outbound', 2));
      await waitFor(() => expect(client.getQueryData<ChannelStats[]>(CHANNEL_STATS_QUERY_KEY)?.[0]?.hasUnread).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(api.acknowledgeChannelRead).toHaveBeenCalledTimes(1);
    });
  });
});
