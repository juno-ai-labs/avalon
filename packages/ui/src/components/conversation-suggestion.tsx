import { IconCheck, IconCornerDownRight, IconCornerUpLeft, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * A conversation suggestion: one quiet line under a settled turn saying the
 * result might be worth carrying up, or a side question might deserve its own
 * Breakout, or the whole purpose is ready to mark resolved (docs/conversation-suggestions.md). A dashed outline, because the
 * thing it names does not exist yet and because it is a suggestion rather
 * than something a person did; a title naming the action and its target; one
 * sentence; one cut line of the words the action would post or start with;
 * the action; and a dismiss. Nothing posts or starts without the person: the
 * merge and Breakout actions open an editor; resolution runs only on a click.
 */
export const SUGGESTION_EXCERPT_CHARACTERS = 72;

/**
 * The excerpt line, cut by characters rather than by CSS: the first
 * {@link SUGGESTION_EXCERPT_CHARACTERS} of the words, a trailing space
 * dropped, an ellipsis appended, so the closing quote follows the ellipsis
 * directly. CSS truncation leaves up to a glyph of blank between the ellipsis
 * and whatever comes after it, which is why it is not used here. The line
 * wraps across a merge card's full width; other kinds keep `white-space: nowrap`
 * with `overflow: hidden` as a guard for a narrow pane. The budget fits one line
 * of the original chip at the narrowest pane
 * the desktop lays out (design.md, "The client").
 */
export function suggestionExcerpt(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const points = [...firstLine];
  const cut = points.length > SUGGESTION_EXCERPT_CHARACTERS || firstLine !== text.trim();
  const kept = points.slice(0, SUGGESTION_EXCERPT_CHARACTERS).join('').trimEnd();
  return `“${kept}${cut ? '…' : ''}”`;
}

export function SuggestionChip({ action, excerpt, kind, label, onDismiss, pending, secondaryAction, sentence, title }: {
  kind: 'merge_up' | 'start_breakout' | 'mark_resolved';
  /** The chip's accessible name. */
  label: string;
  /** "Merge to Cold Outreach", "Breakout: Starter tier"; the host fills the one slot. */
  title: ReactNode;
  sentence: ReactNode;
  /** The words the action would post or start with; null draws no line. */
  excerpt: string | null;
  /** The draft has not landed: a skeleton where the excerpt goes, the action disabled, Dismiss live. */
  pending: boolean;
  action: { label: string; onAct: () => void; disabled?: boolean };
  /** Independent of the draft: resolution needs no drafted words. */
  secondaryAction?: { label: string; onAct: () => void; disabled?: boolean };
  onDismiss: () => void;
}): React.JSX.Element {
  const Icon = kind === 'mark_resolved' ? IconCheck : kind === 'merge_up' ? IconCornerUpLeft : IconCornerDownRight;
  return (
    <div aria-label={label} className={clsx('suggestion-chip', kind === 'mark_resolved' ? 'is-resolve' : kind === 'merge_up' ? 'is-merge' : 'is-breakout')} role="group">
      <div className="suggestion-chip-text">
        <span className="suggestion-chip-title"><Icon aria-hidden="true" size={13} stroke={1.9} />{title}</span>
        <p className="suggestion-chip-sentence">{sentence}</p>
        {pending
          ? <span aria-label="Rally is drafting the words" className="suggestion-chip-excerpt is-pending" role="status">
              <span aria-hidden="true">“</span><span className="skeleton-bar" /><span aria-hidden="true">”</span>
            </span>
          : excerpt !== null && <p className="suggestion-chip-excerpt">{excerpt}</p>}
      </div>
      <div className="suggestion-chip-controls">
        <div className="suggestion-chip-actions">
          <button className="suggestion-chip-action" disabled={pending || action.disabled} onClick={action.onAct} type="button">
            <Icon aria-hidden="true" size={12} stroke={2} />{action.label}
          </button>
          {secondaryAction && <button className="suggestion-chip-secondary-action" disabled={secondaryAction.disabled} onClick={secondaryAction.onAct} type="button">
            <IconCheck aria-hidden="true" size={12} stroke={2} />{secondaryAction.label}
          </button>}
          {kind === 'merge_up' && <button className="suggestion-chip-secondary-action suggestion-chip-discard" onClick={onDismiss} type="button">
            <IconX aria-hidden="true" size={12} stroke={2} />Discard
          </button>}
        </div>
        <button aria-label="Dismiss suggestion" className="suggestion-chip-dismiss" onClick={onDismiss} type="button">
          <IconX aria-hidden="true" size={12} stroke={2} />
        </button>
      </div>
    </div>
  );
}
