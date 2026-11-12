import type * as PlatformModule from '../lib/platform';
import { asUserId, asWorkstreamId, type CanvasSidebarRow } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import { WORKSPACE_MEMBERS_QUERY_KEY } from '../lib/workspace-members';
import type { AutomationSummary } from '../lib/types';
import { SidekicksLibraryRoute, SidekicksLibraryScreen } from './sidekicks-library';

const getSidekicks = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api: { getSidekicks, getWorkspaceMembers } }) }));
const shell = vi.hoisted(() => ({ host: 'desktop' as 'desktop' | 'browser', guest: false }));
vi.mock('../lib/collaboration-session', () => ({ useShellCapabilities: () => shell }));
// Whether a workspace socket is mounted above the screen, as in the main window.
const socket = vi.hoisted(() => ({ mounted: false }));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => socket.mounted ? {} : null }));
const openThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof PlatformModule>(),
  desktopBridge: () => ({ openThread }),
}));

beforeEach(() => {
  socket.mounted = false;
  shell.host = 'desktop';
  shell.guest = false;
  getWorkspaceMembers.mockReset().mockResolvedValue([
    { id: 'alex', name: 'Alex Rivera', email: 'alex@example.com', timezone: 'UTC' },
    { id: 'sam', name: 'Sam Chen', email: 'sam@example.com', timezone: 'UTC' },
    { id: 'owner', name: 'Sidekick Author', email: 'owner@example.com', timezone: 'UTC' },
  ]);
  getSidekicks.mockReset().mockResolvedValue([
    { id: 'personal', name: 'Daily brief', description: 'Prepare my morning notes.', scope: 'you', status: 'active' },
    { id: 'team', name: 'Team brief', description: 'Share the latest product news.', scope: 'workspace', status: 'active' },
  ]);
});

