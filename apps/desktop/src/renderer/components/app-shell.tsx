import type { CreateSpaceRequest, PersonalOrder, SpaceDirectory, SpaceSummary, WorkspaceAttention, WorkstreamBatchFilter } from '@rally/contracts';
import type { ClientSession } from '@rally/contracts/client-session';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PropsWithChildren, useContext } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DesktopWorkspaceOnboardingState, DesktopWorkspaceSummary } from '../../common/desktop';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import { workspaceActivationFailureCode } from '../../common/workspace-activation-error';
import {
  AccountSignInFailedError,
  AccountSignInSupersededError,
  useAppSession,
  WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
} from '../lib/app-session';
import type { RallyApi } from '../lib/api';
import { workstreamRecencyAt } from '../lib/format';
import { MemberPresentationContext } from '../lib/member-presentation';
import { openLink } from '../lib/browser-rail-links';
import { conversationDirectoryQueryKey } from '../lib/conversation-directory';
import { desktopBridge } from '../lib/platform';
import { layoutKey, writeLayout } from '../lib/desktop-layout';
import { uuidV7 } from '../lib/telemetry';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { SIDEBAR_CONTENT_MIN_WIDTH, useUiStore } from '../lib/ui-store';
import { INACTIVE_SPACES_QUERY_KEY, PERSONAL_ORDER_QUERY_KEY, SPACES_QUERY_KEY, applyContainerOrder } from '../lib/sidebar-list-store';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { usePersonalOrder, useSpaceDirectories, useSpacesReady } from '../lib/use-space-directories';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { activeRealtimeWorkstreamId } from '../lib/workspace-workstream-sockets';
import { useWorkspaceSocket, type SidebarConnect, type WorkspaceSocketState } from '../lib/workspace-socket';
import { useOpenFirstWorkstream, openWorkstreamId } from '../lib/workstream-landing';
import { patchCachedWorkstreamViewerState } from '../lib/workstream-state-store';
import {
  evictCachedWorkstream,
  holdCachedWorkstreamArchive,
  patchCachedWorkstream,
  setCachedWorkstreams,
} from '../lib/workstreams-cache';
import { AttachmentLightbox } from './attachment-lightbox';
import type { AttachmentPreview } from './attachments';
import { SearchModal } from './search-modal';
import { Sidebar } from './sidebar';
import { WorkspaceAccountMenu } from './workspace-account-menu';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

/** Keep async callbacks aligned with the route from the latest committed render. */
export function useLatestCommittedValue<T>(value: T): React.RefObject<T> {
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
  }, [value]);
  return current;
}

/** Revoke async work before later layout effects can observe an unmounted shell. */
export function useLayoutMountedRef(): React.RefObject<boolean> {
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

/** Archive is writable only while this connection still owns a live Space snapshot. */
export function hasLiveSpaceArchiveAuthority(
  state: WorkspaceSocketState,
  sidebarConnect: SidebarConnect | null,
): boolean {
  return state === 'connected' && sidebarConnect?.spacesLive === true;
}

/** Upsert a mutation response without duplicating an earlier socket push. */
export function upsertSpaceDirectory(
  current: SpaceDirectory | undefined,
  space: SpaceSummary,
): SpaceDirectory {
  return {
    // A REST response does not advance the socket receiver's ledger. The next
    // authoritative socket snapshot still has to be accepted at this version.
    waterline: current?.waterline ?? 0,
    items: current?.items.some((item) => item.id === space.id)
      ? current.items.map((item) => item.id === space.id ? space : item)
      : [...(current?.items ?? []), space],
  };
}

/** Move a current archive response between the two directories and leave its open route. */
export function applyArchivedSpace(
  queryClient: QueryClient,
  archived: SpaceSummary,
  pathname: string,
  openFirstWorkstream: () => void,
  wasActiveWhenRequested = false,
): boolean {
  const active = queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY);
  const inactive = queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY);
  const cachedSpace = [...(active?.items ?? []), ...(inactive?.items ?? [])]
    .find((space) => space.id === archived.id);
  const newerActiveSpace = active?.items.some(
    (space) => space.id === archived.id && space.revision > archived.revision,
  ) ?? false;
  const newerInactiveSpace = inactive?.items.some(
    (space) => space.id === archived.id && space.revision > archived.revision,
  ) ?? false;
  const removedBySocket = wasActiveWhenRequested
    && active !== undefined
    && inactive !== undefined
    && cachedSpace === undefined;
  const leaveArchivedRoute = (): void => {
    if (pathname === `/spaces/${archived.id}`
      || pathname.startsWith(`/spaces/${archived.id}/`)) {
      openFirstWorkstream();
    }
  };
  // The socket may have delivered a later restore or archive while this REST
  // request was in flight. Preserve either its newer per-Space revision or its
  // authoritative removal from both loaded directories: the REST response has
  // no directory waterline and cannot distinguish that removal from old data.
  if (newerActiveSpace) return false;
  if (newerInactiveSpace || removedBySocket) {
    leaveArchivedRoute();
    return false;
  }
  queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
    ...current,
    items: current.items.filter((space) => space.id !== archived.id),
  } : current);
  queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
    ...current,
    // The socket may win the race with this REST response. Replace that copy
    // in place so later socket-owned archive ordering is not moved behind it.
    items: current.items.some((space) => space.id === archived.id)
      ? current.items.map((space) => space.id === archived.id ? archived : space)
      : [archived, ...current.items],
  } : current);
  leaveArchivedRoute();
  return true;
}

