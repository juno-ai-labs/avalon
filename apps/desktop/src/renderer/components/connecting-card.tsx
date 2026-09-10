import { AlertTriangle, LoaderCircle, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './primitives';

export type ConnectingCardState = 'connecting' | 'offline' | 'failed';

/** What the card is connecting to, for the sentence when the thing has no name yet. */
export type ConnectingCardSubject = 'work stream' | 'substream' | 'Sidekick' | 'project';

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
 * The small floating card over a screen that painted from the local cache
 * before its socket answered.
 *
 * What it says is the whole of what a person needs to know about a cached
 * paint: the screen is real, it is what the workspace last said, and the live
 * connection is on its way. It is a status, so it is polite rather than
 * assertive; a failure keeps the same card and adds the one action there is.
 */
export function ConnectingCard({ detail, error, name, onRetry, state, subject }: ConnectingCardProps): React.JSX.Element {
  const target = name === null ? <>this {subject}</> : <strong>{name}</strong>;
  const sentence = state === 'connecting'
    ? <>Connecting to {target}…</>
    : state === 'offline'
      ? <>Waiting for a connection to {target}…</>
      : <>Rally could not connect to {target}.</>;
  return (
    <div aria-live="polite" className={clsx('connecting-card', `is-${state}`)} role="status">
      <span aria-hidden="true" className="connecting-card-icon">
        {state === 'connecting'
          ? <LoaderCircle className="spin" size={14} />
          : state === 'offline'
            ? <WifiOff size={14} />
            : <AlertTriangle size={14} />}
      </span>
      <span className="connecting-card-copy">
        <span className="connecting-card-sentence">{sentence}</span>
        {state === 'failed' && error
          ? <small>{error}</small>
          : detail && <small>{detail}</small>}
      </span>
      {state === 'failed' && onRetry && <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}
