import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { formatRelative } from '../lib/format';
import { useDraftText } from '../lib/use-draft-text';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import type { AgentModelOverride, CreatedWorkstream, Message, MessageAttachment, WorkOpportunity, Workspace, WorkspaceMember, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { type AttachmentPreview, AttachmentLightbox } from '../components/attachments';
import { ComposerInput } from '../components/composer-input';
import { Avatar, AvatarStack, AvalonMark, Button, Modal, StatusDot, TitleSkeleton } from '../components/primitives';
import { withSuggestedPrompts } from '../components/suggested-prompts';
import { MessageBlock } from '../components/workstream-blocks';

interface CreateWorkstreamInput {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
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
  /**
   * Which launcher started this. Suggested work is created from the suggestion
   * rather than from the composer, so its surface shows no opening turn and no
   * draft — anything sitting in the composer belongs to a work stream that has
   * not been started, and showing it here would attach it to one that has.
   */
  origin: 'composer' | 'suggested-work';
  /** Drives the work timer, which the created stream keeps counting from. */
  startedAt: number;
}

/**
 * The detail a just-created work stream is put into the cache under, so its
 * screen paints instead of loading.
 *
 * Both launchers seed through here. They differ only in what they can say about
 * the transcript — a typed create authored its opening turn, suggested work's is
 * the agent's — and if they differed in the detail as well, one of them would be
 * the path whose work timer silently stopped surviving the navigation.
 */
function launchedWorkstreamDetail(
  created: CreatedWorkstream,
  context: {
    creator: WorkspaceMember;
    origin: string;
    participants?: WorkspaceMember[];
    /** The instant the launch surface has been counting from. */
    startedAt: string;
  },
): WorkstreamDetail {
  return {
    ...created.workstream,
    createdAt: created.createdAt,
    createdBy: { ...context.creator, role: 'creator' },
    participants: [{ ...context.creator, role: 'creator' }, ...context.participants ?? []],
    viewers: [],
    resources: [],
    connections: [],
    artifacts: [],
    backgroundTasks: [],
    automationRuns: [],
    openElicitations: [],
    suggestions: [],
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
          startedAt: context.startedAt,
          createdAt: context.startedAt,
        },
      }
      : {}),
  };
}

/**
 * How long the home content stays mounted fading out under the transcript that
 * replaced it. The stylesheet animates over the same span, so the two have to
 * agree — the same contract `RAIL_CROSSFADE_MS` keeps for the right sidebar.
 */
const HOME_HAND_OFF_MS = 190;

/**
 * Whether the home content is still on screen fading out over the work stream
 * being created. Only arriving at the launching state has anything to fade: a
 * create that fails puts the launcher back, and the person it failed for is
 * owed it immediately rather than after an animation.
 */
function useHomeHandOff(launching: boolean): boolean {
  const [shown, setShown] = useState(launching);
  // A second launch can begin while the first hand-off is still pending — a
  // create that failed, retried straight away. Storing a boolean would be an
  // equal value, React would bail out, and the first departure's timer would
  // end the second fade early. The count makes every departure distinct.
  const [departure, setDeparture] = useState<number | null>(null);

  if (shown !== launching) {
    setShown(launching);
    if (launching) setDeparture((current) => (current ?? 0) + 1);
  }

  useEffect(() => {
    if (departure === null) return undefined;
    const timer = window.setTimeout(() => setDeparture(null), HOME_HAND_OFF_MS);
    return () => window.clearTimeout(timer);
  }, [departure]);

  return launching && departure !== null;
}

const WorkSuggestedPrompts = withSuggestedPrompts<{
  items: WorkOpportunity[];
  pendingId: string | null;
  error?: string;
  onSelect: (item: WorkOpportunity) => void;
  onDismiss: (item: WorkOpportunity) => void;
}>(({ items, pendingId, error, onSelect, onDismiss }) => ({
  label: 'Suggested work',
  items: items.map((item) => ({
    id: item.id,
    text: item.displayPrompt,
    icon: item.icon,
    sourceLabel: item.sourceLabel,
  })),
  pendingId,
  ...(error ? { error } : {}),
  onSelect: (selected) => {
    const opportunity = items.find((item) => item.id === selected.id);
    if (opportunity) onSelect(opportunity);
  },
  onDismiss: (selected) => {
    const opportunity = items.find((item) => item.id === selected.id);
    if (opportunity) onDismiss(opportunity);
  },
}));