/** Build the archive callback around the route and cache state current at response time. */
export function archiveSpaceMutationHandler(
  api: Pick<RallyApi, 'archiveSpace'> | null,
  queryClient: QueryClient,
  currentPathname: () => string,
  openFirstWorkstream: () => void,
  requestStillCurrent: () => boolean = () => true,
): (spaceId: string) => Promise<void> {
  return async (spaceId) => {
    if (!api) throw new Error('Your session is no longer active. Sign in again.');
    const wasActiveWhenRequested = queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)
      ?.items.some((space) => space.id === spaceId) ?? false;
    const archived = await api.archiveSpace(spaceId);
    if (!requestStillCurrent()) return;
    applyArchivedSpace(
      queryClient,
      archived,
      currentPathname(),
      openFirstWorkstream,
      wasActiveWhenRequested,
    );
  };
}

/**
 * The Space-placement callbacks handed to the sidebar.
 *
 * Kept as one tested adapter because both identifiers are strings at the API
 * boundary: reversing `spaceId` and `workstreamId` typechecks while sending the
 * mutation to the wrong route. The shell uses this returned pair directly, so
 * the test covers the same callbacks the sidebar invokes.
 */
export function channelSpaceMutationHandlers(
  api: Pick<RallyApi, 'addChannelToSpace' | 'moveChannelBetweenSpaces' | 'removeChannelFromSpace'> | null,
  queryClient: QueryClient,
): {
  onAddChannelToSpace: (spaceId: string, workstreamId: string) => Promise<void>;
  onMoveChannelToSpace: (sourceSpaceId: string, targetSpaceId: string, workstreamId: string) => Promise<void>;
  onRemoveChannelFromSpace: (spaceId: string, workstreamId: string) => Promise<void>;
} {
  const activeApi = (): Pick<RallyApi, 'addChannelToSpace' | 'moveChannelBetweenSpaces' | 'removeChannelFromSpace'> => {
    if (!api) throw new Error('Your session is no longer active. Sign in again.');
    return api;
  };
  const applySpace = (updated: SpaceSummary): void => {
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
      ...current,
      items: current.items.map((space) => (
        space.id === updated.id && updated.revision >= space.revision ? updated : space
      )),
    } : current);
  };
  const pendingMoves = new Map<string, Promise<void>>();
  const moveChannel = async (
    sourceSpaceId: string,
    targetSpaceId: string,
    workstreamId: string,
  ): Promise<void> => {
    const moveApi = activeApi();
    const before = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
      ?.find((workstream) => workstream.id === workstreamId)?.spaceIds;
    const optimistic = before === undefined ? undefined : [...new Set([
      ...before.filter((spaceId) => spaceId !== sourceSpaceId),
      targetSpaceId,
    ])];
    if (optimistic !== undefined) {
      patchCachedWorkstream(queryClient, workstreamId, { spaceIds: optimistic });
    }
    let moved: Awaited<ReturnType<typeof moveApi.moveChannelBetweenSpaces>>;
    try {
      moved = await moveApi.moveChannelBetweenSpaces(sourceSpaceId, targetSpaceId, workstreamId);
    } catch (cause) {
      if (before !== undefined && optimistic !== undefined) {
        patchCachedWorkstream(queryClient, workstreamId, (current) => (
          current.spaceIds.length === optimistic.length
            && current.spaceIds.every((spaceId, index) => spaceId === optimistic[index])
            ? { ...current, spaceIds: before }
            : current
        ));
      }
      throw cause;
    }
    applySpace(moved.target);
    applySpace(moved.source);
    // The optimistic value already represents this successful operation. A
    // different value here came from a newer socket publication and must win.
  };
  return {
    // A Channel keeps every Space it is already in: adding is additive, and
    // the placement it produces is a second one rather than a move.
    onAddChannelToSpace: async (spaceId, workstreamId) => {
      applySpace(await activeApi().addChannelToSpace(spaceId, workstreamId));
      // The placement is on the Channel's row, which only WorkspaceDO writes;
      // its socket push is what puts the row under the Space.
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    },
    // One server operation composes the membership primitives in the safe
    // order: establish the destination before withdrawing the source, so an
    // interrupted move can leave an extra placement but never a homeless
    // Channel. The Channel cache moves before the request, so the source rail
    // responds to the drop rather than to a later round trip. The response
    // reconciles the two Space summaries; no refetch extends the gesture.
    onMoveChannelToSpace: (sourceSpaceId, targetSpaceId, workstreamId) => {
      if (sourceSpaceId === targetSpaceId) return Promise.resolve();
      const previous = pendingMoves.get(workstreamId);
      const moving = previous === undefined
        ? moveChannel(sourceSpaceId, targetSpaceId, workstreamId)
        : previous.then(() => moveChannel(sourceSpaceId, targetSpaceId, workstreamId));
      pendingMoves.set(workstreamId, moving);
      void moving.finally(() => {
        if (pendingMoves.get(workstreamId) === moving) pendingMoves.delete(workstreamId);
      }).catch(() => undefined);
      return moving;
    },
    onRemoveChannelFromSpace: async (spaceId, workstreamId) => {
      applySpace(await activeApi().removeChannelFromSpace(spaceId, workstreamId));
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    },
  };
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
  if (filter.pinned !== undefined) {
    const pinnedInSpace = workstream.spacePins?.some((pin) => pin.spaceId === filter.spaceId) ?? false;
    if (pinnedInSpace !== filter.pinned) return false;
  }
  const activityAt = Date.parse(filter.recency === 'access' ? workstreamRecencyAt(workstream) : workstream.lastActivityAt);
  if (!Number.isFinite(activityAt)) return false;
  const atOrAfter = filter.lastActivityAt?.atOrAfter;
  const before = filter.lastActivityAt?.before;
  if (atOrAfter !== undefined && activityAt < Date.parse(atOrAfter)) return false;
  if (before !== undefined && activityAt >= Date.parse(before)) return false;
  return true;
}

