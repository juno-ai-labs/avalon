import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../common/desktop';
import { SessionGate } from './App';

const sessionState = vi.hoisted(() => ({
  api: {
    getWorkspace: vi.fn(),
  },
  activateWorkspace: vi.fn(),
  booting: false,
  getOnboardingState: vi.fn(),
  pendingInvitation: { token: 'invite-token-long-enough', region: 'global' },
  region: 'global',
  runtime: null,
  session: null as DesktopSession | null,
  signOut: vi.fn(),
}));

vi.mock('./lib/app-session', () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppSession: () => sessionState,
}));
vi.mock('./screens/onboarding', () => ({
  BootScreen: () => <div>boot screen</div>,
  InvitationOnboarding: ({ invitations }: { invitations: unknown[] }) => <div>invitations {invitations.length}</div>,
  RegionOnboarding: () => <div>workspace setup</div>,
  SignInScreen: () => <div>sign in screen</div>,
}));
vi.mock('./components/app-shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('./screens/new-workstream', () => ({ NewWorkstreamScreen: () => <div>main workspace UI</div> }));
vi.mock('./screens/workstream', () => ({ WorkstreamScreen: () => <div>workstream</div> }));
vi.mock('./screens/new-automation', () => ({ NewAutomationScreen: () => <div>new automation</div> }));
vi.mock('./screens/automation-overview', () => ({ AutomationOverviewScreen: () => <div>automation</div> }));
vi.mock('./screens/workspace-settings', () => ({ WorkspaceSettingsScreen: () => <div>settings</div> }));

const identitySession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: 'https://api.with-avalon.com',
  user: { id: 'user-1', email: 'adam@example.com', name: 'Adam' },
  workspace: null,
};

function renderGate(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><SessionGate /></QueryClientProvider>);
}

describe('SessionGate identity-first ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    sessionState.booting = false;
    sessionState.session = null;
    sessionState.getOnboardingState.mockResolvedValue({ workspace: null, invitations: [] });
    sessionState.activateWorkspace.mockResolvedValue(undefined);
    sessionState.api.getWorkspace.mockResolvedValue({
      id: 'workspace-1',
      name: 'Avalon Studio',
      region: 'global',
      currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' },
    });
  });

  it('requires sign-in before showing a deep-linked invitation', () => {
    renderGate();
    expect(screen.getByText('sign in screen')).toBeVisible();
    expect(screen.queryByText(/invitations/u)).not.toBeInTheDocument();
  });

  it('opens the main UI immediately when the authenticated session has a workspace', async () => {
    sessionState.session = {
      ...identitySession,
      workspace: { id: 'workspace-1', name: 'Avalon Studio', region: 'global', role: 'owner' },
    };
    renderGate();

    expect(await screen.findByText('main workspace UI')).toBeVisible();
    expect(sessionState.getOnboardingState).not.toHaveBeenCalled();
  });

  it('shows authenticated invitations before workspace setup', async () => {
    sessionState.session = identitySession;
    sessionState.getOnboardingState.mockResolvedValue({
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
    sessionState.getOnboardingState.mockResolvedValue({
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
    await vi.waitFor(() => expect(sessionState.activateWorkspace).toHaveBeenCalledWith('eu', 'workspace-eu'));
  });
});
