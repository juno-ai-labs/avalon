import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelStats } from '@rally/contracts';
import { CHANNEL_STATS_QUERY_KEY } from '../lib/sidebar-list-store';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { ChannelScreen } from './channel';

const api = vi.hoisted(() => ({
  getChannelFeed: vi.fn(),
  getWorkspaceMembers: vi.fn(async () => []),
  archiveSpace: vi.fn(),
  updateSpacePresentation: vi.fn(),
  updateSpaceAudience: vi.fn(),
  acknowledgeChannelRead: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: null }) }));
const spaces = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces, inactive: { data: undefined } }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));
vi.mock('../components/channel-composer', () => ({
  ChannelComposer: ({ threadOpen }: { threadOpen?: boolean }) => <div data-thread-open={String(threadOpen)}>composer</div>,
}));
// The thread pane, with the Channel crumb it would draw once it is off screen.
vi.mock('./workstream', async () => {
  const { useChannelPane } = await import('../lib/navigation-routes');
  return {
    WorkstreamScreen: () => {
      const pane = useChannelPane();
      return <div>thread pane{pane && <button onClick={pane.crumb.onSelect} type="button">Channel crumb</button>}</div>;
    },
  };
});

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
    channelId: 'outbound', threadCount: 2, newThreadCount: 1, lastActivityAt: '2026-10-03T00:00:00.000Z',
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
    fireEvent.click(screen.getByRole('button', { name: 'Private thread, request access' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/secret');
  });

  it('opens the Channel alone from its crumb, leaving the thread and its breakout', async () => {
    renderChannel('/channels/outbound/threads/plan?substream=rollout');

    fireEvent.click(await screen.findByRole('button', { name: 'Channel crumb' }));

    expect(screen.getByTestId('location')).toHaveTextContent(/^\/channels\/outbound$/u);
    expect(screen.queryByText('thread pane')).toBeNull();
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
      { kind: 'locked', placedAt: '2026-09-20T12:00:00.000Z', attentionSequenceNumber: 1, threadId: 'secret' },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Threads in Outbound' }));
    await feed.findAllByRole('listitem');
    expect(feed.getAllByRole('separator')).toHaveLength(2);
  });

  it('keeps the same date in different years apart', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2025-10-02T12:00:00.000Z', attentionSequenceNumber: 2, thread: plan },
      { kind: 'locked', placedAt: '2024-10-02T12:00:00.000Z', attentionSequenceNumber: 1, threadId: 'secret' },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Threads in Outbound' }));
    await feed.findAllByRole('listitem');
    expect(feed.getAllByRole('separator')).toHaveLength(2);
  });

  it('names somebody it cannot look up as someone, not Rally', async () => {
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, createdByUserId: 'gone' } },
    ] });
    renderChannel();
    const feed = within(await screen.findByRole('list', { name: 'Threads in Outbound' }));
    expect((await feed.findAllByRole('listitem'))[0]).toHaveTextContent('Someone');
  });

  it('renders a thread’s summary as its message would, a member named in it as a mention chip', async () => {
    const alex = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    api.getWorkspaceMembers.mockResolvedValueOnce([
      { id: alex, name: 'Alex Todorovic', email: 'alex@rally.test', role: 'member' },
    ] as never);
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: { ...plan, objective: '@Alex Todorovic @Nobody here are the **mockups**' } },
    ] });
    const { container } = renderChannel();
    await waitFor(() => expect(container.querySelector('.channel-feed-summary .mention-chip')).not.toBeNull());
    const summary = container.querySelector('.channel-feed-summary')!;
    expect(summary.querySelectorAll('.mention-chip')).toHaveLength(1);
    expect(summary.querySelector('.mention-chip')).toHaveAttribute('data-person-id', alex);
    expect(summary.querySelector('.mention-chip-label')).toHaveTextContent('Alex Todorovic');
    expect(summary.querySelector('strong')).toHaveTextContent('mockups');
    expect(summary).toHaveTextContent('Alex Todorovic @Nobody here are the mockups');
  });

  it('offers no composer to somebody who reaches the Channel only through a thread in it', async () => {
    spaces.data = outbound('through_channel');
    renderChannel();
    await screen.findByRole('list', { name: 'Threads in Outbound' });
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
      await screen.findByRole('list', { name: 'Threads in Outbound' });
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
    expect(screen.getByTestId('location')).not.toHaveTextContent('/channels/outbound');
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
