import { LoaderCircle, Sparkles, Square, UserPlus } from 'lucide-react';
import { type RefObject, useMemo, useRef, useState } from 'react';
import type { RallyApi, MentionIdentity } from '../lib/api';
import { workstreamDraftKey } from '../lib/draft-keys';
import {
  completeMentionAtCaret,
  mentionsInTrimmedText,
  rebaseMentionIdentities,
  resolveMentionPayload,
  upsertMentionIdentity,
} from '../lib/mention-draft';
import { PERSON_MENTION_TYPE } from '../lib/mention-constants';
import { NO_MENTIONS, useDraftText } from '../lib/use-draft-text';
import { draftWithMentionStarted, mentionOptionId, mentionQueryAtCaret, useMentionNavigation } from '../lib/use-mention-navigation';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { WorkstreamMessageDeliveryMode } from '../lib/use-workstream-socket';
import { STOPPING_LABEL } from './agent-work-timing';
import type { AttachmentPreview } from './attachments';
import { ComposerInput, type ComposerModelControl } from './composer-input';
import { Avatar, Button, IconButton, Modal } from './primitives';
import type { RallyRegion } from '../../common/desktop';

/**
 * Someone an `@` can name here. Only people for now: the work stream's
 * connections were offered alongside them and have been taken back out, so a
 * connection is neither pickable nor highlighted in a draft written here. What
 * the transcript renders is unaffected — a connector mention that reaches it
 * from anywhere else still draws its chip.
 */
interface MentionCandidate {
  id: string;
  label: string;
  description: string;
  kind: 'rally' | 'person';
  member?: WorkspaceMember;
}

interface WorkstreamComposerProps {
  /** What the empty box invites; an automation's conversation asks for its instructions. */
  placeholder?: string;
  /**
   * The launch surfaces dress this composer as the one they hand off from, so
   * the element the eye follows into the dock is the same element throughout.
   * Everything else about it — mentions, attachments, the queue, the draft —
   * is what an ordinary conversation composer does.
   */
  className?: string;
  footerHint?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  api?: Pick<RallyApi, 'getTranscriptionSocketTicket'>;
  workstream: WorkstreamDetail;
  workspaceId?: string;
  workspaceRegion?: RallyRegion;
  substreamId?: string;
  members: WorkspaceMember[];
  /**
   * The model control, passed straight to the composer that draws it. Both
   * conversations this composer serves want one: a substream being started
   * takes the `choice` shape, and a conversation that already exists takes the
   * locked `settled` one. Hosts that pass nothing show no control at all, and
   * neither shape appears unless Debug enabled is on.
   */
  model?: ComposerModelControl;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sending: boolean;
  uploading: boolean;
  /**
   * The conversation is painted from the local cache and its socket has not
   * yet delivered the live transcript. Everything about the composer works —
   * typing, mentions, attachments, the draft — except sending, which waits
   * for the socket so a message is never queued against a transcript the
   * room has not confirmed. Enter is swallowed the way it is for an empty
   * draft, so the sentence stays where it was typed.
   */
  sendBlocked?: boolean;
  error?: string;
  attachments: PendingAttachment[];
  onSend: (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds?: string[],
    deliveryMode?: WorkstreamMessageDeliveryMode,
  ) => Promise<void>;
  onAttach: (files: FileList | File[]) => void;
  onOpenAttachment: (preview: AttachmentPreview) => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment: (localId: string) => void;
  onStop: () => Promise<void>;
  backgroundAgentCount?: number | null;
}

interface PendingMentionConfirmation {
  text: string;
  mentions: MentionIdentity[];
  members: WorkspaceMember[];
  deliveryMode?: WorkstreamMessageDeliveryMode;
}

interface ComposerCommand {
  id: 'participants' | 'attach' | 'stop' | 'clear';
  label: string;
  description: string;
}

const BASE_COMMANDS: ComposerCommand[] = [
  { id: 'participants', label: 'participants', description: 'Mention a participant' },
  { id: 'attach', label: 'attach', description: 'Choose a file to attach' },
  { id: 'clear', label: 'clear', description: 'Clear this draft' },
];

