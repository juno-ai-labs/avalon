import { render } from '@testing-library/react';
import { backgroundRealtimeWorkstreamIds } from '../lib/workspace-workstream-sockets';
import { openWorkstreamId } from '../lib/workstream-landing';
import { QueryClient } from '@tanstack/react-query';
import { asSpaceId, SpaceSummarySchema, type SpaceDirectory } from '@rally/contracts';
import type { ClientSession } from '@rally/contracts/client-session';
import { useLayoutEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { INACTIVE_SPACES_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import {
  applyArchivedSpace,
  applyPinnedWorkstreams,
  applyPinnedWorkstreamsIfCurrent,
  archiveSpaceMutationHandler,
  channelSpaceMutationHandlers,
  hasLiveSpaceArchiveAuthority,
  invitationAccountMismatch,
  sidebarConstraintThreshold,
  spacesSidebarAvailableWidth,
  spacesEnabledForSession,
  useLayoutMountedRef,
  useLatestCommittedValue,
  upsertSpaceDirectory,
  windowControlsShellClass,
  batchArchiveSkipIds,
  workstreamMatchesBatchFilter,
} from './app-shell';

describe('sidebarConstraintThreshold', () => {
  it('reserves the Space rail at both hierarchy depths', () => {
    expect(sidebarConstraintThreshold({
      pathname: '/spaces/hiring',
      sidebarWidth: 280,
      spacesSidebarWidth: 280,
      spacesCollapsed: false,
      spacesEnabled: true,
    })).toBe(984);
    expect(sidebarConstraintThreshold({
      pathname: '/workstreams/launch',
      sidebarWidth: 280,
      spacesSidebarWidth: 280,
      spacesCollapsed: true,
      spacesEnabled: true,
    })).toBe(880);
    expect(sidebarConstraintThreshold({
      pathname: '/workstreams/launch',
      sidebarWidth: 280,
      spacesSidebarWidth: 280,
      spacesCollapsed: false,
      spacesEnabled: false,
    })).toBe(792);
  });
});

describe('spacesSidebarAvailableWidth', () => {
  it('reserves compact Channel and context rails before sizing Spaces', () => {
    expect(spacesSidebarAvailableWidth({
      pathname: '/workstreams/launch',
      viewportWidth: 850,
    })).toBe(250);
    expect(spacesSidebarAvailableWidth({
      pathname: '/spaces/hiring',
      viewportWidth: 850,
    })).toBe(338);
  });
});

describe('hasLiveSpaceArchiveAuthority', () => {
  const liveConnect = { generation: 1, nextCursor: null, spacesLive: true };

  it('requires both a live Space snapshot and a currently connected socket', () => {
    expect(hasLiveSpaceArchiveAuthority('connected', liveConnect)).toBe(true);
    expect(hasLiveSpaceArchiveAuthority('connected', { ...liveConnect, spacesLive: false })).toBe(false);
    expect(hasLiveSpaceArchiveAuthority('reconnecting', liveConnect)).toBe(false);
    expect(hasLiveSpaceArchiveAuthority('unavailable', liveConnect)).toBe(false);
  });
});

describe('useLatestCommittedValue', () => {
  it('publishes a new route before later layout work can observe the commit', () => {
    let observed = '';
    function Probe({ pathname }: { pathname: string }): null {
      const currentPathname = useLatestCommittedValue(pathname);
      useLayoutEffect(() => {
        observed = currentPathname.current;
      }, [currentPathname, pathname]);
      return null;
    }

    const view = render(<Probe pathname="/spaces/old" />);
    view.rerender(<Probe pathname="/workstreams/new" />);

    expect(observed).toBe('/workstreams/new');
  });
});

describe('useLayoutMountedRef', () => {
  it('revokes the token before parent layout work observes the unmount commit', () => {
    let mountedRef: React.RefObject<boolean> | null = null;
    let observedAfterUnmount = true;
    function Child(): null {
      mountedRef = useLayoutMountedRef();
      return null;
    }
    function Probe({ show }: { show: boolean }): React.JSX.Element | null {
      useLayoutEffect(() => {
        if (!show) observedAfterUnmount = mountedRef?.current ?? true;
      }, [show]);
      return show ? <Child /> : null;
    }

    const view = render(<Probe show />);
    view.rerender(<Probe show={false} />);

    expect(observedAfterUnmount).toBe(false);
  });
});

const workstreamId = '00000000-0000-7000-8000-000000000001';
const space = SpaceSummarySchema.parse({
  id: '00000000-0000-7000-8000-0000000000f2',
  name: 'Hiring',
  iconKey: 'target',
  colorKey: 'green',
  scope: 'personal',
  status: 'active',
  systemRole: null,
  revision: 1,
  reach: 'participant',
  participants: [],
  channelCount: 0,
  defaultResourceIds: [],
  defaultSidekickIds: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

function summary(harnessStatus: WorkstreamSummary['harnessStatus'], id = workstreamId): WorkstreamSummary {
  return {
    id,
    title: 'Draft the reply',
    titleStatus: 'settled',
    scope: 'workspace',
    harnessStatus,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    spaceIds: [],
    lastActivityAt: '2026-08-11T10:00:00.000Z',
  };
}

describe('openWorkstreamId', () => {
  it('names the channel the route has open', () => {
    expect(openWorkstreamId(`/workstreams/${workstreamId}`)).toBe(workstreamId);
  });

  it('decodes an escaped segment, and survives a malformed one', () => {
    expect(openWorkstreamId('/workstreams/a%20b')).toBe('a b');
    expect(() => openWorkstreamId('/workstreams/%')).not.toThrow();
    expect(openWorkstreamId('/workstreams/%')).toBe('%');
  });

  it('has none for the composer, other screens, or a nested route', () => {
    expect(openWorkstreamId('/workstreams/new')).toBeNull();
    expect(openWorkstreamId('/automations/abc')).toBeNull();
    expect(openWorkstreamId(`/workstreams/${workstreamId}/settings`)).toBeNull();
  });
});

describe('invitationAccountMismatch', () => {
  it('explains which account must sign in without exposing a dead invitation prompt', () => {
    expect(invitationAccountMismatch('invited@example.com', 'active@example.com')).toBe(
      'This invitation is for invited@example.com. Sign in with that account to continue.',
    );
    expect(invitationAccountMismatch('Invited@example.com', 'invited@example.com')).toBeNull();
  });
});

describe('spacesEnabledForSession', () => {
  const session: ClientSession = {
    expiresAt: '2026-09-20T00:00:00.000Z',
    apiBaseUrl: 'https://api.rally.test',
    user: { id: '00000000-0000-7000-8000-0000000000a1', email: 'adam@example.com', name: 'Adam Juhasz' },
    workspace: {
      id: '00000000-0000-7000-8000-0000000000b1',
      name: 'Rally Studio',
      region: 'global',
      role: 'member',
    },
  };

  // Guest access to Spaces is deferred: every Space RPC refuses a guest, so the
  // shell omits the navigation rather than drawing controls that only fail.
  it('omits spaces for a guest, and keeps them for a member however the wire says so', () => {
    expect(spacesEnabledForSession({
      ...session,
      workspace: { ...session.workspace!, accessClass: 'guest', role: null },
    })).toBe(false);
    expect(spacesEnabledForSession({
      ...session,
      workspace: { ...session.workspace!, accessClass: 'member' },
    })).toBe(true);
    // An absent `accessClass` is the legacy full-member representation.
    expect(spacesEnabledForSession(session)).toBe(true);
  });
});

describe('upsertSpaceDirectory', () => {
  it('does not duplicate a space when its socket push beats the REST response', () => {
    expect(upsertSpaceDirectory({ waterline: 4, items: [space] }, space)).toEqual({
      waterline: 4,
      items: [space],
    });
  });
});

describe('applyArchivedSpace', () => {
  const archived = SpaceSummarySchema.parse({ ...space, status: 'archived', revision: 2 });

  it('moves the response between directories exactly once and leaves its open route', () => {
    const queryClient = new QueryClient();
    const newerArchive = SpaceSummarySchema.parse({
      ...space,
      id: '00000000-0000-7000-8000-0000000000f3',
      name: 'Onboarding',
      status: 'archived',
      revision: 3,
    });
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 5, items: [space] });
    // This archive and then another one may publish before the REST response.
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, {
      waterline: 7,
      items: [newerArchive, archived],
    });
    const openFirstWorkstream = vi.fn();

    applyArchivedSpace(queryClient, archived, `/spaces/${space.id}/participants`, openFirstWorkstream);

    expect(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)).toEqual({ waterline: 5, items: [] });
    expect(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)).toEqual({
      waterline: 7,
      items: [newerArchive, archived],
    });
    expect(openFirstWorkstream).toHaveBeenCalledOnce();
  });

  it('does not move the route when another Space is open', () => {
    const openFirstWorkstream = vi.fn();

    applyArchivedSpace(new QueryClient(), archived, '/workstreams/new', openFirstWorkstream);

    expect(openFirstWorkstream).not.toHaveBeenCalled();
  });

  it('preserves a newer socket-delivered restore when the archive response arrives late', () => {
    const queryClient = new QueryClient();
    const restored = SpaceSummarySchema.parse({ ...space, revision: archived.revision + 1 });
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 9, items: [restored] });
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, { waterline: 9, items: [] });
    const openFirstWorkstream = vi.fn();

    expect(applyArchivedSpace(
      queryClient,
      archived,
      `/spaces/${space.id}`,
      openFirstWorkstream,
    )).toBe(false);

    expect(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)).toEqual({
      waterline: 9,
      items: [restored],
    });
    expect(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)).toEqual({
      waterline: 9,
      items: [],
    });
    expect(openFirstWorkstream).not.toHaveBeenCalled();
  });

  it('leaves the route while preserving a newer socket-delivered re-archive', () => {
    const queryClient = new QueryClient();
    const rearchived = SpaceSummarySchema.parse({ ...archived, revision: archived.revision + 2 });
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 11, items: [] });
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, { waterline: 11, items: [rearchived] });
    const openFirstWorkstream = vi.fn();

    expect(applyArchivedSpace(
      queryClient,
      archived,
      `/spaces/${space.id}/participants`,
      openFirstWorkstream,
    )).toBe(false);

    expect(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)).toEqual({
      waterline: 11,
      items: [rearchived],
    });
    expect(openFirstWorkstream).toHaveBeenCalledOnce();
  });
});

