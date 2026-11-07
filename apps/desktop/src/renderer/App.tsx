import { AppRouteNavigation } from './lib/app-navigation';
import { ArtifactWindow } from './screens/artifact-window';
import { AppErrorBoundary } from "@rally/ui/components/app-error-boundary";
import { createQueryClient } from "./lib/query-client";
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Cable, RefreshCcw } from 'lucide-react';
import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { desktopWorkspaceIdentityKey } from '../common/desktop';
import { logError } from '../common/logger';
import { AppShell } from './components/app-shell';
import { RallyPong } from './components/easter-eggs/rally-pong';
import { Button, EmptyState, LoadingState } from './components/primitives';
import { SpeechPlaybackProvider } from './components/speech-playback';
import { ApiError, isSessionRejection } from './lib/api';
import { useWorkspaceMembers } from './lib/workspace-members';
import { AppSessionProvider, useAppSession, type AppSessionValue, FINISH_SIGN_IN_IN_BROWSER } from './lib/app-session';
import { useShellCapabilities } from './lib/collaboration-session';
import { localCacheScope } from './lib/local-cache';
import { FaviconApiProvider } from './lib/favicon-api';
import { LocalCacheScopeProvider } from './lib/local-cache-scope';
import { desktopBridge } from './lib/platform';
import { refreshPoppedOutArtifacts, restorePoppedOutArtifacts, type RefreshPoppedOutArtifactsInput } from './lib/popped-out-artifacts';
import { useResourceHeads } from './lib/resource-heads';
import { useWorkspaceQuery } from './lib/use-workspace';
import {
  abandonPendingWorkstreamFeedOpen,
  abandonWorkstreamFeedOpenOutsideRoute,
  installRendererErrorTelemetry,
  consumeSurfaceEntrypoint,
  reportJavascriptError,
  reportTelemetryProductIntent,
  reportTelemetryScreen,
  telemetryScreenForPath,
  telemetrySurfaceForPath,
  uuidV7,
} from './lib/telemetry';
import { watchSystemAppearance, watchThemeBroadcast } from './lib/theme';
import type { Workspace } from './lib/types';
import { useWindowActivationTracking } from './lib/window-activation';
import { useEscapeClosesWindow } from './lib/window-escape';
import { useOptionalWorkspaceSocket, WorkspaceSocketProvider } from './lib/workspace-socket';
import { WorkstreamSocketResumeProvider } from './lib/workstream-socket-resume';
import { AutomationScreen } from './screens/automation';
import { CanvasScreen } from './screens/canvas';
import { CanvasesHomeScreen } from './screens/canvases-home';
import { DeepLinkErrorScreen } from './screens/deep-link-error';
import { LandingScreen } from './screens/landing';
import { useOpenLanding } from './lib/landing';
import { AccountOnboardingGate, WorkspaceOnboardingJourney } from './screens/guided-onboarding';
import { ErrorNotice } from './components/primitives';
import { BootScreen, InvitationOnboarding, RegionOnboarding, SignInScreen } from './screens/onboarding';
import { SidekicksLibraryRoute } from './screens/sidekicks-library';
import { WorkspaceSettingsScreen } from './screens/workspace-settings';
import { SidekickMentionProvider } from './lib/sidekick-mentions';

const queryClient = createQueryClient();

function ErrorBoundary({ children }: PropsWithChildren): React.JSX.Element {
  return <AppErrorBoundary onError={(error, info) => {
    logError('rally', 'renderer error boundary caught an error', error, info.componentStack);
    reportJavascriptError(error, 'react_boundary');
  }}>{children}</AppErrorBoundary>;
}