export function WorkstreamComposer({
  placeholder = 'Message the work stream…',
  className,
  footerHint,
  submitLabel = 'Send message',
  autoFocus = false,
  api,
  workstream,
  workspaceId = 'test-workspace',
  workspaceRegion = 'global',
  substreamId = '0',
  members,
  model,
  fileInputRef,
  sending,
  uploading,
  sendBlocked = false,
  error,
  attachments,
  onSend,
  onAttach,
  onOpenAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onStop,
  backgroundAgentCount,
}: WorkstreamComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRevisionRef = useRef(0);
  const {
    text,
    setText,
    mentions: selectedMentions,
    setMentions: setSelectedMentions,
  } = useDraftText(workstreamDraftKey(workspaceRegion, workspaceId, workstream.id, substreamId));
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMentionConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const readyAttachmentCount = attachments.filter((attachment) => attachment.status === 'ready').length;
  const participantIds = useMemo(() => new Set(workstream.participants.map((person) => person.id)), [workstream.participants]);
  const candidates = useMemo<MentionCandidate[]>(() => [{
    id: 'rally-assistant',
    label: 'Rally',
    description: 'Ask Rally to join this part of the conversation',
    kind: 'rally' as const,
  }, ...members
    // The same rule the participants rail applies: a membership that is not
    // active is one the work-stream endpoint refuses, so naming it here would
    // only produce a failure nobody can act on.
    .filter((member) => (member.status ?? 'active') === 'active')
    .map((member) => ({
      id: member.id,
      label: member.name,
      description: participantIds.has(member.id) ? member.email : `${member.email} · not participating`,
      kind: 'person' as const,
      member,
    }))], [members, participantIds]);

  const mentionLabels = useMemo(() => candidates.map((candidate) => candidate.label), [candidates]);
  const visibleCandidates = mentionQuery === null
    ? []
    : candidates.filter((candidate) => {
        const query = mentionQuery.toLowerCase();
        return candidate.label.toLowerCase().includes(query)
          || candidate.member?.email.toLowerCase().includes(query);
      }).slice(0, 8);
  const mentionNavigation = useMentionNavigation(
    visibleCandidates.map((candidate) => candidate.id),
    (index) => {
      const candidate = visibleCandidates[index];
      if (candidate) insertMention(candidate);
    },
  );
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
    // `toLowerCase`, not `toLocaleLowerCase`: this has to agree with
    // `mention-highlight.ts`, which uses the locale-independent one so a Turkish
    // dotted I does not make a name highlighted here unmatched there.
    setSelectedMentions((current) => rebaseMentionIdentities(text, value, current));
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

  const resetDraft = (): void => {
    setText('');
    setSelectedMentions(NO_MENTIONS);
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

  /**
   * Opens a mention where the caret is. `from` replaces the draft it starts in,
   * for the one caller that clears the composer first: `/participants` empties
   * the draft and the textarea has not seen that yet when this runs, so reading
   * the caret out of it would measure against the command that is being
   * replaced.
   */
  const beginMention = (from?: string): void => {
    draftRevisionRef.current += 1;
    const started = draftWithMentionStarted(
      from ?? text,
      from === undefined ? textareaRef.current?.selectionStart : from.length,
      from === undefined ? textareaRef.current?.selectionEnd : from.length,
    );
    setText(started.value);
    setMentionQuery('');
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      // Only while the draft is still the one this opened. A frame is enough
      // room for a keystroke, and putting the caret back where the `@` went
      // would drag it out of whatever was typed in the meantime.
      if (textarea?.value === started.value) textarea.setSelectionRange(started.caret, started.caret);
    });
  };

  const runCommand = async (command: ComposerCommand): Promise<void> => {
    if (command.id === 'participants') {
      setText('');
      beginMention('');
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
    const completed = completeMentionAtCaret(text, caret, candidate.label, textarea?.selectionEnd ?? caret);
    // Nothing to replace: the caret is no longer standing after an `@`, so
    // there is no mention here to complete. `slice(0, -1)` would silently eat
    // the character before the caret instead.
    if (!completed) {
      setMentionQuery(null);
      return;
    }
    setText(completed.text);
    setSelectedMentions((current) => {
      const rebased = rebaseMentionIdentities(text, completed.text, current);
      if (!candidate.member) return rebased;
      const identity: MentionIdentity = {
        type: 'person',
        label: candidate.label,
        userId: candidate.member.id,
        connectorType: null,
        startOffset: completed.startOffset,
        endOffset: completed.endOffset,
      };
      return upsertMentionIdentity(rebased, identity);
    });
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(completed.caret, completed.caret);
    });
  };

  const send = async (): Promise<void> => {
    const submitted = mentionsInTrimmedText(text, selectedMentions);
    const trimmed = submitted.text;
    if (sendBlocked || (!trimmed && readyAttachmentCount === 0) || uploading) return;
    const resolvedPersonIds = new Set(resolveMentionPayload(
      trimmed,
      submitted.mentions,
      members
        .filter((member) => (member.status ?? 'active') === 'active')
        .map((member) => ({
          type: 'person', label: member.name, userId: member.id, connectorType: null,
        })),
    ).flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []));
    const nonparticipants = members.filter((member) => {
      if ((member.status ?? 'active') !== 'active') return false;
      if (participantIds.has(member.id)) return false;
      return resolvedPersonIds.has(member.id);
    });
    if (workstream.scope === 'personal' && nonparticipants.length > 0) {
      setPendingConfirmation({
        text: trimmed,
        mentions: submitted.mentions,
        members: nonparticipants,
        ...(workstream.harnessStatus === 'running' ? { deliveryMode: 'steer' as const } : {}),
      });
      return;
    }
    const mentions = submitted.mentions;
    const revision = draftRevisionRef.current;
    const submittedDeliveryMode = workstream.harnessStatus === 'running' ? 'steer' as const : undefined;
    resetDraft();
    try {
      await onSend(trimmed, mentions, undefined, submittedDeliveryMode);
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
        submitted.deliveryMode,
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
        <div className="mention-popover" id="workstream-mention-listbox" role="listbox" aria-label="Mentions">
          {visibleCandidates.map((candidate, index) => (
            <button
              aria-label={`${candidate.label} — ${candidate.description} — ${candidate.kind === 'rally' ? 'Bot' : PERSON_MENTION_TYPE}`}
              aria-selected={index === mentionNavigation.activeIndex}
              className={index === mentionNavigation.activeIndex ? 'is-selected' : undefined}
              id={mentionOptionId(candidate.id)}
              key={candidate.id}
              onClick={() => insertMention(candidate)}
              /* Move rather than enter: the list scrolls under a still pointer
                 when the arrows walk past its edge, and that must not steal the
                 highlight back. */
              onMouseMove={() => mentionNavigation.setActiveIndex(index)}
              ref={index === mentionNavigation.activeIndex ? mentionNavigation.activeOptionRef : undefined}
              role="option"
              type="button"
            >
              <span aria-hidden="true" className="mention-icon">
                {candidate.member
                  ? <Avatar member={candidate.member} size="small" />
                  : <span className="rally-mention-icon"><Sparkles size={14} /></span>}
              </span>
              <span className="mention-popover-copy">
                <strong>{candidate.label}</strong>
                {candidate.kind === 'person' && <small>{candidate.description}</small>}
              </span>
              <span className="mention-popover-kind">{candidate.kind === 'rally' ? 'Bot' : PERSON_MENTION_TYPE}</span>
            </button>
          ))}
        </div>
      )}
      {backgroundAgentCount != null && backgroundAgentCount > 0 && (
        <div className="background-agent-count" role="status">
          {backgroundAgentCount} background {backgroundAgentCount === 1 ? 'agent' : 'agents'} running
        </div>
      )}
      <ComposerInput
        api={api}
        ariaLabel={placeholder.replace(/…$/u, '')}
        attachments={attachments}
        autoFocus={autoFocus}
        {...(className ? { className } : {})}
        error={error}
        {...(footerHint ? { footerHint } : {})}
        fileInputRef={fileInputRef}
        layout="message-capsule"
        onAttach={onAttach}
        onKeyDown={(event) => {
          if (mentionNavigation.handleKeyDown(event)) return;
          if (event.key === 'Escape' && (mentionQuery !== null || visibleCommands.length > 0)) {
            // ComposerInput never hands a host a keydown belonging to an
            // in-flight IME composition, so this Escape is always a dismissal
            // rather than a candidate being abandoned. Prevented only when
            // there is something here to dismiss: an Escape this composer
            // ignores should keep travelling to whatever else is listening.
            event.preventDefault();
            if (mentionQuery !== null) setMentionQuery(null);
            if (visibleCommands.length > 0) setSlashDismissed(true);
          }
          if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && visibleCommands[0]) {
            event.preventDefault();
            void runCommand(visibleCommands[0]);
          }
        }}
        mentionLabels={mentionLabels}
        mentionListbox={visibleCandidates.length > 0
          ? { id: 'workstream-mention-listbox', activeOptionId: mentionNavigation.activeOptionId }
          : undefined}
        {...(model ? { model } : {})}
        onMention={beginMention}
        onOpenAttachment={onOpenAttachment}
        onRemoveAttachment={onRemoveAttachment}
        onRetryAttachment={onRetryAttachment}
        onSelect={() => refreshOpenMentionQuery(text)}
        onSubmit={send}
        onValueChange={updateText}
        placeholder={placeholder}
        ref={textareaRef}
        shouldSubmitOnEnter={() => mentionQuery === null}
        submitAccessory={(
          <div
            className="composer-stop-slot"
            data-visible={workstream.harnessStatus === 'running'}
            inert={workstream.harnessStatus !== 'running'}
          >
            <IconButton
              className="stop-button"
              aria-disabled={workstream.stopRequested}
              label={workstream.stopRequested ? STOPPING_LABEL : 'Stop the current run'}
              onClick={() => { if (!workstream.stopRequested) void onStop(); }}
              tooltipSide="top"
            >
              {workstream.stopRequested
                ? <LoaderCircle aria-hidden="true" className="spin" size={12} />
                : <Square aria-hidden="true" fill="currentColor" size={10} />}
            </IconButton>
          </div>
        )}
        submitDisabled={sendBlocked || uploading || (!text.trim() && readyAttachmentCount === 0)}
        submitLabel={sendBlocked ? `${submitLabel}, available once Rally connects` : submitLabel}
        submitting={sending}
        uploading={uploading}
        value={text}
      />

      <Modal
        description={pendingConfirmation && pendingConfirmation.members.length > 1
          ? `${pendingConfirmation.members.map((member) => member.name).join(', ')} are not currently participants. Would you like to add them with this message? If you do not add them, they will not be able to see the mentions or this ${substreamId === '0' ? 'work stream' : 'substream'}.`
          : `${pendingConfirmation?.members[0]?.name ?? 'This person'} is not currently a participant. Would you like to add them with this message? If you do not add them, they will not be able to see the mention or this ${substreamId === '0' ? 'work stream' : 'substream'}.`}
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
