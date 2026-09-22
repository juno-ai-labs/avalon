import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SpaceSummarySchema, asSpaceId, type SpaceSummary } from '@rally/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import type * as SidebarListStore from '../lib/sidebar-list-store';
import { SpaceDashboardScreen } from './space-dashboard';
import type { SpaceConversationSummary, Workspace } from '../lib/types';

const api = vi.hoisted(() => ({
  archiveSpace: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  listResources: vi.fn(),
  listSpaceChannels: vi.fn(),
  restoreSpace: vi.fn(),
  updateSpaceAudience: vi.fn(),
  updateSpacePresentation: vi.fn(),
}));
const removedDataHooks = vi.hoisted(() => ({
  useSocketOwnedList: vi.fn(() => ({ data: [] })),
  useWorkstreamsQuery: vi.fn(() => ({ data: [] })),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/sidebar-list-store', async (importOriginal) => ({
  ...await importOriginal<typeof SidebarListStore>(),
  useSocketOwnedList: removedDataHooks.useSocketOwnedList,
}));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: removedDataHooks.useWorkstreamsQuery }));
vi.mock('../lib/workstream-landing', () => ({ useOpenFirstWorkstream: () => () => undefined }));
/** Null unless a test wants the screen to think the directory is the local cache's. */
const workspaceSocket = vi.hoisted(() => ({
  current: null as null | { sidebarConnect: null | { generation: number }; state: 'connecting' | 'connected' | 'unavailable' },
}));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => workspaceSocket.current }));

const member = {
  id: '00000000-0000-7000-8000-000000000002',
  name: 'Adam Juhasz',
  email: 'adam@example.com',
  timezone: 'America/Los_Angeles',
};
const workspace = {
  id: 'workspace-1',
  name: 'Rally Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser: { ...member, role: 'member' },
} as Workspace;

function makeSpace(overrides: Record<string, unknown> = {}): SpaceSummary {
  return SpaceSummarySchema.parse({
    id: asSpaceId('019d3c99-63cc-7a88-8eb4-bf54b091be06'),
    name: 'Hiring',
    iconKey: 'briefcase',
    colorKey: 'green',
    scope: 'personal',
    status: 'active',
    systemRole: null,
    revision: 1,
    reach: 'participant',
    participants: [{ userId: member.id }],
    channelCount: 0,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  });
}

const hiring = makeSpace();

/** One Channel as the dashboard's page answers it. */
function channelRow(overrides: Record<string, unknown> = {}): SpaceConversationSummary {
  return {
    id: '00000000-0000-7000-8000-0000000000e1',
    title: 'Ship the launch',
    lastActivityAt: '2026-08-27T01:00:00.000Z',
    spaceIds: [hiring.id as string],
    kind: 'channel',
    breakoutOf: null,
    appearance: { icon: 'rocket', color: 'blue' },
    ...overrides,
  } as SpaceConversationSummary;
}

/** One breakout as the same page answers it, beside its Channel. */
function breakoutRow(overrides: Record<string, unknown> = {}): SpaceConversationSummary {
  return {
    id: '00000000-0000-7000-8000-0000000000e9',
    title: 'Pricing',
    lastActivityAt: '2026-08-27T02:00:00.000Z',
    spaceIds: [hiring.id as string],
    kind: 'breakout',
    appearance: { icon: 'sparkles', color: 'rose' },
    breakoutOf: {
      workstreamId: '00000000-0000-7000-8000-0000000000e1',
      substreamId: '00000000-0000-7000-8000-0000000000e9',
      title: 'Ship the launch',
      appearance: { icon: 'rocket', color: 'blue' },
    },
    ...overrides,
  } as SpaceConversationSummary;
}

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

/**
 * The screen, plus the two handles a test needs: the cache it reads, and a
 * re-render — the socket is a module-level double, so a reconnect is a change
 * to that double followed by a render rather than an event.
 */
