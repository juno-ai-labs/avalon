import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { optimisticOpeningTranscript } from '../lib/launched-conversation';
import type { MentionIdentity } from '../lib/api';
import { holdCreationTraceUntilSendReady, startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import { mentionOptionId, useMentionNavigation } from '../lib/use-mention-navigation';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import type { AgentModelOverride, CreatedWorkstream, Message, MessageAttachment, Workspace, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { type ComposerConversation, WorkstreamComposer } from '../components/workstream-composer';
import { Avatar, EmptyState, LoadingState, TitleSkeleton } from '../components/primitives';
import { MessageBlock } from '../components/workstream-blocks';

interface CreateWorkstreamInput {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
  mentions: MentionIdentity[];
  participantIds: string[];
  /**
   * The submit instant the launch surface has been counting from. Seeded onto
   * the created run so the work timer does not jump at the navigation; the
   * first refetch replaces it with the run's real start.
   */
  startedAt: string;
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

export function NewWorkstreamScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const owningSpaceId = useParams<{ spaceId: string }>().spaceId!;
  /**
   * The Spaces this Channel is being started in.
   *
   * A list rather than one id because a Channel belongs to as many Spaces as it
   * was put in, and the creation contract's field is `spaceIds`. Only the
   * sidebar's creation dialog reaches this screen, and it names one Space — but
   * a screen that held a single id would have to be rewritten by whoever adds
   * the second way in.
   */
  const owningSpaceIds = [owningSpaceId];
  const { api } = useAppSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const workspaceDraftKey = newWorkstreamDraftKey(workspace.region, workspace.id);
  const draftKey = `${workspaceDraftKey}:space:${owningSpaceIds.join(',')}`;
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  const [recipientQuery, setRecipientQuery] = useState('');
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false);
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
  const { active: spaces } = useSpaceDirectories();
  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  const recipientCandidates = useMemo(() => {
    const normalized = recipientQuery.trim().toLocaleLowerCase();
    return (members.data ?? [])
      .filter((member) => (
        member.id !== workspace.currentUser.id
        && (member.status ?? 'active') === 'active'
        && !selectedIds.has(member.id)
      ))
      .filter((member) => !normalized || `${member.name} ${member.email}`.toLocaleLowerCase().includes(normalized));
  }, [members.data, recipientQuery, selectedIds, workspace.currentUser.id]);
  const selectRecipient = useCallback((member: WorkspaceMember): void => {
    setSelectedMembers((current) => current.some((candidate) => candidate.id === member.id)
      ? current
      : [...current, member]);
    setRecipientQuery('');
    setRecipientPickerOpen(true);
    requestAnimationFrame(() => recipientInputRef.current?.focus());
  }, []);
  const recipientNavigation = useMentionNavigation(
    recipientPickerOpen ? recipientCandidates.map((member) => member.id) : [],
    (index) => {
      const member = recipientCandidates[index];
      if (member) selectRecipient(member);
    },
  );
  const removeRecipient = useCallback((memberId: string): void => {
    setSelectedMembers((current) => current.filter((member) => member.id !== memberId));
    setRecipientPickerOpen(true);
    requestAnimationFrame(() => recipientInputRef.current?.focus());
  }, []);
  const returnTo = typeof location.state === 'object'
      && location.state !== null
      && 'returnTo' in location.state
      && typeof location.state.returnTo === 'string'
      ? location.state.returnTo
      : null;
  const channelName = typeof location.state === 'object'
      && location.state !== null
      && 'channelName' in location.state
      && typeof location.state.channelName === 'string'
      ? location.state.channelName.trim()
      : '';
  const canCloseNewChat = Boolean(returnTo && returnTo !== location.pathname);
  const closeNewChat = useCallback((): void => {
    if (returnTo && returnTo !== location.pathname) {
      void navigate(returnTo, { replace: true });
      return;
    }
  }, [location.pathname, returnTo, navigate]);
  const owningSpace = spaces.data?.items.find((space) => owningSpaceIds.includes(space.id));
  // A personal Space decides who is in its Channels, so the bar shows the
  // Space's own roster and offers no way to change it.
  const participantsManagedBySpace = owningSpace?.scope === 'personal';
  const personalSpaceParticipantIds = useMemo(() => new Set(
    owningSpace?.scope === 'personal'
      ? owningSpace.participants.map((participant) => participant.userId as string)
      : [],
  ), [owningSpace]);
  useEffect(() => {
    if (owningSpace?.scope !== 'personal') return;
    setSelectedMembers((members.data ?? []).filter((member) => (
      member.id !== workspace.currentUser.id && personalSpaceParticipantIds.has(member.id)
    )));
  }, [members.data, owningSpace?.scope, personalSpaceParticipantIds, workspace.currentUser.id]);
  // Opened on the keystroke that starts a work stream and closed once the
  // route change is requested. The surface is optimistic — the work stream is
  // already on screen — so what this spans is the round trip behind it. Held in
  // a ref because the mutation's callbacks each run in their own commit.
  const createTrace = useRef<PerfTrace | null>(null);
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
        ...(channelName ? { title: channelName } : {}),
        openingMessage: input.openingMessage,
        participantIds: input.participantIds,
        spaceIds: owningSpaceIds,
        ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        requestId: trace.traceId,
        operationId: trace.traceId,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      }));
    },
    onError: () => {
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
        }, workspace.currentUser),
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
  ): Promise<void> => {
    // Before the launch state, not after it. The screen below opens optimistically
    // on this keystroke, and a work stream that cannot be created must never be
    // one of the ones that appears to open.
    if (openingMessage.length > MESSAGE_MAX_CHARACTERS) {
      setTooLong(true);
      throw new Error(MESSAGE_TOO_LONG_MESSAGE);
    }
    setTooLong(false);
    const readyAttachments = attachmentDraft.ready;
    // Somebody named in the opening message is somebody this Channel is for, so
    // a mention adds them as surely as the Participants bar does.
    const participantIds = [...new Set([
      ...selectedMembers.map((member) => member.id),
      ...mentions.flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []),
      ...confirmedParticipantUserIds,
    ])].filter((id) => id !== workspace.currentUser.id);
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
    setLaunching({ attachments, createdAt, openingMessage, startedAt: Date.parse(createdAt) });
    await create.mutateAsync({
      attachmentIds: readyAttachments.map((attachment) => attachment.resource!.id),
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments,
      modelOverride,
      openingMessage,
      mentions,
      participantIds,
      startedAt: createdAt,
    });
  };

  /**
   * The Channel the composer is writing into, before it exists: the people in
   * the Participants bar, the Space's scope — which decides whether mentioning
   * somebody outside them asks first — and no run to steer or stop.
   */
  const pendingChannel: ComposerConversation = {
    scope: owningSpace?.scope === 'personal' ? 'personal' : 'workspace',
    harnessStatus: 'completed',
    stopRequested: false,
    participants: [
      { ...workspace.currentUser, role: 'creator' },
      ...selectedMembers.map((member) => ({ ...member, role: 'explicit' })),
    ],
  };

  // Text or files: `submit` accepts a create carrying only attachments, and
  // that turn is a bubble of tiles rather than an empty one.
  const openingTurn: Message | null = launching
    ? {
      id: 'launching-opening-message',
      workstreamId: 'launching',
      sequenceNumber: 1,
      authorType: 'human',
      author: workspace.currentUser,
      messageType: 'text',
      text: launching.openingMessage,
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
       is the element the eye holds on to while everything around it changes,
       and remounting it would break the hand-off into two separate objects. */
    <div className={clsx(
      'workstream-launch-screen new-chat-screen',
      launching && 'workstream-screen is-launching',
    )}>
      {!launching && <div className="screen-drag-strip window-drag" />}
      <header className="launch-header workstream-header window-drag">
        {!launching && (
          <div className="new-chat-recipient-bar window-no-drag">
            <span className="new-chat-to-label" id="new-channel-participants-label">Participants:</span>
            <div
              aria-labelledby="new-channel-participants-label"
              className="new-chat-recipient-input-shell"
              role="group"
            >
              {/* The creator is always in the Channel, so their chip has no
                  remove control. */}
              <span className="new-chat-recipient-chip">
                <Avatar member={workspace.currentUser} size="small" />
                <span>{workspace.currentUser.name}</span>
              </span>
              {selectedMembers.map((member) => (
                <span className="new-chat-recipient-chip" key={member.id}>
                  <Avatar member={member} size="small" />
                  <span>{member.name}</span>
                  {!participantsManagedBySpace && <button
                    aria-label={`Remove ${member.name}`}
                    onClick={() => removeRecipient(member.id)}
                    type="button"
                  >
                    <X aria-hidden="true" size={13} strokeWidth={1.7} />
                  </button>}
                </span>
              ))}
              {participantsManagedBySpace ? (
                <span className="new-chat-recipient-note">Managed by the space</span>
              ) : <input
                aria-activedescendant={recipientNavigation.activeOptionId}
                aria-controls="new-chat-recipient-listbox"
                aria-expanded={recipientPickerOpen}
                aria-label="Search people"
                autoComplete="off"
                onChange={(event) => {
                  setRecipientQuery(event.currentTarget.value);
                  setRecipientPickerOpen(true);
                }}
                onFocus={() => setRecipientPickerOpen(true)}
                onKeyDown={(event) => {
                  if (event.metaKey && /^Digit[1-9]$/u.test(event.code)) {
                    const member = recipientCandidates[Number(event.code.slice(-1)) - 1];
                    if (member) {
                      event.preventDefault();
                      event.stopPropagation();
                      selectRecipient(member);
                    }
                    return;
                  }
                  if (recipientNavigation.handleKeyDown(event)) return;
                  if (event.key === 'Backspace' && recipientQuery.length === 0 && selectedMembers.length > 0) {
                    event.preventDefault();
                    removeRecipient(selectedMembers[selectedMembers.length - 1]!.id);
                    return;
                  }
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  if (recipientPickerOpen) setRecipientPickerOpen(false);
                  else closeNewChat();
                }}
                placeholder="Add people"
                ref={recipientInputRef}
                role="combobox"
                type="text"
                value={recipientQuery}
              />}
            </div>
            {canCloseNewChat && <button aria-label="Close new channel" className="new-chat-close" onClick={closeNewChat} type="button">
              <X aria-hidden="true" size={16} strokeWidth={1.7} />
            </button>}
          </div>
        )}
        {launching && (
          <div className="workstream-header-left window-no-drag">
            <div className="workstream-title-block">
              <div className="workstream-title-line">
                <h1>{channelName || <TitleSkeleton className="title-skeleton-header" />}</h1>
              </div>
            </div>
          </div>
        )}
        {!launching && !participantsManagedBySpace && recipientPickerOpen && (
          <div
            aria-label="People"
            className="new-chat-recipient-results window-no-drag"
            id="new-chat-recipient-listbox"
            role="listbox"
          >
            {members.isLoading ? (
              <p className="new-chat-recipient-empty">Loading people…</p>
            ) : recipientCandidates.length > 0 ? recipientCandidates.map((member, index) => (
              <button
                aria-label={`${member.name} — ${member.email}`}
                aria-selected={index === recipientNavigation.activeIndex}
                className={index === recipientNavigation.activeIndex ? 'is-selected' : undefined}
                id={mentionOptionId(member.id)}
                key={member.id}
                onClick={() => selectRecipient(member)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => recipientNavigation.setActiveIndex(index)}
                ref={index === recipientNavigation.activeIndex ? recipientNavigation.activeOptionRef : undefined}
                role="option"
                type="button"
              >
                <Avatar member={member} size="small" />
                <span className="new-chat-recipient-copy">
                  <strong>{member.name}</strong>
                </span>
                {index < 9 && (
                  <span aria-hidden="true" className="new-chat-recipient-shortcut">
                    <kbd>⌘</kbd><kbd>{index + 1}</kbd>
                  </span>
                )}
              </button>
            )) : (
              <p className="new-chat-recipient-empty">
                {recipientQuery.trim() ? 'No matching people' : 'Everyone available is selected'}
              </p>
            )}
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
        <div
          className="composer-stack"
          onFocusCapture={() => setRecipientPickerOpen(false)}
          onPointerDown={() => setRecipientPickerOpen(false)}
        >
          {/* The composer every conversation writes with, so the first message
              gets the same mentions, commands and draft handling as the rest.
              Keyed by the draft, which carries the Space: switching between
              Space launchers remounts it and restores initial focus. */}
          <WorkstreamComposer
            api={api ?? undefined}
            ariaLabel="Opening channel message"
            attachments={attachmentDraft.attachments}
            autoFocus
            draftKey={draftKey}
            error={(tooLong ? MESSAGE_TOO_LONG_MESSAGE : undefined) ?? create.error?.message ?? attachmentDraft.error}
            fileInputRef={fileInputRef}
            footerHint="Enter to create · Shift+Enter for a new line"
            key={draftKey}
            members={members.data ?? []}
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
  );
}
