import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { ArrowUp, AtSign, Check, ChevronDown, LoaderCircle, Mic, Paperclip } from 'lucide-react';
import {
  forwardRef,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AvalonApi } from '../lib/api';
import { splitMentionHighlights } from '../lib/mention-highlight';
import { appendDictationTranscript, useRealtimeDictation } from '../lib/use-realtime-dictation';
import { useFileDrop } from '../lib/use-file-drop';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { type AttachmentPreview, PendingAttachmentTile } from './attachments';
import { IconButton, InlineError } from './primitives';

interface ComposerInputProps {
  api?: Pick<AvalonApi, 'getTranscriptionSocketTicket'>;
  ariaLabel: string;
  attachments: PendingAttachment[];
  autoFocus?: boolean;
  className?: string;
  error?: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  footerHint?: ReactNode;
  maxHeight?: number;
  mentionDisabled?: boolean;
  mentionLabel?: string;
  /** Labels of the resources an `@` can name here; typing one highlights it in the draft. */
  mentionLabels?: readonly string[];
  onAttach: (files: FileList | File[]) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMention: () => void;
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
  maxHeight = 180,
  mentionDisabled = false,
  mentionLabel = 'Mention a participant or connection',
  mentionLabels = NO_MENTION_LABELS,
  onAttach,
  onKeyDown,
  onMention,
  onOpenAttachment,
  onRemoveAttachment,
  onRetryAttachment,
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
  const highlightRef = useRef<HTMLDivElement>(null);
  const dictationBaseRef = useRef('');
  const microphonePressRef = useRef<{ startedAt: number; startedRecording: boolean } | undefined>(undefined);
  const attachFiles = useCallback((files: FileList | File[]): void => {
    if (!submitting) onAttach(files);
  }, [onAttach, submitting]);
  const drop = useFileDrop((files) => attachFiles(files), submitting);
  // An IME's in-flight text never reaches `value`, so the highlight layer steps
  // aside and lets the textarea paint itself until the composition commits.
  const [composing, setComposing] = useState(false);
  const highlighting = mentionLabels.length > 0;
  const segments = useMemo(
    () => highlighting ? splitMentionHighlights(value, mentionLabels) : [],
    [highlighting, mentionLabels, value],
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
    textarea.style.height = 'auto';
    if ((nextValue ?? textarea.value).length > 0) {
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }
    syncHighlightScroll();
  }, [maxHeight, syncHighlightScroll]);
  useLayoutEffect(() => {
    resizeTextarea(value);
  }, [resizeTextarea, value]);
  const dictation = useRealtimeDictation(api, (transcript) => {
    onValueChange(appendDictationTranscript(dictationBaseRef.current, transcript));
    requestAnimationFrame(() => resizeTextarea());
  });
  const dictationActive = !['idle', 'error'].includes(dictation.state);
  const dictationBlocking = ['requesting', 'connecting', 'listening'].includes(dictation.state);
  const dictationEditingBlocked = dictationBlocking || dictation.state === 'finalizing';

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

  return (
    <>
      <div
        className={clsx(
          'workstream-composer',
          className,
          highlighting && 'is-highlighting',
          composing && 'is-composing',
          submitting && 'is-sending',
          drop.dragging && 'is-file-dragging',
        )}
        onDragEnter={drop.onDragEnter}
        onDragLeave={drop.onDragLeave}
        onDragOver={drop.onDragOver}
        onDrop={drop.onDrop}
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
            <IconButton disabled={submitting || dictationEditingBlocked || mentionDisabled} label={mentionLabel} onClick={beginMention}>
              <AtSign size={15} />
            </IconButton>
            <IconButton disabled={submitting} label="Attach a file" onClick={() => fileInputRef.current?.click()}>
              {uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}
            </IconButton>
            <div className={clsx('microphone-control', dictation.state === 'listening' && 'is-listening')}>
              <IconButton
                aria-pressed={dictationActive}
                className="dictation-button"
                disabled={!api || submitting}
                label={dictation.state === 'finalizing'
                  ? 'Finalizing dictation'
                  : dictation.state === 'transcribing'
                    ? 'Cancel dictation'
                    : dictationActive ? 'Stop dictation' : 'Click or hold to dictate'}
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
                {dictation.state === 'requesting' || dictation.state === 'connecting' || dictation.state === 'transcribing' || dictation.state === 'finalizing'
                  ? <LoaderCircle className="spin" size={15} />
                  : <Mic size={15} />}
              </IconButton>
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
          </div>
          {footerHint && <span className="composer-hint">{footerHint}</span>}
          <div className="composer-submit-area">
            {submitAccessory}
            <button aria-label={submitLabel} className="composer-send" disabled={dictationBlocking || submitDisabled} onClick={() => void submit()} type="button">
              {submitting ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={15} />}
            </button>
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
