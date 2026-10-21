import { BreakoutMenu, ChannelMenu, type ConversationRowTarget } from '@rally/ui/components/conversation-menus';
import type { BreakoutMark } from '@rally/ui/components/breakout-marks';
import { SplitConversationLayout, type SplitConversationMode } from '@rally/ui/components/split-conversation';
import { TitlePillClose, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { WorkstreamGlyph, workstreamMark } from '@rally/ui/components/workstream-glyph';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchThroughOwner } from '../lib/fetch-through-owner';
import { PaneVisibility } from '../lib/pane-visibility';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { copyWorkstreamLink } from '../lib/copy-workstream-link';
import { asSubstreamId, asWorkspaceId, asWorkstreamId, conversationNeedsViewer, type ConversationMergeResult, type HarnessStatus } from '@rally/contracts';
import { logError } from '../../common/logger';
import { useCollaborationSession, useOptionalCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import { mainOmitted, mainReachable, useConversationDirectory } from '../lib/conversation-directory';

import { layoutKey, readLayout, writeLayout } from '../lib/desktop-layout';
import { reportTelemetryProductIntent, telemetryVisibility, uuidV7 } from '../lib/telemetry';
import { holdCreationTraceUntilSendReady, startPerfTrace } from '../lib/perf-trace';

import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';
import { AppearancePicker, AppearanceSubmenu } from '../components/appearance-picker';
import { IconPalette } from '@tabler/icons-react';
import { RelativeTime } from '../components/relative-time';

import type { WorkstreamChildDirectory } from '../lib/channel-viewer-state';
import type { MessageMergedInto, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { EmailMentionContext, emailMentionDirectory, NO_INVITEES, useWorkspaceInvitees } from '../lib/workspace-invitees';
import { useRetainedWorkstreamSocket } from '../lib/workstream-socket-pool';
import { Button, InlineError, Modal, TitleSkeleton } from '../components/primitives';
import { SessionImportUpdateDialog, importedSourceUpdatable } from '../components/session-import-update-dialog';

import { useCachedWorkstreamAppearance, useCachedWorkstreamSummary } from '../lib/use-workstreams-query';
import { useMergeChannels } from '../lib/use-merge-channels';
import { launchedSubstreamDetail, optimisticOpeningTranscript } from '../lib/launched-conversation';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import { patchCachedWorkstream, workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { archiveThread, resolutionFailure, resolveConversation } from '../lib/thread-lifecycle';
import { ArchiveConversationModal } from '../components/archive-conversation-modal';
import { SidekickPicker } from '../components/sidekick-picker';
import { openMemorySource, useMemoryFacts, type MemoryFacts } from '../components/memory-review';
import { workstreamSidekickRows } from '../components/sidekick-section';
import { useChannelRail } from '../lib/channel-rails';
import { type LaunchingSubstream, type SubstreamLaunchProps } from '../components/substream-launch';
import { ConversationOpeningSkeleton, ConversationSurface, mergeLabel, mergeTargetFor, workspaceMemberFromSession, type ConversationHeaderContext, type ScrollToTurnRequest } from './conversation-surface';
import { useSpaceDirectories } from '../lib/use-space-directories';

// The feed, composer and rail live in `conversation-surface.tsx`, shared with
// the automation screen. The helpers below are re-exported so the tests and
// screens that reached them through this module keep their import.
export {
  AddParticipantDialog,
  AddResourceDialog,
  RunFailureNotice,
  WorkstreamErrorState,
  acceptedMessageOverlayDeliveryState,
  branchProvenance,
  conversationReadAcknowledgement,
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  manualElicitationResponse,
  orderedTranscriptOwnsRunTiming,
  resourceVersionsQueryKey,
  workspaceMemberFromSession,
  workstreamPayloadBelongsToRoute,
  workstreamPresenceViewers,
  workstreamRunTiming,
  workstreamShowsReadyState,
} from './conversation-surface';

import { useOpenFirstWorkstream } from '../lib/workstream-landing';
import { channelRoute, revealChannelMessageState, useChannelPane, usePaneExpansion } from '../lib/navigation-routes';
import { expandToggle } from '../components/pane-expand-toggle';
import { usePinAction, usePinnedIds } from '../lib/pins';
import { spaceFailureSentence } from '../lib/space-failure-copy';
import { normalizeHarnessStatus } from '../lib/api';

type RailAttentionProjection = {
  harnessStatus?: HarnessStatus;
  unreadCount?: number;
  youAreMentioned?: boolean;
  unseen?: boolean;
  needsAttention?: boolean;
};

/** Viewer projections outlive the opened detail and also cover unopened siblings. */
export function railConversationNeedsAttention(
  projection: RailAttentionProjection,
  selectedDetail?: WorkstreamDetail,
): boolean | undefined {
  // Guest navigation is a snapshot; the selected child's open detail is newer.
  if (projection.needsAttention !== undefined) {
    return selectedDetail ? conversationNeedsViewer(selectedDetail) : projection.needsAttention;
  }
  if (projection.harnessStatus === undefined && projection.unreadCount === undefined
    && projection.youAreMentioned === undefined && projection.unseen === undefined) {
    return selectedDetail ? conversationNeedsViewer(selectedDetail) : undefined;
  }
  return conversationNeedsViewer({
    harnessStatus: projection.harnessStatus
      ? normalizeHarnessStatus(projection.harnessStatus)
      : selectedDetail?.harnessStatus ?? 'completed',
    hasUnread: projection.unreadCount === undefined ? selectedDetail?.hasUnread : projection.unreadCount > 0,
    youAreMentioned: projection.youAreMentioned ?? selectedDetail?.youAreMentioned,
    unseen: projection.unseen ?? selectedDetail?.unseen,
  });
}

/** Whether the conversation's run is paused on a question; the open detail is newer than the row. */
export function railConversationNeedsInput(
  projection: RailAttentionProjection,
  selectedDetail?: WorkstreamDetail,
): boolean {
  return (selectedDetail?.harnessStatus ?? projection.harnessStatus) === 'needs_input';
}

export function railChildrenWithAttention<T extends RailAttentionProjection & { substreamId: string }>(
  directory: readonly T[] | undefined,
  selectedSubstreamId: string,
  selectedDetail?: WorkstreamDetail,
): (T & { needsAttention?: boolean; needsInput: boolean })[] | undefined {
  return directory?.map((child) => {
    const detail = child.substreamId === selectedSubstreamId ? selectedDetail : undefined;
    return {
      ...child,
      needsAttention: railConversationNeedsAttention(child, detail),
      needsInput: railConversationNeedsInput(child, detail),
    };
  });
}

type WorkstreamSidebarFailure =
  | 'copy_link'
  | 'make_public'
  | 'make_private'
  | 'rename_workstream'
  | 'rename_substream'
  | 'archive_workstream'
  | 'archive_substream';

interface FailureCopy { title: string; copy: string }

/** A failure is one of the fixed actions, or a refusal whose own sentence says what to change. */
function failureCopyOf(failure: WorkstreamSidebarFailure | FailureCopy): FailureCopy {
  return typeof failure === 'string' ? workstreamSidebarFailureCopy[failure] : failure;
}

const workstreamSidebarFailureCopy: Record<WorkstreamSidebarFailure, FailureCopy> = {
  copy_link: { title: 'The link couldn’t be copied', copy: 'The link couldn’t be copied. Try again.' },
  make_public: { title: 'The thread couldn’t be updated', copy: 'The thread couldn’t be made public. Try again.' },
  make_private: { title: 'The thread couldn’t be updated', copy: 'The thread couldn’t be made private. Try again.' },
  rename_workstream: { title: 'The thread couldn’t be renamed', copy: 'The thread couldn’t be renamed. Try again.' },
  rename_substream: { title: 'The breakout couldn’t be renamed', copy: 'The breakout couldn’t be renamed. Try again.' },
  archive_workstream: { title: 'The thread couldn’t be archived', copy: 'The thread couldn’t be archived. Try again.' },
  archive_substream: { title: 'The breakout couldn’t be archived', copy: 'The breakout couldn’t be archived. Try again.' },
};

/**
 * A work stream: the shared conversation surface under the work-stream header.
 * A pending row mounts nothing that dials or reads its room, only a captioned
 * skeleton; see `keepPendingWorkstreams`.
 */
export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const row = useCachedWorkstreamSummary(id);
  if (row?.pending) return <PendingWorkstreamScreen row={row} />;
  return <OpenWorkstreamScreen />;
}

/**
 * The opening as the room will draw it, with the same email-mention directory
 * the composer and the open conversation use, so no chip changes when the
 * create answers. The session is optional: an import's screen is mounted
 * without one, and it needs the API only to read previews.
 */
function PendingWorkstreamScreen({ row }: { row: WorkstreamSummary }): React.JSX.Element {
  const api = useOptionalCollaborationSession()?.api;
  const { guest } = useShellCapabilities();
  // Stable, so a pending-row update does not restart the previews' reads.
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal),
    [api],
  );
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const invitees = useWorkspaceInvitees(api, !guest);
  const emailMentions = useMemo(
    () => emailMentionDirectory(members.data ?? [], invitees.data ?? NO_INVITEES),
    [members.data, invitees.data],
  );
  return (
    <EmailMentionContext.Provider value={emailMentions}>
      <ConversationOpeningSkeleton
        caption
        label={row.pendingOrigin === 'import' ? 'Importing conversation…' : 'Starting…'}
        loadAttachmentContent={api ? loadAttachmentContent : undefined}
        openingAuthorId={row.createdByUserId}
        openingMessage={row.pendingOpening}
        parentKind="workstream"
      />
    </EmailMentionContext.Provider>
  );
}

