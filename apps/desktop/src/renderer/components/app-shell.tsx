import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type CSSProperties, type PropsWithChildren } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { useUiStore } from '../lib/ui-store';
import type { NoteDetail, NoteSummary, Workspace, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { Sidebar } from './sidebar';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

export function openWorkstreamId(pathname: string): string | null {
  const id = /^\/workstreams\/([^/]+)$/.exec(pathname)?.[1];
  if (id === undefined || id === 'new') return null;
  try {
    return decodeURIComponent(id);
  } catch {
    // This runs during the shell's render, where a throw takes the whole window
    // to the error boundary rather than just the route — and the segment is
    // reachable by hand-edited hash or deep link, so `/workstreams/%` must not
    // be able to do that. Falling back to the raw segment is also what React
    // Router does when it decodes a param, which keeps the id this returns
    // equal to the one the screen keys its detail query by.
    return id;
  }
}

/**
 * Which work stream the list poll has caught holding a stale harness status, if
 * any. The poll is the backstop for every work stream this client has no room
 * socket to; it must not become a second opinion about the one it does. A
 * pushed status writes the detail and the list together, so when the two
 * disagree the side written longer ago is the stale one — and that is normally
 * the detail, which nothing refreshes on a timer, leaving the header pulsing
 * "Running" under a sidebar dot that has already gone yellow. Re-reading the
 * detail rather than patching the status in place keeps its run metadata, which
 * the elapsed-time display reads, agreeing with the status beside it.
 */
export function staleHarnessStatusWorkstreamId(
  activeWorkstreamId: string | null,
  summaries: WorkstreamSummary[] | undefined,
  summariesUpdatedAt: number,
  detail: { data?: WorkstreamDetail; dataUpdatedAt: number } | undefined,
): string | null {
  if (activeWorkstreamId === null || !summaries || !detail?.data) return null;
  const summary = summaries.find((item) => item.id === activeWorkstreamId);
  if (!summary || summary.harnessStatus === detail.data.harnessStatus) return null;
  return detail.dataUpdatedAt <= summariesUpdatedAt ? activeWorkstreamId : null;
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const { api, clearDeepLinkError, deepLinkError, signOut } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railExpanded = useUiStore((state) => state.railExpanded);
  const hypersightOpen = useUiStore((state) => state.hypersightOpen);
  const hypersightWidth = useUiStore((state) => state.hypersightWidth);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  // HyperSight and the inspector rail are the same slot, so the main pane makes
  // room for whichever one holds it.
  const showShellRail = (railOpen || hypersightOpen) && !location.pathname.startsWith('/notes/');
  const automations = useQuery({
    queryKey: ['automations'],
    queryFn: ({ signal }) => api!.getAutomations(signal),
    enabled: Boolean(api),
    staleTime: 20_000,
  });
  // Debugging widens the sidebar to include system work streams — a digest
  // run's transcript and anything like it. The flag is part of the query key so
  // toggling the preference refetches rather than serving the narrower list.
  const debugEnabled = useDebugEnabled();
  const workstreams = useQuery({
    queryKey: ['workstreams', debugEnabled],
    queryFn: ({ signal }) => api!.getWorkstreams(signal, debugEnabled),
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

  const activeWorkstreamId = openWorkstreamId(location.pathname);
  useEffect(() => {
    const staleId = staleHarnessStatusWorkstreamId(
      activeWorkstreamId,
      workstreams.data,
      workstreams.dataUpdatedAt,
      activeWorkstreamId === null
        ? undefined
        : queryClient.getQueryState<WorkstreamDetail>(['workstream', activeWorkstreamId]),
    );
    if (staleId === null) return;
    void queryClient.invalidateQueries({ queryKey: ['workstream', staleId], exact: true });
  }, [activeWorkstreamId, queryClient, workstreams.data, workstreams.dataUpdatedAt]);

  const shellStyle = {
    '--rail-width': `${hypersightOpen ? hypersightWidth : railExpanded ? Math.max(520, railWidth) : railWidth}px`,
    '--sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className={showShellRail ? 'workspace-shell rail-open' : 'workspace-shell'} style={shellStyle}>
      <Sidebar
        automations={automations.data ?? []}
        loading={automations.isLoading || workstreams.isLoading || notes.isLoading}
        notes={notes.data ?? []}
        onArchiveDraftAutomation={async (automation) => {
          if (!api) return;
          await api.archiveDraftAutomation(automation.id);
          await queryClient.invalidateQueries({ queryKey: ['automations'] });
          if (location.pathname === `/automations/${automation.id}`) void navigate('/workstreams/new');
        }}
        onArchiveNote={async (note) => {
          if (!api) return;
          await api.archiveNote(note.id);
          // An archived note's resource stops being served everywhere, not just
          // in the note queries: an open work stream it was attached to holds it
          // in a cache that nothing else invalidates, and archiving emits no
          // socket event to shake it loose.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['notes'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream-context'] }),
            queryClient.invalidateQueries({ queryKey: ['resources'] }),
          ]);
          queryClient.removeQueries({ queryKey: ['note', note.id] });
          // The archived note's own screen would keep polling a note the API no
          // longer serves, so leave it the way a deleted automation does.
          if (location.pathname === `/notes/${note.id}`) void navigate('/workstreams/new');
        }}
        onChangeNoteScope={async (note, scope) => {
          if (!api) return;
          const updated = await api.updateNote(note.id, { scope });
          // The server bumps last_activity_at on any note write, and that is the
          // sidebar's sort key. Patching the scope alone would leave the row in
          // its old position until the next refetch moved it for no visible
          // reason, so the timestamps travel with it.
          queryClient.setQueryData<NoteSummary[]>(['notes'], (current) =>
            current?.map((item) => item.id === updated.id ? {
              ...item,
              scope: updated.scope,
              lastActivityAt: updated.lastActivityAt,
              updatedAt: updated.updatedAt,
            } : item),
          );
          queryClient.setQueryData<NoteDetail>(['note', updated.id], (current) =>
            current ? {
              ...current,
              scope: updated.scope,
              lastActivityAt: updated.lastActivityAt,
              updatedAt: updated.updatedAt,
            } : current,
          );
        }}
        onDeleteAutomation={async (automation) => {
          if (!api) return;
          await api.deleteAutomation(automation.id);
          // Deleting closes any run that was opened ahead of its planned time,
          // so the work-stream list is stale too, not just the automation list.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['automations'] }),
            queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
          ]);
          if (location.pathname === `/automations/${automation.id}`) void navigate('/workstreams/new');
        }}
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
