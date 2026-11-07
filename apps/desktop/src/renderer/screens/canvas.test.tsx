import { asUserId } from '@rally/contracts';
import type { CanvasDetail } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutKey, writeLayout } from '../lib/desktop-layout';
import type * as Platform from '../lib/platform';
import { openResourceRequest } from '../lib/navigation-routes';
import type { ConversationSurfaceProps } from './conversation-surface';
import { CanvasScreen } from './canvas';

const WORKSPACE = '00000000-0000-7000-8000-0000000000f1';
const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const MAYA = asUserId('00000000-0000-7000-8000-0000000000a2');
const CANVAS = '00000000-0000-7000-8000-0000000000c1';

const getCanvas = vi.hoisted(() => vi.fn());
const setCanvasPinned = vi.hoisted(() => vi.fn());
const setCanvasAudience = vi.hoisted(() => vi.fn());
const getWorkspaceMembers = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({
    api: { getCanvas, setCanvasPinned, setCanvasAudience, getWorkspaceMembers },
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
const surfaces = vi.hoisted(() => [] as Array<{ props: ConversationSurfaceProps; requested: string | null }>);
vi.mock('./conversation-surface', () => ({
  ConversationSurface: (props: ConversationSurfaceProps) => {
    const location = useLocation();
    surfaces.push({ props, requested: openResourceRequest(location.state)?.resourceId ?? null });
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

function renderCanvas(entry = `/canvases/${CANVAS}`): void {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Tooltip.Provider><MemoryRouter initialEntries={[entry]}>
      <Routes><Route element={<CanvasScreen />} path="/canvases/:id" /></Routes>
    </MemoryRouter></Tooltip.Provider>
  </QueryClientProvider>);
}

const lastSurface = () => surfaces.at(-1)!;

beforeEach(() => {
  surfaces.length = 0;
  copyText.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  getCanvas.mockReset().mockResolvedValue(detail());
  setCanvasPinned.mockReset().mockResolvedValue(undefined);
  setCanvasAudience.mockReset();
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

  it('opens the newest artifact when the Canvas has none saved open', async () => {
    renderCanvas();
    await waitFor(() => expect(lastSurface().requested).toBe('00000000-0000-7000-8000-0000000000b2'));
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
