import { navigateAppRoute } from './app-navigation';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountOnboarding, OrganizationNameSuggestion, SupportPerson, SupportWorkspace, UpdateAccountOnboarding, WorkspaceDeparture, WorkspaceDepartureOutcome } from '@rally/contracts';
import type { ClientSession } from '@rally/contracts/client-session';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
import {
  workspaceTargetsEqual,
  type WorkspaceTarget,
} from '@rally/contracts/workspace-target';
import type {
  RallyDesktopBridge,
  DesktopDeepLinkNavigation,
  DesktopSession,
  RuntimeConfig,
} from '../../common/desktop';
import { accountReconnectRequired, workspaceActivationFailureCode } from '../../common/workspace-activation-error';
import { SLACK_PERSONAL_CAPABILITIES } from './slack-personal-capabilities';
import { RallyApi } from './api';
import { CollaborationSessionProvider, shellCapabilities, type ConnectorSetupCapability, type PendingConnectorOAuth } from './collaboration-session';
export type { PendingConnectorOAuth } from './collaboration-session';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from './use-client-feature-flags';
import { workspaceFromSession } from './session-workspace';
import { accountOnboardingQueryKey } from './account-onboarding-query';
import { clearAllDrafts, clearWorkspaceDrafts, migrateLegacyDrafts } from './draft-cache';
import { canvasRoute } from './canvases';
import { openResourceState } from './navigation-routes';
import { clearAllLocalCache, clearWorkspaceLocalCache } from './local-cache';
import {
  readDevicePreferences,
  setDeviceSelectedRegion,
  setDeviceWorkspaceName,
} from './device-preferences';
import { desktopBridge, type DesktopWorkspaceOnboardingState } from './platform';
import { abandonPendingWorkstreamFeedOpen, markSurfaceEntrypoint, reportJavascriptError } from './telemetry';
import type { Region } from './types';
import { useUiStore } from './ui-store';
import { invalidateCachedWorkstreamDetails } from './workstreams-cache';

const connectorProviderNames = {
  custom_mcp: 'The MCP server',
  google: 'Google',
  github: 'GitHub',
  apollo: 'Apollo.io',
  ashby: 'Ashby',
  canva: 'Canva',
  fireflies: 'Fireflies',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
} as const;

export interface PendingInvitation {
  token: string;
  region: Region;
}

/** The account menu's directory; whoever restores the account identity invalidates it. */
export const WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY = ['workspace-account-directory'] as const;

/**
 * How an action that needs the account identity reports the detour it took.
 * Main answers such an action with `account_reconnect_required` when this
 * device holds no identity credential; the action then opens the browser for
 * a sign-in and runs again once that has landed, and the row or dialog that
 * started it hears about the wait through this so it can say where the
 * person is expected next.
 */
export interface AccountActionProgress {
  onSignInRequired: () => void;
}

/** Where the person is expected while an action that needed the account
 * identity waits for the sign-in it started: under the row, in the dialog,
 * or in place of the opening state. */
export const FINISH_SIGN_IN_IN_BROWSER = 'Finish signing in to Rally in your browser';

/** A newer browser sign-in was started from this device; it carries the
 * person's current intent, and whoever waited on the earlier one stands down. */
export class AccountSignInSupersededError extends Error {
  override readonly name = 'AccountSignInSupersededError';

  constructor(message = 'A newer sign-in replaced this one') {
    super(message);
  }
}

/** The browser sign-in an action was waiting on did not complete. */
export class AccountSignInFailedError extends Error {
  override readonly name = 'AccountSignInFailedError';
}

export interface AppSessionValue {
  /** Which client is running the shell: the Mac app, or a browser tab. */
  host: 'desktop' | 'browser';
  booting: boolean;
  runtime: RuntimeConfig | null;
  region: Region | null;
  workspaceName: string;
  /** A desktop bearer session, or the browser's credential-free cookie session. */
  session: ClientSession | null;
  api: RallyApi | null;
  invitationApi: RallyApi | null;
  deepLinkError: string | null;
  exchangingTicket: boolean;
  selectRegion: (region: Region) => void;
  setWorkspaceName: (name: string) => void;
  editWorkspaceSetup: () => void;
  pendingInvitation: PendingInvitation | null;
  /** An access request the menu bar asked the main window to decide; see `AccessRequestDialog`. */
  pendingAccessRequestId: string | null;
  clearPendingAccessRequest: () => void;
  pendingConnectorOAuth: PendingConnectorOAuth | null;
  updateCurrentUserName: (name: string) => void;
  setPendingConnectorOAuth: (attempt: PendingConnectorOAuth | null) => void;
  clearPendingInvitation: () => void;
  getOnboardingState: () => Promise<DesktopWorkspaceOnboardingState>;
  activateWorkspace: (
    region: Region,
    workspaceId: string,
    operationId?: string,
    progress?: AccountActionProgress,
  ) => Promise<void>;
  acceptInvitation: (region: Region, invitationId: string, operationId?: string) => Promise<void>;
  declineInvitation: (region: Region, invitationId: string) => Promise<void>;
  /** Opens the browser for an account sign-in and resolves once its callback
   * has been exchanged for the identity credential on this device. */
  reconnectAccountIdentity: () => Promise<void>;
  /** Stands the action waiting on a browser sign-in down without cancelling
   * the sign-in: one that still lands restores the credential all the same. */
  abandonAccountSignIn: () => void;
  leaveWorkspace: (workspaceId: string, expectedOutcome: WorkspaceDepartureOutcome) => Promise<WorkspaceDeparture>;
  createDevelopmentSession: () => Promise<void>;
  finishWorkspaceSetup: (
    name: string,
    region: Region,
    operationId?: string,
    progress?: AccountActionProgress,
  ) => Promise<void>;
  refreshSession: () => Promise<ClientSession>;
  /** The signed-in person's account onboarding, read and written at identity scope. */
  getAccountOnboarding: () => Promise<AccountOnboarding>;
  updateAccountOnboarding: (input: UpdateAccountOnboarding) => Promise<AccountOnboarding>;
  /** A name to prefill when creating an organization, read at identity scope. */
  getOrganizationNameSuggestion: () => Promise<OrganizationNameSuggestion>;
  signOut: () => Promise<void>;
  signOutIfCredentialCleared: () => Promise<void>;
  surrenderActiveWorkspace: () => Promise<void>;
  /**
   * Rally staff support access (`docs/impersonation.md`). The Organization
   * list is `null` for anybody who is not Rally staff, and rejects only on a
   * failure worth retrying.
   * Starting a session makes the chosen person's view the active one, and
   * ending it returns to the Organization used before.
   */
  listSupportWorkspaces: () => Promise<SupportWorkspace[] | null>;
  listSupportPeople: (workspaceId: string) => Promise<SupportPerson[]>;
  startSupportSession: (target: { region: Region; workspaceId: string }, userId: string) => Promise<void>;
  endSupportSession: () => Promise<void>;
  clearDeepLinkError: () => void;
}

const AppSessionContext = createContext<AppSessionValue | null>(null);

