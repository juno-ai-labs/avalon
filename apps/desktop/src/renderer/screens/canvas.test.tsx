import { asUserId } from '@rally/contracts';
import type { CanvasDetail, CanvasSidebarRow } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { RENAME_CANVAS_STATE } from '../lib/canvases';
import { layoutKey, writeLayout } from '../lib/desktop-layout';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type * as Platform from '../lib/platform';
import { expandRequest, openResourceRequest } from '../lib/navigation-routes';
import type { ConversationSurfaceProps } from './conversation-surface';
import { CanvasScreen } from './canvas';

const WORKSPACE = '00000000-0000-7000-8000-0000000000f1';
const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const MAYA = asUserId('00000000-0000-7000-8000-0000000000a2');
const CANVAS = '00000000-0000-7000-8000-0000000000c1';

const getCanvas = vi.hoisted(() => vi.fn());
const setCanvasPinned = vi.hoisted(() => vi.fn());
const setCanvasAudience = vi.hoisted(() => vi.fn());
const renameCanvas = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({
    api: { getCanvas, setCanvasPinned, setCanvasAudience, getWorkspaceMembers, renameCanvas },
    session: { user: { id: ME }, workspace: { id: WORKSPACE, region: 'global', role: 'member' } },
  }),
  useOptionalCollaborationSession: () => null,
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));

const copyText = vi.hoisted(() => vi.fn());
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof Platform>(),
  desktopBridge: () => ({ copyText, getRuntimeConfig: async () => ({ webBaseUrl: 'https://rallywith.ai' }) }),
}));

// The conversation is its own surface with its own sockets; this file is about
// what the Canvas hands it: the parent, the header, and the artifact to open.
const surfaces = vi.hoisted(() => [] as Array<{ props: ConversationSurfaceProps; requested: string | null; expanded: boolean }>);
vi.mock('./conversation-surface', () => ({
  ConversationOpeningSkeleton: ({ label }: { label: string }) => <p>{label}</p>,
  ConversationSurface: (props: ConversationSurfaceProps) => {
    const location = useLocation();
    surfaces.push({ props, requested: openResourceRequest(location.state)?.resourceId ?? null, expanded: expandRequest(location) !== null });
    return <div>{props.renderHeader?.({ presentUserIds: [ME, MAYA] } as never)}</div>;
  },
}));

function detail(overrides: Partial<CanvasDetail> = {}): CanvasDetail {
  return {
    id: CANVAS, title: 'Q4 revenue review', createdByUserId: ME, createdAt: '2026-11-07T09:00:00.000Z',
    updatedAt: '2026-11-07T09:30:00.000Z', lastEditor: null, writerSidekickId: null, visibility: 'creator',
    participantUserIds: [], canManage: true,
    artifacts: [
      { resourceId: '00000000-0000-7000-8000-0000000000b2', title: 'Board deck', mimeType: 'application/pdf', kind: 'file', version: 3, updatedAt: '2026-11-07T09:30:00.000Z' },
      { resourceId: '00000000-0000-7000-8000-0000000000b1', title: 'Notes', mimeType: 'text/markdown', kind: 'file', version: 1, updatedAt: '2026-11-07T09:10:00.000Z' },
    ],
    ...overrides,
  } as CanvasDetail;
}

function renderCanvas(entry: string | { pathname: string; state: unknown } = `/canvases/${CANVAS}`): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <Tooltip.Provider><MemoryRouter initialEntries={[entry]}>
      <Routes><Route element={<CanvasScreen />} path="/canvases/:id" /></Routes>
    </MemoryRouter></Tooltip.Provider>
  </QueryClientProvider>);
  return client;
}

/** A row of the socket's Canvas list, as `workspace_canvas_list` carries it. */
function listRow(title: string, overrides: Partial<CanvasSidebarRow> = {}): CanvasSidebarRow {
  return {
    id: CANVAS, title, createdByUserId: ME, createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:30:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: false,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: false, ...overrides,
  } as CanvasSidebarRow;
}

