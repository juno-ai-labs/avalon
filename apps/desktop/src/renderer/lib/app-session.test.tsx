import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RallyDesktopBridge,
  DesktopDeepLinkEntrypoint,
  DesktopDeepLinkNavigation,
  DesktopSession,
  RuntimeConfig,
} from '../../common/desktop';
import {
  AppSessionProvider,
  useAppSession,
  type AppSessionDesktopBridge,
} from './app-session';
import { clearAllDrafts, readDraftText, writeDraftText } from './draft-cache';
import { useDraftText } from './use-draft-text';
import type { RallyApi } from './api';
import { readDevicePreferences } from './device-preferences';
import {
  consumeSurfaceEntrypoint,
  markWorkstreamFeedOpenStarted,
  workstreamFeedOpenAttemptId,
} from './telemetry';

let deepLinkListener: ((navigation: DesktopDeepLinkNavigation) => void) | null = null;
let sessionListener: ((session: DesktopSession | null) => void) | null = null;
let observedApi: RallyApi | null = null;
let observedSignOutIfCleared: (() => Promise<void>) | null = null;
const bridge = vi.hoisted(() => ({
  cancelDesktopAuthAttempt: vi.fn(),
  consumePendingDeepLinks: vi.fn(),
  acceptInvitation: vi.fn(),
  activateWorkspace: vi.fn(),
  createDevelopmentSession: vi.fn(),
  createWorkspace: vi.fn(),
  declineInvitation: vi.fn(),
  exchangeDesktopTicket: vi.fn(),
  getOnboardingState: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getSession: vi.fn(),
  hasStoredCredential: vi.fn(),
  logout: vi.fn(),
  onDeepLink: vi.fn(),
  onSessionChanged: vi.fn(),
  openExternal: vi.fn(),
  openSettings: vi.fn(),
  refreshSession: vi.fn(),
  reportTelemetryProductIntent: vi.fn(),
}) satisfies AppSessionDesktopBridge & Pick<RallyDesktopBridge, 'reportTelemetryProductIntent'>);

vi.mock('./platform', () => ({ desktopBridge: () => bridge }));

const futureExpiry = new Date(Date.now() + 60 * 60_000).toISOString();

const euSession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: futureExpiry,
  apiBaseUrl: 'https://eu.api.rallywith.ai',
  user: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee' },
  workspace: {
    id: 'workspace-eu',
    name: 'European Research',
    region: 'eu',
    role: 'member',
  },
};

const globalIdentitySession: DesktopSession = {
  ...euSession,
  apiBaseUrl: 'https://api.rallywith.ai',
  workspace: null,
};

const expiredIdentitySession: DesktopSession = {
  ...globalIdentitySession,
  expiresAt: '2020-01-01T00:00:00.000Z',
};

function SessionProbe(): React.JSX.Element {
  const context = useAppSession();
  const { api, booting, deepLinkError, invitationApi, pendingInvitation, region, session } = context;
  observedApi = api;
  observedSignOutIfCleared = context.signOutIfCredentialCleared;
  return (
    <>
      <output>
        {booting ? 'booting' : `${region ?? 'none'}:${pendingInvitation ? 'invite' : session?.workspace?.name ?? 'signed-out'}`}
      </output>
      <output data-testid="invitation-api">{invitationApi?.baseUrl ?? 'none'}</output>
      <output data-testid="session-email">{session?.user.email ?? 'none'}</output>
      <output data-testid="session-token">{session?.accessToken ?? 'none'}</output>
      <output data-testid="session-role">{session?.workspace?.role ?? 'none'}</output>
      <output data-testid="deep-link-error">{deepLinkError ?? 'none'}</output>
    </>
  );
}

function renderProvider(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppSessionProvider><SessionProbe /></AppSessionProvider>
    </QueryClientProvider>,
  );
  return client;
}

/**
 * The baseline every test in this file assumes: cleared mocks and storage, no
 * stored session, and a bridge whose listeners are wired to the module-level
 * captures above.
 *
 * It lives at file scope because both `describe` blocks need it. It used to sit
 * inside the first one, so the second passed only when a test from the first
 * had already run and left the bridge configured — an ordering the runner
 * happens to give it today and is under no obligation to keep.
 */
