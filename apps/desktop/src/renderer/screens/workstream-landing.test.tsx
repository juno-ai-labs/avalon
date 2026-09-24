import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { WorkstreamLandingScreen } from './workstream-landing';
import { layoutKey } from '../lib/desktop-layout';

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: { user: { id: 'person' }, workspace: { id: 'org', accessClass: 'member' } },
}) }));
const spaces = vi.hoisted(() => ({ data: undefined as { items: { id: string; systemRole?: string | null }[] } | undefined }));
vi.mock('../lib/use-space-directories', () => ({ useSpaceDirectories: () => ({ active: spaces }) }));

const socket = vi.hoisted(() => ({ state: 'connecting', sidebarConnect: null as { spacesLive: boolean } | null }));
vi.mock('../lib/workspace-socket', () => ({ useWorkspaceSocket: () => socket }));

const directory = vi.hoisted(() => ({
  data: undefined as WorkstreamSummary[] | undefined,
  error: null as Error | null,
  hasMore: false,
  isFetchingMore: false,
  fetchMore: vi.fn(),
}));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => directory }));

function stream(id: string, pinPosition: number | null, lastActivityAt: string): WorkstreamSummary {
  return {
    id, pinPosition, lastActivityAt, title: id, titleStatus: 'settled', scope: 'workspace',
    harnessStatus: 'completed', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false,
    firstUnreadSequenceNumber: null, nextPendingWakeup: null, participantUserIds: [], participantExtraCount: 0,
    spaceIds: [],
  };
}

function Destination(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="destination">{location.pathname}{location.search}</div>;
}

function Router({ initial = '/' }: { initial?: string | { pathname: string; state: unknown } }): React.JSX.Element {
  return <MemoryRouter initialEntries={[initial]}><Routes>
    <Route element={<WorkstreamLandingScreen />} path="/" />
    <Route element={<Destination />} path="*" />
  </Routes></MemoryRouter>;
}

