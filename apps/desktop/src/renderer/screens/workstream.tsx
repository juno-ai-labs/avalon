import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconAugmentedReality } from '@tabler/icons-react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
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
import { WORKSTREAM_NAMING_GRACE_MS } from '@avalon/contracts';
import { workstreamCanonicalUrl } from '@avalon/contracts/workstream-links';
import type { DesktopSession } from '../../common/desktop';
import { useAppSession } from '../lib/app-session';
import { ApiError, messagesWithTransientBlocks, type MentionIdentity } from '../lib/api';
import { answerElicitationOptimistically } from '../lib/elicitation';
import { formatDateTime } from '../lib/format';
import { workstreamDraftKey } from '../lib/draft-keys';
import { desktopBridge } from '../lib/platform';
import {
  appendDismissedSuggestionId,
  createTextMessage,
  dismissedSuggestionIdsQueryKey,
  removeTranscriptMessage,
  visibleTranscriptMessages,
} from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useFileDrop } from '../lib/use-file-drop';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { useTextClipped } from '../lib/use-text-clipped';
import { type RailPanel, type RailVariant, useUiStore } from '../lib/ui-store';
import {
  insertMessage,
  nextTranscriptSequence,
  reconcileCanonicalTranscript,
  useWorkstreamSocket,
} from '../lib/use-workstream-socket';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import type { ElicitationData, HarnessRunMetadata, HarnessStatus, HyperSight, HyperSightPreference, Message, WorkspaceMember, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { AgentWorkTiming, type AgentWorkTimingProps } from '../components/agent-work-timing';
import { InspectorRail } from '../components/inspector-rail';
import { type AttachmentPreview, AttachmentLightbox } from '../components/attachments';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, OpeningState, SocketStatusIndicator, StatusDot, TitleSkeleton } from '../components/primitives';
import { MessageBlock, type SystemRowDisclosure } from '../components/workstream-blocks';
import { WorkstreamComposer } from '../components/workstream-composer';
import { HyperSightPanel, HyperSightRail } from '../components/hypersight-panel';
import { useRailCrossFade } from '../components/rail-surface';

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

/**
 * Which panel holds the right sidebar. The inspector rail's open state is local
 * and immediate, while HyperSight's is a preference write that can fail and roll
 * back, so the rail holds the slot until that write settles: a failed write can
 * leave the stored preference disagreeing with the screen, never two panels
 * stacked in one slot with both controls reading as open.
 */
