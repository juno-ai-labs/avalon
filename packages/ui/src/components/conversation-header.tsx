import * as Tooltip from '@radix-ui/react-tooltip';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { Check, Copy, Ellipsis, Info, LoaderCircle, Lock, Mail, Menu, Monitor, PanelRight, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import { harnessMarkerStatus } from '../lib/format';
import { isComposingKeyEvent } from '../lib/ime';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { useTextClipped } from '../lib/use-text-clipped';
import type { ConversationPresentation, SocketState } from '../lib/types';
import { AvatarStack, Badge, IconButton, InlineError, SocketStatusIndicator, StatusDot, TitleSkeleton } from './primitives';
import { WorkstreamGlyph } from './workstream-glyph';
import { AppearancePicker } from './appearance-picker';
const RENAME_HINT = 'Click to rename. Press Enter to save.';

export function ConversationHeader({
  grokBotMode = false,
  substreamId = '0',
  workstream,
  socketState,
  onAddParticipant,
  onOpenRail,
  onRename,
  onAppearanceChange,
  presentUserIds = [],
  currentUserId = null,
  onCopyLink, onCopyEmail, onCopyId, onShowNavigation,
  railOpen = false, railVariant = "context", onCloseRail, contextEnabled = false, actions,
}: {
  grokBotMode?: boolean;
  substreamId?: string;
  workstream: ConversationPresentation;
  socketState: SocketState;
  onAddParticipant: () => void;
  onOpenRail: (variant: "context") => void;
  onRename: (title: string) => Promise<void>;
  onAppearanceChange?: (patch: WorkstreamAppearancePatch) => Promise<void>;
  presentUserIds?: readonly string[];
  currentUserId?: string | null;
  onCopyLink?: () => void; onCopyEmail?: () => void; onCopyId?: () => void;
  onShowNavigation: () => void; railOpen?: boolean; railVariant?: 'context'; onCloseRail?: () => void;
  contextEnabled?: boolean; actions?: React.ReactNode;
}): React.JSX.Element {
  // The right sidebar holds one panel at a time, so every control that opens it
  // reads as pressed while its own panel is the one showing, and closes it
  // again from that state.
  const showing = (variant: "context"): boolean => railOpen && railVariant === variant;
  const toggleRail = (variant: "context"): void => {
    if (showing(variant)) onCloseRail?.();
    else onOpenRail(variant);
  };
  // A null draft means the heading is displayed; any string means the inline
  // editor is open, so there is one source of truth for both.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // The route keeps this component mounted across work streams, so an open
  // editor would otherwise carry the previous stream's draft into the next one.
  // The ref lets an in-flight rename recognize that it is no longer the one on
  // screen: the promise it is waiting on outlives the navigation.
  const conversationKey = `${workstream.id}:${substreamId}`;
  const shownWorkstreamId = useRef({ key: conversationKey, visit: 0 });
  if (shownWorkstreamId.current.key !== conversationKey) {
    shownWorkstreamId.current = { key: conversationKey, visit: shownWorkstreamId.current.visit + 1 };
  }
  useEffect(() => {
    setRenameDraft(null);
    setRenameFailed(false);
    setRenaming(false);
  }, [conversationKey]);
  // Closing the editor unmounts the field, which would leave focus on the body
  // and strand a keyboard user at the top of the document. The title button
  // does not exist until the next render, so the focus call waits for it.
  const titleButton = useRef<HTMLButtonElement>(null);
  const returnFocusToTitle = useRef(false);
  useEffect(() => {
    if (renameDraft !== null || !returnFocusToTitle.current) return;
    returnFocusToTitle.current = false;
    titleButton.current?.focus();
  }, [renameDraft]);
  // The measurement needs the same element, but as state rather than a ref: the
  // heading is swapped out for the editor and for the naming skeleton, and a
  // mutable ref changing does not re-run an effect, so the button coming back
  // would otherwise go unmeasured. The ref above stays because focus is set
  // during an effect, where reading the current node is the point.
  const [titleNode, setTitleNode] = useState<HTMLButtonElement | null>(null);
  const attachTitleButton = useCallback((node: HTMLButtonElement | null) => {
    titleButton.current = node;
    setTitleNode(node);
  }, []);
  const titleClipped = useTextClipped(titleNode, workstream.title);
  const renameHintId = useId();
  const startRename = (): void => {
    setRenameDraft(workstream.title);
    setRenameFailed(false);
  };
  const cancelRename = (): void => {
    returnFocusToTitle.current = true;
    setRenameDraft(null);
    setRenameFailed(false);
  };
  const submitRename = async (): Promise<void> => {
    const title = renameDraft?.trim() ?? '';
    if (!title || renaming) return;
    // An unchanged name is a no-op rather than a request; the editor still
    // closes, so Save never looks inert.
    if (title === workstream.title) {
      cancelRename();
      return;
    }
    // Every completion below is guarded on the work stream still being the one
    // on screen. Navigating away mid-flight otherwise lands the old stream's
    // failure under the new stream's title, or closes an editor the user has
    // since opened on it.
    const submittedFor = shownWorkstreamId.current;
    setRenaming(true);
    setRenameFailed(false);
    try {
      await onRename(title);
      if (shownWorkstreamId.current !== submittedFor) return;
      returnFocusToTitle.current = true;
      setRenameDraft(null);
    } catch {
      if (shownWorkstreamId.current !== submittedFor) return;
      setRenameFailed(true);
    } finally {
      if (shownWorkstreamId.current === submittedFor) setRenaming(false);
    }
  };
  const naming = useNamingSkeleton(workstream);

  const titleContent = (naming ? (
    <h1><TitleSkeleton className="title-skeleton-header" /></h1>
  ) : renameDraft === null ? (
    <>
      <h1>
        <button
          aria-describedby={renameHintId}
          aria-keyshortcuts="Enter F2"
          className="workstream-title-button"
          onClick={startRename}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault();
              startRename();
            }
          }}
          ref={attachTitleButton}
          // A clipped title is unreadable anywhere else on the screen,
          // so the tooltip leads with the name and keeps the hint under
          // it. The tooltip is for the reader who cannot see the name:
          // the button's accessible name is its text, which is the
          // whole title however little of it fits, so `aria-describedby`
          // above keeps the description down to the hint rather than
          // letting `title` announce the name a second time.
          title={titleClipped ? `${workstream.title}\n${RENAME_HINT}` : RENAME_HINT}
          type="button"
        >
          {workstream.title}
        </button>
      </h1>
      {/* Outside the heading on purpose: inside it, this text would
          join the heading's own name and be read as part of it. */}
      <span className="sr-only" id={renameHintId}>{RENAME_HINT}</span>
    </>
  ) : (
    <form
      className="workstream-title-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void submitRename();
      }}
    >
      <input
        aria-label="Work stream name"
        autoFocus
        className="workstream-title-input"
        disabled={renaming}
        // The contract caps a title at 180, and the sidebar's dialog
        // already stops there. Without the same cap the server
        // rejects the save with a message that never mentions length.
        maxLength={180}
        onChange={(event) => {
          setRenameDraft(event.currentTarget.value);
          // The reason for a failed save stands in for the status
          // line, so it cannot outlive the draft that caused it.
          setRenameFailed(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          // While an IME is composing, Escape cancels the candidate
          // rather than the rename — discarding the draft here would
          // throw away a name somebody is halfway through typing,
          // with nothing to undo it. See `../lib/ime.ts`.
          if (isComposingKeyEvent(event.nativeEvent)) {
            if (event.key === 'Enter') event.preventDefault();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
          }
        }}
        value={renameDraft}
      />
      <IconButton
        className="title-edit-save"
        disabled={renaming || renameDraft.trim().length === 0}
        label="Save name"
        type="submit"
      >
        {renaming ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
      </IconButton>
      <IconButton className="title-edit-cancel" disabled={renaming} label="Cancel rename" onClick={cancelRename}>
        <X size={15} />
      </IconButton>
    </form>
  ));

  if (grokBotMode) {
    return (
      <header className="grokbot-workstream-header window-drag">
        <div className="grokbot-header-navigation window-no-drag">
          <IconButton className="header-menu-button" label="Open navigation" onClick={() => onShowNavigation()}>
            <Menu size={16} />
          </IconButton>
        </div>
        {naming ? (
          <h1><TitleSkeleton className="title-skeleton-header" /></h1>
        ) : (
          <div className="grokbot-conversation-title">
              {onAppearanceChange ? <AppearancePicker key={workstream.id} id={workstream.id} appearance={workstream.appearance} label="Change work-stream icon and color" onChange={onAppearanceChange} renderGlyph={(appearance) => <WorkstreamGlyph id={workstream.id} appearance={appearance} size={20} />} /> : <WorkstreamGlyph id={workstream.id} appearance={workstream.appearance} size={20} />}
              {titleContent}
              {renameFailed && <InlineError>That work stream couldn’t be renamed. Try again.</InlineError>}
          </div>
        )}
        <div className="grokbot-header-actions window-no-drag">
          {actions}
          <Tooltip.Root delayDuration={300}>
            <Tooltip.Trigger asChild>
              <button
                className="participant-header-button"
                aria-label={substreamId === '0' ? 'Manage work-stream participants' : 'Manage substream participants'}
                aria-description={workstream.participants.map((person) => person.name).join(', ')}
                onClick={onAddParticipant}
                type="button"
              >
                <AvatarStack members={workstream.participants} currentUserId={currentUserId} presentUserIds={substreamId === '0' ? presentUserIds : []} showTooltip={false} />
                <UserPlus aria-hidden="true" size={13} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip" side="bottom" sideOffset={6}>
                {naming ? 'Participants of this conversation' : `Participants of ${workstream.title}`}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          {contextEnabled && <IconButton
            aria-pressed={showing('context')}
            className="grokbot-computer-button"
            label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
            onClick={() => toggleRail('context')}
          >
            <Monitor size={16} strokeWidth={1.8} />
          </IconButton>}
        </div>
      </header>
    );
  }

  return (
    <header className="workstream-header window-drag">
      <div className="workstream-header-left window-no-drag">
        <IconButton className="header-menu-button" label="Open navigation" onClick={() => onShowNavigation()}><Menu size={16} /></IconButton>
        {onAppearanceChange ? <AppearancePicker key={workstream.id} id={workstream.id} appearance={workstream.appearance} label="Change work-stream icon and color" onChange={onAppearanceChange} renderGlyph={(appearance) => <WorkstreamGlyph id={workstream.id} appearance={appearance} size={30} />} /> : <WorkstreamGlyph id={workstream.id} appearance={workstream.appearance} size={30} />}
        <div className="workstream-title-block">
          {/* The one place a title arriving on its own is worth announcing. A
              work stream created a second ago is named while its author is
              looking at it, and a skeleton that says a name is coming owes
              them the name — the sidebar rows deliberately stay silent, since
              a list that announces once per unnamed row is noise. Live is off
              while the editor is open: the person renaming it is typing the
              new name and does not need it read back, and the swap between
              heading and form is not news. */}
          <div
            aria-live={renameDraft === null ? 'polite' : 'off'}
            className="workstream-title-line"
          >
            {titleContent}
            {/* Only its participant can open this one, so say so where they are
                reading it rather than only in the sidebar they came from. */}
            {workstream.scope === 'personal' && <Badge className="badge-private"><Lock aria-hidden="true" size={9} /> Private</Badge>}
          </div>
          <div className="workstream-subtitle">
            {renameFailed ? (
              <InlineError>That work stream couldn’t be renamed. Try again.</InlineError>
            ) : (
              <>
                <StatusDot status={harnessMarkerStatus(workstream.harnessStatus)} />
              </>
            )}
          </div>
        </div>
      </div>
      <div className="workstream-header-actions window-no-drag">
        <SocketStatusIndicator state={socketState} />
        <button className="participant-header-button" onClick={onAddParticipant} type="button">
          <AvatarStack
            currentUserId={currentUserId}
            members={workstream.participants}
            presentUserIds={presentUserIds}
          />
          <UserPlus aria-hidden="true" size={13} />
          <span className="sr-only">Add participant</span>
        </button>
        {contextEnabled && <IconButton
          aria-pressed={showing('context')}
          className={clsx('panel-toggle', showing('context') && 'is-active')}
          label={showing('context') ? 'Hide work-stream context' : 'Work-stream context'}
          onClick={() => toggleRail('context')}
        >
          <PanelRight size={15} />
        </IconButton>}
        {actions}
        {(onCopyLink || onCopyEmail || onCopyId) && <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><IconButton label="More work-stream actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              {onCopyLink && <DropdownMenu.Item className="menu-item" onSelect={onCopyLink}><Copy size={14} /> Copy work-stream link</DropdownMenu.Item>}
              {workstream.emailAddress && onCopyEmail && (
                <DropdownMenu.Item className="menu-item" onSelect={onCopyEmail}><Mail size={14} /> Copy work-stream email address</DropdownMenu.Item>
              )}
              {onCopyId && <DropdownMenu.Item className="menu-item" onSelect={onCopyId}><Info size={14} /> Copy work-stream ID</DropdownMenu.Item>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </div>
    </header>
  );
}
