import type { WorkspaceSocketWatchDependencies } from '@rally/contracts/workspace-reach-watch';
import { describe, expect, it, vi } from 'vitest';
import { SidebarListsWatch } from './sidebar-lists-watch';

type Handlers = Pick<WorkspaceSocketWatchDependencies, 'onSubscribed' | 'onMessage'>;

const CANVAS = {
  id: '00000000-0000-7000-8000-0000000000c1', title: 'Q4 review', createdByUserId: '00000000-0000-7000-8000-0000000000a1',
  createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z', lastEditor: null, writerSidekickId: null,
  visibility: 'creator', artifactKind: null, unread: true, presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
};
const SIDEKICK = {
  id: '00000000-0000-7000-8000-0000000000b1', name: 'Incident triage', description: '', emailAddress: null,
  scope: 'workspace', status: 'active', nextRunAt: null, lastRunAt: null, updatedAt: '2026-11-07T09:00:00.000Z', needsInput: true,
};

function subscribeAnswer(): Record<string, unknown> {
  return {
    type: 'workspace_sync', eventId: '00000000-0000-7000-8000-000000000017', waterline: 4,
    occurredAt: '2026-11-07T09:00:00.000Z', topics: [], reason: 'initial',
    sidebar: {
      workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
      automations: { waterline: 3, items: [SIDEKICK] },
      notes: { waterline: 1, items: [], nextCursor: null },
      canvases: { waterline: 5, items: [CANVAS] },
    },
  };
}

async function harness(): Promise<{ watch: SidebarListsWatch; handlers: Handlers; onChange: ReturnType<typeof vi.fn> }> {
  let handlers!: Handlers;
  const onChange = vi.fn();
  const watch = new SidebarListsWatch({
    socket: (given) => { handlers = given; return vi.fn(); },
    onChange,
    logWarning: vi.fn(),
  });
  watch.start();
  return { watch, handlers, onChange };
}

const connection = {} as Parameters<Handlers['onSubscribed']>[1];

describe('the menu bar\'s Canvases and Sidekicks lists', () => {
  it('takes both lists from the subscribe answer, then each newer push, and drops an older one', async () => {
    const { watch, handlers, onChange } = await harness();
    expect(watch.snapshot()).toEqual({ canvases: null, sidekicks: null });

    handlers.onSubscribed(subscribeAnswer(), connection);
    expect(watch.snapshot()).toEqual({
      canvases: [{ id: CANVAS.id, title: 'Q4 review', unread: true, updatedAt: CANVAS.updatedAt }],
      sidekicks: [{ id: SIDEKICK.id, name: 'Incident triage', needsInput: true, unread: false }],
    });

    handlers.onMessage?.({ type: 'workspace_canvas_list', occurredAt: '2026-11-07T09:01:00.000Z', waterline: 4, items: [] }, connection);
    expect(watch.snapshot().canvases).toHaveLength(1);
    handlers.onMessage?.({ type: 'workspace_canvas_list', occurredAt: '2026-11-07T09:01:00.000Z', waterline: 6, items: [] }, connection);
    expect(watch.snapshot().canvases).toEqual([]);

    handlers.onMessage?.({
      type: 'workspace_sidebar_list', occurredAt: '2026-11-07T09:02:00.000Z', list: 'automations', waterline: 4,
      items: [{ ...SIDEKICK, needsInput: false, unread: true }],
    }, connection);
    expect(watch.snapshot().sidekicks).toEqual([{ id: SIDEKICK.id, name: 'Incident triage', needsInput: false, unread: true }]);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalled();
  });

  it('forgets both lists when stopped', async () => {
    const { watch, handlers } = await harness();
    handlers.onSubscribed(subscribeAnswer(), connection);
    watch.stop();
    expect(watch.snapshot()).toEqual({ canvases: null, sidekicks: null });
    expect(watch.running()).toBe(false);
  });
});