function OpenWorkstreamScreen(): React.JSX.Element {
  const pinnedThreads = usePinnedIds('thread');
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { api, session } = useCollaborationSession();
  const [importUpdateOpen, setImportUpdateOpen] = useState(false);
  const queryClient = useQueryClient();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const selectedSubstreamId = searchParams.get('substream') || '0';
  const { guest } = useShellCapabilities();
  const activeSpaces = useSpaceDirectories().active.data;
  const conversationDirectory = useConversationDirectory();
  const directoryEntry = conversationDirectory?.workstreams.find((item) => item.parentId === id);
  const row = useCachedWorkstreamSummary(id);
  // Scoped to the conversations the directory lists when Main is not theirs,
  // by their row or the conversation directory (`mainReachable`): somebody in
  // a Breakout of a Channel whose Main they may not open.
  const conversationScoped = mainReachable(row, conversationDirectory, id) === false;
  // Changing the Channel itself (its audience, name, mark, pin, archive) goes
  // through `/workstreams` and the pin RPC, which take a member who can open
  // Main. A guest reads Main when they take part in it, and changes it never.
  const channelWritable = !conversationScoped && !guest;
  // Parent chrome remains live even on a direct link into a child. Reuse the
  // retained Main connection rather than deriving its inventory from the child.
  // A child grant proves nothing about Main; keep that host scoped to its child.
  // Main is on screen beside any Breakout unless it is not this person's: a
  // Breakout grant proves nothing about Main.
  const mainVisible = selectedSubstreamId === '0' || !conversationScoped;
  const mainConnection = useRetainedWorkstreamSocket(api, id, Boolean(api && id && !conversationScoped), 'workstream', '0');
  const parent = useQuery<WorkstreamDetail | undefined>({
    queryKey: ['workstream', id], queryFn: fetchThroughOwner, enabled: false,
  });
  const importedSource = useQuery({
    queryKey: ['workstream-import-source', session?.user.id, id],
    queryFn: () => api!.importedSessionSource(id),
    // Imports are a member's; a guest's route refuses the read.
    enabled: Boolean(api && session?.user.id && id && !guest),
    staleTime: Number.POSITIVE_INFINITY,
  });
  // The rail's mark follows the sidebar row rather than this detail, so one
  // appearance change moves both rails together instead of moving the sidebar
  // now and this rail when the projection lands. The header keeps the detail:
  // that entry is what retires the picker's own preview.
  const rowAppearance = useCachedWorkstreamAppearance(id);
  const children = useQuery<WorkstreamChildDirectory | undefined>({
    queryKey: ['workstream-children', id], queryFn: fetchThroughOwner, enabled: false,
  });
  const sharedParent = conversationScoped ? directoryEntry : undefined;
  const linkSpaceIds = parent.data?.spaceIds ?? conversationDirectory?.spaces
    .filter((space) => space.workstreamIds.includes(id))
    .sort((a, b) => Number(a.scope === 'personal') - Number(b.scope === 'personal') || a.id.localeCompare(b.id))
    .map((space) => space.id) ?? [];
  const requestedSpaceId = searchParams.get('space');
  const linkSpaceId = requestedSpaceId && linkSpaceIds.includes(requestedSpaceId)
    ? requestedSpaceId : linkSpaceIds[0] ?? null;
  // The open substream's own detail, for its row in the rail below. Its title
  // and the header's are then one value rather than two that agree eventually.
  const openChild = useQuery<WorkstreamDetail | undefined>({
    queryKey: workstreamDetailQueryKey(id, selectedSubstreamId),
    queryFn: fetchThroughOwner,
    enabled: false,
  });
  /**
   * The rail's rows, with the open substream's own name on its own row.
   *
   * Every row here is the parent's copy, which converges a Queue round trip
   * after a child is renamed — long enough, on the naming pass that follows
   * every creation, that the row for the conversation on screen disagreed with
   * the header above it. A child is the authority on its own name and this
   * window holds that answer for the child it has open: the same detail the
   * header renders, so the two cannot say different things.
   *
   * Read here rather than written back into the directory, and only for the
   * open child. `docs/substream-creation.md` holds why each of those is so, and
   * what writing it back cost when it was tried.
   */
  const directoryChildren = sharedParent
    ? sharedParent.conversations.filter((item) => item.substreamId !== '0' && !item.archived).map((item) => {
        const live = children.data?.privateChildren?.find((child) => child.substreamId === item.substreamId);
        return {
          ...(live ?? {
            substreamId: item.substreamId,
            title: item.title,
            createdByUserId: session?.user.id ?? '',
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
          }),
          resolved: live?.resolved ?? item.resolved,
          scope: item.scope,
          originTurnId: live?.originTurnId ?? item.originTurnId ?? null,
          ...(live?.appearance ?? item.appearance ? { appearance: live?.appearance ?? item.appearance } : {}),
          ...(live || item.needsAttention === undefined ? {} : { needsAttention: item.needsAttention }),
          // Until the private list answers, the author and dates above are
          // stand-ins; a byline must not name them.
          ...(live ? {} : { standIn: true as const }),
        };
      })
    : children.data?.privateChildren;
  const namedChildren = directoryChildren?.map((child) =>
    child.substreamId === selectedSubstreamId
      ? {
          ...child,
          ...(openChild.data?.title ? { title: openChild.data.title } : {}),
          ...(child.appearance === undefined && openChild.data?.appearance
            ? { appearance: openChild.data.appearance }
            : {}),
        }
      : child);
  const railChildren = railChildrenWithAttention(namedChildren, selectedSubstreamId, openChild.data);
  // One target per dialog rather than one shared "menu target": both can be
  // open in sequence on different rows, and a single slot would make cancelling
  // one clear the other's subject out from under it.
  const [renameTarget, setRenameTarget] = useState<(ConversationRowTarget & { parentId: string }) | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<(ConversationRowTarget & { parentId: string }) | null>(null);
  const [substreamPending, setSubstreamPending] = useState(false);
  const [substreamMenuFailure, setSubstreamMenuFailure] = useState<WorkstreamSidebarFailure | FailureCopy | null>(null);
  const selectedAppearance = selectedSubstreamId === '0'
    ? parent.data?.appearance
    : railChildren?.find((child) => child.substreamId === selectedSubstreamId)?.appearance
      ?? openChild.data?.appearance;
  /**
   * The substream being written, if any. Nothing has been reserved on the
   * server while this is set: preparation and confirmation both happen on the
   * keystroke that submits the composer, so leaving the surface is free and a
   * substream nobody finished writing never exists.
   */
  const [creation, setCreation] = useState<{
    parentId: string;
    throughTurnId: string | null;
    /**
     * Minted once, when the surface opens, and kept across every attempt.
     *
     * These are what make a retry a retry. Both halves of creation are
     * idempotent under them — the operation resumes rather than reserving a
     * second child, and the turn replays rather than being said twice — and a
     * lost response is the failure this path actually has, since the composer
     * hands the words back and the obvious thing to do is press enter again.
     * Fresh ids per attempt would turn that into a second substream.
     */
    operationId: string;
    clientMessageId: string;
    /** A suggestion's drafted opening prompt, seeded into the launch composer once. */
    initialDraft?: string | undefined;
  } | null>(null);
  const [launching, setLaunching] = useState<LaunchingSubstream | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const creationRef = useRef(creation);
  creationRef.current = creation;
  const selectSubstream = (substreamId: string): void => {
    // Going anywhere is how the launch surface is left. Nothing was reserved
    // for it, so there is nothing to cancel — only a draft to leave behind,
    // which its composer keeps under its own key for the next time.
    resetCreation();
    const next = new URLSearchParams(searchParams);
    next.delete('turn');
    next.delete('sequence');
    if (substreamId === '0') next.delete('substream');
    else next.set('substream', substreamId);
    setSearchParams(next, { replace: true });
  };
  const previousChildren = useRef<{ parentId: string; ids: Set<string> }>({ parentId: id, ids: new Set() });
  const restoredBreakout: unknown = location.state && typeof location.state === 'object'
    && 'restoredBreakout' in location.state ? location.state.restoredBreakout : null;
  useEffect(() => {
    if (!children.data && !(conversationScoped && conversationDirectory)) return;
    const ids = new Set<string>((directoryChildren ?? []).map((child) => child.substreamId));
    // A list seeded from the device carries no version and may predate the
    // restored breakout, so only a live one may say it is gone.
    const live = sharedParent !== undefined || children.data?.stateVersion !== undefined;
    if ((previousChildren.current.parentId === id && previousChildren.current.ids.has(selectedSubstreamId)
      || live && restoredBreakout === selectedSubstreamId) && !ids.has(selectedSubstreamId)) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('substream'); next.delete('turn'); next.delete('sequence');
        return next;
      }, { replace: true });
    }
    previousChildren.current = { parentId: id, ids };
  }, [children.data, conversationDirectory, conversationScoped, id, selectedSubstreamId, restoredBreakout, setSearchParams, sharedParent]);
  // A link that names no conversation opens Main, which a Channel reached only
  // through some of its conversations does not offer: open the first it lists,
  // as its sidebar row does.
  const firstListedSubstreamId = directoryEntry && mainOmitted(directoryEntry)
    ? (directoryEntry.conversations.find((item) => !item.archived) ?? directoryEntry.conversations[0])?.substreamId
    : undefined;
  useEffect(() => {
    if (selectedSubstreamId !== '0' || !firstListedSubstreamId) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('substream', firstListedSubstreamId);
      return next;
    }, { replace: true });
  }, [firstListedSubstreamId, selectedSubstreamId, setSearchParams]);
  const routeRef = useRef({ id, selectedSubstreamId, routeKey: location.key, visit: 0 });
  routeRef.current = { id, selectedSubstreamId, routeKey: location.key,
    visit: routeRef.current.visit + Number(routeRef.current.routeKey !== location.key) };
  useEffect(() => () => { routeRef.current.visit += 1; }, []);
  const reportParentAction = (workstream: WorkstreamSummary, action: 'rename' | 'archive' | 'make_public' | 'make_private'): void => {
    reportTelemetryProductIntent({
      kind: 'workstream_action_completed', workstreamId: workstream.id, action,
      visibility: telemetryVisibility(workstream.scope),
      origin: workstream.systemKind ? 'system' : 'ad_hoc', pinned: pinnedThreads.has(workstream.id),
    });
  };
  const menuOperation = useRef(0);
  const copyRowLink = (target: ConversationRowTarget): void => {
    if (!session?.workspace) return;
    const workspace = session.workspace;
    const visit = routeRef.current.visit;
    const operation = ++menuOperation.current;
    void copyWorkstreamLink({ region: workspace.region, workspaceId: workspace.id }, linkSpaceId, id, target.substreamId).catch(() => {
      if (routeRef.current.visit === visit && menuOperation.current === operation) {
        setSubstreamMenuFailure('copy_link');
      }
    });
  };
  const setPublic = (next: boolean): void => {
    if (!api || substreamPending) return;
    const visit = routeRef.current.visit;
    const action = next ? 'make_public' : 'make_private';
    const operation = ++menuOperation.current;
    setSubstreamPending(true);
    void api.setWorkstreamScope(id, next ? 'workspace' : 'personal').then((updated) => {
      patchCachedWorkstream(queryClient, id, { scope: updated.scope, updatedAt: updated.updatedAt });
      reportParentAction(updated, action);
    }).catch((cause: unknown) => {
      // Not over a newer menu action, or after leaving for another conversation.
      if (routeRef.current.visit !== visit || menuOperation.current !== operation) return;
      // A refusal names what to change first; anything else is the action's
      // own retry sentence.
      const fallback = workstreamSidebarFailureCopy[action];
      setSubstreamMenuFailure({ title: fallback.title, copy: spaceFailureSentence(cause, fallback.copy) });
      // Selecting a Breakout changes the visit without the reset a new Channel
      // gets, so the pending flag is released by Channel, not by visit.
    }).finally(() => { if (routeRef.current.id === id) setSubstreamPending(false); });
  };
  const submitSubstreamRename = async (): Promise<void> => {
    const target = renameTarget;
    const title = renameTitle.trim();
    if (!api || !target || !title || substreamPending) return;
    if (title === target.title) { setRenameTarget(null); return; }
    const visit = routeRef.current.visit;
    setSubstreamPending(true);
    setSubstreamMenuFailure(null);
    try {
      // Match header renaming: a conversation-scoped Main is its own authority.
      if (target.substreamId === '0' && channelWritable) {
        const updated = await api.renameWorkstream(target.parentId, title);
        patchCachedWorkstream(queryClient, target.parentId, { title: updated.title, titleStatus: updated.titleStatus, updatedAt: updated.updatedAt });
        reportParentAction(updated, 'rename');
      } else await api.renameSubstream(target.parentId, target.substreamId, title);
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setRenameTarget(null);
    } catch {
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setSubstreamMenuFailure(target.substreamId === '0' ? 'rename_workstream' : 'rename_substream');
    } finally {
      if (routeRef.current.id === target.parentId && routeRef.current.visit === visit) setSubstreamPending(false);
    }
  };
  const submitSubstreamArchive = async (): Promise<void> => {
    const target = archiveTarget;
    if (!api || !target || substreamPending) return;
    const visit = routeRef.current.visit;
    setSubstreamPending(true);
    setSubstreamMenuFailure(null);
    try {
      const archiveApplied = target.substreamId === '0'
        ? await archiveThread(api, queryClient, target.parentId, pinnedThreads.has(target.parentId))
        : (await api.setSubstreamArchived(target.parentId, target.substreamId, true), true);
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setArchiveTarget(null);
      if (target.substreamId === '0') {
        if (archiveApplied) openFirstWorkstream([target.parentId]);
      } else if (routeRef.current.selectedSubstreamId === target.substreamId) selectSubstream('0');
    } catch {
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setSubstreamMenuFailure(target.substreamId === '0' ? 'archive_workstream' : 'archive_substream');
    } finally {
      if (routeRef.current.id === target.parentId && routeRef.current.visit === visit) setSubstreamPending(false);
    }
  };
  /**
   * Whether the attempt on screen has reserved anything on the server.
   *
   * Nothing is reserved while the surface is merely open — that is the
   * flow's own promise — but a submit that failed after `prepare` leaves a
   * reserved child and a spent summary behind it, and the surface stays open
   * over it. Leaving is where that gets cancelled, so leaving has to know.
   */
  const preparedRef = useRef(false);
  const resetCreation = (): void => {
    const abandoned = preparedRef.current ? creationRef.current : null;
    preparedRef.current = false;
    creationRef.current = null;
    setCreation(null); setLaunching(null); setCreationError(null);
    // Best effort by design: the endpoint refuses an operation that is already
    // confirming or ready, which is exactly when there is nothing to release.
    if (api && abandoned) {
      void api.cancelSubstream(abandoned.parentId, abandoned.operationId).catch(() => undefined);
    }
  };
  const startCreation = (throughTurnId: string | null, initialDraft?: string): void => {
    // As `openBreakout` does: a panel the thread holds would hide the new
    // breakout's launch surface.
    const rail = useUiStore.getState();
    if (rail.railOpen && rail.railScope === id) rail.closeRail();
    resetCreation();
    setCreation({
      parentId: id,
      throughTurnId,
      operationId: uuidV7(),
      clientMessageId: crypto.randomUUID(),
      ...(initialDraft ? { initialDraft } : {}),
    });
  };
  useEffect(() => {
    setRenameTarget(null); setArchiveTarget(null); setSubstreamPending(false); setSubstreamMenuFailure(null);
    // Only when the work stream itself changed. Selecting another conversation
    // inside it is how the launch surface is left, and that already clears it.
    if (creationRef.current && creationRef.current.parentId !== id) resetCreation();
    // A new navigation, including the same Thread under another Channel,
    // owns new dialogs and pending state even if the conversation id is unchanged.
  }, [id, selectedSubstreamId, location.key]);
  /**
   * Create the substream the launch surface is holding, and send its first
   * message.
   *
   * Both halves of the creation are on this keystroke: preparation freezes the
   * main conversation through the branch point and summarizes it, and
   * confirmation writes the child, installs that context and admits the
   * opening turn. The person is not waiting in front of either — the surface
   * below has already drawn the turn they typed, and the substream is being
   * opened around it.
   */
  const createSubstream = async (opening: Parameters<SubstreamLaunchProps['onCreate']>[0]): Promise<void> => {
    const attempt = creationRef.current;
    if (!api || !attempt) throw new Error('This thread is not ready for a new breakout.');
    const createdAt = new Date().toISOString();
    const trace = startPerfTrace('substream_create', { operationId: attempt.operationId });
    const startedAt = performance.now();
    // In the same commit as the request, not after it: this is what makes the
    // substream appear to open on the keystroke rather than on the response.
    setLaunching({
      attachments: opening.attachments,
      createdAt,
      text: opening.text,
      mentions: opening.mentions,
      startedAt: Date.parse(createdAt),
    });
    setCreationError(null);
    try {
      await trace.step('prepare_request', () => api.prepareSubstream(attempt.parentId, {
        operationId: attempt.operationId, throughTurnId: attempt.throughTurnId,
      }));
      // From here the operation holds a reserved child, so leaving the surface
      // has something to release.
      if (creationRef.current === attempt) preparedRef.current = true;
      const created = await trace.step('confirm_request', () => api.confirmSubstream(
        attempt.parentId,
        attempt.operationId,
        {
          clientMessageId: attempt.clientMessageId,
          text: opening.text,
          mentions: opening.mentions,
          attachmentIds: opening.attachmentIds,
          confirmedParticipantUserIds: opening.confirmedParticipantUserIds,
        },
        opening.modelOverride,
      ));
      // Shared once the breakout exists, and not awaited: it opens on the
      // create alone, and the address is among its People as Invited when this
      // lands. A failure leaves them out of that list, which is where to look.
      if (opening.invitedEmails.length > 0 && session?.workspace) {
        const workspaceId = session.workspace.id;
        void Promise.resolve().then(() => api.createScopeInvitations({
          operationId: uuidV7(),
          parentId: attempt.parentId,
          emails: [...opening.invitedEmails].sort(),
          targets: [{
            kind: 'conversation',
            workspaceId: asWorkspaceId(workspaceId),
            parentId: asWorkstreamId(attempt.parentId),
            substreamId: asSubstreamId(created.substreamId),
          }],
          completeWorkstream: false,
          expiresAt: null,
        }))
          .then(() => queryClient.invalidateQueries({ queryKey: ['scope-invitations', attempt.parentId, created.substreamId] }))
          .catch((error: unknown) => logError('rally', `could not share the new breakout with ${opening.invitedEmails.join(', ')}`, error));
      }
      const current = creationRef.current === attempt;
      if (!current) trace.end({ outcome: 'superseded' });
      else trace.annotate({ workstreamId: attempt.parentId });
      const parentDetail = queryClient.getQueryData<WorkstreamDetail>(workstreamDetailQueryKey(id, '0'));
      const creator = workspaceMemberFromSession(session);
      // Seeded before the navigation, both of them: the child's screen shows
      // its full-screen opening state while *either* the detail or the
      // transcript is missing, so one without the other still flashes it.
      //
      // Seeded even for an attempt abandoned mid-flight — by selecting another
      // conversation, the one way out left once submission has begun. That
      // substream exists and is working on the message that created it, so the
      // screen it is eventually opened on should paint what this response
      // already knows rather than load it again.
      if (parentDetail && creator && created.opening) {
        const detail = launchedSubstreamDetail(parentDetail, {
          creator,
          title: created.title,
          createdAt: created.opening.createdAt,
          modelOverride: opening.modelOverride,
        });
        queryClient.setQueryData(workstreamDetailQueryKey(id, created.substreamId), detail);
        queryClient.setQueryData(
          orderedTranscriptQueryKey(id, created.substreamId),
          optimisticOpeningTranscript({
            turnId: created.opening.turnId,
            clientMessageId: created.opening.clientMessageId,
            createdAt: created.opening.createdAt,
            text: opening.text,
            mentions: opening.mentions,
            attachments: opening.attachments,
          }, creator, members.data ?? []),
        );
      }
      // Nothing else is this attempt's to do: it is not the one on screen, so
      // it neither clears that surface nor navigates anybody.
      if (!current) return;
      // Created, so there is nothing left to cancel — and `cancelSubstream`
      // refuses a ready operation anyway.
      preparedRef.current = false;
      trace.mark('cache_seed');
      holdCreationTraceUntilSendReady(
        trace,
        attempt.parentId,
        created.substreamId,
        Math.max(0, performance.now() - startedAt),
      );
      resetCreation();
      selectSubstream(created.substreamId);
    } catch (error) {
      trace.end({ outcome: 'failed', workstreamId: attempt.parentId });
      // Back to the composer with the words still in it. The optimistic turn
      // stood for a substream that does not exist, so it cannot stay on screen
      // next to an error about why it never will. Only the surface's own state
      // is skipped for an attempt that was abandoned mid-flight; the rejection
      // is not, because that is what puts the draft and its attachments back —
      // swallowing it would report a send that never happened, and take the
      // words with it.
      if (creationRef.current === attempt) {
        setLaunching(null);
        setCreationError('The breakout couldn’t be created. Try again.');
      }
      throw error;
    }
  };
  // The Channel's people, Sidekicks and artifacts as the workspace socket
  // already holds them, for the menus drawn before a snapshot answers.
  const channelRail = useChannelRail(id);
  // The roster App holds for the session, read on its own terms.
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api && !guest),
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Pending until every participant can be named: a partial facepile would
  // grow when the snapshot lands, and an empty one would say nobody is here.
  const railParticipantList = channelRail && members.data
    ? channelRail.participantUserIds.map((userId) => members.data.find((member) => member.id === userId))
    : undefined;
  const railParticipants = railParticipantList?.every((member) => member !== undefined)
    ? railParticipantList.filter((member) => member !== undefined)
    : undefined;
  const railSidekicks = channelRail && channelRail.sidekicks.attached
    ? workstreamSidekickRows({
      owned: channelRail.sidekicks.owned,
      recommended: channelRail.sidekicks.recommended,
      attached: channelRail.sidekicks.attached,
    })
    : undefined;
  const railTitle = parent.data?.title ?? row?.title ?? sharedParent?.title ?? undefined;
  const channelAppearance = rowAppearance ?? parent.data?.appearance ?? sharedParent?.appearance;
  const breakoutMarks = useMemo<BreakoutMark[] | undefined>(() => railChildren?.map((child) => ({
    substreamId: child.substreamId,
    resolved: 'resolved' in child ? child.resolved : undefined,
    title: child.title,
    appearance: child.appearance,
    originTurnId: child.originTurnId ?? null,
    lastActivityAt: ('lastActivityAt' in child ? child.lastActivityAt : undefined) ?? child.updatedAt,
    createdAt: child.createdAt,
    createdByUserId: 'standIn' in child ? undefined : child.createdByUserId,
    unreadCount: 'unreadCount' in child ? child.unreadCount : undefined,
    youAreMentioned: 'youAreMentioned' in child ? child.youAreMentioned : undefined,
    unseen: 'unseen' in child ? child.unseen : undefined,
    needsAttention: child.needsAttention,
    needsInput: child.needsInput,
  })), [railChildren]);
  const breakoutAge = (breakout: BreakoutMark): React.ReactNode => breakout.lastActivityAt
    ? <RelativeTime value={breakout.lastActivityAt} />
    : null;

  // Which panes are on screen. The right slot is one place: a Breakout open
  // beside its Channel takes it, and a panel either conversation opens takes
  // it from the other, which is hidden but stays mounted.
  const openBreakoutId = selectedSubstreamId !== '0' ? selectedSubstreamId : null;
  // The Thread's and the open Breakout's own facts, each read once its Memory
  // level opens. A reader scoped to a Breakout cannot open the Thread's Main,
  // so the Thread's are not theirs to review.
  const threadMemory = useMemoryFacts({
    queryKey: ['memory', 'conversation', id, '0'],
    read: (signal) => api!.getConversationMemory(id, '0', signal),
    forget: (factId) => api!.forgetConversationMemory(id, '0', factId),
    enabled: api !== null && !conversationScoped,
    lazy: true,
  });
  const breakoutMemory = useMemoryFacts({
    queryKey: ['memory', 'conversation', id, openBreakoutId ?? ''],
    read: (signal) => api!.getConversationMemory(id, openBreakoutId!, signal),
    forget: (factId) => api!.forgetConversationMemory(id, openBreakoutId!, factId),
    enabled: api !== null && openBreakoutId !== null,
    lazy: true,
  });
  const creatingHere = creation?.parentId === id;
  const breakoutPaneOpen = openBreakoutId !== null || creatingHere;
  const railScope = useUiStore((state) => state.railScope);
  const storeRailOpen = useUiStore((state) => state.railOpen);
  const closeRail = useUiStore((state) => state.closeRail);
  const pinThread = usePinAction(api);
  const breakoutScope = openBreakoutId === null ? null : `${id}:${openBreakoutId}`;
  const breakoutOwnsRail = storeRailOpen && breakoutScope !== null && railScope === breakoutScope;
  const mainOwnsRail = storeRailOpen && railScope === id;
  // A breakout expanded over its thread. A panel the breakout opens ends it.
  const { expanded: breakoutExpanded, setExpanded: setBreakoutExpanded } = usePaneExpansion(openBreakoutId);
  if (breakoutOwnsRail && breakoutExpanded) setBreakoutExpanded(false);
  const splitMode: SplitConversationMode = !breakoutPaneOpen ? 'main'
    : !mainVisible || breakoutOwnsRail || breakoutExpanded ? 'breakout'
      : mainOwnsRail ? 'main' : 'split';
  // What the layout shows, which is the breakout alone in a window too narrow
  // for the split: the thread then rides as the breakout's breadcrumb.
  const [shownMode, setShownMode] = useState<SplitConversationMode>(splitMode);
  const breakoutWidthKey = layoutKey(session?.workspace?.id ?? 'unbound', session?.user.id ?? 'unbound', 'breakout-width');
  const [breakoutWidth, setBreakoutWidth] = useState<number | null>(() => {
    const stored = Number.parseFloat(readLayout(breakoutWidthKey) ?? '');
    return Number.isFinite(stored) ? stored : null;
  });
  // Beside a Channel, this thread is the right of two panes. Opening a
  // breakout or a panel needs both panes for itself, so the Channel steps off
  // screen and rides as the first breadcrumb instead
  // (`docs/pane-stack.md`).
  const channelPane = useChannelPane();
  const navigate = useNavigate();
  const threadUsesTwoPanes = breakoutPaneOpen || mainOwnsRail;
  const setThreadUsesTwoPanes = channelPane?.setThreadUsesTwoPanes;
  useEffect(() => {
    setThreadUsesTwoPanes?.(threadUsesTwoPanes);
  }, [setThreadUsesTwoPanes, threadUsesTwoPanes]);
  useEffect(() => () => setThreadUsesTwoPanes?.(false), [setThreadUsesTwoPanes]);
  const channelCrumbs = channelPane?.shifted ? [channelPane.crumb] : [];
  const changeBreakoutWidth = useCallback((width: number): void => {
    setBreakoutWidth(width);
    writeLayout(breakoutWidthKey, String(width));
  }, [breakoutWidthKey]);
  const [scrollToTurn, setScrollToTurn] = useState<ScrollToTurnRequest | null>(null);
  const showInChannel = (turnId: string | null | undefined): void => {
    if (breakoutOwnsRail) closeRail();
    if (turnId) setScrollToTurn((current) => ({ turnId, nonce: (current?.nonce ?? 0) + 1 }));
  };
  /**
   * The thread on its own. Closing the breakout closes a panel it held: a
   * surface closes its own panel as it unmounts.
   */
  const openThreadAlone = (): void => selectSubstream('0');
  // A merge takes the reader up to where it landed, onto the merge itself.
  const showMerge = (result: ConversationMergeResult): void => {
    if (result.mergedInto.kind === 'channel') {
      void navigate(channelRoute(result.mergedInto.id), { state: revealChannelMessageState(result.messageId) });
      return;
    }
    if (!mainVisible) return;
    openThreadAlone();
    // A replay wrote nothing, so no socket event will bring the turn: it is
    // searched for like any other.
    setScrollToTurn((current) => ({ turnId: result.messageId, nonce: (current?.nonce ?? 0) + 1, arriving: !result.replayed }));
  };
  /**
   * A source's merge divider: the merge where it landed, written some time
   * ago. A Breakout's is in this thread, so the Breakout closes and the thread
   * scrolls to it; a thread's is in a Channel, which opens onto it wherever it
   * is in the feed.
   */
  const openMerge = (merge: MessageMergedInto): void => {
    if (merge.kind === 'channel') {
      void navigate(channelRoute(merge.id), { state: revealChannelMessageState(merge.messageId, { searchHistory: true }) });
      return;
    }
    openThreadAlone();
    showInChannel(merge.messageId);
  };
  // A fact's source opens like any link, and the menu closes as it does.
  const memoryLevel = (memory: MemoryFacts) => ({ ...memory, onOpenSource: (source: Parameters<typeof openMemorySource>[0]) => openMemorySource(source, (to) => void navigate(to)) });
  const openBreakout = (substreamId: string): void => {
    // A panel the Channel has open would hide the Breakout being asked for.
    if (mainOwnsRail) closeRail();
    selectSubstream(substreamId);
  };

  // The same read the thread's pane makes, so the menu names the same default.
  const eligibleMergeChannels = useMergeChannels(api, id, !guest && parent.data !== undefined);
  // The title menu's Merge opens the composer's merge mode in that pane.
  const [mergeRequest, setMergeRequest] = useState<{ substreamId: string; nonce: number } | null>(null);
  const threadMerge = mergeTargetFor({
    parentKind: 'workstream', substreamId: '0', guest, thread: parent.data, placements: row?.spaceIds,
    eligible: eligibleMergeChannels, spaces: activeSpaces?.items ?? [],
  });
  const resolve = async (target: ConversationRowTarget): Promise<void> => {
    if (!api || substreamPending) return;
    const visit = routeRef.current.visit;
    const parentId = id;
    setSubstreamPending(true);
    setSubstreamMenuFailure(null);
    try {
      await resolveConversation(api, queryClient, parentId, target.substreamId);
      if (routeRef.current.id !== parentId || routeRef.current.visit !== visit) return;
      if (target.substreamId !== '0') { if (mainVisible) openThreadAlone(); }
      else {
        const channelId = channelPane?.channelId ?? linkSpaceId;
        if (channelId) void navigate(channelRoute(channelId));
      }
    } catch (error) {
      if (routeRef.current.id === parentId && routeRef.current.visit === visit) {
        const noun = target.substreamId === '0' ? 'thread' : 'breakout';
        const copy = resolutionFailure(error, noun);
        setSubstreamMenuFailure({ title: `The ${noun} couldn’t be resolved`, copy });
      }
    } finally {
      if (routeRef.current.id === parentId && routeRef.current.visit === visit) setSubstreamPending(false);
    }
  };
  const threadResolved = row?.resolved
    ?? directoryEntry?.conversations.find((item) => item.substreamId === '0')?.resolved
    ?? parent.data?.resolved;
  const threadArchived = Boolean(parent.data?.archivedAt || row?.archivedAt || directoryEntry?.archived);
  const breakoutResolved = railChildren?.find((child) => child.substreamId === openBreakoutId)?.resolved;
  const breakoutArchived = Boolean(openChild.data?.archivedAt
    || directoryEntry?.conversations.find((item) => item.substreamId === openBreakoutId)?.archived);
  const mainActions = (conversationScoped ? mainVisible : parent.data) ? {
    merge: threadMerge ? {
      label: mergeLabel(threadMerge),
      target: threadMerge.kind === 'channel' && threadMerge.channels.length > 1 ? `${threadMerge.channels.length} Channels` : 'Channel',
      disabled: Boolean(threadResolved),
      disabledReason: threadResolved ? 'This thread is already resolved.' : undefined,
      onSelect: () => setMergeRequest({ substreamId: '0', nonce: Date.now() }),
    } : undefined,
    onResolve: !threadArchived && !conversationScoped ? (target: ConversationRowTarget) => { void resolve(target); } : undefined,
    resolveDisabled: substreamPending || Boolean(threadResolved),
    resolveDisabledReason: threadResolved ? 'This thread is already resolved.' : undefined,
    isPublic: parent.data?.scope === 'workspace',
    onSetPublic: !channelWritable || parent.data?.systemKind ? undefined : setPublic,
    publicDisabled: substreamPending,
    onCopyLink: session?.workspace ? copyRowLink : undefined,
    onRename: (target: ConversationRowTarget) => { ++menuOperation.current; setRenameTarget({ ...target, parentId: id }); setRenameTitle(target.title); setSubstreamMenuFailure(null); },
    onArchive: !channelWritable ? undefined : (target: ConversationRowTarget) => { ++menuOperation.current; setArchiveTarget({ ...target, parentId: id }); setSubstreamMenuFailure(null); },
  } : undefined;
  const substreamActions = {
    onResolve: !breakoutArchived && !threadArchived
      ? (target: ConversationRowTarget) => { void resolve(target); } : undefined,
    resolveDisabled: substreamPending || Boolean(breakoutResolved),
    resolveDisabledReason: breakoutResolved ? 'This breakout is already resolved.' : undefined,
    // The Breakout's pane merges only when it has its Thread to merge into,
    // which a reader scoped to the Breakout alone does not.
    merge: openBreakoutId && !conversationScoped && parent.data ? {
      label: 'Merge to thread',
      target: parent.data.title,
      onSelect: () => setMergeRequest({ substreamId: openBreakoutId, nonce: Date.now() }),
    } : undefined,
    onCopyLink: session?.workspace ? copyRowLink : undefined,
    onRename: (child: ConversationRowTarget) => { ++menuOperation.current; setRenameTarget({ ...child, parentId: id }); setRenameTitle(child.title); setSubstreamMenuFailure(null); },
    onArchive: (child: ConversationRowTarget) => { ++menuOperation.current; setArchiveTarget({ ...child, parentId: id }); setSubstreamMenuFailure(null); },
  };

  /**
   * The Channel's pill: its mark, its name, and the menu that replaced the
   * Channel sidebar. Drawn from the Main surface's own context when it is the
   * Main surface's header, and from what the socket already holds when it is
   * stacked above a Breakout that has taken the Channel's place.
   */
  const channelLevel = (context: ConversationHeaderContext | null, onSelect?: () => void): TitlePillLevel => {
    const detail = context?.detail ?? parent.data;
    const title = parent.data?.title ?? detail?.title ?? railTitle ?? '';
    const naming = (detail?.titleStatus ?? row?.titleStatus) === 'naming';
    const glyph = <WorkstreamGlyph appearance={channelAppearance} id={id} size={24} />;
    const appearanceChange = channelWritable ? mainConnection.setAppearance : undefined;
    return {
      key: `channel:${id}`,
      icon: glyph,
      bridge: { mark: workstreamMark(id, channelAppearance ?? undefined), name: title, action: 'Open thread' },
      ...(!onSelect && appearanceChange ? {
        iconAction: <AppearancePicker
          appearance={channelAppearance}
          colors={false}
          id={id}
          key={id}
          label={`Change ${title} icon`}
          onChange={appearanceChange}
          renderGlyph={(appearance) => <WorkstreamGlyph appearance={appearance} id={id} size={24} />}
        />,
      } : {}),
      title: naming ? <TitleSkeleton className="title-skeleton-header" /> : title,
      label: `Thread menu: ${title}`,
      onMenuOpen: context?.people?.onOpen,
      ...(onSelect ? { onSelect } : {}),
      menu: <ChannelMenu
        actions={mainActions}
        appearance={appearanceChange ? <AppearanceSubmenu
          appearance={channelAppearance}
          icon={<IconPalette aria-hidden="true" size={16} stroke={1.8} />}
          id={id}
          key={id}
          colors={false}
          label="Icon"
          onChange={appearanceChange}
        /> : undefined}
        addSidekick={(context || channelRail) && <SidekickPicker substreamId="0" workstreamId={id} />}
        breakouts={breakoutMarks}
        memory={api && !conversationScoped ? memoryLevel(threadMemory) : undefined}
        // The update re-runs the import in the embedded browser, which only the Mac app has.
        onImportUpdates={api && desktopServicesAvailable() && importedSourceUpdatable(importedSource.data) ? () => setImportUpdateOpen(true) : undefined}
        onOpenArtifact={context?.openArtifact}
        onOpenBreakout={openBreakout}
        onOpenSidekick={(sidekickId) => void desktopBridge().openSidekicks(sidekickId)}
        onRefreshSidekicks={context?.refreshSidekicks}
        onSidekickMenuOpen={context?.loadSidekickOptions}
        openSubstreamId={openBreakoutId}
        participantsPending={context === null && railParticipants === undefined}
        people={context?.people}
        pinned={api && channelWritable ? {
          on: pinnedThreads.has(id),
          onChange: (next) => pinThread('thread', id, next, undefined, context?.detail ?? parent.data ?? row),
        } : undefined}
        presentUserIds={context?.presentUserIds ?? []}
        renderAge={breakoutAge}
        sidekickFailure={context?.sidekickFailure}
        sidekicks={context ? context.sidekicks : railSidekicks}
        workstream={{
          id,
          title,
          appearance: channelAppearance,
          scope: detail?.scope ?? row?.scope ?? sharedParent?.scope,
          participants: detail?.participants ?? railParticipants ?? [],
          resources: detail?.resources ?? channelRail?.resources ?? [],
        }}
      />,
    };
  };

  const openBreakoutMark = breakoutMarks?.find((breakout) => breakout.substreamId === openBreakoutId);
  const breakoutLevel = (context: ConversationHeaderContext): TitlePillLevel => {
    const title = context.detail.title;
    const naming = context.detail.titleStatus === 'naming';
    const breakoutId = openBreakoutId ?? '';
    // The thread pill's shape: its own glyph, which is its appearance picker.
    return {
      key: `breakout:${breakoutId}`,
      icon: <WorkstreamGlyph appearance={selectedAppearance} id={breakoutId} size={24} />,
      ...(channelWritable ? {
        iconAction: <AppearancePicker
          appearance={selectedAppearance}
          colors={false}
          id={breakoutId}
          key={breakoutId}
          label={`Change ${title} icon`}
          onChange={context.setAppearance}
          renderGlyph={(appearance) => <WorkstreamGlyph appearance={appearance} id={breakoutId} size={24} />}
        />,
      } : {}),
      bridge: { mark: workstreamMark(breakoutId, selectedAppearance ?? undefined), name: title, action: 'Open breakout' },
      title: naming ? <TitleSkeleton className="title-skeleton-header" /> : title,
      label: `Breakout menu: ${title}`,
      onMenuOpen: context.people?.onOpen,
      menu: <BreakoutMenu
        actions={substreamActions}
        appearance={!channelWritable ? undefined : <AppearanceSubmenu
          appearance={selectedAppearance}
          icon={<IconPalette aria-hidden="true" size={16} stroke={1.8} />}
          id={breakoutId}
          key={breakoutId}
          colors={false}
          label="Icon"
          onChange={context.setAppearance}
        />}
        breakout={{ substreamId: breakoutId, title }}
        channel={{ id, title: railTitle ?? '', appearance: channelAppearance }}
        memory={api ? memoryLevel(breakoutMemory) : undefined}
        onShowInChannel={mainVisible ? () => showInChannel(openBreakoutMark?.originTurnId) : undefined}
        origin={context.origin}
        addSidekick={<SidekickPicker substreamId={breakoutId} workstreamId={id} />}
        onOpenSidekick={(sidekickId) => void desktopBridge().openSidekicks(sidekickId)}
        onRefreshSidekicks={context.refreshSidekicks}
        onSidekickMenuOpen={context.loadSidekickOptions}
        participants={context.detail.participants}
        people={context.people}
        presentUserIds={context.presentUserIds}
        sidekickFailure={context.sidekickFailure}
        sidekicks={context.sidekicks}
        scope={(() => {
          const child = railChildren?.find((candidate) => candidate.substreamId === breakoutId);
          return child && 'scope' in child ? child.scope : undefined;
        })()}
      />,
    };
  };

  // Beside its Channel, the thread can take the whole window, and give it
  // back. A breakout or a panel holds the expansion until it closes.
  const threadExpandAction = !channelPane ? undefined
    : expandToggle(channelPane.expanded, !channelPane.shifted, channelPane.setExpanded);
  // A breakout beside its thread can do the same, one level down.
  const breakoutExpandAction = expandToggle(breakoutExpanded, shownMode === 'split', setBreakoutExpanded);

  const mainPane = !mainVisible ? null : <ConversationSurface
    resolved={Boolean(threadResolved)}
    linkSpaceId={linkSpaceId}
    breakouts={breakoutMarks}
    mergeRequest={mergeRequest?.substreamId === '0' ? mergeRequest.nonce : null}
    onMerged={showMerge}
    honorsSearchTarget={openBreakoutId === null}
    onOpenBreakout={openBreakout}
    onOpenMerge={openMerge}
    onStartSubstream={startCreation}
    openBreakoutId={openBreakoutId}
    parentId={id}
    parentKind="workstream"
    renderHeader={(context) => <TitlePillHeader
      ancestors={channelCrumbs}
      current={channelLevel(context)}
      actions={threadExpandAction}
      trailing={channelPane && !channelPane.shifted
        ? <TitlePillClose label="Close thread" onClose={() => void navigate(channelRoute(channelPane.channelId))} />
        : undefined}
    />}
    scrollToTurn={scrollToTurn}
    sidebarScope={conversationScoped ? 'conversation' : 'workstream'}
    substreamId="0"
    workstreamContext={conversationScoped ? undefined : parent.data}
  />;

  // What a breakout sits in: its Channel when that is off screen, and its
  // thread, unless the reader reaches only the breakout.
  const breakoutCrumbs = mainVisible ? [...channelCrumbs, channelLevel(null, openThreadAlone)] : [];
  const closeBreakout = <TitlePillClose label="Close breakout" onClose={() => selectSubstream('0')} />;
  const breakoutPane = !breakoutPaneOpen ? null : creatingHere ? <ConversationSurface
    honorsSearchTarget={false}
    key={`launch:${id}`}
    paneKey="launch"
    parentId={id}
    parentKind="workstream"
    sidebarScope={conversationScoped ? 'conversation' : 'workstream'}
    substreamId="0"
    substreamLaunch={{
      throughTurnId: creation.throughTurnId,
      ...(creation.initialDraft ? { initialDraft: creation.initialDraft } : {}),
      launching,
      ...(creationError ? { error: creationError } : {}),
      onCancel: resetCreation,
      onCreate: createSubstream,
    }}
    workstreamContext={conversationScoped ? undefined : parent.data}
  /> : <ConversationSurface
    resolved={Boolean(breakoutResolved)}
    linkSpaceId={linkSpaceId}
    mergeRequest={mergeRequest && mergeRequest.substreamId === openBreakoutId ? mergeRequest.nonce : null}
    onMerged={showMerge}
    // A reader who reaches only this Breakout cannot open the thread its merge
    // went to, so its divider stays a label.
    {...(conversationScoped ? {} : { onOpenMerge: openMerge })}
    parentCrumbs={breakoutCrumbs}
    parentId={id}
    parentKind="workstream"
    renderHeader={(context) => <TitlePillHeader
      ancestors={shownMode === 'breakout' && mainVisible ? breakoutCrumbs : []}
      current={breakoutLevel(context)}
      actions={breakoutExpandAction}
      trailing={mainVisible ? closeBreakout : undefined}
    />}
    sidebarScope={conversationScoped ? 'conversation' : 'workstream'}
    substreamId={openBreakoutId ?? '0'}
    breakoutOrigin={{ turnId: openBreakoutMark?.originTurnId, channelTitle: railTitle ?? parent.data?.title ?? '' }}
    workstreamContext={conversationScoped ? undefined : parent.data}
  />;

  return (
    <>
    {api && importedSourceUpdatable(importedSource.data) && <SessionImportUpdateDialog key={id} open={importUpdateOpen}
      onClose={() => setImportUpdateOpen(false)} source={importedSource.data} workstreamId={id} />}
    <SplitConversationLayout
      breakout={breakoutPane}
      breakoutWidth={breakoutWidth}
      main={mainPane && <PaneVisibility visible={shownMode !== 'breakout'}>{mainPane}</PaneVisibility>}
      mode={splitMode}
      onBreakoutWidthChange={changeBreakoutWidth}
      onShownChange={setShownMode}
    />
    <Modal
      footer={<>
        <Button disabled={substreamPending} onClick={() => { setRenameTarget(null); setSubstreamMenuFailure(null); }}>Cancel</Button>
        <Button
          className="button-primary"
          disabled={substreamPending || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
          onClick={() => void submitSubstreamRename()}
        >Rename</Button>
      </>}
      onOpenChange={(open) => { if (!open && !substreamPending) { setRenameTarget(null); setSubstreamMenuFailure(null); } }}
      open={Boolean(renameTarget)}
      title={renameTarget?.substreamId === '0' ? 'Rename thread' : 'Rename breakout'}
    >
      {substreamMenuFailure && <InlineError>{failureCopyOf(substreamMenuFailure).copy}</InlineError>}
      <form onSubmit={(event) => { event.preventDefault(); void submitSubstreamRename(); }}>
        <label className="form-field">
          <span>Title</span>
          <input autoFocus maxLength={180} disabled={substreamPending} onChange={(event) => setRenameTitle(event.target.value)} value={renameTitle} />
        </label>
      </form>
    </Modal>
    <ArchiveConversationModal
      target={archiveTarget ? { title: archiveTarget.title, noun: archiveTarget.substreamId === '0' ? 'thread' : 'breakout' } : null}
      pending={substreamPending}
      error={substreamMenuFailure ? failureCopyOf(substreamMenuFailure).copy : null}
      onClose={() => { setArchiveTarget(null); setSubstreamMenuFailure(null); }}
      onConfirm={() => void submitSubstreamArchive()}
    />
    <Modal
      footer={<Button onClick={() => setSubstreamMenuFailure(null)}>Close</Button>}
      onOpenChange={(open) => { if (!open) setSubstreamMenuFailure(null); }}
      open={Boolean(substreamMenuFailure) && !renameTarget && !archiveTarget}
      title={substreamMenuFailure ? failureCopyOf(substreamMenuFailure).title : 'That couldn’t be updated'}
    >
      {substreamMenuFailure && <InlineError>{failureCopyOf(substreamMenuFailure).copy}</InlineError>}
    </Modal>
    </>
  );
}

