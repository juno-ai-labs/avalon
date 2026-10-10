import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHANNEL_STATS_QUERY_KEY, PINS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import type { SpaceConversationSummary, Workspace } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { NavigationSidebar } from './navigation-sidebar';

const api = vi.hoisted(() => ({
  getMyThreads: vi.fn(),
  getActivity: vi.fn(),
  markActivitySeen: vi.fn(async () => undefined),
  setPinned: vi.fn(),
  reorderPins: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));

const workspace = {
  id: 'org', name: 'Rally', region: 'global',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', role: 'owner', accessClass: 'member' },
} as unknown as Workspace;

function channel(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active', systemRole: null,
    revision: 1, reach: 'organization', participants: [], channelCount: 0, attentionCount: 0,
    defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
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
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [{ channelId: 'apple', threadCount: 1, lastActivityAt: null }]);
    });

    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
    expect(pinned.getAllByRole('button').map((row) => row.textContent)).toEqual(['Outbound0 threads', 'Growth0 threads']);
    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(all.getAllByRole('button').filter((row) => row.classList.contains('navigation-channel-row')).map((row) => row.textContent))
      .toEqual(['Apple1 thread', 'Zebra0 threads']);
  });

  it('opens a Channel on its own route', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: /Outbound/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound');
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

  it('groups Activity by day, marks what is new, and marks it read once shown', async () => {
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
    await waitFor(() => expect(api.markActivitySeen).toHaveBeenCalledWith(now.toISOString()));
  });
});
