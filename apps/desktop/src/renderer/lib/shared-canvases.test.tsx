import { CanvasSidebarRowSchema, type CanvasSidebarRow } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOtherOrganizationCanvases, useSharedCanvasesInAllOrganizations } from './shared-canvases';

const ACTIVE = { id: '00000000-0000-7000-8000-0000000000e0', name: 'Home', region: 'global' };
const ACME = { id: '00000000-0000-7000-8000-0000000000e1', name: 'Acme', region: 'enterprise' };
const BETA = { id: '00000000-0000-7000-8000-0000000000e2', name: 'Beta', region: 'global' };
const NEVER_OPENED = { id: '00000000-0000-7000-8000-0000000000e3', name: 'Gamma', region: 'global' };

const app = vi.hoisted(() => ({
  getOnboardingState: vi.fn(),
  getWorkspaceSharedCanvases: vi.fn(),
}));
const flags = vi.hoisted(() => ({ multipleWorkspacesEnabled: true }));
vi.mock('./app-session', () => ({
  WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY: ['workspace-account-directory'],
  useOptionalAppSession: () => app,
}));
vi.mock('./collaboration-session', () => ({
  useOptionalCollaborationSession: () => ({ api: {}, session: { user: { id: 'me' }, workspace: { id: ACTIVE.id, region: ACTIVE.region } } }),
}));
vi.mock('./use-client-feature-flags', () => ({ useClientFeatureFlags: () => ({ data: flags }) }));

function row(id: string, title: string, updatedAt: string): CanvasSidebarRow {
  return CanvasSidebarRowSchema.parse({
    id, title, createdByUserId: '00000000-0000-7000-8000-0000000000a2', createdAt: updatedAt, updatedAt,
    lastEditor: null, writerSidekickId: null, visibility: 'participants', artifactKind: null, unread: false,
    presentUserIds: [], pinnedPosition: null, sharedWithMe: true,
  });
}

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  flags.multipleWorkspacesEnabled = true;
  app.getOnboardingState.mockReset().mockResolvedValue({
    workspaces: [
      { ...ACTIVE, credentialStored: true },
      { ...ACME, accessClass: 'guest', credentialStored: true },
      { ...BETA, credentialStored: true },
      { ...NEVER_OPENED, credentialStored: false },
    ],
    invitations: [],
  });
  app.getWorkspaceSharedCanvases.mockReset().mockImplementation(async ({ workspaceId }: { workspaceId: string }) => {
    if (workspaceId === ACME.id) return [row('00000000-0000-7000-8000-0000000000d1', 'Partner roadmap', '2026-11-08T09:00:00.000Z')];
    if (workspaceId === BETA.id) throw new Error('unreachable');
    return [];
  });
});

describe('useOtherOrganizationCanvases', () => {
  it('reads every other Organization this device can reach, a guest one included, and keeps the ones that answered', async () => {
    const { result } = renderHook(() => useOtherOrganizationCanvases(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toEqual({
      organization: ACME,
      row: expect.objectContaining({ title: 'Partner roadmap' }),
    });
    expect(app.getWorkspaceSharedCanvases.mock.calls.map(([input]) => input)).toEqual([
      { region: ACME.region, workspaceId: ACME.id },
      { region: BETA.region, workspaceId: BETA.id },
    ]);
  });

  it('reads nothing and lists nothing once the switch is off', async () => {
    const { result } = renderHook(() => {
      const [enabled, setEnabled] = useSharedCanvasesInAllOrganizations();
      return { canvases: useOtherOrganizationCanvases(), enabled, setEnabled };
    }, { wrapper });
    await waitFor(() => expect(result.current.canvases).toHaveLength(1));
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.canvases).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('rally:device-preferences')!)).toMatchObject({ sharedCanvasesInAllOrganizations: false });

    app.getWorkspaceSharedCanvases.mockClear();
    const { result: later } = renderHook(() => useOtherOrganizationCanvases(), { wrapper });
    expect(later.current).toEqual([]);
    expect(app.getOnboardingState).toHaveBeenCalledTimes(1);
    expect(app.getWorkspaceSharedCanvases).not.toHaveBeenCalled();
  });
});
