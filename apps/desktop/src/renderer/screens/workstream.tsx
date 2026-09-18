import { ShareConversationButton, ShareConversationDialog } from "../components/scope-sharing-panel";
import { ConversationHeader } from '@rally/ui/components/conversation-header';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { copyWorkstreamLink } from '../lib/copy-workstream-link';
import type { WorkspaceTarget } from '@rally/contracts/workspace-target';
import { useCollaborationSession } from '../lib/collaboration-session';

import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent, telemetryVisibility, uuidV7 } from '../lib/telemetry';
import { holdCreationTraceUntilSendReady, startPerfTrace } from '../lib/perf-trace';

import { RIGHT_SIDEBAR_ENABLED, useUiStore } from '../lib/ui-store';

import type { WorkstreamChildDirectory } from '../lib/use-workstream-control-socket';
import type { WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { useRetainedWorkstreamSocket } from '../lib/workstream-socket-pool';
import { Button, InlineError, Modal } from '../components/primitives';

import { useCachedWorkstreamAppearance } from '../lib/use-workstreams-query';
import { launchedSubstreamDetail, optimisticOpeningTranscript } from '../lib/launched-conversation';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import { evictCachedWorkstream, patchCachedWorkstream, workstreamDetailQueryKey } from '../lib/workstreams-cache';
import { WorkstreamSidebar, type ConversationRowTarget } from '../components/workstream-sidebar';
import { SidekickPicker } from '../components/sidekick-picker';
import { PENDING_SUBSTREAM_DRAFT_ID, type LaunchingSubstream, type SubstreamLaunchProps } from '../components/substream-launch';
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
  conversationReadAcknowledgement,
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

import { useOpenFirstWorkstream } from '../lib/workstream-landing';

type WorkstreamSidebarFailure =
  | 'copy_link'
  | 'make_public'
  | 'rename_workstream'
  | 'rename_substream'
  | 'archive_workstream'
  | 'archive_substream';

const workstreamSidebarFailureCopy: Record<WorkstreamSidebarFailure, { title: string; copy: string }> = {
  copy_link: { title: 'The link couldn’t be copied', copy: 'The link couldn’t be copied. Try again.' },
  make_public: { title: 'The work stream couldn’t be updated', copy: 'The work stream couldn’t be made public. Try again.' },
  rename_workstream: { title: 'The work stream couldn’t be renamed', copy: 'The work stream couldn’t be renamed. Try again.' },
  rename_substream: { title: 'The substream couldn’t be renamed', copy: 'The substream couldn’t be renamed. Try again.' },
  archive_workstream: { title: 'The work stream couldn’t be archived', copy: 'The work stream couldn’t be archived. Try again.' },
  archive_substream: { title: 'The substream couldn’t be archived', copy: 'The substream couldn’t be archived. Try again.' },
};

export function WorkstreamHeader({ workspaceTarget, ...props }: Omit<React.ComponentProps<typeof ConversationHeader>,
  'onShowNavigation' | 'onCopyLink' | 'onCopyEmail' | 'onCopyId'> & { workspaceTarget: WorkspaceTarget | null }): React.JSX.Element {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const closeRail = useUiStore((state) => state.closeRail);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const copy = (value: string, contentType: 'workstream_email' | 'workstream_id') => {
    void desktopBridge().copyText(value).then(() => reportTelemetryProductIntent({
      kind: 'content_copied', contentType, resourceType: 'workstream', resourceId: props.workstream.id,
    })).catch(() => undefined);
  };
  // HTTPS links unfurl and work without the desktop app installed; custom schemes do not.
  return <ConversationHeader {...props} railOpen={railOpen} railVariant={railVariant} onCloseRail={closeRail}
    contextEnabled={RIGHT_SIDEBAR_ENABLED} onShowNavigation={() => setSidebarOpen(true)}
    onCopyLink={() => { if (workspaceTarget) void copyWorkstreamLink(workspaceTarget, props.workstream.id, props.substreamId ?? '0').catch(() => undefined); }}
    onCopyEmail={props.workstream.emailAddress ? () => copy(props.workstream.emailAddress!, 'workstream_email') : undefined}
    onCopyId={() => copy(props.workstream.id, 'workstream_id')} />;
}

/** A work stream: the shared conversation surface under the work-stream header. */
export function WorkstreamScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { api, session } = useCollaborationSession();
  const [sharingSubstream, setSharingSubstream] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const selectedSubstreamId = searchParams.get('substream') || '0';
  const guest = session?.workspace?.accessClass === 'guest';
  // Parent chrome remains live even on a direct link into a child. Reuse the
  // retained Main connection rather than deriving its inventory from the child.
  // A guest child grant proves nothing about Main; keep that host scoped to its child.
  const mainConnection = useRetainedWorkstreamSocket(api, id, Boolean(api && id && (!guest || selectedSubstreamId === '0')), 'workstream', '0');
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
  // The open substream's own detail, for its row in the rail below. Its title
  // and the header's are then one value rather than two that agree eventually.
  const openChild = useQuery<WorkstreamDetail | undefined>({
    queryKey: workstreamDetailQueryKey(id, selectedSubstreamId),
    queryFn: async () => undefined,
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
  const railChildren = children.data?.privateChildren?.map((child) =>
    child.substreamId === selectedSubstreamId && openChild.data?.title
      ? { ...child, title: openChild.data.title }
      : child);
  // One target per dialog rather than one shared "menu target": both can be
  // open in sequence on different rows, and a single slot would make cancelling
  // one clear the other's subject out from under it.
  const [renameTarget, setRenameTarget] = useState<(ConversationRowTarget & { parentId: string }) | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<(ConversationRowTarget & { parentId: string }) | null>(null);
  const [substreamPending, setSubstreamPending] = useState(false);
  const [substreamMenuFailure, setSubstreamMenuFailure] = useState<WorkstreamSidebarFailure | null>(null);
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
  } | null>(null);
  const [launching, setLaunching] = useState<LaunchingSubstream | null>(null);
  /**
   * The child preparation reserved for the attempt on screen, once it has
   * answered with one.
   *
   * The rail needs it to keep one row per conversation: readiness publishes the
   * child to the parent's directory from inside the confirmation, so the real
   * row can arrive before the response that clears `launching` does, and a
   * placeholder watching only `launching` would stand beside it. Reserved
   * children are not readable as conversations, so this is an id to recognize
   * a row by and never one to navigate to.
   */
  const [reservedChildId, setReservedChildId] = useState<string | null>(null);
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
  const reportParentAction = (workstream: WorkstreamSummary, action: 'rename' | 'archive' | 'make_public'): void => {
    reportTelemetryProductIntent({
      kind: 'workstream_action_completed', workstreamId: workstream.id, action,
      visibility: telemetryVisibility(workstream.scope),
      origin: workstream.systemKind ? 'system' : 'ad_hoc', pinned: workstream.pinPosition !== null,
    });
  };
  const menuOperation = useRef(0);
  const copyRowLink = (target: ConversationRowTarget): void => {
    if (!session?.workspace) return;
    const workspace = session.workspace;
    const visit = routeRef.current.visit;
    const operation = ++menuOperation.current;
    void copyWorkstreamLink({ region: workspace.region, workspaceId: workspace.id }, id, target.substreamId).catch(() => {
      if (routeRef.current.visit === visit && menuOperation.current === operation) {
        setSubstreamMenuFailure('copy_link');
      }
    });
  };
  const makePublic = (): void => {
    if (!api || substreamPending) return;
    const visit = routeRef.current.visit;
    ++menuOperation.current;
    setSubstreamPending(true);
    void api.setWorkstreamScope(id, 'workspace').then((updated) => {
      patchCachedWorkstream(queryClient, id, { scope: updated.scope, updatedAt: updated.updatedAt });
      reportParentAction(updated, 'make_public');
    }).catch(() => {
      if (routeRef.current.visit === visit) setSubstreamMenuFailure('make_public');
    }).finally(() => { if (routeRef.current.visit === visit) setSubstreamPending(false); });
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
      // Match header renaming: guest Main is conversation-scoped authority.
      if (target.substreamId === '0' && !guest) {
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
      if (target.substreamId === '0') {
        const updated = await api.archiveWorkstream(target.parentId);
        reportParentAction(updated, 'archive');
        evictCachedWorkstream(queryClient, target.parentId);
      } else await api.setSubstreamArchived(target.parentId, target.substreamId, true);
      if (routeRef.current.id !== target.parentId || routeRef.current.visit !== visit) return;
      setArchiveTarget(null);
      if (target.substreamId === '0') openFirstWorkstream([target.parentId]);
      else if (routeRef.current.selectedSubstreamId === target.substreamId) selectSubstream('0');
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
    setCreation(null); setLaunching(null); setCreationError(null); setReservedChildId(null);
    // Best effort by design: the endpoint refuses an operation that is already
    // confirming or ready, which is exactly when there is nothing to release.
    if (api && abandoned) {
      void api.cancelSubstream(abandoned.parentId, abandoned.operationId).catch(() => undefined);
    }
  };
  const startCreation = (throughTurnId: string | null): void => {
    resetCreation();
    setCreation({
      parentId: id,
      throughTurnId,
      operationId: uuidV7(),
      clientMessageId: crypto.randomUUID(),
    });
  };
  useEffect(() => {
    setRenameTarget(null); setArchiveTarget(null); setSubstreamPending(false); setSubstreamMenuFailure(null);
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
    const createdAt = new Date().toISOString();
    const trace = startPerfTrace('substream_create', { operationId: attempt.operationId });
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
      const prepared = await trace.step('prepare_request', () => api.prepareSubstream(attempt.parentId, {
        operationId: attempt.operationId, throughTurnId: attempt.throughTurnId,
      }));
      // From here the operation holds a reserved child, so leaving the surface
      // has something to release — and the rail has an id to recognize that
      // child's own row by when confirmation publishes it.
      if (creationRef.current === attempt) {
        preparedRef.current = true;
        setReservedChildId(prepared.substreamId);
      }
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
          }, creator),
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
        setCreationError('The substream couldn’t be created. Try again.');
      }
      throw error;
    }
  };
  return (
    <>
    {api && session?.workspace && sharingSubstream !== null && <ShareConversationDialog api={api} workspaceId={session.workspace.id} parentId={id} substreamId={sharingSubstream} open onOpenChange={(open) => { if (!open) setSharingSubstream(null); }} />}
    <ConversationSurface
      parentId={id}
      parentKind="workstream"
      workstreamContext={guest ? undefined : parent.data}
      sidebarScope={guest ? 'conversation' : 'workstream'}
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
          mainVisible={!guest || selectedSubstreamId === '0'}
          onSidekickMenuOpen={context.loadSidekickOptions}
          addSidekick={<SidekickPicker workstreamId={context.detail.id} substreamId={selectedSubstreamId} />}
          sidekicks={context.sidekicks}
          sidekicksFailed={context.sidekicksFailed}
          workstream={{ ...context.detail, title: parent.data?.title ?? context.detail.title, appearance: rowAppearance ?? parent.data?.appearance, privateChildren: railChildren }}
          creatingSubstream={creation?.parentId === id && launching !== null
            ? { reservedSubstreamId: reservedChildId }
            : null}
          presentUserIds={context.presentUserIds}
          onParticipants={context.openParticipantDialog}
          selectedSubstreamId={creation?.parentId === id ? PENDING_SUBSTREAM_DRAFT_ID : selectedSubstreamId}
          onSelectSubstream={selectSubstream}
          onNewSubstream={() => startCreation(null)}
          onOpenArtifact={context.openArtifact}
          onFocusTranscript={context.focusTranscript}
          mainActions={(guest ? selectedSubstreamId === '0' : parent.data) ? {
            onMakePublic: guest || parent.data?.systemKind ? undefined : makePublic,
            publicDisabled: parent.data?.scope === 'workspace' || substreamPending,
            onShare: (target) => setSharingSubstream(target.substreamId),
            onCopyLink: session?.workspace ? copyRowLink : undefined,
            onRename: (target) => { ++menuOperation.current; setRenameTarget({ ...target, parentId: id }); setRenameTitle(target.title); setSubstreamMenuFailure(null); },
            onArchive: guest ? undefined : (target) => { ++menuOperation.current; setArchiveTarget({ ...target, parentId: id }); setSubstreamMenuFailure(null); },
          } : undefined}
          substreamActions={{
            onShare: (target) => setSharingSubstream(target.substreamId),
            onCopyLink: session?.workspace ? copyRowLink : undefined,
            onRename: (child) => { ++menuOperation.current; setRenameTarget({ ...child, parentId: id }); setRenameTitle(child.title); setSubstreamMenuFailure(null); },
            onArchive: (child) => { ++menuOperation.current; setArchiveTarget({ ...child, parentId: id }); setSubstreamMenuFailure(null); },
          }}
        />
      )}
      renderHeader={(context) => (
        <WorkstreamHeader
          actions={api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id}
            parentId={id} substreamId={selectedSubstreamId} /> : null}
          currentUserId={session?.user.id ?? null}
          grokBotMode
          substreamId={selectedSubstreamId}
          onAddParticipant={context.openParticipantDialog}
          onOpenRail={context.openRail}
          onRename={context.rename}
          onAppearanceChange={guest ? undefined : mainConnection.setAppearance}
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
        <Button disabled={substreamPending} onClick={() => { setRenameTarget(null); setSubstreamMenuFailure(null); }}>Cancel</Button>
        <Button
          className="button-primary"
          disabled={substreamPending || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
          onClick={() => void submitSubstreamRename()}
        >Rename</Button>
      </>}
      onOpenChange={(open) => { if (!open && !substreamPending) { setRenameTarget(null); setSubstreamMenuFailure(null); } }}
      open={Boolean(renameTarget)}
      title={renameTarget?.substreamId === '0' ? 'Rename work stream' : 'Rename substream'}
    >
      {substreamMenuFailure && <InlineError>{workstreamSidebarFailureCopy[substreamMenuFailure].copy}</InlineError>}
      <form onSubmit={(event) => { event.preventDefault(); void submitSubstreamRename(); }}>
        <label className="form-field">
          <span>Title</span>
          <input autoFocus maxLength={180} disabled={substreamPending} onChange={(event) => setRenameTitle(event.target.value)} value={renameTitle} />
        </label>
      </form>
    </Modal>
    <Modal
      footer={<>
        <Button disabled={substreamPending} onClick={() => { setArchiveTarget(null); setSubstreamMenuFailure(null); }}>Cancel</Button>
        <Button className="button-danger" disabled={substreamPending} onClick={() => void submitSubstreamArchive()}>Archive</Button>
      </>}
      onOpenChange={(open) => { if (!open && !substreamPending) { setArchiveTarget(null); setSubstreamMenuFailure(null); } }}
      open={Boolean(archiveTarget)}
      title={archiveTarget?.substreamId === '0' ? 'Archive work stream' : 'Archive substream'}
    >
      <p className="modal-copy">
        <strong>{archiveTarget?.title}</strong> leaves the sidebar for everyone in it, and stops
        accepting messages. The conversation is kept, but restoring it currently requires the API; there is no restore control in the app.
      </p>
      {substreamMenuFailure && <InlineError>{workstreamSidebarFailureCopy[substreamMenuFailure].copy}</InlineError>}
    </Modal>
    <Modal
      footer={<Button onClick={() => setSubstreamMenuFailure(null)}>Close</Button>}
      onOpenChange={(open) => { if (!open) setSubstreamMenuFailure(null); }}
      open={Boolean(substreamMenuFailure) && !renameTarget && !archiveTarget}
      title={substreamMenuFailure ? workstreamSidebarFailureCopy[substreamMenuFailure].title : 'That couldn’t be updated'}
    >
      {substreamMenuFailure && <InlineError>{workstreamSidebarFailureCopy[substreamMenuFailure].copy}</InlineError>}
    </Modal>
    </>
  );
}
