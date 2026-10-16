import { useQuery } from '@tanstack/react-query';

import type { RallyApi } from './api';

/**
 * The order a thread's Channels are offered for a merge: the server's, earliest
 * placement first, so the first is the default it would choose
 * (docs/conversation-merge.md). Read in the background, so the Merge label
 * never waits on it; `undefined` until it lands, when the directory's order
 * stands in.
 */
export function useMergeChannelOrder(
  api: Pick<RallyApi, 'mergeChannels'> | null | undefined,
  threadId: string,
  enabled: boolean,
): readonly string[] | undefined {
  return useQuery({
    queryKey: ['merge-channels', threadId],
    queryFn: async () => (await api!.mergeChannels(threadId)).channels.map((channel) => channel.id),
    enabled: enabled && Boolean(api?.mergeChannels),
    retry: false,
  }).data;
}
