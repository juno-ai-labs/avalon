import { asUserId } from '@rally/contracts';
import type { CanvasSidebarRow } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import { CanvasesHomeScreen } from './canvases-home';

const createCanvas = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ guest: false }));
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({ api: { createCanvas, getWorkspaceMembers }, session: { user: { id: ME } } }),
  useOptionalCollaborationSession: () => ({ api: { createCanvas } }),
  useShellCapabilities: () => ({ host: 'desktop', guest: shell.guest }),
}));

const elsewhere = vi.hoisted(() => ({ items: [] as unknown[] }));
const openWorkspaceCanvas = vi.hoisted(() => vi.fn());
vi.mock('../lib/shared-canvases', () => ({ useOtherOrganizationCanvases: () => elsewhere.items }));
vi.mock('../lib/app-session', () => ({ useOptionalAppSession: () => ({ openWorkspaceCanvas }) }));

const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const MAYA = asUserId('00000000-0000-7000-8000-0000000000a2');
const THEO = asUserId('00000000-0000-7000-8000-0000000000a3');

function canvas(id: string, title: string, overrides: Partial<CanvasSidebarRow> = {}): CanvasSidebarRow {
  return {
    id, title, createdByUserId: ME, createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: false,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: false, ...overrides,
  } as CanvasSidebarRow;
}

/** The workspace socket's push, through the receiver the socket applies it with. */
function clientWith(rows: CanvasSidebarRow[] | null): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (rows) applyVersionedSidebarList(client, 'canvases', 1, rows);
  return client;
}

function renderHome(client: QueryClient): void {
  render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter initialEntries={['/canvases']}>
    <Routes>
      <Route element={<CanvasesHomeScreen />} path="/canvases" />
      <Route element={<div>Opened canvas</div>} path="/canvases/:id" />
    </Routes>
  </MemoryRouter></Tooltip.Provider></QueryClientProvider>);
}

