import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { formatRelative } from '../lib/format';
import { useDraftText } from '../lib/use-draft-text';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useWindowFilePaste } from '../lib/use-file-paste';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import type { AgentModelOverride, Message, MessageAttachment, WorkOpportunity, Workspace, WorkspaceMember, WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { type AttachmentPreview, AttachmentLightbox } from '../components/attachments';
import { ComposerInput } from '../components/composer-input';
import { Avatar, AvatarStack, AvalonMark, Button, Modal, StatusDot } from '../components/primitives';
import { withSuggestedPrompts } from '../components/suggested-prompts';

interface CreateWorkstreamInput {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  modelOverride: AgentModelOverride | null;
  openingMessage: string;
  participantIds: string[];
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
  const draftKey = newWorkstreamDraftKey(workspace.id);
  const { text: message, setText: setMessage } = useDraftText(draftKey);
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Not kept in the draft cache: the draft outlives the session, and a model
  // pinned last week is not a choice anyone would expect to still be in force.
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const attachmentDraft = useFileAttachments(api, draftKey);
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
      setMessage((current) => current.length > 0 ? current : input.openingMessage);
    },
    onSettled: () => {
      submittingRef.current = false;
    },
    onSuccess: (created, input) => {
      const selectedParticipants = (members.data ?? [])
        .filter((member) => input.participantIds.includes(member.id))
        .map((member) => ({ ...member, role: 'explicit' }));
      const detail: WorkstreamDetail = {
        ...created.workstream,
        createdAt: created.createdAt,
        createdBy: { ...workspace.currentUser, role: 'creator' },
        participants: [{ ...workspace.currentUser, role: 'creator' }, ...selectedParticipants],
        viewers: [],
        resources: [],
        connections: [],
        artifacts: [],
        backgroundTasks: [],
        automationRuns: [],
        openElicitations: [],
        suggestions: [],
      };
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
    onSuccess: (created, opportunity) => {
      opportunityKeys.current.delete(opportunity.id);
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
    create.mutate({
      attachmentIds: readyAttachments.map((attachment) => attachment.resource!.id),
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments: readyAttachments.map((attachment) => ({
        id: attachment.resource!.id,
        fileName: attachment.file.name,
        mimeType: attachment.file.type || 'application/octet-stream',
        sizeBytes: attachment.file.size,
        contentAvailable: true,
        createdAt,
      })),
      modelOverride,
      openingMessage,
      participantIds,
    });
  };

  const participants = [workspace.currentUser, ...selectedMembers];
  const participantSummary = participants.length <= 2
    ? participants.map((participant) => participant.name).join(', ')
    : `${workspace.currentUser.name} +${participants.length - 1}`;

  return (
    <div className="new-workstream-screen screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
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

      <section className="new-workstream-launcher" aria-labelledby="new-workstream-heading">
        <h2 className="sr-only" id="new-workstream-heading">Start a new work stream</h2>
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

        <ComposerInput
          api={api ?? undefined}
          ariaLabel="Opening work-stream message"
          attachments={attachmentDraft.attachments}
          autoFocus
          className="hero-composer"
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
          onValueChange={setMessage}
          placeholder="Describe a task or ask a question…"
          rows={2}
          submitDisabled={attachmentDraft.uploading || (!message.trim() && attachmentDraft.ready.length === 0) || create.isPending || submittingRef.current}
          submitLabel="Create work stream"
          submitting={create.isPending}
          uploading={attachmentDraft.uploading}
          value={message}
        />
        {members.error && <p className="muted-notice">People could not be loaded. You can still create this work stream with yourself.</p>}
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