function WaitingWorkstreamRow({ workstream }: { workstream: WorkstreamSummary }): React.JSX.Element {
  const summary = workstream.preview ?? workstream.objective ?? workstream.automationName;
  return (
    <NavLink className="waiting-workstream-row" to={`/workstreams/${workstream.id}`}>
      <StatusDot status="needs_input" />
      <span className="waiting-workstream-copy">
        <strong>{workstream.title}</strong>
        {summary && <span>{summary}</span>}
      </span>
      {workstream.origin === 'automation' && workstream.automationName && (
        <span className="waiting-workstream-source">{workstream.automationName}</span>
      )}
      <time dateTime={workstream.lastActivityAt}>{formatRelative(workstream.lastActivityAt)}</time>
      <ChevronRight aria-hidden="true" size={15} />
    </NavLink>
  );
}

function ParticipantPicker({
  currentUser,
  members,
  open,
  selected,
  onOpenChange,
  onToggle,
}: {
  currentUser: WorkspaceMember;
  members: WorkspaceMember[];
  open: boolean;
  selected: Set<string>;
  onOpenChange: (open: boolean) => void;
  onToggle: (member: WorkspaceMember) => void;
}): React.JSX.Element {
  return (
    <Modal
      description="Only individual workspace members can be added in this version."
      footer={<Button className="button-primary" onClick={() => onOpenChange(false)}>Done</Button>}
      onOpenChange={onOpenChange}
      open={open}
      title="Add people"
    >
      <div className="member-picker-list" role="group" aria-label="Workspace members">
        {members
          .filter((member) => member.id !== currentUser.id)
          .map((member) => (
            <label className="member-picker-row" key={member.id}>
              <input
                checked={selected.has(member.id)}
                onChange={() => onToggle(member)}
                type="checkbox"
              />
              <Avatar member={member} size="medium" />
              <span><strong>{member.name}</strong><small>{member.email}</small></span>
              <span aria-hidden="true" className="member-checkbox" />
            </label>
          ))}
      </div>
    </Modal>
  );
}

