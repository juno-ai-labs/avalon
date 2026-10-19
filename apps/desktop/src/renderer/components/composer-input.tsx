import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { ArrowUp, AtSign, Check, ChevronDown, LoaderCircle, Mic, Paperclip, Plus } from 'lucide-react';
import {
  forwardRef,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AGENT_MODEL_GROUPS,
  UNPINNED_AGENT_MODEL,
  UNPINNED_AGENT_MODEL_LABEL,
  agentModelInUseLabel,
  agentModelInUseTriggerLabel,
  agentModelLabel,
  agentModelTriggerLabel,
  type AgentModelOverride,
} from '../lib/agent-models';
import { isComposingKeyEvent } from '../lib/ime';
import {
  continueListAtCaret,
  type DraftEdit,
  type ListMarkerKind,
  selectionTouchesListItem,
  shiftListAtCaret,
  toggleListAtSelection,
} from '../lib/markdown-lists';
import { normalizeMentionLabels, splitMentionHighlights } from '../lib/mention-highlight';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { appendDictationTranscript, type RealtimeDictationApi, useRealtimeDictation } from '../lib/use-realtime-dictation';
import { useFileDrop } from '../lib/use-file-drop';
import { useFilePaste } from '../lib/use-file-paste';
import { MAX_ATTACHMENTS } from '../lib/attachment-limits';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { type AttachmentPreview, PendingAttachmentTile } from './attachments';
import { IconButton, InlineError, Tip } from './primitives';

/**
 * The model control a composer offers, in whichever of its two shapes fits
 * where that composer stands.
 *
 * Named and exported rather than inlined on the props: the substream launcher
 * hands its shape through `WorkstreamComposer` on the way here, and two
 * declarations of the same union are two things to keep in step.
 *
 * `choice` offers the model this composer's work will run on, pinning it ahead
 * of the `agent-model-workstream` flag. `value` is `null` until something is
 * chosen, which is what keeps an untouched composer on the flag rather than
 * silently pinning every conversation a developer starts. That state is shown
 * as **Default** rather than as a model name: which model it resolves to is the
 * flag's answer, and this process cannot see the served variation.
 *
 * `settled` is the same control with its trigger disabled: it shows the model
 * already in force and does not open. The pin is written once, when the
 * conversation is created, and nothing afterwards edits it — so there is no
 * decision left to offer, and offering one would promise a change the next run
 * would not honour. The control stays anyway because the question it answers
 * survives the decision: a developer reading a transcript wants to know which
 * model wrote it, and until this existed the only way to find out was the
 * database.
 */
export type ComposerModelControl =
  | {
    kind: 'choice';
    value: AgentModelOverride | null;
    onChange: (model: AgentModelOverride | null) => void;
  }
  | {
    kind: 'settled';
    /**
     * The model this conversation is on: what its latest run recorded, or its
     * pin where that run recorded nothing. Any OpenRouter id, not only one the
     * pin list admits — an unpinned conversation runs on whatever the flag
     * served. Null where neither is known, which is only a conversation with no
     * run and no pin, and reads as **Default** for the same reason a fresh
     * composer does.
     */
    model: string | null;
    /**
     * Whether the conversation carries a pin. It changes what the control may
     * honestly claim, not what it shows: a pinned conversation runs on `model`
     * every time, while an unpinned one re-resolved the flag to get there and
     * may resolve differently next launch. Both are equally unchangeable
     * *here* — that is the disable — but only one of them is fixed.
     */
    pinned: boolean;
  };

/**
 * A host's own entry in the message capsule's "+" menu, listed after Attach
 * files when the host takes attachments. The menu shows whenever it has an
 * entry, so a host without attachments can still offer these. The composer draws it and calls `onSelect`; what it does belongs to
 * the host, so a surface can offer an action that only makes sense there.
 */
export interface ComposerMenuAction {
  /**
   * Why the action cannot run here. The entry still shows, disabled, with this
   * as its tooltip: an action that silently vanishes on one platform reads as
   * missing rather than unavailable.
   */
  disabledReason?: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}