function resetDesktopBridge(): void {
  vi.clearAllMocks();
  window.localStorage.clear();
  deepLinkListener = null;
  sessionListener = null;
  observedApi = null;
  observedSignOutIfCleared = null;
  bridge.getRuntimeConfig.mockResolvedValue({
    appVersion: 'test',
    isPackaged: true,
    platform: 'darwin',
    api: {
      global: 'https://api.rallywith.ai',
      eu: 'https://eu.api.rallywith.ai',
    },
    webBaseUrl: 'https://rallywith.ai',
    devAuthEnabled: false,
  });
  bridge.getSession.mockResolvedValue(null);
  bridge.hasStoredCredential.mockResolvedValue(false);
  bridge.consumePendingDeepLinks.mockResolvedValue([]);
  bridge.reportTelemetryProductIntent.mockResolvedValue(undefined);
  bridge.onDeepLink.mockImplementation((listener: (navigation: DesktopDeepLinkNavigation) => void) => {
    deepLinkListener = listener;
    return () => { deepLinkListener = null; };
  });
  bridge.onSessionChanged.mockImplementation((listener: (session: DesktopSession | null) => void) => {
    sessionListener = listener;
    return () => { sessionListener = null; };
  });
  bridge.exchangeDesktopTicket.mockResolvedValue(globalIdentitySession);
}

