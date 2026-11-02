import { MAX_ATTACHMENTS } from '../lib/attachment-limits';
import { AnnotationsSchema } from '@rally/contracts';
import { AnnotationChips, useAnnotationDraft } from './artifact-annotations';
import clsx from 'clsx';
import { LoaderCircle, Square, UserPlus } from 'lucide-react';
import { type ReactNode, type RefObject, useMemo, useRef, useState } from 'react';
import type { MentionIdentity } from '../lib/api';
import type { RealtimeDictationApi } from '../lib/use-realtime-dictation';
import {
  completeMentionAtCaret,
  mentionsInTrimmedText,
  rebaseMentionIdentities,
  resolveMentionPayload,
  sidekickMentionsAsMarkdown,
  upsertMentionIdentity,
} from '../lib/mention-draft';
import type { WorkspaceInvitee } from '@rally/contracts';
import { inviteeAsMember, mentionedInvitees, NO_INVITEES } from '../lib/workspace-invitees';
import { NO_MENTIONS, useDraftText } from '../lib/use-draft-text';
import { draftWithMentionStarted, mentionOptionId, mentionQueryAtCaret, useMentionNavigation } from '../lib/use-mention-navigation';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { type SidekickMentionTarget, useSidekickMentions } from '../lib/sidekick-mentions';
import type { WorkstreamMessageDeliveryMode } from '../lib/use-workstream-socket';
import { ComposerAgentActivity } from './composer-agent-activity';
import { STOPPING_LABEL } from './agent-work-timing';
import type { AttachmentPreview } from './attachments';
import { ComposerInput, type ComposerMenuAction, type ComposerModelControl } from './composer-input';
import { Avatar, Button, IconButton, Modal, RallyAvatar } from './primitives';
import { AutomationGlyph } from './workstream-glyph';

/**
 * Someone an `@` can name here. Only people for now: the work stream's
 * connections were offered alongside them and have been taken back out, so a
 * connection is neither pickable nor highlighted in a draft written here. What
 * the transcript renders is unaffected — a connector mention that reaches it
 * from anywhere else still draws its chip.
 *
 * An invitee is somebody invited to the Organization who has not joined. They
 * have no account, so their label is their address and the mention is the
 * typed `@address`: no identity rides with it, and the host shares the
 * conversation with the address when the message is sent.
 *
 * A Sidekick is sent as a link; see `sidekickMentionsAsMarkdown`.
 */
interface MentionCandidate {
  id: string;
  label: string;
  description: string;
  kind: 'rally' | 'person' | 'invitee' | 'sidekick';
  member?: WorkspaceMember;
  sidekick?: SidekickMentionTarget;
}

const NO_SHARED: readonly string[] = [];

/** Only a message that names an invitee says so, so every other send keeps its arity. */
function invitedArgument(emails: string[]): [] | [string[]] {
  return emails.length > 0 ? [emails] : [];
}

/** Include the account type in the accessible option name. */
function mentionKindLabel(candidate: MentionCandidate): string {
  if (candidate.kind === 'rally') return 'AI';
  if (candidate.kind === 'invitee') return 'Invited';
  if (candidate.kind === 'sidekick') return 'Sidekick';
  return candidate.member?.accessClass === 'guest' ? 'Guest' : 'Member';
}

/**
 * What the composer needs to know about the conversation it writes into: who is
 * in it, whether a mention of somebody outside it needs confirming, and whether
 * a run is going. A conversation that does not exist yet — a Channel or a
 * breakout being started — supplies these without being one.
 */
export type ComposerConversation = Pick<WorkstreamDetail, 'participants' | 'scope' | 'harnessStatus' | 'stopRequested'>;

