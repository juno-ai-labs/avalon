import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconAugmentedReality } from '@tabler/icons-react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUp,
  CalendarClock,
  Check,
  Copy,
  Ellipsis,
  FileText,
  FileUp,
  Info,
  LoaderCircle,
  Lock,
  Mail,
  Menu,
  PanelRight,
  Plus,
  RefreshCcw,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  type TranscriptActivity,
  type TranscriptTurn,
  type WorkstreamMessageDeliveryState,
  type WorkstreamTranscriptSnapshot,
} from '@rally/contracts';
import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import type { DesktopSession } from '../../common/desktop';
import { useAppSession } from '../lib/app-session';
import { useCitations } from '../lib/use-citations';
import { ApiError, type MentionIdentity } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { isComposingKeyEvent } from '../lib/ime';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { workstreamDraftKey } from '../lib/draft-keys';
import { desktopBridge } from '../lib/platform';
import {
  currentSurfaceEntrypoint,
  cancelWorkstreamFeedOpen,
  reportTelemetryProductIntent,
  telemetryCountBucket,
  telemetryVisibility,
  type WorkstreamFeedSource,
  workstreamFeedOpenAttemptId,
  workstreamFeedSourceQueryKey,
  workstreamSocketSnapshotGenerationQueryKey,
  workstreamNavigation,
} from '../lib/telemetry';
import {
  appendDismissedSuggestionId,
  adjacentTranscriptRange,
  composeTranscript,
  createTextMessage,
  dismissedSuggestionIdsQueryKey,
  groupPluginToolMessages,
  orderedTranscriptMessages,
  pendingTranscriptInputOverlay,
  reconcileAuthoritativeTranscriptOverlays,
  removeTranscriptOverlay,
  setTranscriptElicitationState,
  transcriptCoverageAdvanced,
  transcriptOverlaysQueryKey,
  type TranscriptOverlay,
  upsertTranscriptOverlay,
} from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useFileDrop } from '../lib/use-file-drop';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { useTextClipped } from '../lib/use-text-clipped';
import { TRANSCRIPT_END_SLACK, useTranscriptFollow } from '../lib/use-transcript-follow';
import { useWorkstreamFeedOpenTelemetry } from '../lib/use-workstream-feed-open-telemetry';
import { useWorkstreamSendReadyTelemetry } from '../lib/use-workstream-send-ready-telemetry';
import { useBlockDashboardSockets } from '../lib/use-block-dashboard-sockets';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { JumpToLatestButton, RunStoppedNotice } from '../components/conversation-follow';
import { type RailPanel, type RailVariant, useUiStore } from '../lib/ui-store';
import { type SocketState, type WorkstreamMessageDeliveryMode } from '../lib/use-workstream-socket';
import { useRetainedWorkstreamSocket, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import type { ElicitationData, HarnessRunMetadata, HarnessStatus, BlockDashboard, BlockDashboardPreference, Message, Participant, ResourceVersion, WorkspaceMember, WorkstreamBoot, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { AgentCompactionIndicator, AgentWorkTiming, type AgentWorkTimingProps } from '../components/agent-work-timing';
import { InspectorRail } from '../components/inspector-rail';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, OpeningState, SocketStatusIndicator, StatusDot, TitleSkeleton } from '../components/primitives';
import { MessageBlock, type SystemRowDisclosure } from '../components/workstream-blocks';
import { WorkstreamComposer } from '../components/workstream-composer';
import { BlockDashboardPanel, BlockDashboardRail } from '../components/block-dashboard-panel';
import { useRailCrossFade } from '../components/rail-surface';

/**
 * The cache key for one resource's version history.
 *
 * Keyed on the version the detail is showing as well as the resource, for the
 * same reason the preview beside it is: a republish or a watch-driven
 * re-ingest keeps the resource's id and arrives over the socket, so a key made
 * of the id alone leaves the rail showing a history missing its newest entry
 * while presenting itself as the whole record. Only the participant's own
 * re-fetch invalidates explicitly; every other writer moves this number.
 */
export function resourceVersionsQueryKey(
  resourceId: string | null,
  currentVersion: number | null,
): readonly [string, string | null, number | null] {
  return ['resource-versions', resourceId, currentVersion];}

export function acceptedMessageOverlayDeliveryState(
  deliveryState: WorkstreamMessageDeliveryState,
  requestedMode: WorkstreamMessageDeliveryMode | undefined,
): Message['deliveryState'] {
  if (deliveryState === 'canonical') return undefined;
  return requestedMode === 'queue' ? 'queue_pending' : 'steer_pending';
}

export function workspaceMemberFromSession(session: DesktopSession | null): WorkspaceMember | undefined {
  if (!session?.workspace) return undefined;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    timezone: session.user.timezone ?? 'America/Los_Angeles',
    ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
    role: session.workspace.role,
  };
}

/** Resolve WorkspaceDO's foreground IDs through the roster for the inspector. */
export function workstreamPresenceViewers(
  participants: readonly Pick<Participant, 'id'>[],
  members: readonly WorkspaceMember[],
  presentUserIds: readonly string[],
): Participant[] {
  const participantIds = new Set(participants.map((participant) => participant.id));
  const presentIds = new Set(presentUserIds);
  return members
    .filter((member) => presentIds.has(member.id) && !participantIds.has(member.id))
    .map((member) => ({ ...member, viewing: true }));
}

function detailFromRecoveryBoot(boot: WorkstreamBoot): WorkstreamDetail {
  const { transcript, ...detail } = boot;
  void transcript;
  return detail;
}

export function workstreamRunTiming(
  status: HarnessStatus,
  run: HarnessRunMetadata | undefined,
  now = Date.now(),
): AgentWorkTimingProps | null {
  if (!run || status === 'scheduled' || status === 'needs_input') return null;
  const startedAt = Date.parse(run.startedAt ?? run.createdAt);
  if (!Number.isFinite(startedAt)) return null;
  if (status === 'running') return { active: true, durationMs: 0, startedAt };
  const canonicalCompletedAt = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const completedAt = Number.isFinite(canonicalCompletedAt) ? canonicalCompletedAt : now;
  return { active: false, durationMs: Math.max(0, completedAt - startedAt) };
}

/** An admitted run is already work, even before its Workflow starts. */
export function workstreamShowsReadyState(
  transcriptLength: number,
  hasActiveElicitation: boolean,
  status: HarnessStatus,
): boolean {
  return transcriptLength === 0
    && !hasActiveElicitation
    && status !== 'scheduled'
    && status !== 'running';
}

interface OrderedTimingSnapshot {
  activities: readonly Pick<TranscriptActivity, 'activityId' | 'parentActivityId' | 'scope' | 'subjectId'>[];
  ranges: readonly { turns: readonly Pick<TranscriptTurn, 'activityId'>[] }[];
  activeTurns: readonly Pick<TranscriptTurn, 'activityId'>[];
}

export function orderedTranscriptOwnsRunTiming(
  snapshot: OrderedTimingSnapshot | undefined,
  runId: string | undefined,
): boolean {
  if (!runId || !snapshot) return false;
  const response = snapshot.activities.find((activity) =>
    activity.scope === 'response' && activity.subjectId === runId);
  if (!response) return false;
  const assistantActivityIds = new Set(snapshot.activities.flatMap((activity) =>
    activity.scope === 'assistant_turn' && activity.parentActivityId === response.activityId
      ? [activity.activityId]
      : []));
  return [...snapshot.ranges.flatMap((range) => range.turns), ...snapshot.activeTurns]
    .some((turn) => turn.activityId !== null && assistantActivityIds.has(turn.activityId));
}

/**
 * Fence the reused route subtree to the work stream named by the current URL.
 *
 * The socket pool deliberately keeps `WorkstreamScreen` mounted while its
 * route parameter changes. Query observers and socket-owned caches do not all
 * change in the same React phase, so a render during that handoff can still
 * hold the previous detail or transcript. Those values remain valid in their
 * own keyed caches, but they must never paint under the next work stream's URL.
 */
export function workstreamPayloadBelongsToRoute(
  routeWorkstreamId: string,
  workstream: Pick<WorkstreamDetail, 'id'> | undefined,
  transcript: WorkstreamTranscriptSnapshot | undefined,
): boolean {
  return workstream?.id === routeWorkstreamId
    && transcript !== undefined;
}

/**
 * Which panel holds the right sidebar. The inspector rail's open state is local
 * and immediate, while HyperSight's is a preference write that can fail and roll
 * back, so the rail holds the slot until that write settles: a failed write can
 * leave the stored preference disagreeing with the screen, never two panels
 * stacked in one slot with both controls reading as open.
 */
export function blockDashboardHoldsSidebar(preferenceVisible: boolean, railOpen: boolean): boolean {
  return preferenceVisible && !railOpen;
}

export function manualElicitationResponse(
  elicitation: ElicitationData,
  text: string,
): { answer: string | string[]; customResponse?: string } {
  const customResponse = text.trim();
  if (elicitation.responseType === 'text') return { answer: customResponse };
  if (elicitation.responseType === 'multi_select') return { answer: [customResponse], customResponse };
  return { answer: customResponse, customResponse };
}

