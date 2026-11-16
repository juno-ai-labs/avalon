import { expect, it } from 'vitest';
import { directoryKey } from './directory';
import type { MobileSnapshot } from './protocol';

const snapshot = {
  userId: 'u1', userName: 'Ada', workspaceId: 'w1', workspaceName: 'Labs', workspacePath: '/app/workspaces/us/w1',
  canvases: [{ id: 'c1', title: 'Plan', icon: null, color: null, updatedAt: '2026-11-15T10:00:00.000Z' }],
  sharedElsewhere: [],
  pins: ['c1'], hasMore: false, loading: false, pinBusy: false, pinError: null, directoryError: false,
  canvasId: null, tabId: null, view: 'home', title: 'Your canvases', artifactId: null, artifactPicker: false,
} satisfies MobileSnapshot;

it('treats an agent touching a canvas, or Home navigating, as the same directory', () => {
  const touched = { ...snapshot, canvases: [{ ...snapshot.canvases[0]!, updatedAt: '2026-11-15T10:05:00.000Z' }] };
  const navigated = { ...snapshot, canvasId: 'c1', view: 'artifact' as const, title: 'Plan', artifactId: 'r1' };
  expect(directoryKey(touched)).toBe(directoryKey(snapshot));
  expect(directoryKey(navigated)).toBe(directoryKey(snapshot));
});

it('sees a change the native shell shows', () => {
  const renamed = { ...snapshot, canvases: [{ ...snapshot.canvases[0]!, title: 'Roadmap' }] };
  expect(directoryKey(renamed)).not.toBe(directoryKey(snapshot));
  expect(directoryKey({ ...snapshot, pins: [] })).not.toBe(directoryKey(snapshot));
  expect(directoryKey({ ...snapshot, pinBusy: true })).not.toBe(directoryKey(snapshot));
  expect(directoryKey(null)).toBe('');
  const shared = { id: 'c9', title: 'Partner roadmap', icon: null, color: null, updatedAt: '2026-11-15T10:00:00.000Z', organization: { id: 'w2', name: 'Acme', region: 'us' } };
  expect(directoryKey({ ...snapshot, sharedElsewhere: [shared] })).not.toBe(directoryKey(snapshot));
  // Beside a shared Canvas, this Organization's own dates place cards too.
  const touchedLocal = { ...snapshot, sharedElsewhere: [shared], canvases: [{ ...snapshot.canvases[0]!, updatedAt: '2026-11-15T12:00:00.000Z' }] };
  expect(directoryKey(touchedLocal)).not.toBe(directoryKey({ ...snapshot, sharedElsewhere: [shared] }));
  // Its date places it among this Organization's Canvases, so a newer one moves it.
  expect(directoryKey({ ...snapshot, sharedElsewhere: [{ ...shared, updatedAt: '2026-11-15T11:00:00.000Z' }] }))
    .not.toBe(directoryKey({ ...snapshot, sharedElsewhere: [shared] }));
});
