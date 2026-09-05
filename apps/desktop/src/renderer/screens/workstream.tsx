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
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type { SubstreamPreparationPreview } from '@rally/contracts/substream-creation';
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
import { AvatarStack, Badge, Button, IconButton, InlineError, Modal, SocketStatusIndicator, StatusDot, TitleSkeleton } from '../components/primitives';
import { WorkstreamGlyph } from '../components/workstream-glyph';
import { WorkstreamSidebar } from '../components/workstream-sidebar';
import { SubstreamContext } from '../components/substream-context';
import { ConversationSurface } from './conversation-surface';

// The feed, composer and rail live in `conversation-surface.tsx`, shared with
// the automation screen. The helpers below are re-exported so the tests and
// screens that reached them through this module keep their import.
export {
  AddParticipantDialog,
  AddResourceDialog,
  RunFailureNotice,
  WorkstreamErrorState,
  acceptedMessageOverlayDeliveryState,
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  manualElicitationResponse,
  orderedTranscriptOwnsRunTiming,
  preservedPrependScrollTop,
  resourceVersionsQueryKey,
  shouldLoadEarlierFromScroll,
  workspaceMemberFromSession,
  workstreamPayloadBelongsToRoute,
  workstreamPresenceViewers,
  workstreamRunTiming,
  workstreamShowsReadyState,
} from './conversation-surface';

const RENAME_HINT = 'Double-click to rename';

