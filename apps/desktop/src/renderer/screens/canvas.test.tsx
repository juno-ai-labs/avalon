import { asUserId } from '@rally/contracts';
import type { CanvasDetail, CanvasSidebarRow, CanvasSidekick } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { RENAME_CANVAS_STATE } from '../lib/canvases';
import { layoutKey, writeLayout } from '../lib/desktop-layout';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type * as Platform from '../lib/platform';
import { expandRequest, openResourceRequest } from '../lib/navigation-routes';
import type { ConversationSurfaceProps, ConversationHostPanel } from './conversation-surface';
import type * as ConversationSurfaceExports from './conversation-surface';

type ConversationSurfaceModule = typeof ConversationSurfaceExports;
import { CanvasScreen } from './canvas';

const WORKSPACE = '00000000-0000-7000-8000-0000000000f1';
const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const MAYA = asUserId('00000000-0000-7000-8000-0000000000a2');
const CANVAS = '00000000-0000-7000-8000-0000000000c1';
const LEAVING_TICKET = '00000000-0000-7000-8000-0000000000e1';

const getCanvas = vi.hoisted(() => vi.fn());
const archiveCanvas = vi.hoisted(() => vi.fn());
const discardBlankCanvas = vi.hoisted(() => vi.fn());
const setCanvasPinned = vi.hoisted(() => vi.fn());
const artifactLink = vi.hoisted(() => vi.fn());
const setCanvasAudience = vi.hoisted(() => vi.fn());
const renameCanvas = vi.hoisted(() => vi.fn());
const setCanvasAppearance = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
const createScopeInvitations = vi.hoisted(() => vi.fn());
const getCanvasAccess = vi.hoisted(() => vi.fn());
const requestCanvasAccess = vi.hoisted(() => vi.fn());
const decideCanvasAccess = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({
    api: { artifactLink, getCanvas, archiveCanvas, discardBlankCanvas, setCanvasPinned, setCanvasAudience, getWorkspaceMembers, renameCanvas, setCanvasAppearance, createScopeInvitations, getCanvasAccess, requestCanvasAccess, decideCanvasAccess },
    session: { user: { id: ME }, workspace: { id: WORKSPACE, region: 'global', role: 'member' } },
  }),
  useOptionalCollaborationSession: () => null,
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));

const socketStatus = vi.hoisted(() => ({ state: 'connected', sidebarReady: true }));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => socketStatus }));

const copyText = vi.hoisted(() => vi.fn());
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof Platform>(),
  desktopBridge: () => ({ copyText, getRuntimeConfig: async () => ({ webBaseUrl: 'https://rallywith.ai' }) }),
}));

// The conversation is its own surface with its own sockets; this file is about
// what the Canvas hands it: the parent, the header, and the artifact to open.
const showStateHeader = vi.hoisted(() => ({ current: false }));
const surfaces = vi.hoisted(() => [] as Array<{ props: ConversationSurfaceProps; requested: string | null; expanded: boolean }>);
vi.mock('./conversation-surface', () => ({
  ConversationOpeningSkeleton: ({ label }: { label: string }) => <p>{label}</p>,
  ConversationSurface: (props: ConversationSurfaceProps) => {
    const location = useLocation();
    const navigate = useNavigate();
    const [panelOpen, setPanelOpen] = useState(false);
    const [hostPanel, setHostPanel] = useState<ConversationHostPanel | null>(null);
    surfaces.push({ props, requested: openResourceRequest(location.state)?.resourceId ?? null, expanded: expandRequest(location) !== null });
    return <div>
      {hostPanel && <aside aria-label={hostPanel.label}>{hostPanel.render({ onClose: () => setHostPanel(null), ancestors: undefined, expandAction: undefined })}</aside>}
      {props.composerActivity}
      {showStateHeader.current ? props.stateHeader : props.renderHeader?.({ presentUserIds: [ME, MAYA], panelOpen, openPanel: setHostPanel } as never)}
      <button onClick={() => setPanelOpen((open) => !open)} type="button">{panelOpen ? 'Close test panel' : 'Open test panel'}</button>
      <button onClick={() => void navigate('/canvases')} type="button">Leave the Canvas</button>
    </div>;
  },
}));

vi.mock('./automation', () => ({ SidekickPanel: ({ id, controls }: { id: string; controls: { onClose: () => void } }) => <div>Sidekick panel {id}<button onClick={controls.onClose}>Close panel</button></div> }));

const editorControls=(dialog:HTMLElement)=>within(within(dialog).getByRole('group',{name:'Who can edit'}));

function detail(overrides: Partial<CanvasDetail> = {}): CanvasDetail {
  return { artifactVisibility:'editors', artifactUserIds:[], sharingRevision:0,
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
      <Routes>
        <Route element={<CanvasScreen />} path="/canvases/:id" />
        <Route element={<p>Canvases home</p>} path="/canvases" />
        <Route element={<SidekickPage />} path="/sidekicks/:id" />
      </Routes>
    </MemoryRouter></Tooltip.Provider>
  </QueryClientProvider></ErrorNoticeProvider>);
  return client;
}

function SidekickPage(): React.JSX.Element {
  return <p>Sidekick page {useLocation().pathname}</p>;
}

const TRACKER = '00000000-0000-7000-8000-0000000000d1';
const DIGEST = '00000000-0000-7000-8000-0000000000d2';

