import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvalonDesktopBridge, DesktopSession } from '../../common/desktop';
import { AppSessionProvider, useAppSession } from './app-session';
import { readDevicePreferences } from './device-preferences';

let deepLinkListener: ((url: string) => void) | null = null;
let sessionListener: ((session: DesktopSession | null) => void) | null = null;
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
  logout: vi.fn(),
  onDeepLink: vi.fn(),
  onSessionChanged: vi.fn(),
  openExternal: vi.fn(),
  openSettings: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('./platform', () => ({ desktopBridge: () => bridge as unknown as AvalonDesktopBridge }));

const euSession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
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

function SessionProbe(): React.JSX.Element {
  const { booting, deepLinkError, invitationApi, pendingInvitation, region, session } = useAppSession();
  return (
    <>
      <output>
        {booting ? 'booting' : `${region ?? 'none'}:${pendingInvitation ? 'invite' : session?.workspace?.name ?? 'signed-out'}`}
      </output>
      <output data-testid="invitation-api">{invitationApi?.baseUrl ?? 'none'}</output>
      <output data-testid="session-email">{session?.user.email ?? 'none'}</output>
      <output data-testid="deep-link-error">{deepLinkError ?? 'none'}</output>
    </>
  );
}

function renderProvider(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppSessionProvider><SessionProbe /></AppSessionProvider>
    </QueryClientProvider>,
  );
}

describe('single-platform desktop identity routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    deepLinkListener = null;
    sessionListener = null;
    bridge.getRuntimeConfig.mockResolvedValue({
      appVersion: 'test',
      isPackaged: true,
      platform: 'darwin',
      api: {
        global: 'https://api.with-avalon.com',
        eu: 'https://eu.api.with-avalon.com',
      },
      devAuthEnabled: false,
    });
    bridge.getSession.mockResolvedValue(null);
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

  it('clears the native session after a terminal refresh failure so sign-in can restart', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    bridge.refreshSession.mockRejectedValueOnce(new Error('refresh token expired'));
    bridge.logout.mockResolvedValueOnce(undefined);

    renderProvider();

    await waitFor(() => expect(bridge.logout).toHaveBeenCalledTimes(1), { timeout: 2_500 });
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('session expired');
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
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.(euSession));
    expect(await screen.findByText('eu:European Research')).toBeVisible();

    act(() => sessionListener?.(null));
    expect(await screen.findByText('global:signed-out')).toBeVisible();
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

    act(() => deepLinkListener?.(
      'avalon://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected',
    ));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workstream'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['automation'] });
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    invalidate.mockRestore();
  });

  it('consumes a Slack link token only through the authenticated regional session', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...euSession,
      expiresAt: '2030-08-02T00:00:00.000Z',
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
      expiresAt: '2030-08-02T00:00:00.000Z',
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

    act(() => deepLinkListener?.(rawUrl));

    await waitFor(() => expect(screen.getByTestId('deep-link-error')).toHaveTextContent('unexpected sign-in link'));
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });
});