function ServiceSetupState({ error, onRetry }: { error: Error; onRetry: () => void }): React.JSX.Element {
  const { signOut } = useAppSession();
  const [playing, setPlaying] = useState(false);
  const stopPlaying = useCallback(() => setPlaying(false), []);
  const isNetwork = error instanceof ApiError && error.status === 0;
  useEffect(() => {
    // Space starts a game, as the offline dinosaur does, unless a control has
    // focus and Space is that control's.
    const start = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.target !== document.body) return;
      event.preventDefault();
      setPlaying(true);
    };
    window.addEventListener('keydown', start);
    return () => window.removeEventListener('keydown', start);
  }, []);
  return (
    <main className="service-setup-screen window-drag">
      <section className="service-setup-card window-no-drag">
        <button
          aria-label={playing ? 'Stop playing Pong' : 'Play Pong while you wait'}
          className="setup-icon"
          onClick={() => setPlaying((current) => !current)}
          type="button"
        >
          <Cable size={20} />
        </button>
        <h1>{isNetwork ? 'Rally can’t connect' : 'Rally isn’t available right now'}</h1>
        {/* A network failure's message only restates the title; any other
            failure's message is the reason, such as a sign-in that was refused. */}
        <p>{isNetwork ? 'Check your internet connection, then try again.' : error.message}</p>
        {playing && <RallyPong onClose={stopPlaying} />}
        <div className="setup-actions">
          {isNetwork && <ErrorNotice automatic={false} detailsLabel="Details" occurrence={error} title="Rally can’t connect">{error.message}</ErrorNotice>}
          <Button onClick={() => void signOut()}>Sign out</Button>
          <Button className="button-primary" onClick={onRetry}><RefreshCcw size={14} /> Try again</Button>
        </div>
      </section>
    </main>
  );
}

function NotFoundScreen(): React.JSX.Element {
  // Through the hook rather than the hash, so the entry is replaced and Back
  // does not return to the route that had nothing to show.
  const openLanding = useOpenLanding();
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <EmptyState
        action={<Button onClick={() => openLanding()}>Go to your Canvases</Button>}
        description="This Rally view does not exist or is no longer available."
        title="Nothing here"
      />
    </div>
  );
}

/**
 * Whether this window is on screen, for a surface that may have been built
 * before anybody asked to see it.
 *
 * Only the settings window is prewarmed, and only main can tell a prewarmed
 * window from an opened one: the renderer's own `document.visibilityState`
 * reports `visible` for a `show: false` window on at least one platform, so it
 * cannot be used for this. Every other surface is on screen the moment it
 * mounts and starts `true`, which makes this a no-op everywhere else.
 */
function useWindowRevealed(prewarmable: boolean): boolean {
  const [revealed, setRevealed] = useState(!prewarmable);
  useEffect(() => {
    if (!prewarmable) return;
    return desktopBridge().onSettingsWindowRevealed(() => setRevealed(true));
  }, [prewarmable]);
  return revealed;
}

/**
 * `enabled` is what keeps a prewarmed window out of the numbers. `/settings`
 * resolves to a *surface*, so this reports `surface_viewed` for it rather than a
 * screen — and that report both consumes the pending entrypoint and latches
 * `lastSurfacePath`, so a prewarm firing it would spend the attribution on
 * nobody and leave the real open reporting nothing at all.
 */
function TelemetryRouteObserver({ enabled = true }: { enabled?: boolean }): null {
  const location = useLocation();
  const lastScreen = useRef<ReturnType<typeof telemetryScreenForPath>>(null);
  const lastSurfacePath = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const screen = telemetryScreenForPath(location.pathname);
    // The automation route has one screen behind it now that the builder is
    // gone, so the path is the whole answer and the draft lookup this used to
    // do — reading the automations list to tell two screens apart — is a query
    // for a distinction that no longer exists.
    const surface = telemetrySurfaceForPath(location.pathname);
    abandonWorkstreamFeedOpenOutsideRoute(
      surface?.resourceType === 'workstream' ? surface.resourceId ?? null : null,
    );
    if (!surface && screen !== lastScreen.current) {
      lastScreen.current = screen;
      if (screen) reportTelemetryScreen(screen);
    }
    if (surface && lastSurfacePath.current !== location.pathname) {
      lastSurfacePath.current = location.pathname;
      reportTelemetryProductIntent({
        kind: 'surface_viewed',
        ...surface,
        entrypoint: consumeSurfaceEntrypoint(),
      });
    }
  }, [enabled, location.pathname]);
  return null;
}

