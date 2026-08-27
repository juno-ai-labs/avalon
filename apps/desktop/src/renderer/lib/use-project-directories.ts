import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectDirectory } from '@rally/contracts';

function useSocketOwnedProjectDirectory(
  queryKey: readonly ['projects'] | readonly ['projects-inactive'],
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
    active: useSocketOwnedProjectDirectory(['projects']),
    inactive: useSocketOwnedProjectDirectory(['projects-inactive']),
  };
}
