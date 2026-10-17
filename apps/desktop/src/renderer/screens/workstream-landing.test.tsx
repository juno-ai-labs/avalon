import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutKey } from '../lib/desktop-layout';
import { expandRequest } from '../lib/navigation-routes';
import { PINS_QUERY_KEY } from '../lib/sidebar-list-store';
import { WorkstreamLandingScreen } from './workstream-landing';

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: { user: { id: 'person' }, workspace: { id: 'org', accessClass: 'member' } },
}) }));
const spaces = vi.hoisted(() => ({
  data: undefined as { items: { id: string; name: string; systemRole?: string | null }[] } | undefined,
}));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces, inactive: { data: undefined } }) }));
const socket = vi.hoisted(() => ({
  state: 'connecting',
  sidebarConnect: null as { spacesLive: boolean } | null,
}));
vi.mock('../lib/workspace-socket', () => ({ useWorkspaceSocket: () => socket }));

function Destination(): React.JSX.Element {
  const location = useLocation();
  const restored = typeof location.state === 'object' && location.state !== null && 'restoredBreakout' in location.state
    ? String(location.state.restoredBreakout) : '';
  return <div data-expanded={expandRequest(location) !== null} data-restored={restored} data-testid="destination">{location.pathname}{location.search}</div>;
}

function Router({ initial = '/', pins = [] }: {
  initial?: string | { pathname: string; state: unknown };
  pins?: { kind: 'thread' | 'channel' | 'breakout'; id: string; parentId: string | null }[];
}): React.JSX.Element {
  const queryClient = new QueryClient();
  queryClient.setQueryData(PINS_QUERY_KEY, pins);
  return <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[initial]}><Routes>
      <Route element={<WorkstreamLandingScreen />} path="/" />
      <Route element={<Destination />} path="*" />
    </Routes></MemoryRouter>
  </QueryClientProvider>;
}

const general = { id: 'general', name: 'General', systemRole: 'general' };

describe('the root landing', () => {
  beforeEach(() => {
    localStorage.clear();
    spaces.data = undefined;
    socket.state = 'connecting';
    socket.sidebarConnect = null;
  });

  it('reopens the thread and breakout this device last had open, naming the breakout restored', async () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/channels/outbound/threads/plan?substream=child');
    render(<Router />);
    const destination = await screen.findByTestId('destination');
    expect(destination).toHaveTextContent('/channels/outbound/threads/plan?substream=child');
    expect(destination).toHaveAttribute('data-expanded', 'false');
    expect(destination).toHaveAttribute('data-restored', 'child');
  });

  it('reopens a thread under its Channel expanded', async () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/channels/outbound/threads/plan');
    render(<Router />);
    const destination = await screen.findByTestId('destination');
    expect(destination).toHaveTextContent(/^\/channels\/outbound\/threads\/plan$/u);
    expect(destination).toHaveAttribute('data-expanded', 'true');
  });

  it('does not reopen a thread a leaving screen names, and lands on a Channel instead', async () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/channels/outbound/threads/left');
    spaces.data = { items: [general] };
    render(<Router initial={{ pathname: '/', state: { skipWorkstreamIds: ['left'] } }} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent(/^\/channels\/general$/u);
  });

  it('returns a screen that just left a thread to the Channel it was in, ahead of a pin', async () => {
    spaces.data = { items: [general, { id: 'outbound', name: 'Outbound' }, { id: 'growth', name: 'Growth' }] };
    render(<Router
      initial={{ pathname: '/', state: { skipWorkstreamIds: ['left'], spaceId: 'outbound' } }}
      pins={[{ kind: 'channel', id: 'growth', parentId: null }]}
    />);
    expect(await screen.findByTestId('destination')).toHaveTextContent(/^\/channels\/outbound$/u);
  });

  it('opens the first pinned Channel ahead of General', async () => {
    spaces.data = { items: [general, { id: 'outbound', name: 'Outbound' }, { id: 'growth', name: 'Growth' }] };
    render(<Router pins={[
      { kind: 'thread', id: 'a-thread', parentId: null },
      { kind: 'channel', id: 'growth', parentId: null },
      { kind: 'channel', id: 'outbound', parentId: null },
    ]} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent(/^\/channels\/growth$/u);
  });

  it('opens General when nothing is pinned, and the first Channel A–Z when there is no General', async () => {
    spaces.data = { items: [{ id: 'zebra', name: 'Zebra' }, general, { id: 'apple', name: 'Apple' }] };
    const view = render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent(/^\/channels\/general$/u);
    view.unmount();
    spaces.data = { items: [{ id: 'zebra', name: 'Zebra' }, { id: 'apple', name: 'Apple' }] };
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent(/^\/channels\/apple$/u);
  });

  it('waits for the Channels, and says so when the socket cannot deliver them', () => {
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening channels');
    view.unmount();
    socket.state = 'unavailable';
    render(<Router />);
    expect(screen.getByText(/Unable to connect to your organization/u)).toBeInTheDocument();
  });

  it('says there is nothing to open when the person may see no Channel', () => {
    spaces.data = { items: [] };
    render(<Router />);
    expect(screen.getByText('No channels yet')).toBeInTheDocument();
  });
});
