import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { Button, EmptyState, OpeningState } from './primitives';

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
      action={<Button onClick={() => socket.retry()}>Try again</Button>}
      description={`Your ${noun} arrive over Rally’s live connection, which could not be opened. Rally keeps trying.`}
      title="Rally can’t connect"
    />;
  }
  return <OpeningState label={label} />;
}
