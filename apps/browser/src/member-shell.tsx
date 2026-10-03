import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { UpdateAccountOnboarding } from '@rally/contracts';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { BrowserWorkspacesSchema } from '@rally/contracts/browser-session';
import type { Region } from '@rally/contracts/regions';
import { WorkspaceApp } from '../../desktop/src/renderer/App';
import { AccountOnboardingGate } from '../../desktop/src/renderer/screens/guided-onboarding';
import { RallyApi } from '../../desktop/src/renderer/lib/api';
import { AppSessionValueProvider, type AppSessionValue } from '../../desktop/src/renderer/lib/app-session';
import type { ConnectorSetupCapability, PendingConnectorOAuth } from '../../desktop/src/renderer/lib/collaboration-session';
import { clearWorkspaceDrafts } from '../../desktop/src/renderer/lib/draft-cache';
import { FaviconApiProvider } from '../../desktop/src/renderer/lib/favicon-api';
import { clearWorkspaceLocalCache } from '../../desktop/src/renderer/lib/local-cache';
import { desktopBridge } from '../../desktop/src/renderer/lib/platform';
import { reconcileWebPush } from '../../desktop/src/renderer/lib/web-push';
import { createQueryClient } from '../../desktop/src/renderer/lib/query-client';
import { NEW_SIDEKICK_TARGET } from '../../desktop/src/common/sidekicks';
import { memberShellLocation } from './session';
import { browserRequest } from './transport';

const MAC_APP_ONLY = 'Available in the Mac app.';

function macAppOnly(): Promise<never> {
  return Promise.reject(new Error(MAC_APP_ONLY));
}

/** The API for this session's Organization, kept stable across metadata refreshes. */
function useCookieApi(session: CookieClientSession): RallyApi {
  const api = useMemo(() => new RallyApi(session.apiBaseUrl, session), [
    session.apiBaseUrl, session.user.id, session.workspace?.id, session.workspace?.region,
    session.workspace?.role, session.workspace?.accessClass,
  ]);
  useLayoutEffect(() => { api.setSession(session); }, [api, session]);
  return api;
}

/**
 * The desktop shell for an Organization member, over the browser's cookie
 * session. The desktop builds its session value from the bridge; this one
 * builds it from the cookie session the entry restored. Anything that only
 * the Mac app can do rejects with one sentence saying so.
 */
