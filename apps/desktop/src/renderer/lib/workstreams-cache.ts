import type { QueryClient } from '@tanstack/react-query';
import type { WorkstreamSummary } from './types';

/** The one cache entry every work-stream list reader and writer shares. */
export const WORKSTREAMS_QUERY_KEY = ['workstreams'] as const;

type WorkstreamsCacheUpdate = WorkstreamSummary[]
  | ((current: WorkstreamSummary[] | undefined) => WorkstreamSummary[] | undefined);

function assertWorkstreamList(value: unknown): asserts value is WorkstreamSummary[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid workstreams cache value: expected a WorkstreamSummary array.');
  }
}

/**
 * The only write boundary for the shared flat work-stream list.
 *
 * React Query's `setQueryData` infers its generic from the value being written,
 * not from the query key. Calling it directly therefore permits a page object
 * to be stored under a key whose readers independently expect an array. This
 * wrapper binds the key to the array at compile time, and the small runtime
 * invariant catches a cast or other type escape at the corrupting write rather
 * than at a later `.map` or `.filter` in the sidebar.
 */
export function setCachedWorkstreams(
  queryClient: QueryClient,
  update: WorkstreamsCacheUpdate,
): void {
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) => {
    if (current !== undefined) assertWorkstreamList(current);
    const next = typeof update === 'function' ? update(current) : update;
    if (next !== undefined) assertWorkstreamList(next);
    return next;
  });
}
