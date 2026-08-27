import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type CSSProperties, type PropsWithChildren } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CreateProjectRequest, ProjectDirectory, ProjectSummary, WorkstreamBatchFilter } from '@rally/contracts';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useProjectDirectories } from '../lib/use-project-directories';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { WorkstreamSocketPool } from '../lib/workstream-socket-pool';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import type { AutomationSummary, NoteDetail, NoteSummary, Workspace, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { ThemeBackdrop } from './theme-backdrop';
import { Sidebar } from './sidebar';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

/**
 * The states in which a work stream still has a run to stop.
 *
 * Wider than `'running'` alone: a `scheduled` run has been admitted and is
 * about to start, and a `needs_input` one is parked waiting for a person who
 * will not be able to answer it once the work stream is archived. `stopHarness`
 * is a no-op when no run matches, so a row that has already finished costs one
 * request and changes nothing.
 */
export const RUNNING_HARNESS_STATUSES: ReadonlySet<WorkstreamSummary['harnessStatus']> = new Set([
  'scheduled', 'running', 'needs_input',
]);
export const PROACTIVE_RECENT_WORKSTREAM_COUNT = 5;

/** Upsert a mutation response without duplicating an earlier socket push. */
export function upsertProjectDirectory(
  current: ProjectDirectory | undefined,
  project: ProjectSummary,
): ProjectDirectory {
  return {
    // A REST response does not advance the socket receiver's ledger. The next
    // authoritative socket snapshot still has to be accepted at this version.
    waterline: current?.waterline ?? 0,
    items: current?.items.some((item) => item.id === project.id)
      ? current.items.map((item) => item.id === project.id ? project : item)
      : [...(current?.items ?? []), project],
  };
}

export function backgroundRealtimeWorkstreamIds(
  activeWorkstreamId: string | null,
  workstreams: WorkstreamSummary[] | undefined,
): string[] {
  const candidates = (workstreams ?? []).filter((workstream) => workstream.id !== activeWorkstreamId);
  const recentUnpinned = new Set(candidates
    .filter((workstream) => workstream.pinPosition === null)
    .sort((left, right) => {
      const activityOrder = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
      return activityOrder || left.id.localeCompare(right.id);
    })
    .slice(0, PROACTIVE_RECENT_WORKSTREAM_COUNT)
    .map((workstream) => workstream.id));
  return candidates.flatMap((workstream) => (
    workstream.harnessStatus === 'running'
      || workstream.pinPosition !== null
      || recentUnpinned.has(workstream.id)
      ? [workstream.id]
      : []
  ));
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

/** Mirror the generic directory predicate only to decide whether this route must leave. */
export function workstreamMatchesBatchFilter(
  workstream: WorkstreamSummary,
  filter: WorkstreamBatchFilter,
): boolean {
  if (!filter.includeSystem && workstream.systemKind != null) return false;
  if (filter.pinned !== undefined && (workstream.pinPosition !== null) !== filter.pinned) return false;
  const activityAt = Date.parse(workstream.lastActivityAt);
  if (!Number.isFinite(activityAt)) return false;
  const atOrAfter = filter.lastActivityAt?.atOrAfter;
  const before = filter.lastActivityAt?.before;
  if (atOrAfter !== undefined && activityAt < Date.parse(atOrAfter)) return false;
  if (before !== undefined && activityAt >= Date.parse(before)) return false;
  return true;
}

/**
 * Apply a pin response — the caller's whole pinned list, in order — to the
 * cached work-stream list.
 *
 * Every row is rewritten, not just the ones named: the response *is* the pinned
 * set, so a work stream absent from it is one this person no longer has pinned,
 * whichever window unpinned it. Patching only the named rows would leave a pin
 * removed on another device sitting in this sidebar until the next socket page, in a
 * position the server has already given to something else.
 */
export function applyPinnedWorkstreams(
  queryClient: ReturnType<typeof useQueryClient>,
  pinned: WorkstreamSummary[],
): void {
  const positions = new Map(pinned.map((workstream) => [workstream.id, workstream.pinPosition]));
  setCachedWorkstreams(queryClient, (current) =>
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

/**
 * Read a list the workspace socket owns and nothing here fetches.
 *
 * `useWorkstreamsQuery`'s opening batch seeds it and WorkspaceDO re-sends it
 * whole on every change, so there is no fetch to make and no staleness for
 * React Query to police. The query exists only to subscribe this component to
 * the cache entry; the fetcher is unreachable and says so, because a silent
 * `undefined` from an accidentally enabled query would look like an empty
 * sidebar rather than a bug. Invalidating one of these keys does nothing by
 * design — the socket is the only *authority* for the contents.
 *
 * `onChangeNoteScope` below patches `['notes']` directly, which is the single
 * exception and not a second authority: it holds no waterline, cannot advance
 * the ledger, and is overwritten by the push the same write earns. It is a
 * latency hedge against one visible reorder, and the push behind it is what
 * makes the row correct.
 */
function useSocketOwnedList<T>(queryKey: readonly unknown[]): UseQueryResult<T[]> {
  return useQuery<T[]>({
    queryKey,
    queryFn: () => {
      throw new Error(`${String(queryKey[0])} is pushed by the workspace socket, never fetched`);
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const { api, clearDeepLinkError, deepLinkError, signOut } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const blockDashboardOpen = useUiStore((state) => state.blockDashboardOpen);
  const blockDashboardWidth = useUiStore((state) => state.blockDashboardWidth);
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
  const slotHolder = blockDashboardOpen ? 'block-dashboard' : railOpen ? 'inspector' : railLeaving;
  const showShellRail = slotHolder !== null && !location.pathname.startsWith('/notes/');
  // Nothing here loads the sidebar. Subscribing to the workspace socket is
  // answered with the whole of it — the first page of work streams, the
  // automations and the notes — and WorkspaceDO pushes each list again whenever
  // it changes a row. This query exists for what a person asks for afterwards:
  // scrolling past page one, or widening the list with Debug enabled.
  const workstreams = useWorkstreamsQuery();
  const automations = useSocketOwnedList<AutomationSummary>(['automations']);
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
  const notes = useSocketOwnedList<NoteSummary>(['notes']);
  const { active: projects, inactive: inactiveProjects } = useProjectDirectories();
  const featureFlags = useClientFeatureFlags(api);
  const { setForegroundWorkstreamId } = useWorkspaceSocket();

  const activeWorkstreamId = openWorkstreamId(location.pathname);
  useEffect(() => {
    setForegroundWorkstreamId(activeWorkstreamId);
  }, [activeWorkstreamId, setForegroundWorkstreamId]);
  useEffect(() => {
    return () => setForegroundWorkstreamId(null);
  }, [setForegroundWorkstreamId]);
  const backgroundRealtimeIds = useMemo(
    () => backgroundRealtimeWorkstreamIds(activeWorkstreamId, workstreams.data),
    [activeWorkstreamId, workstreams.data],
  );

  // One custom property carries the right sidebar's width, so the panel in the
  // slot, the grab handle beside it, and the room the main pane leaves for it
  // all animate together when the slot changes hands. It follows whichever panel
  // is on screen, so a panel closing on its own dissolves at its own width
  // rather than resizing to a width nothing is about to show.
  const shellStyle = {
    '--rail-width': `${slotHolder === 'block-dashboard' ? blockDashboardWidth : railWidth}px`,
    '--av-cmp-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <WorkstreamSocketPool
      activeWorkstreamId={activeWorkstreamId}
      api={api}
      backgroundWorkstreamIds={backgroundRealtimeIds}
    >
      <div className={showShellRail ? 'workspace-shell rail-open' : 'workspace-shell'} style={shellStyle}>
      {/*
        The main window only. The standalone Settings and meeting windows reach
        their own surfaces before `AppShell` and deliberately do not mount this:
        both are dense forms, and a field of moving light behind one costs more
        legibility than it buys. They keep `surface-default` as a flat ground.

        So on Air the two windows do look different side by side, which is a
        decision rather than an oversight — `docs/theming.md` records it in the
        Invariants, and a test fails if a third surface starts mounting one
        without that decision being revisited.
      */}
      <ThemeBackdrop />
      <Sidebar
        automations={automations.data ?? []}
        // Not `isLoading`: the first page is not fetched, so there is no
        // in-flight request to report. The sidebar is waiting exactly while it
        // has no list yet — which also keeps the skeletons up rather than
        // claiming an empty workspace when the socket cannot connect.
        loading={workstreams.data === undefined}
        notes={notes.data ?? []}
        projects={projects.data?.items ?? []}
        inactiveProjects={inactiveProjects.data?.items ?? []}
        meetingRecordingAvailable={featureFlags.data?.meetingRecordingEnabled === true}
        automationWorkspaceTemplatesAvailable={featureFlags.data?.automationWorkspaceTemplatesEnabled === true}
        onArchiveDraftAutomation={async (automation) => {
          if (!api) return;
          await api.archiveDraftAutomation(automation.id);
          // No list invalidation: archiving writes `automation_subscriptions`,
          // and WorkspaceDO pushes the rewritten list off the back of that write.
          leaveAutomationScreen(automation.id);
        }}
        onArchiveNote={async (note) => {
          if (!api) return;
          await api.archiveNote(note.id);
          // An archived note's resource stops being served everywhere, not just
          // in the note queries: an open work stream it was attached to holds it
          // in a cache that nothing else invalidates, and archiving emits no
          // socket event to shake it loose. The note list itself is not here —
          // the write to `notes` pushes it.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['workstream'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream-context'] }),
            queryClient.invalidateQueries({ queryKey: ['resources'] }),
          ]);
          queryClient.removeQueries({ queryKey: ['note', note.id] });
          // The archived note's own screen would keep reading a note the API no
          // longer serves, so leave it the way a deleted automation does.
          if (location.pathname === `/notes/${note.id}`) void navigate('/workstreams/new');
        }}
        onArchiveWorkstream={async (workstream) => {
          // Thrown rather than returned, unlike the handlers around it. The
          // sidebar treats this promise resolving as the archive having
          // happened: it reports the `archive` intent and closes the dialog. A
          // signed-out `api` would therefore claim success for a request that
          // was never sent — the one outcome the confirmation's failure dialog
          // exists to prevent, and a false product event besides.
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          // Stopped before it is archived, because archiving takes away every
          // surface that could stop it afterwards: `authorize` refuses an
          // archived work stream, so `POST /:id/stop` and the transcript both
          // 404 the moment this lands, and the row is gone from the sidebar.
          // Left alone, a run would keep calling tools and spending against a
          // work stream nobody can open — while the dialog just said it stopped
          // reaching the agent.
          //
          // Two requests with no transaction between them, deliberately in this
          // order: a stop that fails leaves the work stream exactly as it was,
          // which is the recoverable direction. The reverse would archive first
          // and strand the run it could no longer reach.
          if (RUNNING_HARNESS_STATUSES.has(workstream.harnessStatus)) {
            await api.stopHarness(workstream.id);
          }
          await api.archiveWorkstream(workstream.id);
          // No list invalidation and no cache patch: WorkstreamDO answers this
          // write with a directory tombstone, and `applyVersionedWorkstreamState`
          // drops both the sidebar row and the `['workstream', id]` detail entry
          // off the back of it — the same path an archive from another window
          // takes, and the one that has the waterline to order it against
          // whatever else is in flight for this row.
          //
          // Leaving the screen is this handler's, though. The socket removes the
          // query but not the route, so the reader would be left on a work stream
          // the API no longer serves. Replacing rather than pushing, so Back
          // cannot return to it — as a deleted automation leaves, and
          // deliberately not as the archived note above does: that one pushes,
          // so Back returns to a note the API will refuse.
          // The one thing that cannot wait for the tombstone. With the socket
          // down the PATCH still succeeds, so the row stays until reconnect and
          // clicking it would serve this cached transcript for a work stream the
          // API now refuses. Idempotent with the tombstone, which removes the
          // same key, and safe against a later frame: the state store only
          // merges a detail entry `if (detail)`.
          queryClient.removeQueries({ queryKey: ['workstream', workstream.id], exact: true });
          if (openWorkstreamId(location.pathname) === workstream.id) {
            void navigate('/workstreams/new', { replace: true });
          }
        }}
        onApplyWorkstreamBatch={async (operationId, filter, update) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const enqueuedCount = await api.applyWorkstreamBatch(operationId, filter, update);
          const selected = activeWorkstreamId === null
            ? undefined
            : workstreams.data?.find((workstream) => workstream.id === activeWorkstreamId);
          if (update.kind === 'archive' && selected && workstreamMatchesBatchFilter(selected, filter)) {
            queryClient.removeQueries({ queryKey: ['workstream', selected.id], exact: true });
            void navigate('/workstreams/new', { replace: true });
          }
          return enqueuedCount;
        }}
        onChangeNoteScope={async (note, scope) => {
          if (!api) return;
          const updated = await api.updateNote(note.id, { scope });
          // The server bumps last_activity_at on any note write, and that is the
          // sidebar's sort key. Patching the scope alone would leave the row in
          // its old position until the next refetch moved it for no visible
          // reason, so the timestamps travel with it.
          //
          // Deliberately not through `applyVersionedSidebarList`: this patch has
          // no waterline to offer, and inventing one would corrupt the ledger
          // that orders the real pushes. It is an optimistic local edit, valid
          // only until WorkspaceDO re-sends the list off this same write — see
          // the note on `useSocketOwnedList`.
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
          setCachedWorkstreams(queryClient, (current) =>
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
          // so the work-stream list is stale too — and that one is not pushed
          // off the automation write the way the automation list is.
          await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
          // Leaving the deleted automation's route replaces it rather than
          // pushing, so Back cannot return to it, and the detail query goes
          // with it so nothing can render the automation from cache.
          leaveAutomationScreen(automation.id);
          queryClient.removeQueries({ queryKey: ['automation', automation.id] });
        }}
        onMarkWorkstreamUnread={async (workstream) => {
          if (!api) return;
          const updated = await api.markWorkstreamUnread(workstream.id);
          setCachedWorkstreams(queryClient, (current) =>
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
          setCachedWorkstreams(queryClient, (current) =>
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
        onPreviewWorkstreamBatch={async (filter) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          return api.previewWorkstreamBatch(filter);
        }}
        onCreateProject={async (input: CreateProjectRequest) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const created = await api.createProject(input);
          queryClient.setQueryData<ProjectDirectory>(
            ['projects'],
            (current) => upsertProjectDirectory(current, created),
          );
        }}
        onAddWorkstreamToProject={async (projectId, workstreamId) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const updated = await api.addWorkstreamToProject(projectId, workstreamId);
          queryClient.setQueryData<ProjectDirectory>(['projects'], (current) => current ? {
            ...current,
            items: current.items.map((project) => project.id === updated.id ? updated : {
              ...project,
              workstreamIds: project.workstreamIds.filter((id) => id !== workstreamId),
            }),
          } : current);
        }}
        onReorderProjects={async (projectIds) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const directory = await api.reorderProjects(projectIds);
          queryClient.setQueryData(['projects'], directory);
        }}
        onRestoreProject={async (projectId) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const restored = await api.restoreProject(projectId);
          queryClient.setQueryData<ProjectDirectory>(['projects-inactive'], (current) => current ? {
            ...current,
            items: current.items.filter((project) => project.id !== restored.id),
          } : current);
          queryClient.setQueryData<ProjectDirectory>(['projects'], (current) => current ? {
            ...current,
            items: current.items.some((project) => project.id === restored.id)
              ? current.items.map((project) => project.id === restored.id ? restored : project)
              : [...current.items, restored],
          } : current);
        }}
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
    </WorkstreamSocketPool>
  );
}