describe('archiveSpaceMutationHandler', () => {
  const archived = SpaceSummarySchema.parse({ ...space, status: 'archived', revision: 2 });

  it.each([
    {
      start: `/spaces/${space.id}`,
      current: '/workstreams/new',
      expectedRedirects: 0,
      label: 'does not replace a route selected while the request was pending',
    },
    {
      start: '/workstreams/new',
      current: `/spaces/${space.id}`,
      expectedRedirects: 1,
      label: 'leaves the archived Space when it became current while the request was pending',
    },
  ])('$label', async ({ start, current, expectedRedirects }) => {
    let finishArchive!: (value: typeof archived) => void;
    const api = {
      archiveSpace: vi.fn(() => new Promise<typeof archived>((resolve) => { finishArchive = resolve; })),
    };
    let pathname = start;
    const openFirstWorkstream = vi.fn();
    const archive = archiveSpaceMutationHandler(
      api,
      new QueryClient(),
      () => pathname,
      openFirstWorkstream,
    );

    const pending = archive(space.id);
    pathname = current;
    finishArchive(archived);
    await pending;

    expect(openFirstWorkstream).toHaveBeenCalledTimes(expectedRedirects);
  });

  it('preserves a socket removal from both directories while the request is pending', async () => {
    let finishArchive!: (value: typeof archived) => void;
    const api = {
      archiveSpace: vi.fn(() => new Promise<typeof archived>((resolve) => { finishArchive = resolve; })),
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 8, items: [space] });
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, { waterline: 8, items: [] });
    const openFirstWorkstream = vi.fn();
    const archive = archiveSpaceMutationHandler(
      api,
      queryClient,
      () => `/spaces/${space.id}`,
      openFirstWorkstream,
    );

    const pending = archive(space.id);
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 9, items: [] });
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, { waterline: 9, items: [] });
    finishArchive(archived);
    await pending;

    expect(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)).toEqual({ waterline: 9, items: [] });
    expect(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)).toEqual({ waterline: 9, items: [] });
    expect(openFirstWorkstream).toHaveBeenCalledOnce();
  });

  it('ignores a completion after its Organization shell unmounts', async () => {
    let finishArchive!: (value: typeof archived) => void;
    const api = {
      archiveSpace: vi.fn(() => new Promise<typeof archived>((resolve) => { finishArchive = resolve; })),
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, { waterline: 4, items: [space] });
    queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, { waterline: 4, items: [] });
    const openFirstWorkstream = vi.fn();
    let shellMounted = true;
    const archive = archiveSpaceMutationHandler(
      api,
      queryClient,
      () => `/spaces/${space.id}`,
      openFirstWorkstream,
      () => shellMounted,
    );

    const pending = archive(space.id);
    shellMounted = false;
    finishArchive(archived);
    await pending;

    expect(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)).toEqual({ waterline: 4, items: [space] });
    expect(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)).toEqual({ waterline: 4, items: [] });
    expect(openFirstWorkstream).not.toHaveBeenCalled();
  });
});