/** A rejected bearer may just be expired, so main decides whether the session
 * is over. Every other 401 — including ones the client synthesizes after a 200,
 * like `session_profile_missing` — is deterministic, and only signing out
 * recovers from it. */
function endSessionFor(
  error: unknown,
  {
    signOut,
    signOutIfCredentialCleared,
    surrenderActiveWorkspace,
  }: Pick<AppSessionValue, 'signOut' | 'signOutIfCredentialCleared' | 'surrenderActiveWorkspace'>,
): void {
  if (!(error instanceof ApiError)) return;
  if (
    error.status === 403
    && (error.code === 'workspace_access_denied' || error.code === 'workspace_access_revoked')
  ) {
    void surrenderActiveWorkspace();
  } else if (error.status === 401) {
    void (isSessionRejection(error) ? signOutIfCredentialCleared() : signOut());
  }
}

export function WorkspaceApp(): React.JSX.Element {
  const { api, session, refreshSession, signOut, signOutIfCredentialCleared, surrenderActiveWorkspace } = useAppSession();
  // Every surface used to hold its whole tree behind this one read — the screen
  // below was `Opening workspace…` until it landed, so a window opened onto
  // Settings had not mounted the settings screen, let alone started any of its
  // own reads, until a round trip had returned what the session already knew.
  // The placeholder ends that: the tree mounts on the session's own copy and
  // this read replaces it in place. `null` when the session cannot fully
  // describe the workspace, which is the old behaviour exactly.
  // One definition of this read, shared with every surface that needs the
  // viewer's own role — see `lib/use-workspace.ts` for why the session's copy
  // is no longer good enough for a gate.
  const workspace = useWorkspaceQuery({ api, session });
  const { guest } = useShellCapabilities();
  // What a guest may do is read from the session, which is only renewed on
  // its own schedule. A promotion or demotion refetches this profile at once,
  // so when the two disagree the session is renewed now and the shell
  // follows, rather than a promoted member waiting out the access token.
  const servedGuest = workspace.data ? workspace.data.currentUser.accessClass === 'guest' : guest;
  useEffect(() => {
    if (servedGuest !== guest) void refreshSession().catch(() => undefined);
  }, [guest, refreshSession, servedGuest]);
  useWorkspaceMembers(api, { enabled: Boolean(session?.workspace), staleTime: Number.POSITIVE_INFINITY });

  useEffect(() => {
    if (workspace.error) abandonPendingWorkstreamFeedOpen();
    endSessionFor(workspace.error, { signOut, signOutIfCredentialCleared, surrenderActiveWorkspace });
  }, [signOut, signOutIfCredentialCleared, surrenderActiveWorkspace, workspace.error]);

  const surface = new URLSearchParams(window.location.search).get('surface');
  const mainSurface = surface !== 'settings';
  // A window that closes on Escape has to do it before its screen exists, too.
  // `Opening workspace…` and the service-setup error are the states a person is
  // most stuck in, and until the profile lands Settings has not mounted the
  // screen that installs the gesture — so the keystroke did
  // nothing in exactly the dead end it exists to leave.
  //
  // It stands down the moment the screen is there. Both installs would answer
  // the same keystroke otherwise, and this one nominates no scope, so it would
  // close Settings over a half-written invitation its own pane guard had just
  // refused. `workspace.data` is the whole condition because it is what decides
  // whether that screen renders at all.
  //
  // No scope of its own: a loading state and an error card hold no typing.
  // The meeting window is left out — a recording in progress is not a dead end,
  // and nobody asked for Escape to end one.
  useEscapeClosesWindow({
    enabled: surface === 'settings' && !workspace.data,
  });
  const scope = `${session!.user.email}:${desktopWorkspaceIdentityKey(session!.workspace!.region, session!.workspace!.id)}`;
  const content = workspace.error
    ? <ServiceSetupState error={workspace.error} onRetry={() => void workspace.refetch()} />
    : workspace.data ? <WorkspaceAppContent workspace={workspace.data} />
      : <LoadingState label="Opening organization…" />;
  return (
    // Named above the socket provider so the directory it seeds and the
    // conversations every feed hook below it seeds belong to this workspace.
    <LocalCacheScopeProvider scope={localCacheScope(session!.user.id, session!.workspace!.region, session!.workspace!.id, guest ? 'guest' : 'member')}>
    <WorkspaceSocketProvider
      key={scope}
      api={api!}
      onAccessRevoked={surrenderActiveWorkspace}
      // The main window publishes its socket to main and Settings consumes
      // it, so a desktop holds one Organization socket rather than one per
      // window.
      relay={surface === 'settings' ? 'consume' : mainSurface ? 'publish' : undefined}
      region={session!.workspace!.region}
      workspaceId={session!.workspace!.id}
    >
      <SidekickMentionProvider>
      {/* The directory connection and profile request start together. Keep this
          tree mounted when the profile arrives so prepared sockets survive. */}
      {/* Commit route changes atomically so a new hash never labels an old feed. */}
      {mainSurface ? <HashRouter useTransitions={false}>
        <AppRouteNavigation />
        <WorkstreamSocketResumeProvider scope={scope}>
          <WorkspaceOnboardingJourney workspace={workspace.error ? null : workspace.data ?? null}>
            {content}
          </WorkspaceOnboardingJourney>
        </WorkstreamSocketResumeProvider>
      </HashRouter> : content}
      </SidekickMentionProvider>
    </WorkspaceSocketProvider>
    </LocalCacheScopeProvider>
  );
}

