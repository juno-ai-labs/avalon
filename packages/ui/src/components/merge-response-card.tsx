import { ErrorNotice } from './primitives';
import { IconCornerUpLeft, IconFileText, IconUsers, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { isComposingKeyEvent } from '../lib/ime';

/**
 * The merge as the parent will draw it, editable in place: `MergeMessage`'s
 * layout (the source's mark and name, "merged by" and the person, then the
 * words) with the body a text box, the embeds the words cite as pills a
 * person can take out, and under it the audience line, the target pill, a
 * hint and the two buttons (docs/conversation-merge.md, "The response card").
 * A tag line above names the parent that will see it. Enter merges,
 * Shift+Enter breaks a line, Esc cancels. Every merge is made
 * here, from a suggestion, the Merge hover action or the title menu; the
 * composer below it stays an ordinary composer.
 */
export function MergeResponseCard({
  audience, autoFocus = true, className, embeds, error, label, mergedBy, onCancel, onChange, onSubmit, quote, source, submitting, targetName, targetPill, time, value,
}: {
  /** Who will see it, as merge mode's notice said it. */
  audience: ReactNode;
  autoFocus?: boolean;
  className?: string;
  /** The artifacts the words cite, each removable from the words. */
  embeds: ReadonlyArray<{ id: string; title: string; onRemove: () => void }>;
  error?: string | undefined;
  label: string;
  mergedBy: ReactNode;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** In a Channel only: the thread's first line. */
  quote?: string | null | undefined;
  source: { mark: ReactNode; tint?: { background: string; ink: string } | undefined; title: string };
  submitting: boolean;
  /** The parent the merge lands in, for the tag line and the empty card's prompt. */
  targetName: string;
  /** The host's target pill: the Thread, or the Channel with its menu. */
  targetPill: ReactNode;
  time: ReactNode;
  value: string;
}): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Sized to its words, and again when its width changes: a narrower pane
  // wraps an unchanged note onto more lines, which `overflow: hidden` would clip.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const fit = (): void => {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  useEffect(() => {
    if (!autoFocus) return;
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Mid-composition, Enter commits a candidate and Escape drops one: neither is ours.
    if (isComposingKeyEvent(event.nativeEvent)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!submitting && value.trim().length > 0) onSubmit();
    }
  };
  return (
    <article aria-label={label} className={clsx('merge-message merge-response-card', className)}>
      <div className="merge-response-card-tag"><IconCornerUpLeft aria-hidden="true" size={12} stroke={2} />Merge, as {targetName} will see it</div>
      <div className="merge-message-meta">
        <span className="merge-message-source">
          <span aria-hidden="true" className="merge-message-mark" style={source.tint ? { background: source.tint.background, color: source.tint.ink } : undefined}>{source.mark}</span>
          <span>{source.title}</span>
        </span>
        <span>· merged by</span>
        <span className="merge-message-who">{mergedBy}</span>
        <span aria-hidden="true">·</span>
        {time}
      </div>
      {quote && (
        <div className="merge-message-quote">
          <IconCornerUpLeft aria-hidden="true" size={13} stroke={1.9} />
          <span>{quote}</span>
        </div>
      )}
      <div className="merge-message-body">
        <textarea
          aria-label="Merge note"
          className="merge-response-card-input"
          readOnly={submitting}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Write what ${targetName} should know. Embed an artifact with [Title](resource://id).`}
          ref={textarea}
          rows={2}
          value={value}
        />
      </div>
      {embeds.length > 0 && (
        <ul aria-label="Artifacts this merge carries" className="merge-response-card-embeds">
          {embeds.map((embed) => (
            <li className="merge-response-card-embed" key={embed.id}>
              <IconFileText aria-hidden="true" size={16} stroke={1.7} />
              <span className="merge-response-card-embed-title">{embed.title}</span>
              <button aria-label={`Remove ${embed.title}`} disabled={submitting} onClick={embed.onRemove} type="button">
                <IconX aria-hidden="true" size={12} stroke={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <p className="merge-response-card-audience"><IconUsers aria-hidden="true" size={14} stroke={1.8} />{audience}</p>
      <div className="merge-response-card-foot">
        {targetPill}
        <span className="merge-response-card-hint">Enter to merge · Esc to cancel</span>
        <span className="merge-response-card-foot-space" />
        <button className="merge-response-card-cancel" disabled={submitting} onClick={onCancel} type="button">Cancel</button>
        <button className="merge-response-card-submit" disabled={submitting || value.trim().length === 0} onClick={onSubmit} type="button">
          <IconCornerUpLeft aria-hidden="true" size={13} stroke={2} /><span>Merge</span>
        </button>
      </div>
    </article>
  );
}
