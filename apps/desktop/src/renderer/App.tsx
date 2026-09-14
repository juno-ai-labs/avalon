import type { Region } from "@rally/contracts/regions";
import { AccountOnboardingGate, WorkspaceOnboardingJourney } from './screens/guided-onboarding';
import { SidekicksWindow, SidekicksWindowRedirect } from './screens/sidekicks-library';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cable, RefreshCcw } from 'lucide-react';
import { Component, type ErrorInfo, type PropsWithChildren, useEffect, useMemo, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { logError } from '../common/logger';
import { desktopWorkspaceIdentityKey } from '../common/desktop';
import { AppShell } from './components/app-shell';
import { WorkstreamLandingScreen } from './screens/workstream-landing';
import { useOpenFirstWorkstream } from './lib/workstream-landing';
import { Button, EmptyState, LoadingState } from './components/primitives';
import { SpeechPlaybackProvider } from './components/speech-playback';
import { ApiError, isSessionRejection } from './lib/api';
import { AppSessionProvider, useAppSession, type AppSessionValue, FINISH_SIGN_IN_IN_BROWSER } from './lib/app-session';
import { desktopBridge } from './lib/platform';
import { workspaceFromSession } from './lib/session-workspace';
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
import { useWindowActivationTracking } from './lib/window-activation';
import { useEscapeClosesWindow } from './lib/window-escape';
import { WorkstreamSocketResumeProvider } from './lib/workstream-socket-resume';
import { localCacheScope } from './lib/local-cache';
import { LocalCacheScopeProvider } from './lib/local-cache-scope';
import { WorkspaceSocketProvider } from './lib/workspace-socket';
import { WorkspaceWorkstreamSockets } from './lib/workspace-workstream-sockets';
import type { Workspace } from './lib/types';
import { AutomationScreen } from './screens/automation';
import { DeepLinkErrorScreen } from './screens/deep-link-error';
import { MeetingNotesScreen } from './screens/meeting-notes';
import { NoteDetailScreen } from './screens/note-detail';
import { NewWorkstreamScreen } from './screens/new-workstream';
import { ProjectSpaceScreen } from './screens/project-space';
import { BootScreen, InvitationOnboarding, RegionOnboarding, SignInScreen } from './screens/onboarding';
import { WorkstreamScreen } from './screens/workstream';
import { WorkspaceSettingsScreen } from './screens/workspace-settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (attempt, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && attempt < 2,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

class ErrorBoundary extends Component<PropsWithChildren, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError('rally', 'renderer error boundary caught an error', error, info.componentStack);
    reportJavascriptError(error, 'react_boundary');
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-error-screen window-drag">
          <section className="fatal-error-card window-no-drag">
            <AlertTriangle aria-hidden="true" size={22} />
            <h1>Rally needs to reopen this view</h1>
            <p>{this.state.error.message}</p>
            <Button className="button-primary" onClick={() => window.location.reload()}>Reload Rally</Button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
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
        <h1>{isNetwork ? 'Rally cannot reach this region' : 'The regional service is not ready'}</h1>
        <p>{error.message}</p>
        <dl>
          <div><dt>Region</dt><dd>{displayRegion}</dd></div>
          <div><dt>API endpoint</dt><dd className="mono">{targetApiBaseUrl ?? api?.baseUrl}</dd></div>
        </dl>
        <div className="setup-guidance">
          <strong>Local development</strong>
          <p>Start the Cloudflare API for this region and confirm the safe <code>VITE_API_GLOBAL_URL</code> value in <code>.env.local</code>. Server API keys must not use a <code>VITE_</code> prefix.</p>
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
        action={<Button onClick={() => openFirstWorkstream()}>Go to your work streams</Button>}
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

function WorkspaceApp(): React.JSX.Element {
  const { api, session, signOut, signOutIfCredentialCleared, surrenderActiveWorkspace } = useAppSession();
  // Every surface used to hold its whole tree behind this one read — the screen
  // below was `Opening workspace…` until it landed, so a window opened onto
  // Settings had not mounted the settings screen, let alone started any of its
  // own reads, until a round trip had returned what the session already knew.
  // The placeholder ends that: the tree mounts on the session's own copy and
  // this read replaces it in place. `null` when the session cannot fully
  // describe the workspace, which is the old behaviour exactly.
  const placeholderWorkspace = useMemo(() => workspaceFromSession(session) ?? undefined, [session]);
  const workspace = useQuery({
    queryKey: ['workspace', session?.workspace?.id, session?.user.id],
    queryFn: ({ signal }) => api!.getWorkspace(signal),
    enabled: Boolean(api && session),
    staleTime: 30_000,
    placeholderData: placeholderWorkspace,
  });
  useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api && session?.workspace),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (workspace.error) abandonPendingWorkstreamFeedOpen();
    endSessionFor(workspace.error, { signOut, signOutIfCredentialCleared, surrenderActiveWorkspace });
  }, [signOut, signOutIfCredentialCleared, surrenderActiveWorkspace, workspace.error]);

  const surface = new URLSearchParams(window.location.search).get('surface');
  const mainSurface = surface !== 'settings' && surface !== 'sidekicks' && surface !== 'meeting';
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
  const content = workspace.error
    ? <ServiceSetupState error={workspace.error} onRetry={() => void workspace.refetch()} />
    : workspace.data ? <WorkspaceAppContent workspace={workspace.data} />
      : <LoadingState label="Opening workspace…" />;
  return (
    // Named above the socket provider so the directory it seeds and the
    // conversations every feed hook below it seeds belong to this workspace.
    <LocalCacheScopeProvider scope={localCacheScope(session!.user.id, session!.workspace!.region, session!.workspace!.id)}>
    <WorkspaceSocketProvider key={scope} api={api!} onAccessRevoked={surrenderActiveWorkspace} workspaceId={session!.workspace!.id}>
      {/* The directory connection and profile request start together. Keep this
          tree mounted when the profile arrives so prepared sockets survive. */}
      {/* Commit route changes atomically so a new hash never labels an old feed. */}
      {mainSurface ? <HashRouter useTransitions={false}>
        <WorkstreamSocketResumeProvider scope={scope}>
          <WorkspaceOnboardingJourney workspace={workspace.error ? null : workspace.data ?? null}>
            <WorkspaceWorkstreamSockets api={workspace.error ? null : api}>
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

  const meetingSurface = new URLSearchParams(window.location.search).get('surface') === 'meeting';
  if (meetingSurface) {
    return (
      <HashRouter>
        <TelemetryRouteObserver />
        <Routes>
          <Route element={<MeetingNotesScreen />} path="/meeting" />
          <Route element={<Navigate replace to="/meeting" />} path="*" />
        </Routes>
      </HashRouter>
    );
  }

  return (
    <SpeechPlaybackProvider api={api!}>
      <TelemetryRouteObserver />
        <AppShell workspace={workspace}>
          <Routes>
            <Route element={<WorkstreamLandingScreen />} path="/" />
            <Route element={<NewWorkstreamScreen workspace={workspace} />} path="/workstreams/new" />
            <Route element={<ProjectSpaceScreen />} path="/projects/:projectId" />
            <Route element={<NewWorkstreamScreen workspace={workspace} projectId="route" />} path="/projects/:projectId/workstreams/new" />
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
            <Route element={<NoteDetailScreen />} path="/notes/:id" />
            <Route element={<AutomationScreen />} path="/automations/:id" />
            <Route element={<SidekicksWindowRedirect />} path="/sidekicks" />
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
      setActivationError(error instanceof Error ? error : new Error('Rally could not open this workspace.'));
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
    return <LoadingState label="Checking your workspaces…" />;
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
        error={new Error(onboarding.data.identityError ?? 'Rally could not check your workspaces.')}
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
  // Above the deep-link branch below, so every window this renderer draws —
  // including the ones that return before the providers — can tell an app
  // switch from a person. See `lib/window-activation.ts`.
  useWindowActivationTracking();
  // Only a `system` choice follows the Mac; the watcher decides that for itself
  // so that a later change of choice does not need to re-subscribe.
  useEffect(() => watchSystemAppearance(), []);
  useEffect(() => watchThemeBroadcast(), []);
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
            <AccountOnboardingGate><SessionGate /></AccountOnboardingGate>
          </AppSessionProvider>
        </Tooltip.Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
