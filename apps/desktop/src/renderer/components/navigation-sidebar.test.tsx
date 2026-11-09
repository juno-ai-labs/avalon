import { StrictMode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigationType, type InitialEntry } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CollaborationSessionProvider } from '../lib/collaboration-session';
import { applyVersionedSidebarList, type ActivityList } from '../lib/sidebar-list-store';
import type { AutomationSummary, Workspace } from '../lib/types';
import { RESTORED_ROUTE } from '../lib/landing';
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
  decideCanvasAccess: vi.fn(),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
/** The workspace socket the sidebar sends Mark all seen on; only its command is used. */
const socket = vi.hoisted(() => ({ markAllActivitySeen: vi.fn(), state: 'connected' as string }));
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

/** The pane: where the route is, how it got there, and a link inside it, as a Canvas's own links are. */
function Location(): React.JSX.Element {
  const { pathname, search } = useLocation();
  return <div>
    <div data-navigation={useNavigationType()} data-testid="location">{pathname}</div>
    <div data-testid="address">{`${pathname}${search}`}</div>
    <Link to="/sidekicks/triage">Open a Sidekick from the pane</Link>
  </div>;
}

function renderSidebar(person: Workspace = workspace, route: InitialEntry = '/', activity?: ActivityList, strict = false, landing = false): QueryClient {
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
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  socket.state = 'connected';
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
    // The section first, then its count, in the button's own name.
    expect(canvases).toHaveAccessibleName('Canvases, 1 unread');
    expect(canvases.querySelector('.navigation-rail-badge')).toHaveTextContent('1');
    expect(within(rail).getByRole('button', { name: /Sidekicks/ })).toHaveAccessibleName('Sidekicks, 1 waiting');
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

  it('at phone width, closing the sheet on another list returns its bar to the open screen\'s section', () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      renderSidebar(workspace, '/canvases');
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      fireEvent.click(screen.getByRole('button', { name: /Sidekicks/ }));

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(useUiStore.getState().sidebarSection).toBe('canvases');
      expect(screen.getByRole('heading', { name: 'Canvases' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
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
    const unread = within(screen.getByRole('region', { name: 'All canvases' })).getByRole('link', { name: /Q4 revenue review/ });
    expect(within(unread).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Pinned Canvases' })).queryByRole('img', { name: 'Unread' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search organization' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/canvases/00000000-0000-7000-8000-0000000000c9'));
    expect(api.createCanvas).toHaveBeenCalledWith({ canvasId: expect.any(String) });
  });

  it('says the build is out of date above lists the device cache painted, and offers the update', () => {
    socket.state = 'update_required';
    renderSidebar();
    // The cached rows still paint, so nothing about an empty list can say why they stopped moving.
    expect(within(screen.getByRole('region', { name: 'All canvases' })).getByRole('link', { name: /Q4 revenue review/ })).toBeInTheDocument();
    expect(screen.getByText('This version of Rally is out of date. Lists here stop updating until it is.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload Rally' })).toBeInTheDocument();
  });

  it('says so when New Canvas fails, rather than doing nothing', async () => {
    api.createCanvas.mockRejectedValue(new Error('The organization is not reachable.'));
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    expect(await screen.findByText('The Canvas could not be made. Try again.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('makes one Canvas for a double click on New Canvas', async () => {
    let answer!: (created: { canvasId: string; turnId: null }) => void;
    api.createCanvas.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    act(() => answer({ canvasId: '00000000-0000-7000-8000-0000000000c9', turnId: null }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/canvases/00000000-0000-7000-8000-0000000000c9'));
    expect(api.createCanvas).toHaveBeenCalledTimes(1);
  });

  it('retries a failed New Canvas as the same Canvas, so an answer lost in transit makes no second one', async () => {
    api.createCanvas.mockRejectedValueOnce(new Error('The organization is not reachable.'));
    useUiStore.getState().setSidebarSection('canvases');
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    await screen.findByText('The Canvas could not be made. Try again.');
    // The failure's notice is a dialog over the sidebar; the button under it is the one pressed again.
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas', hidden: true }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/canvases/00000000-0000-7000-8000-0000000000c9'));
    const [first, second] = api.createCanvas.mock.calls.map(([input]) => input as { canvasId: string });
    expect(second!.canvasId).toBe(first!.canvasId);
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

  it('at phone width, names the home the route lands on in the bar while Activity stays the stored section', () => {
    useUiStore.getState().setSidebarSection('activity');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      renderSidebar(workspace, '/canvases');
      expect(screen.getByRole('heading', { name: 'Canvases' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New Canvas' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark all seen' })).toBeNull();
      expect(useUiStore.getState().sidebarSection).toBe('activity');
      // The sheet, once opened, is the list left open.
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("badges a Canvas row's glyph with the Canvas's mark, in the icon and colour chosen for it, and a Sidekick row with none", async () => {
    useUiStore.getState().setSidebarSection('activity');
    const client = renderSidebar(workspace, '/', page);
    const badges = (): Array<HTMLElement | null> => within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link')
      .map((row) => row.querySelector<HTMLElement>('.activity-row-tile .identity-tile-badge-fill'));
    const [sidekickRow, mention] = badges();
    expect(sidekickRow).toBeNull();
    // Unchosen: the Canvas's default, its Chat-only layout in the hue its id gives it.
    expect(mention).toHaveStyle({ background: 'var(--av-sys-color-project-tint-green)' });
    expect(mention!.querySelector('svg')).toHaveClass('lucide-panels-top-left');
    act(() => {
      applyVersionedSidebarList(client, 'canvases', 2, [
        canvas(CANVAS, 'Q4 revenue review', { appearance: { icon: 'flag', color: 'orange' } }),
      ]);
    });
    await waitFor(() => {
      for (const badge of badges().slice(1)) {
        expect(badge).toHaveStyle({ background: 'var(--av-sys-color-project-tint-orange)' });
        expect(badge!.querySelector('svg')).toHaveClass('lucide-flag');
      }
    });
  });

  it('at phone width, keeps Activity open when its sheet closes for one of its rows', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      renderSidebar(workspace, '/canvases', page);
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /Activity/ }));
      const rows = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
      await waitFor(() => expect(rows[1]).toHaveTextContent('Avery mentioned you in Q4 revenue review'));

      fireEvent.click(rows[1]!);

      expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
      expect(useUiStore.getState().sidebarSection).toBe('activity');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('badges the rail with the unseen count and lists who did what where, newest first, opening each where it happened', async () => {
    renderSidebar(workspace, '/', page);
    const rail = screen.getByRole('navigation', { name: 'Sections' });
    const activity = within(rail).getByRole('button', { name: /Activity/ });
    expect(activity).toHaveAccessibleName('Activity, 2 unseen');
    expect(activity.querySelector('.navigation-rail-badge')).toHaveTextContent('2');
    expect(within(rail).getByRole('button', { name: /^Sidekicks, \d+ waiting$/ })).toBeInTheDocument();
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

  describe('entering it opens its top row', () => {
    const TOP = `/sidekicks/${SIDEKICK}?run=${RUN}`;
    const MENTION = `/canvases/${CANVAS}?turn=00000000-0000-7000-8000-0000000000e1&sequence=42`;
    const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Sections' });
    const pick = (name: RegExp): void => { fireEvent.click(within(rail()).getByRole('button', { name })); };
    const rows = (): HTMLElement[] => within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');

    it('from the rail, pushes the top row into the pane and draws that row open', () => {
      renderSidebar(workspace, '/canvases', page);
      pick(/Activity/);
      expect(screen.getByTestId('address')).toHaveTextContent(TOP);
      expect(screen.getByTestId('location')).toHaveAttribute('data-navigation', 'PUSH');
      expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual(['page', null, null]);
      expect(useUiStore.getState().sidebarSection).toBe('activity');
    });

    it('at launch with Activity stored, replaces the landing with the top row once the list arrives, and not before', async () => {
      useUiStore.getState().setSidebarSection('activity');
      const client = renderSidebar(workspace, '/', undefined, true, true);
      expect(screen.getByTestId('address')).toHaveTextContent(/^\/canvases$/u);
      await act(async () => { applyVersionedSidebarList(client, 'activity', 1, page); });
      await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(TOP));
      expect(screen.getByTestId('location')).toHaveAttribute('data-navigation', 'REPLACE');
    });

    it('at launch, keeps a Canvas the window lands on, restored by this device or opened by a link', () => {
      useUiStore.getState().setSidebarSection('activity');
      renderSidebar(workspace, { pathname: `/canvases/${CANVAS}`, state: RESTORED_ROUTE }, page);
      expect(screen.getByTestId('address')).toHaveTextContent(new RegExp(`^/canvases/${CANVAS}$`, 'u'));
      cleanup();
      renderSidebar(workspace, `/canvases/${CANVAS}`, page);
      expect(screen.getByTestId('address')).toHaveTextContent(new RegExp(`^/canvases/${CANVAS}$`, 'u'));
      expect(useUiStore.getState().sidebarSection).toBe('activity');
    });

    it('from the rail, gives way to a navigation made before the list arrived', async () => {
      const client = renderSidebar(workspace, '/canvases');
      pick(/Activity/);
      fireEvent.click(screen.getByRole('link', { name: 'Open a Sidekick from the pane' }));
      await act(async () => { applyVersionedSidebarList(client, 'activity', 1, page); });
      await waitFor(() => expect(rows()).toHaveLength(3));
      await act(async () => {});
      expect(screen.getByTestId('address')).toHaveTextContent(/^\/sidekicks\/triage$/u);
    });

    it('opens nothing for an empty feed, nor for the first row to arrive after it', async () => {
      const client = renderSidebar(workspace, '/canvases', { unseenCount: 0, items: [] });
      pick(/Activity/);
      expect(screen.getByTestId('address')).toHaveTextContent(/^\/canvases$/u);
      await act(async () => { applyVersionedSidebarList(client, 'activity', 2, page); });
      await waitFor(() => expect(rows()).toHaveLength(3));
      await act(async () => {});
      expect(screen.getByTestId('address')).toHaveTextContent(/^\/canvases$/u);
    });

    it('does not move the pane for a row arriving on top while Activity stays open', async () => {
      const client = renderSidebar(workspace, '/canvases', page);
      pick(/Activity/);
      fireEvent.click(rows()[1]!);
      expect(screen.getByTestId('address')).toHaveTextContent(MENTION);
      await act(async () => { applyVersionedSidebarList(client, 'activity', 2, { unseenCount: 3, items: [
        { ...page.items[1]!, id: 'a0', messageId: '00000000-0000-7000-8000-0000000000e9', messageSequence: 50, createdAt: '2026-11-08T10:00:00.000Z' },
        ...page.items,
      ] }); });
      await waitFor(() => expect(rows()).toHaveLength(4));
      await act(async () => {});
      expect(screen.getByTestId('address')).toHaveTextContent(MENTION);
    });

    it('opens the top row again when Activity is left for another section and picked again', () => {
      renderSidebar(workspace, '/canvases', page);
      pick(/Activity/);
      fireEvent.click(rows()[1]!);
      pick(/Canvases/);
      expect(screen.getByTestId('address')).toHaveTextContent(MENTION);
      pick(/Activity/);
      expect(screen.getByTestId('address')).toHaveTextContent(TOP);
    });
  });

  describe('stays open until another section is picked', () => {
    it('when one of its rows opens a Canvas', () => {
      useUiStore.getState().setSidebarSection('activity');
      renderSidebar(workspace, '/', page);
      fireEvent.click(within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link')[1]!);
      expect(screen.getByTestId('location')).toHaveTextContent(`/canvases/${CANVAS}`);
      expect(useUiStore.getState().sidebarSection).toBe('activity');
    });

    it('when the pane opens a Sidekick of its own accord', () => {
      useUiStore.getState().setSidebarSection('activity');
      renderSidebar(workspace, `/canvases/${CANVAS}`, page);
      fireEvent.click(screen.getByRole('link', { name: 'Open a Sidekick from the pane' }));
      expect(screen.getByTestId('location')).toHaveTextContent('/sidekicks/triage');
      expect(useUiStore.getState().sidebarSection).toBe('activity');
      expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    });

    it('at phone width, when its sheet is closed without opening anything', () => {
      const width = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      try {
        renderSidebar(workspace, '/canvases', { unseenCount: 0, items: [] });
        fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
        fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /Activity/ }));

        fireEvent.keyDown(window, { key: 'Escape' });

        expect(useUiStore.getState().sidebarSection).toBe('activity');
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      }
    });
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

  it('opens a finished run in the shared conversation, which clears it, and marks none of a Sidekick\'s finished rows open', () => {
    const OTHER_RUN = '00000000-0000-7000-8000-0000000000d3';
    const finished = (id: string, runId: string): ActivityList['items'][number] => ({
      id, kind: 'run_finished', parentKind: 'automation', parentId: SIDEKICK, parentTitle: 'Release notes', substreamId: runId as never,
      messageId: null, messageSequence: null, runId, actor: { kind: 'sidekick', id: SIDEKICK }, preview: 'Shipped.', createdAt: '2026-11-08T09:59:00.000Z', seen: true,
    });
    const runs: ActivityList = { unseenCount: 1, items: [page.items[0]!, finished('f1', RUN), finished('f2', OTHER_RUN)] };
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, `/sidekicks/${SIDEKICK}`, runs);
    const rows = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      `/sidekicks/${SIDEKICK}?run=${RUN}`,
      `/sidekicks/${SIDEKICK}`,
      `/sidekicks/${SIDEKICK}`,
    ]);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, null, null]);
    cleanup();
    // On the run that asked, only its Needs input row is open.
    renderSidebar(workspace, `/sidekicks/${SIDEKICK}?run=${RUN}`, runs);
    const onRun = within(screen.getByRole('region', { name: 'Activity' })).getAllByRole('link');
    expect(onRun.map((row) => row.getAttribute('aria-current'))).toEqual(['page', null, null]);
  });

  describe('the kinds about replies, versions and access', () => {
    const MAYA = '00000000-0000-7000-8000-0000000000b2';
    const ARTIFACT = '00000000-0000-7000-8000-0000000000f1';
    const base = { parentKind: 'canvas' as const, parentId: CANVAS, parentTitle: 'Q4 revenue review', substreamId: '0' as never,
      messageId: null, messageSequence: null, runId: null, actor: { kind: 'person' as const, id: AVERY }, preview: null,
      createdAt: '2026-11-08T09:00:00.000Z', seen: false };
    const item = (overrides: Partial<ActivityList['items'][number]>): ActivityList['items'][number] => ({ ...base, id: 'x', kind: 'mention', ...overrides });

    beforeEach(() => {
      api.getWorkspaceMembers.mockResolvedValue([
        { id: AVERY, name: 'Avery', email: 'avery@rally.test', timezone: 'UTC' },
        { id: MAYA, name: 'Maya', email: 'maya@rally.test', timezone: 'UTC' },
      ] as never);
      api.decideCanvasAccess.mockReset().mockResolvedValue({ state: 'approved' });
    });

    async function rowsOf(items: ActivityList['items']): Promise<HTMLElement[]> {
      useUiStore.getState().setSidebarSection('activity');
      renderSidebar(workspace, '/', { unseenCount: items.length, items });
      const region = screen.getByRole('region', { name: 'Activity' });
      await waitFor(() => expect(within(region).getAllByRole('link')[0]).toHaveTextContent(/^Avery|^Maya/u));
      return within(region).getAllByRole('link');
    }

    it('names a reply by its author and place, previews it, and opens the Chat at it or the Sidekick conversation', async () => {
      const rows = await rowsOf([
        item({ id: 'm1', kind: 'new_message', messageId: '00000000-0000-7000-8000-0000000000e2', messageSequence: 9, preview: 'Totals look right' }),
        item({ id: 'm2', kind: 'new_message', preview: 'Older reply' }),
        item({ id: 'm3', kind: 'new_message', parentKind: 'automation', parentId: SIDEKICK, parentTitle: 'Release notes', preview: 'Ship it' }),
      ]);
      expect(rows.map((row) => row.querySelector('.activity-row-text')?.textContent)).toEqual([
        'Avery in Q4 revenue review', 'Avery in Q4 revenue review', 'Avery in Release notes',
      ]);
      expect(rows[0]).toHaveTextContent('Totals look right');
      expect(rows.map((row) => row.getAttribute('href'))).toEqual([
        `/canvases/${CANVAS}?turn=00000000-0000-7000-8000-0000000000e2&sequence=9`,
        `/canvases/${CANVAS}`,
        `/sidekicks/${SIDEKICK}`,
      ]);
    });

    it('names a pinned Canvas\'s new version and opens the Canvas onto that artifact', async () => {
      const rows = await rowsOf([item({ id: 'u1', kind: 'artifact_updated', artifact: { resourceId: ARTIFACT, title: 'Board deck' } })]);
      expect(rows[0]!.querySelector('.activity-row-text')).toHaveTextContent('Avery updated Board deck in Q4 revenue review');
      expect(rows[0]).toHaveAttribute('href', `/canvases/${CANVAS}?artifact=${ARTIFACT}`);
    });

    it('keeps every name of the new kinds in the row and its tooltip, the place last and bold, and the dot on the first line when there is no preview', async () => {
      const rows = await rowsOf([
        item({ id: 'k1', kind: 'access_request', accessRequest: { state: 'pending', decidedByName: null } }),
        item({ id: 'k2', kind: 'access_granted', actor: { kind: 'person', id: MAYA } }),
        item({ id: 'k3', kind: 'artifact_updated', artifact: { resourceId: ARTIFACT, title: 'Board meeting readiness checklist' } }),
      ]);
      expect(rows.map((row) => row.getAttribute('title'))).toEqual([
        'Avery asked to open Q4 revenue review',
        'Maya let you into Q4 revenue review',
        'Avery updated Board meeting readiness checklist in Q4 revenue review',
      ]);
      expect(rows.map((row) => [...row.querySelectorAll('.activity-row-text strong')].map((strong) => strong.textContent))).toEqual([
        ['Avery', 'Q4 revenue review'],
        ['Maya', 'Q4 revenue review'],
        ['Avery', 'Board meeting readiness checklist', 'Q4 revenue review'],
      ]);
      // No preview: one line, holding the sentence, the time and the dot.
      for (const row of rows) {
        const lines = row.querySelectorAll('.navigation-row-line');
        expect(lines).toHaveLength(1);
        expect(within(lines[0] as HTMLElement).getByRole('img', { name: 'Unseen' })).toBeInTheDocument();
      }
    });

    it('offers Approve and Deny under a pending request, each sending the decision for that requester', async () => {
      const rows = await rowsOf([item({ id: 'r1', kind: 'access_request', preview: 'For the board review', accessRequest: { state: 'pending', decidedByName: null } })]);
      expect(rows[0]!.querySelector('.activity-row-text')).toHaveTextContent('Avery asked to open Q4 revenue review');
      expect(rows[0]).toHaveTextContent('For the board review');
      expect(rows[0]).toHaveAttribute('href', `/canvases/${CANVAS}`);
      // The buttons are beside the link, not inside it.
      expect(within(rows[0]!).queryByRole('button')).toBeNull();
      // The preview keeps its own line, with the dot at its end.
      expect(within(rows[0]!.querySelectorAll<HTMLElement>('.navigation-row-line')[1]!).getByRole('img', { name: 'Unseen' })).toBeInTheDocument();
      // Named for the Canvas too, so two requests from one person differ.
      fireEvent.click(screen.getByRole('button', { name: 'Approve Avery for Q4 revenue review' }));
      await waitFor(() => expect(api.decideCanvasAccess).toHaveBeenCalledWith(CANVAS, AVERY, 'approve'));
      // Answered: both stay held until the push settles the row, so a second
      // press cannot meet this person's own answer as already settled.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve Avery for Q4 revenue review' })).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Deny Avery for Q4 revenue review' })).toBeDisabled();
      expect(api.decideCanvasAccess).toHaveBeenCalledTimes(1);
    });

    it('sends Deny for the requester, and names the buttons for the request until the name is known', async () => {
      api.getWorkspaceMembers.mockResolvedValue([] as never);
      useUiStore.getState().setSidebarSection('activity');
      renderSidebar(workspace, '/', { unseenCount: 1, items: [item({ id: 'r4', kind: 'access_request', accessRequest: { state: 'pending', decidedByName: null } })] });
      fireEvent.click(await screen.findByRole('button', { name: 'Deny request for Q4 revenue review' }));
      await waitFor(() => expect(api.decideCanvasAccess).toHaveBeenCalledWith(CANVAS, AVERY, 'deny'));
      expect(screen.queryByRole('button', { name: /Someone/u })).toBeNull();
    });

    it('reads a settled request as who decided, in the buttons\' place, "You" to the decider, with nothing left to press', async () => {
      const rows = await rowsOf([
        item({ id: 'r2', kind: 'access_request', preview: 'For the board review', seen: true, accessRequest: { state: 'approved', decidedByName: 'Me', decidedByUserId: ME } }),
        item({ id: 'r3', kind: 'access_request', seen: true, accessRequest: { state: 'denied', decidedByName: 'Maya', decidedByUserId: MAYA } }),
        // From a server older than the decider's id: the name.
        item({ id: 'r5', kind: 'access_request', seen: true, accessRequest: { state: 'approved', decidedByName: 'Maya' } }),
      ]);
      expect(rows[0]).toHaveTextContent('For the board review');
      expect(rows.map((row) => row.closest('.activity-row-group')?.querySelector('.activity-row-actions')?.textContent))
        .toEqual(['You approved', 'Maya denied', 'Maya approved']);
      expect(rows.map((row) => row.classList.contains('is-seen'))).toEqual([true, true, true]);
      expect(screen.queryByRole('button', { name: /^(Approve|Deny) / })).toBeNull();
    });

    it('names who declined the request, never the Canvas, behind a lock, and opens its requestable pane', async () => {
      const rows = await rowsOf([item({
        id: 'd1', kind: 'access_denied', parentTitle: null, actor: { kind: 'person', id: MAYA },
        accessRequest: { state: 'denied', decidedByName: 'Maya Chen', decidedByUserId: MAYA },
      })]);
      expect(rows[0]!.querySelector('.activity-row-text')).toHaveTextContent('Maya Chen declined your request to open a Canvas');
      expect(rows[0]).toHaveAttribute('title', 'Maya Chen declined your request to open a Canvas');
      expect(rows[0]).not.toHaveTextContent('Q4 revenue review');
      expect(rows[0]!.querySelector('.activity-row-tile .activity-row-glyph.is-access_denied svg')).toHaveClass('tabler-icon-lock');
      expect(rows[0]!.querySelector('.activity-row-glyph.is-access_denied svg')).not.toHaveClass('tabler-icon-lock-open');
      expect(rows[0]).toHaveAttribute('href', `/canvases/${CANVAS}`);
      expect(within(rows[0]!.parentElement!).queryByRole('button', { name: /^(Approve|Deny) / })).toBeNull();
    });

    it('names who let the person in and opens the Canvas', async () => {
      const rows = await rowsOf([item({ id: 'g1', kind: 'access_granted', actor: { kind: 'person', id: MAYA } })]);
      expect(rows[0]!.querySelector('.activity-row-text')).toHaveTextContent('Maya let you into Q4 revenue review');
      // An open lock, not the closed one a request and a denial draw, beside the Canvas badge.
      expect(rows[0]!.querySelector('.activity-row-tile .activity-row-glyph.is-access_granted svg')).toHaveClass('tabler-icon-lock-open');
      expect(rows[0]!.querySelector('.activity-row-tile .identity-tile-badge')).not.toBeNull();
      expect(rows[0]).toHaveAttribute('href', `/canvases/${CANVAS}`);
    });
  });

  it('says how it fills when there is nothing yet, and offers Mark all seen only with something unseen', () => {
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, '/', { unseenCount: 0, items: [] });
    expect(screen.getByText('Nothing yet. Mentions, new messages, Canvases you are added to, Sidekick runs that need you or finish, updates to Canvases you pinned, requests to open a Canvas and answers to yours show up here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all seen' })).toBeDisabled();
  });

  it('sends Mark all seen on the workspace socket when something is unseen', () => {
    useUiStore.getState().setSidebarSection('activity');
    renderSidebar(workspace, '/', page);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(socket.markAllActivitySeen).toHaveBeenCalledTimes(1);
  });
});
