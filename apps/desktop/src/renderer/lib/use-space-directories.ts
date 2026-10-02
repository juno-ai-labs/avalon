import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PersonalOrder, PinnedOrder, SpaceDirectory } from '@rally/contracts';
import {
  INACTIVE_SPACES_QUERY_KEY,
  PERSONAL_ORDER_QUERY_KEY,
  PINNED_ORDER_QUERY_KEY,
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

/**
 * Every list this person has arranged by hand, as the workspace socket last
 * delivered it.
 *
 * Empty until a payload arrives, and empty for a guest, who is sent no Space
 * state at all — which draws every list in its natural order rather than
 * leaving a surface waiting for an answer that is not coming.
 */
export function usePersonalOrder(): PersonalOrder {
  return useQuery<PersonalOrder>({
    queryKey: PERSONAL_ORDER_QUERY_KEY,
    queryFn: () => {
      throw new Error('personal-order is pushed by the organization socket, never fetched');
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data ?? [];
}

/** All's Pinned order, pushed with `usePersonalOrder`'s and empty until it arrives. */
export function usePinnedOrder(): PinnedOrder {
  return useQuery<PinnedOrder>({
    queryKey: PINNED_ORDER_QUERY_KEY,
    queryFn: () => {
      throw new Error('pinned-order is pushed by the organization socket, never fetched');
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data ?? EMPTY_PINNED_ORDER;
}
const EMPTY_PINNED_ORDER: PinnedOrder = [];
