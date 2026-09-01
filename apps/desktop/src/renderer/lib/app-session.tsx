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
import type { ConnectorOAuthProvider, WorkspaceDeparture, WorkspaceDepartureOutcome } from '@rally/contracts';
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
import { SLACK_PERSONAL_CAPABILITIES } from './slack-personal-capabilities';
import { RallyApi } from './api';
import { clearAllDrafts, clearWorkspaceDrafts, migrateLegacyDrafts } from './draft-cache';
import {
  readDevicePreferences,
  setDeviceSelectedRegion,
  setDeviceWorkspaceName,
} from './device-preferences';
import { desktopBridge, type DesktopWorkspaceOnboardingState } from './platform';
import { abandonPendingWorkstreamFeedOpen, markSurfaceEntrypoint, reportJavascriptError } from './telemetry';
import type { Region } from './types';

const connectorProviderNames = {
  google: 'Google',
  github: 'GitHub',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
} as const;

export interface PendingInvitation {
  token: string;
  region: Region;
}

export interface PendingConnectorOAuth {
  attemptId: string;
  provider: ConnectorOAuthProvider;
  region: Region;
  workspaceId: string;
}

export interface AppSessionValue {
  booting: boolean;
  runtime: RuntimeConfig | null;
  region: Region | null;
  workspaceName: string;
  session: DesktopSession | null;
  api: RallyApi | null;
  invitationApi: RallyApi | null;
  deepLinkError: string | null;
  exchangingTicket: boolean;
  selectRegion: (region: Region) => void;
  setWorkspaceName: (name: string) => void;
  editWorkspaceSetup: () => void;
  pendingInvitation: PendingInvitation | null;
  pendingConnectorOAuth: PendingConnectorOAuth | null;
  setPendingConnectorOAuth: (attempt: PendingConnectorOAuth | null) => void;
  clearPendingInvitation: () => void;
  getOnboardingState: () => Promise<DesktopWorkspaceOnboardingState>;
  activateWorkspace: (region: Region, workspaceId: string, operationId?: string) => Promise<void>;
  acceptInvitation: (region: Region, invitationId: string, operationId?: string) => Promise<void>;
  declineInvitation: (region: Region, invitationId: string) => Promise<void>;
  reconnectAccountIdentity: () => Promise<void>;
  leaveWorkspace: (workspaceId: string, expectedOutcome: WorkspaceDepartureOutcome) => Promise<WorkspaceDeparture>;
  createDevelopmentSession: () => Promise<void>;
  finishWorkspaceSetup: (name: string, region: Region, operationId?: string) => Promise<void>;
  refreshSession: () => Promise<DesktopSession>;
  signOut: () => Promise<void>;
  signOutIfCredentialCleared: () => Promise<void>;
  surrenderActiveWorkspace: () => Promise<void>;
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
  | 'getRuntimeConfig'
  | 'getSession'
  | 'hasStoredCredential'
  | 'logout'
  | 'leaveWorkspace'
  | 'onDeepLink'
  | 'onSessionChanged'
  | 'openExternal'
  | 'openSettings'
  | 'refreshSession'
  | 'showDeepLinkError'
  | 'surrenderActiveWorkspace'
>;

function regionForSession(runtime: RuntimeConfig, session: DesktopSession): Region {
  if (session.workspace) return session.workspace.region;
  return runtime.api.eu === session.apiBaseUrl ? 'eu' : 'global';
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

export function AppSessionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [region, setRegion] = useState<Region | null>(() => readDevicePreferences().selectedRegion ?? null);
  const [workspaceName, setWorkspaceNameState] = useState(() => readDevicePreferences().workspaceName ?? '');
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [pendingInvitation, setPendingInvitation] = useState<PendingInvitation | null>(null);
  const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
  const [booting, setBooting] = useState(true);
  const [exchangingTicket, setExchangingTicket] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const sessionRef = useRef<DesktopSession | null>(null);
  sessionRef.current = session;
  const bridge = useMemo<AppSessionDesktopBridge>(() => desktopBridge(), []);
  const queryClient = useQueryClient();

  const applySession = useCallback((nextSession: DesktopSession | null): void => {
    setSession(nextSession);
    if (!nextSession) {
      setDeviceSelectedRegion('global');
      setRegion('global');
      queryClient.clear();
      return;
    }
    const nextRegion = nextSession.workspace?.region
      ?? (runtime?.api.eu === nextSession.apiBaseUrl ? 'eu' : 'global');
    setDeviceSelectedRegion(nextRegion);
    setRegion(nextRegion);
    if (nextSession.workspace) {
      setDeviceWorkspaceName(nextSession.workspace.name);
      setWorkspaceNameState(nextSession.workspace.name);
    }
    queryClient.clear();
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
    const previousSession = sessionRef.current;
    sessionRef.current = nextSession;
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
    setSession(renewed);
    return renewed;
  }, [bridge]);

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
    return new RallyApi(runtime.api[pendingInvitation.region], null);
  }, [pendingInvitation, runtime]);

  const createDevelopmentSession = useCallback(async () => {
    if (!api) throw new Error('Choose a workspace region first.');
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

  const reconnectAccountIdentity = useCallback(async (): Promise<void> => {
    if (!runtime) throw new Error('Rally is still loading its identity service.');
    let attemptId: string | null = null;
    try {
      const authAttempt = await bridge.createDesktopAuthAttempt({
        apiBaseUrl: runtime.api.global,
        region: 'global',
      });
      attemptId = authAttempt.attemptId;
      const identityApi = new RallyApi(runtime.api.global, null);
      const url = await identityApi.beginGoogleLogin(
        'global',
        'rallywithai://auth/complete',
        { authAttempt },
      );
      await bridge.openExternal(url);
    } catch (error) {
      if (attemptId) await bridge.cancelDesktopAuthAttempt(attemptId).catch(() => undefined);
      throw error;
    }
  }, [bridge, runtime]);

  const activateWorkspace = useCallback(async (selectedRegion: Region, workspaceId: string, operationId?: string): Promise<void> => {
    const nextSession = await bridge.activateWorkspace({ region: selectedRegion, workspaceId, operationId });
    applySession(nextSession);
  }, [applySession, bridge]);

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
      throw new Error('The workspace is no longer active');
    }
    const departure = await bridge.leaveWorkspace({ expectedOutcome, region: session.workspace.region, workspaceId });
    await clearWorkspaceDrafts(session.workspace.region, workspaceId);
    queryClient.removeQueries();
    return departure;
  }, [bridge, queryClient, session?.workspace]);

  const refreshSession = useCallback(async (): Promise<DesktopSession> => {
    const nextSession = await bridge.refreshSession();
    setSession(nextSession);
    if (nextSession.workspace) {
      setDeviceSelectedRegion(nextSession.workspace.region);
      setDeviceWorkspaceName(nextSession.workspace.name);
      setRegion(nextSession.workspace.region);
      setWorkspaceNameState(nextSession.workspace.name);
    }
    return nextSession;
  }, [bridge]);

  const finishWorkspaceSetup = useCallback(async (name: string, selectedRegion: Region, operationId?: string): Promise<void> => {
    const normalized = name.trim();
    if (normalized.length < 2) throw new Error('Enter a workspace name with at least two characters.');
    setDeviceWorkspaceName(normalized);
    setWorkspaceNameState(normalized);
    const nextSession = await bridge.createWorkspace({ region: selectedRegion, name: normalized, operationId });
    applySession(nextSession);
  }, [applySession, bridge]);

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
      const sameAccount = session?.user.email.toLocaleLowerCase('en-US')
        === previousSession.user.email.toLocaleLowerCase('en-US');
      if (!sameAccount) void clearAllDrafts();
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
    const departing = session?.workspace ?? null;
    const nextSession = await bridge.surrenderActiveWorkspace();
    if (departing) await clearWorkspaceDrafts(departing.region, departing.id);
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
          throw new Error('The requested workspace could not be renewed.');
        }
        sessionRef.current = renewedSession;
        applySession(renewedSession);
        return renewedSession;
      });
      return targetApi;
    };
    const activateDeepLinkWorkspace = async (target: WorkspaceTarget): Promise<RallyApi> => {
      if (!sessionRef.current) throw new Error('Sign in before opening a workspace link.');
      // An explicit target is an authorization request, even when it names the
      // workspace currently drawn. Main asks the platform to rediscover the
      // membership on every addressed link so a stale cached credential can
      // never turn a removed membership into access.
      const nextSession = await bridge.activateWorkspace({
        region: target.region,
        workspaceId: target.workspaceId,
      });
      if (!nextSession.workspace || !workspaceTargetsEqual({
        region: nextSession.workspace.region,
        workspaceId: nextSession.workspace.id,
      }, target)) {
        throw new Error('The requested workspace could not be activated.');
      }
      // React state commits later. Keep the imperative deep-link path on the
      // session it just activated so two callbacks in the same turn cannot
      // apply the second one to the workspace that was active before them.
      sessionRef.current = nextSession;
      applySession(nextSession);
      return apiForSession(nextSession, target);
    };
    const runInDeepLinkWorkspace = async (
      target: WorkspaceTarget,
      action: (targetApi: RallyApi) => void | Promise<void>,
    ): Promise<void> => {
      try {
        await action(await activateDeepLinkWorkspace(target));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '';
        reportDeepLinkFailure(
          /sign in/iu.test(message)
            ? message
            : /reach|network|offline|timeout|unavailable/iu.test(message)
              ? 'Rally could not reach that workspace. Check your connection, then reopen this link.'
              : 'Rally could not access the workspace this link belongs to.',
        );
      }
    };
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
        if (!requireActiveWorkspace('Sign in before starting a work stream.')) return;
        setDeepLinkError(null);
        markSurfaceEntrypoint(navigation.entrypoint);
        window.location.hash = '/workstreams/new';
        return;
      }
      if (intent.kind === 'workstream') {
        const openWorkstream = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          window.location.hash = `/workstreams/${intent.workstreamId}`;
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openWorkstream);
        else if (requireActiveWorkspace('Sign in before opening this work-stream link.')) openWorkstream();
        return;
      }
      if (intent.kind === 'note') {
        if (!requireActiveWorkspace('Sign in before opening this note.')) return;
        setDeepLinkError(null);
        markSurfaceEntrypoint(navigation.entrypoint);
        window.location.hash = `/notes/${intent.noteId}`;
        return;
      }
      if (intent.kind === 'settings') {
        const openSettings = async (): Promise<void> => {
          setDeepLinkError(null);
          await bridge.openSettings(intent.section);
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openSettings);
        else await openSettings();
        return;
      }
      if (intent.kind === 'new-automation') {
        const openAutomation = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          window.location.hash = '/automations/new';
        };
        if (intent.target) await runInDeepLinkWorkspace(intent.target, openAutomation);
        else if (requireActiveWorkspace('Sign in before creating an automation.')) openAutomation();
        return;
      }
      if (intent.kind === 'slack-link') {
        const linkSlack = async (targetApi: RallyApi): Promise<void> => {
          setDeepLinkError(null);
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
            'Sign in to the matching Rally workspace before connecting your Slack account.',
          );
          if (activeSession) await linkSlack(apiForSession(activeSession));
        }
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
          if (intent.status === 'connected') {
            setDeepLinkError(null);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
              queryClient.invalidateQueries({ queryKey: ['workstream'] }),
              queryClient.invalidateQueries({ queryKey: ['automation'] }),
            ]);
            if (intent.target) await bridge.openSettings('connections');
          } else {
            reportDeepLinkFailure(
              intent.status === 'denied'
                ? `${connectorName ?? 'Connector'} authorization was cancelled.`
                : `${connectorName ?? 'Connector'} could not be connected. Try again from Connections.`,
            );
          }
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
        reportDeepLinkFailure(
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
          apiBaseUrl: runtime.api.global,
          region: 'global',
          ticket: intent.ticket!,
          attemptId: intent.attemptId!,
        });
        sessionRef.current = nextSession;
        applySession(nextSession);
      } catch (error: unknown) {
        reportDeepLinkFailure(error instanceof Error ? error.message : 'Sign in could not be completed.');
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
        if (active) await handleDeepLink(navigation);
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
  }, [applySession, bridge, queryClient, runtime]);

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

  const value = useMemo<AppSessionValue>(
    () => ({
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
      pendingConnectorOAuth,
      setPendingConnectorOAuth,
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
      reconnectAccountIdentity,
      signOut,
      signOutIfCredentialCleared,
      surrenderActiveWorkspace,
      clearDeepLinkError: () => setDeepLinkError(null),
    }),
    [
      api,
      acceptInvitation,
      activateWorkspace,
      booting,
      createDevelopmentSession,
      declineInvitation,
      leaveWorkspace,
      deepLinkError,
      exchangingTicket,
      finishWorkspaceSetup,
      getOnboardingState,
      pendingInvitation,
      pendingConnectorOAuth,
      invitationApi,
      region,
      runtime,
      refreshSession,
      reconnectAccountIdentity,
      session,
      signOut,
      signOutIfCredentialCleared,
      surrenderActiveWorkspace,
      selectRegion,
      setWorkspaceName,
      editWorkspaceSetup,
      workspaceName,
    ],
  );

  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): AppSessionValue {
  const context = useContext(AppSessionContext);
  if (!context) throw new Error('useAppSession must be used inside AppSessionProvider');
  return context;
}
