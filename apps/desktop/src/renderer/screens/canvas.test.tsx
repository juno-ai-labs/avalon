import { asUserId } from '@rally/contracts';
import type { CanvasDetail, CanvasSidebarRow } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { RENAME_CANVAS_STATE } from '../lib/canvases';
import { layoutKey, writeLayout } from '../lib/desktop-layout';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type * as Platform from '../lib/platform';
import { expandRequest, openResourceRequest } from '../lib/navigation-routes';
import type { ConversationSurfaceProps } from './conversation-surface';
import type * as ConversationSurfaceExports from './conversation-surface';

type ConversationSurfaceModule = typeof ConversationSurfaceExports;
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
const createScopeInvitations = vi.hoisted(() => vi.fn());
const getCanvasAccess = vi.hoisted(() => vi.fn());
const requestCanvasAccess = vi.hoisted(() => vi.fn());
const decideCanvasAccess = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({
    api: { getCanvas, setCanvasPinned, setCanvasAudience, getWorkspaceMembers, renameCanvas, createScopeInvitations, getCanvasAccess, requestCanvasAccess, decideCanvasAccess },
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
  render(<ErrorNoticeProvider><QueryClientProvider client={client}>
    <Tooltip.Provider><MemoryRouter initialEntries={[entry]}>
      <Routes><Route element={<CanvasScreen />} path="/canvases/:id" /></Routes>
    </MemoryRouter></Tooltip.Provider>
  </QueryClientProvider></ErrorNoticeProvider>);
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
  createScopeInvitations.mockReset().mockResolvedValue({ status: 'created', invitations: [] });
  getCanvasAccess.mockReset().mockRejectedValue(new ApiError('This Canvas does not exist', 404, 'canvas_not_found'));
  requestCanvasAccess.mockReset().mockResolvedValue({ status: 'pending' });
  decideCanvasAccess.mockReset().mockResolvedValue({ state: 'approved' });
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

  it('reopens a closed panel onto the newest artifact, from either menu', async () => {
    renderCanvas();
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    surfaces.length = 0;
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open artifact' }));
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    expect(lastSurface().expanded).toBe(false);
    surfaces.length = 0;
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Canvas actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open artifact' }));
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
  });

  it('replaces the entry it reopens the panel on, so Back leaves the Canvas', async () => {
    function Back(): React.JSX.Element {
      const navigate = useNavigate();
      return <button onClick={() => void navigate(-1)} type="button">Go back</button>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ErrorNoticeProvider><QueryClientProvider client={client}><Tooltip.Provider>
      <MemoryRouter initialEntries={['/canvases', `/canvases/${CANVAS}`]} initialIndex={1}>
        <Back />
        <Routes>
          <Route element={<p>Canvases home</p>} path="/canvases" />
          <Route element={<CanvasScreen />} path="/canvases/:id" />
        </Routes>
      </MemoryRouter>
    </Tooltip.Provider></QueryClientProvider></ErrorNoticeProvider>);
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open artifact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByText('Canvases home')).toBeInTheDocument();
  });

  it('copies the Canvas id for support from its menu', async () => {
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Canvas ID' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(CANVAS));
  });

  it('offers no artifact to open on a Canvas that has none', async () => {
    getCanvas.mockResolvedValue(detail({ artifacts: [] }));
    renderCanvas();
    await waitFor(() => expect(getCanvas).toHaveBeenCalled());
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Copy link' });
    expect(screen.queryByRole('menuitem', { name: 'Open artifact' })).toBeNull();
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
    // One in-pane state: no dialog over it, and nothing to try again.
    expect(await screen.findByText('This Canvas does not exist.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // Its conversation never opened, so no socket failure is raised over it.
    expect(surfaces).toHaveLength(0);
    expect(document.title).toBe('Canvas not found · Rally');
  });

  describe('a Canvas that exists but does not admit the viewer', () => {
    const notFound = (): ApiError => new ApiError('This Canvas does not exist', 404, 'canvas_not_found');
    beforeEach(() => {
      getCanvas.mockRejectedValue(notFound());
      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: null });
    });

    it('offers Request access with an optional message, then says when it was sent and holds the button', async () => {
      renderCanvas();
      expect(await screen.findByText("You don't have access to this Canvas")).toBeInTheDocument();
      expect(getCanvasAccess).toHaveBeenCalledWith(CANVAS, expect.anything());
      expect(screen.queryByText('This Canvas does not exist.')).toBeNull();
      expect(surfaces).toHaveLength(0);
      expect(document.title).toBe('Request access · Rally');

      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'pending', requestedAt: new Date().toISOString() } });
      fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
      const dialog = await screen.findByRole('dialog', { name: 'Request access' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Message (optional)' }), { target: { value: '  For the board review  ' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

      await waitFor(() => expect(requestCanvasAccess).toHaveBeenCalledWith(CANVAS, 'For the board review'));
      expect(await screen.findByRole('status')).toHaveTextContent('Request sent · just now');
      expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('sends no message when none is typed', async () => {
      renderCanvas();
      fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(requestCanvasAccess).toHaveBeenCalledWith(CANVAS, undefined));
    });

    it("reads the viewer's pending request back, and offers a new one after a denial", async () => {
      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'pending', requestedAt: '2026-11-08T09:00:00.000Z' } });
      renderCanvas();
      expect(await screen.findByRole('status')).toHaveTextContent(/^Request sent · /u);
      expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
      cleanup();

      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'denied', requestedAt: '2026-11-08T09:00:00.000Z' } });
      renderCanvas();
      expect(await screen.findByRole('button', { name: 'Request access' })).toBeEnabled();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows the refusal in the dialog', async () => {
      requestCanvasAccess.mockRejectedValue(new ApiError('Only members of this Organization can ask to open its Canvases', 403, 'canvas_access_request_not_member'));
      renderCanvas();
      fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
      expect(await screen.findByRole('alertdialog', { name: 'The request could not be sent' })).toHaveTextContent('Only members of this Organization can ask to open its Canvases');
    });

    it('keeps a restored route on a requestable Canvas', async () => {
      renderCanvas({ pathname: `/canvases/${CANVAS}`, state: { restoredRoute: true } });
      expect(await screen.findByText("You don't have access to this Canvas")).toBeInTheDocument();
    });

    it('opens into the Canvas when it joins the list, without a refresh', async () => {
      const client = renderCanvas();
      await screen.findByText("You don't have access to this Canvas");
      getCanvas.mockResolvedValue(detail());
      act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review')]); });
      await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
      expect(lastSurface().props).toMatchObject({ parentId: CANVAS, parentKind: 'canvas' });
      expect(screen.queryByText("You don't have access to this Canvas")).toBeNull();
    });

    it('opens into the Canvas when its access_granted row arrives', async () => {
      const client = renderCanvas();
      await screen.findByText("You don't have access to this Canvas");
      getCanvas.mockResolvedValue(detail());
      act(() => {
        applyVersionedSidebarList(client, 'activity', 1, { unseenCount: 1, items: [{
          id: 'granted-1', kind: 'access_granted', parentKind: 'canvas', parentId: CANVAS, parentTitle: 'Q4 revenue review',
          substreamId: null, messageId: null, messageSequence: null, runId: null, actor: { kind: 'person', id: MAYA },
          preview: null, createdAt: '2026-11-08T09:00:00.000Z', seen: false,
        }] });
      });
      await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
      expect(getCanvas).toHaveBeenCalledTimes(2);
    });
  });

  it('says a conversation it cannot reach is offline, in the pane and not in a dialog, without blaming the Canvas', async () => {
    const { WorkstreamErrorState } = await vi.importActual<ConversationSurfaceModule>('./conversation-surface');
    const retry = vi.fn();
    render(<Tooltip.Provider><MemoryRouter><WorkstreamErrorState description={undefined} onRetry={retry} workstreamId={CANVAS} /></MemoryRouter></Tooltip.Provider>);
    expect(screen.getByText('Rally can’t reach the server right now.')).toBeInTheDocument();
    expect(screen.getByText('Live edits resume when Rally reconnects.')).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('keeps the Canvas header, with its pill and Share, over the offline state', async () => {
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    const stateHeader = lastSurface().props.stateHeader;
    cleanup();
    const { WorkstreamErrorState } = await vi.importActual<ConversationSurfaceModule>('./conversation-surface');
    render(<Tooltip.Provider><MemoryRouter><WorkstreamErrorState description={undefined} header={stateHeader} onRetry={vi.fn()} workstreamId={CANVAS} /></MemoryRouter></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Canvas menu: Q4 revenue review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Canvas actions' })).toBeInTheDocument();
    // The support menu belongs to the bare header the Canvas's replaces.
    expect(screen.queryByRole('button', { name: 'More Canvas actions' })).toBeNull();
    expect(screen.getByText('Rally can’t reach the server right now.')).toBeInTheDocument();
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

  it("lists a decider's pending requests in Share, and Approve keeps the new participant when Save follows", async () => {
    getCanvas.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [],
      pendingAccessRequests: [{ userId: MAYA, name: 'Maya Lin', message: 'For the board review', requestedAt: '2026-11-08T09:00:00.000Z' }] }));
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const requests = within(dialog).getByRole('region', { name: 'Requests' });
    const [row] = within(requests).getAllByRole('listitem');
    expect(row).toHaveTextContent('Maya Lin');
    expect(row).toHaveTextContent('For the board review');

    // The approval is read back as the detail: Maya is in, with no request left.
    getCanvas.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA], pendingAccessRequests: [] }));
    fireEvent.click(within(row!).getByRole('button', { name: 'Approve Maya Lin' }));
    await waitFor(() => expect(decideCanvasAccess).toHaveBeenCalledWith(CANVAS, MAYA, 'approve'));
    await waitFor(() => expect(within(dialog).queryByRole('region', { name: 'Requests' })).toBeNull());
    expect(await within(dialog).findByRole('checkbox', { name: 'Maya Lin' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'participants', userIds: [MAYA] }));
  });

  it('shows Deny and its refusal by name', async () => {
    getCanvas.mockResolvedValue(detail({ pendingAccessRequests: [{ userId: MAYA, name: 'Maya Lin', message: null, requestedAt: '2026-11-08T09:00:00.000Z' }] }));
    decideCanvasAccess.mockRejectedValue(new ApiError('canvas_access_request_settled', 409, 'canvas_access_request_settled'));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Share Canvas' })).getByRole('button', { name: 'Deny Maya Lin' }));
    await waitFor(() => expect(decideCanvasAccess).toHaveBeenCalledWith(CANVAS, MAYA, 'deny'));
    expect(await screen.findByRole('alertdialog', { name: 'The request could not be answered' })).toHaveTextContent('Someone already answered this request.');
  });

  it('offers only guests to pick once the whole Organization can open it, and never the viewer', async () => {
    const GUEST = asUserId('00000000-0000-7000-8000-0000000000a4');
    const THEO = asUserId('00000000-0000-7000-8000-0000000000a3');
    getWorkspaceMembers.mockResolvedValue([
      { id: ME, name: 'Adam Jones', email: 'adam@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: THEO, name: 'Theo Park', email: 'theo@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: GUEST, name: 'Gale Guest', email: 'gale@example.test', timezone: 'UTC', accessClass: 'guest' },
    ]);
    // Maya made it; Adam, an administrator, is managing it.
    getCanvas.mockResolvedValue(detail({ createdByUserId: MAYA, visibility: 'participants', participantUserIds: [THEO] }));
    setCanvasAudience.mockResolvedValue(detail({ createdByUserId: MAYA, visibility: 'workspace', participantUserIds: [GUEST] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    expect(await within(dialog).findByRole('checkbox', { name: 'Theo Park' })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: 'Adam Jones' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));

    expect(within(dialog).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['Gale Guest']);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Gale Guest' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    // Theo, a member, is in already; only the guest is sent.
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'workspace', userIds: [GUEST] }));
  });

  it('invites the guests typed in the form on Save, the dialog\'s one primary action', async () => {
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'workspace' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));
    // No guest to pick yet, so no search over nothing until the guest section opens.
    expect(within(dialog).queryByRole('searchbox', { name: 'Search people' }) ?? within(dialog).queryByLabelText('Search people')).toBeNull();
    const guests = within(dialog).getByText('Invite a guest by email').closest('details')!;
    guests.open = true;
    fireEvent(guests, new Event('toggle'));
    expect(await within(dialog).findByLabelText('Search people')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Email addresses'), { target: { value: 'b@example.test, a@example.test' } });
    expect(within(dialog).getAllByRole('button').filter((button) => /^(Share|Save)$/.test(button.textContent ?? '')).map((button) => button.textContent)).toEqual(['Save']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createScopeInvitations).toHaveBeenCalledWith(expect.objectContaining({
      parentId: CANVAS, emails: ['a@example.test', 'b@example.test'],
      targets: [{ kind: 'workstream', workspaceId: WORKSPACE, parentId: CANVAS }],
    })));
    expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'workspace', userIds: [] });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Canvas' })).toBeNull());
  });

  it('sends no addresses left under a closed guest section', async () => {
    setCanvasAudience.mockResolvedValue(detail());
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const guests = within(dialog).getByText('Invite a guest by email').closest('details')!;
    guests.open = true;
    fireEvent(guests, new Event('toggle'));
    fireEvent.change(within(dialog).getByLabelText('Email addresses'), { target: { value: 'a@example.test' } });
    guests.open = false;
    fireEvent(guests, new Event('toggle'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Canvas' })).toBeNull());
    expect(createScopeInvitations).not.toHaveBeenCalled();
  });

  it('saves nothing and says why when the typed addresses are not addresses', async () => {
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const guests = within(dialog).getByText('Invite a guest by email').closest('details')!;
    guests.open = true;
    fireEvent(guests, new Event('toggle'));
    fireEvent.change(within(dialog).getByLabelText('Email addresses'), { target: { value: 'not-an-address' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(setCanvasAudience).not.toHaveBeenCalled();
    expect(createScopeInvitations).not.toHaveBeenCalled();
    // The app's notice layer says why; nothing was saved or sent. (jsdom
    // dismisses the panel under the notice's focus move, which a real window
    // does not, so whether it stays open is checked there.)
    expect(await screen.findByText(/Enter valid email addresses/)).toBeInTheDocument();
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
