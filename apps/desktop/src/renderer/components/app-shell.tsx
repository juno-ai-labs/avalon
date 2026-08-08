import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties, PropsWithChildren } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';
import type { Workspace, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { Sidebar } from './sidebar';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const { api, clearDeepLinkError, deepLinkError, signOut } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railExpanded = useUiStore((state) => state.railExpanded);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const showShellRail = railOpen && !location.pathname.startsWith('/notes/');
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
    refetchInterval: 15_000,
  });
  const notes = useQuery({
    queryKey: ['notes'],
    queryFn: ({ signal }) => api!.getNotes(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const shellStyle = {
    '--rail-width': `${railExpanded ? Math.max(520, railWidth) : railWidth}px`,
    '--sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className={showShellRail ? 'workspace-shell rail-open' : 'workspace-shell'} style={shellStyle}>
      <Sidebar
        automations={automations.data ?? []}
        loading={automations.isLoading || workstreams.isLoading || notes.isLoading}
        notes={notes.data ?? []}
        onMarkWorkstreamUnread={async (workstream) => {
          if (!api) return;
          const updated = await api.markWorkstreamUnread(workstream.id);
          queryClient.setQueryData<WorkstreamSummary[]>(['workstreams'], (current) =>
            current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
          );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', updated.id], (current) =>
            current ? { ...current, ...updated } : current,
          );
          if (location.pathname === `/workstreams/${updated.id}`) void navigate('/workstreams/new');
        }}
        onRenameWorkstream={async (workstream, title) => {
          if (!api) return;
          const updated = await api.renameWorkstream(workstream.id, title);
          queryClient.setQueryData<WorkstreamSummary[]>(['workstreams'], (current) =>
            current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
          );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', updated.id], (current) =>
            current ? { ...current, title: updated.title } : current,
          );
        }}
        onRunAutomation={async (automation) => {
          if (!api) return;
          const workstream = await api.runAutomation(automation.id);
          await queryClient.invalidateQueries({ queryKey: ['workstreams'] });
          void navigate(`/workstreams/${workstream.id}`);
        }}
        onOpenMeetingNotes={() => desktopBridge().openMeetingNotes()}
        onSignOut={() => {
          void signOut().catch(() => undefined);
        }}
        workspace={workspace}
        workstreams={workstreams.data ?? []}
      />
      <main className="main-pane">
        {deepLinkError && (
          <div className="connection-banner" role="alert">
            <span>{deepLinkError}</span>
            <button onClick={clearDeepLinkError} type="button">Dismiss</button>
          </div>
        )}
        {(automations.error || workstreams.error || notes.error) && (
          <div className="connection-banner" role="status">
            <span>
              {automations.error instanceof ApiError && automations.error.status === 0
                ? 'Regional service offline. Existing views may be stale.'
                : 'Some navigation data could not be refreshed.'}
            </span>
            <button onClick={() => void Promise.all([automations.refetch(), workstreams.refetch(), notes.refetch()])} type="button">Retry</button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