export function WorkstreamHeader({
  grokBotMode = false,
  workstream,
  socketState,
  onAddParticipant,
  onOpenRail,
  onRename,
  presentUserIds = [],
  currentUserId = null,
  workspaceTarget,
}: {
  grokBotMode?: boolean;
  workstream: WorkstreamDetail;
  socketState: SocketState;
  onAddParticipant: () => void;
  onOpenRail: (variant: RailVariant) => void;
  onRename: (title: string) => Promise<void>;
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
      if (!workspaceTarget) return;
      const bridge = desktopBridge();
      const { webBaseUrl } = await bridge.getRuntimeConfig();
      await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, {
        region: workspaceTarget.region,
        workspaceId: workspaceTarget.workspaceId,
        workstreamId: workstream.id,
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
          <h1>
            <span className="grokbot-conversation-title">
              <WorkstreamGlyph id={workstream.id} size={20} />
              <span>{workstream.title}</span>
            </span>
          </h1>
        )}
        {RIGHT_SIDEBAR_ENABLED && <IconButton
          aria-pressed={showing('context')}
          className="grokbot-computer-button window-no-drag"
          label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
          onClick={() => toggleRail('context')}
        >
          <Monitor size={16} strokeWidth={1.8} />
        </IconButton>}
      </header>
    );
  }

  return (
    <header className="workstream-header window-drag">
      <div className="workstream-header-left window-no-drag">
        <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton>
        <WorkstreamGlyph id={workstream.id} size={30} />
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
  const selectedSubstreamId = searchParams.get('substream') || '0';
  const parent = useQuery<WorkstreamDetail | undefined>({
    queryKey: ['workstream', id], queryFn: async () => undefined, enabled: false,
  });
  const children = useQuery<WorkstreamChildDirectory | undefined>({
    queryKey: ['workstream-children', id], queryFn: async () => undefined, enabled: false,
  });
  const [creation, setCreation] = useState<{ operationId: string; parentId: string; title: string; throughTurnId: string | null; preparationWaitMs: number } | null>(null);
  const [preview, setPreview] = useState<SubstreamPreparationPreview | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [creationPending, setCreationPending] = useState<'prepare' | 'confirm' | null>(null);
  const creationRef = useRef(creation);
  creationRef.current = creation;
  const selectSubstream = (substreamId: string): void => {
    const next = new URLSearchParams(searchParams);
    if (substreamId === '0') next.delete('substream');
    else next.set('substream', substreamId);
    setSearchParams(next, { replace: true });
  };
  const resetCreation = (): void => {
    creationRef.current = null;
    setCreation(null); setPreview(null); setCreationError(null); setCreationPending(null);
  };
  const cancelCreation = (): void => {
    if (creationPending === 'confirm') return;
    if (api && creation) void api.cancelSubstream(creation.parentId, creation.operationId).catch(() => undefined);
    resetCreation();
  };
  const startCreation = (throughTurnId: string | null): void => {
    setPreview(null); setCreationError(null); setCreationPending(null);
    setCreation({ operationId: uuidV7(), parentId: id, title: 'New substream', throughTurnId, preparationWaitMs: 0 });
  };
  const updateCreationTitle = (nextTitle: string): void => {
    const active = creationRef.current;
    if (!active) return;
    if (api && creationError) void api.cancelSubstream(active.parentId, active.operationId).catch(() => undefined);
    setCreation({ ...active, operationId: uuidV7(), title: nextTitle, preparationWaitMs: 0 });
  };
  useEffect(() => {
    const active = creationRef.current;
    if (active && active.parentId !== id) {
      if (api) void api.cancelSubstream(active.parentId, active.operationId).catch(() => undefined);
      resetCreation();
    }
  }, [api, id]);
  const prepare = async (): Promise<void> => {
    const attempt = creationRef.current;
    if (!api || !attempt?.title.trim() || creationPending) return;
    const startedAt = performance.now();
    const trace = startPerfTrace('substream_create', { operationId: attempt.operationId });
    setCreationPending('prepare'); setCreationError(null);
    try {
      const prepared = await trace.step('prepare_request', () => api.prepareSubstream(attempt.parentId, {
        operationId: attempt.operationId, title: attempt.title.trim(), throughTurnId: attempt.throughTurnId,
      }));
      const elapsed = Math.max(0, performance.now() - startedAt);
      trace.end({ outcome: 'completed', workstreamId: attempt.parentId, systemWaitMs: elapsed });
      if (creationRef.current?.operationId !== attempt.operationId || creationRef.current.parentId !== attempt.parentId) return;
      setCreation((current) => current?.operationId === attempt.operationId ? { ...current, preparationWaitMs: current.preparationWaitMs + elapsed } : current);
      setPreview(prepared);
    } catch (error) {
      trace.end({ outcome: 'failed', workstreamId: attempt.parentId });
      if (creationRef.current?.operationId !== attempt.operationId || creationRef.current.parentId !== attempt.parentId) return;
      const elapsed = Math.max(0, performance.now() - startedAt);
      setCreation((current) => current?.operationId === attempt.operationId ? { ...current, preparationWaitMs: current.preparationWaitMs + elapsed } : current);
      setCreationError(error instanceof Error ? error.message : 'The substream preview could not be prepared.');
    } finally {
      if (creationRef.current?.operationId === attempt.operationId) setCreationPending(null);
    }
  };
  const confirm = async (): Promise<void> => {
    const attempt = creationRef.current;
    if (!api || !preview || !attempt || creationPending) return;
    const startedAt = performance.now();
    const trace = startPerfTrace('substream_create', { operationId: attempt.operationId });
    setCreationPending('confirm'); setCreationError(null);
    try {
      const result = await trace.step('confirm_request', () => api.confirmSubstream(attempt.parentId, attempt.operationId));
      if (creationRef.current?.operationId !== attempt.operationId || creationRef.current.parentId !== attempt.parentId) {
        trace.end({ outcome: 'superseded' }); return;
      }
      trace.annotate({ workstreamId: attempt.parentId });
      holdCreationTraceUntilSendReady(
        trace,
        attempt.parentId,
        result.substreamId,
        attempt.preparationWaitMs + Math.max(0, performance.now() - startedAt),
      );
      resetCreation();
      selectSubstream(result.substreamId);
    } catch (error) {
      trace.end({ outcome: 'failed', workstreamId: attempt.parentId });
      if (creationRef.current?.operationId !== attempt.operationId || creationRef.current.parentId !== attempt.parentId) return;
      setCreationError(error instanceof Error ? error.message : 'The substream could not be created.');
      setCreationPending(null);
    }
  };
  return (
    <>
    <ConversationSurface
      parentId={id}
      parentKind="workstream"
      onStartSubstream={startCreation}
      renderSidebar={(context) => (
        <WorkstreamSidebar
          workstream={{ ...context.detail, title: parent.data?.title ?? context.detail.title, privateChildren: children.data?.privateChildren }}
          presentUserIds={context.presentUserIds}
          selectedSubstreamId={selectedSubstreamId}
          onSelectSubstream={selectSubstream}
          onNewSubstream={() => startCreation(null)}
          onOpenArtifact={context.openArtifact}
          onResources={context.openResources}
          onParticipants={context.openParticipantDialog}
          onFocusTranscript={context.focusTranscript}
        />
      )}
      renderHeader={(context) => (
        <WorkstreamHeader
          currentUserId={session?.user.id ?? null}
          grokBotMode
          onAddParticipant={context.openParticipantDialog}
          onOpenRail={context.openRail}
          onRename={context.rename}
          presentUserIds={context.presentUserIds}
          socketState={context.socketState}
          workspaceTarget={session?.workspace ? {
            region: session.workspace.region,
            workspaceId: session.workspace.id,
          } : null}
          workstream={parent.data ?? context.detail}
        />
      )}
      substreamId={selectedSubstreamId}
    />
    <Modal
      description="Only you can see this private substream until you add participants. Review the selected context before creating it."
      footer={<>
        <Button className="secondary" disabled={creationPending === 'confirm'} onClick={cancelCreation}>Cancel</Button>
        {preview
          ? <Button disabled={creationPending !== null} onClick={() => void confirm()}>{creationPending === 'confirm' ? 'Creating…' : 'Create substream'}</Button>
          : <Button disabled={creationPending !== null || !creation?.title.trim()} onClick={() => void prepare()}>{creationPending === 'prepare' ? 'Preparing…' : 'Review context'}</Button>}
      </>}
      onOpenChange={(open) => { if (!open) cancelCreation(); }}
      open={creation?.parentId === id}
      title="New substream"
    >
      {creationError && <InlineError>{creationError}</InlineError>}
      {!preview ? <label className="field-label">Title<input autoFocus className="text-input" onChange={(event) => updateCreationTitle(event.target.value)} value={creation?.title ?? ''} /></label> : <div className="substream-context-preview">
        <strong>{preview.title}</strong>
        <p>Context from the main conversation</p>
        <SubstreamContext context={preview.context} />
      </div>}
    </Modal>
    </>
  );
}
