import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type CSSProperties, type PropsWithChildren } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import type { NoteDetail, NoteSummary, Workspace, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { Sidebar } from './sidebar';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

/**
 * Whether the screen at this route is showing the named automation, and would
 * therefore be stranded once it stops being served.
 *
 * There are two such screens, not one. An automation that runs is read on its
 * overview; a draft is read in the builder, which the sidebar reaches through a
 * query rather than a path. Missing the second leaves the builder on a
 * conversation the API will not serve again — and with a Create button that
 * would insert a second automation instead of promoting this one.
 */
export function showsAutomation(pathname: string, search: string, automationId: string): boolean {
  if (pathname === `/automations/${automationId}`) return true;
  return pathname === '/automations/new' && new URLSearchParams(search).get('draft') === automationId;
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

/**
 * Apply a pin response — the caller's whole pinned list, in order — to the
 * cached work-stream list.
 *
 * Every row is rewritten, not just the ones named: the response *is* the pinned
 * set, so a work stream absent from it is one this person no longer has pinned,
 * whichever window unpinned it. Patching only the named rows would leave a pin
 * removed on another device sitting in this sidebar until the next poll, in a
 * position the server has already given to something else.
 */
export function applyPinnedWorkstreams(
  queryClient: ReturnType<typeof useQueryClient>,
  pinned: WorkstreamSummary[],
): void {
  const positions = new Map(pinned.map((workstream) => [workstream.id, workstream.pinPosition]));
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
    current?.map((item) => {
      const pinPosition = positions.get(item.id) ?? null;
      return item.pinPosition === pinPosition ? item : { ...item, pinPosition };
    }),
  );
}

/**
 * Apply a pin response only if a later one has not been issued behind it.
 *
 * The three pin mutations all rewrite the same list, and their responses can
 * come back out of order: two quick moves, the second answered first, and the
 * first response then describes an arrangement the server has already moved
 * past. Written unconditionally it would put that stale order on screen — and
 * the local drag order has been cleared by then, so nothing else is holding the
 * newer one. Ordering by *issue* rather than arrival is what makes the last
 * thing the reader did the last thing they see.
 *
 * Returns whether the response was applied, which is what the tests assert on.
 */
export function applyPinnedWorkstreamsIfCurrent(
  queryClient: ReturnType<typeof useQueryClient>,
  pinned: WorkstreamSummary[],
  issued: number,
  latestIssued: number,
): boolean {
  if (issued !== latestIssued) return false;
  applyPinnedWorkstreams(queryClient, pinned);
  return true;
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const { api, clearDeepLinkError, deepLinkError, signOut } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const hypersightOpen = useUiStore((state) => state.hypersightOpen);
  const hypersightWidth = useUiStore((state) => state.hypersightWidth);
  const railLeaving = useUiStore((state) => state.railLeaving);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  // Replacing rather than pushing, so Back cannot return to an automation that
  // is no longer served — true of an archived draft as much as a deleted
  // automation.
  const leaveAutomationScreen = (automationId: string): void => {
    if (showsAutomation(location.pathname, location.search, automationId)) {
      void navigate('/workstreams/new', { replace: true });
    }
  };

  // HyperSight and the inspector rail are the same slot, so the main pane makes
  // room for whichever one holds it — including a panel that has lost the slot
  // and is still fading out, which is on screen and has to be laid out for.
  const slotHolder = hypersightOpen ? 'hypersight' : railOpen ? 'inspector' : railLeaving;
  const showShellRail = slotHolder !== null && !location.pathname.startsWith('/notes/');
  const automations = useQuery({
    queryKey: ['automations'],
    queryFn: ({ signal }) => api!.getAutomations(signal),
    enabled: Boolean(api),
    staleTime: 20_000,
  });
  const workstreams = useWorkstreamsQuery();
  // One counter across all three pin mutations, because they all rewrite the
  // same list and a response can only be judged stale against the others.
  const pinRequestsIssued = useRef(0);
  // Answers whether this response was the one applied, which the sidebar needs
  // as well: a superseded response updates nothing, so the action behind it has
  // no row movement to follow and must not scroll the viewport either.
  const applyPinResponse = async (request: () => Promise<WorkstreamSummary[]>): Promise<boolean> => {
    pinRequestsIssued.current += 1;
    const issued = pinRequestsIssued.current;
    const pinned = await request();
    if (!applyPinnedWorkstreamsIfCurrent(queryClient, pinned, issued, pinRequestsIssued.current)) return false;
    // The response is the whole pinned list and can name a work stream this
    // device has never listed — pinned on another machine, and too quiet to sit
    // on the page this one last fetched. Patching positions cannot conjure that
    // row, so the list is refetched behind the patch: the patch is what moves
    // the section immediately, the refetch is what makes it complete.
    void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    return true;
  };
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

  // One custom property carries the right sidebar's width, so the panel in the
  // slot, the grab handle beside it, and the room the main pane leaves for it
  // all animate together when the slot changes hands. It follows whichever panel
  // is on screen, so a panel closing on its own dissolves at its own width
  // rather than resizing to a width nothing is about to show.
  const shellStyle = {
    '--rail-width': `${slotHolder === 'hypersight' ? hypersightWidth : railWidth}px`,
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
          leaveAutomationScreen(automation.id);
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
        onChangeWorkstreamScope={async (workstream, scope) => {
          if (!api) return;
          const updated = await api.setWorkstreamScope(workstream.id, scope);
          queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
            current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
          );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', updated.id], (current) =>
            current ? { ...current, scope: updated.scope } : current,
          );
        }}
        onDeleteAutomation={async (automation) => {
          if (!api) return;
          await api.deleteAutomation(automation.id);
          // Deleting closes any run that was opened ahead of its planned time,
          // so the work-stream list is stale too, not just the automation list.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['automations'] }),
            queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
          ]);
          // Leaving the deleted automation's route replaces it rather than
          // pushing, so Back cannot return to it, and the detail query goes
          // with it so nothing can render the automation from cache.
          leaveAutomationScreen(automation.id);
          queryClient.removeQueries({ queryKey: ['automation', automation.id] });
        }}
        onMarkWorkstreamUnread={async (workstream) => {
          if (!api) return;
          const updated = await api.markWorkstreamUnread(workstream.id);
          queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
            current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
          );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', updated.id], (current) =>
            current ? { ...current, ...updated } : current,
          );
          if (location.pathname === `/workstreams/${updated.id}`) void navigate('/workstreams/new');
        }}
        onPinWorkstream={async (workstream, pinned) => {
          if (!api) return false;
          return applyPinResponse(() => pinned
            ? api.pinWorkstream(workstream.id)
            : api.unpinWorkstream(workstream.id));
        }}
        onReorderPinnedWorkstreams={async (workstreamIds) => {
          if (!api) return;
          await applyPinResponse(() => api.reorderWorkstreamPins(workstreamIds));
        }}
        onRenameWorkstream={async (workstream, title) => {
          if (!api) return;
          const updated = await api.renameWorkstream(workstream.id, title);
          queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
            current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
          );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', updated.id], (current) =>
            current ? { ...current, title: updated.title } : current,
          );
        }}
        onRunAutomation={async (automation) => {
          if (!api) return;
          const workstream = await api.runAutomation(automation.id);
          await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
          void navigate(`/workstreams/${workstream.id}`);
        }}
        onOpenMeetingNotes={() => desktopBridge().openMeetingNotes()}
        onSignOut={() => {
          void signOut().catch(() => undefined);
        }}
        hasMoreWorkstreams={workstreams.hasMore}
        loadingMoreWorkstreams={workstreams.isFetchingMore}
        onLoadMoreWorkstreams={workstreams.fetchMore}
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