describe('workstreamMatchesBatchFilter', () => {
  it('uses visits for access-based archive cleanup and activity for legacy commands', () => {
    const row = { ...summary('completed'), lastActivityAt: '2026-08-01T00:00:00.000Z',
      lastAccessedAt: '2026-09-08T00:00:00.000Z' };
    const range = { lastActivityAt: { atOrAfter: '2026-09-01T00:00:00.000Z' }, includeSystem: false };
    expect(workstreamMatchesBatchFilter(row, { ...range, recency: 'access' })).toBe(true);
    expect(workstreamMatchesBatchFilter(row, range)).toBe(false);
    expect(workstreamMatchesBatchFilter({ ...row, lastActivityAt: row.lastAccessedAt,
      lastAccessedAt: '2026-08-01T00:00:00.000Z' }, { ...range, recency: 'access' })).toBe(false);
  });
  it('matches the selected unpinned non-system row against the same half-open range', () => {
    expect(workstreamMatchesBatchFilter(summary('completed'), {
      lastActivityAt: {
        atOrAfter: '2026-08-11T00:00:00.000Z',
        before: '2026-08-12T00:00:00.000Z',
      },
      pinned: false,
      spaceId: asSpaceId('00000000-0000-7000-8000-0000000000f2'),
      includeSystem: false,
    })).toBe(true);
    expect(workstreamMatchesBatchFilter(summary('completed'), {
      lastActivityAt: { before: '2026-08-11T10:00:00.000Z' },
      pinned: false,
      spaceId: asSpaceId('00000000-0000-7000-8000-0000000000f2'),
      includeSystem: false,
    })).toBe(false);
  });
});

