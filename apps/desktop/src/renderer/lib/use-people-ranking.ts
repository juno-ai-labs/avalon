import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RallyApi } from './api';

/** Optional ranking loads when People opens; the ordinary roster is immediately usable. */
export function usePeopleRanking(api: Pick<RallyApi, 'getPeopleRanking'> | null | undefined, workspaceId: string, userId: string | undefined, channelId: string | null, enabled: boolean) {
  const [wanted, setWanted] = useState(false);
  const ranking = useQuery({
    queryKey: ['people-ranking', workspaceId, userId, channelId],
    queryFn: ({ signal }) => api!.getPeopleRanking(channelId, signal),
    enabled: Boolean(api && userId) && enabled && wanted,
  });
  return {
    ranking: ranking.data,
    onOpen: () => { setWanted(true); if (wanted) void ranking.refetch({ cancelRefetch: false }); },
    rankingLoading: wanted && ranking.isPending && ranking.isFetching,
    rankingFailed: ranking.isError,
    onRetryRanking: () => { void ranking.refetch(); },
  };
}
