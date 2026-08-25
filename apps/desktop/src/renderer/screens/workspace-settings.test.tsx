import * as Tooltip from '@radix-ui/react-tooltip';
import { ClientFeatureFlagsSchema } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { ApiError } from '../lib/api';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from '../lib/use-client-feature-flags';
import type { Workspace, WorkspaceInvitation } from '../lib/types';
import { escapeClosesSettings, WorkspaceSettingsScreen } from './workspace-settings';

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConnections: vi.fn(),
  getGitHubRepositoryAccessSettings: vi.fn(),
  updateGitHubRepositoryAccessSettings: vi.fn(),
  getAvailableConnectorTypes: vi.fn(),
  createGranolaWorkspaceConnection: vi.fn(),
  createWebhookConnection: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  createXConnection: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  startProviderConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  getTerminalWorkspaceSettings: vi.fn(),
  previewTerminalNetworkPolicy: vi.fn(),
  applyTerminalNetworkPolicy: vi.fn(),
  getDigestSchedule: vi.fn(),
  updateDigestSchedule: vi.fn(),
  clientFeatureFlags: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
const getApplicationIcon = vi.hoisted(() => vi.fn());
const setApplicationIcon = vi.hoisted(() => vi.fn());
const resetApplicationIcon = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn());
const setLockdownMode = vi.hoisted(() => vi.fn());
const setDebugEnabled = vi.hoisted(() => vi.fn());
const setMenuBarEnabled = vi.hoisted(() => vi.fn());
const setLaunchAtLogin = vi.hoisted(() => vi.fn());
const setProductAnalyticsEnabled = vi.hoisted(() => vi.fn());
const getTelemetryInspector = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const applicationSettingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());
const settingsSectionRequest = vi.hoisted(() => ({
  listener: null as ((section: string) => void) | null,
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({
    api,
    runtime: {
      appVersion: '0.1.0',
      isPackaged: false,
      platform: 'darwin',
      api: { global: 'https://api.rallywith.ai', eu: 'https://eu.api.rallywith.ai' },
      devAuthEnabled: true,
    },
    session: { apiBaseUrl: 'https://eu.api.rallywith.ai' },
    signOut,
  }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getApplicationSettings,
    setLockdownMode,
    setDebugEnabled,
    setMenuBarEnabled,
    setLaunchAtLogin,
    setProductAnalyticsEnabled,
    getTelemetryInspector,
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettingsListeners.add(listener);
      return () => applicationSettingsListeners.delete(listener);
    },
    getApplicationIcon,
    setApplicationIcon,
    resetApplicationIcon,
    onApplicationIconChanged: () => () => undefined,
    openExternal,
    onSettingsSectionRequested: (listener: (section: string) => void) => {
      settingsSectionRequest.listener = listener;
      return () => {
        if (settingsSectionRequest.listener === listener) settingsSectionRequest.listener = null;
      };
    },
  }),
}));