/** The settings window's route observer, held until the window is on screen. */
function SettingsSurfaceTelemetry(): React.JSX.Element {
  return <TelemetryRouteObserver enabled={useWindowRevealed(true)} />;
}

function WorkspaceAppContent({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api } = useAppSession();
  const { guest } = useShellCapabilities();
  useEffect(() => {
    if (!api || new URLSearchParams(window.location.search).has('surface')) return;
    const controller = new AbortController();
    void restorePoppedOutArtifacts({
      bridge: desktopBridge(),
      getResourceVersions: (id) => api.getResourceVersions(id),
      loadResourceContent: (id, signal, version) => api.getResourcePreviewContent(id, signal, version),
      openSiteArtifact: (id) => api.openArtifact(id),
      signal: controller.signal,
    }).catch(() => undefined);
    return () => controller.abort();
  }, [api, workspace.id]);
  // A popped-out window follows its artifact's new versions whether or not
  // the conversation it came from is on screen. This is the only place that
  // refreshes one on a new version: every version this window hears, from the
  // workspace socket or a conversation's own, is a recorded head
  // (`followResourceHeads`), and only a window main reports behind is
  // refreshed. Aborted with the session rather than per head: a refresh
  // cancelled by the next head would still hold its in-flight key when that
  // head's run looks.
  const resourceHeads = useResourceHeads();
  const headRefreshes = useRef<{ controller: AbortController; inFlight: Set<string> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    headRefreshes.current = { controller, inFlight: new Set() };
    return () => controller.abort();
  }, [api]);
  const refreshWindows = useCallback((resources: RefreshPoppedOutArtifactsInput['resources']) => {
    const session = headRefreshes.current;
    if (!api || !session || resources.length === 0) return;
    void refreshPoppedOutArtifacts({
      bridge: desktopBridge(),
      inFlight: session.inFlight,
      loadResourceContent: (id, signal, version) => api.getResourcePreviewContent(id, signal, version),
      openSiteArtifact: (id) => api.openArtifact(id),
      resources,
      signal: session.controller.signal,
    }).catch(() => {
      // A window stays on its last complete version; the next head retries it.
    });
  }, [api]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('surface')) return;
    refreshWindows(Object.values(resourceHeads).map((head) => ({
      id: head.resourceId,
      currentVersion: head.version,
      title: head.title,
      ...(head.mimeType ? { mimeType: head.mimeType } : {}),
    })));
  }, [refreshWindows, resourceHeads]);
  // Versions are announced once and never replayed, so a window whose
  // conversation is not open misses those written while the socket was away.
  // Each reconnect after the first reads the current version of each open
  // window's artifact, as restoring one at launch does.
  const connectGeneration = useOptionalWorkspaceSocket()?.sidebarConnect?.generation ?? 0;
  useEffect(() => {
    if (!api || connectGeneration <= 1 || new URLSearchParams(window.location.search).has('surface')) return;
    const signal = headRefreshes.current?.controller.signal;
    void (async () => {
      const open = Object.keys(await desktopBridge().getPoppedOutArtifactVersions());
      const current = await Promise.all(open.map(async (id) => {
        const head = (await api.getResourceVersions(id, signal))[0];
        return head ? [{
          id, currentVersion: head.version, title: head.title, ...(head.mimeType ? { mimeType: head.mimeType } : {}),
        }] : [];
      }));
      refreshWindows(current.flat());
    })().catch(() => {
      // A window stays on its last complete version; the next head retries it.
    });
  }, [api, connectGeneration, refreshWindows]);
  const settingsSurface = new URLSearchParams(window.location.search).get('surface') === 'settings';
  if (settingsSurface) {
    return (
      <HashRouter>
        <SettingsSurfaceTelemetry />
        <Routes>
          <Route element={<WorkspaceSettingsScreen standaloneWindow workspace={workspace} />} path="/settings" />
          <Route element={<Navigate replace to="/settings" />} path="*" />
        </Routes>
      </HashRouter>
    );
  }

  return (
    <SpeechPlaybackProvider api={api!}>
      <TelemetryRouteObserver />
        <AppShell workspace={workspace}>
          <Routes>
            <Route element={<LandingScreen />} path="/" />
            {/* Inert: a deep link that changes organization parks here while
                its destination resolves, rather than on the landing route,
                which would open an unrelated screen first. */}
            <Route element={<LoadingState label="Opening…" />} path="/opening" />
            {/* The Channels, Threads, Spaces, Projects, Activity and Artifacts
                surfaces are gone (2026-11 cutover); their stored and linked
                addresses open the Canvases home rather than a dead screen. */}
            {['/channels/*', '/spaces/*', '/workstreams/*', '/projects/*', '/activity', '/artifacts'].map((path) => (
              <Route element={<Navigate replace to="/canvases" />} key={path} path={path} />
            ))}
            <Route element={<CanvasesHomeScreen />} path="/canvases" />
            <Route element={<CanvasScreen />} path="/canvases/:id" />
            <Route element={<AutomationScreen />} path="/automations/:id" />
            <Route element={<SidekicksLibraryRoute />} path="/sidekicks" />
            {/* Creating a Sidekick is a member's. */}
            {guest && <Route element={<Navigate replace to="/sidekicks" />} path="/sidekicks/new" />}
            <Route element={<AutomationScreen />} path="/sidekicks/:id" />
            <Route element={<WorkspaceSettingsScreen workspace={workspace} />} path="/settings" />
            <Route element={<NotFoundScreen />} path="*" />
          </Routes>
        </AppShell>
    </SpeechPlaybackProvider>
  );
}

