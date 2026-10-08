import { asSubstreamId, asWorkspaceId, asWorkstreamId, MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { optimisticOpeningTranscript } from '../lib/launched-conversation';
import { optimisticMentionRendering } from '../lib/transcript';
import type { MentionIdentity } from '../lib/api';
import { holdCreationTraceUntilSendReady, startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { useSpaceChoices } from '../lib/space-choices';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { EmailMentionContext, emailMentionDirectory, inviteeAsMember, isInvitee, NO_INVITEES, useWorkspaceInvitees } from '../lib/workspace-invitees';
import { logError } from '../../common/logger';
import { uuidV7 } from '../lib/telemetry';
import { addPendingWorkstream, confirmPendingWorkstream, discardPendingWorkstream } from '../lib/workstreams-cache';
import type { AgentModelOverride, CreatedWorkstream, Message, MessageAttachment, Workspace, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { type ComposerConversation, WorkstreamComposer } from '../components/workstream-composer';
import { NewChannelParticipants } from '../components/new-channel-participants';
import { DropdownSelect, EmptyState, LoadingState, TitleSkeleton } from '../components/primitives';
import { MessageBlock } from '../components/workstream-blocks';

interface CreateWorkstreamInput {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
  mentions: MentionIdentity[];
  participantIds: string[];
  /** Invitees picked or mentioned, shared the Channel by address once it exists. */
  invitedEmails: string[];
  /**
   * The submit instant the launch surface has been counting from. Seeded onto
   * the created run so the work timer does not jump at the navigation; the
   * first refetch replaces it with the run's real start.
   */
  startedAt: string;
  /** The id this Channel is listed under from the keystroke, and created under. */
  workstreamId: string;
}

/**
 * What the screen shows between pressing enter and the work stream existing.
 *
 * The create round trip is not short — it reserves an email route, writes the
 * work stream, and starts a harness run — and until this existed the person who
 * pressed enter watched the launcher they had just emptied. This is the same
 * turn they are about to be looking at, drawn from what they typed, so the wait
 * happens inside the work stream rather than in front of it.
 */
interface LaunchingWorkstream {
  attachments: MessageAttachment[];
  /** Frozen at submit so the optimistic turn and the persisted one agree. */
  createdAt: string;
  openingMessage: string;
  /** The popover selections, so the drawn turn shows chips rather than plain `@Name`. */
  mentions: MentionIdentity[];
  /** Drives the work timer, which the created stream keeps counting from. */
  startedAt: number;
}

/**
 * The detail a just-created work stream is put into the cache under, so its
 * screen paints instead of loading.
 *
 * Both launchers seed through here. They differ only in what they can say about
 * the transcript — a typed create holds the text of its opening turn, while
 * suggested work's turn is expanded server-side and is not on the client at
 * all — and if they differed in the detail as well, one of them would be the
 * path whose work timer silently stopped surviving the navigation.
 */
function launchedWorkstreamDetail(
  created: CreatedWorkstream,
  context: {
    creator: WorkspaceMember;
    /**
     * The model this create pinned, where it pinned one. Carried onto the seeded
     * run *and* onto the detail's own `modelOverride`, so the work stream's
     * model pill opens on the name the composer's selector was showing a moment
     * ago instead of falling back to **Default** until the refetch answers, and
     * describes it as pinned rather than as following the flag. Absent means
     * unpinned, which the flag decides and this process cannot see.
     */
    model?: AgentModelOverride | null;
    origin: string;
    participants?: WorkspaceMember[];
    /** The instant the launch surface has been counting from. */
    startedAt: string;
  },
): WorkstreamDetail {
  return {
    ...created.workstream,
    createdAt: created.createdAt,
    // The pin itself, beside the run below. The run answers *which* model, and
    // this answers whether that model is fixed — two different claims the pill
    // makes from two different fields. `created.workstream` cannot supply it:
    // it is a summary, and `mapWorkstreamSummary` does not carry the column, so
    // without this a work stream pinned a moment ago describes itself as
    // following the flag until the first refetch replaces the seed.
    modelOverride: context.model ?? null,
    createdBy: { ...context.creator, role: 'creator' },
    participants: [{ ...context.creator, role: 'creator' }, ...context.participants ?? []],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    // Without the run, the work timer the launch surface has been showing
    // disappears on arrival and only comes back when the refetch answers —
    // the one thing that still read as a navigation.
    ...(created.harnessRunId
      ? {
        latestHarnessRunId: created.harnessRunId,
        latestHarnessRun: {
          id: created.harnessRunId,
          origin: context.origin,
          status: 'running' as const,
          ...(context.model ? { model: context.model } : {}),
          startedAt: context.startedAt,
          createdAt: context.startedAt,
        },
      }
      : {}),
  };
}

/**
 * The launcher, mounted afresh for every opening.
 *
 * Every navigation here is a new Channel, started in the Space the route names.
 * React keeps one instance across a change of `:spaceId`, and across a
 * second opening of the Space already on screen, so without this key the
 * people picked for one Channel were carried into the next — into a different
 * Space's Channel, even — and the composer's autofocus never ran again. The
 * unsent draft and its attachments are cached by Space, so remounting loses
 * nothing a person typed.
 */
export function NewWorkstreamScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  return <NewWorkstreamLauncher key={useLocation().key} workspace={workspace} />;
}

function NewWorkstreamLauncher({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const routeSpaceId = useParams<{ spaceId: string }>().spaceId!;
  // The route opens the launcher on a Space; the Space picker above the
  // composer can move it to another before the Channel exists. Held here rather
  // than in the route, because a navigation remounts the launcher and would
  // drop the people and name already chosen.
  const [pickedSpaceId, setPickedSpaceId] = useState(routeSpaceId);
  const [channelNameInput, setChannelNameInput] = useState('');
  const channelName = channelNameInput.trim();
  const { api } = useAppSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceDraftKey = newWorkstreamDraftKey(workspace.region, workspace.id);
  // Keyed by the Space the launcher opened on, not the one picked since, so
  // changing the picker never swaps the words in the composer for another draft.
  const draftKey = `${workspaceDraftKey}:space:${routeSpaceId}`;
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  // Not kept in the draft cache: the draft outlives the session, and a model
  // pinned last week is not a choice anyone would expect to still be in force.
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [launching, setLaunching] = useState<LaunchingWorkstream | null>(null);
  // Set by `submit` when the composer holds more than the server takes, and
  // cleared by the next keystroke. Held separately from `create.error` because
  // nothing was sent: the request this would have been is the one thing that
  // must not happen, since the create path reserves an address and writes rows
  // before anything looks at the message's length.
  const [tooLong, setTooLong] = useState(false);
  const attachmentDraft = useFileAttachments(api, draftKey);
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal),
    [api],
  );
  // The composer autofocuses here, but focus moves away the moment anything else
  // is clicked; a paste landing on the document still reaches the draft.
  useWindowFilePaste(attachmentDraft.addFiles);
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  // People invited to the Organization who have not joined yet: pickable
  // beside members, and shared the Channel by address once it exists.
  const invitees = useWorkspaceInvitees(api, workspace.currentUser.accessClass !== 'guest');
  const visibleInvitees = invitees.data ?? NO_INVITEES;
  const emailMentions = useMemo(
    () => emailMentionDirectory(members.data ?? [], visibleInvitees),
    [members.data, visibleInvitees],
  );
  const { active: spaces } = useSpaceDirectories();
  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  const recipientCandidates = useMemo(() => [
    ...(members.data ?? []).filter((member) => (
      member.id !== workspace.currentUser.id
      && (member.status ?? 'active') === 'active'
      && !selectedIds.has(member.id)
    )),
    ...visibleInvitees.map((invitee) => inviteeAsMember(invitee.email)).filter((member) => !selectedIds.has(member.id)),
  ], [members.data, selectedIds, visibleInvitees, workspace.currentUser.id]);
  const selectRecipient = useCallback((member: WorkspaceMember): void => {
    setSelectedMembers((current) => current.some((candidate) => candidate.id === member.id)
      ? current
      : [...current, member]);
  }, []);
  const removeRecipient = useCallback((memberId: string): void => {
    setSelectedMembers((current) => current.filter((member) => member.id !== memberId));
  }, []);
  const returnTo = typeof location.state === 'object'
      && location.state !== null
      && 'returnTo' in location.state
      && typeof location.state.returnTo === 'string'
      ? location.state.returnTo
      : null;
  const canCloseNewChat = Boolean(returnTo && returnTo !== location.pathname);
  const closeNewChat = useCallback((): void => {
    if (returnTo && returnTo !== location.pathname) {
      void navigate(returnTo, { replace: true });
      return;
    }
  }, [location.pathname, returnTo, navigate]);
  // The picked Space can leave the directory (archived from the sidebar) while
  // this screen is open; the launcher then falls back to the route's Space
  // rather than to "Space not found".
  const pickedSpace = spaces.data?.items.find((space) => space.id === pickedSpaceId);
  const owningSpace = pickedSpace ?? spaces.data?.items.find((space) => space.id === routeSpaceId);
  const owningSpaceId = owningSpace?.id ?? pickedSpaceId;
  // The Spaces a Channel can be started in, as every Space picker lists them.
  // A Space reached only through a shared Channel is not one; the route's own
  // Space stays listed so the picker never shows a value it has no row for.
  const spaceOptions = useSpaceChoices(spaces.data?.items ?? [])
    .filter((space) => space.reach !== 'through_channel' || space.id === owningSpaceId)
    .map((space) => ({ label: space.name, value: space.id }));
  // Opened on the keystroke that starts a work stream and closed once the
  // route change is requested. The surface is optimistic — the work stream is
  // already on screen — so what this spans is the round trip behind it. Held in
  // a ref because the mutation's callbacks each run in their own commit.
  const createTrace = useRef<PerfTrace | null>(null);
  // Set on the keystroke that starts a create and cleared only by its failure.
  // A ref rather than `launching`, which a second Enter in the same frame would
  // read from the render before it was set.
  const createPending = useRef(false);
  const createStartedAt = useRef<number | null>(null);
  const create = useMutation({
    mutationFn: (input: CreateWorkstreamInput) => {
      // A second create starting while one is in flight would otherwise drop
      // the first trace on the floor, silently losing the slower of the two.
      createTrace.current?.end({ outcome: 'superseded' });
      const trace = startPerfTrace('workstream_create');
      createTrace.current = trace;
      createStartedAt.current = performance.now();
      trace.annotate({
        participantCount: input.participantIds.length,
        attachmentCount: input.attachmentIds.length,
        openingMessageLength: input.openingMessage.length,
      });
      return trace.step('create_request', () => api!.createWorkstream({
        workstreamId: input.workstreamId,
        ...(channelName ? { title: channelName } : {}),
        openingMessage: input.openingMessage,
        participantIds: input.participantIds,
        spaceIds: [owningSpaceId],
        ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        requestId: trace.traceId,
        operationId: trace.traceId,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      }));
    },
    onError: (_error, input) => {
      createPending.current = false;
      discardPendingWorkstream(queryClient, input.workstreamId);
      createTrace.current?.end({ outcome: 'failed' });
      createTrace.current = null;
      createStartedAt.current = null;
      // Back to the launcher. The optimistic turn stood for a work stream that
      // does not exist, so it cannot stay on screen next to an error about why.
      // The words come back through the composer, which restores the draft it
      // cleared when `submit` rejects.
      setLaunching(null);
    },
    onSuccess: (created, input) => {
      confirmPendingWorkstream(queryClient, input.workstreamId, created.workstream);
      // Shared once the Channel exists, and not awaited: the Channel opens on
      // the create alone, and the address is in its People as Invited when this
      // lands. A failure leaves them out of that list, which is where the
      // creator looks for them.
      if (input.invitedEmails.length > 0) {
        void Promise.resolve().then(() => api!.createScopeInvitations({
          operationId: uuidV7(),
          parentId: created.workstream.id,
          emails: input.invitedEmails,
          targets: [{
            kind: 'conversation',
            workspaceId: asWorkspaceId(workspace.id),
            parentId: asWorkstreamId(created.workstream.id),
            substreamId: asSubstreamId('0'),
          }],
          completeWorkstream: false,
          expiresAt: null,
        }))
          // A People level opened while this was in flight read an empty list.
          .then(() => queryClient.invalidateQueries({ queryKey: ['scope-invitations', created.workstream.id] }))
          .catch((error: unknown) => logError('rally', `could not share the new channel with ${input.invitedEmails.join(', ')}`, error));
      }
      const selectedParticipants = (members.data ?? [])
        .filter((member) => input.participantIds.includes(member.id))
        .map((member) => ({ ...member, role: 'explicit' }));
      const detail: WorkstreamDetail = launchedWorkstreamDetail(created, {
          creator: workspace.currentUser,
          model: input.modelOverride,
          origin: 'opening_message',
          participants: selectedParticipants,
          startedAt: input.startedAt,
        });
      queryClient.setQueryData(['workstream', created.workstream.id], detail);
      queryClient.setQueryData(
        ['ordered-transcript', created.workstream.id],
        optimisticOpeningTranscript({
          turnId: created.turnId,
          clientMessageId: created.clientMessageId,
          createdAt: created.createdAt,
          text: input.openingMessage,
          mentions: input.mentions,
          attachments: input.attachments,
        }, workspace.currentUser, members.data ?? []),
      );
      void queryClient.invalidateQueries({ queryKey: ['workstream', created.workstream.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      attachmentDraft.consume(input.attachmentLocalIds);
      createTrace.current?.mark('cache_seed');
      void navigate(`/workstreams/${created.workstream.id}`);
      if (createTrace.current) holdCreationTraceUntilSendReady(
        createTrace.current,
        created.workstream.id,
        '0',
        createStartedAt.current === null ? 0 : Math.max(0, performance.now() - createStartedAt.current),
      );
      createTrace.current?.annotate({
        workstreamId: created.workstream.id,
        harnessRunId: created.harnessRunId,
      });
      createTrace.current = null;
      createStartedAt.current = null;
    },
  });

  /**
   * The composer's `onSend`. It has already cleared the draft, and restores it
   * if this rejects, so every refusal here throws rather than returns.
   */
  const submit = async (
    openingMessage: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
    _deliveryMode?: unknown,
    mentionedInvitees: string[] = [],
  ): Promise<void> => {
    // The composer keeps accepting Enter while it shows the create in flight,
    // and a second submit would start a second Channel. Throwing hands the new
    // words back to the draft.
    if (createPending.current) throw new Error('A channel is already being created');
    // Before the launch state, not after it. The screen below opens optimistically
    // on this keystroke, and a work stream that cannot be created must never be
    // one of the ones that appears to open.
    if (openingMessage.length > MESSAGE_MAX_CHARACTERS) {
      setTooLong(true);
      throw new Error(MESSAGE_TOO_LONG_MESSAGE);
    }
    setTooLong(false);
    createPending.current = true;
    const readyAttachments = attachmentDraft.ready;
    // Somebody named in the opening message is somebody this Channel is for, so
    // a mention adds them as surely as the Participants bar does.
    const participantIds = [...new Set([
      ...selectedMembers.filter((member) => !isInvitee(member)).map((member) => member.id),
      ...mentions.flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []),
      ...confirmedParticipantUserIds,
    ])].filter((id) => id !== workspace.currentUser.id);
    const invitedEmails = [...new Set([
      ...selectedMembers.filter(isInvitee).map((member) => member.email),
      ...mentionedInvitees,
    ])].sort();
    const createdAt = new Date().toISOString();
    const attachments = readyAttachments.map((attachment) => ({
      id: attachment.resource!.id,
      fileName: attachment.file.name,
      mimeType: attachment.file.type || 'application/octet-stream',
      sizeBytes: attachment.file.size,
      contentAvailable: true,
      createdAt,
    }));
    // Before the request, not after it: this is the whole point of the screen
    // below, and a state set in the same commit as the send is what makes the
    // work stream appear to open on the keystroke rather than on the response.
    setLaunching({ attachments, createdAt, openingMessage, mentions, startedAt: Date.parse(createdAt) });
    // The sidebar lists the Channel on the same keystroke, under the id the
    // server will create it with, so its row there is already the real one
    // and the server's answer only fills it in. Placed in exactly the Space
    // the request names, and Organization-wide, as the route creates it.
    const workstreamId = uuidV7();
    addPendingWorkstream(queryClient, {
      id: workstreamId,
      ...(channelName ? { title: channelName } : {}),
      spaceIds: [owningSpaceId],
      scope: 'workspace',
      harnessStatus: 'running',
      createdAt,
    });
    await create.mutateAsync({
      attachmentIds: readyAttachments.map((attachment) => attachment.resource!.id),
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments,
      modelOverride,
      openingMessage,
      mentions,
      participantIds,
      invitedEmails,
      workstreamId,
      startedAt: createdAt,
    });
  };

  /**
   * The Channel the composer is writing into, before it exists: the people in
   * the Participants bar, Organization-wide as every new Channel is born, and
   * no run to steer or stop.
   */
  const pendingChannel: ComposerConversation = {
    scope: 'workspace',
    harnessStatus: 'completed',
    stopRequested: false,
    participants: [
      { ...workspace.currentUser, role: 'creator' },
      ...selectedMembers.filter((member) => !isInvitee(member)).map((member) => ({ ...member, role: 'explicit' })),
    ],
  };

  // Text or files: `submit` accepts a create carrying only attachments, and
  // that turn is a bubble of tiles rather than an empty one.
  const openingMentions = launching
    ? optimisticMentionRendering(launching.openingMessage, launching.mentions, members.data ?? [])
    : null;
  const openingTurn: Message | null = launching && openingMentions
    ? {
      id: 'launching-opening-message',
      workstreamId: 'launching',
      sequenceNumber: 1,
      authorType: 'human',
      author: workspace.currentUser,
      messageType: 'text',
      text: openingMentions.text,
      mentions: openingMentions.mentions,
      attachments: launching.attachments,
      createdAt: launching.createdAt,
    }
    : null;

  if (spaces.data === undefined) {
    return <LoadingState label="Opening space…" />;
  }
  if (!owningSpace) {
    return <EmptyState title="Space not found" description="It may have been archived or you may no longer have access." />;
  }

  return (
    /* Both states are one element tree, and the launching one carries
       `workstream-screen` so it inherits that screen's own geometry rather than
       an approximation of it. The composer is never unmounted between them: it
       moves from the middle of the pane to the dock, and remounting it would
       break the hand-off into two separate objects. */
    <EmailMentionContext.Provider value={emailMentions}>
    <div className={clsx(
      'workstream-launch-screen new-chat-screen',
      launching && 'workstream-screen is-launching',
    )}>
      {!launching && <div className="screen-drag-strip window-drag" />}
      {!launching && canCloseNewChat && <button aria-label="Close new channel" className="new-chat-close window-no-drag" onClick={closeNewChat} type="button">
        <X aria-hidden="true" size={16} strokeWidth={1.7} />
      </button>}
      <header className="launch-header workstream-header window-drag">
        {launching && (
          <div className="workstream-header-left window-no-drag">
            <div className="workstream-title-block">
              <div className="workstream-title-line">
                <h1>{channelName || <TitleSkeleton className="title-skeleton-header" />}</h1>
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="launch-body">
        {launching && (
          <div className="launch-transcript-layer transcript-scroll">
            <div className="transcript-column">
              {openingTurn && (
                <div className="launch-arrival" style={{ '--arrival-index': 0 } as React.CSSProperties}>
                  <MessageBlock
                    currentUserId={workspace.currentUser.id}
                    loadAttachmentContent={api ? loadAttachmentContent : undefined}
                    message={openingTurn}
                    onAnswerElicitation={async () => undefined}
                    onOpenAttachment={setAttachmentPreview}
                  />
                </div>
              )}
              <div className="launch-arrival" style={{ '--arrival-index': openingTurn ? 1 : 0 } as React.CSSProperties}>
                {/* The run has not been admitted yet, but it is about to be and
                    the created stream keeps counting from this same instant, so
                    the timer does not restart at the swap. */}
                <AgentWorkTiming active durationMs={0} startedAt={launching.startedAt} />
              </div>
            </div>
          </div>
        )}
      </div>

      <section className="composer-dock launch-dock" aria-labelledby="new-workstream-heading">
        <h2 className="sr-only" id="new-workstream-heading">Start a new channel</h2>
        <div className="composer-stack">
          {/* Who the Channel is for, and where and under what name it lives:
              set beside the composer that starts it, and gone with the
              resting state once it does. */}
          {!launching && <div className="new-channel-setup">
            <NewChannelParticipants
              candidates={recipientCandidates}
              creator={workspace.currentUser}
              loading={members.isLoading}
              onAdd={selectRecipient}
              onRemove={removeRecipient}
              selected={selectedMembers}
            />
            <div className="new-channel-placement">
              <DropdownSelect
                ariaLabel="Space"
                onValueChange={setPickedSpaceId}
                options={spaceOptions}
                side="top"
                value={owningSpaceId}
                variant="pill"
              />
              <span aria-hidden="true" className="new-channel-placement-divider">/</span>
              <input
                aria-label="Name of channel"
                className="new-channel-name"
                maxLength={180}
                onChange={(event) => setChannelNameInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeNewChat();
                }}
                placeholder="Name this channel"
                type="text"
                value={channelNameInput}
              />
            </div>
          </div>}
          {/* The composer every conversation writes with. */}
          <WorkstreamComposer
            api={api ?? undefined}
            ariaLabel="Opening channel message"
            attachments={attachmentDraft.attachments}
            autoFocus
            draftKey={draftKey}
            error={(tooLong ? MESSAGE_TOO_LONG_MESSAGE : undefined) ?? create.error?.message ?? attachmentDraft.error}
            fileInputRef={fileInputRef}
            footerHint="Enter to create · Shift+Enter for a new line"
            members={members.data ?? []}
            invitees={visibleInvitees}
            model={{ kind: 'choice', value: modelOverride, onChange: setModelOverride }}
            onAttach={attachmentDraft.addFiles}
            onDraftChange={() => setTooLong(false)}
            onOpenAttachment={setAttachmentPreview}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSend={submit}
            onStop={async () => undefined}
            placeholder="Describe what this channel will be used for"
            // Not a cosmetic state: it is what freezes the attachment tiles and
            // the file input while the files they stand for are already on
            // their way into a message.
            sending={launching !== null}
            submitLabel="Create channel"
            uploading={attachmentDraft.uploading}
            workstream={pendingChannel}
          />
        </div>
        {members.error && !launching && <p className="muted-notice">People could not be loaded. You can still create this channel with yourself.</p>}
      </section>

      <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
    </div>
    </EmailMentionContext.Provider>
  );
}
