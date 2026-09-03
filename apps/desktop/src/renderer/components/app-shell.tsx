import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PropsWithChildren } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CreateProjectRequest, ProjectDirectory, ProjectSummary, WorkspaceAttention, WorkstreamBatchFilter } from '@rally/contracts';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import type { DesktopWorkspaceOnboardingState, DesktopWorkspaceSummary } from '../../common/desktop';
import { workspaceActivationFailureCode } from '../../common/workspace-activation-error';
import {
  AccountSignInFailedError,
  AccountSignInSupersededError,
  useAppSession,
  WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
} from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { uuidV7 } from '../lib/telemetry';
import {
  COLLAPSED_SIDEBAR_WIDTH,
  SIDEBAR_CONTENT_MIN_WIDTH,
  useUiStore,
} from '../lib/ui-store';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useProjectDirectories } from '../lib/use-project-directories';
import { useNotesQuery } from '../lib/use-notes-query';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { WorkstreamSocketPool } from '../lib/workstream-socket-pool';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import {
  evictCachedWorkstream,
  invalidateCachedWorkstreamDetails,
  setCachedWorkstreams,
} from '../lib/workstreams-cache';
import type { AutomationSummary, NoteDetail, NoteSummary, Workspace, WorkspaceMember, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { Sidebar } from './sidebar';
import { WorkspaceAccountMenu } from './workspace-account-menu';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

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
 * therefore be stranded once it stops being served. A draft and an accepted
 * automation share the one route, so this covers both.
 */
export function showsAutomation(pathname: string, automationId: string): boolean {
  return pathname === `/automations/${automationId}`;
}

/**
 * The shell class that says the window's own buttons are painted over the page,
 * or none. Reserving room for them is `docs/assumptions.md` item 25.
 *
 * Only macOS paints them there: the main window asks `hiddenInset` of darwin
 * and `hidden` of everything else, and off darwin that leaves the buttons in
 * the window manager's own frame or, on Windows, not drawn at all. `undefined`
 * — the runtime config still in flight — answers the same as any other
 * non-macOS platform, which is the reading that leaves a header where it
 * already is rather than jumping it sideways when the answer lands.
 */
export function windowControlsShellClass(platform: string | undefined): string {
  return platform === 'darwin' ? 'has-overlay-window-controls' : '';
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

export function invitationAccountMismatch(invitationEmail: string, accountEmail: string): string | null {
  if (invitationEmail.toLocaleLowerCase('en-US') === accountEmail.toLocaleLowerCase('en-US')) return null;
  return `This invitation is for ${invitationEmail}. Sign in with that account to continue.`;
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
/** How long the panes take to fade up on a new workspace; matches `workspace-enter` in `app.css`. */
const WORKSPACE_ENTER_MS = 320;

export function useSocketOwnedList<T>(queryKey: readonly unknown[]): UseQueryResult<T[]> {
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
  const {
    acceptInvitation,
    activateWorkspace,
    api,
    clearPendingInvitation,
    declineInvitation,
    finishWorkspaceSetup,
    getOnboardingState,
    invitationApi,
    pendingInvitation,
    abandonAccountSignIn,
    runtime,
    session,
    signOut,
  } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railLeaving = useUiStore((state) => state.railLeaving);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measure = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // GrokBot protects 424px for the conversation. Its saved expanded width is
  // the other half of the breakpoint, so resizing the sidebar also moves the
  // point at which it becomes an icon rail.
  const sidebarCompact = sidebarCollapsed || windowWidth < sidebarWidth + SIDEBAR_CONTENT_MIN_WIDTH;
  const effectiveSidebarWidth = sidebarCompact ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth;
  // Replacing rather than pushing, so Back cannot return to an automation that
  // is no longer served — true of an archived draft as much as a deleted
  // automation.
  const leaveAutomationScreen = (automationId: string): void => {
    if (showsAutomation(location.pathname, automationId)) {
      void navigate('/workstreams/new', { replace: true });
    }
  };

  // The main pane keeps room for an inspector that is still fading out.
  const showShellRail = (railOpen || railLeaving) && !location.pathname.startsWith('/notes/');
  // Nothing here loads the sidebar. Subscribing to the workspace socket is
  // answered with the whole of it — the first page of work streams, the
  // automations and the notes — and WorkspaceDO pushes each list again whenever
  // it changes a row. This query exists for what a person asks for afterwards:
  // scrolling past page one, or widening the list with Debug enabled.
  const workstreams = useWorkstreamsQuery();
  const members = useQuery<WorkspaceMember[]>({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: Number.POSITIVE_INFINITY,
  });
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
  const notes = useNotesQuery();
  const { active: projects, inactive: inactiveProjects } = useProjectDirectories();
  const featureFlags = useClientFeatureFlags(api);
  const multipleWorkspacesEnabled = featureFlags.data?.multipleWorkspacesEnabled === true;
  const workspaceDirectory = useQuery<DesktopWorkspaceOnboardingState>({
    queryKey: WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
    queryFn: getOnboardingState,
    enabled: multipleWorkspacesEnabled,
  });
  // Main lists the stored set whatever happened to discovery. The account's
  // own state is not read here: a switch or a creation that finds the
  // identity credential missing signs in through the browser and continues
  // by itself (see `activateWorkspace`), so no row is ever marked on a state
  // this renderer may be holding stale.
  const pendingInvitationPreview = useQuery({
    queryKey: ['workspace-invitation-preview', pendingInvitation?.region, pendingInvitation?.token],
    queryFn: ({ signal }) => invitationApi!.getInvitationPreview(pendingInvitation!.token, signal),
    enabled: Boolean(multipleWorkspacesEnabled && pendingInvitation && invitationApi),
    retry: false,
  });
  useEffect(() => {
    if (!pendingInvitationPreview.error) return;
    clearPendingInvitation();
    void desktopBridge().showDeepLinkError(
      pendingInvitationPreview.error instanceof Error
        ? pendingInvitationPreview.error.message
        : 'This invitation is invalid, expired, or no longer available.',
    );
  }, [clearPendingInvitation, pendingInvitationPreview.error]);
  useEffect(() => {
    if (!pendingInvitationPreview.data || !session) return;
    const mismatch = invitationAccountMismatch(pendingInvitationPreview.data.email, session.user.email);
    if (!mismatch) return;
    clearPendingInvitation();
    void desktopBridge().showDeepLinkError(mismatch);
  }, [clearPendingInvitation, pendingInvitationPreview.data, session]);
  const activeWorkspace: DesktopWorkspaceSummary = workspaceDirectory.data?.workspaces
    .find((candidate) => candidate.id === workspace.id && candidate.region === workspace.region) ?? {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.id,
      region: workspace.region,
      role: session?.workspace?.role ?? 'member',
      createdAt: new Date(0).toISOString(),
    };
  const knownWorkspaces = workspaceDirectory.data?.workspaces.length
    ? workspaceDirectory.data.workspaces
    : [activeWorkspace];
  const promptedInvitation = pendingInvitationPreview.data
    ? workspaceDirectory.data?.invitations.find((candidate) => (
      candidate.workspaceId === pendingInvitationPreview.data.workspaceId
      && candidate.region === pendingInvitationPreview.data.region
    )) ?? null
    : null;
  const backgroundWorkspaces = knownWorkspaces.filter((candidate) => (
    candidate.id !== workspace.id || candidate.region !== workspace.region
  ));
  // Attention is read with each workspace's own stored credential, so only the
  // rows this device holds one for can answer. A row discovery listed that was
  // never opened here has none, and asking would fail the whole batch.
  const attentionWorkspaces = backgroundWorkspaces.filter((candidate) => candidate.credentialStored === true);
  const attentionWorkspaceKeys = attentionWorkspaces.map((candidate) => (
    desktopWorkspaceIdentityKey(candidate.region, candidate.id)
  ));
  const workspaceAttention = useQuery<Record<string, WorkspaceAttention>>({
    queryKey: ['workspace-attention', ...attentionWorkspaceKeys],
    queryFn: async () => Object.fromEntries(await Promise.all(attentionWorkspaces.map(async (candidate) => (
      [
        desktopWorkspaceIdentityKey(candidate.region, candidate.id),
        await desktopBridge().getWorkspaceAttention({ region: candidate.region, workspaceId: candidate.id }),
      ] as const
    )))),
    enabled: multipleWorkspacesEnabled && attentionWorkspaces.length > 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
  useEffect(() => {
    if (!workspaceAttention.isError || !navigator.onLine) return;
    // A removed background membership first surfaces through its own attention
    // credential. Reconcile discovery immediately so that stable revocation
    // removes the row; an ordinary transport failure leaves cached discovery
    // untouched and the stale count remains visible.
    void workspaceDirectory.refetch();
  }, [workspaceAttention.isError]);
  useEffect(() => {
    if (!multipleWorkspacesEnabled) return undefined;
    const refresh = (): void => {
      void workspaceDirectory.refetch();
      if (attentionWorkspaces.length > 0) void workspaceAttention.refetch();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [attentionWorkspaceKeys.join(':'), multipleWorkspacesEnabled]);
  const [switchingWorkspaceKey, setSwitchingWorkspaceKey] = useState<string | null>(null);
  const [signingInWorkspaceKey, setSigningInWorkspaceKey] = useState<string | null>(null);
  const [workspaceErrors, setWorkspaceErrors] = useState<Record<string, string | undefined>>({});
  // Choosing a row again while it waits on the browser starts a newer switch;
  // the earlier one then stands down without touching the row it shares.
  const switchAttemptRef = useRef(0);
  const switchingWorkspace = knownWorkspaces.find((candidate) => (
    desktopWorkspaceIdentityKey(candidate.region, candidate.id) === switchingWorkspaceKey
  ));
  // A switch is a dissolve rather than a cut. While the new credential is
  // minted the screen dims in place, and once the session changes the same
  // panes fade back up over the same backdrop showing the new workspace —
  // possible because `activateWorkspace` fetches what this shell needs before
  // the old workspace is torn down, so nothing blank sits between the two.
  const workspaceKey = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
  const [enteringWorkspaceKey, setEnteringWorkspaceKey] = useState<string | null>(null);
  const shownWorkspaceKey = useRef(workspaceKey);
  useEffect(() => {
    if (shownWorkspaceKey.current === workspaceKey) return undefined;
    shownWorkspaceKey.current = workspaceKey;
    setEnteringWorkspaceKey(workspaceKey);
    const timer = window.setTimeout(() => setEnteringWorkspaceKey(null), WORKSPACE_ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [workspaceKey]);
  const shellClassName = [
    'workspace-shell',
    windowControlsShellClass(runtime?.platform),
    showShellRail ? 'rail-open' : '',
    switchingWorkspaceKey !== null ? 'is-switching-workspace' : '',
    enteringWorkspaceKey === workspaceKey ? 'is-entering-workspace' : '',
  ].filter(Boolean).join(' ');
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
    '--rail-width': `${railWidth}px`,
    '--av-cmp-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <WorkstreamSocketPool
      activeWorkstreamId={activeWorkstreamId}
      api={api}
      backgroundWorkstreamIds={backgroundRealtimeIds}
    >
      <div className={shellClassName} style={shellStyle}>
      <Sidebar
        accountMenu={(
          <WorkspaceAccountMenu
            activeWorkspace={activeWorkspace}
            attention={workspaceAttention.data ?? {}}
            currentUser={workspace.currentUser}
            enabled={multipleWorkspacesEnabled}
            invitations={workspaceDirectory.data?.invitations ?? []}
            promptedInvitation={promptedInvitation}
            onAcceptInvitation={async (invitation, operationId) => {
              await acceptInvitation(invitation.region, invitation.id, operationId);
              clearPendingInvitation();
              await workspaceDirectory.refetch();
            }}
            onCreateWorkspace={async (input, operationId, progress) => {
              await finishWorkspaceSetup(input.name, input.region, operationId, progress);
              await workspaceDirectory.refetch();
            }}
            onDeclineInvitation={async (invitation) => {
              await declineInvitation(invitation.region, invitation.id);
              await workspaceDirectory.refetch();
            }}
            onMenuOpen={() => {
              void workspaceDirectory.refetch();
              if (attentionWorkspaces.length > 0) void workspaceAttention.refetch();
            }}
            onAbandonSignIn={abandonAccountSignIn}
            onInvitationPromptDismiss={clearPendingInvitation}
            onOpenSettings={() => { void desktopBridge().openSettings(); }}
            onSignOut={() => { void signOut().catch(() => undefined); }}
            onSwitchWorkspace={async (target) => {
              const targetKey = desktopWorkspaceIdentityKey(target.region, target.id);
              if (!navigator.onLine) {
                setWorkspaceErrors((current) => ({ ...current, [targetKey]: 'Connect to open this workspace' }));
                return false;
              }
              const attempt = ++switchAttemptRef.current;
              setWorkspaceErrors((current) => ({ ...current, [targetKey]: undefined }));
              setSigningInWorkspaceKey(null);
              setSwitchingWorkspaceKey(targetKey);
              try {
                await activateWorkspace(target.region, target.id, uuidV7(), {
                  onSignInRequired: () => {
                    if (switchAttemptRef.current === attempt) setSigningInWorkspaceKey(targetKey);
                  },
                });
                return true;
              } catch (error) {
                // A superseded attempt, or one whose row a newer attempt has
                // since taken over, has nothing left to say about that row.
                if (error instanceof AccountSignInSupersededError || switchAttemptRef.current !== attempt) return false;
                const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
                const message = error instanceof Error ? error.message : '';
                const activationFailure = workspaceActivationFailureCode(error);
                setWorkspaceErrors((current) => ({
                  ...current,
                  [targetKey]: error instanceof AccountSignInFailedError
                    ? error.message
                    : message === 'Finish or stop the recording before switching workspaces'
                    ? message
                    : code === 'workspace_access_denied' || activationFailure === 'workspace_access_denied'
                    ? 'You are no longer a member of this workspace'
                    : 'Rally could not open this workspace',
                }));
                if (code === 'workspace_access_denied' || activationFailure === 'workspace_access_denied') {
                  await workspaceDirectory.refetch();
                }
                return false;
              } finally {
                if (switchAttemptRef.current === attempt) {
                  setSwitchingWorkspaceKey(null);
                  setSigningInWorkspaceKey(null);
                }
              }
            }}
            signingInWorkspaceKey={signingInWorkspaceKey}
            staleAt={workspaceAttention.isError && workspaceAttention.dataUpdatedAt > 0
              ? new Date(workspaceAttention.dataUpdatedAt).toISOString()
              : null}
            switchingWorkspaceKey={switchingWorkspaceKey}
            workspaceErrors={workspaceErrors}
            workspaces={knownWorkspaces}
          />
        )}
        automations={automations.data ?? []}
        compact={sidebarCompact}
        conversationOnly
        members={members.data ?? []}
        // Not `isLoading`: the first page is not fetched, so there is no
        // in-flight request to report. The sidebar is waiting exactly while it
        // has no list yet — which also keeps the skeletons up rather than
        // claiming an empty workspace when the socket cannot connect.
        loading={workstreams.data === undefined}
        notes={notes.data ?? []}
        projects={projects.data?.items ?? []}
        inactiveProjects={inactiveProjects.data?.items ?? []}
        meetingRecordingAvailable={featureFlags.data?.meetingRecordingEnabled === true}
        onArchiveNote={async (note) => {
          if (!api) return;
          await api.archiveNote(note.id);
          // An archived note's resource stops being served everywhere, not just
          // in the note queries: an open work stream it was attached to holds it
          // in a cache that nothing else invalidates, and archiving emits no
          // socket event to shake it loose. The note list itself is not here —
          // the write to `notes` pushes it.
          await Promise.all([
            invalidateCachedWorkstreamDetails(queryClient),
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
          // WorkstreamDO commits the loop stop request and archive together;
          // there is no separate child command to race against lost access.
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
          evictCachedWorkstream(queryClient, workstream.id);
          if (openWorkstreamId(location.pathname) === workstream.id) {
            void navigate('/workstreams/new', { replace: true });
          }
        }}
        onApplyWorkstreamBatch={async (operationId, filter, update) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const accepted = await api.applyWorkstreamBatch(operationId, filter, update);
          const selected = activeWorkstreamId === null
            ? undefined
            : workstreams.data?.find((workstream) => workstream.id === activeWorkstreamId);
          if (update.kind === 'archive' && selected && workstreamMatchesBatchFilter(selected, filter)) {
            evictCachedWorkstream(queryClient, selected.id);
            void navigate('/workstreams/new', { replace: true });
          }
          if (accepted.archivedNoteCount > 0) {
            // The same caches a single note's archive shakes loose, for the same
            // reason: an archived note's resource stops being served everywhere,
            // and a work stream it was attached to holds it in a cache no socket
            // event reaches. The note list itself is not here — WorkspaceDO
            // pushes it off the write that archived them.
            //
            // `['note']` refetches rather than predicting. Archiving one note
            // names it, so that path can leave its route knowing what went; a
            // batch is told only how many, and reconstructing *which* from the
            // filter and the list as it stands now gets it wrong — a note that
            // was recording when the archive ran, and has since stopped, reads
            // as taken when it was skipped. A note that really went answers 404
            // on the refetch and its own screen says so, which is the treatment
            // an archived work stream already gets; one that survived just
            // refreshes under the reader.
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['note'] }),
              invalidateCachedWorkstreamDetails(queryClient),
              queryClient.invalidateQueries({ queryKey: ['workstream-context'] }),
              queryClient.invalidateQueries({ queryKey: ['resources'] }),
            ]);
          }
          return accepted;
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
          await api.runAutomation(automation.id);
          // A run is a substream of the automation, listed on its screen, so
          // that is where a person who asked for one lands.
          await queryClient.invalidateQueries({ queryKey: ['automation-runs', automation.id] });
          void navigate(`/automations/${automation.id}`);
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
          return created;
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
        hasMoreNotes={notes.hasMore}
        loadingMoreWorkstreams={workstreams.isFetchingMore}
        loadingMoreNotes={notes.isFetchingMore}
        onLoadMoreWorkstreams={workstreams.fetchMore}
        onLoadMoreNotes={notes.fetchMore}
        workspace={workspace}
        workstreams={workstreams.data ?? []}
        windowWidth={windowWidth}
      />
        <span aria-live="polite" className="sr-only">
          {switchingWorkspace ? `Opening ${switchingWorkspace.name}…` : ''}
        </span>
        <main className="main-pane">
          {children}
        </main>
      </div>
    </WorkstreamSocketPool>
  );
}
