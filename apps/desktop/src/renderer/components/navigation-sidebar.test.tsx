import { StrictMode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CollaborationSessionProvider } from '../lib/collaboration-session';
import { applyVersionedSidebarList, type ActivityList } from '../lib/sidebar-list-store';
import type { AutomationSummary, Workspace } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { NavigationSidebar } from './navigation-sidebar';

/*
 * The rail and its three sections, Canvases, Sidekicks and Activity, inside
 * the real sidebar, and the phone sheet the sidebar becomes at phone width.
 */

const api = vi.hoisted(() => ({
  getWorkspaceMembers: vi.fn(async () => []),
  createCanvas: vi.fn(),
  setCanvasPinned: vi.fn(),
  setSidekickPinned: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
/** The workspace socket the sidebar sends Mark all seen on; only its command is used. */
const socket = vi.hoisted(() => ({ markAllActivitySeen: vi.fn() }));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => socket }));

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

function renderSidebar(person: Workspace = workspace, route = '/', activity?: ActivityList, strict = false, landing = false): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (activity) applyVersionedSidebarList(client, 'activity', 1, activity);
  applyVersionedSidebarList(client, 'canvases', 1, [
    canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { unread: true }),
    canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { pinnedPosition: 0 }),
  ]);
  applyVersionedSidebarList(client, 'automations', 1, [
    sidekick('triage', 'Incident triage', { needsInput: true }),
    sidekick('changelog', 'Weekly changelog'),
    sidekick('revenue', 'Revenue analyst', { pinnedPosition: 0 }),
  ]);
  const tree = <QueryClientProvider client={client}><Tooltip.Provider>
    <CollaborationSessionProvider api={api as never} session={{ user: { id: ME } } as never}>
      <MemoryRouter initialEntries={[route]}>
        <NavigationSidebar
          accountMenu={<span>account</span>}
          downloadedUpdate={null}
          onOpenSearch={vi.fn()}
          workspace={person}
        />
        <Routes>
          {/* The app's landing: a launch starts at "/" and is sent to the Canvases home. */}
          {landing && <Route element={<Navigate replace to="/canvases" />} path="/" />}
          <Route element={<Location />} path="*" />
        </Routes>
      </MemoryRouter>
    </CollaborationSessionProvider>
  </Tooltip.Provider></QueryClientProvider>;
  // StrictMode runs effects twice, as the app's development build does.
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useUiStore.getState().setSidebarSection('canvases');
  useUiStore.getState().setSidebarOpen(false);
  useUiStore.getState().setSheetAfterNavigation(false);
  api.createCanvas.mockResolvedValue({ canvasId: '00000000-0000-7000-8000-0000000000c9', turnId: null });
});

describe('the Canvases and Sidekicks sections', () => {
  it('draws a rail of Canvases and Sidekicks, each with its count, and switches between them', () => {
    renderSidebar();
    const rail = screen.getByRole('navigation', { name: 'Sections' });
    expect([...rail.querySelectorAll('.navigation-rail-label')].map((label) => label.textContent))
      .toEqual(['Canvases', 'Sidekicks', 'Activity']);
    const canvases = within(rail).getByRole('button', { name: /Canvases/ });
    expect(canvases).toHaveAttribute('aria-current', 'page');
    expect(within(canvases).getByRole('img', { name: '1 unread' })).toHaveTextContent('1');
    expect(within(within(rail).getByRole('button', { name: /Sidekicks/ })).getByRole('img', { name: '1 waiting' })).toHaveTextContent('1');
    fireEvent.click(within(rail).getByRole('button', { name: /Sidekicks/ }));
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeInTheDocument();
    expect(useUiStore.getState().sidebarSection).toBe('sidekicks');
  });

  it('closes the phone sheet when a row is opened from it, and keeps it open across sections', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: /Sidekicks/ }));
    fireEvent.click(screen.getByRole('button', { name: /Canvases/ }));
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('link', { name: /Launch plan/ }));

    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the phone sheet once, after its own reset, when a navigation asked for it', () => {
    // A deep link into another organization remounts the sidebar and changes
    // the route; both reset the sheet, so the link asks for it this way.
    useUiStore.getState().setSheetAfterNavigation(true);
    renderSidebar();

    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
    expect(useUiStore.getState().sheetAfterNavigation).toBe(false);

    // Spent: the next navigation closes the sheet as any other does.
    fireEvent.click(screen.getByRole('link', { name: /Launch plan/ }));
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the phone sheet on Escape and hands focus back to its button', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    fireEvent.keyDown(window, { key: 'Escape' });

    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('draws the Canvases section with its New and Search actions', async () => {
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    expect(screen.getByRole('heading', { name: 'Canvases' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Canvases' })).getByRole('link', { name: /Launch plan/ })).toBeInTheDocument();
    const unread = within(screen.getByRole('region', { name: 'All Canvases' })).getByRole('link', { name: /Q4 revenue review/ });
    expect(within(unread).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Canvases' })).queryByRole('img', { name: 'Unread' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search organization' })).toBeEnabled();
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

  it('shows the section of whatever was opened, however it was opened', () => {
    renderSidebar(workspace, '/sidekicks/triage');
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeInTheDocument();
    expect(useUiStore.getState().sidebarSection).toBe('sidekicks');
  });

  it('keeps the section left open when the window lands on a section home', () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    renderSidebar(workspace, '/canvases', undefined, true);
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeInTheDocument();
    expect(useUiStore.getState().sidebarSection).toBe('sidekicks');
  });

  it('keeps the section left open across a launch the landing redirects to the Canvases home', () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    renderSidebar(workspace, '/', undefined, true, true);
    expect(screen.getByTestId('location')).toHaveTextContent('/canvases');
    expect(useUiStore.getState().sidebarSection).toBe('sidekicks');
  });

  it('opens the section of a Canvas the window lands on', () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    renderSidebar(workspace, '/canvases/00000000-0000-7000-8000-0000000000c1');
    expect(useUiStore.getState().sidebarSection).toBe('canvases');
  });

  it('remembers either section across launches', async () => {
    useUiStore.getState().setSidebarSection('sidekicks');
    vi.resetModules();
    const relaunched = await import('../lib/ui-store');
    expect(relaunched.useUiStore.getState().sidebarSection).toBe('sidekicks');
  });
});

