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
import type { RallyApi } from '../lib/api';
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
import { normalizeMentionLabels, splitMentionHighlights } from '../lib/mention-highlight';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { appendDictationTranscript, useRealtimeDictation } from '../lib/use-realtime-dictation';
import { useFileDrop } from '../lib/use-file-drop';
import { useFilePaste } from '../lib/use-file-paste';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { type AttachmentPreview, PendingAttachmentTile } from './attachments';
import { IconButton, InlineError } from './primitives';

interface ComposerInputProps {
  api?: Pick<RallyApi, 'getTranscriptionSocketTicket'>;
  ariaLabel: string;
  attachments: PendingAttachment[];
  autoFocus?: boolean;
  className?: string;
  error?: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  footerHint?: ReactNode;
  /** Main work streams opt into GrokBot's single-row message capsule. */
  layout?: 'toolbar' | 'message-capsule';
  maxHeight?: number;
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
   * Two shapes, because the two composers stand at different points in a work
   * stream's life and only one of them still has a decision to make.
   *
   * `choice` offers the model this composer's work will run on, pinning it ahead
   * of the `agent-model-workstream` flag. `value` is `null` until something is
   * chosen, which is what keeps an untouched composer on the flag rather than
   * silently pinning every work stream a developer starts. That state is shown
   * as **Default** rather than as a model name: which model it resolves to is
   * the flag's answer, and this process cannot see the served variation.
   *
   * `settled` is the same control with its trigger disabled: it shows the model
   * already in force and does not open. The pin is written once, when the work
   * stream is created, and nothing afterwards edits it — so there is no decision
   * left to offer, and offering one would promise a change the next run would
   * not honour. The control stays anyway because the question
   * it answers survives the decision: a developer reading a transcript wants to
   * know which model wrote it, and until this existed the only way to find out
   * was the database.
   */
  model?:
    | {
      kind: 'choice';
      value: AgentModelOverride | null;
      onChange: (model: AgentModelOverride | null) => void;
    }
    | {
      kind: 'settled';
      /**
       * The model this work stream is on: what its latest run recorded, or its
       * pin where that run recorded nothing. Any OpenRouter id, not only one the
       * pin list admits — an unpinned work stream runs on whatever the flag
       * served. Null where neither is known, which is only a work stream with no
       * run and no pin, and reads as **Default** for the same reason a fresh
       * composer does.
       */
      model: string | null;
      /**
       * Whether the work stream carries a pin. It changes what the control may
       * honestly claim, not what it shows: a pinned work stream runs on `model`
       * every time, while an unpinned one re-resolved the flag to get there and
       * may resolve differently next launch. Both are equally unchangeable
       * *here* — that is the disable — but only one of them is fixed.
       */
      pinned: boolean;
    };
  onAttach: (files: FileList | File[]) => void;
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

/** Stable empty default so the highlight memo is not invalidated every render. */
const NO_MENTION_LABELS: readonly string[] = [];

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
  layout = 'toolbar',
  maxHeight = 180,
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
    if (!submitting) onAttach(files);
  }, [onAttach, submitting]);
  const debugEnabled = useDebugEnabled();
  const drop = useFileDrop((files) => attachFiles(files), submitting);
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
  const paste = useFilePaste(attachFiles, submitting);
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
  }, [resizeTextarea, value]);
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
  const dictation = useRealtimeDictation(api, (transcript) => {
    onValueChange(appendDictationTranscript(dictationBaseRef.current, transcript));
    requestAnimationFrame(() => resizeTextarea());
  });
  const dictationActive = !['idle', 'error'].includes(dictation.state);
  const dictationBlocking = ['requesting', 'listening'].includes(dictation.state);
  const dictationEditingBlocked = dictationBlocking || dictation.state === 'finalizing';
  const messageCapsule = layout === 'message-capsule';
  const showSubmit = submitting || value.trim().length > 0 || attachments.length > 0;

  const startDictation = (): void => {
    dictationBaseRef.current = value;
    void dictation.start();
  };

  const toggleDictation = (): void => {
    if (dictationActive) void dictation.stop();
    else startDictation();
  };

  const submit = async (): Promise<void> => {
    if (dictationBlocking || submitDisabled) return;
    if (dictation.state === 'transcribing' || dictation.state === 'finalizing') await dictation.stop();
    await onSubmit();
  };

  const beginMention = (): void => {
    if (dictation.state === 'transcribing' || dictation.state === 'finalizing') void dictation.stop();
    onMention();
  };

  const dictationButton = (idleLabel: string): React.JSX.Element => (
    <IconButton
      aria-pressed={dictationActive}
      className="dictation-button"
      disabled={!api || submitting}
      label={dictation.state === 'finalizing'
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
        if (press?.startedRecording) void dictation.stop();
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
      onPointerUp={() => {
        const press = microphonePressRef.current;
        microphonePressRef.current = undefined;
        if (press?.startedRecording && performance.now() - press.startedAt >= 350) {
          void dictation.stop();
        }
      }}
    >
      {dictation.state === 'requesting' || dictation.state === 'transcribing' || dictation.state === 'finalizing'
        ? <LoaderCircle className="spin" size={15} />
        : <Mic size={15} />}
    </IconButton>
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
          messageCapsule && showSubmit && 'has-submit',
        )}
        onDragEnter={drop.onDragEnter}
        onDragLeave={drop.onDragLeave}
        onDragOver={drop.onDragOver}
        onDrop={drop.onDrop}
        /* On the shell rather than the textarea: a paste lands wherever focus sits
           inside the composer, including the toolbar and the attachment tiles. */
        onPaste={paste}
      >
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
              if (dictation.state === 'transcribing' || dictation.state === 'finalizing') void dictation.stop();
              onValueChange(event.target.value);
              resizeTextarea(event.target.value);
            }}
            onKeyDown={(event) => {
              // First, and before the host's handler: while an IME is composing
              // it owns every key, and nothing in this composer or above it may
              // act on one. See `lib/ime.ts`.
              if (isComposingKeyEvent(event.nativeEvent)) return;
              onKeyDown?.(event);
              if (
                !event.defaultPrevented
                && event.key === 'Enter'
                && !event.shiftKey
                && (shouldSubmitOnEnter?.() ?? true)
              ) {
                event.preventDefault();
                void submit();
              }
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
        <div className="composer-toolbar">
          <div className="composer-tools">
            {!messageCapsule && (
              <IconButton disabled={submitting || dictationEditingBlocked || mentionDisabled} label={mentionLabel} onClick={beginMention}>
                <AtSign size={15} />
              </IconButton>
            )}
            {messageCapsule ? (
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
                    <DropdownMenu.Item
                      className="menu-item composer-action-menu-item"
                      onSelect={() => fileInputRef.current?.click()}
                    >
                      <Paperclip aria-hidden="true" />
                      <span>Attach files</span>
                    </DropdownMenu.Item>
                    {model && debugEnabled && model.kind === 'choice' && <>
                      <DropdownMenu.Separator className="menu-separator" />
                      <DropdownMenu.Label className="menu-label">Model</DropdownMenu.Label>
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
                        {AGENT_MODEL_GROUPS.flatMap((group) => group.models).map((choice) => (
                          <DropdownMenu.RadioItem className="menu-item model-selector-item" key={choice.id} value={choice.id}>
                            <span>{choice.label}</span>
                            <DropdownMenu.ItemIndicator asChild>
                              <Check aria-hidden="true" size={15} />
                            </DropdownMenu.ItemIndicator>
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </>}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <IconButton disabled={submitting} label="Attach a file" onClick={() => fileInputRef.current?.click()}>
                {uploading ? <LoaderCircle className="spin" size={15} /> : <Plus size={16} />}
              </IconButton>
            )}
            {!messageCapsule && (
              <div className={clsx('microphone-control', dictation.state === 'listening' && 'is-listening')}>
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
            {model && debugEnabled && !messageCapsule && (
              /* One control in both shapes. A settled work stream gets the same
                 dropdown — same trigger, same pill, same chevron — with the
                 trigger `disabled`, which is what stops it opening; its menu is
                 left unrendered because a disabled trigger can never reach it.
                 The tooltip carrying the full model id survives the disable and
                 was checked in a real window, so the id is reachable by hover
                 and not only as the accessible name — Tab skips a disabled
                 button, which is the one route it does lose. */
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
          </div>
          {footerHint && <span className="composer-hint">{footerHint}</span>}
          <div className="composer-submit-area">
            {submitAccessory}
            {messageCapsule && (
              <div className={clsx('microphone-control', dictation.state === 'listening' && 'is-listening')}>
                {dictationButton('Start voice input')}
              </div>
            )}
            {(!messageCapsule || showSubmit) && (
              <button aria-label={submitLabel} className="composer-send" disabled={dictationBlocking || submitDisabled} onClick={() => void submit()} type="button">
                {submitting ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={15} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {(error || dictation.error) && (
        <div className="composer-error-slot"><InlineError>{error || dictation.error}</InlineError></div>
      )}
      <input
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
      />
    </>
  );
});