interface WorkstreamComposerProps {
  /** What the empty box invites; an automation's conversation asks for its instructions. */
  placeholder?: string;
  /** Defaults to the placeholder without its ellipsis. */
  ariaLabel?: string;
  /**
   * The launch surfaces dress this composer as the one they hand off from, so
   * the element the eye follows into the dock is the same element throughout.
   * Everything else about it — mentions, attachments, the queue, the draft —
   * is what an ordinary conversation composer does.
   */
  className?: string;
  footerHint?: string;
  /** See `ComposerInput`: a line over the toolbar, a control among its tools, and the send button's face. */
  notice?: ReactNode;
  toolsAccessory?: ReactNode;
  submitContent?: ReactNode;
  /** Escape with nothing open to dismiss, for a composer mode the host can leave. */
  onCancel?: () => void;
  /** Host entries for the "+" menu, after Attach files. */
  menuActions?: readonly ComposerMenuAction[];
  submitLabel?: string;
  autoFocus?: boolean;
  api?: RealtimeDictationApi;
  workstream: ComposerConversation;
  annotationsEnabled?: boolean;
  /** The key the unsent draft is cached under; see `lib/draft-keys.ts`. */
  draftKey: string;
  substreamId?: string;
  members: WorkspaceMember[];
  /**
   * People invited to the Organization who have not joined. Offered after the
   * members, and named as their address; absent where the host cannot share
   * the conversation with them.
   */
  invitees?: readonly WorkspaceInvitee[];
  /**
   * Invitees this conversation is already shared with. They are mentioned like
   * any other, but neither confirmed nor handed to the host again: a second
   * share would be a second email.
   */
  sharedInviteeEmails?: readonly string[];
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
    /** Invitees the message names, whom the host shares the conversation with before it sends. */
    invitedEmails?: string[],
  ) => Promise<void>;
  /** Absent where the message cannot carry files; see `ComposerInput`. */
  onAttach?: (files: FileList | File[]) => void;
  /** Every edit to the draft, for a host that clears its own notice on one. */
  onDraftChange?: (value: string) => void;
  onOpenAttachment: (preview: AttachmentPreview) => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment: (localId: string) => void;
  onStop: () => Promise<void>;
  backgroundAgentCount?: number | null;
  runningSidekickCount?: number | null;
}

