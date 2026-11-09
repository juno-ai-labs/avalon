import { describe, expect, it } from 'vitest';
import { canvasTurnRoute, openCanvasId } from '../lib/canvases';
import {
  invitationAccountMismatch,
  messageResultRoute,
  windowControlsShellClass,
  withActiveWorkspaceName,
} from './app-shell';

const workstreamId = '00000000-0000-7000-8000-000000000001';

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

describe('canvasTurnRoute', () => {
  it('opens a message search result on its Canvas, at the turn the conversation surface reads back', () => {
    const route = canvasTurnRoute(workstreamId, 'turn a/1', 42);
    expect(route).toBe(`/canvases/${workstreamId}?turn=turn%20a%2F1&sequence=42`);
    const [pathname, query] = route.split('?');
    expect(openCanvasId(pathname!)).toBe(workstreamId);
    const params = new URLSearchParams(query);
    expect(params.get('turn')).toBe('turn a/1');
    expect(params.get('sequence')).toBe('42');
  });
});

describe('messageResultRoute', () => {
  const hit = { kind: 'message' as const, workstreamId, turnId: 'turn-1', transcriptSequence: 3, range: { start: 0, end: 1 } };

  it('opens a Canvas Chat hit on the Canvas', () => {
    expect(messageResultRoute({ ...hit, parentKind: 'canvas', substreamId: '0' }))
      .toBe(`/canvases/${workstreamId}?turn=turn-1&sequence=3`);
  });

  it('opens a Sidekick hit on the Sidekick: its shared conversation, or the run it was said in', () => {
    expect(messageResultRoute({ ...hit, parentKind: 'automation', substreamId: '0' }))
      .toBe(`/sidekicks/${workstreamId}?turn=turn-1&sequence=3`);
    const run = '00000000-0000-7000-8000-0000000000b1';
    expect(messageResultRoute({ ...hit, parentKind: 'automation', substreamId: run }))
      .toBe(`/sidekicks/${workstreamId}?run=${run}&turn=turn-1&sequence=3`);
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
