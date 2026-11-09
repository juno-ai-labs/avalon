import { CanvasSidebarRowSchema, type CanvasSidebarRow } from '@rally/contracts';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANVAS_DIRECTORY_CACHE_KEY,
  canvasDirectorySlice,
  hydrateCanvasDirectory,
  mirrorCanvasDirectory,
} from './canvas-directory-cache';
import { clearAllLocalCache, closeLocalCache, localCacheScope } from './local-cache';
import { applyVersionedSidebarList } from './sidebar-list-store';
import type { AutomationSummary } from './types';

const ME = '00000000-0000-7000-8000-0000000000aa';
const scope = localCacheScope(ME, 'global', '00000000-0000-7000-8000-000000000001');

const canvas = CanvasSidebarRowSchema.parse({
  id: '00000000-0000-7000-8000-0000000000c1', title: 'Q4 revenue review', createdByUserId: ME,
  createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z', lastEditor: null,
  writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: true,
  presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
});

const sidekick: AutomationSummary = {
  id: '00000000-0000-7000-8000-000000000005', name: 'Weekly changelog', description: '',
  scope: 'workspace', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', needsInput: true,
};

describe('Canvases and Sidekicks directory cache', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => closeLocalCache());

  it('paints the next launch from the lists the socket last applied', async () => {
    const before = new QueryClient();
    const mirror = mirrorCanvasDirectory(before, scope);
    applyVersionedSidebarList(before, 'canvases', 4, [canvas]);
    applyVersionedSidebarList(before, 'automations', 2, [sidekick]);
    await mirror.flush();
    mirror.stop();

    const after = new QueryClient();
    await hydrateCanvasDirectory(after, scope, () => true);
    expect(after.getQueryData<CanvasSidebarRow[]>(['canvases'])?.map((row) => [row.title, row.unread])).toEqual([['Q4 revenue review', true]]);
    expect(after.getQueryData<AutomationSummary[]>(['automations'])?.map((row) => [row.name, row.needsInput])).toEqual([['Weekly changelog', true]]);
    // The seed leaves the ledger alone, so the socket's first list still applies.
    expect(applyVersionedSidebarList(after, 'canvases', 0, [])).toBe(true);
  });

  it('writes nothing until the socket has applied a list', async () => {
    const client = new QueryClient();
    const mirror = mirrorCanvasDirectory(client, scope);
    client.setQueryData(['canvases'], [canvas]);
    await mirror.flush();
    mirror.stop();
    expect(await canvasDirectorySlice.read(scope, CANVAS_DIRECTORY_CACHE_KEY)).toBeNull();
  });

  it('never paints over a list the socket already delivered', async () => {
    await canvasDirectorySlice.write(scope, CANVAS_DIRECTORY_CACHE_KEY, { canvases: [canvas] });
    const client = new QueryClient();
    applyVersionedSidebarList(client, 'canvases', 9, []);
    await hydrateCanvasDirectory(client, scope, () => true);
    expect(client.getQueryData(['canvases'])).toEqual([]);
    expect(client.getQueryData(['automations'])).toBeUndefined();
  });

  it('drops a row whose Canvas list this build cannot read', async () => {
    await canvasDirectorySlice.write(scope, CANVAS_DIRECTORY_CACHE_KEY, { canvases: [{ id: 'not-a-canvas' } as never] });
    expect(await canvasDirectorySlice.read(scope, CANVAS_DIRECTORY_CACHE_KEY)).toBeNull();
  });
});
