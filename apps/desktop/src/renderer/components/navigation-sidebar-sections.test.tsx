import * as Tooltip from '@radix-ui/react-tooltip';
import type { CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CollaborationSessionProvider } from '../lib/collaboration-session';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type { AutomationSummary, Workspace } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { NavigationSidebar } from './navigation-sidebar';

/*
 * The Canvases and Sidekicks sections inside the real sidebar, as the rail will
 * switch to them at cutover (plan step B-1): selected through the section the
 * ui-store holds, since no rail button selects them yet.
 */

const api = vi.hoisted(() => ({
  getMyThreads: vi.fn(async () => ({ nextCursor: null, items: [], pinned: [] })),
  getActivity: vi.fn(async () => ({ nextCursor: null, items: [] })),
  getChannelStats: vi.fn(async () => []),
  getWorkspaceMembers: vi.fn(async () => []),
  createCanvas: vi.fn(),
  setCanvasPinned: vi.fn(),
  setSidekickPinned: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));
vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketHoverWarmup: () => ({ onPointerCancel: vi.fn(), onPointerEnter: vi.fn(), onPointerLeave: vi.fn() }),
  useWorkstreamSocketOpenContext: () => () => ({ state: 'retained_pair', socketLeaseId: 'lease-1' }),
}));

const ME = '00000000-0000-7000-8000-0000000000a1';
const workspace: Workspace = {
  id: 'org', name: 'Rally', region: 'enterprise', timezone: 'UTC',
  currentUser: { id: ME, name: 'Me', email: 'me@rally.test', timezone: 'UTC', role: 'owner', accessClass: 'member' },
};

function canvas(id: string, title: string, overrides: Partial<CanvasSidebarRow> = {}): CanvasSidebarRow {
  return {
    id, title, createdByUserId: ME, createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: false,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: false, ...overrides,
  } as CanvasSidebarRow;
}

function sidekick(id: string, name: string, overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return { id, name, description: '', scope: 'workspace', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', ...overrides };
}

function Location(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderSidebar(person: Workspace = workspace): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  applyVersionedSidebarList(client, 'canvases', 1, [
    canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { unread: true }),
    canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { pinnedPosition: 0 }),
  ]);
  applyVersionedSidebarList(client, 'automations', 1, [
    sidekick('triage', 'Incident triage', { needsInput: true }),
    sidekick('changelog', 'Weekly changelog'),
    sidekick('revenue', 'Revenue analyst', { pinnedPosition: 0 }),
  ]);
  render(<QueryClientProvider client={client}><Tooltip.Provider>
    <CollaborationSessionProvider api={api as never} session={{ user: { id: ME } } as never}>
      <MemoryRouter initialEntries={['/']}>
        <NavigationSidebar
          accessDecisionFailed={false}
          accessRequests={[]}
          accountMenu={<span>account</span>}
          attentionComplete
          attentionItems={[]}
          downloadedUpdate={null}
          onDecideAccessRequest={vi.fn()}
          onOpenAccessRequest={vi.fn()}
          onOpenSearch={vi.fn()}
          workspace={person}
        />
        <Routes><Route element={<Location />} path="*" /></Routes>
      </MemoryRouter>
    </CollaborationSessionProvider>
  </Tooltip.Provider></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.createCanvas.mockResolvedValue({ canvasId: '00000000-0000-7000-8000-0000000000c9', turnId: null });
});

describe('the Canvases and Sidekicks sections', () => {
  it('draws the Canvases section with its New and Search actions, and no rail button yet', async () => {
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    expect(screen.getByRole('heading', { name: 'Canvases' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Canvases' })).getByRole('link', { name: /Launch plan/ })).toBeInTheDocument();
    const unread = within(screen.getByRole('region', { name: 'All Canvases' })).getByRole('link', { name: /Q4 revenue review/ });
    expect(within(unread).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Canvases' })).queryByRole('img', { name: 'Unread' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search organization' })).toBeEnabled();
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).queryByRole('button', { name: /Canvases/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/canvases/00000000-0000-7000-8000-0000000000c9'));
    expect(api.createCanvas).toHaveBeenCalledWith({});
  });

  it('says so when New Canvas fails, rather than doing nothing', async () => {
    api.createCanvas.mockRejectedValue(new Error('The organization is not reachable.'));
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    expect(await screen.findByText('The Canvas could not be made. Try again.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('draws the Sidekicks section with Needs input first, and New Sidekick', () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    renderSidebar();
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Needs input' })).getByRole('link', { name: /Incident triage/ })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'All Sidekicks' })).getByRole('link', { name: /Weekly changelog/ })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Sidekicks' })).getByRole('link', { name: /Revenue analyst/ })).toBeInTheDocument();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')))
      .toEqual(['Needs input', 'Pinned Sidekicks', 'All Sidekicks']);
    fireEvent.click(screen.getByRole('button', { name: 'New Sidekick' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sidekicks/new');
  });

  it('offers a guest neither New action', () => {
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar({ ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } });
    expect(screen.queryByRole('button', { name: 'New Canvas' })).toBeNull();
  });

  it('remembers either section across launches', async () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    vi.resetModules();
    const relaunched = await import('../lib/ui-store');
    expect(relaunched.useUiStore.getState().sidebarSection).toBe('sidekicks');
  });
});
