import * as Tooltip from '@radix-ui/react-tooltip';
import { TitlePillHeader } from '@rally/ui/components/title-pill';
import { IconCircle } from '@tabler/icons-react';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { AppRouteNavigation } from './app-navigation';
import { NavigationHistoryProvider } from '../components/navigation-history';
import type { ReactNode } from 'react';
import "../../../../../tests/isolated-region";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RallyDesktopBridge,
  DesktopDeepLinkEntrypoint,
  DesktopDeepLinkNavigation,
  DesktopSession,
  RuntimeConfig,
} from '../../common/desktop';
import { accountReconnectRequiredFailure, workspaceActivationFailure } from '../../common/workspace-activation-error';
import { canvasDeepLink, sidekickDeepLink } from '@rally/contracts/links';
import {
  AccountSignInFailedError,
  AccountSignInSupersededError,
  AppSessionProvider,
  type AppSessionDesktopBridge,
  type AppSessionValue,
  useAppSession,
  WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
} from './app-session';
import { clearAllDrafts, readDraftText, writeDraftText } from './draft-cache';
import { defineLocalCacheSlice, localCacheScope } from './local-cache';
import { newWorkstreamDraftKey, workstreamDraftKey } from './draft-keys';
import { useDraftText } from './use-draft-text';
import { useCollaborationSession, type ConnectorSetupCapability } from './collaboration-session';
import { RallyApi } from './api';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from './use-client-feature-flags';
import { accountOnboardingQueryKey } from './account-onboarding-query';
import { readDevicePreferences } from './device-preferences';
import { useUiStore } from './ui-store';
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
let observedAbandonAccountSignIn: (() => void) | null = null;
let observedSurrenderActiveWorkspace: (() => Promise<void>) | null = null;
let observedActivateWorkspace: AppSessionValue['activateWorkspace'] | null = null;
let observedFinishWorkspaceSetup: AppSessionValue['finishWorkspaceSetup'] | null = null;
let observedLeaveWorkspace: ((
  workspaceId: string,
  expectedOutcome: 'left' | 'abandoned',
) => Promise<unknown>) | null = null;
let observedPendingConnectorOAuth: AppSessionValue['pendingConnectorOAuth'] = null;
let observedSetPendingConnectorOAuth: AppSessionValue['setPendingConnectorOAuth'] | null = null;
let observedSetResourceAuthorizationAttempt: ConnectorSetupCapability['setResourceAuthorizationAttempt'] | null = null;
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
  getAccountOnboarding: vi.fn(),
  updateAccountOnboarding: vi.fn(),
  getOrganizationNameSuggestion: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getSession: vi.fn(),
  hasStoredCredential: vi.fn(),
  leaveWorkspace: vi.fn(),
  logout: vi.fn(),
  onDeepLink: vi.fn(),
  onSessionChanged: vi.fn(),
  openExternal: vi.fn(),
  openSidekick: vi.fn().mockResolvedValue(undefined),
  openSettings: vi.fn(),
  refreshSession: vi.fn(),
  reselectActiveWorkspace: vi.fn(),
  showDeepLinkError: vi.fn<RallyDesktopBridge['showDeepLinkError']>(async () => undefined),
  surrenderActiveWorkspace: vi.fn(),
  listSupportWorkspaces: vi.fn(),
  listSupportPeople: vi.fn(),
  startSupportSession: vi.fn(),
  endSupportSession: vi.fn(),
  reportTelemetryProductIntent: vi.fn(),
}) satisfies AppSessionDesktopBridge & Pick<RallyDesktopBridge, 'reportTelemetryProductIntent'>);

vi.mock('./platform', () => ({ desktopBridge: () => bridge }));

const futureExpiry = new Date(Date.now() + 60 * 60_000).toISOString();

/**
 * Any row at all: the wipes go by scope, not by shape, so the shape here is
 * whatever is simplest to write and read back.
 */
const rememberedRows = defineLocalCacheSlice<{ remembered: boolean }>({
  kind: 'test-remembered',
  version: 1,
  parse: (value) => value !== null && typeof value === 'object' && (value as { remembered?: unknown }).remembered === true
    ? { remembered: true }
    : null,
});

const enterpriseSession: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: futureExpiry,
  apiBaseUrl: 'https://enterprise.api.rallywith.ai',
  user: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee' },
  workspace: {
    id: 'workspace-enterprise',
    name: 'European Research',
    region: 'enterprise',
    role: 'member',
  },
};

const globalIdentitySession: DesktopSession = {
  ...enterpriseSession,
  apiBaseUrl: 'https://api.rallywith.ai',
  workspace: null,
};

const expiredIdentitySession: DesktopSession = {
  ...globalIdentitySession,
  expiresAt: '2020-01-01T00:00:00.000Z',
};

function SessionProbe(): React.JSX.Element {
  const context = useAppSession();
  const collaboration = useCollaborationSession();
  const { api, booting, deepLinkError, invitationApi, pendingInvitation, region, session } = context;
  observedApi = api;
  observedSignOutIfCleared = context.signOutIfCredentialCleared;
  observedReconnectAccount = context.reconnectAccountIdentity;
  observedAbandonAccountSignIn = context.abandonAccountSignIn;
  observedSurrenderActiveWorkspace = context.surrenderActiveWorkspace;
  observedActivateWorkspace = context.activateWorkspace;
  observedFinishWorkspaceSetup = context.finishWorkspaceSetup;
  observedLeaveWorkspace = context.leaveWorkspace;
  observedPendingConnectorOAuth = context.pendingConnectorOAuth;
  observedSetPendingConnectorOAuth = context.setPendingConnectorOAuth;
  observedSetResourceAuthorizationAttempt = collaboration.connectorSetup?.setResourceAuthorizationAttempt ?? null;
  return (
    <>
      <output data-testid="collaboration-context">{collaboration.api === context.api && collaboration.session === context.session && collaboration.connectorSetup !== null ? 'shared' : 'mismatch'}</output>
      <output>
        {booting ? 'booting' : `${region ?? 'none'}:${pendingInvitation ? 'invite' : session?.workspace?.name ?? 'signed-out'}`}
      </output>
      <output data-testid="invitation-api">{invitationApi?.baseUrl ?? 'none'}</output>
      <output data-testid="session-email">{session?.user.email ?? 'none'}</output>
      <output data-testid="session-token">{(session && 'accessToken' in session ? String(session.accessToken) : null) ?? 'none'}</output>
      <output data-testid="session-role">{session?.workspace?.role ?? 'none'}</output>
      <output data-testid="pending-connector-attempt">{context.pendingConnectorOAuth?.attemptId ?? 'none'}</output>
      <output data-testid="pending-resource-status">{collaboration.connectorSetup?.resourceAuthorizationAttempts['connection:file:tool']?.resourceAuthorizationStatus ?? 'none'}</output>
      <output data-testid="other-resource-status">{collaboration.connectorSetup?.resourceAuthorizationAttempts['connection:file:other']?.resourceAuthorizationStatus ?? 'none'}</output>
      <output data-testid="deep-link-error">{deepLinkError ?? 'none'}</output>
    </>
  );
}

function DeepLinkHistoryProbe(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <TitlePillHeader current={{ key: 'current', title: 'Thread', icon: <IconCircle />, label: 'Thread menu' }} />
    <output data-testid="history-route">{location.pathname}</output>
    <button onClick={() => void navigate('/workstreams/ordinary-visit')}>Visit another thread</button>
  </>;
}

