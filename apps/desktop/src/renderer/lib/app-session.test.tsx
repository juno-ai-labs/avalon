import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvalonDesktopBridge, DesktopSession } from '../../common/desktop';
import { AppSessionProvider, useAppSession } from './app-session';
import type { AvalonApi } from './api';
import { readDevicePreferences } from './device-preferences';

let deepLinkListener: ((url: string) => void) | null = null;
let sessionListener: ((session: DesktopSession | null) => void) | null = null;
let observedApi: AvalonApi | null = null;
let observedSignOutIfCleared: (() => Promise<void>) | null = null;
const bridge = vi.hoisted(() => ({
  cancelDesktopAuthAttempt: vi.fn(),
  createDesktopAuthAttempt: vi.fn(),
  consumePendingDeepLinks: vi.fn(),
  copyText: vi.fn(),
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
}));

vi.mock('./platform', () => ({ desktopBridge: () => bridge as unknown as AvalonDesktopBridge }));

const futureExpiry = new Date(Date.now() + 60 * 60_000).toISOString();

const euSession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: futureExpiry,
  apiBaseUrl: 'https://eu.api.with-avalon.com',
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
  apiBaseUrl: 'https://api.with-avalon.com',
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

describe('single-platform desktop identity routing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
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
        global: 'https://api.with-avalon.com',
        eu: 'https://eu.api.with-avalon.com',
      },
      webBaseUrl: 'https://with-avalon.com',
      devAuthEnabled: false,
    });
    bridge.getSession.mockResolvedValue(null);
    bridge.hasStoredCredential.mockResolvedValue(false);
    bridge.consumePendingDeepLinks.mockResolvedValue([]);
    bridge.onDeepLink.mockImplementation((listener: (url: string) => void) => {
      deepLinkListener = listener;
      return () => { deepLinkListener = null; };
    });
    bridge.onSessionChanged.mockImplementation((listener: (session: DesktopSession | null) => void) => {
      sessionListener = listener;
      return () => { sessionListener = null; };
    });
    bridge.exchangeDesktopTicket.mockResolvedValue(globalIdentitySession);
  });

  it('accepts a callback only from the Global identity service', async () => {
    window.localStorage.setItem('avalon:selected-region', 'eu');
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(`avalon://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'a'.repeat(43)}`));

    await waitFor(() => expect(bridge.exchangeDesktopTicket).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.with-avalon.com',
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: 'a'.repeat(43),
    }));
    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(window.localStorage.getItem('avalon:selected-region')).toBeNull();
  });

  it('does not drain a cold-start OAuth callback until runtime endpoints are loaded', async () => {
    let resolveRuntime!: (value: Awaited<ReturnType<AvalonDesktopBridge['getRuntimeConfig']>>) => void;
    bridge.getRuntimeConfig.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntime = resolve;
    }));
    bridge.consumePendingDeepLinks.mockResolvedValueOnce([
      `avalon://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'b'.repeat(43)}`,
    ]);

    renderProvider();
    expect(bridge.consumePendingDeepLinks).not.toHaveBeenCalled();

    await act(async () => resolveRuntime({
      appVersion: 'test',
      isPackaged: true,
      platform: 'darwin',
      api: {
        global: 'https://api.with-avalon.com',
        eu: 'https://eu.api.with-avalon.com',
      },
      webBaseUrl: 'https://with-avalon.com',
      devAuthEnabled: false,
    }));

    await waitFor(() => expect(bridge.exchangeDesktopTicket).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.with-avalon.com',
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
        ? new Response(JSON.stringify({ url: 'wss://api.with-avalon.com/socket', ticket: 'socket-ticket' }))
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
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(`avalon://auth/complete?ticket=single-use-ticket-long-enough&region=eu&attempt=${'a'.repeat(43)}`));

    expect(bridge.exchangeDesktopTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('identity service');
  });

  it('keeps identity on Global while previewing a regional legacy invite link', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      'avalon://invitations/accept?token=private-invitation-token-long-enough&region=eu',
    ));

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://eu.api.with-avalon.com');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspace-onboarding'] });
    invalidate.mockRestore();
  });

  it('previews a cross-region invitation on its own API without moving the active session', async () => {
    const globalSession: DesktopSession = {
      ...euSession,
      apiBaseUrl: 'https://api.with-avalon.com',
      workspace: { ...euSession.workspace!, id: 'workspace-global', name: 'Global Research', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(globalSession);
    renderProvider();
    expect(await screen.findByText('global:Global Research')).toBeVisible();
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      'avalon://invitations/accept?token=private-invitation-token-long-enough&region=eu',
    ));

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://eu.api.with-avalon.com');
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
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      `avalon://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    ));

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
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      `avalon://auth/complete?provider=linear&region=eu&attempt=${'a'.repeat(43)}&status=denied&error=oauth_denied`,
    ));

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
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      'avalon://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected',
    ));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('invalid connector completion');

    act(() => deepLinkListener?.(
      `avalon://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    ));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('invalid connector completion');
  });

  it('rejects a connector result from a different regional server', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: futureExpiry,
    });
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();
    // The optional call is a silent no-op until the provider has registered its
    // listener, and rendering the session does not guarantee that has happened.
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(
      `avalon://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    ));

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
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    renderProvider();
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    act(() => deepLinkListener?.(`avalon://slack/link?token=${'a'.repeat(43)}`));

    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(2));
    const [previewUrl, previewInit] = fetchRequest.mock.calls[0]!;
    const [linkUrl, linkInit] = fetchRequest.mock.calls[1]!;
    expect(previewUrl).toBe('https://eu.api.with-avalon.com/connections/slack/link/preview');
    expect(linkUrl).toBe('https://eu.api.with-avalon.com/connections/slack/link');
    expect(new Headers(previewInit?.headers).get('authorization')).toBe(`Bearer ${euSession.accessToken}`);
    expect(previewInit?.body).toBe(JSON.stringify({ token: 'a'.repeat(43) }));
    expect(linkInit?.body).toBe(JSON.stringify({ token: 'a'.repeat(43) }));
    expect(confirm).toHaveBeenCalledWith('Connect Slack user U01234567 from Acme to your current Avalon account?');
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
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

    act(() => deepLinkListener?.(`avalon://slack/link?token=${'a'.repeat(43)}`));

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

    act(() => deepLinkListener?.('avalon://settings/workspace'));

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

    act(() => deepLinkListener?.('avalon://settings/connections'));
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));

    act(() => deepLinkListener?.('avalon://automations/new'));
    await waitFor(() => expect(window.location.hash).toBe('#/automations/new'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it.each([
    'avalon://settings/workspace?section=connections',
    'avalon://settings/Workspace',
    'avalon://automations/new?template=unknown',
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
    await waitFor(() => expect(deepLinkListener).not.toBeNull());

    act(() => deepLinkListener?.(rawUrl));

    await waitFor(() => expect(screen.getByTestId('deep-link-error')).toHaveTextContent('unexpected sign-in link'));
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });
});
