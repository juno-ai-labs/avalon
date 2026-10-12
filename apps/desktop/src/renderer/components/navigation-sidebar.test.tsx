import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, PINS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import type { ChannelStats } from '@rally/contracts';
import type { SpaceConversationSummary, Workspace } from '../lib/types';
import { markDeepLinkWorkstreamNavigation } from '../lib/deep-link-navigation';
import type * as TelemetryModule from '../lib/telemetry';
import { useUiStore } from '../lib/ui-store';
import { NavigationSidebar } from './navigation-sidebar';

const api = vi.hoisted(() => ({
  getMyThreads: vi.fn(),
  getActivity: vi.fn(),
  markActivitySeen: vi.fn(async () => undefined),
  setPinned: vi.fn(),
  reorderPins: vi.fn(),
  getChannelStats: vi.fn(async () => []),
  getWorkspaceMembers: vi.fn(async () => [{ id: 'maya', name: 'Maya K', email: 'maya@rally.test', timezone: 'UTC' }]),
  restoreSpace: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));
const telemetry = vi.hoisted(() => ({
  markWorkstreamFeedOpenStarted: vi.fn(),
  markWorkstreamNavigation: vi.fn(),
  markSurfaceEntrypoint: vi.fn(),
  reportTelemetryProductIntent: vi.fn(),
}));
vi.mock('../lib/telemetry', async (original) => ({ ...await original<typeof TelemetryModule>(), ...telemetry }));
const warmup = vi.hoisted(() => ({ onPointerCancel: vi.fn(), onPointerEnter: vi.fn(), onPointerLeave: vi.fn() }));
const warmedThreads = vi.hoisted(() => [] as string[]);
vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketHoverWarmup: (threadId: string) => {
    warmedThreads.push(threadId);
    return warmup;
  },
  useWorkstreamSocketOpenContext: () => () => ({ state: 'retained_pair', socketLeaseId: 'lease-1' }),
}));

const workspace: Workspace = {
  id: 'org', name: 'Rally', region: 'enterprise', timezone: 'UTC',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', timezone: 'UTC', role: 'owner', accessClass: 'member' },
};

function channel(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active', systemRole: null,
    revision: 1, reach: 'organization', participants: [], channelCount: 0, attentionCount: 0,
    defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function stats(channelId: string, overrides: Partial<ChannelStats> = {}): ChannelStats {
  return {
    channelId, threadCount: 0, lastActivityAt: null,
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, firstUnreadSequenceNumber: null, hasUnread: false,
    ...overrides,
  };
}

function thread(id: string, title: string, overrides: Partial<SpaceConversationSummary> = {}): SpaceConversationSummary {
  return {
    id, title, titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null, nextPendingWakeup: null,
    participantUserIds: [], participantExtraCount: 0, spaceIds: ['outbound'], pinPosition: null,
    lastActivityAt: '2026-10-01T00:00:00.000Z', kind: 'channel', breakoutOf: null,
    ...overrides,
  } as SpaceConversationSummary;
}

/** Each thread row's name and second line. */
function threadRows(list: ReturnType<typeof within>): Array<[string | null | undefined, string | null | undefined]> {
  return list.getAllByRole('link').filter((row: HTMLElement) => row.classList.contains('navigation-thread-row'))
    .map((row: HTMLElement) => [row.querySelector('.navigation-row-title')?.textContent, row.querySelector('.navigation-row-detail')?.textContent]);
}

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-state={JSON.stringify(location.state)} data-testid="location">{location.pathname}{location.search}</div>;
}

function renderSidebar(seed: (client: QueryClient) => void, waiting = 0, { route = '/', person = workspace }: { route?: string; person?: Workspace } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={[route]}>
      <NavigationSidebar
        accessDecisionFailed={false}
        accessRequests={[]}
        accountMenu={<span>account</span>}
        attentionComplete
        attentionItems={Array.from({ length: waiting }, (_, index) => ({ key: `item-${index}` })) as never}
        downloadedUpdate={null}
        onDecideAccessRequest={vi.fn()}
        onOpenAccessRequest={vi.fn()}
        workspace={person}
      />
      <Routes><Route element={<Location />} path="*" /></Routes>
    </MemoryRouter>
  </Tooltip.Provider></QueryClientProvider>);
}

