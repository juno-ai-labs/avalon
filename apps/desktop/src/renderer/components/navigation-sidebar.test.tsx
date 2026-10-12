import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, PINS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import type { ChannelStats } from '@rally/contracts';
import type { SpaceConversationSummary, Workspace } from '../lib/types';
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

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderSidebar(seed: (client: QueryClient) => void, waiting = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={['/']}>
      <NavigationSidebar
        accessDecisionFailed={false}
        accessRequests={[]}
        accountMenu={<span>account</span>}
        attentionComplete
        attentionItems={Array.from({ length: waiting }, (_, index) => ({ key: `item-${index}` })) as never}
        downloadedUpdate={null}
        onDecideAccessRequest={vi.fn()}
        onOpenAccessRequest={vi.fn()}
        workspace={workspace}
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
    expect(pinned.getAllByRole('button').map((row) => row.textContent)).toEqual(['Outbound0 threads', 'Growth0 threads']);
    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(all.getAllByRole('button').filter((row) => row.classList.contains('navigation-channel-row')).map((row) => row.textContent))
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

    fireEvent.keyDown(pinned.getByRole('button', { name: /Growth/u }), { key: 'ArrowUp', altKey: true });
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);

    fireEvent.contextMenu(pinned.getByRole('button', { name: /Outbound/u }));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);
  });

  it('says why a pin did not save', async () => {
    api.setPinned.mockRejectedValue(new ApiError('limit', 409, 'pin_limit_reached'));
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /Outbound/u }));
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
    expect(await all.findByRole('button', { name: /Hiring/u })).toBeInTheDocument();
    expect(api.restoreSpace).toHaveBeenCalledWith('hiring');
    expect(screen.queryByRole('region', { name: 'Archived channels' })).not.toBeInTheDocument();
  });

  it('opens a Channel on its own route', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: /Outbound/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound');
  });

  it('closes the phone sheet when a Channel is opened from it, and keeps it open across sections', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Outbound/u }));

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

    const list = within(await screen.findByRole('region', { name: 'Threads' }));
    await waitFor(() => expect(list.getAllByRole('button').filter((row) => row.classList.contains('navigation-thread-row'))
      .map((row) => row.textContent)).toEqual(['Make a websiteQ4 plan', 'Q4 planOutbound']));
    fireEvent.click(list.getByRole('button', { name: /Make a website/u }));
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
    await waitFor(() => expect(today.getByRole('button')).toHaveTextContent('Maya K started Q4 plan'));
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
    expect(today.getByRole('button')).toHaveTextContent('Maya K added you to Reply-handling playbook');
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
      .getAllByRole('button')
      .filter((row) => row.classList.contains('navigation-channel-row'))
      .map((row) => row.querySelector('.navigation-row-title')?.textContent);

    it('marks only an unread Channel with a dot', () => {
      renderSidebar(seed);
      expect(within(screen.getByRole('button', { name: /Mango/u })).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
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

      fireEvent.contextMenu(screen.getByRole('button', { name: /Zebra/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await screen.findByRole('region', { name: 'Pinned channels' });

      // Zebra rises two slots, from last under All channels to first under
      // Pinned: the row the Pinned section now renders is the one that plays.
      const moved = playedOn('channel:zebra');
      expect(screen.getByRole('region', { name: 'Pinned channels' })).toContainElement(moved!.element);
      expect(moved!.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
      expect(playedOn('channel:apple')?.keyframes).toEqual([{ transform: 'translate(0px, -96px)' }, { transform: 'translate(0px, 0px)' }]);
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
      await within(screen.getByRole('region', { name: 'All channels' })).findByRole('button', { name: /Hiring/u });

      // From the fourth slot (under Archived) to the second (above Outbound).
      expect(playedOn('channel:hiring')?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
    });

    it('holds the dragged row, and drops it in the slot laid out under the pointer', () => {
      const pins = fruit.items.map((item) => ({ kind: 'channel' as const, id: item.id, parentId: null }));
      api.reorderPins.mockResolvedValue(pins);
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, fruit);
        client.setQueryData(PINS_QUERY_KEY, pins);
      });
      const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
      const zebra = pinned.getByRole('button', { name: /Zebra/u });
      fireEvent.dragStart(zebra, { dataTransfer: { effectAllowed: 'all' } });
      expect(zebra).toHaveAttribute('data-motion-hold');

      // The event reaches Apple, but the pointer is in Mango's laid-out slot
      // (the Pinned heading is slot 0, Apple 1, Mango 2): a row drawn there
      // mid-motion is not the slot's owner.
      // jsdom has no DragEvent, so the pointer's position is set by hand.
      const apple = pinned.getByRole('button', { name: /Apple/u });
      const over = createEvent.dragOver(apple);
      Object.defineProperty(over, 'clientY', { value: 100 });
      fireEvent(apple, over);
      fireEvent.drop(zebra);
      expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['apple', 'zebra', 'mango']);
    });
  });
});
