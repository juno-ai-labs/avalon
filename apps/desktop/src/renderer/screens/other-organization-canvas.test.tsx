import { asUserId } from '@rally/contracts';
import type { CanvasDetail } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasDetailQueryKey } from '../lib/canvases';
import { CollaborationSessionProvider } from '../lib/collaboration-session';
import type * as AppSession from '../lib/app-session';
import type * as Platform from '../lib/platform';
import { OtherOrganizationCanvasScreen } from './other-organization-canvas';
import { ORGANIZATION_CANVAS_ROUTE, organizationCanvasRoute } from '../lib/organization-scope';

const ME = asUserId('00000000-0000-7000-8000-0000000000a1');
const HOME = '00000000-0000-7000-8000-0000000000f1';
const ACME = '00000000-0000-7000-8000-0000000000f2';
const CANVAS = '00000000-0000-7000-8000-0000000000c1';

const openOrganizationSession = vi.hoisted(() => vi.fn());
const homeSession = { user: { id: ME, name: 'Adam', email: 'adam@example.test', timezone: 'UTC' }, workspace: { id: HOME, name: 'Home', region: 'global', role: 'member', timezone: 'UTC' } };
vi.mock('../lib/app-session', async (importOriginal) => ({
  ...await importOriginal<typeof AppSession>(),
  useAppSession: () => ({ session: homeSession, openOrganizationSession }),
}));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof Platform>(),
  desktopBridge: () => ({ copyText: vi.fn(), getRuntimeConfig: async () => ({ webBaseUrl: 'https://rallywith.ai' }) }),
}));
// The conversation has its own sockets; this file is about which client the Canvas screen runs on.
vi.mock('./conversation-surface', () => ({
  ConversationOpeningSkeleton: ({ label }: { label: string }) => <p>{label}</p>,
  ConversationSurface: (props: { renderHeader?: (context: never) => React.ReactNode }) =>
    <div>{props.renderHeader?.({ presentUserIds: [], panelOpen: false, openPanel: () => undefined } as never)}</div>,
}));
vi.mock('./automation', () => ({ SidekickPanel: () => null }));

function detail(title: string): CanvasDetail {
  return {
    artifactVisibility: 'editors', artifactUserIds: [], sharingRevision: 0,
    id: CANVAS, title, createdByUserId: asUserId('00000000-0000-7000-8000-0000000000a9'), createdAt: '2026-11-07T09:00:00.000Z',
    updatedAt: '2026-11-07T09:30:00.000Z', lastEditor: null, writerSidekickId: null, visibility: 'participants',
    participantUserIds: [ME], canManage: false, artifacts: [],
  } as CanvasDetail;
}

function clientApi(title: string) {
  return {
    getCanvas: vi.fn(async () => detail(title)),
    getWorkspaceMembers: vi.fn(async () => []),
    getCanvasAccess: vi.fn(),
    setSession: vi.fn(),
  };
}

beforeEach(() => {
  cleanup();
  openOrganizationSession.mockReset();
});

describe('OtherOrganizationCanvasScreen', () => {
  it("opens another Organization's Canvas on that Organization's client and cache, leaving the one in front untouched", async () => {
    const home = clientApi('Home copy');
    const acme = clientApi('Partner roadmap');
    openOrganizationSession.mockResolvedValue({
      api: acme,
      session: { ...homeSession, workspace: { id: ACME, name: 'Acme', region: 'global', role: 'member', timezone: 'UTC', accessClass: 'guest' } },
    });
    const shellCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A stale row under the same key in the shell's cache must not paint here.
    shellCache.setQueryData(canvasDetailQueryKey(CANVAS), detail('Home copy'));
    render(<ErrorNoticeProvider><QueryClientProvider client={shellCache}>
      <CollaborationSessionProvider api={home as never} session={homeSession as never}>
        <Tooltip.Provider><MemoryRouter initialEntries={[organizationCanvasRoute({ region: 'global', workspaceId: ACME }, CANVAS)]}>
          <Routes><Route element={<OtherOrganizationCanvasScreen />} path={ORGANIZATION_CANVAS_ROUTE} /></Routes>
        </MemoryRouter></Tooltip.Provider>
      </CollaborationSessionProvider>
    </QueryClientProvider></ErrorNoticeProvider>);

    expect(await screen.findByText('Partner roadmap')).toBeInTheDocument();
    expect(screen.queryByText('Home copy')).not.toBeInTheDocument();
    expect(openOrganizationSession).toHaveBeenCalledWith({ region: 'global', workspaceId: ACME });
    expect(acme.getCanvas).toHaveBeenCalledWith(CANVAS, expect.anything());
    expect(home.getCanvas).not.toHaveBeenCalled();
    // The shell's own copy is left as it was.
    expect(shellCache.getQueryData<CanvasDetail>(canvasDetailQueryKey(CANVAS))?.title).toBe('Home copy');
  });

  it('says so, and offers a retry, when the other Organization cannot be opened', async () => {
    openOrganizationSession.mockRejectedValue(new Error('You no longer have access to Acme.'));
    render(<ErrorNoticeProvider><QueryClientProvider client={new QueryClient()}>
      <CollaborationSessionProvider api={clientApi('Home') as never} session={homeSession as never}>
        <Tooltip.Provider><MemoryRouter initialEntries={[organizationCanvasRoute({ region: 'global', workspaceId: ACME }, CANVAS)]}>
          <Routes><Route element={<OtherOrganizationCanvasScreen />} path={ORGANIZATION_CANVAS_ROUTE} /></Routes>
        </MemoryRouter></Tooltip.Provider>
      </CollaborationSessionProvider>
    </QueryClientProvider></ErrorNoticeProvider>);
    expect(await screen.findByText('You no longer have access to Acme.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
