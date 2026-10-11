import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelStats } from '@rally/contracts';
import { CHANNEL_STATS_QUERY_KEY } from '../lib/sidebar-list-store';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { ChannelScreen } from './channel';

const api = vi.hoisted(() => ({
  getChannelFeed: vi.fn(),
  getWorkspaceMembers: vi.fn(async () => []),
  archiveSpace: vi.fn(),
  acknowledgeChannelRead: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: null }) }));
const spaces = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces, inactive: { data: undefined } }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));
vi.mock('../components/channel-composer', () => ({
  ChannelComposer: ({ threadOpen }: { threadOpen?: boolean }) => <div data-thread-open={String(threadOpen)}>composer</div>,
}));
vi.mock('./workstream', () => ({ WorkstreamScreen: () => <div>thread pane</div> }));

const workspace: Workspace = {
  id: 'org', name: 'Rally', region: 'enterprise', timezone: 'UTC',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', timezone: 'UTC', role: 'member', accessClass: 'member' },
};

function outbound(reach: 'organization' | 'participant' | 'through_channel') {
  return { waterline: 1, items: [{
    id: 'outbound', name: 'Outbound', iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active',
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
    channelId: 'outbound', threadCount: 2, lastActivityAt: '2026-10-03T00:00:00.000Z',
    latestAttentionSequenceNumber: 2, readThroughSequenceNumber: 1, firstUnreadSequenceNumber: 2, hasUnread: true,
    ...overrides,
  };
}

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderChannel(path = '/channels/outbound', seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  const view = render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" /></Routes>
      <Routes><Route element={<Location />} path="*" /></Routes>
    </MemoryRouter>
  </Tooltip.Provider></QueryClientProvider>);
  return { ...view, client };
}

describe('a Channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spaces.data = outbound('organization');
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'locked', placedAt: '2026-10-03T00:00:00.000Z', attentionSequenceNumber: 2, threadId: 'secret' },
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: plan },
    ] });
  });

  it('lists its threads oldest first down to now, a locked one as nothing but a request for access', async () => {
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Threads in Outbound' }));
    const rows = await feed.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('A four-week outbound setup plan.');
    expect(within(rows[0]!).getByRole('button', { name: 'Q4 plan' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Private thread');
    expect(within(rows[1]!).getByRole('button')).toHaveTextContent('Request access');
    expect(screen.getByText('composer')).toBeInTheDocument();
  });

  it('opens a thread beside the Channel from its chip, and the request for a locked one at its address', async () => {
    renderChannel();
    fireEvent.click(await screen.findByRole('button', { name: 'Q4 plan' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/plan');
    expect(await screen.findByText('thread pane')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/secret');
  });

  it('hands the composer focus and paste back while a thread is open beside it', async () => {
    renderChannel();
    expect(await screen.findByText('composer')).toHaveAttribute('data-thread-open', 'false');
    fireEvent.click(await screen.findByRole('button', { name: 'Q4 plan' }));
    expect(await screen.findByText('composer')).toHaveAttribute('data-thread-open', 'true');
  });

  it('names somebody it cannot look up as someone, not Rally', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, createdByUserId: 'gone' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Threads in Outbound' }));
    expect((await feed.findAllByRole('listitem'))[0]).toHaveTextContent('Someone');
  });

  it('offers no composer to somebody who reaches the Channel only through a thread in it', async () => {
    spaces.data = outbound('through_channel');
    renderChannel();
    await screen.findByRole('list', { name: 'Threads in Outbound' });
    expect(screen.queryByText('composer')).not.toBeInTheDocument();
  });

  it('archives from its title menu after asking, and leaves for the landing', async () => {
    api.archiveSpace.mockResolvedValue({ ...outbound('organization').items[0], status: 'archived' });
    renderChannel();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Channel menu: Outbound' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive channel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/u));
    expect(api.archiveSpace).toHaveBeenCalledWith('outbound');
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
      await waitFor(() => expect(client.getQueryData<ChannelStats[]>(CHANNEL_STATS_QUERY_KEY)?.[0])
        .toMatchObject({ readThroughSequenceNumber: 2, hasUnread: false }));
    });

    it('sends nothing for a Channel already read through its newest placement', async () => {
      renderChannel('/channels/outbound', (seeded) => seeded.setQueryData(CHANNEL_STATS_QUERY_KEY, [outboundStats({
        readThroughSequenceNumber: 2, firstUnreadSequenceNumber: null, hasUnread: false,
      })]));

      await screen.findByRole('button', { name: 'Q4 plan' });
      // Past the acknowledgement's debounce, so a send would have happened.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(api.acknowledgeChannelRead).not.toHaveBeenCalled();
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