describe('SidekicksLibraryScreen', () => {
  it('does not claim a zero count while loading or after a failed load', async () => {
    getSidekicks.mockRejectedValue(new Error('Unavailable'));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toBeEmptyDOMElement();
    await screen.findByText('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toBeEmptyDOMElement();
  });

  it('combines ownership and text filters and recovers from no matches', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: /Daily brief/ })).toHaveAttribute('href', '/sidekicks/personal');
    expect(screen.getByRole('region', { name: 'Your Sidekicks' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toHaveTextContent('2 Sidekicks');
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(screen.queryByRole('link', { name: /Daily brief/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Team brief/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Sidekicks' }), { target: { value: 'morning' } });
    expect(screen.getByRole('region', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByText('No matching Sidekicks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(screen.getByRole('link', { name: /Daily brief/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team brief/ })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Sidekick ownership' })).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the Sidekicks home', () => {
  it('names the window after the section, and gives the name back on leaving', () => {
    document.title = 'Rally';
    const view = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryRoute /></MemoryRouter></QueryClientProvider>);
    expect(document.title).toBe('Sidekicks · Rally');
    view.unmount();
    expect(document.title).toBe('Rally');
  });

  it('lists each Sidekick the workspace socket keeps as a card with its status, who it is shared with and when it next wakes', async () => {
    // The rows as the socket's sidebar read carries them: only it says
    // `needsInput`, which `GET /sidekicks` never does.
    socket.mounted = true;
    const client = new QueryClient();
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'triage', name: 'Incident triage', description: 'Watches alerts.', scope: 'you', audience: 'people', sharedWithUserIds: ['alex', 'sam', 'unlisted'], status: 'active', needsInput: true, triggerKinds: ['manual', 'external_event'], updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'changelog', name: 'Weekly changelog', description: 'Every Friday.', scope: 'workspace', audience: 'workspace', status: 'active', runState: 'working', nextRunAt: '2099-11-13T22:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'revenue', name: 'Revenue analyst', description: 'Keeps revenue current.', scope: 'you', audience: 'personal', status: 'paused', updatedAt: '2026-11-07T09:00:00.000Z' },
    ] satisfies AutomationSummary[]);
    render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></Tooltip.Provider></QueryClientProvider>);
    expect(getSidekicks).not.toHaveBeenCalled();
    const triageLink = await screen.findByRole('link', { name: 'Incident triage' });
    const triage = triageLink.closest('li')!;
    expect(within(triage).getByText('Needs input')).toBeInTheDocument();
    const facepile = await within(triage).findByRole('img', { name: 'Alex Rivera; Sam Chen; and 1 more' });
    expect(within(facepile).getByText('+1')).toBeInTheDocument();
    expect(triageLink).not.toContainElement(facepile);
    // What wakes it, the alert ahead of a request.
    const next = within(triage).getByText('Next');
    expect(next.nextElementSibling).toHaveTextContent('On alert');
    expect(triageLink).not.toContainElement(next);
    const changelog = screen.getByRole('link', { name: 'Weekly changelog' }).closest('li')!;
    expect(within(changelog).getByText('Organization')).toBeInTheDocument();
    expect(within(changelog).queryByText('Working')).toBeNull();
    expect(within(changelog).getByText('Next').nextElementSibling).not.toHaveTextContent('—');
    const revenue = screen.getByRole('link', { name: 'Revenue analyst' }).closest('li')!;
    expect(within(revenue).getByText('Paused')).toBeInTheDocument();
    expect(within(revenue).getByText('Only you')).toBeInTheDocument();
    expect(within(revenue).getByText('Next').nextElementSibling).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    expect(screen.getByRole('link', { name: 'Revenue analyst' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toHaveTextContent(/^1 Sidekick$/);
    expect(screen.queryByRole('link', { name: 'Weekly changelog' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Only you' }));
    // Shared with named people is not only its author's.
    expect(screen.queryByRole('link', { name: 'Incident triage' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Revenue analyst' })).toBeInTheDocument();
  });

  it('uses the cached Organization roster when opening the dashboard', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    client.setQueryData(WORKSPACE_MEMBERS_QUERY_KEY,
      [{ id: 'alex', name: 'Cached Alex', email: 'alex@example.com', timezone: 'UTC' }],
      { updatedAt: Date.now() - 120_000 });
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'triage', name: 'Incident triage', description: 'Watches alerts.', scope: 'you', audience: 'people', sharedWithUserIds: ['alex'], status: 'active', updatedAt: '2026-11-07T09:00:00.000Z' },
    ] satisfies AutomationSummary[]);
    render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByRole('img', { name: 'Cached Alex' })).toBeInTheDocument();
    expect(getWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('only shows the top-right pill for paused Sidekicks and preserves Needs input', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'older', name: 'Weekly changelog', description: 'Every Friday.', scope: 'workspace', status: 'active', running: true, runState: null, updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'both', name: 'Incident triage', description: 'Watches alerts.', scope: 'workspace', status: 'active', running: true, runState: 'needs_input', needsInput: true, updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'draft', name: 'Draft helper', description: '', scope: 'you', status: 'draft', updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'paused', name: 'Paused helper', description: '', scope: 'you', status: 'paused', running: true, needsInput: true, updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'idle', name: 'Revenue analyst', description: 'Keeps revenue current.', scope: 'workspace', status: 'active', running: false, runState: null, updatedAt: '2026-11-07T09:00:00.000Z' },
    ] satisfies AutomationSummary[]);
    render(<QueryClientProvider client={client}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const row = async (name: string) => (await screen.findByRole('link', { name })).closest('li')!;
    expect((await row('Weekly changelog')).querySelector('.sidekick-status-pill')).toBeNull();
    const both = await row('Incident triage');
    expect(both.querySelector('.sidekick-status-pill')).toBeNull();
    expect(within(both).getByText('Needs input')).toBeInTheDocument();
    expect((await row('Revenue analyst')).querySelector('.sidekick-status-pill')).toBeNull();
    expect((await row('Draft helper')).querySelector('.sidekick-status-pill')).toBeNull();
    const paused = await row('Paused helper');
    expect(paused.querySelector('.sidekick-status-pill')).toHaveTextContent('Paused');
    expect(within(paused).getByText('Needs input')).toBeInTheDocument();
  });

  it('links each Canvas a Sidekick is attached to from a pill on its card, under the Paused pill when it has one', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    const CANVAS = '00000000-0000-7000-8000-0000000000c1';
    const OTHER = '00000000-0000-7000-8000-0000000000c2';
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'tracker', name: 'Launch tracker', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z',
        attachedCanvases: [{ id: CANVAS, title: 'Launch plan' }, { id: OTHER, title: 'Roadmap' }] },
      { id: 'paused', name: 'Inbox listener', description: '', scope: 'you', status: 'paused', updatedAt: '2026-11-07T09:00:00.000Z',
        attachedCanvases: [{ id: CANVAS, title: 'Launch plan' }] },
      { id: 'none', name: 'Weekly changelog', description: '', scope: 'workspace', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', attachedCanvases: [] },
      { id: 'many', name: 'Portfolio watcher', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z',
        attachedCanvases: ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ id: `canvas-${letter}`, title: `Canvas ${letter.toUpperCase()}` })) },
      { id: 'three', name: 'Trio watcher', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z',
        attachedCanvases: ['a', 'b', 'c'].map((letter) => ({ id: `canvas-${letter}`, title: `Canvas ${letter.toUpperCase()}` })) },
      // An older Worker sends no list.
      { id: 'older', name: 'Daily brief', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z' },
    ] satisfies AutomationSummary[]);
    render(<QueryClientProvider client={client}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const card = async (name: string) => (await screen.findByRole('link', { name })).closest('li')!;
    const tracker = await card('Launch tracker');
    const pills = within(tracker).getAllByRole('link', { name: /^Canvas: / });
    expect(pills.map((pill) => [pill.textContent, pill.getAttribute('href')])).toEqual([
      ['Launch plan', `/canvases/${CANVAS}`], ['Roadmap', `/canvases/${OTHER}`],
    ]);
    // The arrow sits after the title, at the pill's right.
    expect(pills[0]!.lastElementChild).toHaveClass('tabler-icon-arrow-up-right');
    expect(tracker.querySelector('.sidekick-card-canvases')).not.toHaveClass('is-below-status');
    expect((await card('Inbox listener')).querySelector('.sidekick-card-canvases')).toHaveClass('is-below-status');
    expect((await card('Weekly changelog')).querySelector('.sidekick-card-canvases')).toBeNull();
    // The preview holds three rows: three Canvases are all shown, and more
    // than three show two and a last row that opens the Sidekick, which lists them all.
    expect(within(await card('Trio watcher')).getAllByRole('link').filter((link) => link.classList.contains('sidekick-card-canvas'))
      .map((link) => link.textContent)).toEqual(['Canvas A', 'Canvas B', 'Canvas C']);
    expect(within(await card('Portfolio watcher')).getAllByRole('link').filter((link) => link.classList.contains('sidekick-card-canvas'))
      .map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Canvas A', '/canvases/canvas-a'], ['Canvas B', '/canvases/canvas-b'], ['+3 more', '/sidekicks/many'],
    ]);
    expect((await card('Daily brief')).querySelector('.sidekick-card-canvases')).toBeNull();
  });

  it('offers New Sidekick beside the empty copy when there are none', async () => {
    getSidekicks.mockResolvedValue([]);
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('No Sidekicks yet')).toBeInTheDocument();
    expect(screen.getByText('Describe what you would like to delegate to create one.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'New Sidekick' })).toHaveLength(2);
  });

  it('truncates Canvas titles after 30 characters without splitting emoji and retains the full name', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    const attachedCanvases = [
      { id: '00000000-0000-7000-8000-0000000000c1', title: 'Weekly product release updates for everyone' },
      { id: '00000000-0000-7000-8000-0000000000c2', title: 'Weekly product release updates' },
      { id: '00000000-0000-7000-8000-0000000000c3', title: 'Weekly product launch notes: 👩🏽‍💻 next' },
    ];
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'tracker', name: 'Launch tracker', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', attachedCanvases },
    ]);
    render(<QueryClientProvider client={client}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const chosen = await screen.findByRole('link', { name: 'Canvas: Weekly product release updates for everyone' });
    expect(chosen).toHaveTextContent(/^Weekly product release updates…$/);
    expect(chosen).toHaveAttribute('title', 'Weekly product release updates for everyone');
    expect(chosen.querySelector('.lucide')).toBeNull();
    expect(screen.getByRole('link', { name: 'Canvas: Weekly product release updates' })).toHaveTextContent(/^Weekly product release updates$/);
    expect(screen.getByRole('link', { name: 'Canvas: Weekly product launch notes: 👩🏽‍💻 next' })).toHaveTextContent(/^Weekly product launch notes: 👩🏽‍💻…$/);

  });

  it('uses the live directory for legacy attachments and follows appearance changes', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    const attachedCanvases = [{ id: '00000000-0000-7000-8000-0000000000c1', title: 'Release notes' }];
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: 'tracker', name: 'Launch tracker', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', attachedCanvases },
    ]);
    render(<QueryClientProvider client={client}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const chosen = await screen.findByRole('link', { name: 'Canvas: Release notes' });
    expect(chosen.querySelector('.lucide')).toBeNull();
    const rows: CanvasSidebarRow[] = attachedCanvases.map((canvas) => ({
      ...canvas, id: asWorkstreamId(canvas.id), createdByUserId: asUserId('00000000-0000-7000-8000-0000000000a1'),
      createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
      lastEditor: null, writerSidekickId: null, visibility: 'creator', unread: false,
      presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
      artifactKind: 'site', appearance: { icon: canvas.id === '00000000-0000-7000-8000-0000000000c1' ? 'flag' : null, color: 'orange' },
    }));
    act(() => { applyVersionedSidebarList(client, 'canvases', 1, rows); });
    await waitFor(() => { expect(chosen.querySelector('.lucide-flag')).toBeInTheDocument(); });
    act(() => { applyVersionedSidebarList(client, 'canvases', 2, rows.map((row) => ({ ...row, appearance: { icon: 'star', color: 'blue' } }))); });
    await waitFor(() => { expect(chosen.querySelector('.lucide-star')).toBeInTheDocument(); });
    expect(chosen).toHaveAttribute('href', '/canvases/00000000-0000-7000-8000-0000000000c1');
  });

  it('shows actual attachment icons outside the loaded Canvas page and follows attachment updates', async () => {
    socket.mounted = true;
    const client = new QueryClient();
    applyVersionedSidebarList(client, 'canvases', 1, []);
    const item: AutomationSummary = { id: 'tracker', name: 'Launch tracker', description: '', scope: 'you', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z',
      attachedCanvases: [
        { id: 'custom', title: 'Release notes', artifactKind: 'file', appearance: { icon: 'flag', color: 'orange' } },
        { id: 'site', title: 'Dashboard', artifactKind: 'site', appearance: { icon: null, color: null } },
      ] };
    applyVersionedSidebarList(client, 'automations', 1, [item]);
    render(<QueryClientProvider client={client}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const chosen = await screen.findByRole('link', { name: 'Canvas: Release notes' });
    expect(chosen.querySelector('.lucide-flag')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Canvas: Dashboard' }).querySelector('.lucide-panels-top-left')).toBeInTheDocument();
    act(() => { applyVersionedSidebarList(client, 'automations', 2, [{ ...item, attachedCanvases: [
      { id: 'custom', title: 'Updated notes', artifactKind: null, appearance: { icon: 'star', color: 'blue' } },
    ] }]); });
    await waitFor(() => { expect(screen.getByRole('link', { name: 'Canvas: Updated notes' }).querySelector('.lucide-star')).toBeInTheDocument(); });
  });

  it.each(['desktop', 'browser'] as const)('renders in the main window (%s)', async (host) => {
    shell.host = host;
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryRoute /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: /Daily brief/ })).toHaveAttribute('href', '/sidekicks/personal');
    expect(screen.queryByText('Opening Sidekicks…')).toBeNull();
  });
});
