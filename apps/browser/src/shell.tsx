import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { UpdateAccountOnboarding } from '@rally/contracts';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { BrowserSessionSchema, BrowserWorkspaceAttentionSchema, BrowserWorkspacesSchema, type BrowserWorkspaceAttention } from '@rally/contracts/browser-session';
import { SupportPeopleSchema, SupportWorkspacesSchema } from '@rally/contracts';
import { z } from 'zod';
import { IDENTITY_REGION, type Region } from '@rally/contracts/regions';
import { WorkspaceApp } from '../../desktop/src/renderer/App';
import { AccountOnboardingGate } from '../../desktop/src/renderer/screens/guided-onboarding';
import { RallyApi } from '../../desktop/src/renderer/lib/api';
import { AppSessionValueProvider, type AppSessionValue } from '../../desktop/src/renderer/lib/app-session';
import { type ConnectorSetupCapability, type PendingConnectorOAuth } from '../../desktop/src/renderer/lib/collaboration-session';
import { clearWorkspaceDrafts } from '../../desktop/src/renderer/lib/draft-cache';
import { FaviconApiProvider } from '../../desktop/src/renderer/lib/favicon-api';
import { clearWorkspaceLocalCache } from '../../desktop/src/renderer/lib/local-cache';
import { desktopBridge } from '../../desktop/src/renderer/lib/platform';
import { reconcileWebPush } from '../../desktop/src/renderer/lib/web-push';
import { createQueryClient } from '../../desktop/src/renderer/lib/query-client';
import { useWindowActivationTracking } from '../../desktop/src/renderer/lib/window-activation';
import { setShellMounted } from './notification-open';
import { shellLocation } from './session';
import { BrowserApiError, browserRequest } from './transport';

const MAC_APP_ONLY = 'Available in the Mac app.';

function macAppOnly(): Promise<never> {
  return Promise.reject(new Error(MAC_APP_ONLY));
}

let attentionRead: Promise<BrowserWorkspaceAttention> | null = null;

/**
 * Every membership's attention in one identity-cookie read, shared by the
 * account menu's per-Organization asks of one refresh: they arrive together
 * (one `Promise.all`), so the read in flight answers all of them, and the
 * next refresh (focus, the menu opening) reads again.
 */
