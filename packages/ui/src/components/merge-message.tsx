import { IconCornerUpLeft } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * A merged result, drawn the same wherever it lands: a Breakout's in its
 * Thread, a Thread's in its Channel (docs/conversation-merge.md). It sits on
 * the leading side, because it comes back up rather than going out. One line
 * names the source, who merged it and when; an optional quote line recalls
 * what the source was asked; then the result, and whatever actions the host
 * offers under it.
 */
export function MergeMessage({ actions, children, className, id, label, mergedBy, onQuote, quote, source, time }: {
  /** The host's controls under the result, such as a Thread's hover actions. */
  actions?: ReactNode;
  /** The result itself, rendered by the host. */
  children: ReactNode;
  /** The host's own row class, for the spacing its feed gives every row. */
  className?: string;
  id?: string;
  /** The block's accessible name. */
  label: string;
  /** Who merged it, as the host can draw them: an avatar and a name. */
  mergedBy: ReactNode;
  /** The source's first line, when the host has one. */
  quote?: string | null | undefined;
  /** Shows where the quote came from, when the host can: the line becomes a button. */
  onQuote?: (() => void) | undefined;
  source: {
    /** The source's own mark: a Breakout's or the Thread's. */
    mark: ReactNode;
    /** The Thread's own colours behind its mark; a Breakout's sits on the neutral fill. */
    tint?: { background: string; ink: string } | undefined;
    title: string;
    onOpen?: (() => void) | undefined;
  };
  time: ReactNode;
}): React.JSX.Element {
  return (
    <article aria-label={label} className={clsx('merge-message', className)} id={id}>
      <div className="merge-message-meta">
        <span className="merge-message-source">
          <span
            aria-hidden="true"
            className="merge-message-mark"
            style={source.tint ? { background: source.tint.background, color: source.tint.ink } : undefined}
          >{source.mark}</span>
          {source.onOpen
            ? <button onClick={source.onOpen} type="button">{source.title}</button>
            : <span>{source.title}</span>}
        </span>
        <span>· merged by</span>
        <span className="merge-message-who">{mergedBy}</span>
        <span aria-hidden="true">·</span>
        {time}
      </div>
      {quote && (
        <div className="merge-message-quote">
          <IconCornerUpLeft aria-hidden="true" size={13} stroke={1.9} />
          {onQuote
            ? <button onClick={onQuote} type="button">{quote}</button>
            : <span>{quote}</span>}
        </div>
      )}
      <div className="merge-message-body">{children}</div>
      {actions}
    </article>
  );
}
