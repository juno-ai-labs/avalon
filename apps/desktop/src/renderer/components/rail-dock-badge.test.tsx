import { CanvasSidebarRowSchema, type CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { dockBadgeCount, useRailDockBadge } from './navigation-sidebar';

const setDockBadgeCount = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ setDockBadgeCount }) }));

function canvas(suffix: string, unread: boolean): CanvasSidebarRow {
  return CanvasSidebarRowSchema.parse({
    id: `00000000-0000-7000-8000-0000000000${suffix}`, title: suffix, createdByUserId: '00000000-0000-7000-8000-0000000000a1',
    createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', artifactKind: null, unread,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
  });
}

function sidekick(id: string, overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return { id, name: id, description: '', scope: 'workspace', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', ...overrides };
}

describe('the dock badge', () => {
  beforeEach(() => setDockBadgeCount.mockClear());

  it('is nothing until Activity has arrived, then its unseen count', () => {
    expect([dockBadgeCount(undefined), dockBadgeCount({ unseenCount: 0, items: [] }), dockBadgeCount({ unseenCount: 7, items: [] })])
      .toEqual([null, 0, 7]);
  });

  it('follows the unseen Activity count while Rally is open, never the Canvas or Sidekick rows\' counts', async () => {
    const client = new QueryClient();
    renderHook(() => useRailDockBadge(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    // Lists with unread rows but no Activity yet: the badge an alert set stays.
    act(() => applyVersionedSidebarList(client, 'canvases', 1, [canvas('c1', true), canvas('c2', false), canvas('c3', true)]));
    act(() => applyVersionedSidebarList(client, 'automations', 1, [sidekick('waiting', { needsInput: true }), sidekick('quiet')]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(setDockBadgeCount).not.toHaveBeenCalled();

    act(() => applyVersionedSidebarList(client, 'activity', 1, { unseenCount: 5, items: [] }));
    await waitFor(() => expect(setDockBadgeCount.mock.calls).toEqual([[5]]));

    act(() => applyVersionedSidebarList(client, 'activity', 2, { unseenCount: 0, items: [] }));
    await waitFor(() => expect(setDockBadgeCount.mock.calls.at(-1)).toEqual([0]));
  });
});