function readBrowserAttention(): Promise<BrowserWorkspaceAttention> {
  attentionRead ??= browserRequest(IDENTITY_REGION, '/workspaces/attention', BrowserWorkspaceAttentionSchema)
    .finally(() => { attentionRead = null; });
  return attentionRead;
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
 * The desktop shell over the browser's cookie session, for members and guests
 * alike. The desktop builds its session value from the bridge; this one builds
 * it from the cookie session the entry restored. Anything only the Mac app can
 * do rejects with one sentence saying so; what a guest may do is the shell's
 * own question (`useShellCapabilities`), answered the same way in both hosts.
 */
function BrowserSession({ region, session, onSignOut, onRevalidate }: {
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
  // A support session never registers this browser for the person's
  // notifications (`docs/impersonation.md`); the API refuses it as well.
  useEffect(() => { if (!session.impersonator) void reconcileWebPush(api).catch(() => undefined); }, [api, session.impersonator]);
  // A notification click routes in place only while this is mounted.
  useEffect(() => { setShellMounted(true); return () => setShellMounted(false); }, []);
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
    // Only the macOS menu bar opens a request this way.
    pendingAccessRequestId: null,
    clearPendingAccessRequest: () => undefined,
    pendingConnectorOAuth,
    setPendingConnectorOAuth,
    updateCurrentUserName: () => { void queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    clearPendingInvitation: () => undefined,
    getOnboardingState: async () => {
      const { workspaces } = await browserRequest(IDENTITY_REGION, '/workspaces', BrowserWorkspacesSchema);
      // The identity cookie reads every membership's attention, so each row
      // counts as holding a credential for the account menu's counts.
      return { workspace: null, workspaces: workspaces.map((row) => ({ ...row, credentialStored: true })), invitations: [], identity: 'connected' as const };
    },
    getWorkspaceAttention: async ({ region: target, workspaceId }) => {
      const { attention } = await readBrowserAttention();
      const found = attention.find((row) => row.region === target && row.workspaceId === workspaceId);
      // Left out of the answer: its read failed (`browser_workspace_attention_failed`).
      if (!found) throw new Error('Organization attention is unavailable right now.');
      return found.attention;
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
    getOrganizationNameSuggestion: () => identityApi.getOrganizationNameSuggestion(),
    updateAccountOnboarding,
    signOut,
    // The cookie session has no stored credential to inspect: the entry
    // re-reads the server session and unmounts this shell if it is gone.
    signOutIfCredentialCleared: revalidate,
    surrenderActiveWorkspace: revalidate,
    // Rally access over this browser's cookie (`docs/impersonation.md`): the
    // support session takes the Organization's slot in this browser, and the
    // page reloads into it, as switching Organization does here.
    // A 403 here is the staff refusal, which is final; anything else throws so it is retried.
    listSupportWorkspaces: async () => {
      try {
        return (await browserRequest(IDENTITY_REGION, '/support/workspaces', SupportWorkspacesSchema)).workspaces;
      } catch (error) {
        if (error instanceof BrowserApiError && error.status === 403) return null;
        throw error;
      }
    },
    listSupportPeople: async (workspaceId) =>
      (await browserRequest(IDENTITY_REGION, `/support/workspaces/${encodeURIComponent(workspaceId)}/people`, SupportPeopleSchema)).people,
    // Drafts are keyed by Organization and conversation, not person, and the
    // reload below skips the shell's account-change cleanup, so the
    // Organization's drafts go on the way in and on the way out.
    startSupportSession: async (target, userId) => {
      await browserRequest(target.region, '/support/session', BrowserSessionSchema, { workspaceId: target.workspaceId, userId });
      await clearWorkspaceDrafts(target.region, target.workspaceId);
      location.assign(`/app/workspaces/${target.region}/${target.workspaceId}`);
    },
    endSupportSession: async () => {
      if (session.workspace) {
        await browserRequest(session.workspace.region, '/support/end', z.undefined(), { workspaceId: session.workspace.id });
        await clearWorkspaceDrafts(session.workspace.region, session.workspace.id);
        await clearWorkspaceLocalCache(session.user.id, session.workspace.region, session.workspace.id);
      }
      location.assign('/');
    },
    clearDeepLinkError: () => undefined,
  }), [api, getAccountOnboarding, identityApi, onRevalidate, pendingConnectorOAuth, queryClient, region, revalidate, session, signOut, updateAccountOnboarding]);
  return <AppSessionValueProvider value={value} connectorSetup={connectorSetup}>
    <FaviconApiProvider>
      <AccountOnboardingGate><WorkspaceApp /></AccountOnboardingGate>
    </FaviconApiProvider>
  </AppSessionValueProvider>;
}

/**
 * The signed-in application, and the browser's one lazy boundary: sign-in
 * never downloads the renderer.
 */
export default function BrowserShell(props: {
  region: Region;
  session: CookieClientSession;
  onSignOut: () => void;
  onRevalidate: () => void;
}): React.JSX.Element {
  const [queryClient] = useState(() => createQueryClient());
  // The desktop's `App` installs this and the browser mounts below it, so the
  // tips and previews that ask it get the same answers here. See
  // `lib/window-activation.ts`.
  useWindowActivationTracking();
  // The desktop shell routes by hash. Rewrite a canonical link into that form
  // once, before its router first reads the location.
  useState(() => {
    const next = shellLocation(location.pathname, location.hash);
    if (next) history.replaceState(history.state, '', next);
    // A tab opened as the former Sidekicks tab carries `?surface=sidekicks`,
    // which would mount the Sidekicks window and never let its close button
    // leave. Sidekicks is a route of this tab now (`window-surface.ts`).
    const url = new URL(location.href);
    if (url.searchParams.has('surface')) {
      url.searchParams.delete('surface');
      history.replaceState(history.state, '', url);
    }
  });
  return <QueryClientProvider client={queryClient}>
    <Tooltip.Provider><BrowserSession {...props} /></Tooltip.Provider>
  </QueryClientProvider>;
}
