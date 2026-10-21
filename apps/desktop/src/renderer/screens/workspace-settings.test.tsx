import "../../../../../tests/isolated-region";
import { AccountOnboardingGate } from './guided-onboarding';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ClientFeatureFlagsSchema, DEFAULT_MEMBER_PREFERENCES,
  DEFAULT_NOTIFICATION_CHANNELS, type MemoryReview, type MemoryReviewFact } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useState } from 'react';
import { coreSettingsProvider } from '../settings/registry';
import type { PendingConnectorOAuth } from '../lib/app-session';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { ApiError } from '../lib/api';
import type { Workspace, WorkspaceInvitation } from '../lib/types';
import { WorkspaceSettingsScreen } from './workspace-settings';
import { CollaborationSessionProvider } from '../lib/collaboration-session';

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getSupportAccess: vi.fn(),
  promoteWorkspaceGuest: vi.fn(),
  getConnections: vi.fn(),
  getGitHubRepositoryAccessSettings: vi.fn(),
  updateGitHubRepositoryAccessSettings: vi.fn(),
  getAvailableConnectorTypes: vi.fn(),
  createGranolaWorkspaceConnection: vi.fn(),
  connectorInstallation: vi.fn(),
  createWebhookConnection: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  createXConnection: vi.fn(),
  createCustomMcpConnection: vi.fn(),
  startCustomMcpConnection: vi.fn(),
  getCustomMcpSettings: vi.fn(),
  updateCustomMcpToolPolicy: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  startProviderConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  setWorkspaceMemberRole: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  getTerminalWorkspaceSettings: vi.fn(),
  previewTerminalNetworkPolicy: vi.fn(),
  applyTerminalNetworkPolicy: vi.fn(),
  getDigestSchedule: vi.fn(),
  updateDigestSchedule: vi.fn(),
  clientFeatureFlags: vi.fn(),
  getMyPersonalSystemPrompt: vi.fn(),
  updateMyPersonalSystemPrompt: vi.fn(),
  getMyPreferences: vi.fn(),
  updateMyPreferences: vi.fn(),
  getMyMemory: vi.fn<(signal?: AbortSignal) => Promise<MemoryReview>>(async () => ({ facts: [] })),
  forgetMyMemory: vi.fn(async (factId: string) => ({ factId, retractedAt: '2026-10-19T12:00:00.000Z' })),
  getOrganizationMemory: vi.fn<(signal?: AbortSignal) => Promise<MemoryReview>>(async () => ({ facts: [] })),
  forgetOrganizationMemory: vi.fn(async (factId: string) => ({ factId, retractedAt: '2026-10-19T12:00:00.000Z' })),
}));
const copyText = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
const getApplicationIcon = vi.hoisted(() => vi.fn());
const setApplicationIcon = vi.hoisted(() => vi.fn());
const resetApplicationIcon = vi.hoisted(() => vi.fn());
const openNotificationSettings = vi.hoisted(() => vi.fn(async () => undefined));
const getApplicationSettings = vi.hoisted(() => vi.fn());
const setLockdownMode = vi.hoisted(() => vi.fn());
const setDebugEnabled = vi.hoisted(() => vi.fn());
const setMenuBarEnabled = vi.hoisted(() => vi.fn());
const setLaunchAtLogin = vi.hoisted(() => vi.fn());
const setProductAnalyticsEnabled = vi.hoisted(() => vi.fn());
const setReleaseChannel = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const leaveWorkspace = vi.hoisted(() => vi.fn());
const applicationSettingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());
const sessionHost = vi.hoisted(() => ({ current: 'desktop' as 'desktop' | 'browser' }));
const getAccountOnboarding = vi.hoisted(() => async () => ({ eligible: false, introduced: true, revision: 1, presentation: null }));
const settingsSectionRequest = vi.hoisted(() => ({
  listener: null as ((section: string) => void) | null,
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => {
    const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
    return {
      host: sessionHost.current,
      api,
      getAccountOnboarding,
      runtime: {
        appVersion: '0.1.0',
        isPackaged: false,
        platform: 'darwin',
        api: { global: 'https://api.rallywith.ai', enterprise: 'https://enterprise.api.rallywith.ai' },
        devAuthEnabled: true,
      },
      session: { apiBaseUrl: 'https://enterprise.api.rallywith.ai', user: { id: 'user-1', name: 'Adam', email: 'adam@example.com' },
        ...(sessionHost.current === 'browser' ? { authentication: 'cookie' } : {}) },
      leaveWorkspace,
      signOut,
      pendingConnectorOAuth,
      setPendingConnectorOAuth,
    };
  },
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    getAccountOnboarding: async () => ({ eligible: false, introduced: true, revision: 1, presentation: null }),
    copyText,
    getApplicationSettings,
    setLockdownMode,
    setDebugEnabled,
    setMenuBarEnabled,
    setLaunchAtLogin,
    setProductAnalyticsEnabled,
    setReleaseChannel,
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettingsListeners.add(listener);
      return () => applicationSettingsListeners.delete(listener);
    },
    getApplicationIcon,
    setApplicationIcon,
    resetApplicationIcon,
    openNotificationSettings,
    onApplicationIconChanged: () => () => undefined,
    openExternal,
    onSettingsSectionRequested: (listener: (section: string) => void) => {
      settingsSectionRequest.listener = listener;
      return () => {
        if (settingsSectionRequest.listener === listener) settingsSectionRequest.listener = null;
      };
    },
  }),
  desktopServicesAvailable: () => false,
}));

const owner = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles', role: 'owner' };
const member = { id: 'user-2', name: 'Sam', email: 'sam@example.com', timezone: 'America/Los_Angeles', role: 'member' };
/** An administrator who is not the owner — the standing this change makes reachable. */
const secondAdmin = { id: 'user-3', name: 'Riley', email: 'riley@example.com', timezone: 'America/Los_Angeles', role: 'admin' };
/** Shares a display name with `member`, which is why the accessible name carries the email. */
const namesake = { id: 'user-4', name: 'Sam', email: 'sam.reed@example.com', timezone: 'America/Los_Angeles', role: 'member' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Rally Studio',
  region: 'enterprise',
  timezone: 'Europe/London',
  currentUser: owner,
};
const invitation: WorkspaceInvitation = {
  id: '00000000-0000-7000-8000-000000000009',
  email: 'invitee@example.com',
  role: 'member',
  status: 'pending',
  invitedByName: 'Adam',
  expiresAt: '2026-08-08T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};
const inviteUrl = 'https://rallywith.ai/invite/#region=enterprise&token=private-token-value-long-enough';

function rememberedFact(factId: string, text: string, subjectKind: 'person' | 'organization', removable: boolean): MemoryReviewFact {
  return {
    factId, subjectKind, subjectTitle: null, kind: 'standing', text,
    validFrom: null, validUntil: null, recordedAt: '2026-10-01T12:00:00.000Z', conflict: false, derivedFrom: 'person',
    source: { kind: 'thread', workstreamId: 'plan', title: 'Q4 plan' }, removable,
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function renderSettings(
  nextWorkspace: Workspace = workspace,
  client = createTestQueryClient(),
  standaloneWindow = false,
): void {
  client.setQueryData(['account-onboarding', 'adam@example.com'], { eligible: false, introduced: true, revision: 1, presentation: null });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={client}>
        <CollaborationSessionProvider api={api as never} host={sessionHost.current} session={null}>
          <AccountOnboardingGate><WorkspaceSettingsScreen standaloneWindow={standaloneWindow} workspace={nextWorkspace} /></AccountOnboardingGate>
        </CollaborationSessionProvider>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

/** Push a cached entry back in time, so an observer's `staleTime` has passed. */
function ageCacheEntry(client: QueryClient, queryKey: readonly unknown[], byMs: number): void {
  const entry = client.getQueryCache().find({ queryKey });
  if (!entry) throw new Error(`no cache entry for ${JSON.stringify(queryKey)}`);
  entry.state.dataUpdatedAt -= byMs;
}

/**
 * What a window being shown looks like to React Query's focus manager.
 *
 * Dispatched on `window`, which is where the manager listens (`focusManager`
 * in `@tanstack/query-core`): the specification fires `visibilitychange` at the
 * document and lets it bubble, and a non-bubbling event on the document here
 * would reach no listener and quietly prove nothing.
 */
function revealWindow(): void {
  window.dispatchEvent(new Event('visibilitychange'));
}

/** Opens a connection's own page from its row on Connections, where its actions are. */
async function openConnection(name: string): Promise<void> {
  fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name }));
  await screen.findByRole('heading', { level: 1, name });
}

function openSettingsSection(
  name: 'Account' | 'Notifications' | 'Organization' | 'Security' | 'Connections' | 'Application',
): void {
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}

/** Radix opens a dropdown on pointer down, not click. */
async function openMemberActions(name: string): Promise<void> {
  fireEvent.pointerDown(await screen.findByRole('button', { name }), { button: 0, ctrlKey: false });
}

/**
 * The live connect action inside a connector card, once it is actually clickable.
 *
 * **Every test that expects a connect action to do something must go through
 * here.** `ConnectorButton` renders two different trigger elements: while the
 * connector catalog and the connection list are loading it wraps the button in a
 * disabled `<span role="button" aria-disabled="true">` and hides the native
 * button from the accessibility tree, and once those land it renders the button
 * itself. The card appears as soon as the provider's name does, which is before
 * either query resolves.
 *
 * `toBeEnabled()` cannot see the difference. jest-dom deliberately ignores
 * `aria-disabled`, and a `<span>` is not a form control, so a wait on it passes
 * on the first tick against the span — and the test then focuses or clicks a
 * span, which is a silent no-op. That is why the failures never mention the
 * span: a click reports `Number of calls: 0` and a focus reports no tooltip,
 * both only on a machine loaded enough for the queries to land late.
 *
 * Requiring the tag is what actually observes the swap, and returning from
 * inside the `waitFor` is what hands back an element still in the document
 * rather than the detached span. This was found and fixed twice inline before it
 * was made shared; a third copy should be a call to this instead.
 */
async function enabledConnectAction(card: HTMLElement, name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const button = within(card).getByRole('button', { name });
    expect(button.tagName).toBe('BUTTON');
    return button;
  });
}

function announceApplicationSettings(settings: DesktopApplicationSettings): void {
  act(() => {
    for (const listener of applicationSettingsListeners) listener(settings);
  });
}

function applicationSettings(
  overrides: Partial<DesktopApplicationSettings> = {},
): DesktopApplicationSettings {
  return {
    releaseChannel: 'stable',
    releaseChannelAvailable: true,
    lockdownMode: false,
    lockdownAvailable: true,
    debugEnabled: false,
    developerSettingsAvailable: true,
    pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
    menuBarAvailable: true,
    menuBarPresent: true,
    launchAtLogin: true,
    launchAtLoginAvailable: true,
    productAnalyticsEnabled: true,
    productAnalyticsEffective: true,
    productAnalyticsPreferencePending: false,
    nativeCrashRestartRequired: false,
    ...overrides,
  };
}