export function AddParticipantDialog({
  current,
  error,
  members,
  open,
  pending,
  onAdd,
  onRemove,
  onOpenChange,
}: {
  current: WorkspaceMember[];
  error?: string | undefined;
  members: WorkspaceMember[];
  open: boolean;
  pending: boolean;
  onAdd: (member: WorkspaceMember) => void;
  onRemove: (member: WorkspaceMember) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const currentById = new Map(current.map((member) => [member.id, member]));
  const activeMembers = members.filter((member) => (member.status ?? 'active') === 'active');
  const activeMemberIds = new Set(activeMembers.map((member) => member.id));
  // A membership that is not active is one the work-stream endpoint refuses,
  // so offering it here would only produce a failure the person cannot act on.
  // Still retain any current participant missing from the active roster: the
  // work-stream object is authoritative for who is already in this room.
  const listed = [
    ...activeMembers.map((member) => currentById.get(member.id) ?? member),
    ...current.filter((member) => !activeMemberIds.has(member.id)),
  ];
  return (
    <Modal
      description="Opening or viewing never adds someone as a participant. Add them explicitly here."
      onOpenChange={onOpenChange}
      open={open}
      title="Add a participant"
    >
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="member-action-list">
        {listed.map((member) => {
          const isParticipant = currentById.has(member.id);
          if (!isParticipant) {
            return (
              <button
                aria-label={`Add ${member.name} to work stream`}
                className="member-action-row"
                disabled={pending}
                key={member.id}
                onClick={() => onAdd(member)}
                type="button"
              >
                <Avatar member={member} size="medium" />
                <span><strong>{member.name}</strong><small>{member.email}</small></span>
                {pending ? <LoaderCircle className="spin" size={15} /> : <Plus aria-hidden="true" size={15} />}
              </button>
            );
          }
          return (
            <div className="member-action-row" key={member.id}>
              <Avatar member={member} size="medium" />
              <span><strong>{member.name}</strong><small>{member.email}</small></span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton
                    disabled={pending}
                    label={`${member.name} participant actions`}
                    showTooltip={false}
                  >
                    {pending ? <LoaderCircle className="spin" size={15} /> : <Ellipsis size={16} />}
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" className="menu-content" sideOffset={6}>
                    <DropdownMenu.Item
                      className="menu-item menu-item-danger"
                      disabled={current.length <= 1 || pending}
                      onSelect={() => onRemove(member)}
                    >
                      Remove from work stream
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function readableResourceKind(value: string): string {
  return value.replace(/[_-]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

export function AddResourceDialog({
  current,
  resources,
  open,
  pending,
  loading,
  fetching,
  error,
  search,
  hasMore,
  onAttach,
  onLoadMore,
  onOpenChange,
  onSearchChange,
  onUpload,
}: {
  current: WorkstreamResource[];
  resources: WorkstreamResource[];
  open: boolean;
  pending: boolean;
  loading: boolean;
  fetching: boolean;
  error?: string | undefined;
  search: string;
  hasMore: boolean;
  onAttach: (resource: WorkstreamResource) => void;
  onLoadMore: () => void;
  onOpenChange: (open: boolean) => void;
  onSearchChange: (value: string) => void;
  onUpload: () => void;
}): React.JSX.Element {
  const currentIds = new Set(current.map((resource) => resource.id));
  const available = resources.filter((resource) => !currentIds.has(resource.id));
  return (
    <Modal
      description="Attach a resource discovered through a connector, or upload a file from this Mac."
      footer={(
        <>
          <Button className="resource-upload-button" disabled={pending} onClick={onUpload}>
            <FileUp aria-hidden="true" size={14} /> Upload file
          </Button>
          {hasMore && (
            <Button disabled={fetching || pending} onClick={onLoadMore}>
              {fetching ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
              Load more
            </Button>
          )}
        </>
      )}
      onOpenChange={onOpenChange}
      open={open}
      title="Add a resource"
    >
      <div className="resource-picker">
        <label className="resource-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Search resources"
            autoFocus
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Search repositories, files, issues, and pull requests"
            type="search"
            value={search}
          />
        </label>
        {error ? <InlineError>{error}</InlineError> : null}
        {loading ? (
          <LoadingState label="Finding resources…" />
        ) : available.length === 0 ? (
          <EmptyState
            title={search ? 'No matching resources' : 'No connector resources yet'}
            description={search ? 'Try a different search, or upload a file.' : 'Resources discovered by connected services will appear here.'}
          />
        ) : (
          <div className="resource-picker-list">
            {available.map((resource) => (
              <button
                disabled={pending}
                key={resource.id}
                onClick={() => onAttach(resource)}
                type="button"
              >
                <span aria-hidden="true" className="resource-picker-icon"><FileText size={15} /></span>
                <span className="resource-picker-copy">
                  <strong>{resource.title}</strong>
                  <small>{readableResourceKind(resource.provider ?? 'Rally')} · {readableResourceKind(resource.resourceType)}</small>
                </span>
                {pending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <Plus aria-hidden="true" size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

const RENAME_HINT = 'Double-click to rename';

export function WorkstreamHeader({
  workstream,
  socketState,
  blockDashboardOpen,
  blockDashboardAvailable = false,
  onAddParticipant,
  onOpenRail,
  onRename,
  onToggleBlockDashboard,
  presentUserIds = [],
  currentUserId = null,
}: {
  workstream: WorkstreamDetail;
  socketState: SocketState;
  blockDashboardOpen: boolean;
  blockDashboardAvailable?: boolean;
  onAddParticipant: () => void;
  onOpenRail: (variant: RailVariant) => void;
  onRename: (title: string) => Promise<void>;
  onToggleBlockDashboard: () => void;
  presentUserIds?: readonly string[];
  currentUserId?: string | null;
}): React.JSX.Element {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const closeRail = useUiStore((state) => state.closeRail);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  // The right sidebar holds one panel at a time, so every control that opens it
  // reads as pressed while its own panel is the one showing, and closes it
  // again from that state.
  const showing = (variant: RailVariant): boolean => railOpen && railVariant === variant;
  const toggleRail = (variant: RailVariant): void => {
    if (showing(variant)) closeRail();
    else onOpenRail(variant);
  };
  // A null draft means the heading is displayed; any string means the inline
  // editor is open, so there is one source of truth for both.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // The route keeps this component mounted across work streams, so an open
  // editor would otherwise carry the previous stream's draft into the next one.
  // The ref lets an in-flight rename recognize that it is no longer the one on
  // screen: the promise it is waiting on outlives the navigation.
  const shownWorkstreamId = useRef(workstream.id);
  useEffect(() => {
    shownWorkstreamId.current = workstream.id;
    setRenameDraft(null);
    setRenameError(null);
    setRenaming(false);
  }, [workstream.id]);
  // Closing the editor unmounts the field, which would leave focus on the body
  // and strand a keyboard user at the top of the document. The title button
  // does not exist until the next render, so the focus call waits for it.
  const titleButton = useRef<HTMLButtonElement>(null);
  const returnFocusToTitle = useRef(false);
  useEffect(() => {
    if (renameDraft !== null || !returnFocusToTitle.current) return;
    returnFocusToTitle.current = false;
    titleButton.current?.focus();
  }, [renameDraft]);
  // The measurement needs the same element, but as state rather than a ref: the
  // heading is swapped out for the editor and for the naming skeleton, and a
  // mutable ref changing does not re-run an effect, so the button coming back
  // would otherwise go unmeasured. The ref above stays because focus is set
  // during an effect, where reading the current node is the point.
  const [titleNode, setTitleNode] = useState<HTMLButtonElement | null>(null);
  const attachTitleButton = useCallback((node: HTMLButtonElement | null) => {
    titleButton.current = node;
    setTitleNode(node);
  }, []);
  const titleClipped = useTextClipped(titleNode, workstream.title);
  const renameHintId = useId();
  const startRename = (): void => {
    setRenameDraft(workstream.title);
    setRenameError(null);
  };
  const cancelRename = (): void => {
    returnFocusToTitle.current = true;
    setRenameDraft(null);
    setRenameError(null);
  };
  const submitRename = async (): Promise<void> => {
    const title = renameDraft?.trim() ?? '';
    if (!title || renaming) return;
    // An unchanged name is a no-op rather than a request; the editor still
    // closes, so Save never looks inert.
    if (title === workstream.title) {
      cancelRename();
      return;
    }
    // Every completion below is guarded on the work stream still being the one
    // on screen. Navigating away mid-flight otherwise lands the old stream's
    // failure under the new stream's title, or closes an editor the user has
    // since opened on it.
    const submittedFor = workstream.id;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(title);
      if (shownWorkstreamId.current !== submittedFor) return;
      returnFocusToTitle.current = true;
      setRenameDraft(null);
    } catch (error) {
      if (shownWorkstreamId.current !== submittedFor) return;
      setRenameError(error instanceof Error ? error.message : 'The work stream could not be renamed.');
    } finally {
      if (shownWorkstreamId.current === submittedFor) setRenaming(false);
    }
  };
  // Copy the canonical HTTPS link, not the `rallywithai://` deep link. A copied link
  // is going somewhere else — Slack, mail, a Linear comment — where an unknown
  // scheme does not unfurl, often does not linkify, and is dead for anyone who
  // has not installed Rally. The canonical link ends at the same work stream.
  const copyLink = (): void => {
    void (async () => {
      const bridge = desktopBridge();
      const { webBaseUrl } = await bridge.getRuntimeConfig();
      await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, workstream.id));
      reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_link', resourceType: 'workstream', resourceId: workstream.id,
      });
    })().catch(() => undefined);
  };
  const copyEmailAddress = (): void => {
    if (!workstream.emailAddress) return;
    void desktopBridge().copyText(workstream.emailAddress)
      .then(() => reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_email', resourceType: 'workstream', resourceId: workstream.id,
      }))
      .catch(() => undefined);
  };
  const copyWorkstreamId = (): void => {
    void desktopBridge().copyText(workstream.id)
      .then(() => reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_id', resourceType: 'workstream', resourceId: workstream.id,
      }))
      .catch(() => undefined);
  };
  const naming = useNamingSkeleton(workstream);

  return (
    <header className="workstream-header window-drag">
      <div className="workstream-header-left window-no-drag">
        <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton>
        <div className="workstream-title-block">
          {/* The one place a title arriving on its own is worth announcing. A
              work stream created a second ago is named while its author is
              looking at it, and a skeleton that says a name is coming owes
              them the name — the sidebar rows deliberately stay silent, since
              a list that announces once per unnamed row is noise. Live is off
              while the editor is open: the person renaming it is typing the
              new name and does not need it read back, and the swap between
              heading and form is not news. */}
          <div
            aria-live={renameDraft === null ? 'polite' : 'off'}
            className="workstream-title-line"
          >
            {naming ? (
              <h1><TitleSkeleton className="title-skeleton-header" /></h1>
            ) : renameDraft === null ? (
              <>
                <h1>
                  {/* A heading cannot carry the interaction itself: a focusable
                      h1 is still announced as a heading, so a screen-reader user
                      is never told there is anything to activate. A real button
                      inside it is announced as one, and the heading keeps its
                      name from the button's text. A mouse click reports a detail
                      of 1 or more and is ignored — only a double click opens the
                      editor — while keyboard activation reports 0. */}
                  <button
                    aria-describedby={renameHintId}
                    aria-keyshortcuts="Enter F2"
                    className="workstream-title-button"
                    onClick={(event) => { if (event.detail === 0) startRename(); }}
                    onDoubleClick={startRename}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') {
                        event.preventDefault();
                        startRename();
                      }
                    }}
                    ref={attachTitleButton}
                    // A clipped title is unreadable anywhere else on the screen,
                    // so the tooltip leads with the name and keeps the hint under
                    // it. The tooltip is for the reader who cannot see the name:
                    // the button's accessible name is its text, which is the
                    // whole title however little of it fits, so `aria-describedby`
                    // above keeps the description down to the hint rather than
                    // letting `title` announce the name a second time.
                    title={titleClipped ? `${workstream.title}\n${RENAME_HINT}` : RENAME_HINT}
                    type="button"
                  >
                    {workstream.title}
                  </button>
                </h1>
                {/* Outside the heading on purpose: inside it, this text would
                    join the heading's own name and be read as part of it. */}
                <span className="sr-only" id={renameHintId}>{RENAME_HINT}</span>
              </>
            ) : (
              <form
                className="workstream-title-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename();
                }}
              >
                <input
                  aria-label="Work stream name"
                  autoFocus
                  className="workstream-title-input"
                  disabled={renaming}
                  // The contract caps a title at 180, and the sidebar's dialog
                  // already stops there. Without the same cap the server
                  // rejects the save with a message that never mentions length.
                  maxLength={180}
                  onChange={(event) => {
                    setRenameDraft(event.currentTarget.value);
                    // The reason for a failed save stands in for the status
                    // line, so it cannot outlive the draft that caused it.
                    setRenameError(null);
                  }}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    // While an IME is composing, Escape cancels the candidate
                    // rather than the rename — discarding the draft here would
                    // throw away a name somebody is halfway through typing,
                    // with nothing to undo it. See `../lib/ime.ts`.
                    if (isComposingKeyEvent(event.nativeEvent)) return;
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  value={renameDraft}
                />
                <IconButton
                  className="title-edit-save"
                  disabled={renaming || renameDraft.trim().length === 0}
                  label="Save name"
                  type="submit"
                >
                  {renaming ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                </IconButton>
                <IconButton className="title-edit-cancel" disabled={renaming} label="Cancel rename" onClick={cancelRename}>
                  <X size={15} />
                </IconButton>
              </form>
            )}
            {workstream.origin === 'automation' && <Badge>{workstream.automationName ?? 'Automation'}</Badge>}
            {/* Only its participant can open this one, so say so where they are
                reading it rather than only in the sidebar they came from. */}
            {workstream.scope === 'personal' && <Badge className="badge-private"><Lock aria-hidden="true" size={9} /> Private</Badge>}
          </div>
          <div className="workstream-subtitle">
            {renameError ? (
              <InlineError>{renameError}</InlineError>
            ) : (
              <>
                <StatusDot status={workstream.harnessStatus} />
                {workstream.plannedFor && <span><CalendarClock size={11} /> {formatDateTime(workstream.plannedFor)}</span>}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="workstream-header-actions window-no-drag">
        <SocketStatusIndicator state={socketState} />
        <button className="participant-header-button" onClick={onAddParticipant} type="button">
          <AvatarStack
            currentUserId={currentUserId}
            members={workstream.participants}
            presentUserIds={presentUserIds}
          />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>
        {/* The two controls that own the right sidebar sit side by side, in the
            order the panels themselves are named. */}
        {blockDashboardAvailable && (
          <IconButton
            className={clsx('panel-toggle', 'block-dashboard-toggle', blockDashboardOpen && 'is-active')}
            aria-pressed={blockDashboardOpen}
            label={blockDashboardOpen ? 'Hide HyperSight' : 'Show HyperSight'}
            onClick={onToggleBlockDashboard}
          >
            <IconAugmentedReality size={16} stroke={1.7} />
          </IconButton>
        )}
        <IconButton
          aria-pressed={showing('context')}
          className={clsx('panel-toggle', showing('context') && 'is-active')}
          label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
          onClick={() => toggleRail('context')}
        >
          <PanelRight size={15} />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              {workstream.origin === 'automation' && (
                <DropdownMenu.Item className="menu-item" onSelect={() => onOpenRail('runs')}>Automation runs</DropdownMenu.Item>
              )}
              <DropdownMenu.Item className="menu-item" onSelect={copyLink}><Copy size={14} /> Copy work-stream link</DropdownMenu.Item>
              {workstream.emailAddress && (
                <DropdownMenu.Item className="menu-item" onSelect={copyEmailAddress}><Mail size={14} /> Copy work-stream email address</DropdownMenu.Item>
              )}
              <DropdownMenu.Item className="menu-item" onSelect={copyWorkstreamId}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

export function WorkstreamErrorState({
  description,
  onRetry,
  workstreamId,
}: {
  description: string;
  onRetry: () => void;
  workstreamId: string;
}): React.JSX.Element {
  const copyWorkstreamId = (): void => {
    void desktopBridge().copyText(workstreamId)
      .then(() => reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_id', resourceType: 'workstream', resourceId: workstreamId,
      }))
      .catch(() => undefined);
  };
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="screen-state-actions window-no-drag">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              <DropdownMenu.Item className="menu-item" onSelect={copyWorkstreamId}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <EmptyState
        action={<Button onClick={onRetry}><RefreshCcw size={14} /> Try again</Button>}
        description={description}
        title="Work stream could not be opened"
      />
    </div>
  );
}

export function initialTranscriptAnchorIndex(
  transcript: Message[],
  firstUnreadSequenceNumber: number | null,
): number | null {
  if (firstUnreadSequenceNumber === null) return null;
  const firstUnreadIndex = transcript.findIndex((message) =>
    message.realtimeOrder === undefined
    && message.attentionSequenceNumber != null
    && message.attentionSequenceNumber >= firstUnreadSequenceNumber);
  return firstUnreadIndex < 0 ? null : Math.max(0, firstUnreadIndex - 1);
}

export function shouldLoadEarlierFromScroll(
  scrollTop: number,
  hasEarlierCursor: boolean,
  loading: boolean,
): boolean {
  return scrollTop < 160 && hasEarlierCursor && !loading;
}

export function preservedPrependScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}

export function highestVisibleAttentionSequence(
  transcript: Message[],
  visibleIndexes: number[],
  latestAttentionSequenceNumber: number,
): number {
  return visibleIndexes.reduce((highest, index) => {
    const message = transcript[index];
    if (
      !message
      || message.realtimeOrder !== undefined
      || message.messageType === 'tool_event'
      || message.attentionSequenceNumber == null
      || message.attentionSequenceNumber > latestAttentionSequenceNumber
    ) return highest;
    return Math.max(highest, message.attentionSequenceNumber);
  }, 0);
}

export function RunFailureNotice({
  code,
  message,
  requestId,
  retrying,
  onCopyRequestId,
  onRetry,
}: {
  code: string;
  message: string;
  requestId?: string;
  retrying: boolean;
  onCopyRequestId: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Run failed" className="run-failure-notice" role="alert">
      <span aria-hidden="true" className="run-failure-icon"><AlertTriangle size={16} /></span>
      <div className="run-failure-copy">
        <strong>Run failed</strong>
        <p>{message}</p>
        <code>{code}</code>
      </div>
      <div className="run-failure-actions">
        {requestId ? (
          <Button onClick={onCopyRequestId}><Copy aria-hidden="true" size={13} /> Copy request ID</Button>
        ) : null}
        <Button className="button-primary" disabled={retrying} onClick={onRetry}>
          {retrying ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <RefreshCcw aria-hidden="true" size={13} />}
          Retry
        </Button>
      </div>
    </section>
  );
}

/** Hoisted for identity: a `?? []` per render would re-key the citation lookup. */
const NO_RESOURCES: WorkstreamDetail['resources'] = [];

export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const readSocketOpenContext = useWorkstreamSocketOpenContext(id);
  const navigate = useNavigate();
  const { api, session } = useAppSession();
  const { presenceUserIdsByWorkstream } = useWorkspaceSocket();
  const featureFlags = useClientFeatureFlags(api);
  const queryClient = useQueryClient();
  const closeRail = useUiStore((state) => state.closeRail);
  const inspector = useUiStore((state) => state.inspector);
  const openRail = useUiStore((state) => state.openRail);
  const railOpen = useUiStore((state) => state.railOpen);
  const setBlockDashboardOpen = useUiStore((state) => state.setBlockDashboardOpen);
  const setRailLeaving = useUiStore((state) => state.setRailLeaving);
  const setRailScope = useUiStore((state) => state.setRailScope);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [participantDialogOpen, setParticipantDialogOpen] = useState(false);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState('');
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState('');
  const [sendError, setSendError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | undefined>();
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const pendingOlderAfterReconnectRef = useRef(false);
  const pendingNewerAfterReconnectRef = useRef(false);
  const pendingJumpAfterReconnectRef = useRef(false);
  const initialPositionedWorkstreamRef = useRef<string | null>(null);
  const readAckTimerRef = useRef<number | null>(null);
  const readAckInFlightRef = useRef<string | null>(null);
  const activeWorkstreamIdRef = useRef(id);
  const pendingSendCount = useRef(0);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const attachmentDraft = useFileAttachments(api, workstreamDraftKey(id));
  const transcriptDrop = useFileDrop(attachmentDraft.addFiles);
  const railDrop = useFileDrop(attachmentDraft.addFiles);
  // The composer does not take focus when a work stream opens, so a paste that
  // lands on the document reaches the same draft the transcript and rail accept
  // files into.
  useWindowFilePaste(attachmentDraft.addFiles);
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal),
    [api],
  );

  useEffect(() => () => closeRail(), [closeRail, id]);

  // Each work stream keeps its own width for each panel, so the sidebar opens
  // at the width this stream was last left at rather than the last one visited.
  useEffect(() => {
    setRailScope(id);
    return () => setRailScope(null);
  }, [id, setRailScope]);

  useEffect(() => {
    activeWorkstreamIdRef.current = id;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    pendingOlderAfterReconnectRef.current = false;
    pendingNewerAfterReconnectRef.current = false;
    pendingJumpAfterReconnectRef.current = false;
    initialPositionedWorkstreamRef.current = null;
    readAckInFlightRef.current = null;
    if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    readAckTimerRef.current = null;
    setLoadingOlder(false);
    setOlderMessagesError(undefined);
  }, [id]);

  useEffect(() => {
    if (!resourceDialogOpen) {
      setDebouncedResourceSearch('');
      return;
    }
    const timeout = window.setTimeout(() => setDebouncedResourceSearch(resourceSearch.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [resourceDialogOpen, resourceSearch]);

  // These fetchers are recovery paths, not the normal open. Selecting a work
  // stream admits its feed socket immediately; the first snapshot populates
  // both query keys. Keeping the REST readers attached to disabled observers
  // gives the reconnecting/unavailable Retry button an explicit canonical fallback
  // without racing a second boot against the room on every navigation.
  const initialFeedCacheState = useMemo(() => (
    queryClient.getQueryData(['ordered-transcript', id]) !== undefined
      ? 'feed_cached'
      : queryClient.getQueryData(['workstream', id]) !== undefined ? 'detail_cached' : 'cold'
  ), [id, queryClient]);
  const fetchWorkstreamDetail = useCallback(async (signal?: AbortSignal): Promise<WorkstreamDetail> => {
    const snapshotGeneration = queryClient.getQueryData<number>(
      workstreamSocketSnapshotGenerationQueryKey(id),
    ) ?? 0;
    const boot = await api!.getWorkstream(id, signal, workstreamFeedOpenAttemptId(id));
    if ((queryClient.getQueryData<number>(
      workstreamSocketSnapshotGenerationQueryKey(id),
    ) ?? 0) !== snapshotGeneration) {
      const socketDetail = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
      if (socketDetail) return socketDetail;
      throw new Error('Socket snapshot superseded REST work-stream recovery');
    }
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', id],
      boot.transcript,
    );
    const canonical = orderedTranscriptMessages(boot.transcript, id);
    const pendingOverlays = boot.transcript.pendingInputs.map((input) =>
      pendingTranscriptInputOverlay(input, id, {
        source: 'rest_snapshot',
        snapshotId: boot.transcript.snapshotId,
      }));
    queryClient.setQueryData<TranscriptOverlay[]>(
      transcriptOverlaysQueryKey(id),
      (current) => reconcileAuthoritativeTranscriptOverlays(canonical, current, pendingOverlays),
    );
    queryClient.setQueryData<WorkstreamFeedSource>(workstreamFeedSourceQueryKey(id), 'boot_payload');
    return detailFromRecoveryBoot(boot);
  }, [api, id, queryClient]);
  const workstream = useQuery<WorkstreamDetail>({
    queryKey: ['workstream', id],
    queryFn: ({ signal }) => fetchWorkstreamDetail(signal),
    enabled: false,
    staleTime: 5_000,
  });
  const orderedTranscript = useQuery<WorkstreamTranscriptSnapshot | undefined>({
    queryKey: ['ordered-transcript', id],
    queryFn: async () => undefined,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const transcriptOverlays = useQuery<TranscriptOverlay[]>({
    queryKey: transcriptOverlaysQueryKey(id),
    queryFn: async () => [],
    enabled: false,
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const telemetryOpenedWorkstreamRef = useRef<string | null>(null);
  useEffect(() => {
    const detail = workstream.data;
    if (!detail || detail.id !== id || telemetryOpenedWorkstreamRef.current === detail.id) return;
    telemetryOpenedWorkstreamRef.current = detail.id;
    reportTelemetryProductIntent({
      kind: 'workstream_opened',
      workstreamId: detail.id,
      visibility: telemetryVisibility(detail.scope),
      navigation: workstreamNavigation(detail.id),
      origin: detail.systemKind ? 'system' : detail.origin,
      pinned: detail.pinPosition !== null,
    });
  }, [id, workstream.data]);
  const payloadBelongsToRoute = workstreamPayloadBelongsToRoute(
    id,
    workstream.data,
    orderedTranscript.data,
  );
  const routedDetail = payloadBelongsToRoute ? workstream.data : undefined;
  useEffect(() => {
    if (workstream.isError) {
      cancelWorkstreamFeedOpen(id, performance.now(), readSocketOpenContext().socketLeaseId);
    }
  }, [id, readSocketOpenContext, workstream.isError]);
  const feedSource = useQuery<WorkstreamFeedSource | null>({
    queryKey: workstreamFeedSourceQueryKey(id),
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const initialFeedTelemetrySnapshot = useMemo<{
    feedSource: WorkstreamFeedSource;
    messageCount: ReturnType<typeof telemetryCountBucket>;
  } | null>(() => {
    if (!routedDetail || !orderedTranscript.data) return null;
    const resolvedFeedSource = initialFeedCacheState === 'feed_cached'
      ? 'feed_cache'
      : feedSource.data;
    if (!resolvedFeedSource) return null;
    return {
      feedSource: resolvedFeedSource,
      messageCount: telemetryCountBucket(orderedTranscript.data.ranges.reduce(
        (count, range) => count + range.turns.reduce(
          (turnCount, turn) => turnCount + turn.blocks.length,
          0,
        ),
        orderedTranscript.data.activeTurns.reduce(
          (count, turn) => count + turn.blocks.length,
          0,
        ),
      )),
    };
  }, [feedSource.data, initialFeedCacheState, orderedTranscript.data, routedDetail]);
  useWorkstreamFeedOpenTelemetry({
    cacheState: initialFeedCacheState,
    feedSource: initialFeedTelemetrySnapshot?.feedSource,
    isReady: payloadBelongsToRoute,
    messageCount: initialFeedTelemetrySnapshot?.messageCount,
    readSocketOpenContext,
    workstreamId: id,
  });
  // The rail's detail reads through the *preview* route, exactly as the
  // attachment lightbox does: it materializes readable text for a file that is
  // not already text, which is what makes a cited Word file or PDF worth
  // opening. The identity is stable so the preview's effect does not refire on
  // every commit of the screen around it.
  const loadResourceContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error('No API session'));
      return api.getResourcePreviewContent(resourceId, signal);
    },
    [api],
  );
  // Citations resolve against the loaded work stream's resources, and the
  // transcript needs this before the screen has decided it has a work stream to
  // draw at all — hence `routedDetail?`, and hence the hoisted empty array,
  // which keeps the identity stable while there is nothing loaded. It is
  // declared after the preview read because it now takes it: the embed card's
  // excerpt is the same derivative the rail's panel shows.
  const citations = useCitations({
    loadResourceContent,
    resources: routedDetail?.resources ?? NO_RESOURCES,
  });
  const automationSubscriptionId = routedDetail?.automationSubscriptionId;
  const deferredContext = useQuery({
    queryKey: ['workstream-context', id, automationSubscriptionId ?? null],
    queryFn: ({ signal }) => api!.getWorkstreamContext(id, automationSubscriptionId, signal),
    enabled: Boolean(api && id && routedDetail && orderedTranscript.data),
    staleTime: 5_000,
  });
  // No request and no open gate of its own. The independently-started control
  // socket writes the preference when it arrives; until then the dashboard is
  // simply closed and the feed remains fully usable.
  const blockDashboardPreference = useQuery<BlockDashboardPreference | null>({
    queryKey: ['block-dashboard-preference', id],
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const blockDashboardPreferred = blockDashboardPreference.data?.visible ?? false;
  const blockDashboardOpen = featureFlags.data?.hypersightEnabled === true
    && blockDashboardHoldsSidebar(blockDashboardPreferred, railOpen);
  // Handing the sidebar from one panel to the other keeps the panel that lost
  // it on screen a moment longer, fading out over the one that took it while
  // the slot animates between their two widths.
  const railLeaving = useRailCrossFade<RailPanel>(blockDashboardOpen ? 'block-dashboard' : railOpen ? 'inspector' : null);
  const blockDashboard = useQuery({
    queryKey: ['block-dashboard', id],
    queryFn: ({ signal }) => api!.getBlockDashboard(id, signal),
    enabled: Boolean(api && id && blockDashboardOpen),
    staleTime: 5_000,
  });
  const reportedHyperSightOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!blockDashboardOpen) {
      reportedHyperSightOpen.current = null;
      return;
    }
    if (!blockDashboard.data || reportedHyperSightOpen.current === id) return;
    reportedHyperSightOpen.current = id;
    reportTelemetryProductIntent({
      kind: 'hypersight_opened',
      workstreamId: id,
      blockCount: telemetryCountBucket(blockDashboard.data.blocks.length),
    });
  }, [blockDashboard.data, blockDashboardOpen, id]);
  const blockDashboardConnectionStates = useBlockDashboardSockets(
    api,
    id,
    blockDashboard.data?.blocks.map((block) => block.id) ?? [],
    Boolean(api && id && blockDashboardOpen && blockDashboard.isSuccess),
  );
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const availableResources = useInfiniteQuery({
    queryKey: ['resources', debouncedResourceSearch],
    queryFn: ({ pageParam, signal }) => api!.listResources({
      ...(debouncedResourceSearch ? { query: debouncedResourceSearch } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
      limit: 50,
      signal,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(api && resourceDialogOpen),
    staleTime: 15_000,
  });
  const socketConnection = useRetainedWorkstreamSocket(
    api,
    id,
    Boolean(api && id),
  );
  const requestSocketSnapshot = socketConnection.requestSnapshot;
  useEffect(() => {
    if (socketConnection.state !== 'connected' || payloadBelongsToRoute) return;
    requestSocketSnapshot();
  }, [payloadBelongsToRoute, requestSocketSnapshot, socketConnection.state]);
  useWorkstreamSendReadyTelemetry({
    isReady: socketConnection.sendReady,
    workspaceSocketState: socketConnection.workspaceSocketState,
    workstreamId: id,
  });
  const socketState = socketConnection.state;
  const loadTranscriptRange = socketConnection.loadTranscriptRange;
  const olderTranscriptRange = orderedTranscript.data
    ? adjacentTranscriptRange(orderedTranscript.data, 'older')
    : null;
  const newerTranscriptRange = orderedTranscript.data
    ? adjacentTranscriptRange(orderedTranscript.data, 'newer')
    : null;
  // Streaming reveal changes only presentation overlays, potentially once per
  // painted frame. Keep the canonical flatten/dedupe/sort outside that clock:
  // it changes only when the durable snapshot or author projection changes.
  const canonicalTranscript = useMemo(() => orderedTranscriptMessages(
    orderedTranscript.data,
    id,
    members.data ?? [],
  ), [id, members.data, orderedTranscript.data]);
  const transcript = useMemo(
    () => groupPluginToolMessages(composeTranscript(canonicalTranscript, transcriptOverlays.data)),
    [canonicalTranscript, transcriptOverlays.data],
  );
  // Held here rather than in the row: the virtualizer unmounts a row that
  // leaves the window but keeps the height it measured, so an open row that
  // came back closed would shrink under a cache that still expects it open.
  const [expandedSystemRows, setExpandedSystemRows] = useState<ReadonlySet<string>>(() => new Set());
  const systemRowDisclosure = useMemo<SystemRowDisclosure>(() => ({
    expanded: expandedSystemRows,
    onToggle: (messageId) => setExpandedSystemRows((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    }),
  }), [expandedSystemRows]);
  const transcriptVirtualizer = useVirtualizer({
    count: transcript.length,
    estimateSize: () => 140,
    getItemKey: (index) => transcript[index]?.id ?? index,
    getScrollElement: () => transcriptRef.current,
    overscan: 8,
  });
  // Following the newest message is off until the screen has put this work
  // stream's viewport where it belongs, and off again whenever the end of the
  // transcript is a page away rather than loaded.
  const {
    atEnd: transcriptAtEnd,
    onScroll: onTranscriptScroll,
    onWheel: onTranscriptWheel,
    release: releaseTranscriptFollow,
    scrollTo: scrollTranscriptTo,
    scrollToEnd: scrollTranscriptToEnd,
  } = useTranscriptFollow(
    transcriptRef,
    initialPositionedWorkstreamRef.current === id
      && transcript.length > 0
      && orderedTranscript.data !== undefined
      && adjacentTranscriptRange(orderedTranscript.data, 'newer') === null,
    id,
  );

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', id],
    );
    const orderedRange = orderedSnapshot
      ? adjacentTranscriptRange(orderedSnapshot, 'older')
      : null;
    if (!orderedSnapshot || !orderedRange || loadingOlderRef.current) return;
    if (socketState !== 'connected') {
      pendingOlderAfterReconnectRef.current = true;
      setOlderMessagesError(undefined);
      return;
    }
    pendingOlderAfterReconnectRef.current = false;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderMessagesError(undefined);
    const scrollElement = transcriptRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    const previousScrollTop = scrollElement?.scrollTop ?? 0;
    try {
      while (activeWorkstreamIdRef.current === id) {
        const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', id],
        );
        const range = snapshot ? adjacentTranscriptRange(snapshot, 'older') : null;
        if (!snapshot || !range) return;
        try {
          await loadTranscriptRange({
            snapshotId: snapshot.snapshotId,
            range,
            resumeAfterEventSequence: snapshot.eventSequence,
          });
          break;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'transcript_snapshot_changed') continue;
          throw error;
        }
      }
      if (activeWorkstreamIdRef.current !== id) return;
      window.requestAnimationFrame(() => {
        const element = transcriptRef.current;
        if (!element) return;
        scrollTranscriptTo(preservedPrependScrollTop(
          previousScrollTop,
          previousScrollHeight,
          element.scrollHeight,
        ));
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workstream_socket_unavailable') {
        pendingOlderAfterReconnectRef.current = true;
        return;
      }
      setOlderMessagesError(error instanceof Error ? error.message : 'Earlier messages could not be loaded.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [id, loadTranscriptRange, queryClient, scrollTranscriptTo, socketState]);

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', id],
    );
    const orderedRange = orderedSnapshot
      ? adjacentTranscriptRange(orderedSnapshot, 'newer')
      : null;
    if (!orderedSnapshot || !orderedRange || loadingNewerRef.current) return;
    if (socketState !== 'connected') {
      pendingNewerAfterReconnectRef.current = true;
      setOlderMessagesError(undefined);
      return;
    }
    pendingNewerAfterReconnectRef.current = false;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      while (activeWorkstreamIdRef.current === id) {
        const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', id],
        );
        const range = snapshot ? adjacentTranscriptRange(snapshot, 'newer') : null;
        if (!snapshot || !range) return;
        try {
          await loadTranscriptRange({
            snapshotId: snapshot.snapshotId,
            range,
            resumeAfterEventSequence: snapshot.eventSequence,
          });
          break;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'transcript_snapshot_changed') continue;
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workstream_socket_unavailable') {
        pendingNewerAfterReconnectRef.current = true;
        return;
      }
      setOlderMessagesError(error instanceof Error ? error.message : 'Newer messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [id, loadTranscriptRange, queryClient, socketState]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    if (loadingNewerRef.current) return;
    if (socketState !== 'connected') {
      pendingJumpAfterReconnectRef.current = true;
      setOlderMessagesError(undefined);
      return;
    }
    pendingJumpAfterReconnectRef.current = false;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
        ['ordered-transcript', id],
      );
      if (!orderedSnapshot || orderedSnapshot.snapshotThrough === 0) {
        window.requestAnimationFrame(() => scrollTranscriptToEnd({ smooth: true }));
        return;
      }
      if (orderedSnapshot?.ranges.some((range) =>
        range.covered.endExclusive === orderedSnapshot.snapshotThrough + 1)) {
        window.requestAnimationFrame(() => scrollTranscriptToEnd({ smooth: true }));
        return;
      }
      let snapshot = orderedSnapshot;
      let range = adjacentTranscriptRange(snapshot, 'newer');
      while (range) {
        try {
          await loadTranscriptRange({
            snapshotId: snapshot.snapshotId,
            range,
            resumeAfterEventSequence: snapshot.eventSequence,
          });
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'transcript_snapshot_changed') throw error;
          const refreshed = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
            ['ordered-transcript', id],
          );
          if (!refreshed) throw error;
          snapshot = refreshed;
          range = adjacentTranscriptRange(snapshot, 'newer');
          continue;
        }
        if (activeWorkstreamIdRef.current !== id) return;
        const next = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', id]);
        if (!next) {
          throw new Error('Rally could not load the latest messages. Try again.');
        }
        if (next.snapshotId !== snapshot.snapshotId) {
          snapshot = next;
          range = adjacentTranscriptRange(snapshot, 'newer');
          continue;
        }
        if (!transcriptCoverageAdvanced(snapshot, next)) {
          throw new Error('Rally could not load the latest messages. Try again.');
        }
        snapshot = next;
        range = adjacentTranscriptRange(snapshot, 'newer');
      }
      // Not `scrollToIndex`: aimed at the last row with `align: 'end'` it
      // targets the virtualizer's maximum offset, which it recomputes every
      // frame for five seconds — against a row still growing that is a second
      // follow, competing with this one and with the reader.
      window.requestAnimationFrame(() => scrollTranscriptToEnd({ smooth: true }));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workstream_socket_unavailable') {
        pendingJumpAfterReconnectRef.current = true;
        return;
      }
      setOlderMessagesError(error instanceof Error ? error.message : 'The latest messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [id, loadTranscriptRange, queryClient, scrollTranscriptToEnd, socketState]);

  useEffect(() => {
    if (socketState !== 'connected') return;
    if (pendingJumpAfterReconnectRef.current) {
      pendingJumpAfterReconnectRef.current = false;
      void jumpToLatest();
      return;
    }
    if (pendingNewerAfterReconnectRef.current) {
      pendingNewerAfterReconnectRef.current = false;
      void loadNewerMessages();
    }
    if (pendingOlderAfterReconnectRef.current) {
      pendingOlderAfterReconnectRef.current = false;
      void loadOlderMessages();
    }
  }, [jumpToLatest, loadNewerMessages, loadOlderMessages, socketState]);

  const addParticipant = useMutation({
    mutationFn: (member: WorkspaceMember) => api!.addParticipant(id, member.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setParticipantDialogOpen(false);
    },
  });

  const removeParticipant = useMutation({
    mutationFn: (member: WorkspaceMember) => api!.removeParticipant(id, member.id),
    onSuccess: (_result, member) => {
      const previous = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        participants: current.participants.filter((participant) => participant.id !== member.id),
      } : current);
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      if (member.id === session?.user.id && previous?.scope === 'personal') {
        setParticipantDialogOpen(false);
        queryClient.removeQueries({ queryKey: ['workstream', id], exact: true });
        void navigate('/workstreams/new', { replace: true });
      }
    },
  });

  // The header renames in place, so both the open detail and the sidebar list
  // have to show the new title without a refetch round trip.
  const renameWorkstream = useMutation({
    mutationFn: (title: string) => api!.renameWorkstream(id, title),
    onSuccess: (updated) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) =>
        current ? { ...current, title: updated.title } : current,
      );
      setCachedWorkstreams(queryClient, (current) =>
        current?.map((item) => item.id === updated.id ? { ...item, ...updated } : item),
      );
    },
  });

  const attachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.attachResource(id, resource.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setResourceDialogOpen(false);
      setResourceSearch('');
    },
  });

  const updateBlockDashboard = useMutation({
    mutationFn: (blocks: Array<{ id: string; prompt: string }>) => {
      const current = queryClient.getQueryData<BlockDashboard>(['block-dashboard', id]) ?? blockDashboard.data;
      if (!current) throw new Error('HyperSight is not ready yet.');
      return api!.updateBlockDashboard(id, {
        expectedVersionNumber: current.versionNumber,
        blocks,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['block-dashboard', id], updated);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['block-dashboard', id], exact: true });
    },
  });

  const updateBlockDashboardPreference = useMutation({
    mutationFn: (visible: boolean) => api!.updateBlockDashboardPreference(id, visible),
    onMutate: async (visible) => {
      await queryClient.cancelQueries({ queryKey: ['block-dashboard-preference', id], exact: true });
      const previous = queryClient.getQueryData<BlockDashboardPreference>(['block-dashboard-preference', id]);
      queryClient.setQueryData<BlockDashboardPreference>(['block-dashboard-preference', id], {
        visible,
        updatedAt: previous?.updatedAt ?? null,
      });
      return { previous };
    },
    onError: (_error, _visible, context) => {
      queryClient.setQueryData(['block-dashboard-preference', id], context?.previous);
    },
    onSuccess: (preference) => {
      queryClient.setQueryData(['block-dashboard-preference', id], preference);
    },
  });
  const { mutate: persistBlockDashboardPreference } = updateBlockDashboardPreference;

  // HyperSight and the inspector rail share the right sidebar and are never
  // open together. HyperSight's visibility is a stored personal preference
  // rather than window state, so yielding the sidebar to the rail is written
  // back the same way the toggle is: the next visit opens where this one left
  // off.
  const setBlockDashboardVisible = useCallback((visible: boolean): void => {
    if (visible) closeRail();
    persistBlockDashboardPreference(visible);
  }, [closeRail, persistBlockDashboardPreference]);

  const openRailVariant = useCallback((variant: RailVariant): void => {
    openRail(variant);
    if (blockDashboardPreferred) persistBlockDashboardPreference(false);
  }, [blockDashboardPreferred, openRail, persistBlockDashboardPreference]);

  // The shell lays the main pane out against whichever panel holds the right
  // sidebar, and only this screen knows whether HyperSight has it — or which
  // panel is still fading out of it.
  useEffect(() => {
    setBlockDashboardOpen(blockDashboardOpen);
  }, [blockDashboardOpen, setBlockDashboardOpen]);
  useEffect(() => {
    setRailLeaving(railLeaving);
    return () => setRailLeaving(null);
  }, [railLeaving, setRailLeaving]);
  useEffect(() => () => setBlockDashboardOpen(false), [setBlockDashboardOpen]);

  const stop = useMutation({
    mutationFn: () => api!.stopHarness(id),
    onSuccess: () => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) =>
        current ? { ...current, stopRequested: true } : current);
      requestSocketSnapshot();
      void queryClient.invalidateQueries({ queryKey: ['workstream-context', id] });
    },
  });

  const retry = useMutation({
    mutationFn: () => api!.retryHarness(id),
    onSuccess: async () => {
      requestSocketSnapshot();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    },
  });

  const watchResource = useMutation({
    mutationFn: ({ resource, enabled }: { resource: WorkstreamResource; enabled: boolean }) =>
      api!.setResourceWatch(id, resource.id, enabled),
    onMutate: async ({ resource, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['workstream', id], exact: true });
      const previous = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === resource.id ? {
          ...item,
          watchEnabled: enabled,
          watchStatus: enabled ? 'watching' : 'paused',
        } : item),
      } : current);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['workstream', id], context.previous);
    },
    onSuccess: (result, { resource, enabled }) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === resource.id ? {
          ...item,
          watchEnabled: result.enabled,
          watchStatus: result.enabled ? 'watching' : enabled ? 'error' : 'paused',
        } : item),
      } : current);
    },
  });

  const detachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.detachResource(id, resource.id),
    onSuccess: (_result, resource) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.filter((item) => item.id !== resource.id),
      } : current);
    },
  });

  // The rail's detail shows one resource at a time, so its history is fetched
  // for that one rather than for every attachment the work stream carries.
  const inspectedResourceId = inspector?.type === 'resource' ? inspector.id : null;
  const inspectedResourceVersion = workstream.data?.resources
    .find((resource) => resource.id === inspectedResourceId)?.currentVersion ?? null;
  const resourceVersions = useQuery({
    queryKey: resourceVersionsQueryKey(inspectedResourceId, inspectedResourceVersion),
    queryFn: ({ signal }) => api!.getResourceVersions(inspectedResourceId!, signal),
    // `closeRail` deliberately keeps the inspector's selection, so without the
    // rail's own state here the query keeps refetching for a panel nobody can
    // see.
    enabled: Boolean(api && inspectedResourceId && railOpen),
  });

  const refreshResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.refreshResource(resource.id),
    onSuccess: (refreshed) => {
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === refreshed.id
          ? { ...item, ...refreshed, relationshipType: item.relationshipType, direction: item.direction }
          : item),
      } : current);
      // The re-fetch is exactly the pointer swap that writes a version, so the
      // list the rail is showing is one entry out of date the moment it lands.
      // Prefix-matched, because the key carries the version this resource was
      // at: the swap moves that number and would refetch on its own, and this
      // covers the re-fetch the provider answered without changing anything.
      void queryClient.invalidateQueries({ queryKey: ['resource-versions', refreshed.id] });
    },
  });

  const openResourceVersion = useCallback((
    resource: WorkstreamResource,
    version: ResourceVersion,
    returnFocus: HTMLElement,
  ) => {
    setAttachmentPreview({
      // The version's own title and type. A rename is itself what captured the
      // version being opened, so the current name over old bytes would name
      // the wrong thing in the one surface built to keep them apart.
      name: version.title,
      ...(version.mimeType ? { mimeType: version.mimeType } : {}),
      loadContent: (signal?: AbortSignal) => api!.getResourceVersionContent(resource.id, version.version, signal),
      returnFocus,
      superseded: {
        // Says which version and that it is not the live one, in that order:
        // "of N" alone leaves a reader to work out that V2 of 3 is history.
        label: `Version ${version.version} · not current`,
        onReturnToCurrent: () => setAttachmentPreview({
          name: resource.title,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          loadContent: (signal?: AbortSignal) => loadAttachmentContent(resource.id, signal),
          returnFocus,
        }),
      },
    });
  }, [api, loadAttachmentContent]);

  const activeElicitation = transcript.find((message) =>
    message.messageType === 'elicitation' && message.elicitation?.status === 'open')?.elicitation;

  const answerElicitation = async (
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void> => {
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', id], (current) =>
      current ? setTranscriptElicitationState(current, elicitationId, {
        status: 'answered',
        answer,
      }) : current);
    const previous = queryClient.getQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id))
      ?.find((overlay) => overlay.identity.type === 'elicitation'
        && overlay.identity.elicitationId === elicitationId);
    queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) =>
      (current ?? []).map((overlay) => overlay.identity.type === 'elicitation'
        && overlay.identity.elicitationId === elicitationId
        && overlay.message.elicitation
        ? {
            ...overlay,
            message: {
              ...overlay.message,
              elicitation: { ...overlay.message.elicitation, status: 'answered', answer },
            },
          }
        : overlay));
    try {
      await api!.answerElicitation(id, elicitationId, answer, customResponse);
      requestSocketSnapshot();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    } catch (error) {
      queryClient.setQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', id], (current) =>
        current ? setTranscriptElicitationState(current, elicitationId, {
          status: 'open',
          answer: null,
        }) : current);
      if (previous) {
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) =>
          upsertTranscriptOverlay(current, previous));
      }
      throw error;
    }
  };

  const sendMessage = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
    deliveryMode?: WorkstreamMessageDeliveryMode,
  ): Promise<void> => {
    if (!api || !routedDetail) throw new Error('This work stream is not ready to receive messages.');
    // Ahead of the optimistic turn and of `sending`. A message the server will
    // refuse must not appear in the transcript first and be pulled back out of
    // it, and the person is the only one who can resolve this.
    //
    // Rejecting rather than returning, because `WorkstreamComposer.send` clears
    // the draft *before* awaiting this and restores it only if this rejects. A
    // refusal that resolved would therefore delete the message it is asking the
    // person to shorten — the one outcome worse than sending it. Every other
    // failure below throws for the same reason; this is not an error path that
    // happens to throw, it is the contract that surface is built on.
    if (text.length > MESSAGE_MAX_CHARACTERS) {
      setSendError(MESSAGE_TOO_LONG_MESSAGE);
      throw new ApiError(MESSAGE_TOO_LONG_MESSAGE, 400, 'message_too_long');
    }
    // Sending is the strongest statement anyone can make that they mean to be
    // at the end: they are about to add to it, and the answer is what they are
    // waiting for. Before the follow could be stopped at all this happened by
    // accident, because the next token re-armed it.
    scrollTranscriptToEnd();
    pendingSendCount.current += 1;
    setSending(true);
    setSendError(undefined);
    if (activeElicitation) {
      const response = manualElicitationResponse(activeElicitation, text);
      try {
        await answerElicitation(activeElicitation.id, response.answer, response.customResponse);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'The response could not be sent.');
        throw error;
      } finally {
        pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
        if (pendingSendCount.current === 0) setSending(false);
      }
      return;
    }
    const attachmentLease = await attachmentDraft.leaseReady();
    const readyAttachments = attachmentLease.attachments;
    const clientId = crypto.randomUUID();
    queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) => {
      const latestTranscript = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
        ['ordered-transcript', id],
      );
      const afterTranscriptSequence = latestTranscript?.snapshotThrough ?? 0;
      const eventSequence = Math.max(
        latestTranscript?.eventSequence ?? 0,
        ...(current ?? [])
          .filter((overlay) => overlay.position.afterTranscriptSequence === afterTranscriptSequence)
          .map((overlay) => overlay.position.eventSequence),
      ) + 1;
      const createdAt = new Date().toISOString();
      const optimistic = createTextMessage({
        id: clientId,
        clientMessageId: clientId,
        workstreamId: id,
        sequenceNumber: 0,
        authorType: 'human',
        author: workspaceMemberFromSession(session),
        text,
        attachments: readyAttachments.flatMap((attachment) => attachment.resource ? [{
          id: attachment.resource.id,
          fileName: attachment.file.name,
          mimeType: attachment.file.type || 'application/octet-stream',
          sizeBytes: attachment.file.size,
          contentAvailable: true,
          createdAt,
        }] : []),
        createdAt,
        deliveryState: 'sending',
      });
      return upsertTranscriptOverlay(current, {
        identity: { type: 'client_message', clientMessageId: clientId },
        provenance: { source: 'client_command', phase: 'sending' },
        position: { afterTranscriptSequence, eventSequence },
        message: optimistic,
      });
    });
    try {
      const created = await socketConnection.createMessage({
        text,
        clientId,
        mentions,
        confirmedParticipantUserIds,
        attachmentIds: readyAttachments.flatMap((attachment) => attachment.resource ? [attachment.resource.id] : []),
        ...(deliveryMode ? { runMode: deliveryMode } : {}),
      });
      queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) => {
        const optimistic = (current ?? []).find((overlay) =>
          overlay.identity.type === 'client_message'
          && overlay.identity.clientMessageId === clientId
          && overlay.provenance.source === 'client_command');
        if (!optimistic) return current ?? [];
        const turnId = created.turnId;
        const { deliveryState: _deliveryState, ...acceptedMessage } = optimistic.message;
        void _deliveryState;
        const overlayDeliveryState = acceptedMessageOverlayDeliveryState(
          created.deliveryState,
          deliveryMode,
        );
        return upsertTranscriptOverlay(
          removeTranscriptOverlay(current, (overlay) => overlay === optimistic),
          {
            ...optimistic,
            identity: { type: 'client_message', clientMessageId: clientId, turnId },
            provenance: { source: 'client_command', phase: 'accepted' },
            message: {
              ...acceptedMessage,
              id: turnId,
              clientMessageId: created.clientMessageId,
              transcriptTurnId: turnId,
              createdAt: created.createdAt,
              ...(overlayDeliveryState ? { deliveryState: overlayDeliveryState } : {}),
            },
          },
        );
      });
      attachmentDraft.commitLease(attachmentLease.leaseId);
      requestSocketSnapshot();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    } catch (error) {
      await attachmentDraft.restoreLease(attachmentLease.leaseId);
      queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) =>
        removeTranscriptOverlay(current, (overlay) =>
          overlay.identity.type === 'client_message'
          && overlay.identity.clientMessageId === clientId
          && overlay.provenance.source === 'client_command'));
      setSendError(error instanceof Error ? error.message : 'The message could not be sent.');
      throw error;
    } finally {
      pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
      if (pendingSendCount.current === 0) setSending(false);
    }
  };

  const resolveSuggestion = async (suggestionId: string, action: 'accept' | 'dismiss'): Promise<void> => {
    // Remove the pending detail entry before the request so an overlapping
    // transcript rebuild cannot restore a card whose decision is in flight.
    const pending = queryClient.getQueryData<WorkstreamDetail>(['workstream', id])
      ?.suggestions?.find((suggestion) => suggestion.id === suggestionId);
    const pendingOverlay = queryClient.getQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id))
      ?.find((overlay) => overlay.identity.type === 'activity_suggestion'
        && overlay.identity.suggestionId === suggestionId);
    queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current
      ? { ...current, suggestions: (current.suggestions ?? []).filter((suggestion) => suggestion.id !== suggestionId) }
      : current);
    queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) =>
      removeTranscriptOverlay(current, (overlay) => overlay.identity.type === 'activity_suggestion'
        && overlay.identity.suggestionId === suggestionId));
    try {
      await api!.resolveActivitySuggestion(id, suggestionId, action);
      if (action === 'dismiss') {
        queryClient.setQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id), (current) =>
          appendDismissedSuggestionId(current, suggestionId));
      }
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (pending && status !== 404 && status !== 409) {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current
          && !(current.suggestions ?? []).some((suggestion) => suggestion.id === suggestionId)
          ? { ...current, suggestions: [...(current.suggestions ?? []), pending] }
          : current);
        if (pendingOverlay) {
          queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id), (current) =>
            upsertTranscriptOverlay(current, pendingOverlay));
        }
      } else {
        requestSocketSnapshot();
      }
      throw error;
    }
    requestSocketSnapshot();
  };

  useEffect(() => {
    if (!routedDetail || initialPositionedWorkstreamRef.current === id) return;
    initialPositionedWorkstreamRef.current = id;
    const anchorSequence = routedDetail.firstUnreadSequenceNumber;
    window.requestAnimationFrame(() => {
      if (activeWorkstreamIdRef.current !== id) return;
      // A work stream created moments ago has no transcript yet and a run
      // already going. There is nothing to position, and the reply that is
      // about to arrive is what the person is waiting to read.
      if (transcript.length === 0) {
        scrollTranscriptToEnd();
        return;
      }
      const anchorIndex = initialTranscriptAnchorIndex(transcript, anchorSequence);
      if (anchorIndex !== null) {
        // Opened at the first unread message rather than at the end, so the
        // transcript is not following: a run already streaming into this work
        // stream must not pull the reader off the message they came back for.
        releaseTranscriptFollow();
        // The one sanctioned `scrollToIndex`: the rows above the anchor have
        // never been measured, so only the virtualizer can find the offset, and
        // its reconcile loop is what corrects the estimate as they measure. It
        // aims at a row that is not moving, so it settles instead of following.
        transcriptVirtualizer.scrollToIndex(anchorIndex, { align: 'start' });
        return;
      }
      scrollTranscriptToEnd();
    });
  }, [id, routedDetail, transcript, transcriptVirtualizer]);

  const acknowledgeVisibleMessages = useCallback((): void => {
    const detail = queryClient.getQueryData<WorkstreamDetail>(['workstream', id]);
    const element = transcriptRef.current;
    if (!api || !detail || !element || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (initialPositionedWorkstreamRef.current !== id) return;
    const viewportTop = element.scrollTop;
    const viewportBottom = viewportTop + element.clientHeight;
    const visibleIndexes = transcriptVirtualizer.getVirtualItems()
      .filter((item) => item.start < viewportBottom && item.end > viewportTop)
      .map((item) => item.index);
    const highestVisibleSequence = highestVisibleAttentionSequence(
      transcript,
      visibleIndexes,
      detail.latestAttentionSequenceNumber,
    );
    if (highestVisibleSequence === 0) return;
    if (
      highestVisibleSequence <= detail.readThroughSequenceNumber
      && detail.manualUnreadFromSequenceNumber === null
    ) return;
    const ackKey = `${id}:${highestVisibleSequence}:${detail.manualUnreadGeneration}`;
    if (readAckInFlightRef.current === ackKey) return;
    readAckInFlightRef.current = ackKey;
    void api.acknowledgeWorkstreamRead(
      id,
      highestVisibleSequence,
      detail.manualUnreadGeneration,
      currentSurfaceEntrypoint(),
    ).then((updated) => {
      if (activeWorkstreamIdRef.current !== id) return;
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) =>
        current ? { ...current, ...updated } : current);
      setCachedWorkstreams(queryClient, (current) =>
        current?.map((item) => item.id === id ? { ...item, ...updated } : item));
    }).catch(() => {
      requestSocketSnapshot();
    }).finally(() => {
      if (readAckInFlightRef.current === ackKey) readAckInFlightRef.current = null;
    });
  }, [api, id, queryClient, requestSocketSnapshot, transcript, transcriptVirtualizer]);

  const scheduleReadAcknowledgement = useCallback((): void => {
    if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    readAckTimerRef.current = window.setTimeout(() => {
      readAckTimerRef.current = null;
      acknowledgeVisibleMessages();
    }, 250);
  }, [acknowledgeVisibleMessages]);

  useEffect(() => {
    scheduleReadAcknowledgement();
  }, [scheduleReadAcknowledgement, transcript.length]);

  useEffect(() => {
    const acknowledgeOnFocus = (): void => scheduleReadAcknowledgement();
    window.addEventListener('focus', acknowledgeOnFocus);
    document.addEventListener('visibilitychange', acknowledgeOnFocus);
    return () => {
      window.removeEventListener('focus', acknowledgeOnFocus);
      document.removeEventListener('visibilitychange', acknowledgeOnFocus);
      if (readAckTimerRef.current !== null) window.clearTimeout(readAckTimerRef.current);
    };
  }, [scheduleReadAcknowledgement]);

  if (!payloadBelongsToRoute || !routedDetail) {
    if (
      socketConnection.state === 'reconnecting'
      || socketConnection.state === 'unavailable'
      || workstream.error
    ) {
      return (
        <WorkstreamErrorState
          description={workstream.error?.message
            ?? (socketConnection.state === 'reconnecting'
              ? 'The live connection could not be opened. Try again while Rally reconnects.'
              : 'This work stream is unavailable.')}
          onRetry={() => void workstream.refetch()}
          workstreamId={id}
        />
      );
    }
    return <OpeningState label="Opening work stream…" />;
  }

  const detail = routedDetail;
  const runTiming = workstreamRunTiming(detail.harnessStatus, detail.latestHarnessRun);
  const orderedOwnsRunTiming = orderedTranscriptOwnsRunTiming(
    orderedTranscript.data,
    detail.latestHarnessRunId ?? detail.latestHarnessRun?.id,
  );
  const visibleTranscript = transcript;
  const firstUnreadSequenceNumber = detail.firstUnreadSequenceNumber;
  const firstUnreadIndex = firstUnreadSequenceNumber === null
    ? -1
    : visibleTranscript.findIndex((message) =>
      message.realtimeOrder === undefined
      && message.attentionSequenceNumber != null
      && message.attentionSequenceNumber >= firstUnreadSequenceNumber);
  const displayedDetail: WorkstreamDetail = {
    ...detail,
    viewers: workstreamPresenceViewers(
      detail.participants,
      members.data ?? [],
      presenceUserIdsByWorkstream[id] ?? [],
    ),
    automationRuns: deferredContext.data?.automationRuns ?? detail.automationRuns,
    ...(deferredContext.data?.automationSubscription
      ? { automationSubscription: deferredContext.data.automationSubscription }
      : {}),
  };
  const discoveredResources = [...new Map(
    (availableResources.data?.pages.flatMap((page) => page.items) ?? []).map((resource) => [resource.id, resource]),
  ).values()];

  return (
    <div className="workstream-screen">
      {/* The HyperSight preference is independent metadata, never an open or
          interaction gate. The control is optimistic even before the control
          socket's first metadata frame arrives. */}
      <WorkstreamHeader
        blockDashboardAvailable={featureFlags.data?.hypersightEnabled === true}
        blockDashboardOpen={blockDashboardOpen}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onOpenRail={openRailVariant}
        onRename={(title) => renameWorkstream.mutateAsync(title).then(() => undefined)}
        onToggleBlockDashboard={() => setBlockDashboardVisible(!blockDashboardOpen)}
        currentUserId={session?.user.id ?? null}
        presentUserIds={presenceUserIdsByWorkstream[id] ?? []}
        socketState={socketState}
        workstream={displayedDetail}
      />
      {blockDashboardOpen || railLeaving === 'block-dashboard' ? (
        <BlockDashboardRail
          blockCount={blockDashboard.data?.blocks.length ?? 0}
          leaving={railLeaving === 'block-dashboard'}
          onClose={() => setBlockDashboardVisible(false)}
        >
          {blockDashboard.data ? (
            <BlockDashboardPanel
              connectionStates={blockDashboardConnectionStates}
              error={updateBlockDashboard.error?.message ?? blockDashboard.error?.message}
              blockDashboard={blockDashboard.data}
              onChange={(blocks) => updateBlockDashboard.mutateAsync(blocks).then(() => undefined)}
              pending={updateBlockDashboard.isPending}
            />
          ) : blockDashboard.error ? (
            <div className="block-dashboard-load-state">
              <InlineError>{blockDashboard.error.message}</InlineError>
              <Button onClick={() => void blockDashboard.refetch()}><RefreshCcw size={14} /> Try again</Button>
            </div>
          ) : (
            <div className="block-dashboard-load-state">
              <LoadingState label="Opening HyperSight…" />
            </div>
          )}
        </BlockDashboardRail>
      ) : null}
      {/* Focusable so the transcript can be scrolled from the keyboard at all.
          Chromium gives Page Up, Home, and the arrows to a scroller only when it
          can take focus, and the composer takes it when a work stream opens — so
          without this a reader using the keyboard has no way to leave the end of
          a streaming turn, which is the whole thing the follow is built around.
          `log` rather than `region`: the content is appended over time and a
          screen reader should treat it that way. */}
      <div
        aria-label="Transcript"
        className={clsx('transcript-scroll', transcriptDrop.dragging && 'is-file-dragging')}
        role="log"
        tabIndex={0}
        onDragEnter={transcriptDrop.onDragEnter}
        onDragLeave={transcriptDrop.onDragLeave}
        onDragOver={transcriptDrop.onDragOver}
        onDrop={transcriptDrop.onDrop}
        // The transcript reads scrolling intent from the wheel as well as from
        // the scroll it causes, because the two do not arrive in the same frame.
        // `useTranscriptFollow` holds the reasoning.
        //
        // A predominantly horizontal gesture is not that intent, and since the
        // embed-card row a run of citations renders into scrolls sideways
        // inside the transcript, one now reaches this handler: a trackpad swipe
        // across a row of cards carries enough vertical drift to look like a
        // scroll up, which would drop the reader out of follow and raise Jump
        // to latest in the middle of a streaming turn.
        onWheel={(event) => {
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          onTranscriptWheel(event.currentTarget, event.deltaY);
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          onTranscriptScroll(element);
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < TRANSCRIPT_END_SLACK;
          if (shouldLoadEarlierFromScroll(
            element.scrollTop,
            olderTranscriptRange !== null,
            loadingOlderRef.current,
          )) {
            void loadOlderMessages();
          }
          if (nearBottom
            && newerTranscriptRange !== null
            && !loadingNewerRef.current) {
            void loadNewerMessages();
          }
          scheduleReadAcknowledgement();
        }}
        ref={transcriptRef}
      >
        <div className="transcript-column">
          {olderTranscriptRange && (
            <div className="transcript-history-control">
              <Button disabled={loadingOlder || socketState !== 'connected'} onClick={() => void loadOlderMessages()}>
                {loadingOlder || socketState !== 'connected'
                  ? <LoaderCircle aria-hidden="true" className="spin" size={14} />
                  : <ArrowUp aria-hidden="true" size={14} />}
                {loadingOlder
                  ? 'Loading earlier messages…'
                  : socketState !== 'connected'
                    ? 'Waiting to reconnect…'
                    : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {olderMessagesError && <InlineError>{olderMessagesError}</InlineError>}
          {/* Not while a run is going. A work stream opened the instant it was
              created has an empty transcript and an agent already working on
              it, and inviting the person to start it is both wrong and the
              opposite of what the timer below says. The turn arrives moments
              later; until then the timer is the whole of the state. */}
          {workstreamShowsReadyState(
            visibleTranscript.length,
            Boolean(activeElicitation),
            detail.harnessStatus,
          ) ? (
            <EmptyState title="Ready to begin" description="Send a message to start work in this stream." />
          ) : (
            <div
              className="virtual-transcript"
              style={{ height: `${transcriptVirtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {transcriptVirtualizer.getVirtualItems().map((virtualRow) => {
                const message = visibleTranscript[virtualRow.index];
                if (!message) return null;
                return (
                  <div
                    className="virtual-message-row"
                    data-index={virtualRow.index}
                    key={message.id}
                    ref={transcriptVirtualizer.measureElement}
                    style={{
                      left: 0,
                      position: 'absolute',
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: '100%',
                    }}
                  >
                    {virtualRow.index === firstUnreadIndex && (
                      <div className="unread-divider" role="separator"><span>Unread messages</span></div>
                    )}
                    {message.blocksOmittedPlaceholder ? (
                      <div className="transcript-history-control" role="status">
                        <span>This message is too large to display.</span>
                      </div>
                    ) : (
                      <MessageBlock
                        citations={citations}
                        currentUserId={session?.user.id}
                        loadAttachmentContent={loadAttachmentContent}
                        message={message}
                        onAnswerElicitation={answerElicitation}
                        onOpenAttachment={setAttachmentPreview}
                        onResolveSuggestion={resolveSuggestion}
                        systemRowDisclosure={systemRowDisclosure}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {socketConnection.activeCompaction
            && detail.harnessStatus === 'running'
            && socketConnection.activeCompaction.harnessRunId === (detail.latestHarnessRunId ?? detail.latestHarnessRun?.id)
            ? <AgentCompactionIndicator />
            : !orderedOwnsRunTiming
              && runTiming
              && <AgentWorkTiming key={detail.latestHarnessRunId ?? detail.latestHarnessRun?.id} {...runTiming} />}
          {detail.harnessStatus === 'failed' && detail.latestHarnessRun?.status === 'failed' && (
            <RunFailureNotice
              code={detail.latestHarnessRun.error?.code ?? 'harness_execution_failed'}
              message={detail.latestHarnessRun.error?.message ?? 'Rally could not complete this run. Retrying is unlikely to help — copy the request ID for support.'}
              onCopyRequestId={() => void desktopBridge().copyText(detail.latestHarnessRun?.requestId ?? detail.latestHarnessRun!.id)}
              onRetry={() => retry.mutate()}
              requestId={detail.latestHarnessRun.requestId ?? detail.latestHarnessRun.id}
              retrying={retry.isPending}
            />
          )}
          {detail.latestHarnessRun?.status === 'stopped' && (
            <RunStoppedNotice onRetry={() => retry.mutate()} retrying={retry.isPending} />
          )}
        </div>
      </div>

      <div className="composer-dock">
        {!transcriptAtEnd && (
          <JumpToLatestButton onJump={() => void jumpToLatest()} />
        )}
        <div className="composer-stack">
          <WorkstreamComposer
            api={api ?? undefined}
            attachments={attachmentDraft.attachments}
            error={sendError ?? attachmentDraft.error ?? attachResource.error?.message ?? stop.error?.message ?? retry.error?.message}
            fileInputRef={fileInputRef}
            members={members.data ?? []}
            onAttach={attachmentDraft.addFiles}
            onOpenAttachment={setAttachmentPreview}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSend={sendMessage}
            onStop={async () => {
              await stop.mutateAsync();
            }}
            sending={sending}
            uploading={attachmentDraft.uploading}
            key={displayedDetail.id}
            workstream={displayedDetail}
          />
        </div>
      </div>

      <InspectorRail
        dropTarget={railDrop}
        {...(api ? { loadResourceContent: loadResourceContent } : {})}
        error={deferredContext.error?.message
          ?? watchResource.error?.message
          ?? detachResource.error?.message
          ?? refreshResource.error?.message
          ?? attachResource.error?.message}
        leaving={railLeaving === 'inspector'}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onAddResource={() => setResourceDialogOpen(true)}
        onDetachResource={(resource) => detachResource.mutate(resource)}
        onOpenResourceVersion={openResourceVersion}
        onOpenRun={(run) => void navigate(`/workstreams/${run.workstreamId}`)}
        onRefreshResource={(resource) => refreshResource.mutate(resource)}
        onToggleWatch={(resource, enabled) => watchResource.mutate({ resource, enabled })}
        refreshingResourceId={refreshResource.isPending ? refreshResource.variables?.id ?? null : null}
        resourceVersions={resourceVersions.data ?? []}
        resourceVersionsError={resourceVersions.error?.message}
        workstream={displayedDetail}
      />

      <AddParticipantDialog
        current={displayedDetail.participants}
        error={addParticipant.error?.message ?? removeParticipant.error?.message}
        members={members.data ?? []}
        onAdd={(member) => {
          removeParticipant.reset();
          addParticipant.mutate(member);
        }}
        onRemove={(member) => {
          addParticipant.reset();
          removeParticipant.mutate(member);
        }}
        onOpenChange={(next) => {
          // A refused add is only worth showing while the dialog that provoked
          // it is open. Reopening starts clean rather than reporting the last
          // attempt as though it were this one.
          if (!next) {
            addParticipant.reset();
            removeParticipant.reset();
          }
          setParticipantDialogOpen(next);
        }}
        open={participantDialogOpen}
        pending={addParticipant.isPending || removeParticipant.isPending}
      />
      <AddResourceDialog
        current={displayedDetail.resources}
        error={availableResources.error?.message ?? attachResource.error?.message}
        fetching={availableResources.isFetchingNextPage}
        hasMore={Boolean(availableResources.hasNextPage)}
        loading={availableResources.isLoading}
        onAttach={(resource) => attachResource.mutate(resource)}
        onLoadMore={() => void availableResources.fetchNextPage()}
        onOpenChange={(open) => {
          setResourceDialogOpen(open);
          if (!open) setResourceSearch('');
        }}
        onSearchChange={setResourceSearch}
        onUpload={() => {
          setResourceDialogOpen(false);
          fileInputRef.current?.click();
        }}
        open={resourceDialogOpen}
        pending={attachResource.isPending}
        resources={discoveredResources}
        search={resourceSearch}
      />
      <AttachmentLightbox onClose={() => setAttachmentPreview(null)} preview={attachmentPreview} />
    </div>
  );
}
