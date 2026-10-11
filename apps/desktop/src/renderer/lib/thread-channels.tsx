import type { ThreadChannels } from '@rally/ui/components/conversation-menus';
import { SpaceIcon } from '@rally/ui/components/space-icon';
import { markColors } from '@rally/ui/lib/project-palette';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useCollaborationSession } from './collaboration-session';
import { channelFeedQueryKey, MY_THREADS_QUERY_KEY } from './sidebar-list-store';
import { spaceFailureSentence } from './space-failure-copy';
import { useSpaceDirectories } from './use-space-directories';
import { workstreamDetailQueryKey } from './workstreams-cache';

/**
 * The Channels level of a thread's title menu: the Channels it sits in, and
 * every other Channel it could be added to.
 *
 * A Channel is addable when this person may start a thread there (they reach
 * it as more than a reader of one thread in it). The server keeps a thread in
 * at least one Channel, so the last one cannot be removed. `writable` is false
 * for a guest, who sees where the thread sits and changes nothing.
 */
export function useThreadChannels(threadId: string, spaceIds: readonly string[], writable: boolean): ThreadChannels | undefined {
  // The same session the thread screen reads, so any host of that screen has it.
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const { active } = useSpaceDirectories();
  const [error, setError] = useState<string | null>(null);
  const channels = active.data?.items;
  if (!channels) return undefined;
  const row = (space: (typeof channels)[number]) => ({
    id: space.id,
    name: space.name,
    icon: <span className="navigation-channel-mark is-small" style={{ background: markColors(space.colorKey).tint }}>
      <SpaceIcon size={16} space={space} />
    </span>,
  });
  const inThread = new Set(spaceIds);
  const current = channels.filter((space) => inThread.has(space.id)).map(row);
  const addable = channels
    .filter((space) => !inThread.has(space.id) && space.reach !== 'through_channel')
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    .map(row);
  const settle = (channelId: string, write: Promise<unknown>, fallback: string): void => {
    setError(null);
    void write.then(() => {
      // The thread's row, with its Channels, arrives on the socket (it is
      // never fetched); the lists that read placements, and the thread's own
      // detail, are read again.
      void queryClient.invalidateQueries({ queryKey: channelFeedQueryKey(channelId) });
      void queryClient.invalidateQueries({ queryKey: MY_THREADS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: workstreamDetailQueryKey(threadId, '0') });
    }, (cause: unknown) => setError(spaceFailureSentence(cause, fallback)));
  };
  return {
    current,
    addable,
    error,
    ...(writable && api ? {
      onAdd: (channelId: string) => settle(channelId, api.addChannelToSpace(channelId, threadId), 'The thread couldn’t be added to that channel.'),
      onRemove: (channelId: string) => settle(channelId, api.removeChannelFromSpace(channelId, threadId), 'The thread couldn’t be taken out of that channel.'),
    } : {}),
  };
}
