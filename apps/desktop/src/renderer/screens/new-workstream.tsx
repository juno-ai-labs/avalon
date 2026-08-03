import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronRight, LoaderCircle, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { formatRelative } from '../lib/format';
import type { Workspace, WorkspaceMember, WorkstreamSummary } from '../lib/types';
import { Avatar, AvatarStack, AvalonMark, Button, InlineError, Modal, StatusDot } from '../components/primitives';

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<WorkspaceMember[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const workstreams = useQuery({
    queryKey: ['workstreams'],
    queryFn: ({ signal }) => api!.getWorkstreams(signal),
    enabled: Boolean(api),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  const waitingWorkstreams = useMemo(
    () => (workstreams.data ?? [])
      .filter((workstream) => workstream.harnessStatus === 'needs_input')
      .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()),
    [workstreams.data],
  );

  const create = useMutation({
    mutationFn: () =>
      api!.createWorkstream({
        openingMessage: message.trim(),
        participantIds: selectedMembers.map((member) => member.id),
      }),
    onSuccess: (workstream) => {
      void queryClient.invalidateQueries({ queryKey: ['workstreams'] });
      void navigate(`/workstreams/${workstream.id}`);
    },
  });

  const submit = (): void => {
    if (!message.trim() || create.isPending) return;
    create.mutate();
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

        <div className="hero-composer">
          <textarea
            aria-label="Opening work-stream message"
            autoFocus
            onChange={(event) => {
              setMessage(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a task or ask a question…"
            ref={textareaRef}
            rows={2}
            value={message}
          />
          <div className="hero-composer-footer">
            <span>Enter to create · Shift+Enter for a new line</span>
            <button aria-label="Create work stream" disabled={!message.trim() || create.isPending} onClick={submit} type="button">
              {create.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ArrowUp aria-hidden="true" size={16} />}
            </button>
          </div>
        </div>
        {create.error && <InlineError>{create.error.message}</InlineError>}
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
    </div>
  );
}