describe('batchArchiveSkipIds', () => {
  it('names every cached row the filter took, not only the open one', () => {
    const filter = {
      lastActivityAt: { atOrAfter: '2026-08-11T00:00:00.000Z', before: '2026-08-12T00:00:00.000Z' },
      pinned: false,
      spaceId: asSpaceId('00000000-0000-7000-8000-0000000000f2'),
      includeSystem: false,
    };
    const taken = summary('completed');
    const alsoTaken = { ...summary('running'), id: '00000000-0000-7000-8000-000000000031' };
    const older = { ...summary('completed'), id: '00000000-0000-7000-8000-000000000032', lastActivityAt: '2026-08-01T10:00:00.000Z' };
    const pinned = {
      ...summary('completed'),
      id: '00000000-0000-7000-8000-000000000033',
      spacePins: [{ spaceId: '00000000-0000-7000-8000-0000000000f2', position: 0 }],
    };
    expect(batchArchiveSkipIds([older, taken, pinned, alsoTaken], filter)).toEqual([taken.id, alsoTaken.id]);
    expect(batchArchiveSkipIds([], filter)).toEqual([]);
  });
});

describe('backgroundRealtimeWorkstreamIds', () => {
  it('opens every pinned pair, five recent unpinned pairs, and any other running pair', () => {
    const running = summary('running');
    const scheduled = summary('scheduled', '00000000-0000-7000-8000-000000000002');
    const completed = summary('completed', '00000000-0000-7000-8000-000000000003');
    const pinned = {
      ...summary('completed', '00000000-0000-7000-8000-000000000004'),
      spacePins: [{ spaceId: '00000000-0000-7000-8000-0000000000f2', position: 0 }],
      lastActivityAt: '2025-01-01T00:00:00.000Z',
    };
    const unpinned = Array.from({ length: 7 }, (_, index) => ({
      ...summary('completed', `00000000-0000-7000-8000-${String(index + 5).padStart(12, '0')}`),
      lastActivityAt: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    }));
    const oldButRunning = {
      ...running,
      lastActivityAt: '2024-01-01T00:00:00.000Z',
    };
    const finishedOld = {
      ...completed,
      lastActivityAt: '2023-01-01T00:00:00.000Z',
    };

    expect(backgroundRealtimeWorkstreamIds(scheduled.id, [
      oldButRunning,
      scheduled,
      finishedOld,
      pinned,
      ...unpinned,
    ])).toEqual([
      oldButRunning.id,
      pinned.id,
      ...unpinned.slice(2).map((workstream) => workstream.id),
    ]);
  });
});

