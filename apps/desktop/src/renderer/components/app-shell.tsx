import { useQuery } from '@tanstack/react-query';
import type { CSSProperties, PropsWithChildren } from 'react';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { useUiStore } from '../lib/ui-store';
import type { Workspace } from '../lib/types';
import { Sidebar } from './sidebar';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const { api, signOut } = useAppSession();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railExpanded = useUiStore((state) => state.railExpanded);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const automations = useQuery({
    queryKey: ['automations'],
    queryFn: ({ signal }) => api!.getAutomations(signal),
    enabled: Boolean(api),
    staleTime: 20_000,
  });
  const workstreams = useQuery({
    queryKey: ['workstreams'],
    queryFn: ({ signal }) => api!.getWorkstreams(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
  });

  const shellStyle = {
    '--rail-width': `${railExpanded ? Math.max(520, railWidth) : railWidth}px`,
    '--sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className={railOpen ? 'workspace-shell rail-open' : 'workspace-shell'} style={shellStyle}>
      <Sidebar
        automations={automations.data ?? []}
        loading={automations.isLoading || workstreams.isLoading}
        onSignOut={() => {
          void signOut().catch(() => undefined);
        }}
        workspace={workspace}
        workstreams={workstreams.data ?? []}
      />
      <main className="main-pane">
        {(automations.error || workstreams.error) && (
          <div className="connection-banner" role="status">
            <span>
              {automations.error instanceof ApiError && automations.error.status === 0
                ? 'Regional service offline. Existing views may be stale.'
                : 'Some navigation data could not be refreshed.'}
            </span>
            <button onClick={() => void Promise.all([automations.refetch(), workstreams.refetch()])} type="button">Retry</button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