describe('the Activity section', () => {
  const AVERY = '00000000-0000-7000-8000-0000000000b1';
  const CANVAS = '00000000-0000-7000-8000-0000000000c1';
  const SIDEKICK = '00000000-0000-7000-8000-0000000000d1';
  const RUN = '00000000-0000-7000-8000-0000000000d2';
  const page: ActivityList = {
    unseenCount: 2,
    items: [
      { id: 'a1', kind: 'needs_input', parentKind: 'automation', parentId: SIDEKICK, parentTitle: 'Release notes', substreamId: RUN as never,
        messageId: null, messageSequence: null, runId: RUN, actor: { kind: 'sidekick', id: SIDEKICK }, preview: 'Which environment?', createdAt: '2026-11-08T09:59:00.000Z', seen: false },
      { id: 'a2', kind: 'mention', parentKind: 'canvas', parentId: CANVAS, parentTitle: 'Q4 revenue review', substreamId: '0' as never,
        messageId: '00000000-0000-7000-8000-0000000000e1', messageSequence: 42, runId: null, actor: { kind: 'person', id: AVERY }, preview: 'Can you check the totals?',
        createdAt: '2026-11-08T09:58:00.000Z', seen: false },
      { id: 'a3', kind: 'participant_added', parentKind: 'canvas', parentId: CANVAS, parentTitle: null, substreamId: '0' as never,
        messageId: null, messageSequence: null, runId: null, actor: { kind: 'person', id: AVERY }, preview: null, createdAt: '2026-11-08T09:00:00.000Z', seen: true },
    ],
  };

  beforeEach(() => {
    api.getWorkspaceMembers.mockResolvedValue([{ id: AVERY, name: 'Avery', email: 'avery@rally.test', timezone: 'UTC' }] as never);
  });

  it('badges the rail with the unseen count and lists who did what where, newest first, opening each where it happened', async () => {
    renderSidebar(workspace, '/', page);
    const rail = screen.getByRole('navigation', { name: 'Sections' });
    const activity = within(rail).getByRole('button', { name: /Activity/ });
    expect(within(activity).getByRole('img', { name: '2 unseen' })).toHaveTextContent('2');
    fireEvent.click(activity);
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();

    const rows = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    await waitFor(() => expect(rows[1]).toHaveTextContent('Avery mentioned you in Q4 revenue review'));
    expect(rows.map((row) => row.querySelector('.activity-row-text')?.textContent)).toEqual([
      'Release notes needs your input',
      'Avery mentioned you in Q4 revenue review',
      // A Canvas the person may no longer open is not named.
      'Avery added you to a Canvas',
    ]);
    // A run that needs input opens that run, where its question is; a mention
    // opens the Chat at its message; the add, which names none, opens the Canvas.
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      `/sidekicks/${SIDEKICK}?run=${RUN}`,
      `/canvases/${CANVAS}?turn=00000000-0000-7000-8000-0000000000e1&sequence=42`,
      `/canvases/${CANVAS}`,
    ]);
    expect(rows.map((row) => within(row).queryByRole('img', { name: 'Unseen' }) !== null)).toEqual([true, true, false]);
    expect(rows[0]).toHaveTextContent('Which environment?');

    // Opening a row keeps Activity open beside it, the next row a click away.
    fireEvent.click(rows[1]!);
    expect(screen.getByTestId('location')).toHaveTextContent(`/canvases/${CANVAS}`);
    expect(useUiStore.getState().sidebarSection).toBe('activity');
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
  });

  it('marks the rows about what the route has open, not the row last clicked', () => {
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, `/canvases/${CANVAS}`, page);
    const rows = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'page', 'page']);
    cleanup();
    // To the run that asked: the highlight moves with the route, to that
    // run's row alone.
    renderSidebar(workspace, `/sidekicks/${SIDEKICK}?run=${RUN}`, page);
    const back = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    expect(back.map((row) => row.getAttribute('aria-current'))).toEqual(['page', null, null]);
    cleanup();
    // The Sidekick's shared conversation is not that run.
    renderSidebar(workspace, `/sidekicks/${SIDEKICK}`, page);
    const shared = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    expect(shared.map((row) => row.getAttribute('aria-current'))).toEqual([null, null, null]);
  });

  it('says how it fills when there is nothing yet, and offers Mark all seen only with something unseen', () => {
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, '/', { unseenCount: 0, items: [] });
    expect(screen.getByText('Nothing yet. Mentions, Canvases you are added to and Sidekick runs that need you or finish show up here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all seen' })).toBeDisabled();
  });

  it('sends Mark all seen on the workspace socket when something is unseen', () => {
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, '/', page);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(socket.markAllActivitySeen).toHaveBeenCalledTimes(1);
  });
});