function renderSpace(summary = hiring, options: { ready?: boolean } = {}): {
  queryClient: QueryClient;
  rerender: () => void;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const active = summary.status === 'active';
  queryClient.setQueryData(['spaces'], { waterline: 1, items: active ? [summary] : [] });
  queryClient.setQueryData(['spaces-inactive'], { waterline: 1, items: active ? [] : [summary] });
  queryClient.setQueryData(['spaces-ready'], options.ready ?? true);
  const tree = (): React.JSX.Element => (
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/spaces/${summary.id}`]}>
          <Routes>
            <Route element={<SpaceDashboardScreen workspace={workspace} />} path="/spaces/:spaceId" />
            <Route element={<Location />} path="*" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>
  );
  const { rerender } = render(tree());
  return { queryClient, rerender: () => rerender(tree()) };
}

describe('the Space dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceSocket.current = null;
    api.getWorkspaceMembers.mockResolvedValue([member]);
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    api.updateSpacePresentation.mockImplementation(async (_id: string, input: { name: string; iconKey: string; colorKey: string }) => makeSpace({ ...input, revision: 2 }));
    api.updateSpaceAudience.mockImplementation(async (_id: string, input: { scope: 'personal' | 'workspace' }) => makeSpace({ scope: input.scope, revision: 2 }));
  });

  // A Space is not a conversation. The backing object has a hidden main, and
  // nothing in the product opens it.
  it('draws no composer, transcript, Main link or breakout list', async () => {
    renderSpace();

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /message/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /breakout/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new breakout/iu })).not.toBeInTheDocument();
  });

  it('shows Channels without section actions, Resources, or Sidekicks', async () => {
    // The Space's own page carries the Channels; the device's directory is a
    // separate list and is deliberately not what this section reads.
    api.listSpaceChannels.mockResolvedValue({ items: [channelRow()], nextCursor: null });
    renderSpace(makeSpace({
      channelCount: 1,
      defaultResourceIds: ['00000000-0000-7000-8000-0000000000c1'],
      defaultSidekickIds: ['00000000-0000-7000-8000-0000000000b1'],
    }));

    expect(await screen.findByRole('link', { name: /Ship the launch/u })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Resources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add channel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New channel in Hiring' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(api.listResources).not.toHaveBeenCalled();
    expect(removedDataHooks.useSocketOwnedList).not.toHaveBeenCalled();
    expect(removedDataHooks.useWorkstreamsQuery).not.toHaveBeenCalled();
  });

  // The list is conversations, not memberships: a Channel and any of its
  // breakouts that still need this reader, in one list ordered by activity.
  it('draws channels and their breakouts with their identity marks as one activity-ordered list', async () => {
    api.listSpaceChannels.mockResolvedValue({
      items: [breakoutRow(), channelRow()],
      nextCursor: null,
    });
    renderSpace(makeSpace({ channelCount: 1 }));

    const list = await screen.findAllByRole('link');
    expect(list.map((link) => link.getAttribute('href'))).toEqual([
      // A breakout opens *its own conversation*, which is the parent Channel
      // with the substream selected — the Channel's main transcript is a
      // different room and landing there is the bug this pins.
      '/workstreams/00000000-0000-7000-8000-0000000000e1?substream=00000000-0000-7000-8000-0000000000e9',
      '/workstreams/00000000-0000-7000-8000-0000000000e1',
    ]);
    // The breakout says where it lives, because "Pricing" on its own says
    // nothing. Its parent Channel keeps the filled pebble while the Breakout
    // keeps its own bare mark, joined by the chevrons.
    const breakout = list[0]!;
    expect(within(breakout).getByText('in Ship the launch')).toBeVisible();
    expect(breakout.querySelector('.workstream-glyph .lucide-rocket')).not.toBeNull();
    expect(breakout.querySelector('.waiting-conversation-arrow.tabler-icon-chevrons-right')).not.toBeNull();
    expect(breakout.querySelector('.waiting-conversation-icon > .lucide-sparkles')).not.toBeNull();
    expect(list[1]!.querySelector('.workstream-glyph .lucide-rocket')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('names each Channel and Breakout mark with the conversation identity tooltip', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [breakoutRow()], nextCursor: null });
    renderSpace(makeSpace({ channelCount: 1 }));

    const icons = (await screen.findByRole('link', { name: /Pricing/u }))
      .querySelectorAll<HTMLElement>('.waiting-conversation-icon');
    expect(icons).toHaveLength(2);

    fireEvent.pointerMove(icons[0]!, { pointerType: 'mouse' });
    let tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveClass('sidebar-workstream-preview-surface');
    expect(tooltip).toHaveTextContent('Ship the launch');

    fireEvent.pointerMove(icons[1]!, { pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Pricing'), { timeout: 1_000 });
    tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('sidebar-workstream-preview-surface');
    expect(tooltip).toHaveTextContent('Pricing');
  });

  // Two empty states, because they are two different facts. Telling somebody
  // "no channels yet" about a Space with forty of them sends them looking for
  // a bug; the count is what separates the two.
  it('given a space whose conversations are all stale, then it says so rather than claiming it is empty', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    renderSpace(makeSpace({ channelCount: 4 }));

    expect(await screen.findByText('Nothing here needs you right now')).toBeVisible();
    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();
  });

  it('given a space with no channels at all, then it still says so', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    renderSpace(makeSpace({ channelCount: 0 }));

    expect(await screen.findByText('No channels yet')).toBeVisible();
    expect(screen.getByText('Channels will appear here when they need your attention.')).toBeVisible();
    expect(screen.queryByText('Nothing here needs you right now')).not.toBeInTheDocument();
  });

  // A nudge sent while the socket was away is never re-sent, and nothing
  // durable records that it happened — so a fresh connect payload is this
  // screen's only evidence that it may have missed one. `workspace-socket.tsx`
  // owns the other half: the nudge itself.
  it('refetches the page after the socket reconnects', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    workspaceSocket.current = { sidebarConnect: { generation: 1 }, state: 'connected' };
    const { rerender } = renderSpace(makeSpace({ channelCount: 1 }));
    await waitFor(() => expect(api.listSpaceChannels).toHaveBeenCalledTimes(1));

    workspaceSocket.current = { sidebarConnect: { generation: 2 }, state: 'connected' };
    rerender();

    await waitFor(() => expect(api.listSpaceChannels).toHaveBeenCalledTimes(2));
  });

  // The generation the screen mounted at is already accounted for by the
  // query's own mount fetch, so adopting it must not cost a second read of the
  // same page on every open.
  it('does not refetch the page for the connection it opened on', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    workspaceSocket.current = { sidebarConnect: { generation: 3 }, state: 'connected' };
    const { rerender } = renderSpace(makeSpace({ channelCount: 1 }));
    await waitFor(() => expect(api.listSpaceChannels).toHaveBeenCalledTimes(1));

    rerender();

    await waitFor(() => expect(api.listSpaceChannels).toHaveBeenCalledTimes(1));
  });

  it('asks for the next page of channels when Load more is used', async () => {
    api.listSpaceChannels.mockResolvedValueOnce({ items: [], nextCursor: 'page-2' });
    api.listSpaceChannels.mockResolvedValueOnce({ items: [], nextCursor: null });
    renderSpace(makeSpace({ channelCount: 300 }));

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(api.listSpaceChannels).toHaveBeenCalledWith(hiring.id, 'page-2', expect.anything()));
  });

  it('opens the complete icon and color picker from the space icon and saves the choice', async () => {
    renderSpace();

    fireEvent.click(screen.getByRole('button', { name: 'Change icon and color for Hiring' }));
    const dialog = screen.getByRole('dialog', { name: 'Space icon and color' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rocket' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledWith(hiring.id, {
      name: 'Hiring',
      iconKey: 'rocket',
      colorKey: 'green',
    }));
  });

  it('renames the space from the header', async () => {
    renderSpace();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Hiring' }));
    const field = screen.getByRole('textbox', { name: 'Space name' });
    fireEvent.change(field, { target: { value: 'Recruiting' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(api.updateSpacePresentation).toHaveBeenCalledWith(hiring.id, {
      name: 'Recruiting',
      iconKey: 'briefcase',
      colorKey: 'green',
    }));
  });

  // General is the Organization's protected fallback: its lifecycle and its
  // Organization-wide audience are immutable, and its name and mark are not.
  it('given General, then archive and audience are absent while rename and icon stay', async () => {
    renderSpace(makeSpace({ name: 'General', scope: 'workspace', systemRole: 'general' }));

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Archive space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Space audience' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change icon and color for General' })).toBeInTheDocument();
  });

  /**
   * A Space this reader reaches only because they can read a Channel in it.
   *
   * The whole screen is the header and the conversation list. Its lifecycle,
   * audience, participants and Channel-management controls are the Space's own,
   * and none of those are theirs to see or change.
   */
  it('given a space reached through a channel, then it is the header and the list and nothing else', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [channelRow()], nextCursor: null });
    renderSpace(makeSpace({
      name: 'Side work',
      reach: 'through_channel',
      participants: [],
      channelCount: 1,
      defaultResourceIds: [],
      defaultSidekickIds: [],
    }));

    // The header and the list, which is what the disclosure is for.
    expect(await screen.findByRole('link', { name: /Ship the launch/u })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Side work' })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Archive space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Space audience' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage participants' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add channel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New channel in Side work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).not.toBeInTheDocument();
    // The rename is an interaction rather than a control, so its absence is
    // the field never opening rather than a button that is not drawn.
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Side work' }));
    expect(screen.queryByRole('textbox', { name: 'Space name' })).not.toBeInTheDocument();
  });

  // The server's sentence is a diagnostic written for a log, in the
  // Organization's internal words; the code is what the person is shown.
  it('given an archive the server refuses, then it names what has to move first', async () => {
    api.archiveSpace.mockRejectedValue(new ApiError(
      'A Channel in “Hiring” belongs to no other Space, so it would have no home',
      409,
      'space_membership_final',
    ));
    renderSpace();

    fireEvent.click(screen.getByRole('button', { name: 'Archive space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive space?' });
    expect(within(dialog).getByText(/A channel whose only space is this one has to be moved first/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

    expect(await screen.findByText('Every channel needs a space, and this would leave one with none. Add it to another space first.'))
      .toBeVisible();
    expect(screen.queryByText(/belongs to no other Space/u)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Archive space?' })).toBeVisible();
  });

  it('given a blocked archive that named channels, then it lists the ones to move', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: [channelRow()], nextCursor: null });
    api.archiveSpace.mockRejectedValue(new ApiError(
      'A Channel in “Hiring” belongs to no other Space, so it would have no home',
      409,
      'space_membership_final',
      { channelIds: ['00000000-0000-7000-8000-0000000000e1'] },
    ));
    renderSpace(makeSpace({ channelCount: 1 }));

    fireEvent.click(screen.getByRole('button', { name: 'Archive space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive space?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

    const blocked = await screen.findByRole('list', { name: 'Channels to move first' });
    expect(within(blocked).getByText('Ship the launch')).toBeVisible();
  });

  // One failure appears once. A single `error` string was rendered in the body
  // and in every modal at once, so a refused rename turned up inside unrelated
  // controls the moment one was opened.
  it('given a refused rename, then the sentence stays with the name and out of the modals', async () => {
    api.updateSpacePresentation.mockRejectedValueOnce(new ApiError('Revision 1 is stale', 409, 'space_revision_conflict'));
    renderSpace();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Hiring' }));
    const field = screen.getByRole('textbox', { name: 'Space name' });
    fireEvent.change(field, { target: { value: 'Recruiting' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    const sentence = 'The space changed while this was being applied. Try again.';
    expect(await screen.findByText(sentence)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Manage participants/u }));
    const picker = await screen.findByRole('dialog', { name: 'Space participants' });
    expect(within(picker).queryByText(sentence)).not.toBeInTheDocument();
    expect(screen.getAllByText(sentence)).toHaveLength(1);
  });

  it('changes the audience through the confirmation', async () => {
    renderSpace();

    fireEvent.click(screen.getByRole('combobox', { name: 'Space audience' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Everyone in the organization' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(api.updateSpaceAudience).toHaveBeenCalledWith(hiring.id, {
      scope: 'workspace',
      participantUserIds: [member.id],
    }));
  });

  // The sentence for a refused roster is drawn inside this dialog, so a dialog
  // that closes on the refusal closes over the only place it would be read.
  // The refusal this is about is new: a personal Space cannot be narrowed to a
  // participant list its own editor is not on.
  it('keeps the participants dialog open on a refusal, with the sentence in it', async () => {
    api.getWorkspaceMembers.mockResolvedValue([member, {
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Samantha Lee',
      email: 'samantha@example.com',
      timezone: 'America/Los_Angeles',
    }]);
    api.updateSpaceAudience.mockRejectedValueOnce(new ApiError(
      'Making “Hiring” private without you in it would leave you unable to change it back',
      409,
      'space_audience_self_excluded',
    ));
    renderSpace();

    fireEvent.click(await screen.findByRole('button', { name: 'Manage participants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Space participants' });
    const checkboxes = within(dialog).getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(
      'You can’t make a space private without yourself in it. Add yourself back to keep access.',
    )).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Space participants' })).toBeVisible();
  });

  // A remembered Space is read-only until the directory is live: every edit
  // sends the whole record back, so one made against the seed would carry
  // fields another client may have changed since the row was written.
  it('given a directory painted from the local cache, then editing waits for the connection', async () => {
    workspaceSocket.current = { sidebarConnect: null, state: 'connecting' };
    renderSpace();

    expect(await screen.findByText(/Connecting to/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive space' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Space audience' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Change icon and color for Hiring' })).not.toBeInTheDocument();
  });

  it('given an organization still opening, then the dashboard shows the opening state', () => {
    renderSpace(hiring, { ready: false });

    expect(screen.getByText(/Rally is opening this organization/u)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });
});
