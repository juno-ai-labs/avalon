import { CanvasSidebarRowSchema, type CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { useRailDockBadge } from './navigation-sidebar';

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

  it('is the rail\'s two counts added up, sent only once both lists have arrived', async () => {
    const client = new QueryClient();
    renderHook(() => useRailDockBadge(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    act(() => applyVersionedSidebarList(client, 'canvases', 1, [canvas('c1', true), canvas('c2', false), canvas('c3', true)]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(setDockBadgeCount).not.toHaveBeenCalled();

    act(() => applyVersionedSidebarList(client, 'automations', 1, [
      sidekick('waiting', { needsInput: true }),
      sidekick('unread', { unread: true }),
      sidekick('quiet'),
    ]));
    await waitFor(() => expect(setDockBadgeCount.mock.calls).toEqual([[4]]));

    act(() => applyVersionedSidebarList(client, 'canvases', 2, [canvas('c1', false)]));
    await waitFor(() => expect(setDockBadgeCount.mock.calls.at(-1)).toEqual([2]));
  });
});