interface ComposerInputProps {
  api?: RealtimeDictationApi;
  ariaLabel: string;
  attachments: PendingAttachment[];
  autoFocus?: boolean;
  className?: string;
  error?: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  footerHint?: ReactNode;
  /** A line inside the composer, over its toolbar: what sending will do, for a host that sends somewhere unusual. */
  notice?: ReactNode;
  beforeInput?: ReactNode;
  /** A host's own control at the end of the toolbar's tools, such as where a merge goes. */
  toolsAccessory?: ReactNode;
  /** What the send button shows in place of its arrow, for a host whose send is not a plain send. */
  submitContent?: ReactNode;
  /** Main work streams opt into GrokBot's single-row message capsule. */
  layout?: 'toolbar' | 'message-capsule';
  maxHeight?: number;
  /** Extra "+" menu entries; only the message capsule has the menu to put them in. */
  menuActions?: readonly ComposerMenuAction[];
  mentionDisabled?: boolean;
  mentionLabel?: string;
  /** Labels of the resources an `@` can name here; typing one highlights it in the draft. */
  mentionLabels?: readonly string[];
  /**
   * The mention list this draft is currently driving, if one is open.
   *
   * Focus deliberately stays in the textarea while that list is walked, so the
   * options never receive it and a screen reader is never told which row `Enter`
   * would take. These two attributes are what answer that.
   *
   * Two attributes and no `role="combobox"`: `aria-activedescendant` is
   * supported on a textbox, and that is what a screen reader needs to follow the
   * highlight. Taking the full editable-combobox shape instead would swap the
   * composer's announced role from multiline textbox to combobox the moment an
   * `@` opened a list and back when it closed — a change to how the main writing
   * surface introduces itself, in the middle of a sentence, which is a worse
   * trade than the pattern purity is worth. `aria-expanded` is only valid
   * alongside that role, so it is not here either.
   */
  mentionListbox?: { id: string; activeOptionId: string | undefined };
  /**
   * The model pill in the toolbar. Composers that pass nothing show none; those
   * that do still only show it while Application → Developer → **Debug enabled**
   * is on, because which model the work runs on is a developer's question rather
   * than part of describing work.
   *
   * Two shapes, because a composer stands either before the conversation it
   * writes into exists or after, and only the first still has a decision to
   * make. Both creation composers — a work stream's and a substream's — take
   * `choice`; the conversation composer inside either one takes `settled`.
   */
  model?: ComposerModelControl;
  /** Absent where the message cannot carry files: no attach control, drop or paste. */
  onAttach?: (files: FileList | File[]) => void;
  /**
   * The host's own key handling — mention navigation, dismissing a popover,
   * slash commands. It never receives a keydown dispatched during an IME
   * composition: this composer drops those before calling it, because the IME
   * owns every key between `compositionstart` and `compositionend`. The reasons
   * and the signals are in `lib/ime.ts`.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMention: () => void;
  /**
   * The caret moved, by arrow key, click, or drag. A composer whose `@` list is
   * open re-reads what the caret is naming from here: the list has to close when
   * the caret leaves the mention it belongs to, and no value change accompanies
   * that move.
   */
  onSelect?: () => void;
  onOpenAttachment: (preview: AttachmentPreview) => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment: (localId: string) => void;
  onSubmit: () => Promise<void> | void;
  onValueChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  shouldSubmitOnEnter?: () => boolean;
  /** Host-owned trailing action, rendered to the right of Send. */
  submitAccessory?: ReactNode;
  submitDisabled: boolean;
  submitLabel: string;
  submitting?: boolean;
  uploading: boolean;
  value: string;
}

