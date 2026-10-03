import { Navigate, useParams } from 'react-router-dom';
import { EmptyState, LoadingState } from '../components/primitives';
import { useConversationDirectoryQuery } from '../lib/conversation-directory';

/**
 * Where a guest lands: the Organization's root, or a Space link. A guest has no
 * Channel list or Space dashboard of the Organization's, so both read the
 * conversation directory the sidebar is drawn from and open the first Channel
 * shared with them (in the linked Space, when there is one), on Main when they
 * hold it and on their first open Breakout when they do not.
 */
export function SharedLanding(): React.JSX.Element {
  const { spaceId } = useParams<{ spaceId: string }>();
  const directory = useConversationDirectoryQuery();
  if (!directory.data) {
    // The shell owns the fetch and the sidebar offers its retry; this only
    // stops waiting once that fetch has failed.
    return directory.isError
      ? <EmptyState title="Shared channels could not be loaded" description="Check your connection, then retry from the sidebar." />
      : <LoadingState label={spaceId ? 'Opening Space…' : 'Opening channels…'} />;
  }
  const { spaces, workstreams } = directory.data;
  const channelIds = spaceId === undefined
    ? workstreams.map((item) => item.parentId)
    : spaces.find((item) => item.id === spaceId)?.workstreamIds ?? [];
  const channel = channelIds
    .map((id) => workstreams.find((item) => item.parentId === id))
    .find((item) => item !== undefined && !item.archived);
  const conversation = channel?.conversations.find((item) => !item.archived);
  if (!channel || !conversation) {
    return <EmptyState
      title={spaceId ? 'Nothing shared here' : 'No channels yet'}
      description={spaceId ? 'Channels shared with you in this Space appear in the sidebar.' : 'Channels shared with you appear in the sidebar.'}
    />;
  }
  const substream = conversation.substreamId === '0' ? '' : `?substream=${encodeURIComponent(conversation.substreamId)}`;
  return <Navigate replace to={`/workstreams/${encodeURIComponent(channel.parentId)}${substream}`} />;
}
