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
import { IdSchema, type WorkspaceDeparture, type WorkspaceDepartureOutcome } from '@rally/contracts';
import { isDesktopDeepLinkProtocol } from '@rally/contracts/desktop-deep-link';
import { parseWorkstreamLinkTarget } from '@rally/contracts/workstream-links';
import {
  parseWorkspaceTarget,
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
    const activateDeepLinkWorkspace = async (target: WorkspaceTarget): Promise<RallyApi> => {
      const activeSession = sessionRef.current;
      if (!activeSession?.workspace) {
        throw new Error('Sign in before opening a workspace link.');
      }
      if (workspaceTargetsEqual({
        region: activeSession.workspace.region,
        workspaceId: activeSession.workspace.id,
      }, target)) {
        return new RallyApi(activeSession.apiBaseUrl, activeSession);
      }
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
      return new RallyApi(nextSession.apiBaseUrl, nextSession);
    };
    const runInDeepLinkWorkspace = (
      target: WorkspaceTarget,
      action: (targetApi: RallyApi) => void | Promise<void>,
    ): void => {
      void activateDeepLinkWorkspace(target)
        .then(action)
        .catch((error: unknown) => {
          reportDeepLinkFailure(
            error instanceof Error && /sign in/iu.test(error.message)
              ? error.message
              : 'Rally could not access the workspace this link belongs to.',
          );
        });
    };
    const handleDeepLink = (navigation: DesktopDeepLinkNavigation): void => {
      let deepLink: URL;
      try {
        deepLink = new URL(navigation.url);
      } catch {
        reportDeepLinkFailure('Rally received an invalid sign-in link.');
        return;
      }
      if (isDesktopDeepLinkProtocol(deepLink.protocol) && deepLink.hostname === 'workstreams' && deepLink.pathname === '/new') {
        if (!sessionRef.current?.workspace) {
          reportDeepLinkFailure('Sign in before starting a work stream.');
          return;
        }
        setDeepLinkError(null);
        markSurfaceEntrypoint(navigation.entrypoint);
        window.location.hash = '/workstreams/new';
        return;
      }
      if (isDesktopDeepLinkProtocol(deepLink.protocol) && deepLink.hostname === 'workstreams') {
        const target = parseWorkstreamLinkTarget(deepLink.toString(), { webBaseUrl: runtime.webBaseUrl });
        if (!target || !sessionRef.current?.workspace) {
          reportDeepLinkFailure('Sign in before opening this work-stream link.');
          return;
        }
        const openWorkstream = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          window.location.hash = `/workstreams/${target.workstreamId}`;
        };
        if (target.region === null) openWorkstream();
        else runInDeepLinkWorkspace(target, openWorkstream);
        return;
      }
      if (isDesktopDeepLinkProtocol(deepLink.protocol) && deepLink.hostname === 'notes') {
        // Sent by the main process when a meeting window closes, so that the
        // recording a person just ended hands them to the note it produced.
        const noteId = deepLink.pathname.slice(1);
        // Two different problems, and telling them apart is the difference
        // between an instruction someone can act on and one that cannot help:
        // signing in again does nothing about a link that names no note.
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(noteId)) {
          reportDeepLinkFailure('Rally could not open that note link.');
          return;
        }
        if (!sessionRef.current?.workspace) {
          reportDeepLinkFailure('Sign in before opening this note.');
          return;
        }
        setDeepLinkError(null);
        markSurfaceEntrypoint(navigation.entrypoint);
        window.location.hash = `/notes/${noteId}`;
        return;
      }
      if (
        isDesktopDeepLinkProtocol(deepLink.protocol)
        && deepLink.hostname === 'settings'
        && (deepLink.pathname === '/workspace' || deepLink.pathname === '/connections'
          || deepLink.pathname === '/digest')
      ) {
        const target = deepLink.search ? parseWorkspaceTarget(deepLink.searchParams) : null;
        const exactRouting = deepLink.search === '' || (
          target !== null
          && [...deepLink.searchParams.keys()].length === 2
          && [...deepLink.searchParams.keys()].every((key) => key === 'region' || key === 'workspace')
        );
        if (!exactRouting) {
          reportDeepLinkFailure('Rally received an unexpected sign-in link.');
          return;
        }
        const section = deepLink.pathname === '/connections'
          ? 'connections'
          : deepLink.pathname === '/digest' ? 'digest' : 'workspace';
        const openSettings = (): void => {
          setDeepLinkError(null);
          void bridge.openSettings(section);
        };
        if (target) runInDeepLinkWorkspace(target, openSettings);
        else openSettings();
        return;
      }
      if (
        isDesktopDeepLinkProtocol(deepLink.protocol)
        && deepLink.hostname === 'automations'
        && deepLink.pathname === '/new'
      ) {
        const target = deepLink.search ? parseWorkspaceTarget(deepLink.searchParams) : null;
        const exactRouting = deepLink.search === '' || (
          target !== null
          && [...deepLink.searchParams.keys()].length === 2
          && [...deepLink.searchParams.keys()].every((key) => key === 'region' || key === 'workspace')
        );
        if (!exactRouting) {
          reportDeepLinkFailure('Rally received an unexpected sign-in link.');
          return;
        }
        if (!sessionRef.current?.workspace) {
          reportDeepLinkFailure('Sign in before creating an automation.');
          return;
        }
        const openAutomation = (): void => {
          setDeepLinkError(null);
          markSurfaceEntrypoint(navigation.entrypoint);
          window.location.hash = '/automations/new';
        };
        if (target) runInDeepLinkWorkspace(target, openAutomation);
        else openAutomation();
        return;
      }
      if (isDesktopDeepLinkProtocol(deepLink.protocol) && deepLink.hostname === 'slack' && deepLink.pathname === '/link') {
        const token = deepLink.searchParams.get('token');
        const target = deepLink.searchParams.has('workspace')
          ? parseWorkspaceTarget(deepLink.searchParams)
          : null;
        const entries = [...deepLink.searchParams.keys()];
        const exactToken = token
          && /^[A-Za-z0-9_-]{20,500}$/u.test(token)
          && deepLink.searchParams.getAll('token').length === 1
          && (
            (entries.length === 1 && entries[0] === 'token')
            || (
              entries.length === 3
              && entries.every((key) => key === 'token' || key === 'region' || key === 'workspace')
              && target !== null
            )
          );
        if (!exactToken || !sessionRef.current?.workspace) {
          reportDeepLinkFailure('Sign in to the matching Rally workspace before connecting your Slack account.');
          return;
        }
        const linkSlack = (targetApi: RallyApi): void => {
          setDeepLinkError(null);
          void targetApi.previewSlackUserLink(token)
          .then((preview) => {
            const confirmed = window.confirm(
              `Connect Slack user ${preview.slackUserId} from ${preview.workspaceName} to your Rally account, `
              + 'and let Rally search and act in Slack as you?',
            );
            if (!confirmed) return null;
            return targetApi.linkSlackUser(token);
          })
          .then(async (result) => {
            if (!result) return;
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
              queryClient.invalidateQueries({ queryKey: ['automation'] }),
            ]);
            // One button, both halves. Linking records who this Slack person is;
            // the personal connection is what lets Rally act as them. Split
            // across two buttons that both said "Connect", members reasonably
            // believed the first had done the second — App Home said
            // "Welcome, <name>" while personal tools stayed unconnected. The
            // authorization is continued into here rather than left as a second
            // errand. Its own callback re-establishes the link, so whichever
            // half a member reaches first, both end up done.
            try {
              // Inside the same try as the authorization: this rejecting is not
              // the link failing, and reporting "your Slack account could not be
              // linked" for a link that committed is the error the whole change
              // is about.
              await bridge.openSettings('connections');
              const authorization = await targetApi.startProviderConnection(
                'slack',
                'you',
                [...SLACK_PERSONAL_CAPABILITIES],
              );
              await bridge.openExternal(authorization.url);
            } catch (error: unknown) {
              // The link committed and is useful on its own. Surface the
              // failure without retracting what already succeeded.
              reportDeepLinkFailure(
                error instanceof Error
                  ? `Slack was linked, but personal Slack tools could not be connected: ${error.message}`
                  : 'Slack was linked, but personal Slack tools could not be connected.',
              );
            }
          })
          .catch((error: unknown) => {
            reportDeepLinkFailure(error instanceof Error ? error.message : 'Your Slack account could not be linked.');
          });
        };
        if (target) runInDeepLinkWorkspace(target, linkSlack);
        else {
          const activeSession = sessionRef.current;
          if (activeSession) linkSlack(new RallyApi(activeSession.apiBaseUrl, activeSession));
        }
        return;
      }
      if (isDesktopDeepLinkProtocol(deepLink.protocol) && deepLink.hostname === 'invitations' && deepLink.pathname === '/accept') {
        const token = deepLink.searchParams.get('token');
        const inviteRegion = deepLink.searchParams.get('region');
        if (!token || token.length < 20 || (inviteRegion !== 'global' && inviteRegion !== 'eu')) {
          reportDeepLinkFailure('Rally received an invalid workspace invitation.');
          return;
        }
        setPendingInvitation({ token, region: inviteRegion });
        setDeepLinkError(null);
        // Invitations are discovered from the verified platform identity.
        // Refresh an already-mounted empty setup gate immediately instead of
        // leaving the user on “Create workspace” until the next launch.
        void queryClient.invalidateQueries({ queryKey: ['workspace-onboarding'] });
        void queryClient.invalidateQueries({ queryKey: ['workspace-account-directory'] });
        return;
      }
      if (!isDesktopDeepLinkProtocol(deepLink.protocol) || deepLink.hostname !== 'auth' || deepLink.pathname !== '/complete') {
        reportDeepLinkFailure('Rally received an unexpected sign-in link.');
        return;
      }
      const connectionId = deepLink.searchParams.get('connection');
      const connectorProvider = deepLink.searchParams.get('provider');
      const activeSession = sessionRef.current;
      if (connectionId && deepLink.searchParams.get('status') === 'connected' && connectorProvider === null) {
        const legacyEntries = [...deepLink.searchParams.entries()];
        if (
          !activeSession?.workspace
          || !IdSchema.safeParse(connectionId).success
          || legacyEntries.length !== 2
          || legacyEntries.some(([name]) => name !== 'connection' && name !== 'status')
          || deepLink.searchParams.getAll('connection').length !== 1
          || deepLink.searchParams.getAll('status').length !== 1
        ) {
          reportDeepLinkFailure('Rally received an invalid connector completion link.');
          return;
        }
        setDeepLinkError(null);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ['connections'] }),
          queryClient.invalidateQueries({ queryKey: ['workstream'] }),
          queryClient.invalidateQueries({ queryKey: ['automation'] }),
        ]);
        return;
      }
      const connectorName = connectorProvider && connectorProvider in connectorProviderNames
        ? connectorProviderNames[connectorProvider as keyof typeof connectorProviderNames]
        : null;
      const connectorStatus = deepLink.searchParams.get('status');
      if (connectionId || connectorProvider || connectorStatus) {
        const entries = [...deepLink.searchParams.entries()];
        const hasSingleValue = (name: string): boolean => deepLink.searchParams.getAll(name).length === 1;
        const callbackRegion = deepLink.searchParams.get('region');
        const attemptId = deepLink.searchParams.get('attempt');
        const connectorError = deepLink.searchParams.get('error');
        const callbackWorkspace = deepLink.searchParams.has('workspace')
          ? parseWorkspaceTarget(deepLink.searchParams)
          : null;
        const validOptionalWorkspace = !deepLink.searchParams.has('workspace')
          || (callbackWorkspace !== null && callbackWorkspace.region === callbackRegion);
        const validSuccess =
          entries.length >= 4
          && entries.length <= 6
          && entries.every(([name]) => ['connection', 'status', 'region', 'workspace', 'attempt', 'provider'].includes(name))
          && ['connection', 'status', 'region', 'provider'].every(hasSingleValue)
          && connectorStatus === 'connected'
          && connectionId !== null
          && IdSchema.safeParse(connectionId).success
          && (attemptId === null || (hasSingleValue('attempt') && /^[A-Za-z0-9_-]{43}$/u.test(attemptId)))
          && connectorError === null;
        const validFailure =
          entries.length >= 4
          && entries.length <= 6
          && entries.every(([name]) => ['status', 'error', 'region', 'workspace', 'attempt', 'provider'].includes(name))
          && ['status', 'error', 'region', 'provider'].every(hasSingleValue)
          && (connectorStatus === 'denied' || connectorStatus === 'failed')
          && connectionId === null
          && connectorError !== null
          && /^[a-z0-9_-]{1,100}$/u.test(connectorError)
          && (attemptId === null || (hasSingleValue('attempt') && /^[A-Za-z0-9_-]{43}$/u.test(attemptId)));
        const legacyWorkspaceMatches = callbackWorkspace !== null
          || callbackRegion === activeSession?.workspace?.region;
        if (!activeSession?.workspace || !connectorName || !validOptionalWorkspace
          || !legacyWorkspaceMatches || (!validSuccess && !validFailure)) {
          reportDeepLinkFailure('Rally received an invalid connector completion link.');
          return;
        }
        const applyConnectorResult = (): void => {
          if (validSuccess) {
            setDeepLinkError(null);
            void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['connections'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream'] }),
            queryClient.invalidateQueries({ queryKey: ['automation'] }),
            ]);
          } else {
            reportDeepLinkFailure(
              connectorStatus === 'denied'
                ? `${connectorName} authorization was cancelled.`
                : `${connectorName} could not be connected. Try again from Connections.`,
            );
          }
        };
        if (callbackWorkspace) runInDeepLinkWorkspace(callbackWorkspace, applyConnectorResult);
        else applyConnectorResult();
        return;
      }
      const connectionError = deepLink.searchParams.get('error');
      if (connectionError) {
        const failedAttemptId = deepLink.searchParams.get('attempt');
        if (failedAttemptId && /^[A-Za-z0-9_-]{43}$/u.test(failedAttemptId)) {
          void bridge.cancelDesktopAuthAttempt(failedAttemptId);
        }
        reportDeepLinkFailure(`Sign in could not be completed: ${connectionError.replace(/[_-]+/gu, ' ')}`);
        return;
      }
      const ticket = deepLink.searchParams.get('ticket');
      if (!ticket) {
        reportDeepLinkFailure('The sign-in link did not contain a desktop ticket.');
        return;
      }
      const callbackRegion = deepLink.searchParams.get('region');
      if (callbackRegion !== 'global') {
        reportDeepLinkFailure('The sign-in link did not match Rally’s identity service.');
        return;
      }
      const attemptId = deepLink.searchParams.get('attempt');
      if (!attemptId || !/^[A-Za-z0-9_-]{43}$/u.test(attemptId)) {
        reportDeepLinkFailure('The sign-in link did not match a native authentication attempt.');
        return;
      }
      setDeviceSelectedRegion(callbackRegion);
      setRegion(callbackRegion);
      setExchangingTicket(true);
      setDeepLinkError(null);
      void bridge
        .exchangeDesktopTicket({
          apiBaseUrl: runtime.api[callbackRegion],
          region: callbackRegion,
          ticket,
          attemptId,
        })
        .then((nextSession) => {
          if (nextSession.workspace) {
            setDeviceWorkspaceName(nextSession.workspace.name);
            setWorkspaceNameState(nextSession.workspace.name);
          }
          setSession(nextSession);
        })
        .catch((error: unknown) => {
          reportDeepLinkFailure(error instanceof Error ? error.message : 'Sign in could not be completed.');
        })
        .finally(() => setExchangingTicket(false));
    };
    const unsubscribe = bridge.onDeepLink(handleDeepLink);
    void bridge.consumePendingDeepLinks().then((deepLinks) => deepLinks.forEach(handleDeepLink));
    return unsubscribe;
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
