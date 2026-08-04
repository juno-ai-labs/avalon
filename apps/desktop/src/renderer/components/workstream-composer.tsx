import clsx from 'clsx';
import { ArrowUp, AtSign, LoaderCircle, Paperclip, Square, UserPlus } from 'lucide-react';
import { type RefObject, useMemo, useRef, useState } from 'react';
import type { MentionIdentity } from '../lib/api';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { useFileDrop } from '../lib/use-file-drop';
import type { SocketState } from '../lib/use-workstream-socket';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { type AttachmentPreview, PendingAttachmentTile } from './attachments';
import { Avatar, Badge, Button, IconButton, InlineError, Modal } from './primitives';

interface MentionCandidate {
  id: string;
  kind: 'person' | 'connector';
  label: string;
  description: string;
  member?: WorkspaceMember;
  connectorType?: string;
}

interface WorkstreamComposerProps {
  workstream: WorkstreamDetail;
  members: WorkspaceMember[];
  socketState: SocketState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sending: boolean;
  uploading: boolean;
  error?: string;
  attachments: PendingAttachment[];
  onSend: (text: string, mentions: MentionIdentity[], confirmedParticipantUserIds?: string[]) => Promise<void>;
  onAttach: (files: FileList | File[]) => void;
  onOpenAttachment: (preview: AttachmentPreview) => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment: (localId: string) => void;
  onStop: () => Promise<void>;
}

interface PendingMentionConfirmation {
  text: string;
  mentions: MentionIdentity[];
  members: WorkspaceMember[];
}

interface ComposerCommand {
  id: 'participants' | 'attach' | 'stop' | 'clear';
  label: string;
  description: string;
}

const BASE_COMMANDS: ComposerCommand[] = [
  { id: 'participants', label: 'participants', description: 'Mention a participant or connection' },
  { id: 'attach', label: 'attach', description: 'Choose a file to attach' },
  { id: 'clear', label: 'clear', description: 'Clear this draft' },
];

function socketLabel(state: SocketState): string {
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'unavailable') return 'Live updates unavailable';
  return 'Loading';
}

