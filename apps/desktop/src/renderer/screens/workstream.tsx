import * as Tooltip from '@radix-ui/react-tooltip';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import {
  Check,
  Copy,
  Ellipsis,
  Info,
  LoaderCircle,
  Lock,
  Mail,
  Menu,
  Monitor,
  PanelRight,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import type { WorkspaceTarget } from '@rally/contracts/workspace-target';
import { useAppSession } from '../lib/app-session';
import { isComposingKeyEvent } from '../lib/ime';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';
import { holdCreationTraceUntilSendReady, startPerfTrace } from '../lib/perf-trace';
import { useTextClipped } from '../lib/use-text-clipped';
import { RIGHT_SIDEBAR_ENABLED, type RailVariant, useUiStore } from '../lib/ui-store';
import type { SocketState } from '../lib/use-workstream-socket';
import type { WorkstreamChildDirectory } from '../lib/use-workstream-control-socket';
import type { WorkstreamDetail } from '../lib/types';
import { useRetainedWorkstreamSocket } from '../lib/workstream-socket-pool';
import { AvatarStack, Badge, Button, IconButton, InlineError, Modal, SocketStatusIndicator, StatusDot, TitleSkeleton } from '../components/primitives';
import { WorkstreamGlyph } from '../components/workstream-glyph';
import { WorkstreamAppearancePicker } from '../components/workstream-appearance-picker';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import { useCachedWorkstreamAppearance } from '../lib/use-workstreams-query';
import { launchedSubstreamDetail, optimisticOpeningTranscript } from '../lib/launched-conversation';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import { workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { WorkstreamSidebar, type SubstreamRowTarget } from '../components/workstream-sidebar';
import {
  PENDING_SUBSTREAM_DRAFT_ID,
  type LaunchingSubstream,
  type SubstreamLaunchProps,
} from '../components/substream-launch';
import { ConversationSurface, workspaceMemberFromSession } from './conversation-surface';

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
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  manualElicitationResponse,
  orderedTranscriptOwnsRunTiming,
  preservedPrependScrollTop,
  resourceVersionsQueryKey,
  workspaceMemberFromSession,
  workstreamPayloadBelongsToRoute,
  workstreamPresenceViewers,
  workstreamRunTiming,
  workstreamShowsReadyState,
} from './conversation-surface';

const RENAME_HINT = 'Click to rename. Press Enter to save.';

export function WorkstreamHeader({
  grokBotMode = false,
  substreamId = '0',
  workstream,
  socketState,
  onAddParticipant,
  onOpenRail,
  onRename,
  onAppearanceChange,
  presentUserIds = [],
  currentUserId = null,
  workspaceTarget,
}: {
  grokBotMode?: boolean;
  substreamId?: string;
  workstream: WorkstreamDetail;
  socketState: SocketState;
  onAddParticipant: () => void;
  onOpenRail: (variant: RailVariant) => void;
  onRename: (title: string) => Promise<void>;
  onAppearanceChange?: (patch: WorkstreamAppearancePatch) => Promise<void>;
  presentUserIds?: readonly string[];
  currentUserId?: string | null;
  workspaceTarget: WorkspaceTarget | null;
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
  const conversationKey = `${workstream.id}:${substreamId}`;
  const shownWorkstreamId = useRef({ key: conversationKey, visit: 0 });
  if (shownWorkstreamId.current.key !== conversationKey) {
    shownWorkstreamId.current = { key: conversationKey, visit: shownWorkstreamId.current.visit + 1 };
  }
  useEffect(() => {
    setRenameDraft(null);
    setRenameError(null);
    setRenaming(false);
  }, [conversationKey]);
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
    const submittedFor = shownWorkstreamId.current;
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
      if (!workspaceTarget) return;
      const bridge = desktopBridge();
      const { webBaseUrl } = await bridge.getRuntimeConfig();
      await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, {
        region: workspaceTarget.region,
        workspaceId: workspaceTarget.workspaceId,
        workstreamId: workstream.id,
        ...(substreamId === '0' ? {} : { substreamId }),
      }));
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

  const titleContent = (naming ? (
    <h1><TitleSkeleton className="title-skeleton-header" /></h1>
  ) : renameDraft === null ? (
    <>
      <h1>
        <button
          aria-describedby={renameHintId}
          aria-keyshortcuts="Enter F2"
          className="workstream-title-button"
          onClick={startRename}
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
          if (isComposingKeyEvent(event.nativeEvent)) {
            if (event.key === 'Enter') event.preventDefault();
            return;
          }
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
  ));

  if (grokBotMode) {
    return (
      <header className="grokbot-workstream-header window-drag">
        <div className="grokbot-header-navigation window-no-drag">
          <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Menu size={16} />
          </IconButton>
        </div>
        {naming ? (
          <h1><TitleSkeleton className="title-skeleton-header" /></h1>
        ) : (
          <div className="grokbot-conversation-title">
              {onAppearanceChange ? <WorkstreamAppearancePicker key={workstream.id} id={workstream.id} appearance={workstream.appearance} size={20} onChange={onAppearanceChange} /> : <WorkstreamGlyph id={workstream.id} appearance={workstream.appearance} size={20} />}
              {titleContent}
              {renameError && <InlineError>{renameError}</InlineError>}
          </div>
        )}
        <div className="grokbot-header-actions window-no-drag">
          <Tooltip.Root delayDuration={300}>
            <Tooltip.Trigger asChild>
              <button
                className="participant-header-button"
                aria-label={substreamId === '0' ? 'Manage work-stream participants' : 'Manage substream participants'}
                aria-description={workstream.participants.map((person) => person.name).join(', ')}
                onClick={onAddParticipant}
                type="button"
              >
                <AvatarStack members={workstream.participants} currentUserId={currentUserId} presentUserIds={substreamId === '0' ? presentUserIds : []} showTooltip={false} />
                <UserPlus aria-hidden="true" size={13} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip" side="bottom" sideOffset={6}>
                {naming ? 'Participants of this conversation' : `Participants of ${workstream.title}`}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          {RIGHT_SIDEBAR_ENABLED && <IconButton
            aria-pressed={showing('context')}
            className="grokbot-computer-button"
            label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
            onClick={() => toggleRail('context')}
          >
            <Monitor size={16} strokeWidth={1.8} />
          </IconButton>}
        </div>
      </header>
    );
  }

  return (
    <header className="workstream-header window-drag">
      <div className="workstream-header-left window-no-drag">
        <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton>
        {onAppearanceChange ? <WorkstreamAppearancePicker key={workstream.id} id={workstream.id} appearance={workstream.appearance} size={30} onChange={onAppearanceChange} /> : <WorkstreamGlyph id={workstream.id} appearance={workstream.appearance} size={30} />}
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
            {titleContent}
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
        {RIGHT_SIDEBAR_ENABLED && <IconButton
          aria-pressed={showing('context')}
          className={clsx('panel-toggle', showing('context') && 'is-active')}
          label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
          onClick={() => toggleRail('context')}
        >
          <PanelRight size={15} />
        </IconButton>}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
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


/** A work stream: the shared conversation surface under the work-stream header. */
export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { api, session } = useAppSession();
  const queryClient = useQueryClient();
  const selectedSubstreamId = searchParams.get('substream') || '0';
  // Parent chrome remains live even on a direct link into a child. Reuse the
  // retained Main connection rather than deriving its inventory from the child.
  const mainConnection = useRetainedWorkstreamSocket(api, id, Boolean(api && id), 'workstream', '0');
  const parent = useQuery<WorkstreamDetail | undefined>({
    queryKey: ['workstream', id], queryFn: async () => undefined, enabled: false,
  });
  // The rail's mark follows the sidebar row rather than this detail, so one
  // appearance change moves both rails together instead of moving the sidebar
  // now and this rail when the projection lands. The header keeps the detail:
  // that entry is what retires the picker's own preview.
  const rowAppearance = useCachedWorkstreamAppearance(id);
  const children = useQuery<WorkstreamChildDirectory | undefined>({
    queryKey: ['workstream-children', id], queryFn: async () => undefined, enabled: false,
  });
  // One target per dialog rather than one shared "menu target": both can be
  // open in sequence on different rows, and a single slot would make cancelling
  // one clear the other's subject out from under it.
  const [renameTarget, setRenameTarget] = useState<(SubstreamRowTarget & { parentId: string }) | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<(SubstreamRowTarget & { parentId: string }) | null>(null);
  const [substreamPending, setSubstreamPending] = useState(false);
  const [substreamMenuError, setSubstreamMenuError] = useState<string | null>(null);
  /**
   * The substream being written, if any. Nothing has been reserved on the
   * server while this is set: preparation and confirmation both happen on the
   * keystroke that submits the composer, so leaving the surface is free and a
   * substream nobody finished writing never exists.
   */
  const [creation, setCreation] = useState<{ parentId: string; throughTurnId: string | null } | null>(null);
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
  useEffect(() => {
    if (!children.data) return;
    const ids = new Set<string>(children.data.privateChildren?.map((child) => child.substreamId));
    if (previousChildren.current.parentId === id && previousChildren.current.ids.has(selectedSubstreamId)
      && !ids.has(selectedSubstreamId)) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('substream'); next.delete('turn'); next.delete('sequence');
        return next;
      }, { replace: true });
    }
    previousChildren.current = { parentId: id, ids };
  }, [children.data, id, selectedSubstreamId, setSearchParams]);
  const routeRef = useRef({ id, selectedSubstreamId, visit: 0 });
  routeRef.current = { id, selectedSubstreamId, visit: routeRef.current.visit + Number(routeRef.current.id !== id || routeRef.current.selectedSubstreamId !== selectedSubstreamId) };
  const submitSubstreamRename = async (): Promise<void> => {
    const target = renameTarget;
    const title = renameTitle.trim();
    if (!api || !target || !title || substreamPending) return;
    if (title === target.title) { setRenameTarget(null); return; }
    const visit = routeRef.current.visit;
    setSubstreamPending(true);
    setSubstreamMenuError(null);
    try {
      await api.renameSubstream(target.parentId, target.substreamId, title);
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setRenameTarget(null);
    } catch (error) {
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setSubstreamMenuError(error instanceof Error ? error.message : 'That substream could not be renamed.');
    } finally {
      if (routeRef.current.id === target.parentId && routeRef.current.visit === visit) setSubstreamPending(false);
    }
  };
  const submitSubstreamArchive = async (): Promise<void> => {
    const target = archiveTarget;
    if (!api || !target || substreamPending) return;
    const visit = routeRef.current.visit;
    setSubstreamPending(true);
    setSubstreamMenuError(null);
    try {
      await api.setSubstreamArchived(target.parentId, target.substreamId, true);
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setArchiveTarget(null);
      if (routeRef.current.selectedSubstreamId === target.substreamId) selectSubstream('0');
    } catch (error) {
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setSubstreamMenuError(error instanceof Error ? error.message : 'That substream could not be archived.');
    } finally {
      if (routeRef.current.id === target.parentId && routeRef.current.visit === visit) setSubstreamPending(false);
    }
  };
  const resetCreation = (): void => {
    creationRef.current = null;
    setCreation(null); setLaunching(null); setCreationError(null);
  };
  const startCreation = (throughTurnId: string | null): void => {
    setLaunching(null); setCreationError(null);
    setCreation({ parentId: id, throughTurnId });
  };
  useEffect(() => {
    setRenameTarget(null); setArchiveTarget(null); setSubstreamPending(false); setSubstreamMenuError(null);
    // Only when the work stream itself changed. Selecting another conversation
    // inside it is how the launch surface is left, and that already clears it.
    if (creationRef.current && creationRef.current.parentId !== id) resetCreation();
    // Selecting another conversation inside the same work stream still closes
    // a row's dialogs, which is why this watches the substream as well.
  }, [id, selectedSubstreamId]);
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
    if (!api || !attempt) throw new Error('This work stream is not ready for a new substream.');
    const operationId = uuidV7();
    const createdAt = new Date().toISOString();
    const trace = startPerfTrace('substream_create', { operationId });
    const startedAt = performance.now();
    // In the same commit as the request, not after it: this is what makes the
    // substream appear to open on the keystroke rather than on the response.
    setLaunching({
      attachments: opening.attachments,
      createdAt,
      text: opening.text,
      startedAt: Date.parse(createdAt),
    });
    setCreationError(null);
    try {
      await trace.step('prepare_request', () => api.prepareSubstream(attempt.parentId, {
        operationId, throughTurnId: attempt.throughTurnId,
      }));
      const created = await trace.step('confirm_request', () => api.confirmSubstream(
        attempt.parentId,
        operationId,
        {
          clientMessageId: crypto.randomUUID(),
          text: opening.text,
          mentions: opening.mentions,
          attachmentIds: opening.attachmentIds,
          confirmedParticipantUserIds: opening.confirmedParticipantUserIds,
        },
      ));
      if (creationRef.current !== attempt) { trace.end({ outcome: 'superseded' }); return; }
      trace.annotate({ workstreamId: attempt.parentId });
      const parentDetail = queryClient.getQueryData<WorkstreamDetail>(workstreamDetailQueryKey(id, '0'));
      const creator = workspaceMemberFromSession(session);
      // Seeded before the navigation, both of them: the child's screen shows
      // its full-screen opening state while *either* the detail or the
      // transcript is missing, so one without the other still flashes it.
      if (parentDetail && creator && created.opening) {
        const detail = launchedSubstreamDetail(parentDetail, {
          creator,
          title: created.title,
          createdAt: created.opening.createdAt,
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
          }, creator),
        );
      }
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
      if (creationRef.current !== attempt) return;
      // Back to the composer with the words still in it. The optimistic turn
      // stood for a substream that does not exist, so it cannot stay on screen
      // next to an error about why it never will.
      setLaunching(null);
      setCreationError(error instanceof Error ? error.message : 'The substream could not be created.');
      throw error;
    }
  };
  return (
    <>
    <ConversationSurface
      parentId={id}
      parentKind="workstream"
      workstreamContext={parent.data}
      onStartSubstream={startCreation}
      substreamLaunch={creation?.parentId === id ? {
        throughTurnId: creation.throughTurnId,
        launching,
        ...(creationError ? { error: creationError } : {}),
        onCancel: resetCreation,
        onCreate: createSubstream,
      } : null}
      renderSidebar={(context) => (
        <WorkstreamSidebar
          attachedSidekicks={context.attachedSidekicks}
          attachedSidekicksError={context.attachedSidekicksError}
          onRemoveSidekick={context.removeSidekick}
          workstream={{ ...context.detail, title: parent.data?.title ?? context.detail.title, appearance: rowAppearance ?? parent.data?.appearance, privateChildren: children.data?.privateChildren }}
          presentUserIds={context.presentUserIds}
          onParticipants={context.openParticipantDialog}
          selectedSubstreamId={creation?.parentId === id ? PENDING_SUBSTREAM_DRAFT_ID : selectedSubstreamId}
          onSelectSubstream={selectSubstream}
          onNewSubstream={() => startCreation(null)}
          onOpenArtifact={context.openArtifact}
          onFocusTranscript={context.focusTranscript}
          substreamActions={{
            onRename: (child) => { setRenameTarget({ ...child, parentId: id }); setRenameTitle(child.title); setSubstreamMenuError(null); },
            onArchive: (child) => { setArchiveTarget({ ...child, parentId: id }); setSubstreamMenuError(null); },
          }}
        />
      )}
      renderHeader={(context) => (
        <WorkstreamHeader
          currentUserId={session?.user.id ?? null}
          grokBotMode
          substreamId={selectedSubstreamId}
          onAddParticipant={context.openParticipantDialog}
          onOpenRail={context.openRail}
          onRename={context.rename}
          onAppearanceChange={mainConnection.setAppearance}
          presentUserIds={context.presentUserIds}
          socketState={context.socketState}
          workspaceTarget={session?.workspace ? {
            region: session.workspace.region,
            workspaceId: session.workspace.id,
          } : null}
          workstream={{ ...context.detail, appearance: parent.data?.appearance }}
        />
      )}
      substreamId={selectedSubstreamId}
    />
    <Modal
      footer={<>
        <Button disabled={substreamPending} onClick={() => { setRenameTarget(null); setSubstreamMenuError(null); }}>Cancel</Button>
        <Button
          className="button-primary"
          disabled={substreamPending || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
          onClick={() => void submitSubstreamRename()}
        >Rename</Button>
      </>}
      onOpenChange={(open) => { if (!open && !substreamPending) { setRenameTarget(null); setSubstreamMenuError(null); } }}
      open={Boolean(renameTarget)}
      title="Rename substream"
    >
      {substreamMenuError && <InlineError>{substreamMenuError}</InlineError>}
      <form onSubmit={(event) => { event.preventDefault(); void submitSubstreamRename(); }}>
        <label className="form-field">
          <span>Title</span>
          <input autoFocus maxLength={180} disabled={substreamPending} onChange={(event) => setRenameTitle(event.target.value)} value={renameTitle} />
        </label>
      </form>
    </Modal>
    <Modal
      footer={<>
        <Button disabled={substreamPending} onClick={() => { setArchiveTarget(null); setSubstreamMenuError(null); }}>Cancel</Button>
        <Button className="button-danger" disabled={substreamPending} onClick={() => void submitSubstreamArchive()}>Archive</Button>
      </>}
      onOpenChange={(open) => { if (!open && !substreamPending) { setArchiveTarget(null); setSubstreamMenuError(null); } }}
      open={Boolean(archiveTarget)}
      title="Archive substream"
    >
      <p className="modal-copy">
        <strong>{archiveTarget?.title}</strong> leaves the sidebar for everyone in it, and stops
        accepting messages. The conversation is kept, but restoring it currently requires the API; there is no restore control in the app.
      </p>
      {substreamMenuError && <InlineError>{substreamMenuError}</InlineError>}
    </Modal>
    <Modal
      footer={<Button onClick={() => setSubstreamMenuError(null)}>Close</Button>}
      onOpenChange={(open) => { if (!open) setSubstreamMenuError(null); }}
      open={Boolean(substreamMenuError) && !renameTarget && !archiveTarget}
      title="That could not be updated"
    >
      <InlineError>{substreamMenuError}</InlineError>
    </Modal>
    </>
  );
}
