import "../../../../tests/isolated-region";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from './lib/types';
import type { DesktopSession } from '../common/desktop';
import { SessionGate } from './App';
import { setCachedWorkstreams } from './lib/workstreams-cache';
import { ApiError } from './lib/api';
import {
  abandonPendingWorkstreamFeedOpen,
  markWorkstreamFeedOpenStarted,
  workstreamFeedOpenAttemptId,
} from './lib/telemetry';
import type * as CollaborationSessionModule from './lib/collaboration-session';

const sessionState = vi.hoisted(() => ({
  api: {
    getWorkspace: vi.fn(),
    getWorkspaceMembers: vi.fn(),
    getWorkspaceSocketTicket: vi.fn(),
    getSocketTicket: vi.fn(),
    getWorkstreamControlSocketTicket: vi.fn(),
  },
  activateWorkspace: vi.fn(),
  booting: false,
  getOnboardingState: vi.fn(),
  pendingInvitation: { token: 'invite-token-long-enough', region: 'global' },
  region: 'global',
  runtime: null,
  session: null as DesktopSession | null,
  signOut: vi.fn(),
  signOutIfCredentialCleared: vi.fn(),
  surrenderActiveWorkspace: vi.fn(),
}));

vi.mock('./lib/collaboration-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationSessionModule>();
  return {
    useCollaborationSession: () => sessionState,
    useOptionalCollaborationSession: () => sessionState,
    useShellCapabilities: () => actual.shellCapabilities({ host: 'desktop', session: sessionState.session }),
  };
});
vi.mock('./lib/app-session', () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppSession: () => sessionState,
  FINISH_SIGN_IN_IN_BROWSER: 'Finish signing in to Rally in your browser',
}));
vi.mock('./screens/onboarding', () => ({
  BootScreen: () => <div>boot screen</div>,
  InvitationOnboarding: ({ invitations }: { invitations: unknown[] }) => <div>invitations {invitations.length}</div>,
  RegionOnboarding: () => <div>organization setup</div>,
  SignInScreen: () => <div>sign in screen</div>,
}));
vi.mock('./components/app-shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('./screens/canvas', () => ({ CanvasScreen: () => <div>canvas screen</div> }));
vi.mock('./screens/canvases-home', () => ({ CanvasesHomeScreen: () => <div>canvases home</div> }));
vi.mock('./screens/automation', () => ({ AutomationScreen: () => <div>automation</div> }));
vi.mock('./screens/workspace-settings', () => ({
  WorkspaceSettingsScreen: ({ workspace }: { workspace: { name: string; timezone: string } }) => (
    <>
      <div>settings</div>
      <div data-testid="settings-workspace">{`${workspace.name} / ${workspace.timezone}`}</div>
    </>
  ),
}));

const identitySession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: 'https://api.rallywith.ai',
  user: { id: 'user-1', email: 'adam@example.com', name: 'Adam' },
  workspace: null,
};

/**
 * A session as `stored-session.ts` actually persists one: both timezones
 * present, so the renderer can describe the workspace without asking the API.
 * `identitySession` deliberately keeps the older, thinner shape — the desktop
 * type still allows it, and it is the case that must keep waiting for the read.
 */
const completeWorkspaceSession: DesktopSession = {
  ...identitySession,
  user: { ...identitySession.user, timezone: 'America/Los_Angeles' },
  workspace: {
    id: 'workspace-1',
    name: 'Rally Studio',
    region: 'global',
    role: 'owner',
    timezone: 'Europe/London',
  },
};

function renderGate(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setCachedWorkstreams(queryClient, []);
  render(<QueryClientProvider client={queryClient}><SessionGate /></QueryClientProvider>);
  return queryClient;
}