describe('single-platform desktop identity routing', () => {
  // Every deep link goes through here. The provider registers no listener at
  // all until `getRuntimeConfig` resolves — its effect early-returns while
  // `runtime` is null — so a dispatch straight into `deepLinkListener?.()` can
  // land before the first registration, where the optional call swallows the
  // link and the test then fails much later on an assertion that never comes
  // true. Wait for the listener, then call it unguarded so a missing one throws
  // at the dispatch instead.
  //
  // This promises a listener, not one closing over the state the test has
  // asserted: every branch except auth reads the closure's `session` and `api`,
  // so a dispatch arriving before those settle takes the "Sign in before…" path.
  // Keep awaiting a session-bearing `findByText` before calling this.
  async function dispatchDeepLink(
    url: string,
    entrypoint: DesktopDeepLinkEntrypoint = 'deep_link',
  ): Promise<void> {
    await waitFor(() => expect(deepLinkListener).not.toBeNull());
    act(() => deepLinkListener!({ url, entrypoint }));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(resetDesktopBridge);

  it('accepts a callback only from the Global identity service', async () => {
    window.localStorage.setItem('rally:selected-region', 'eu');
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'a'.repeat(43)}`);

    await waitFor(() => expect(bridge.exchangeDesktopTicket).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: 'a'.repeat(43),
    }));
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(window.localStorage.getItem('rally:selected-region')).toBeNull();
  });

  it('accepts a sign-in callback on the superseded avalon scheme', async () => {
    // A build shipped before the rename registered `avalon:` alone, and the
    // links it minted are still in inboxes. The main process forwards them; the
    // renderer has to route them by the same list rather than one literal.
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await dispatchDeepLink(`avalon://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'c'.repeat(43)}`);

    await waitFor(() => expect(bridge.exchangeDesktopTicket).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: 'c'.repeat(43),
    }));
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
  });

  it('opens settings from a link minted in either scheme', async () => {
    // Routing is by the shared scheme list, so the current scheme and the
    // superseded one reach the same handler. Settings is the case with no
    // session gate in front of it, which isolates the scheme decision.
    renderProvider();
    await screen.findByText('global:signed-out');

    await dispatchDeepLink('rallywithai://settings/connections');
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));

    await dispatchDeepLink('avalon://settings/workspace');
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('workspace'));
  });

  it('does not drain a cold-start OAuth callback until runtime endpoints are loaded', async () => {
    let resolveRuntime!: (value: RuntimeConfig) => void;
    bridge.getRuntimeConfig.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntime = resolve;
    }));
    bridge.consumePendingDeepLinks.mockResolvedValueOnce([
      {
        url: `rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'b'.repeat(43)}`,
        entrypoint: 'deep_link',
      },
    ]);

    renderProvider();
    expect(bridge.consumePendingDeepLinks).not.toHaveBeenCalled();

    await act(async () => resolveRuntime({
      appVersion: 'test',
      isPackaged: true,
      platform: 'darwin',
      api: {
        global: 'https://api.rallywith.ai',
        eu: 'https://eu.api.rallywith.ai',
      },
      webBaseUrl: 'https://rallywith.ai',
      devAuthEnabled: false,
    }));

    await waitFor(() => expect(bridge.exchangeDesktopTicket).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: 'b'.repeat(43),
    }));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('signs out once main reports the durable credential was surrendered', async () => {
    bridge.getSession.mockResolvedValueOnce(expiredIdentitySession);
    bridge.refreshSession.mockRejectedValueOnce(new Error('refresh token expired'));
    bridge.hasStoredCredential.mockResolvedValue(false);

    renderProvider();

    await waitFor(
      () => expect(screen.getByTestId('deep-link-error')).toHaveTextContent('session expired'),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('session-email')).toHaveTextContent('none');
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('keeps a still-stored session signed in when a refresh fails transiently', async () => {
    bridge.getSession.mockResolvedValue(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValueOnce(new Error('network unreachable'));

    renderProvider();

    await waitFor(() => expect(bridge.refreshSession).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitFor(() => expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('keeps retrying a permanently failing refresh while the credential is still stored', async () => {
    // Main surrenders the credential when a refresh can never succeed, so a
    // refresh that keeps failing with one still on disk is by definition
    // transient and must never strand the user on the sign-in screen.
    bridge.getSession.mockResolvedValue(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValue(new Error('regional service unreachable'));

    renderProvider();

    await waitFor(() => expect(bridge.refreshSession).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitFor(() => expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('does not probe the network to decide whether the credential was surrendered', async () => {
    // `session:get` refreshes to rebuild a missing profile cache, so using it
    // as the oracle would let a network blip masquerade as an expiry.
    bridge.getSession.mockResolvedValueOnce(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValueOnce(new Error('network unreachable'));

    renderProvider();

    await waitFor(() => expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(bridge.getSession).toHaveBeenCalledTimes(1);
    expect(bridge.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when an unauthorized read leaves the native credential intact', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    bridge.hasStoredCredential.mockResolvedValue(true);

    renderProvider();
    await waitFor(() => expect(observedSignOutIfCleared).not.toBeNull());
    await act(async () => observedSignOutIfCleared?.());

    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('drops the session when an unauthorized read follows a surrendered credential', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    bridge.hasStoredCredential.mockResolvedValue(false);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com'));
    await act(async () => observedSignOutIfCleared?.());

    expect(screen.getByTestId('session-email')).toHaveTextContent('none');
  });

  it('renews a service-rejected bearer on demand so requests recover without a restart', async () => {
    // The scheduled refresh cannot fire while the renderer is throttled, so
    // the client still believes its token is valid when the service rejects it.
    const renewedSession = {
      ...globalIdentitySession,
      accessToken: 'renewed-access-token-longer-than-twenty',
    };
    bridge.getSession.mockResolvedValueOnce(globalIdentitySession);
    bridge.refreshSession.mockResolvedValue(renewedSession);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(authorization === `Bearer ${renewedSession.accessToken}`
        ? new Response(JSON.stringify({ url: 'wss://api.rallywith.ai/socket', ticket: 'socket-ticket' }))
        : new Response(JSON.stringify({ error: { code: 'invalid_session' } }), { status: 401 }));
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('session-token')).toHaveTextContent(
      globalIdentitySession.accessToken,
    ));

    await expect(observedApi!.getSocketTicket('workstream-1'))
      .resolves.toMatchObject({ ticket: 'socket-ticket' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bridge.refreshSession).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('rejects a regional authentication callback instead of creating a second login surface', async () => {
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=eu&attempt=${'a'.repeat(43)}`);

    expect(bridge.exchangeDesktopTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('identity service');
  });

  it('keeps identity on Global while previewing a regional legacy invite link', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await dispatchDeepLink(
      'rallywithai://invitations/accept?token=private-invitation-token-long-enough&region=eu',
    );

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://eu.api.rallywith.ai');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspace-onboarding'] });
    invalidate.mockRestore();
  });

  it('previews a cross-region invitation on its own API without moving the active session', async () => {
    const globalSession: DesktopSession = {
      ...euSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...euSession.workspace!, id: 'workspace-global', name: 'Global Research', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(globalSession);
    renderProvider();
    expect(await screen.findByText('global:Global Research')).toBeVisible();
    await dispatchDeepLink(
      'rallywithai://invitations/accept?token=private-invitation-token-long-enough&region=eu',
    );

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://eu.api.rallywith.ai');
    expect(readDevicePreferences().selectedRegion).toBe('global');
  });

  it('replaces or clears the provider session when another native window changes it', async () => {
    const client = renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    const signedOutApi = observedApi;

    client.setQueryData(['private-workspace-data'], 'signed-out-cache');
    act(() => sessionListener?.(euSession));
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    expect(client.getQueryData(['private-workspace-data'])).toBeUndefined();
    expect(observedApi).not.toBe(signedOutApi);

    const signedInApi = observedApi;
    client.setQueryData(['private-workspace-data'], 'signed-in-cache');
    act(() => sessionListener?.(null));
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    expect(client.getQueryData(['private-workspace-data'])).toBeUndefined();
    expect(observedApi).not.toBe(signedInApi);
  });

  it('preserves cached and transient API state across routine access-token rotation', async () => {
    bridge.getSession.mockResolvedValueOnce(euSession);
    const client = renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    const initialApi = observedApi;
    client.setQueryData(['private-workspace-data'], 'still-mounted');

    const refreshedSession: DesktopSession = {
      ...euSession,
      accessToken: 'rotated-access-token-longer-than-twenty-characters',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    act(() => sessionListener?.(refreshedSession));

    expect(await screen.findByTestId('session-token')).toHaveTextContent(refreshedSession.accessToken);
    expect(client.getQueryData(['private-workspace-data'])).toBe('still-mounted');
    expect(observedApi).toBe(initialApi);

    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await observedApi!.getWorkspaceMembers();
    expect(new Headers(fetchRequest.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe(`Bearer ${refreshedSession.accessToken}`);
    fetchRequest.mockRestore();
  });

  it('preserves cached and transient API state across scheduled session refresh', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-07T12:00:00.000Z');
    vi.setSystemTime(now);
    const initialSession: DesktopSession = {
      ...euSession,
      accessToken: 'initial-scheduled-access-token-longer-than-twenty-characters',
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    };
    const refreshedSession: DesktopSession = {
      ...initialSession,
      accessToken: 'scheduled-rotated-access-token-longer-than-twenty-characters',
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    };
    bridge.getSession.mockResolvedValueOnce(initialSession);
    bridge.refreshSession.mockResolvedValueOnce(refreshedSession);
    const client = renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('eu:European Research')).toBeVisible();
    const initialApi = observedApi;
    client.setQueryDefaults(['private-workspace-data'], { gcTime: Infinity });
    client.setQueryData(['private-workspace-data'], 'still-mounted');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * 60_000);
    });

    expect(bridge.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session-token')).toHaveTextContent(refreshedSession.accessToken);
    expect(client.getQueryData(['private-workspace-data'])).toBe('still-mounted');
    expect(observedApi).toBe(initialApi);

    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await observedApi!.getWorkspaceMembers();
    expect(new Headers(fetchRequest.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe(`Bearer ${refreshedSession.accessToken}`);
    fetchRequest.mockRestore();
  });

  it('clears cached data and replaces the API client after a role-only demotion', async () => {
    const adminSession: DesktopSession = {
      ...euSession,
      workspace: { ...euSession.workspace!, role: 'admin' },
    };
    bridge.getSession.mockResolvedValueOnce(adminSession);
    const client = renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    expect(screen.getByTestId('session-role')).toHaveTextContent('admin');
    const adminApi = observedApi;
    client.setQueryData(['admin-only-data'], 'private');

    act(() => sessionListener?.({
      ...adminSession,
      accessToken: 'demoted-access-token-longer-than-twenty-characters',
      workspace: { ...adminSession.workspace!, role: 'member' },
    }));

    expect(await screen.findByTestId('session-role')).toHaveTextContent('member');
    expect(client.getQueryData(['admin-only-data'])).toBeUndefined();
    expect(observedApi).not.toBe(adminApi);
  });

  it('refreshes connector data immediately when native OAuth completes', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();
    await dispatchDeepLink(
      `rallywithai://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workstream'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['automation'] });
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    invalidate.mockRestore();
  });

  it('accepts a regional server-owned connector result and surfaces denial', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: futureExpiry,
    });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await dispatchDeepLink(
      `rallywithai://auth/complete?provider=linear&region=eu&attempt=${'a'.repeat(43)}&status=denied&error=oauth_denied`,
    );

    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('Linear authorization was cancelled');
  });

  it('rejects malformed connector UUIDs in legacy and server-owned completion links', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      expiresAt: futureExpiry,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();
    await dispatchDeepLink(
      'rallywithai://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected',
    );
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('invalid connector completion');

    await dispatchDeepLink(
      `rallywithai://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    );
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('invalid connector completion');
  });

  it('rejects a connector result from a different regional server', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: futureExpiry,
    });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await dispatchDeepLink(
      `rallywithai://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    );

    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('invalid connector completion');
  });

  it('consumes a Slack link token only through the authenticated regional session', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: futureExpiry,
    });
    bridge.openSettings.mockResolvedValueOnce(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchRequest = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamId: 'T01234567',
        slackUserId: 'U01234567',
        workspaceName: 'Acme',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
      linked: true,
      teamId: 'T01234567',
      slackUserId: 'U01234567',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // The link continues straight into the personal Slack authorization, so
      // one click in Slack does both halves rather than leaving the second as
      // an errand the member has to know about.
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://slack.com/oauth/v2_user/authorize?state=abc',
        attemptId: 'b'.repeat(43),
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(`rallywithai://slack/link?token=${'a'.repeat(43)}`);

    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(3));
    const [previewUrl, previewInit] = fetchRequest.mock.calls[0]!;
    const [linkUrl, linkInit] = fetchRequest.mock.calls[1]!;
    const [startUrl, startInit] = fetchRequest.mock.calls[2]!;
    expect(previewUrl).toBe('https://eu.api.rallywith.ai/connections/slack/link/preview');
    expect(linkUrl).toBe('https://eu.api.rallywith.ai/connections/slack/link');
    expect(startUrl).toBe('https://eu.api.rallywith.ai/connections/slack/start?telemetryVersion=2');
    expect(new Headers(previewInit?.headers).get('authorization')).toBe(`Bearer ${euSession.accessToken}`);
    expect(previewInit?.body).toBe(JSON.stringify({ token: 'a'.repeat(43) }));
    expect(linkInit?.body).toBe(JSON.stringify({ token: 'a'.repeat(43) }));
    expect(JSON.parse(String(startInit?.body))).toMatchObject({ scope: 'personal' });
    expect(confirm).toHaveBeenCalledWith(
      'Connect Slack user U01234567 from Acme to your Rally account, '
      + 'and let Rally search and act in Slack as you?',
    );
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://slack.com/oauth/v2_user/authorize?state=abc',
    ));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    fetchRequest.mockRestore();
    confirm.mockRestore();
  });

  it('keeps the link when the personal Slack authorization cannot be started', async () => {
    // The link committed and is useful on its own, so the failure is reported
    // without retracting what already succeeded.
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.openSettings.mockResolvedValueOnce(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchRequest = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamId: 'T01234567',
        slackUserId: 'U01234567',
        workspaceName: 'Acme',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        linked: true,
        teamId: 'T01234567',
        slackUserId: 'U01234567',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'provider_unavailable', message: 'nope' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(`rallywithai://slack/link?token=${'a'.repeat(43)}`);

    await waitFor(() => expect(screen.getByTestId('deep-link-error')).toHaveTextContent(
      /Slack was linked, but personal Slack tools could not be connected/u,
    ));
    fetchRequest.mockRestore();
    confirm.mockRestore();
  });

  it('does not consume a Slack link token when the user rejects its identity preview', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: futureExpiry,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      teamId: 'T01234567',
      slackUserId: 'U01234567',
      workspaceName: 'Acme',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(`rallywithai://slack/link?token=${'a'.repeat(43)}`);

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(String(fetchRequest.mock.calls[0]?.[0])).toContain('/connections/slack/link/preview');
    expect(bridge.openSettings).not.toHaveBeenCalled();
    fetchRequest.mockRestore();
    confirm.mockRestore();
  });

  it('opens the desktop settings window from a notification deep link', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    bridge.openSettings.mockResolvedValueOnce(undefined);
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();

    await dispatchDeepLink('rallywithai://settings/workspace');

    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('workspace'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('opens Connections and automation creation from exact public handoff links', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    bridge.openSettings.mockResolvedValue(undefined);
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();

    await dispatchDeepLink('rallywithai://settings/connections');
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));

    await dispatchDeepLink('rallywithai://automations/new');
    await waitFor(() => expect(window.location.hash).toBe('#/automations/new'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('opens the note a closing meeting window hands back', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();

    await dispatchDeepLink('rallywithai://notes/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30');

    await waitFor(() => expect(window.location.hash).toBe('#/notes/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('tells a signed-in person a note link is unreadable rather than telling them to sign in', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink('rallywithai://notes/not-a-note');

    // Signing in again does nothing about a link that names no note, so saying
    // so would send someone to a remedy that cannot work.
    await waitFor(() => expect(screen.getByTestId('deep-link-error'))
      .toHaveTextContent('Rally could not open that note link.'));
    expect(window.location.hash).toBe(before);
  });

  it('asks a signed-out person to sign in before opening a note', async () => {
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink('rallywithai://notes/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30');

    await waitFor(() => expect(screen.getByTestId('deep-link-error'))
      .toHaveTextContent('Sign in before opening this note.'));
    expect(window.location.hash).toBe(before);
  });

  it('opens the new work stream screen, which is how the menu bar starts one', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();

    await dispatchDeepLink('rallywithai://workstreams/new', 'menu_bar');

    // `/new` has to be read before the identifier branch, which would otherwise
    // measure it against the UUID pattern and reject it.
    await waitFor(() => expect(window.location.hash).toBe('#/workstreams/new'));
    expect(consumeSurfaceEntrypoint()).toBe('menu_bar');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it.each([
    'rallywithai://settings/workspace?section=connections',
    'rallywithai://settings/Workspace',
    'rallywithai://automations/new?template=unknown',
  ])('rejects a non-canonical settings deep link: %s', async (rawUrl) => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '7d7a69ac-59ef-4fc2-a022-f9629e631878',
        name: 'Juno Labs',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();
    await dispatchDeepLink(rawUrl);

    await waitFor(() => expect(screen.getByTestId('deep-link-error')).toHaveTextContent('unexpected sign-in link'));
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });
});

describe('draft cache lifetime across a session', () => {
  beforeEach(async () => {
    resetDesktopBridge();
    await clearAllDrafts();
  });

  it('keeps the drafts a previous run left behind when a session arrives', async () => {
    await writeDraftText('new-workstream:workspace-eu', 'written before the last quit');
    bridge.getSession.mockResolvedValue(euSession);

    renderProvider();

    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await waitFor(() => expect(observedApi).not.toBeNull());
    expect((await readDraftText('new-workstream:workspace-eu'))?.text).toBe('written before the last quit');
  });

  it('drops every draft when the session ends without going through signOut', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await writeDraftText('workstream:1', 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    // Main surrendering a terminally expired credential, not a button press.
    act(() => sessionListener?.(null));

    await waitFor(async () => expect(await readDraftText('workstream:1')).toBeNull());
  });

  it('abandons an opening attempt when the session that owns it ends', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    const workstreamId = '00000000-0000-4000-8000-000000000213';
    const operationId = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 100);
    bridge.reportTelemetryProductIntent.mockClear();

    act(() => sessionListener?.(null));

    await waitFor(() => expect(bridge.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_open_outcome',
      operationId,
      workstreamId,
      outcome: 'abandoned',
      durationMs: expect.any(Number),
    }));
    expect(workstreamFeedOpenAttemptId(workstreamId)).toBeUndefined();
  });

  it('drops every draft when another account takes over the device', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await writeDraftText('workstream:1', 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.({ ...euSession, user: { ...euSession.user, id: 'user-2' } }));

    await waitFor(async () => expect(await readDraftText('workstream:1')).toBeNull());
  });

  it('cannot be repopulated by a composer flushing its draft on the way out', async () => {
    function ComposerProbe(): React.JSX.Element {
      const { session } = useAppSession();
      return session ? <Composer /> : <output>gone</output>;
    }
    function Composer(): React.JSX.Element {
      const draft = useDraftText('workstream:1');
      return <button onClick={() => draft.setText('typed just before signing out')} type="button">type</button>;
    }
    bridge.getSession.mockResolvedValue(euSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AppSessionProvider><SessionProbe /><ComposerProbe /></AppSessionProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    // Typed inside the save debounce, so the write is still pending when the
    // session ends and the composer unmounts.
    act(() => screen.getByRole('button', { name: 'type' }).click());
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.(null));

    expect(await screen.findByText('gone')).toBeVisible();
    await waitFor(async () => expect(await readDraftText('workstream:1')).toBeNull());
    // The unmount flush has long since run; the clear still had the last word.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await readDraftText('workstream:1')).toBeNull();
  });
});