/** A Sidekick attached to the Canvas, as its detail lists it. */
function attached(id: string, name: string, overrides: Partial<CanvasSidekick> = {}): CanvasSidekick {
  return { id, name, status: 'active', madeHere: true, ...overrides };
}

/** The menu row naming a Sidekick: its name and its state, read as one item. */
function sidekickRow(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Sidekicks' })).getByText(name).closest<HTMLElement>('[role="menuitem"]')!;
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
  showStateHeader.current = false;
  socketStatus.state = 'connected';
  socketStatus.sidebarReady = true;
  copyText.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  getCanvas.mockReset().mockResolvedValue(detail());
  archiveCanvas.mockReset().mockResolvedValue(undefined);
  discardBlankCanvas.mockReset().mockResolvedValue(undefined);
  setCanvasPinned.mockReset().mockResolvedValue(undefined);
  setCanvasAudience.mockReset();
  artifactLink.mockReset().mockResolvedValue({artifactId:'00000000-0000-7000-8000-0000000000b2',canonicalUrl:'https://quiet-blue-river-garden-g.rallyusercontent.com'});
  renameCanvas.mockReset();
  setCanvasAppearance.mockReset();
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
  it('confirms Archive Canvas and leaves for Canvases only after success', async () => {
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive canvas' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Canvas' });
    expect(dialog).toHaveTextContent('removed from everyone’s Canvases');
    expect(archiveCanvas).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive Canvas' }));
    await waitFor(() => expect(archiveCanvas).toHaveBeenCalledWith(CANVAS));
    expect(await screen.findByText('Canvases home')).toBeInTheDocument();
  });

  it('keeps the Canvas and confirmation available when archiving fails', async () => {
    archiveCanvas.mockRejectedValue(new ApiError('Not allowed', 403, 'canvas_archive_forbidden'));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive canvas' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Canvas' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive Canvas' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('The Canvas could not be archived. Try again.');
    expect(screen.queryByText('Canvases home')).toBeNull();
    expect(dialog).toBeInTheDocument();
  });

  it('asks to discard a Canvas whose Chat was blank when the person left it', async () => {
    getCanvas.mockResolvedValue(detail({ title: 'Untitled Canvas', artifacts: [] }));
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Untitled Canvas' });
    act(() => lastSurface().props.onBlankChange?.(true, LEAVING_TICKET));
    expect(discardBlankCanvas).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the Canvas' }));
    expect(await screen.findByText('Canvases home')).toBeInTheDocument();
    await waitFor(() => expect(discardBlankCanvas).toHaveBeenCalledWith(CANVAS, LEAVING_TICKET));
  });

  it('keeps a Canvas left with something typed or said in its Chat', async () => {
    getCanvas.mockResolvedValue(detail({ title: 'Untitled Canvas', artifacts: [] }));
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Untitled Canvas' });
    act(() => lastSurface().props.onBlankChange?.(true, LEAVING_TICKET));
    act(() => lastSurface().props.onBlankChange?.(false, LEAVING_TICKET));
    fireEvent.click(screen.getByRole('button', { name: 'Leave the Canvas' }));
    expect(await screen.findByText('Canvases home')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(discardBlankCanvas).not.toHaveBeenCalled();
  });

  it('offers no archive action to someone who cannot manage the Canvas', async () => {
    getCanvas.mockResolvedValue(detail({ canManage: false }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Copy link' });
    expect(screen.queryByRole('menuitem', { name: 'Archive canvas' })).toBeNull();
  });

  it.each([
    [[], ''],
    [[attached(TRACKER, 'Launch tracker'), attached(DIGEST, 'Weekly digest', { madeHere: false })],
      ' Archiving also archives the Sidekick this Canvas made.'],
    [[attached(TRACKER, 'Launch tracker'), attached(DIGEST, 'Weekly digest')],
      ' Archiving also archives the 2 Sidekicks this Canvas made.'],
  ])('says in the Archive Canvas confirmation that the Sidekicks the Canvas made are archived too (%#)', async (sidekicks, ending) => {
    getCanvas.mockResolvedValue(detail({ sidekicks }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive canvas' }));
    const copy = (await screen.findByRole('dialog', { name: 'Archive Canvas' })).querySelector('.modal-copy')!;
    expect(copy.textContent.endsWith(` no longer be viewable in Rally.${ending}`)).toBe(true);
    expect(copy).not.toHaveTextContent('Launch tracker');
  });

  it('lists the attached Sidekicks in its menu by name and state, between Change appearance and Archive canvas', async () => {
    getCanvas.mockResolvedValue(detail({ sidekicks: [
      attached(TRACKER, 'Launch tracker'),
      attached(DIGEST, 'Weekly digest', { status: 'paused', madeHere: false }),
      attached('00000000-0000-7000-8000-0000000000d3', 'Unfinished', { status: 'draft' }),
    ] }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('group', { name: 'Sidekicks' });
    const order = screen.getAllByRole('menuitem').map((item) => item.getAttribute('aria-label') ?? item.textContent.trim());
    expect(order.slice(order.indexOf('Change appearance'))).toEqual([
      'Change appearance', 'Launch trackerActive', 'Weekly digestPaused', 'UnfinishedDraft', 'Archive canvas',
    ]);
    // The menu archives no Sidekick, whichever Canvas made it: that is asked of the Chat.
    expect(screen.queryByRole('menuitem', { name: /Archive Sidekick/u })).toBeNull();
  });

  it("follows the Canvas list for its Sidekicks, so one made or paused while the Canvas is open reaches its menu", async () => {
    // The detail this screen opened with knows of no Sidekick.
    getCanvas.mockResolvedValue(detail({ sidekicks: [] }));
    const client = renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Change appearance' });
    expect(screen.queryByText('Sidekicks')).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // Its Chat makes one: the socket's list row carries it, and no detail is read again.
    act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review', { sidekicks: [attached(TRACKER, 'Launch tracker', { status: 'draft' })] })]); });
    await openMenu('Q4 revenue review');
    expect(sidekickRow('Launch tracker')).toHaveTextContent('Launch trackerDraft');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // Renamed and paused, then archived.
    act(() => { applyVersionedSidebarList(client, 'canvases', 2, [listRow('Q4 revenue review', { sidekicks: [attached(TRACKER, 'Inbox listener', { status: 'paused' })] })]); });
    await openMenu('Q4 revenue review');
    expect(sidekickRow('Inbox listener')).toHaveTextContent('Inbox listenerPaused');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    act(() => { applyVersionedSidebarList(client, 'canvases', 3, [listRow('Q4 revenue review', { sidekicks: [] })]); });
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Change appearance' });
    expect(screen.queryByText('Sidekicks')).toBeNull();
    expect(getCanvas).toHaveBeenCalledTimes(1);
  });

  it('draws no Sidekicks section for a Canvas with none, or from a server that sends none', async () => {
    getCanvas.mockResolvedValue(detail({ sidekicks: [] }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Change appearance' });
    expect(screen.queryByText('Sidekicks')).toBeNull();
    cleanup();
    getCanvas.mockResolvedValue(detail());
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Change appearance' });
    expect(screen.queryByText('Sidekicks')).toBeNull();
  });

  it('keeps a Sidekick reachable from the Canvas state header before its conversation opens', async () => {
    showStateHeader.current = true;
    getCanvas.mockResolvedValue(detail({ sidekicks: [attached(TRACKER, 'Launch tracker', { canOpen: true })] }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(sidekickRow('Launch tracker'));
    expect(await screen.findByText(`Sidekick page /sidekicks/${TRACKER}`)).toBeInTheDocument();
  });

  it("opens a Sidekick in the right panel from its row only for someone it is shared with, and says how to change it otherwise", async () => {
    getCanvas.mockResolvedValue(detail({ sidekicks: [
      attached(TRACKER, 'Launch tracker', { canOpen: true }), attached(DIGEST, 'Weekly digest', { canOpen: false }),
    ] }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('group', { name: 'Sidekicks' });
    const unshared = sidekickRow('Weekly digest');
    expect(unshared).toHaveAttribute('aria-disabled', 'true');
    expect(unshared).not.toHaveAttribute('href');
    act(() => unshared.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Ask in this Canvas’s chat to change it. Its creator can share it with you to open it.');
    fireEvent.click(unshared);
    expect(screen.queryByText(/Sidekick page/u)).toBeNull();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(sidekickRow('Launch tracker')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(sidekickRow('Launch tracker'));
    expect(await screen.findByRole('complementary', { name: 'Sidekick: Launch tracker' })).toHaveTextContent(`Sidekick panel ${TRACKER}`);
    expect(screen.getByRole('button', { name: 'Canvas menu: Q4 revenue review' })).toBeInTheDocument();
    expect(screen.queryByText(/Sidekick page/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary', { name: 'Sidekick: Launch tracker' })).toBeNull();
  });

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

  it('reopens a closed panel onto the newest artifact from the command menu', async () => {
    renderCanvas();
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    surfaces.length = 0;
  showStateHeader.current = false;
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open artifact' }));
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
    expect(lastSurface().expanded).toBe(false);
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

  it('offers the four command shortcuts and opens Share from its tile', async () => {
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Canvas actions' })).toBeNull();
    await openMenu('Q4 revenue review');
    const shortcuts = await screen.findByRole('group', { name: 'Actions' });
    expect(within(shortcuts).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Share', 'Open artifact', 'Copy link', 'Pin']);
    expect(screen.queryByRole('menuitem', { name: 'Copy Canvas ID' })).toBeNull();
    fireEvent.click(within(shortcuts).getByRole('menuitem', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Share Canvas' })).toBeInTheDocument();
  });

  it('disables the artifact shortcut on a Canvas that has none', async () => {
    getCanvas.mockResolvedValue(detail({ artifacts: [] }));
    renderCanvas();
    await waitFor(() => expect(getCanvas).toHaveBeenCalled());
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Copy link' });
    const shortcut = screen.getByRole('menuitem', { name: 'Open artifact' });
    expect(shortcut).toHaveAttribute('aria-disabled', 'true');
    act(() => shortcut.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('This Canvas has no artifacts yet.');
  });

  it('disables Open artifact while its panel is shown and enables it after close', async () => {
    renderCanvas();
    await openMenu('Q4 revenue review');
    await screen.findByRole('menuitem', { name: 'Open artifact' });
    const shortcut = () => screen.getByRole('menuitem', { name: 'Open artifact' });
    expect(shortcut()).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Open test panel' }));
    expect(shortcut()).toHaveAttribute('aria-disabled', 'true');
    act(() => shortcut().focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('The artifact panel is already open.');
    fireEvent.click(shortcut());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close test panel' }));
    expect(shortcut()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('pins the Canvas from its menu', async () => {
    renderCanvas();
    const trigger = await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
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

  it("changes the Canvas's appearance from its menu, saving through the route and drawing the answer on the pill", async () => {
    setCanvasAppearance.mockResolvedValue(detail({ appearance: { icon: null, color: 'orange' } }));
    renderCanvas();
    await openMenu('Q4 revenue review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Change appearance' }));
    const palette = await screen.findByRole('menu', { name: 'Change appearance' });
    // Focus starts inside the palette, on the colour the Canvas wears (its id's hue while unchosen).
    await waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'menuitemradio'));
    expect(palette).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(palette).getByRole('menuitemradio', { name: 'Orange' }));
    expect(setCanvasAppearance).toHaveBeenCalledWith(CANVAS, { color: 'orange' });
    // The pill's mark is the palette's own button, beside its menu.
    const mark = screen.getByRole('button', { name: 'Change appearance', hidden: true });
    await waitFor(() => expect(mark.querySelector('.identity-tile-shape')).toHaveStyle({ background: 'var(--av-sys-color-project-tint-orange)' }));
  });

  it("opens the same palette from the pill's mark, beside its menu", async () => {
    setCanvasAppearance.mockResolvedValue(detail({ appearance: { icon: 'flag', color: null } }));
    renderCanvas();
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Change appearance' }), { button: 0, ctrlKey: false });
    const palette = await screen.findByRole('menu', { name: 'Change appearance' });
    fireEvent.click(within(palette).getByRole('menuitemradio', { name: 'Flag' }));
    expect(setCanvasAppearance).toHaveBeenCalledWith(CANVAS, { icon: 'flag' });
  });

  it('draws the icon and colour chosen for the Canvas on its pill, and follows a choice the list push carries', async () => {
    getCanvas.mockResolvedValue(detail({ appearance: { icon: 'flag', color: 'orange' } }));
    const client = renderCanvas();
    applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review', { appearance: { icon: 'flag', color: 'orange' } })]);
    await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
    const pill = screen.getByRole('button', { name: 'Change appearance' });
    await waitFor(() => expect(pill.querySelector('.identity-tile-shape svg')).toHaveClass('lucide-flag'));
    act(() => { applyVersionedSidebarList(client, 'canvases', 2, [listRow('Q4 revenue review', { appearance: { icon: 'flag', color: 'blue' } })]); });
    await waitFor(() => expect(pill.querySelector('.identity-tile-shape')).toHaveStyle({ background: 'var(--av-sys-color-project-tint-blue)' }));
    expect(getCanvas).toHaveBeenCalledTimes(1);
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

    it('tells a guest, who cannot ask, that they cannot open it, with nothing to try again', async () => {
      getCanvasAccess.mockRejectedValue(new ApiError('Only a member of the Organization can ask to open a Canvas', 403, 'canvas_access_request_not_member'));
      renderCanvas();
      expect(await screen.findByText('You can’t open this Canvas.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    });

    it('offers Request access with an optional message, opening on the message, then says when it was sent in the button\'s place', async () => {
      renderCanvas();
      expect(await screen.findByText("You don't have access to this Canvas")).toBeInTheDocument();
      expect(getCanvasAccess).toHaveBeenCalledWith(CANVAS, expect.anything());
      expect(screen.queryByText('This Canvas does not exist.')).toBeNull();
      expect(surfaces).toHaveLength(0);
      expect(document.title).toBe('Request access · Rally');

      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'pending', requestedAt: new Date().toISOString() } });
      fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
      const dialog = await screen.findByRole('dialog', { name: 'Request access' });
      await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Message (optional)' })).toHaveFocus());
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Message (optional)' }), { target: { value: '  For the board review  ' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

      await waitFor(() => expect(requestCanvasAccess).toHaveBeenCalledWith(CANVAS, 'For the board review'));
      expect(await screen.findByRole('status')).toHaveTextContent('Request sent · just now');
      expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
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
      expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
      cleanup();

      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'denied', requestedAt: '2026-11-08T09:00:00.000Z', decidedAt: new Date().toISOString() } });
      renderCanvas();
      expect(await screen.findByRole('button', { name: 'Request access' })).toBeEnabled();
      expect(screen.getByRole('status')).toHaveTextContent('Request declined · just now');
      expect(screen.getByText('Ask again if you still need it.')).toBeInTheDocument();
    });

    it('says declined, with Request access again, when its access_denied row arrives', async () => {
      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'pending', requestedAt: '2026-11-08T09:00:00.000Z', decidedAt: null } });
      const client = renderCanvas();
      expect(await screen.findByRole('status')).toHaveTextContent(/^Request sent · /u);
      getCanvasAccess.mockResolvedValue({ access: 'requestable', title: null, request: { state: 'denied', requestedAt: '2026-11-08T09:00:00.000Z', decidedAt: new Date().toISOString() } });
      act(() => {
        applyVersionedSidebarList(client, 'activity', 1, { unseenCount: 1, items: [{
          id: 'denied-1', kind: 'access_denied', parentKind: 'canvas', parentId: CANVAS, parentTitle: null,
          substreamId: null, messageId: null, messageSequence: null, runId: null, actor: { kind: 'person', id: MAYA },
          preview: null, createdAt: '2026-11-08T09:05:00.000Z', seen: false,
          accessRequest: { state: 'denied', decidedByName: 'Maya', decidedByUserId: MAYA },
        }] });
      });
      expect(await screen.findByRole('button', { name: 'Request access' })).toBeEnabled();
      expect(screen.getByRole('status')).toHaveTextContent('Request declined · just now');
      expect(getCanvas).toHaveBeenCalledTimes(1);
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

    it('reads the Canvas again when the access read says it is open already', async () => {
      getCanvasAccess.mockRejectedValue(new ApiError('You can already open this Canvas', 409, 'canvas_access_open'));
      getCanvas.mockRejectedValueOnce(notFound()).mockResolvedValue(detail());
      renderCanvas();
      await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
      expect(getCanvas).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("You don't have access to this Canvas")).toBeNull();
      expect(screen.queryByText('This Canvas could not be opened.')).toBeNull();
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
    expect(screen.getByText('This Canvas opens when Rally reconnects.')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Canvas actions' })).toBeNull();
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

  it('keeps guest editors when saving while the people roster is pending', async () => {
    const GUEST = asUserId('00000000-0000-7000-8000-0000000000a7');
    getWorkspaceMembers.mockReturnValue(new Promise(() => {}));
    getCanvas.mockResolvedValue(detail({ visibility: 'workspace', participantUserIds: [GUEST] }));
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'workspace', participantUserIds: [GUEST], artifactVisibility: 'public' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Anyone with the link' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'workspace', userIds: [GUEST], artifactVisibility: 'public', artifactUserIds: [], expectedRevision: 0,
    }));
  });

  it('lets a manager explicitly retain an existing editor as an artifact recipient', async () => {
    getCanvas.mockResolvedValue(detail({visibility:'participants',participantUserIds:[MAYA]}));
    setCanvasAudience.mockResolvedValue(detail({visibility:'participants',participantUserIds:[MAYA],artifactVisibility:'participants',artifactUserIds:[MAYA]}));
    renderCanvas();
    await waitFor(()=>expect(screen.getByRole('button',{name:'Share'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'Share'}));
    const dialog=await screen.findByRole('dialog',{name:'Share Canvas'});
    const artifactControls=within(dialog).getByRole('group',{name:'Who can interact with artifacts'});
    fireEvent.click(within(artifactControls).getByRole('radio',{name:'Specific people'}));
    const section=artifactControls.closest('section')!;
    fireEvent.click(within(section).getByRole('button',{name:'Add people'}));
    const person=await within(section).findByRole('checkbox',{name:'Maya Lin'});
    expect(person).toBeEnabled();
    fireEvent.click(person);
    fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS,{
      visibility:'participants',userIds:[MAYA],artifactVisibility:'participants',artifactUserIds:[MAYA],expectedRevision:0,
    }));
  });

  it('keeps explicit artifact recipients when they also become editors', async () => {
    getCanvas.mockResolvedValue(detail({ visibility: 'creator', artifactVisibility: 'participants', artifactUserIds: [MAYA] }));
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA], artifactVisibility: 'participants', artifactUserIds: [MAYA] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const editorSection = within(dialog).getByRole('group', { name: 'Who can edit' }).closest('section')!;
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: 'Specific people' }));
    fireEvent.click(within(editorSection).getByRole('button', { name: 'Add people' }));
    fireEvent.click(await within(editorSection).findByRole('checkbox', { name: 'Maya Lin' }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'participants', userIds: [MAYA], artifactVisibility: 'participants', artifactUserIds: [MAYA], expectedRevision: 0,
    }));
  });

  it('rules out artifact audiences narrower than Organization editors, keeping public', async () => {
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'workspace', artifactVisibility: 'workspace' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const artifactControls = within(within(dialog).getByRole('group', { name: 'Who can interact with artifacts' }));
    expect(artifactControls.getByRole('radio', { name: 'Editors only' })).toBeChecked();
    expect(artifactControls.getByRole('radio', { name: 'Specific people' })).toBeEnabled();
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));
    expect(artifactControls.getByRole('radio', { name: /Everyone in the Organization/ })).toBeChecked();
    expect(artifactControls.getByRole('radio', { name: 'Editors only' })).toBeDisabled();
    expect(artifactControls.getByRole('radio', { name: 'Specific people' })).toBeDisabled();
    expect(within(dialog).getByText('Everyone in the Organization can edit, so they can already use the artifacts.')).toBeInTheDocument();

    fireEvent.click(artifactControls.getByRole('radio', { name: 'Anyone with the link' }));
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: 'Only you' }));
    expect(artifactControls.getByRole('radio', { name: 'Editors only' })).toBeEnabled();
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));
    expect(artifactControls.getByRole('radio', { name: 'Anyone with the link' })).toBeChecked();

    fireEvent.click(artifactControls.getByRole('radio', { name: /Everyone in the Organization/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'workspace', userIds: [], artifactVisibility: 'workspace', artifactUserIds: [], expectedRevision: 0,
    }));
  });

  it('restores the stored artifact choice when editors leave the Organization, never saving a raise nobody picked', async () => {
    getCanvas.mockResolvedValue(detail({ visibility: 'workspace', artifactVisibility: 'editors' }));
    setCanvasAudience.mockResolvedValue(detail());
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const artifactControls = within(within(dialog).getByRole('group', { name: 'Who can interact with artifacts' }));
    expect(artifactControls.getByRole('radio', { name: /Everyone in the Organization/ })).toBeChecked();
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: 'Only you' }));
    expect(artifactControls.getByRole('radio', { name: 'Editors only' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'creator', userIds: [], artifactVisibility: 'editors', artifactUserIds: [], expectedRevision: 0,
    }));
  });

  it('saves public artifact use independently of the two editors and copies the artifact URL',async()=>{
    getCanvas.mockResolvedValue(detail({visibility:'participants',participantUserIds:[MAYA],sharingRevision:7}));
    setCanvasAudience.mockResolvedValue(detail({visibility:'participants',participantUserIds:[MAYA],artifactVisibility:'public',sharingRevision:8}));
    renderCanvas();
    await waitFor(()=>expect(screen.getByRole('button',{name:'Share'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'Share'}));
    const dialog=await screen.findByRole('dialog',{name:'Share Canvas'});
    const artifactControls=within(within(dialog).getByRole('group',{name:'Who can interact with artifacts'}));
    fireEvent.click(artifactControls.getByRole('radio',{name:'Anyone with the link'}));
    expect(editorControls(dialog).getByRole('radio',{name:'Specific people'})).toBeChecked();
    fireEvent.click(await within(dialog).findByRole('button',{name:'Copy link'}));
    await waitFor(()=>expect(copyText).toHaveBeenCalledWith('https://quiet-blue-river-garden-g.rallyusercontent.com'));
    fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS,{visibility:'participants',userIds:[MAYA],artifactVisibility:'public',artifactUserIds:[],expectedRevision:7}));
  });

  it('retries an artifact link after publication catches up without closing Share or losing the draft', async () => {
    const url = 'https://quiet-blue-river-garden-g.rallyusercontent.com';
    let finish: ((value: { artifactId: string; canonicalUrl: string }) => void) | undefined;
    artifactLink.mockRejectedValueOnce(new ApiError('Not published yet', 404, 'artifact_not_found'))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Artifact link couldn’t be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const dialog = screen.getByRole('dialog', { name: 'Share Canvas' });
    const artifactControls = within(dialog).getByRole('group', { name: 'Who can interact with artifacts' });
    fireEvent.click(within(artifactControls).getByRole('radio', { name: 'Anyone with the link' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry link' }));
    await waitFor(() => expect(artifactLink).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole('button', { name: 'Getting link…' })).toBeDisabled();
    await act(async () => { finish?.({ artifactId: '00000000-0000-7000-8000-0000000000b2', canonicalUrl: url }); });
    expect(await within(dialog).findByRole('textbox', { name: 'Artifact link' })).toHaveValue(url);
    expect(within(artifactControls).getByRole('radio', { name: 'Anyone with the link' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(url));
  });

  it('changes who can open it from Share, for a manager', async () => {
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    const onlyYou = editorControls(dialog).getByRole('radio', { name: 'Only you' });
    expect(onlyYou).toBeChecked();
    fireEvent.click(editorControls(dialog).getByText('Specific people'));
    expect(onlyYou).not.toBeChecked();
    expect(editorControls(dialog).getByRole('radio', { name: 'Specific people' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button',{name:'Add people'}));
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Maya Lin' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'participants', userIds: [MAYA], artifactVisibility: 'editors', artifactUserIds: [], expectedRevision: 0 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Canvas' })).toBeNull());
  });

  it('says a Canvas a Sidekick writes is open to everyone the Sidekick is shared with, whatever is chosen', async () => {
    getCanvas.mockResolvedValue(detail({ writerSidekickId: '00000000-0000-7000-8000-0000000000b9' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    expect(within(dialog).queryByText('Nobody else can open it.')).toBeNull();
    const onlyYou = editorControls(dialog).getByRole('radio', { name: 'Only you' });
    expect(onlyYou).toBeChecked();
    expect(within(dialog).getByText('Editors include everyone the Sidekick that writes this Canvas is shared with.')).toBeInTheDocument();
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
    fireEvent.click(within(dialog).getByRole('button',{name:'Add people'}));
    expect(await within(dialog).findByRole('checkbox', { name: 'Maya Lin' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'participants', userIds: [MAYA], artifactVisibility: 'editors', artifactUserIds: [], expectedRevision: 0 }));
  });

  it('takes the visibility an approval moved a creator-only Canvas to, so Save keeps the person let in', async () => {
    getCanvas.mockResolvedValue(detail({ visibility: 'creator', participantUserIds: [],
      pendingAccessRequests: [{ userId: MAYA, name: 'Maya Lin', message: null, requestedAt: '2026-11-08T09:00:00.000Z' }] }));
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    expect(editorControls(dialog).getByRole('radio', { name: /^Only you/u })).toBeChecked();

    // The server seats Maya and opens the Canvas to its participants.
    getCanvas.mockResolvedValue(detail({ visibility: 'participants', participantUserIds: [MAYA], pendingAccessRequests: [] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve Maya Lin' }));
    await waitFor(() => expect(within(dialog).queryByRole('region', { name: 'Requests' })).toBeNull());
    await waitFor(() => expect(editorControls(dialog).getByRole('radio', { name: /^Specific people/u })).toBeChecked());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'participants', userIds: [MAYA], artifactVisibility: 'editors', artifactUserIds: [], expectedRevision: 0 }));
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

  it('keeps Organization members searchable and checked while allowing only guests to be selected', async () => {
    const GUEST = asUserId('00000000-0000-7000-8000-0000000000a4');
    const THEO = asUserId('00000000-0000-7000-8000-0000000000a3');
    const RAE = asUserId('00000000-0000-7000-8000-0000000000a5');
    getWorkspaceMembers.mockResolvedValue([
      { id: ME, name: 'Adam Jones', email: 'adam@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: MAYA, name: 'Maya Lin', email: 'maya@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: THEO, name: 'Theo Park', email: 'theo@example.test', timezone: 'UTC', status: 'active' },
      { id: RAE, name: 'Rae Lee', email: 'rae@example.test', timezone: 'UTC', accessClass: 'member' },
      { id: asUserId('00000000-0000-7000-8000-0000000000a6'), name: 'Isa Bell', email: 'isa@example.test', timezone: 'UTC', status: 'invited' },
      { id: GUEST, name: 'Gale Guest', email: 'gale@example.test', timezone: 'UTC', accessClass: 'guest' },
    ]);
    // Maya made it; Adam, an administrator, is managing it.
    getCanvas.mockResolvedValue(detail({ createdByUserId: MAYA, visibility: 'participants', participantUserIds: [THEO] }));
    setCanvasAudience.mockResolvedValue(detail({ createdByUserId: MAYA, visibility: 'workspace', participantUserIds: [GUEST] }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    fireEvent.click(within(dialog).getByRole('button',{name:'Add people'}));
    expect(await within(dialog).findByRole('checkbox', { name: 'Theo Park' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Rae Lee' })).not.toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: 'Adam Jones' })).toBeNull();

    fireEvent.click(editorControls(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));

    expect(within(dialog).getByRole('checkbox', { name: 'Theo Park' })).toBeDisabled();
    const invitee = within(dialog).getByRole('checkbox', { name: 'Isa Bell' });
    expect(invitee).toBeDisabled();
    expect(invitee).not.toBeChecked();
    expect(invitee).toHaveAccessibleDescription('Invitation pending');
    const search = within(dialog).getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(search, { target: { value: 'rae@example.test' } });
    const rae = within(dialog).getByRole('checkbox', { name: 'Rae Lee' });
    expect(rae).toBeChecked();
    expect(rae).toBeDisabled();
    expect(within(dialog).getAllByRole('checkbox')).toEqual([rae]);
    fireEvent.change(search, { target: { value: '' } });
    expect(within(dialog).getByRole('checkbox', { name: 'Gale Guest' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Gale Guest' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    // Theo, a member, is in already; only the guest is sent.
    await waitFor(() => expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'workspace', userIds: [GUEST], artifactVisibility: 'workspace', artifactUserIds: [], expectedRevision: 0 }));
  });

  it('invites the guests typed in the form on Save, the dialog\'s one primary action', async () => {
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'workspace' }));
    renderCanvas();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Canvas' });
    fireEvent.click(editorControls(dialog).getByRole('radio', { name: /Everyone in the Organization/ }));
    const editorSection = within(within(dialog).getByRole('group', { name: 'Who can edit' }).closest('section')!);
    fireEvent.click(editorSection.getByRole('button',{name:'Add people'}));
    expect(editorSection.getByRole('searchbox', { name: 'Search people' })).toBeInTheDocument();
    const guests = within(dialog).getByText('Invite a guest by email').closest('details')!;
    guests.open = true;
    fireEvent(guests, new Event('toggle'));
    fireEvent.change(within(dialog).getByLabelText('Email addresses'), { target: { value: 'b@example.test, a@example.test' } });
    expect(within(dialog).getAllByRole('button').filter((button) => /^(Share|Save)$/.test(button.textContent ?? '')).map((button) => button.textContent)).toEqual(['Save']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createScopeInvitations).toHaveBeenCalledWith(expect.objectContaining({
      parentId: CANVAS, emails: ['a@example.test', 'b@example.test'],
      targets: [{ kind: 'workstream', workspaceId: WORKSPACE, parentId: CANVAS }],
    })));
    expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, { visibility: 'workspace', userIds: [], artifactVisibility: 'workspace', artifactUserIds: [], expectedRevision: 0 });
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

it('hands the current Canvas live counts to the composer and follows its pushes', async () => {
  const client = renderCanvas();
  await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
  act(() => { applyVersionedSidebarList(client, 'canvases', 1, [listRow('Q4 revenue review', {
    runningActivity: { backgroundAgents: 2, sidekicks: 1 },
  })]); });
  await screen.findByText('2 background agents running · 1 Sidekick running', { selector: '[role="status"]' });
  act(() => { applyVersionedSidebarList(client, 'canvases', 2, [listRow('Q4 revenue review', {
    runningActivity: { backgroundAgents: 0, sidekicks: 0 },
  })]); });
  await waitFor(() => expect(screen.queryByText(/background agents running/u, { selector: '[role="status"]' })).toBeNull());
});

it('refreshes counts for an open Canvas outside the sidebar page', async () => {
  getCanvas.mockResolvedValue(detail({ runningActivity: { backgroundAgents: 1, sidekicks: 0 } }));
  const client = renderCanvas();
  await screen.findByText('1 background agent running', { selector: '[role="status"]' });
  let resolveRefresh!: (value: ReturnType<typeof detail>) => void;
  getCanvas.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
  act(() => { applyVersionedSidebarList(client, 'canvases', 1, []); });
  expect(screen.getByRole('status')).toHaveTextContent('1 background agent running');
  await act(async () => { resolveRefresh(detail({ runningActivity: { backgroundAgents: 0, sidekicks: 1 } })); });
  await screen.findByText('1 Sidekick running', { selector: '[role="status"]' });
  expect(screen.queryByText('1 background agent running', { selector: '[role="status"]' })).toBeNull();
});

it('gates the actual Canvas composer on the current connection snapshot', async () => {
  const client = renderCanvas();
  await screen.findByRole('button', { name: 'Canvas menu: Q4 revenue review' });
  for (const [state, sidebarReady, count] of [['connecting', false, 1], ['connected', false, 2], ['connected', true, 3], ['disconnected', false, 4]] as const) {
    act(() => {
      socketStatus.state = state;
      socketStatus.sidebarReady = sidebarReady;
      applyVersionedSidebarList(client, 'canvases', count, [listRow('Q4 revenue review', {
        runningActivity: { backgroundAgents: count, sidekicks: 0 },
      })]);
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(sidebarReady ? '3 background agents running' : ''));
  }
});

it('cancels an initial off-page detail read when a newer Canvas push arrives', async () => {
  let resolveOld!: (value: CanvasDetail) => void;
  getCanvas.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue(detail({ runningActivity: { backgroundAgents: 0, sidekicks: 1 } }));
  const client = renderCanvas();
  await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(1));
  const oldSignal = getCanvas.mock.calls[0]![1] as AbortSignal;
  act(() => { applyVersionedSidebarList(client, 'canvases', 1, []); });
  await screen.findByText('1 Sidekick running', { selector: '[role="status"]' });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { resolveOld(detail({ runningActivity: { backgroundAgents: 9, sidekicks: 0 } })); });
  expect(screen.getByRole('status')).toHaveTextContent('1 Sidekick running');
});

it('does not retry an inaccessible Canvas on unrelated Canvas pushes', async () => {
  getCanvas.mockRejectedValue(new ApiError('Not found', 404, 'canvas_not_found'));
  const client = renderCanvas();
  await waitFor(() => expect(client.getQueryState(['canvas', CANVAS])?.status).toBe('error'));
  const calls = getCanvas.mock.calls.length;
  await act(async () => { applyVersionedSidebarList(client, 'canvases', 1, []); });
  expect(getCanvas).toHaveBeenCalledTimes(calls);
});

describe('the artifact cards’ audience', () => {
  const GUEST = asUserId('00000000-0000-7000-8000-0000000000a9');
  const sharing = () => lastSurface().props.artifactSharing!;

  it('hands the surface the Canvas’s published artifacts', async () => {
    renderCanvas();
    await waitFor(() => expect(lastSurface().props.artifactSharing).toBeDefined());
    expect(sharing().publishedIds).toEqual(['00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000b1']);
    expect(sharing().audience).toMatchObject({ value: 'editors', canChange: true });
  });

  it('saves a new artifact audience with the editors as they were and the revision it was drawn from', async () => {
    getCanvas.mockResolvedValue(detail({
      visibility: 'workspace', participantUserIds: [MAYA, GUEST], sharingRevision: 4,
      artifactVisibility: 'workspace', artifactUserIds: [GUEST],
    }));
    setCanvasAudience.mockResolvedValue(detail({ visibility: 'workspace', participantUserIds: [MAYA, GUEST], sharingRevision: 5, artifactVisibility: 'public' }));
    renderCanvas();
    await waitFor(() => expect(lastSurface().props.artifactSharing?.audience?.value).toBe('workspace'));
    // The member list arrives on its own read; the guest filter needs it.
    await waitFor(() => expect(getWorkspaceMembers).toHaveBeenCalled());

    await act(async () => { await sharing().audience!.change('public'); });

    // An Organization-wide Canvas names only its guests as editors; Maya is a member.
    expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'workspace', userIds: [GUEST], artifactVisibility: 'public', artifactUserIds: [], expectedRevision: 4,
    });
    await waitFor(() => expect(sharing().audience?.value).toBe('public'));
  });

  it('keeps the chosen artifact users when the audience stays the Organization', async () => {
    getCanvas.mockResolvedValue(detail({ artifactVisibility: 'participants', artifactUserIds: [GUEST], sharingRevision: 2 }));
    setCanvasAudience.mockResolvedValue(detail({ artifactVisibility: 'workspace', artifactUserIds: [GUEST], sharingRevision: 3 }));
    renderCanvas();
    await waitFor(() => expect(lastSurface().props.artifactSharing?.audience?.value).toBe('participants'));

    await act(async () => { await sharing().audience!.change('workspace'); });

    expect(setCanvasAudience).toHaveBeenCalledWith(CANVAS, {
      visibility: 'creator', userIds: [], artifactVisibility: 'workspace', artifactUserIds: [GUEST], expectedRevision: 2,
    });
  });

  it('reloads the Canvas and says why when someone else changed sharing first', async () => {
    setCanvasAudience.mockRejectedValue(new ApiError('Sharing changed', 409, 'canvas_sharing_changed'));
    renderCanvas();
    await waitFor(() => expect(lastSurface().props.artifactSharing?.audience).toBeDefined());
    const reads = getCanvas.mock.calls.length;

    await act(async () => { await expect(sharing().audience!.change('public')).rejects.toThrow('Sharing changed'); });

    await waitFor(() => expect(getCanvas.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText(/Someone else changed this Canvas’s sharing first/u)).toBeInTheDocument();
  });

  it('offers the audience without a menu to someone who cannot manage sharing', async () => {
    getCanvas.mockResolvedValue(detail({ canManage: false }));
    renderCanvas();
    await waitFor(() => expect(lastSurface().props.artifactSharing?.audience?.canChange).toBe(false));
  });
});