function renderProvider(route?: ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppSessionProvider><SessionProbe />{route}</AppSessionProvider>
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
  observedActivateWorkspace = null;
  observedFinishWorkspaceSetup = null;
  observedLeaveWorkspace = null;
  observedPendingConnectorOAuth = null;
  observedSetPendingConnectorOAuth = null;
  observedSetResourceAuthorizationAttempt = null;
  bridge.getRuntimeConfig.mockResolvedValue({
    appVersion: 'test',
    isPackaged: true,
    platform: 'darwin',
    api: {
      global: 'https://api.rallywith.ai',
      enterprise: 'https://enterprise.api.rallywith.ai',
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
  // The preload answers a cancellation with a promise; the seam must too.
  bridge.cancelDesktopAuthAttempt.mockResolvedValue(undefined);
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
  // Main answers a link with the active session only when a test says the
  // target is active; otherwise every addressed link activates, as before.
  bridge.reselectActiveWorkspace.mockResolvedValue(null);
  // A test that navigates leaves the hash behind for the next one.
  window.location.hash = '';
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
    window.localStorage.setItem('rally:selected-region', 'enterprise');
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
    expect(screen.getByTestId('collaboration-context')).toHaveTextContent('shared');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(window.localStorage.getItem('rally:selected-region')).toBeNull();
  });

  const ticketCallback = `rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'a'.repeat(43)}`;
  const missingIdentity = (): Error => new Error(
    `Error invoking remote method 'onboarding:activate-organization': Error: ${accountReconnectRequiredFailure().message}`,
  );

  it('signs the account in from an active organization and settles once the browser callback has landed', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    // Main answers a reconnect under an active workspace with that same session.
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    const beginGoogleLogin = vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    client.setQueryData(WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY, { identity: 'reconnect_required' });

    let settled = false;
    const reconnect = observedReconnectAccount!().then(() => { settled = true; });
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    ));
    expect(bridge.createDesktopAuthAttempt).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
    });
    expect(beginGoogleLogin).toHaveBeenCalledWith(
      'global',
      'rallywithai://auth/complete',
      { authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'challenge' } },
    );
    // Opening the browser is not the sign-in: nothing settles, and nothing the
    // menu holds is touched, until the callback has been exchanged.
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    expect(client.getQueryState(WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY)?.isInvalidated).toBe(false);

    await dispatchDeepLink(ticketCallback);
    await reconnect;

    expect(settled).toBe(true);
    expect(client.getQueryState(WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
  });

  it('lands a switch that had to sign the account in first, and tells the row about the detour', async () => {
    const nextSession: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...enterpriseSession.workspace!, id: 'workspace-global', name: 'Global Studio', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    bridge.activateWorkspace
      .mockRejectedValueOnce(missingIdentity())
      .mockResolvedValueOnce(nextSession);
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    const getWorkspace = vi.spyOn(RallyApi.prototype, 'getWorkspace').mockResolvedValue({
      id: 'workspace-global', name: 'Global Studio', region: 'global', timezone: 'America/New_York',
      currentUser: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee', timezone: 'America/New_York', role: 'member' },
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const onSignInRequired = vi.fn();
    let landed = false;
    const activation = observedActivateWorkspace!('global', 'workspace-global', undefined, { onSignInRequired })
      .then(() => { landed = true; });
    await waitFor(() => expect(onSignInRequired).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledOnce());
    expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
    expect(landed).toBe(false);
    expect(screen.getByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(ticketCallback);
    await act(async () => { await activation; });

    expect(bridge.activateWorkspace).toHaveBeenCalledTimes(2);
    expect(bridge.activateWorkspace).toHaveBeenLastCalledWith({
      region: 'global', workspaceId: 'workspace-global', operationId: undefined,
    });
    expect(await screen.findByText('global:Global Studio')).toBeVisible();
    expect(window.location.hash).toBe('#/');
    getWorkspace.mockRestore();
  });

  it('fails the waiting switch with the sign-in failure when the browser callback reports one', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.activateWorkspace.mockRejectedValueOnce(missingIdentity());
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const failure = observedActivateWorkspace!('global', 'workspace-global', undefined, { onSignInRequired: vi.fn() })
      .then(() => null, (error: unknown) => error);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledOnce());
    await dispatchDeepLink(`rallywithai://auth/complete?error=access_denied&region=global&attempt=${'a'.repeat(43)}`);
    const error = await failure;

    expect(error).toBeInstanceOf(AccountSignInFailedError);
    expect((error as Error).message).toBe('Sign in could not be completed: access denied');
    expect(bridge.cancelDesktopAuthAttempt).toHaveBeenCalledWith('a'.repeat(43));
    // The row shows it; the window does not also raise a dialog for it.
    expect(bridge.showDeepLinkError).not.toHaveBeenCalled();
    expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
  });

  it('reports a sign-in that never reached the browser under the row, not as an organization outage', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.activateWorkspace.mockRejectedValueOnce(missingIdentity());
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockRejectedValue(new Error('Google authentication is not configured'));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const onSignInRequired = vi.fn();
    const error = await observedActivateWorkspace!('global', 'workspace-global', undefined, { onSignInRequired })
      .then(() => null, (failure: unknown) => failure);

    expect(onSignInRequired).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(AccountSignInFailedError);
    expect((error as Error).message).toBe('Rally could not open the sign-in page');
    expect(bridge.cancelDesktopAuthAttempt).toHaveBeenCalledWith('a'.repeat(43));
    expect(bridge.openExternal).not.toHaveBeenCalled();
    expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('stands an earlier sign-in waiter down when a newer sign-in is started', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    bridge.createDesktopAuthAttempt
      .mockResolvedValueOnce({ attemptId: 'a'.repeat(43), codeChallenge: 'challenge' })
      .mockResolvedValueOnce({ attemptId: 'b'.repeat(43), codeChallenge: 'challenge' });
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const first = observedReconnectAccount!();
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(1));
    const second = observedReconnectAccount!();
    await expect(first).rejects.toBeInstanceOf(AccountSignInSupersededError);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(2));

    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'b'.repeat(43)}`);

    await expect(second).resolves.toBeUndefined();
  });

  it('lets a callback from a superseded attempt say nothing to the sign-in now waiting', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.createDesktopAuthAttempt
      .mockResolvedValueOnce({ attemptId: 'a'.repeat(43), codeChallenge: 'challenge' })
      .mockResolvedValueOnce({ attemptId: 'b'.repeat(43), codeChallenge: 'challenge' });
    // Main honours only the newest attempt: the earlier tab's ticket is refused.
    bridge.exchangeDesktopTicket.mockImplementation(async ({ attemptId }: { attemptId: string }) => {
      if (attemptId !== 'b'.repeat(43)) throw new Error('This sign-in attempt expired. Start sign-in again.');
      return enterpriseSession;
    });
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const first = observedReconnectAccount!();
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(1));
    const second = observedReconnectAccount!();
    await expect(first).rejects.toBeInstanceOf(AccountSignInSupersededError);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(2));
    let settled: 'resolved' | 'rejected' | null = null;
    void second.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });

    // The earlier tab reports a failure, then hands in its ticket anyway.
    await dispatchDeepLink(`rallywithai://auth/complete?error=access_denied&region=global&attempt=${'a'.repeat(43)}`);
    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'a'.repeat(43)}`);
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBeNull();
    expect(bridge.showDeepLinkError).not.toHaveBeenCalled();

    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'b'.repeat(43)}`);
    await expect(second).resolves.toBeUndefined();
  });

  it('stands the earlier waiter down as soon as main honours a newer attempt, even when the browser never opens', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.createDesktopAuthAttempt
      .mockResolvedValueOnce({ attemptId: 'a'.repeat(43), codeChallenge: 'challenge' })
      .mockResolvedValueOnce({ attemptId: 'b'.repeat(43), codeChallenge: 'challenge' });
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValueOnce('https://accounts.google.com/o/oauth2/v2/auth?state=opaque')
      .mockRejectedValueOnce(new Error('Google authentication is not configured'));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const first = observedReconnectAccount!();
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(1));
    const second = observedReconnectAccount!();

    // Nothing is left parked on an attempt main has already retired.
    await expect(first).rejects.toBeInstanceOf(AccountSignInSupersededError);
    await expect(second).rejects.toThrow('Google authentication is not configured');
    expect(bridge.cancelDesktopAuthAttempt).toHaveBeenCalledWith('b'.repeat(43));
    expect(bridge.openExternal).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer activation\'s mark when the earlier one it superseded unwinds', async () => {
    const workspaceGlobal = 'workspace-global';
    const activated: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...enterpriseSession.workspace!, id: workspaceGlobal, name: 'Global Studio', region: 'global' },
    };
    const record = {
      id: workspaceGlobal, name: 'Global Studio', region: 'global' as const, timezone: 'America/New_York',
      currentUser: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee', timezone: 'America/New_York', role: 'member' as const },
    };
    let resolveRecord!: (value: typeof record) => void;
    const getWorkspace = vi.spyOn(RallyApi.prototype, 'getWorkspace').mockImplementation(
      () => new Promise((resolve) => { resolveRecord = resolve; }),
    );
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    bridge.createDesktopAuthAttempt
      .mockResolvedValueOnce({ attemptId: 'a'.repeat(43), codeChallenge: 'challenge' })
      .mockResolvedValueOnce({ attemptId: 'b'.repeat(43), codeChallenge: 'challenge' });
    // Both attempts find the identity missing; the one whose sign-in lands
    // activates, and main announces that session before the IPC reply.
    bridge.activateWorkspace
      .mockRejectedValueOnce(missingIdentity())
      .mockRejectedValueOnce(missingIdentity())
      .mockImplementationOnce(async () => {
        sessionListener?.(activated);
        return activated;
      });
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    const first = observedActivateWorkspace!('global', workspaceGlobal, undefined, { onSignInRequired: vi.fn() })
      .then(() => null, (error: unknown) => error);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(1));
    let second!: Promise<void>;
    await act(async () => {
      second = observedActivateWorkspace!('global', workspaceGlobal, undefined, { onSignInRequired: vi.fn() });
      await Promise.resolve();
    });
    expect(await first).toBeInstanceOf(AccountSignInSupersededError);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledTimes(2));

    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'b'.repeat(43)}`);
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(1));
    // The early announcement did not take the previous workspace down: the
    // superseded attempt's unwinding left the newer attempt's mark in place.
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
    await act(async () => { resolveRecord(record); await second; });

    expect(await screen.findByText('global:Global Studio')).toBeVisible();
    getWorkspace.mockRestore();
  });

  it('signs in in place for an addressed link into another organization, and opens it once the sign-in lands', async () => {
    const workspaceGlobal = '00000000-0000-7000-8000-000000000030';
    const activated: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...enterpriseSession.workspace!, id: workspaceGlobal, name: 'Global Studio', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    bridge.activateWorkspace.mockRejectedValueOnce(missingIdentity()).mockResolvedValueOnce(activated);
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(canvasDeepLink({ region: 'global', workspaceId: workspaceGlobal, canvasId: '00000000-0000-7000-8000-000000000031' }));
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledOnce());
    expect(bridge.showDeepLinkError).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');

    // The callback is itself a deep link: the queue the link came through must be free to take it.
    await dispatchDeepLink(ticketCallback);

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.location.hash).toBe('#/canvases/00000000-0000-7000-8000-000000000031'));
    expect(await screen.findByText('global:Global Studio')).toBeVisible();
    expect(bridge.showDeepLinkError).not.toHaveBeenCalled();
  });

  it('abandons the action waiting on a sign-in, and still keeps the sign-in that then lands', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.exchangeDesktopTicket.mockResolvedValue(enterpriseSession);
    bridge.activateWorkspace.mockRejectedValueOnce(missingIdentity());
    vi.spyOn(RallyApi.prototype, 'beginGoogleLogin')
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    client.setQueryData(WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY, { identity: 'reconnect_required' });

    const activation = observedActivateWorkspace!('global', 'workspace-global', undefined, { onSignInRequired: vi.fn() })
      .then(() => null, (error: unknown) => error);
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledOnce());
    act(() => observedAbandonAccountSignIn!());

    expect(await activation).toBeInstanceOf(AccountSignInSupersededError);
    expect(bridge.cancelDesktopAuthAttempt).not.toHaveBeenCalled();

    await dispatchDeepLink(ticketCallback);

    // The credential is back and the menu is told; the switch does not happen.
    expect(bridge.exchangeDesktopTicket).toHaveBeenCalledOnce();
    expect(client.getQueryState(WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
    expect(bridge.showDeepLinkError).not.toHaveBeenCalled();
  });

  it('moves to the next stored organization after active membership is revoked', async () => {
    const nextSession: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: {
        ...enterpriseSession.workspace!,
        id: 'workspace-global',
        name: 'Global Studio',
        region: 'global',
      },
    };
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.surrenderActiveWorkspace.mockResolvedValue(nextSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

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

  it('opens the Activity section from its link, leaving the pane to the section', async () => {
    useUiStore.setState({ sidebarSection: 'sidekicks', sidebarOpen: false });
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink('rallywithai://activity');

    await waitFor(() => expect(useUiStore.getState().sidebarSection).toBe('activity'));
    expect(window.location.hash).toBe(before);
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
        enterprise: 'https://enterprise.api.rallywith.ai',
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
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.hasStoredCredential.mockResolvedValue(true);

    renderProvider();
    await waitFor(() => expect(observedSignOutIfCleared).not.toBeNull());
    await act(async () => observedSignOutIfCleared?.());

    expect(screen.getByTestId('session-email')).toHaveTextContent('invitee@example.com');
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('drops the session when an unauthorized read follows a surrendered credential', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
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
    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=enterprise&attempt=${'a'.repeat(43)}`);

    expect(bridge.exchangeDesktopTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('identity service');
  });

  it('keeps identity on Global while previewing a regional legacy invite link', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await dispatchDeepLink(
      'rallywithai://invitations/accept?token=private-invitation-token-long-enough&region=enterprise',
    );

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://enterprise.api.rallywith.ai');
    expect(readDevicePreferences().selectedRegion).toBe('global');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspace-onboarding'] });
    invalidate.mockRestore();
  });

  it('previews a cross-region invitation on its own API without moving the active session', async () => {
    const globalSession: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...enterpriseSession.workspace!, id: 'workspace-global', name: 'Global Research', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(globalSession);
    renderProvider();
    expect(await screen.findByText('global:Global Research')).toBeVisible();
    await dispatchDeepLink(
      'rallywithai://invitations/accept?token=private-invitation-token-long-enough&region=enterprise',
    );

    expect(await screen.findByText('global:invite')).toBeVisible();
    expect(screen.getByTestId('invitation-api')).toHaveTextContent('https://enterprise.api.rallywith.ai');
    expect(readDevicePreferences().selectedRegion).toBe('global');
  });

  it('replaces or clears the provider session when another native window changes it', async () => {
    const client = renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    const signedOutApi = observedApi;

    client.setQueryData(['private-workspace-data'], 'signed-out-cache');
    act(() => sessionListener?.(enterpriseSession));
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
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
    bridge.getSession.mockResolvedValueOnce(enterpriseSession);
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    await waitFor(() => expect(sessionListener).not.toBeNull());
    const initialApi = observedApi;
    client.setQueryData(['private-workspace-data'], 'still-mounted');

    const refreshedSession: DesktopSession = {
      ...enterpriseSession,
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
      ...enterpriseSession,
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
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
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
      ...enterpriseSession,
      workspace: { ...enterpriseSession.workspace!, role: 'admin' },
    };
    bridge.getSession.mockResolvedValueOnce(adminSession);
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
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

  it('activates the connector attempt organization before applying its completion', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000019';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: targetWorkspaceId,
        name: 'Origin Organization',
        region: 'global',
        role: 'owner',
      },
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=granola`,
    );

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: targetWorkspaceId,
    }));
    expect(await screen.findByText('global:Origin Organization')).toBeVisible();
  });

  it('lands a chosen organization on its new-channel page with its record already in the cache', async () => {
    const workspaceA = '00000000-0000-7000-8000-000000000031';
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000032';
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: '00000000-0000-7000-8000-000000000033', name: 'Organization B', region: 'global', role: 'member' },
    });
    const activated: DesktopSession = {
      ...globalIdentitySession,
      accessToken: 'workspace-a-access-token-longer-than-twenty',
      workspace: { id: workspaceA, name: 'Organization A', region: 'global', role: 'owner' },
    };
    bridge.activateWorkspace.mockResolvedValueOnce(activated);
    const record = {
      id: workspaceA, name: 'Organization A', region: 'global' as const, timezone: 'America/New_York',
      currentUser: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee', timezone: 'America/New_York', role: 'owner' as const },
    };
    let resolveRecord!: (value: typeof record) => void;
    const getWorkspace = vi.spyOn(RallyApi.prototype, 'getWorkspace').mockImplementation(
      () => new Promise((resolve) => { resolveRecord = resolve; }),
    );
    // Main announces the new session the moment it is persisted — before the
    // activation has fetched what the shell needs — exactly as the desktop does.
    bridge.activateWorkspace.mockImplementation(async () => {
      sessionListener?.(activated);
      return activated;
    });
    const client = renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();
    const flags = { developerSettings: true, multipleWorkspacesEnabled: true };
    client.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, flags);

    let activation!: Promise<void>;
    await act(async () => { activation = observedActivateWorkspace!('global', workspaceA); await Promise.resolve(); });
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(1));
    // The early announcement did not take the previous workspace down.
    expect(screen.getByText('global:Organization B')).toBeVisible();
    expect(window.location.hash).toBe('#/workstreams/00000000-0000-7000-8000-000000000032');
    await act(async () => { resolveRecord(record); await activation; });

    expect(await screen.findByText('global:Organization A')).toBeVisible();
    expect(window.location.hash).toBe('#/');
    expect(client.getQueryData(['workspace', workspaceA, 'user-1'])).toEqual(record);
    expect(client.getQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY)).toEqual(flags);
    expect(client.getQueryState(CLIENT_FEATURE_FLAGS_QUERY_KEY)?.dataUpdatedAt).toBe(0);
    getWorkspace.mockRestore();
  });

  it('keeps the route when the chosen organization is the one already open', async () => {
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000034';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({ ...enterpriseSession, accessToken: 'renewed-access-token-longer-than-twenty' });
    const getWorkspace = vi.spyOn(RallyApi.prototype, 'getWorkspace').mockResolvedValue({
      id: 'workspace-enterprise', name: 'European Research', region: 'enterprise', timezone: 'Europe/Berlin',
      currentUser: { id: 'user-1', email: 'invitee@example.com', name: 'Invitee', timezone: 'Europe/Berlin', role: 'member' },
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await act(async () => { await observedActivateWorkspace!('enterprise', 'workspace-enterprise'); });

    expect(window.location.hash).toBe('#/workstreams/00000000-0000-7000-8000-000000000034');
    getWorkspace.mockRestore();
  });

  it('lands a created organization the way a switch lands, without waiting on a record the session already describes', async () => {
    const created = '00000000-0000-7000-8000-000000000035';
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000036';
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: '00000000-0000-7000-8000-000000000037', name: 'Organization B', region: 'global', role: 'member' },
    });
    const session: DesktopSession = {
      ...globalIdentitySession,
      accessToken: 'created-access-token-longer-than-twenty',
      user: { ...globalIdentitySession.user, timezone: 'America/New_York' },
      workspace: { id: created, name: 'Created Organization', region: 'global', role: 'owner', timezone: 'America/New_York' },
    };
    let finishCreate!: () => void;
    // Main announces the new workspace the moment it is persisted, before the
    // creation call has returned to this renderer.
    bridge.createWorkspace.mockImplementation(async () => {
      sessionListener?.(session);
      await new Promise<void>((resolve) => { finishCreate = resolve; });
      return session;
    });
    const getWorkspace = vi.spyOn(RallyApi.prototype, 'getWorkspace');
    const client = renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();
    const flags = { developerSettings: true, multipleWorkspacesEnabled: true };
    client.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, flags);
    const account = { eligible: true, introduced: true, revision: 3 };
    client.setQueryData(accountOnboardingQueryKey(session.user.email), account);

    let creation!: Promise<void>;
    await act(async () => { creation = observedFinishWorkspaceSetup!('Created Organization', 'global'); await Promise.resolve(); });
    await waitFor(() => expect(bridge.createWorkspace).toHaveBeenCalledTimes(1));
    // The early announcement did not take the previous workspace down.
    expect(screen.getByText('global:Organization B')).toBeVisible();
    expect(window.location.hash).toBe('#/workstreams/00000000-0000-7000-8000-000000000036');
    await act(async () => { finishCreate(); await creation; });

    expect(await screen.findByText('global:Created Organization')).toBeVisible();
    expect(window.location.hash).toBe('#/');
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(client.getQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY)).toEqual(flags);
    expect(client.getQueryState(CLIENT_FEATURE_FLAGS_QUERY_KEY)?.dataUpdatedAt).toBe(0);
    expect(client.getQueryData(accountOnboardingQueryKey(session.user.email))).toEqual(account);
    expect(client.getQueryState(accountOnboardingQueryKey(session.user.email))?.dataUpdatedAt).toBe(0);
    getWorkspace.mockRestore();
  });

  it('lets a renewal of the workspace on screen through while a creation waits', async () => {
    const current = { id: '00000000-0000-7000-8000-00000000003c', name: 'Organization B', region: 'global' as const, role: 'member' as const };
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession, workspace: current });
    let finishCreate!: (session: DesktopSession) => void;
    bridge.createWorkspace.mockImplementationOnce(() => new Promise<DesktopSession>((resolve) => { finishCreate = resolve; }));
    renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();

    let creation!: Promise<void>;
    await act(async () => { creation = observedFinishWorkspaceSetup!('New Organization', 'global'); await Promise.resolve(); });
    await waitFor(() => expect(bridge.createWorkspace).toHaveBeenCalledTimes(1));
    // Main renews the session on screen (here, after a rename) while the
    // creation is still waiting on a browser sign-in.
    await act(async () => { sessionListener?.({ ...globalIdentitySession, workspace: { ...current, name: 'Organization B renamed' } }); });
    expect(await screen.findByText('global:Organization B renamed')).toBeVisible();

    await act(async () => {
      finishCreate({ ...globalIdentitySession, workspace: { id: '00000000-0000-7000-8000-00000000003d', name: 'New Organization', region: 'global', role: 'owner' } });
      await creation;
    });
    expect(await screen.findByText('global:New Organization')).toBeVisible();
  });

  it('applies a switch held during a creation that then fails', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: '00000000-0000-7000-8000-00000000003a', name: 'Organization B', region: 'global', role: 'member' },
    });
    const elsewhere: DesktopSession = {
      ...globalIdentitySession,
      workspace: { id: '00000000-0000-7000-8000-00000000003b', name: 'Organization C', region: 'global', role: 'member' },
    };
    // Another window switches this account to Organization C while the
    // creation is in flight, and then the creation is refused.
    bridge.createWorkspace.mockImplementationOnce(async () => {
      sessionListener?.(elsewhere);
      throw new Error('creation refused');
    });
    renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();

    await act(async () => {
      await expect(observedFinishWorkspaceSetup!('Refused Organization', 'global')).rejects.toThrow('creation refused');
    });

    expect(await screen.findByText('global:Organization C')).toBeVisible();
  });

  it('does not carry an ineligible account across a creation, which can make it eligible', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: '00000000-0000-7000-8000-000000000038', name: 'Organization B', region: 'global', role: 'member' },
    });
    const session: DesktopSession = {
      ...globalIdentitySession,
      user: { ...globalIdentitySession.user, timezone: 'UTC' },
      workspace: { id: '00000000-0000-7000-8000-000000000039', name: 'First Organization', region: 'global', role: 'owner', timezone: 'UTC' },
    };
    bridge.createWorkspace.mockResolvedValueOnce(session);
    const client = renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();
    client.setQueryData(accountOnboardingQueryKey(session.user.email), { eligible: false, introduced: true, revision: 1 });

    await act(async () => { await observedFinishWorkspaceSetup!('First Organization', 'global'); });

    expect(await screen.findByText('global:First Organization')).toBeVisible();
    expect(client.getQueryData(accountOnboardingQueryKey(session.user.email))).toBeUndefined();
  });

  it('keeps conversation OAuth results in the feed and clears terminal failures', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000023';
    const attemptId = 'a'.repeat(43);
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    bridge.reselectActiveWorkspace.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    renderProvider();
    expect(await screen.findByText('global:Organization A')).toBeVisible();
    await act(async () => observedSetPendingConnectorOAuth!({
      source: 'conversation',
      connectorId: 'slack',
      scope: 'personal',
      provider: 'slack',
      region: 'global',
      workspaceId,
      attemptId,
    }));
    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/auth/complete?status=denied&error=access_denied&attempt=${attemptId}&provider=slack`,
    );
    await waitFor(() => expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('none'));
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });

  it('returns a resource grant to its channel card without opening Connections', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000023';
    const attemptId = 'a'.repeat(43);
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    bridge.reselectActiveWorkspace.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    renderProvider();
    expect(await screen.findByText('global:Organization A')).toBeVisible();
    await act(async () => observedSetResourceAuthorizationAttempt!('connection:file:tool', {
      source: 'resource', provider: 'google', region: 'global', workspaceId, attemptId,
      resourceAuthorizationKey: 'connection:file:tool', resourceAuthorizationStatus: 'pending',
    }));
    await act(async () => observedSetResourceAuthorizationAttempt!('connection:file:other', {
      source: 'resource', provider: 'google', region: 'global', workspaceId, attemptId: 'b'.repeat(43),
      resourceAuthorizationKey: 'connection:file:other', resourceAuthorizationStatus: 'pending',
    }));
    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${attemptId}&provider=google`,
    );
    await waitFor(() => expect(screen.getByTestId('pending-resource-status')).toHaveTextContent('succeeded'));
    expect(screen.getByTestId('other-resource-status')).toHaveTextContent('pending');
    expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('none');
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });

  it('keeps a denied resource grant as a retryable card state', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000023';
    const attemptId = 'a'.repeat(43);
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    bridge.reselectActiveWorkspace.mockResolvedValueOnce({ ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Organization A', region: 'global', role: 'owner' } });
    renderProvider();
    expect(await screen.findByText('global:Organization A')).toBeVisible();
    await act(async () => observedSetResourceAuthorizationAttempt!('connection:file:tool', {
      source: 'resource', provider: 'google', region: 'global', workspaceId, attemptId,
      resourceAuthorizationKey: 'connection:file:tool', resourceAuthorizationStatus: 'pending',
    }));
    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceId}/auth/complete?status=denied&error=access_denied&attempt=${attemptId}&provider=google`,
    );
    await waitFor(() => expect(screen.getByTestId('pending-resource-status')).toHaveTextContent('denied'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    expect(bridge.openSettings).not.toHaveBeenCalled();
  });

  it('returns from organization B to same-region organization A for connector completion', async () => {
    const workspaceA = '00000000-0000-7000-8000-000000000023';
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000026';
    bridge.getSession.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: '00000000-0000-7000-8000-000000000024',
        name: 'Organization B',
        region: 'global',
        role: 'member',
      },
    });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: workspaceA, name: 'Organization A', region: 'global', role: 'owner' },
    });
    renderProvider();
    expect(await screen.findByText('global:Organization B')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${workspaceA}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=slack`,
    );

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: workspaceA,
    }));
    expect(await screen.findByText('global:Organization A')).toBeVisible();
    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections'));
    // The inert route the organization change parks on, not the landing route.
    expect(window.location.hash).toBe('#/opening');
  });

  it.each([
    {
      name: 'Canvas',
      url: canvasDeepLink({
        region: 'enterprise',
        workspaceId: '00000000-0000-7000-8000-000000000030',
        canvasId: '00000000-0000-7000-8000-000000000031',
      }),
      assertDestination: async () => expect(window.location.hash)
        .toBe('#/canvases/00000000-0000-7000-8000-000000000031'),
    },
    {
      name: 'settings',
      url: 'rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000030/settings/connections',
      assertDestination: async () => waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections')),
    },
    {
      name: 'automation',
      url: 'rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000030/automations/new',
      // Opens the app: the builder is gone, and a conversation is started from
      // a Space the link does not name. What this case is really about is the
      // workspace activation before the hop, which is unchanged: the link still
      // addresses a workspace, and that workspace is activated before anything
      // navigates.
      assertDestination: async () => expect(window.location.hash).toBe('#/'),
    },
    {
      name: 'Activity',
      url: 'rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000030/activity',
      // Opens the section on the landing a launch has, never left parked on
      // `/opening`; the sidebar then replaces it with the top row.
      assertDestination: async () => {
        await waitFor(() => expect(window.location.hash).toBe('#/canvases'));
        expect(useUiStore.getState().sidebarSection).toBe('activity');
      },
    },
    {
      name: 'Sidekick',
      url: sidekickDeepLink({
        region: 'enterprise',
        workspaceId: '00000000-0000-7000-8000-000000000030',
        sidekickId: '00000000-0000-7000-8000-000000000033',
      }),
      assertDestination: async () => expect(window.location.hash)
        .toBe('#/sidekicks/00000000-0000-7000-8000-000000000033'),
    },
    {
      name: 'connector result',
      url: `rallywithai://workspace/enterprise/00000000-0000-7000-8000-000000000030/auth/complete?connection=00000000-0000-7000-8000-000000000032&status=connected&attempt=${'a'.repeat(43)}&provider=google`,
      assertDestination: async () => waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('connections')),
    },
  ])('activates an addressed $name link from an identity-only session', async (testCase) => {
    const { url, assertDestination } = testCase;
    const innerWidth = window.innerWidth;
    if ('width' in testCase) Object.defineProperty(window, 'innerWidth', { configurable: true, value: testCase.width });
    useUiStore.setState({ sidebarSection: 'sidekicks', sidebarOpen: false, sheetAfterNavigation: false });
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000030';
    bridge.getSession.mockResolvedValueOnce({ ...globalIdentitySession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValue({
      ...enterpriseSession,
      expiresAt: futureExpiry,
      workspace: {
        id: targetWorkspaceId,
        name: 'Addressed Organization',
        region: 'enterprise',
        role: 'member',
      },
    });
    useUiStore.setState({ sidebarSection: 'canvases' });
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();

    await dispatchDeepLink(url);

    await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'enterprise',
      workspaceId: targetWorkspaceId,
    }));
    await assertDestination();
    expect(lastDeepLinkFailure()).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  it('serializes addressed resource links in delivery order', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000033';
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000034';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000035';
    const activations: Array<{ resolve: (session: DesktopSession) => void }> = [];
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockImplementation(() => new Promise<DesktopSession>((resolve) => {
      activations.push({ resolve });
    }));
    const activated: DesktopSession = {
      ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Ordered Organization', region: 'global', role: 'member' },
    };
    // Main answers a claim from whatever it has activated so far.
    let mainActiveSession: DesktopSession | null = null;
    bridge.reselectActiveWorkspace.mockImplementation(async (target) => (
      mainActiveSession?.workspace?.id === target.workspaceId ? mainActiveSession : null
    ));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: workspaceId, canvasId: firstWorkstreamId }),
    );
    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: workspaceId, canvasId: secondWorkstreamId }),
    );

    // The second link waits behind the first's activation rather than running
    // against the workspace that was active before it.
    await waitFor(() => expect(activations).toHaveLength(1));
    expect(window.location.hash).not.toContain(secondWorkstreamId);
    mainActiveSession = activated;
    activations[0]!.resolve(activated);
    await waitFor(() => expect(window.location.hash).toBe(`#/canvases/${secondWorkstreamId}`));
    // By the time the second link ran, its workspace was the active one, so
    // main answered the claim and it opened without a second activation. Had
    // the second link run before the first resolved, the claim would have
    // found nothing active and a second activation would be pending here.
    expect(activations).toHaveLength(1);
    expect(bridge.reselectActiveWorkspace).toHaveBeenCalledTimes(2);
  });

  it('opens an artifact link\'s Canvas after serialized organization activation', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000033';
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000034';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000035';
    const childId = '00000000-0000-7000-8000-000000000099';
    const activations: Array<{ resolve: (session: DesktopSession) => void }> = [];
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockImplementation(() => new Promise<DesktopSession>((resolve) => {
      activations.push({ resolve });
    }));
    const activated: DesktopSession = {
      ...globalIdentitySession,
      workspace: { id: workspaceId, name: 'Ordered Organization', region: 'global', role: 'member' },
    };
    // Main answers a claim from whatever it has activated so far.
    let mainActiveSession: DesktopSession | null = null;
    bridge.reselectActiveWorkspace.mockImplementation(async (target) => (
      mainActiveSession?.workspace?.id === target.workspaceId ? mainActiveSession : null
    ));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: workspaceId, canvasId: firstWorkstreamId }),
    );
    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: workspaceId, canvasId: secondWorkstreamId, artifactId: childId }),
    );

    // The second link waits behind the first's activation rather than running
    // against the workspace that was active before it.
    await waitFor(() => expect(activations).toHaveLength(1));
    expect(window.location.hash).not.toContain(secondWorkstreamId);
    mainActiveSession = activated;
    activations[0]!.resolve(activated);
    await waitFor(() => expect(window.location.hash).toBe(`#/canvases/${secondWorkstreamId}`));
    // By the time the second link ran, its workspace was the active one, so
    // main answered the claim and it opened without a second activation. Had
    // the second link run before the first resolved, the claim would have
    // found nothing active and a second activation would be pending here.
    expect(activations).toHaveLength(1);
    expect(bridge.reselectActiveWorkspace).toHaveBeenCalledTimes(2);
  });

  it('continues serialized deep-link delivery after one action rejects', async () => {
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.openSettings.mockRejectedValueOnce(new Error('Settings could not be opened'));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    useUiStore.setState({ sidebarSection: 'canvases' });
    await dispatchDeepLink('rallywithai://settings/connections');
    await dispatchDeepLink('rallywithai://activity');

    await waitFor(() => expect(useUiStore.getState().sidebarSection).toBe('activity'));
  });

  it('does not apply a connector result when its organization cannot be activated', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000025';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(workspaceActivationFailure('workspace_access_denied'));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&attempt=${'a'.repeat(43)}&provider=notion`,
    );

    await waitFor(() => expect(lastDeepLinkFailure()).toContain('access'));
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['connections'] });
    invalidate.mockRestore();
  });

  it('does not navigate when an organization-addressed Canvas link cannot be activated', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000020';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(workspaceActivationFailure('workspace_access_denied'));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: targetWorkspaceId, canvasId: '00000000-0000-7000-8000-000000000021' }),
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
      ...enterpriseSession,
      expiresAt: futureExpiry,
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    await dispatchDeepLink(
      `rallywithai://auth/complete?provider=linear&region=enterprise&attempt=${'a'.repeat(43)}&status=denied&error=oauth_denied`,
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
      ...enterpriseSession,
      expiresAt: futureExpiry,
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    await dispatchDeepLink(
      `rallywithai://auth/complete?connection=1ba39221-dac7-40cc-8f77-a88132740f16&status=connected&region=global&attempt=${'a'.repeat(43)}&provider=linear`,
    );

    expect(lastDeepLinkFailure()).toContain('invalid connector completion');
  });

  it('consumes a Slack link token only through the authenticated regional session', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...enterpriseSession,
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
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(`rallywithai://slack/link?token=${'a'.repeat(43)}`);

    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(3));
    const [previewUrl, previewInit] = fetchRequest.mock.calls[0]!;
    const [linkUrl, linkInit] = fetchRequest.mock.calls[1]!;
    const [startUrl, startInit] = fetchRequest.mock.calls[2]!;
    expect(previewUrl).toBe('https://enterprise.api.rallywith.ai/connections/slack/link/preview');
    expect(linkUrl).toBe('https://enterprise.api.rallywith.ai/connections/slack/link');
    expect(startUrl).toBe(
      'https://enterprise.api.rallywith.ai/connections/slack/start?telemetryVersion=2&desktopHandoffVersion=2',
    );
    expect(new Headers(previewInit?.headers).get('authorization')).toBe(`Bearer ${enterpriseSession.accessToken}`);
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

  it('renews a rejected bearer while consuming an organization-addressed Slack link', async () => {
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
    bridge.reselectActiveWorkspace.mockResolvedValueOnce(staleSession);
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
    // The link names the active workspace, so main answered the claim and the
    // stale bearer is renewed by the target API's own renewal, not by a
    // platform activation minting a fresh session.
    expect(bridge.reselectActiveWorkspace).toHaveBeenCalledWith({ region: 'global', workspaceId });
    expect(bridge.activateWorkspace).not.toHaveBeenCalled();
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
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
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
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(`rallywithai://slack/link?token=${'a'.repeat(43)}`);

    await waitFor(() => expect(lastDeepLinkFailure()).toMatch(
      /Slack was linked, but personal Slack tools could not be connected/u,
    ));
    fetchRequest.mockRestore();
    confirm.mockRestore();
  });

  it('does not consume a Slack link token when the user rejects its identity preview', async () => {
    bridge.getSession.mockResolvedValueOnce({
      ...enterpriseSession,
      expiresAt: futureExpiry,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      teamId: 'T01234567',
      slackUserId: 'U01234567',
      workspaceName: 'Acme',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

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
    // asking for one in a Channel, which starts from a Space the link does not
    // name, so it opens the app. The link keeps working — somebody's bookmark
    // should not 404.
    await dispatchDeepLink('rallywithai://automations/new');
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
  });

  it('activates an organization-addressed settings destination before opening it', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000026';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: {
        id: targetWorkspaceId,
        name: 'Notification Organization',
        region: 'global',
        role: 'member',
      },
    });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();

    await dispatchDeepLink(
      `rallywithai://workspace/global/${targetWorkspaceId}/settings/digest`,
    );

    await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledWith('notifications'));
    expect(bridge.activateWorkspace).toHaveBeenCalledWith({
      region: 'global',
      workspaceId: targetWorkspaceId,
    });
  });

  it('preserves a pending connector attempt while another organization is active', async () => {
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    await waitFor(() => expect(observedSetPendingConnectorOAuth).not.toBeNull());

    act(() => observedSetPendingConnectorOAuth?.({
      attemptId: 'a'.repeat(43),
      provider: 'slack',
      region: 'enterprise',
      workspaceId: enterpriseSession.workspace!.id,
    }));
    expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('a'.repeat(43));

    act(() => sessionListener?.({
      ...globalIdentitySession,
      workspace: {
        id: '00000000-0000-7000-8000-000000000037',
        name: 'Organization B',
        region: 'global',
        role: 'member',
      },
    }));

    expect(await screen.findByText('global:Organization B')).toBeVisible();
    expect(observedPendingConnectorOAuth?.workspaceId).toBe(enterpriseSession.workspace!.id);
    expect(screen.getByTestId('pending-connector-attempt')).toHaveTextContent('a'.repeat(43));
  });

  it('distinguishes a retryable organization activation outage from denied access', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000038';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockRejectedValueOnce(
      new Error('Rally could not reach the selected regional service.'),
    );
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: targetWorkspaceId, canvasId: '00000000-0000-7000-8000-000000000039' }),
    );

    await waitFor(() => expect(lastDeepLinkFailure()).toContain('Check your connection'));
    expect(lastDeepLinkFailure()).toContain('reopen this link');
    expect(window.location.hash).toBe(before);
    expect(screen.getByText('enterprise:European Research')).toBeVisible();
  });

  it('opens a link to the active organization without re-activating it', async () => {
    const activeWorkspaceId = '00000000-0000-7000-8000-000000000040';
    const activeSession: DesktopSession = {
      ...globalIdentitySession,
      workspace: { id: activeWorkspaceId, name: 'Juno Labs', region: 'global', role: 'member' },
    };
    window.location.hash = '/workstreams/00000000-0000-7000-8000-000000000041';
    bridge.getSession.mockResolvedValueOnce(activeSession);
    bridge.reselectActiveWorkspace.mockResolvedValue(activeSession);
    const client = renderProvider(<Tooltip.Provider><HashRouter>
      <AppRouteNavigation />
      <NavigationHistoryProvider enabled><DeepLinkHistoryProbe /></NavigationHistoryProvider>
    </HashRouter></Tooltip.Provider>);
    expect(await screen.findByText('global:Juno Labs')).toBeVisible();
    client.setQueryData(['members'], ['cached']);
    fireEvent.click(screen.getByRole('button', { name: 'Visit another thread' }));

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: activeWorkspaceId, canvasId: '00000000-0000-7000-8000-000000000042' }),
    );

    await waitFor(() => expect(window.location.hash).toBe('#/canvases/00000000-0000-7000-8000-000000000042'));
    // Straight to the work stream: main answered with the session in use, no
    // platform round trip, and the shell keeps what it had loaded rather than
    // reloading behind the link.
    expect(bridge.reselectActiveWorkspace).toHaveBeenCalledWith({ region: 'global', workspaceId: activeWorkspaceId });
    expect(bridge.activateWorkspace).not.toHaveBeenCalled();
    expect(client.getQueryData(['members'])).toEqual(['cached']);
    expect(screen.getByTestId('deep-link-error')).toHaveTextContent('none');
    expect(window.history.state).toMatchObject({ idx: 2 });
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('history-route')).toHaveTextContent('/workstreams/ordinary-visit'));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    await waitFor(() => expect(screen.getByTestId('history-route')).toHaveTextContent('/canvases/00000000-0000-7000-8000-000000000042'));
    // A new deep link from an earlier visit discards the old forward branch.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('history-route')).toHaveTextContent('/workstreams/ordinary-visit'));
    await dispatchDeepLink(canvasDeepLink({ region: 'global', workspaceId: activeWorkspaceId, canvasId: '00000000-0000-7000-8000-000000000043' }));
    await waitFor(() => expect(screen.getByTestId('history-route')).toHaveTextContent('/canvases/00000000-0000-7000-8000-000000000043'));
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('activates an organization that is not the active one, even when its credential is stored', async () => {
    const targetWorkspaceId = '00000000-0000-7000-8000-000000000045';
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...globalIdentitySession,
      workspace: { id: targetWorkspaceId, name: 'Fresh Organization', region: 'global', role: 'member' },
    });
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    client.setQueryData(['members'], ['from-enterprise']);

    await dispatchDeepLink(
      canvasDeepLink({ region: 'global', workspaceId: targetWorkspaceId, canvasId: '00000000-0000-7000-8000-000000000046' }),
    );

    await waitFor(() => expect(window.location.hash).toBe('#/canvases/00000000-0000-7000-8000-000000000046'));
    // Main declined the local claim, so the platform revalidated the
    // membership before the window moved.
    expect(bridge.reselectActiveWorkspace).toHaveBeenCalledWith({ region: 'global', workspaceId: targetWorkspaceId });
    expect(bridge.activateWorkspace).toHaveBeenCalledWith({ region: 'global', workspaceId: targetWorkspaceId });
    expect(await screen.findByText('global:Fresh Organization')).toBeVisible();
    // A different workspace is a different cache scope: nothing from the
    // previous one may be drawn under the new credential.
    expect(client.getQueryData(['members'])).toBeUndefined();
  });

  it('keeps the query cache when a same-organization session is applied', async () => {
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.activateWorkspace.mockResolvedValueOnce({
      ...enterpriseSession,
      accessToken: 'renewed-token-longer-than-twenty-characters',
      expiresAt: futureExpiry,
    });
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    client.setQueryData(['members'], ['cached']);

    await act(async () => {
      await observedActivateWorkspace!('enterprise', enterpriseSession.workspace!.id);
    });

    await waitFor(() => expect(screen.getByTestId('session-token'))
      .toHaveTextContent('renewed-token-longer-than-twenty-characters'));
    expect(client.getQueryData(['members'])).toEqual(['cached']);
  });

  it('clears the query cache when a sign-in completes for another account', async () => {
    bridge.getSession.mockResolvedValueOnce({ ...enterpriseSession, expiresAt: futureExpiry });
    bridge.exchangeDesktopTicket.mockResolvedValueOnce({
      ...globalIdentitySession,
      user: { id: 'user-2', email: 'other@example.com', name: 'Other' },
    });
    const client = renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    client.setQueryData(['members'], ['first-account']);

    await dispatchDeepLink(`rallywithai://auth/complete?ticket=single-use-ticket-long-enough&region=global&attempt=${'d'.repeat(43)}`);

    // The previous session is compared before the new one is adopted: a
    // different account is a different scope, and nothing it cached may be
    // drawn for the account that just signed in.
    await waitFor(() => expect(screen.getByTestId('session-email')).toHaveTextContent('other@example.com'));
    expect(client.getQueryData(['members'])).toBeUndefined();
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

  it('rejects retired note links for signed-out users', async () => {
    renderProvider();
    expect(await screen.findByText('global:signed-out')).toBeVisible();
    const before = window.location.hash;

    await dispatchDeepLink('rallywithai://notes/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30');

    await waitFor(() => expect(screen.getByTestId('deep-link-error'))
      .toHaveTextContent('Rally could not open that note link.'));
    expect(window.location.hash).toBe(before);
  });

  it('gives a signed-in person without an organization the window, not the inline message', async () => {
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

  it('opens the app for a new-channel link, which names no Space to start in', async () => {
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
    await waitFor(() => expect(window.location.hash).toBe('#/'));
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
    await writeDraftText('new-workstream:workspace-enterprise', 'written before the last quit');
    bridge.getSession.mockResolvedValue(enterpriseSession);

    renderProvider();

    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    await waitFor(() => expect(observedApi).not.toBeNull());
    await waitFor(async () => expect((await readDraftText(
      newWorkstreamDraftKey('enterprise', 'workspace-enterprise'),
    ))?.text).toBe('written before the last quit'));
  });

  it('drops every draft when the session ends without going through signOut', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const draftKey = workstreamDraftKey('enterprise', 'workspace-enterprise', '1');
    await writeDraftText(draftKey, 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    // Main surrendering a terminally expired credential, not a button press.
    act(() => sessionListener?.(null));

    await waitFor(async () => expect(await readDraftText(draftKey)).toBeNull());
  });

  it('abandons an opening attempt when the session that owns it ends', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
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

  it('drops every remembered conversation when the session ends without going through signOut', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const scope = localCacheScope('user-1', 'enterprise', 'workspace-enterprise');
    await rememberedRows.write(scope, 'ws:0', { remembered: true });
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.(null));

    await waitFor(async () => expect(await rememberedRows.read(scope, 'ws:0')).toBeNull());
  });

  it('drops every remembered conversation when another account takes over the device', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const scope = localCacheScope('user-1', 'enterprise', 'workspace-enterprise');
    await rememberedRows.write(scope, 'ws:0', { remembered: true });
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.({
      ...enterpriseSession,
      user: { ...enterpriseSession.user, id: 'user-2', email: 'another@example.com' },
    }));

    await waitFor(async () => expect(await rememberedRows.read(scope, 'ws:0')).toBeNull());
  });

  it('forgets an organization the account is refused when activating it fails, and keeps the active one', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const refused = localCacheScope('user-1', 'global', 'workspace-global');
    const active = localCacheScope('user-1', 'enterprise', 'workspace-enterprise');
    await rememberedRows.write(refused, 'ws:0', { remembered: true });
    await rememberedRows.write(active, 'ws:0', { remembered: true });
    await waitFor(() => expect(observedActivateWorkspace).not.toBeNull());
    bridge.activateWorkspace.mockRejectedValueOnce(workspaceActivationFailure('workspace_access_denied'));

    await expect(observedActivateWorkspace!('global', 'workspace-global')).rejects.toThrow();

    await waitFor(async () => expect(await rememberedRows.read(refused, 'ws:0')).toBeNull());
    expect(await rememberedRows.read(active, 'ws:0')).toEqual({ remembered: true });
  });

  it('drops every draft when another account takes over the device', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const draftKey = workstreamDraftKey('enterprise', 'workspace-enterprise', '1');
    await writeDraftText(draftKey, 'half a thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.({
      ...enterpriseSession,
      user: { ...enterpriseSession.user, id: 'user-2', email: 'another@example.com' },
    }));

    await waitFor(async () => expect(await readDraftText(draftKey)).toBeNull());
  });

  it('preserves both organization draft scopes while switching within one account', async () => {
    const globalSession: DesktopSession = {
      ...enterpriseSession,
      apiBaseUrl: 'https://api.rallywith.ai',
      workspace: { ...enterpriseSession.workspace!, id: 'workspace-global', name: 'Global Research', region: 'global' },
    };
    bridge.getSession.mockResolvedValue(enterpriseSession);
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const enterpriseDraft = workstreamDraftKey('enterprise', 'workspace-enterprise', '1');
    const globalDraft = workstreamDraftKey('global', 'workspace-global', '2');
    await writeDraftText(enterpriseDraft, 'enterprise thought');
    await writeDraftText(globalDraft, 'global thought');
    await waitFor(() => expect(sessionListener).not.toBeNull());

    act(() => sessionListener?.(globalSession));

    expect(await screen.findByText('global:Global Research')).toBeVisible();
    expect((await readDraftText(enterpriseDraft))?.text).toBe('enterprise thought');
    expect((await readDraftText(globalDraft))?.text).toBe('global thought');
  });

  it('clears only the departed organization draft scope after leave succeeds', async () => {
    bridge.getSession.mockResolvedValue(enterpriseSession);
    bridge.leaveWorkspace.mockResolvedValue({ outcome: 'left' });
    renderProvider();
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
    const enterpriseDraft = workstreamDraftKey('enterprise', 'workspace-enterprise', '1');
    const globalDraft = workstreamDraftKey('global', 'workspace-enterprise', '2');
    await writeDraftText(enterpriseDraft, 'enterprise thought');
    await writeDraftText(globalDraft, 'global thought');
    await waitFor(() => expect(observedLeaveWorkspace).not.toBeNull());

    await act(async () => {
      await observedLeaveWorkspace?.('workspace-enterprise', 'left');
    });

    expect(bridge.leaveWorkspace).toHaveBeenCalledWith({
      expectedOutcome: 'left',
      region: 'enterprise',
      workspaceId: 'workspace-enterprise',
    });
    expect(await readDraftText(enterpriseDraft)).toBeNull();
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
    bridge.getSession.mockResolvedValue(enterpriseSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AppSessionProvider><SessionProbe /><ComposerProbe /></AppSessionProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('enterprise:European Research')).toBeVisible();
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