describe('Organization settings', () => {
  beforeEach(() => {
    sessionHost.current = 'desktop';
    vi.clearAllMocks();
    // `clearAllMocks` wipes recorded calls but leaves a queued
    // `mockResolvedValueOnce` in place, and a queued value outranks the
    // persistent one the next test sets. Two tests below queue `once` attempts
    // for this mock and drain them by letting the component poll — a count that
    // depends on how many times an effect re-runs, which no test controls. An
    // undrained value is then served to whichever test runs next, so the test
    // that sets up a `pending` attempt sees a settled one instead and never
    // renders `Waiting…`. Resetting this one mock drains its queue; the others
    // keep `clearAllMocks` semantics, which the second suite in this file
    // depends on.
    api.getConnectorOAuthAttempt.mockReset();
    applicationSettingsListeners.clear();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    window.history.replaceState({}, '', '/');
    settingsSectionRequest.listener = null;
    api.getWorkspaceMembers.mockResolvedValue([owner, member]);
    api.getSupportAccess.mockResolvedValue({ available: true, expiresAt: null });
    api.getWorkspaceInvitations.mockResolvedValue([invitation]);
    api.getConnections.mockResolvedValue([]);
    api.getMyPersonalSystemPrompt.mockResolvedValue('');
    api.getMyPreferences.mockResolvedValue(DEFAULT_MEMBER_PREFERENCES);
    api.getMyMemory.mockResolvedValue({ facts: [] });
    api.getOrganizationMemory.mockResolvedValue({ facts: [] });
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({}));
    api.getGitHubRepositoryAccessSettings.mockResolvedValue({
      connectionId: '00000000-0000-7000-8000-000000000020',
      connectionName: 'GitHub · Rally',
      revision: 3,
      mode: 'all_repositories',
      defaultRemoteAccess: 'full_access',
      repositories: [],
      availableRepositories: [
        {
          repositoryId: '101',
          repositoryFullName: 'juno-ai-labs/rally',
          private: true,
          remoteAccess: 'full_access',
        },
        {
          repositoryId: '102',
          repositoryFullName: 'juno-ai-labs/docs',
          private: false,
          remoteAccess: 'full_access',
        },
      ],
    });
    api.updateGitHubRepositoryAccessSettings.mockImplementation(async (_connectionId: string, input: {
      expectedRevision: number;
      mode: 'all_repositories' | 'selected_repositories';
      defaultRemoteAccess: 'read_only' | 'full_access';
      repositories: Array<{ repositoryId: string; repositoryFullName: string; remoteAccess: 'read_only' | 'full_access' }>;
    }) => ({
      connectionId: '00000000-0000-7000-8000-000000000020',
      connectionName: 'GitHub · Rally',
      revision: input.expectedRevision + 1,
      mode: input.mode,
      defaultRemoteAccess: input.defaultRemoteAccess,
      repositories: input.repositories,
      availableRepositories: [
        {
          repositoryId: '101', repositoryFullName: 'juno-ai-labs/rally', private: true,
          remoteAccess: input.repositories.find((entry) => entry.repositoryId === '101')?.remoteAccess
            ?? (input.mode === 'all_repositories' ? input.defaultRemoteAccess : null),
        },
        {
          repositoryId: '102', repositoryFullName: 'juno-ai-labs/docs', private: false,
          remoteAccess: input.repositories.find((entry) => entry.repositoryId === '102')?.remoteAccess
            ?? (input.mode === 'all_repositories' ? input.defaultRemoteAccess : null),
        },
      ],
    }));
    api.getAvailableConnectorTypes.mockResolvedValue([
      'custom_mcp', 'generic_webhook', 'github', 'google', 'granola', 'linear', 'notion', 'slack', 'x',
    ]);
    api.createGranolaWorkspaceConnection.mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000018',
      connectorType: 'granola',
      scope: 'workspace',
      displayName: 'Granola organization',
      capabilities: ['granola.workspace.read'],
      status: 'healthy',
    });
    api.createWebhookConnection.mockResolvedValue({
      connection: {
        id: '00000000-0000-7000-8000-000000000019',
        connectorType: 'generic_webhook',
        scope: 'you',
        displayName: 'Inbound webhook',
        capabilities: [],
        status: 'healthy',
      },
      endpoint: 'https://enterprise.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000019',
      signingSecret: 'whsec_one-time-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    });
    api.rotateWebhookSecret.mockResolvedValue({
      endpoint: 'https://enterprise.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
      signingSecret: 'whsec_rotated-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    });
    api.disconnectConnection.mockResolvedValue(undefined);
    api.startProviderConnection.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'a'.repeat(43),
    });
    api.reconnectConnection.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'b'.repeat(43),
    });
    api.getConnectorOAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'succeeded',
      connectionId: '00000000-0000-7000-8000-000000000004',
      errorCode: null,
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    api.createWorkspaceInvitation.mockResolvedValue({ invitation, inviteUrl, emailDelivery: 'sent' });
    api.revokeWorkspaceInvitation.mockResolvedValue(undefined);
    leaveWorkspace.mockResolvedValue({ outcome: 'left' });
    api.getTerminalWorkspaceSettings.mockResolvedValue({
      availability: 'supported', mode: 'trusted_only', revision: 1, verificationState: 'verified',
      customDomains: [], remainingCustomSlots: 7, failureCode: null,
    });
    api.previewTerminalNetworkPolicy.mockResolvedValue({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1,
      proposedMode: 'full_internet', customDomains: [], remainingCustomSlots: 7,
    });
    api.applyTerminalNetworkPolicy.mockResolvedValue({
      availability: 'supported', mode: 'full_internet', revision: 2, verificationState: 'verified',
      customDomains: [], remainingCustomSlots: 7, failureCode: null,
    });
    copyText.mockResolvedValue(undefined);
    openExternal.mockResolvedValue(undefined);
    getApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
    getApplicationSettings.mockResolvedValue(applicationSettings());
    setLockdownMode.mockImplementation(async (lockdownMode: boolean) => applicationSettings({ lockdownMode }));
    setDebugEnabled.mockImplementation(async (debugEnabled: boolean) => applicationSettings({ debugEnabled }));
    setMenuBarEnabled.mockImplementation(async (menuBarEnabled: boolean) => applicationSettings({ menuBarEnabled }));
    setLaunchAtLogin.mockImplementation(async (launchAtLogin: boolean) => applicationSettings({ launchAtLogin }));
    setProductAnalyticsEnabled.mockImplementation(async (productAnalyticsEnabled: boolean) => applicationSettings({
      productAnalyticsEnabled,
      productAnalyticsEffective: productAnalyticsEnabled,
      nativeCrashRestartRequired: !productAnalyticsEnabled,
    }));
    setReleaseChannel.mockImplementation(async (releaseChannel: 'stable' | 'faster') => applicationSettings({ releaseChannel }));
    setApplicationIcon.mockImplementation(async (activeIcon: string) => ({
      activeIcon,
      isAutomatic: false,
      supported: true,
    }));
    resetApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
  });

  it('promotes a guest from the current membership revision and refreshes the roster', async () => {
    const guest = { ...member, name: 'Guest Sam', accessClass: 'guest' as const, role: null, incarnation: 'membership', revision: 3 };
    api.getWorkspaceMembers.mockResolvedValue([owner, guest]);
    api.promoteWorkspaceGuest.mockImplementationOnce(async () => {
      api.getWorkspaceMembers.mockResolvedValue([owner, { ...guest, accessClass: 'member', role: 'member', revision: 4 }]);
      return {};
    });
    renderSettings();
    openSettingsSection('Organization');
    await openMemberActions(`Guest Sam (${guest.email}) member actions`);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make member' }));
    expect(api.promoteWorkspaceGuest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));
    await waitFor(() => expect(api.promoteWorkspaceGuest).toHaveBeenCalledWith(guest.id, { incarnation: 'membership', expectedRevision: 3 }));
    await waitFor(() => expect(screen.getByText('Guest Sam').closest('.settings-member-row')).toHaveTextContent('member'));
    expect(screen.getByText('Guest Sam')).toBeVisible();
  });

  it('opens the phone sections sheet by default and shuts it when a section is picked', async () => {
    renderSettings();
    const toggle = await screen.findByRole('button', { name: 'Close settings sections' });
    const sheet = screen.getByRole('navigation', { name: 'Settings sections' }).closest('aside');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(sheet).toHaveClass('is-mobile-open');

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Organization' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
    expect(sheet).not.toHaveClass('is-mobile-open');
    expect(screen.getByRole('button', { name: 'Open settings sections' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Open settings sections' }));
    expect(sheet).toHaveClass('is-mobile-open');
  });

  it('makes the page inert under the open phone sheet and shuts it on Escape', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 640px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    renderSettings();
    const toggle = await screen.findByRole('button', { name: 'Close settings sections' });
    const page = screen.getByRole('main').querySelector('.settings-content-scroll');
    expect(page).toHaveAttribute('inert');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(page).not.toHaveAttribute('inert');
  });

  it('leaves the page live beside the sections list when wider than a phone', async () => {
    renderSettings();
    await screen.findByRole('button', { name: 'Close settings sections' });
    expect(screen.getByRole('main').querySelector('.settings-content-scroll')).not.toHaveAttribute('inert');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Close settings sections' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the phone sections sheet shut when a link names the section', async () => {
    window.location.hash = '#/settings?section=workspace';
    try {
      renderSettings();
      expect(await screen.findByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Open settings sections' })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      window.location.hash = '';
    }
  });

  it('keeps a guest on their own sections even when a link names a member\'s', async () => {
    const guestSession = { apiBaseUrl: 'https://enterprise.api.rallywith.ai', expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'user-1', name: 'Adam', email: 'adam@example.com' },
      workspace: { id: 'workspace-1', name: 'Rally Studio', region: 'enterprise', role: null, timezone: 'Europe/London', accessClass: 'guest' as const } };
    window.location.hash = '#/settings?section=internet-access';
    const client = createTestQueryClient();
    client.setQueryData(['account-onboarding', 'adam@example.com'], { eligible: false, introduced: true, revision: 1, presentation: null });
    try {
      render(
        <Tooltip.Provider>
          <QueryClientProvider client={client}>
            <CollaborationSessionProvider api={api as never} session={guestSession}>
              <WorkspaceSettingsScreen workspace={workspace} />
            </CollaborationSessionProvider>
          </QueryClientProvider>
        </Tooltip.Provider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
      const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
      expect(within(navigation).getAllByRole('button').map((button) => button.textContent)).toEqual(['Account', 'Application']);
      expect(api.getTerminalWorkspaceSettings).not.toHaveBeenCalled();
    } finally {
      window.location.hash = '';
    }
  });

  it('paints the agent-work switch from what this device last saw while the server read is pending', async () => {
    window.localStorage.setItem(`rally:member-preferences:${workspace.id}`, JSON.stringify({ showAgentWork: false }));
    api.getMyPreferences.mockReturnValue(new Promise(() => {}));
    try {
      renderSettings();
      openSettingsSection('Account');
      expect(await screen.findByRole('switch', { name: /Show agent work/u })).not.toBeChecked();
    } finally {
      window.localStorage.removeItem(`rally:member-preferences:${workspace.id}`);
    }
  });

  it('saves the agent-work switch to the server', async () => {
    api.getMyPreferences.mockResolvedValue(DEFAULT_MEMBER_PREFERENCES);
    api.updateMyPreferences.mockImplementation(async () => ({ ...DEFAULT_MEMBER_PREFERENCES, showAgentWork: false }));
    renderSettings();
    openSettingsSection('Account');

    const toggle = await screen.findByRole('switch', { name: /Show agent work/u });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalledWith({ showAgentWork: false }));
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('saves one kind\'s channels for every device and leaves the other kinds alone', async () => {
    api.getDigestSchedule.mockResolvedValue({
      id: 'digest', enabled: true, days: [1], times: [540], timezone: 'Europe/London',
      deliveryTargets: [], nextRunAt: null, lastDeliveredAt: null,
    });
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    api.getMyPreferences.mockResolvedValue(DEFAULT_MEMBER_PREFERENCES);
    api.updateMyPreferences.mockImplementation(async () => ({ ...DEFAULT_MEMBER_PREFERENCES,
      notify: { ...DEFAULT_NOTIFICATION_CHANNELS, newThreads: ['push', 'email'] } }));
    renderSettings();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .findByRole('button', { name: 'Notifications' }));

    // jsdom lays nothing out, so the row has no room for a button each and offers its menu.
    const menu = await screen.findByRole('button', { name: 'How to tell you about new threads' });
    expect(menu).toHaveTextContent('Push');
    fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^Email/u }));

    // Only the kind that changed, whole: a stale copy of the others must not be written back.
    await waitFor(() => expect(api.updateMyPreferences).toHaveBeenCalledWith({ notify: { newThreads: ['push', 'email'] } }));
    await waitFor(() => expect(menu).toHaveTextContent('Push and Email'));
  });

  it('keeps Slack on screen for a person whose Slack account is not linked, so they can turn it off', async () => {
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    api.getMyPreferences.mockResolvedValue(DEFAULT_MEMBER_PREFERENCES);
    // The workspace has Slack, but this person has not linked to it, so no connection offers it.
    api.getConnections.mockResolvedValue([{ id: 'slack-one', connectorType: 'slack', scope: 'workspace',
      displayName: 'Juno Labs', capabilities: [], status: 'healthy', settingsKind: null }]);
    renderSettings();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .findByRole('button', { name: 'Notifications' }));

    const menu = await screen.findByRole('button', { name: 'How to tell you about mentions' });
    await waitFor(() => expect(menu).toHaveTextContent('Push and Slack'));
  });

  it('saves an edited personal system prompt and offers Save only while it differs', async () => {
    api.getMyPersonalSystemPrompt.mockResolvedValue('Answer briefly.');
    api.updateMyPersonalSystemPrompt.mockImplementation(async (text: string) => text);
    renderSettings();
    openSettingsSection('Account');

    const prompt = await screen.findByRole('textbox', { name: 'Personal system prompt' });
    await waitFor(() => expect(prompt).toHaveValue('Answer briefly.'));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(prompt, { target: { value: 'Answer in French.' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.updateMyPersonalSystemPrompt).toHaveBeenCalledWith('Answer in French.'));
    await waitFor(() => expect(save).toBeDisabled());
    expect(prompt).toHaveValue('Answer in French.');
  });

  it('lists what Rally remembers about the person under Account, and removes one', async () => {
    api.getMyMemory.mockResolvedValue({ facts: [
      rememberedFact('own-1', 'Prefers short answers.', 'person', true),
      rememberedFact('own-2', 'Works in Go.', 'person', true),
    ] });
    renderSettings();
    openSettingsSection('Account');

    const list = await screen.findByRole('region', { name: 'What Rally remembers about you' });
    expect(await within(list).findByText('Prefers short answers.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What Rally remembers about you' })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “Prefers short answers.”' }));

    await waitFor(() => expect(within(list).queryByText('Prefers short answers.')).toBeNull());
    expect(api.forgetMyMemory).toHaveBeenCalledWith('own-1');
    expect(within(list).getByText('Works in Go.')).toBeInTheDocument();
    expect(api.getOrganizationMemory).not.toHaveBeenCalled();
  });

  it('says so under Account when Rally has remembered nothing about the person', async () => {
    renderSettings();
    openSettingsSection('Account');

    expect(await screen.findByText('Rally has not remembered anything about you yet.')).toBeInTheDocument();
  });

  it('lists the Organization’s facts under Organization, with Remove for an administrator', async () => {
    // The server marks the Organization's facts removable for an administrator only.
    api.getOrganizationMemory.mockResolvedValue({ facts: [rememberedFact('org-1', 'The fiscal year starts in February.', 'organization', true)] });
    renderSettings();
    openSettingsSection('Organization');

    const list = await screen.findByRole('region', { name: 'What Rally remembers about the Organization' });
    expect(await within(list).findByText('The fiscal year starts in February.')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “The fiscal year starts in February.”' }));
    await waitFor(() => expect(within(list).queryByText('The fiscal year starts in February.')).toBeNull());
    expect(api.forgetOrganizationMemory).toHaveBeenCalledWith('org-1');
  });

  it('lists the Organization’s facts to a member without Remove', async () => {
    api.getOrganizationMemory.mockResolvedValue({ facts: [rememberedFact('org-1', 'The fiscal year starts in February.', 'organization', false)] });
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Organization');

    const list = await screen.findByRole('region', { name: 'What Rally remembers about the Organization' });
    expect(await within(list).findByText('The fiscal year starts in February.')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^Remove/u })).toBeNull();
  });

  it('opens on the member list the application already holds', async () => {
    const client = createTestQueryClient();
    // What the boot around this screen leaves behind: `App.tsx` reads the roster
    // for the shell and holds it at `staleTime: Infinity`, so by the time
    // Settings mounts the list is already there and seconds old at most.
    client.setQueryData(['workspace-members'], [owner, member]);
    renderSettings(workspace, client);

    await waitFor(() => expect(api.getConnections).toHaveBeenCalled());
    expect(api.getWorkspaceMembers).not.toHaveBeenCalled();
    expect(await screen.findByText('adam@example.com')).toBeVisible();
  });

  it('does not read connections twice when the window is revealed right after mounting', async () => {
    renderSettings();
    await waitFor(() => expect(api.getConnections).toHaveBeenCalledTimes(1));

    // What showing a window raises — a prewarmed one at its reveal, and a cold
    // one moments after its own first read.
    act(() => revealWindow());

    await waitFor(() => expect(api.getWorkspaceInvitations).toHaveBeenCalled());
    expect(api.getConnections).toHaveBeenCalledTimes(1);
  });

  it('reads connections again when the window is revealed after a trip out to a provider', async () => {
    const client = createTestQueryClient();
    renderSettings(workspace, client);
    // Waited on the landed answer, not the call: a read that has started has no
    // `dataUpdatedAt` to age yet, and would overwrite one on the way in.
    await waitFor(() => expect(client.getQueryState(['connections'])?.dataUpdatedAt).toBeGreaterThan(0));
    expect(api.getConnections).toHaveBeenCalledTimes(1);

    // Authorizing a connector happens in a browser, and coming back here is the
    // moment the answer exists. Aged rather than timer-driven: the subject is
    // the staleness the reveal is measured against, not a schedule.
    ageCacheEntry(client, ['connections'], 30_000);
    act(() => revealWindow());

    await waitFor(() => expect(api.getConnections).toHaveBeenCalledTimes(2));
  });

  it('indexes provider actions only for their available scopes and preserves IME Escape', async () => {
    renderSettings();
    await screen.findByRole('navigation', { name: 'Settings sections' });
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'Connect for organization' } });
    expect(document.querySelector('[data-setting-result="provider:google-mail-calendar"]')).toBeNull();
    fireEvent.change(search, { target: { value: 'Connect for me' } });
    expect(document.querySelector('[data-setting-result="provider:x"]')).toBeNull();
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
    expect(search).toHaveValue('Connect for me');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
  });

  it.each(coreSettingsProvider.entries)('reveals registered setting $key without executing it', async ({ definition }) => {
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    api.getConnections.mockResolvedValue([
      { id: 'github-one', connectorType: 'github', scope: 'workspace', displayName: 'GitHub One',
        capabilities: [], status: 'healthy', settingsKind: 'github_repository_access' },
      { id: 'mcp-one', connectorType: 'custom_mcp', scope: 'workspace', displayName: 'MCP One',
        capabilities: [], status: 'healthy', settingsKind: 'custom_mcp_tools' },
    ]);
    api.getCustomMcpSettings.mockResolvedValue({
      connectionId: 'mcp-one', connectionName: 'MCP One', scope: 'workspace',
      serverUrl: 'https://mcp.example.test', authMode: 'oauth', toolPolicy: 'all_tools',
      toolPolicyEditable: true, tools: [], toolsUnavailable: null,
    });
    api.getDigestSchedule.mockResolvedValue({
      id: 'digest', enabled: true, days: [1], times: [540], timezone: 'Europe/London',
      deliveryTargets: [{ type: 'email', connectionId: null, displayName: 'Adam', status: 'active', lastDeliveredAt: null }],
      nextRunAt: null, lastDeliveredAt: null,
    });
    if (definition.availability === 'browser') sessionHost.current = 'browser';
    renderSettings();
    // Wait for the shared availability and connection metadata, not for the destination pane.
    await screen.findByRole('button', { name: 'GitHub One' });
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: definition.label } });
    const results = screen.getByRole('navigation', { name: 'Settings search results' });
    const result = within(results).getAllByRole('button').find((button) =>
      button.dataset.settingResult === definition.id
        || button.dataset.settingResult?.startsWith(definition.id + ':'));
    expect(result, definition.id).toBeDefined();
    fireEvent.click(result!);
    if (definition.id === 'inviteSend') {
      await waitFor(() => expect(document.querySelector(`[data-setting-id="${definition.id}"]`)).toHaveClass('settings-search-highlight'));
      expect(document.activeElement?.closest('button[type="submit"]')).toBeNull();
    } else {
      await waitFor(() => expect(document.activeElement).toHaveAttribute('data-setting-id', definition.entryPoint ?? definition.id));
    }
    expect(signOut).not.toHaveBeenCalled();
    expect(leaveWorkspace).not.toHaveBeenCalled();
    expect(api.createWorkspaceInvitation).not.toHaveBeenCalled();
    expect(api.startProviderConnection).not.toHaveBeenCalled();
    expect(api.applyTerminalNetworkPolicy).not.toHaveBeenCalled();
    expect(api.rotateWebhookSecret).not.toHaveBeenCalled();
  });

  it('keeps the network policy on its own top-level Security page', async () => {
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const securityNavigation = within(navigation).getByRole('button', { name: 'Security' });
    expect(securityNavigation).not.toHaveClass('settings-navigation-child');
    // Between Organization and Connections.
    const organizationNavigation = within(navigation).getByRole('button', { name: 'Organization' });
    expect(organizationNavigation.compareDocumentPosition(securityNavigation) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(securityNavigation.compareDocumentPosition(
      within(navigation).getByRole('button', { name: 'Connections' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    openSettingsSection('Organization');
    expect(await screen.findByText('Sam', undefined, { timeout: 10_000 })).toBeVisible();
    // The destructive review-and-confirm flow is not sitting in the middle of
    // the preferences list, and Workspace does not pay for its read.
    expect(screen.queryByText('Terminal network access')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^Full internet/ })).not.toBeInTheDocument();
    expect(api.getTerminalWorkspaceSettings).not.toHaveBeenCalled();

    fireEvent.click(securityNavigation);

    expect(await screen.findByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    expect(await screen.findByRole('radio', { name: /^Trusted only/ }, { timeout: 10_000 })).toBeChecked();
    await waitFor(() => expect(api.getTerminalWorkspaceSettings).toHaveBeenCalled());
  }, 30_000);

  it('asks before applying full Terminal internet access', async () => {
    renderSettings();
    openSettingsSection('Security');
    // 10s rather than the suite's 5s `asyncUtilTimeout` (src/renderer/test/setup.ts),
    // and 30s rather than its 15s `testTimeout` on the `it` below. These panes
    // settle several queries deep, and on a CPU-loaded machine — a CI runner, or
    // `pnpm test` running nine packages at once — they have exhausted both while
    // the code under them was fine. Measured at 10x oversubscription on 4 cores:
    // 18-20s per test, of which no single await exceeded 10s, so the per-test
    // budget is the binding one and the two have to move together. 30s keeps the
    // 3:1 ratio the shared config already sets between them, which is what makes
    // a condition that never settles fail as the assertion rather than as a bare
    // test timeout. Same pair on every named test below.
    expect(await screen.findByText('Terminal network access', undefined, { timeout: 10_000 })).toBeVisible();
    // The heading and the radio group settle on different ticks, so the sync
    // query raced the render and failed under full-suite load. The same query
    // is already awaited below.
    const fullInternet = await screen.findByRole('radio', { name: /^Full internet/ }, { timeout: 10_000 });
    fireEvent.click(fullInternet);
    await waitFor(() => expect(fullInternet).toBeChecked(), { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Save network change' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change network access?' }, { timeout: 10_000 });
    expect(within(dialog).getByText(/may be interrupted/u)).toBeVisible();
    expect(api.previewTerminalNetworkPolicy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.applyTerminalNetworkPolicy).toHaveBeenCalledWith({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1, confirmed: true,
    }), { timeout: 10_000 });
    expect(api.previewTerminalNetworkPolicy).toHaveBeenCalledWith({
      expectedRevision: 1, mode: 'full_internet', customDomains: [],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 10_000 });
  }, 30_000);

  it('changes nothing when the network change is cancelled', async () => {
    renderSettings();
    openSettingsSection('Security');
    fireEvent.click(await screen.findByRole('radio', { name: /^Full internet/ }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save network change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change network access?' }, { timeout: 10_000 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 10_000 });
    expect(api.previewTerminalNetworkPolicy).not.toHaveBeenCalled();
    expect(api.applyTerminalNetworkPolicy).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    ['preview', 'The Terminal network policy changed; reload settings and preview the policy again.'],
    ['apply', 'Daytona did not confirm the requested network policy.'],
  ] as const)('keeps the draft and shows the error when the %s request fails', async (failing, message) => {
    const failure = new ApiError(message, 409, 'terminal_policy_revision_conflict');
    if (failing === 'preview') api.previewTerminalNetworkPolicy.mockRejectedValueOnce(failure);
    else api.applyTerminalNetworkPolicy.mockRejectedValueOnce(failure);
    renderSettings();
    openSettingsSection('Security');
    const fullInternet = await screen.findByRole('radio', { name: /^Full internet/ }, { timeout: 10_000 });
    fireEvent.click(fullInternet);
    fireEvent.click(screen.getByRole('button', { name: 'Save network change' }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, { timeout: 10_000 })).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(message, undefined, { timeout: 10_000 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 10_000 });
    expect(fullInternet).toBeChecked();
    if (failing === 'preview') expect(api.applyTerminalNetworkPolicy).not.toHaveBeenCalled();

    // A retry goes through with the same draft.
    fireEvent.click(screen.getByRole('button', { name: 'Save network change' }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, { timeout: 10_000 })).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.applyTerminalNetworkPolicy).toHaveBeenLastCalledWith({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1, confirmed: true,
    }), { timeout: 10_000 });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  }, 30_000);

  it('keeps Rally-managed Trusted-only domains out of the settings surface', async () => {
    api.previewTerminalNetworkPolicy.mockResolvedValueOnce({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1,
      proposedMode: 'trusted_only', customDomains: ['packages.example.com'],
      remainingCustomSlots: 6,
    });
    renderSettings();
    openSettingsSection('Security');

    expect(await screen.findByText('Organization-approved domains', undefined, { timeout: 10_000 })).toBeVisible();
    expect(screen.queryByText('Required targets')).not.toBeInTheDocument();
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText('Additional Terminal domains'), {
      target: { value: 'packages.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save network change' }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, { timeout: 10_000 })).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.previewTerminalNetworkPolicy).toHaveBeenCalledWith({
      expectedRevision: 1, mode: 'trusted_only', customDomains: ['packages.example.com'],
    }), { timeout: 10_000 });
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
  }, 30_000);

  it('opens the exact section requested by a native settings-window URL', async () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=workspace#/settings');
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).getByRole('button', { name: 'Organization' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
    expect(await screen.findByText('Sam')).toBeVisible();
  });

  it('marks an installed connection and its provider card with the same company', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000021',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Rally',
      capabilities: ['slack.agent'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    const row = (await within(screen.getByRole('main')).findByText('Slack · Rally')).closest('tr');
    const rowMark = row?.querySelector('.connector-mark');
    expect(rowMark).toBeTruthy();

    // The card somebody would connect from wears the same mark as the row that
    // connecting produced: both reach it from the connector's own type.
    const card = screen.getByText('Slack').closest('.provider-card');
    const cardMark = card?.querySelector('.connector-mark');
    expect(cardMark?.innerHTML).toBe(rowMark?.innerHTML);

    // Each mark carries `connector-mark` and nothing else. A second class here
    // is how the sizes went dead: a bare `.provider-mark` ties `.connector-mark`
    // on specificity and loses on source order, so the rule reads as if it
    // applies and does not. Both surfaces size through `.connector-mark` now.
    expect([...(rowMark?.classList ?? [])]).toEqual(['connector-mark']);
    expect([...(cardMark?.classList ?? [])]).toEqual(['connector-mark']);
  });

  it('leaves an inbound webhook unmarked, having no company behind it', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000022',
      connectorType: 'generic_webhook',
      scope: 'workspace',
      displayName: 'Deploy notifications',
      capabilities: [],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    const row = (await within(screen.getByRole('main')).findByText('Deploy notifications')).closest('tr');
    expect(row?.querySelector('.connector-mark')).toBeNull();
  });

  it('adds a custom MCP server through headers without leaving for a browser', async () => {
    api.createCustomMcpConnection.mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000030',
      connectorType: 'custom_mcp',
      scope: 'workspace',
      displayName: 'Acme docs',
      capabilities: ['custom_mcp.tools'],
      status: 'healthy',
      settingsKind: 'custom_mcp_tools',
    });
    renderSettings();
    openSettingsSection('Connections');

    const card = (await screen.findByText('Custom MCP server')).closest('article');
    fireEvent.click(await enabledConnectAction(card!, 'Connect for organization'));
    // The labels carry their help text too, so each matcher is anchored on the
    // field's own name rather than the whole string.
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: 'Acme docs' } });
    fireEvent.change(screen.getByLabelText(/^Server URL/u), {
      target: { value: 'https://mcp.acme.test/mcp' },
    });
    fireEvent.change(screen.getByLabelText(/^Authorization/u), { target: { value: 'headers' } });
    fireEvent.change(screen.getByLabelText('Header 1 name'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByLabelText('Header 1 value'), { target: { value: 'Bearer secret' } });
    fireEvent.change(screen.getByLabelText(/^Tools Rally may use/u), {
      target: { value: 'read_only_tools' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(api.createCustomMcpConnection).toHaveBeenCalledWith({
      displayName: 'Acme docs',
      scope: 'workspace',
      serverUrl: 'https://mcp.acme.test/mcp',
      requestHeaders: { Authorization: 'Bearer secret' },
      toolPolicy: 'read_only_tools',
    }));
    // Header authentication never leaves Rally, so nothing may open a browser.
    expect(openExternal).not.toHaveBeenCalled();
    expect(api.startCustomMcpConnection).not.toHaveBeenCalled();
  });

  it('sends an OAuth MCP server to its own authorization and waits for the callback', async () => {
    api.startCustomMcpConnection.mockResolvedValue({
      url: 'https://mcp.acme.test/authorize?state=abc',
      attemptId: 'a'.repeat(43),
    });
    api.getConnectorOAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      provider: 'custom_mcp',
      status: 'pending',
      connectionId: null,
      errorCode: null,
      expiresAt: '2026-09-03T01:00:00.000Z',
    });
    renderSettings();
    openSettingsSection('Connections');

    const card = (await screen.findByText('Custom MCP server')).closest('article');
    fireEvent.click(await enabledConnectAction(card!, 'Connect for me'));
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: 'My docs' } });
    fireEvent.change(screen.getByLabelText(/^Server URL/u), {
      target: { value: 'https://mcp.acme.test/mcp' },
    });
    // A personal connection has no policy to choose: it is only ever its owner's.
    expect(screen.queryByLabelText(/^Tools Rally may use/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize server' }));

    await waitFor(() => expect(api.startCustomMcpConnection).toHaveBeenCalledWith({
      displayName: 'My docs',
      scope: 'you',
      serverUrl: 'https://mcp.acme.test/mcp',
      toolPolicy: 'all_tools',
    }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://mcp.acme.test/authorize?state=abc'));
  });

  it('shows a connected server its live catalog and changes what the organization may call', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000030',
      connectorType: 'custom_mcp',
      scope: 'workspace',
      displayName: 'Acme docs',
      capabilities: ['custom_mcp.tools'],
      status: 'healthy',
      settingsKind: 'custom_mcp_tools',
    }]);
    const settings = {
      connectionId: '00000000-0000-7000-8000-000000000030',
      connectionName: 'Acme docs',
      scope: 'workspace' as const,
      serverUrl: 'https://mcp.acme.test/mcp',
      authMode: 'headers' as const,
      toolPolicy: 'all_tools' as const,
      toolPolicyEditable: true,
      tools: [
        { name: 'search_docs', description: 'Search the corpus', readOnly: true, destructive: false, available: true },
        { name: 'publish_doc', description: 'Publish a document', readOnly: false, destructive: true, available: true },
      ],
      toolsUnavailable: null,
    };
    api.getCustomMcpSettings.mockResolvedValue(settings);
    api.updateCustomMcpToolPolicy.mockResolvedValue({
      ...settings,
      toolPolicy: 'read_only_tools',
      tools: [
        settings.tools[0]!,
        { ...settings.tools[1]!, available: false },
      ],
    });
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'Acme docs' }));

    expect(await screen.findByText('https://mcp.acme.test/mcp')).toBeVisible();
    const writeRow = (await screen.findByText('publish_doc'))
      .closest<HTMLElement>('.settings-custom-mcp-tool-row');
    expect(within(writeRow!).getByText('Destructive')).toBeVisible();
    expect(within(writeRow!).getByText('Available')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Tools Rally may use'), {
      target: { value: 'read_only_tools' },
    });
    await waitFor(() => expect(api.updateCustomMcpToolPolicy).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000030',
      'read_only_tools',
    ));
    // The tool is still listed, so a person can see what the policy is holding
    // back rather than watching it disappear.
    await waitFor(() => expect(
      within(screen.getByText('publish_doc').closest<HTMLElement>('.settings-custom-mcp-tool-row')!)
        .getByText('Withheld'),
    ).toBeVisible());
  });

  it('refreshes the count when a policy save finishes after returning to Connections', async () => {
    const connectionId = '00000000-0000-7000-8000-000000000030';
    const listed = (toolCount: number) => [{
      id: connectionId, connectorType: 'custom_mcp', scope: 'workspace',
      displayName: 'Acme docs', capabilities: ['custom_mcp.tools'],
      status: 'healthy', settingsKind: 'custom_mcp_tools', toolCount,
    }];
    api.getConnections.mockResolvedValue(listed(2));
    const settings = {
      connectionId, connectionName: 'Acme docs', scope: 'workspace' as const,
      serverUrl: 'https://mcp.acme.test/mcp', authMode: 'headers' as const,
      toolPolicy: 'all_tools' as const, toolPolicyEditable: true,
      tools: [], toolsUnavailable: null,
    };
    api.getCustomMcpSettings.mockResolvedValue(settings);
    let finishPolicySave!: () => void;
    api.updateCustomMcpToolPolicy.mockImplementationOnce(() => new Promise((resolve) => {
      finishPolicySave = () => resolve({ ...settings, toolPolicy: 'read_only_tools' });
    }));
    renderSettings();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'Acme docs' }));
    fireEvent.change(await screen.findByLabelText('Tools Rally may use'), {
      target: { value: 'read_only_tools' },
    });
    await waitFor(() => expect(api.updateCustomMcpToolPolicy).toHaveBeenCalledWith(
      connectionId, 'read_only_tools',
    ));
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Organization connections' });
    expect(await within(table).findByRole('cell', { name: '2' })).toBeVisible();

    // The save stores the narrowed count server-side; the list read after it
    // is what carries the new number.
    api.getConnections.mockResolvedValue(listed(1));
    await act(async () => finishPolicySave());
    expect(await within(table).findByRole('cell', { name: '1' })).toBeVisible();
    expect(within(table).queryByRole('cell', { name: '2' })).not.toBeInTheDocument();
  });

  it('says why a catalog is missing instead of showing an empty one', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000030',
      connectorType: 'custom_mcp',
      scope: 'you',
      displayName: 'My docs',
      capabilities: ['custom_mcp.tools'],
      status: 'healthy',
      settingsKind: 'custom_mcp_tools',
    }]);
    api.getCustomMcpSettings.mockResolvedValue({
      connectionId: '00000000-0000-7000-8000-000000000030',
      connectionName: 'My docs',
      scope: 'personal',
      serverUrl: 'https://mcp.acme.test/mcp',
      authMode: 'oauth',
      toolPolicy: 'all_tools',
      toolPolicyEditable: false,
      tools: [],
      toolsUnavailable: 'Custom MCP returned HTTP 503',
    });
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'My docs' }));

    expect(await screen.findByText('This server’s tools could not be read')).toBeVisible();
    expect(screen.getByText('Custom MCP returned HTTP 503')).toBeVisible();
    // A personal connection's policy is fixed, so the control is not offered as
    // something to change.
    expect(screen.getByLabelText('Tools Rally may use')).toBeDisabled();
  });

  it('gives every installed connection its own page under Connections, settings or not', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000020',
      connectorType: 'github',
      scope: 'workspace',
      displayName: 'GitHub · Rally',
      capabilities: ['github.metadata.read', 'github.contents.read'],
      status: 'healthy',
      settingsKind: 'github_repository_access',
      toolCount: 20,
    }, {
      id: '00000000-0000-7000-8000-000000000022',
      connectorType: 'granola',
      scope: 'you',
      displayName: 'Granola · adam@example.com',
      capabilities: ['granola.notes.read'],
      status: 'healthy',
      toolCount: 6,
    }]);
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const granolaNavigation = await within(navigation).findByRole('button', { name: 'Granola · adam@example.com' });
    const githubNavigation = within(navigation).getByRole('button', { name: 'GitHub · Rally' });
    // Personal before organization, as the tables list them, both after Connections.
    expect(within(navigation).getByRole('button', { name: 'Connections' })
      .compareDocumentPosition(granolaNavigation) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(granolaNavigation.compareDocumentPosition(githubNavigation) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(granolaNavigation).toHaveClass('settings-navigation-child');
    expect(granolaNavigation.querySelector('.connector-mark')).not.toBeNull();

    // A connection with nothing to configure still has a page: its status, access and tools.
    fireEvent.click(granolaNavigation);
    expect(await screen.findByRole('heading', { level: 1, name: 'Granola · adam@example.com' })).toBeVisible();
    expect(granolaNavigation).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('6 tools available to Rally through this connection.')).toBeVisible();
    expect(screen.getByText('Personal')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2, name: 'Repository access' })).not.toBeInTheDocument();
    expect(api.getGitHubRepositoryAccessSettings).not.toHaveBeenCalled();

    // A row on Connections opens the same page from anywhere along it.
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Organization connections' });
    fireEvent.click(within(table).getByRole('cell', { name: '20' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'GitHub · Rally' })).toBeVisible();
    expect(githubNavigation).toHaveAttribute('aria-current', 'page');
    expect(granolaNavigation).not.toHaveAttribute('aria-current');
    expect(await screen.findByRole('heading', { level: 2, name: 'Repository access' })).toBeVisible();
    expect(await screen.findByText('juno-ai-labs/rally')).toBeVisible();
    expect(screen.getByText(/Read-only still allows Rally to edit and commit locally/u)).toBeVisible();
    expect(api.getGitHubRepositoryAccessSettings).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000020',
      expect.any(AbortSignal),
    );
  });

  it('opens a connection\'s own page from search, and a setting on the connection it names', async () => {
    const first = '00000000-0000-7000-8000-000000000030';
    const second = '00000000-0000-7000-8000-000000000031';
    api.getConnections.mockResolvedValue([first, second].map((id, index) => ({
      id, connectorType: 'custom_mcp', scope: 'workspace',
      displayName: index === 0 ? 'Cloudflare API' : 'Cloudflare Observability',
      capabilities: ['custom_mcp.tools'], status: 'healthy', settingsKind: 'custom_mcp_tools',
    })));
    api.getCustomMcpSettings.mockImplementation(async (connectionId: string) => ({
      connectionId, connectionName: connectionId, scope: 'workspace',
      serverUrl: `https://mcp.example.test/${connectionId}`, authMode: 'oauth', toolPolicy: 'all_tools',
      toolPolicyEditable: true, tools: [], toolsUnavailable: null,
    }));
    renderSettings();
    await screen.findByRole('button', { name: 'Cloudflare Observability' });
    const search = screen.getByRole('searchbox', { name: 'Search settings' });

    fireEvent.change(search, { target: { value: 'observability' } });
    const results = screen.getByRole('navigation', { name: 'Settings search results' });
    expect(within(results).getByRole('button', { name: 'Cloudflare Observability Connections' })).toBeVisible();
    fireEvent.click(document.querySelector<HTMLElement>(`[data-setting-result="connection:${second}"]`)!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cloudflare Observability' })).toBeVisible();
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-setting-id', `connection:${second}`));
    expect(await screen.findByText(`https://mcp.example.test/${second}`)).toBeVisible();

    fireEvent.change(search, { target: { value: 'Tools Rally may use API' } });
    fireEvent.click(document.querySelector<HTMLElement>(`[data-setting-result="mcpPolicy:${first}"]`)!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cloudflare API' })).toBeVisible();
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-setting-instance', first));
    expect(document.activeElement).toHaveAttribute('data-setting-id', 'mcpPolicy');
    expect(api.updateCustomMcpToolPolicy).not.toHaveBeenCalled();
  });

  it('shows organization GitHub policy read-only to non-admin members', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000020',
      connectorType: 'github',
      scope: 'workspace',
      displayName: 'GitHub · Rally',
      capabilities: ['github.metadata.read'],
      status: 'healthy',
      settingsKind: 'github_repository_access',
    }]);
    renderSettings({ ...workspace, currentUser: member });
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub · Rally' }));

    expect(await screen.findByText(/Ask an organization administrator to change it/u)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Repository availability' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Default remote access' })).toBeDisabled();
  });

  it('gives a member\'s personal GitHub connection a page apart from the organization\'s', async () => {
    const workspaceConnectionId = '00000000-0000-7000-8000-000000000020';
    const personalConnectionId = '00000000-0000-7000-8000-000000000021';
    api.getConnections.mockResolvedValue([{
      id: workspaceConnectionId,
      connectorType: 'github',
      scope: 'workspace',
      displayName: 'GitHub · Rally',
      capabilities: ['github.metadata.read'],
      status: 'healthy',
      settingsKind: 'github_repository_access',
    }, {
      id: personalConnectionId,
      connectorType: 'github',
      scope: 'you',
      ownerUserId: member.id,
      displayName: 'GitHub · Sam',
      capabilities: ['github.metadata.read'],
      status: 'healthy',
      settingsKind: 'github_repository_access',
    }]);
    api.getGitHubRepositoryAccessSettings.mockImplementation(async (connectionId: string) => ({
      connectionId,
      connectionName: connectionId === personalConnectionId ? 'GitHub · Sam' : 'GitHub · Rally',
      revision: 3,
      mode: 'all_repositories',
      defaultRemoteAccess: 'full_access',
      repositories: [],
      availableRepositories: [],
    }));
    renderSettings({ ...workspace, currentUser: member });
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub · Rally' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Repository availability' })).toBeDisabled());
    fireEvent.click(within(navigation).getByRole('button', { name: 'GitHub · Sam' }));

    await waitFor(() => expect(api.getGitHubRepositoryAccessSettings).toHaveBeenCalledWith(
      personalConnectionId,
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Repository availability' })).toBeEnabled());
  });

  it('updates repository selection and remote access without restricting local edits', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000020',
      connectorType: 'github',
      scope: 'workspace',
      displayName: 'GitHub · Rally',
      capabilities: ['github.metadata.read', 'github.contents.read'],
      status: 'healthy',
      settingsKind: 'github_repository_access',
    }]);
    renderSettings();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub · Rally' }));

    const availability = await screen.findByRole('combobox', { name: 'Repository availability' });
    fireEvent.change(availability, { target: { value: 'selected_repositories' } });
    await waitFor(() => expect(api.updateGitHubRepositoryAccessSettings).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000020',
      { expectedRevision: 3, mode: 'selected_repositories', defaultRemoteAccess: 'full_access', repositories: [] },
    ));
    const add = await screen.findAllByRole('button', { name: 'Add' });
    fireEvent.click(add[0]!);
    await waitFor(() => expect(api.updateGitHubRepositoryAccessSettings).toHaveBeenLastCalledWith(
      '00000000-0000-7000-8000-000000000020',
      {
        expectedRevision: 4,
        mode: 'selected_repositories',
        defaultRemoteAccess: 'full_access',
        repositories: [{
          repositoryId: '101',
          repositoryFullName: 'juno-ai-labs/rally',
          remoteAccess: 'read_only',
        }],
      },
    ));
    expect(screen.getByText(/Terminal harness always permits local edits and local commits/iu)).toBeVisible();
    expect(screen.queryByText(/participant explicitly requested/iu)).not.toBeInTheDocument();
  });

  it('refreshes members when the list settings opened onto could have gone stale', async () => {
    const client = createTestQueryClient();
    client.setQueryData(['workspace-members'], [owner]);
    // Older than this observer's 30 seconds, which every list that has been sat
    // on long enough for somebody to have joined or left is. It used to be
    // refetched unconditionally; the premise this test needed all along is that
    // the copy on hand is old, not merely that one exists.
    ageCacheEntry(client, ['workspace-members'], 60_000);

    renderSettings(workspace, client);
    openSettingsSection('Organization');

    expect(screen.getByText('Adam')).toBeVisible();
    await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Sam')).toBeVisible();
  });

  it('targets an already-open singleton settings window and ignores invalid section events', async () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

    act(() => settingsSectionRequest.listener?.('connections'));
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();

    act(() => settingsSectionRequest.listener?.('not-a-section'));
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
  });

  it('lands a connection request that names no connection on Connections, not the last page shown', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000022', connectorType: 'granola', scope: 'you',
      displayName: 'Granola · adam@example.com', capabilities: [], status: 'healthy', toolCount: 6,
    }]);
    renderSettings();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'Granola · adam@example.com' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Granola · adam@example.com' })).toBeVisible();
    openSettingsSection('Application');

    act(() => settingsSectionRequest.listener?.('connection'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
  });

  it('falls back to Account for the removed General settings section', () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=general#/settings');
    renderSettings();

    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  });

  it('offers separate Google presets with their exact personal and organization capabilities', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar', undefined, { timeout: 10_000 })).closest('article');
    expect(mailCard).not.toBeNull();
    expect(within(mailCard!).queryByRole('button', { name: 'Connect for organization' })).not.toBeInTheDocument();
    // The card's name renders from the static provider list, but the button
    // stays disabled until the connector catalog answers — `providerAvailable`
    // is `catalog.data?.includes(...) ?? false`. Clicking before then is a
    // no-op, and the failure it produces is the `waitFor` below timing out on
    // "Number of calls: 0" rather than anything naming the real cause. Every
    // other connect click in this file already waits for this; this one did
    // not, and lost the race on a loaded machine.
    fireEvent.click(await enabledConnectAction(mailCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'google',
      'you',
      ['gmail.read', 'gmail.modify', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
    ), { timeout: 10_000 });

    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(driveCard).not.toBeNull();
    fireEvent.click(await enabledConnectAction(driveCard!, 'Connect for organization'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'google',
      'workspace',
      ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
    ), { timeout: 10_000 });
    expect(openExternal).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('explains personal and organization connector scope from each connect action', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    const personalButton = await enabledConnectAction(driveCard!, 'Connect for me');
    const workspaceButton = await enabledConnectAction(driveCard!, 'Connect for organization');

    fireEvent.focus(personalButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Only you can use this connection; it acts with your provider identity.',
    );
    fireEvent.blur(personalButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    fireEvent.focus(workspaceButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this organization can use this connection; it acts for the organization.',
    );
    fireEvent.blur(workspaceButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('gives every connector card one paragraph, and Ashby its opt-in prerequisite on the button', async () => {
    api.getAvailableConnectorTypes.mockResolvedValue([
      'ashby', 'custom_mcp', 'generic_webhook', 'github', 'google', 'granola', 'linear', 'notion', 'slack', 'x',
    ]);
    renderSettings();
    openSettingsSection('Connections');

    // A card's height is the height of its content, and the grid stretches a
    // row to its tallest card — so a card carrying more than the one
    // description paragraph pads its neighbours with empty space.
    // Ashby and Fireflies each used to carry a connection-status line the
    // installed-connections list above already shows, and Ashby a third
    // paragraph for its MCP opt-in.
    const cards = await screen.findAllByRole('article');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const paragraphs = [...card.children].filter((child) => child.tagName === 'P');
      expect(paragraphs).toHaveLength(1);
      expect(paragraphs[0]?.className).toBe('');
    }

    // The opt-in is a prerequisite Rally cannot check and the OAuth redirect
    // cannot explain, so it rides the button it qualifies rather than a second
    // paragraph. Losing it entirely leaves a non-opted-in org with a
    // provider-side failure and nothing naming the cause.
    const ashbyCard = (await screen.findByText('Ashby')).closest('article');
    expect(ashbyCard).not.toBeNull();
    const ashbyPersonal = await enabledConnectAction(ashbyCard!, 'Connect for me');
    fireEvent.focus(ashbyPersonal);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Personal sign-in requires your organization's Ashby MCP opt-in and an eligible account.",
    );
    fireEvent.blur(ashbyPersonal);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    // Every other provider's tooltip says only what the scope means.
    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    const drivePersonal = await enabledConnectAction(driveCard!, 'Connect for me');
    fireEvent.focus(drivePersonal);
    expect(await screen.findByRole('tooltip')).not.toHaveTextContent('Ashby MCP opt-in');
    fireEvent.blur(drivePersonal);
  }, 30_000);

  it('gives disabled connector tooltip triggers a name and disabled semantics', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'workspace',
      displayName: 'Google Drive · Rally',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    const workspaceButton = within(driveCard!).getByRole('button', { name: 'Connect for organization' });
    await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
    expect(workspaceButton).toHaveAccessibleName('Connect for organization');

    fireEvent.focus(workspaceButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this organization can use this connection; it acts for the organization. A Google Drive + Docs + Sheets organization connection is already installed. Manage it above.',
    );
  });

  it('offers personal Notion MCP separately from the shared organization bot connection', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const notionCard = (await screen.findByText('Notion')).closest('article');
    expect(notionCard).not.toBeNull();
    expect(screen.getByText(/organization automations use only the connections explicitly bound to them/iu)).toBeVisible();
    const personalButton = await enabledConnectAction(notionCard!, 'Connect for me');
    fireEvent.click(personalButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'notion',
      'you',
      ['notion.personal.mcp'],
    ));
    const workspaceButton = await enabledConnectAction(notionCard!, 'Connect for organization');
    fireEvent.click(workspaceButton);

    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'notion',
      'workspace',
      ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
    ));
  });

  it('reconciles a denied connector attempt from the regional API when no deep link arrives', async () => {
    api.getConnectorOAuthAttempt.mockResolvedValueOnce({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'denied',
      connectionId: null,
      errorCode: 'oauth_denied',
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    fireEvent.click(await enabledConnectAction(mailCard!, 'Connect for me'));

    await waitFor(() => expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('a'.repeat(43)));
    await enabledConnectAction(mailCard!, 'Connect for me');
    expect(screen.queryByText('Google authorization was cancelled.')).not.toBeInTheDocument();
    expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('reconciles the server-owned reconnect attempt without a footer message', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Imported connection label',
      capabilities: ['drive.read'],
      status: 'reconnect_required',
    }]);
    api.getConnectorOAuthAttempt
      .mockResolvedValueOnce({
        attemptId: 'b'.repeat(43),
        provider: 'notion',
        status: 'pending',
        connectionId: null,
        errorCode: null,
        expiresAt: '2026-08-08T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        attemptId: 'b'.repeat(43),
        provider: 'notion',
        status: 'denied',
        connectionId: null,
        errorCode: 'oauth_denied',
        expiresAt: '2026-08-08T00:00:00.000Z',
      });
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Imported connection label');
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Imported connection label' }));

    const dialog = await screen.findByRole('dialog', { name: 'Refresh Imported connection label?' });
    expect(dialog).toHaveAccessibleDescription('You’ll be sent to the provider to authorize this connection again.');
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(api.getConnectorOAuthAttempt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Imported connection label' })).toBeEnabled());
    expect(screen.queryByText('Notion authorization was cancelled.')).not.toBeInTheDocument();
    expect(api.reconnectConnection).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000010',
      'google',
      'you',
      1,
    );
    expect(api.getConnectorOAuthAttempt).toHaveBeenNthCalledWith(1, 'b'.repeat(43));
  });

  it('lets a healthy installed connection start reconnect after confirmation', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Google · adam@example.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Google · adam@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refresh Google · adam@example.com?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(api.reconnectConnection).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000010',
      'google',
      'you',
      1,
    ));
    expect(openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
  });

  it('disables reconnect actions while a reconnect request is pending', async () => {
    let resolveReconnect!: (value: { url: string; attemptId: string }) => void;
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    api.reconnectConnection.mockImplementationOnce(() => new Promise((resolve) => {
      resolveReconnect = resolve;
    }));
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Google · adam@example.com');
    const reconnectButton = await screen.findByRole('button', { name: 'Refresh Google · adam@example.com' });
    fireEvent.click(reconnectButton);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Refresh Google · adam@example.com' }),
    ).toHaveAttribute('aria-disabled', 'true'));
    await act(async () => resolveReconnect({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'b'.repeat(43),
    }));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
  });

  it('disables reconnect actions while another provider authorization is pending', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    api.getConnectorOAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'pending',
      connectionId: null,
      errorCode: null,
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    fireEvent.click(await enabledConnectAction(mailCard!, 'Connect for me'));

    expect(await within(mailCard!).findByText('Waiting…')).toBeVisible();
    await openConnection('Google · adam@example.com');
    expect(screen.getByRole('button', { name: 'Refresh Google · adam@example.com' }))
      .toHaveAttribute('aria-disabled', 'true');
  });

  it('offers personal and organization Linear authorization without granting agent identity personally', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    fireEvent.click(await enabledConnectAction(linearCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'you',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));

    fireEvent.click(await enabledConnectAction(linearCard!, 'Connect for organization'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('offers one Slack card with personal MCP and organization Agent authorization', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    expect(screen.queryByText('Slack knowledge')).not.toBeInTheDocument();
    expect(screen.queryByText('Slack actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Rally Agent for Slack')).not.toBeInTheDocument();

    // The card's name renders from the provider catalog, which settles before
    // the connections query the button's `disabled` also waits on — so the wait
    // the workspace button below already does is needed here too. Without it
    // this click can land on a still-disabled button and go nowhere, which is
    // what it did once under a loaded `pnpm test`.
    fireEvent.click(await enabledConnectAction(slackCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      ['slack.personal.mcp'],
    ));

    fireEvent.click(await enabledConnectAction(slackCard!, 'Connect for organization'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'slack',
      'workspace',
      ['slack.agent', 'slack.notifications.write'],
    ));
  });

  it('does not expose Slack Agent policy controls', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000015',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Rally',
      capabilities: ['slack.agent'],
      status: 'healthy',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    await within(screen.getByRole('main')).findByText('Slack · Rally');
    expect(screen.queryByRole('button', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('offers personal Granola MCP and submits an organization API key only through the secure setup dialog', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const granolaCard = (await screen.findByText('Granola')).closest('article');
    expect(granolaCard).not.toBeNull();

    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'granola',
      'you',
      ['granola.personal.read'],
    ));

    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect for organization'));

    const dialog = await screen.findByRole('dialog', { name: 'Connect Granola workspace' });
    expect(within(dialog).getByRole('heading', { name: 'Generate the key in Granola' })).toBeVisible();
    expect(within(dialog).getByText('Open the Granola desktop app as a workspace administrator.')).toBeVisible();
    expect(within(dialog).getByText('Go to Settings → Connectors → Workspace API keys.')).toBeVisible();
    expect(within(dialog).getByText('Choose Create new key.')).toBeVisible();
    expect(within(dialog).getByText('Copy the new key, then paste it below.')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Granola’s API key guide ↗' }));
    expect(openExternal).toHaveBeenLastCalledWith('https://docs.granola.ai/help-center/sharing/integrations/granola-api');
    const apiKeyInput = within(dialog).getByLabelText('Workspace API key');
    expect(apiKeyInput).toHaveAttribute('type', 'password');
    expect(dialog).toHaveAccessibleDescription(
      'An organization-wide Granola connection requires a Granola Workspace API key. Personal Granola connections use browser sign-in and do not need a key.',
    );

    // A paste that cannot be a Granola key says so, rather than leaving a dead
    // Connect button and no reason for it. Typing is held back until the field
    // settles; a paste is a finished value, so it is judged at once.
    fireEvent.change(apiKeyInput, { target: { value: 'sk-live' } });
    expect(within(dialog).queryByRole('alertdialog')).toBeNull();
    fireEvent.paste(apiKeyInput);
    fireEvent.change(apiKeyInput, { target: { value: 'sk-live-wrong-provider-key' } });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Granola keys start with grn_');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(within(dialog).getByRole('button', { name: 'Connect for organization' })).toBeDisabled();

    const apiKey = `grn_${'a'.repeat(24)}`;
    fireEvent.change(apiKeyInput, { target: { value: apiKey } });
    expect(within(dialog).queryByRole('alertdialog')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect for organization' }));

    await waitFor(() => expect(api.createGranolaWorkspaceConnection).toHaveBeenCalledWith(apiKey, expect.any(String)));
    expect(await screen.findByText('No personal connections yet')).toBeVisible();
    expect(screen.getByText('No organization connections yet')).toBeVisible();
  });

  it('settles on the existing Granola installation when setup loses its response, with no events console', async () => {
    renderSettings();
    openSettingsSection('Connections');
    const granolaCard = (await screen.findByText('Granola')).closest('article');
    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect for organization'));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Granola workspace' });
    api.createGranolaWorkspaceConnection.mockRejectedValue(new Error('Response lost'));
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000018', connectorType: 'granola', scope: 'workspace',
      displayName: 'Granola organization events', capabilities: ['granola.workspace.read'], status: 'error',
    }]);
    api.connectorInstallation.mockResolvedValue({ installation: null });
    fireEvent.change(within(dialog).getByLabelText('Workspace API key'), { target: { value: `grn_${'a'.repeat(24)}` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect for organization' }));
    // The lost response found its connection: setup closes rather than
    // offering a second one, and the row that appears carries no console.
    expect(await within(document.querySelector('main')!).findByText('Granola organization events')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Granola workspace' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Organization events' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage events for Granola organization events', hidden: true })).not.toBeInTheDocument();
    expect(api.connectorInstallation).not.toHaveBeenCalled();
    expect(api.createGranolaWorkspaceConnection).toHaveBeenCalledTimes(1);
  });

  // The other half of the console list: with only Granola and Fireflies asserted
  // absent, an empty or mis-exported list would take Ashby's window away and
  // leave every one of those assertions green.
  it('keeps the events console on an Ashby organization connection', async () => {
    api.getAvailableConnectorTypes.mockResolvedValue(['ashby']);
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000022', connectorType: 'ashby', scope: 'workspace',
      displayName: 'Ashby organization events', capabilities: ['ashby.workspace.events'], status: 'healthy',
    }]);
    api.connectorInstallation.mockResolvedValue({ installation: null });
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Ashby organization events');
    fireEvent.click(await screen.findByRole('button', { name: 'Manage events for Ashby organization events' }));
    expect(await screen.findByRole('dialog', { name: 'Organization events' })).toBeVisible();
    await waitFor(() => expect(api.connectorInstallation).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000022'));
  });

  it.each(['desktop', 'browser'] as const)('connects Apollo.io through personal OAuth on %s', async (host) => {
    sessionHost.current = host;
    api.getAvailableConnectorTypes.mockResolvedValue(['apollo']);
    renderSettings();
    openSettingsSection('Connections');
    const card = (await screen.findByText('Apollo.io')).closest('article')!;
    expect(within(card).queryByRole('button', { name: 'Connect for organization' })).not.toBeInTheDocument();
    fireEvent.click(await enabledConnectAction(card, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith('apollo', 'you', ['apollo.personal.mcp']));
    expect(openExternal).toHaveBeenCalled();
  });

  it('offers Fireflies to a person and never to the organization', async () => {
    api.getAvailableConnectorTypes.mockResolvedValue(['fireflies']);
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000021', connectorType: 'fireflies', scope: 'workspace',
      displayName: 'Fireflies organization meetings', capabilities: ['fireflies.workspace.read'], status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    const firefliesCard = (await screen.findByText('Fireflies')).closest('article');
    expect(firefliesCard).not.toBeNull();
    // One administrator's key is every member's read of every meeting it can
    // see, so there is no workspace connection to start.
    expect(within(firefliesCard!).queryByRole('button', { name: 'Connect for organization' })).not.toBeInTheDocument();
    // The workspace connection a customer already has keeps its row — it still
    // receives meetings — and offers no webhook console over it.
    expect(within(screen.getByRole('main')).getByText('Fireflies organization meetings')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Manage events for Fireflies organization meetings', hidden: true })).not.toBeInTheDocument();

    fireEvent.click(await enabledConnectAction(firefliesCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith('fireflies', 'you', ['fireflies.personal.read']));
  });

  it('offers the read-only X connector only at organization scope', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();

    fireEvent.click(await enabledConnectAction(xCard!, 'Connect for organization'));
    await waitFor(() => expect(api.createXConnection).toHaveBeenCalledWith(['x.read']));
    expect(api.startProviderConnection).not.toHaveBeenCalledWith('x', expect.anything(), expect.anything());
  });

  it('creates a signed generic webhook and exposes its endpoint and secret once', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const webhookCard = (await screen.findByText('Inbound webhook')).closest('article');
    expect(webhookCard).not.toBeNull();
    fireEvent.click(await enabledConnectAction(webhookCard!, 'Connect for me'));

    const dialog = await screen.findByRole('dialog', { name: 'Create inbound webhook' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Support intake' } });
    fireEvent.change(within(dialog).getByLabelText(/Allowed event types/u), {
      target: { value: 'ticket.created, ticket.updated' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create webhook' }));

    await waitFor(() => expect(api.createWebhookConnection).toHaveBeenCalledWith(
      'Support intake',
      'you',
      ['ticket.created', 'ticket.updated'],
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ));
    expect(await within(dialog).findByLabelText('Webhook endpoint')).toHaveValue(
      'https://enterprise.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000019',
    );
    expect(within(dialog).getByLabelText('Webhook signing secret')).toHaveAttribute('type', 'password');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy secret' }));
    expect(copyText).toHaveBeenLastCalledWith('whsec_one-time-secret');
  });

  it('marks X unavailable when the regional backend has no TwitterAPI.io credential', async () => {
    api.getAvailableConnectorTypes.mockResolvedValue([
      'generic_webhook', 'github', 'google', 'granola', 'linear', 'notion', 'slack',
    ]);
    renderSettings();
    openSettingsSection('Connections');

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).getByText('Unavailable')).toBeVisible();
    const connect = within(xCard!).getByRole('button', { name: 'Connect for organization' });
    expect(connect).toHaveAttribute('aria-disabled', 'true');
    fireEvent.focus(connect);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this organization can use this connection; it acts for the organization. Public X via TwitterAPI.io is not configured in this Rally region.',
    );
  });

  it('disables duplicate organization X connections', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000017',
      connectorType: 'x',
      scope: 'workspace',
      displayName: 'X',
      capabilities: ['x.read'],
      status: 'healthy',
    }]);

    renderSettings();
    openSettingsSection('Connections');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();
    const workspaceButton = within(xCard!).getByRole('button', { name: 'Connect for organization' });
    await waitFor(() => {
      expect(workspaceButton).toHaveAttribute('aria-disabled', 'true');
    });
    expect(screen.queryByRole('button', { name: 'Refresh X' })).not.toBeInTheDocument();
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate Slack organization authorization for an existing %s installation',
    async (status) => {
      api.getConnections.mockResolvedValue([{
        id: '00000000-0000-7000-8000-000000000015',
        connectorType: 'slack',
        scope: 'workspace',
        displayName: 'Slack · Rally',
        capabilities: ['slack.agent', 'slack.notifications.write'],
        status,
      }]);

      renderSettings();
      openSettingsSection('Connections');
      fireEvent.click(screen.getByRole('radio', { name: 'All' }));

      const slackCard = (await screen.findByText('Slack')).closest('article');
      expect(slackCard).not.toBeNull();
      await waitFor(() => {
        expect(within(slackCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
      });
      expect(within(slackCard!).queryByRole('button', { name: 'Connect another workspace' })).not.toBeInTheDocument();
      const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect for organization' });
      await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows replacing a disabled Slack organization installation', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000016',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Rally',
      capabilities: ['slack.agent', 'slack.notifications.write'],
      status: 'disabled',
    }]);

    renderSettings();
    openSettingsSection('Connections');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    const workspaceButton = await enabledConnectAction(slackCard!, 'Connect for organization');
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'workspace',
      ['slack.agent', 'slack.notifications.write'],
    ));
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate organization authorization for an existing %s Linear installation',
    async (status) => {
      api.getConnections.mockResolvedValue([{
        id: '00000000-0000-7000-8000-000000000011',
        connectorType: 'linear',
        scope: 'workspace',
        displayName: 'Linear · Rally',
        capabilities: ['linear.read'],
        status,
      }]);

      renderSettings();
      openSettingsSection('Connections');
      fireEvent.click(screen.getByRole('radio', { name: 'All' }));

      const linearCard = (await screen.findByText('Linear')).closest('article');
      expect(linearCard).not.toBeNull();
      // The catalog query gates enablement; `findByText` resolves before it.
      await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
      const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect for organization' });
      await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows a replacement organization authorization after the existing connection is disabled', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000012',
      connectorType: 'linear',
      scope: 'workspace',
      displayName: 'Linear · Rally',
      capabilities: ['linear.read'],
      status: 'disabled',
    }]);

    renderSettings();
    openSettingsSection('Connections');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    const workspaceButton = await enabledConnectAction(linearCard!, 'Connect for organization');
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('keeps providers with an installable missing scope in Not connected', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000013',
      connectorType: 'google',
      scope: 'workspace',
      displayName: 'Google Workspace · Rally',
      capabilities: ['gmail.read', 'calendar.read'],
      status: 'healthy',
    }, {
      id: '00000000-0000-7000-8000-000000000014',
      connectorType: 'linear',
      scope: 'you',
      displayName: 'Linear · Adam',
      capabilities: ['linear.read'],
      status: 'healthy',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect for organization' }))
      .toHaveAttribute('aria-disabled', 'true'));
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());

    const linearCard = screen.getByText('Linear').closest('article');
    expect(linearCard).not.toBeNull();
    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for organization' })).toBeEnabled());
  });

  it('lets members connect Linear personally without offering an organization installation', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
    expect(within(linearCard!).queryByRole('button', { name: 'Connect for organization' })).not.toBeInTheDocument();
  });

  it('draws each tool count from the connection list, with a dash where there is no count', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'static-tools', modelPluginId: 'plugin_google', connectorType: 'google',
        scope: 'you', displayName: 'Google tools', capabilities: ['gmail.read'], status: 'healthy',
        toolCount: 5,
      },
      {
        id: 'empty-server', modelPluginId: 'plugin_custom_mcp', connectorType: 'custom_mcp',
        scope: 'you', displayName: 'Empty server', capabilities: ['custom_mcp.tools'], status: 'healthy',
        toolCount: 0,
      },
      {
        id: 'never-discovered', modelPluginId: 'plugin_granola', connectorType: 'granola',
        scope: 'you', displayName: 'Granola notes', capabilities: ['granola.personal.read'], status: 'healthy',
        toolCountMissing: 'counting',
      },
      {
        id: 'failed-discovery', modelPluginId: 'plugin_granola_2', connectorType: 'granola',
        scope: 'you', displayName: 'Granola archive', capabilities: ['granola.personal.read'], status: 'healthy',
        toolCountMissing: 'not_counted',
      },
      {
        id: 'unregistered', modelPluginId: 'plugin_linear', connectorType: 'linear',
        scope: 'you', displayName: 'Linear issues', capabilities: ['linear.read'], status: 'healthy',
        toolCountMissing: 'connector_unavailable',
      },
      {
        // As a region that predates the reason reports a disabled row.
        id: 'disabled-tools', modelPluginId: 'plugin_google_2', connectorType: 'google',
        scope: 'you', displayName: 'Disabled Google', capabilities: ['gmail.read'], status: 'disabled',
      },
    ]);
    renderSettings();
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Personal connections' });
    const row = (name: string) => within(table).getByText(name).closest('tr')!;

    await waitFor(() => expect(within(row('Google tools')).getByRole('cell', { name: '5' })).toBeVisible());
    // Zero is a count: a server that offers nothing reads 0, not a dash.
    expect(within(row('Empty server')).getByRole('cell', { name: '0' })).toHaveTextContent(/^0$/);
    // No count is not zero: each dash says which of its reasons it is.
    const dash = (name: string, label: string) => {
      const cell = within(row(name)).getByRole('cell', { name: label });
      expect(cell).toHaveTextContent(/^—$/);
      expect(cell).toHaveAttribute('title', label);
    };
    dash('Granola notes', 'No tool count yet: counting this connection’s tools');
    dash('Granola archive', 'No tool count: the last tool discovery did not succeed');
    dash('Linear issues', 'No tool count: this connector is not available in this region');
    dash('Disabled Google', 'No tool count: this connection is disabled');
    // One request draws the whole column.
    expect(api.getConnections).toHaveBeenCalledTimes(1);
  });

  it('shows the count a refetched list reports after the window is revealed again', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const listed = (toolCount: number) => [{
      id: 'tool-count-connection',
      modelPluginId: 'plugin_google',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google tools',
      capabilities: ['gmail.read'],
      status: 'healthy',
      toolCount,
    }];
    api.getConnections.mockResolvedValue(listed(7));
    renderSettings(workspace, client);
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Personal connections' });
    expect(await within(table).findByRole('cell', { name: '7' })).toBeVisible();

    ageCacheEntry(client, ['connections'], 30_000);
    api.getConnections.mockResolvedValue(listed(9));
    act(() => revealWindow());
    expect(await within(table).findByRole('cell', { name: '9' })).toBeVisible();
    expect(within(table).queryByRole('cell', { name: '7' })).not.toBeInTheDocument();
  });

  it('separates personal and organization connections into tables with scoped empty states', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      workspaceId: workspace.id,
      connectorType: 'google',
      scope: 'you',
      ownerUserId: owner.id,
      ownerName: owner.name,
      displayName: 'Google · adam@example.com',
      capabilities: ['gmail.read', 'calendar.read'],
      status: 'healthy',
      lastSyncAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      toolCount: 7,
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const connectionName = await within(screen.getByRole('main')).findByText('Google · adam@example.com');
    expect(connectionName).toBeVisible();
    expect(await screen.findByText('7')).toBeVisible();
    const personalTable = screen.getByRole('table', { name: 'Personal connections' });
    const workspaceTable = screen.getByRole('table', { name: 'Organization connections' });
    expect(personalTable.compareDocumentPosition(workspaceTable) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(personalTable).getByText('Google · adam@example.com')).toBeVisible();
    expect(within(workspaceTable).getByText('No organization connections yet')).toBeVisible();
    expect(within(workspaceTable).getByText(/Connect a connector below/iu)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    const connectionsHeading = screen.getByRole('heading', { level: 2, name: 'Your connections' });
    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(connectionsHeading.compareDocumentPosition(driveCard!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const filter = screen.getByRole('radiogroup', { name: 'Filter connections' });
    expect(within(filter).getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'Not connected',
      'Connected',
      'All',
    ]);
    expect(within(filter).getByRole('radio', { name: 'Not connected' })).toBeChecked();
    expect(screen.queryByText('Google Mail + Calendar')).not.toBeInTheDocument();
    // The table opens a connection rather than acting on it.
    expect(within(personalTable).queryByRole('button', { name: 'Refresh Google · adam@example.com' })).not.toBeInTheDocument();
    expect(within(personalTable).queryByRole('button', { name: 'Delete Google · adam@example.com' })).not.toBeInTheDocument();

    await openConnection('Google · adam@example.com');
    const reconnectButton = screen.getByRole('button', { name: 'Refresh Google · adam@example.com' });
    const disconnectButton = screen.getByRole('button', { name: 'Delete Google · adam@example.com' });
    fireEvent.click(reconnectButton);
    const dialog = await screen.findByRole('dialog', { name: 'Refresh Google · adam@example.com?' });
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(disconnectButton);
    const deleteDialog = await screen.findByRole('dialog', { name: 'Delete Google · adam@example.com?' });
    expect(api.disconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.disconnectConnection).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000010',
    ));

    openSettingsSection('Connections');
    fireEvent.click(await screen.findByRole('radio', { name: 'Connected' }));
    await waitFor(() => expect(screen.getByText('Google Mail + Calendar')).toBeVisible());
    expect(screen.queryByText('Google Drive + Docs + Sheets')).not.toBeInTheDocument();
  });

  it('renders generic webhooks in the installed list', async () => {
    let resolveRotation!: (value: {
      endpoint: string;
      signingSecret: string;
      signatureFormat: string;
    }) => void;
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      connectorType: 'generic_webhook',
      scope: 'workspace',
      displayName: 'Inbound webhook',
      capabilities: [],
      status: 'healthy',
    }]);
    api.rotateWebhookSecret.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRotation = resolve;
    }));
    renderSettings();
    openSettingsSection('Connections');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    expect(await screen.findByRole('table', { name: 'Organization connections' })).toBeVisible();
    expect(within(screen.getByRole('main')).getAllByText('Inbound webhook')).toHaveLength(2);
    await openConnection('Inbound webhook');
    const rotateButton = await screen.findByRole('button', { name: 'Refresh Inbound webhook' });
    expect(rotateButton).toBeVisible();
    fireEvent.focus(rotateButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Refresh this webhook by replacing its signing secret.',
    );
    fireEvent.click(rotateButton);
    const dialog = await screen.findByRole('dialog', { name: 'Refresh Inbound webhook?' });
    expect(api.rotateWebhookSecret).not.toHaveBeenCalled();
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.rotateWebhookSecret).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000099',
    ));
    expect(cancelButton).toBeDisabled();
    fireEvent.click(cancelButton);
    expect(dialog).toBeVisible();

    await act(async () => resolveRotation({
      endpoint: 'https://enterprise.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
      signingSecret: 'whsec_rotated-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    }));
    expect(await within(dialog).findByLabelText('Webhook endpoint')).toHaveValue(
      'https://enterprise.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
    );
    expect(within(dialog).getByLabelText('Webhook signing secret')).toHaveValue('whsec_rotated-secret');
  });

  it('allows members to refresh their personal connections while hiding organization controls', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · sam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }, {
      id: '00000000-0000-7000-8000-000000000011',
      connectorType: 'linear',
      scope: 'workspace',
      displayName: 'Linear · Rally',
      capabilities: ['linear.read'],
      status: 'healthy',
    }]);

    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Connections');

    expect(await within(screen.getByRole('main')).findByText('Google · sam@example.com')).toBeVisible();
    expect(within(screen.getByRole('main')).getByText('Linear · Rally')).toBeVisible();
    await openConnection('Google · sam@example.com');
    expect(screen.getByRole('button', { name: 'Refresh Google · sam@example.com' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete Google · sam@example.com' })).toBeVisible();
    openSettingsSection('Connections');
    await openConnection('Linear · Rally');
    expect(screen.queryByRole('button', { name: 'Refresh Linear · Rally' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Linear · Rally' })).not.toBeInTheDocument();
  });

  it('shows deletion failures inside the confirmation dialog', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    api.disconnectConnection.mockRejectedValueOnce(new ApiError(
      'The connection could not be deleted. Try again.',
      503,
      'connection_delete_failed',
    ));
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Google · adam@example.com');
    const deleteButton = await screen.findByRole('button', { name: 'Delete Google · adam@example.com' });
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole('dialog', { name: 'Delete Google · adam@example.com?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('The connection could not be deleted. Try again.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('lets an owner create, copy, and revoke an invite', async () => {
    renderSettings();
    openSettingsSection('Organization');

    expect(await screen.findByText('Sam', undefined, { timeout: 10_000 })).toBeVisible();
    expect(await screen.findByText('Sam', undefined, { timeout: 10_000 })).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
      target: { value: 'new-admin@example.com' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(
      () => expect(api.createWorkspaceInvitation).toHaveBeenCalledWith('new-admin@example.com', 'admin'),
      { timeout: 10_000 },
    );
    expect(await screen.findByText('Invitation emailed', undefined, { timeout: 10_000 })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy invite link' }, { timeout: 10_000 }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(inviteUrl), { timeout: 10_000 });

    fireEvent.click(screen.getByRole('button', { name: `Revoke invitation for ${invitation.email}` }));
    await waitFor(
      () => expect(api.revokeWorkspaceInvitation).toHaveBeenCalledWith(invitation.id),
      { timeout: 10_000 },
    );
  }, 30_000);

  /**
   * The viewer this PR exists for: an administrator who is **not** the owner.
   *
   * Rendering the owner here would keep this test green against a renderer that
   * had regressed to owner-only, which is precisely the behaviour under test.
   */
  it('lets an administrator who is not the owner promote, demote, and invite another administrator', async () => {
    api.setWorkspaceMemberRole.mockResolvedValue(undefined);
    api.getWorkspaceMembers.mockResolvedValue([owner, secondAdmin, member, namesake]);
    renderSettings({ ...workspace, currentUser: secondAdmin });
    openSettingsSection('Organization');
    expect(await screen.findAllByText('Sam')).toHaveLength(2);

    // One menu per eligible row, each with an accessible name only that row
    // can answer to. `Sam` appears twice on purpose: a name alone would leave a
    // screen-reader user unable to tell the two rows apart. The owner's menu is
    // disabled: theirs is the one role the server refuses to reassign or remove.
    const names = screen.getAllByRole('button', { name: /member actions$/ }).map((control) => control.getAttribute('aria-label'));
    expect(screen.getByRole('button', { name: 'Adam (adam@example.com) member actions' })).toBeDisabled();
    expect(names).toEqual([
      'Adam (adam@example.com) member actions',
      'Riley (riley@example.com) member actions',
      'Sam (sam@example.com) member actions',
      'Sam (sam.reed@example.com) member actions',
    ]);

    await openMemberActions('Sam (sam@example.com) member actions');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make administrator' }));
    await waitFor(
      () => expect(api.setWorkspaceMemberRole).toHaveBeenCalledWith(member.id, 'admin'),
      { timeout: 10_000 },
    );
    // The viewer's own row offers the role change but not Suspend: the server
    // refuses removing yourself, and leaving is its own control.
    await openMemberActions('Riley (riley@example.com) member actions');
    expect(screen.queryByRole('menuitem', { name: 'Suspend' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove administrator' }));
    await waitFor(
      () => expect(api.setWorkspaceMemberRole).toHaveBeenCalledWith(secondAdmin.id, 'member'),
      { timeout: 10_000 },
    );

    // The other half of the same change: inviting an administrator was the
    // owner's alone, and an administrator now has that option too.
    expect(within(screen.getByRole('combobox', { name: 'Role' })).getByRole('option', { name: 'Administrator' }))
      .toBeInTheDocument();
  });

  it('offers an ordinary member no member-role controls at all', async () => {
    api.getWorkspaceMembers.mockResolvedValue([owner, secondAdmin, member, namesake]);
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Organization');
    expect(await screen.findByText('Adam')).toBeVisible();
    expect(screen.queryByRole('button', { name: /member actions$/ })).not.toBeInTheDocument();
  });

  it('lists members by name, then guests by name, ignoring case', async () => {
    const guestZed = { ...member, id: 'user-5', name: 'Aaron', email: 'Zed@example.com', accessClass: 'guest' as const, role: null };
    const guestBo = { ...member, id: 'user-6', name: 'zz', email: 'bo@example.com', accessClass: 'guest' as const, role: null };
    const lowerName = { ...member, id: 'user-7', name: 'bea', email: 'bea@example.com' };
    api.getWorkspaceMembers.mockResolvedValue([guestZed, member, owner, guestBo, lowerName, secondAdmin]);
    renderSettings();
    openSettingsSection('Organization');
    expect(await screen.findByText('Riley')).toBeVisible();
    const rows = Array.from(document.querySelectorAll('.settings-member-list .settings-member-row strong'))
      .map((name) => name.textContent);
    expect(rows).toEqual(['Adam', 'bea', 'Riley', 'Sam', 'Aaron', 'zz']);
  });

  it('suspends a member after confirmation and refreshes the roster', async () => {
    api.removeWorkspaceMember.mockImplementationOnce(async () => {
      api.getWorkspaceMembers.mockResolvedValue([owner]);
    });
    api.getWorkspaceMembers.mockResolvedValue([owner, member]);
    renderSettings();
    openSettingsSection('Organization');
    await openMemberActions('Sam (sam@example.com) member actions');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Sam?' });
    expect(api.removeWorkspaceMember).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(api.removeWorkspaceMember).toHaveBeenCalledWith(workspace.id, member.id));
    await waitFor(() => expect(screen.queryByText('Sam')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Suspend Sam?' })).not.toBeInTheDocument();
  });

  it('keeps the person when Suspend is cancelled, and lets a failed suspension be retried', async () => {
    api.getWorkspaceMembers.mockResolvedValue([owner, member]);
    api.removeWorkspaceMember
      .mockRejectedValueOnce(new ApiError('The workspace membership changed. Check it and try again.', 409, 'membership_changed'))
      .mockImplementationOnce(async () => { api.getWorkspaceMembers.mockResolvedValue([owner]); });
    renderSettings();
    openSettingsSection('Organization');

    await openMemberActions('Sam (sam@example.com) member actions');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Suspend' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Suspend Sam?' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Suspend Sam?' })).not.toBeInTheDocument());
    expect(api.removeWorkspaceMember).not.toHaveBeenCalled();

    await openMemberActions('Sam (sam@example.com) member actions');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Sam?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('The workspace membership changed. Check it and try again.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getAllByText('Sam').length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(api.removeWorkspaceMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Suspend Sam?' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Sam')).not.toBeInTheDocument());
  });

  it('does not expose invitation management to regular members', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Organization');
    expect(await screen.findByText('Adam')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).not.toBeInTheDocument();
    expect(api.getWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it('confirms leaving an organization without describing it as deleted', async () => {
    renderSettings();
    openSettingsSection('Organization');

    const leave = await screen.findByRole('button', { name: 'Leave this organization' });
    fireEvent.click(leave);

    const dialog = await screen.findByRole('dialog', { name: 'Leave Rally Studio?' });
    expect(within(dialog).getByText('Rally Studio stays available to its other members.')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave organization' }));

    await waitFor(() => expect(leaveWorkspace).toHaveBeenCalledWith(workspace.id, 'left'));
  });

  it('warns that the last member will close the organization', async () => {
    api.getWorkspaceMembers.mockResolvedValue([owner]);
    leaveWorkspace.mockResolvedValue({ outcome: 'abandoned' });
    renderSettings();
    openSettingsSection('Organization');

    const leave = await screen.findByRole('button', { name: 'Leave and close organization' });
    fireEvent.click(leave);

    const dialog = await screen.findByRole('dialog', { name: 'Leave and close Rally Studio?' });
    expect(within(dialog).getByText(
      'You are the last member. Rally Studio will close, and nobody will be able to open it again.',
    )).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave and close' }));

    await waitFor(() => expect(leaveWorkspace).toHaveBeenCalledWith(workspace.id, 'abandoned'));
  });

  it('searches individual settings without switching panes until a result is selected', async () => {
    renderSettings();
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'organization' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Organization Organization' }));
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-setting-id', 'workspaceIdentity'));
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
    fireEvent.change(search, { target: { value: 'does not exist' } });
    expect(screen.getByText('No settings found')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
  });

  it('selects a macOS app icon with an immediate jump state', async () => {
    renderSettings();
    openSettingsSection('Application');

    const ludicrous = await screen.findByRole('button', { name: 'Ludicrous speed app icon' });
    // The tiles render immediately, disabled and pressed on the 'light' fallback, and only
    // become the saved selection once the picker's getApplicationIcon() promise resolves.
    // Waiting for Dark to be pressed keeps the click off that race, and is also the point
    // at which the tiles stop being disabled.
    await screen.findByRole('button', { name: 'Dark app icon', pressed: true });
    fireEvent.click(ludicrous);

    expect(ludicrous).toHaveClass('is-jumping');
    expect(ludicrous).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(setApplicationIcon).toHaveBeenCalledWith('ludicrous'));
    expect(await screen.findByText('Ludicrous speed is selected.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Use the system icon' }));
    await waitFor(() => expect(resetApplicationIcon).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Using dark automatically with the system appearance.')).toBeVisible();
  });

  it('starts every connection in a browser but the desktop-only ones, and points at the Mac app for those', async () => {
    sessionHost.current = 'browser';
    renderSettings();
    openSettingsSection('Connections');

    const linear = (await screen.findByText('Linear')).closest('.provider-card') as HTMLElement;
    await waitFor(() => expect(within(linear).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
    expect(within(linear).queryByText('Download the Mac app to connect this.')).toBeNull();
    const canva = screen.getByText('Canva').closest('.provider-card') as HTMLElement;
    expect(within(canva).getByRole('link', { name: 'Download the Mac app to connect this.' })).toBeVisible();
    for (const button of within(canva).getAllByRole('button')) expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps an installed desktop-only connection from refreshing in a browser', async () => {
    sessionHost.current = 'browser';
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000011',
      connectorType: 'canva',
      scope: 'you',
      displayName: 'Canva · adam@example.com',
      capabilities: ['canva.personal.mcp'],
      status: 'reconnect_required',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    await openConnection('Canva · adam@example.com');
    const refresh = await screen.findByRole('button', { name: 'Refresh Canva · adam@example.com' });
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(refresh);
    expect(screen.queryByRole('dialog', { name: 'Refresh Canva · adam@example.com?' })).toBeNull();
  });

  it('offers browser notifications in a browser and says when this browser cannot show them', async () => {
    sessionHost.current = 'browser';
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    renderSettings();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('heading', { name: 'In this browser' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'On this Mac' })).toBeNull();
    // jsdom has no service worker, which is exactly the unsupported browser.
    expect(await screen.findByText('This browser cannot show Rally notifications.')).toBeVisible();
    expect(screen.getByRole('switch', { name: /Show notifications/ })).toBeDisabled();
  });

  it('tells an iOS Safari tab to add Rally to the Home Screen for notifications', async () => {
    // An iOS Safari tab: no service worker push, and navigator.standalone is false.
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
    try {
      sessionHost.current = 'browser';
      api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
      renderSettings();
      const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
      fireEvent.click(await within(navigation).findByRole('button', { name: 'Notifications' }));
      expect(await screen.findByText(/tap Share, then Add to Home Screen/)).toBeVisible();
      expect(screen.queryByText('This browser cannot show Rally notifications.')).toBeNull();
      expect(screen.getByRole('switch', { name: /Show notifications/ })).toBeDisabled();
    } finally {
      Reflect.deleteProperty(navigator, 'standalone');
    }
  });

  it.each([
    ['denied', 'unknown', 'Turned off in macOS'],
    ['enabled', 'disabled', 'Badges turned off in macOS'],
  ] as const)('sends a Mac with notifications %s and badges %s to System Settings', async (status, badge, copy) => {
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    getApplicationSettings.mockResolvedValue(applicationSettings({
      pushNotificationStatus: status, notificationBadgeStatus: badge,
    }));
    renderSettings();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .findByRole('button', { name: 'Notifications' }));

    const notice = (await screen.findByText(copy)).closest('.settings-preference-row') as HTMLElement;
    fireEvent.click(within(notice).getByRole('button', { name: 'Open System Settings' }));
    expect(openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('says nothing about badges while macOS allows them', async () => {
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true }));
    getApplicationSettings.mockResolvedValue(applicationSettings({
      pushNotificationStatus: 'enabled', notificationBadgeStatus: 'enabled',
    }));
    renderSettings();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('heading', { name: 'On this Mac' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull();
  });

  it('drops the Desktop app section in a browser and offers appearance under Account', async () => {
    sessionHost.current = 'browser';
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeVisible();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).queryByRole('button', { name: 'Application' })).toBeNull();
    expect(within(navigation).queryByText('Desktop app')).toBeNull();
  });

  it('returns to the workspace instead of closing a browser tab', async () => {
    sessionHost.current = 'browser';
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.location.hash = '#/settings';
    renderSettings(workspace, createTestQueryClient(), true);

    fireEvent.click(await screen.findByRole('button', { name: 'Close settings' }));
    expect(window.location.hash).toBe('#/');
    window.location.hash = '#/settings';
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(window.location.hash).toBe('#/');
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it('toggles Lockdown mode for the saved authentication session', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
  });

  it('shows the automatic off state when the operating-system keystore is unavailable', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Lockdown mode is off because this Mac’s keystore is unavailable.'))
      .toBeVisible();
  });

  it('still allows an in-app off transition from a stale unavailable-keystore state', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: true,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);

    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(false));
  });

  it('toggles the menu bar item from Appearance, on by default and above the icon picker', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Show Rally in the menu bar' });
    expect(toggle).toBeChecked();

    // Above the app icon, inside Appearance: the row has to precede the picker
    // in the document, which is what decides where it lands on screen.
    const picker = screen.getByRole('group', { name: 'App icon' });
    expect(toggle.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(setMenuBarEnabled).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setMenuBarEnabled).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();
  });

  it('toggles opening at login from Startup, and offers it nowhere in the menu bar', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Open Rally at login' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setLaunchAtLogin).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setLaunchAtLogin).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();
  });

  it('defaults to Stable and switches this Mac to the Faster update channel', async () => {
    renderSettings();
    openSettingsSection('Application');

    const channel = await screen.findByRole('combobox', { name: 'Update channel' });
    expect(channel).toHaveTextContent('Stable');
    fireEvent.click(channel);
    fireEvent.click(screen.getByRole('option', { name: /Faster/u }));

    await waitFor(() => expect(setReleaseChannel).toHaveBeenCalledWith('faster'));
    expect(channel).toHaveTextContent('Faster');
  });

  it('controls product analytics and explains regional crash behavior', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Product analytics' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setProductAnalyticsEnabled).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Restart Rally to remove local native crash dumps and apply the current setting/u)).toBeVisible();
  });

  it('answers About with the app version and nothing a developer would ask', async () => {
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByRole('heading', { name: 'About' })).toBeVisible();
    const about = screen.getByRole('heading', { name: 'About' }).parentElement!.nextElementSibling!;
    expect(within(about as HTMLElement).getByText('Version')).toBeVisible();
    expect(within(about as HTMLElement).getByText('0.1.0')).toBeVisible();
    // Build channel, platform, the API base URL and the socket's reconnect
    // strategy are debugging facts, and the API base URL named the region's
    // host on a pane anyone can open.
    for (const retired of ['Build', 'Platform', 'Regional API', 'Realtime']) {
      expect(screen.queryByText(retired), retired).not.toBeInTheDocument();
    }
    expect(screen.queryByText('https://enterprise.api.rallywith.ai')).not.toBeInTheDocument();
  });

  it('offers no telemetry inspector in the staff-only Developer section', async () => {
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByRole('switch', { name: 'Debug enabled' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Telemetry inspector' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh telemetry inspector' })).not.toBeInTheDocument();
  });

  it('finds Privacy and diagnostics from telemetry-related settings searches', async () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'crash' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Product analytics Application' }));
    expect(await screen.findByRole('heading', { name: 'Privacy & diagnostics' })).toBeVisible();
  });

  it('disables the account preference on a browser bridge that cannot persist it', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: false,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: false,
      menuBarPresent: false,
      launchAtLogin: false,
      launchAtLoginAvailable: false,
      productAnalyticsEnabled: true,
      productAnalyticsAvailable: false,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByRole('switch', { name: 'Product analytics' })).toBeDisabled();
    expect(screen.getByText('Product analytics is managed in the Rally desktop app.')).toBeVisible();
  });

  it('reports what macOS holds rather than what was asked for', async () => {
    // A registration macOS is still waiting to have approved leaves the login
    // item off. Showing the toggle on because the write succeeded would tell
    // someone Rally opens at login when it does not.
    setLaunchAtLogin.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Open Rally at login' });
    fireEvent.click(toggle);

    await waitFor(() => expect(setLaunchAtLogin).toHaveBeenCalled());
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('offers no login toggle where there are no login items', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: false,
      launchAtLoginAvailable: false,
    });
    renderSettings();
    openSettingsSection('Application');

    await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(screen.queryByRole('switch', { name: 'Open Rally at login' })).toBeNull();
  });

  it('says so when the status item could not be added, instead of a switch beside an empty menu bar', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      // The write succeeded; creating the item did not.
      menuBarPresent: false,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByRole('switch', { name: 'Show Rally in the menu bar' })).toBeChecked();
    expect(await screen.findByText(/could not add itself to the menu bar/u)).toBeVisible();
  });

  it('says nothing about a missing status item while the preference is off', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: false,
      menuBarAvailable: true,
      menuBarPresent: false,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByRole('switch', { name: 'Show Rally in the menu bar' })).not.toBeChecked();
    expect(screen.queryByText(/could not add itself to the menu bar/u)).toBeNull();
  });

  it('offers no menu bar toggle where there is no menu bar to put Rally in', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: false,
      menuBarPresent: false,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');

    // The settings shell renders disabled controls while its bridge read is in
    // flight, so another switch merely existing does not prove availability
    // has loaded. First observe a control become interactive as the positive
    // readiness signal, then assert that the unavailable control disappeared.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Lockdown mode' })).toBeEnabled());
    expect(screen.queryByRole('switch', { name: 'Show Rally in the menu bar' })).toBeNull();
  });

  it('toggles the Developer debug preference and leaves it off by default', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Debug enabled' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(setDebugEnabled).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setDebugEnabled).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
  });

  it('does not answer a search for "debug" with a pane that has no Developer section', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: false,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    await screen.findByRole('navigation', { name: 'Settings sections' });
    const search = screen.getByRole('searchbox', { name: 'Search settings' });

    fireEvent.change(search, { target: { value: 'debug' } });
    expect(screen.getByText('No settings found')).toBeVisible();

    // The same search finds it once the section is actually on offer.
    act(() => {
      for (const listener of applicationSettingsListeners) {
        listener({
          lockdownMode: false,
          lockdownAvailable: true,
          debugEnabled: false,
          developerSettingsAvailable: true,
        });
      }
    });
    expect(screen.getByRole('button', { name: 'Debug enabled Application' })).toBeVisible();
  });

  it('offers no Developer section when the service has not enabled the flag', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      // A stored preference the service does not stand behind. The main process
      // reports the effective value, so this reads off however the file reads.
      debugEnabled: false,
      developerSettingsAvailable: false,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');

    // The rest of the pane is there; only the flagged section is absent.
    expect(await screen.findByRole('switch', { name: 'Lockdown mode' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Developer' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();
  });

  it('reveals and withdraws the Developer section as the polled flag changes', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: false,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');
    await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();

    announceApplicationSettings({
      releaseChannel: 'stable',
      releaseChannelAvailable: true,
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: true,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    expect(screen.getByRole('switch', { name: 'Debug enabled' })).toBeChecked();

    // The flag going off takes the section with it, without a reload, and takes
    // the effective preference to off on the way past.
    announceApplicationSettings({
      releaseChannel: 'stable',
      releaseChannelAvailable: true,
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: false,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();
  });

  it.each([
    { liveEnabled: true, staleEnabled: false },
    { liveEnabled: false, staleEnabled: true },
  ])(
    'keeps the live Developer value $liveEnabled when an older $staleEnabled snapshot settles',
    async ({ liveEnabled, staleEnabled }) => {
      let resolveInitial!: (settings: DesktopApplicationSettings) => void;
      getApplicationSettings.mockReturnValue(new Promise((resolve) => {
        resolveInitial = resolve;
      }));
      renderSettings();
      openSettingsSection('Application');
      await waitFor(() => expect(applicationSettingsListeners.size).toBe(1));

      const settings = (enabled: boolean): DesktopApplicationSettings => applicationSettings({
        debugEnabled: enabled,
        developerSettingsAvailable: enabled,
      });
      announceApplicationSettings(settings(liveEnabled));
      expect(screen.queryByRole('switch', { name: 'Debug enabled' }) !== null).toBe(liveEnabled);

      await act(async () => {
        resolveInitial(settings(staleEnabled));
        await Promise.resolve();
      });
      expect(screen.queryByRole('switch', { name: 'Debug enabled' }) !== null).toBe(liveEnabled);
    },
  );

  it('keeps a live flag withdrawal when an older settings mutation settles afterward', async () => {
    let resolveMutation!: (settings: DesktopApplicationSettings) => void;
    setDebugEnabled.mockReturnValue(new Promise((resolve) => {
      resolveMutation = resolve;
    }));
    renderSettings();
    openSettingsSection('Application');
    const debugToggle = await screen.findByRole('switch', { name: 'Debug enabled' });

    fireEvent.click(debugToggle);
    await waitFor(() => expect(setDebugEnabled).toHaveBeenCalledWith(true));
    announceApplicationSettings(applicationSettings({
      debugEnabled: false,
      developerSettingsAvailable: false,
    }));
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();

    await act(async () => {
      resolveMutation(applicationSettings({ debugEnabled: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();
  });

  it('clears an existing application-settings load error when a live value arrives', async () => {
    getApplicationSettings.mockRejectedValue(new Error('Application settings could not be read.'));
    renderSettings();
    openSettingsSection('Application');
    expect(await screen.findByText('Application settings could not be read.')).toBeVisible();

    announceApplicationSettings(applicationSettings());
    expect(screen.queryByText('Application settings could not be read.')).toBeNull();
  });

  it('does not surface a stale read failure after a live value arrives', async () => {
    let rejectInitial!: (error: Error) => void;
    getApplicationSettings.mockReturnValue(new Promise((_resolve, reject) => {
      rejectInitial = reject;
    }));
    renderSettings();
    openSettingsSection('Application');
    await waitFor(() => expect(applicationSettingsListeners.size).toBe(1));

    announceApplicationSettings(applicationSettings());
    await act(async () => {
      rejectInitial(new Error('Application settings could not be read.'));
      await Promise.resolve();
    });
    expect(screen.queryByText('Application settings could not be read.')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Debug enabled' })).toBeVisible();
  });

  it('shows application-setting load failures inline', async () => {
    getApplicationSettings.mockRejectedValue(new Error('Application settings could not be read.'));
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByText('Application settings could not be read.')).toBeVisible();
  });
});

describe('Closing the settings window with Escape', () => {
  let close: MockInstance<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    api.getWorkspaceMembers.mockResolvedValue([owner]);
    api.getWorkspaceInvitations.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    api.getAvailableConnectorTypes.mockResolvedValue([]);
    api.getTerminalWorkspaceSettings.mockResolvedValue({
      availability: 'supported', mode: 'trusted_only', revision: 1, verificationState: 'verified',
      customDomains: [], remainingCustomSlots: 7, failureCode: null,
    });
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({}));
    api.getDigestSchedule.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      enabled: true,
      days: [1, 2, 3, 4, 5],
      times: [9 * 60],
      timezone: 'Europe/London',
      deliveryTargets: [
        { type: 'email', connectionId: null, displayName: 'adam@rally.local', status: 'active', lastDeliveredAt: null },
      ],
      nextRunAt: null,
      lastDeliveredAt: null,
    });
    getApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
  });

  it('closes the settings window', () => {
    renderSettings(workspace, createTestQueryClient(), true);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves the main window open when settings is a route inside it', () => {
    // Away from Electron the same screen is a route in the only window there
    // is, and Escape there would close the workspace rather than a panel.
    renderSettings(workspace, createTestQueryClient(), false);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(close).not.toHaveBeenCalled();
  });

  it('keeps typing that has nowhere else to come from', () => {
    renderSettings(workspace, createTestQueryClient(), true);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });

    fireEvent.change(search, { target: { value: 'connections' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();

    // An empty field holds nothing to lose, so the window still closes.
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps an invitation draft the caret has already left', async () => {
    renderSettings(workspace, createTestQueryClient(), true);
    openSettingsSection('Organization');

    const email = await screen.findByPlaceholderText('teammate@company.com');
    fireEvent.change(email, { target: { value: 'teammate@company.com' } });

    // Typing the address and reaching for the Role select or Send is the normal
    // way to fill this in; the draft is no less unsaved for the caret moving.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Role' }), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();

    fireEvent.change(email, { target: { value: '' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('still closes from every section when nothing has been typed', async () => {
    renderSettings(workspace, createTestQueryClient(), true);

    // The pane sweep asks the panes a question about themselves: the first one
    // to render a saved value into a writable text field would make Escape
    // permanently dead in that section, and the symptom is a key that quietly
    // stopped working rather than a failing assertion anywhere near the cause.
    for (const section of ['Account', 'Notifications', 'Organization', 'Security', 'Connections', 'Application'] as const) {
      openSettingsSection(section);
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(section));

      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(close, `Escape is dead in ${section}`).toHaveBeenCalled();
      close.mockClear();
    }
  });

  it('closes over persisted Terminal domains until the draft actually changes', async () => {
    api.getTerminalWorkspaceSettings.mockResolvedValue({
      availability: 'supported', mode: 'trusted_only', revision: 3, verificationState: 'verified',
      customDomains: ['packages.example.com'], remainingCustomSlots: 6, failureCode: null,
    });
    renderSettings(workspace, createTestQueryClient(), true);
    openSettingsSection('Security');
    const domains = await screen.findByLabelText('Additional Terminal domains');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();

    fireEvent.change(domains, { target: { value: 'packages.example.com\nnew.example.com' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('dismisses an open dialog without taking the window with it', async () => {
    api.getAvailableConnectorTypes.mockResolvedValue(['granola']);
    renderSettings(workspace, createTestQueryClient(), true);
    openSettingsSection('Connections');

    const granolaCard = (await screen.findByText('Granola')).closest('article');
    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect for organization'));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Granola workspace' });

    // Radix closes the dialog on this keystroke itself. The window listener sees
    // the same event, and closing over a confirmation is exactly what the guard
    // on dismissable layers exists to prevent.
    fireEvent.keyDown(within(dialog).getByLabelText('Workspace API key'), { key: 'Escape' });

    expect(close).not.toHaveBeenCalled();
  });
});