interface PendingMentionConfirmation {
  text: string;
  mentions: MentionIdentity[];
  members: WorkspaceMember[];
  invitedEmails: string[];
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
  placeholder = 'Message the thread…',
  annotationsEnabled = true,
  ariaLabel,
  className,
  footerHint,
  notice,
  toolsAccessory,
  submitContent,
  onCancel,
  menuActions,
  submitLabel = 'Send message',
  autoFocus = false,
  api,
  workstream,
  draftKey,
  substreamId = '0',
  members,
  invitees = NO_INVITEES,
  sharedInviteeEmails = NO_SHARED,
  model,
  fileInputRef,
  sending,
  uploading,
  sendBlocked = false,
  error,
  attachments,
  onSend,
  onAttach,
  onDraftChange,
  onOpenAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onStop,
  backgroundAgentCount,
  runningSidekickCount,
}: WorkstreamComposerProps): React.JSX.Element {
  const inheritedAnnotationDraft = useAnnotationDraft();
  const annotationDraft = annotationsEnabled ? inheritedAnnotationDraft : null;
  const annotationPayloadValid = AnnotationsSchema.safeParse(annotationDraft?.readyPins.map((p) => p.annotation) ?? []).success;
  const annotationAttachmentCount = annotationDraft?.readyPins.filter((p) => p.annotation.content.imageAttachmentId).length ?? 0;
  const annotationBlocked = (Boolean(sending) && Boolean(annotationDraft?.pins.length)) || !annotationPayloadValid || annotationAttachmentCount + attachments.length > MAX_ATTACHMENTS || annotationDraft?.uploading;
  const hasCommentedPin = annotationDraft?.readyPins.some((p) => p.annotation.comment.trim()) ?? false;
  const annotationSendPending = useRef(false);
  const submitMessage: typeof onSend = async (draftText, draftMentions, ...rest) => {
    const withPins=Boolean(annotationDraft?.pins.length);
    if(withPins&&annotationSendPending.current)throw new Error('Your artifact comments are still sending.');
    if(withPins)annotationSendPending.current=true;
    // The host sends what the reader will see, so a picked Sidekick leaves as
    // its link here and every host's optimistic turn already shows the chip.
    const outgoing = sidekickMentionsAsMarkdown(draftText, draftMentions);
    try {await onSend(outgoing.text, outgoing.mentions, ...rest);} finally {if(withPins)annotationSendPending.current=false;}
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRevisionRef = useRef(0);
  const {
    text,
    setText,
    mentions: selectedMentions,
    setMentions: setSelectedMentions,
  } = useDraftText(draftKey);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMentionConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const readyAttachmentCount = attachments.filter((attachment) => attachment.status === 'ready').length;
  // The Organization's Sidekicks and this conversation's own (see
  // `sidekick-mentions.tsx`), offered after the people. Drafts are left out:
  // one that has never been published has nothing to name yet.
  const sidekicks = useSidekickMentions().list;
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
      description: member.email,
      kind: 'person' as const,
      member,
    })),
  ...invitees.map((invitee) => ({
    id: `invitee:${invitee.email}`,
    label: invitee.email,
    description: '',
    kind: 'invitee' as const,
  })),
  ...sidekicks
    .filter((sidekick) => sidekick.status !== 'draft')
    .map((sidekick) => ({
      id: `sidekick:${sidekick.id}`,
      label: sidekick.name,
      description: sidekick.description,
      kind: 'sidekick' as const,
      sidekick,
    }))], [invitees, members, sidekicks]);

  const mentionLabels = useMemo(() => candidates.map((candidate) => candidate.label), [candidates]);
  const mentionGroups = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    const matches = candidates.filter((candidate) => candidate.label.toLowerCase().includes(query)
      || candidate.member?.email.toLowerCase().includes(query));
    const sharedInvitees = new Set(sharedInviteeEmails);
    const groups = [
      { label: null, candidates: matches.filter((candidate) => candidate.kind === 'rally') },
      { label: 'Participants', candidates: matches.filter((candidate) =>
        candidate.member ? participantIds.has(candidate.id) : candidate.kind === 'invitee' && sharedInvitees.has(candidate.label)) },
      { label: 'Org members', candidates: matches.filter((candidate) =>
        candidate.member ? !participantIds.has(candidate.id) && candidate.member.accessClass !== 'guest'
          : candidate.kind === 'invitee' && !sharedInvitees.has(candidate.label)) },
      { label: 'Guests', candidates: matches.filter((candidate) =>
        candidate.member?.accessClass === 'guest' && !participantIds.has(candidate.id)) },
      { label: 'Sidekicks', candidates: matches.filter((candidate) => candidate.kind === 'sidekick') },
    ].filter((group) => group.candidates.length > 0);
    // Carry each group's starting index so rendering a row never scans the list.
    let startIndex = 0;
    return groups.map((group) => {
      const indexedGroup = { ...group, startIndex };
      startIndex += group.candidates.length;
      return indexedGroup;
    });
  }, [candidates, mentionQuery, participantIds, sharedInviteeEmails]);
  // A single option sequence keeps keyboard navigation independent of headings.
  const visibleCandidates = useMemo(() => mentionGroups.flatMap((group) => group.candidates), [mentionGroups]);
  const mentionNavigation = useMentionNavigation(
    visibleCandidates.map((candidate) => candidate.id),
    (index) => {
      const candidate = visibleCandidates[index];
      if (candidate) insertMention(candidate);
    },
  );
  const slashMatch = text.match(/^\/([^\s/]*)$/u);
  const commandQuery = slashMatch?.[1]?.toLowerCase() ?? null;
  const commands = useMemo(() => {
    const base = onAttach ? BASE_COMMANDS : BASE_COMMANDS.filter((command) => command.id !== 'attach');
    return workstream.harnessStatus === 'running'
      ? [...base, { id: 'stop', label: 'stop', description: 'Stop the current run' } satisfies ComposerCommand]
      : base;
  }, [onAttach, workstream.harnessStatus]);
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
    onDraftChange?.(value);
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
      const range = { startOffset: completed.startOffset, endOffset: completed.endOffset };
      const identity: MentionIdentity | null = candidate.member
        ? { type: 'person', label: candidate.label, userId: candidate.member.id, connectorType: null, ...range }
        : candidate.sidekick
        ? { type: 'sidekick', label: candidate.label, userId: null, connectorType: null, sidekickId: candidate.sidekick.id, ...range }
        : null;
      if (!identity) return rebased;
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
    if (sendBlocked || annotationBlocked || (!trimmed && readyAttachmentCount === 0 && !hasCommentedPin) || uploading) return;
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
    const invitedEmails = mentionedInvitees(trimmed, invitees).filter((email) => !sharedInviteeEmails.includes(email));
    const peopleNeedingConfirmation = workstream.scope === 'personal'
      ? nonparticipants
      : nonparticipants.filter((member) => member.accessClass === 'guest');
    if (peopleNeedingConfirmation.length > 0 || (workstream.scope === 'personal' && invitedEmails.length > 0)) {
      setPendingConfirmation({
        text: trimmed,
        mentions: submitted.mentions,
        members: peopleNeedingConfirmation,
        invitedEmails,
        ...(workstream.harnessStatus === 'running' ? { deliveryMode: 'steer' as const } : {}),
      });
      return;
    }
    const mentions = submitted.mentions;
    const revision = draftRevisionRef.current;
    const submittedDeliveryMode = workstream.harnessStatus === 'running' ? 'steer' as const : undefined;
    resetDraft();
    try {
      await submitMessage(trimmed, mentions, undefined, submittedDeliveryMode, ...invitedArgument(invitedEmails));
    } catch {
      restoreDraft(trimmed, mentions, revision);
    }
  };

  const confirmationNames = pendingConfirmation
    ? [...pendingConfirmation.members.map((member) => member.name), ...pendingConfirmation.invitedEmails]
    : [];

  const confirmAddAndSend = async (): Promise<void> => {
    if (!pendingConfirmation) return;
    const submitted = pendingConfirmation;
    const revision = draftRevisionRef.current;
    setConfirming(true);
    setPendingConfirmation(null);
    resetDraft();
    try {
      await submitMessage(
        submitted.text,
        submitted.mentions,
        submitted.members.map((member) => member.id),
        submitted.deliveryMode,
        ...invitedArgument(submitted.invitedEmails),
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
          {mentionGroups.map((group) => (
            <div key={group.label ?? 'rally'} role="group" aria-label={group.label ?? 'Rally'}>
              {group.label && <div className="mention-popover-heading" aria-hidden="true">{group.label}</div>}
              {group.candidates.map((candidate, localIndex) => {
                const index = group.startIndex + localIndex;
                return (
                  <button
                    aria-label={[candidate.label, candidate.description, mentionKindLabel(candidate)].filter(Boolean).join(' — ')}
                    aria-selected={index === mentionNavigation.activeIndex}
                    className={clsx(index === mentionNavigation.activeIndex && 'is-selected', candidate.kind === 'invitee' && 'is-invited', candidate.kind === 'sidekick' && 'is-sidekick')}
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
                        : candidate.sidekick
                        ? <span className="mention-icon-sidekick">
                          <AutomationGlyph {...(candidate.sidekick.appearance ? { appearance: candidate.sidekick.appearance } : {})} id={candidate.sidekick.id} />
                        </span>
                        : candidate.kind === 'invitee'
                        ? <Avatar member={inviteeAsMember(candidate.label)} size="small" />
                        : <RallyAvatar size="small" />}
                    </span>
                    <span className="mention-popover-copy">
                      <strong>{candidate.label}</strong>
                      {candidate.kind !== 'rally' && candidate.description && <small>{candidate.description}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div>
        <ComposerAgentActivity count={backgroundAgentCount} />
        <ComposerAgentActivity count={runningSidekickCount} kind="sidekick" />
      </div>
      <ComposerInput
        api={api}
        ariaLabel={ariaLabel ?? placeholder.replace(/…$/u, '')}
        beforeInput={annotationsEnabled ? <AnnotationChips /> : undefined}
        attachments={attachments}
        autoFocus={autoFocus}
        {...(className ? { className } : {})}
        error={!annotationPayloadValid ? 'These pins are too large to send together.' : annotationAttachmentCount + attachments.length > MAX_ATTACHMENTS ? 'Send no more than 10 images and attachments together.' : error}
        {...(footerHint ? { footerHint } : {})}
        {...(notice ? { notice } : {})}
        {...(toolsAccessory ? { toolsAccessory } : {})}
        {...(submitContent ? { submitContent } : {})}
        fileInputRef={fileInputRef}
        layout="message-capsule"
        {...(onAttach ? { onAttach } : {})}
        {...(menuActions ? { menuActions } : {})}
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
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            onCancel();
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
        submitDisabled={sendBlocked || annotationBlocked || uploading || (!text.trim() && readyAttachmentCount === 0 && !hasCommentedPin)}
        submitLabel={sendBlocked ? `${submitLabel}, available once Rally connects` : submitLabel}
        submitting={sending}
        uploading={uploading}
        value={text}
      />

      <Modal
        description={confirmationNames.length > 1
          ? `${confirmationNames.join(', ')} are not currently participants. Would you like to add them with this message? If you do not add them, they will not be able to see the mentions or this ${substreamId === '0' ? 'thread' : 'breakout'}.`
          : `${confirmationNames[0] ?? 'This person'} is not currently a participant. Would you like to add them with this message? If you do not add them, they will not be able to see the mention or this ${substreamId === '0' ? 'thread' : 'breakout'}.`}
        footer={
          <>
            <Button disabled={confirming} onClick={() => setPendingConfirmation(null)}>Cancel</Button>
            <Button className="button-primary" disabled={confirming} onClick={() => void confirmAddAndSend()}>
              {confirming ? <LoaderCircle className="spin" size={14} /> : <UserPlus size={14} />}
              {confirmationNames.length > 1 ? 'Add all and mention' : 'Add and mention'}
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (!open && !confirming) setPendingConfirmation(null);
        }}
        open={Boolean(pendingConfirmation)}
        title={confirmationNames.length > 1 ? 'Add participants?' : 'Add participant?'}
      >
        {pendingConfirmation?.members.map((member) => (
          <div className="mention-confirm-person" key={member.id}>
            <Avatar member={member} size="large" />
            <span><strong>{member.name}</strong><small>{member.email}</small></span>
          </div>
        ))}
        {/* Shared by address: they join when they sign in with it. */}
        {pendingConfirmation?.invitedEmails.map((email) => (
          <div className="mention-confirm-person is-invited" key={email}>
            <Avatar member={inviteeAsMember(email)} size="large" />
            <span><strong>{email}</strong><small>Invited · joins when they sign in</small></span>
          </div>
        ))}
      </Modal>
    </div>
  );
}
