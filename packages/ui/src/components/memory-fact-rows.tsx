import type { MemoryReviewFact, MemoryReviewSource } from '@rally/contracts';
import type { ReactNode } from 'react';

import { useNow } from '../lib/clock';
import { formatDayLabel } from '../lib/format';
import { Badge, Button, InlineError } from './primitives';

/** One remembered fact as a review list draws it: the `MemoryReview` contract's row. */
export type MemoryMenuFact = MemoryReviewFact;

/**
 * One scope's remembered facts and what can be done to them, as a host hands
 * them to a list: a title-pill level, or a settings card. The server decides
 * what is listed and what may be removed (`docs/agent-memory.md`).
 */
export interface MemoryFactsState {
  /** Newest first; undefined until the read answers. */
  facts: readonly MemoryMenuFact[] | undefined;
  /** Why the read failed, when it did. */
  failure?: string | undefined;
  onRemove: (factId: string) => void;
  /** Each fact's own removal, by fact id: one row's request never speaks for another's. */
  removals?: Readonly<Record<string, MemoryFactRemoval>> | undefined;
}

/**
 * A removal asked for one fact: in flight, or refused with the reason shown
 * under the fact, which stays listed. A removal that succeeded has no entry;
 * its fact is gone from the list.
 */
export type MemoryFactRemoval = { pending: true } | { pending: false; refusal: string };

const UNTITLED_SOURCE: Record<MemoryReviewSource['kind'], string> = {
  thread: 'a thread',
  breakout: 'a breakout',
  channel: 'a channel',
  sidekick: 'a Sidekick',
};

/** What a fact's "from" link is called: its conversation's title, or what kind of place it is. */
export function memorySourceTitle(source: MemoryReviewSource): string {
  return source.title ?? UNTITLED_SOURCE[source.kind];
}

/** A day as it reads mid-sentence: "until today", "until Oct 24". */
function dayPhrase(value: string, now: Date): string {
  const label = formatDayLabel(value, now);
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label;
}

/**
 * Where a fact stands against now, read from its two instants rather than
 * flags the server computed when it answered, so a fact that runs out while
 * the list is open reads Expired on the clock's next tick, and an upcoming one
 * turns to Until, without another read.
 */
function Horizon({ fact, now }: { fact: Pick<MemoryMenuFact, 'validFrom' | 'validUntil'>; now: Date }): React.JSX.Element | null {
  const { validFrom, validUntil } = fact;
  if (validUntil !== null && Date.parse(validUntil) <= now.getTime()) {
    return <span className="memory-review-expired">{`Expired ${dayPhrase(validUntil, now)}`}</span>;
  }
  if (validFrom !== null && Date.parse(validFrom) > now.getTime()) {
    return <span>{`From ${dayPhrase(validFrom, now)}`}{validUntil !== null && ` until ${dayPhrase(validUntil, now)}`}</span>;
  }
  if (validUntil !== null) return <span>{`Until ${dayPhrase(validUntil, now)}`}</span>;
  return null;
}

/**
 * The one renderer of remembered facts: each fact's text, a `Disagreement`
 * badge for a conflict, its horizon ("Until", "Expired" muted, or "From" for an
 * upcoming one), where it came from, and **Remove** where the server allows it.
 * It draws no heading: the host decides which scope this is.
 *
 * `renderSource` draws the "from" link, since how a conversation opens is the
 * host's: a router link on a settings page, a menu item that also closes the
 * pop-out in a title menu.
 */
export function MemoryFactRows({ facts, onRemove, removals, renderSource }: Omit<MemoryFactsState, 'facts' | 'failure'> & {
  facts: readonly MemoryMenuFact[];
  renderSource: (source: MemoryReviewSource, title: string) => ReactNode;
}): React.JSX.Element {
  const now = new Date(useNow());
  return <ul className="memory-review-facts">
    {facts.map((fact) => {
      const removal = removals?.[fact.factId];
      return <li className="memory-review-fact" key={fact.factId}>
        <div className="memory-review-fact-body">
          <p>
            {fact.text}
            {fact.conflict && <Badge className="memory-review-conflict">Disagreement</Badge>}
          </p>
          <p className="memory-review-fact-meta">
            <Horizon fact={fact} now={now} />
            <span>from {renderSource(fact.source, memorySourceTitle(fact.source))}</span>
          </p>
          {removal && !removal.pending && <InlineError>{removal.refusal}</InlineError>}
        </div>
        {fact.removable && <Button
          aria-label={`Remove “${fact.text}”`}
          className="button-quiet"
          disabled={removal?.pending === true}
          onClick={() => onRemove(fact.factId)}
        >Remove</Button>}
      </li>;
    })}
  </ul>;
}
