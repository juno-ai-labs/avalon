import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectDirectory } from '@rally/contracts';
import { PROJECTS_QUERY_KEY, INACTIVE_PROJECTS_QUERY_KEY } from './sidebar-list-store';

function useSocketOwnedProjectDirectory(
  queryKey: typeof PROJECTS_QUERY_KEY | typeof INACTIVE_PROJECTS_QUERY_KEY,
): UseQueryResult<ProjectDirectory> {
  return useQuery<ProjectDirectory>({
    queryKey,
    queryFn: () => {
      throw new Error(`${queryKey[0]} is pushed by the workspace socket, never fetched`);
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The active and archived project directories owned by the workspace socket. */
export function useProjectDirectories(): {
  active: UseQueryResult<ProjectDirectory>;
  inactive: UseQueryResult<ProjectDirectory>;
} {
  return {
    active: useSocketOwnedProjectDirectory(PROJECTS_QUERY_KEY),
    inactive: useSocketOwnedProjectDirectory(INACTIVE_PROJECTS_QUERY_KEY),
  };
}