beforeEach(() => {
  shell.guest = false;
  elsewhere.items = [];
  openWorkspaceCanvas.mockReset();
  createCanvas.mockReset().mockResolvedValue({ canvasId: '00000000-0000-7000-8000-0000000000c9', turnId: null });
  getWorkspaceMembers.mockReset().mockResolvedValue([
    { id: ME, name: 'Adam Jones', email: 'adam@example.test', timezone: 'UTC' },
    { id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC' },
    { id: THEO, name: 'Theo Park', email: 'theo@example.test', timezone: 'UTC' },
  ]);
});

describe('CanvasesHomeScreen', () => {
  it("lists a Canvas shared from another Organization by date, names that Organization, and opens it there", () => {
    const organization = { id: '00000000-0000-7000-8000-0000000000e1', name: 'Acme', region: 'enterprise' as const };
    elsewhere.items = [{ organization, row: canvas('00000000-0000-7000-8000-0000000000d1', 'Partner roadmap', {
      createdByUserId: MAYA, sharedWithMe: true, visibility: 'participants', updatedAt: '2026-11-08T09:00:00.000Z' }) }];
    renderHome(clientWith([canvas('00000000-0000-7000-8000-0000000000c1', 'Our plan')]));
    const recent = screen.getByRole('region', { name: 'Recent' });
    // The newer one first, whichever Organization it is from.
    expect(within(recent).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Partner roadmap', 'Our plan']);
    const shared = within(recent).getByRole('button', { name: 'Partner roadmap' });
    expect(shared).toHaveAccessibleDescription('Shared from Acme');
    expect(shared.closest('li')!.querySelector('.canvas-card-organization')).toHaveTextContent('A');
    fireEvent.click(shared);
    expect(openWorkspaceCanvas).toHaveBeenCalledWith({ region: 'enterprise', workspaceId: organization.id, canvasId: '00000000-0000-7000-8000-0000000000d1' });

    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
    expect(within(recent).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Partner roadmap']);
  });

  it("draws each Canvas's icon and colour in its preview and leaves its title without an icon", () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Chosen', { artifactKind: 'site', appearance: { icon: 'flag', color: 'orange' } }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Unchosen', { artifactKind: 'file', appearance: { icon: null, color: null } }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Archive', { artifactKind: 'archive' }),
      canvas('00000000-0000-7000-8000-0000000000c4', 'Chat only'),
    ]));
    const card = (title: string): HTMLElement => screen.getByRole('link', { name: title }).closest('li')!;
    // An unchosen icon is the one placeholder, whatever its newest artifact is.
    for (const [title, glyph] of [['Chosen', 'flag'], ['Unchosen', 'panels-top-left'], ['Archive', 'panels-top-left'], ['Chat only', 'panels-top-left']] as const) {
      expect(card(title).querySelectorAll('.dashboard-card-preview svg')).toHaveLength(1);
      expect(card(title).querySelector('.dashboard-card-preview svg')).toHaveClass(`lucide-${glyph}`);
      expect(card(title).querySelector('h3 svg')).toBeNull();
    }
    expect(card('Chosen').querySelector('.dashboard-card-preview')).toHaveStyle({ background: 'var(--av-sys-color-project-tint-orange)' });
    expect(card('Chosen').querySelector('.dashboard-card-preview > svg')).toHaveAttribute('stroke', 'var(--av-sys-color-project-ink-orange)');
    expect(card('Unchosen').querySelector('.dashboard-card-preview')).toHaveStyle({ background: 'var(--av-sys-color-project-tint-emerald)' });
  });

  it('keeps Canvases in activity order independently of stored data or viewer presence', async () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { hasStoredData: false, presentUserIds: [MAYA, THEO] }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { hasStoredData: true, lastEditor: { kind: 'rally', id: null } }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Hiring pipeline', { presentUserIds: [ME] }),
    ]));
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getAllByRole('link').map((link) => link.textContent))
      .toEqual(['Q4 revenue review', 'Launch plan', 'Hiring pipeline']);
    expect(within(recent).getByRole('link', { name: 'Launch plan' })).toHaveAccessibleDescription('Data backed');
    expect(within(recent).getByRole('link', { name: 'Q4 revenue review' })).toHaveAccessibleDescription('');
    expect(within(recent).getAllByText('Only you')).toHaveLength(3);
    // Older rows with no artifact state also stay in Recent.
    expect(within(recent).getByRole('link', { name: 'Hiring pipeline' })).toBeInTheDocument();
    expect(within(recent).getByText('3 Canvases')).toBeInTheDocument();
  });

  it('shows viewer facepiles separately from Data artifact badges', async () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { hasStoredData: false, presentUserIds: [MAYA, THEO] }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Data tracker', { hasStoredData: true }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Hiring pipeline', { presentUserIds: [ME] }),
      canvas('00000000-0000-7000-8000-0000000000c4', 'Shared tracker', { hasStoredData: true, presentUserIds: [MAYA] }),
    ]));
    const card = (title: string): HTMLElement => screen.getByRole('link', { name: title }).closest('li')!;
    await waitFor(() => expect(card('Q4 revenue review').querySelectorAll('.canvas-card-presence .avatar')).toHaveLength(2));
    expect(within(card('Q4 revenue review')).queryByText('Data backed')).toBeNull();
    expect(within(card('Data tracker')).getByText('Data backed')).toBeInTheDocument();
    expect(card('Data tracker').querySelector('.canvas-card-presence')).toBeNull();
    expect(within(card('Shared tracker')).getByText('Data backed')).toBeInTheDocument();
    expect(card('Shared tracker').querySelectorAll('.canvas-card-presence .avatar')).toHaveLength(1);
    expect(card('Hiring pipeline').querySelector('.canvas-card-presence')).toBeNull();
    expect(within(card('Hiring pipeline')).queryByText('Data backed')).toBeNull();
  });

  it('draws the attached Sidekicks as a facepile at the right, under the Data badge when the card has one', async () => {
    const sidekick = (suffix: string, name: string) => ({ id: `00000000-0000-7000-8000-0000000000${suffix}`, name, status: 'active' as const, madeHere: true });
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Inbox', { hasStoredData: true,
        sidekicks: [sidekick('e1', 'Inbox listener'), sidekick('e2', 'Digest')] }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'PR dashboard', {
        sidekicks: ['e3', 'e4', 'e5', 'e6', 'e7', 'e8'].map((suffix, index) => sidekick(suffix, `Watcher ${index + 1}`)) }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Notes', { sidekicks: [] }),
      // A server older than attaching sends no list.
      canvas('00000000-0000-7000-8000-0000000000c4', 'Older', {}),
    ]));
    const card = (title: string): HTMLElement => screen.getByRole('link', { name: title }).closest('li')!;
    await waitFor(() => expect(card('Inbox').querySelectorAll('.sidekick-stack-item')).toHaveLength(2));
    expect(within(card('Inbox')).getByRole('img', { name: 'Sidekicks: Inbox listener; Digest', hidden: true })).toBeInTheDocument();
    // The card's link is described by both, since the preview itself is decorative.
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAccessibleDescription('Data backed Sidekicks: Inbox listener; Digest');
    // No Data badge: the facepile takes the top right itself, and stops at four with the rest counted.
    expect(card('PR dashboard').querySelectorAll('.sidekick-stack-item:not(.sidekick-stack-overflow)')).toHaveLength(4);
    expect(card('PR dashboard').querySelector('.sidekick-stack-overflow')).toHaveTextContent('+2');
    expect(within(card('PR dashboard')).getByRole('img', { hidden: true,
      name: 'Sidekicks: Watcher 1; Watcher 2; Watcher 3; Watcher 4; and 2 more' })).toBeInTheDocument();
    expect(card('Notes').querySelector('.canvas-card-sidekicks')).toBeNull();
    expect(card('Older').querySelector('.canvas-card-sidekicks')).toBeNull();
  });

  it('labels and filters reactive only for active attached Sidekicks with automatic triggers', () => {
    const sidekick = (triggerKinds: ('manual' | 'schedule' | 'external_event' | 'invocation')[], status: 'active' | 'paused' | 'draft' = 'active') => ({
      id: `updater-${triggerKinds.join('-')}-${status}`, name: 'Updater', madeHere: true, status, triggerKinds,
    });
    renderHome(clientWith([
      canvas('scheduled', 'Scheduled', { hasStoredData: true, sidekicks: [sidekick(['manual']), sidekick(['schedule', 'invocation'])] }),
      canvas('event', 'Event driven', { sidekicks: [sidekick(['external_event', 'invocation'])] }),
      canvas('manual', 'Manual only', { sidekicks: [sidekick(['manual'])] }),
      canvas('invocation', 'App invocation only', { sidekicks: [sidekick(['invocation'])] }),
      canvas('requested', 'Manual and app invocation', { sidekicks: [sidekick(['manual', 'invocation'])] }),
      canvas('paused', 'Paused', { sidekicks: [sidekick(['schedule'], 'paused')] }),
      canvas('draft', 'Draft', { sidekicks: [sidekick(['schedule'], 'draft')] }),
      canvas('empty', 'No triggers', { sidekicks: [sidekick([])] }),
      canvas('older', 'Older Sidekick', { sidekicks: [{ id: 'older', name: 'Older', madeHere: true, status: 'active' }] }),
      canvas('none', 'No Sidekicks'),
    ]));
    expect(screen.getAllByText('Reactive', { selector: '.canvas-card-badge' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'App invocation only' })).toHaveAccessibleDescription('Sidekicks: Updater');
    expect(screen.getByRole('link', { name: 'Manual and app invocation' })).toHaveAccessibleDescription('Sidekicks: Updater');
    expect(screen.getByRole('link', { name: 'Scheduled' })).toHaveAccessibleDescription('Reactive Data backed Sidekicks: Updater; Updater');
    expect(screen.getByRole('link', { name: 'Event driven' })).toHaveAccessibleDescription('Reactive Sidekicks: Updater');
    const reactive = screen.getByRole('button', { name: 'Reactive' });
    fireEvent.click(reactive);
    expect(reactive).toHaveAttribute('aria-pressed', 'true');
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Scheduled', 'Event driven']);
    expect(recent).toHaveTextContent('2 Canvases');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Canvases' }), { target: { value: 'event' } });
    expect(screen.getByRole('region', { name: 'Search results' })).toHaveTextContent('1 Canvas');
    expect(screen.queryByRole('link', { name: 'Scheduled' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Event driven' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Canvases' }), { target: { value: 'manual' } });
    expect(screen.getByText('No matching Canvases')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(reactive).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('link', { name: 'Manual only' })).toBeInTheDocument();
  });

  it('shows the sharing setting and matching icon even when a run wrote the Canvas', () => {
    const sidekickId = '00000000-0000-7000-8000-0000000000e1';
    const runId = '00000000-0000-7000-8000-0000000000f3';
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Weekly digest', { createdByUserId: MAYA, writerSidekickId: sidekickId,
        lastEditor: { kind: 'sidekick', id: sidekickId }, lastWrittenBy: { sidekickId, runId, runNumber: 3, sidekickName: 'Digest writer' } }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { visibility: 'workspace', lastEditor: { kind: 'rally', id: null } }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Shared plan', { visibility: 'participants', presentUserIds: [MAYA] }),
      canvas('00000000-0000-7000-8000-0000000000c4', 'Private plan'),
      canvas('00000000-0000-7000-8000-0000000000c5', 'My digest', { writerSidekickId: sidekickId }),
      canvas('00000000-0000-7000-8000-0000000000c6', 'Shared digest', { visibility: 'participants', writerSidekickId: sidekickId }),
      canvas('00000000-0000-7000-8000-0000000000c7', 'Organization digest', { visibility: 'workspace', writerSidekickId: sidekickId }),
      canvas('00000000-0000-7000-8000-0000000000c8', 'Another private plan', { createdByUserId: MAYA }),
    ]));
    const card = (title: string): HTMLElement => screen.getByRole('link', { name: title }).closest('li')!;
    for (const [title, label, icon] of [
      ['Weekly digest', "Creator and the Sidekick's audience", 'users'],
      ['Launch plan', 'Everyone in the Organization', 'building'],
      ['Shared plan', 'Specific people', 'users'],
      ['Private plan', 'Only you', 'lock'],
      ['My digest', "You and the Sidekick's audience", 'users'],
      ['Shared digest', "Specific people and the Sidekick's audience", 'users'],
      ['Organization digest', 'Everyone in the Organization', 'building'],
      ['Another private plan', 'Only the creator', 'lock'],
    ] as const) {
      const status = within(card(title)).getByText(label);
      expect(status.closest('.canvas-sharing-status')).toHaveAttribute('title', label);
      expect(status.closest('.canvas-sharing-status')?.querySelector('svg')).toHaveClass(`tabler-icon-${icon}`);
    }
  });

  it('orders All, Reactive and Data first and filters by database-backed artifacts, authorship and search', () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Mine'),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Shared plan', { hasStoredData: true, createdByUserId: MAYA, sharedWithMe: true }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Weekly changelog', { createdByUserId: MAYA, writerSidekickId: '00000000-0000-7000-8000-0000000000e1' }),
    ]));
    const filters = screen.getByRole('group', { name: 'Canvas filter' });
    expect(within(filters).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['All', 'Reactive', 'Data backed', 'Made by me', 'Shared with me']);
    fireEvent.click(within(filters).getByRole('button', { name: 'Data backed' }));
    expect(screen.getByRole('link', { name: 'Shared plan' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent' })).toHaveTextContent('1 Canvas');
    expect(screen.queryByRole('link', { name: 'Mine' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Weekly changelog' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Canvases' }), { target: { value: 'weekly' } });
    expect(screen.getByText('No matching Canvases')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Shared plan' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Canvases' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
    expect(screen.getByRole('link', { name: 'Shared plan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Mine' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Made by me' }));
    expect(screen.getByRole('link', { name: 'Mine' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Canvases' }), { target: { value: 'weekly' } });
    expect(screen.getByRole('region', { name: 'Search results' })).toHaveTextContent('Weekly changelog');
    expect(screen.queryByRole('link', { name: 'Mine' })).toBeNull();
  });

  it('starts a first Canvas from a prompt, which becomes its first message', async () => {
    renderHome(clientWith([]));
    expect(screen.getByRole('button', { name: 'New Canvas' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Start from a prompt' });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'A tracker for our Q1 hiring plan' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Opened canvas')).toBeInTheDocument();
    expect(createCanvas).toHaveBeenCalledWith({ canvasId: expect.any(String), prompt: { text: 'A tracker for our Q1 hiring plan', clientMessageId: expect.any(String) } });
  });

  it('keeps an unsent prompt when returning from the Marketplace', () => {
    renderHome(clientWith([]));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'My draft prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Marketplace' }));
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Canvases' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('My draft prompt');
  });

  it('opens the Marketplace in place of the Canvas list, with its categories as the only row, and comes back to the same filter', () => {
    renderHome(clientWith([canvas('mine', 'My Canvas')]));
    fireEvent.click(screen.getByRole('button', { name: 'Made by me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Marketplace' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Marketplace');
    expect(screen.queryByRole('group', { name: 'Canvas filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marketplace' })).toBeNull();
    const templates = screen.getByRole('region', { name: 'Canvas templates' });
    const categories = within(templates).getByRole('group', { name: 'Template category' });
    expect(within(categories).getByRole('button', { name: 'Developers', pressed: true })).toBeInTheDocument();
    const countByCategory = [
      ['Developers', 3],
      ['Product managers', 2],
      ['Parents', 3],
      ['Recruiters', 1],
    ] as const;
    expect(within(categories).getAllByRole('button').map((button) => button.textContent))
      .toEqual(countByCategory.map(([label]) => label));
    for (const [label, count] of countByCategory) {
      const category = within(categories).getByRole('button', { name: label });
      fireEvent.click(category);
      expect(category).toHaveAttribute('aria-pressed', 'true');
      const cards = within(templates).getByRole('list');
      expect(within(cards).getAllByRole('button')).toHaveLength(count);
    }
    expect(screen.queryByRole('link', { name: 'My Canvas' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search Canvases' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Canvases' }));
    expect(screen.queryByRole('region', { name: 'Canvas templates' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Canvases');
    expect(screen.getByRole('button', { name: 'Made by me', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Canvas' })).toBeInTheDocument();
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('opens a Canvas immediately with the selected template as its first message, even on an empty dashboard', () => {
    createCanvas.mockReturnValue(new Promise(() => undefined));
    renderHome(clientWith([]));
    fireEvent.click(screen.getByRole('button', { name: 'Marketplace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recruiters' }));
    const cards = within(screen.getByRole('region', { name: 'Canvas templates' })).getByRole('list');
    const template = within(cards).getByRole('button');
    fireEvent.click(template);
    expect(screen.getByText('Opened canvas')).toBeInTheDocument();
    expect(createCanvas).toHaveBeenCalledExactlyOnceWith({
      canvasId: expect.any(String),
      prompt: {
        text: expect.stringMatching(/^(?!---)[^\n]*\brecruiting market map\b[\s\S]*\n\n\S/iu),
        clientMessageId: expect.any(String),
      },
    });
  });

  it('makes an empty Canvas from New Canvas', async () => {
    renderHome(clientWith([canvas('00000000-0000-7000-8000-0000000000c1', 'Mine')]));
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    await waitFor(() => expect(createCanvas).toHaveBeenCalledWith({ canvasId: expect.any(String) }));
    expect(await screen.findByText('Opened canvas')).toBeInTheDocument();
  });

  it('offers a guest no way to make one', () => {
    shell.guest = true;
    renderHome(clientWith([]));
    expect(screen.queryByRole('button', { name: 'New Canvas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marketplace' })).toBeNull();
    expect(screen.getByText('No Canvases yet')).toBeInTheDocument();
  });

  it('waits for the list rather than claiming there is none', () => {
    renderHome(clientWith(null));
    expect(screen.getByText('Loading Canvases…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start from a prompt' })).toBeNull();
  });
});