export function hypersightHoldsSidebar(preferenceVisible: boolean, railOpen: boolean): boolean {
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

function AddParticipantDialog({
  current,
  members,
  open,
  pending,
  onAdd,
  onOpenChange,
}: {
  current: WorkspaceMember[];
  members: WorkspaceMember[];
  open: boolean;
  pending: boolean;
  onAdd: (member: WorkspaceMember) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const currentIds = new Set(current.map((member) => member.id));
  const available = members.filter((member) => !currentIds.has(member.id));
  return (
    <Modal
      description="Opening or viewing never adds someone as a participant. Add them explicitly here."
      onOpenChange={onOpenChange}
      open={open}
      title="Add a participant"
    >
      {available.length === 0 ? (
        <EmptyState title="Everyone is already here" description="There are no other workspace members to add." />
      ) : (
        <div className="member-action-list">
          {available.map((member) => (
            <button disabled={pending} key={member.id} onClick={() => onAdd(member)} type="button">
              <Avatar member={member} size="medium" />
              <span><strong>{member.name}</strong><small>{member.email}</small></span>
              {pending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            </button>
          ))}
        </div>
      )}
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
                  <small>{readableResourceKind(resource.provider ?? 'Avalon')} · {readableResourceKind(resource.resourceType)}</small>
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

/**
 * Whether to hold this work stream's title for a name that is still coming.
 *
 * `titleStatus` alone is not enough here. The API stops reporting `naming` past
 * the grace, but that only applies to a read, and this query has no refetch of
 * its own — so a client that was already connected when the rename event failed
 * to reach it would keep a `naming` row, and the skeleton, for the session. The
 * same rule applied to what the client already holds closes that: past the
 * grace the provisional title is the title, whatever the row still says.
 */
function useNamingSkeleton(workstream: WorkstreamDetail): boolean {
  const naming = workstream.titleStatus === 'naming';
  const createdAt = Date.parse(workstream.createdAt);
  const expiresAt = naming && Number.isFinite(createdAt)
    ? createdAt + WORKSTREAM_NAMING_GRACE_MS
    : null;
  const [expired, setExpired] = useState(() => expiresAt !== null && Date.now() >= expiresAt);

  useEffect(() => {
    if (expiresAt === null) return undefined;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return undefined;
    }
    // The name almost always arrives long before this fires; the timer exists
    // for the case where nothing arrives at all.
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return naming && !expired;
}

const RENAME_HINT = 'Double-click to rename';

export function WorkstreamHeader({
  workstream,
  socketState,
  hypersightOpen,
  hypersightPreferencePending,
  onAddParticipant,
  onOpenRail,
  onRename,
  onToggleHyperSight,
}: {
  workstream: WorkstreamDetail;
  socketState: ReturnType<typeof useWorkstreamSocket>;
  hypersightOpen: boolean;
  hypersightPreferencePending: boolean;
  onAddParticipant: () => void;
  onOpenRail: (variant: RailVariant) => void;
  onRename: (title: string) => Promise<void>;
  onToggleHyperSight: () => void;
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
  // Copy the canonical HTTPS link, not the `avalon://` deep link. A copied link
  // is going somewhere else — Slack, mail, a Linear comment — where an unknown
  // scheme does not unfurl, often does not linkify, and is dead for anyone who
  // has not installed Avalon. The canonical link ends at the same work stream.
  const copyLink = (): void => {
    void (async () => {
      const bridge = desktopBridge();
      const { webBaseUrl } = await bridge.getRuntimeConfig();
      await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, workstream.id));
    })();
  };
  const copyEmailAddress = (): void => {
    if (workstream.emailAddress) void desktopBridge().copyText(workstream.emailAddress);
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
          <AvatarStack members={workstream.participants} />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>
        {/* The two controls that own the right sidebar sit side by side, in the
            order the panels themselves are named. */}
        <IconButton
          className={clsx('panel-toggle', 'hypersight-toggle', hypersightOpen && 'is-active')}
          aria-pressed={hypersightOpen}
          disabled={hypersightPreferencePending}
          label={hypersightOpen ? 'Hide HyperSight' : 'Show HyperSight'}
          onClick={onToggleHyperSight}
        >
          <IconAugmentedReality size={16} stroke={1.7} />
        </IconButton>
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
              <DropdownMenu.Item className="menu-item" onSelect={() => void desktopBridge().copyText(workstream.id)}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>
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
  return (
    <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="screen-state-actions window-no-drag">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              <DropdownMenu.Item className="menu-item" onSelect={() => void desktopBridge().copyText(workstreamId)}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>
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

export function JumpToLatestButton({ onJump }: { onJump: () => void }): React.JSX.Element {
  return (
    <IconButton className="jump-bottom" label="Jump to latest" onClick={onJump} tooltipSide="top">
      <ArrowDown aria-hidden="true" size={15} />
    </IconButton>
  );
}

export function initialTranscriptAnchorIndex(
  transcript: Message[],
  firstUnreadSequenceNumber: number | null,
): number | null {
  if (firstUnreadSequenceNumber === null) return null;
  const firstUnreadIndex = transcript.findIndex((message) =>
    message.realtimeOrder === undefined && message.sequenceNumber >= firstUnreadSequenceNumber);
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
      || message.sequenceNumber > latestAttentionSequenceNumber
    ) return highest;
    return Math.max(highest, message.sequenceNumber);
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

export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { api, session } = useAppSession();
  const queryClient = useQueryClient();
  const closeRail = useUiStore((state) => state.closeRail);
  const openRail = useUiStore((state) => state.openRail);
  const railOpen = useUiStore((state) => state.railOpen);
  const setHyperSightOpen = useUiStore((state) => state.setHyperSightOpen);
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
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | undefined>();
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
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
    (resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal),
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

  const workstream = useQuery({
    queryKey: ['workstream', id],
    queryFn: ({ signal }) => api!.getWorkstream(id, signal),
    enabled: Boolean(api && id),
    staleTime: 5_000,
  });
  const messageCursor = useQuery<string | null>({
    queryKey: ['messages-cursor', id],
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const newerMessageCursor = useQuery<string | null>({
    queryKey: ['messages-newer-cursor', id],
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: async ({ signal }) => {
      const detail = await queryClient.fetchQuery({
        queryKey: ['workstream', id],
        queryFn: ({ signal: detailSignal }) => api!.getWorkstream(id, detailSignal),
        staleTime: 5_000,
      });
      const page = await api!.getMessagePage(id, {
        ...(detail.firstUnreadSequenceNumber !== null
          ? { around: detail.firstUnreadSequenceNumber }
          : {}),
        signal,
      });
      const previous = queryClient.getQueryData<Message[]>(['messages', id]);
      const pageOldestSequence = page.items.reduce(
        (oldest, message) => Math.min(oldest, message.sequenceNumber),
        Number.POSITIVE_INFINITY,
      );
      const alreadyHasOlderMessages = (previous ?? []).some((message) =>
        message.realtimeOrder === undefined && message.sequenceNumber < pageOldestSequence);
      if (!alreadyHasOlderMessages) {
        queryClient.setQueryData(['messages-cursor', id], page.nextCursor);
      }
      queryClient.setQueryData(['messages-newer-cursor', id], page.newerCursor);
      const canonicalMessages = messagesWithTransientBlocks(
        page.items,
        detail,
        queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id)),
      );
      return reconcileCanonicalTranscript(previous, canonicalMessages, detail.harnessStatus);
    },
    enabled: Boolean(api && id),
    staleTime: 2_000,
  });
  const deferredContext = useQuery({
    queryKey: ['workstream-context', id, workstream.data?.automationSubscriptionId ?? null],
    queryFn: ({ signal }) => api!.getWorkstreamContext(id, workstream.data?.automationSubscriptionId, signal),
    enabled: Boolean(api && id && workstream.isSuccess && messages.isSuccess),
    staleTime: 5_000,
  });
  const hypersightPreference = useQuery({
    queryKey: ['hypersight-preference', id],
    queryFn: ({ signal }) => api!.getHyperSightPreference(id, signal),
    enabled: Boolean(api && id),
    staleTime: 5_000,
  });
  const hypersightPreferred = hypersightPreference.data?.visible ?? false;
  const hypersightOpen = hypersightHoldsSidebar(hypersightPreferred, railOpen);
  // Handing the sidebar from one panel to the other keeps the panel that lost
  // it on screen a moment longer, fading out over the one that took it while
  // the slot animates between their two widths.
  const railLeaving = useRailCrossFade<RailPanel>(hypersightOpen ? 'hypersight' : railOpen ? 'inspector' : null);
  const hypersight = useQuery({
    queryKey: ['hypersight', id],
    queryFn: ({ signal }) => api!.getHyperSight(id, signal),
    enabled: Boolean(api && id && hypersightOpen),
    staleTime: 5_000,
  });
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
  const socketState = useWorkstreamSocket(
    api,
    id,
    workstream.isSuccess && messages.isSuccess,
  );
  const transcript = messages.data ?? [];
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

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const before = queryClient.getQueryData<string | null>(['messages-cursor', id]);
    if (!api || !before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderMessagesError(undefined);
    const scrollElement = transcriptRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    const previousScrollTop = scrollElement?.scrollTop ?? 0;
    try {
      const page = await api.getMessagePage(id, { before });
      if (activeWorkstreamIdRef.current !== id) return;
      if (page.nextCursor === before) throw new Error('Avalon received a repeated transcript cursor.');
      const visibleItems = visibleTranscriptMessages(
        page.items,
        queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id)),
      );
      queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        visibleItems.reduce((merged, message) => insertMessage(merged, message), current ?? []));
      queryClient.setQueryData(['messages-cursor', id], page.nextCursor);
      window.requestAnimationFrame(() => {
        const element = transcriptRef.current;
        if (!element) return;
        element.scrollTop = previousScrollTop + Math.max(0, element.scrollHeight - previousScrollHeight);
      });
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'Earlier messages could not be loaded.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [api, id, queryClient]);

  const loadNewerMessages = useCallback(async (): Promise<void> => {
    const after = queryClient.getQueryData<string | null>(['messages-newer-cursor', id]);
    if (!api || !after || loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      const page = await api.getMessagePage(id, { after });
      if (activeWorkstreamIdRef.current !== id) return;
      if (page.newerCursor === after) throw new Error('Avalon received a repeated transcript cursor.');
      const visibleItems = visibleTranscriptMessages(
        page.items,
        queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id)),
      );
      queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        visibleItems.reduce((merged, message) => insertMessage(merged, message), current ?? []));
      queryClient.setQueryData(['messages-newer-cursor', id], page.newerCursor);
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'Newer messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [api, id, queryClient]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    if (!api || loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setOlderMessagesError(undefined);
    try {
      let after = queryClient.getQueryData<string | null>(['messages-newer-cursor', id]);
      while (after) {
        const page = await api.getMessagePage(id, { after });
        if (activeWorkstreamIdRef.current !== id) return;
        if (page.newerCursor === after) throw new Error('Avalon received a repeated transcript cursor.');
        const visibleItems = visibleTranscriptMessages(
          page.items,
          queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id)),
        );
        queryClient.setQueryData<Message[]>(['messages', id], (current) =>
          visibleItems.reduce((merged, message) => insertMessage(merged, message), current ?? []));
        after = page.newerCursor;
        queryClient.setQueryData(['messages-newer-cursor', id], after);
      }
      setAtBottom(true);
      window.requestAnimationFrame(() => {
        const current = queryClient.getQueryData<Message[]>(['messages', id]) ?? [];
        transcriptVirtualizer.scrollToIndex(Math.max(0, current.length - 1), { align: 'end', behavior: 'smooth' });
      });
    } catch (error) {
      setOlderMessagesError(error instanceof Error ? error.message : 'The latest messages could not be loaded.');
    } finally {
      loadingNewerRef.current = false;
    }
  }, [api, id, queryClient, transcriptVirtualizer]);

  const addParticipant = useMutation({
    mutationFn: (member: WorkspaceMember) => api!.addParticipant(id, member.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workstream', id], updated);
      setParticipantDialogOpen(false);
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

  const updateHyperSight = useMutation({
    mutationFn: (blocks: Array<{ id: string; prompt: string }>) => {
      const current = queryClient.getQueryData<HyperSight>(['hypersight', id]) ?? hypersight.data;
      if (!current) throw new Error('HyperSight is not ready yet.');
      return api!.updateHyperSight(id, {
        expectedVersionNumber: current.versionNumber,
        blocks,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['hypersight', id], updated);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['hypersight', id], exact: true });
    },
  });

  const updateHyperSightPreference = useMutation({
    mutationFn: (visible: boolean) => api!.updateHyperSightPreference(id, visible),
    onMutate: async (visible) => {
      await queryClient.cancelQueries({ queryKey: ['hypersight-preference', id], exact: true });
      const previous = queryClient.getQueryData<HyperSightPreference>(['hypersight-preference', id]);
      queryClient.setQueryData<HyperSightPreference>(['hypersight-preference', id], {
        visible,
        updatedAt: previous?.updatedAt ?? null,
      });
      return { previous };
    },
    onError: (_error, _visible, context) => {
      queryClient.setQueryData(['hypersight-preference', id], context?.previous);
    },
    onSuccess: (preference) => {
      queryClient.setQueryData(['hypersight-preference', id], preference);
    },
  });
  const { mutate: persistHyperSightPreference } = updateHyperSightPreference;

  // HyperSight and the inspector rail share the right sidebar and are never
  // open together. HyperSight's visibility is a stored personal preference
  // rather than window state, so yielding the sidebar to the rail is written
  // back the same way the toggle is: the next visit opens where this one left
  // off.
  const setHyperSightVisible = useCallback((visible: boolean): void => {
    if (visible) closeRail();
    persistHyperSightPreference(visible);
  }, [closeRail, persistHyperSightPreference]);

  const openRailVariant = useCallback((variant: RailVariant): void => {
    openRail(variant);
    if (hypersightPreferred) persistHyperSightPreference(false);
  }, [hypersightPreferred, openRail, persistHyperSightPreference]);

  // The shell lays the main pane out against whichever panel holds the right
  // sidebar, and only this screen knows whether HyperSight has it — or which
  // panel is still fading out of it.
  useEffect(() => {
    setHyperSightOpen(hypersightOpen);
  }, [hypersightOpen, setHyperSightOpen]);
  useEffect(() => {
    setRailLeaving(railLeaving);
    return () => setRailLeaving(null);
  }, [railLeaving, setRailLeaving]);
  useEffect(() => () => setHyperSightOpen(false), [setHyperSightOpen]);

  const stop = useMutation({
    mutationFn: () => api!.stopHarness(id),
    onSuccess: () => void Promise.all([
      workstream.refetch(),
      queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
    ]),
  });

  const retry = useMutation({
    mutationFn: () => api!.retryHarness(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
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

  const activeElicitation = (messages.data ?? []).find((message) =>
    message.messageType === 'elicitation' && message.elicitation?.status === 'open')?.elicitation;

  const answerElicitation = async (
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void> => {
    const previousMessage = queryClient.getQueryData<Message[]>(['messages', id])?.find((message) =>
      message.messageType === 'elicitation' && message.elicitation?.id === elicitationId);
    await answerElicitationOptimistically({
      answer,
      elicitationId,
      previousMessage,
      submit: async () => {
        await api!.answerElicitation(id, elicitationId, answer, customResponse);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
          queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
          queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
        ]);
      },
      updateMessages: (update) => queryClient.setQueryData<Message[]>(['messages', id], (current) =>
        current ? update(current) : current),
    });
  };

  const sendMessage = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
  ): Promise<void> => {
    if (!api || !workstream.data) throw new Error('This work stream is not ready to receive messages.');
    const readyAttachments = attachmentDraft.ready;
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
    const clientId = crypto.randomUUID();
    queryClient.setQueryData<Message[]>(['messages', id], (current) => {
      const anchorSequenceNumber = nextTranscriptSequence(current);
      const createdAt = new Date().toISOString();
      const optimistic = createTextMessage({
        id: clientId,
        clientMessageId: clientId,
        workstreamId: id,
        sequenceNumber: anchorSequenceNumber,
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
        realtimeOrder: {
          anchorSequenceNumber,
          eventSequence: Number.MAX_SAFE_INTEGER,
          placement: 'at_anchor',
        },
      });
      return insertMessage(current, optimistic);
    });
    try {
      const created = await api.createMessage(id, {
        text,
        clientId,
        mentions,
        confirmedParticipantUserIds,
        attachmentIds: readyAttachments.flatMap((attachment) => attachment.resource ? [attachment.resource.id] : []),
      });
      queryClient.setQueryData<Message[]>(['messages', id], (current) => insertMessage(current, created));
      attachmentDraft.consume();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['messages', id], exact: true }),
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', id] }),
      ]);
    } catch (error) {
      queryClient.setQueryData<Message[]>(['messages', id], (current) => (current ?? []).filter((message) => message.id !== clientId));
      setSendError(error instanceof Error ? error.message : 'The message could not be sent.');
      throw error;
    } finally {
      pendingSendCount.current = Math.max(0, pendingSendCount.current - 1);
      if (pendingSendCount.current === 0) setSending(false);
    }
  };

  const resolveSuggestion = async (suggestionId: string, action: 'accept' | 'dismiss'): Promise<void> => {
    // The transcript's suggestion cards are rebuilt from the detail's pending
    // suggestions every time the message page is fetched, and that fetch reads
    // the detail through the cache. Dropping the suggestion before the request
    // rather than after also covers a rebuild that lands while the request is
    // still in flight, which would otherwise restore the card to its pending
    // state and offer buttons whose request can only fail.
    const pending = queryClient.getQueryData<WorkstreamDetail>(['workstream', id])
      ?.suggestions?.find((suggestion) => suggestion.id === suggestionId);
    queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current
      ? { ...current, suggestions: (current.suggestions ?? []).filter((suggestion) => suggestion.id !== suggestionId) }
      : current);
    try {
      await api!.resolveActivitySuggestion(id, suggestionId, action);
      // A disconnected socket cannot deliver the resolved event that normally
      // removes a dismissal from the feed. Apply the successful decision here
      // too so the card does not survive while an active run makes transcript
      // reconciliation retain newer realtime rows.
      if (action === 'dismiss') {
        queryClient.setQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(id), (current) =>
          appendDismissedSuggestionId(current, suggestionId));
        queryClient.setQueryData<Message[]>(['messages', id], (current) =>
          removeTranscriptMessage(current, `suggestion-${suggestionId}`));
      }
    } catch (error) {
      // 404 and 409 both mean the server no longer holds this suggestion open,
      // so its card must not return offering buttons over a decision already
      // made — the very thing this is here to stop. Every other failure left
      // the suggestion pending, and its card has to come back to carry the
      // error. Restore only this suggestion, so a detail update that landed
      // while the request was in flight survives.
      const status = error instanceof ApiError ? error.status : 0;
      if (pending && status !== 404 && status !== 409) {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) => current
          && !(current.suggestions ?? []).some((suggestion) => suggestion.id === suggestionId)
          ? { ...current, suggestions: [...(current.suggestions ?? []), pending] }
          : current);
      } else {
        void workstream.refetch();
      }
      throw error;
    }
    await Promise.all([messages.refetch(), workstream.refetch()]);
  };

  useEffect(() => {
    if (!workstream.data || messages.isLoading || initialPositionedWorkstreamRef.current === id) return;
    initialPositionedWorkstreamRef.current = id;
    const anchorSequence = workstream.data.firstUnreadSequenceNumber;
    window.requestAnimationFrame(() => {
      if (activeWorkstreamIdRef.current !== id || transcript.length === 0) return;
      const anchorIndex = initialTranscriptAnchorIndex(transcript, anchorSequence);
      if (anchorIndex !== null) {
        setAtBottom(false);
        transcriptVirtualizer.scrollToIndex(anchorIndex, { align: 'start' });
        return;
      }
      setAtBottom(true);
      transcriptVirtualizer.scrollToIndex(transcript.length - 1, { align: 'end' });
    });
  }, [id, messages.isLoading, transcript, transcriptVirtualizer, workstream.data]);

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
    ).then((updated) => {
      if (activeWorkstreamIdRef.current !== id) return;
      queryClient.setQueryData<WorkstreamDetail>(['workstream', id], (current) =>
        current ? { ...current, ...updated } : current);
      setCachedWorkstreams(queryClient, (current) =>
        current?.map((item) => item.id === id ? { ...item, ...updated } : item));
    }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: ['workstream', id], exact: true });
    }).finally(() => {
      if (readAckInFlightRef.current === ackKey) readAckInFlightRef.current = null;
    });
  }, [api, id, queryClient, transcript, transcriptVirtualizer]);

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

  useEffect(() => {
    if (initialPositionedWorkstreamRef.current !== id || !atBottom || newerMessageCursor.data) return;
    if (transcript.length === 0) return;
    requestAnimationFrame(() => transcriptVirtualizer.scrollToIndex(transcript.length - 1, { align: 'end' }));
  }, [atBottom, id, newerMessageCursor.data, transcript, transcriptVirtualizer]);

  if (workstream.isLoading || messages.isLoading) {
    return <OpeningState label="Opening work stream…" />;
  }
  if (workstream.error || messages.error || !workstream.data) {
    return (
      <WorkstreamErrorState
        description={workstream.error?.message ?? messages.error?.message ?? 'This work stream is unavailable.'}
        onRetry={() => void Promise.all([workstream.refetch(), messages.refetch()])}
        workstreamId={id}
      />
    );
  }

  const detail = workstream.data;
  const runTiming = workstreamRunTiming(detail.harnessStatus, detail.latestHarnessRun);
  const visibleTranscript = transcript;
  const firstUnreadSequenceNumber = detail.firstUnreadSequenceNumber;
  const firstUnreadIndex = firstUnreadSequenceNumber === null
    ? -1
    : visibleTranscript.findIndex((message) =>
      message.realtimeOrder === undefined && message.sequenceNumber >= firstUnreadSequenceNumber);
  const displayedDetail: WorkstreamDetail = {
    ...detail,
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
      {/* The HyperSight control is disabled only while the stored preference is
          still unknown. Disabling it for the write as well would blur it
          mid-click — Chromium blurs a focused element as it is disabled — so
          the sidebar would capture the body rather than the toggle and have
          nothing to hand focus back to when it closes. The write is optimistic;
          there is nothing to wait for. */}
      <WorkstreamHeader
        hypersightOpen={hypersightOpen}
        hypersightPreferencePending={hypersightPreference.isPending}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onOpenRail={openRailVariant}
        onRename={(title) => renameWorkstream.mutateAsync(title).then(() => undefined)}
        onToggleHyperSight={() => setHyperSightVisible(!hypersightOpen)}
        socketState={socketState}
        workstream={displayedDetail}
      />
      {hypersightOpen || railLeaving === 'hypersight' ? (
        <HyperSightRail
          blockCount={hypersight.data?.blocks.length ?? 0}
          leaving={railLeaving === 'hypersight'}
          onClose={() => setHyperSightVisible(false)}
        >
          {hypersight.data ? (
            <HyperSightPanel
              error={updateHyperSight.error?.message ?? hypersight.error?.message}
              hypersight={hypersight.data}
              onChange={(blocks) => updateHyperSight.mutateAsync(blocks).then(() => undefined)}
              pending={updateHyperSight.isPending}
            />
          ) : hypersight.error ? (
            <div className="hypersight-load-state">
              <InlineError>{hypersight.error.message}</InlineError>
              <Button onClick={() => void hypersight.refetch()}><RefreshCcw size={14} /> Try again</Button>
            </div>
          ) : (
            <div className="hypersight-load-state">
              <LoadingState label="Opening HyperSight…" />
            </div>
          )}
        </HyperSightRail>
      ) : null}
      <div
        className={clsx('transcript-scroll', transcriptDrop.dragging && 'is-file-dragging')}
        onDragEnter={transcriptDrop.onDragEnter}
        onDragLeave={transcriptDrop.onDragLeave}
        onDragOver={transcriptDrop.onDragOver}
        onDrop={transcriptDrop.onDrop}
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          setAtBottom(nearBottom && newerMessageCursor.data === null);
          if (element.scrollTop < 160 && messageCursor.data && !loadingOlderRef.current) {
            void loadOlderMessages();
          }
          if (nearBottom && newerMessageCursor.data && !loadingNewerRef.current) {
            void loadNewerMessages();
          }
          scheduleReadAcknowledgement();
        }}
        ref={transcriptRef}
      >
        <div className="transcript-column">
          {messageCursor.data && (
            <div className="transcript-history-control">
              <Button disabled={loadingOlder} onClick={() => void loadOlderMessages()}>
                {loadingOlder ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <ArrowUp aria-hidden="true" size={14} />}
                {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {olderMessagesError && <InlineError>{olderMessagesError}</InlineError>}
          {/* Not while a run is going. A work stream opened the instant it was
              created has an empty transcript and an agent already working on
              it, and inviting the person to start it is both wrong and the
              opposite of what the timer below says. The turn arrives moments
              later; until then the timer is the whole of the state. */}
          {visibleTranscript.length === 0 && !activeElicitation && !runTiming?.active ? (
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
                    <MessageBlock
                      currentUserId={session?.user.id}
                      loadAttachmentContent={loadAttachmentContent}
                      message={message}
                      onAnswerElicitation={answerElicitation}
                      onOpenAttachment={setAttachmentPreview}
                      onResolveSuggestion={resolveSuggestion}
                      systemRowDisclosure={systemRowDisclosure}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {runTiming && <AgentWorkTiming key={detail.latestHarnessRunId ?? detail.latestHarnessRun?.id} {...runTiming} />}
          {detail.harnessStatus === 'failed' && detail.latestHarnessRun?.status === 'failed' && (
            <RunFailureNotice
              code={detail.latestHarnessRun.error?.code ?? 'harness_execution_failed'}
              message={detail.latestHarnessRun.error?.message ?? 'Avalon could not complete this run. Retry it, or copy the request ID for support.'}
              onCopyRequestId={() => void desktopBridge().copyText(detail.latestHarnessRun?.requestId ?? detail.latestHarnessRun!.id)}
              onRetry={() => retry.mutate()}
              requestId={detail.latestHarnessRun.requestId ?? detail.latestHarnessRun.id}
              retrying={retry.isPending}
            />
          )}
        </div>
      </div>

      <div className="composer-dock">
        {!atBottom && (
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
        error={deferredContext.error?.message ?? watchResource.error?.message ?? detachResource.error?.message ?? attachResource.error?.message}
        leaving={railLeaving === 'inspector'}
        onAddParticipant={() => setParticipantDialogOpen(true)}
        onAddResource={() => setResourceDialogOpen(true)}
        onDetachResource={(resource) => detachResource.mutate(resource)}
        onOpenRun={(run) => void navigate(`/workstreams/${run.workstreamId}`)}
        onToggleWatch={(resource, enabled) => watchResource.mutate({ resource, enabled })}
        workstream={displayedDetail}
      />

      <AddParticipantDialog
        current={displayedDetail.participants}
        members={members.data ?? []}
        onAdd={(member) => addParticipant.mutate(member)}
        onOpenChange={setParticipantDialogOpen}
        open={participantDialogOpen}
        pending={addParticipant.isPending}
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
