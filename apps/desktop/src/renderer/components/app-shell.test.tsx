import { activeRealtimeWorkstreamId, backgroundRealtimeWorkstreamIds } from '../lib/workspace-workstream-sockets';
import { openCanvasId } from '../lib/canvases';
import { asSpaceId, asSubstreamId, WorkstreamPrivateChildSchema } from '@rally/contracts';
import type { ClientSession } from '@rally/contracts/client-session';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { describe, expect, it } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { associativeWorkstreamsForSidebar } from '../lib/conversation-directory';
import {
  searchChannelPlaces,
  invitationAccountMismatch,
  spacesEnabledForSession,
  windowControlsShellClass,
  withActiveWorkspaceName,
} from './app-shell';

const workstreamId = '00000000-0000-7000-8000-000000000001';
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

describe('openCanvasId', () => {
  it('names the Canvas the route has open', () => {
    expect(openCanvasId(`/canvases/${workstreamId}`)).toBe(workstreamId);
    expect(openCanvasId('/canvases')).toBeNull();
  });

  it('decodes an escaped segment, and survives a malformed one', () => {
    expect(openCanvasId('/canvases/a%20b')).toBe('a b');
    expect(openCanvasId('/canvases/%')).toBe('%');
  });

  it('has none for other screens, or a nested route', () => {
    expect(openCanvasId('/sidekicks/abc')).toBeNull();
    expect(openCanvasId(`/canvases/${workstreamId}/settings`)).toBeNull();
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

  it('keeps Space navigation for guests and members', () => {
    expect(spacesEnabledForSession({
      ...session,
      workspace: { ...session.workspace!, accessClass: 'guest', role: null },
    })).toBe(true);
    expect(spacesEnabledForSession({
      ...session,
      workspace: { ...session.workspace!, accessClass: 'member' },
    })).toBe(true);
    // An absent `accessClass` is the legacy full-member representation.
    expect(spacesEnabledForSession(session)).toBe(true);
  });
});

describe('searchChannelPlaces', () => {
  const member = asSubstreamId('00000000-0000-7000-8000-0000000000b1');
  const granted = asSubstreamId('00000000-0000-7000-8000-0000000000b2');
  const archived = asSubstreamId('00000000-0000-7000-8000-0000000000b3');
  const directory: SharedNavigationDirectory = {
    spaces: [],
    workstreams: [{
      parentId: workstreamId, title: 'Draft the reply', scope: 'personal', archived: false,
      conversations: [
        { substreamId: asSubstreamId('0'), title: 'Main', scope: 'personal', archived: false },
        { substreamId: member, title: 'Stale title', scope: 'personal', archived: false },
        { substreamId: granted, title: 'Granted notes', appearance: { icon: 'rocket', color: 'violet' }, scope: 'personal', archived: false },
        { substreamId: archived, title: 'Old notes', scope: 'personal', archived: true },
      ],
    }],
  };

  it('lists a Breakout reached through a grant beside the ones the reader is a member of', () => {
    const held = { [workstreamId]: [WorkstreamPrivateChildSchema.parse({ substreamId: member, title: 'Member notes',
      createdByUserId: workstreamId, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' })] };
    expect(searchChannelPlaces([summary('completed')], held, directory).map((place) => [place.kind, place.id, place.name])).toEqual([
      ['channel', workstreamId, 'Draft the reply'],
      // The member list's own row wins over the directory's for the same Breakout.
      ['breakout', member, 'Member notes'],
      ['breakout', granted, 'Granted notes'],
    ]);
  });
});

describe('associativeWorkstreamsForSidebar', () => {
  const directory: SharedNavigationDirectory = {
    spaces: [{
      id: asSpaceId('00000000-0000-7000-8000-0000000000f1'),
      name: 'Private planning',
      iconKey: 'star',
      colorKey: 'red',
      scope: 'personal',
      workstreamIds: [workstreamId],
    }],
    workstreams: [{
      parentId: workstreamId,
      title: 'Launch plan',
      appearance: { icon: 'rocket', color: 'violet' },
      scope: 'personal',
      archived: false,
      conversations: [{ substreamId: asSubstreamId('00000000-0000-7000-8000-0000000000f2'), title: 'Risks', scope: 'personal', archived: false }],
    }],
  };

  it('opens a socket row whose Main is not listed on its first listed conversation', () => {
    const other = summary('completed', '00000000-0000-7000-8000-0000000000f9');
    expect(associativeWorkstreamsForSidebar(directory, [other, summary('completed')])).toEqual([
      other,
      expect.objectContaining({
        id: workstreamId,
        title: 'Draft the reply',
        associativeSubstreamId: '00000000-0000-7000-8000-0000000000f2',
      }),
    ]);
  });

  it('adds no row the socket did not list, and leaves a row whose Main is listed alone', () => {
    expect(associativeWorkstreamsForSidebar(directory, [])).toEqual([]);
    const withMain: SharedNavigationDirectory = {
      ...directory,
      workstreams: [{
        ...directory.workstreams[0]!,
        conversations: [{ substreamId: asSubstreamId('0'), title: 'Main', scope: 'personal', archived: false }],
      }],
    };
    const listed = summary('completed');
    expect(associativeWorkstreamsForSidebar(withMain, [listed])).toEqual([listed]);
    expect(associativeWorkstreamsForSidebar(undefined, [listed])).toEqual([listed]);
  });
});

describe('activeRealtimeWorkstreamId', () => {
  // The server lists an import's Channel before its room is written.
  it('opens no socket for a routed Channel whose create is still in flight', () => {
    const row = summary('completed');

    expect(activeRealtimeWorkstreamId(row.id, [{ ...row, pending: true }])).toBeNull();
    expect(activeRealtimeWorkstreamId(row.id, [row])).toBe(row.id);
    expect(activeRealtimeWorkstreamId(row.id, undefined)).toBe(row.id);
    expect(activeRealtimeWorkstreamId(null, [row])).toBeNull();
  });
});

describe('backgroundRealtimeWorkstreamIds', () => {
  it('opens every pinned thread, the five most recent unpinned ones, and any other running one', () => {
    const running = summary('running');
    const scheduled = summary('scheduled', '00000000-0000-7000-8000-000000000002');
    const completed = summary('completed', '00000000-0000-7000-8000-000000000003');
    const pinned = {
      ...summary('completed', '00000000-0000-7000-8000-000000000004'),
      lastActivityAt: '2025-01-01T00:00:00.000Z',
    };
    // Pinned only through an old desktop's per-Space pin, which no surface
    // here shows: it is one more unpinned thread, and too old to open.
    const legacyPinned = {
      ...summary('completed', '00000000-0000-7000-8000-000000000013'),
      spacePins: [{ spaceId: '00000000-0000-7000-8000-0000000000f2', position: 0 }],
      lastActivityAt: '2025-01-02T00:00:00.000Z',
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
      legacyPinned,
      ...unpinned,
    ], new Set([pinned.id]))).toEqual([
      oldButRunning.id,
      pinned.id,
      ...unpinned.slice(2).map((workstream) => workstream.id),
    ]);
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

describe('withActiveWorkspaceName', () => {
  const row = (id: string, region: string, name: string) => ({
    id, name, slug: id, region, role: 'owner' as const, createdAt: '2026-08-01T00:00:00.000Z',
  });

  it('renames only the active row, matched on id and region together', () => {
    const rows = [row('a', 'global', 'Old'), row('a', 'eu', 'Same id elsewhere'), row('b', 'global', 'Other')];
    expect(withActiveWorkspaceName(rows, { id: 'a', region: 'global', name: 'Juno Labs' }).map((r) => r.name))
      .toEqual(['Juno Labs', 'Same id elsewhere', 'Other']);
  });

  it('leaves a directory without the active row as it was', () => {
    const rows = [row('b', 'global', 'Other')];
    expect(withActiveWorkspaceName(rows, { id: 'a', region: 'global', name: 'Juno Labs' })).toEqual(rows);
  });
});
