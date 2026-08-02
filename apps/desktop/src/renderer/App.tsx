import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cable, RefreshCcw } from 'lucide-react';
import { Component, type ErrorInfo, type PropsWithChildren, useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { Button, EmptyState, LoadingState } from './components/primitives';
import { ApiError } from './lib/api';
import { AppSessionProvider, useAppSession } from './lib/app-session';
import { AutomationOverviewScreen } from './screens/automation-overview';
import { NewAutomationScreen } from './screens/new-automation';
import { NewWorkstreamScreen } from './screens/new-workstream';
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
    console.error('Avalon renderer error', error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-error-screen window-drag">
          <section className="fatal-error-card window-no-drag">
            <AlertTriangle aria-hidden="true" size={22} />
            <h1>Avalon needs to reopen this view</h1>
            <p>{this.state.error.message}</p>
            <Button className="button-primary" onClick={() => window.location.reload()}>Reload Avalon</Button>
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
        <h1>{isNetwork ? 'Avalon cannot reach this region' : 'The regional service is not ready'}</h1>
        <p>{error.message}</p>
        <dl>
          <div><dt>Region</dt><dd>{displayRegion === 'eu' ? 'European Union' : 'Global'}</dd></div>
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
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <EmptyState
        action={<Button onClick={() => { window.location.hash = '#/workstreams/new'; }}>Go to new work stream</Button>}
        description="This Avalon view does not exist or is no longer available."
        title="Nothing here"
      />
    </div>
  );
}

function WorkspaceApp(): React.JSX.Element {
  const { api, session, signOut } = useAppSession();
  const workspace = useQuery({
    queryKey: ['workspace', session?.workspace?.id, session?.user.id],
    queryFn: ({ signal }) => api!.getWorkspace(signal),
    enabled: Boolean(api && session),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (workspace.error instanceof ApiError && workspace.error.status === 401) void signOut();
  }, [signOut, workspace.error]);

  if (workspace.isLoading || !workspace.error && !workspace.data) return <LoadingState label="Opening workspace…" />;
  if (workspace.error) return <ServiceSetupState error={workspace.error} onRetry={() => void workspace.refetch()} />;
  if (!workspace.data) return <LoadingState label="Opening workspace…" />;

  const settingsSurface = new URLSearchParams(window.location.search).get('surface') === 'settings';
  if (settingsSurface) {
    return (
      <HashRouter>
        <Routes>
          <Route element={<WorkspaceSettingsScreen workspace={workspace.data} />} path="/settings" />
          <Route element={<Navigate replace to="/settings" />} path="*" />
        </Routes>
      </HashRouter>
    );
  }

  return (
    <HashRouter>
      <AppShell workspace={workspace.data}>
        <Routes>
          <Route element={<Navigate replace to="/workstreams/new" />} path="/" />
          <Route element={<NewWorkstreamScreen workspace={workspace.data} />} path="/workstreams/new" />
          <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          <Route element={<NewAutomationScreen />} path="/automations/new" />
          <Route element={<AutomationOverviewScreen />} path="/automations/:id" />
          <Route element={<WorkspaceSettingsScreen workspace={workspace.data} />} path="/settings" />
          <Route element={<NotFoundScreen />} path="*" />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}

function WorkspaceOnboardingGate(): React.JSX.Element {
  const { activateWorkspace, getOnboardingState, runtime, session, signOut } = useAppSession();
  const [activatingWorkspaceId, setActivatingWorkspaceId] = useState<string | null>(null);
  const [activationError, setActivationError] = useState<Error | null>(null);
  const onboarding = useQuery({
    queryKey: ['workspace-onboarding', session?.user.id],
    queryFn: getOnboardingState,
    enabled: Boolean(session && !session.workspace),
    staleTime: 0,
  });

  useEffect(() => {
    const workspace = onboarding.data?.workspace;
    if (!workspace || activatingWorkspaceId !== null) return;
    setActivatingWorkspaceId(workspace.id);
    setActivationError(null);
    void activateWorkspace(workspace.region, workspace.id).catch((error: unknown) => {
      setActivationError(error instanceof Error ? error : new Error('Avalon could not open this organization.'));
    });
  }, [activateWorkspace, activatingWorkspaceId, onboarding.data?.workspace]);

  useEffect(() => {
    if (onboarding.error instanceof ApiError && onboarding.error.status === 401) void signOut();
  }, [onboarding.error, signOut]);

  if (onboarding.isLoading || (!onboarding.error && !onboarding.data)) {
    return <LoadingState label="Checking your organizations…" />;
  }
  if (onboarding.error) {
    return <ServiceSetupState error={onboarding.error} onRetry={() => void onboarding.refetch()} />;
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
    return <LoadingState label={`Opening ${onboarding.data.workspace.name}…`} />;
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
  if (booting) return <BootScreen />;
  if (!session) return <SignInScreen />;
  if (session.workspace) return <WorkspaceApp />;
  return <WorkspaceOnboardingGate />;
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <AppSessionProvider>
            <SessionGate />
          </AppSessionProvider>
        </Tooltip.Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
