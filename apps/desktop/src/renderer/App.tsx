import { AccountOnboardingGate, WorkspaceOnboardingJourney } from './screens/guided-onboarding';
import { SidekicksLibraryScreen, SidekicksWindowRedirect } from './screens/sidekicks-library';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cable, RefreshCcw } from 'lucide-react';
import { Component, type ErrorInfo, type PropsWithChildren, useEffect, useRef, useState } from 'react';
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
import { WorkstreamSocketResumeProvider } from './lib/workstream-socket-resume';
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
  targetRegion?: 'global' | 'eu';
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
          <div><dt>Region</dt><dd>{displayRegion === 'eu' ? 'European Union' : 'United States'}</dd></div>
          <div><dt>API endpoint</dt><dd className="mono">{targetApiBaseUrl ?? api?.baseUrl}</dd></div>
        </dl>
        <div className="setup-guidance">
          <strong>Local development</strong>
          <p>Start the Cloudflare API for this region and confirm the safe <code>VITE_API_{displayRegion === 'eu' ? 'EU' : 'GLOBAL'}_URL</code> value in <code>.env.local</code>. Server API keys must not use a <code>VITE_</code> prefix.</p>
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

function TelemetryRouteObserver(): null {
  const location = useLocation();
  const lastScreen = useRef<ReturnType<typeof telemetryScreenForPath>>(null);
  const lastSurfacePath = useRef<string | null>(null);
  useEffect(() => {
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
  }, [location.pathname]);
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
  const workspace = useQuery({
    queryKey: ['workspace', session?.workspace?.id, session?.user.id],
    queryFn: ({ signal }) => api!.getWorkspace(signal),
    enabled: Boolean(api && session),
    staleTime: 30_000,
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
  const scope = `${session!.user.email}:${desktopWorkspaceIdentityKey(session!.workspace!.region, session!.workspace!.id)}`;
  const content = workspace.error
    ? <ServiceSetupState error={workspace.error} onRetry={() => void workspace.refetch()} />
    : workspace.data ? <WorkspaceAppContent workspace={workspace.data} />
      : <LoadingState label="Opening workspace…" />;
  return (
    <WorkspaceSocketProvider key={scope} api={api!} onAccessRevoked={surrenderActiveWorkspace} workspaceId={session!.workspace!.id}>
      {/* The directory connection and profile request start together. Keep this
          tree mounted when the profile arrives so prepared sockets survive. */}
      {/* Commit route changes atomically so a new hash never labels an old feed. */}
      {mainSurface ? <HashRouter useTransitions={false}>
        <WorkstreamSocketResumeProvider scope={scope}>
          <WorkspaceWorkstreamSockets api={workspace.error ? null : api}>
            {content}
          </WorkspaceWorkstreamSockets>
        </WorkstreamSocketResumeProvider>
      </HashRouter> : content}
    </WorkspaceSocketProvider>
  );
}

function WorkspaceAppContent({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api } = useAppSession();
  const settingsSurface = new URLSearchParams(window.location.search).get('surface') === 'settings';
  if (settingsSurface) {
    return (
      <HashRouter>
        <TelemetryRouteObserver />
        <Routes>
          <Route element={<WorkspaceSettingsScreen standaloneWindow workspace={workspace} />} path="/settings" />
          <Route element={<Navigate replace to="/settings" />} path="*" />
        </Routes>
      </HashRouter>
    );
  }

  if (new URLSearchParams(window.location.search).get('surface') === 'sidekicks') {
    return (
      <SpeechPlaybackProvider api={api!}>
        <HashRouter useTransitions={false}>
          <Routes>
            <Route element={<SidekicksLibraryScreen />} path="/sidekicks" />
            <Route element={<AutomationScreen />} path="/sidekicks/:id" />
            <Route element={<AutomationScreen />} path="/automations/:id" />
            <Route element={<Navigate replace to="/sidekicks" />} path="*" />
          </Routes>
        </HashRouter>
      </SpeechPlaybackProvider>
    );
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
      <WorkspaceOnboardingJourney key={`${workspace.region}:${workspace.id}:${workspace.currentUser.id}`} workspace={workspace}>
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
      </WorkspaceOnboardingJourney>
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
