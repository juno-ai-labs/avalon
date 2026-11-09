import { RefreshCcw } from 'lucide-react';

import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { Button, EmptyState, OpeningState } from './primitives';
import { UpdateRallyAction } from './update-rally-action';

/**
 * Rally's one sentence for a connection it cannot open, said the same way by
 * every surface that waits on it: a Canvas's pane, a section home and the
 * sidebar's lists.
 */
export const OFFLINE_TITLE = 'Rally can’t reach the server right now.';

/** What those surfaces say instead when the server no longer serves this build. */
export const UPDATE_REQUIRED_TITLE = 'This version of Rally is out of date.';

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
  if (socket?.state === 'update_required') {
    return <EmptyState
      action={<UpdateRallyAction />}
      description={`Your ${noun} appear once Rally is up to date.`}
      title={UPDATE_REQUIRED_TITLE}
    />;
  }
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
  return Boolean(socket && (socket.state === 'reconnecting' || socket.state === 'unavailable'
    || socket.state === 'update_required'));
}

/** The sidebar's line in place of its placeholder rows while the socket is down. */
export function SidebarListDown({ noun }: { noun: string }): React.JSX.Element {
  const socket = useOptionalWorkspaceSocket();
  // `WorkspaceUpdateNotice` above the lists says why and carries the action.
  if (socket?.state === 'update_required') {
    return <p className="navigation-empty" role="status">{`Your ${noun} appear once Rally is up to date.`}</p>;
  }
  return <p className="navigation-empty" role="status">{`${OFFLINE_TITLE} Your ${noun} appear when Rally reconnects.`}</p>;
}

/**
 * The sidebar's notice that the server no longer serves this build, shown
 * above its lists whatever they hold: a returning person's lists paint from
 * the device cache (`hydrateCanvasDirectory`), so a notice that waited for an
 * empty list would never show them why nothing moves.
 */
export function WorkspaceUpdateNotice(): React.JSX.Element | null {
  const socket = useOptionalWorkspaceSocket();
  if (socket?.state !== 'update_required') return null;
  return (
    <div className="navigation-update-notice" role="status">
      <p>{`${UPDATE_REQUIRED_TITLE} Lists here stop updating until it is.`}</p>
      <UpdateRallyAction />
    </div>
  );
}