async function openMenu(title: string): Promise<void> {
  const trigger = await screen.findByRole('button', { name: `Canvas menu: ${title}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

const lastSurface = () => surfaces.at(-1)!;

beforeEach(() => {
  surfaces.length = 0;
  copyText.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  getCanvas.mockReset().mockResolvedValue(detail());
  setCanvasPinned.mockReset().mockResolvedValue(undefined);
  setCanvasAudience.mockReset();
  renameCanvas.mockReset();
  document.title = 'Rally';
  getWorkspaceMembers.mockReset().mockResolvedValue([
    { id: ME, name: 'Adam Jones', email: 'adam@example.test', timezone: 'UTC' },
    { id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC' },
  ]);
});

describe('CanvasScreen', () => {
  it("opens the Canvas's Chat as a canvas conversation under a header naming it", async () => {
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    expect(lastSurface().props).toMatchObject({ parentId: CANVAS, parentKind: 'canvas', substreamId: '0' });
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
    // The viewer is not counted among the people here.
    expect(await screen.findByRole('group', { name: '1 person here' })).toBeInTheDocument();
  });

  it('opens the newest artifact beside the Chat when the Canvas has none saved open', async () => {
    renderCanvas();
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    // Nobody asked for it, so it does not cover the conversation they opened.
    expect(lastSurface().expanded).toBe(false);
  });

  it('restores the artifact panel the Canvas had open, rather than the newest', async () => {
    writeLayout(layoutKey(WORKSPACE, ME, `artifact-panel:${CANVAS}:0`), JSON.stringify({ resourceId: '00000000-0000-7000-8000-0000000000b1', workstreamScoped: false }));
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    await waitFor(() => expect(getCanvas).toHaveBeenCalled());
    // Nothing is requested over it: the surface's own restore reads that key.
    expect(surfaces.every((surface) => surface.requested === null)).toBe(true);
  });

  it('keeps the rail closed for a Canvas with no artifacts yet', async () => {
    getCanvas.mockResolvedValue(detail({ artifacts: [] }));
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    expect(surfaces.every((surface) => surface.requested === null)).toBe(true);
  });

  it('opens the artifact a link names rather than the newest', async () => {
    renderCanvas(`/canvases/${CANVAS}?artifact=00000000-0000-7000-8000-0000000000b1`);
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b1'));
    expect(lastSurface().expanded).toBe(true);
    await waitFor(() => expect(getCanvas).toHaveBeenCalled());
    expect(surfaces.some((surface) => surface.requested === '00000000-0000-7000-8000-0000000000b2')).toBe(false);
  });

  it("copies the Canvas's own link from its menu", async () => {
    renderCanvas();
    const trigger = await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7Xe/cv/1111117Hxt1fAWDjN7Wp/'));
  });

  it('pins the Canvas from its menu', async () => {
    renderCanvas();
    const trigger = await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(setCanvasPinned).toHaveBeenCalledWith(CANVAS, true);
  });

  it('pins the Canvas from the header\'s separate actions button too', async () => {
    renderCanvas();
    const trigger = await screen.findByRole('button', { name: 'Canvas actions' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(setCanvasPinned).toHaveBeenCalledWith(CANVAS, true);
  });

  it('renames the Canvas in its pill from the menu, and saves on Enter', async () => {
    renameCanvas.mockResolvedValue(detail({ title: 'Lisbon offsite' }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = await screen.findByRole('textbox', { name: 'Canvas title' });
    expect(field).toHaveValue('Q4 revenue review');
    fireEvent.change(field, { target: { value: 'Lisbon offsite' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(renameCanvas).toHaveBeenCalledWith(CANVAS, 'Lisbon offsite');
    expect(await screen.findByRole('button', { name: 'Canvas menu: Lisbon offsite' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Canvas title' })).toBeNull();
  });

  it('cancels a rename on Escape without asking the server', async () => {
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = await screen.findByRole('textbox', { name: 'Canvas title' });
    fireEvent.change(field, { target: { value: 'Something else' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' })).toBeInTheDocument();
    expect(renameCanvas).not.toHaveBeenCalled();
  });

  it("says why the server refused a title, and keeps the field open on what was typed", async () => {
    renameCanvas.mockRejectedValue(new ApiError('The request is invalid: title:too_small', 400, 'canvas_rename_invalid:title:too_small'));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = await screen.findByRole('textbox', { name: 'Canvas title' });
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const notice = await screen.findByRole('alertdialog', { name: 'The Canvas could not be renamed' });
    expect(notice).toHaveTextContent('A Canvas needs a title');
    expect(field).toHaveValue('   ');
    // The notice takes focus; leaving the field for it does not send the refused title again.
    fireEvent.blur(field);
    expect(renameCanvas).toHaveBeenCalledTimes(1);
  });

  it("shows the server's own words for a refusal it does not name", async () => {
    renameCanvas.mockRejectedValue(new ApiError('You no longer have access to this Canvas', 403, 'canvas_forbidden'));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = await screen.findByRole('textbox', { name: 'Canvas title' });
    fireEvent.change(field, { target: { value: 'Lisbon' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByRole('alertdialog', { name: 'The Canvas could not be renamed' })).toHaveTextContent('You no longer have access to this Canvas');
  });

  it.each([
    ['a well-formed id that names nothing', new ApiError('This Canvas does not exist', 404, 'canvas_not_found')],
    ['a malformed id', new ApiError('The request is invalid: id:invalid_format', 400, 'canvas_id_invalid:id:invalid_format')],
  ])('says the Canvas does not exist for %s', async (_case, error) => {
    getCanvas.mockRejectedValue(error);
    renderCanvas('/canvases/not-a-canvas');
    expect(await screen.findByRole('alertdialog', { name: 'Canvas could not be opened' })).toHaveTextContent('This Canvas does not exist.');
    // Its conversation never opened, so no socket failure is raised over it.
    expect(surfaces).toHaveLength(0);
  });

  it('opens a Canvas in the list at once, beside its detail read', async () => {
    getCanvas.mockReturnValue(new Promise(() => undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review')]);
    render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter initialEntries={[`/canvases/${CANVAS}`]}>
      <Routes><Route element={<CanvasScreen />} path="/canvases/:id" /></Routes>
    </MemoryRouter></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' })).toBeInTheDocument();
    expect(surfaces.length).toBeGreaterThan(0);
  });

  it('opens already renaming when the sidebar row asked for it', async () => {
    renderCanvas({ pathname: `/canvases/${CANVAS}`, state: RENAME_CANVAS_STATE });
    expect(await screen.findByRole('textbox', { name: 'Canvas title' })).toHaveValue('Q4 revenue review');
  });

  it('follows a rename the list push carries, without refetching the Canvas', async () => {
    const client = renderCanvas();
    applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review')]);
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(1));
    act(() => { applyVersionedSidebarList(client, 'canvases', 2, [listRow('t1 Lisbon chat')]); });
    expect(await screen.findByRole('button', { name: 'Canvas menu: t1 Lisbon chat' })).toBeInTheDocument();
    expect(getCanvas).toHaveBeenCalledTimes(1);
  });

  it("keeps the detail's title over a device-cache row the socket has not confirmed", async () => {
    getCanvas.mockResolvedValue(detail({ title: 'Renamed while closed' }));
    const client = renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Renamed while closed' });
    // The disk seed writes the list without the waterline ledger.
    await act(async () => {
      client.setQueryData(['canvases'], [listRow('Q4 revenue review')]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('button', { name: 'Canvas menu: Renamed while closed' })).toBeInTheDocument();
    act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Renamed again')]); });
    expect(await screen.findByRole('button', { name: 'Canvas menu: Renamed again' })).toBeInTheDocument();
  });

  it('shows Rally naming a Canvas made without a title, then the title its push carries', async () => {
    getCanvas.mockResolvedValue(detail({ title: 'Untitled Canvas', titleStatus: 'naming' }));
    const client = renderCanvas();
    const pill = await screen.findByRole('button', { name: 'Canvas menu: Rally is choosing a name' });
    expect(pill.querySelector('.title-skeleton')).not.toBeNull();
    expect(screen.queryByText('Untitled Canvas')).toBeNull();
    expect(document.title).toBe('Rally');
    act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Lisbon tram routes', { titleStatus: 'settled' })]); });
    expect(await screen.findByRole('button', { name: 'Canvas menu: Lisbon tram routes' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Lisbon tram routes · Rally'));
  });

  it('leaves the naming state when naming settles without changing the title', async () => {
    getCanvas.mockResolvedValue(detail({ title: 'Untitled Canvas', titleStatus: 'naming' }));
    const client = renderCanvas();
    act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Untitled Canvas', { titleStatus: 'naming' })]); });
    await screen.findByRole('button', { name: 'Canvas menu: Rally is choosing a name' });
    // No model, or an empty answer: the server settles and keeps the title.
    act(() => { applyVersionedSidebarList(client, 'canvases', 2, [listRow('Untitled Canvas', { titleStatus: 'settled' })]); });
    expect(await screen.findByRole('button', { name: 'Canvas menu: Untitled Canvas' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Untitled Canvas · Rally'));
  });

  it('names the window after the open Canvas, and gives the name back on leaving', async () => {
    renderCanvas();
    await waitFor(() => expect(document.title).toBe('Q4 revenue review · Rally'));
    cleanup();
    expect(document.title).toBe('Rally');
  });

  it('changes who can open it from Share, for a manager', async () => {
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    expect(within(dialog).getByRole('radio', { name: /Only you/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Specific people/ }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Maya Lin' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'participants', userIds: [MAYA] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Canvas' })).toBeNull());
  });

  it('shows the audience read-only to someone who cannot change it', async () => {
    getCanvas.mockResolvedValue(detail({ canManage: false, createdByUserId: MAYA, visibility: 'workspace' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    expect(within(dialog).getByText('Everyone in the Organization')).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(await within(dialog).findByText(/Only Maya Lin and the Organization’s administrators/)).toBeInTheDocument();
  });
});