export type AppSessionDesktopBridge = Pick<
  RallyDesktopBridge,
  | 'acceptInvitation'
  | 'activateWorkspace'
  | 'cancelDesktopAuthAttempt'
  | 'consumePendingDeepLinks'
  | 'createDesktopAuthAttempt'
  | 'createDevelopmentSession'
  | 'createWorkspace'
  | 'declineInvitation'
  | 'exchangeDesktopTicket'
  | 'getOnboardingState'
  | 'getAccountOnboarding'
  | 'updateAccountOnboarding'
  | 'getOrganizationNameSuggestion'
  | 'getRuntimeConfig'
  | 'getSession'
  | 'hasStoredCredential'
  | 'logout'
  | 'leaveWorkspace'
  | 'onDeepLink'
  | 'onSessionChanged'
  | 'openExternal'
  | 'openSidekick'
  | 'openSettings'
  | 'refreshSession'
  | 'reselectActiveWorkspace'
  | 'showDeepLinkError'
  | 'surrenderActiveWorkspace'
  | 'listSupportWorkspaces'
  | 'listSupportPeople'
  | 'startSupportSession'
  | 'endSupportSession'
>;

function configuredApiBase(runtime: RuntimeConfig, region: Region): string {
  const url = runtime.api[region];
  if (!url) throw new Error('The region is unavailable');
  return url;
}

function regionForSession(runtime: RuntimeConfig, session: DesktopSession): Region {
  if (session.workspace) return session.workspace.region;
  return 'global';
}

function sessionsShareCacheScope(
  previousSession: DesktopSession | null,
  nextSession: DesktopSession | null,
): boolean {
  if (!previousSession || !nextSession) return previousSession === nextSession;
  return previousSession.apiBaseUrl === nextSession.apiBaseUrl
    && previousSession.user.id === nextSession.user.id
    && (previousSession.workspace?.id ?? null) === (nextSession.workspace?.id ?? null)
    && (previousSession.workspace?.region ?? null) === (nextSession.workspace?.region ?? null)
    && (previousSession.workspace?.role ?? null) === (nextSession.workspace?.role ?? null);
}

/**
 * Drafts belong to one user's view of one workspace. A role change is not a new
 * view of it, so being promoted does not cost anyone their unsent message.
 */
function sessionsShareDraftScope(
  previousSession: DesktopSession | null,
  nextSession: DesktopSession | null,
): boolean {
  if (!previousSession || !nextSession) return previousSession === nextSession;
  return previousSession.apiBaseUrl === nextSession.apiBaseUrl
    && previousSession.user.email.toLocaleLowerCase('en-US') === nextSession.user.email.toLocaleLowerCase('en-US')
    && (previousSession.workspace?.id ?? null) === (nextSession.workspace?.id ?? null);
}

/**
 * Send the main window home when a support session ends. Settings and the
 * other auxiliary windows route by hash under a `?surface=`, so they keep
 * their own route.
 */
function leaveSupportRoute(): void {
  if (!new URLSearchParams(window.location.search).has('surface')) navigateAppRoute('/');
}