describe('SessionGate identity-first ordering', () => {
  afterEach(() => {
    abandonPendingWorkstreamFeedOpen();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    sessionState.booting = false;
    sessionState.session = null;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected', workspace: null, invitations: [] });
    sessionState.activateWorkspace.mockResolvedValue(undefined);
    sessionState.api.getWorkspace.mockResolvedValue({
      id: 'workspace-1',
      name: 'Rally Studio',
      region: 'global',
      currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' },
    });
    sessionState.api.getWorkspaceMembers.mockResolvedValue([]);
    // Hold transport outside the renderer: these tests exercise the real
    // provider/pool mount order, while workspace-socket and pool suites drive frames.
    sessionState.api.getWorkspaceSocketTicket.mockImplementation(() => new Promise(() => {}));
    sessionState.api.getSocketTicket.mockImplementation(() => new Promise(() => {}));
    sessionState.api.getWorkstreamControlSocketTicket.mockImplementation(() => new Promise(() => {}));
  });

  it('requires sign-in before showing a deep-linked invitation', () => {
    renderGate();
    expect(screen.getByText('sign in screen')).toBeVisible();
    expect(screen.queryByText(/invitations/u)).not.toBeInTheDocument();
  });

  it('opens the main UI immediately when the authenticated session has an organization', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();

    // With no Channels the landing waits inside the shell for General.
    expect(await screen.findByRole('main')).toBeVisible();
    expect(sessionState.getOnboardingState).not.toHaveBeenCalled();
  });

  it('starts organization admission and the landing feeds while organization details are pending', async () => {
    sessionState.session = { ...identitySession, workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' } };
    const profile = { id: 'workspace-1', name: 'Rally Studio', region: 'global', currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' } };
    let finishProfile!: (value: typeof profile) => void;
    sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise((resolve) => { finishProfile = resolve; }));
    const client = renderGate();
    expect(screen.getByText('Opening organization…')).toBeVisible();
    expect(sessionState.api.getWorkspace).toHaveBeenCalledTimes(1);
    expect(sessionState.api.getWorkspaceSocketTicket).toHaveBeenCalledTimes(1);
    const id = '00000000-0000-7000-8000-000000000031';
    // The workspace provider's canonical directory write can land before REST.
    const first: WorkstreamSummary = {
      id, title: 'First channel', titleStatus: 'settled', scope: 'workspace',
      harnessStatus: 'completed', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
      manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false,
      firstUnreadSequenceNumber: null, lastActivityAt: '2025-01-01T12:00:00Z',
      lastAccessedAt: '2026-09-09T12:00:00Z',
      pinPosition: null, nextPendingWakeup: null, participantUserIds: [], participantExtraCount: 0,
      spaceIds: [],
    };
    // Recently viewed wins the landing even outside the five most active rows.
    const recent = Array.from({ length: 5 }, (_, index) => ({ ...first,
      id: `00000000-0000-7000-8000-${String(index + 40).padStart(12, '0')}`,
      lastActivityAt: '2026-09-09T13:00:00Z', lastAccessedAt: '2026-09-08T12:00:00Z',
    }));
    act(() => setCachedWorkstreams(client, [first, ...recent]));
    await waitFor(() => expect(sessionState.api.getSocketTicket).toHaveBeenCalledTimes(6));
    expect(sessionState.api.getSocketTicket.mock.calls.some(([target]) => target === id)).toBe(true);
    expect(sessionState.api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(screen.getByText('Opening organization…')).toBeVisible();
    await act(async () => { finishProfile(profile); });
    // The landing opens the Canvases home; the sockets above were warmed regardless.
    expect(await screen.findByText('canvases home')).toBeVisible();
    expect(sessionState.api.getWorkspaceSocketTicket).toHaveBeenCalledTimes(1);
    expect(sessionState.api.getSocketTicket).toHaveBeenCalledTimes(6);
    expect(sessionState.api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
  });

  it('draws the settings surface on the session while the organization read is still in flight', async () => {
    window.history.replaceState({}, '', '/?surface=settings#/settings');
    sessionState.session = completeWorkspaceSession;
    sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise(() => {}));
    renderGate();

    // Nothing here has come back from the API. Settings used to sit behind
    // `Opening workspace…` for a whole round trip before its own reads could
    // even start, on a profile the session already held.
    expect(await screen.findByText('settings')).toBeVisible();
    expect(screen.queryByText('Opening organization…')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-workspace')).toHaveTextContent('Rally Studio / Europe/London');
  });

  it('replaces the session view of the organization with the server answer', async () => {
    window.history.replaceState({}, '', '/?surface=settings#/settings');
    sessionState.session = completeWorkspaceSession;
    const renamed = {
      id: 'workspace-1',
      name: 'Rally Labs',
      region: 'global',
      timezone: 'America/New_York',
      currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' },
    };
    let finishProfile!: (value: typeof renamed) => void;
    sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise((resolve) => { finishProfile = resolve; }));
    renderGate();
    expect(await screen.findByTestId('settings-workspace')).toHaveTextContent('Rally Studio / Europe/London');

    await act(async () => { finishProfile(renamed); });

    await waitFor(() => expect(screen.getByTestId('settings-workspace'))
      .toHaveTextContent('Rally Labs / America/New_York'));
  });

  it('still waits for the read when the session cannot describe the organization', async () => {
    window.history.replaceState({}, '', '/?surface=settings#/settings');
    // No timezones: a placeholder built from this would be inventing two of the
    // five fields, so the surface waits exactly as it did before.
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise(() => {}));
    renderGate();

    expect(await screen.findByText('Opening organization…')).toBeVisible();
    expect(screen.queryByText('settings')).not.toBeInTheDocument();
  });

  it.each([
    ['/canvases/00000000-0000-7000-8000-00000000a001', 'canvas screen'],
    ['/sidekicks/00000000-0000-7000-8000-000000000031', 'automation'],
  ])('preserves explicit route %s', async (route, destination) => {
    window.history.replaceState({}, '', `/#${route}`);
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();
    expect(await screen.findByText(destination)).toBeVisible();
    expect(window.location.hash).toBe(`#${route}`);
  });

  it.each([
    '/channels/00000000-0000-7000-8000-00000000a001/threads/00000000-0000-7000-8000-00000000a002',
    '/spaces/00000000-0000-7000-8000-00000000a001',
    '/workstreams/00000000-0000-7000-8000-000000000031?substream=2',
    '/projects/launch',
    '/activity',
    '/artifacts',
  ])('opens the Canvases home from the removed route %s', async (route) => {
    window.history.replaceState({}, '', `/#${route}`);
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();
    expect(await screen.findByText('canvases home')).toBeVisible();
    expect(window.location.hash).toBe('#/canvases');
  });

  it('does not poll members while the WorkspaceDO socket owns invalidation', async () => {
    vi.useFakeTimers();
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sessionState.api.getWorkspaceMembers).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
    });
    expect(sessionState.api.getWorkspaceMembers).toHaveBeenCalledTimes(1);
  });

  it('abandons a sidebar opening when an organization error replaces its owning surface', async () => {
    const workstreamId = '00000000-0000-4000-8000-000000000220';
    window.history.replaceState({}, '', `/#/workstreams/${workstreamId}`);
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    const firstAttempt = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 100);
    sessionState.api.getWorkspace.mockRejectedValueOnce(new Error('Regional service unavailable.'));
    renderGate();

    expect(await screen.findByText('Regional service unavailable.')).toBeVisible();
    await vi.waitFor(() => expect(workstreamFeedOpenAttemptId(workstreamId)).toBeUndefined());

    sessionState.api.getWorkspace.mockResolvedValueOnce({
      id: 'workspace-1',
      name: 'Rally Studio',
      region: 'global',
      currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('canvases home')).toBeVisible();

    const retryAttempt = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 60_100);
    expect(retryAttempt).not.toBe(firstAttempt);
  });

  it('says Rally cannot connect without opening a dialog, and plays Pong while it waits', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    sessionState.api.getWorkspace.mockRejectedValueOnce(new ApiError('Rally could not reach the selected regional service.', 0, 'network_error'));
    renderGate();

    expect(await screen.findByRole('heading', { name: 'Rally can’t connect' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();
    expect(screen.queryByText('Rally 0 · Best 0')).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: ' ' });
    expect(screen.getByText('Rally 0 · Best 0')).toBeVisible();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('Rally 0 · Best 0')).not.toBeInTheDocument();
  });

  it('surrenders the active organization credential after a membership revocation', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    sessionState.api.getWorkspace.mockRejectedValueOnce(new ApiError(
      'Organization access is unavailable',
      403,
      'workspace_access_denied',
    ));

    renderGate();

    await vi.waitFor(() => expect(sessionState.surrenderActiveWorkspace).toHaveBeenCalledOnce());
    expect(sessionState.signOut).not.toHaveBeenCalled();
  });

  it('shows authenticated invitations before organization setup', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: null,
      invitations: [{ id: 'invite-1' }],
    });
    renderGate();

    expect(await screen.findByText('invitations 1')).toBeVisible();
    expect(screen.queryByText('organization setup')).not.toBeInTheDocument();
  });

  it('shows organization setup only when no memberships or invitations exist', async () => {
    sessionState.session = identitySession;
    renderGate();

    expect(await screen.findByText('organization setup')).toBeVisible();
  });

  it('automatically activates an existing organization discovered through the one identity service', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: {
        id: 'workspace-enterprise',
        name: 'European Research',
        slug: 'european-research',
        region: 'enterprise',
        role: 'member',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      invitations: [],
    });
    renderGate();

    expect(await screen.findByText('Opening European Research…')).toBeVisible();
    await vi.waitFor(() => expect(sessionState.activateWorkspace).toHaveBeenCalledWith(
      'enterprise',
      'workspace-enterprise',
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      { onSignInRequired: expect.any(Function) },
    ));
  });

  it('says where the person is expected when the startup activation has to sign the account in', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: {
        id: 'workspace-enterprise',
        name: 'European Research',
        slug: 'european-research',
        region: 'enterprise',
        role: 'member',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      invitations: [],
    });
    let rejectActivation: ((error: Error) => void) | null = null;
    sessionState.activateWorkspace.mockImplementation((
      _region: string, _workspaceId: string, _operationId: string, progress: { onSignInRequired: () => void },
    ) => new Promise<void>((_resolve, reject) => {
      rejectActivation = reject;
      progress.onSignInRequired();
    }));
    renderGate();

    expect(await screen.findByText('Finish signing in to Rally in your browser')).toBeVisible();
    expect(screen.queryByText('Opening European Research…')).not.toBeInTheDocument();

    // A sign-in that does not complete lands as the setup failure it is, with its retry.
    act(() => rejectActivation!(new Error('Sign in could not be completed: access denied')));
    expect(await screen.findByText('Sign in could not be completed: access denied')).toBeVisible();
  });

  describe('Escape before a secondary window has a screen', () => {
    const workspaceSession: DesktopSession = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };

    it.each(['settings'] as const)(
      'closes the %s window while the organization profile is still in flight',
      async (surface) => {
        const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
        window.history.replaceState({}, '', `/?surface=${surface}`);
        sessionState.session = workspaceSession;
        sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise(() => {}));
        renderGate();
        expect(screen.getByText('Opening organization…')).toBeVisible();

        fireEvent.keyDown(document.body, { key: 'Escape' });

        expect(close).toHaveBeenCalledOnce();
      },
    );

    it('closes the window from the service-setup error, which is the same dead end', async () => {
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
      window.history.replaceState({}, '', '/?surface=settings');
      sessionState.session = workspaceSession;
      sessionState.api.getWorkspace.mockRejectedValueOnce(new Error('Regional service unavailable.'));
      renderGate();
      expect(await screen.findByText('Regional service unavailable.')).toBeVisible();

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(close).toHaveBeenCalledOnce();
    });

    it('ends a Pong game on Escape before closing the window, and closes it on the next', async () => {
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
      window.history.replaceState({}, '', '/?surface=settings');
      sessionState.session = workspaceSession;
      sessionState.api.getWorkspace.mockRejectedValueOnce(new Error('Regional service unavailable.'));
      renderGate();
      fireEvent.click(await screen.findByRole('button', { name: 'Play Pong while you wait' }));
      expect(screen.getByText('Rally 0 · Best 0')).toBeVisible();

      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByText('Rally 0 · Best 0')).not.toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();

      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(close).toHaveBeenCalledOnce();
    });

    it('hands the keystroke to the screen once the profile lands, rather than answering it twice', async () => {
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
      window.history.replaceState({}, '', '/?surface=settings');
      sessionState.session = workspaceSession;
      renderGate();
      // `WorkspaceSettingsScreen` is mocked here, so it installs nothing. What is
      // being pinned is that this listener stands down: left armed, it would
      // answer a keystroke the real screen refuses over unsaved text in its pane,
      // and no test of the screen could see it because the listener is not there.
      expect(await screen.findByText('settings')).toBeVisible();

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(close).not.toHaveBeenCalled();
    });

    it('leaves the main window alone, where the keystroke would shut the organization', async () => {
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
      sessionState.session = workspaceSession;
      sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise(() => {}));
      renderGate();
      expect(screen.getByText('Opening organization…')).toBeVisible();

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(close).not.toHaveBeenCalled();
    });

    it('leaves a meeting window alone: a recording in progress is not a dead end', async () => {
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
      window.history.replaceState({}, '', '/?surface=meeting');
      sessionState.session = workspaceSession;
      sessionState.api.getWorkspace.mockImplementationOnce(() => new Promise(() => {}));
      renderGate();
      expect(screen.getByText('Opening organization…')).toBeVisible();

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(close).not.toHaveBeenCalled();
    });
  });
});