function setForwardedRef<T>(ref: Ref<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Apply a list edit to the live field, through the field's own editing command
 * rather than by handing the parent a new string.
 *
 * `execCommand` is what puts the change on the textarea's undo stack: ⌘Z after
 * Enter takes the bullet back off instead of clearing the whole draft, and
 * these are keys somebody presses a dozen times in one message. It also fires a
 * native `input` event, so React's `onChange` runs exactly as it does for a
 * typed character and every consumer downstream of it — `onValueChange`, the
 * draft cache, the mention rebase that carries `@Name` spans through an edit —
 * sees one ordinary edit rather than a wholesale replacement.
 *
 * Every operation in `markdown-lists` rewrites line prefixes, so however many
 * lines it touched the change is one contiguous span: the common head and tail
 * locate it, and what is left between them is what gets inserted. Returns false
 * where the command is unavailable or refused — jsdom has neither — and the
 * caller falls back to replacing the draft outright.
 */
function applyDraftEdit(textarea: HTMLTextAreaElement, edit: DraftEdit): boolean {
  const previous = textarea.value;
  let head = 0;
  while (head < previous.length && head < edit.text.length && previous[head] === edit.text[head]) head += 1;
  let tail = 0;
  while (
    tail < previous.length - head && tail < edit.text.length - head
    && previous[previous.length - tail - 1] === edit.text[edit.text.length - tail - 1]
  ) tail += 1;
  const insert = edit.text.slice(head, edit.text.length - tail);
  if (typeof document.execCommand !== 'function') return false;
  textarea.setSelectionRange(head, previous.length - tail);
  // `insertText` with nothing to insert is not a delete in every engine; the
  // command that removes a selection is the one that says so.
  if (!document.execCommand(insert === '' ? 'delete' : 'insertText', false, insert)) return false;
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  return true;
}

/**
 * The two list shortcuts, as Slack, Google Docs and Word all spell them:
 * ⌘⇧8 for bullets, ⌘⇧7 for numbers, on Control off macOS.
 *
 * Matched on `code` rather than `key` because with Shift held the digit row
 * reports `*` and `&` — and only on a layout that puts them there. The physical
 * key is what the shortcut is, so the physical key is what is read.
 */
function listShortcutKind(event: KeyboardEvent<HTMLTextAreaElement>): ListMarkerKind | null {
  if (!event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.code === 'Digit8') return 'bulleted';
  if (event.code === 'Digit7') return 'numbered';
  return null;
}

/** Stable empty default so the highlight memo is not invalidated every render. */
const NO_MENTION_LABELS: readonly string[] = [];
const NO_MENU_ACTIONS: readonly ComposerMenuAction[] = [];

/**
 * The shared text-entry surface for both a new work stream and an existing one.
 * Keeping attachments, mentions, dictation, keyboard submission, and the toolbar
 * here prevents the two primary composers from evolving separate controls.
 *
 * Owning keyboard submission also means owning what an IME is allowed to reach:
 * a keydown belonging to an in-flight composition is dropped here, before the
 * host's `onKeyDown` and before this composer's own Enter, so no host has to
 * remember the rule. See `lib/ime.ts`.
 */
export const ComposerInput = forwardRef<HTMLTextAreaElement, ComposerInputProps>(function ComposerInput({
  api,
  ariaLabel,
  attachments,
  autoFocus = false,
  className,
  error,
  fileInputRef,
  footerHint,
  notice,
  beforeInput,
  toolsAccessory,
  submitContent,
  layout = 'toolbar',
  maxHeight = 180,
  menuActions = NO_MENU_ACTIONS,
  mentionDisabled = false,
  mentionLabel = 'Mention a participant',
  mentionLabels = NO_MENTION_LABELS,
  mentionListbox,
  model,
  onAttach,
  onKeyDown,
  onMention,
  onOpenAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onSelect,
  onSubmit,
  onValueChange,
  placeholder,
  rows = 1,
  shouldSubmitOnEnter,
  submitAccessory,
  submitDisabled,
  submitLabel,
  submitting = false,
  uploading,
  value,
}, forwardedRef): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const resizeAnimationsRef = useRef<Animation[]>([]);
  const measuredTextareaRef = useRef(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const dictationBaseRef = useRef('');
  const microphonePressRef = useRef<{ startedAt: number; startedRecording: boolean } | undefined>(undefined);
  const attachFiles = useCallback((files: FileList | File[]): void => {
    if (!submitting) onAttach?.(files);
  }, [onAttach, submitting]);
  const debugEnabled = useDebugEnabled();
  const drop = useFileDrop((files) => attachFiles(files), submitting || !onAttach);
  // Turning Debug enabled off takes the control away; it has to take the choice
  // with it. A pin left behind in the parent's state would keep pinning every
  // work stream started from this screen with nothing on screen saying so, and
  // no way to clear it. A settled pill holds no choice to release.
  const releaseModelOverride = model?.kind === 'choice' ? model.onChange : undefined;
  const modelOverrideValue = model?.kind === 'choice' ? model.value : null;
  // What the pill is naming, whichever shape it is in — only `null` is quiet.
  const selectedModel = model?.kind === 'settled' ? model.model : modelOverrideValue;
  useEffect(() => {
    if (!debugEnabled && modelOverrideValue !== null) releaseModelOverride?.(null);
  }, [debugEnabled, modelOverrideValue, releaseModelOverride]);
  const paste = useFilePaste(attachFiles, submitting || !onAttach, attachments.length < MAX_ATTACHMENTS);
  // An IME's in-flight text never reaches `value`, so the highlight layer steps
  // aside and lets the textarea paint itself until the composition commits.
  const [composing, setComposing] = useState(false);
  const highlighting = mentionLabels.length > 0;
  // Normalized once per label set, not once per keystroke.
  const labels = useMemo(() => normalizeMentionLabels(mentionLabels), [mentionLabels]);
  const segments = useMemo(
    () => highlighting ? splitMentionHighlights(value, labels) : [],
    [highlighting, labels, value],
  );
  const syncHighlightScroll = useCallback((): void => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);
  // Dictation writes into the field from outside it, and the browser only
  // keeps a caret in view, never a value it was handed. Once the field is at
  // its height limit the newest words would land below the fold, so each
  // transcript update asks for the tail to be shown after the field has
  // taken its new height; the highlight layer follows the same scroll.
  const transcriptTailPendingRef = useRef(false);
  const followTranscriptTail = useCallback((): void => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.scrollTop = textarea.scrollHeight;
    syncHighlightScroll();
  }, [syncHighlightScroll]);
  const resizeTextarea = useCallback((nextValue?: string): void => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const composer = composerRef.current;
    const shell = textarea.parentElement;
    const previousHeight = textarea.getBoundingClientRect().height;
    const previousTextLeft = textarea.getBoundingClientRect().left + parseFloat(getComputedStyle(textarea).paddingLeft);
    for (const animation of resizeAnimationsRef.current) animation.cancel();
    resizeAnimationsRef.current = [];
    // Measure at the compact width every time, so expanding the text column
    // cannot alternate between wrapped and unwrapped on successive edits.
    if (composer) delete composer.dataset.multiline;
    // Keep the underlying wrap state current even while attachments force the
    // expanded layout, so removing the last tile cannot briefly compact it.
    const hadAttachments = composer?.classList.contains('has-attachments') ?? false;
    if (hadAttachments) composer?.classList.remove('has-attachments');
    textarea.style.height = 'auto';
    if (layout === 'message-capsule' && composer) {
      const singleRowHeight = textarea.clientHeight;
      composer.dataset.multiline = String(textarea.scrollHeight > singleRowHeight);
    }
    if (hadAttachments) composer?.classList.add('has-attachments');
    if ((nextValue ?? textarea.value).length > 0) {
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }
    if (layout === 'message-capsule' && shell && measuredTextareaRef.current
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      && typeof textarea.animate === 'function') {
      const height = textarea.getBoundingClientRect().height;
      const textLeft = textarea.getBoundingClientRect().left + parseFloat(getComputedStyle(textarea).paddingLeft);
      // Use the current painted position when typing reverses an unfinished
      // transition. Height moves the capsule edge; translation carries the text
      // and its mention highlights together without scaling the glyphs.
      const motion = { duration: 220, easing: 'cubic-bezier(.32, .72, 0, 1)' };
      if (previousHeight !== height) {
        resizeAnimationsRef.current.push(textarea.animate([
          { height: `${previousHeight}px` }, { height: `${height}px` },
        ], motion));
      }
      if (previousTextLeft !== textLeft) {
        resizeAnimationsRef.current.push(shell.animate([
          { transform: `translateX(${previousTextLeft - textLeft}px)` }, { transform: 'translateX(0)' },
        ], motion));
      }
    }
    measuredTextareaRef.current = true;
    syncHighlightScroll();
  }, [attachments.length, layout, maxHeight, syncHighlightScroll]);
  useLayoutEffect(() => {
    resizeTextarea(value);
    if (!transcriptTailPendingRef.current) return;
    transcriptTailPendingRef.current = false;
    followTranscriptTail();
  }, [followTranscriptTail, resizeTextarea, value]);
  useEffect(() => () => {
    for (const animation of resizeAnimationsRef.current) animation.cancel();
  }, []);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      if (composer.clientWidth === width) return;
      width = composer.clientWidth;
      resizeTextarea();
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [resizeTextarea]);
  // The level ring is painted straight onto the control: ten writes a second
  // through React would re-render the whole composer for a box-shadow.
  const microphoneControlRef = useRef<HTMLDivElement>(null);
  const dictation = useRealtimeDictation(api, (transcript) => {
    const next = appendDictationTranscript(dictationBaseRef.current, transcript);
    // An update that changes nothing, such as the empty transcript a start
    // sends, must not leave the follow armed for the person's next keystroke.
    if (next === value) return;
    onValueChange(next);
    transcriptTailPendingRef.current = true;
    // The layout effect follows the tail on the render that carries the new
    // value; this frame covers the capsule's height animation settling after
    // it, and clears the flag in case that render has not happened.
    requestAnimationFrame(() => {
      transcriptTailPendingRef.current = false;
      resizeTextarea();
      followTranscriptTail();
    });
  }, {
    onLevel: (level) => microphoneControlRef.current?.style.setProperty('--dictation-level', level.toFixed(3)),
  });
  const dictationActive = !['idle', 'error'].includes(dictation.state);
  // Dictation owns the text while it is running: the transcript is written into
  // the same field, so a caret in there would fight it. Sending is no longer on
  // this list — `submit` stops dictation and sends what it heard instead.
  const dictationEditingBlocked = ['requesting', 'listening', 'finalizing'].includes(dictation.state);
  const messageCapsule = layout === 'message-capsule';

  // Set by `submit` while dictation is running, cleared by the effect below
  // when it settles, and by the microphone when the user cancels the send.
  const [sendAfterDictation, setSendAfterDictation] = useState(false);

  const startDictation = (): void => {
    dictationBaseRef.current = value;
    void dictation.start();
  };

  // `stop()` adopts the attempt's finalization promise, and that promise rejects
  // when the drain, the socket, or the completion timeout fails. Every stop in
  // this component is fire and forget — the hook puts the same failure in
  // `dictation.error`, which the composer renders below — so the rejection is
  // consumed here rather than reaching the renderer's `unhandledrejection`
  // reporter, which files it as a JavaScript defect.
  const stopDictation = (): void => {
    void dictation.stop().catch(() => undefined);
  };

  const toggleDictation = (): void => {
    // A pending send is the first thing the microphone cancels. Finalization
    // can run to the hook's completion timeout, and for that whole window Send
    // is spinning, Enter returns on the pending flag, and the field is
    // read-only because `finalizing` blocks editing — so without this there is
    // nothing on the composer that answers. Cancelling only the send leaves the
    // drain to finish on its own: the transcript still lands in the draft, it
    // simply is not posted, and the user gets their text back rather than a
    // minute of a spinner.
    if (sendAfterDictation) {
      setSendAfterDictation(false);
      return;
    }
    if (dictationActive) stopDictation();
    else startDictation();
  };

  // Send while dictation is running stops it and sends what it heard, the tail
  // still in flight included — a Send button that silently drops the last words
  // spoken is worse than one that waits a beat for them.
  //
  // Awaiting `stop()` and submitting is not enough to get them: the final
  // transcript reaches the host through `onValueChange`, so the host's own
  // submit closure is one render behind it, and awaiting inside the click
  // handler submits the text as it stood when the click landed. Waiting for
  // dictation to settle and submitting from an effect is that next render, and
  // it is React's ordering rather than a microtask race.
  useEffect(() => {
    if (!sendAfterDictation) return;
    // A failed stop keeps the draft and shows its error; it does not send. So
    // does a silent one: the hook's completion timeout reports "No speech was
    // detected" as an error rather than an empty transcript.
    if (dictation.state === 'error') {
      setSendAfterDictation(false);
      return;
    }
    if (dictation.state !== 'idle') return;
    setSendAfterDictation(false);
    // The transcript has landed, so `submitDisabled` now reflects the final
    // draft rather than the empty one the stop was allowed on. Nothing to send
    // — or an attachment still uploading — leaves the draft where it is.
    if (submitDisabled) return;
    void onSubmit();
  }, [dictation.state, onSubmit, sendAfterDictation, submitDisabled]);

  const submit = async (): Promise<void> => {
    if (sendAfterDictation) return;
    // Stopping comes before the empty-draft guard, because while dictation is
    // running the draft is not the whole story: it stays empty until the first
    // partial arrives, and on a provider that sends nothing before the final
    // commit it stays empty for the entire recording. Guarding on it first
    // would make Send unreachable in exactly the case the recording holds the
    // most. The effect above re-checks it once the transcript is in.
    if (dictationActive) {
      setSendAfterDictation(true);
      stopDictation();
      return;
    }
    if (submitDisabled) return;
    await onSubmit();
  };

  const beginMention = (): void => {
    if (dictation.state === 'transcribing' || dictation.state === 'finalizing') stopDictation();
    onMention();
  };

  /**
   * Put a list edit into the field, or report that there was none to put.
   *
   * `false` is the whole contract with the keyboard: it means the operation
   * declined, and the keystroke is then left to do whatever it would have done
   * — insert a newline, move focus to the next control. That is what keeps Tab
   * from trapping anybody in the composer.
   */
  const runListEdit = (edit: DraftEdit | null): boolean => {
    const textarea = textareaRef.current;
    if (!edit || !textarea) return false;
    if (!applyDraftEdit(textarea, edit)) {
      onValueChange(edit.text);
      requestAnimationFrame(() => textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd));
    }
    resizeTextarea(edit.text);
    return true;
  };

  /**
   * The list keys, read off the live field rather than off `value`: the caret
   * offsets come from the DOM, so the text they index into has to as well.
   */
  const runListKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const textarea = textareaRef.current;
    if (!textarea || dictationEditingBlocked) return false;
    const { selectionStart, selectionEnd, value: live } = textarea;
    if (event.key === 'Enter') return runListEdit(continueListAtCaret(live, selectionStart, selectionEnd));
    if (event.key === 'Tab') {
      runListEdit(shiftListAtCaret(live, selectionStart, selectionEnd, event.shiftKey ? 'out' : 'in'));
      // On whether the caret is in a list, not on whether the draft moved: at
      // the depth cap and at the margin the shift does nothing, and handing the
      // key back there would take the caret out of the field mid-list, which is
      // the one thing about Tab people notice.
      return selectionTouchesListItem(live, selectionStart, selectionEnd);
    }
    const kind = listShortcutKind(event);
    return kind !== null && runListEdit(toggleListAtSelection(live, selectionStart, selectionEnd, kind));
  };

  const dictationButton = (idleLabel: string): React.JSX.Element => (
    <IconButton
      aria-pressed={dictationActive}
      className="dictation-button"
      disabled={!api || submitting}
      label={sendAfterDictation
        ? 'Cancel sending'
        : dictation.state === 'finalizing'
          ? 'Finalizing dictation'
          : dictation.state === 'transcribing'
            ? 'Cancel dictation'
            : dictationActive ? 'Stop dictation' : idleLabel}
      onClick={(event) => {
        if (event.detail === 0) toggleDictation();
      }}
      onPointerCancel={() => {
        const press = microphonePressRef.current;
        microphonePressRef.current = undefined;
        if (press?.startedRecording) stopDictation();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        microphonePressRef.current = {
          startedAt: performance.now(),
          startedRecording: !dictationActive,
        };
        toggleDictation();
      }}
      // A pointer or focus reaching the button is the best signal a press is
      // coming: the ticket it will need is requested now, so the socket can
      // open the moment capture starts.
      onFocus={() => dictation.prefetch()}
      onPointerEnter={() => dictation.prefetch()}
      onPointerUp={() => {
        const press = microphonePressRef.current;
        microphonePressRef.current = undefined;
        if (press?.startedRecording && performance.now() - press.startedAt >= 350) {
          stopDictation();
        }
      }}
    >
      {dictation.state === 'transcribing' || dictation.state === 'finalizing'
        ? <LoaderCircle className="spin" size={15} />
        : <Mic size={15} />}
    </IconButton>
  );
  // `is-arming` answers the press before the microphone has opened;
  // `is-listening` is reserved for capture that is running.
  const microphoneControlClassName = clsx(
    'microphone-control',
    dictation.state === 'requesting' && 'is-arming',
    dictation.state === 'listening' && 'is-listening',
  );

  return (
    <>
      <div
        ref={composerRef}
        className={clsx(
          'workstream-composer',
          className,
          highlighting && 'is-highlighting',
          composing && 'is-composing',
          submitting && 'is-sending',
          drop.dragging && 'is-file-dragging',
          messageCapsule && 'is-message-capsule',
          messageCapsule && attachments.length > 0 && 'has-attachments',
        )}
        onDragEnter={drop.onDragEnter}
        onDragLeave={drop.onDragLeave}
        onDragOver={drop.onDragOver}
        onDrop={drop.onDrop}
        /* On the shell rather than the textarea: a paste lands wherever focus sits
           inside the composer, including the toolbar and the attachment tiles. */
        onPaste={paste}
      >
        {beforeInput}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <PendingAttachmentTile
                actionsDisabled={submitting}
                attachment={attachment}
                key={attachment.localId}
                onOpen={onOpenAttachment}
                onRemove={() => onRemoveAttachment(attachment.localId)}
                onRetry={() => onRetryAttachment(attachment.localId)}
              />
            ))}
          </div>
        )}
        <div className="composer-input-shell">
          {highlighting && (
            <div aria-hidden="true" className="composer-highlight" ref={highlightRef}>
              {segments.map((segment, index) => (
                <Fragment key={index}>
                  {segment.kind === 'mention' ? <mark className="composer-mention">{segment.text}</mark> : segment.text}
                </Fragment>
              ))}
              {/* A draft ending in a newline keeps its trailing line box only if something occupies it. */}
              {value.endsWith('\n') && '\u200b'}
            </div>
          )}
          <textarea
            aria-activedescendant={mentionListbox?.activeOptionId}
            aria-controls={mentionListbox?.id}
            aria-label={ariaLabel}
            autoFocus={autoFocus}
            onCompositionEnd={() => setComposing(false)}
            onCompositionStart={() => setComposing(true)}
            onChange={(event) => {
              if (dictation.state === 'transcribing' || dictation.state === 'finalizing') stopDictation();
              onValueChange(event.target.value);
              resizeTextarea(event.target.value);
            }}
            onKeyDown={(event) => {
              // First, and before the host's handler: while an IME is composing
              // it owns every key, and nothing in this composer or above it may
              // act on one. See `lib/ime.ts`.
              if (isComposingKeyEvent(event.nativeEvent)) return;
              onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === 'Enter' && !event.shiftKey && (shouldSubmitOnEnter?.() ?? true)) {
                event.preventDefault();
                void submit();
                return;
              }
              // Last, so sending always wins the plain Enter and the host keeps
              // first refusal on every key. An Enter that reaches here is the
              // one that was going to insert a newline, which is the keystroke
              // a list is carried on by.
              if (runListKey(event)) event.preventDefault();
            }}
            onScroll={syncHighlightScroll}
            onSelect={onSelect}
            placeholder={placeholder}
            readOnly={dictationEditingBlocked}
            ref={(element) => {
              textareaRef.current = element;
              setForwardedRef(forwardedRef, element);
            }}
            rows={rows}
            value={value}
          />
        </div>
        {notice && <div className="composer-notice">{notice}</div>}
        <div className="composer-toolbar">
          <div className="composer-tools">
            {!messageCapsule && (
              <IconButton disabled={submitting || dictationEditingBlocked || mentionDisabled} label={mentionLabel} onClick={beginMention}>
                <AtSign size={15} />
              </IconButton>
            )}
            {messageCapsule ? (onAttach || menuActions.length > 0) && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton className="composer-action-trigger" disabled={submitting} label="Composer actions">
                    {uploading ? <LoaderCircle className="spin" size={15} /> : <Plus size={17} />}
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    className="menu-content composer-action-menu"
                    collisionPadding={8}
                    side="top"
                    sideOffset={8}
                  >
                    {onAttach && (
                      <DropdownMenu.Item
                        className="menu-item composer-action-menu-item"
                        onSelect={() => fileInputRef.current?.click()}
                      >
                        <Paperclip aria-hidden="true" />
                        <span>Attach files</span>
                      </DropdownMenu.Item>
                    )}
                    {menuActions.map((action) => {
                      const disabled = action.disabledReason !== undefined;
                      // Disabled by hand rather than with Radix's `disabled`, which
                      // drops the item from arrow-key focus and so leaves a keyboard
                      // never reaching the tooltip that says why.
                      const item = (
                        <DropdownMenu.Item
                          aria-disabled={disabled || undefined}
                          className="menu-item composer-action-menu-item"
                          data-disabled={disabled ? '' : undefined}
                          key={action.label}
                          onSelect={(event) => {
                            if (disabled) event.preventDefault();
                            else action.onSelect();
                          }}
                        >
                          {action.icon}
                          <span>{action.label}</span>
                        </DropdownMenu.Item>
                      );
                      return action.disabledReason === undefined
                        ? item
                        : <Tip key={action.label} label={action.disabledReason} side="right">{item}</Tip>;
                    })}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : onAttach && (
              <IconButton disabled={submitting} label="Attach a file" onClick={() => fileInputRef.current?.click()}>
                {uploading ? <LoaderCircle className="spin" size={15} /> : <Plus size={16} />}
              </IconButton>
            )}
            {!messageCapsule && (
              <div className={microphoneControlClassName} ref={microphoneControlRef}>
                {dictationButton('Click or hold to dictate')}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton className="microphone-menu-trigger" disabled={submitting || dictationEditingBlocked} label="Choose microphone">
                      <ChevronDown size={14} />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="start" className="menu-content microphone-menu" sideOffset={8}>
                      <DropdownMenu.Label className="menu-label">Microphone</DropdownMenu.Label>
                      {dictation.devices.length === 0 ? (
                        <DropdownMenu.Item className="menu-item" disabled>No microphones found</DropdownMenu.Item>
                      ) : (
                        <DropdownMenu.RadioGroup onValueChange={dictation.setSelectedDeviceId} value={dictation.selectedDeviceId}>
                          {dictation.devices.map((device) => (
                            <DropdownMenu.RadioItem className="menu-item microphone-menu-item" key={device.deviceId} value={device.deviceId}>
                              <span>{device.label}</span>
                              <DropdownMenu.ItemIndicator asChild>
                                <Check aria-hidden="true" size={15} />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            )}
            {model && debugEnabled && (
              /* One control, in one place, in both shapes and both layouts. A
                 settled conversation gets the same dropdown — same trigger,
                 same pill, same chevron — with the trigger `disabled`, which is
                 what stops it opening; its menu is left unrendered because a
                 disabled trigger can never reach it. The tooltip carrying the
                 full model id survives the disable and was checked in a real
                 window, so the id is reachable by hover and not only as the
                 accessible name — Tab skips a disabled button, which is the one
                 route it does lose.

                 The capsule layout used to keep the choice as a radio group
                 inside the composer-actions menu instead. That gave the same
                 control two homes: the menu while a choice was open, and this
                 pill once there was nothing left to choose — so the answer to
                 "which model is this?" moved as soon as it stopped being a
                 question. It is the pill in both. */
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton
                    className={clsx(
                      'model-selector-trigger',
                      model.kind === 'settled' && 'is-settled',
                      !selectedModel && 'is-unpinned',
                    )}
                    disabled={model.kind === 'settled' || submitting}
                    label={model.kind === 'settled'
                      ? agentModelInUseTriggerLabel(model.model, model.pinned)
                      : agentModelTriggerLabel(model.value)}
                  >
                    <span>{model.kind === 'settled' ? agentModelInUseLabel(model.model) : agentModelLabel(model.value)}</span>
                    <ChevronDown aria-hidden="true" size={13} />
                  </IconButton>
                </DropdownMenu.Trigger>
                {model.kind === 'choice' && (
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="start" className="menu-content model-selector-menu" sideOffset={8}>
                      <DropdownMenu.Label className="menu-label">Model</DropdownMenu.Label>
                      {/* Unpinned is its own value rather than the first model:
                          the flag decides which model it resolves to, and naming
                          one here would be a claim the renderer cannot make. */}
                      <DropdownMenu.RadioGroup
                        onValueChange={(chosen) =>
                          model.onChange(chosen === UNPINNED_AGENT_MODEL ? null : chosen as AgentModelOverride)}
                        value={model.value ?? UNPINNED_AGENT_MODEL}
                      >
                        <DropdownMenu.RadioItem className="menu-item model-selector-item" value={UNPINNED_AGENT_MODEL}>
                          <span>{UNPINNED_AGENT_MODEL_LABEL}</span>
                          <DropdownMenu.ItemIndicator asChild>
                            <Check aria-hidden="true" size={15} />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                        {AGENT_MODEL_GROUPS.map((group) => (
                          <Fragment key={group.provider}>
                            <DropdownMenu.Label className="menu-label model-selector-provider">{group.provider}</DropdownMenu.Label>
                            {group.models.map((choice) => (
                              <DropdownMenu.RadioItem className="menu-item model-selector-item" key={choice.id} value={choice.id}>
                                <span>{choice.label}</span>
                                <DropdownMenu.ItemIndicator asChild>
                                  <Check aria-hidden="true" size={15} />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                            ))}
                          </Fragment>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                )}
              </DropdownMenu.Root>
            )}
            {toolsAccessory}
          </div>
          {footerHint && <span className="composer-hint">{footerHint}</span>}
          <div className="composer-submit-area">
            {messageCapsule && (
              <div className={microphoneControlClassName} ref={microphoneControlRef}>
                {dictationButton('Start voice input')}
              </div>
            )}
            {/* Send stays visible whether or not there is anything to send. It
                used to appear with the first character, which moved the
                microphone under the cursor mid-keystroke and left the empty
                composer with no visible way to send at all — the affordance a
                first-time reader looks for is the one that was missing. Every
                host already passes `submitDisabled` for an empty draft, so the
                disabled state is the one it always computed. */}
            <button aria-label={submitLabel} className={clsx('composer-send', submitContent !== undefined && 'has-content')} disabled={(submitDisabled && !dictationActive) || sendAfterDictation} onClick={() => void submit()} type="button">
              {submitting || sendAfterDictation ? <LoaderCircle className="spin" size={15} /> : submitContent ?? <ArrowUp size={15} />}
            </button>
            {submitAccessory}
          </div>
        </div>
      </div>
      {(error || dictation.error) && (
        <div className="composer-error-slot"><InlineError>{error || dictation.error}</InlineError></div>
      )}
      {onAttach && <input
        className="sr-only"
        disabled={submitting}
        multiple
        onChange={(event) => {
          if (event.target.files?.length) attachFiles(event.target.files);
          event.target.value = '';
        }}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />}
    </>
  );
});
