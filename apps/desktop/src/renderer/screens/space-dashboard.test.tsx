import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SpaceSummarySchema, asSpaceId, type SpaceSummary } from '@rally/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { SpaceDashboardScreen } from './space-dashboard';
import type { Workspace, WorkstreamSummary } from '../lib/types';

const api = vi.hoisted(() => ({
  addChannelToSpace: vi.fn(),
  addSpaceDefault: vi.fn(),
  archiveSpace: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  listResources: vi.fn(),
  listSpaceChannels: vi.fn(),
  removeChannelFromSpace: vi.fn(),
  removeSpaceDefault: vi.fn(),
  restoreSpace: vi.fn(),
  updateSpaceAudience: vi.fn(),
  updateSpacePresentation: vi.fn(),
}));
const channels = vi.hoisted(() => ({ current: [] as WorkstreamSummary[] }));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: channels.current }) }));
vi.mock('../lib/workstream-landing', () => ({ useOpenFirstWorkstream: () => () => undefined }));
/** Null unless a test wants the screen to think the directory is the local cache's. */
const workspaceSocket = vi.hoisted(() => ({
  current: null as null | { sidebarConnect: null | { generation: number }; state: 'connecting' | 'connected' | 'unavailable' },
}));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => workspaceSocket.current }));

const member = {
  id: '00000000-0000-7000-8000-000000000002',
  name: 'Morgan Ellis',
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

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSpace(summary = hiring, options: { ready?: boolean } = {}): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const active = summary.status === 'active';
  queryClient.setQueryData(['spaces'], { waterline: 1, items: active ? [summary] : [] });
  queryClient.setQueryData(['spaces-inactive'], { waterline: 1, items: active ? [] : [summary] });
  queryClient.setQueryData(['spaces-ready'], options.ready ?? true);
  queryClient.setQueryData(['automations'], [{
    id: '00000000-0000-7000-8000-0000000000b1',
    name: 'Weekly digest',
    description: 'Summarises the week',
    scope: 'workspace',
    status: 'active',
    updatedAt: '2026-08-27T00:00:00.000Z',
  }]);
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/spaces/${summary.id}`]}>
          <Routes>
            <Route element={<SpaceDashboardScreen workspace={workspace} />} path="/spaces/:spaceId" />
            <Route element={<Location />} path="*" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('the Space dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceSocket.current = null;
    channels.current = [];
    api.getWorkspaceMembers.mockResolvedValue([member]);
    api.listResources.mockResolvedValue({
      items: [{
        id: '00000000-0000-7000-8000-0000000000c1',
        title: 'Hiring plan',
        resourceType: 'document',
        provider: 'Drive',
        watchEnabled: false,
        watchStatus: 'unsupported',
      }],
      nextCursor: null,
    });
    api.listSpaceChannels.mockResolvedValue({ items: [], nextCursor: null });
    api.updateSpacePresentation.mockImplementation(async (_id: string, input: { name: string; iconKey: string; colorKey: string }) => makeSpace({ ...input, revision: 2 }));
    api.updateSpaceAudience.mockImplementation(async (_id: string, input: { scope: 'personal' | 'workspace' }) => makeSpace({ scope: input.scope, revision: 2 }));
  });

  // A Space is not a conversation. The backing object has a hidden main, and
  // nothing in the product opens it.
  it('draws no composer, transcript, Main link or breakout list', async () => {
    renderSpace();

    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /message/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /breakout/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new breakout/iu })).not.toBeInTheDocument();
  });

  it('shows the channels, resources and Sidekicks sections', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: ['00000000-0000-7000-8000-0000000000e1'], nextCursor: null });
    channels.current = [{
      id: '00000000-0000-7000-8000-0000000000e1',
      title: 'Ship the launch',
      lastActivityAt: '2026-08-27T01:00:00.000Z',
      spaceIds: [hiring.id as string],
    } as WorkstreamSummary];
    renderSpace(makeSpace({
      channelCount: 1,
      defaultResourceIds: ['00000000-0000-7000-8000-0000000000c1'],
      defaultSidekickIds: ['00000000-0000-7000-8000-0000000000b1'],
    }));

    expect(await screen.findByRole('link', { name: /Ship the launch/u })).toBeVisible();
    expect(await screen.findByText('Hiring plan')).toBeVisible();
    expect(screen.getByText('Weekly digest')).toBeVisible();
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

    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Archive space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Space audience' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change icon and color for General' })).toBeInTheDocument();
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

  // One failure appears once. A single `error` string was rendered in the body
  // and in all five modals at once, so a refused rename turned up inside the
  // channel picker the moment it was opened.
  it('given a refused rename, then the sentence stays with the name and out of the modals', async () => {
    api.updateSpacePresentation.mockRejectedValueOnce(new ApiError('Revision 1 is stale', 409, 'space_revision_conflict'));
    renderSpace();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Hiring' }));
    const field = screen.getByRole('textbox', { name: 'Space name' });
    fireEvent.change(field, { target: { value: 'Recruiting' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    const sentence = 'The space changed while this was being applied. Try again.';
    expect(await screen.findByText(sentence)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const picker = await screen.findByRole('dialog', { name: 'Add channels' });
    expect(within(picker).queryByText(sentence)).not.toBeInTheDocument();
    expect(screen.getAllByText(sentence)).toHaveLength(1);
  });

  it('removes a channel from this space without touching its other spaces', async () => {
    api.listSpaceChannels.mockResolvedValue({ items: ['00000000-0000-7000-8000-0000000000e1'], nextCursor: null });
    api.removeChannelFromSpace.mockResolvedValue(makeSpace({ channelCount: 0 }));
    channels.current = [{
      id: '00000000-0000-7000-8000-0000000000e1',
      title: 'Ship the launch',
      lastActivityAt: '2026-08-27T01:00:00.000Z',
      spaceIds: [hiring.id as string],
    } as WorkstreamSummary];
    renderSpace(makeSpace({ channelCount: 1 }));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.removeChannelFromSpace)
      .toHaveBeenCalledWith(hiring.id, '00000000-0000-7000-8000-0000000000e1'));
  });

  it('adds an existing channel to this space', async () => {
    api.addChannelToSpace.mockResolvedValue(makeSpace({ channelCount: 1 }));
    channels.current = [{
      id: '00000000-0000-7000-8000-0000000000e2',
      title: 'Comp review',
      lastActivityAt: '2026-08-27T01:00:00.000Z',
      spaceIds: ['00000000-0000-7000-8000-0000000000f0'],
    } as WorkstreamSummary];
    renderSpace();

    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));

    await waitFor(() => expect(api.addChannelToSpace)
      .toHaveBeenCalledWith(hiring.id, '00000000-0000-7000-8000-0000000000e2'));
  });

  it('adds a resource and a Sidekick through the one kind-keyed route', async () => {
    api.addSpaceDefault.mockResolvedValue(makeSpace());
    renderSpace();

    fireEvent.click(await screen.findByRole('button', { name: 'Add resource' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.addSpaceDefault)
      .toHaveBeenCalledWith(hiring.id, 'resource', '00000000-0000-7000-8000-0000000000c1'));

    fireEvent.click(screen.getByRole('button', { name: 'Add Sidekick' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.addSpaceDefault)
      .toHaveBeenCalledWith(hiring.id, 'sidekick', '00000000-0000-7000-8000-0000000000b1'));
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
    expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
  });
});
