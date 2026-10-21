import { AppRouteNavigation } from './lib/app-navigation';
import { ArtifactWindow } from './screens/artifact-window';
import { AppErrorBoundary } from "@rally/ui/components/app-error-boundary";
import { createQueryClient } from "./lib/query-client";
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Region } from "@rally/contracts/regions";
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Cable, RefreshCcw } from 'lucide-react';
import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { desktopWorkspaceIdentityKey } from '../common/desktop';
import { logError } from '../common/logger';
import { AppShell } from './components/app-shell';
import { Button, EmptyState, LoadingState } from './components/primitives';
import { SpeechPlaybackProvider } from './components/speech-playback';
import { ApiError, isSessionRejection } from './lib/api';
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
import { WorkspaceWorkstreamSockets } from './lib/workspace-workstream-sockets';
import { BrowserImportProgress } from './lib/browser-import-progress';
import { useOpenFirstWorkstream } from './lib/workstream-landing';
import { WorkstreamSocketResumeProvider } from './lib/workstream-socket-resume';
import { AutomationScreen } from './screens/automation';
import { DeepLinkErrorScreen } from './screens/deep-link-error';
import { AccountOnboardingGate, WorkspaceOnboardingJourney } from './screens/guided-onboarding';
import { ErrorNotice } from './components/primitives';
import { BootScreen, InvitationOnboarding, RegionOnboarding, SignInScreen } from './screens/onboarding';
import { ChannelScreen } from './screens/channel';
import { channelRoute, homeChannelId, openThreadResourceState, threadRoute } from './lib/navigation-routes';
import { useCachedWorkstreamSummary } from './lib/use-workstreams-query';
import { SidekicksLibraryRoute, SidekicksWindow } from './screens/sidekicks-library';
import { BrowserImportWindow } from './screens/browser-import';
import { WorkspaceSettingsScreen } from './screens/workspace-settings';
import { WorkstreamScreen } from './screens/workstream';
import { WorkstreamLandingScreen } from './screens/workstream-landing';

const queryClient = createQueryClient();

function ErrorBoundary({ children }: PropsWithChildren): React.JSX.Element {
  return <AppErrorBoundary onError={(error, info) => {
    logError('rally', 'renderer error boundary caught an error', error, info.componentStack);
    reportJavascriptError(error, 'react_boundary');
  }}>{children}</AppErrorBoundary>;
}

function ServiceSetupState({
  error,
  onRetry,
  targetApiBaseUrl,
  targetRegion,
}: {
  error: Error;
  onRetry: () => void;
  targetApiBaseUrl?: string;
  targetRegion?: Region;
}): React.JSX.Element {
  const { api, region, signOut } = useAppSession();
  const displayRegion = targetRegion ?? region;
  const isNetwork = error instanceof ApiError && error.status === 0;
  return (
    <main className="service-setup-screen window-drag">
      <section className="service-setup-card window-no-drag">
        <span className="setup-icon"><Cable size={22} /></span>
        <p className="eyebrow">{isNetwork ? 'Service unavailable' : 'Setup required'}</p>
        <ErrorNotice title={isNetwork ? 'Rally cannot reach this region' : 'The regional service is not ready'}>{error.message}</ErrorNotice>
        <dl>
          <div><dt>Region</dt><dd>{displayRegion}</dd></div>
          <div><dt>API endpoint</dt><dd className="mono">{targetApiBaseUrl ?? api?.baseUrl}</dd></div>
        </dl>
        <div className="setup-guidance">
          <strong>Local development</strong>
          <p>Start the Cloudflare API for this region and confirm this deployment’s API URL in <code>.env.local</code>. Server API keys must not use a <code>VITE_</code> prefix.</p>
        </div>
        <div className="setup-actions">
          <Button onClick={() => void signOut()}>Return to sign in</Button>
          <Button className="button-primary" onClick={onRetry}><RefreshCcw size={14} /> Retry connection</Button>
        </div>
      </section>
    </main>
  );
}

