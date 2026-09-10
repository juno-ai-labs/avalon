import { useVisibleReadAcknowledgement } from '../lib/use-visible-read-acknowledgement';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  Copy,
  Ellipsis,
  FileText,
  FileUp,
  Info,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Search,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  type SidekickAttachment,
  type TranscriptActivity,
  type TranscriptTurn,
  type WorkstreamMessageDeliveryState,
  type WorkstreamTranscriptSnapshot,
} from '@rally/contracts';
import type { ConversationParentKind } from '@rally/contracts/conversation-parent';
import type { SubstreamInitialContext } from '@rally/contracts/substream-creation';
import type { DesktopSession } from '../../common/desktop';
import { useAppSession } from '../lib/app-session';
import { useCitations } from '../lib/use-citations';
import { ApiError, type MentionIdentity } from '../lib/api';
import { workstreamDraftKey } from '../lib/draft-keys';
import { desktopBridge } from '../lib/platform';
import {
  currentSurfaceEntrypoint,
  reportTelemetryProductIntent,
  telemetryCountBucket,
  telemetryVisibility,
  type WorkstreamFeedSource,
  workstreamFeedSourceQueryKey,
  workstreamNavigation,
} from '../lib/telemetry';
import {
  adjacentTranscriptRange,
  collapseSettledWorkIntoAccordion,
  composeTranscript,
  createTextMessage,
  foldSettledWorkIntoMessages,
  groupPluginToolMessages,
  groupThinkingMessages,
  optimisticMentionRendering,
  orderedTranscriptMessages,
  applyPendingInputQueueOrder,
  assignPendingInputQueueSequences,
  composerQueueOverlays,
  isComposerQueueOverlay,
  pendingOverlayInputId,
  transcriptOverlayIdentityKey,
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
import { TRANSCRIPT_END_SLACK, useTranscriptFollow } from '../lib/use-transcript-follow';
import { useTranscriptHistory } from '../lib/use-transcript-history';
import { useWorkstreamFeedOpenTelemetry } from '../lib/use-workstream-feed-open-telemetry';
import { useWorkstreamSendReadyTelemetry } from '../lib/use-workstream-send-ready-telemetry';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { ActivityPresence, JumpToLatestButton, RunStoppedNotice } from '../components/conversation-follow';
import { RIGHT_SIDEBAR_ENABLED, type RailVariant, useUiStore } from '../lib/ui-store';
import {
  orderedTranscriptQueryKey,
  substreamInitialContextQueryKey,
  type SocketState,
  type WorkstreamMessageDeliveryMode,
} from '../lib/use-workstream-socket';
import { useRetainedWorkstreamSocket, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { evictCachedWorkstream, patchCachedWorkstream, workstreamDetailQueryKey } from '../lib/workstreams-cache';
import {
  SubstreamLaunchSurface,
  type LaunchingSubstream,
  type SubstreamLaunchProps,
} from '../components/substream-launch';
import { patchCachedWorkstreamViewerState } from '../lib/workstream-state-store';
import { useOpenFirstWorkstream } from '../lib/workstream-landing';
import type { ElicitationData, HarnessRunMetadata, HarnessStatus, Message, Participant, ResourceVersion, WorkspaceMember, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { AgentCompactionIndicator, AgentWorkTiming, type AgentWorkTimingProps } from '../components/agent-work-timing';
import { InspectorRail } from '../components/inspector-rail';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { Avatar, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, OpeningState } from '../components/primitives';
import { queueAuthorMember, type ComposerQueueItem } from '../components/composer-queue';
import { MessageFeed, useMessageFeedVirtualizer } from '../components/message-feed';
import { ConnectorConnectionsProvider } from '../components/connector-mentions';
import { WorkstreamComposer } from '../components/workstream-composer';
import { SubstreamContext } from '../components/substream-context';
import { useRailExitFade } from '../components/rail-surface';

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
  return requestedMode === 'steer' ? 'steer_pending' : 'queue_pending';
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
 * How many main-conversation turns a substream shows above its composer.
 *
 * Enough to recognize what is being branched out of at a glance, and few
 * enough that the composer stays where the eye left it. What the substream
 * actually inherits is not this: the platform freezes a summary of the
 * conversation through the branch point, and the child's own feed shows it
 * under **Context from the main conversation** once it exists.
 */
const BRANCH_PROVENANCE_TURNS = 5;

/**
 * The turns shown, faded, above a substream's composer: the message it branches
 * from and the ones that led to it, oldest first.
 *
 * A substream started from the sidebar branches from wherever the conversation
 * has reached rather than from a message somebody pointed at, and it shows
 * nothing — the same empty body the work-stream launcher has, because there is
 * no particular moment to be looking at.
 */
export function branchProvenance(
  transcript: readonly Message[],
  throughTurnId: string | null,
): Message[] {
  if (throughTurnId === null) return [];
  const cutoff = transcript.findIndex((message) =>
    message.transcriptTurnId === throughTurnId || message.id === throughTurnId);
  // A branch point outside the loaded window is not an error and not a reason
  // to show the wrong turns: the substream is still the one that was asked
  // for, and its provenance is simply not on the client to draw.
  if (cutoff < 0) return [];
  return transcript.slice(Math.max(0, cutoff + 1 - BRANCH_PROVENANCE_TURNS), cutoff + 1);
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
  privateSubstream = false,
  error,
  members,
  open,
  pending,
  onAdd,
  onRemove,
  onOpenChange,
}: {
  current: WorkspaceMember[];
  privateSubstream?: boolean;
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
      description={privateSubstream
        ? 'Added participants can read this substream, including its inherited context. They must already have access to the parent work stream; adding them here does not grant that access.'
        : 'Opening or viewing never adds someone as a participant. Add them explicitly here.'}
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
                aria-label={`Add ${member.name} to ${privateSubstream ? 'substream' : 'work stream'}`}
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
                      Remove from {privateSubstream ? 'substream' : 'work stream'}
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
  uploadLabel = 'Upload file',
  incomplete = false,
  onRetry,
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
  uploadLabel?: string;
  incomplete?: boolean;
  onRetry?: () => void;
}): React.JSX.Element {
  const currentIds = new Set(current.map((resource) => resource.id));
  const available = resources.filter((resource) => !currentIds.has(resource.id));
  return (
    <Modal
      description="Attach a resource discovered through a connector, or upload a file from this Mac."
      footer={(
        <>
          <Button className="resource-upload-button" disabled={pending} onClick={onUpload}>
            <FileUp aria-hidden="true" size={14} /> {uploadLabel}
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
        {incomplete && <div role="status">Some resources are unavailable. <Button onClick={onRetry}>Retry</Button></div>}
        {error ? <InlineError>{error}</InlineError> : null}
        {loading ? (
          <LoadingState label="Finding resources…" />
        ) : available.length === 0 ? (
          <EmptyState
            title={incomplete ? 'No verified resources available' : search ? 'No matching resources' : 'No connector resources yet'}
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

export function WorkstreamErrorState({
  description,
  onRetry,
  parentNoun = 'work stream',
  workstreamId,
}: {
  description: string;
  onRetry: () => void;
  /** What could not be opened, for the title: a work stream or an automation. */
  parentNoun?: 'work stream' | 'automation';
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
        title={`${parentNoun === 'automation' ? 'Sidekick' : 'Work stream'} could not be opened`}
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
      // A settled run's accordion carries its turn's ordinal so the unread
      // divider lands above it rather than between it and its answer, but it is
      // machinery: scrolling it into view, or scrolling through an open one,
      // says nothing about having read the sentence it sits above.
      || message.messageType === 'work_accordion'
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

/**
 * What the surface hands whoever renders the strip above the feed. A work
 * stream puts its header there; an automation's screen renders its own header
 * outside the surface and passes nothing.
 */
export interface ConversationHeaderContext {
  detail: WorkstreamDetail;
  socketState: SocketState;
  presentUserIds: readonly string[];
  openParticipantDialog: () => void;
  openRail: (variant: RailVariant) => void;
  rename: (title: string) => Promise<void>;
}

export interface ConversationSubstreamLaunch {
  /** The main-conversation turn the substream branches from, or null from the sidebar. */
  throughTurnId: string | null;
  launching: LaunchingSubstream | null;
  error?: string | undefined;
  onCancel: () => void;
  onCreate: SubstreamLaunchProps['onCreate'];
}

export interface ConversationSurfaceProps {
  parentKind: ConversationParentKind;
  parentId: string;
  substreamId: string;
  /** Parent-owned sidebar data; never substitute the selected child's roster or inventory. */
  workstreamContext?: WorkstreamDetail;
  onStartSubstream?: (throughTurnId: string) => void;
  /**
   * A substream being written in front of this conversation.
   *
   * It replaces the three rows of the column — header, transcript, dock — and
   * nothing else: the sidebar, the inspector and the parent's own socket
   * belong to the work stream, which has not been left. The turns it fades in
   * above its composer come from this transcript, which is the one place they
   * are already loaded.
   */
  substreamLaunch?: ConversationSubstreamLaunch | null;
  renderHeader?: (context: ConversationHeaderContext) => React.ReactNode;
  renderSidebar?: (context: ConversationHeaderContext & {
    attachedSidekicks: SidekickAttachment[] | undefined;
    attachedSidekicksError: string | undefined;
    removeSidekick: ((id: string) => void) | undefined;
    focusTranscript: () => void;
    openArtifact: (id: string, returnFocus: HTMLElement) => void;
  }) => React.ReactNode;
}

/**
 * One conversation's feed, composer and rail, whoever its parent is.
 *
 * Everything below is keyed by the parent id and the substream: the detail and
 * transcript caches, the socket, the overlays, the drafts. A work stream and
 * an automation are opened through the same `/conversations` boot and the
 * same feed socket, so the surface is the same component; what differs is the
 * strip above it, which the caller renders, and the WorkstreamDO control
 * socket, which only a work stream has and the socket hook mounts only for it.
 */
export function ConversationSurface({
  parentKind,
  parentId: id,
  substreamId,
  workstreamContext,
  renderHeader,
  renderSidebar,
  onStartSubstream,
  substreamLaunch,
}: ConversationSurfaceProps): React.JSX.Element {
  const detailQueryKey = useMemo(() => workstreamDetailQueryKey(id, substreamId), [id, substreamId]);
  const parentDetailQueryKey = useMemo(() => workstreamDetailQueryKey(id, '0'), [id]);
  const transcriptQueryKey = useMemo(() => orderedTranscriptQueryKey(id, substreamId), [id, substreamId]);
  const readSocketOpenContext = useWorkstreamSocketOpenContext(id);
  const parentNoun = parentKind === 'automation' ? 'automation' : 'work stream';
  const navigate = useNavigate();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchSequence = Number(searchParams.get('sequence'));
  const searchTurnId = Number.isSafeInteger(searchSequence) && searchSequence > 0 ? searchParams.get('turn') : null;

  const requestedSearch = useRef<string | null>(null);

  const { api, session } = useAppSession();
  const { presenceUserIdsByWorkstream } = useWorkspaceSocket();
  const featureFlags = useClientFeatureFlags(api);
  const queryClient = useQueryClient();
  const closeRail = useUiStore((state) => state.closeRail);
  const inspect = useUiStore((state) => state.inspect);
  const inspector = useUiStore((state) => state.inspector);
  const openRail = useUiStore((state) => state.openRail);
  const storeRailOpen = useUiStore((state) => state.railOpen);
  const railScope = useUiStore((state) => state.railScope);
  const setRailLeaving = useUiStore((state) => state.setRailLeaving);
  const setRailScope = useUiStore((state) => state.setRailScope);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const conversationGenerationRef = useRef(0);
  const olderRequestsRef = useRef(new Map<string, Promise<void>>());
  const [positionedConversation, setPositionedConversation] = useState<string | null>(null);
  const [participantDialogOpen, setParticipantDialogOpen] = useState(false);
  const [participantDialogSubstreamId, setParticipantDialogSubstreamId] = useState(substreamId);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState('');
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState('');
  const [sendError, setSendError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | undefined>();
  const [otherHistoryError, setOtherHistoryError] = useState<string | undefined>();

  const loadingNewerRef = useRef(false);
  const pendingOlderAfterReconnectRef = useRef(false);
  const pendingNewerAfterReconnectRef = useRef(false);
  const pendingJumpAfterReconnectRef = useRef(false);
  const initialPositionedWorkstreamRef = useRef<string | null>(null);
  const readAckInFlightRef = useRef<string | null>(null);
  const conversationAddress = `${id}:${substreamId}`;
  const activeConversationAddressRef = useRef(conversationAddress);
  const pendingSendCount = useRef(0);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [resourcePreview, setResourcePreview] = useState<{ resourceId: string; returnFocus: HTMLElement; workstreamScoped?: boolean } | null>(null);
  const openResourceDetails = useCallback((resourceId: string, returnFocus: HTMLElement): void => {
    setAttachmentPreview(null);
    setResourcePreview({ resourceId, returnFocus });
  }, []);
  const openWorkstreamResourceDetails = useCallback((resourceId: string, returnFocus: HTMLElement): void => {
    setAttachmentPreview(null);
    setResourcePreview({ resourceId, returnFocus, workstreamScoped: true });
  }, []);
  const workspaceId = session?.workspace?.id ?? 'unbound';
  const workspaceRegion = session?.workspace?.region ?? 'global';
  const attachmentDraft = useFileAttachments(api, workstreamDraftKey(workspaceRegion, workspaceId, id, substreamId));
  const transcriptDrop = useFileDrop(attachmentDraft.addFiles);
  const railDrop = useFileDrop(attachmentDraft.addFiles);
  // The composer does not take focus when a work stream opens, so a paste that
  // lands on the document reaches the same draft the transcript and rail accept
  // files into.
  const conversationVisible = useContext(ConversationVisibilityContext);
  const conversationVisibleRef = useRef(conversationVisible);
  conversationVisibleRef.current = conversationVisible;
  useWindowFilePaste(attachmentDraft.addFiles, !conversationVisible);
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal),
    [api],
  );

  // Leaving a work stream closes the right sidebar, and switching to another one
  // is leaving this one: the panel was opened against this feed and has nothing
  // to say about the next. The selection goes with it, because a resource id
  // from the stream just left names nothing in the one arriving — the one case
  // where clearing under the closing panel's fade beats what it would otherwise
  // be showing, which is a detail it can no longer find. A layout effect so the
  // close lands in the commit that changes the route, rather than a frame after
  // the work stream underneath it has already been painted.
  //
  // The scope moves in the same effect rather than a passive one of its own. It
  // is what each work stream's panel widths are stored under, and it is also
  // this screen's answer to whose rail the store is describing; the two have to
  // move together, or the render that changes the route reads an open rail that
  // belongs to the stream it just left.
  useLayoutEffect(() => {
    setAttachmentPreview(null);
    setResourcePreview(null);
    setResourceDialogOpen(false);
    setRailScope(id);
    return () => {
      closeRail();
      inspect(null);
      setRailScope(null);
    };
  }, [closeRail, id, inspect, setRailScope]);

  useLayoutEffect(() => {
    activeConversationAddressRef.current = conversationAddress;
    conversationGenerationRef.current += 1;
    setPositionedConversation(null);
    setOtherHistoryError(undefined);
    loadingNewerRef.current = false;
    pendingOlderAfterReconnectRef.current = false;
    pendingNewerAfterReconnectRef.current = false;
    pendingJumpAfterReconnectRef.current = false;
    initialPositionedWorkstreamRef.current = null;
    readAckInFlightRef.current = null;
    setLoadingOlder(false);
    setOlderMessagesError(undefined);
  }, [conversationAddress]);

  useEffect(() => {
    if (!resourceDialogOpen) {
      setDebouncedResourceSearch('');
      return;
    }
    const timeout = window.setTimeout(() => setDebouncedResourceSearch(resourceSearch.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [resourceDialogOpen, resourceSearch]);

  // The admitted conversation socket is the only producer of these caches.
  // Its canonical snapshot installs detail and transcript together, including
  // after a cursor-zero recovery, so Retry restarts that same ordered path.
  const initialFeedCacheState = useMemo(() => (
    queryClient.getQueryData(transcriptQueryKey) !== undefined
      ? 'feed_cached'
      : queryClient.getQueryData(detailQueryKey) !== undefined ? 'detail_cached' : 'cold'
  ), [detailQueryKey, queryClient, transcriptQueryKey]);
  const workstream = useQuery<WorkstreamDetail | undefined>({
    queryKey: detailQueryKey,
    queryFn: async () => undefined,
    enabled: false,
    staleTime: 5_000,
  });
  const orderedTranscript = useQuery<WorkstreamTranscriptSnapshot | undefined>({
    queryKey: transcriptQueryKey,
    queryFn: async () => undefined,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const initialContext = useQuery<SubstreamInitialContext | null>({
    queryKey: substreamInitialContextQueryKey(id, substreamId),
    queryFn: async () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const transcriptOverlays = useQuery<TranscriptOverlay[]>({
    queryKey: transcriptOverlaysQueryKey(id, substreamId),
    queryFn: async () => [],
    enabled: false,
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const telemetryOpenedWorkstreamRef = useRef<string | null>(null);
  useEffect(() => {
    const detail = workstream.data;
    if (parentKind !== 'workstream') return;
    if (!detail || detail.id !== id || telemetryOpenedWorkstreamRef.current === detail.id) return;
    telemetryOpenedWorkstreamRef.current = detail.id;
    reportTelemetryProductIntent({
      kind: 'workstream_opened',
      workstreamId: detail.id,
      visibility: telemetryVisibility(detail.scope),
      navigation: workstreamNavigation(detail.id),
      origin: detail.systemKind ? 'system' : 'ad_hoc',
      pinned: detail.pinPosition !== null,
    });
  }, [id, parentKind, workstream.data]);
  const payloadBelongsToRoute = workstreamPayloadBelongsToRoute(
    id,
    workstream.data,
    orderedTranscript.data,
  );
  const routedDetail = payloadBelongsToRoute ? workstream.data : undefined;
  const feedSource = useQuery<WorkstreamFeedSource | null>({
    queryKey: workstreamFeedSourceQueryKey(id, substreamId),
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
  /**
   * Everything the live-artifact detail needs, or `undefined`.
   *
   * `undefined` is how the feature is off — the rail then renders a site as the
   * ordinary resource card, which still lists, versions, and removes it. The
   * flag gates presentation only: an artifact's authorization is structural and
   * holds whether or not this is passed.
   */
  const siteArtifacts = useMemo(() => {
    if (!api || featureFlags.data?.liveArtifactsEnabled !== true) return undefined;
    const bridge = window.rally;
    if (!bridge) return undefined;
    return {
      openArtifact: (resourceId: string) => api.openArtifact(resourceId),
      describeData: (resourceId: string) => api.describeArtifactData(resourceId),
      loadTable: (resourceId: string, table: string) => api.readArtifactTable(resourceId, table),
      loadErrors: (resourceId: string) => api.readArtifactErrors(resourceId),
      surface: {
        present: bridge.presentArtifactPreview,
        setBounds: bridge.setArtifactPreviewBounds,
        close: bridge.closeArtifactPreview,
        popOut: bridge.popOutArtifact,
        copyText: bridge.copyText,
        openExternal: bridge.openExternal,
      },
    };
  }, [api, featureFlags.data?.liveArtifactsEnabled]);
  // Citations resolve against the loaded work stream's resources, and the
  // transcript needs this before the screen has decided it has a work stream to
  // draw at all — hence `routedDetail?`, and hence the hoisted empty array,
  // which keeps the identity stable while there is nothing loaded. It is
  // declared after the preview read because it now takes it: the embed card's
  // excerpt is the same derivative the rail's panel shows.
  const citations = useCitations({
    loadResourceContent,
    onOpenPreview: setAttachmentPreview,
    onOpenResourceDetails: openResourceDetails,
    resources: routedDetail?.resources ?? NO_RESOURCES,
  });
  const sidebarCitations = useCitations({
    loadResourceContent,
    onOpenPreview: setAttachmentPreview,
    onOpenResourceDetails: openWorkstreamResourceDetails,
    resources: workstreamContext?.id === id ? workstreamContext.resources : NO_RESOURCES,
  });
  // The store holds the rail's open state, but on the render that changes the
  // route it is still describing the previous work stream — the effect above
  // has not run yet. Reading it through the scope is what keeps that render
  // from laying out, or starting a fade for, a panel belonging to the stream
  // just left; every path that opens the rail writes the store, and each is
  // honoured from the moment the scope names this stream.
  const railOpen = RIGHT_SIDEBAR_ENABLED && storeRailOpen && railScope === id;
  // A route switch is not a sidebar hand-off: scope the fade to the work stream
  // so the previous stream's inspector never dissolves over the arriving feed.
  const railLeaving = useRailExitFade(railOpen, id);
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
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
    parentKind,
    substreamId,
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
    substreamId,
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
  const harnessRunning = routedDetail?.harnessStatus === 'running';
  const queueOverlays = useMemo(
    () => composerQueueOverlays(transcriptOverlays.data, { harnessRunning }),
    [harnessRunning, transcriptOverlays.data],
  );
  const queueItems = useMemo<ComposerQueueItem[]>(
    () => queueOverlays.map((overlay) => ({
      key: transcriptOverlayIdentityKey(overlay.identity),
      inputId: pendingOverlayInputId(overlay) ?? null,
      text: overlay.message.text ?? '',
      mentions: overlay.message.mentions ?? [],
      member: queueAuthorMember(overlay.message, members.data ?? []),
      sending: overlay.message.deliveryState === 'sending',
    })),
    [members.data, queueOverlays],
  );
  const liveMessageIds = useMemo(() => new Set((transcriptOverlays.data ?? [])
    .filter((overlay) => overlay.provenance.source === 'client_command'
      || overlay.provenance.source === 'stream_event'
      || overlay.provenance.source === 'socket_event')
    .map((overlay) => overlay.message.id)), [transcriptOverlays.data]);
  const transcript = useMemo(
    () => {
      const feedOverlays = (transcriptOverlays.data ?? []).filter((overlay) =>
        !isComposerQueueOverlay(overlay, { harnessRunning }));
      return collapseSettledWorkIntoAccordion(
        foldSettledWorkIntoMessages(
          groupThinkingMessages(
            groupPluginToolMessages(composeTranscript(canonicalTranscript, feedOverlays)),
          ),
        ),
      );
    },
    [canonicalTranscript, harnessRunning, transcriptOverlays.data],
  );
  // Held here rather than in the row: the virtualizer unmounts a row that
  // leaves the window but keeps the height it measured, so an open row that
  // came back closed would shrink under a cache that still expects it open.
  const transcriptVirtualizer = useMessageFeedVirtualizer({
    messages: transcript,
    scrollRef: transcriptRef,
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
    conversationAddress,
  );

  useEffect(() => {
    if (socketState !== 'connected') requestedSearch.current = null;
    if (!searchTurnId || !Number.isSafeInteger(searchSequence) || searchSequence < 1
      || socketState !== 'connected' || !orderedTranscript.data) return;
    const targetKey = `${conversationAddress}:${searchTurnId}`;

    const index = transcript.findIndex((message) => message.transcriptTurnId === searchTurnId);
    if (index >= 0) {
      requestedSearch.current = null;
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('turn');
        next.delete('sequence');
        return next;
      }, { replace: true });
      releaseTranscriptFollow();
      initialPositionedWorkstreamRef.current = id;
      transcriptVirtualizer.scrollToIndex(index, { align: 'start' });
      setPositionedConversation(conversationAddress);
      return;
    }
    const snapshot = orderedTranscript.data;
    if (snapshot.ranges.some((range) => range.covered.startInclusive <= searchSequence
      && range.covered.endExclusive > searchSequence)) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('turn'); next.delete('sequence');
        return next;
      }, { replace: true });
      setOtherHistoryError('The matching message is no longer available.');
      return;
    }
    const requestKey = `${targetKey}:${snapshot.snapshotId}`;
    if (requestedSearch.current === requestKey) return;
    requestedSearch.current = requestKey;
    void loadTranscriptRange({
      snapshotId: snapshot.snapshotId,
      range: { startInclusive: searchSequence, endExclusive: searchSequence + 1 },
      resumeAfterEventSequence: snapshot.eventSequence,
    }).catch((error: unknown) => {
      if (activeConversationAddressRef.current === conversationAddress && requestedSearch.current === requestKey) setOtherHistoryError(error instanceof Error ? error.message : 'The matching message could not be opened.');
    });
  }, [conversationAddress, id, loadTranscriptRange, orderedTranscript.data, releaseTranscriptFollow,
    searchSequence, searchTurnId, setSearchParams, socketState, transcript, transcriptVirtualizer]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const generation = conversationGenerationRef.current;
    const stillCurrent = (): boolean => activeConversationAddressRef.current === conversationAddress
      && conversationGenerationRef.current === generation;
    const pending = olderRequestsRef.current.get(conversationAddress);
    if (pending) {
      setLoadingOlder(true);
      await pending;
      if (stillCurrent()) setLoadingOlder(false);
      return;
    }
    const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey);
    if (!orderedSnapshot || !adjacentTranscriptRange(orderedSnapshot, 'older')) return;
    if (socketState !== 'connected') {
      pendingOlderAfterReconnectRef.current = true;
      return;
    }
    pendingOlderAfterReconnectRef.current = false;
    setLoadingOlder(true);
    setOlderMessagesError(undefined);
    const scrollElement = transcriptRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    const previousScrollTop = scrollElement?.scrollTop ?? 0;
    const request = (async (): Promise<void> => {
      try {
        while (stillCurrent()) {
          const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey);
          const range = snapshot ? adjacentTranscriptRange(snapshot, 'older') : null;
          if (!snapshot || !range) return;
          try {
            await loadTranscriptRange({
              snapshotId: snapshot.snapshotId,
              range,
              resumeAfterEventSequence: snapshot.eventSequence,
            });
            const next = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey);
            if (!next || (next.snapshotId === snapshot.snapshotId && !transcriptCoverageAdvanced(snapshot, next))) {
              throw new Error('Earlier messages could not be loaded. Try again.');
            }
            break;
          } catch (error) {
            if (error instanceof ApiError && error.code === 'transcript_snapshot_changed') continue;
            throw error;
          }
        }
        if (!stillCurrent()) return;
        window.requestAnimationFrame(() => {
          if (!stillCurrent()) return;
          const element = transcriptRef.current;
          if (!element) return;
          scrollTranscriptTo(preservedPrependScrollTop(
            previousScrollTop, previousScrollHeight, element.scrollHeight,
          ));
        });
      } catch (error) {
        if (!stillCurrent()) return;
        if (error instanceof ApiError && error.code === 'workstream_socket_unavailable') {
          pendingOlderAfterReconnectRef.current = true;
          return;
        }
        setOlderMessagesError(error instanceof Error ? error.message : 'Earlier messages could not be loaded.');
      }
    })();
    olderRequestsRef.current.set(conversationAddress, request);
    try {
      await request;
    } finally {
      olderRequestsRef.current.delete(conversationAddress);
      if (activeConversationAddressRef.current === conversationAddress) setLoadingOlder(false);
    }
  }, [conversationAddress, loadTranscriptRange, queryClient, scrollTranscriptTo, socketState, transcriptQueryKey]);

  const nearHistoryEdge = useTranscriptHistory({
    scrollRef: transcriptRef,
    contentRef: transcriptContentRef,
    conversationAddress,
    enabled: payloadBelongsToRoute && positionedConversation === conversationAddress
      && !searchTurnId && olderTranscriptRange !== null,
    canLoad: socketState === 'connected' && !loadingOlder && !olderMessagesError,
    loadOlder: () => { void loadOlderMessages(); },
  });

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      transcriptQueryKey,
    );
    const orderedRange = orderedSnapshot
      ? adjacentTranscriptRange(orderedSnapshot, 'newer')
      : null;
    if (!orderedSnapshot || !orderedRange || loadingNewerRef.current) return;
    if (socketState !== 'connected') {
      pendingNewerAfterReconnectRef.current = true;
      setOtherHistoryError(undefined);
      return;
    }
    pendingNewerAfterReconnectRef.current = false;
    loadingNewerRef.current = true;
    setOtherHistoryError(undefined);
    try {
      while (activeConversationAddressRef.current === conversationAddress) {
        const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
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
      setOtherHistoryError(error instanceof Error ? error.message : 'Newer messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [id, loadTranscriptRange, queryClient, socketState]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    if (loadingNewerRef.current) return;
    if (socketState !== 'connected') {
      pendingJumpAfterReconnectRef.current = true;
      setOtherHistoryError(undefined);
      return;
    }
    pendingJumpAfterReconnectRef.current = false;
    loadingNewerRef.current = true;
    setOtherHistoryError(undefined);
    try {
      const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
        transcriptQueryKey,
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
            transcriptQueryKey,
          );
          if (!refreshed) throw error;
          snapshot = refreshed;
          range = adjacentTranscriptRange(snapshot, 'newer');
          continue;
        }
        if (activeConversationAddressRef.current !== conversationAddress) return;
        const next = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey);
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
      setOtherHistoryError(error instanceof Error ? error.message : 'The latest messages could not be loaded.');
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

  const cacheAddedParticipant = (target: string, member: WorkspaceMember): void => {
    queryClient.setQueryData<WorkstreamDetail>(workstreamDetailQueryKey(id, target), (current) => current ? {
      ...current,
      participants: current.participants.some((person) => person.id === member.id)
        ? current.participants : [...current.participants, member],
    } : current);
  };

  const addParticipant = useMutation({
    mutationFn: async ({ member, target }: { member: WorkspaceMember; target: string }): Promise<WorkstreamDetail | undefined> => {
      if (target === '0') return api!.addParticipant(id, member.id);
      await api!.addSubstreamParticipant(id, target, member.id);
      return undefined;
    },
    onSuccess: (updated, { target, member }) => {
      if (updated) queryClient.setQueryData(workstreamDetailQueryKey(id, target), updated);
      else cacheAddedParticipant(target, member);
      setParticipantDialogOpen(false);
    },
  });

  const removeParticipant = useMutation({
    mutationFn: ({ member, target }: { member: WorkspaceMember; target: string }) => target === '0'
      ? api!.removeParticipant(id, member.id)
      : api!.removeSubstreamParticipant(id, target, member.id),
    onSuccess: (_result, { member, target }) => {
      const targetKey = workstreamDetailQueryKey(id, target);
      const previous = queryClient.getQueryData<WorkstreamDetail>(targetKey);
      queryClient.setQueryData<WorkstreamDetail>(targetKey, (current) => current ? {
        ...current,
        participants: current.participants.filter((participant) => participant.id !== member.id),
      } : current);
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      if (member.id === session?.user.id && (target !== '0' || previous?.scope === 'personal')) {
        setParticipantDialogOpen(false);
        if (target !== '0') {
          queryClient.removeQueries({ queryKey: targetKey, exact: true });
          void navigate(`/workstreams/${id}`, { replace: true });
          return;
        }
        evictCachedWorkstream(queryClient, id);
        openFirstWorkstream([id]);
      }
    },
  });

  // The header renames in place, so both the open detail and the sidebar list
  // have to show the new title without a refetch round trip.
  const renameWorkstream = useMutation({
    mutationFn: async (title: string) => {
      if (substreamId === '0') return api!.renameWorkstream(id, title);
      await api!.renameSubstream(id, substreamId, title);
      return undefined;
    },
    onSuccess: (updated) => {
      if (!updated) return;
      patchCachedWorkstream(queryClient, updated.id, { title: updated.title, titleStatus: updated.titleStatus, updatedAt: updated.updatedAt });
    },
  });

  const attachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.attachResource(id, resource.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(parentDetailQueryKey, updated);
      setResourceDialogOpen(false);
      setResourceSearch('');
    },
  });

  // The shell needs to know whether the inspector is still fading out so it
  // reserves the same width for that final frame.
  useLayoutEffect(() => {
    setRailLeaving(railLeaving);
    return () => setRailLeaving(false);
  }, [railLeaving, setRailLeaving]);

  const stop = useMutation({
    mutationFn: () => socketConnection.stopHarness(),
    onSuccess: () => {
      queryClient.setQueryData<WorkstreamDetail>(detailQueryKey, (current) =>
        current ? { ...current, stopRequested: true } : current);
      requestSocketSnapshot();
    },
  });

  const retry = useMutation({
    mutationFn: () => socketConnection.retryHarness(),
    onSuccess: async () => {
      requestSocketSnapshot();
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    },
  });

  const watchResource = useMutation({
    mutationFn: ({ resource, enabled }: { resource: WorkstreamResource; enabled: boolean }) =>
      api!.setResourceWatch(id, resource.id, enabled),
    onMutate: async ({ resource, enabled }) => {
      await queryClient.cancelQueries({ queryKey: parentDetailQueryKey, exact: true });
      const previous = queryClient.getQueryData<WorkstreamDetail>(parentDetailQueryKey);
      queryClient.setQueryData<WorkstreamDetail>(parentDetailQueryKey, (current) => current ? {
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
      if (context?.previous) queryClient.setQueryData(parentDetailQueryKey, context.previous);
    },
    onSuccess: (result, { resource, enabled }) => {
      queryClient.setQueryData<WorkstreamDetail>(parentDetailQueryKey, (current) => current ? {
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
      queryClient.setQueryData<WorkstreamDetail>(parentDetailQueryKey, (current) => current ? {
        ...current,
        resources: current.resources.filter((item) => item.id !== resource.id),
      } : current);
    },
  });

  // The rail's detail shows one resource at a time, so its history is fetched
  // for that one rather than for every attachment the work stream carries.
  const inspectedResourceId = resourcePreview ? resourcePreview.resourceId : inspector?.type === 'resource' ? inspector.id : null;
  const inspectedResourceVersion = (resourcePreview?.workstreamScoped ? workstreamContext : workstream.data)?.resources
    .find((resource) => resource.id === inspectedResourceId)?.currentVersion ?? null;
  const resourceVersions = useQuery({
    queryKey: resourceVersionsQueryKey(inspectedResourceId, inspectedResourceVersion),
    queryFn: ({ signal }) => api!.getResourceVersions(inspectedResourceId!, signal),
    // `closeRail` deliberately keeps the inspector's selection, so without the
    // rail's own state here the query keeps refetching for a panel nobody can
    // see.
    enabled: Boolean(api && inspectedResourceId && (railOpen || resourcePreview)),
  });

  // Creating the automation a proposal card names. Invalidates the rail so a
  // room's new automation appears where its participants manage it, and the
  // automation's own detail so its screen shows the accepted revision.
  const acceptProposedAutomation = useMutation({
    mutationFn: (automationId: string) => api!.acceptAutomation(automationId),
    onSuccess: (_detail, automationId) => {
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
      void queryClient.invalidateQueries({ queryKey: ['automation', automationId] });
    },
  });

  // Loaded main-stream attachments belong in the rail; owned Sidekicks are
  // managed through the dedicated library. Fetch only while the rail is open.
  const attachedSidekicks = useQuery({
    queryKey: ['attached-sidekicks', id],
    queryFn: ({ signal }) => api!.getAttachedSidekicks(id!, signal),
    enabled: Boolean(api && id && parentKind === 'workstream'),
  });
  const removeSidekick = useMutation({
    mutationFn: (sidekickId: string) => api!.removeAttachedSidekick(id!, sidekickId),
    onSuccess: (items) => queryClient.setQueryData(['attached-sidekicks', id], items),
  });
  const sidekickRefreshSequence = orderedTranscript.data?.eventSequence;
  useEffect(() => {
    if (parentKind === 'automation') {
      void queryClient.invalidateQueries({ queryKey: ['automation', id] });
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
    } else {
      void queryClient.invalidateQueries({ queryKey: ['attached-sidekicks', id] });
    }
  }, [id, parentKind, queryClient, sidekickRefreshSequence]);

  const refreshResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.refreshResource(resource.id),
    onSuccess: (refreshed) => {
      queryClient.setQueryData<WorkstreamDetail>(parentDetailQueryKey, (current) => current ? {
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
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey, (current) =>
      current ? setTranscriptElicitationState(current, elicitationId, {
        status: 'answered',
        answer,
      }) : current);
    const previous = queryClient.getQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId))
      ?.find((overlay) => overlay.identity.type === 'elicitation'
        && overlay.identity.elicitationId === elicitationId);
    queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) =>
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
      await socketConnection.answerElicitation(elicitationId, answer, customResponse);
      requestSocketSnapshot();
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    } catch (error) {
      queryClient.setQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey, (current) =>
        current ? setTranscriptElicitationState(current, elicitationId, {
          status: 'open',
          answer: null,
        }) : current);
      if (previous) {
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) =>
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
    queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) => {
      const latestTranscript = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
        transcriptQueryKey,
      );
      const afterTranscriptSequence = latestTranscript?.snapshotThrough ?? 0;
      const eventSequence = Math.max(
        latestTranscript?.eventSequence ?? 0,
        ...(current ?? [])
          .filter((overlay) => overlay.position.afterTranscriptSequence === afterTranscriptSequence)
          .map((overlay) => overlay.position.eventSequence),
      ) + 1;
      const createdAt = new Date().toISOString();
      // Rendered text, not sent text: `createMessage` below is given the draft
      // the person typed, and the room does this same rewrite on its own copy.
      const rendered = optimisticMentionRendering(text, mentions, members.data ?? []);
      const optimistic = createTextMessage({
        id: clientId,
        clientMessageId: clientId,
        workstreamId: id,
        sequenceNumber: 0,
        authorType: 'human',
        author: workspaceMemberFromSession(session),
        text: rendered.text,
        mentions: rendered.mentions,
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
      // Private-child membership belongs to the parent. The generic message
      // confirmation only updates the conversation-local participant roster,
      // which cannot grant discovery or socket admission to a private child.
      if (parentKind === 'workstream' && substreamId !== '0') {
        for (const userId of confirmedParticipantUserIds) {
          await api.addSubstreamParticipant(id, substreamId, userId);
          const member = members.data?.find((person) => person.id === userId);
          if (member) cacheAddedParticipant(substreamId, member);
        }
      }
      const created = await socketConnection.createMessage({
        text,
        clientId,
        mentions,
        confirmedParticipantUserIds: parentKind === 'workstream' && substreamId !== '0' ? [] : confirmedParticipantUserIds,
        attachmentIds: readyAttachments.flatMap((attachment) => attachment.resource ? [attachment.resource.id] : []),
        ...(deliveryMode ? { runMode: deliveryMode } : {}),
      });
      queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) => {
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
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    } catch (error) {
      await attachmentDraft.restoreLease(attachmentLease.leaseId);
      queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) =>
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

  const reorderQueue = async (inputIds: string[]): Promise<void> => {
    const previous = queryClient.getQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId));
    queryClient.setQueryData<TranscriptOverlay[]>(
      transcriptOverlaysQueryKey(id, substreamId),
      (current) => applyPendingInputQueueOrder(current, inputIds),
    );
    try {
      const result = await socketConnection.reorderPendingInputs(inputIds);
      queryClient.setQueryData<TranscriptOverlay[]>(
        transcriptOverlaysQueryKey(id, substreamId),
        (current) => assignPendingInputQueueSequences(current, result.pendingInputs),
      );
    } catch (error) {
      if (previous) {
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), previous);
      }
      setSendError(error instanceof Error ? error.message : 'Queued messages could not be reordered.');
      throw error;
    }
  };

  useEffect(() => {
    if (!routedDetail || searchTurnId || initialPositionedWorkstreamRef.current === id) return;
    initialPositionedWorkstreamRef.current = id;
    const anchorSequence = routedDetail.firstUnreadSequenceNumber;
    const generation = conversationGenerationRef.current;
    window.requestAnimationFrame(() => {
      if (activeConversationAddressRef.current !== conversationAddress
        || conversationGenerationRef.current !== generation) return;
      // A work stream created moments ago has no transcript yet and a run
      // already going. There is nothing to position, and the reply that is
      // about to arrive is what the person is waiting to read.
      if (transcript.length === 0) {
        scrollTranscriptToEnd();
        setPositionedConversation(conversationAddress);
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
        setPositionedConversation(conversationAddress);
        return;
      }
      scrollTranscriptToEnd();
      setPositionedConversation(conversationAddress);
    });
  }, [id, routedDetail, transcript, transcriptVirtualizer]);

  const acknowledgeVisibleMessages = useCallback((): void => {
    // This endpoint owns Main attention; child ordinals are a separate sequence.
    if (substreamId !== '0') return;
    const detail = queryClient.getQueryData<WorkstreamDetail>(detailQueryKey);
    const element = transcriptRef.current;
    if (!conversationVisibleRef.current || !api || !detail || !element || document.visibilityState !== 'visible' || !document.hasFocus()) return;
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
      if (activeConversationAddressRef.current !== conversationAddress) return;
      // The entry this loop reads back is the addressed one, so it is the one
      // that has to carry the new read waterline or the next scroll re-sends.
      patchCachedWorkstreamViewerState(queryClient, id, updated, substreamId);
    }).catch(() => {
      requestSocketSnapshot();
    }).finally(() => {
      if (readAckInFlightRef.current === ackKey) readAckInFlightRef.current = null;
    });
  }, [api, conversationAddress, detailQueryKey, id, queryClient, requestSocketSnapshot, substreamId, transcript, transcriptVirtualizer]);

  const scheduleReadAcknowledgement = useVisibleReadAcknowledgement(acknowledgeVisibleMessages);

  if (!payloadBelongsToRoute || !routedDetail) {
    if (
      socketConnection.state === 'reconnecting'
      || socketConnection.state === 'unavailable'
    ) {
      return (
        <WorkstreamErrorState
          description={socketConnection.openingError
            ?? (socketConnection.state === 'reconnecting'
              ? 'The live connection could not be opened. Try again while Rally reconnects.'
              : `This ${parentKind === 'automation' ? 'Sidekick' : parentNoun} is unavailable.`)}
          onRetry={socketConnection.retryOpening}
          parentNoun={parentNoun}
          workstreamId={id}
        />
      );
    }
    return <OpeningState label={`Opening ${parentKind === 'automation' ? 'Sidekick' : parentNoun}…`} />;
  }

  const detail = routedDetail;
  const launchAuthor = workspaceMemberFromSession(session);
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
  };
  const sidebarDetail = workstreamContext?.id === id ? workstreamContext : {
    ...displayedDetail, resources: [], participants: [], viewers: [],
  };
  const resourceManagementDetail = resourcePreview?.workstreamScoped ? sidebarDetail : displayedDetail;
  const discoveredResources = [...new Map(
    (availableResources.data?.pages.flatMap((page) => page.items) ?? []).map((resource) => [resource.id, resource]),
  ).values()];

  return (
    <ConnectorConnectionsProvider connections={connections.data}>
    <div className="conversation-layout">
      {renderSidebar?.({
        attachedSidekicks: attachedSidekicks.data,
        attachedSidekicksError: attachedSidekicks.error?.message ?? removeSidekick.error?.message,
        removeSidekick: sidebarDetail.participants.some((person) => person.id === session?.user.id) ? (sidekickId) => removeSidekick.mutate(sidekickId) : undefined,
        detail: sidebarDetail,
        socketState,
        presentUserIds: presenceUserIdsByWorkstream[id] ?? [],
        openParticipantDialog: () => { setParticipantDialogSubstreamId('0'); setParticipantDialogOpen(true); },
        openRail,
        rename: (title) => renameWorkstream.mutateAsync(title).then(() => undefined),
        openArtifact: sidebarCitations.openPreview,
        focusTranscript: () => transcriptRef.current?.focus({ preventScroll: true }),
      })}
    <div className={clsx(
      'workstream-screen',
      parentKind === 'automation' && 'automation-screen',
      // The launch geometry, taken whole from the work-stream launcher: an
      // `auto` header row that can grow into place, the launcher's own dock
      // padding and composer treatment while composing, and nothing of its own
      // once `is-launching` lands — by then the element is already dressed as
      // the conversation it is about to become.
      substreamLaunch && 'workstream-launch-screen',
      substreamLaunch?.launching && 'is-launching',
    )}>
      {substreamLaunch ? <SubstreamLaunchSurface
        api={api}
        currentUser={launchAuthor}
        draft={{
          throughTurnId: substreamLaunch.throughTurnId,
          provenance: branchProvenance(visibleTranscript, substreamLaunch.throughTurnId),
        }}
        error={substreamLaunch.error}
        launching={substreamLaunch.launching}
        {...(api ? { loadAttachmentContent } : {})}
        members={members.data ?? []}
        onCancel={substreamLaunch.onCancel}
        onCreate={substreamLaunch.onCreate}
        onOpenAttachment={setAttachmentPreview}
        parent={displayedDetail}
        workspaceId={workspaceId}
        workspaceRegion={workspaceRegion}
      /> : <>
      {renderHeader?.({
        detail: displayedDetail,
        socketState,
        presentUserIds: presenceUserIdsByWorkstream[id] ?? [],
        openParticipantDialog: () => { setParticipantDialogSubstreamId(substreamId); setParticipantDialogOpen(true); },
        openRail,
        rename: (title) => renameWorkstream.mutateAsync(title).then(() => undefined),
      })}
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
          if (nearBottom
            && newerTranscriptRange !== null
            && !loadingNewerRef.current) {
            void loadNewerMessages();
          }
          scheduleReadAcknowledgement();
        }}
        ref={transcriptRef}
      >
        <div className="transcript-column" ref={transcriptContentRef}>
          <div role="status" className={loadingOlder || (nearHistoryEdge && socketState !== 'connected')
            ? 'transcript-history-control' : undefined}>
            {(loadingOlder || (nearHistoryEdge && socketState !== 'connected')) && <>
              <LoaderCircle aria-hidden="true" className="spin" size={14} />
              <span>{socketState !== 'connected' ? 'Waiting to reconnect…' : 'Loading earlier messages…'}</span>
            </>}
          </div>
          {olderTranscriptRange && olderMessagesError && !loadingOlder && (
            <div className="transcript-history-control">
              <Button disabled={socketState !== 'connected'} onClick={() => void loadOlderMessages()}>
                <RefreshCcw aria-hidden="true" size={14} />
                {socketState !== 'connected' ? 'Waiting to reconnect…' : 'Retry loading earlier messages'}
              </Button>
            </div>
          )}
          {olderMessagesError && <InlineError>{olderMessagesError}</InlineError>}
          {otherHistoryError && <InlineError>{otherHistoryError}</InlineError>}
          {substreamId !== '0' && initialContext.data && <section className="substream-initial-context" aria-label="Initial context">
            <strong>Context from the main conversation</strong>
            <SubstreamContext context={initialContext.data} />
          </section>}
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
            <EmptyState
              title="Ready to begin"
              description={parentKind === 'automation'
                ? 'Tell your Sidekick what you’d like help with. You can ask for changes as you go.'
                : 'Send a message to start work in this stream.'}
            />
          ) : (
            <MessageFeed
              citations={citations}
              currentUserId={session?.user.id}
              currentUserName={session?.user.name}
              firstUnreadIndex={firstUnreadIndex}
              loadAttachmentContent={loadAttachmentContent}
              messages={visibleTranscript}
              liveMessageIds={liveMessageIds}
              onAnswerElicitation={answerElicitation}
              onOpenAttachment={setAttachmentPreview}
              onStartSubstream={parentKind === 'workstream' && substreamId === '0' ? onStartSubstream : undefined}
              {...(api ? { onAcceptDraft: (automationId: string) => {
                acceptProposedAutomation.mutate(automationId);
              } } : {})}
              acceptingDraftFor={acceptProposedAutomation.isPending
                ? acceptProposedAutomation.variables ?? null
                : null}
              acceptDraftError={acceptProposedAutomation.error?.message}
              virtualizer={transcriptVirtualizer}
            />
          )}
          <ActivityPresence>{socketConnection.activeCompaction
            && detail.harnessStatus === 'running'
            && socketConnection.activeCompaction.harnessRunId === (detail.latestHarnessRunId ?? detail.latestHarnessRun?.id)
            ? <AgentCompactionIndicator />
            : !orderedOwnsRunTiming
              && runTiming
              && <AgentWorkTiming key={detail.latestHarnessRunId ?? detail.latestHarnessRun?.id} {...runTiming} />}</ActivityPresence>
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
        <JumpToLatestButton onJump={() => void jumpToLatest()} visible={!transcriptAtEnd} />
        <div className="composer-stack">
          <WorkstreamComposer
            api={api ?? undefined}
            placeholder={parentKind === 'automation' ? 'Ask your Sidekick…' : 'Message the work stream…'}
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
            onReorderQueue={reorderQueue}
            queueItems={queueItems}
            sending={sending}
            uploading={attachmentDraft.uploading}
            key={conversationAddress}
            workstream={displayedDetail}
            workspaceId={workspaceId}
            workspaceRegion={workspaceRegion}
            substreamId={substreamId}
          />
        </div>
      </div>
      </>}

      {(RIGHT_SIDEBAR_ENABLED || resourcePreview) && <InspectorRail
        {...(resourcePreview ? { lightbox: {
          ...resourcePreview,
          onClose: () => setResourcePreview(null),
        } } : {})}
        dropTarget={railDrop}
        {...(api ? { loadResourceContent: loadResourceContent } : {})}
        error={watchResource.error?.message
          ?? detachResource.error?.message
          ?? refreshResource.error?.message
          ?? attachResource.error?.message}
        leaving={railLeaving}
        onAddParticipant={() => { setParticipantDialogSubstreamId(resourcePreview?.workstreamScoped ? '0' : substreamId); setParticipantDialogOpen(true); }}
        {...(substreamId === '0' || resourcePreview?.workstreamScoped ? {
          onAddResource: () => setResourceDialogOpen(true),
          onDetachResource: (resource: WorkstreamResource) => detachResource.mutateAsync(resource),
          onRefreshResource: (resource: WorkstreamResource) => refreshResource.mutate(resource),
          onToggleWatch: (resource: WorkstreamResource, enabled: boolean) => watchResource.mutate({ resource, enabled }),
        } : {})}
        onOpenResourceVersion={openResourceVersion}
        refreshingResourceId={refreshResource.isPending ? refreshResource.variables?.id ?? null : null}
        resourceVersions={resourceVersions.data}
        resourceVersionsError={resourceVersions.error?.message}
        {...(siteArtifacts ? { siteArtifacts } : {})}
        workstream={resourceManagementDetail}
        attachedSidekicks={attachedSidekicks.data}
        onRemoveSidekick={sidebarDetail.participants.some((person) => person.id === session?.user.id) ? (sidekickId) => removeSidekick.mutate(sidekickId) : undefined}
        attachedSidekicksError={attachedSidekicks.error?.message ?? removeSidekick.error?.message}
      />}

      <AddParticipantDialog
        privateSubstream={participantDialogSubstreamId !== '0'}
        current={participantDialogSubstreamId === '0' && renderSidebar ? sidebarDetail.participants : displayedDetail.participants}
        error={addParticipant.error?.message ?? removeParticipant.error?.message}
        members={members.data ?? []}
        onAdd={(member) => {
          removeParticipant.reset();
          addParticipant.mutate({ member, target: participantDialogSubstreamId });
        }}
        onRemove={(member) => {
          addParticipant.reset();
          removeParticipant.mutate({ member, target: participantDialogSubstreamId });
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
        incomplete={availableResources.data?.pages.some((page) => page.complete === false) ?? false}
        onRetry={() => { void availableResources.refetch(); }}
        current={resourceManagementDetail.resources}
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
          if (resourcePreview?.workstreamScoped && substreamId !== '0') {
            setResourcePreview(null);
            void navigate(`/workstreams/${id}`);
            return;
          }
          fileInputRef.current?.click();
        }}
        uploadLabel={resourcePreview?.workstreamScoped && substreamId !== '0' ? 'Upload in Main log' : 'Upload file'}
        open={resourceDialogOpen}
        pending={attachResource.isPending}
        resources={discoveredResources}
        search={resourceSearch}
      />
      <AttachmentLightbox onClose={() => setAttachmentPreview(null)} preview={attachmentPreview} />
    </div>
    </div>
    </ConnectorConnectionsProvider>
  );
}