export function NewWorkstreamScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const opportunityKeys = useRef(new Map<string, string>());
  // The instant the suggested-work surface started counting from, carried to
  // `onSuccess` so the seeded run continues it rather than restarting.
  const opportunityStartedAt = useRef<string | null>(null);
  const draftKey = newWorkstreamDraftKey(workspace.id);
  const { text: message, setText: setMessage } = useDraftText(draftKey);
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Not kept in the draft cache: the draft outlives the session, and a model
  // pinned last week is not a choice anyone would expect to still be in force.
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [launching, setLaunching] = useState<LaunchingWorkstream | null>(null);
  const homeLeaving = useHomeHandOff(launching !== null);
  const attachmentDraft = useFileAttachments(api, draftKey);
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal),
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
  // The same list the sidebar shows, from the same cache entry, so a realtime
  // update lands on both at once.
  const workstreams = useWorkstreamsQuery();
  const opportunities = useQuery({
    queryKey: ['work-opportunities'],
    queryFn: ({ signal }) => api!.getWorkOpportunities(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  const waitingWorkstreams = useMemo(
    () => (workstreams.data ?? [])
      .filter((workstream) => workstream.harnessStatus === 'needs_input')
      .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()),
    [workstreams.data],
  );

  const create = useMutation({
    mutationFn: (input: CreateWorkstreamInput) =>
      api!.createWorkstream({
        openingMessage: input.openingMessage,
        participantIds: input.participantIds,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      }),
    onError: (_error, input) => {
      // Back to the launcher with the words still in it. The optimistic turn
      // stood for a work stream that does not exist, so it cannot stay on
      // screen next to an error about why.
      setLaunching(null);
      setMessage((current) => current.length > 0 ? current : input.openingMessage);
    },
    onSettled: () => {
      submittingRef.current = false;
    },
    onSuccess: (created, input) => {
      const selectedParticipants = (members.data ?? [])
        .filter((member) => input.participantIds.includes(member.id))
        .map((member) => ({ ...member, role: 'explicit' }));
      const detail: WorkstreamDetail = launchedWorkstreamDetail(created, {
          creator: workspace.currentUser,
          origin: 'opening_message',
          participants: selectedParticipants,
          startedAt: input.startedAt,
        });
      const openingMessage: Message = {
        id: created.messageId,
        clientMessageId: created.clientMessageId,
        workstreamId: created.workstream.id,
        sequenceNumber: 1,
        authorType: 'human',
        author: workspace.currentUser,
        messageType: 'text',
        text: input.openingMessage,
        attachments: input.attachments,
        createdAt: created.createdAt,
      };
      queryClient.setQueryData(['workstream', created.workstream.id], detail);
      queryClient.setQueryData(['messages', created.workstream.id], [openingMessage]);
      queryClient.setQueryData(['messages-cursor', created.workstream.id], null);
      void queryClient.invalidateQueries({ queryKey: ['workstream', created.workstream.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['messages', created.workstream.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      attachmentDraft.consume(input.attachmentLocalIds);
      void navigate(`/workstreams/${created.workstream.id}`);
    },
  });

  const startOpportunity = useMutation({
    mutationFn: (opportunity: WorkOpportunity) => {
      const key = opportunityKeys.current.get(opportunity.id) ?? crypto.randomUUID();
      opportunityKeys.current.set(opportunity.id, key);
      return api!.startWorkOpportunity(opportunity.id, opportunity.version, key);
    },
    // Suggested work opens onto the same surface, minus the opening turn: that
    // one is written by the agent from the expanded prompt, so there is nothing
    // here that could stand in for it without inventing what it says.
    onMutate: () => {
      const createdAt = new Date().toISOString();
      opportunityStartedAt.current = createdAt;
      setLaunching({
        attachments: [],
        createdAt,
        openingMessage: '',
        origin: 'suggested-work',
        startedAt: Date.parse(createdAt),
      });
    },
    onError: () => setLaunching(null),
    onSuccess: (created, opportunity) => {
      opportunityKeys.current.delete(opportunity.id);
      // Seeded for the same reason the typed path is: without it the work-stream
      // screen has neither query and shows its full-screen `Opening work stream…`
      // state, cutting away from a surface that was already showing this work
      // stream. The transcript is seeded empty rather than invented — the opening
      // turn here is the agent's, and it arrives with the refetch a moment later.
      const detail = launchedWorkstreamDetail(created, {
        creator: workspace.currentUser,
        origin: 'suggested_work',
        startedAt: opportunityStartedAt.current ?? created.createdAt,
      });
      queryClient.setQueryData(['workstream', created.workstream.id], detail);
      queryClient.setQueryData(['messages', created.workstream.id], []);
      queryClient.setQueryData(['messages-cursor', created.workstream.id], null);
      void queryClient.invalidateQueries({ queryKey: ['workstream', created.workstream.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['messages', created.workstream.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['work-opportunities'] });
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      void navigate(`/workstreams/${created.workstream.id}`);
    },
  });

  const dismissOpportunity = useMutation({
    mutationFn: (opportunity: WorkOpportunity) => api!.dismissWorkOpportunity(opportunity.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-opportunities'] }),
  });

  const impressionKey = (opportunities.data ?? []).map((item) => `${item.id}:${item.version}`).join('|');
  useEffect(() => {
    const ids = (opportunities.data ?? []).map((item) => item.id);
    if (ids.length > 0) void api?.recordWorkOpportunityImpressions(ids);
  }, [api, impressionKey]);

  const submit = (): void => {
    const openingMessage = message.trim();
    const readyAttachments = attachmentDraft.ready;
    if ((!openingMessage && readyAttachments.length === 0) || attachmentDraft.uploading || submittingRef.current) return;
    submittingRef.current = true;
    const participantIds = selectedMembers.map((member) => member.id);
    setMessage('');
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
    setLaunching({ attachments, createdAt, openingMessage, origin: 'composer', startedAt: Date.parse(createdAt) });
    create.mutate({
      attachmentIds: readyAttachments.map((attachment) => attachment.resource!.id),
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments,
      modelOverride,
      openingMessage,
      participantIds,
      startedAt: createdAt,
    });
  };

  // Suggested work is not created from the composer, so the draft sitting in it
  // is held back rather than shown attached to the work stream being started.
  // Nothing is discarded: it is still in state and still in the draft cache, and
  // it comes back the moment the launch ends either way.
  const draftHidden = launching?.origin === 'suggested-work';
  const participants = [workspace.currentUser, ...selectedMembers];
  const participantSummary = participants.length <= 2
    ? participants.map((participant) => participant.name).join(', ')
    : `${workspace.currentUser.name} +${participants.length - 1}`;
  // Text or files: `submit` accepts a create carrying only attachments, and
  // that turn is a bubble of tiles rather than an empty one. Suggested work is
  // the only launch with no turn at all — its opening message is the agent's,
  // written from the expanded prompt, and nothing here could stand in for it.
  const openingTurn: Message | null = launching?.origin === 'composer'
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

  return (
    /* Both states are one element tree, and the launching one carries
       `workstream-screen` so it inherits that screen's own geometry rather than
       an approximation of it. The composer is never unmounted between them: it
       is the element the eye holds on to while everything around it changes,
       and remounting it would break the hand-off into two separate objects. */
    <div className={clsx('workstream-launch-screen', launching && 'workstream-screen is-launching')}>
      {!launching && <div className="screen-drag-strip window-drag" />}
      <header className="launch-header workstream-header window-drag">
        {launching && (
          <div className="workstream-header-left window-no-drag">
            <div className="workstream-title-block">
              {/* The same skeleton the created work stream shows while the
                  naming agent answers, so the header does not change hands at
                  the swap — it is already waiting for the same name. */}
              <div className="workstream-title-line">
                <h1><TitleSkeleton className="title-skeleton-header" /></h1>
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="launch-body">
        {(!launching || homeLeaving) && (
          <div className={clsx('launch-home-layer', launching && 'is-leaving')} inert={Boolean(launching)}>
            <div className="new-workstream-home">
              <header className="new-workstream-welcome">
                <AvalonMark className="new-workstream-welcome-mark" />
                <h1>Welcome back, {workspace.currentUser.name.split(/\s+/u)[0]}</h1>
              </header>

              {waitingWorkstreams.length > 0 && (
                <section className="waiting-workstreams" aria-labelledby="waiting-workstreams-heading">
                  <h2 id="waiting-workstreams-heading">Waiting for input</h2>
                  <div className="waiting-workstream-list">
                    {waitingWorkstreams.map((workstream) => <WaitingWorkstreamRow key={workstream.id} workstream={workstream} />)}
                  </div>
                </section>
              )}

              <WorkSuggestedPrompts
                error={opportunities.error?.message ?? startOpportunity.error?.message ?? dismissOpportunity.error?.message}
                items={opportunities.data ?? []}
                onDismiss={(opportunity) => dismissOpportunity.mutate(opportunity)}
                onSelect={(opportunity) => startOpportunity.mutate(opportunity)}
                pendingId={startOpportunity.isPending
                  ? startOpportunity.variables?.id ?? null
                  : dismissOpportunity.isPending ? dismissOpportunity.variables?.id ?? null : null}
              />

            </div>
          </div>
        )}

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
                    onResolveSuggestion={async () => undefined}
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
        <h2 className="sr-only" id="new-workstream-heading">Start a new work stream</h2>
        <div className="launch-modifiers">
          <div className="new-workstream-modifiers" aria-label="Work-stream participants">
            <button
              aria-haspopup="dialog"
              aria-label={`Manage participants: ${participants.map((participant) => participant.name).join(', ')}`}
              className="participant-modifier"
              onClick={() => setPickerOpen(true)}
              type="button"
            >
              <span aria-hidden="true"><AvatarStack limit={4} members={participants} /></span>
              <span>{participantSummary}</span>
            </button>
            <button aria-label="Add people" className="participant-modifier-add" onClick={() => setPickerOpen(true)} type="button">
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>
        </div>

        <div className="composer-stack">
          <ComposerInput
            api={api ?? undefined}
            ariaLabel="Opening work-stream message"
            attachments={draftHidden ? [] : attachmentDraft.attachments}
            autoFocus
            className="launch-composer"
            error={create.error?.message ?? attachmentDraft.error}
            fileInputRef={fileInputRef}
            footerHint="Enter to create · Shift+Enter for a new line"
            maxHeight={220}
            modelOverride={{ value: modelOverride, onChange: setModelOverride }}
            onAttach={attachmentDraft.addFiles}
            onMention={() => setPickerOpen(true)}
            onOpenAttachment={setAttachmentPreview}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSubmit={submit}
            // Held back rather than merely hidden: the composer is controlled,
            // so a keystroke during a suggested-work launch would otherwise
            // write the empty value it is being shown back over the draft it is
            // hiding, and lose it.
            onValueChange={(value) => { if (!draftHidden) setMessage(value); }}
            placeholder="Describe a task or ask a question…"
            rows={2}
            submitDisabled={attachmentDraft.uploading || (!message.trim() && attachmentDraft.ready.length === 0) || launching !== null}
            submitLabel="Create work stream"
            // Not a cosmetic state: it is what freezes the attachment tiles and
            // the file input while the files they stand for are already on
            // their way into a message.
            submitting={launching !== null}
            uploading={attachmentDraft.uploading}
            value={draftHidden ? '' : message}
          />
        </div>
        {members.error && !launching && <p className="muted-notice">People could not be loaded. You can still create this work stream with yourself.</p>}
      </section>

      <ParticipantPicker
        currentUser={workspace.currentUser}
        members={members.data ?? []}
        onOpenChange={setPickerOpen}
        onToggle={(member) => {
          setSelectedMembers((current) =>
            current.some((candidate) => candidate.id === member.id)
              ? current.filter((candidate) => candidate.id !== member.id)
              : [...current, member],
          );
        }}
        open={pickerOpen}
        selected={selectedIds}
      />
      <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
    </div>
  );
}