function NotFoundScreen(): React.JSX.Element {
  // Through the hook rather than the hash, so the entry is replaced and Back
  // does not return to the route that had nothing to show.
  const openFirstWorkstream = useOpenFirstWorkstream();
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <EmptyState
        action={<Button onClick={() => openFirstWorkstream()}>Go to your threads</Button>}
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
  useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api && session?.workspace && !guest),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (workspace.error) abandonPendingWorkstreamFeedOpen();
    endSessionFor(workspace.error, { signOut, signOutIfCredentialCleared, surrenderActiveWorkspace });
  }, [signOut, signOutIfCredentialCleared, surrenderActiveWorkspace, workspace.error]);

  const surface = new URLSearchParams(window.location.search).get('surface');
  const mainSurface = surface !== 'settings' && surface !== 'sidekicks' && surface !== 'browser-import';
  // A window that closes on Escape has to do it before its screen exists, too.
  // `Opening workspace…` and the service-setup error are the states a person is
  // most stuck in, and until the profile lands neither Settings nor Sidekicks
  // has mounted the screen that installs the gesture — so the keystroke did
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
    enabled: (surface === 'sidekicks' || surface === 'settings') && !workspace.data,
  });
  const scope = `${session!.user.email}:${desktopWorkspaceIdentityKey(session!.workspace!.region, session!.workspace!.id)}`;
  // The import window needs the session's API and nothing from the profile
  // read, so its browser opens without waiting on that round trip.
  const content = surface === 'browser-import' ? <BrowserImportWindow />
    : workspace.error
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
      // The main window publishes its socket to main and Settings and
      // Sidekicks consume it, so a desktop holds one Organization socket
      // rather than one per window.
      relay={surface === 'settings' || surface === 'sidekicks' ? 'consume' : mainSurface ? 'publish' : undefined}
      region={session!.workspace!.region}
      workspaceId={session!.workspace!.id}
    >
      {/* The directory connection and profile request start together. Keep this
          tree mounted when the profile arrives so prepared sockets survive. */}
      {/* Commit route changes atomically so a new hash never labels an old feed. */}
      {mainSurface ? <HashRouter useTransitions={false}>
        <AppRouteNavigation />
        <WorkstreamSocketResumeProvider scope={scope}>
          <WorkspaceOnboardingJourney workspace={workspace.error ? null : workspace.data ?? null}>
            <WorkspaceWorkstreamSockets api={workspace.error ? null : api}>
              <BrowserImportProgress />
              {content}
            </WorkspaceWorkstreamSockets>
          </WorkspaceOnboardingJourney>
        </WorkstreamSocketResumeProvider>
      </HashRouter> : content}
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

  if (new URLSearchParams(window.location.search).get('surface') === 'sidekicks') {
    return <SidekicksWindow />;
  }


  return (
    <SpeechPlaybackProvider api={api!}>
      <TelemetryRouteObserver />
        <AppShell workspace={workspace}>
          <Routes>
            <Route element={<WorkstreamLandingScreen />} path="/" />
            {/* Inert: a deep link that changes organization parks here while
                its destination resolves, rather than on the landing route,
                which would open an unrelated conversation first. */}
            <Route element={<LoadingState label="Opening…" />} path="/opening" />
            {/* A Channel and a thread open beside it: the first two panes of
                the stack (`docs/pane-stack.md`). A stored Space is a Channel. */}
            {/* One route for both, so the Channel pane stays mounted as a
                thread opens and closes beside it. */}
            <Route element={<ChannelScreen workspace={workspace} />} path="/channels/:channelId/*" />
            {/* A Space's old addresses open the Channel it now is. */}
            <Route element={<SpaceRedirect />} path="/spaces/:spaceId/*" />
            {/* Projects are gone and their ids mean nothing here; the landing
                route picks whatever this person should be looking at instead of
                a dead screen naming an object that no longer exists. */}
            <Route element={<Navigate replace to="/" />} path="/projects/*" />
            {/* The Space-less launcher is gone: every Channel is started from a
                Space. Without this, a stale link would open as a Channel whose
                id is "new". */}
            <Route element={<Navigate replace to="/" />} path="/workstreams/new" />
            <Route element={<LoneThreadRoute />} path="/workstreams/:id" />
            <Route element={<AutomationScreen />} path="/automations/:id" />
            <Route element={<SidekicksLibraryRoute />} path="/sidekicks" />
            {/* Creating a Sidekick is a member's, as in the Sidekicks window. */}
            {guest && <Route element={<Navigate replace to="/sidekicks" />} path="/sidekicks/new" />}
            <Route element={<AutomationScreen />} path="/sidekicks/:id" />
            <Route element={<WorkspaceSettingsScreen workspace={workspace} />} path="/settings" />
            <Route element={<NotFoundScreen />} path="*" />
          </Routes>
        </AppShell>
    </SpeechPlaybackProvider>
  );
}

/**
 * A thread addressed on its own (search, the menu bar, a deep link): opened
 * under a Channel it sits in when this device knows one, so the Channel is one
 * step back; on its own otherwise. The query string (a breakout, a search
 * target) travels with it.
 */
function LoneThreadRoute(): React.JSX.Element {
  const { id = '' } = useParams();
  const location = useLocation();
  const row = useCachedWorkstreamSummary(id);
  const channelId = row && !row.pending ? homeChannelId(row.spaceIds) : null;
  // A link onto an artifact (a pinned artifact's push) arrives as `?artifact=`,
  // because a deep link sets only the hash; it becomes the same request the
  // sidebar's artifact row makes, so the thread opens with it expanded.
  const search = new URLSearchParams(location.search);
  const artifactId = search.get('artifact');
  search.delete('artifact');
  const state = artifactId ? openThreadResourceState(id, artifactId) : location.state;
  const rest = search.size ? `?${search}` : '';
  if (channelId) return <Navigate replace state={state} to={`${threadRoute(id, channelId)}${rest}`} />;
  if (artifactId) return <Navigate replace state={state} to={`/workstreams/${id}${rest}`} />;
  return <WorkstreamScreen />;
}

/** A Space's old address: the Channel it is now. */
function SpaceRedirect(): React.JSX.Element {
  const { spaceId = '' } = useParams();
  return <Navigate replace to={channelRoute(spaceId)} />;
}

function WorkspaceOnboardingGate(): React.JSX.Element {
  const {
    activateWorkspace, getOnboardingState, runtime, session, signOut, signOutIfCredentialCleared,
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
          targetApiBaseUrl={runtime?.api[onboarding.data.workspace!.region]}
          targetRegion={onboarding.data.workspace.region}
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
