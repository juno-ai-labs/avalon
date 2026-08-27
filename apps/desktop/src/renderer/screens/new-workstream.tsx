import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE, type ProjectSummary } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import {
  completeMentionAtCaret,
  mentionsInTrimmedText,
  rebaseMentionIdentities,
  upsertMentionIdentity,
} from '../lib/mention-draft';
import { formatRelative, workstreamMarkerStatus, workstreamNeedsAttention } from '../lib/format';
import { PERSON_MENTION_TYPE } from '../lib/mention-constants';
import type { MentionIdentity } from '../lib/api';
import { startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import { useDraftText } from '../lib/use-draft-text';
import { draftWithMentionStarted, mentionOptionId, mentionQueryAtCaret, useMentionNavigation } from '../lib/use-mention-navigation';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import type { AgentModelOverride, CreatedWorkstream, Message, MessageAttachment, MessageMention, WorkOpportunity, Workspace, WorkspaceMember, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { ComposerInput } from '../components/composer-input';
import { Avatar, AvatarStack, RallyMark, Badge, Button, Modal, StatusDot, TitleSkeleton } from '../components/primitives';
import { withSuggestedPrompts } from '../components/suggested-prompts';
import { MessageBlock } from '../components/workstream-blocks';
import { ProjectIconPile } from '../components/project-sidebar-section';

interface CreateWorkstreamInput {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
  mentions: MentionIdentity[];
  participantIds: string[];
  /** User-edit generation at submit; programmatic clearing does not advance it. */
  draftRevision: number;
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

/** Presentation metadata for the accepted optimistic turn seeded after create. */
function optimisticMessageMentions(mentions: readonly MentionIdentity[]): MessageMention[] {
  return mentions.flatMap((mention) => (
    mention.startOffset === undefined || mention.endOffset === undefined
      ? []
      : [{
          type: mention.type,
          ...(mention.userId ? { personId: mention.userId } : {}),
          ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
          displayName: mention.label,
          startOffset: mention.startOffset,
          endOffset: mention.endOffset,
        }]
  ));
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
     * run so the work stream's own model pill opens on the name the composer's
     * selector was showing a moment ago instead of falling back to **Default**
     * until the refetch answers. Absent means unpinned, which the flag decides
     * and this process cannot see.
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
    createdBy: { ...context.creator, role: 'creator' },
    participants: [{ ...context.creator, role: 'creator' }, ...context.participants ?? []],
    viewers: [],
    resources: [],
    connections: [],
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
          ...(context.model ? { model: context.model } : {}),
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

function AttentionWorkstreamRow({ projects, workstream }: { projects: ProjectSummary[]; workstream: WorkstreamSummary }): React.JSX.Element {
  const summary = workstream.preview ?? workstream.objective ?? workstream.automationName;
  return (
    <NavLink className="waiting-workstream-row" to={`/workstreams/${workstream.id}`}>
      {/* Read from the work stream rather than hard-coded, now that three states
          land a row here and they do not mean the same thing — and through the
          same ranking the sidebar dot uses, so one work stream does not show
          two different markers on two screens. */}
      <StatusDot status={workstreamMarkerStatus(workstream)} />
      <ProjectIconPile projects={projects.filter((project) => project.workstreamIds.includes(workstream.id))} />
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
  const availableMembers = members.filter((member) => member.id !== currentUser.id);
  const firstCheckboxRef = useRef<HTMLInputElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      description="Only individual workspace members can be added in this version."
      footer={<Button ref={doneButtonRef} className="button-primary" onClick={() => onOpenChange(false)}>Done</Button>}
      initialFocusRef={availableMembers.length > 0 ? firstCheckboxRef : doneButtonRef}
      onOpenChange={onOpenChange}
      open={open}
      title="Add people"
    >
      <div className="member-picker-list" role="group" aria-label="Workspace members">
        {availableMembers
          .map((member, index) => (
            <label className="member-picker-row" key={member.id}>
              <input
                checked={selected.has(member.id)}
                onChange={() => onToggle(member)}
                ref={index === 0 ? firstCheckboxRef : undefined}
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

export function NewWorkstreamScreen({ workspace, projectId }: { workspace: Workspace; projectId?: string }): React.JSX.Element {
  const routeProjectId = useParams<{ projectId: string }>().projectId;
  const owningProjectId = projectId === 'route' ? routeProjectId : projectId;
  const { api } = useAppSession();
  const featureFlags = useClientFeatureFlags(api);
  const suggestedWorkEnabled = featureFlags.data?.suggestedWorkEnabled === true;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const opportunityKeys = useRef(new Map<string, string>());
  // The instant the suggested-work surface started counting from, carried to
  // `onSuccess` so the seeded run continues it rather than restarting.
  const opportunityStartedAt = useRef<string | null>(null);
  const draftKey = owningProjectId ? `${newWorkstreamDraftKey(workspace.id)}:project:${owningProjectId}` : newWorkstreamDraftKey(workspace.id);
  const {
    text: message,
    setText: setMessage,
    mentions: selectedMentions,
    setMentions: setSelectedMentions,
  } = useDraftText(draftKey);
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
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
  const homeLeaving = useHomeHandOff(launching !== null);
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
  // The same list the sidebar shows, from the same cache entry, so a realtime
  // update lands on both at once.
  const workstreams = useWorkstreamsQuery();
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api!.getProjects(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const opportunities = useQuery({
    queryKey: ['work-opportunities'],
    queryFn: ({ signal }) => api!.getWorkOpportunities(signal),
    enabled: Boolean(api && suggestedWorkEnabled),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  // Everything somebody put in front of this person: a run stopped for an
  // answer, a mention, and a work stream somebody added them to that they have
  // not opened. All three have a person behind them, which is what the section
  // is for and what keeps it short enough to scan — being merely unread is not
  // one of them, and listing it swamped the rest. The newest activity is the
  // one worth looking at first, so the list is ordered by that rather than by
  // which of the states a row happens to be in.
  const attentionWorkstreams = useMemo(
    () => (workstreams.data ?? [])
      .filter((workstream) => workstreamNeedsAttention(workstream))
      .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()),
    [workstreams.data],
  );

  // Opened on the keystroke that starts a work stream and closed once the
  // route change is requested. The surface is optimistic — the work stream is
  // already on screen — so what this spans is the round trip behind it. Held in
  // a ref because the mutation's callbacks each run in their own commit.
  const createTrace = useRef<PerfTrace | null>(null);
  const create = useMutation({
    mutationFn: (input: CreateWorkstreamInput) => {
      // A second create starting while one is in flight would otherwise drop
      // the first trace on the floor, silently losing the slower of the two.
      createTrace.current?.end({ outcome: 'superseded' });
      const trace = startPerfTrace('workstream_create');
      createTrace.current = trace;
      trace.annotate({
        participantCount: input.participantIds.length,
        attachmentCount: input.attachmentIds.length,
        openingMessageLength: input.openingMessage.length,
      });
      return trace.step('create_request', () => api!.createWorkstream({
        ...(owningProjectId ? { projectId: owningProjectId } : {}),
        openingMessage: input.openingMessage,
        participantIds: input.participantIds,
        ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        requestId: trace.traceId,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      }));
    },
    onError: (_error, input) => {
      createTrace.current?.end({ outcome: 'failed' });
      createTrace.current = null;
      // Back to the launcher with the words still in it. The optimistic turn
      // stood for a work stream that does not exist, so it cannot stay on
      // screen next to an error about why.
      setLaunching(null);
      // Restore one coherent submitted snapshot only when no user edit landed
      // after submit. Text and identity spans must never come from different
      // draft generations.
      if (draftRevisionRef.current === input.draftRevision) {
        setMessage(input.openingMessage);
        setSelectedMentions(input.mentions);
      }
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
          model: input.modelOverride,
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
        mentions: optimisticMessageMentions(input.mentions),
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
      createTrace.current?.mark('cache_seed');
      void navigate(`/workstreams/${created.workstream.id}`);
      // `navigation_requested`, not `navigated`: the route update is scheduled
      // here and this trace closes before React commits it. The distinction is
      // small because the surface is optimistic — the person has been looking
      // at the work stream since the keystroke, so what this measures is the
      // round trip behind a screen they already have, not a wait for one.
      createTrace.current?.end({
        outcome: 'navigation_requested',
        workstreamId: created.workstream.id,
        harnessRunId: created.harnessRunId,
      });
      createTrace.current = null;
    },
  });

  const startOpportunity = useMutation({
    mutationFn: (opportunity: WorkOpportunity) => {
      const key = opportunityKeys.current.get(opportunity.id) ?? crypto.randomUUID();
      opportunityKeys.current.set(opportunity.id, key);
      const position = (opportunities.data ?? []).findIndex((item) => item.id === opportunity.id) + 1;
      return api!.startWorkOpportunity(opportunity.id, opportunity.version, key, 'workspace_home', position);
    },
    // Suggested work opens onto the same surface, minus the opening turn. That
    // turn is attributed to the person selecting the suggestion, but its text is
    // the expanded brief, which the server holds and this list has never seen —
    // only the one-line `displayPrompt`. Standing that line in for the brief
    // would show them a turn that is replaced by a different, much longer one
    // the moment the refetch lands.
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
      // stream. The transcript is seeded empty rather than invented — the brief
      // that opening turn carries is written server-side, and it arrives with the
      // refetch a moment later.
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
    mutationFn: (opportunity: WorkOpportunity) => api!.dismissWorkOpportunity(
      opportunity.id,
      opportunity.version,
      (opportunities.data ?? []).findIndex((item) => item.id === opportunity.id) + 1,
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-opportunities'] }),
  });

  const impressionKey = (opportunities.data ?? []).map((item) => `${item.id}:${item.version}`).join('|');
  useEffect(() => {
    if (!suggestedWorkEnabled) return;
    const ids = (opportunities.data ?? []).map((item) => item.id);
    if (ids.length > 0) void api?.recordWorkOpportunityImpressions(ids);
  }, [api, impressionKey, suggestedWorkEnabled]);

  const submit = (): void => {
    const submitted = mentionsInTrimmedText(message, selectedMentions);
    const openingMessage = submitted.text;
    const readyAttachments = attachmentDraft.ready;
    if ((!openingMessage && readyAttachments.length === 0) || attachmentDraft.uploading || submittingRef.current) return;
    // Before the launch state, not after it. The screen below opens optimistically
    // on this keystroke, and a work stream that cannot be created must never be
    // one of the ones that appears to open.
    if (openingMessage.length > MESSAGE_MAX_CHARACTERS) {
      setTooLong(true);
      return;
    }
    setTooLong(false);
    submittingRef.current = true;
    const participantIds = selectedMembers.map((member) => member.id);
    const mentions = submitted.mentions;
    setMessage('');
    setSelectedMentions([]);
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
      mentions,
      participantIds,
      draftRevision: draftRevisionRef.current,
      startedAt: createdAt,
    });
  };

  // Suggested work is not created from the composer, so the draft sitting in it
  // is held back rather than shown attached to the work stream being started.
  // Nothing is discarded: it is still in state and still in the draft cache, and
  // it comes back the moment the launch ends either way.
  const draftHidden = launching?.origin === 'suggested-work';
  const participants = [workspace.currentUser, ...selectedMembers];
  // A membership that is not active is one the work-stream endpoints refuse, so
  // neither the inline list nor the dialog may offer it: picking one here also
  // adds them to the create request, which would then fail as a whole.
  const activeMembers = useMemo(
    () => (members.data ?? []).filter((member) => (member.status ?? 'active') === 'active'),
    [members.data],
  );
  const mentionCandidates = activeMembers;
  const mentionLabels = useMemo(() => mentionCandidates.map((member) => member.name), [mentionCandidates]);
  const visibleCandidates = mentionQuery === null
    ? []
    : mentionCandidates.filter((member) => member.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);
  const mentionNavigation = useMentionNavigation(
    visibleCandidates.map((member) => member.id),
    (index) => {
      const member = visibleCandidates[index];
      if (member) insertMention(member);
    },
  );

  const updateMessage = (value: string): void => {
    draftRevisionRef.current += 1;
    setMessage(value);
    setSelectedMentions((current) => rebaseMentionIdentities(message, value, current));
    syncMentionQuery(value);
  };

  /** What the caret is naming, recomputed as the draft changes. */
  const syncMentionQuery = (value: string): void => {
    setMentionQuery(mentionQueryAtCaret(value, textareaRef.current?.selectionStart));
  };

  /**
   * The caret moved without the draft changing — an arrow key, a click, a drag.
   * This may only *close* the list: a list that outlives the mention the caret
   * was in still answers `Enter` and inserts against an `@` the caret has left.
   * It may not open one, or `Escape` would last exactly until the next arrow
   * key, and wandering back through an old mention would raise a list nobody
   * asked for.
   */
  const refreshOpenMentionQuery = (value: string): void => {
    setMentionQuery((current) => current === null
      ? null
      : mentionQueryAtCaret(value, textareaRef.current?.selectionStart));
  };

  const beginMention = (): void => {
    const started = draftWithMentionStarted(
      message,
      textareaRef.current?.selectionStart,
      textareaRef.current?.selectionEnd,
    );
    draftRevisionRef.current += 1;
    setMessage(started.value);
    setMentionQuery('');
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      // Only while the draft is still the one this opened. A frame is enough
      // room for a keystroke, and putting the caret back where the `@` went
      // would drag it out of whatever was typed in the meantime.
      if (textarea?.value === started.value) textarea.setSelectionRange(started.caret, started.caret);
    });
  };

  /** Names the person in both the visible draft and its identity-bearing span. */
  const insertMention = (member: WorkspaceMember): void => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? message.length;
    const completed = completeMentionAtCaret(message, caret, member.name, textarea?.selectionEnd ?? caret);
    // The caret has left the mention this list belongs to; there is nothing
    // here to complete, and `slice(0, -1)` would eat the character before it.
    if (!completed) {
      setMentionQuery(null);
      return;
    }
    draftRevisionRef.current += 1;
    setMessage(completed.text);
    setSelectedMentions((current) => upsertMentionIdentity(
      rebaseMentionIdentities(message, completed.text, current),
      {
        type: 'person',
        label: member.name,
        userId: member.id,
        connectorType: null,
        startOffset: completed.startOffset,
        endOffset: completed.endOffset,
      },
    ));
    if (member.id !== workspace.currentUser.id) {
      setSelectedMembers((current) => current.some((candidate) => candidate.id === member.id) ? current : [...current, member]);
    }
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(completed.caret, completed.caret);
    });
  };
  const participantSummary = participants.length <= 2
    ? participants.map((participant) => participant.name).join(', ')
    : `${workspace.currentUser.name} +${participants.length - 1}`;
  // Text or files: `submit` accepts a create carrying only attachments, and
  // that turn is a bubble of tiles rather than an empty one. Suggested work is
  // the only launch with no turn at all — its opening turn is the selecting
  // member's, but the brief it carries is expanded server-side and the client
  // holds only the one-line suggestion, which is not the same text.
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
                <RallyMark className="new-workstream-welcome-mark" />
                <h1>{owningProjectId ? 'New project work stream' : `Welcome back, ${workspace.currentUser.name.split(/\s+/u)[0]}`}</h1>
              </header>

              {!owningProjectId && attentionWorkstreams.length > 0 && (
                <section className="waiting-workstreams" aria-labelledby="attention-workstreams-heading">
                  <h2 id="attention-workstreams-heading">Needs attention</h2>
                  <div className="waiting-workstream-list">
                    {attentionWorkstreams.map((workstream) => <AttentionWorkstreamRow key={workstream.id} projects={projects.data?.items ?? []} workstream={workstream} />)}
                  </div>
                </section>
              )}

              {!owningProjectId && suggestedWorkEnabled && (
                <WorkSuggestedPrompts
                  error={opportunities.error?.message ?? startOpportunity.error?.message ?? dismissOpportunity.error?.message}
                  items={opportunities.data ?? []}
                  onDismiss={(opportunity) => dismissOpportunity.mutate(opportunity)}
                  onSelect={(opportunity) => startOpportunity.mutate(opportunity)}
                  pendingId={startOpportunity.isPending
                    ? startOpportunity.variables?.id ?? null
                    : dismissOpportunity.isPending ? dismissOpportunity.variables?.id ?? null : null}
                />
              )}

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
          {visibleCandidates.length > 0 && (
            <div className="mention-popover" id="launch-mention-listbox" role="listbox" aria-label="Mentions">
              {visibleCandidates.map((member, index) => (
                <button
                  aria-label={`${member.name} — ${member.email} — ${PERSON_MENTION_TYPE}`}
                  aria-selected={index === mentionNavigation.activeIndex}
                  className={index === mentionNavigation.activeIndex ? 'is-selected' : undefined}
                  id={mentionOptionId(member.id)}
                  key={member.id}
                  onClick={() => insertMention(member)}
                  onMouseMove={() => mentionNavigation.setActiveIndex(index)}
                  ref={index === mentionNavigation.activeIndex ? mentionNavigation.activeOptionRef : undefined}
                  role="option"
                  type="button"
                >
                  <span aria-hidden="true" className="mention-icon">
                    <Avatar member={member} size="small" />
                  </span>
                  <span><strong>{member.name}</strong><small>{member.email}</small></span>
                  <Badge>{PERSON_MENTION_TYPE}</Badge>
                </button>
              ))}
            </div>
          )}
          <ComposerInput
            api={api ?? undefined}
            ariaLabel="Opening work-stream message"
            attachments={draftHidden ? [] : attachmentDraft.attachments}
            autoFocus
            className="launch-composer"
            error={(tooLong ? MESSAGE_TOO_LONG_MESSAGE : undefined) ?? create.error?.message ?? attachmentDraft.error}
            fileInputRef={fileInputRef}
            footerHint="Enter to create · Shift+Enter for a new line"
            maxHeight={220}
            model={{ kind: 'choice', value: modelOverride, onChange: setModelOverride }}
            mentionLabels={mentionLabels}
            mentionListbox={visibleCandidates.length > 0
              ? { id: 'launch-mention-listbox', activeOptionId: mentionNavigation.activeOptionId }
              : undefined}
            onAttach={attachmentDraft.addFiles}
            onKeyDown={(event) => {
              if (mentionNavigation.handleKeyDown(event)) return;
              if (event.key !== 'Escape' || mentionQuery === null) return;
              event.preventDefault();
              setMentionQuery(null);
            }}
            onMention={beginMention}
            onOpenAttachment={setAttachmentPreview}
            onRemoveAttachment={attachmentDraft.removeAttachment}
            onRetryAttachment={attachmentDraft.retryAttachment}
            onSelect={() => { if (!draftHidden) refreshOpenMentionQuery(message); }}
            onSubmit={submit}
            // Held back rather than merely hidden: the composer is controlled,
            // so a keystroke during a suggested-work launch would otherwise
            // write the empty value it is being shown back over the draft it is
            // hiding, and lose it.
            onValueChange={(value) => { if (draftHidden) return; updateMessage(value); setTooLong(false); }}
            placeholder="Describe a task or ask a question…"
            ref={textareaRef}
            rows={2}
            shouldSubmitOnEnter={() => mentionQuery === null}
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
        members={activeMembers}
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