function WorkspaceOnboardingGate(): React.JSX.Element {
  const {
    activateWorkspace, getOnboardingState, session, signOut, signOutIfCredentialCleared,
    surrenderActiveWorkspace,
  } = useAppSession();
  const [activatingWorkspaceId, setActivatingWorkspaceId] = useState<string | null>(null);
  const [activationError, setActivationError] = useState<Error | null>(null);
  // The stored identity can be refused for good on this very activation, in
  // which case it signs in through the browser like any other; the opening
  // state says so rather than leaving a browser window unexplained.
  const [activationSigningIn, setActivationSigningIn] = useState(false);
  const onboarding = useQuery({
    queryKey: ['workspace-onboarding', session?.user.id],
    queryFn: getOnboardingState,
    enabled: Boolean(session && !session.workspace),
    staleTime: 0,
  });

  useEffect(() => {
    const workspace = onboarding.data?.workspace;
    if (!workspace || activatingWorkspaceId !== null) return;
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'workspace_activation_requested',
      selectedRegion: workspace.region,
      entrypoint: 'workspace_switcher',
      operationId,
    });
    setActivatingWorkspaceId(workspace.id);
    setActivationError(null);
    setActivationSigningIn(false);
    void activateWorkspace(workspace.region, workspace.id, operationId, {
      onSignInRequired: () => setActivationSigningIn(true),
    }).catch((error: unknown) => {
      setActivationSigningIn(false);
      setActivationError(error instanceof Error ? error : new Error('Rally could not open this organization.'));
    });
  }, [activateWorkspace, activatingWorkspaceId, onboarding.data?.workspace]);

  useEffect(() => {
    endSessionFor(onboarding.error, { signOut, signOutIfCredentialCleared, surrenderActiveWorkspace });
  }, [onboarding.error, signOut, signOutIfCredentialCleared, surrenderActiveWorkspace]);

  useEffect(() => {
    if (!onboarding.data) return;
    reportTelemetryScreen(onboarding.data.workspace || onboarding.data.invitations.length > 0
      ? 'onboarding_workspace'
      : 'onboarding_region');
  }, [onboarding.data]);

  if (onboarding.isLoading || (!onboarding.error && !onboarding.data)) {
    return <LoadingState label="Checking your organizations…" />;
  }
  if (onboarding.error) {
    return <ServiceSetupState error={onboarding.error} onRetry={() => void onboarding.refetch()} />;
  }
  if (onboarding.data.identity !== 'connected') {
    // Main answers with a state rather than rejecting so the account menu can
    // keep listing the stored set; on this screen there is no stored set to
    // show, and the state reads as the setup failure it is.
    return (
      <ServiceSetupState
        error={new Error(onboarding.data.identityError ?? 'Rally could not check your organizations.')}
        onRetry={() => void onboarding.refetch()}
      />
    );
  }
  if (onboarding.data.workspace) {
    if (activationError) {
      return (
        <ServiceSetupState
          error={activationError}
          onRetry={() => {
            setActivationError(null);
            setActivatingWorkspaceId(null);
          }}
        />
      );
    }
    return (
      <LoadingState
        label={activationSigningIn ? FINISH_SIGN_IN_IN_BROWSER : `Opening ${onboarding.data.workspace.name}…`}
      />
    );
  }
  if (onboarding.data.invitations.length > 0) {
    return (
      <InvitationOnboarding
        invitations={onboarding.data.invitations}
        onChanged={() => onboarding.refetch()}
      />
    );
  }
  return <RegionOnboarding />;
}

