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
import { workspaceActivationFailure } from '../../common/workspace-activation-error';
import {
  AppSessionProvider,
  useAppSession,
  type AppSessionDesktopBridge,
  type AppSessionValue,
} from './app-session';
import { clearAllDrafts, readDraftText, writeDraftText } from './draft-cache';
import { newWorkstreamDraftKey, workstreamDraftKey } from './draft-keys';
import { useDraftText } from './use-draft-text';
import { RallyApi } from './api';
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
let observedReconnectAccount: (() => Promise<void>) | null = null;
let observedSurrenderActiveWorkspace: (() => Promise<void>) | null = null;
let observedLeaveWorkspace: ((
  workspaceId: string,
  expectedOutcome: 'left' | 'abandoned',
) => Promise<unknown>) | null = null;
let observedPendingConnectorOAuth: AppSessionValue['pendingConnectorOAuth'] = null;
let observedSetPendingConnectorOAuth: AppSessionValue['setPendingConnectorOAuth'] | null = null;
const bridge = vi.hoisted(() => ({
  cancelDesktopAuthAttempt: vi.fn(),
  createDesktopAuthAttempt: vi.fn(),
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
  leaveWorkspace: vi.fn(),
  logout: vi.fn(),
  onDeepLink: vi.fn(),
  onSessionChanged: vi.fn(),
  openExternal: vi.fn(),
  openSettings: vi.fn(),
  refreshSession: vi.fn(),
  showDeepLinkError: vi.fn<RallyDesktopBridge['showDeepLinkError']>(async () => undefined),
  surrenderActiveWorkspace: vi.fn(),
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
  observedReconnectAccount = context.reconnectAccountIdentity;
  observedSurrenderActiveWorkspace = context.surrenderActiveWorkspace;
  observedLeaveWorkspace = context.leaveWorkspace;
  observedPendingConnectorOAuth = context.pendingConnectorOAuth;
  observedSetPendingConnectorOAuth = context.setPendingConnectorOAuth;
  return (
    <>
      <output>
        {booting ? 'booting' : `${region ?? 'none'}:${pendingInvitation ? 'invite' : session?.workspace?.name ?? 'signed-out'}`}
      </output>
      <output data-testid="invitation-api">{invitationApi?.baseUrl ?? 'none'}</output>
      <output data-testid="session-email">{session?.user.email ?? 'none'}</output>
      <output data-testid="session-token">{session?.accessToken ?? 'none'}</output>
      <output data-testid="session-role">{session?.workspace?.role ?? 'none'}</output>
      <output data-testid="pending-connector-attempt">{context.pendingConnectorOAuth?.attemptId ?? 'none'}</output>
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
/**
 * The message the failure window was last asked to show.
 *
 * Once there is a workspace a refused link leaves the renderer entirely — the
 * window that handled it is not reliably the one in front — so this, and not
 * the `deep-link-error` output, is where a signed-in failure now shows up.
 * Signed-out failures still render inline and are still asserted there.
 */
function lastDeepLinkFailure(): string | null {
  const calls = bridge.showDeepLinkError.mock.calls;
  return calls.at(-1)?.[0] ?? null;
}

function resetDesktopBridge(): void {
  vi.clearAllMocks();
  window.localStorage.clear();
  deepLinkListener = null;
  sessionListener = null;
  observedApi = null;
  observedSignOutIfCleared = null;
  observedReconnectAccount = null;
  observedSurrenderActiveWorkspace = null;
  observedLeaveWorkspace = null;
  observedPendingConnectorOAuth = null;
  observedSetPendingConnectorOAuth = null;
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
  // A scheduled refresh can fire more than once in a test that lets the clock
  // run past the retry delay. Without a default this resolves `undefined` and
  // the provider blanks the session; resolving the same object it already
  // holds is a no-op re-render instead.
  bridge.refreshSession.mockResolvedValue(expiredIdentitySession);
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
  bridge.createDesktopAuthAttempt.mockResolvedValue({
    attemptId: 'a'.repeat(43),
    codeChallenge: 'challenge',
  });
  bridge.surrenderActiveWorkspace.mockResolvedValue(null);
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
    await act(async () => {
      deepLinkListener!({ url, entrypoint });
      await Promise.resolve();
      await Promise.resolve();
    });
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

  it('starts an in-place platform identity reconnect from an active workspace', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    const beginGoogleLogin = vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await act(async () => { await observedReconnectAccount?.(); });

    expect(bridge.createDesktopAuthAttempt).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
    });
    expect(beginGoogleLogin).toHaveBeenCalledWith(
      'global',
      'rallywithai://auth/complete',
      { authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'challenge' } },
    );
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    );
  });

  it('moves to the next stored workspace after active membership is revoked', async () => {
    const nextSession: DesktopSession = {
      ...euSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: {
        ...euSession.workspace!,
        id: 'workspace-global',
        name: 'Global Studio',
        region: 'global',
      },
    };
    bridge.getSession.mockResolvedValue(euSession);
    bridge.surrenderActiveWorkspace.mockResolvedValue(nextSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await act(async () => { await observedSurrenderActiveWorkspace?.(); });

    expect(bridge.surrenderActiveWorkspace).toHaveBeenCalledOnce();
    expect(screen.getByText('global:Global Studio')).toBeVisible();
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
    vi.useFakeTimers();
    bridge.getSession.mockResolvedValue(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValueOnce(new Error('network unreachable'));

    renderProvider();

    // Boot has to settle before the clock moves: the refresh timer is armed by
    // the effect that runs once `session:get` resolves, so advancing straight
    // past its 1s delay would move the clock before there was a timer to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bridge.refreshSession).toHaveBeenCalledTimes(1);
    expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('keeps retrying a permanently failing refresh while the credential is still stored', async () => {
    // Main surrenders the credential when a refresh can never succeed, so a
    // refresh that keeps failing with one still on disk is by definition
    // transient and must never strand the user on the sign-in screen.
    vi.useFakeTimers();
    bridge.getSession.mockResolvedValue(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValue(new Error('regional service unreachable'));

    renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(bridge.refreshSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(bridge.refreshSession).toHaveBeenCalledTimes(2);
    expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('does not probe the network to decide whether the credential was surrendered', async () => {
    // `session:get` refreshes to rebuild a missing profile cache, so using it
    // as the oracle would let a network blip masquerade as an expiry.
    vi.useFakeTimers();
    bridge.getSession.mockResolvedValueOnce(expiredIdentitySession);
    bridge.hasStoredCredential.mockResolvedValue(true);
    bridge.refreshSession.mockRejectedValueOnce(new Error('network unreachable'));

    renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bridge.hasStoredCredential).toHaveBeenCalledTimes(1);
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

  it('activates the connector attempt workspace before applying its completion', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000019';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: targetWorkspaceId,
        name: 'Origin Workspace',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=granola`,
    );

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: targetWorkspaceId,
    }));
    expect(await screen.findByText('global:Origin Workspace')).toBeVisible();
  });

  it('returns from workspace B to same-region workspace A for connector completion', async () => {
    const workspaceA = '00000000-0000-7000-8000-000000000023';
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000026';
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '00000000-0000-7000-8000-000000000024',
        name: 'Workspace B',
        region: 'global',
        role: 'member',
      },
    });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: workspaceA, name: 'Workspace A', region: 'global', role: 'owner' },
    });
    renderProvider();
    expect(await screen.findByText('global:Workspace B')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceA}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=slack`,
    );

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: workspaceA,
    }));
    expect(await screen.findByText('global:Workspace A')).toBeVisible();
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));
    expect(window.location.hash).toBe('#/workstreams/new');
  });

  it.each([
    {
      name: 'work-stream',
      url: 'rallywithai://workspace/eu/00000000-0000-7000-8000-000000000030/workstreams/00000000-0000-7000-8000-000000000031',
      assertDestination: async () => expect(window.location.hash)
        .toBe('#/workstreams/00000000-0000-7000-8000-000000000031'),
    },
    {
      name: 'settings',
      url: 'rallywithai://workspace/eu/00000000-0000-7000-8000-000000000030/settings/connections',
      assertDestination: async () => waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections')),
    },
    {
      name: 'automation',
      url: 'rallywithai://workspace/eu/00000000-0000-7000-8000-000000000030/automations/new',
      assertDestination: async () => expect(window.location.hash).toBe('#/automations/new'),
    },
    {
      name: 'connector result',
      url: `rallywithai://workspace/eu/00000000-0000-7000-8000-000000000030/auth/complete?connection=00000000-0000-7000-8000-000000000032&status=connected&attempt=${'a'.repeat(43)}&provider=google`,
      assertDestination: async () => waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections')),
    },
  ])('activates an addressed $name link from an identity-only session', async ({ url, assertDestination }) => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000030';
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValue({
      ...euSession,
      expiresAt: futureExpiry,
      workspace: {
        id: targetWorkspaceId,
        name: 'Addressed Workspace',
        region: 'eu',
        role: 'member',
      },
    });
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();

    await dispatchDeepLink(url);

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'eu',
      workspaceId: targetWorkspaceId,
    }));
    await assertDestination();
    expect(lastDeepLinkFailure()).toBeNull();
  });

  it('serializes addressed resource links in delivery order', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000033';
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000034';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000035';
    const activations: Array<{ resolve: (session: DesktopSession) => void }> = [];
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockImplementation(() => new Promise<DesktopSession>((resolve) => {
      activations.push({ resolve });
    }));
    const activated: DesktopSession = {
      ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Ordered Workspace', region: 'global', role: 'member' },
    };
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/workstreams/${firstWorkstreamId}`,
    );
    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/workstreams/${secondWorkstreamId}`,
    );

    await waitFor(() => expect(activations).toHaveLength(1));
    activations[0]!.resolve(activated);
    await waitFor(() => expect(activations).toHaveLength(2));
    activations[1]!.resolve(activated);
    await waitFor(() => expect(window.location.hash).toBe(`#/workstreams/${secondWorkstreamId}`));
  });

  it('continues serialized deep-link delivery after one action rejects', async () => {
    const workstreamId = '00000000-0000-7000-8000-000000000036';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.openSettings.mockRejectedValueOnce(new Error('Settings could not be opened'));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink('rallywithai://settings/connections');
    await dispatchDeepLink(`rallywithai://workstreams/${workstreamId}`);

    await waitFor(() => expect(window.location.hash).toBe(`#/workstreams/${workstreamId}`));
  });

  it('does not apply a connector result when its workspace cannot be activated', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000025';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(workspaceActivationFailure('workspace_access_denied'));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=notion`,
    );

    await waitFor(() => expect(lastDeepLinkFailure()).toContain('access'));
    expect(screen.getByText('eu:European Research')).toBeVisible();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['connections'] });
    invalidate.mockRestore();
  });

  it('does not navigate when a workspace-addressed work-stream link cannot be activated', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000020';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(workspaceActivationFailure('workspace_access_denied'));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/workstreams/00000000-0000-7000-8000-000000000021`,
    );

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: targetWorkspaceId,
    }));
    expect(window.location.hash).toBe(before);
    expect(lastDeepLinkFailure()).toContain('access');
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

    expect(lastDeepLinkFailure()).toContain('Linear authorization was cancelled');
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
    expect(lastDeepLinkFailure()).toContain('invalid connector completion');

    await dispatchDeepLink(
      `rallywithai://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    );
    expect(lastDeepLinkFailure()).toContain('invalid connector completion');
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

    expect(lastDeepLinkFailure()).toContain('invalid connector completion');
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
    expect(startUrl).toBe(
      'https://eu.api.rallywith.ai/connections/slack/start?telemetryVersion=2&desktopHandoffVersion=2',
    );
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

  it('renews a rejected bearer while consuming a workspace-addressed Slack link', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000036';
    const staleSession: DesktopSession = {
      ...globalIdentitySession,
      expiresAt: futureExpiry,
      workspace: { id: workspaceId, name: 'Slack Workspace', region: 'global', role: 'member' },
    };
    const renewedSession = {
      ...staleSession,
      accessToken: 'renewed-target-token-longer-than-twenty-characters',
    };
    bridge.getSession.mockResolvedValueOnce(staleSession);
    bridge.activateWorkspace.mockResolvedValue(staleSession);
    bridge.refreshSession.mockResolvedValue(renewedSession);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchRequest = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'invalid_session', message: 'expired' },
      }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamId: 'T01234567',
        slackUserId: 'U01234567',
        workspaceName: 'Acme',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    renderProvider();
    expect(await screen.findByText('global:Slack Workspace')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/slack/link?token=${'a'.repeat(43)}`,
    );

    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(2));
    expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId,
    });
    expect(bridge.refreshSession).toHaveBeenCalledOnce();
    expect(new Headers(fetchRequest.mock.calls[1]?.[1]?.headers).get('authorization'))
      .toBe(`Bearer ${renewedSession.accessToken}`);
    expect(confirm).toHaveBeenCalledOnce();
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

    await waitFor(() => expect(lastDeepLinkFailure()).toMatch(
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

    // The builder this link used to open is gone: an automation is drafted by
    // asking for one in a work stream, so the link lands where that happens.
    // The link itself keeps working — somebody's bookmark should not 404.
    await dispatchDeepLink('rallywithai://automations/new');
    await waitFor(() => expect(window.location.hash).toBe('#/workstreams/new'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('activates a workspace-addressed settings destination before opening it', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000026';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: targetWorkspaceId,
        name: 'Notification Workspace',
        region: 'global',
        role: 'member',
      },
    });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/settings/digest`,
    );

    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('digest'));
    expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: targetWorkspaceId,
    });
  });

  it('preserves a pending connector attempt while another workspace is active', async () => {
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    await waitFor(() => expect(observedSetPendingConnectorOAuth).not.toBeNull());

    act(() => observedSetPendingConnectorOAuth?.({
      attemptId: 'a'.repeat(43),
      provider: 'slack',
      region: 'eu',
      workspaceId: euSession.workspace!.id,
    }));
    expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('a'.repeat(43));

    act(() => sessionListener?.({
      ...globalIdentitySession,
      workspace: {
        id: '00000000-0000-7000-8000-000000000037',
        name: 'Workspace B',
        region: 'global',
        role: 'member',
      },
    }));

    expect(await screen.findByText('global:Workspace B')).toBeVisible();
    expect(observedPendingConnectorOAuth?.workspaceId).toBe(euSession.workspace!.id);
    expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('a'.repeat(43));
  });

  it('distinguishes a retryable workspace activation outage from denied access', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000038';
    bridge.getSession.mockResolvedValueOnce({ ...euSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(
      new Error('Rally could not reach the selected regional service.'),
    );
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/workstreams/00000000-0000-7000-8000-000000000039`,
    );

    await waitFor(() => expect(lastDeepLinkFailure()).toContain('Check your connection'));
    expect(lastDeepLinkFailure()).toContain('reopen this link');
    expect(window.location.hash).toBe(before);
    expect(screen.getByText('eu:European Research')).toBeVisible();
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
    await waitFor(() => expect(lastDeepLinkFailure()).toBe('Rally could not open that note link.'));
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

  it('gives a signed-in person without a workspace the window, not the inline message', async () => {
    // `SignInScreen` is the only surface that renders the inline message, and
    // `SessionGate` shows it only when there is no session at all. Someone who
    // has signed in but not joined a workspace is on `WorkspaceOnboardingGate`,
    // which renders neither — so routing them inline files the failure where
    // nothing draws it.
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession, expiresAt: futureExpiry });
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();

    await dispatchDeepLink('rallywithai://notes/not-a-note');

    await waitFor(() => expect(lastDeepLinkFailure()).toBe('Rally could not open that note link.'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
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

    await waitFor(() => expect(lastDeepLinkFailure()).toContain('unexpected sign-in link'));
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
    await waitFor(async () => expect((await readDraftText(
      newWorkstreamDraftKey('eu', 'workspace-eu'),
    ))?.text).toBe('written before the last quit'));
  });

  it('drops every draft when the session ends without going through signOut', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    const draftKey = workstreamDraftKey('eu', 'workspace-eu', '1');
    await writeDraftText(draftKey, 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    // Main surrendering a terminally expired credential, not a button press.
    act(() => sessionListener?.(null));

    await waitFor(async () => expect(await readDraftText(draftKey)).toBeNull());
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
    const draftKey = workstreamDraftKey('eu', 'workspace-eu', '1');
    await writeDraftText(draftKey, 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.({
      ...euSession,
      user: { ...euSession.user, id: 'user-2', email: 'another@example.com' },
    }));

    await waitFor(async () => expect(await readDraftText(draftKey)).toBeNull());
  });

  it('preserves both workspace draft scopes while switching within one account', async () => {
    const globalSession: DesktopSession = {
      ...euSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...euSession.workspace!, id: 'workspace-global', name: 'Global Research', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(euSession);
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    const euDraft = workstreamDraftKey('eu', 'workspace-eu', '1');
    const globalDraft = workstreamDraftKey('global', 'workspace-global', '2');
    await writeDraftText(euDraft, 'eu thought');
    await writeDraftText(globalDraft, 'global thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.(globalSession));

    expect(await screen.findByText('global:Global Research')).toBeVisible();
    expect((await readDraftText(euDraft))?.text).toBe('eu thought');
    expect((await readDraftText(globalDraft))?.text).toBe('global thought');
  });

  it('clears only the departed workspace draft scope after leave succeeds', async () => {
    bridge.getSession.mockResolvedValue(euSession);
    bridge.leaveWorkspace.mockResolvedValue({ outcome: 'left' });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    const euDraft = workstreamDraftKey('eu', 'workspace-eu', '1');
    const globalDraft = workstreamDraftKey('global', 'workspace-eu', '2');
    await writeDraftText(euDraft, 'eu thought');
    await writeDraftText(globalDraft, 'global thought');
    await waitFor(() => expect(observedLeaveWorkspace).not.toBeNull());

    await act(async () => {
      await observedLeaveWorkspace?.('workspace-eu', 'left');
    });

    expect(bridge.leaveWorkspace).toHaveBeenCalledWith({
      expectedOutcome: 'left',
      region: 'eu',
      workspaceId: 'workspace-eu',
    });
    expect(await readDraftText(euDraft)).toBeNull();
    expect((await readDraftText(globalDraft))?.text).toBe('global thought');
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
