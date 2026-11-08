import { SubstreamIdSchema } from '@rally/contracts';
import { MessageIssueProvider } from '../components/message-issue-dialog';
import { validateAnnotationSend } from '../lib/use-annotation-pins';
import { TranscriptHistoryStatus } from '../components/transcript-history-status';
import { loadAnnotationPreview, readAnnotationVersion } from '../lib/annotation-preview';
import { AnnotationDraftProvider, useAnnotationDraft } from '../components/artifact-annotations';
import { EmailMentionContext, emailMentionDirectory, NO_INVITEES } from "../lib/workspace-invitees";
import { mentionLinksAsText } from "@rally/contracts/citations";
import { useWorkspaceMembers } from "../lib/workspace-members";
import { useVisibleReadAcknowledgement } from '../lib/use-visible-read-acknowledgement';
import { useOpenReadReport } from '../lib/open-read-report';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchThroughOwner } from '../lib/fetch-through-owner';
import clsx from 'clsx';
import { personalColor, personalColorInk } from '../components/personal-avatar';
import { MemberPresentationContext } from '../lib/member-presentation';
import {
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
import { useLocation, useSearchParams } from 'react-router-dom';
import { expandToggle, openResourceRequest, usePaneExpansion } from '../lib/navigation-routes';
import {
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  type TranscriptActivity,
  type TranscriptTurn,
  type WorkstreamMessageDeliveryState,
  type WorkstreamTranscriptSnapshot,
  type SidekickMessageIntent,
} from '@rally/contracts';
import type { ConversationParentKind } from '@rally/contracts/conversation-parent';
import type { SubstreamInitialContext } from '@rally/contracts/substream-creation';
import type { ClientSession } from '@rally/contracts/client-session';
import { useCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import { useCitations } from '../lib/use-citations';
import { ApiError, type MentionIdentity } from '../lib/api';
import { conversationAnnotationScope, conversationDraftKey } from '../lib/draft-keys';
import { useBrowserRailLinks } from '../lib/browser-rail-links';
import { TitlePillLeading, TitlePillNavigation, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { WorkstreamGlyph, workstreamMark } from '@rally/ui/components/workstream-glyph';
import { desktopBridge } from '../lib/platform';
import { layoutKey, readArtifactPanel, writeLayout } from '../lib/desktop-layout';
import {
  currentSurfaceEntrypoint,
  reportTelemetryProductIntent,
  type WorkstreamFeedSource,
  workstreamFeedSourceQueryKey,
} from '../lib/telemetry';
import {
  adjacentTranscriptRange,
  collapseSettledWorkIntoAccordion,
  dedupeAdjacentConnectorConnectionCards,
  composeTranscript,
  createTextMessage,
  foldSettledWorkIntoMessages,
  groupPluginToolMessages,
  groupThinkingMessages,
  optimisticMentionRendering,
  orderedTranscriptMessages,
  removeTranscriptOverlay,
  transcriptCoverageAdvanced,
  transcriptOverlaysQueryKey,
  transcriptTurnsKey,
  type TranscriptOverlay,
  upsertTranscriptOverlay,
  withoutAgentWork,
} from '../lib/transcript';
import { useMemberPreferences } from '../lib/use-member-preferences';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useFileDrop } from '../lib/use-file-drop';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { TRANSCRIPT_END_SLACK, useTranscriptFollow } from '../lib/use-transcript-follow';
import { useTranscriptHistory } from '../lib/use-transcript-history';
import { useVirtualScrollAnchor } from '../lib/use-virtual-scroll-anchor';
import { useSiteArtifacts } from '../lib/use-site-artifacts';
import { ActivityPresence, InferenceDelayNotice, JumpToLatestButton } from '../components/conversation-follow';
import { openRailAtEvenSplit, restoreRail, useRailFillsPane } from '../lib/rail-split';
import { type RailVariant, useUiStore } from '../lib/ui-store';
import {
  orderedTranscriptQueryKey,
  useWorkstreamSocket,
  substreamInitialContextQueryKey,
  type SocketState,
  type WorkstreamMessageDeliveryMode,
} from '../lib/use-workstream-socket';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { patchCachedWorkstreamViewerState, workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { answerConversationElicitation } from '../lib/conversation-elicitation';
import type { ElicitationData, HarnessRunMetadata, HarnessStatus, Message, Participant, PendingOpening, ResourceVersion, WorkspaceMember, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { AgentCompactionIndicator, AgentWorkTiming, RunStopAcknowledgement, type AgentWorkTimingProps } from '../components/agent-work-timing';
import { ConnectingCard, ConnectingCardSlot } from '../components/connecting-card';
import { InspectorRail } from '../components/inspector-rail';
import { AttachmentPanel } from '../components/attachment-panel';
import type { AttachmentPreview } from '../components/attachments';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import { HumanMessageBody } from '../components/workstream-blocks';
import { Button, EmptyState, IconButton, ErrorNotice, LoadingState, Modal } from '../components/primitives';
import { OFFLINE_TITLE, OfflineRetry } from '../components/pushed-list-pending';
import { PaneState } from '../components/pane-state';
import { CopyButton } from '../components/copy-button';
import { MessageFeed, useMessageFeedVirtualizer } from '../components/message-feed';
import {
  ConnectorConnectionsProvider,
  connectorConnectionCardInput,
  connectorResourceAuthorizationRequest,
} from '../components/connector-mentions';
import { isUnrecognizedConnectorConnectionCard } from '../lib/connector-connection-card';
import type { ComposerMenuAction } from '../components/composer-input';
import { WorkstreamComposer } from '../components/workstream-composer';
import { useRailExitFade } from '../components/rail-surface';
import { EmbeddedBrowserRail } from '../components/embedded-browser-rail';

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

export function workspaceMemberFromSession(session: ClientSession | null): WorkspaceMember | undefined {
  if (!session?.workspace) return undefined;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    timezone: session.user.timezone ?? 'America/Los_Angeles',
    ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
    role: session.workspace.role,
    ...(session.workspace.accessClass ? { accessClass: session.workspace.accessClass } : {}),
  };
}

/**
 * The shape of a conversation while its first socket snapshot is in flight.
 *
 * This is the real conversation geometry, not a centered interstitial. Keeping
 * the header, feed and composer in place makes opening feel like content
 * arriving into an already-open room and prevents the whole pane from being
 * redrawn around the snapshot.
 */
/**
 * The feed, header and composer placeholders, and the status that says what is
 * opening. The status lives here rather than on the layout so that a rail drawn
 * beside it, placeholder or real, is never read out as part of it.
 */
function ConversationOpeningFeed({ label, parentKind, caption = false, openingMessage, openingAuthorId, loadAttachmentContent }: {
  label: string;
  parentKind: ConversationParentKind;
  /** Show the label above the placeholders, for a wait long enough to explain. */
  caption?: boolean;
  /**
   * What the person just sent, for a thread still being created: drawn as the
   * message it is about to be, mentions and attachments included, so the pane
   * does not swap a placeholder for it.
   */
  openingMessage?: PendingOpening | undefined;
  /** Who sent it, for their own bubble colour, as the transcript draws it. */
  openingAuthorId?: string | undefined;
  /** Reads an attachment's preview; without it the opening shows no attachments. */
  loadAttachmentContent?: ((id: string, signal?: AbortSignal) => Promise<Blob>) | undefined;
}): React.JSX.Element {
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const presentations = useContext(MemberPresentationContext);
  const profile = openingAuthorId ? presentations.get(openingAuthorId) : undefined;
  const bubbleStyle = profile ? {
    '--av-cmp-bubble-human-background': personalColor(profile.color),
    '--av-cmp-bubble-human-foreground': personalColorInk(profile.color),
  } as React.CSSProperties : undefined;
  return (
    <div
      aria-label={label}
      className={clsx(
        'workstream-screen conversation-opening-feed',
        parentKind === 'automation' && 'automation-screen',
      )}
      role="status"
    >
        {parentKind === 'automation' ? (
          <header className="sidekick-conversation-heading window-drag conversation-opening-header">
            <span className="skeleton-bar conversation-opening-header-title" />
          </header>
        ) : (
          <header className="title-pill-header window-drag conversation-opening-header">
            <div className="title-pill-ancestors"><TitlePillLeading /><TitlePillNavigation /></div>
            <div className="title-pill-current"><span className="skeleton-bar title-pill-skeleton" /></div>
            <div className="title-pill-trailing" />
          </header>
        )}
        <div className="transcript-scroll">
          {openingMessage ? <div className="transcript-column conversation-opening-messages">
            <article className="message-block human-message own-human-message" style={bubbleStyle}>
              <div className="human-message-content">
                <HumanMessageBody
                  attachments={openingMessage.attachments}
                  loadAttachmentContent={loadAttachmentContent}
                  mentions={openingMessage.mentions}
                  messageId="opening"
                  onOpenAttachment={setAttachmentPreview}
                  text={openingMessage.text}
                />
              </div>
            </article>
            <p aria-hidden="true" className="conversation-opening-caption">{label}</p>
          </div> : <div className="transcript-column conversation-opening-messages">
            {caption && <p aria-hidden="true" className="conversation-opening-caption">{label}</p>}
            <div className="conversation-opening-message">
              <div className="conversation-opening-byline">
                <span className="skeleton-bar conversation-opening-name" />
                <span className="skeleton-bar conversation-opening-time" />
              </div>
              <div className="conversation-opening-prose">
                <span className="skeleton-bar conversation-opening-line" />
                <span className="skeleton-bar conversation-opening-line is-long" />
                <span className="skeleton-bar conversation-opening-line is-short" />
              </div>
            </div>
            <div className="conversation-opening-message is-human">
              <div className="conversation-opening-byline">
                <span className="skeleton-bar conversation-opening-time" />
                <span className="skeleton-bar conversation-opening-name is-long" />
              </div>
              <div className="conversation-opening-bubble">
                <span className="skeleton-bar conversation-opening-line" />
                <span className="skeleton-bar conversation-opening-line is-long" />
                <span className="skeleton-bar conversation-opening-line is-medium" />
              </div>
            </div>
            <div className="conversation-opening-message">
              <div className="conversation-opening-byline">
                <span className="skeleton-bar conversation-opening-name" />
                <span className="skeleton-bar conversation-opening-time" />
              </div>
              <div className="conversation-opening-prose">
                <span className="skeleton-bar conversation-opening-line is-long" />
                <span className="skeleton-bar conversation-opening-line" />
                <span className="skeleton-bar conversation-opening-line is-medium" />
              </div>
              <div className="conversation-opening-prose">
                <span className="skeleton-bar conversation-opening-line" />
                <span className="skeleton-bar conversation-opening-line is-short" />
              </div>
            </div>
          </div>}
        </div>
        <div className="composer-dock conversation-opening-composer-dock">
          <div className="skeleton-bar conversation-opening-composer" />
        </div>
        <span className="sr-only">{label}</span>
        <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
    </div>
  );
}

export function ConversationOpeningSkeleton({
  label,
  parentKind,
  caption = false,
  openingMessage,
  openingAuthorId,
  loadAttachmentContent,
}: {
  label: string;
  parentKind: ConversationParentKind;
  caption?: boolean;
  openingMessage?: PendingOpening | undefined;
  openingAuthorId?: string | undefined;
  loadAttachmentContent?: ((id: string, signal?: AbortSignal) => Promise<Blob>) | undefined;
}): React.JSX.Element {
  return (
    <div className="conversation-layout conversation-opening-skeleton">
      <ConversationOpeningFeed caption={caption} label={label} loadAttachmentContent={loadAttachmentContent} openingAuthorId={openingAuthorId} openingMessage={openingMessage} parentKind={parentKind} />
    </div>
  );
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
 * Which row the transcript's activity slot shows, if any.
 *
 * Both answers describe the run, so both belong in the feed, in reading order,
 * with the turns they are about. The pending-stop acknowledgement deliberately
 * is not one of them — see `conversationShowsStoppingRow`.
 *
 * `timing` is left to the feed whenever the ordered transcript already draws
 * the run's own rows, which is why it is the one answer that can be `null`
 * while a run is plainly going.
 *
 * The `timing` answer carries the props it was decided from rather than naming
 * a kind and leaving the caller to fetch them. A bare kind made the call site
 * assert `runTiming!` back, which moved the non-null guarantee out of the
 * compiler and into this function and that spread agreeing — so a fourth answer,
 * or a `timing` branch that stopped requiring `runTiming`, would have spread
 * `null` at render instead of failing typecheck.
 */
export function conversationActivityRow(input: {
  status: HarnessStatus;
  compactingThisRun: boolean;
  orderedOwnsRunTiming: boolean;
  runTiming: AgentWorkTimingProps | null;
}): { kind: 'compacting' } | { kind: 'timing'; timing: AgentWorkTimingProps } | null {
  if (input.compactingThisRun && input.status === 'running') return { kind: 'compacting' };
  if (!input.orderedOwnsRunTiming && input.runTiming) {
    return { kind: 'timing', timing: input.runTiming };
  }
  return null;
}

/**
 * Whether to acknowledge a pending stop above the composer.
 *
 * Stop is observed at the loop's next safe step boundary: the response in
 * flight and every tool it already asked for settle first, and no further
 * provider request begins. A production run took 11.2 seconds to get there, and
 * for all of it the only sign the click had landed was a spinner in a 28px
 * button and a tooltip nobody hovers.
 *
 * Drawn in the composer dock rather than in the transcript's activity slot,
 * which is inside the scroller. `useTranscriptFollow` hands the viewport to the
 * reader the moment they scroll up and nothing about pressing Stop takes it
 * back — correctly, since only the reader's own scrolling may move it — so a
 * row appended to the feed lands below the fold for exactly the person most
 * likely to be reading history while a run is going. The dock sits outside the
 * scroller, so this is visible at any scroll position. It also puts the
 * acknowledgement beside the control it answers: the two rows in the feed
 * describe the run, and this one answers a button press.
 *
 * Gated on a live run, not on the flag alone. The loop clears
 * `stop_requested_at` as it goes idle, but a settled run can still be read back
 * before the next snapshot lands, and a stopping row over an already-stopped
 * run promises a wait that is over.
 */
export function conversationShowsStoppingRow(
  status: HarnessStatus,
  stopRequested: boolean | undefined,
): boolean {
  return status === 'running' && stopRequested === true;
}

/**
 * What the dock says about a stop: the run whose stop this session watched
 * settle, and whether a stop it watched being asked for is still pending.
 *
 * The acknowledgement is temporary chrome. It answers a button press, for the
 * people who were in the room when it landed, and nothing durable records it:
 * opening the conversation later shows the transcript and no notice at all.
 * That is why this reads a transition the client observed rather than the run
 * row. `latestHarnessRun.status` is permanent, and read on its own it outlived
 * every reason to say anything — it only moves when a *new run* exists, and a
 * member turn the addressing classifier reads as conversation between people
 * starts none (`agent-harness.md`), so in a room with two people in it the
 * notice sat under every later message, reading as Rally having stopped on the
 * message that person had just sent.
 *
 * `pendingRunId` is the arming signal: the run this session watched a stop
 * asked for, while it was still going. It has to *survive* the wait, which is
 * the whole subtlety here — between the request and the settlement the run
 * still reads `running`, so an arming that cleared itself as soon as it found
 * nothing to acknowledge would throw away the only record that this reader
 * asked. It clears when that run settles, whatever it settles as, because by
 * then it has either been acknowledged or has nothing to say.
 *
 * Both halves name a run rather than carrying a bare flag, and for the same
 * reason: an arm is made for one run and answers only that one. It cannot be a
 * boolean, because the two do not arrive together. `applyHarnessStatus` clears
 * `stopRequested` from the status event and leaves `latestHarnessRun` to the
 * canonical snapshot behind it, so the arm has to bridge that gap — and a
 * snapshot that lands already carrying a *newer* run would otherwise inherit
 * it, and answer a button press nobody made for that one.
 */
export interface StopAcknowledgement {
  /** The run whose stop this session watched settle, and still says so. */
  runId: string | null;
  /** The run this session watched a stop asked for, until that run settles. */
  pendingRunId: string | null;
}

export const NO_STOP_ACKNOWLEDGEMENT: StopAcknowledgement = { runId: null, pendingRunId: null };

export function nextStopAcknowledgement(
  current: StopAcknowledgement,
  status: HarnessStatus,
  stopRequested: boolean | undefined,
  run: Pick<HarnessRunMetadata, 'id' | 'status'> | null | undefined,
): StopAcknowledgement {
  if (!run) return NO_STOP_ACKNOWLEDGEMENT;
  const armed = conversationShowsStoppingRow(status, stopRequested) || current.pendingRunId === run.id;
  // Two facts, because neither covers the whole sequence.
  //
  // The conversation's status says whether anything is live, and says it
  // first: `applyHarnessStatus` moves it on the status event and leaves the
  // run row to the canonical snapshot behind it. Without it, a held
  // acknowledgement sits in the dock saying the run stopped while the feed
  // above it draws an agent visibly working.
  //
  // The run row says whether what ended was a stop, and it is the only thing
  // that says so. A member stop's status frame does *not* report `stopped`:
  // `settleWorkstreamState` leaves a stopped run's work stream `idle`,
  // deliberately, because a stop is the member taking the conversation back
  // rather than an outcome to report — and this client reads `idle` as
  // `completed`. Driven against the running client, a real stop reports
  // `status: completed, runStatus: stopped`.
  //
  // So the frame that ends the wait is indistinguishable from an ordinary
  // finish until the run row arrives, and the arming has to outlive it.
  // Cleared there, the acknowledgement is gone a beat before its own evidence
  // and never appears at all — which a stop in the client showed and no test
  // did. The dock holds the row up across that window for the same reason.
  const working = status === 'running' || status === 'scheduled' || status === 'needs_input';
  const stopLanded = status === 'stopped' || run.status === 'stopped';
  const runSettled = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped';
  const held = armed || current.runId === run.id;
  return {
    runId: !working && stopLanded && held ? run.id : null,
    pendingRunId: armed && !runSettled ? run.id : null,
  };
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
 * conversation through the branch point, and these turns are the only part of
 * it anybody is shown — the frozen summary itself is the child's runs' to read.
 */
const BRANCH_PROVENANCE_TURNS = 5;

/**
 * The turns shown, faded, above a substream's composer: the message it branches
 * from and the ones that led to it, oldest first.
 *
 * Only written rows, counted in turns. (The rule was "What reaches a
 * Breakout" in the retired docs/substream-creation.md.)
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
  // The turn's last row: its work row comes first and shares its id.
  let cutoff = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index]!;
    if (message.transcriptTurnId === throughTurnId || message.id === throughTurnId) {
      cutoff = index;
      break;
    }
  }
  // A branch point outside the loaded window is not an error and not a reason
  // to show the wrong turns: the substream is still the one that was asked
  // for, and its provenance is simply not on the client to draw.
  if (cutoff < 0) return [];
  const shown: Message[] = [];
  const turns = new Set<string>();
  for (let index = cutoff; index >= 0; index -= 1) {
    const message = transcript[index]!;
    if (message.messageType !== 'text' && message.messageType !== 'automation_activation') continue;
    const turn = message.transcriptTurnId ?? message.id;
    if (!turns.has(turn)) {
      if (turns.size === BRANCH_PROVENANCE_TURNS) break;
      turns.add(turn);
    }
    shown.push(message);
  }
  return shown.reverse();
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

/**
 * The sentence a refusal carries, when the server wrote one for the person in
 * front of it: a 4xx with a code, whose message the route chose. Anything else
 * — a network failure, a 5xx, a body with no error — keeps the caller's
 * generic sentence rather than a status line.
 */
export function refusalMessage(error: unknown): string | undefined {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code
    ? error.message : undefined;
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
  failure,
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
  failure?: 'load' | 'attach' | undefined;
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
        {failure ? <ErrorNotice>{failure === 'load'
          ? 'Resources couldn’t be loaded.'
          : 'That resource couldn’t be added.'}</ErrorNotice> : null}
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
  header,
  onRetry,
  parentNoun = 'Canvas',
  workstreamId,
}: {
  /** What the server said when it refused, if it said anything. */
  description: string | undefined;
  /** The conversation's own header, kept over the state (`stateHeader`). */
  header?: React.ReactNode;
  onRetry: () => void;
  /** What could not be opened, for the title. */
  parentNoun?: 'Sidekick' | 'Canvas';
  workstreamId: string;
}): React.JSX.Element {
  const copyWorkstreamId = (): void => {
    void desktopBridge().copyText(workstreamId)
      .then(() => reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_id', resourceType: 'workstream', resourceId: workstreamId,
      }))
      .catch(() => undefined);
  };
  const menu = <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><IconButton className="title-pill-action" label={`More ${parentNoun} actions`}><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
        <DropdownMenu.Item className="menu-item" onSelect={copyWorkstreamId}><Info size={14} /> Copy {parentNoun} ID</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
  // A refusal the server explained names the conversation; a connection that
  // could not be reached at all is the PRD's offline state, which blames
  // nothing on the conversation. Either way it is the pane's one state, with
  // Back and Forward, and never a dialog over it.
  return description
    ? <PaneState
      action={<div className="empty-state-actions">
        <ErrorNotice automatic={false} detailsLabel="Connection details" title={`${parentNoun} could not be opened`}>{description}</ErrorNotice>
        <Button onClick={onRetry}><RefreshCcw size={14} /> Try again</Button>
      </div>}
      description="Try opening it again."
      header={header}
      title={`This ${parentNoun} could not be opened.`}
      trailing={menu}
    />
    : <PaneState
      action={<OfflineRetry onRetry={onRetry} />}
      description="Live edits resume when Rally reconnects."
      header={header}
      title={OFFLINE_TITLE}
      trailing={menu}
    />;
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

/**
 * The acknowledgement one conversation owes, addressed to itself, or nothing.
 *
 * Every conversation keeps its own read waterline: an `AgentLoopDO` per
 * substream, each with its own attention ordinals and its own
 * `member_attention` row. So the conversation on screen is always the one to
 * acknowledge, whether it is Main or a private child. This used to be a work
 * stream's fact, and a child's read therefore went unrecorded: the divider it
 * had already drawn from that child's own unread waterline stayed above the
 * reply the person was reading, through reopens and reconnects alike, because
 * nothing but sending another message could move `seen_attention_ordinal`
 * there.
 *
 * Nothing to send when no message that asks for attention is on screen, or
 * when the room already knows everything visible has been read, unless a
 * manual mark is standing, which this acknowledgement is what retires, or
 * this open of the conversation has not reported yet. An open always reports
 * once, at the cursor the room already holds if nothing moved it: Activity
 * clears a finished run's row, which is updated in place, on a report's time
 * as well as its cursor, so a person who had read the Sidekick before its run
 * finished would otherwise come back to a row nothing clears
 * (`docs/activity.md`). For the same reason a new or revised turn while the
 * conversation is open owes one more: a run's row finishing in place in front
 * of its requester moves no cursor. Once per open and per change of its
 * turns, never per scroll, so the read path costs what it did.
 *
 * `key` is the identity of the one request allowed in flight. It carries the
 * substream because the acknowledgement does: two children of one work stream
 * are two waterlines, and a key naming only the work stream would call them
 * the same read.
 */
export function conversationReadAcknowledgement(input: {
  parentId: string;
  substreamId: string;
  highestVisibleSequence: number;
  viewer: Pick<WorkstreamDetail,
    'readThroughSequenceNumber' | 'manualUnreadFromSequenceNumber' | 'manualUnreadGeneration'>;
  /** Whether this open of the conversation, at its current turns, has already sent a report. */
  reportedThisOpen: boolean;
}): {
  parentId: string;
  substreamId: string;
  readThroughSequenceNumber: number;
  observedManualUnreadGeneration: number;
  key: string;
} | null {
  if (input.highestVisibleSequence === 0) return null;
  const unchanged = input.highestVisibleSequence <= input.viewer.readThroughSequenceNumber
    && input.viewer.manualUnreadFromSequenceNumber === null;
  if (unchanged && input.reportedThisOpen) return null;
  // An open's report at an unchanged cursor restates it rather than reading
  // back to what happens to be on screen.
  const readThroughSequenceNumber = unchanged
    ? input.viewer.readThroughSequenceNumber : input.highestVisibleSequence;
  return {
    parentId: input.parentId,
    substreamId: input.substreamId,
    readThroughSequenceNumber,
    observedManualUnreadGeneration: input.viewer.manualUnreadGeneration,
    key: `${input.parentId}:${input.substreamId}:${readThroughSequenceNumber}:${input.viewer.manualUnreadGeneration}`,
  };
}

export function RunFailureNotice({
  automatic = true,
  code,
  message,
  requestId,
  retrying,
  onRetry,
}: {
  automatic?: boolean;
  code: string;
  message: string;
  requestId?: string;
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Run recovery" className="run-recovery">
      <ErrorNotice automatic={automatic} detailsLabel="Run details" occurrence={requestId} title="Run failed">
      <div className="run-failure-copy">
        <p>{message}</p>
        <code>{code}</code>
        {/* The id is shown beside its control rather than hidden behind a
            sentence: the message asks for it to be copied for support, and a
            copy control is an icon, so the value has to be on screen for the
            icon to be about something. */}
        {requestId ? (
          <div className="copy-detail run-failure-request">
            <span>Request ID <span className="mono">{requestId}</span></span>
            <CopyButton label="Copy request ID" size={12} value={requestId} />
          </div>
        ) : null}
      </div>
      </ErrorNotice>
      <div className="run-failure-actions">
        <Button className="button-primary" disabled={retrying} onClick={onRetry}>
          {retrying ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <RefreshCcw aria-hidden="true" size={13} />}
          Retry
        </Button>
      </div>
    </section>
  );
}

/** Hoisted for identity: a `?? []` per render would re-key the citation lookup. */
const NO_MEMBERS: WorkspaceMember[] = [];

const NO_WORKSPACE_PRESENCE: Record<string, string[]> = {};

const NO_RESOURCES: WorkstreamDetail['resources'] = [];
const IGNORE_FILES = (): void => undefined;

/**
 * What a conversation's right panel holds: one of its resources, with the
 * resource's own actions, or a file to read (an attachment, a citation's file,
 * a prior version). `workstreamScoped` marks a resource of the thread's Main
 * opened from a Breakout's sidebar.
 */
type ConversationPanel =
  | { kind: 'resource'; resourceId: string; workstreamScoped?: boolean }
  | { kind: 'attachment'; preview: AttachmentPreview };

/**
 * What the surface hands whoever renders the strip above the feed. A work
 * stream puts its header there; an automation's screen renders its own header
 * outside the surface and passes nothing.
 */
export interface ConversationHeaderContext {
  detail: WorkstreamDetail;
  socketState: SocketState;
  presentUserIds: readonly string[];
  openResource: (resourceId: string, returnFocus: HTMLElement) => void;
  openRail: (variant: RailVariant) => void;
  /** Open one of this conversation's artifacts in its own right panel. */
  openArtifact: (id: string, returnFocus: HTMLElement) => void;
}


/**
 * Bring this turn into view; a new nonce asks again for the same turn.
 * `arriving` is a turn just written that the feed has yet to receive: the
 * request waits for it rather than paging back through older messages.
 */
export interface ScrollToTurnRequest {
  turnId: string;
  nonce: number;
  arriving?: boolean;
}

/** The keys that scroll a focused transcript. */
const TRANSCRIPT_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export interface ConversationSurfaceProps {
  parentKind: ConversationParentKind;
  parentId: string;
  substreamId: string;
  renderHeader?: (context: ConversationHeaderContext) => React.ReactNode;
  /**
   * The header a state with no conversation to show (offline, refused) keeps
   * over it, which `renderHeader` cannot draw without the conversation's detail.
   */
  stateHeader?: React.ReactNode;
  scrollToTurn?: ScrollToTurnRequest | null;
  /**
   * What every message sent from this surface is for, when the host says:
   * `edit_sidekick` marks it for a Sidekick's wizard. The server routes an
   * unmarked message in a Sidekick's conversation to a run.
   */
  messageIntent?: SidekickMessageIntent;
  /** Entries the host adds to the composer's menu, after the surface's own. */
  composerMenuActions?: readonly ComposerMenuAction[];
  /** What the composer says while empty, when the host has something more specific to say. */
  composerPlaceholder?: string;
  /**
   * What the conversation is called where the host knows better than its
   * stored title: a Sidekick's conversation keeps the title it was created
   * with ("New Sidekick") while the Sidekick is renamed around it.
   */
  conversationName?: string;
  /** A line just over the composer for a mode the host has put it in, such as editing a Sidekick. */
  composerNotice?: React.ReactNode;
  /** Escape in an empty composer leaves that mode. */
  onComposerCancel?: () => void;
  /**
   * Draw the feed without a composer: a run's own conversation, opened from
   * its Sidekick. Only the composer goes: a question in the feed keeps its
   * answer form, since answering it is how a waiting run continues.
   */
  withoutComposer?: boolean;
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
export function ConversationSurface(props: ConversationSurfaceProps): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  return <AnnotationDraftProvider draftKey={conversationDraftKey(session?.workspace?.region ?? 'global', session?.workspace?.id ?? 'unbound', props.parentKind, props.parentId, props.substreamId)} scopeKey={conversationAnnotationScope(props.parentKind, props.parentId, props.substreamId)} readResource={api ? (id) => api.getResource(id) : undefined} readResourceVersion={api ? (id,version,signal,annotation,mimeType) => readAnnotationVersion(api,id,version,signal,annotation,mimeType) : undefined} upload={api ? async (file) => (await api.uploadResource(file, crypto.randomUUID())).id : undefined}><ConversationSurfaceContent {...props} /></AnnotationDraftProvider>;
}

function ConversationSurfaceContent({
  parentKind,
  parentId: id,
  substreamId,
  renderHeader,
  stateHeader,
  scrollToTurn = null,
  messageIntent,
  composerMenuActions: hostMenuActions,
  composerPlaceholder,
  composerNotice,
  conversationName,
  onComposerCancel,
  withoutComposer = false,
}: ConversationSurfaceProps): React.JSX.Element {
  const annotationDraft = useAnnotationDraft();
  const detailQueryKey = useMemo(() => workstreamDetailQueryKey(id, substreamId), [id, substreamId]);
  const parentDetailQueryKey = useMemo(() => workstreamDetailQueryKey(id, '0'), [id]);
  const transcriptQueryKey = useMemo(() => orderedTranscriptQueryKey(id, substreamId), [id, substreamId]);
  const parentNoun = parentKind === 'automation' ? 'Sidekick' : 'Canvas';
  const [searchParams, setSearchParams] = useSearchParams();
  const searchSequence = Number(searchParams.get('sequence'));
  const searchTurnId = Number.isSafeInteger(searchSequence) && searchSequence > 0 ? searchParams.get('turn') : null;

  const requestedSearch = useRef<string | null>(null);

  const { api, session } = useCollaborationSession();
  const { guest } = useShellCapabilities();
  const workspaceSocket = useOptionalWorkspaceSocket();
  const presenceUserIdsByWorkstream = workspaceSocket?.presenceUserIdsByWorkstream ?? NO_WORKSPACE_PRESENCE;
  const queryClient = useQueryClient();
  const closeRail = useUiStore((state) => state.closeRail);
  const inspect = useUiStore((state) => state.inspect);
  const inspector = useUiStore((state) => state.inspector);
  const openRail = useUiStore((state) => state.openRail);
  const storeRailOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const railWidth = useUiStore((state) => state.railWidth);
  const railScope = useUiStore((state) => state.railScope);
  const setRailLeaving = useUiStore((state) => state.setRailLeaving);
  const setRailScope = useUiStore((state) => state.setRailScope);
  // The right slot belongs to one conversation at a time, so it is scoped to
  // the conversation that opened it: a surface opens, closes and fades only
  // its own panel.
  const railScopeKey = substreamId === '0' ? id : `${id}:${substreamId}`;
  const claimRail = useCallback((): void => {
    if (useUiStore.getState().railScope !== railScopeKey) setRailScope(railScopeKey);
  }, [railScopeKey, setRailScope]);
  const openOwnRail = useCallback((variant: RailVariant = 'context'): void => {
    claimRail();
    openRail(variant);
  }, [claimRail, openRail]);
  const closeOwnRail = useCallback((): void => {
    if (useUiStore.getState().railScope === railScopeKey) closeRail();
  }, [closeRail, railScopeKey]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutElement = useCallback(() => layoutRef.current, []);
  const setRailVariant = useUiStore((state) => state.setRailVariant);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const conversationGenerationRef = useRef(0);
  const olderRequestsRef = useRef(new Map<string, Promise<void>>());
  const [positionedConversation, setPositionedConversation] = useState<string | null>(null);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState('');
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState('');
  const [sendError, setSendError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  // Declared up here because sending clears it, and the composer's send is
  // defined long before the fold below that maintains it.
  const [carriedStopAcknowledgement, setCarriedStopAcknowledgement] = useState(NO_STOP_ACKNOWLEDGEMENT);
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
  const artifactPanelKey = layoutKey(session?.workspace?.id ?? 'unbound', session?.user.id ?? 'unbound', `artifact-panel:${conversationAddress}`);
  const restoredPanelKey = useRef<string | null>(null);
  const activeConversationAddressRef = useRef(conversationAddress);
  const pendingSendCount = useRef(0);
  // What the right panel holds. Every artifact and attachment this
  // conversation opens lands here rather than in a modal. Closing keeps the
  // occupant so the panel has something to draw while it fades out.
  const [panel, setPanel] = useState<ConversationPanel | null>(null);
  const openPanel = useCallback((next: ConversationPanel): void => {
    setPanel(next);
    // Every attachment and artifact opens at an even split with the conversation.
    openRailAtEvenSplit(railScopeKey, () => openOwnRail('context'));
  }, [openOwnRail, railScopeKey]);
  const resourcePanel = panel?.kind === 'resource' ? panel : null;
  const openAttachment = useCallback((preview: AttachmentPreview): void => {
    if (preview.annotation && api && preview.resourceId) {
      void loadAnnotationPreview(api,preview,(resourceId)=>openPanel({kind:'resource',resourceId})).then((loaded)=>openPanel({kind:'attachment',preview:loaded}));
      return;
    }
    if (preview.resourceId && !preview.loadContent) {openPanel({kind:'resource',resourceId:preview.resourceId});return;}
    openPanel({ kind: 'attachment', preview });
  }, [openPanel, api]);
  const setAnnotationPreviewOpener = annotationDraft?.setPreviewOpener;
  useEffect(()=>{setAnnotationPreviewOpener?.(openAttachment);return()=>setAnnotationPreviewOpener?.(null);},[openAttachment,setAnnotationPreviewOpener]);
  const openResourceDetails = useCallback((resourceId: string): void => {
    openPanel({ kind: 'resource', resourceId });
  }, [openPanel]);
  // A navigation can ask this conversation to open onto an artifact (a
  // Canvas opened onto one). Arriving by it, the panel restored below is that
  // artifact rather than the one this conversation saved.
  const location = useLocation();
  const resourceRequest = openResourceRequest(location.state);
  const requestedResourceId = resourceRequest?.conversationId === id && substreamId === '0' ? resourceRequest.resourceId : null;
  // Each navigation onto an artifact is a request of its own: selecting the
  // same pinned row again, after closing its panel, opens it again.
  const resourceRequestKey = requestedResourceId === null ? null : location.key;
  const workspaceId = session?.workspace?.id ?? 'unbound';
  const workspaceRegion = session?.workspace?.region ?? 'global';
  const attachmentDraft = useFileAttachments(api, conversationDraftKey(workspaceRegion, workspaceId, parentKind, id, substreamId));
  // A conversation without a composer (a run opened from its Sidekick) has none to
  // show what lands in its draft, so a drop or a paste there would upload a
  // file nobody can see or send: it takes none.
  const acceptFiles = withoutComposer ? IGNORE_FILES : attachmentDraft.addFiles;
  const transcriptDrop = useFileDrop(acceptFiles);
  const railDrop = useFileDrop(acceptFiles);
  // The composer does not take focus when a work stream opens, so a paste that
  // lands on the document reaches the same draft the transcript and rail accept
  // files into.
  const conversationVisible = useContext(ConversationVisibilityContext);
  const conversationVisibleRef = useRef(conversationVisible);
  conversationVisibleRef.current = conversationVisible;
  useWindowFilePaste(acceptFiles, !conversationVisible);
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
    const savedPanel = requestedResourceId !== null
      ? { resourceId: requestedResourceId, workstreamScoped: false }
      : readArtifactPanel(artifactPanelKey);
    setPanel(savedPanel ? { kind: 'resource', ...savedPanel } : null);
    setResourceDialogOpen(false);
    // Claimed on arrival when there is a panel to restore, or when nobody holds
    // the slot.
    if (savedPanel || useUiStore.getState().railScope === null) setRailScope(railScopeKey);
    if (savedPanel) restoreRail(railScopeKey, () => useUiStore.getState().openRail('context'));
    restoredPanelKey.current = artifactPanelKey;
    return () => {
      restoredPanelKey.current = null;
      if (useUiStore.getState().railScope === railScopeKey) {
        closeRail();
        inspect(null);
        setRailScope(null);
      }
    };
  }, [artifactPanelKey, closeRail, inspect, railScopeKey, requestedResourceId, resourceRequestKey, setRailScope]);
  // Only a Canvas draws the browser rail; a Sidekick's links stay external.
  useBrowserRailLinks(parentKind === 'canvas', layoutElement, claimRail);

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
  const workstream = useQuery<WorkstreamDetail | undefined>({
    queryKey: detailQueryKey,
    queryFn: fetchThroughOwner,
    enabled: false,
    staleTime: 5_000,
  });
  const orderedTranscript = useQuery<WorkstreamTranscriptSnapshot | undefined>({
    queryKey: transcriptQueryKey,
    queryFn: fetchThroughOwner,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Subscribed to, never read: nothing on this surface draws a substream's
  // starting context. The observer is what keeps the socket-owned entry in the
  // cache, and two things that never render it read it by key — `sendReady`,
  // which will not let a substream send until its context has arrived, and the
  // local-cache mirror, which declines to write a conversation whose context it
  // cannot find. An entry nobody observes is garbage-collected out from under
  // both of them five minutes after it lands.
  useQuery<SubstreamInitialContext | null>({
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
  const payloadBelongsToRoute = workstreamPayloadBelongsToRoute(
    id,
    workstream.data,
    orderedTranscript.data,
  );
  const routedDetail = payloadBelongsToRoute ? workstream.data : undefined;
  // A stored failure is available through Run details. Only a run seen active
  // in this conversation is a new interruption, including across cache updates.
  const observedActiveRun = useRef<string | null>(null);
  useEffect(() => {
    if (routedDetail?.harnessStatus === 'running') {
      observedActiveRun.current = routedDetail.latestHarnessRunId ?? routedDetail.latestHarnessRun?.id ?? null;
    }
  }, [routedDetail]);
  const feedSource = useQuery<WorkstreamFeedSource | null>({
    queryKey: workstreamFeedSourceQueryKey(id, substreamId),
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  /**
   * The transcript on screen is what the local cache remembered, not what the
   * room has said on this socket. Everything that reads or writes against the
   * room's fence — range loads, read acknowledgements, sending — waits for the
   * live snapshot that replaces it; what stays is reading and composing.
   */
  const feedFromLocalCache = feedSource.data === 'local_cache';
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
  const loadOriginalResourceContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api
      ? api.getResourceContent(resourceId, signal)
      : Promise.reject(new Error('No API session')),
    [api],
  );
  const siteArtifacts = useSiteArtifacts(api);
  useEffect(() => {
    if (!resourcePanel) return;
    if (!routedDetail || routedDetail.resources.some((resource) => resource.id === resourcePanel.resourceId)) return;
    // The device cache's copy of the conversation is not the room's word on
    // what it holds; it can predate the artifact, or hold none at all, and
    // closing on it shut the panel a Canvas had just opened onto its newest
    // artifact on a first visit.
    if (feedFromLocalCache) return;
    setPanel(null);
    closeOwnRail();
  }, [resourcePanel, closeOwnRail, feedFromLocalCache, routedDetail]);
  // Popped-out windows follow new versions from the app shell
  // (`App.tsx`), which reads every version this conversation's socket carries
  // through `followResourceHeads`.
  const attachResource = useMutation({
    mutationFn: (resource: WorkstreamResource) => api!.attachResource(id, resource.id),
    onSuccess: (updated) => queryClient.setQueryData(parentDetailQueryKey, updated),
  });
  // Renaming is for what this conversation generated, not for a file somebody attached.
  const isGeneratedArtifact = (resourceId: string): boolean =>
    Boolean(routedDetail?.resources.some((resource) => resource.id === resourceId && resource.direction === 'artifact'));
  // Citations resolve against the loaded work stream's resources, and the
  // transcript needs this before the screen has decided it has a work stream to
  // draw at all — hence `routedDetail?`, and hence the hoisted empty array,
  // which keeps the identity stable while there is nothing loaded. It is
  // declared after the preview read because it now takes it: the embed card's
  // excerpt is the same derivative the rail's panel shows.
  const citations = useCitations({
    loadResourceContent,
    onOpenPreview: openAttachment,
    onOpenResourceDetails: openResourceDetails,
    resources: routedDetail?.resources ?? NO_RESOURCES,
  });
  // The store holds the rail's open state, but on the render that changes the
  // route it is still describing the previous work stream — the effect above
  // has not run yet. Reading it through the scope is what keeps that render
  // from laying out, or starting a fade for, a panel belonging to the stream
  // just left; every path that opens the rail writes the store, and each is
  // honoured from the moment the scope names this stream.
  const railOpen = (railVariant === 'browser' || Boolean(panel)) && storeRailOpen && railScope === railScopeKey;
  useEffect(() => {
    if (restoredPanelKey.current !== artifactPanelKey) return;
    // A link opened in the browser covers the artifact panel rather than
    // closing it, so the saved panel stays for when the browser closes.
    if (railVariant === 'browser' && panel) return;
    // Only a resource is restored after relaunch: an attachment preview is a
    // loader closure, with nothing to write down.
    writeLayout(artifactPanelKey, railOpen && railVariant === 'context' && resourcePanel
      ? JSON.stringify({ resourceId: resourcePanel.resourceId, workstreamScoped: false }) : null);
  }, [artifactPanelKey, panel, resourcePanel, railOpen, railVariant]);
  // A route switch is not a sidebar hand-off: scope the fade to the work stream
  // so the previous stream's inspector never dissolves over the arriving feed.
  const railLeaving = useRailExitFade(railOpen, railScopeKey);
  // Once a closed panel has faded out it is gone. Kept any longer, a browser
  // opened later would hand the slot back to it on close (below), bringing
  // back an attachment the person had already closed.
  useEffect(() => {
    if (panel && !railOpen && !railLeaving) setPanel(null);
  }, [panel, railLeaving, railOpen]);
  // The panel is expanded over its conversation, or beside it. A navigation
  // onto an artifact asks for it expanded; an artifact opened from the
  // transcript opens beside. Only the requested artifact honours the request,
  // so another opened after it opens beside.
  const panelShown = railOpen && railVariant === 'context' && Boolean(panel);
  const panelKey = !panelShown || !panel ? null
    : panel.kind === 'resource' ? `resource:${panel.resourceId}` : `attachment:${panel.preview.resourceId ?? panel.preview.name}`;
  const { expanded: panelExpanded, setExpanded: setPanelExpanded } = usePaneExpansion(
    panelKey,
    requestedResourceId !== null && panelKey === `resource:${requestedResourceId}`,
  );
  const ownsRail = railScope === railScopeKey;
  const setRailExpanded = useUiStore((state) => state.setRailExpanded);
  useEffect(() => {
    if (!ownsRail) return undefined;
    setRailExpanded(panelExpanded);
    return () => setRailExpanded(false);
  }, [ownsRail, panelExpanded, setRailExpanded]);
  // Too narrow for the panel beside its conversation, a phone included, the
  // panel covers the pane whether or not it was expanded, so it offers
  // neither Expand nor a Collapse that would change nothing. The expansion
  // is kept for when the window widens.
  const panelFillsPane = useRailFillsPane(useUiStore((state) => state.sidebarWidth));
  const panelExpandAction = panelFillsPane ? undefined : expandToggle(panelExpanded, true, setPanelExpanded);
  // Alone on screen, the panel carries the crumb of the conversation it covers.
  const conversationTitle = routedDetail?.title ?? '';
  const conversationMarkId = substreamId === '0' ? id : substreamId;
  const panelAncestors: TitlePillLevel[] | undefined = !panelExpanded && !panelFillsPane ? undefined : [
    {
      key: `panel-conversation:${conversationAddress}`,
      icon: <WorkstreamGlyph appearance={routedDetail?.appearance} id={conversationMarkId} size={24} />,
      bridge: {
        mark: workstreamMark(conversationMarkId, routedDetail?.appearance ?? undefined),
        name: conversationTitle,
        action: parentKind === 'automation' ? 'Open Sidekick' : 'Open Canvas',
      },
      title: conversationTitle,
      label: `Show ${conversationTitle || 'the conversation'}`,
      onSelect: () => {
        if (panelFillsPane) closeOwnRail();
        else setPanelExpanded(false);
      },
    },
  ];
  // A guest reads it too, but names and mentions from the conversation's own
  // participants; see `visibleMembers`.
  const members = useWorkspaceMembers(api);
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api && !guest),
    // OAuth completion publishes the workspace socket's
    // `connector_connections` topic. Its invalidation refetches this active
    // query, which lets an in-feed connection card become Connected without a
    // focus heuristic or polling loop.
    staleTime: 60_000,
  });
  const visibleMembers = guest ? routedDetail?.participants ?? NO_MEMBERS : members.data ?? NO_MEMBERS;
  const visibleConnections = guest ? routedDetail?.connections : connections.data;
  const emailMentions = useMemo(() => emailMentionDirectory(visibleMembers, NO_INVITEES), [visibleMembers]);
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
  const socketConnection = useWorkstreamSocket(
    api,
    id,
    Boolean(api && id),
    'active_workstream',
    undefined,
    true,
    substreamId,
  );
  const requestSocketSnapshot = socketConnection.requestSnapshot;
  useEffect(() => {
    if (socketConnection.state !== 'connected' || payloadBelongsToRoute) return;
    requestSocketSnapshot();
  }, [payloadBelongsToRoute, requestSocketSnapshot, socketConnection.state]);
  const socketState = socketConnection.state;
  /** The room is on the line and what is on screen is its own: ranges can be asked for against it. */
  const feedLive = socketState === 'connected' && !feedFromLocalCache;
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
  // Declared here, after the snapshot it is keyed by: a new or revised turn
  // owes a fresh report at an unchanged cursor (`useOpenReadReport`).
  const openReadReport = useOpenReadReport(conversationAddress, transcriptTurnsKey(orderedTranscript.data));
  const canonicalTranscript = useMemo(() => orderedTranscriptMessages(
    orderedTranscript.data,
    id,
    visibleMembers,
  ), [id, visibleMembers, orderedTranscript.data]);
  const liveMessageIds = useMemo(() => new Set((transcriptOverlays.data ?? [])
    .filter((overlay) => overlay.provenance.source === 'client_command'
      || overlay.provenance.source === 'stream_event'
      || overlay.provenance.source === 'socket_event')
    .map((overlay) => overlay.message.id)), [transcriptOverlays.data]);
  // A guest is refused the members' `/workspace` routes, so a guest keeps the
  // defaults; the socket still answers with whatever is stored.
  const showAgentWork = useMemberPreferences(
    session?.workspace?.accessClass === 'guest' ? null : api,
    workspaceId,
  ).data.showAgentWork;
  const transcript = useMemo(
    () => {
      const feedOverlays = transcriptOverlays.data ?? [];
      const composed = dedupeAdjacentConnectorConnectionCards(
        composeTranscript(canonicalTranscript, feedOverlays),
      );
      return collapseSettledWorkIntoAccordion(
        foldSettledWorkIntoMessages(
          groupThinkingMessages(
            groupPluginToolMessages(showAgentWork ? composed : withoutAgentWork(composed, (message) => (
              connectorResourceAuthorizationRequest(message) !== null
                || connectorConnectionCardInput(message) !== null
                || isUnrecognizedConnectorConnectionCard(message)
            ))),
          ),
        ),
      );
    },
    [canonicalTranscript, transcriptOverlays.data, showAgentWork],
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
    isFollowing: isFollowingTranscript,
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
    if (!feedLive) requestedSearch.current = null;
    if (!searchTurnId || !Number.isSafeInteger(searchSequence) || searchSequence < 1
      || !feedLive || !orderedTranscript.data) return;
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
    }).catch(() => {
      if (activeConversationAddressRef.current === conversationAddress && requestedSearch.current === requestKey) setOtherHistoryError('The matching message couldn’t be opened. Try again.');
    });
  }, [conversationAddress, feedLive, id, loadTranscriptRange, orderedTranscript.data, releaseTranscriptFollow,
    searchSequence, searchTurnId, setSearchParams, transcript, transcriptVirtualizer]);

  const revealTurn = useCallback((turnId: string): boolean => {
    const index = transcript.findIndex((message) => message.transcriptTurnId === turnId);
    if (index < 0) return false;
    releaseTranscriptFollow();
    transcriptVirtualizer.scrollToIndex(index, { align: 'center' });
    return true;
  }, [releaseTranscriptFollow, transcript, transcriptVirtualizer]);
  const handledScrollNonce = useRef<number | null>(null);

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
    if (!feedLive) {
      pendingOlderAfterReconnectRef.current = true;
      return;
    }
    pendingOlderAfterReconnectRef.current = false;
    setLoadingOlder(true);
    setOlderMessagesError(undefined);
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
      } catch (error) {
        if (!stillCurrent()) return;
        if (error instanceof ApiError && error.code === 'workstream_socket_unavailable') {
          pendingOlderAfterReconnectRef.current = true;
          return;
        }
        setOlderMessagesError('Earlier messages couldn’t be loaded. Try again.');
      }
    })();
    olderRequestsRef.current.set(conversationAddress, request);
    try {
      await request;
    } finally {
      olderRequestsRef.current.delete(conversationAddress);
      if (activeConversationAddressRef.current === conversationAddress) setLoadingOlder(false);
    }
  }, [conversationAddress, feedLive, loadTranscriptRange, queryClient, transcriptQueryKey]);
  useEffect(() => {
    if (scrollToTurn === null || handledScrollNonce.current === scrollToTurn.nonce) return;
    // The newest row, as a turn just written usually is, is the end: not
    // `scrollToIndex`, which aimed at the last row lands short of it while
    // the rows above are still estimates.
    if (transcript.at(-1)?.transcriptTurnId === scrollToTurn.turnId) {
      handledScrollNonce.current = scrollToTurn.nonce;
      window.requestAnimationFrame(() => scrollTranscriptToEnd({ smooth: true }));
      return;
    }
    if (revealTurn(scrollToTurn.turnId)) {
      handledScrollNonce.current = scrollToTurn.nonce;
      return;
    }
    // A turn on its way waits for the feed to deliver it.
    if (scrollToTurn.arriving) return;
    // An origin older than the loaded pages: page back toward it. Each page
    // re-runs this, and reaching the oldest page ends the search.
    if (loadingOlder || olderMessagesError || !orderedTranscript.data) return;
    if (!adjacentTranscriptRange(orderedTranscript.data, 'older')) {
      handledScrollNonce.current = scrollToTurn.nonce;
      return;
    }
    void loadOlderMessages();
  }, [loadOlderMessages, loadingOlder, olderMessagesError, orderedTranscript.data, revealTurn, scrollToTurn,
    scrollTranscriptToEnd, transcript]);
  // A turn on its way scrolls only while the reader waits for it: their own
  // input on the transcript drops it. Input, not scroll events, because the
  // virtualizer moves the viewport on its own as rows measure.
  const dropArrivingScroll = (): void => {
    if (scrollToTurn?.arriving) handledScrollNonce.current = scrollToTurn.nonce;
  };

  const nearHistoryEdge = useTranscriptHistory({
    scrollRef: transcriptRef,
    contentRef: transcriptContentRef,
    conversationAddress,
    enabled: payloadBelongsToRoute && positionedConversation === conversationAddress
      && !searchTurnId && olderTranscriptRange !== null,
    canLoad: feedLive && !loadingOlder && !olderMessagesError,
    loadOlder: () => { void loadOlderMessages(); },
  });

  // After the virtualizer and the follow: rows prepended above the reader keep
  // the row they were reading where it was, in the same commit. The layout key
  // names what is drawn above the feed, which a page with no visible rows can
  // change without changing the feed.
  const historyStatusShown = (olderTranscriptRange !== null && !olderMessagesError) || loadingOlder
    || (nearHistoryEdge && !feedLive && !feedFromLocalCache);
  const historyRetryShown = olderTranscriptRange !== null && olderMessagesError !== undefined && !loadingOlder;
  useVirtualScrollAnchor(transcriptVirtualizer, transcriptRef, scrollTranscriptTo, {
    enabled: () => !isFollowingTranscript(),
    layoutKey: `${historyStatusShown}:${historyRetryShown}:${olderMessagesError ?? ''}:${otherHistoryError ?? ''}`,
  });

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    const orderedSnapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      transcriptQueryKey,
    );
    const orderedRange = orderedSnapshot
      ? adjacentTranscriptRange(orderedSnapshot, 'newer')
      : null;
    if (!orderedSnapshot || !orderedRange || loadingNewerRef.current) return;
    if (!feedLive) {
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
      setOtherHistoryError('Newer messages couldn’t be loaded. Try again.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [id, feedLive, loadTranscriptRange, queryClient]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    if (loadingNewerRef.current) return;
    if (!feedLive) {
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
      setOtherHistoryError('The latest messages couldn’t be loaded. Try again.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [id, feedLive, loadTranscriptRange, queryClient, scrollTranscriptToEnd]);

  useEffect(() => {
    if (!feedLive) return;
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
  }, [feedLive, jumpToLatest, loadNewerMessages, loadOlderMessages]);

  // The shell needs to know whether the inspector is still fading out so it
  // reserves the same width for that final frame.
  useLayoutEffect(() => {
    // Only the pane whose panel is fading speaks for the slot.
    if (!railLeaving && useUiStore.getState().railScope !== railScopeKey) return undefined;
    setRailLeaving(railLeaving);
    return () => setRailLeaving(false);
  }, [railLeaving, railScopeKey, setRailLeaving]);

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

  // The room's `resource_updated` brings the new version; the title moves now,
  // unless that event, or somebody else's, already moved the version on.
  const renameResource = useMutation({
    mutationFn: ({ resource, title }: { resource: WorkstreamResource; title: string }) => api!.renameResource(id, resource.id, title),
    onSuccess: (_result, { resource, title }) => {
      queryClient.setQueryData<WorkstreamDetail>(parentDetailQueryKey, (current) => current ? {
        ...current,
        resources: current.resources.map((item) => item.id === resource.id && item.currentVersion === resource.currentVersion
          ? { ...item, title } : item),
      } : current);
    },
  });

  // The rail's detail shows one resource at a time, so its history is fetched
  // for that one rather than for every attachment the work stream carries.
  const inspectedResourceId = resourcePanel ? resourcePanel.resourceId : inspector?.type === 'resource' ? inspector.id : null;
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

  const sidekickRefreshSequence = orderedTranscript.data?.eventSequence;
  useEffect(() => {
    if (parentKind === 'automation') {
      void queryClient.invalidateQueries({ queryKey: ['automation', id] });
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
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
  ) => {
    // Opened from the resource panel's Versions menu, so the way back is that
    // same panel, scoped as it was.
    const current = resourcePanel?.resourceId === resource.id ? resourcePanel : { kind: 'resource' as const, resourceId: resource.id };
    openAttachment({
      resourceId:resource.id,version:version.version,
      // The version's own title and type. A rename is itself what captured the
      // version being opened, so the current name over old bytes would name
      // the wrong thing in the one surface built to keep them apart.
      name: version.title,
      ...(version.mimeType ? { mimeType: version.mimeType } : {}),
      loadContent: (signal?: AbortSignal) => api!.getResourceVersionContent(resource.id, version.version, signal),
      superseded: {
        // Says which version and that it is not the live one, in that order:
        // "of N" alone leaves a reader to work out that V2 of 3 is history.
        label: `Version ${version.version} · not current`,
        onReturnToCurrent: () => openPanel(current),
      },
    });
  }, [api, openAttachment, openPanel, resourcePanel]);

  const activeElicitation = transcript.find((message) =>
    message.messageType === 'elicitation' && message.elicitation?.status === 'open')?.elicitation;

  const answerElicitation = async (
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void> => {
    await answerConversationElicitation({
      queryClient, parentId: id, substreamId, connection: socketConnection, elicitationId, answer, customResponse,
    });
    requestSocketSnapshot();
  };

  const sendMessage = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
    deliveryMode?: WorkstreamMessageDeliveryMode,
  ): Promise<void> => {
    if (!api || !routedDetail) throw new Error('This conversation is not ready to receive messages.');
    if (annotationDraft?.readyPins.length && (sending || activeElicitation)) throw new Error(activeElicitation ? 'Answer the open question before sending artifact comments.' : 'Your artifact comments are still sending.');
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
    const sentPins = await annotationDraft?.prepareSend() ?? [];
    validateAnnotationSend(sentPins, attachmentDraft.ready.length);
    if (sentPins.length && (sending || activeElicitation)) throw new Error(activeElicitation ? 'Answer the open question before sending artifact comments.' : 'Your artifact comments are still sending.');
    if (annotationDraft?.pins.length && !text.trim() && !sentPins.length && !attachmentDraft.ready.length) throw new Error('Reattach a comment before sending it.');
    // Sending is the strongest statement anyone can make that they mean to be
    // at the end: they are about to add to it, and the answer is what they are
    // waiting for. Before the follow could be stopped at all this happened by
    // accident, because the next token re-armed it.
    scrollTranscriptToEnd();
    pendingSendCount.current += 1;
    setSending(true);
    setSendError(undefined);
    if (activeElicitation) {
      // An answer is stored and shown as plain text, not Markdown, so a picked
      // Sidekick goes back to the `@Name` the reader typed.
      const response = manualElicitationResponse(activeElicitation, mentionLinksAsText(text));
      try {
        await answerElicitation(activeElicitation.id, response.answer, response.customResponse);
        // An answer is a message this reader sent, and an elicitation outlives
        // the run that asked it: one still open over a stopped run leaves the
        // acknowledgement up, and this branch returns before the clear below.
        setCarriedStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT);
      } catch (error) {
        setSendError('The response couldn’t be sent. Try again.');
        throw error;
      } finally {
        pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
        if (pendingSendCount.current === 0) setSending(false);
      }
      return;
    }
    const annotationContent = sentPins.length ? { kind: 'artifact_annotations', annotations: sentPins.map((p) => p.annotation), names: Object.fromEntries(sentPins.map((p) => [p.annotation.target.resourceId, p.name])) } : undefined;
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
      const rendered = optimisticMentionRendering(text, mentions, visibleMembers);
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
          fileName: attachment.resource?.title ?? attachment.file.name,
          mimeType: attachment.resource?.mimeType ?? (attachment.file.type || 'application/octet-stream'),
          sizeBytes: attachment.file.size,
          contentAvailable: true,
          createdAt,
        }] : []),
        createdAt,
        annotationContent,
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
        ...(sentPins.length ? { annotations: sentPins.map((p) => p.annotation) } : {}),
        text,
        clientId,
        mentions,
        confirmedParticipantUserIds,
        attachmentIds: [...readyAttachments.flatMap((attachment) => attachment.resource ? [attachment.resource.id] : []), ...sentPins.flatMap((p) => p.annotation.content.imageAttachmentId ? [p.annotation.content.imageAttachmentId] : [])],
        ...(deliveryMode ? { runMode: deliveryMode } : {}),
        ...(messageIntent ? { intent: messageIntent } : {}),
      });
      annotationDraft?.clearAccepted(sentPins);
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
      // Saying the next thing answers the button press more completely than the
      // row does, whether or not this turn starts a run of its own — and a turn
      // the addressing classifier reads as human-only starts none, so waiting
      // for the run to change would leave the row up indefinitely. On
      // acceptance rather than beside the optimistic overlay above, because a
      // send that fails restores the draft and did not move the conversation
      // on: nothing could put the acknowledgement back, the latest run being
      // durably stopped already. The elicitation branch clears it too.
      setCarriedStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT);
      attachmentDraft.commitLease(attachmentLease.leaseId);
      requestSocketSnapshot();
    } catch (error) {
      await attachmentDraft.restoreLease(attachmentLease.leaseId);
      queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(id, substreamId), (current) =>
        removeTranscriptOverlay(current, (overlay) =>
          overlay.identity.type === 'client_message'
          && overlay.identity.clientMessageId === clientId
          && overlay.provenance.source === 'client_command'));
      setSendError('The message couldn’t be sent. Try again.');
      throw error;
    } finally {
      pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
      if (pendingSendCount.current === 0) setSending(false);
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
      const element = transcriptRef.current;
      // A transcript that fits its viewport shows the first unread message
      // and the end at once: there is nowhere to hold the reader, and a
      // released follow would offer Jump to latest with nothing to jump to.
      const fits = element !== null && element.scrollHeight - element.clientHeight < TRANSCRIPT_END_SLACK;
      if (anchorIndex !== null && !fits) {
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
    // A seed's waterlines are what the room said some launches ago; an
    // acknowledgement built on them could read past a mark made since.
    if (feedFromLocalCache) return;
    const detail = queryClient.getQueryData<WorkstreamDetail>(detailQueryKey);
    const element = transcriptRef.current;
    if (!conversationVisibleRef.current || !api || !detail || !element || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (initialPositionedWorkstreamRef.current !== id) return;
    const viewportTop = element.scrollTop;
    const viewportBottom = viewportTop + element.clientHeight;
    const visibleIndexes = transcriptVirtualizer.getVirtualItems()
      .filter((item) => item.start < viewportBottom && item.end > viewportTop)
      .map((item) => item.index);
    // The addressed conversation's own detail entry, so its own waterlines and
    // its own ordinals decide this. A child's are not Main's.
    const highestVisibleSequence = highestVisibleAttentionSequence(
      transcript,
      visibleIndexes,
      detail.latestAttentionSequenceNumber,
    );
    const pending = conversationReadAcknowledgement({
      parentId: id,
      substreamId,
      highestVisibleSequence,
      viewer: detail,
      reportedThisOpen: openReadReport.reported(),
    });
    if (!pending) return;
    if (readAckInFlightRef.current === pending.key) return;
    readAckInFlightRef.current = pending.key;
    openReadReport.markReported();
    void api.acknowledgeConversationRead(
      pending.parentId,
      pending.substreamId,
      pending.readThroughSequenceNumber,
      pending.observedManualUnreadGeneration,
      currentSurfaceEntrypoint(),
    ).then((updated) => {
      if (activeConversationAddressRef.current !== conversationAddress) return;
      // The entry this loop reads back is the addressed one, so it is the one
      // that has to carry the new read waterline or the next scroll re-sends.
      patchCachedWorkstreamViewerState(queryClient, id, updated, substreamId);
    }).catch(() => {
      requestSocketSnapshot();
    }).finally(() => {
      if (readAckInFlightRef.current === pending.key) readAckInFlightRef.current = null;
    });
  }, [api, conversationAddress, detailQueryKey, feedFromLocalCache, id, openReadReport, queryClient, requestSocketSnapshot, substreamId, transcript, transcriptVirtualizer]);

  const scheduleReadAcknowledgement = useVisibleReadAcknowledgement(acknowledgeVisibleMessages);

  // Above the route gate because these are hooks, and the gate returns.
  const showsStoppingRow = routedDetail !== undefined
    && conversationShowsStoppingRow(routedDetail.harnessStatus, routedDetail.stopRequested);
  // The screen stays mounted across a route change, so the next conversation
  // would otherwise open holding this one's acknowledgement. Before paint,
  // like the other route-scoped state above: a passive effect clears it one
  // frame late, and that frame says "Run stopped" in the wrong room.
  useLayoutEffect(() => {
    setCarriedStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT);
  }, [id, substreamId]);
  // Folded in render, not in an effect, and what draws is this value rather
  // than the carry behind it. An effect lands a frame late, and the frame it
  // is late by is the one where the stopping row has gone and the settled row
  // has not arrived — so the live region unmounts and remounts around the very
  // change it exists to announce. The fold is idempotent, so recomputing it
  // from the carry the effect writes back settles immediately.
  const stopAcknowledgement = routedDetail === undefined
    ? carriedStopAcknowledgement
    : nextStopAcknowledgement(
      carriedStopAcknowledgement,
      routedDetail.harnessStatus,
      routedDetail.stopRequested,
      routedDetail.latestHarnessRun,
    );
  useEffect(() => {
    setCarriedStopAcknowledgement((current) =>
      stopAcknowledgement.runId === current.runId
        && stopAcknowledgement.pendingRunId === current.pendingRunId
        ? current
        : stopAcknowledgement);
  }, [stopAcknowledgement]);

  if (!payloadBelongsToRoute || !routedDetail) {
    if (
      socketConnection.state === 'reconnecting'
      || socketConnection.state === 'unavailable'
    ) {
      const errorState = (
        <WorkstreamErrorState
          description={socketConnection.openingError}
          header={stateHeader}
          onRetry={socketConnection.retryOpening}
          parentNoun={parentNoun}
          workstreamId={id}
        />
      );
      return errorState;
    }
    const openingLabel = `Opening ${parentNoun}…`;
    return (
      <ConversationOpeningSkeleton
        label={openingLabel}
        parentKind={parentKind}
      />
    );
  }

  const detail = routedDetail;
  const runTiming = workstreamRunTiming(detail.harnessStatus, detail.latestHarnessRun);
  const orderedOwnsRunTiming = orderedTranscriptOwnsRunTiming(
    orderedTranscript.data,
    detail.latestHarnessRunId ?? detail.latestHarnessRun?.id,
  );
  const activityRow = conversationActivityRow({
    status: detail.harnessStatus,
    // A compaction has to be running AND belong to the run on screen. Reading
    // the id straight off `activeCompaction` would compare `undefined` with the
    // id of a run that has none either, and a room with no run at all would
    // report itself compacting. `!= null` rather than `!== null`, because the
    // absent value here is sometimes `undefined`: the type says
    // `AgentCompactionState | null`, but a connection double that names only
    // the fields its test drives leaves the key off entirely. It narrows too,
    // which `Boolean(…)` did not, so the read below needs no `?.`.
    compactingThisRun: socketConnection.activeCompaction != null
      && socketConnection.activeCompaction.harnessRunId
        === (detail.latestHarnessRunId ?? detail.latestHarnessRun?.id),
    orderedOwnsRunTiming,
    runTiming,
  });
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
      visibleMembers,
      presenceUserIdsByWorkstream[id] ?? [],
    ),
  };
  const discoveredResources = [...new Map(
    (availableResources.data?.pages.flatMap((page) => page.items) ?? []).map((resource) => [resource.id, resource]),
  ).values()];
  // A persisted run result is an intentional user-facing product record, not a
  // caught transport exception. Its notice pairs the text with a stable code
  // and request id so support can identify the failed run.
  // eslint-disable-next-line rally/no-diagnostic-message-in-presentation
  const latestRunFailureMessage = detail.latestHarnessRun?.error?.message
    ?? 'Rally could not complete this run. Retrying is unlikely to help — copy the request ID for support.';

  const issueSubstreamId = SubstreamIdSchema.safeParse(substreamId).data;
  return (
    <MessageIssueProvider api={api} target={issueSubstreamId ? { kind: 'conversation', parentId: id, substreamId: issueSubstreamId } : null}>
    <EmailMentionContext.Provider value={emailMentions}>
    <ConnectorConnectionsProvider connections={visibleConnections}>
    <div className="conversation-layout" ref={layoutRef}>
    <div className={clsx(
      'workstream-screen has-message-capsule',
      parentKind === 'automation' && 'automation-screen',
    )}>
      {renderHeader?.({
        detail: displayedDetail,
        socketState,
        presentUserIds: presenceUserIdsByWorkstream[id] ?? [],
        openResource: openResourceDetails,
        openRail: openOwnRail,
        openArtifact: citations.openPreview,
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
          dropArrivingScroll();
          onTranscriptWheel(event.currentTarget, event.deltaY);
        }}
        onTouchMove={dropArrivingScroll}
        // On the container itself is its scrollbar; on a message is a click.
        onPointerDown={(event) => { if (event.target === event.currentTarget) dropArrivingScroll(); }}
        onKeyDown={(event) => { if (TRANSCRIPT_SCROLL_KEYS.has(event.key)) dropArrivingScroll(); }}
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
        <ConnectingCardSlot>
          {feedFromLocalCache && (
            <ConnectingCard
              detail="Sending is available once Rally connects"
              error={socketConnection.openingError}
              name={conversationName ?? (detail.titleStatus === 'naming' ? null : detail.title)}
              onRetry={socketConnection.retryOpening}
              state={socketConnection.openingError
                ? 'failed'
                : socketState === 'unavailable' ? 'offline' : 'connecting'}
              subject={parentKind === 'automation' ? 'Sidekick' : 'Canvas'}
            />
          )}
        </ConnectingCardSlot>
        <div className="transcript-column" ref={transcriptContentRef}>
          {/* Over a seed the connecting card, sticky at this same edge, is the
              affordance: a row here would sit under it saying the same thing.
              Its space is held for as long as there is history to load, so the
              status coming and going never moves the messages under it. */}
          <div role="status" className={historyStatusShown ? 'transcript-history-control' : undefined}>
            {(loadingOlder || (nearHistoryEdge && !feedLive && !feedFromLocalCache)) && (
              <TranscriptHistoryStatus live={feedLive} onReconnect={socketConnection.retryOpening} />
            )}
          </div>
          {historyRetryShown && (
            <div className="transcript-history-control">
              <Button onClick={() => feedLive ? void loadOlderMessages() : socketConnection.retryOpening()}>
                <RefreshCcw aria-hidden="true" size={14} />
                {feedLive ? 'Retry loading earlier messages' : 'Reconnect now'}
              </Button>
            </div>
          )}
          {olderMessagesError && <ErrorNotice>{olderMessagesError}</ErrorNotice>}
          {otherHistoryError && <ErrorNotice>{otherHistoryError}</ErrorNotice>}
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
                : 'Ask Rally for what you want to make. Everyone in this Canvas sees the conversation.'}
            />
          ) : (
            <MessageFeed
              connectorConnectionCards
              citations={citations}
              currentUserId={session?.user.id}
              currentUserName={session?.user.name}
              firstUnreadIndex={firstUnreadIndex}
              loadAttachmentContent={loadAttachmentContent}
              messages={visibleTranscript}
              liveMessageIds={liveMessageIds}
              onAnswerElicitation={answerElicitation}
              onOpenAttachment={openAttachment}
              {...(api ? { onAcceptDraft: (automationId: string) => {
                acceptProposedAutomation.mutate(automationId);
              } } : {})}
              acceptingDraftFor={acceptProposedAutomation.isPending
                ? acceptProposedAutomation.variables ?? null
                : null}
              acceptDraftFailureFor={acceptProposedAutomation.error
                ? acceptProposedAutomation.variables ?? null
                : null}
              virtualizer={transcriptVirtualizer}
            />
          )}
          {detail.harnessStatus === 'running'
            && socketConnection.activeInferenceDelays.some((delay) => delay.harnessRunId === detail.latestHarnessRunId)
            && <InferenceDelayNotice />}
          <ActivityPresence>{activityRow?.kind === 'compacting'
            ? <AgentCompactionIndicator />
            : activityRow?.kind === 'timing'
              && <AgentWorkTiming key={detail.latestHarnessRunId ?? detail.latestHarnessRun?.id} {...activityRow.timing} />}</ActivityPresence>
          {detail.harnessStatus === 'failed' && detail.latestHarnessRun?.status === 'failed' && (
            <RunFailureNotice
              automatic={observedActiveRun.current === detail.latestHarnessRun.id}
              code={detail.latestHarnessRun.error?.code ?? 'harness_execution_failed'}
              message={latestRunFailureMessage}
              onRetry={() => retry.mutate()}
              requestId={detail.latestHarnessRun.requestId ?? detail.latestHarnessRun.id}
              retrying={retry.isPending}
            />
          )}
        </div>
      </div>

      <div className="composer-dock">
        <JumpToLatestButton onJump={() => void jumpToLatest()} visible={!transcriptAtEnd} />
        <div className="composer-stack">
          {/* First in the stack, so it reads as a line above the field rather
              than as something the field is sitting on. The stack is a grid
              with its own gap, so it needs no spacing of its own. */}
          {/* One region, mounted from the request through to the outcome, so
              the settled line is a content change inside a live region rather
              than a freshly inserted one. The arming holds it up through the
              window where the status frame has ended the wait and the run row
              has not yet said whether it was a stop — a window this dock used
              to go blank in, and one a member stop always passes through. Say
              the wait is still on until the evidence lands, because it is. */}
          {(showsStoppingRow
            || stopAcknowledgement.pendingRunId !== null
            || stopAcknowledgement.runId !== null)
            && <RunStopAcknowledgement settled={stopAcknowledgement.runId !== null} />}
          {/* Over the composer rather than inside it: the capsule's grid has
              no row for a line of its own. */}
          {!withoutComposer && composerNotice && <div className="composer-mode-notice">{composerNotice}</div>}
          {!withoutComposer && <WorkstreamComposer
            {...(onComposerCancel ? { onCancel: onComposerCancel } : {})}
            api={api ?? undefined}
            placeholder={composerPlaceholder ?? (parentKind === 'automation'
              ? 'Ask your Sidekick…'
              : 'Ask Rally or the people here…')}
            attachments={attachmentDraft.attachments}
            error={sendError
              ?? attachmentDraft.error
              ?? (attachResource.error ? 'The resource couldn’t be added.' : undefined)
              ?? (stop.error ? 'The run couldn’t be stopped.' : undefined)
              ?? (retry.error ? 'The run couldn’t be retried.' : undefined)}
            errorTitle={sendError === MESSAGE_TOO_LONG_MESSAGE ? 'Message too long' : undefined}
            fileInputRef={fileInputRef}
            members={visibleMembers}
            /* Locked, because a pin is written once when the conversation is
               created and nothing afterwards edits it. What it names is the
               latest run's model first and the pin only as a fallback: an
               unpinned conversation is nearly all of them and only its run can
               say what the flag served, while a pinned one whose run failed
               before its first token records nothing and would otherwise read
               as following a flag it never consults. */
            model={{
              kind: 'settled',
              model: displayedDetail.latestHarnessRun?.model ?? displayedDetail.modelOverride ?? null,
              pinned: (displayedDetail.modelOverride ?? null) !== null,
            }}
            onAttach={attachmentDraft.addFiles}
            onOpenAttachment={openAttachment}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSend={sendMessage}
            onStop={async () => {
              await stop.mutateAsync();
            }}
            sendBlocked={feedFromLocalCache}
            sending={sending}
            uploading={attachmentDraft.uploading}
            key={conversationAddress}
            workstream={displayedDetail}
            draftKey={conversationDraftKey(workspaceRegion, workspaceId, parentKind, displayedDetail.id, substreamId)}
            {...(hostMenuActions ? { menuActions: hostMenuActions } : {})}
          />}
        </div>
      </div>

      {railVariant === 'context' && resourcePanel && (railOpen || railLeaving) && <InspectorRail
        panel={{
          resourceId: resourcePanel.resourceId,
          onClose: closeOwnRail,
          expandAction: panelExpandAction,
          ancestors: panelAncestors,
        }}
        dropTarget={railDrop}
        {...(api ? { loadResourceContent, loadOriginalResourceContent } : {})}
        failure={watchResource.error
          ? 'watch'
          : detachResource.error
            ? 'detach'
            : refreshResource.error
              ? 'refresh'
              : attachResource.error ? 'attach' : undefined}
        leaving={railLeaving}
        {...(substreamId === '0' ? {
          onAddResource: () => setResourceDialogOpen(true),
          onDetachResource: (resource: WorkstreamResource) => detachResource.mutateAsync(resource),
          onRefreshResource: (resource: WorkstreamResource) => refreshResource.mutate(resource),
          onToggleWatch: (resource: WorkstreamResource, enabled: boolean) => watchResource.mutate({ resource, enabled }),
        } : {})}
        onOpenResourceVersion={openResourceVersion}
        {...(api && isGeneratedArtifact(resourcePanel.resourceId) ? {
          onRenameResource: (resource: WorkstreamResource, title: string) => renameResource.mutateAsync({ resource, title }),
        } : {})}
        refreshingResourceId={refreshResource.isPending ? refreshResource.variables?.id ?? null : null}
        resourceVersions={resourceVersions.data}
        resourceVersionsFailed={Boolean(resourceVersions.error)}
        {...(siteArtifacts ? { siteArtifacts } : {})}
        workstream={displayedDetail}
      />}

      {railVariant === 'browser' && (railOpen || railLeaving) && window.rally && <EmbeddedBrowserRail
        leaving={railLeaving}
        onClose={panel ? () => setRailVariant('context') : closeOwnRail}
        onResize={setRailWidth}
        width={railWidth}
      />}

      {railVariant === 'context' && panel?.kind === 'attachment' && (railOpen || railLeaving) && <AttachmentPanel
        leaving={railLeaving}
        ancestors={panelAncestors}
        expandAction={panelExpandAction}
        onClose={closeOwnRail}
        onResize={setRailWidth}
        preview={panel.preview}
        width={railWidth}
      />}

      <AddResourceDialog
        incomplete={availableResources.data?.pages.some((page) => page.complete === false) ?? false}
        onRetry={() => { void availableResources.refetch(); }}
        current={displayedDetail.resources}
        failure={availableResources.error ? 'load' : attachResource.error ? 'attach' : undefined}
        fetching={availableResources.isFetchingNextPage}
        hasMore={Boolean(availableResources.hasNextPage)}
        loading={availableResources.isLoading}
        onAttach={(resource) => attachResource.mutate(resource, {
          onSuccess: () => {
            setResourceDialogOpen(false);
            setResourceSearch('');
          },
        })}
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
        uploadLabel="Upload file"
        open={resourceDialogOpen}
        pending={attachResource.isPending}
        resources={discoveredResources}
        search={resourceSearch}
      />
    </div>
    </div>
    </ConnectorConnectionsProvider>
    </EmailMentionContext.Provider>
    </MessageIssueProvider>
  );
}