describe('the navigation sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useUiStore.getState().setSidebarSection('channels');
    useUiStore.getState().setThreadSort('recent');
    useUiStore.getState().setChannelSort('alphabetical');
    useUiStore.getState().setSidebarOpen(false);
  });

  it('lists pinned Channels in the person’s order, then every other Channel A–Z with its thread count', () => {
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
        channel('zebra', 'Zebra'), channel('apple', 'Apple'), channel('outbound', 'Outbound'), channel('growth', 'Growth'),
      ] });
      client.setQueryData(PINS_QUERY_KEY, [
        { kind: 'channel', id: 'outbound', parentId: null },
        { kind: 'channel', id: 'growth', parentId: null },
      ]);
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [stats('apple', { threadCount: 1 })]);
    });

    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
    expect(pinned.getAllByRole('link').map((row) => row.textContent)).toEqual(['Outbound0 threadsPinned, 1 of 2.', 'Growth0 threadsPinned, 2 of 2.']);
    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(all.getAllByRole('link').filter((row) => row.classList.contains('navigation-channel-row')).map((row) => row.textContent))
      .toEqual(['Apple1 thread', 'Zebra0 threads']);
  });

  it('reorders a pinned Channel from the keyboard and from its menu, not only by dragging', async () => {
    const pins = [
      { kind: 'channel' as const, id: 'outbound', parentId: null },
      { kind: 'channel' as const, id: 'growth', parentId: null },
    ];
    api.reorderPins.mockResolvedValue(pins);
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
      client.setQueryData(PINS_QUERY_KEY, pins);
    });
    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));

    fireEvent.keyDown(pinned.getByRole('link', { name: /Growth/u }), { key: 'ArrowUp', altKey: true });
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);

    fireEvent.contextMenu(pinned.getByRole('link', { name: /Outbound/u }));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);
  });

  it('keeps an empty Pinned section that says how to pin, and wakes it while a row is dragged', async () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
    const hint = pinned.getByText('Move a channel here to pin it').parentElement!;
    expect(hint).not.toHaveClass('is-armed');
    fireEvent.dragStart(screen.getByRole('link', { name: /Outbound/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
    expect(hint).toHaveClass('is-armed');
    fireEvent.dragEnd(screen.getByRole('link', { name: /Outbound/u }));
    expect(hint).not.toHaveClass('is-armed');

    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    expect(await within(await screen.findByRole('region', { name: 'Pinned threads' })).findByText('Move a thread here to pin it')).toBeInTheDocument();
  });

  it('says why a pin did not save', async () => {
    api.setPinned.mockRejectedValue(new ApiError('limit', 409, 'pin_limit_reached'));
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Outbound/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(await screen.findByText('You’ve pinned as many items as Rally allows. Unpin one first.')).toBeInTheDocument();
  });

  it('keeps archived Channels folded at the bottom, and restores one into the list', async () => {
    api.restoreSpace.mockResolvedValue(channel('hiring', 'Hiring'));
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
      client.setQueryData(INACTIVE_SPACES_QUERY_KEY, { waterline: 1, items: [channel('hiring', 'Hiring', { status: 'archived' })] });
    });
    const archived = within(screen.getByRole('region', { name: 'Archived channels' }));
    expect(archived.queryByText('Hiring')).not.toBeInTheDocument();
    fireEvent.click(archived.getByRole('button', { name: 'Show 1' }));
    fireEvent.click(archived.getByRole('button', { name: 'Restore' }));

    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(await all.findByRole('link', { name: /Hiring/u })).toBeInTheDocument();
    expect(api.restoreSpace).toHaveBeenCalledWith('hiring');
    expect(screen.queryByRole('region', { name: 'Archived channels' })).not.toBeInTheDocument();
  });

  it('opens a Channel on its own route', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('link', { name: /Outbound/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound');
  });

  it('closes the phone sheet when a Channel is opened from it, and keeps it open across sections', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('link', { name: /Outbound/u }));

    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the phone sheet on Escape and hands focus back to its button', () => {
    renderSidebar(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    fireEvent.keyDown(window, { key: 'Escape' });

    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('counts what is waiting on the Threads button', () => {
    renderSidebar(() => undefined, 3);
    expect(screen.getByRole('img', { name: '3 waiting' })).toHaveTextContent('3');
  });

  it('lists the person’s threads and breakouts, and opens a breakout beside its thread under that thread’s Channel', async () => {
    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('plan', 'Q4 plan', { lastActivityAt: '2026-10-02T00:00:00.000Z' }),
      thread('site', 'Make a website', {
        kind: 'breakout', lastActivityAt: '2026-10-03T00:00:00.000Z',
        breakoutOf: { workstreamId: 'plan', substreamId: 'site', title: 'Q4 plan' },
      }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const list = within(await screen.findByRole('region', { name: 'Recent threads' }));
    await waitFor(() => expect(threadRows(list)).toEqual([
      ['Make a website', '↳ Q4 plan · Outbound'],
      ['Q4 plan', 'Outbound'],
    ]));
    fireEvent.click(list.getByRole('link', { name: /Make a website/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/plan?substream=site');
  });

  it('names who started a thread from the member directory when the row carries only their id', async () => {
    useUiStore.getState().setSidebarSection('activity');
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [{
      id: 'started:plan', kind: 'thread_started', occurredAt: new Date().toISOString(), actorUserId: 'maya', actorLabel: '',
      threadId: 'plan', threadTitle: 'Q4 plan', breakout: null, channelIds: ['outbound'], unread: true,
    }] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    await waitFor(() => expect(today.getByRole('link')).toHaveTextContent('Maya K started Q4 plan'));
  });

  it('groups Activity by day, marks what is new, and marks it read once shown', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useUiStore.getState().setSidebarSection('activity');
    const now = new Date();
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [{
      id: 'event-1', kind: 'added', occurredAt: now.toISOString(), actorUserId: 'maya', actorLabel: 'Maya K',
      threadId: 'plan', threadTitle: 'Reply-handling playbook', breakout: null, channelIds: ['outbound'], unread: true,
    }] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    expect(today.getByRole('link')).toHaveTextContent('Maya K added you to Reply-handling playbook');
    expect(today.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    // A window in the background is not somebody looking: nothing is marked
    // until it takes focus.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.markActivitySeen).not.toHaveBeenCalled();
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(api.markActivitySeen).toHaveBeenCalledWith(now.toISOString()));
    hasFocus.mockRestore();
  });

  it('marks a thread unread for new messages, a mention or never having opened it, and not for what its run is doing', async () => {
    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('new', 'New messages', { hasUnread: true }),
      thread('named', 'Named', { youAreMentioned: true }),
      thread('unseen', 'Never opened', { unseen: true }),
      thread('running', 'Running', { harnessStatus: 'running' }),
      thread('both', 'In two', { spaceIds: ['outbound', 'growth'] }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] }));

    const list = within(await screen.findByRole('region', { name: 'Recent threads' }));
    await waitFor(() => expect(list.getByRole('link', { name: /New messages/u })).toBeInTheDocument());
    const unread = (name: string): boolean => within(list.getByRole('link', { name: new RegExp(name, 'u') })).queryByRole('img', { name: 'Unread' }) !== null;
    expect(['New messages', 'Named', 'Never opened', 'Running', 'In two'].map(unread)).toEqual([true, true, true, false, false]);
    expect(threadRows(list).find(([title]) => title === 'In two')).toEqual(['In two', 'Outbound · Growth']);
  });

  it('starts a thread from the Channel in view, or from General when none is', async () => {
    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
      channel('outbound', 'Outbound'), channel('general', 'General', { systemRole: 'general' }),
    ] }));

    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/general');
    // The composer may already be mounted, so the focus is asked for in the
    // navigation rather than left to its mount.
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', '{"focusComposer":true}');
  });

  it('opens New channel from the Channels header', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByRole('dialog', { name: 'New channel' })).toBeInTheDocument();
  });

  describe('the Activity tab’s filters', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);
    const item = (id: string, overrides: Record<string, unknown>) => ({
      id, kind: 'added', occurredAt: now.toISOString(), actorUserId: 'maya', actorLabel: 'Maya K',
      threadId: 'plan', threadTitle: id, breakout: null, channelIds: ['outbound'], unread: false, ...overrides,
    });
    const seed = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
    };

    beforeEach(() => {
      useUiStore.getState().setSidebarSection('activity');
      api.getActivity.mockImplementation(async (_cursor: string | null, only: string | null) => ({
        nextCursor: null,
        items: only === 'mentions'
          ? [item('Named here', { kind: 'mentioned' })]
          : [item('Fresh', { unread: true }), item('Old news', { occurredAt: earlier.toISOString() })],
      }));
    });

    it('shows only unread rows under Unread, and asks the server for mentions under Mentions', async () => {
      renderSidebar(seed);
      const titles = (): string[] => screen.queryAllByRole('link').filter((row) => row.classList.contains('activity-row'))
        .map((row) => row.querySelectorAll('strong')[1]?.textContent ?? '');
      await waitFor(() => expect(titles()).toEqual(['Fresh', 'Old news']));

      fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
      expect(titles()).toEqual(['Fresh']);

      fireEvent.click(screen.getByRole('button', { name: 'Mentions' }));
      await waitFor(() => expect(titles()).toEqual(['Named here']));
      expect(api.getActivity).toHaveBeenCalledWith(null, 'mentions', expect.anything());
    });

    it('clears every dot and moves the waterline on Mark all read', async () => {
      renderSidebar(seed);
      const today = within(await screen.findByRole('region', { name: 'Today' }));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(today.queryAllByRole('img', { name: 'Unread' })).toEqual([]));
      expect(api.markActivitySeen).toHaveBeenCalledWith(now.toISOString());
    });

    it('reads the feed again when Mark all read fails, so its dots come back', async () => {
      api.markActivitySeen.mockRejectedValueOnce(new Error('offline'));
      renderSidebar(seed);
      const today = within(await screen.findByRole('region', { name: 'Today' }));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));
      const reads = api.getActivity.mock.calls.length;

      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(api.getActivity.mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));
    });
  });

  describe('the Channels tab’s unread state and sort', () => {
    // Apple has never had a thread; Kiwi holds a thread that needs this
    // person; Mango has a placement this person has not seen; Zebra is the
    // most recently active and fully read.
    const seed = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
        channel('zebra', 'Zebra'), channel('apple', 'Apple'), channel('mango', 'Mango'), channel('kiwi', 'Kiwi', { attentionCount: 2 }),
      ] });
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [
        stats('zebra', { threadCount: 3, lastActivityAt: '2026-10-05T00:00:00.000Z', latestAttentionSequenceNumber: 3, readThroughSequenceNumber: 3 }),
        stats('mango', {
          threadCount: 1, lastActivityAt: '2026-10-03T00:00:00.000Z', latestAttentionSequenceNumber: 1,
          firstUnreadSequenceNumber: 1, hasUnread: true,
        }),
        stats('kiwi', { threadCount: 2, lastActivityAt: '2026-10-04T00:00:00.000Z', latestAttentionSequenceNumber: 2, readThroughSequenceNumber: 2 }),
      ]);
    };
    const names = (): Array<string | null | undefined> => within(screen.getByRole('region', { name: 'All channels' }))
      .getAllByRole('link')
      .filter((row) => row.classList.contains('navigation-channel-row'))
      .map((row) => row.querySelector('.navigation-row-title')?.textContent);

    it('marks only an unread Channel with a dot', () => {
      renderSidebar(seed);
      expect(within(screen.getByRole('link', { name: /Mango/u })).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
      expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(1);
    });

    it('cycles A–Z, Recent and Needs attention from the heading', () => {
      renderSidebar(seed);
      expect(names()).toEqual(['Apple', 'Kiwi', 'Mango', 'Zebra']);

      fireEvent.click(screen.getByRole('button', { name: 'Sorted by A–Z. Sort by Recent' }));
      expect(names()).toEqual(['Zebra', 'Kiwi', 'Mango', 'Apple']);

      fireEvent.click(screen.getByRole('button', { name: 'Sorted by Recent. Sort by Needs attention' }));
      expect(names()).toEqual(['Mango', 'Kiwi', 'Zebra', 'Apple']);
      expect(screen.getByRole('button', { name: 'Sorted by Needs attention. Sort by A–Z' })).toBeInTheDocument();
    });

    it('keeps the chosen order when the sidebar is drawn again', () => {
      const first = renderSidebar(seed);
      fireEvent.click(screen.getByRole('button', { name: 'Sorted by A–Z. Sort by Recent' }));
      first.unmount();

      renderSidebar(seed);
      expect(screen.getByRole('button', { name: 'Sorted by Recent. Sort by Needs attention' })).toBeInTheDocument();
      expect(names()).toEqual(['Zebra', 'Kiwi', 'Mango', 'Apple']);
    });
  });
  describe('list motion', () => {
    const animate = vi.fn((element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      void element; void keyframes; void options;
      return { cancel: vi.fn(), onfinish: null, oncancel: null };
    });
    const measure = Element.prototype.getBoundingClientRect;

    // `animate` is deleted rather than restored because jsdom never defined
    // it; the measurement jsdom does define goes back as it was.
    beforeEach(() => {
      animate.mockClear();
      Element.prototype.animate = function animateStub(
        this: Element,
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ): Animation {
        return animate(this, keyframes as Keyframe[], options as KeyframeAnimationOptions) as unknown as Animation;
      };
      // jsdom lays nothing out: rows and headings sit one slot apart in
      // document order under the scroll box.
      Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
        const scroll = this.closest('.sidebar-scroll');
        const index = scroll === null || scroll === this
          ? 0
          : [...scroll.querySelectorAll('[data-motion-key]')].indexOf(this);
        const top = index * 48;
        return { top, left: 8, right: 288, bottom: top + 48, width: 280, height: 48, x: 8, y: top, toJSON: () => ({}) };
      };
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).animate;
      Element.prototype.getBoundingClientRect = measure;
    });

    function playedOn(key: string): { element: HTMLElement; keyframes: Keyframe[] } | undefined {
      const call = animate.mock.calls.find(([element]) => (element as HTMLElement).dataset.motionKey === key);
      return call ? { element: call[0] as HTMLElement, keyframes: call[1] } : undefined;
    }

    const fruit = { waterline: 1, items: [channel('apple', 'Apple'), channel('mango', 'Mango'), channel('zebra', 'Zebra')] };

    it('moves a pinned Channel up into Pinned, and shifts the rows it passed', async () => {
      api.setPinned.mockResolvedValue([{ kind: 'channel', id: 'zebra', parentId: null }]);
      renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, fruit));

      fireEvent.contextMenu(screen.getByRole('link', { name: /Zebra/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
      await pinned.findByRole('link', { name: /Zebra/u });

      // Zebra rises three slots, from last under All channels to first under
      // Pinned: the row the Pinned section now renders is the one that plays.
      const moved = playedOn('channel:zebra');
      expect(screen.getByRole('region', { name: 'Pinned channels' })).toContainElement(moved!.element);
      expect(moved!.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 144px)' }));
      expect(playedOn('channel:apple')?.keyframes).toEqual([{ transform: 'translate(0px, -48px)' }, { transform: 'translate(0px, 0px)' }]);
    });

    it('moves a restored Channel from Archived up into the list', async () => {
      api.restoreSpace.mockResolvedValue(channel('hiring', 'Hiring'));
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
        client.setQueryData(INACTIVE_SPACES_QUERY_KEY, { waterline: 1, items: [channel('hiring', 'Hiring', { status: 'archived' })] });
      });
      const archived = within(screen.getByRole('region', { name: 'Archived channels' }));
      fireEvent.click(archived.getByRole('button', { name: 'Show 1' }));
      fireEvent.click(archived.getByRole('button', { name: 'Restore' }));
      await within(screen.getByRole('region', { name: 'All channels' })).findByRole('link', { name: /Hiring/u });

      // From the fourth slot (under Archived) to the second (above Outbound).
      expect(playedOn('channel:hiring')?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
    });

    it('pins a row dragged into Pinned at the slot held open for it', async () => {
      api.setPinned.mockResolvedValue(['apple', 'mango', 'zebra'].map((id) => ({ kind: 'channel', id, parentId: null })));
      api.reorderPins.mockResolvedValue(['apple', 'zebra', 'mango'].map((id) => ({ kind: 'channel', id, parentId: null })));
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, fruit);
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'channel', id: 'apple', parentId: null },
          { kind: 'channel', id: 'mango', parentId: null },
        ]);
      });
      const section = screen.getByRole('region', { name: 'Pinned channels' });
      const zebra = within(screen.getByRole('region', { name: 'All channels' })).getByRole('link', { name: /Zebra/u });
      fireEvent.dragStart(zebra, { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });

      // The Pinned heading is slot 0, Apple 1 and Mango 2: a pointer past
      // Apple's middle and short of Mango's holds the slot between them.
      const over = createEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      Object.defineProperty(over, 'clientY', { value: 100 });
      fireEvent(section, over);
      const ghost = section.querySelector('.is-pin-ghost');
      expect(ghost).toHaveTextContent('Zebra');
      expect([...section.querySelectorAll('.navigation-channel-row')].map((row) => row.textContent?.slice(0, 5)))
        .toEqual(['Apple', 'Zebra', 'Mango']);

      fireEvent.drop(section);
      // A new pin is appended, so the slot it was dropped in is saved after.
      await waitFor(() => expect(api.reorderPins).toHaveBeenCalledWith('channel', ['apple', 'zebra', 'mango']));
      expect(api.setPinned).toHaveBeenCalledWith('channel', 'zebra', true, undefined);
      await waitFor(() => expect(within(section).getAllByRole('link').filter((row) => row.classList.contains('navigation-channel-row'))
        .map((row) => row.textContent?.slice(0, 5))).toEqual(['Apple', 'Zebra', 'Mango']));
      expect(section.querySelector('.is-pin-ghost')).toBeNull();
    });

    it('lets a row pinned by dragging be unpinned back into its list', async () => {
      const pinnedList = [{ kind: 'channel' as const, id: 'zebra', parentId: null }];
      api.setPinned.mockResolvedValueOnce(pinnedList).mockResolvedValueOnce([]);
      renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, fruit));
      const section = screen.getByRole('region', { name: 'Pinned channels' });
      const all = within(screen.getByRole('region', { name: 'All channels' }));
      fireEvent.dragStart(all.getByRole('link', { name: /Zebra/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
      fireEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      fireEvent.drop(section);
      const pinnedZebra = await within(section).findByRole('link', { name: /Zebra/u });

      fireEvent.contextMenu(pinnedZebra);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
      expect(await all.findByRole('link', { name: /Zebra/u })).toBeInTheDocument();
      expect(within(section).queryByRole('link', { name: /Zebra/u })).not.toBeInTheDocument();
    });

    it('holds the dragged row, and drops it in the slot laid out under the pointer', () => {
      const pins = fruit.items.map((item) => ({ kind: 'channel' as const, id: item.id, parentId: null }));
      api.reorderPins.mockResolvedValue(pins);
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, fruit);
        client.setQueryData(PINS_QUERY_KEY, pins);
      });
      const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
      const zebra = pinned.getByRole('link', { name: /Zebra/u });
      fireEvent.dragStart(zebra, { dataTransfer: { effectAllowed: 'all' } });
      expect(zebra).toHaveAttribute('data-motion-hold');

      // The event reaches Apple, but the pointer is in Mango's laid-out slot
      // (the Pinned heading is slot 0, Apple 1, Mango 2): a row drawn there
      // mid-motion is not the slot's owner.
      // jsdom has no DragEvent, so the pointer's position is set by hand.
      const apple = pinned.getByRole('link', { name: /Apple/u });
      const over = createEvent.dragOver(apple);
      Object.defineProperty(over, 'clientY', { value: 100 });
      fireEvent(apple, over);
      fireEvent.drop(zebra);
      expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['apple', 'zebra', 'mango']);
    });
  });

  describe('what the old sidebar did', () => {
    const plan = thread('00000000-0000-4000-8000-000000000020', 'Q4 plan', { spaceIds: ['outbound'] });
    const seedThreads = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
    };

    const scrollIntoView = vi.fn();

    // Installed and removed in hooks, so a failing assertion cannot leak the
    // stub into later tests. jsdom never defined it, so it is deleted.
    beforeEach(() => {
      useUiStore.getState().setSidebarSection('threads');
      warmedThreads.length = 0;
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it('gives a guest no Channels section, even when Channels was the section last chosen', async () => {
      useUiStore.getState().setSidebarSection('channels');
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads, 0, { person: { ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } } });
      expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
      expect(await screen.findByRole('region', { name: 'Recent threads' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'All channels' })).not.toBeInTheDocument();
    });

    it('draws rows as links, so a modified click can open one in a new tab', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      expect(await screen.findByRole('link', { name: /Q4 plan/u })).toHaveAttribute('href', `/channels/outbound/threads/${plan.id}`);
    });

    it('starts the open measurement on a plain click, and not for the open thread clicked again', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      fireEvent.click(await screen.findByRole('link', { name: /Q4 plan/u }));
      expect(screen.getByTestId('location')).toHaveTextContent(`/channels/outbound/threads/${plan.id}`);
      expect(telemetry.markWorkstreamFeedOpenStarted).toHaveBeenCalledWith(plan.id, 'recent', 'retained_pair', expect.any(Number), 'lease-1');
      expect(telemetry.markWorkstreamNavigation).toHaveBeenCalledWith(plan.id, false);
      expect(telemetry.markSurfaceEntrypoint).toHaveBeenCalledWith('sidebar_recent');

      fireEvent.click(screen.getByRole('link', { name: /Q4 plan/u }));
      expect(telemetry.markWorkstreamFeedOpenStarted).toHaveBeenCalledTimes(1);
    });

    it('warms a thread’s socket while the pointer rests on its row', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      const row = await screen.findByRole('link', { name: /Q4 plan/u });
      expect(warmedThreads).toContain(plan.id);
      fireEvent.pointerEnter(row);
      expect(warmup.onPointerEnter).toHaveBeenCalled();
      fireEvent.pointerLeave(row);
      expect(warmup.onPointerLeave).toHaveBeenCalled();
    });

    it('reports a thread pin once it saves', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      api.setPinned.mockResolvedValue([{ kind: 'thread', id: plan.id, parentId: null }]);
      renderSidebar(seedThreads);
      fireEvent.contextMenu(await screen.findByRole('link', { name: /Q4 plan/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith({
        kind: 'workstream_action_completed', workstreamId: plan.id, action: 'pin', visibility: 'public', origin: 'ad_hoc', pinned: true,
      }));
    });

    it('scrolls to a row a pin moved, and gives it focus when the move left focus nowhere', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      api.setPinned.mockResolvedValue([{ kind: 'thread', id: plan.id, parentId: null }]);
      renderSidebar(seedThreads);
      fireEvent.contextMenu(await screen.findByRole('link', { name: /Q4 plan/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      const pinned = within(screen.getByRole('region', { name: 'Pinned threads' }));
      const row = await pinned.findByRole('link', { name: /Q4 plan/u });
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(row));
      expect(row).toHaveFocus();
    });

    it('shows a timer on a thread with a wake-up coming', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [{
        ...plan, nextPendingWakeup: { dueAt: '2026-10-13T09:00:00.000Z', promptPreview: 'Check the replies' },
      }] });
      renderSidebar(seedThreads);
      expect(await screen.findByRole('img', { name: /^Active timer\. Next: .+\. Check the replies$/u })).toBeInTheDocument();
    });

    it('holds a thread Rally is still naming in place of its provisional title', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [{
        ...plan, title: 'can you plan q4 for me', titleStatus: 'naming', createdAt: new Date().toISOString(),
      }] });
      renderSidebar(seedThreads);
      const list = within(await screen.findByRole('region', { name: 'Recent threads' }));
      expect(await list.findByText('Rally is choosing a name')).toBeInTheDocument();
      expect(list.queryByText('can you plan q4 for me')).not.toBeInTheDocument();
    });

    it('draws placeholder rows while the first page loads', () => {
      api.getMyThreads.mockReturnValue(new Promise(() => undefined));
      renderSidebar(seedThreads);
      expect(screen.getByRole('region', { name: 'Recent threads' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('region', { name: 'Recent threads' }).querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
    });

    it('loads pages until a thread opened from a link is listed, then scrolls it into view', async () => {
      const linked = thread('00000000-0000-4000-8000-000000000099', 'Linked thread');
      api.getMyThreads
        .mockResolvedValueOnce({ nextCursor: 'page-2', items: [plan] })
        .mockResolvedValueOnce({ nextCursor: null, items: [linked] });
      markDeepLinkWorkstreamNavigation(linked.id);
      renderSidebar(seedThreads, 0, { route: `/channels/outbound/threads/${linked.id}` });
      const row = await screen.findByRole('link', { name: /Linked thread/u });
      expect(api.getMyThreads).toHaveBeenLastCalledWith('page-2', expect.anything());
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(row));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    });

    it('counts a pinned breakout’s place past the pinned threads, and offers no reorder when neither kind can move', async () => {
      const site = thread('00000000-0000-4000-8000-000000000030', 'Make a website', {
        kind: 'breakout', breakoutOf: { workstreamId: plan.id, substreamId: 'site', title: 'Q4 plan' },
      });
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan, site] });
      renderSidebar((client) => {
        seedThreads(client);
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'thread', id: plan.id, parentId: null },
          { kind: 'breakout', id: site.id, parentId: plan.id },
        ]);
      });
      const pinned = within(screen.getByRole('region', { name: 'Pinned threads' }));
      expect(await pinned.findByText('Pinned, 1 of 2.')).toBeInTheDocument();
      expect(pinned.getByText('Pinned, 2 of 2.')).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Pinned threads' })).not.toHaveAttribute('aria-describedby');
    });

    it('does not save an older drop’s order over a pin written after it', async () => {
      let answer!: (list: unknown) => void;
      api.setPinned
        .mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }))
        .mockResolvedValueOnce([
          { kind: 'thread', id: plan.id, parentId: null },
          { kind: 'thread', id: '00000000-0000-4000-8000-000000000031', parentId: null },
        ]);
      const other = thread('00000000-0000-4000-8000-000000000031', 'Hiring loop');
      const first = thread('00000000-0000-4000-8000-000000000032', 'Launch notes');
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan, other, first] });
      renderSidebar((client) => {
        seedThreads(client);
        client.setQueryData(PINS_QUERY_KEY, [{ kind: 'thread', id: first.id, parentId: null }]);
      });
      // Drop Q4 plan above Launch notes, then pin Hiring loop from its menu
      // while the drop's pin is still in flight.
      const section = screen.getByRole('region', { name: 'Pinned threads' });
      const list = within(await screen.findByRole('region', { name: 'Recent threads' }));
      fireEvent.dragStart(await list.findByRole('link', { name: /Q4 plan/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
      const over = createEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      Object.defineProperty(over, 'clientY', { value: -1 });
      fireEvent(section, over);
      fireEvent.drop(section);
      fireEvent.contextMenu(list.getByRole('link', { name: /Hiring loop/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(api.setPinned).toHaveBeenCalledTimes(2));

      answer([{ kind: 'thread', id: first.id, parentId: null }, { kind: 'thread', id: plan.id, parentId: null }]);
      await waitFor(() => expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({ workstreamId: plan.id, action: 'pin' })));
      expect(api.reorderPins).not.toHaveBeenCalled();
    });

    it('tells a screen reader how to reorder, once for the section', () => {
      useUiStore.getState().setSidebarSection('channels');
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'channel', id: 'outbound', parentId: null },
          { kind: 'channel', id: 'growth', parentId: null },
        ]);
      });
      expect(screen.getByRole('region', { name: 'Pinned channels' }))
        .toHaveAccessibleDescription('Hold Alt and press the up or down arrow to move a pinned channel.');
    });
  });
});
