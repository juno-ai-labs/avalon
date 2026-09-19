import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { SpaceDirectory } from '@rally/contracts';
import {
  INACTIVE_SPACES_QUERY_KEY,
  SPACES_QUERY_KEY,
  SPACES_READY_QUERY_KEY,
} from './sidebar-list-store';

function useSocketOwnedSpaceDirectory(
  queryKey: typeof SPACES_QUERY_KEY | typeof INACTIVE_SPACES_QUERY_KEY,
): UseQueryResult<SpaceDirectory> {
  return useQuery<SpaceDirectory>({
    queryKey,
    queryFn: () => {
      throw new Error(`${queryKey[0]} is pushed by the organization socket, never fetched`);
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The active and archived Space directories owned by the workspace socket. */
export function useSpaceDirectories(): {
  active: UseQueryResult<SpaceDirectory>;
  inactive: UseQueryResult<SpaceDirectory>;
} {
  return {
    active: useSocketOwnedSpaceDirectory(SPACES_QUERY_KEY),
    inactive: useSocketOwnedSpaceDirectory(INACTIVE_SPACES_QUERY_KEY),
  };
}

/**
 * Whether the Organization has finished opening.
 *
 * `true` until a payload says otherwise, which is what a server without the
 * cutover produces: the flag is optional on the wire, and reading its absence
 * as "still opening" would leave such a build showing the opening state
 * forever.
 */
export function useSpacesReady(): boolean {
  return useQuery<boolean>({
    queryKey: SPACES_READY_QUERY_KEY,
    queryFn: () => {
      throw new Error('spaces-ready is pushed by the organization socket, never fetched');
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data ?? true;
}
