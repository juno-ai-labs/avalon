import { IconCloudDownload } from "@tabler/icons-react";
import type { ReactNode } from 'react';

import { formatTime } from '../lib/format';
import { Tip } from './primitives';
import { RelativeTime } from './relative-time';

/** The byline's clock time; the feed's day dividers carry the date (design.html §2). */
const bylineTime = (value: string): string => formatTime(value);

/**
 * The identity line over every turn in a feed: who said it, and when.
 *
 * One component for Rally's turn, a colleague's, the reader's own, and a
 * settled elicitation answer, so the name and the time take one colour, one
 * size, and one order everywhere rather than four headers that agree by
 * accident. The line reads outward from the edge the turn is aligned to — the
 * name on the edge, the time inward — so the same parts are laid down in
 * reverse for a turn on the trailing edge. That is done in the markup, not
 * with CSS ordering: what a screen reader announces is what a sighted person
 * sees, and an optional label stays beside the name in both.
 */
export function MessageByline({
  align,
  author,
  contextLabel,
  importedBy,
  createdAt,
  dot = false,
  initial,
  workSummary,
}: {
  /** The edge of the feed the turn is aligned to. The name sits on it. */
  align: 'start' | 'end';
  author: string;
  /** Why the turn reads the way it does, beside the name it is attributed to. */
  contextLabel?: string | undefined;
  importedBy?: string | undefined;
  /** An ISO-8601 instant. */
  createdAt: string;
  /** Draw the person-accent dot before the name. A person's turn carries it; Rally's does not. */
  dot?: boolean;
  /**
   * Draw a 16px avatar holding this letter before the name, as design.html §2
   * does for Rally ("R") and for another person; the reader's own turn has none.
   */
  initial?: string | undefined;
  /** A settled response's total, already worded. */
  workSummary?: string | undefined;
}): React.JSX.Element {
  const parts: ReactNode[] = [
    <span className="message-author" key="author">
      {initial ? <span aria-hidden="true" className="message-author-avatar">{initial}</span>
        : dot && <span aria-hidden="true" className="message-author-dot" />}
      <span className="message-author-name">{author}</span>
      {importedBy && (
        <Tip label={`Imported by ${importedBy}`} describesTrigger={false}>
          <span tabIndex={0} aria-label={`Imported by ${importedBy}`}>
            <IconCloudDownload size={12} aria-hidden="true" />
          </span>
        </Tip>
      )}
    </span>,
    contextLabel ? <span className="message-context-label" key="context">{contextLabel}</span> : null,
    <RelativeTime format={bylineTime} key="time" value={createdAt} />,
    workSummary ? <span className="message-work-summary" key="summary">{workSummary}</span> : null,
  ];
  return (
    <header>
      {align === 'end' ? [...parts].reverse() : parts}
    </header>
  );
}
