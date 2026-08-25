import {
  ClientFeatureFlagsSchema,
  type ClientFeatureFlags,
} from '@avalon/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { AvalonApi } from './api';

export const CLIENT_FEATURE_FLAGS_QUERY_KEY = ['feature-flags'] as const;
export const DEFAULT_CLIENT_FEATURE_FLAGS: ClientFeatureFlags = ClientFeatureFlagsSchema.parse({});

/**
 * Product features begin off and move only after a schema-valid server answer.
 * The workspace socket writes the same cache key on connect and on live change;
 * this HTTP read covers the short interval before that socket is subscribed.
 */
export function useClientFeatureFlags(
  api: Pick<AvalonApi, 'clientFeatureFlags'> | null,
): UseQueryResult<ClientFeatureFlags> {
  return useQuery({
    queryKey: CLIENT_FEATURE_FLAGS_QUERY_KEY,
    queryFn: ({ signal }) => api!.clientFeatureFlags(signal),
    enabled: api !== null,
    initialData: DEFAULT_CLIENT_FEATURE_FLAGS,
    staleTime: 60_000,
  });
}
