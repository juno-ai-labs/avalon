import { LoaderCircle, Square, UserPlus } from 'lucide-react';
import { type RefObject, useMemo, useRef, useState } from 'react';
import type { RallyApi, MentionIdentity } from '../lib/api';
import { workstreamDraftKey } from '../lib/draft-keys';
import { PERSON_MENTION_TYPE } from '../lib/mention-constants';
import { NO_MENTIONS, useDraftText } from '../lib/use-draft-text';
import { draftWithMentionStarted, mentionOptionId, mentionQueryAtCaret, useMentionNavigation } from '../lib/use-mention-navigation';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { AttachmentPreview } from './attachments';
import { ComposerInput } from './composer-input';
import { Avatar, Badge, Button, Modal } from './primitives';

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
  member: WorkspaceMember;
}

interface WorkstreamComposerProps {
  api?: Pick<RallyApi, 'getTranscriptionSocketTicket'>;
  workstream: WorkstreamDetail;
  members: WorkspaceMember[];
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
  { id: 'participants', label: 'participants', description: 'Mention a participant' },
  { id: 'attach', label: 'attach', description: 'Choose a file to attach' },
  { id: 'clear', label: 'clear', description: 'Clear this draft' },
];

export function WorkstreamComposer({
  api,
  workstream,
  members,
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
  const {
    text,
    setText,
    mentions: selectedMentions,
    setMentions: setSelectedMentions,
  } = useDraftText(workstreamDraftKey(workstream.id));
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMentionConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const readyAttachmentCount = attachments.filter((attachment) => attachment.status === 'ready').length;
  const participantIds = useMemo(() => new Set(workstream.participants.map((person) => person.id)), [workstream.participants]);
  const candidates = useMemo<MentionCandidate[]>(() => members
    // The same rule the participants rail applies: a membership that is not
    // active is one the work-stream endpoint refuses, so naming it here would
    // only produce a failure nobody can act on.
    .filter((member) => (member.status ?? 'active') === 'active')
    .map((member) => ({
      id: member.id,
      label: member.name,
      description: participantIds.has(member.id) ? member.email : `${member.email} · not participating`,
      member,
    })), [members, participantIds]);

  const mentionLabels = useMemo(() => candidates.map((candidate) => candidate.label), [candidates]);
  const visibleCandidates = mentionQuery === null
    ? []
    : candidates.filter((candidate) => candidate.label.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);
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
    setSelectedMentions((current) => current.filter((mention) => value.toLowerCase().includes(`@${mention.label.toLowerCase()}`)));
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
    const started = draftWithMentionStarted(from ?? text, from === undefined ? textareaRef.current?.selectionStart : from.length);
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
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const atIndex = before.lastIndexOf('@');
    // Nothing to replace: the caret is no longer standing after an `@`, so
    // there is no mention here to complete. `slice(0, -1)` would silently eat
    // the character before the caret instead.
    if (atIndex < 0) {
      setMentionQuery(null);
      return;
    }
    // The separator is the name's own, unless what follows already begins with
    // one: picking mid-sentence otherwise leaves two spaces where the caret was.
    const separator = /^\s/u.test(after) ? '' : ' ';
    const nextText = `${before.slice(0, atIndex)}@${candidate.label}${separator}${after}`;
    setText(nextText);
    const identity: MentionIdentity = { type: 'person', label: candidate.label, userId: candidate.member.id, connectorType: null };
    setSelectedMentions((current) => [
      ...current.filter((mention) => !(mention.type === identity.type && mention.userId === identity.userId && mention.connectorType === identity.connectorType)),
      identity,
    ]);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      const nextCaret = atIndex + candidate.label.length + 1 + separator.length;
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
        <div className="mention-popover" id="workstream-mention-listbox" role="listbox" aria-label="Mentions">
          {visibleCandidates.map((candidate, index) => (
            <button
              aria-label={`${candidate.label} — ${candidate.description} — ${PERSON_MENTION_TYPE}`}
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
                <Avatar member={candidate.member} size="small" />
              </span>
              <span><strong>{candidate.label}</strong><small>{candidate.description}</small></span>
              <Badge>{PERSON_MENTION_TYPE}</Badge>
            </button>
          ))}
        </div>
      )}
      <ComposerInput
        api={api}
        ariaLabel="Message the work stream"
        attachments={attachments}
        error={error}
        fileInputRef={fileInputRef}
        onAttach={onAttach}
        onKeyDown={(event) => {
          if (mentionNavigation.handleKeyDown(event)) return;
          if (event.key === 'Escape' && (mentionQuery !== null || visibleCommands.length > 0)) {
            // Prevented like the other two composers do, and only when there is
            // something here to dismiss: an Escape this composer ignores should
            // keep travelling to whatever else is listening for it.
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
        // The run first, the pin second. What a run recorded is what actually
        // ran — the pin where it was pinned, the flag's served answer where it
        // was not, and the only place that served variation is visible to a
        // client at all. The pin is the fallback rather than the source because
        // it answers for almost nobody, but it does answer for the one case the
        // run cannot: a run that failed before its first token records no model,
        // and a pinned work stream must never be described as following a flag
        // it does not consult.
        model={{
          kind: 'settled',
          // Trimmed before it is believed. `harness_runs.model` is not
          // constrained to be non-empty, and a Worker whose `OPENROUTER_*`
          // variable is unset resolves to `""` — `modelId` in
          // `agent-model-flags.ts` normalizes an absent variable to the empty
          // string — which is stored and reaches here. Empty means the same
          // thing null does, so it falls through to the pin rather than
          // rendering a pill with no name in it.
          model: workstream.latestHarnessRun?.model?.trim() || workstream.modelOverride || null,
          // The pin decides what the control may claim about the future, which
          // is not the same question as what it shows. Only a pinned work
          // stream is fixed to this model; an unpinned one re-resolves the flag
          // on every launch and may land somewhere else next run.
          pinned: workstream.modelOverride != null,
        }}
        onMention={beginMention}
        onOpenAttachment={onOpenAttachment}
        onRemoveAttachment={onRemoveAttachment}
        onRetryAttachment={onRetryAttachment}
        onSelect={() => refreshOpenMentionQuery(text)}
        onSubmit={send}
        onValueChange={updateText}
        placeholder="Message the work stream…"
        ref={textareaRef}
        shouldSubmitOnEnter={() => mentionQuery === null}
        submitAccessory={workstream.harnessStatus === 'running'
          ? <Button className="stop-button" onClick={() => void onStop()}><Square fill="currentColor" size={9} /> Stop</Button>
          : undefined}
        submitDisabled={uploading || (!text.trim() && readyAttachmentCount === 0)}
        submitLabel="Send message"
        submitting={sending}
        uploading={uploading}
        value={text}
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
