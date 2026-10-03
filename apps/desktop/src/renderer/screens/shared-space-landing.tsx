import { Navigate, useParams } from 'react-router-dom';
import { EmptyState, LoadingState } from '../components/primitives';
import { useConversationDirectory } from '../lib/conversation-directory';

/**
 * A Space link, opened by a guest. They have no Space dashboard: its reads are
 * the Organization's, and the routes refuse them. The sidebar already filters
 * to the Space the link names, so this opens the first Channel shared with
 * them there, landing on Main when they hold it and on their first open
 * Breakout when they do not.
 */
export function SharedSpaceLanding(): React.JSX.Element {
  const { spaceId } = useParams<{ spaceId: string }>();
  const directory = useConversationDirectory();
  if (!directory) return <LoadingState label="Opening Space…" />;
  const space = directory.spaces.find((item) => item.id === spaceId);
  const channel = space?.workstreamIds
    .map((id) => directory.workstreams.find((item) => item.parentId === id))
    .find((item) => item !== undefined);
  const conversation = channel?.conversations.find((item) => !item.archived) ?? channel?.conversations[0];
  if (!channel || !conversation) {
    return <EmptyState title="Nothing shared here" description="Channels shared with you in this Space appear in the sidebar." />;
  }
  const substream = conversation.substreamId === '0' ? '' : `?substream=${encodeURIComponent(conversation.substreamId)}`;
  return <Navigate replace to={`/workstreams/${encodeURIComponent(channel.parentId)}${substream}`} />;
}
