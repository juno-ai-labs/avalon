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
  createCanvas.mockReset().mockResolvedValue({ canvasId: '00000000-0000-7000-8000-0000000000c9', turnId: null });
  getWorkspaceMembers.mockReset().mockResolvedValue([
    { id: ME, name: 'Adam Jones', email: 'adam@example.test', timezone: 'UTC' },
    { id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC' },
    { id: THEO, name: 'Theo Park', email: 'theo@example.test', timezone: 'UTC' },
  ]);
});

describe('CanvasesHomeScreen', () => {
  it('lifts the Canvases people are in now into Live now and lists the rest as Recent', async () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { presentUserIds: [MAYA, THEO] }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { lastEditor: { kind: 'rally', id: null } }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Hiring pipeline', { presentUserIds: [ME] }),
    ]));
    const live = screen.getByRole('region', { name: 'Live now' });
    expect(within(live).getByRole('link', { name: 'Q4 revenue review' })).toHaveAttribute('href', '/canvases/00000000-0000-7000-8000-0000000000c1');
    expect(await within(live).findByText(/Maya and Theo are here/)).toBeInTheDocument();
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getByText(/Edited by Rally/)).toBeInTheDocument();
    // The viewer alone in a Canvas is not company: it stays in Recent.
    expect(within(recent).getByRole('link', { name: 'Hiring pipeline' })).toBeInTheDocument();
    expect(within(recent).getByText('2 Canvases')).toBeInTheDocument();
  });

  it('chips a card Live, with the faces of the others in it, only where someone else is', async () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Q4 revenue review', { presentUserIds: [MAYA, THEO] }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Hiring pipeline', { presentUserIds: [ME] }),
    ]));
    const card = (title: string): HTMLElement => screen.getByRole('link', { name: title }).closest('li')!;
    await waitFor(() => expect(card('Q4 revenue review').querySelector('.canvas-card-live')).toHaveTextContent('Live'));
    // The chip's faces are the people other than the viewer, two of them here.
    expect(card('Q4 revenue review').querySelectorAll('.canvas-card-live .avatar')).toHaveLength(2);
    expect(card('Hiring pipeline').querySelector('.canvas-card-live')).toBeNull();
  });

  it("names the run that wrote a card's newest version and opens the Sidekick's conversation at it", async () => {
    const sidekickId = '00000000-0000-7000-8000-0000000000e1';
    const runId = '00000000-0000-7000-8000-0000000000f3';
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Weekly digest', { createdByUserId: MAYA, writerSidekickId: sidekickId,
        lastEditor: { kind: 'sidekick', id: sidekickId }, lastWrittenBy: { sidekickId, runId, runNumber: 3, sidekickName: 'Digest writer' } }),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Launch plan', { lastEditor: { kind: 'rally', id: null }, lastWrittenBy: null }),
    ]));
    const recent = screen.getByRole('region', { name: 'Recent' });
    const run = within(recent).getByRole('link', { name: 'Digest writer · run #3' });
    expect(run).toHaveAttribute('href', `/sidekicks/${sidekickId}?run=${runId}`);
    // A version no run made keeps the editor's line, with no run to open.
    expect(within(recent).getByText(/Edited by Rally/)).toBeInTheDocument();
    expect(within(recent).getAllByRole('link', { name: /run #/ })).toHaveLength(1);
  });

  it('filters by who made a Canvas and by search', () => {
    renderHome(clientWith([
      canvas('00000000-0000-7000-8000-0000000000c1', 'Mine'),
      canvas('00000000-0000-7000-8000-0000000000c2', 'Shared plan', { createdByUserId: MAYA, sharedWithMe: true }),
      canvas('00000000-0000-7000-8000-0000000000c3', 'Weekly changelog', { createdByUserId: MAYA, writerSidekickId: '00000000-0000-7000-8000-0000000000e1' }),
    ]));
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
    expect(screen.getByRole('link', { name: 'Shared plan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Mine' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'From Sidekicks' }));
    expect(screen.getByRole('link', { name: 'Weekly changelog' })).toBeInTheDocument();
    expect(screen.getByText(/Made by a Sidekick/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Made by me' }));
    expect(screen.getByRole('link', { name: 'Mine' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
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
    expect(createCanvas).toHaveBeenCalledWith({ prompt: { text: 'A tracker for our Q1 hiring plan', clientMessageId: expect.any(String) } });
  });

  it('makes an empty Canvas from New Canvas', async () => {
    renderHome(clientWith([canvas('00000000-0000-7000-8000-0000000000c1', 'Mine')]));
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    await waitFor(() => expect(createCanvas).toHaveBeenCalledWith({}));
    expect(await screen.findByText('Opened canvas')).toBeInTheDocument();
  });

  it('offers a guest no way to make one', () => {
    shell.guest = true;
    renderHome(clientWith([]));
    expect(screen.queryByRole('button', { name: 'New Canvas' })).toBeNull();
    expect(screen.getByText('No Canvases yet')).toBeInTheDocument();
  });

  it('waits for the list rather than claiming there is none', () => {
    renderHome(clientWith(null));
    expect(screen.getByText('Loading Canvases…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start from a prompt' })).toBeNull();
  });
});
