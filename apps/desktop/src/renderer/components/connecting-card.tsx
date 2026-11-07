import { ErrorNotice } from './primitives';
import { AlertTriangle, LoaderCircle, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import type { PropsWithChildren } from 'react';
import { Button } from './primitives';

export type ConnectingCardState = 'connecting' | 'offline' | 'failed';

/** What the card is connecting to, for the sentence when the thing has no name yet. */
export type ConnectingCardSubject = 'Canvas' | 'Sidekick';

export interface ConnectingCardProps {
  /** The title of what is opening, or null while Rally is still naming it. */
  name: string | null;
  subject: ConnectingCardSubject;
  state: ConnectingCardState;
  /** Why the connection failed, when it did; shown under the sentence. */
  error?: string | undefined;
  /**
   * What waits for the connection, shown under the sentence while it is being
   * made. A conversation says its composer will send once Rally connects; the
   * capsule composer has no footer of its own to say so in.
   */
  detail?: string | undefined;
  onRetry?: (() => void) | undefined;
}

/**
 * Where a screen's connecting card floats: zero height, so the card covers
 * the rows beneath it rather than pushing them. The slot is the live region
 * and it stays mounted whether or not a card is in it, because a live region
 * that mounts with its text already present is generally not announced; only
 * a change inside one is. A screen renders the slot always and the card only
 * while it is seeded.
 */
export function ConnectingCardSlot({ children, className }: PropsWithChildren<{ className?: string | undefined }>): React.JSX.Element {
  return (
    <div aria-live="polite" className={clsx('connection-card-slot', className)} role="status">
      {children}
    </div>
  );
}

/**
 * The small floating card over a screen that painted from the local cache
 * before its socket answered.
 *
 * What it says is the whole of what a person needs to know about a cached
 * paint: the screen is real, it is what the workspace last said, and the live
 * connection is on its way. A failure keeps the same card, keeps what waits
 * for the connection, adds why, and adds the one action there is.
 */
export function ConnectingCard({ detail, error, name, onRetry, state, subject }: ConnectingCardProps): React.JSX.Element {
  const target = name === null ? <>this {subject}</> : <strong>{name}</strong>;
  const sentence = state === 'connecting'
    ? <>Connecting to {target}…</>
    : state === 'offline'
      ? <>Waiting for a connection to {target}…</>
      : <>Rally could not connect to {target}.</>;
  return (
    <div className={clsx('connecting-card', `is-${state}`)}>
      <span aria-hidden="true" className="connecting-card-icon">
        {state === 'connecting'
          ? <LoaderCircle className="spin" size={14} />
          : state === 'offline'
            ? <WifiOff size={14} />
            : <AlertTriangle size={14} />}
      </span>
      <span className="connecting-card-copy">
        <span className="connecting-card-sentence">{state === 'failed' ? <>Connect to {target}</> : sentence}</span>
        {state === 'failed' && <ErrorNotice><p>{sentence}</p>{error && <p>{error}</p>}</ErrorNotice>}
        {detail && <small>{detail}</small>}
      </span>
      {state === 'failed' && onRetry && <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}