const owner = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles', role: 'owner' };
const member = { id: 'user-2', name: 'Sam', email: 'sam@example.com', timezone: 'America/Los_Angeles', role: 'member' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Rally Studio',
  region: 'eu',
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
const inviteUrl = 'https://rallywith.ai/invite/#region=eu&token=private-token-value-long-enough';

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
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={client}>
        <WorkspaceSettingsScreen standaloneWindow={standaloneWindow} workspace={nextWorkspace} />
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

function openSettingsSection(name: 'Account' | 'Digest' | 'Workspace' | 'Connections' | 'GitHub' | 'Application'): void {
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}

describe('Workspace settings', () => {
  beforeEach(() => {
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
    api.getWorkspaceInvitations.mockResolvedValue([invitation]);
    api.getConnections.mockResolvedValue([]);
    // Every existing test in this file was written before digestsEnabled
    // existed and expects the section to be there; a test that cares about it
    // being hidden overrides this with its own resolved value.
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
      'generic_webhook', 'github', 'google', 'granola', 'linear', 'notion', 'slack', 'x',
    ]);
    api.createGranolaWorkspaceConnection.mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000018',
      connectorType: 'granola',
      scope: 'workspace',
      displayName: 'Granola workspace',
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
      endpoint: 'https://eu.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000019',
      signingSecret: 'whsec_one-time-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    });
    api.rotateWebhookSecret.mockResolvedValue({
      endpoint: 'https://eu.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
      signingSecret: 'whsec_rotated-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    });
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
    api.getTerminalWorkspaceSettings.mockResolvedValue({
      availability: 'supported', mode: 'trusted_only', revision: 1, verificationState: 'verified',
      customDomains: [], remainingCustomSlots: 7, failureCode: null,
    });
    api.previewTerminalNetworkPolicy.mockResolvedValue({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1,
      proposedMode: 'full_internet', customDomains: [], remainingCustomSlots: 7,
      affectedWorkstreamIds: ['00000000-0000-7000-8000-000000000091'],
      affectedWorkstreams: [{ id: '00000000-0000-7000-8000-000000000091', title: 'Customer export' }],
      warning: 'Full internet lets Terminal code contact arbitrary public destinations.',
    });
    api.applyTerminalNetworkPolicy.mockResolvedValue({
      availability: 'supported', mode: 'full_internet', revision: 2, verificationState: 'verified',
      customDomains: [], remainingCustomSlots: 7, failureCode: null,
    });
    copyText.mockResolvedValue(undefined);
    openExternal.mockResolvedValue(undefined);
    getApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    });
    setLockdownMode.mockImplementation(async (lockdownMode: boolean) => ({
      lockdownMode,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    }));
    setDebugEnabled.mockImplementation(async (debugEnabled: boolean) => ({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled: true,
      productAnalyticsEffective: true,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: false,
    }));
    setMenuBarEnabled.mockImplementation(async (menuBarEnabled: boolean) => ({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      menuBarEnabled,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    }));
    setLaunchAtLogin.mockImplementation(async (launchAtLogin: boolean) => ({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin,
      launchAtLoginAvailable: true,
    }));
    setProductAnalyticsEnabled.mockImplementation(async (productAnalyticsEnabled: boolean) => ({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      productAnalyticsEnabled,
      productAnalyticsEffective: productAnalyticsEnabled,
      productAnalyticsPreferencePending: false,
      nativeCrashRestartRequired: !productAnalyticsEnabled,
    }));
    getTelemetryInspector.mockResolvedValue([{
      name: 'screen_viewed', schemaVersion: 1, policyClass: 'product',
      propertyNames: ['screen'], route: 'eu', validation: 'accepted', queueState: 'queued',
    }]);
    setApplicationIcon.mockImplementation(async (activeIcon: string) => ({
      activeIcon,
      isAutomatic: false,
      supported: true,
    }));
    resetApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
  });

  it('previews and confirms full Terminal internet access before applying it', async () => {
    renderSettings();
    openSettingsSection('Workspace');
    expect(await screen.findByText('Terminal network access')).toBeVisible();
    // The heading and the radio group settle on different ticks, so the sync
    // query raced the render and failed under full-suite load. The same query
    // is already awaited below.
    const fullInternet = await screen.findByRole('radio', { name: /^Full internet/ });
    fireEvent.click(fullInternet);
    await waitFor(() => expect(fullInternet).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));

    expect(await screen.findByText(/arbitrary public destinations/u)).toBeVisible();
    expect(api.previewTerminalNetworkPolicy).toHaveBeenCalledWith({
      expectedRevision: 1, mode: 'full_internet', customDomains: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm network change' }));
    await waitFor(() => expect(api.applyTerminalNetworkPolicy).toHaveBeenCalledWith({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1, confirmed: true,
    }));
  });

  it('keeps Rally-managed Trusted-only domains out of the settings surface', async () => {
    api.previewTerminalNetworkPolicy.mockResolvedValueOnce({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1,
      proposedMode: 'trusted_only', customDomains: ['packages.example.com'],
      remainingCustomSlots: 6,
      affectedWorkstreamIds: [], affectedWorkstreams: [],
      warning: 'Trusted only applies managed and workspace-approved access.',
    });
    renderSettings();
    openSettingsSection('Workspace');

    expect(await screen.findByText('Workspace-approved domains')).toBeVisible();
    expect(screen.queryByText('Required targets')).not.toBeInTheDocument();
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText('Additional Terminal domains'), {
      target: { value: 'packages.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));
    fireEvent.click(await screen.findByText('Review exact before and after targets'));
    expect(await screen.findAllByText('packages.example.com')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download workspace domains' })).toBeVisible();
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
  });

  it('reports stopped and quarantined work streams after provider verification fails', async () => {
    api.applyTerminalNetworkPolicy.mockRejectedValueOnce(new ApiError(
      'Daytona did not confirm the requested network policy.',
      502,
      'terminal_policy_verification_failed',
      {
        sandboxOutcomes: [
          { workstreamId: '00000000-0000-7000-8000-000000000091', title: 'Customer export', outcome: 'stopped' },
          { workstreamId: '00000000-0000-7000-8000-000000000092', title: 'Weekly report', outcome: 'quarantined' },
        ],
      },
    ));
    renderSettings();
    openSettingsSection('Workspace');
    fireEvent.click(await screen.findByRole('radio', { name: /^Full internet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm network change' }));

    expect(await screen.findByText('Sandbox outcomes')).toBeVisible();
    expect(screen.getByText('Customer export: stopped')).toBeVisible();
    expect(screen.getByText('Weekly report: quarantined')).toBeVisible();
  });

  it('opens the exact section requested by a native settings-window URL', async () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=workspace#/settings');
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
    expect(await screen.findByText('Sam')).toBeVisible();
  });

  it('adds a nested GitHub settings page only for a configurable active connection', async () => {
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
    const githubNavigation = await within(navigation).findByRole('button', { name: 'GitHub' });
    expect(githubNavigation).toHaveClass('settings-navigation-child');
    fireEvent.click(githubNavigation);

    expect(await screen.findByRole('heading', { level: 2, name: 'Repository access' })).toBeVisible();
    expect(await screen.findByText('juno-ai-labs/rally')).toBeVisible();
    expect(screen.getByText(/Read-only still allows Rally to edit and commit locally/u)).toBeVisible();
    expect(api.getGitHubRepositoryAccessSettings).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000020',
      expect.any(AbortSignal),
    );
  });

  it('shows workspace GitHub policy read-only to non-admin members', async () => {
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
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub' }));

    expect(await screen.findByText(/Ask a workspace administrator to change it/u)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Repository availability' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Default remote access' })).toBeDisabled();
  });

  it('lets a member switch from a workspace GitHub policy to personal settings', async () => {
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
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub' }));

    const connection = await screen.findByRole('combobox', { name: 'GitHub connection' });
    expect(connection).toBeEnabled();
    fireEvent.change(connection, { target: { value: personalConnectionId } });

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
    fireEvent.click(await within(navigation).findByRole('button', { name: 'GitHub' }));

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

  it('refreshes members whenever settings opens even when the cached list is fresh', async () => {
    const client = createTestQueryClient();
    client.setQueryData(['workspace-members'], [owner]);

    renderSettings(workspace, client);
    openSettingsSection('Workspace');

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

  it('falls back to Account for the removed General settings section', () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=general#/settings');
    renderSettings();

    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  });

  it('offers separate Google presets with their exact personal and workspace capabilities', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    expect(mailCard).not.toBeNull();
    expect(within(mailCard!).queryByRole('button', { name: 'Connect workspace' })).not.toBeInTheDocument();
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'google',
      'you',
      ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
    ));

    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(driveCard).not.toBeNull();
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(driveCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'google',
      'workspace',
      ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
    ));
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('explains personal and workspace connector scope from each connect action', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    const personalButton = within(driveCard!).getByRole('button', { name: 'Connect for me' });
    const workspaceButton = within(driveCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(personalButton).toBeEnabled());

    fireEvent.focus(personalButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Only you can use this connection; it acts with your provider identity.',
    );
    fireEvent.blur(personalButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    fireEvent.focus(workspaceButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this workspace can use this connection; it acts for the workspace.',
    );
  });

  it('offers personal Notion MCP separately from the shared workspace bot connection', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const notionCard = (await screen.findByText('Notion')).closest('article');
    expect(notionCard).not.toBeNull();
    expect(screen.getByText(/workspace automations use only the connections explicitly bound to them/iu)).toBeVisible();
    const personalButton = within(notionCard!).getByRole('button', { name: 'Connect for me' });
    // Enabled before clicked, as the workspace button below already is. The
    // card renders as soon as the provider name does, while this button stays
    // disabled until the connector catalog resolves — and a click on a disabled
    // button is a silent no-op, so without this the test fails under load with
    // "Number of calls: 0" rather than with anything about Notion.
    await waitFor(() => expect(personalButton).toBeEnabled());
    fireEvent.click(personalButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'notion',
      'you',
      ['notion.personal.mcp'],
    ));
    const workspaceButton = within(notionCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toBeEnabled());
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
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));

    expect(await screen.findByText('Google authorization was cancelled.')).toBeVisible();
    expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('uses the server-owned attempt provider for reconnect status messaging', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Imported connection label' }));

    const dialog = screen.getByRole('dialog', { name: 'Refresh Imported connection label?' });
    expect(dialog).toHaveAccessibleDescription('You’ll be sent to the provider to authorize this connection again.');
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Notion authorization was cancelled.')).toBeVisible();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Google · adam@example.com' }));
    const dialog = screen.getByRole('dialog', { name: 'Refresh Google · adam@example.com?' });
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

    const reconnectButton = await screen.findByRole('button', { name: 'Refresh Google · adam@example.com' });
    fireEvent.click(reconnectButton);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Refresh Google · adam@example.com' }),
    ).toBeDisabled());
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
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));

    expect(await within(mailCard!).findByText('Waiting…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh Google · adam@example.com' })).toBeDisabled();
  });

  it('offers personal and workspace Linear authorization without granting agent identity personally', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    fireEvent.click(within(linearCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'you',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));

    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(linearCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('offers one Slack card with personal MCP and workspace Agent authorization', async () => {
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
    await waitFor(() => expect(within(slackCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
    fireEvent.click(within(slackCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      ['slack.personal.mcp'],
    ));

    await waitFor(() => expect(within(slackCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(slackCard!).getByRole('button', { name: 'Connect workspace' }));
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

    await screen.findByText('Slack · Rally');
    expect(screen.queryByRole('button', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('offers personal Granola MCP and submits a workspace API key only through the secure setup dialog', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const granolaCard = (await screen.findByText('Granola')).closest('article');
    expect(granolaCard).not.toBeNull();

    fireEvent.click(within(granolaCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'granola',
      'you',
      ['granola.personal.read'],
    ));

    await waitFor(() => expect(within(granolaCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(granolaCard!).getByRole('button', { name: 'Connect workspace' }));

    const dialog = screen.getByRole('dialog', { name: 'Connect Granola workspace' });
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
      'A workspace-wide Granola connection requires a Workspace API key. Personal Granola connections use browser sign-in and do not need a key.',
    );

    const apiKey = `grn_${'a'.repeat(24)}`;
    fireEvent.change(apiKeyInput, { target: { value: apiKey } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect workspace' }));

    await waitFor(() => expect(api.createGranolaWorkspaceConnection).toHaveBeenCalledWith(apiKey));
    expect(await screen.findByText('No personal connections yet')).toBeVisible();
    expect(screen.getByText('No workspace connections yet')).toBeVisible();
  });

  it('offers the read-only X connector only at workspace scope', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();

    await waitFor(() => expect(within(xCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(xCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.createXConnection).toHaveBeenCalledWith(['x.read']));
    expect(api.startProviderConnection).not.toHaveBeenCalledWith('x', expect.anything(), expect.anything());
  });

  it('creates a signed generic webhook and exposes its endpoint and secret once', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const webhookCard = (await screen.findByText('Inbound webhook')).closest('article');
    expect(webhookCard).not.toBeNull();
    fireEvent.click(within(webhookCard!).getByRole('button', { name: 'Connect for me' }));

    const dialog = screen.getByRole('dialog', { name: 'Create inbound webhook' });
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
      'https://eu.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000019',
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
    const connect = within(xCard!).getByRole('button', { name: 'Connect workspace' });
    expect(connect).toBeDisabled();
    expect(connect).toHaveAttribute('title', 'Public X via TwitterAPI.io is not configured in this Rally region.');
  });

  it('disables duplicate workspace X connections', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();
    const workspaceButton = within(xCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => {
      expect(workspaceButton).toBeDisabled();
      expect(workspaceButton).toHaveAttribute(
        'title',
        'A Public X via TwitterAPI.io workspace connection is already installed. Manage it above.',
      );
    });
    expect(screen.queryByRole('button', { name: 'Refresh X' })).not.toBeInTheDocument();
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate Slack workspace authorization for an existing %s installation',
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
      fireEvent.click(screen.getByRole('button', { name: 'All' }));

      const slackCard = (await screen.findByText('Slack')).closest('article');
      expect(slackCard).not.toBeNull();
      await waitFor(() => {
        expect(within(slackCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
      });
      expect(within(slackCard!).queryByRole('button', { name: 'Connect another workspace' })).not.toBeInTheDocument();
      const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toBeDisabled());
      expect(workspaceButton).toHaveAttribute(
        'title',
        'A Slack workspace connection is already installed. Manage it above.',
      );
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows replacing a disabled Slack workspace installation', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toBeEnabled());
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'workspace',
      ['slack.agent', 'slack.notifications.write'],
    ));
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate workspace authorization for an existing %s Linear installation',
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
      fireEvent.click(screen.getByRole('button', { name: 'All' }));

      const linearCard = (await screen.findByText('Linear')).closest('article');
      expect(linearCard).not.toBeNull();
      // The catalog query gates enablement; `findByText` resolves before it.
      await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
      const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toBeDisabled());
      expect(workspaceButton).toHaveAttribute(
        'title',
        'A Linear workspace connection is already installed. Manage it above.',
      );
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows a replacement workspace authorization after the existing connection is disabled', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toBeEnabled());
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('uses provider-level workspace connection detection without blocking personal authorization', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect workspace' })).toBeDisabled());
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());

    const linearCard = screen.getByText('Linear').closest('article');
    expect(linearCard).not.toBeNull();
    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
  });

  it('lets members connect Linear personally without offering a workspace installation', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
    expect(within(linearCard!).queryByRole('button', { name: 'Connect workspace' })).not.toBeInTheDocument();
  });

  it('separates personal and workspace connections into tables with scoped empty states', async () => {
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
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const connectionName = await screen.findByText('Google · adam@example.com');
    expect(connectionName).toBeVisible();
    expect(screen.getByText('2 capabilities')).toBeVisible();
    const personalTable = screen.getByRole('table', { name: 'Personal connections' });
    const workspaceTable = screen.getByRole('table', { name: 'Workspace connections' });
    expect(personalTable.compareDocumentPosition(workspaceTable) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(personalTable).getByText('Google · adam@example.com')).toBeVisible();
    expect(within(workspaceTable).getByText('No workspace connections yet')).toBeVisible();
    expect(within(workspaceTable).getByText(/Connect a connector below/iu)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    const connectionsHeading = screen.getByRole('heading', { level: 2, name: 'Your connections' });
    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(connectionsHeading.compareDocumentPosition(driveCard!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const filter = screen.getByRole('group', { name: 'Filter connections' });
    expect(within(filter).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Not connected',
      'Connected',
      'All',
    ]);
    expect(within(filter).getByRole('button', { name: 'Not connected' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Google Mail + Calendar')).not.toBeInTheDocument();

    const reconnectButton = screen.getByRole('button', { name: 'Refresh Google · adam@example.com' });
    const disconnectButton = screen.getByRole('button', { name: 'Delete Google · adam@example.com' });
    fireEvent.click(reconnectButton);
    const dialog = screen.getByRole('dialog', { name: 'Refresh Google · adam@example.com?' });
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(disconnectButton);
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete Google · adam@example.com?' });
    expect(api.disconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.disconnectConnection).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000010',
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Connected' }));
    expect(screen.getByText('Google Mail + Calendar')).toBeVisible();
    expect(screen.queryByText('Google Drive + Docs + Sheets')).not.toBeInTheDocument();
  });

  it('renders generic webhooks in the installed list', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      connectorType: 'generic_webhook',
      scope: 'workspace',
      displayName: 'Inbound webhook',
      capabilities: [],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const rotateButton = await screen.findByRole('button', { name: 'Refresh Inbound webhook' });
    expect(screen.getByRole('table', { name: 'Workspace connections' })).toBeVisible();
    expect(screen.getAllByText('Inbound webhook')).toHaveLength(2);
    expect(rotateButton).toBeVisible();
    fireEvent.focus(rotateButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Refresh this webhook by replacing its signing secret.',
    );
    fireEvent.click(rotateButton);
    const dialog = screen.getByRole('dialog', { name: 'Refresh Inbound webhook?' });
    expect(api.rotateWebhookSecret).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.rotateWebhookSecret).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000099',
    ));
  });

  it('hides connection refresh actions from non-admin members', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · sam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);

    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Connections');

    expect(await screen.findByText('Google · sam@example.com')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh Google · sam@example.com' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Google · sam@example.com' })).toBeVisible();
  });

  it('shows the immutable EU region and lets an owner create, copy, and revoke an invite', async () => {
    renderSettings();
    openSettingsSection('Workspace');

    expect(await screen.findByText('Data region')).toBeVisible();
    expect(screen.getByText('European Union')).toBeVisible();
    expect(screen.getByText('Locked')).toBeVisible();
    expect(await screen.findByText('Sam')).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
      target: { value: 'new-admin@example.com' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(api.createWorkspaceInvitation).toHaveBeenCalledWith('new-admin@example.com', 'admin'));
    expect(await screen.findByText('Invitation emailed')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(inviteUrl));

    fireEvent.click(screen.getByRole('button', { name: `Revoke invitation for ${invitation.email}` }));
    await waitFor(() => expect(api.revokeWorkspaceInvitation).toHaveBeenCalledWith(invitation.id));
  });

  it('does not expose invitation management to regular members', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Workspace');
    expect(await screen.findByText('Adam')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).not.toBeInTheDocument();
    expect(api.getWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it('uses searchable section navigation and keeps one active settings pane', async () => {
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

    expect(screen.getByText('adam@example.com')).toBeVisible();

    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'region' } });
    expect(within(navigation).getByRole('button', { name: 'Workspace' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible());
    expect(screen.getByText('Data region')).toBeVisible();

    fireEvent.change(search, { target: { value: 'connector' } });
    expect(within(navigation).getByRole('button', { name: 'Connections' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible());

    fireEvent.change(search, { target: { value: 'does not exist' } });
    expect(screen.getByText('No settings found')).toBeVisible();
  });

  it('selects a macOS app icon with an immediate jump state', async () => {
    renderSettings();
    openSettingsSection('Application');

    const ruby = await screen.findByRole('button', { name: 'Ruby app icon' });
    expect(screen.getByRole('button', { name: 'Dark app icon' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(ruby);

    expect(ruby).toHaveClass('is-jumping');
    expect(ruby).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(setApplicationIcon).toHaveBeenCalledWith('ruby'));
    expect(await screen.findByText('Ruby is selected.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Use the system icon' }));
    await waitFor(() => expect(resetApplicationIcon).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Using dark automatically with the system appearance.')).toBeVisible();
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
      menuBarEnabled: true,
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
      menuBarEnabled: true,
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

  it('controls product analytics and explains regional crash behavior', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Product analytics' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/EU telemetry stays in Rally’s EU platform/u)).toBeVisible();

    fireEvent.click(toggle);
    await waitFor(() => expect(setProductAnalyticsEnabled).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Restart Rally to remove local native crash dumps and apply the current setting/u)).toBeVisible();
  });

  it('shows a read-only redacted telemetry inspector only in Developer settings', async () => {
    renderSettings();
    openSettingsSection('Application');
    expect(await screen.findByRole('heading', { name: 'Telemetry inspector' })).toBeVisible();
    expect(await screen.findByText('screen_viewed')).toBeVisible();
    expect(screen.getByText('screen')).toBeVisible();
    expect(screen.getByText(/EU · accepted · queued/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: /replay|emit/u })).toBeNull();
  });

  it('shows telemetry inspector failures and lets the developer retry', async () => {
    getTelemetryInspector
      .mockRejectedValueOnce(new Error('Telemetry decisions could not be read.'))
      .mockResolvedValueOnce([{
        name: 'screen_viewed', schemaVersion: 1, policyClass: 'product',
        propertyNames: ['screen'], route: 'eu', validation: 'accepted', queueState: 'queued',
      }]);
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByText('Telemetry decisions could not be read.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh telemetry inspector' }));
    expect(await screen.findByText('screen_viewed')).toBeVisible();
    expect(screen.queryByText('Telemetry decisions could not be read.')).toBeNull();
  });

  it('finds Privacy and diagnostics from telemetry-related settings searches', async () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'crash' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Application' }));
    expect(await screen.findByRole('heading', { name: 'Privacy & diagnostics' })).toBeVisible();
  });

  it('disables the account preference on a browser bridge that cannot persist it', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: false,
      menuBarEnabled: true,
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
      menuBarEnabled: true,
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
      menuBarEnabled: true,
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
      menuBarEnabled: true,
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
      menuBarEnabled: false,
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
      menuBarEnabled: true,
      menuBarAvailable: false,
      menuBarPresent: false,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');

    await screen.findByRole('switch', { name: 'Lockdown mode' });
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
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    await screen.findByRole('navigation', { name: 'Settings sections' });
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
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
    expect(within(navigation).getByRole('button', { name: 'Application' })).toBeVisible();
  });

  it('offers no Developer section when the service has not enabled the flag', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: true,
      // A stored preference the service does not stand behind. The main process
      // reports the effective value, so this reads off however the file reads.
      debugEnabled: false,
      developerSettingsAvailable: false,
      menuBarEnabled: true,
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
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    renderSettings();
    openSettingsSection('Application');
    await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(screen.queryByRole('switch', { name: 'Debug enabled' })).toBeNull();

    const announce = (settings: DesktopApplicationSettings): void => {
      act(() => {
        for (const listener of applicationSettingsListeners) listener(settings);
      });
    };

    announce({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: true,
      developerSettingsAvailable: true,
      menuBarEnabled: true,
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
    announce({
      lockdownMode: false,
      lockdownAvailable: true,
      debugEnabled: false,
      developerSettingsAvailable: false,
      menuBarEnabled: true,
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

  it('shows application-setting load failures inline', async () => {
    getApplicationSettings.mockRejectedValue(new Error('Application settings could not be read.'));
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByText('Application settings could not be read.')).toBeVisible();
  });

  it('hides the Digest section entirely when digestsEnabled resolves false', async () => {
    api.clientFeatureFlags.mockResolvedValue(ClientFeatureFlagsSchema.parse({ digestsEnabled: false }));
    renderSettings();

    const navigation = await screen.findByRole('navigation', { name: 'Settings sections' });
    await waitFor(() => expect(within(navigation).queryByRole('button', { name: 'Digest' })).toBeNull());
    // Their digest has in fact stopped arriving — see the same comment on
    // `digestSettingsAvailable`'s use site — but there is no copy here for a
    // paused state, so it is simply not one of the sections offered.
    expect(within(navigation).getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  it('withdraws the Digest section and redirects away when the flag flips live', async () => {
    const client = createTestQueryClient();
    renderSettings(workspace, client, true);
    openSettingsSection('Digest');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Digest'));

    // The production path for this is the workspace socket writing a
    // `workspace_feature_flags` push into this same query key, not a
    // re-fetch — simulate it the same way, by writing the cache directly.
    act(() => {
      client.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, ClientFeatureFlagsSchema.parse({ digestsEnabled: false }));
    });

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    await waitFor(() => expect(within(navigation).queryByRole('button', { name: 'Digest' })).toBeNull());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Account');
  });

  it('keeps the Digest pane from painting when a live flip and a non-matching search both strand activeSection on it', async () => {
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
    const client = createTestQueryClient();
    renderSettings(workspace, client, true);
    openSettingsSection('Digest');
    await screen.findByLabelText('New digest time');

    act(() => {
      client.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, ClientFeatureFlagsSchema.parse({ digestsEnabled: false }));
    });
    // A non-matching search collapses every group to no items, so
    // `availableSections` is empty and the redirect effect has no `first` to
    // move to — `activeSection` stays 'digest' indefinitely. Nothing but the
    // render guard on the Digest pane itself keeps it from painting here.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'no setting matches this text' },
    });

    await waitFor(() => expect(screen.queryByLabelText('New digest time')).toBeNull());
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
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
    });
    api.getWorkspaceMembers.mockResolvedValue([owner]);
    api.getWorkspaceInvitations.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    api.getAvailableConnectorTypes.mockResolvedValue([]);
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
    openSettingsSection('Workspace');

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

  it('closes over a digest time, which is a picker rather than a draft', async () => {
    renderSettings(workspace, createTestQueryClient(), true);
    openSettingsSection('Digest');

    // `New digest time` is initialised to 09:00 and is never empty, so counting
    // it as unsaved text would leave Escape permanently dead in this section.
    const time = await screen.findByLabelText('New digest time');
    fireEvent.change(time, { target: { value: '10:30' } });
    fireEvent.keyDown(time, { key: 'Escape' });

    expect(close).toHaveBeenCalledOnce();
  });

  it('still closes from every section when nothing has been typed', async () => {
    renderSettings(workspace, createTestQueryClient(), true);

    // The pane sweep asks the panes a question about themselves: the first one
    // to render a saved value into a writable text field would make Escape
    // permanently dead in that section, and the symptom is a key that quietly
    // stopped working rather than a failing assertion anywhere near the cause.
    for (const section of ['Account', 'Digest', 'Workspace', 'Connections', 'Application'] as const) {
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
    openSettingsSection('Workspace');
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
    await waitFor(() => expect(within(granolaCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(granolaCard!).getByRole('button', { name: 'Connect workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Granola workspace' });

    // Radix closes the dialog on this keystroke itself. The window listener sees
    // the same event, and closing over a confirmation is exactly what the guard
    // on dismissable layers exists to prevent.
    fireEvent.keyDown(within(dialog).getByLabelText('Workspace API key'), { key: 'Escape' });

    expect(close).not.toHaveBeenCalled();
  });
});

describe('escapeClosesSettings', () => {
  function escapeOn(target: EventTarget, init: KeyboardEventInit = {}, pane: Element | null = null): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', ...init });
    target.dispatchEvent(event);
    return escapeClosesSettings(event, pane);
  }

  it('answers only a bare, unclaimed Escape', () => {
    const field = document.createElement('input');
    document.body.append(field);

    expect(escapeOn(field)).toBe(true);
    expect(escapeOn(field, { key: 'Enter' })).toBe(false);
    // A shortcut that happens to contain Escape belongs to whoever bound it.
    expect(escapeOn(field, { metaKey: true })).toBe(false);
    expect(escapeOn(field, { shiftKey: true })).toBe(false);

    field.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    expect(escapeOn(field)).toBe(false);
    field.remove();
  });

  it('yields to the layer the keystroke was aimed at', () => {
    const layer = document.createElement('div');
    layer.setAttribute('role', 'listbox');
    const option = document.createElement('button');
    layer.append(option);
    document.body.append(layer);

    // A select menu is dismissed by this Escape; the window is not.
    expect(escapeOn(option)).toBe(false);
    layer.remove();
  });

  it('ignores controls that hold no typing', () => {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    document.body.append(toggle);

    // A checked box carries a value of its own; it is not unsaved text.
    expect(escapeOn(toggle)).toBe(true);
    toggle.remove();
  });

  it('sweeps the pane for text no element currently holds focus over', () => {
    const pane = document.createElement('div');
    const draft = document.createElement('input');
    const elsewhere = document.createElement('button');
    pane.append(draft);
    document.body.append(pane, elsewhere);

    expect(escapeOn(elsewhere, {}, pane)).toBe(true);
    draft.value = 'teammate@company.com';
    expect(escapeOn(elsewhere, {}, pane)).toBe(false);

    // Values that are already saved, or that cannot be edited at all, are not
    // drafts — a generated endpoint and a disabled field both read as text.
    draft.readOnly = true;
    expect(escapeOn(elsewhere, {}, pane)).toBe(true);
    draft.readOnly = false;
    draft.disabled = true;
    expect(escapeOn(elsewhere, {}, pane)).toBe(true);

    // A picker that ships with a value is never empty, so counting it would
    // leave Escape permanently dead in whichever section shows one.
    draft.disabled = false;
    draft.type = 'time';
    draft.value = '10:30';
    expect(escapeOn(elsewhere, {}, pane)).toBe(true);

    pane.remove();
    elsewhere.remove();
  });
});