export function SessionGate(): React.JSX.Element {
  const { booting, session } = useAppSession();
  useEffect(() => {
    if (!booting && !session) reportTelemetryScreen('onboarding_welcome');
  }, [booting, session]);
  if (booting) return <BootScreen />;
  if (!session) return <SignInScreen />;
  if (session.workspace) return <WorkspaceApp />;
  return <WorkspaceOnboardingGate />;
}

export default function App(): React.JSX.Element {
  useEffect(() => installRendererErrorTelemetry(), []);
  useWindowActivationTracking();
  useEffect(() => watchSystemAppearance(), []);
  useEffect(() => watchThemeBroadcast(), []);
  return new URLSearchParams(window.location.search).get('surface') === 'artifact-preview'
    ? <ErrorBoundary><ArtifactWindow /></ErrorBoundary> : <Application />;
}
function Application(): React.JSX.Element {
  // Above the session gate rather than beside the other surfaces, and that
  // placement is the point: a refused deep link is most worth showing when
  // there is no session to gate on — an expired one, or a link that arrived
  // while the application was still booting. Everything below this line waits
  // on a session, a workspace, or a socket, and this window needs none of the
  // three to say one sentence.
  if (new URLSearchParams(window.location.search).get('surface') === 'deep-link-error') {
    return (
      <ErrorBoundary>
        <DeepLinkErrorScreen />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <AppSessionProvider>
            <FaviconApiProvider>
              <AccountOnboardingGate><SessionGate /></AccountOnboardingGate>
            </FaviconApiProvider>
          </AppSessionProvider>
        </Tooltip.Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
