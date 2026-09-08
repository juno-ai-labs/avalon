import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../common/desktop';
import { SessionGate } from './App';
import { setCachedWorkstreams } from './lib/workstreams-cache';
import { ApiError } from './lib/api';
import {
  abandonPendingWorkstreamFeedOpen,
  markWorkstreamFeedOpenStarted,
  workstreamFeedOpenAttemptId,
} from './lib/telemetry';

const sessionState = vi.hoisted(() => ({
  api: {
    getWorkspace: vi.fn(),
    getWorkspaceMembers: vi.fn(),
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

vi.mock('./lib/app-session', () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppSession: () => sessionState,
  FINISH_SIGN_IN_IN_BROWSER: 'Finish signing in to Rally in your browser',
}));
vi.mock('./lib/workspace-socket', () => ({
  WorkspaceSocketProvider: ({ children }: { children: React.ReactNode }) => children,
  useWorkspaceSocket: () => ({ state: 'connected', sidebarConnect: null }),
}));
vi.mock('./screens/onboarding', () => ({
  BootScreen: () => <div>boot screen</div>,
  InvitationOnboarding: ({ invitations }: { invitations: unknown[] }) => <div>invitations {invitations.length}</div>,
  RegionOnboarding: () => <div>workspace setup</div>,
  SignInScreen: () => <div>sign in screen</div>,
}));
vi.mock('./components/app-shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('./screens/new-workstream', () => ({ NewWorkstreamScreen: () => <div>main workspace UI</div> }));
vi.mock('./screens/meeting-notes', () => ({ MeetingNotesScreen: () => <div>meeting notes</div> }));
vi.mock('./screens/note-detail', () => ({ NoteDetailScreen: () => <div>note detail</div> }));
vi.mock('./screens/workstream', () => ({ WorkstreamScreen: () => <div>workstream</div> }));
vi.mock('./screens/automation', () => ({ AutomationScreen: () => <div>automation</div> }));
vi.mock('./screens/workspace-settings', () => ({ WorkspaceSettingsScreen: () => <div>settings</div> }));

const identitySession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: 'https://api.rallywith.ai',
  user: { id: 'user-1', email: 'adam@example.com', name: 'Adam' },
  workspace: null,
};

function renderGate(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setCachedWorkstreams(queryClient, []);
  render(<QueryClientProvider client={queryClient}><SessionGate /></QueryClientProvider>);
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
  });

  it('requires sign-in before showing a deep-linked invitation', () => {
    renderGate();
    expect(screen.getByText('sign in screen')).toBeVisible();
    expect(screen.queryByText(/invitations/u)).not.toBeInTheDocument();
  });

  it('opens the main UI immediately when the authenticated session has a workspace', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();

    expect(await screen.findByText('main workspace UI')).toBeVisible();
    expect(sessionState.getOnboardingState).not.toHaveBeenCalled();
  });

  it.each([
    ['/workstreams/new', 'main workspace UI'],
    ['/workstreams/00000000-0000-7000-8000-000000000031', 'workstream'],
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

  it('renders the dedicated meeting surface without the workspace shell', async () => {
    window.history.replaceState({}, '', '/?surface=meeting#/meeting');
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    renderGate();

    expect(await screen.findByText('meeting notes')).toBeVisible();
    expect(screen.queryByText('main workspace UI')).not.toBeInTheDocument();
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

  it('abandons a sidebar opening when a workspace error replaces its owning surface', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(await screen.findByText('workstream')).toBeVisible();

    const retryAttempt = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 60_100);
    expect(retryAttempt).not.toBe(firstAttempt);
  });

  it('surrenders the active workspace credential after a membership revocation', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner' },
    };
    sessionState.api.getWorkspace.mockRejectedValueOnce(new ApiError(
      'Workspace access is unavailable',
      403,
      'workspace_access_denied',
    ));

    renderGate();

    await vi.waitFor(() => expect(sessionState.surrenderActiveWorkspace).toHaveBeenCalledOnce());
    expect(sessionState.signOut).not.toHaveBeenCalled();
  });

  it('shows authenticated invitations before workspace setup', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: null,
      invitations: [{ id: 'invite-1' }],
    });
    renderGate();

    expect(await screen.findByText('invitations 1')).toBeVisible();
    expect(screen.queryByText('workspace setup')).not.toBeInTheDocument();
  });

  it('shows workspace setup only when no memberships or invitations exist', async () => {
    sessionState.session = identitySession;
    renderGate();

    expect(await screen.findByText('workspace setup')).toBeVisible();
  });

  it('automatically activates an existing workspace discovered through the one identity service', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: {
        id: 'workspace-eu',
        name: 'European Research',
        slug: 'european-research',
        region: 'eu',
        role: 'member',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      invitations: [],
    });
    renderGate();

    expect(await screen.findByText('Opening European Research…')).toBeVisible();
    await vi.waitFor(() => expect(sessionState.activateWorkspace).toHaveBeenCalledWith(
      'eu',
      'workspace-eu',
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      { onSignInRequired: expect.any(Function) },
    ));
  });

  it('says where the person is expected when the startup activation has to sign the account in', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({ identity: 'connected',
      workspace: {
        id: 'workspace-eu',
        name: 'European Research',
        slug: 'european-research',
        region: 'eu',
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
});