export function AppSessionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [region, setRegion] = useState<Region | null>(() => readDevicePreferences().selectedRegion ?? null);
  const [workspaceName, setWorkspaceNameState] = useState(() => readDevicePreferences().workspaceName ?? '');
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [pendingInvitation, setPendingInvitation] = useState<PendingInvitation | null>(null);
  const [pendingAccessRequestId, setPendingAccessRequestId] = useState<string | null>(null);
  const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
  const pendingConnectorOAuthRef = useRef(pendingConnectorOAuth);
  pendingConnectorOAuthRef.current = pendingConnectorOAuth;
  const [resourceAuthorizationAttempts, setResourceAuthorizationAttempts] = useState<Readonly<Record<string, PendingConnectorOAuth>>>({});
  const resourceAuthorizationAttemptsRef = useRef(resourceAuthorizationAttempts);
  resourceAuthorizationAttemptsRef.current = resourceAuthorizationAttempts;
  const setResourceAuthorizationAttempt = useCallback((key: string, attempt: PendingConnectorOAuth | null) => {
    setResourceAuthorizationAttempts((current) => {
      const next = { ...current };
      if (attempt) next[key] = attempt;
      else delete next[key];
      return next;
    });
  }, []);
  const [booting, setBooting] = useState(true);
  const [exchangingTicket, setExchangingTicket] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const sessionRef = useRef<DesktopSession | null>(null);
  sessionRef.current = session;
  /** The workspace a switch or a creation is in the middle of landing; see the
   * session-changed listener. A creation's `workspaceId` is `null`. */
  const pendingActivationRef = useRef<{
    region: Region;
    workspaceId: string | null;
    /** The last broadcast held for this mark, for a creation that fails to apply. */
    held?: DesktopSession;
  } | null>(null);
  /** Whoever is waiting on the browser sign-in this renderer last started, and the attempt it is waiting on. */
  const pendingAccountSignInRef = useRef<{
    attemptId: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const bridge = useMemo<AppSessionDesktopBridge>(() => desktopBridge(), []);
  const queryClient = useQueryClient();

  /**
   * Adopt a session main just produced. React state commits later, so the
   * ref is moved here as well: an imperative caller in the same turn — a
   * second queued deep link, a renewal — must see the session that was just
   * applied rather than the one drawn before it.
   *
   * The cache is cleared only when the session's scope changed. A renewed
   * credential or a re-activation of the same workspace names the same user
   * and workspace, and every cached list is still theirs; discarding it made
   * the whole shell reload behind a link that was going to open one work
   * stream.
   */
  const applySession = useCallback((nextSession: DesktopSession | null): void => {
    const previousSession = sessionRef.current;
    sessionRef.current = nextSession;
    // Cleared before the state commit, so no frame draws the new session over
    // the old workspace's cache — the same order the broadcast handler keeps.
    if (!sessionsShareCacheScope(previousSession, nextSession)) queryClient.clear();
    setSession(nextSession);
    if (!nextSession) {
      setDeviceSelectedRegion('global');
      setRegion('global');
      return;
    }
    const nextRegion = nextSession.workspace?.region
      ?? 'global';
    setDeviceSelectedRegion(nextRegion);
    setRegion(nextRegion);
    if (nextSession.workspace) {
      setDeviceWorkspaceName(nextSession.workspace.name);
      setWorkspaceNameState(nextSession.workspace.name);
    }
  }, [queryClient, runtime]);

  useEffect(() => {
    let active = true;
    void Promise.all([bridge.getRuntimeConfig(), bridge.getSession()])
      .then(([nextRuntime, nextSession]) => {
        if (!active) return;
        setRuntime(nextRuntime);
        setSession(nextSession);
        if (nextSession) {
          const nextRegion = regionForSession(nextRuntime, nextSession);
          setDeviceSelectedRegion(nextRegion);
          setRegion(nextRegion);
          if (nextSession.workspace) {
            setDeviceWorkspaceName(nextSession.workspace.name);
            setWorkspaceNameState(nextSession.workspace.name);
          }
        } else {
          // Rally has one identity control plane. A data region is selected
          // only after sign-in, when creating a new workspace.
          setDeviceSelectedRegion('global');
          setRegion('global');
        }
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  useEffect(() => bridge.onSessionChanged((nextSession) => {
    // Main announces a workspace the moment it is persisted, which for a
    // switch this renderer asked for is before `activateWorkspace` has fetched
    // what the shell needs to draw it. That path applies the session itself
    // once it has; applying it here first would tear the shell down early and
    // make the switch look like a session change that already happened.
    const pending = pendingActivationRef.current;
    if (
      pending && nextSession?.workspace && nextSession.workspace.region === pending.region
      // A creation does not know its workspace's id until main answers, so it
      // holds any other workspace in the region it asked for; a renewal of the
      // one on screen passes, since a browser sign-in can keep a creation
      // waiting for minutes. Its own answer is main's active session, and a
      // failed creation applies the last broadcast it held.
      && (pending.workspaceId === null
        ? nextSession.workspace.id !== sessionRef.current?.workspace?.id
        : nextSession.workspace.id === pending.workspaceId)
    ) {
      pending.held = nextSession;
      return;
    }
    const previousSession = sessionRef.current;
    sessionRef.current = nextSession;
    // A support session that ended underneath the window (revoked, expired,
    // or ended in another window) leaves a route into somebody else's
    // Organization; start over from the root of the one now in front.
    if (previousSession?.impersonator && previousSession.user.id !== nextSession?.user.id) leaveSupportRoute();
    if (!sessionsShareCacheScope(previousSession, nextSession)) queryClient.clear();
    setSession(nextSession);
    if (nextSession) {
      const nextRegion = nextSession.workspace?.region
        ?? (runtime ? regionForSession(runtime, nextSession) : null);
      if (nextRegion) {
        setDeviceSelectedRegion(nextRegion);
        setRegion(nextRegion);
      }
      if (nextSession.workspace) {
        setDeviceWorkspaceName(nextSession.workspace.name);
        setWorkspaceNameState(nextSession.workspace.name);
      }
    } else {
      setDeviceSelectedRegion('global');
      setRegion('global');
    }
  }), [bridge, queryClient, runtime]);

  const apiBaseUrl = session?.apiBaseUrl ?? runtime?.api.global ?? null;
  const api = useMemo(() => (
    apiBaseUrl ? new RallyApi(apiBaseUrl, session) : null
  ), [
    apiBaseUrl,
    session?.user.id,
    session?.workspace?.id,
    session?.workspace?.region,
    session?.workspace?.role,
  ]);
  const renewCredential = useCallback(async (): Promise<DesktopSession> => {
    const renewed = await bridge.refreshSession();
    applySession(renewed);
    return renewed;
  }, [applySession, bridge]);

  useLayoutEffect(() => {
    // Access-token rotation must not replace the API client: it owns transient
    // draft state that should survive a routine credential refresh. Synchronize
    // its credential only after React commits the matching session state. The
    // client also adopts a token itself the moment it renews one, so this is
    // the authoritative writer rather than the only one; main rejects a
    // refresh once sign-out moves the lifecycle epoch, so the two cannot
    // disagree about which session is current.
    api?.setSession(session);
  }, [api, session]);
  useLayoutEffect(() => {
    // The scheduled refresh below cannot fire while the machine is asleep or
    // the renderer is throttled, so requests must also be able to renew an
    // already-expired bearer on demand instead of failing until a restart.
    api?.setCredentialRenewal(renewCredential);
    return () => api?.setCredentialRenewal(null);
  }, [api, renewCredential]);

  // Invitation preview and OAuth must always use the invite's regional
  // service, even when an existing session belongs to the other region.
  const invitationApi = useMemo(() => {
    if (!pendingInvitation || !runtime) return null;
    return new RallyApi(configuredApiBase(runtime, pendingInvitation.region), null);
  }, [pendingInvitation, runtime]);

  const createDevelopmentSession = useCallback(async () => {
    if (!api) throw new Error('Open an organization first.');
    const nextSession = await bridge.createDevelopmentSession(api.baseUrl, workspaceName || 'Rally Development');
    setSession(nextSession);
    if (nextSession.workspace) {
      setDeviceSelectedRegion(nextSession.workspace.region);
      setDeviceWorkspaceName(nextSession.workspace.name);
      setRegion(nextSession.workspace.region);
      setWorkspaceNameState(nextSession.workspace.name);
    }
  }, [api, bridge, workspaceName]);

  const getOnboardingState = useCallback(
    () => bridge.getOnboardingState(),
    [bridge],
  );

  /**
   * Hand a sign-in's outcome to the action waiting on that attempt. A callback
   * from any other attempt is stale — its tab was superseded by a newer one —
   * and is not the current waiter's to hear; `null` settles whichever attempt
   * is waiting. False when nothing was settled.
   */
  const settleAccountSignIn = useCallback((attemptId: string | null, failure: Error | null): boolean => {
    const pending = pendingAccountSignInRef.current;
    if (!pending || (attemptId !== null && pending.attemptId !== attemptId)) return false;
    pendingAccountSignInRef.current = null;
    if (failure) pending.reject(failure);
    else pending.resolve();
    return true;
  }, []);

  const abandonAccountSignIn = useCallback((): void => {
    settleAccountSignIn(null, new AccountSignInSupersededError('The sign-in was cancelled'));
  }, [settleAccountSignIn]);

  const reconnectAccountIdentity = useCallback(async (): Promise<void> => {
    if (!runtime) throw new Error('Rally is still loading its identity service.');
    const authAttempt = await bridge.createDesktopAuthAttempt({
      apiBaseUrl: configuredApiBase(runtime, 'global'),
      region: 'global',
    });
    // Main honours only this attempt from here on, so whoever waited on an
    // earlier one stands down now — before the browser opens, so that a
    // launch which fails below leaves nothing parked on an attempt main has
    // already retired.
    settleAccountSignIn(null, new AccountSignInSupersededError());
    try {
      const identityApi = new RallyApi(configuredApiBase(runtime, 'global'), null);
      const url = await identityApi.beginGoogleLogin(
        'global',
        'rallywithai://auth/complete',
        { authAttempt },
      );
      await bridge.openExternal(url);
    } catch (error) {
      await bridge.cancelDesktopAuthAttempt(authAttempt.attemptId).catch(() => undefined);
      throw error;
    }
    // The rest happens in the browser. Its callback arrives as a deep link
    // naming this attempt, and the exchange there settles this.
    return new Promise<void>((resolve, reject) => {
      pendingAccountSignInRef.current = { attemptId: authAttempt.attemptId, resolve, reject };
    });
  }, [bridge, runtime, settleAccountSignIn]);

  /**
   * Run an action that needs the account identity. When main answers that
   * this device holds no identity credential, the person is sent to the
   * browser to sign in and the action runs again once that has landed — a
   * switch or a creation restores the credential itself rather than failing
   * and asking for a separate reconnect first.
   */
  const withAccountIdentity = useCallback(async <T,>(
    action: () => Promise<T>,
    progress?: AccountActionProgress,
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!accountReconnectRequired(error)) throw error;
      progress?.onSignInRequired();
      try {
        await reconnectAccountIdentity();
      } catch (signInError) {
        // A sign-in that never reached the browser — the identity service
        // refused to start one, or the page could not be opened — is a
        // sign-in failure to the row that asked, not a workspace outage.
        throw signInError instanceof AccountSignInSupersededError || signInError instanceof AccountSignInFailedError
          ? signInError
          : new AccountSignInFailedError('Rally could not open the sign-in page');
      }
      return action();
    }
  }, [reconnectAccountIdentity]);

  /**
   * Land a chosen workspace in one step. The shell needs the workspace record
   * before it can draw anything, so it is fetched with the new credential
   * while the old workspace is still on screen and seeded into the fresh
   * cache the moment the session changes — otherwise the window shows a bare
   * "Opening workspace…" between the two. The route is reset to the default
   * work-stream landing whenever the workspace actually changed: a work stream
   * open in the previous workspace must not be looked up in the next one.
   * The feature flags ride across the same way so the account menu keeps its
   * shape while the new workspace's answer is on its way.
   *
   * The record is fetched first only for a session that cannot describe the
   * workspace; otherwise the session is the shell's placeholder. The account's
   * onboarding state (identity-scoped) rides with the flags, except across a
   * creation that could make an ineligible account eligible.
   */
  const applyActivatedSession = useCallback(async (
    nextSession: DesktopSession,
    previous: DesktopSession | null,
    landing: 'activation' | 'creation' = 'activation',
  ): Promise<void> => {
    const target = nextSession.workspace;
    // A support session can be the same Organization as somebody else, which
    // is a different view of it all the same.
    const workspaceChanged = !target || !previous?.workspace
      || previous.workspace.id !== target.id || previous.workspace.region !== target.region
      || previous.user.id !== nextSession.user.id;
    const prefetched = target && !workspaceFromSession(nextSession)
      ? await new RallyApi(nextSession.apiBaseUrl, nextSession).getWorkspace().catch(() => null)
      : null;
    const flags = queryClient.getQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY);
    const accountKey = accountOnboardingQueryKey(nextSession.user.email);
    const held = previous?.user.email === nextSession.user.email
      ? queryClient.getQueryData<AccountOnboarding>(accountKey)
      : undefined;
    const account = landing === 'creation' && held?.eligible !== true ? undefined : held;
    if (workspaceChanged) navigateAppRoute('/');
    applySession(nextSession);
    if (prefetched && target) {
      queryClient.setQueryData(['workspace', target.id, nextSession.user.id], prefetched);
    }
    // Carried, not trusted: stamped stale so the new workspace's own answer
    // replaces each on the first render that asks.
    if (flags !== undefined) queryClient.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, flags, { updatedAt: 0 });
    if (account !== undefined) queryClient.setQueryData(accountKey, account, { updatedAt: 0 });
  }, [applySession, queryClient]);

  const activateWorkspace = useCallback(async (
    selectedRegion: Region,
    workspaceId: string,
    operationId?: string,
    progress?: AccountActionProgress,
  ): Promise<void> => {
    const previous = sessionRef.current;
    const activation = { region: selectedRegion, workspaceId };
    pendingActivationRef.current = activation;
    try {
      const nextSession = await withAccountIdentity(
        () => bridge.activateWorkspace({ region: selectedRegion, workspaceId, operationId }),
        progress,
      );
      await applyActivatedSession(nextSession, previous);
    } catch (error) {
      // A workspace this account is refused is one it will not be active in
      // again, so the rows it left there while it was a member have no other
      // moment to leave the device: leaving and surrendering both need the
      // workspace to be the active one, and a removal made while the client
      // sat elsewhere reaches it only here.
      if (previous && workspaceActivationFailureCode(error) === 'workspace_access_denied') {
        await clearWorkspaceDrafts(selectedRegion, workspaceId);
        await clearWorkspaceLocalCache(previous.user.id, selectedRegion, workspaceId);
      }
      throw error;
    } finally {
      // Only this attempt's own mark comes down. A newer attempt at the same
      // row may have installed its own while this one waited on the browser,
      // and that one is still counting on it when its activation lands.
      if (pendingActivationRef.current === activation) pendingActivationRef.current = null;
    }
  }, [applyActivatedSession, bridge, withAccountIdentity]);

  const startSupportSession = useCallback(async (
    { region: targetRegion, workspaceId }: { region: Region; workspaceId: string },
    userId: string,
  ): Promise<void> => {
    const previous = sessionRef.current;
    // Held like an activation, so main's broadcast does not tear the shell
    // down before the chosen person's view is ready to draw.
    const activation = { region: targetRegion, workspaceId };
    pendingActivationRef.current = activation;
    try {
      await applyActivatedSession(await bridge.startSupportSession({ workspaceId, userId }), previous);
    } finally {
      if (pendingActivationRef.current === activation) pendingActivationRef.current = null;
    }
  }, [applyActivatedSession, bridge]);

  const endSupportSession = useCallback(async (): Promise<void> => {
    const ending = sessionRef.current;
    const nextSession = await bridge.endSupportSession();
    // What the staff member saw as somebody else does not stay on this device.
    if (ending?.impersonator && ending.workspace) {
      await clearWorkspaceLocalCache(ending.user.id, ending.workspace.region, ending.workspace.id);
    }
    leaveSupportRoute();
    queryClient.clear();
    applySession(nextSession);
  }, [applySession, bridge, queryClient]);

  const acceptInvitation = useCallback(async (
    invitationRegion: Region,
    invitationId: string,
    operationId?: string,
  ): Promise<void> => {
    const nextSession = await bridge.acceptInvitation({ region: invitationRegion, invitationId, operationId });
    applySession(nextSession);
  }, [applySession, bridge]);

  const declineInvitation = useCallback(async (invitationRegion: Region, invitationId: string): Promise<void> => {
    await bridge.declineInvitation({ region: invitationRegion, invitationId });
  }, [bridge]);

  const leaveWorkspace = useCallback(async (
    workspaceId: string,
    expectedOutcome: WorkspaceDepartureOutcome,
  ): Promise<WorkspaceDeparture> => {
    if (!session?.workspace || session.workspace.id !== workspaceId) {
      throw new Error('The organization is no longer active');
    }
    const departure = await bridge.leaveWorkspace({ expectedOutcome, region: session.workspace.region, workspaceId });
    await clearWorkspaceDrafts(session.workspace.region, workspaceId);
    await clearWorkspaceLocalCache(session.user.id, session.workspace.region, workspaceId);
    queryClient.removeQueries();
    return departure;
  }, [bridge, queryClient, session?.workspace]);

  const getAccountOnboarding = useCallback(() => bridge.getAccountOnboarding(), [bridge]);
  const updateAccountOnboarding = useCallback((input: UpdateAccountOnboarding) => bridge.updateAccountOnboarding(input), [bridge]);
  const refreshSession = useCallback(async (): Promise<DesktopSession> => {
    const nextSession = await bridge.refreshSession();
    // Through `applySession` like every other session writer, so the ref
    // moves with the state and a same-scope renewal keeps the cache.
    applySession(nextSession);
    return nextSession;
  }, [applySession, bridge]);

  const finishWorkspaceSetup = useCallback(async (
    name: string,
    selectedRegion: Region,
    operationId?: string,
    progress?: AccountActionProgress,
  ): Promise<void> => {
    const normalized = name.trim();
    if (normalized.length < 2) throw new Error('Enter an organization name with at least two characters.');
    setDeviceWorkspaceName(normalized);
    setWorkspaceNameState(normalized);
    // Landed the way a switch lands. Without the mark, main's broadcast of the
    // new workspace reached the listener before this call returned, cleared
    // the cache and remounted the shell on the previous workspace's route,
    // with the flags and the account's onboarding state gone.
    const creation: { region: Region; workspaceId: null; held?: DesktopSession } = {
      region: selectedRegion, workspaceId: null,
    };
    pendingActivationRef.current = creation;
    try {
      const nextSession = await withAccountIdentity(
        () => bridge.createWorkspace({ region: selectedRegion, name: normalized, operationId }),
        progress,
      );
      // What is on screen now, not when the creation began: a renewal may
      // have landed while it waited.
      await applyActivatedSession(nextSession, sessionRef.current, 'creation');
    } catch (error) {
      // A creation holds every broadcast in its region, so a workspace another
      // window activated there meanwhile was held for this call's answer. A
      // failed creation has no answer: that broadcast is main's session now.
      if (creation.held && pendingActivationRef.current === creation) {
        pendingActivationRef.current = null;
        applySession(creation.held);
      }
      throw error;
    } finally {
      if (pendingActivationRef.current === creation) pendingActivationRef.current = null;
    }
  }, [applyActivatedSession, applySession, bridge, withAccountIdentity]);

  /**
   * Drafted text and cached attachment bytes are workspace content, so a device
   * that leaves a session keeps none of it — however it left. Watching the
   * session rather than clearing inside `signOut` covers the paths that never
   * run it: main surrendering a terminally expired credential, and a
   * `session:changed(null)` broadcast.
   *
   * The effect placement is also what makes the wipe final. A composer's
   * unmount flushes whatever its save debounce was still holding, and React
   * runs a child's cleanup before a parent's effect, so that write is issued —
   * and its IndexedDB transaction created — before this one. The clear is last,
   * and nothing types its way back onto a signed-out device.
   */
  const draftScopeRef = useRef<DesktopSession | null>(null);
  const legacyDraftMigrationStarted = useRef(false);
  useEffect(() => {
    const previousSession = draftScopeRef.current;
    draftScopeRef.current = session;
    // A first session is an arrival, not a departure: launching Rally must not
    // discard the draft the last run left behind.
    if (previousSession && !sessionsShareDraftScope(previousSession, session)) {
      abandonPendingWorkstreamFeedOpen();
      // The account is who signed in to this device: on a support session, the
      // Rally staff member rather than the person shown.
      const account = (value: DesktopSession) => (value.impersonator?.email ?? value.user.email).toLocaleLowerCase('en-US');
      const sameAccount = session !== null && account(session) === account(previousSession);
      // The local cache is workspace content too — transcripts, not just the
      // sentence being typed — and leaves the device on the same transition.
      if (!sameAccount) {
        void clearAllDrafts();
        void clearAllLocalCache();
      } else {
        // Entering or leaving a support session keeps the staff member's own
        // drafts elsewhere, but drafts are keyed by Organization and
        // conversation, not person: those in the support Organization go, so
        // nobody's unsent text is restored to, or sent as, somebody else.
        for (const side of [previousSession, session]) {
          if (!side.impersonator || !side.workspace) continue;
          void clearWorkspaceDrafts(side.workspace.region, side.workspace.id);
          void clearWorkspaceLocalCache(side.user.id, side.workspace.region, side.workspace.id);
        }
      }
    }
    if (!legacyDraftMigrationStarted.current && session?.workspace) {
      legacyDraftMigrationStarted.current = true;
      void migrateLegacyDrafts(session.workspace.region, session.workspace.id);
    }
  }, [session]);

  const signOut = useCallback(async () => {
    try {
      await bridge.logout();
    } finally {
      setSession(null);
      setDeviceSelectedRegion('global');
      setRegion('global');
      queryClient.clear();
    }
  }, [bridge, queryClient]);

  /** An unauthorized read is not proof of a dead session: the bearer may have
   * simply expired, and renewing it is the API client's job. Main surrenders
   * the durable credential when a refresh fails terminally, so only a missing
   * credential ends things here. */
  const signOutIfCredentialCleared = useCallback(async (): Promise<void> => {
    const stored = await bridge.hasStoredCredential().catch(() => true);
    if (stored) return;
    setSession(null);
    setDeviceSelectedRegion('global');
    setRegion('global');
    queryClient.clear();
  }, [bridge, queryClient]);

  const surrenderActiveWorkspace = useCallback(async (): Promise<void> => {
    const departing = session ? { userId: session.user.id, workspace: session.workspace ?? null } : null;
    const nextSession = await bridge.surrenderActiveWorkspace();
    if (departing?.workspace) {
      await clearWorkspaceDrafts(departing.workspace.region, departing.workspace.id);
      await clearWorkspaceLocalCache(departing.userId, departing.workspace.region, departing.workspace.id);
    }
    // Kept alongside `applySession`'s own scope check: with nothing left to
    // select, previous and next are both null and read as the same scope.
    queryClient.clear();
    applySession(nextSession);
  }, [applySession, bridge, queryClient, session?.workspace]);

  const selectRegion = useCallback((nextRegion: Region) => {
    setDeviceSelectedRegion(nextRegion);
    setRegion(nextRegion);
  }, []);

  const setWorkspaceName = useCallback((name: string) => {
    const normalized = name.trim();
    setDeviceWorkspaceName(normalized);
    setWorkspaceNameState(normalized);
  }, []);

  const editWorkspaceSetup = useCallback(() => {
    setDeviceSelectedRegion(null);
    setRegion(null);
    setDeepLinkError(null);
  }, []);

  useEffect(() => {
    // Native callbacks are single-use. Do not subscribe or drain main's queue
    // until the trusted runtime endpoints are loaded, otherwise a cold-start
    // OAuth callback could be consumed and rejected solely because config was
    // still pending.
    if (!runtime) return undefined;
    /**
     * Report a refused link where the person will actually see it.
     *
     * Once there is a workspace, the window that handled the link is not
     * reliably the window in front: a connector completion is delivered to the
     * settings renderer, which raises and focuses itself, and settings renders
     * no shell — so anything drawn from here lands either behind the settings
     * window or nowhere at all. Main owns a window for exactly this, above
     * whichever one is focused.
     *
     * Signed out there is one window and the sign-in screen already shows this
     * text under the buttons that answer it, so it stays inline: opening a
     * second window over the top of the fix helps nobody.
     *
     * The test is `session === null`, not "has no workspace". `SignInScreen` is
     * the only surface that renders `deepLinkError`, and `SessionGate` shows it
     * only when there is no session at all: a signed-in person who has not
     * joined a workspace yet is on `WorkspaceOnboardingGate`, which renders
     * `RegionOnboarding` or `InvitationOnboarding` and neither of those reads
     * that state. Sending those failures inline would file them somewhere
     * nothing draws, so they take the window like every other signed-in one.
     *
     * A rejection means main refused or could not open the window — it
     * validates the message, and building the window can fail. The message is
     * kept in state as the last copy anyway, but for a signed-in person nothing
     * renders it, so the failure is reported rather than swallowed: silence
     * here is the surface not appearing at all.
     */
    /**
     * A sign-in failure goes to the action waiting on that attempt, which
     * shows it where the person started. A callback from an attempt that was
     * since superseded is stale and says nothing about the one now waiting.
     * The window speaks up only when nothing else will.
     */
    const reportAccountSignInFailure = (attemptId: string | null, message: string): void => {
      if (settleAccountSignIn(attemptId, new AccountSignInFailedError(message))) return;
      if (pendingAccountSignInRef.current) return;
      reportDeepLinkFailure(message);
    };
    const reportDeepLinkFailure = (message: string): void => {
      if (sessionRef.current === null) {
        setDeepLinkError(message);
        return;
      }
      void bridge.showDeepLinkError(message).catch((error: unknown) => {
        setDeepLinkError(message);
        reportJavascriptError(error, 'unknown');
      });
    };
    const apiForSession = (apiSession: DesktopSession, target?: WorkspaceTarget): RallyApi => {
      const targetApi = new RallyApi(apiSession.apiBaseUrl, apiSession);
      targetApi.setCredentialRenewal(async () => {
        const renewedSession = await bridge.refreshSession();
        if (target && (!renewedSession.workspace || !workspaceTargetsEqual({
          region: renewedSession.workspace.region,
          workspaceId: renewedSession.workspace.id,
        }, target))) {
          throw new Error('The requested organization could not be renewed.');
        }
        applySession(renewedSession);
        return renewedSession;
      });
      return targetApi;
    };
    const sessionMatchesTarget = (candidate: DesktopSession, target: WorkspaceTarget): boolean => {
      const workspace = candidate.workspace;
      return workspace !== null
        && workspaceTargetsEqual({ region: workspace.region, workspaceId: workspace.id }, target);
    };
    /**
     * Put the link's workspace in front.
     *
     * A link to the workspace already in front of the person is used as it
     * stands: main answers with the session in use and takes a selection
     * intent, so the link is the newest selection and an activation still in
     * flight cannot take over the window afterwards. Nothing is fetched and
     * nothing is reset — the regional API re-checks membership on every request
     * this credential makes, which is the same check a fresh activation would
     * have minted a credential for.
     *
     * Any other workspace goes to platform activation, which revalidates the
     * membership before the window moves. A stored credential is not enough to
     * switch on: an ended membership leaves its session row alive, so the first
     * read would fail inside a workspace the person cannot leave, rather than
     * refusing the link and leaving them where they were.
     */
    const enterDeepLinkWorkspace = async (
      target: WorkspaceTarget,
    ): Promise<{ api: RallyApi; workspaceChanged: boolean }> => {
      if (!sessionRef.current) throw new Error('Sign in before opening an organization link.');
      const reclaimed = await bridge.reselectActiveWorkspace({
        region: target.region,
        workspaceId: target.workspaceId,
      });
      if (reclaimed && sessionMatchesTarget(reclaimed, target)) {
        return { api: apiForSession(reclaimed, target), workspaceChanged: false };
      }
      const nextSession = await bridge.activateWorkspace({
        region: target.region,
        workspaceId: target.workspaceId,
      });
      if (!sessionMatchesTarget(nextSession, target)) {
        throw new Error('The requested organization could not be activated.');
      }
      applySession(nextSession);
      return { api: apiForSession(nextSession, target), workspaceChanged: true };
    };
    const runInDeepLinkWorkspace = async (
      target: WorkspaceTarget,
      action: (targetApi: RallyApi) => void | Promise<void>,
    ): Promise<void> => {
      const open = async (): Promise<void> => {
        const entered = await enterDeepLinkWorkspace(target);
        // A changed workspace must never leave a resource route from the old
        // workspace behind it. Keep this intermediate route inert while the
        // resource action resolves; the default landing would open an unrelated
        // conversation before the deep-link destination arrives.
        if (entered.workspaceChanged) {
          navigateAppRoute('/opening');
        }
        await action(entered.api);
      };
      try {
        await open();
      } catch (error: unknown) {
        if (accountReconnectRequired(error)) {
          // A device with no identity credential signs in through the browser
          // here as a menu switch would, and the link opens once that lands.
          // The wait happens outside this queue: the sign-in's own callback
          // is a deep link, and it has to be free to come through. There is
          // no in-window note for it — the only surface a link has is the
          // notice window, whose title reads as a failure and which the main
          // window cannot take down once the link has opened — so the browser
          // showing Rally's sign-in page is the cue.
          void reconnectAccountIdentity().then(open).catch(reportDeepLinkWorkspaceFailure);
          return;
        }
        reportDeepLinkWorkspaceFailure(error);
      }
    };
    function reportDeepLinkWorkspaceFailure(error: unknown): void {
        // A newer sign-in took this link's place; whoever started it is told.
        if (error instanceof AccountSignInSupersededError) return;
        const message = error instanceof Error ? error.message : '';
        const activationFailure = workspaceActivationFailureCode(error);
        // Coded failures first: their detail is prose too, and must not be
        // read by the prose tests below as if it were a sentence for the window.
        reportDeepLinkFailure(
          error instanceof AccountSignInFailedError
            ? error.message
            : activationFailure === 'account_reconnect_required'
              ? 'Sign in to Rally again, then reopen this link.'
            : activationFailure === 'workspace_access_denied'
              ? 'Rally could not access the organization this link belongs to.'
            : activationFailure === 'workspace_activation_unavailable'
              ? 'Rally could not reach that organization. Check your connection, then reopen this link.'
            : /sign in/iu.test(message)
              ? message
            : /reach|network|offline|timeout|unavailable/iu.test(message)
              ? 'Rally could not reach that organization. Check your connection, then reopen this link.'
              : 'Rally could not access the organization this link belongs to.',
        );
    }
    const handleDeepLink = async (navigation: DesktopDeepLinkNavigation): Promise<void> => {
      const intent = parseDesktopDeepLinkIntent(navigation.url);
      if (!intent) {
        let deepLink: URL | null = null;
        try {
          deepLink = new URL(navigation.url);
        } catch {
          // The generic error below is the only safe interpretation.
        }
        reportDeepLinkFailure(
          deepLink?.hostname === 'notes'
            ? 'Rally could not open that note link.'
            : deepLink?.hostname === 'auth'
            && deepLink.pathname === '/complete'
            && (deepLink.searchParams.has('connection')
              || deepLink.searchParams.has('provider')
              || deepLink.searchParams.has('status'))
            ? 'Rally received an invalid connector completion link.'
            : deepLink?.hostname === 'auth'
              && deepLink.pathname === '/complete'
              && deepLink.searchParams.has('ticket')
              ? 'The sign-in link did not match Rally’s identity service.'
            : 'Rally received an unexpected sign-in link.',
        );
        return;
      }
      const requireActiveWorkspace = (message: string): DesktopSession | null => {
        const activeSession = sessionRef.current;
        if (!activeSession?.workspace) {
          reportDeepLinkFailure(message);
          return null;
        }
        return activeSession;
      };
      if (intent.kind === 'new-workstream') {
        if (!requireActiveWorkspace('Sign in before starting a Canvas.')) return;
        setDeepLinkError(null);
        markSurfaceEntrypoint(navigation.entrypoint);
        // The link names no Canvas, so it opens the Canvases home; the
        // sidebar's plus is what starts one.
        navigateAppRoute('/');
        return;
      }
      if (intent.kind === 'canvas') {
        await runInDeepLinkWorkspace(intent.target, () => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          navigateAppRoute(canvasRoute(intent.canvasId),
            intent.artifactId ? openResourceState(intent.canvasId, intent.artifactId) : undefined);
        });
        return;
      }
      if (intent.kind === 'sidekick') {
        await runInDeepLinkWorkspace(intent.target, () => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          navigateAppRoute(`/sidekicks/${intent.sidekickId}`);
        });
        return;
      }
      if (intent.kind === 'settings') {
        const openSettings = async (): Promise<void> => {
          setDeepLinkError(null);
          // The digest moved into Notifications; links that name it still land there.
          await bridge.openSettings(intent.section === 'digest' ? 'notifications' : intent.section);
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openSettings);
        else await openSettings();
        return;
      }
      if (intent.kind === 'activity') {
        // Activity is gone (2026-11 cutover); what it listed is the Canvases
        // section's unread dots, so a link that names it lands there.
        const openCanvases = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          useUiStore.getState().setSidebarSection('canvases');
          navigateAppRoute('/canvases');
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openCanvases);
        else if (requireActiveWorkspace('Sign in before opening Rally.')) openCanvases();
        return;
      }
      if (intent.kind === 'new-automation') {
        const openAutomation = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          // The builder this used to open is gone; drafting is a conversation,
          // and a conversation is started from a Space this link does not name.
          navigateAppRoute('/');
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openAutomation);
        else if (requireActiveWorkspace('Sign in before creating a Sidekick.')) openAutomation();
        return;
      }
      if (intent.kind === 'slack-link') {
        const linkSlack = async (targetApi: RallyApi): Promise<void> => {
          setDeepLinkError(null);
          // Linking reads `/connections`, which refuses a guest. The workspace
          // the link ran in is the session by now, whether or not it switched.
          if (sessionRef.current?.workspace?.accessClass === 'guest') {
            reportDeepLinkFailure('Connecting Slack is available to members of this organization.');
            return;
          }
          try {
            const preview = await targetApi.previewSlackUserLink(intent.token);
            const confirmed = window.confirm(
              `Connect Slack user ${preview.slackUserId} from ${preview.workspaceName} to your Rally account, `
              + 'and let Rally search and act in Slack as you?',
            );
            if (!confirmed) return;
            await targetApi.linkSlackUser(intent.token);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
              queryClient.invalidateQueries({ queryKey: ['automation'] }),
            ]);
            try {
              await bridge.openSettings('connections');
              const authorization = await targetApi.startProviderConnection(
                'slack',
                'you',
                [...SLACK_PERSONAL_CAPABILITIES],
              );
              await bridge.openExternal(authorization.url);
            } catch (error: unknown) {
              reportDeepLinkFailure(
                error instanceof Error
                  ? `Slack was linked, but personal Slack tools could not be connected: ${error.message}`
                  : 'Slack was linked, but personal Slack tools could not be connected.',
              );
            }
          } catch (error: unknown) {
            reportDeepLinkFailure(error instanceof Error ? error.message : 'Your Slack account could not be linked.');
          }
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, linkSlack);
        else {
          const activeSession = requireActiveWorkspace(
            'Sign in to the matching Rally organization before connecting your Slack account.',
          );
          if (activeSession) await linkSlack(apiForSession(activeSession));
        }
        return;
      }
      if (intent.kind === 'access-request') {
        const openRequest = (): void => {
          setDeepLinkError(null);
          setPendingAccessRequestId(intent.requestId);
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openRequest);
        else if (requireActiveWorkspace('Sign in before answering this access request.')) openRequest();
        return;
      }
      if (intent.kind === 'invitation') {
        setPendingInvitation({ token: intent.token, region: intent.region });
        setDeepLinkError(null);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workspace-onboarding'] }),
          queryClient.invalidateQueries({ queryKey: ['workspace-account-directory'] }),
        ]);
        return;
      }
      if (intent.kind === 'connector-result') {
        const connectorName = intent.provider ? connectorProviderNames[intent.provider] : null;
        const applyConnectorResult = async (): Promise<void> => {
          const resourceEntry = Object.entries(resourceAuthorizationAttemptsRef.current).find(([, attempt]) =>
            attempt.provider === intent.provider && attempt.attemptId === intent.attemptId);
          if (resourceEntry) {
            const [key, attempt] = resourceEntry;
            setResourceAuthorizationAttempt(key, {
              ...attempt,
              resourceAuthorizationStatus: intent.status === 'connected' ? 'succeeded'
                : intent.status === 'denied' ? 'denied' : 'failed',
            });
            setDeepLinkError(null);
            return;
          }
          const pending = pendingConnectorOAuthRef.current;
          const pendingMatches = pending !== null
            && pending.provider === intent.provider
            && (intent.attemptId === null || pending.attemptId === intent.attemptId)
            && (intent.target === null || (
              pending.workspaceId === intent.target.workspaceId
              && pending.region === intent.target.region
            ));
          if (intent.status === 'connected') {
            setDeepLinkError(null);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
              invalidateCachedWorkstreamDetails(queryClient),
              queryClient.invalidateQueries({ queryKey: ['automation'] }),
            ]);
            const stayInPlace = pendingMatches
              && pending.source === 'conversation';
            if (intent.target && !stayInPlace) await bridge.openSettings('connections');
          } else {
            reportDeepLinkFailure(
              intent.status === 'denied'
                ? `${connectorName ?? 'Connector'} authorization was cancelled.`
                : `${connectorName ?? 'Connector'} could not be connected. Try again.`,
            );
          }
          if (pendingMatches) setPendingConnectorOAuth(null);
        };
        if (intent.target) {
          await runInDeepLinkWorkspace(intent.target, applyConnectorResult);
          return;
        }
        const activeSession = requireActiveWorkspace('Rally received an invalid connector completion link.');
        if (!activeSession) return;
        if (
          intent.callbackRegion !== null
          && intent.callbackRegion !== activeSession.workspace!.region
        ) {
          reportDeepLinkFailure('Rally received an invalid connector completion link.');
          return;
        }
        await applyConnectorResult();
        return;
      }
      if (intent.status === 'failed') {
        if (intent.attemptId) await bridge.cancelDesktopAuthAttempt(intent.attemptId);
        reportAccountSignInFailure(
          intent.attemptId,
          `Sign in could not be completed: ${intent.errorCode?.replace(/[_-]+/gu, ' ') ?? 'unknown error'}`,
        );
        return;
      }
      setDeviceSelectedRegion('global');
      setRegion('global');
      setExchangingTicket(true);
      setDeepLinkError(null);
      try {
        const nextSession = await bridge.exchangeDesktopTicket({
          apiBaseUrl: configuredApiBase(runtime, 'global'),
          region: 'global',
          ticket: intent.ticket!,
          attemptId: intent.attemptId!,
        });
        applySession(nextSession);
        // The account identity is back on this device, so whatever the menu
        // last heard about it — a reconnect it thought was still needed — is
        // stale the moment this lands, not the next time it happens to ask.
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY });
        settleAccountSignIn(intent.attemptId!, null);
      } catch (error: unknown) {
        reportAccountSignInFailure(
          intent.attemptId!,
          error instanceof Error ? error.message : 'Sign in could not be completed.',
        );
      } finally {
        setExchangingTicket(false);
      }
    };
    let active = true;
    let pendingDrained = false;
    const liveDeepLinks: DesktopDeepLinkNavigation[] = [];
    let delivery = Promise.resolve();
    const enqueue = (navigation: DesktopDeepLinkNavigation): void => {
      delivery = delivery.then(async () => {
        if (!active) return;
        try {
          await handleDeepLink(navigation);
        } catch (error: unknown) {
          // One failed window action must not reject the queue tail: every
          // later operating-system callback still deserves its turn. Most
          // destination failures are handled closer to their domain; this is
          // the final boundary for bridge/window failures that escape them.
          reportJavascriptError(error, 'unknown');
          reportDeepLinkFailure(
            error instanceof Error ? error.message : 'Rally could not open that link.',
          );
        }
      });
    };
    const unsubscribe = bridge.onDeepLink((navigation) => {
      if (pendingDrained) enqueue(navigation);
      else liveDeepLinks.push(navigation);
    });
    void bridge.consumePendingDeepLinks()
      .then((deepLinks) => {
        if (!active) return;
        deepLinks.forEach(enqueue);
        pendingDrained = true;
        liveDeepLinks.splice(0).forEach(enqueue);
      })
      .catch((error: unknown) => {
        reportJavascriptError(error, 'unknown');
        pendingDrained = true;
        liveDeepLinks.splice(0).forEach(enqueue);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applySession, bridge, queryClient, reconnectAccountIdentity, runtime, settleAccountSignIn]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryDelayMs = 5_000;
    const expiresAt = Date.parse(session.expiresAt);
    const refreshAt = Number.isFinite(expiresAt) ? Math.max(1_000, expiresAt - Date.now() - 60_000) : 60_000;
    const refresh = async (): Promise<void> => {
      try {
        const refreshed = await bridge.refreshSession();
        if (!cancelled) setSession(refreshed);
      } catch {
        if (cancelled) return;
        // Main owns the encrypted refresh credential and surrenders it when a
        // refresh fails terminally. Every other failure is transient: the
        // refresh credential outlives the access token by weeks, so a network
        // blip must never end an otherwise valid session. A failed probe is
        // read as "still stored" for the same reason.
        const stored = await bridge.hasStoredCredential().catch(() => true);
        if (cancelled) return;
        if (!stored) {
          setDeepLinkError('Your session expired. Sign in again to continue.');
          setSession(null);
          return;
        }
        retryTimer = window.setTimeout(() => void refresh(), retryDelayMs);
        retryDelayMs = Math.min(5 * 60_000, retryDelayMs * 2);
      }
    };
    const timer = window.setTimeout(() => void refresh(), refreshAt);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [bridge, session]);

  const updateCurrentUserName = useCallback((name: string): void => {
    const current = sessionRef.current;
    if (!current || current.user.name === name) return;
    const updated = { ...current, user: { ...current.user, name } };
    sessionRef.current = updated;
    api?.setSession(updated);
    setSession(updated);
    void queryClient.invalidateQueries({ queryKey: ['workspace'] });
  }, [api, queryClient]);

  const value = useMemo<AppSessionValue>(
    () => ({
      host: 'desktop' as const,
      booting,
      runtime,
      region,
      workspaceName,
      session,
      api,
      invitationApi,
      deepLinkError,
      exchangingTicket,
      selectRegion,
      setWorkspaceName,
      editWorkspaceSetup,
      pendingInvitation,
      pendingAccessRequestId,
      clearPendingAccessRequest: () => setPendingAccessRequestId(null),
      pendingConnectorOAuth,
      setPendingConnectorOAuth,
      updateCurrentUserName,
      clearPendingInvitation: () => {
        setPendingInvitation(null);
        if (session?.workspace) {
          setDeviceSelectedRegion(session.workspace.region);
          setRegion(session.workspace.region);
        }
      },
      getOnboardingState,
      activateWorkspace,
      acceptInvitation,
      declineInvitation,
      leaveWorkspace,
      createDevelopmentSession,
      finishWorkspaceSetup,
      refreshSession,
      getAccountOnboarding,
      updateAccountOnboarding,
      reconnectAccountIdentity,
      abandonAccountSignIn,
      signOut,
      signOutIfCredentialCleared,
      surrenderActiveWorkspace,
      getOrganizationNameSuggestion: () => bridge.getOrganizationNameSuggestion(),
      listSupportWorkspaces: () => bridge.listSupportWorkspaces(),
      listSupportPeople: (workspaceId: string) => bridge.listSupportPeople(workspaceId),
      startSupportSession,
      endSupportSession,
      clearDeepLinkError: () => setDeepLinkError(null),
    }),
    [
      abandonAccountSignIn,
      bridge,
      api,
      acceptInvitation,
      activateWorkspace,
      booting,
      createDevelopmentSession,
      declineInvitation,
      leaveWorkspace,
      deepLinkError,
      getAccountOnboarding,
      updateAccountOnboarding,
      exchangingTicket,
      finishWorkspaceSetup,
      getOnboardingState,
      pendingInvitation,
      pendingAccessRequestId,
      pendingConnectorOAuth,
      updateCurrentUserName,
      invitationApi,
      region,
      runtime,
      refreshSession,
      reconnectAccountIdentity,
      session,
      signOut,
      signOutIfCredentialCleared,
      surrenderActiveWorkspace,
      startSupportSession,
      endSupportSession,
      selectRegion,
      setWorkspaceName,
      editWorkspaceSetup,
      workspaceName,
    ],
  );

  const connectorSetup = useMemo(() => ({ pendingConnectorOAuth, setPendingConnectorOAuth,
    resourceAuthorizationAttempts, setResourceAuthorizationAttempt,
    openExternal: (url: string) => bridge.openExternal(url) }), [bridge, pendingConnectorOAuth, resourceAuthorizationAttempts, setResourceAuthorizationAttempt]);
  return <AppSessionValueProvider value={value} connectorSetup={connectorSetup}>{children}</AppSessionValueProvider>;
}

/**
 * Installs a host's session value and the smaller collaboration context every
 * shared surface reads. The desktop builds its value from the bridge; the
 * browser builds one over its cookie session.
 */
export function AppSessionValueProvider({ value, connectorSetup, children }: PropsWithChildren<{
  value: AppSessionValue;
  connectorSetup: ConnectorSetupCapability | null;
}>): React.JSX.Element {
  // Starting a connection is a member's: its routes refuse a guest, so on
  // either host a guest's shell is not handed it. Existing connectors still work.
  const { guest } = shellCapabilities(value);
  return <AppSessionContext.Provider value={value}>
    <CollaborationSessionProvider api={value.api} host={value.host} session={value.session}
      connectorSetup={guest ? null : connectorSetup}>{children}</CollaborationSessionProvider>
  </AppSessionContext.Provider>;
}

export function useAppSession(): AppSessionValue {
  const context = useContext(AppSessionContext);
  if (!context) throw new Error('useAppSession must be used inside AppSessionProvider');
  return context;
}