describe('default channel landing', () => {
  beforeEach(() => {
    localStorage.clear();
    spaces.data = undefined;
    directory.data = undefined;
    directory.error = null;
    directory.hasMore = false;
    directory.fetchMore = vi.fn();
    socket.state = 'connecting';
    socket.sidebarConnect = null;
  });

  it('resumes the last reachable breakout and ignores a stale Channel', async () => {
    directory.data = [stream('recent', null, '2026-09-05'), stream('saved', null, '2026-08-01')];
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/workstreams/saved?substream=child');
    const view = render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/saved?substream=child');
    view.unmount();
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/workstreams/gone');
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/recent');
  });

  it('waits for the Space directory before resuming a saved Space', async () => {
    directory.data = [stream('recent', null, '2026-09-05')];
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/spaces/saved');
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening spaces');
    spaces.data = { items: [{ id: 'saved' }] };
    view.rerender(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/spaces/saved');
  });

  it('falls back when an older socket cannot deliver Spaces', async () => {
    directory.data = [stream('recent', null, '2026-09-05')];
    socket.sidebarConnect = { spacesLive: false };
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/spaces/saved');
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/recent');
  });

  it('pages the Channel directory after a saved Space has disappeared', () => {
    directory.data = [];
    directory.hasMore = true;
    spaces.data = { items: [] };
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/spaces/gone');
    render(<Router />);
    expect(directory.fetchMore).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Opening channels');
  });

  it('resumes a Breakout from a route with transient search parameters', async () => {
    directory.data = [stream('saved', null, '2026-09-05')];
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/workstreams/saved?substream=child&turn=old&sequence=7');
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/saved?substream=child');
  });

  it('pages to a saved Channel beyond the opening directory page', async () => {
    directory.data = [stream('recent', null, '2026-09-05')];
    directory.hasMore = true;
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/workstreams/saved');
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening channels');
    expect(directory.fetchMore).toHaveBeenCalledTimes(1);
    directory.data = [stream('recent', null, '2026-09-05'), stream('saved', null, '2026-08-01')];
    view.rerender(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/saved');
  });

  it('waits for the directory and opens the most recent Channel even if cached legacy pins remain', async () => {
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening channels');
    expect(screen.queryByTestId('destination')).toBeNull();
    directory.data = [stream('recent', null, '2026-09-05'), stream('second-pin', 1, '2026-09-04'), stream('first-pin', 0, '2026-08-01')];
    view.rerender(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/recent');
    directory.data = [stream('different-pin', 0, '2026-09-06')];
    view.rerender(<Router />);
    expect(screen.getByTestId('destination')).toHaveTextContent('/workstreams/recent');
  });

  it('uses sidebar recency order when there are no pins', async () => {
    directory.data = [stream('older', null, '2026-08-01'), stream('newest', null, '2026-09-05')];
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/newest');
  });

  it('opens the last visited channel ahead of newer shared activity', async () => {
    directory.data = [
      { ...stream('noisy', null, '2026-09-08'), createdAt: '2026-08-01', lastAccessedAt: null },
      { ...stream('visited', null, '2026-08-01'), createdAt: '2026-08-01', lastAccessedAt: '2026-09-07' },
    ];
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/visited');
  });

  it('opens General once the Spaces arrive, for a loaded empty directory', async () => {
    directory.data = [];
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening spaces');
    spaces.data = { items: [{ id: 'team', systemRole: null }, { id: 'general', systemRole: 'general' }] };
    view.rerender(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/spaces/general');
  });

  it('says there is nothing to open when an empty directory has no Spaces to fall back to', () => {
    directory.data = [];
    socket.sidebarConnect = { spacesLive: false };
    render(<Router />);
    expect(screen.getByText('No channels yet')).toBeVisible();
    expect(screen.queryByTestId('destination')).toBeNull();
  });

  it('passes over the rows a leaving screen names, whatever their rank', async () => {
    // The row that was just archived or marked unread is still in the
    // directory — the tombstone or refetch has not landed — and it is the
    // most recent row precisely because it was just open.
    directory.data = [stream('archived-pin', 0, '2026-09-06'), stream('unread', null, '2026-09-05'), stream('next', null, '2026-08-01')];
    render(<Router initial={{ pathname: '/', state: { skipWorkstreamIds: ['archived-pin', 'unread'] } }} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/next');
  });

  it('opens General when every listed row is one to pass over', async () => {
    directory.data = [stream('only', null, '2026-09-05')];
    spaces.data = { items: [{ id: 'general', systemRole: 'general' }] };
    render(<Router initial={{ pathname: '/', state: { skipWorkstreamIds: ['only'] } }} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/spaces/general');
  });

  it('asks for the next page when every loaded row is passed over and more exist', async () => {
    // A batch archive can take a whole loaded page while older, unmatched rows
    // sit beyond the cursor. That is not an empty workspace.
    directory.data = [stream('taken', null, '2026-09-05')];
    directory.hasMore = true;
    const initial = { pathname: '/', state: { skipWorkstreamIds: ['taken'] } };
    const view = render(<Router initial={initial} />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening channels');
    expect(screen.queryByTestId('destination')).toBeNull();
    expect(directory.fetchMore).toHaveBeenCalledTimes(1);
    // A page that settled without changing the list — it failed — is not
    // asked for again on its own; only a changed list requests the next one.
    view.rerender(<Router initial={initial} />);
    expect(directory.fetchMore).toHaveBeenCalledTimes(1);
    directory.data = [stream('taken', null, '2026-09-05'), stream('older', null, '2026-08-01')];
    view.rerender(<Router initial={initial} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/older');
  });

  it('ignores state that is not a skip list', async () => {
    directory.data = [stream('only', null, '2026-09-05')];
    render(<Router initial={{ pathname: '/', state: { skipWorkstreamIds: 'only' } }} />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/only');
  });

  it('surfaces a failed opening socket before the directory query is enabled', () => {
    socket.state = 'unavailable';
    render(<Router />);
    expect(screen.getByText(/Unable to connect to your organization/u)).toBeVisible();
    expect(screen.queryByTestId('destination')).toBeNull();
  });

  it('does not treat a directory failure as an empty organization', () => {
    directory.error = new Error('Directory unavailable');
    render(<Router />);
    expect(screen.getByText('Directory unavailable')).toBeVisible();
    expect(screen.queryByTestId('destination')).toBeNull();
  });
});
