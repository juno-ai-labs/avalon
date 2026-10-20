import { useQuery } from '@tanstack/react-query';

import type { RallyApi } from './api';

/**
 * The eligible Channels offered for a merge: the server's, earliest
 * placement first, so the first is the default it would choose
 * (docs/conversation-merge.md). Read in the background, so the Merge label
 * never waits on it; until it lands the directory stands in. Once read, these
 * IDs own eligibility too, including an empty list when no target is writable.
 */
export const MERGE_CHANNELS_QUERY_KEY = ['merge-channels'] as const;

export function useMergeChannels(
  api: Pick<RallyApi, 'mergeChannels'> | null | undefined,
  threadId: string,
  enabled: boolean,
): readonly string[] | undefined {
  return useQuery({
    queryKey: [...MERGE_CHANNELS_QUERY_KEY, threadId],
    queryFn: async () => (await api!.mergeChannels(threadId)).channels.map((channel) => channel.id),
    enabled: enabled && Boolean(api?.mergeChannels),
    retry: false,
  }).data;
}
