import type { SidekickActivityTarget } from '@rally/contracts';
import { useQuery } from '@tanstack/react-query';
import type { RallyApi } from './api';

/** The Organization socket invalidates this count when a Sidekick starts or settles. */
export function useSidekickActivity(api: RallyApi | null, target: SidekickActivityTarget | null): number | undefined {
  return useQuery({
    queryKey: ['sidekick-activity', target?.parentKind, target?.parentId, target?.substreamId],
    queryFn: ({ signal }) => api!.getSidekickActivity(target!, signal),
    enabled: Boolean(api && target),
  }).data;
}