describe('applyPinnedWorkstreams', () => {
  const other = '00000000-0000-7000-8000-000000000002';
  const spaceId = '00000000-0000-7000-8000-0000000000f2';

  function cacheWith(items: WorkstreamSummary[]): QueryClient {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, items);
    return queryClient;
  }

  it('takes every position from the response, including the pins it does not name', () => {
    const queryClient = cacheWith([
      { ...summary('completed'), spacePins: [{ spaceId, position: 0 }] },
      { ...summary('completed', other), pinPosition: null },
    ]);

    applyPinnedWorkstreams(queryClient, spaceId, [
      { ...summary('completed', other), spacePins: [{ spaceId, position: 0 }] },
    ]);

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY))
      .toEqual([
        expect.objectContaining({ id: workstreamId, spacePins: [] }),
        expect.objectContaining({ id: other, spacePins: [{ spaceId, position: 0 }] }),
      ]);
  });

  // Two quick moves, the second answered first. The first response then
  // describes an order the server has already moved past, and the local drag
  // order has been cleared by the time it lands, so nothing else would hold the
  // newer arrangement on screen.
  it('discards a response a later request has superseded', () => {
    const newest = { ...summary('completed'), spacePins: [{ spaceId, position: 1 }] };
    const queryClient = cacheWith([newest, {
      ...summary('completed', other), spacePins: [{ spaceId, position: 0 }],
    }]);

    const stale = [{ ...summary('completed'), spacePins: [{ spaceId, position: 0 }] }];
    expect(applyPinnedWorkstreamsIfCurrent(queryClient, spaceId, stale, 1, 2)).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toBe(newest);

    // The response of the newest request is the one that wins, whenever it lands.
    expect(applyPinnedWorkstreamsIfCurrent(queryClient, spaceId, stale, 2, 2)).toBe(true);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY))
      .toEqual([
        expect.objectContaining({ id: workstreamId, spacePins: [{ spaceId, position: 0 }] }),
        expect.objectContaining({ id: other, spacePins: [] }),
      ]);
  });

  it('leaves a row untouched when its position has not moved', () => {
    const unchanged = { ...summary('completed'), spacePins: [{ spaceId, position: 0 }] };
    const queryClient = cacheWith([unchanged]);

    applyPinnedWorkstreams(queryClient, spaceId, [{
      ...summary('running'), spacePins: [{ spaceId, position: 0 }],
    }]);

    // Rewriting the row would replace a status the socket is authoritative for
    // with whatever the pin response happened to carry.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toBe(unchanged);
  });
});

describe('channelSpaceMutationHandlers', () => {
  it('keeps the Space and Channel identifiers in API order for membership writes and moves', async () => {
    const queryClient = new QueryClient();
    const api = {
      addChannelToSpace: vi.fn().mockResolvedValue({ ...space, channelCount: 1 }),
      removeChannelFromSpace: vi.fn().mockResolvedValue(space),
    };
    const handlers = channelSpaceMutationHandlers(api, queryClient);

    await handlers.onAddChannelToSpace(space.id, workstreamId);
    await handlers.onRemoveChannelFromSpace(space.id, workstreamId);
    await handlers.onMoveChannelToSpace('source-space', 'target-space', workstreamId);

    expect(api.addChannelToSpace).toHaveBeenNthCalledWith(1, space.id, workstreamId);
    expect(api.removeChannelFromSpace).toHaveBeenNthCalledWith(1, space.id, workstreamId);
    expect(api.addChannelToSpace).toHaveBeenNthCalledWith(2, 'target-space', workstreamId);
    expect(api.removeChannelFromSpace).toHaveBeenNthCalledWith(2, 'source-space', workstreamId);
  });
});

/**
 * The mapping itself, not just the decision behind it.
 *
 * A predicate returning `true` proves nothing about which class the shell then
 * writes, and nothing in this suite renders `AppShell` — so an inverted ternary
 * at the call site would put the traffic-light defect back on macOS with every
 * test still green. Returning the class name is what makes that reachable here.
 */
describe('windowControlsShellClass', () => {
  // The main window asks `hiddenInset` of darwin, which paints the traffic
  // lights over the page. Everywhere else it asks `hidden`, and the buttons are
  // in the window manager's frame or not drawn at all.
  it('names the class on macOS and nothing anywhere else', () => {
    expect(windowControlsShellClass('darwin')).toBe('has-overlay-window-controls');
    expect(windowControlsShellClass('win32')).toBe('');
    expect(windowControlsShellClass('linux')).toBe('');
  });

  // The runtime config is fetched, so the platform is briefly unknown. Reading
  // that as "nothing to clear" leaves the header where it already is rather
  // than jumping it sideways when the answer lands.
  it('names nothing while the platform is still unknown', () => {
    expect(windowControlsShellClass(undefined)).toBe('');
  });
});
