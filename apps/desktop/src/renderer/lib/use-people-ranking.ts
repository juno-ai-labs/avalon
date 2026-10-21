import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RallyApi } from './api';

/** Warm optional ranking when the title menu opens; the roster is immediately usable. */
export function usePeopleRanking(api: Pick<RallyApi, 'getPeopleRanking'> | null | undefined, workspaceId: string, userId: string | undefined, channelId: string | null, enabled: boolean) {
  const [wanted, setWanted] = useState(false);
  const eligible = Boolean(api && userId) && enabled;
  const ranking = useQuery({
    queryKey: ['people-ranking', workspaceId, userId, channelId],
    queryFn: ({ signal }) => api!.getPeopleRanking(channelId, signal),
    enabled: eligible && wanted,
  });
  return {
    ranking: eligible ? ranking.data : undefined,
    onOpen: () => {
      if (!eligible) return;
      setWanted(true);
      if (wanted) void ranking.refetch({ cancelRefetch: false });
    },
  };
}