function MemberSession({ region, session, onSignOut, onRevalidate }: {
  region: Region;
  session: CookieClientSession;
  onSignOut: () => void;
  onRevalidate: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const api = useCookieApi(session);
  // Account onboarding is identity-scoped, so it goes through the `_` workspace.
  const identityApi = useMemo(() => new RallyApi(`/regional/${region}/browser/api/_`, { ...session, workspace: null }), [region, session.user.id]);
  useLayoutEffect(() => { identityApi.setSession({ ...session, workspace: null }); }, [identityApi, session]);
  const getAccountOnboarding = useCallback(() => identityApi.getAccountOnboarding(), [identityApi]);
  const updateAccountOnboarding = useCallback((input: UpdateAccountOnboarding) => identityApi.updateAccountOnboarding(input), [identityApi]);
  // A notification subscription from an earlier sign-in delivers nothing until
  // this session registers it. Settings re-checks and shows any failure.
  useEffect(() => { void reconcileWebPush(api).catch(() => undefined); }, [api]);
  const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
  const [resourceAuthorizationAttempts, setResourceAuthorizationAttempts] = useState<Readonly<Record<string, PendingConnectorOAuth>>>({});
  const setResourceAuthorizationAttempt = useCallback((key: string, attempt: PendingConnectorOAuth | null) => {
    setResourceAuthorizationAttempts((current) => {
      const next = { ...current };
      if (attempt) next[key] = attempt; else delete next[key];
      return next;
    });
  }, []);
  // Connectors return to /connections/complete, which closes its own tab; the
  // pending cards reconcile from the attempt read, as on the desktop.
  const connectorSetup = useMemo<ConnectorSetupCapability>(() => ({
    pendingConnectorOAuth, setPendingConnectorOAuth, resourceAuthorizationAttempts, setResourceAuthorizationAttempt,
    openExternal: (url: string) => desktopBridge().openExternal(url),
  }), [pendingConnectorOAuth, resourceAuthorizationAttempts, setResourceAuthorizationAttempt]);
  const revalidate = useCallback(async () => { onRevalidate(); }, [onRevalidate]);
  const signOut = useCallback(async () => { onSignOut(); }, [onSignOut]);
  const value = useMemo<AppSessionValue>(() => ({
    host: 'browser',
    booting: false,
    runtime: null,
    region,
    workspaceName: session.workspace?.name ?? '',
    session,
    api,
    invitationApi: null,
    deepLinkError: null,
    exchangingTicket: false,
    selectRegion: () => undefined,
    setWorkspaceName: () => undefined,
    editWorkspaceSetup: () => undefined,
    pendingInvitation: null,
    pendingConnectorOAuth,
    setPendingConnectorOAuth,
    updateCurrentUserName: () => { void queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    clearPendingInvitation: () => undefined,
    getOnboardingState: async () => {
      const { workspaces } = await browserRequest(region, '/workspaces', BrowserWorkspacesSchema);
      return { workspace: null, workspaces, invitations: [], identity: 'connected' as const };
    },
    activateWorkspace: async (target, workspaceId) => { location.assign(`/app/workspaces/${target}/${workspaceId}`); },
    acceptInvitation: macAppOnly,
    declineInvitation: macAppOnly,
    reconnectAccountIdentity: macAppOnly,
    abandonAccountSignIn: () => undefined,
    leaveWorkspace: async (workspaceId, expectedOutcome) => {
      const departure = await api.leaveWorkspace(workspaceId, expectedOutcome);
      await Promise.all([clearWorkspaceDrafts(region, workspaceId), clearWorkspaceLocalCache(session.user.id, region, workspaceId)]);
      location.assign('/');
      return departure;
    },
    createDevelopmentSession: macAppOnly,
    finishWorkspaceSetup: macAppOnly,
    refreshSession: async () => { onRevalidate(); return session; },
    getAccountOnboarding,
    updateAccountOnboarding,
    signOut,
    // The cookie session has no stored credential to inspect: the entry
    // re-reads the server session and unmounts this shell if it is gone.
    signOutIfCredentialCleared: revalidate,
    surrenderActiveWorkspace: revalidate,
    clearDeepLinkError: () => undefined,
  }), [api, getAccountOnboarding, onRevalidate, pendingConnectorOAuth, queryClient, region, revalidate, session, signOut, updateAccountOnboarding]);
  const createSidekick = useCallback(() => desktopBridge().openSidekicks(NEW_SIDEKICK_TARGET), []);
  return <AppSessionValueProvider value={value} connectorSetup={connectorSetup} createSidekick={createSidekick}>
    <FaviconApiProvider>
      <AccountOnboardingGate><WorkspaceApp /></AccountOnboardingGate>
    </FaviconApiProvider>
  </AppSessionValueProvider>;
}

export function BrowserMemberShell(props: {
  region: Region;
  session: CookieClientSession;
  onSignOut: () => void;
  onRevalidate: () => void;
}): React.JSX.Element {
  const [queryClient] = useState(() => createQueryClient());
  // The desktop shell routes by hash. Rewrite a canonical link into that form
  // once, before its router first reads the location.
  useState(() => {
    const next = memberShellLocation(location.pathname, location.hash);
    if (next) history.replaceState(history.state, '', next);
  });
  return <QueryClientProvider client={queryClient}>
    <Tooltip.Provider><MemberSession {...props} /></Tooltip.Provider>
  </QueryClientProvider>;
}
