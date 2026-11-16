import { beforeEach, expect, it, vi } from 'vitest';

import type { MobileSnapshot } from './protocol';

// The device's file, as expo-file-system would keep it.
const disk = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('expo-file-system', () => ({
  Paths: { document: 'documents' },
  File: class {
    get exists() { return disk.text !== null; }
    textSync() { if (disk.text === null) throw new Error('missing'); return disk.text; }
    write(text: string) { disk.text = text; }
    delete() { disk.text = null; }
  },
}));

const { loadSavedDirectory, saveDirectory } = await import('./saved-directory');

const snapshot: MobileSnapshot = {
  userId: 'u1', userName: 'Ada', workspaceId: 'w1', workspaceName: 'Labs', workspacePath: '/app/workspaces/global/w1',
  canvases: [{ id: 'c1', title: 'Plan', icon: null, color: null, updatedAt: '2026-11-15T10:00:00.000Z' }],
  sharedElsewhere: [{ id: 'c9', title: 'Partner roadmap', icon: null, color: null, updatedAt: '2026-11-15T10:00:00.000Z',
    organization: { id: 'w2', name: 'Acme', region: 'global' } }],
  pins: [], hasMore: false, loading: false, pinBusy: false, pinError: null, directoryError: false,
  canvasId: null, tabId: null, view: 'home', title: 'Your canvases', artifactId: null, artifactPicker: false,
};

beforeEach(() => { disk.text = null; });

it("never writes another Organization's Canvases to the device", () => {
  saveDirectory(snapshot);
  expect(disk.text).not.toContain('Partner roadmap');
  expect(loadSavedDirectory()).toMatchObject({ canvases: [{ title: 'Plan' }], sharedElsewhere: [] });
});

it('drops them from a copy saved before this rule', () => {
  disk.text = JSON.stringify(snapshot);
  expect(loadSavedDirectory()?.sharedElsewhere).toEqual([]);
});
