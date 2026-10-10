import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace, WorkstreamSummary } from '../lib/types';
import { ChannelScreen } from './channel';

const api = vi.hoisted(() => ({ getChannelFeed: vi.fn(), getWorkspaceMembers: vi.fn(async () => []) }));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: null }) }));
const spaces = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces, inactive: { data: undefined } }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));
vi.mock('../components/channel-composer', () => ({ ChannelComposer: () => <div>composer</div> }));
vi.mock('./workstream', () => ({ WorkstreamScreen: () => <div>thread pane</div> }));

const workspace = {
  id: 'org', name: 'Rally', region: 'global',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', role: 'member', accessClass: 'member' },
} as unknown as Workspace;

function outbound(reach: 'organization' | 'participant' | 'through_channel') {
  return { waterline: 1, items: [{
    id: 'outbound', name: 'Outbound', iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active',
    systemRole: null, revision: 1, reach, participants: [], channelCount: 2, attentionCount: 0,
    defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }] };
}

const plan = {
  id: 'plan', title: 'Q4 plan', objective: 'A four-week outbound setup plan.', titleStatus: 'settled', scope: 'workspace',
  harnessStatus: 'completed', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
  nextPendingWakeup: null, participantUserIds: [], participantExtraCount: 0, spaceIds: ['outbound'], pinPosition: null,
  lastActivityAt: '2026-10-02T00:00:00.000Z', createdByUserId: null,
} as unknown as WorkstreamSummary;

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderChannel(path = '/channels/outbound') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" /></Routes>
      <Routes><Route element={<Location />} path="*" /></Routes>
    </MemoryRouter>
  </Tooltip.Provider></QueryClientProvider>);
}

describe('a Channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spaces.data = outbound('organization');
    api.getChannelFeed.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'locked', placedAt: '2026-10-03T00:00:00.000Z', threadId: 'secret' },
      { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', thread: plan },
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

  it('offers no composer to somebody who reaches the Channel only through a thread in it', async () => {
    spaces.data = outbound('through_channel');
    renderChannel();
    await screen.findByRole('list', { name: 'Threads in Outbound' });
    expect(screen.queryByText('composer')).not.toBeInTheDocument();
  });
});
