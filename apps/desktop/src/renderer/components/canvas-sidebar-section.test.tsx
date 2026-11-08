import { asUserId } from '@rally/contracts';
import type { CanvasSidebarRow } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasRenameRequested } from '../lib/canvases';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import { CanvasesSection } from './canvas-sidebar-section';

const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const MAYA = asUserId('00000000-0000-7000-8000-0000000000a2');
const setCanvasPinned = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({ api: { setCanvasPinned, getWorkspaceMembers }, session: { user: { id: ME } } }),
}));

function canvas(id: string, title: string, overrides: Partial<CanvasSidebarRow> = {}): CanvasSidebarRow {
  return {
    id, title, createdByUserId: ME, createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: false,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: false, ...overrides,
  } as CanvasSidebarRow;
}

function renderSection(rows: CanvasSidebarRow[] | null, at = '/'): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (rows) applyVersionedSidebarList(client, 'canvases', 1, rows);
  render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter initialEntries={[at]}>
    <CanvasesSection scroll={createRef()} />
  </MemoryRouter></Tooltip.Provider></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  setCanvasPinned.mockReset().mockResolvedValue(undefined);
  getWorkspaceMembers.mockReset().mockResolvedValue([{ id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC' }]);
});

describe('CanvasesSection', () => {
  it('draws Pinned first in pinned order, then every other Canvas by recency', async () => {
    renderSection([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Acme follow-up', { unread: true }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { pinnedPosition: 1, lastEditor: { kind: 'rally', id: null } }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Q4 revenue review', { pinnedPosition: 0, presentUserIds: [MAYA] }),
    ], '/canvases/00000000-0000-7000-8000-0000000000c1');
    const pinned = screen.getByRole('region', { name: 'Pinned Canvases' });
    expect(within(pinned).getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringContaining('Q4 revenue review'), expect.stringContaining('Launch plan'),
    ]);
    expect(await within(pinned).findByText('Maya is here')).toBeInTheDocument();
    expect(within(pinned).getByRole('img', { name: 'People are here' })).toBeInTheDocument();
    expect(within(pinned).getByText('Edited by Rally')).toBeInTheDocument();
    const all = screen.getByRole('region', { name: 'All Canvases' });
    const row = within(all).getByRole('link', { name: /Acme follow-up/ });
    expect(row).toHaveAttribute('href', '/canvases/00000000-0000-7000-8000-0000000000c1');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row).toHaveClass('is-unread');
    expect(within(row).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(within(row).getByText('Made by you')).toBeInTheDocument();
  });

  it('pins a Canvas dragged into Pinned', async () => {
    renderSection([canvas('00000000-0000-7000-8000-0000000000c1', 'Acme follow-up')]);
    const row = screen.getByRole('link', { name: /Acme follow-up/ });
    const target = screen.getByRole('region', { name: 'Pinned Canvases' });
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(row, { dataTransfer });
    const over = createEvent.dragOver(target, { dataTransfer });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(setCanvasPinned).toHaveBeenCalledWith('00000000-0000-7000-8000-0000000000c1', true));
  });

  it('unpins from a pinned row’s menu', async () => {
    renderSection([canvas('00000000-0000-7000-8000-0000000000c1', 'Launch plan', { pinnedPosition: 0 })]);
    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch plan/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    expect(setCanvasPinned).toHaveBeenCalledWith('00000000-0000-7000-8000-0000000000c1', false);
  });

  it('opens the Canvas with its title being renamed from a row’s Rename…', async () => {
    const opened = vi.fn();
    function Opened(): null {
      const location = useLocation();
      opened(location.pathname, canvasRenameRequested(location.state));
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyVersionedSidebarList(client, 'canvases', 1, [canvas('00000000-0000-7000-8000-0000000000c1', 'Launch plan')]);
    render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter initialEntries={['/']}>
      <CanvasesSection scroll={createRef()} />
      <Routes><Route element={<Opened />} path="/canvases/:id" /><Route element={null} path="/" /></Routes>
    </MemoryRouter></Tooltip.Provider></QueryClientProvider>);
    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch plan/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    await waitFor(() => expect(opened).toHaveBeenLastCalledWith('/canvases/00000000-0000-7000-8000-0000000000c1', true));
  });

  it('draws the sidebar skeleton until the list arrives', () => {
    renderSection(null);
    expect(screen.getByRole('region', { name: 'Pinned Canvases' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('No Canvases yet.')).toBeNull();
  });
});
