import { AccountOnboardingGate } from './guided-onboarding';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ClientFeatureFlagsSchema } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useState } from 'react';
import { coreSettingsProvider } from '../settings/registry';
import type { PendingConnectorOAuth } from '../lib/app-session';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { ApiError } from '../lib/api';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from '../lib/use-client-feature-flags';
import type { Workspace, WorkspaceInvitation } from '../lib/types';
import { WorkspaceSettingsScreen } from './workspace-settings';

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConnections: vi.fn(),
  getConnectionToolCount: vi.fn(),
  getGitHubRepositoryAccessSettings: vi.fn(),
  updateGitHubRepositoryAccessSettings: vi.fn(),
  getAvailableConnectorTypes: vi.fn(),
  createGranolaWorkspaceConnection: vi.fn(),
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
const signOut = vi.hoisted(() => vi.fn());
const leaveWorkspace = vi.hoisted(() => vi.fn());
const applicationSettingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());
const settingsSectionRequest = vi.hoisted(() => ({
  listener: null as ((section: string) => void) | null,
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => {
    const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
    return {
      api,
      runtime: {
        appVersion: '0.1.0',
        isPackaged: false,
        platform: 'darwin',
        api: { global: 'https://api.rallywith.ai', eu: 'https://eu.api.rallywith.ai' },
        devAuthEnabled: true,
      },
      session: { apiBaseUrl: 'https://eu.api.rallywith.ai', user: { id: 'user-1', name: 'Adam', email: 'adam@example.com' } },
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
  client.setQueryData(['account-onboarding', 'adam@example.com'], { eligible: false, introduced: true, revision: 1, presentation: null });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={client}>
        <AccountOnboardingGate><WorkspaceSettingsScreen standaloneWindow={standaloneWindow} workspace={nextWorkspace} /></AccountOnboardingGate>
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

function openSettingsSection(
  name: 'Account' | 'Digest' | 'Workspace' | 'Internet access' | 'Connections' | 'GitHub' | 'MCP tools' | 'Application',
): void {
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
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
    ...overrides,
  };
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
    api.getConnectionToolCount.mockResolvedValue(7);
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
      'custom_mcp', 'generic_webhook', 'github', 'google', 'granola', 'linear', 'notion', 'slack', 'x',
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
    setApplicationIcon.mockImplementation(async (activeIcon: string) => ({
      activeIcon,
      isAutomatic: false,
      supported: true,
    }));
    resetApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
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
    fireEvent.change(search, { target: { value: 'Connect workspace' } });
    expect(document.querySelector('[data-setting-result="provider:google-mail-calendar"]')).toBeNull();
    fireEvent.change(search, { target: { value: 'Connect for me' } });
    expect(document.querySelector('[data-setting-result="provider:x"]')).toBeNull();
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
    expect(search).toHaveValue('Connect for me');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
  });

  it.each(coreSettingsProvider.entries)('reveals registered setting $key without executing it', async ({ definition }) => {
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
    renderSettings();
    // Wait for the shared availability and connection metadata, not for the destination pane.
    await screen.findByRole('button', { name: 'GitHub' });
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: definition.label } });
    const results = screen.getByRole('navigation', { name: 'Settings search results' });
    const result = within(results).getAllByRole('button').find((button) =>
      button.dataset.settingResult === definition.id
        || button.dataset.settingResult?.startsWith(definition.id + ':'));
    expect(result, definition.id).toBeDefined();
    fireEvent.click(result!);
    if (definition.id === 'inviteSend' || definition.id === 'digestSave') {
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

  it('keeps the network policy on its own page under Workspace', async () => {
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const internetAccess = within(navigation).getByRole('button', { name: 'Internet access' });
    expect(internetAccess).toHaveClass('settings-navigation-child');
    // Indented under Workspace, so it has to follow it and precede Connections.
    const workspaceNavigation = within(navigation).getByRole('button', { name: 'Workspace' });
    expect(workspaceNavigation.compareDocumentPosition(internetAccess) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(internetAccess.compareDocumentPosition(
      within(navigation).getByRole('button', { name: 'Connections' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    openSettingsSection('Workspace');
    expect(await screen.findByText('Data region', undefined, { timeout: 10_000 })).toBeVisible();
    // The destructive review-and-confirm flow is not sitting in the middle of
    // the preferences list, and Workspace does not pay for its read.
    expect(screen.queryByText('Terminal network access')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^Full internet/ })).not.toBeInTheDocument();
    expect(api.getTerminalWorkspaceSettings).not.toHaveBeenCalled();

    fireEvent.click(internetAccess);

    expect(await screen.findByRole('heading', { level: 1, name: 'Internet access' })).toBeVisible();
    expect(await screen.findByRole('radio', { name: /^Trusted only/ }, { timeout: 10_000 })).toBeChecked();
    await waitFor(() => expect(api.getTerminalWorkspaceSettings).toHaveBeenCalled());
  }, 30_000);

  it('previews and confirms full Terminal internet access before applying it', async () => {
    renderSettings();
    openSettingsSection('Internet access');
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
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));

    expect(await screen.findByText(/arbitrary public destinations/u, undefined, { timeout: 10_000 })).toBeVisible();
    expect(api.previewTerminalNetworkPolicy).toHaveBeenCalledWith({
      expectedRevision: 1, mode: 'full_internet', customDomains: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm network change' }));
    await waitFor(() => expect(api.applyTerminalNetworkPolicy).toHaveBeenCalledWith({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1, confirmed: true,
    }), { timeout: 10_000 });
  }, 30_000);

  it('keeps Rally-managed Trusted-only domains out of the settings surface', async () => {
    api.previewTerminalNetworkPolicy.mockResolvedValueOnce({
      mutationId: '00000000-0000-7000-8000-000000000090', expectedRevision: 1,
      proposedMode: 'trusted_only', customDomains: ['packages.example.com'],
      remainingCustomSlots: 6,
      affectedWorkstreamIds: [], affectedWorkstreams: [],
      warning: 'Trusted only applies managed and workspace-approved access.',
    });
    renderSettings();
    openSettingsSection('Internet access');

    expect(await screen.findByText('Workspace-approved domains', undefined, { timeout: 10_000 })).toBeVisible();
    expect(screen.queryByText('Required targets')).not.toBeInTheDocument();
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText('Additional Terminal domains'), {
      target: { value: 'packages.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));
    fireEvent.click(await screen.findByText('Review exact before and after targets', undefined, { timeout: 10_000 }));
    expect(await screen.findAllByText('packages.example.com', undefined, { timeout: 10_000 })).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download workspace domains' })).toBeVisible();
    for (const managedDomain of ['github.com', 'deb.debian.org', 'pypi.org', 'registry.npmjs.org']) {
      expect(screen.queryByText(managedDomain)).not.toBeInTheDocument();
    }
  }, 30_000);

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
    openSettingsSection('Internet access');
    fireEvent.click(await screen.findByRole('radio', { name: /^Full internet/ }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole('button', { name: 'Review network change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm network change' }, { timeout: 10_000 }));

    expect(await screen.findByText('Sandbox outcomes', undefined, { timeout: 10_000 })).toBeVisible();
    expect(screen.getByText('Customer export: stopped')).toBeVisible();
    expect(screen.getByText('Weekly report: quarantined')).toBeVisible();
  }, 30_000);

  it('opens the exact section requested by a native settings-window URL', async () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=workspace#/settings');
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
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

    const row = (await screen.findByText('Slack · Rally')).closest('tr');
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

    const row = (await screen.findByText('Deploy notifications')).closest('tr');
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
    fireEvent.click(await enabledConnectAction(card!, 'Connect workspace'));
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

  it('shows a connected server its live catalog and changes what the workspace may call', async () => {
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
    fireEvent.click(await within(navigation).findByRole('button', { name: 'MCP tools' }));

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
    api.getConnections.mockResolvedValue([{
      id: connectionId, connectorType: 'custom_mcp', scope: 'workspace',
      displayName: 'Acme docs', capabilities: ['custom_mcp.tools'],
      status: 'healthy', settingsKind: 'custom_mcp_tools',
    }]);
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
    api.getConnectionToolCount.mockResolvedValue(2);
    renderSettings();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(await within(navigation).findByRole('button', { name: 'MCP tools' }));
    fireEvent.change(await screen.findByLabelText('Tools Rally may use'), {
      target: { value: 'read_only_tools' },
    });
    await waitFor(() => expect(api.updateCustomMcpToolPolicy).toHaveBeenCalledWith(
      connectionId, 'read_only_tools',
    ));
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Workspace connections' });
    expect(await within(table).findByRole('cell', { name: '2' })).toBeVisible();

    api.getConnectionToolCount.mockResolvedValue(1);
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
    fireEvent.click(await within(navigation).findByRole('button', { name: 'MCP tools' }));

    expect(await screen.findByText('This server’s tools could not be read')).toBeVisible();
    expect(screen.getByText('Custom MCP returned HTTP 503')).toBeVisible();
    // A personal connection's policy is fixed, so the control is not offered as
    // something to change.
    expect(screen.getByLabelText('Tools Rally may use')).toBeDisabled();
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

  it('refreshes members when the list settings opened onto could have gone stale', async () => {
    const client = createTestQueryClient();
    client.setQueryData(['workspace-members'], [owner]);
    // Older than this observer's 30 seconds, which every list that has been sat
    // on long enough for somebody to have joined or left is. It used to be
    // refetched unconditionally; the premise this test needed all along is that
    // the copy on hand is old, not merely that one exists.
    ageCacheEntry(client, ['workspace-members'], 60_000);

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

    const mailCard = (await screen.findByText('Google Mail + Calendar', undefined, { timeout: 10_000 })).closest('article');
    expect(mailCard).not.toBeNull();
    expect(within(mailCard!).queryByRole('button', { name: 'Connect workspace' })).not.toBeInTheDocument();
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
      ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
    ), { timeout: 10_000 });

    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(driveCard).not.toBeNull();
    fireEvent.click(await enabledConnectAction(driveCard!, 'Connect workspace'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'google',
      'workspace',
      ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
    ), { timeout: 10_000 });
    expect(openExternal).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('explains personal and workspace connector scope from each connect action', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    const personalButton = await enabledConnectAction(driveCard!, 'Connect for me');
    const workspaceButton = await enabledConnectAction(driveCard!, 'Connect workspace');

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
    fireEvent.blur(workspaceButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

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
    const workspaceButton = within(driveCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
    expect(workspaceButton).toHaveAccessibleName('Connect workspace');

    fireEvent.focus(workspaceButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this workspace can use this connection; it acts for the workspace. A Google Drive + Docs + Sheets workspace connection is already installed. Manage it above.',
    );
  });

  it('offers personal Notion MCP separately from the shared workspace bot connection', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const notionCard = (await screen.findByText('Notion')).closest('article');
    expect(notionCard).not.toBeNull();
    expect(screen.getByText(/workspace automations use only the connections explicitly bound to them/iu)).toBeVisible();
    const personalButton = await enabledConnectAction(notionCard!, 'Connect for me');
    fireEvent.click(personalButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'notion',
      'you',
      ['notion.personal.mcp'],
    ));
    const workspaceButton = await enabledConnectAction(notionCard!, 'Connect workspace');
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

    const dialog = await screen.findByRole('dialog', { name: 'Refresh Imported connection label?' });
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
    expect(screen.getByRole('button', { name: 'Refresh Google · adam@example.com' }))
      .toHaveAttribute('aria-disabled', 'true');
  });

  it('offers personal and workspace Linear authorization without granting agent identity personally', async () => {
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

    fireEvent.click(await enabledConnectAction(linearCard!, 'Connect workspace'));
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
    fireEvent.click(await enabledConnectAction(slackCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      ['slack.personal.mcp'],
    ));

    fireEvent.click(await enabledConnectAction(slackCard!, 'Connect workspace'));
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

    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect for me'));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'granola',
      'you',
      ['granola.personal.read'],
    ));

    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect workspace'));

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

    fireEvent.click(await enabledConnectAction(xCard!, 'Connect workspace'));
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
    expect(connect).toHaveAttribute('aria-disabled', 'true');
    fireEvent.focus(connect);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Everyone in this workspace can use this connection; it acts for the workspace. Public X via TwitterAPI.io is not configured in this Rally region.',
    );
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
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const xCard = (await screen.findByText('Public X via TwitterAPI.io')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();
    const workspaceButton = within(xCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => {
      expect(workspaceButton).toHaveAttribute('aria-disabled', 'true');
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
      fireEvent.click(screen.getByRole('radio', { name: 'All' }));

      const slackCard = (await screen.findByText('Slack')).closest('article');
      expect(slackCard).not.toBeNull();
      await waitFor(() => {
        expect(within(slackCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
      });
      expect(within(slackCard!).queryByRole('button', { name: 'Connect another workspace' })).not.toBeInTheDocument();
      const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
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
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    const workspaceButton = await enabledConnectAction(slackCard!, 'Connect workspace');
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
      fireEvent.click(screen.getByRole('radio', { name: 'All' }));

      const linearCard = (await screen.findByText('Linear')).closest('article');
      expect(linearCard).not.toBeNull();
      // The catalog query gates enablement; `findByText` resolves before it.
      await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled());
      const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toHaveAttribute('aria-disabled', 'true'));
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
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    const workspaceButton = await enabledConnectAction(linearCard!, 'Connect workspace');
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
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect workspace' }))
      .toHaveAttribute('aria-disabled', 'true'));
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

  it('does not request tool inventories for disabled connections', async () => {
    api.getConnections.mockResolvedValue([{
      id: 'disabled-tools', modelPluginId: 'plugin_google', connectorType: 'google',
      scope: 'you', displayName: 'Disabled Google', capabilities: ['gmail.read'], status: 'disabled',
    }]);
    renderSettings();
    openSettingsSection('Connections');
    const row = (await screen.findByText('Disabled Google')).closest('tr')!;
    expect(within(row).getByRole('cell', { name: '—' })).toBeVisible();
    expect(api.getConnectionToolCount).not.toHaveBeenCalled();
    expect(within(row).queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('refreshes tool counts on reveal and replaces stale counts when discovery fails', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    api.getConnections.mockResolvedValue([{
      id: 'tool-count-connection',
      modelPluginId: 'plugin_google',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google tools',
      capabilities: ['gmail.read'],
      status: 'healthy',
    }]);
    renderSettings(workspace, client);
    openSettingsSection('Connections');
    const table = await screen.findByRole('table', { name: 'Personal connections' });
    expect(await within(table).findByRole('cell', { name: '7' })).toBeVisible();

    const countKey = ['connection-tool-count', 'tool-count-connection', ['gmail.read'], 'healthy'];
    act(() => revealWindow());
    expect(api.getConnectionToolCount).toHaveBeenCalledTimes(1);
    ageCacheEntry(client, countKey, 30_000);
    api.getConnectionToolCount.mockResolvedValue(9);
    act(() => revealWindow());
    expect(await within(table).findByRole('cell', { name: '9' })).toBeVisible();

    ageCacheEntry(client, countKey, 30_000);
    api.getConnectionToolCount.mockRejectedValue(new Error('Provider unavailable'));
    act(() => revealWindow());
    expect(await within(table).findByRole('cell', { name: 'Unavailable' })).toBeVisible();
    expect(within(table).queryByRole('cell', { name: '9' })).not.toBeInTheDocument();
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
    expect(await screen.findByText('7')).toBeVisible();
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

    const filter = screen.getByRole('radiogroup', { name: 'Filter connections' });
    expect(within(filter).getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'Not connected',
      'Connected',
      'All',
    ]);
    expect(within(filter).getByRole('radio', { name: 'Not connected' })).toBeChecked();
    expect(screen.queryByText('Google Mail + Calendar')).not.toBeInTheDocument();

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

    fireEvent.click(screen.getByRole('radio', { name: 'Connected' }));
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

    const rotateButton = await screen.findByRole('button', { name: 'Refresh Inbound webhook' });
    expect(screen.getByRole('table', { name: 'Workspace connections' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workspace connections' }).parentElement).toHaveTextContent('1');
    expect(screen.getAllByText('Inbound webhook')).toHaveLength(2);
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
      endpoint: 'https://eu.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
      signingSecret: 'whsec_rotated-secret',
      signatureFormat: 't=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>',
    }));
    expect(await within(dialog).findByLabelText('Webhook endpoint')).toHaveValue(
      'https://eu.api.rallywith.ai/ingest/webhook/00000000-0000-7000-8000-000000000099',
    );
    expect(within(dialog).getByLabelText('Webhook signing secret')).toHaveValue('whsec_rotated-secret');
  });

  it('hides connection refresh actions from non-admin members', async () => {
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

    expect(await screen.findByText('Google · sam@example.com')).toBeVisible();
    expect(screen.getByText('Linear · Rally')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh Google · sam@example.com' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh Linear · Rally' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Google · sam@example.com' })).toBeVisible();
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

    const deleteButton = await screen.findByRole('button', { name: 'Delete Google · adam@example.com' });
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole('dialog', { name: 'Delete Google · adam@example.com?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await within(dialog).findByText('The connection could not be deleted. Try again.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('shows the immutable EU region and lets an owner create, copy, and revoke an invite', async () => {
    renderSettings();
    openSettingsSection('Workspace');

    expect(await screen.findByText('Data region', undefined, { timeout: 10_000 })).toBeVisible();
    expect(screen.getByText('European Union')).toBeVisible();
    expect(screen.getByText('Locked')).toBeVisible();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }, { timeout: 10_000 }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(inviteUrl), { timeout: 10_000 });

    fireEvent.click(screen.getByRole('button', { name: `Revoke invitation for ${invitation.email}` }));
    await waitFor(
      () => expect(api.revokeWorkspaceInvitation).toHaveBeenCalledWith(invitation.id),
      { timeout: 10_000 },
    );
  }, 30_000);

  it('does not expose invitation management to regular members', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Workspace');
    expect(await screen.findByText('Adam')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).not.toBeInTheDocument();
    expect(api.getWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it('confirms leaving a workspace without describing it as deleted', async () => {
    renderSettings();
    openSettingsSection('Workspace');

    const leave = await screen.findByRole('button', { name: 'Leave this workspace' });
    fireEvent.click(leave);

    const dialog = await screen.findByRole('dialog', { name: 'Leave Rally Studio?' });
    expect(within(dialog).getByText('Rally Studio stays available to its other members.')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));

    await waitFor(() => expect(leaveWorkspace).toHaveBeenCalledWith(workspace.id, 'left'));
  });

  it('warns that the last member will close the workspace', async () => {
    api.getWorkspaceMembers.mockResolvedValue([owner]);
    leaveWorkspace.mockResolvedValue({ outcome: 'abandoned' });
    renderSettings();
    openSettingsSection('Workspace');

    const leave = await screen.findByRole('button', { name: 'Leave and close workspace' });
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
    fireEvent.change(search, { target: { value: 'region' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Data region Workspace' }));
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-setting-id', 'workspaceRegion'));
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
    fireEvent.change(search, { target: { value: 'does not exist' } });
    expect(screen.getByText('No settings found')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
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
    expect(screen.queryByText('https://eu.api.rallywith.ai')).not.toBeInTheDocument();
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
      menuBarEnabled: true,
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

    announceApplicationSettings({
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
    announceApplicationSettings({
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
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Digest'),
      { timeout: 10_000 },
    );

    // The production path for this is the workspace socket writing a
    // `workspace_feature_flags` push into this same query key, not a
    // re-fetch — simulate it the same way, by writing the cache directly.
    act(() => {
      client.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, ClientFeatureFlagsSchema.parse({ digestsEnabled: false }));
    });

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    await waitFor(
      () => expect(within(navigation).queryByRole('button', { name: 'Digest' })).toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Account');
  }, 30_000);

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
    api.getConnectionToolCount.mockResolvedValue(7);
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
    for (const section of ['Account', 'Digest', 'Workspace', 'Internet access', 'Connections', 'Application'] as const) {
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
    openSettingsSection('Internet access');
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
    fireEvent.click(await enabledConnectAction(granolaCard!, 'Connect workspace'));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Granola workspace' });

    // Radix closes the dialog on this keystroke itself. The window listener sees
    // the same event, and closing over a confirmation is exactly what the guard
    // on dismissable layers exists to prevent.
    fireEvent.keyDown(within(dialog).getByLabelText('Workspace API key'), { key: 'Escape' });

    expect(close).not.toHaveBeenCalled();
  });
});