/**
 * The rows the landing must pass over after a batch archive took the open one.
 *
 * Every cached row the filter matches, not only the open one. The eviction
 * drops the open row from the list, but the others the batch took stay until
 * their tombstones arrive, and the landing would otherwise open the next most
 * recent of them. This is a reconstruction, not the answer: the response says
 * how many went, never which, and a row whose recency crossed the filter's
 * edge between this snapshot and the server's own evaluation lands on the
 * wrong side. The two errors are not symmetric. Skipping a row that survived
 * costs a landing on an older row, or a page fetch; opening a row that went
 * costs an error screen. So the reconstruction is allowed to be wide and the
 * skip applies to this one landing only.
 */
export function batchArchiveSkipIds(
  workstreams: readonly WorkstreamSummary[],
  filter: WorkstreamBatchFilter,
): string[] {
  return workstreams
    .filter((workstream) => workstreamMatchesBatchFilter(workstream, filter))
    .map((workstream) => workstream.id);
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
  spaceId: string,
  pinned: WorkstreamSummary[],
): void {
  const positions = new Map(pinned.map((workstream) => [
    workstream.id,
    workstream.spacePins?.find((pin) => pin.spaceId === spaceId)?.position ?? null,
  ]));
  setCachedWorkstreams(queryClient, (current) =>
    current?.map((item) => {
      const pinPosition = positions.get(item.id) ?? null;
      const currentPosition = item.spacePins?.find((pin) => pin.spaceId === spaceId)?.position ?? null;
      if (currentPosition === pinPosition) return item;
      const otherPins = (item.spacePins ?? []).filter((pin) => pin.spaceId !== spaceId);
      const spacePins = pinPosition === null
        ? otherPins
        : [...otherPins, { spaceId, position: pinPosition }];
      return { ...item, spacePins };
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
  spaceId: string,
  pinned: WorkstreamSummary[],
  issued: number,
  latestIssued: number,
): boolean {
  if (issued !== latestIssued) return false;
  applyPinnedWorkstreams(queryClient, spaceId, pinned);
  return true;
}

/** How long the panes take to fade up on a new workspace; matches `workspace-enter` in `app.css`. */
const WORKSPACE_ENTER_MS = 320;

/**
 * Whether the active workspace shell has a Space rail.
 *
 * Guests receive an associative, read-only directory instead of the member
 * socket directory: only Spaces that contain a Channel they may read, and only
 * each ancestor's presentation metadata. A session without an active workspace
 * never mounts this shell; null remains enabled for the legacy startup frame.
 */
export function spacesEnabledForSession(session: ClientSession | null): boolean {
  return session === null || session.workspace !== undefined;
}

/** Adapt the metadata-only guest directory to the existing navigation rails. */
export function associativeSpacesForSidebar(directory: SharedNavigationDirectory | undefined): SpaceSummary[] {
  return directory?.spaces.map((space) => ({
    id: space.id,
    name: space.name,
    iconKey: space.iconKey,
    colorKey: space.colorKey,
    scope: space.scope,
    status: 'active',
    systemRole: null,
    revision: 1,
    reach: 'through_channel',
    participants: [],
    channelCount: space.workstreamIds.length,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  })) ?? [];
}

/**
 * The Channel rail: the member directory's rows, then every Channel the
 * conversation directory adds, each drawn from live socket state where there
 * is some.
 *
 * A guest's rail is the conversation directory alone. A member's is the member
 * directory plus any Channel they reach only through its conversations, which
 * opens on the first conversation it lists rather than on Main.
 */
export function associativeWorkstreamsForSidebar(
  directory: SharedNavigationDirectory | undefined,
  workstreams: readonly WorkstreamSummary[] | undefined,
  includeMemberDirectory = false,
): WorkstreamSummary[] {
  if (!workstreams) return [];
  if (!directory) return includeMemberDirectory ? [...workstreams] : [];
  const live = new Map(workstreams.map((item) => [item.id, item]));
  const placements = new Map<string, string[]>();
  for (const space of directory.spaces) {
    for (const workstreamId of space.workstreamIds) {
      const current = placements.get(workstreamId) ?? [];
      current.push(space.id);
      placements.set(workstreamId, current);
    }
  }
  const associative = directory.workstreams.flatMap((metadata) => {
    const first = metadata.conversations.find((item) => !item.archived) ?? metadata.conversations[0];
    if (!first) return [];
    const workstream = live.get(metadata.parentId);
    // A member row the member directory already lists stays as it is.
    if (includeMemberDirectory && workstream) return [];
    return [{
      ...(workstream ?? {
        id: metadata.parentId,
        title: metadata.title ?? first.title,
        titleStatus: 'settled' as const,
        harnessStatus: 'completed' as const,
        latestAttentionSequenceNumber: 0,
        readThroughSequenceNumber: 0,
        manualUnreadFromSequenceNumber: null,
        manualUnreadGeneration: 0,
        hasUnread: false,
        firstUnreadSequenceNumber: null,
        lastActivityAt: '1970-01-01T00:00:00.000Z',
        scope: metadata.scope,
        participantUserIds: [],
        participantExtraCount: 0,
        nextPendingWakeup: null,
        pinPosition: null,
        ...(metadata.appearance ? { appearance: metadata.appearance } : {}),
      }),
      associativeSubstreamId: first.substreamId,
      spaceIds: placements.get(metadata.parentId) ?? [],
    }];
  });
  return includeMemberDirectory ? [...workstreams, ...associative] : associative;
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const personalPresentation = useContext(MemberPresentationContext).get(workspace.currentUser.id);
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
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (api && (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyF' && !event.isComposing) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', openSearch);
    return () => window.removeEventListener('keydown', openSearch);
  }, [api]);
  const searchIdentity = `${workspace.id}:${workspace.currentUser.id}`;
  const [searchPreview, setSearchPreview] = useState<{ identity: string; preview: AttachmentPreview } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    if (!/^\/spaces\/[^/]+$/.test(path)
      && (!/^\/workstreams\/[^/]+$/.test(path) || path === '/workstreams/new')) return;
    const breakout = new URLSearchParams(location.search).get('substream');
    writeLayout(layoutKey(workspace.id, workspace.currentUser.id, 'last-route'),
      path.startsWith('/workstreams/') && breakout
        ? `${path}?substream=${encodeURIComponent(breakout)}` : path);
  }, [location.pathname, location.search, workspace.id, workspace.currentUser.id]);
  const currentPathname = useLatestCommittedValue(location.pathname);
  const shellMounted = useLayoutMountedRef();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const queryClient = useQueryClient();
  const channelSpaceHandlers = useMemo(
    () => channelSpaceMutationHandlers(api, queryClient),
    [api, queryClient],
  );
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railLeaving = useUiStore((state) => state.railLeaving);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const spacesEnabled = spacesEnabledForSession(session);
  // The main pane keeps room for a sidebar that is still fading out.
  const showShellRail = railOpen || railLeaving;
  const expandForShellRail = railOpen;
  useEffect(() => {
    void desktopBridge().setConversationDetailsOpen({
      // A leaving rail remains laid out for its short cross-fade, but no longer
      // owns window geometry. This preserves the true pre-panel bounds.
      open: expandForShellRail,
      width: railWidth,
    }).catch(() => undefined);
  }, [expandForShellRail, railWidth]);
  useEffect(() => () => {
    void desktopBridge().setConversationDetailsOpen({ open: false, width: 0 }).catch(() => undefined);
  }, []);
  // Nothing here loads the sidebar. Subscribing to the workspace socket is
  // answered with the whole of it — the first page of work streams, the
  // Sidekicks and the notes — and WorkspaceDO pushes each list again whenever
  // it changes a row. This query exists for what a person asks for afterwards:
  // scrolling past page one, or widening the list with Debug enabled.
  const workstreams = useWorkstreamsQuery();
  // One counter across all three pin mutations, because they all rewrite the
  // same list and a response can only be judged stale against the others.
  const pinRequestsIssued = useRef(new Map<string, number>());
  // Answers whether this response was the one applied, which the sidebar needs
  // as well: a superseded response updates nothing, so the action behind it has
  // no row movement to follow and must not scroll the viewport either.
  const applyPinResponse = async (spaceId: string, request: () => Promise<WorkstreamSummary[]>): Promise<boolean> => {
    const issued = (pinRequestsIssued.current.get(spaceId) ?? 0) + 1;
    pinRequestsIssued.current.set(spaceId, issued);
    const pinned = await request();
    if (!applyPinnedWorkstreamsIfCurrent(
      queryClient, spaceId, pinned, issued, pinRequestsIssued.current.get(spaceId) ?? 0,
    )) return false;
    // The response is the whole pinned list and can name a work stream this
    // device has never listed — pinned on another machine, and too quiet to sit
    // on the page this one last fetched. Patching positions cannot conjure that
    // row, so the list is refetched behind the patch: the patch is what moves
    // the section immediately, the refetch is what makes it complete.
    void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    return true;
  };
  const { active: spaces, inactive: inactiveSpaces } = useSpaceDirectories();
  const socketSpacesReady = useSpacesReady();
  const guestSession = session?.workspace?.accessClass === 'guest';
  const associativeNavigation = useQuery({
    queryKey: conversationDirectoryQueryKey(workspace.id),
    queryFn: ({ signal }) => api!.getSharedNavigationDirectory(signal),
    enabled: Boolean(api),
    // A guest's whole rail is this read, refreshed on focus. A member's rail is
    // the socket's; this read adds to it and is refreshed by the socket's own
    // signals — a Channel's tombstone, a listed Channel's metadata frame —
    // rather than by a request on every focus.
    refetchOnWindowFocus: guestSession ? 'always' : false,
  });
  const associativeSpaces = useMemo(
    () => associativeSpacesForSidebar(associativeNavigation.data),
    [associativeNavigation.data],
  );
  const sidebarWorkstreams = useMemo(
    () => associativeWorkstreamsForSidebar(associativeNavigation.data, workstreams.data, !guestSession),
    [associativeNavigation.data, guestSession, workstreams.data],
  );
  const visibleSpaces = useMemo(() => {
    if (guestSession) return associativeSpaces;
    // A member also sees the Spaces a conversation-only Channel sits in, as
    // the placement the guest rail gives it, where the member rail has none.
    const memberSpaces = spaces.data?.items ?? [];
    const listed = new Set(memberSpaces.map((space) => space.id));
    return [...memberSpaces, ...associativeSpaces.filter((space) => !listed.has(space.id))];
  }, [associativeSpaces, guestSession, spaces.data?.items]);
  const visibleInactiveSpaces = guestSession ? [] : inactiveSpaces.data?.items ?? [];
  const spacesReady = guestSession ? !associativeNavigation.isPending : socketSpacesReady;
  const ordering = usePersonalOrder();
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
    'app-shell',
    windowControlsShellClass(runtime?.platform),
    showShellRail ? 'rail-open' : '',
    switchingWorkspaceKey !== null ? 'is-switching-workspace' : '',
    enteringWorkspaceKey === workspaceKey ? 'is-entering-workspace' : '',
  ].filter(Boolean).join(' ');
  const {
    loadedSpaceIds, prioritizeSpace, reconnect, setForegroundWorkstreamId, sidebarConnect, state: workspaceSocketState,
  } = useWorkspaceSocket();

  const activeWorkstreamId = openWorkstreamId(location.pathname);
  // A pending Channel may not be in the Organization's directory yet, and the
  // workspace socket closes for good on presence naming a Channel it cannot see.
  const foregroundWorkstreamId = activeRealtimeWorkstreamId(activeWorkstreamId, workstreams.data);
  useEffect(() => {
    setForegroundWorkstreamId(foregroundWorkstreamId);
  }, [foregroundWorkstreamId, setForegroundWorkstreamId]);
  useEffect(() => {
    return () => setForegroundWorkstreamId(null);
  }, [setForegroundWorkstreamId]);


  // One custom property carries the right sidebar's width, so the panel in the
  // slot, the grab handle beside it, and the room the main pane leaves for it
  // all animate together when the slot changes hands. It follows whichever panel
  // is on screen, so a panel closing on its own dissolves at its own width
  // rather than resizing to a width nothing is about to show.
  const shellStyle = {
    '--rail-width': `${railWidth}px`,
    '--conversation-min-width': `${SIDEBAR_CONTENT_MIN_WIDTH}px`,
    '--av-cmp-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <>
      <div className={shellClassName} style={shellStyle}>
      <Sidebar
        onOpenSearch={api ? () => setSearchOpen(true) : undefined}
        accountMenu={(
          <WorkspaceAccountMenu
            activeWorkspace={activeWorkspace}
            attention={workspaceAttention.data ?? {}}
            currentUser={{ ...workspace.currentUser, name: personalPresentation?.displayName ?? workspace.currentUser.name }}
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
                setWorkspaceErrors((current) => ({ ...current, [targetKey]: 'Connect to open this organization' }));
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
                const activationFailure = workspaceActivationFailureCode(error);
                setWorkspaceErrors((current) => ({
                  ...current,
                  [targetKey]: error instanceof AccountSignInFailedError
                    ? error.message
                    : code === 'workspace_access_denied' || activationFailure === 'workspace_access_denied'
                    ? 'You are no longer a member of this organization'
                    : 'Rally could not open this organization',
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
            presentation="grok"
            staleAt={workspaceAttention.isError && workspaceAttention.dataUpdatedAt > 0
              ? new Date(workspaceAttention.dataUpdatedAt).toISOString()
              : null}
            switchingWorkspaceKey={switchingWorkspaceKey}
            workspaceErrors={workspaceErrors}
            workspaces={knownWorkspaces}
          />
        )}
        // Not `isLoading`: the first page is not fetched, so there is no
        // in-flight request to report. The sidebar is waiting exactly while it
        // has no list yet — which also keeps the skeletons up rather than
        // claiming an empty workspace when the socket cannot connect.
        loading={workstreams.data === undefined || (guestSession && associativeNavigation.isPending)}
        spaces={spacesEnabled ? visibleSpaces : undefined}
        spacesReadOnly={guestSession}
        inactiveSpaces={visibleInactiveSpaces}
        spacesReady={spacesReady}
        // The rows on screen are the last ones the socket delivered and the
        // connection is down. They stay, marked out of date, with the one retry
        // there is: a list nothing fetches has nothing to refetch.
        spacesOutOfDate={guestSession ? associativeNavigation.isError : workspaceSocketState === 'unavailable'}
        onRetrySpaces={guestSession ? () => { void associativeNavigation.refetch(); } : reconnect}
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
          const archived = await api.archiveWorkstream(workstream.id);
          // No list invalidation: WorkstreamDO answers this write with a
          // directory tombstone. Until it arrives, retain the response as a
          // hidden row so an older directory page already in flight has no
          // empty slot to seed. The versioned tombstone removes that marker and
          // is still the authority that orders the removal against every other
          // producer.
          //
          // Leaving the screen is this handler's, though. The socket removes the
          // query but not the route, so the reader would be left on a work stream
          // the API no longer serves. The hidden marker has already removed the
          // row from every directory reader; naming it to the landing remains a
          // route-level fence as well. Detail and transcript data cannot wait
          // for the tombstone: the PATCH may succeed while the socket is down.
          holdCachedWorkstreamArchive(queryClient, archived);
          if (openWorkstreamId(location.pathname) === workstream.id) {
            openFirstWorkstream([workstream.id]);
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
            openFirstWorkstream(batchArchiveSkipIds(workstreams.data ?? [], filter));
          }
          return accepted;
        }}
        onChangeWorkstreamScope={async (workstream, scope) => {
          if (!api) return;
          const updated = await api.setWorkstreamScope(workstream.id, scope);
          // The fields this write moves on the server: `updated_at` is stamped
          // on every PATCH, while `last_people_activity_at` is not, so the
          // sidebar's sort key is deliberately left alone here.
          patchCachedWorkstream(queryClient, updated.id, { scope: updated.scope, updatedAt: updated.updatedAt });
        }}
        onMarkWorkstreamUnread={async (workstream) => {
          if (!api) return;
          const updated = await api.markWorkstreamUnread(workstream.id);
          patchCachedWorkstreamViewerState(queryClient, updated.id, updated);
          // Skipped rather than gone: the row stays, and opening it is what
          // would read it again.
          if (location.pathname === `/workstreams/${updated.id}`) openFirstWorkstream([updated.id]);
        }}
        onPinWorkstream={async (workstream, spaceId, pinned) => {
          if (!api) return false;
          return applyPinResponse(spaceId, () => pinned
            ? api.pinWorkstream(workstream.id, spaceId)
            : api.unpinWorkstream(workstream.id, spaceId));
        }}
        onReorderPinnedWorkstreams={async (spaceId, workstreamIds) => {
          if (!api) return;
          await applyPinResponse(spaceId, () => api.reorderWorkstreamPins(spaceId, workstreamIds));
        }}
        onRenameWorkstream={async (workstream, title) => {
          if (!api) return;
          const updated = await api.renameWorkstream(workstream.id, title);
          patchCachedWorkstream(queryClient, updated.id, { title: updated.title, titleStatus: updated.titleStatus, updatedAt: updated.updatedAt });
        }}
        onRunAutomation={async (automation) => {
          if (!api) return;
          await api.runAutomation(automation.id);
          // A run is a substream of the automation, listed on its screen, so
          // that is where a person who asked for one lands.
          await queryClient.invalidateQueries({ queryKey: ['automation-runs', automation.id] });
          void navigate(`/automations/${automation.id}`);
        }}
        onPreviewWorkstreamBatch={async (filter) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          return api.previewWorkstreamBatch(filter);
        }}
        onCreateChannel={async ({ name, spaceId }) => {
          void navigate(`/spaces/${spaceId}/workstreams/new`, {
            state: { channelName: name, returnTo: location.pathname },
          });
        }}
        onCreateSpace={async (input: CreateSpaceRequest) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const created = await api.createSpace(input);
          queryClient.setQueryData<SpaceDirectory>(
            SPACES_QUERY_KEY,
            (current) => upsertSpaceDirectory(current, created),
          );
          return created;
        }}
        {...channelSpaceHandlers}
        ordering={ordering}
        // One write for all three hand-arranged lists. The authority answers
        // with what it actually stored — a request may name an item the
        // container does not hold — and that answer goes straight into the
        // cache, so the arrangement does not flash back to its old order in
        // the frame between the response and the socket's republication.
        onReorderContainer={async (order) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const expected = queryClient.getQueryData<PersonalOrder>(PERSONAL_ORDER_QUERY_KEY);
          applyContainerOrder(queryClient, await api.reorderContainer(order), expected);
        }}
        onRestoreSpace={async (spaceId) => {
          if (!api) throw new Error('Your session is no longer active. Sign in again.');
          const restored = await api.restoreSpace(spaceId);
          queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
            ...current,
            items: current.items.filter((space) => space.id !== restored.id),
          } : current);
          queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
            ...current,
            items: current.items.some((space) => space.id === restored.id)
              ? current.items.map((space) => space.id === restored.id ? restored : space)
              : [...current.items, restored],
          } : current);
        }}
        onArchiveSpace={!hasLiveSpaceArchiveAuthority(workspaceSocketState, sidebarConnect)
          ? undefined : archiveSpaceMutationHandler(
          api,
          queryClient,
          () => currentPathname.current,
          openFirstWorkstream,
          () => shellMounted.current,
        )}
        onSignOut={() => {
          void signOut().catch(() => undefined);
        }}
        hasMoreWorkstreams={workstreams.hasMore}
        loadingMoreWorkstreams={workstreams.isFetchingMore}
        onLoadMoreWorkstreams={workstreams.fetchMore}
        // A walk that failed says so through the query; the Spaces it did not
        // reach stop drawing placeholders rather than waiting for it.
        loadedSpaceIds={sidebarConnect?.channelsBySpace && !workstreams.isError ? loadedSpaceIds : undefined}
        onViewSpace={prioritizeSpace}
        workspace={workspace}
        workstreams={sidebarWorkstreams}
      />
        <span aria-live="polite" className="sr-only">
          {switchingWorkspace ? `Opening ${switchingWorkspace.name}…` : ''}
        </span>
        <main className="main-pane">
          {children}
        </main>
      </div>
      {api && <SearchModal key={`${workspace.id}:${workspace.currentUser.id}`} workspaceId={`${workspace.id}:${workspace.currentUser.id}`}
        open={searchOpen} onOpenChange={setSearchOpen}
        search={(request, signal) => api.searchWorkspace(request, signal)}
        onSelect={(result) => {
          const target = result.location;
          if (target.kind === 'message') {
            navigate(`/workstreams/${target.workstreamId}?substream=${encodeURIComponent(target.substreamId)}&turn=${encodeURIComponent(target.turnId)}&sequence=${target.transcriptSequence}`);
          } else if (target.kind === 'link') {
            void openLink(target.url);
          } else {
            setSearchPreview({ identity: searchIdentity, preview: { name: result.title, ...(target.mimeType ? { mimeType: target.mimeType } : {}), loadContent: (signal) => api.getSearchResourcePreviewContent(target.resourceId, signal) } });
          }
        }} />}
      <AttachmentLightbox key={`lightbox:${searchIdentity}`} preview={searchPreview?.identity === searchIdentity ? searchPreview.preview : null} onClose={() => setSearchPreview(null)} />
    </>
  );
}
