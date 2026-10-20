import { LoaderCircle } from 'lucide-react';
import { Button } from './primitives';

/** History waits for the conversation transport; its recovery stays with that owner. */
export function TranscriptHistoryStatus({ live, onReconnect }: {
  live: boolean;
  onReconnect: () => void;
}): React.JSX.Element {
  return <>
    <LoaderCircle aria-hidden="true" className="spin" size={14} />
    <span>{live ? 'Loading earlier messages…' : 'Waiting to reconnect…'}</span>
    {!live && <Button onClick={onReconnect}>Reconnect now</Button>}
  </>;
}
