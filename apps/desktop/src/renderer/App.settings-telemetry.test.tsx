// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../common/desktop';
import type * as TelemetryModule from './lib/telemetry';
import { SessionGate } from './App';

/**
 * The settings surface reports `surface_viewed` for `settings_application`, and
 * a prewarmed window mounts that surface long before anybody looks at it. These
 * tests cover the consequence rather than the wiring: the report has to wait for
 * main to say the window is on screen, because the renderer cannot tell — a
 * `show: false` window reported `document.visibilityState === 'visible'` under
 * Xvfb, so that signal is not usable for this.
 */
const revealListeners = vi.hoisted(() => new Set<() => void>());
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
const reportTelemetryScreen = vi.hoisted(() => vi.fn());

// Only the reveal channel matters here; everything else the tree happens to
// reach becomes an inert no-op rather than a list to keep in step by hand.
vi.mock('./lib/platform', () => ({
  desktopBridge: () => new Proxy({
    onSettingsWindowRevealed: (listener: () => void) => {
      revealListeners.add(listener);
      return () => revealListeners.delete(listener);
    },
  } as Record<string, unknown>, {
    // The bridge's own convention decides the inert shape: `onX` is a
    // subscription and answers with an unsubscribe, everything else is invoked
    // and awaited.
    get: (target, property) => target[property as string]
      ?? (typeof property === 'string' && property.startsWith('on')
        ? () => () => undefined
        : () => Promise.resolve(undefined)),
  }),
  desktopServicesAvailable: () => false,
}));

vi.mock('./lib/telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof TelemetryModule>(),
  reportTelemetryProductIntent,
  reportTelemetryScreen,
}));

const sessionState = vi.hoisted(() => ({
  api: {
    getWorkspace: vi.fn(),
    getWorkspaceMembers: vi.fn(),
    getWorkspaceSocketTicket: vi.fn(),
  },
  activateWorkspace: vi.fn(),
  booting: false,
  getOnboardingState: vi.fn(),
  pendingInvitation: null,
  region: 'global',
  runtime: null,
  session: null as DesktopSession | null,
  signOut: vi.fn(),
  signOutIfCredentialCleared: vi.fn(),
  surrenderActiveWorkspace: vi.fn(),
}));

vi.mock('./lib/collaboration-session', () => ({ useCollaborationSession: () => sessionState }));
vi.mock('./lib/app-session', () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppSession: () => sessionState,
  FINISH_SIGN_IN_IN_BROWSER: 'Finish signing in to Rally in your browser',
}));
vi.mock('./screens/onboarding', () => ({
  BootScreen: () => <div>boot screen</div>,
  InvitationOnboarding: () => <div>invitations</div>,
  RegionOnboarding: () => <div>workspace setup</div>,
  SignInScreen: () => <div>sign in screen</div>,
}));
vi.mock('./screens/guided-onboarding', () => ({
  AccountOnboardingGate: ({ children }: { children: React.ReactNode }) => children,
  WorkspaceOnboardingJourney: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./screens/workspace-settings', () => ({ WorkspaceSettingsScreen: () => <div>settings</div> }));

const session: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: 'https://api.rallywith.ai',
  user: { id: 'user-1', email: 'adam@example.com', name: 'Adam', timezone: 'America/Los_Angeles' },
  workspace: {
    id: 'workspace-1', name: 'Rally Studio', region: 'global', role: 'owner', timezone: 'Europe/London',
  },
};

function renderSettingsSurface(): void {
  window.history.replaceState({}, '', '/?surface=settings#/settings');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SessionGate /></QueryClientProvider>);
}

function revealWindow(): void {
  act(() => {
    for (const listener of [...revealListeners]) listener();
  });
}

describe('settings surface telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revealListeners.clear();
    sessionState.session = session;
    sessionState.api.getWorkspace.mockResolvedValue({
      id: 'workspace-1',
      name: 'Rally Studio',
      region: 'global',
      timezone: 'Europe/London',
      currentUser: { id: 'user-1', email: 'adam@example.com', name: 'Adam', role: 'owner' },
    });
    sessionState.api.getWorkspaceMembers.mockResolvedValue([]);
    sessionState.api.getWorkspaceSocketTicket.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('reports nothing while the window is only prewarmed', async () => {
    renderSettingsSurface();

    expect(await screen.findByText('settings')).toBeVisible();
    // Mounted, rendered, and nobody has seen it. Reporting here would spend the
    // pending entrypoint on nobody and latch the surface, so the real open
    // would then report nothing at all.
    expect(reportTelemetryProductIntent).not.toHaveBeenCalled();
    expect(reportTelemetryScreen).not.toHaveBeenCalled();
  });

  it('reports the surface once the window is put on screen', async () => {
    renderSettingsSurface();
    await screen.findByText('settings');

    revealWindow();

    expect(reportTelemetryProductIntent).toHaveBeenCalledTimes(1);
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'surface_viewed', surface: 'settings_application' }),
    );
  });

  it('does not report again if main announces a reveal twice', async () => {
    renderSettingsSurface();
    await screen.findByText('settings');

    revealWindow();
    revealWindow();

    expect(reportTelemetryProductIntent).toHaveBeenCalledTimes(1);
  });
});
