import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE, type WorkspaceInvitee } from '@rally/contracts';
import type { AgentModelOverride } from '../lib/agent-models';
import { Pencil, X } from 'lucide-react';
import { IconCornerDownRight } from '@tabler/icons-react';
import {
  useEffect, type ReactNode, useRef, useState } from 'react';
import type { RallyApi, MentionIdentity } from '../lib/api';
import { readDraftText, writeDraftText } from '../lib/draft-cache';
import { workstreamDraftKey } from '../lib/draft-keys';
import { optimisticMentionRendering } from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import type { Message, MessageAttachment, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { RallyRegion } from '../../common/desktop';
import { AgentWorkTiming } from './agent-work-timing';
import { BreakoutOrigin } from './breakout-origin';
import { ConnectingCardSlot } from './connecting-card';
import type { AttachmentPreview } from './attachments';
import { IconButton, TitleSkeleton } from './primitives';
import { TitlePillNavigation } from '@rally/ui/components/title-pill';
import { MessageBlock } from './workstream-blocks';
import { type ComposerConversation, WorkstreamComposer } from './workstream-composer';

/**
 * The substream a person is writing the first message of.
 *
 * It is the only state a substream has before it exists: nothing has been
 * reserved on the server and nothing has been asked of a model. Creation is
 * one request, sent on the keystroke that submits this composer, so backing
 * out of this surface costs a `setState` and leaves nothing behind.
 */
export interface SubstreamDraft {
  /** A drafted opening prompt to seed the composer with, once, over an empty draft. */
  initialDraft?: string | undefined;
  /**
   * The main-conversation turn this branches from, or null when it was started
   * from the sidebar and branches from wherever the conversation has reached.
   */
  throughTurnId: string | null;
  /** The branch point and the turns that led to it, oldest first. */
  provenance: readonly Message[];
}

/**
 * What the surface shows between pressing enter and the substream existing.
 *
 * The same shape the work-stream launcher holds, and for the same reason: the
 * create round trip freezes a context, writes a child, and starts a run, and
 * until this existed the person who pressed enter watched a modal spinner over
 * the conversation they had just left.
 */
export interface LaunchingSubstream {
  attachments: MessageAttachment[];
  /** Frozen at submit so the optimistic turn and the persisted one agree. */
  createdAt: string;
  text: string;
  /** The popover selections, so the drawn turn shows chips rather than plain `@Name`. */
  mentions: MentionIdentity[];
  /** Drives the work timer, which the created substream keeps counting from. */
  startedAt: number;
}

export interface SubstreamLaunchProps {
  api: RallyApi | null;
  /**
   * The parent's connecting card while the parent is a local-cache seed. A
   * branch taken from a seed would persist a turn id the room has not
   * confirmed, so the launch surface carries the same card and the same gate
   * as the conversation it stands in front of.
   */
  connecting?: ReactNode;
  /** The parent is a seed: the composer accepts the words and does not create. */
  sendBlocked?: boolean;
  /**
   * Who is writing, where the session has resolved one. Absent only while a
   * session is being torn down, and the surface still draws: the composer, the
   * branch turns and the words in it do not depend on knowing whose they are.
   */
  currentUser: WorkspaceMember | undefined;
  members: WorkspaceMember[];
  /** People invited to the Organization who have not joined, offered after the members. */
  invitees?: readonly WorkspaceInvitee[];
  /** The work stream the substream is being branched out of. */
  parent: WorkstreamDetail;
  draft: SubstreamDraft;
  launching: LaunchingSubstream | null;
  error?: string | undefined;
  onCancel: () => void;
  /**
   * How a turn drawn here fetches an attachment's bytes. `MessageBlock` shows
   * an attachment row only when it has both this and `onOpenAttachment`, so
   * without it a message with files renders as text alone — on the branch
   * turns, and on the optimistic turn whose whole job is to be what the
   * created substream will draw.
   */
  loadAttachmentContent?: ((id: string, signal?: AbortSignal) => Promise<Blob>) | undefined;
  /**
   * Create the substream with this message. Rejects when creation failed, which
   * is what puts the words back in the composer: the draft is cleared before
   * this is awaited, exactly as an ordinary send clears it.
   */
  onCreate: (opening: {
    text: string;
    mentions: MentionIdentity[];
    confirmedParticipantUserIds: string[];
    /** Invitees the opening message names, whom the host shares the breakout with once it exists. */
    invitedEmails: string[];
    attachments: MessageAttachment[];
    attachmentIds: string[];
    /**
     * The model every run of this substream is pinned to, or null for the
     * ordinary unpinned case. It travels with the opening message because it
     * was decided on the same keystroke: creation is one request, and the pin
     * is part of what that request creates.
     */
    modelOverride: AgentModelOverride | null;
  }) => Promise<void>;
  onOpenAttachment: (preview: AttachmentPreview) => void;
  /**
   * The origin card the created breakout opens with (`BreakoutOrigin`), drawn
   * from the submit keystroke so the opening turn lands where the breakout
   * will draw it.
   */
  origin?: { channelTitle: string; context: Message[]; origin: Message };
  /** The created conversation's header is a title pill: a thread's breakout, not a Sidekick's. */
  titlePill?: boolean;
  workspaceId: string;
  workspaceRegion: RallyRegion;
}

/**
 * The three rows of a substream being started: what it branches from, the
 * composer that starts it, and — once enter is pressed — the turn and the work
 * timer the created substream carries on showing.
 *
 * It is one fragment rather than a screen because it stands *inside* the
 * conversation column: the work stream's sidebar, header rail and inspector
 * belong to the parent and do not change while a child is being written. The
 * geometry is `.workstream-launch-screen`'s, shared with the work-stream
 * launcher, so both hand-offs settle the same composer into the same dock.
 */
export function SubstreamLaunchSurface({
  api,
  connecting = null,
  currentUser,
  members,
  invitees,
  parent,
  draft,
  launching,
  error,
  loadAttachmentContent,
  onCancel,
  onCreate,
  onOpenAttachment,
  origin,
  sendBlocked = false,
  titlePill = false,
  workspaceId,
  workspaceRegion,
}: SubstreamLaunchProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tooLong, setTooLong] = useState(false);
  /**
   * The model this substream will be pinned to, until it is created.
   *
   * It starts unpinned rather than inheriting the parent's pin. A substream is
   * its own conversation with its own row, and every substream created before
   * this control existed follows the flag whatever its parent named — so
   * seeding this with the parent's model would change what an untouched
   * composer does, silently, for work nobody was making a decision about.
   */
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  // Its own draft key, so a message written for a substream that was never
  // created is not carrying into — or worse, out of — the main conversation's
  // composer. `new` is not a substream id: every real one is a UUID.
  const draftKey = workstreamDraftKey(workspaceRegion, workspaceId, parent.id, PENDING_SUBSTREAM_DRAFT_ID);
  // A suggestion's drafted opening prompt is written into the launch draft once,
  // when the pane opens, over an empty draft or over a seed an earlier launch
  // left untouched: a person's own words are never overwritten, and a pane
  // opened without a seed clears one left behind, so the shared pending draft
  // never carries another suggestion's prompt. The composer mounts after the
  // write so it hydrates the seeded words (docs/conversation-suggestions.md).
  const [draftSeeded, setDraftSeeded] = useState(!draft.initialDraft && !seededPrompts.has(draftKey));
  // The notice saying the words are Rally's: only over words this pane seeded,
  // and only until the person edits them.
  const [draftedNotice, setDraftedNotice] = useState(false);
  useEffect(() => {
    if (draftSeeded) return;
    let cancelled = false;
    void readDraftText(draftKey).then(async (current) => {
      const text = current?.text ?? '';
      const untouchedSeed = text.trim().length === 0 || text === seededPrompts.get(draftKey);
      if (draft.initialDraft) {
        if (!untouchedSeed) return;
        await writeDraftText(draftKey, draft.initialDraft);
        seededPrompts.set(draftKey, draft.initialDraft);
        if (!cancelled) setDraftedNotice(true);
      } else if (untouchedSeed && text.length > 0) {
        await writeDraftText(draftKey, '');
        seededPrompts.delete(draftKey);
      }
    }).finally(() => { if (!cancelled) setDraftSeeded(true); });
    return () => { cancelled = true; };
    // Once, on open: the draft is the pane's for as long as it stays open.
  }, []);
  const attachmentDraft = useFileAttachments(api, draftKey);
  /**
   * The conversation the composer believes it is writing into.
   *
   * A substream starts private and idle: only its creator is in it, and there
   * is no run to steer or stop. Handing the composer the parent's own detail
   * would offer a Stop button for the parent's run and treat the parent's
   * participants as people already in this substream, so neither mention would
   * be confirmed and neither person would be added.
   */
  const pendingChild: ComposerConversation = {
    scope: 'personal',
    // Nothing is running in a substream that does not exist, and the composer
    // reads this to decide whether it is steering a run or starting one.
    harnessStatus: 'completed',
    stopRequested: false,
    participants: currentUser ? [{ ...currentUser, role: 'creator' }] : [],
  };

  const send = async (
    text: string,
    mentions: MentionIdentity[],
    confirmedParticipantUserIds: string[] = [],
    _deliveryMode?: unknown,
    invitedEmails: string[] = [],
  ): Promise<void> => {
    // Before anything optimistic. A substream that cannot be created must
    // never be one that appears to open, and the person is the only one who
    // can resolve this.
    if (text.length > MESSAGE_MAX_CHARACTERS) {
      setTooLong(true);
      throw new Error(MESSAGE_TOO_LONG_MESSAGE);
    }
    setTooLong(false);
    const lease = await attachmentDraft.leaseReady();
    const createdAt = new Date().toISOString();
    const attachments = lease.attachments.flatMap((attachment) => attachment.resource ? [{
      id: attachment.resource.id,
      fileName: attachment.resource?.title ?? attachment.file.name,
      mimeType: attachment.resource?.mimeType ?? (attachment.file.type || 'application/octet-stream'),
      sizeBytes: attachment.file.size,
      contentAvailable: true,
      createdAt,
    }] : []);
    try {
      await onCreate({
        text,
        mentions,
        confirmedParticipantUserIds,
        invitedEmails,
        attachments,
        attachmentIds: attachments.map((attachment) => attachment.id),
        modelOverride,
      });
      attachmentDraft.commitLease(lease.leaseId);
    } catch (failure) {
      await attachmentDraft.restoreLease(lease.leaseId);
      throw failure;
    }
  };

  const openingMentions = launching ? optimisticMentionRendering(launching.text, launching.mentions, members) : null;
  const openingTurn: Message | null = launching && openingMentions
    ? {
      id: 'launching-substream-message',
      workstreamId: parent.id,
      sequenceNumber: 1,
      authorType: 'human',
      ...(currentUser ? { author: currentUser } : {}),
      messageType: 'text',
      text: openingMentions.text,
      mentions: openingMentions.mentions,
      attachments: launching.attachments,
      createdAt: launching.createdAt,
    }
    : null;

  return <>
    {launching && titlePill ? (
      // The pill a starting thread shows (`ConversationOpeningSkeleton`), in
      // the 64px row the created breakout's title pill sits in, so the header
      // neither moves nor changes shape when the breakout takes over.
      <header className="launch-header title-pill-header window-drag conversation-opening-header">
        <div className="title-pill-ancestors"><TitlePillNavigation /></div>
        <div className="title-pill-current"><span className="skeleton-bar title-pill-skeleton" /></div>
        <div className="title-pill-trailing" />
      </header>
    ) : (
      <header className="launch-header workstream-header window-drag">
        {launching && (
          <div className="workstream-header-left window-no-drag">
            <div className="workstream-title-block">
              {/* The same skeleton the created substream shows while the naming
                  pass answers, so the header does not change hands at the swap:
                  it is already waiting for the same name. */}
              <div className="workstream-title-line">
                <h1><TitleSkeleton className="title-skeleton-header" /></h1>
              </div>
            </div>
          </div>
        )}
      </header>
    )}

    <div className="launch-body">
      <div className="launch-transcript-layer transcript-scroll">
        <ConnectingCardSlot>{connecting}</ConnectingCardSlot>
        <div className="transcript-column substream-launch-column">
          {/* Only while somebody is still composing. What is being branched
              from is a fact about writing this substream rather than about the
              substream, and from the submit keystroke this column holds what
              the created child holds: leaving the turns in it — collapsing,
              faded, or inert — leaves the opening turn displaced by whatever
              height they still have, and creation can finish before any
              transition does. What the child holds includes its origin card,
              so that takes their place on the keystroke. */}
          {launching === null && draft.provenance.length > 0 && (
            <section aria-label="Branching from" className="substream-branch-context">
              {draft.provenance.map((message) => (
                <MessageBlock
                  {...(currentUser ? { currentUserId: currentUser.id } : {})}
                  key={message.id}
                  {...(loadAttachmentContent ? { loadAttachmentContent } : {})}
                  message={message}
                  onAnswerElicitation={async () => undefined}
                  onOpenAttachment={onOpenAttachment}
                />
              ))}
            </section>
          )}
          {launching && origin && (
            <BreakoutOrigin channelTitle={origin.channelTitle} context={origin.context} origin={origin.origin} />
          )}
          {openingTurn && (
            <div className="launch-arrival" style={{ '--arrival-index': 0 } as React.CSSProperties}>
              <MessageBlock
                {...(currentUser ? { currentUserId: currentUser.id } : {})}
                {...(loadAttachmentContent ? { loadAttachmentContent } : {})}
                message={openingTurn}
                onAnswerElicitation={async () => undefined}
                onOpenAttachment={onOpenAttachment}
              />
            </div>
          )}
          {launching && (
            <div className="launch-arrival" style={{ '--arrival-index': 1 } as React.CSSProperties}>
              {/* What the wait is: the substream is being created and its
                  first instruction admitted. The created child starts its own
                  timer when its room reports the run — an opening message
                  leaves a pending input rather than a run id, so there is
                  nothing here to hand across, and `launchedSubstreamDetail`
                  says why at the field that would carry it. */}
              <AgentWorkTiming active durationMs={0} startedAt={launching.startedAt} />
            </div>
          )}
        </div>
      </div>
    </div>

    <section aria-labelledby="new-substream-heading" className="composer-dock launch-dock">
      <h2 className="sr-only" id="new-substream-heading">Start a new breakout</h2>
      <div className="launch-modifiers">
        <div className="substream-launch-banner">
          <span className="substream-launch-label">
            <IconCornerDownRight aria-hidden="true" size={20} stroke={1.5} />
            <span>{draft.throughTurnId
              ? 'New breakout from this message'
              : 'New breakout'}</span>
          </span>
          <span className="substream-launch-note">
            Private to you until you add somebody. Rally brings the conversation so far with it.
          </span>
          {/* Only while there is something to cancel. The row leaves on submit,
              but it leaves over 220ms and stays in the tab order while it does,
              and this control does not stop a creation that is already in
              flight: it would drop the surface while prepare and confirm ran
              on, leaving a substream and a run behind somebody who had just
              said no. Creation is not cancellable once it is claimed. */}
          <IconButton
            disabled={launching !== null}
            label="Cancel new breakout"
            onClick={onCancel}
          ><X size={15} /></IconButton>
        </div>
      </div>
      <div className="composer-stack">
        {draftSeeded && <WorkstreamComposer annotationsEnabled={false}
          api={api ?? undefined}
          attachments={attachmentDraft.attachments}
          autoFocus
          error={(tooLong ? MESSAGE_TOO_LONG_MESSAGE : undefined) ?? error ?? attachmentDraft.error}
          fileInputRef={fileInputRef}
          footerHint={sendBlocked ? 'Starting a breakout is available once Rally connects' : 'Enter to create · Shift+Enter for a new line'}
          members={members}
          {...(invitees ? { invitees } : {})}
          model={{ kind: 'choice', value: modelOverride, onChange: setModelOverride }}
          {...(draftedNotice ? { notice: <><Pencil aria-hidden="true" size={13} />Drafted by Rally from this thread. Edit it, then start.</> } : {})}
          onAttach={attachmentDraft.addFiles}
          onDraftChange={(value) => { if (value !== draft.initialDraft) { setDraftedNotice(false); seededPrompts.delete(draftKey); } }}
          onOpenAttachment={onOpenAttachment}
          onRemoveAttachment={attachmentDraft.removeAttachment}
          onRetryAttachment={attachmentDraft.retryAttachment}
          onSend={send}
          onStop={async () => undefined}
          placeholder="What should this breakout work on?"
          sendBlocked={sendBlocked}
          sending={launching !== null}
          submitLabel="Create breakout"
          substreamId={PENDING_SUBSTREAM_DRAFT_ID}
          uploading={attachmentDraft.uploading}
          draftKey={draftKey}
          workstream={pendingChild}
        />}
      </div>
    </section>
  </>;
}

/**
 * What the composer of a substream that does not exist yet names its draft.
 *
 * Every real substream id is a UUID, so this cannot collide with one, and the
 * draft it keys survives leaving the surface and coming back to it — the same
 * promise every other composer in Rally makes about words somebody typed.
 */
export { PENDING_SUBSTREAM_DRAFT_ID } from '@rally/ui/components/conversation-menus';
import { PENDING_SUBSTREAM_DRAFT_ID } from '@rally/ui/components/conversation-menus';

/**
 * The prompt each pending launch draft was last seeded with, by draft key, so
 * a later launch can tell Rally's untouched words from a person's own.
 * Session-local on purpose: a restart starts from the stored draft alone.
 */
const seededPrompts = new Map<string, string>();