export function WorkstreamComposer({
  workstream,
  members,
  socketState,
  fileInputRef,
  sending,
  uploading,
  error,
  attachments,
  onSend,
  onAttach,
  onOpenAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onStop,
}: WorkstreamComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRevisionRef = useRef(0);
  const [text, setText] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [selectedMentions, setSelectedMentions] = useState<MentionIdentity[]>([]);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMentionConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const drop = useFileDrop(onAttach);
  const readyAttachmentCount = attachments.filter((attachment) => attachment.status === 'ready').length;
  const participantIds = useMemo(() => new Set(workstream.participants.map((person) => person.id)), [workstream.participants]);
  const candidates = useMemo<MentionCandidate[]>(() => [
    ...members.map((member) => ({
      id: member.id,
      kind: 'person' as const,
      label: member.name,
      description: participantIds.has(member.id) ? member.email : `${member.email} · not participating`,
      member,
    })),
    ...workstream.connections.map((connection) => ({
      id: connection.id,
      kind: 'connector' as const,
      label: connection.displayName,
      description: `${connection.scope === 'you' ? 'Your' : 'Workspace'} connection`,
      connectorType: connection.connectorType,
    })),
  ], [members, participantIds, workstream.connections]);

  const visibleCandidates = mentionQuery === null
    ? []
    : candidates.filter((candidate) => candidate.label.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);
  const slashMatch = text.match(/^\/([^\s/]*)$/u);
  const commandQuery = slashMatch?.[1]?.toLowerCase() ?? null;
  const commands = useMemo(
    () => workstream.harnessStatus === 'running'
      ? [...BASE_COMMANDS, { id: 'stop', label: 'stop', description: 'Stop the current run' } satisfies ComposerCommand]
      : BASE_COMMANDS,
    [workstream.harnessStatus],
  );
  const visibleCommands = commandQuery === null || slashDismissed
    ? []
    : commands.filter((command) => command.label.includes(commandQuery));
  const updateText = (value: string): void => {
    draftRevisionRef.current += 1;
    setText(value);
    setSlashDismissed(false);
    setSelectedMentions((current) => current.filter((mention) => value.toLocaleLowerCase().includes(`@${mention.label.toLocaleLowerCase()}`)));
    const beforeCaret = value.slice(0, textareaRef.current?.selectionStart ?? value.length);
    const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
    setMentionQuery(match?.[1] ?? null);
  };

  const resetDraft = (): void => {
    setText('');
    setSelectedMentions([]);
    setMentionQuery(null);
    setSlashDismissed(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const restoreDraft = (value: string, mentions: MentionIdentity[], revision: number): void => {
    if (draftRevisionRef.current !== revision) return;
    setText(value);
    setSelectedMentions(mentions);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
      textarea.focus();
    });
  };

  const beginMention = (): void => {
    draftRevisionRef.current += 1;
    setText((current) => current.length === 0 || /\s$/u.test(current) ? `${current}@` : `${current} @`);
    setMentionQuery('');
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const runCommand = async (command: ComposerCommand): Promise<void> => {
    if (command.id === 'participants') {
      setText('');
      beginMention();
      return;
    }
    resetDraft();
    if (command.id === 'attach') {
      fileInputRef.current?.click();
      return;
    }
    if (command.id === 'stop') await onStop();
  };

  const insertMention = (candidate: MentionCandidate): void => {
    draftRevisionRef.current += 1;
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const atIndex = before.lastIndexOf('@');
    const nextText = `${before.slice(0, atIndex)}@${candidate.label} ${after}`;
    setText(nextText);
    const identity: MentionIdentity = candidate.kind === 'person'
      ? { type: 'person', label: candidate.label, userId: candidate.member?.id ?? candidate.id, connectorType: null }
      : { type: 'connector', label: candidate.label, userId: null, connectorType: candidate.connectorType ?? null };
    setSelectedMentions((current) => [
      ...current.filter((mention) => !(mention.type === identity.type && mention.userId === identity.userId && mention.connectorType === identity.connectorType)),
      identity,
    ]);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      const nextCaret = atIndex + candidate.label.length + 2;
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if ((!trimmed && readyAttachmentCount === 0) || uploading) return;
    const selectedPersonIds = new Set(selectedMentions.flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []));
    const nonparticipants = members.filter((member) => {
      if (participantIds.has(member.id)) return false;
      const escapedName = member.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const typedMention = new RegExp(`(?:^|[\\s([{])@${escapedName}(?=$|[\\s\\p{P}])`, 'iu').test(trimmed);
      return selectedPersonIds.has(member.id) || typedMention;
    });
    if (nonparticipants.length > 0) {
      setPendingConfirmation({ text: trimmed, mentions: [...selectedMentions], members: nonparticipants });
      return;
    }
    const mentions = [...selectedMentions];
    const revision = draftRevisionRef.current;
    resetDraft();
    try {
      await onSend(trimmed, mentions);
    } catch {
      restoreDraft(trimmed, mentions, revision);
    }
  };

  const confirmAddAndSend = async (): Promise<void> => {
    if (!pendingConfirmation) return;
    const submitted = pendingConfirmation;
    const revision = draftRevisionRef.current;
    setConfirming(true);
    setPendingConfirmation(null);
    resetDraft();
    try {
      await onSend(
        submitted.text,
        submitted.mentions,
        submitted.members.map((member) => member.id),
      );
    } catch {
      restoreDraft(submitted.text, submitted.mentions, revision);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="composer-wrap">
      {visibleCommands.length > 0 && (
        <div className="command-popover" role="listbox" aria-label="Composer commands">
          <div className="command-popover-label">Commands</div>
          {visibleCommands.map((command, index) => (
            <button
              aria-selected={index === 0}
              className={index === 0 ? 'is-selected' : undefined}
              key={command.id}
              onClick={() => void runCommand(command)}
              role="option"
              type="button"
            >
              <strong>/{command.label}</strong>
              <span>{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {visibleCandidates.length > 0 && (
        <div className="mention-popover" role="listbox" aria-label="Mentions">
          {visibleCandidates.map((candidate) => (
            <button key={`${candidate.kind}-${candidate.id}`} onClick={() => insertMention(candidate)} role="option" type="button">
              <span className="mention-icon">
                {candidate.member ? <Avatar member={candidate.member} size="small" /> : <AtSign size={14} />}
              </span>
              <span><strong>{candidate.label}</strong><small>{candidate.description}</small></span>
              <Badge>{candidate.kind === 'person' ? 'Person' : 'Connection'}</Badge>
            </button>
          ))}
        </div>
      )}
      <div
        className={clsx('workstream-composer', sending && 'is-sending', drop.dragging && 'is-file-dragging')}
        onDragEnter={drop.onDragEnter}
        onDragLeave={drop.onDragLeave}
        onDragOver={drop.onDragOver}
        onDrop={drop.onDrop}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <PendingAttachmentTile
                attachment={attachment}
                key={attachment.localId}
                onOpen={onOpenAttachment}
                onRemove={() => onRemoveAttachment(attachment.localId)}
                onRetry={() => onRetryAttachment(attachment.localId)}
              />
            ))}
          </div>
        )}
        <textarea
          aria-label="Message the work stream"
          onChange={(event) => {
            updateText(event.target.value);
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (mentionQuery !== null) setMentionQuery(null);
              if (visibleCommands.length > 0) setSlashDismissed(true);
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && visibleCommands[0]) {
              event.preventDefault();
              void runCommand(visibleCommands[0]);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && mentionQuery === null) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message the work stream…"
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <IconButton label="Mention a participant or connection" onClick={beginMention}>
              <AtSign size={15} />
            </IconButton>
            <IconButton label="Attach a file" onClick={() => fileInputRef.current?.click()}>
              {uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}
            </IconButton>
            <span aria-label={socketLabel(socketState)} className={clsx('socket-state', `socket-${socketState}`)} role="status" title={socketLabel(socketState)}>
              <span aria-hidden="true" /><span className="sr-only">{socketLabel(socketState)}</span>
            </span>
          </div>
          <div className="composer-submit-area">
            {workstream.harnessStatus === 'running' && (
              <Button className="stop-button" onClick={() => void onStop()}><Square fill="currentColor" size={9} /> Stop</Button>
            )}
            <button aria-label="Send message" className="composer-send" disabled={uploading || (!text.trim() && readyAttachmentCount === 0)} onClick={() => void send()} type="button">
              {sending ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
      {error && <div className="composer-error-slot"><InlineError>{error}</InlineError></div>}
      <input
        className="sr-only"
        multiple
        onChange={(event) => {
          if (event.target.files?.length) onAttach(event.target.files);
          event.target.value = '';
        }}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <Modal
        description={pendingConfirmation && pendingConfirmation.members.length > 1
          ? `${pendingConfirmation.members.map((member) => member.name).join(', ')} are not currently participants. Confirm adding all of them with this message.`
          : `${pendingConfirmation?.members[0]?.name ?? 'This person'} is not currently a participant. Confirm adding them with this message.`}
        footer={
          <>
            <Button disabled={confirming} onClick={() => setPendingConfirmation(null)}>Cancel</Button>
            <Button className="button-primary" disabled={confirming} onClick={() => void confirmAddAndSend()}>
              {confirming ? <LoaderCircle className="spin" size={14} /> : <UserPlus size={14} />}
              {pendingConfirmation && pendingConfirmation.members.length > 1 ? 'Add all and mention' : 'Add and mention'}
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (!open && !confirming) setPendingConfirmation(null);
        }}
        open={Boolean(pendingConfirmation)}
        title={pendingConfirmation && pendingConfirmation.members.length > 1 ? 'Add participants?' : 'Add participant?'}
      >
        {pendingConfirmation?.members.map((member) => (
          <div className="mention-confirm-person" key={member.id}>
            <Avatar member={member} size="large" />
            <span><strong>{member.name}</strong><small>{member.email}</small></span>
          </div>
        ))}
      </Modal>
    </div>
  );
}
