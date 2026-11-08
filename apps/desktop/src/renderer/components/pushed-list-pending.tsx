import { RefreshCcw } from 'lucide-react';

import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { Button, EmptyState, OpeningState } from './primitives';

/**
 * Rally's one sentence for a connection it cannot open, said the same way by
 * every surface that waits on it: a Canvas's pane, a section home and the
 * sidebar's lists.
 */
export const OFFLINE_TITLE = 'Rally can’t reach the server right now.';

/** The one Try again those surfaces offer: outlined, with its arrow. */
export function OfflineRetry({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return <Button onClick={onRetry}><RefreshCcw aria-hidden="true" size={14} /> Try again</Button>;
}

/**
 * What a page shows before the Organization socket has delivered the list it
 * reads (`useSocketOwnedList`): the opening state while the socket is dialling,
 * and, once a dial has failed, that it has, with a way to dial again now. A
 * refused handshake (an origin the API does not allow, say) is retried with
 * backoff for ever and is invisible to a page otherwise, which then sits on
 * its opening state with nothing to say why.
 */
export function PushedListPending({ label, noun }: {
  /** The opening state's label, e.g. `Loading Canvases…`. */
  label: string;
  /** What the list holds, for the sentence, e.g. `Canvases`. */
  noun: string;
}): React.JSX.Element {
  const socket = useOptionalWorkspaceSocket();
  if (socket && (socket.state === 'reconnecting' || socket.state === 'unavailable')) {
    return <EmptyState
      action={<OfflineRetry onRetry={() => socket.retry()} />}
      description={`Your ${noun} appear when Rally reconnects.`}
      title={OFFLINE_TITLE}
    />;
  }
  return <OpeningState label={label} />;
}

/**
 * Whether the Organization socket that fills the pushed lists has failed to
 * open: placeholders would then wait for ever, so a list says so instead.
 */
export function usePushedListsDown(): boolean {
  const socket = useOptionalWorkspaceSocket();
  return Boolean(socket && (socket.state === 'reconnecting' || socket.state === 'unavailable'));
}

/** The sidebar's line in place of its placeholder rows while the socket is down. */
export function SidebarListDown({ noun }: { noun: string }): React.JSX.Element {
  return <p className="navigation-empty" role="status">{`${OFFLINE_TITLE} Your ${noun} appear when Rally reconnects.`}</p>;
}
