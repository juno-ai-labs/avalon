import { compareWorkstreamRecency } from './format';
import type { WorkstreamSummary } from './types';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The one route a screen leaves for when what it was showing is no longer
 * there to show — an archived Channel, note, or Space, a deleted
 * automation, a work stream the reader just left or marked unread. It resolves
 * to the first sidebar work stream; only an empty workspace opens the composer,
 * which is otherwise reached by an explicit New action alone.
 */
export const WORKSTREAM_LANDING_ROUTE = '/';

/**
 * Work streams the landing must not open even though the directory may still
 * list them, for this one landing. Three cases, with different reasons. A row
 * marked unread stays in the list for good and must not be reopened, since
 * opening it is what reads it. The other rows a batch archive took stay until
 * their tombstones arrive, and only the open one was evicted. And the single
 * archived or left row has already been hidden from directory readers; naming
 * it here is the route-level half of that fence. A confirmed archive remains
 * in the raw cache as an archived marker until the versioned tombstone arrives,
 * so a directory page already in flight cannot make it visible again. The
 * directory waterline still owns the final removal and orders it against every
 * other producer.
 */
export interface WorkstreamLandingState {
  skipWorkstreamIds: string[];
}

/** The ids a landing entry's `location.state` asks it to pass over; none for a bare visit. */
export function skippedWorkstreamIds(state: unknown): ReadonlySet<string> {
  const ids = typeof state === 'object' && state !== null && 'skipWorkstreamIds' in state
    ? state.skipWorkstreamIds
    : undefined;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
}

/**
 * Leave the current screen for the first work stream. Always replaces, so Back
 * cannot return to a screen the API no longer serves, or reopen and thereby
 * read a work stream that was just marked unread.
 */
export function useOpenFirstWorkstream(): (skipWorkstreamIds?: readonly string[]) => void {
  const navigate = useNavigate();
  return useCallback((skipWorkstreamIds: readonly string[] = []) => {
    const state: WorkstreamLandingState = { skipWorkstreamIds: [...skipWorkstreamIds] };
    void navigate(WORKSTREAM_LANDING_ROUTE, { replace: true, state });
  }, [navigate]);
}

export function openWorkstreamId(pathname: string): string | null {
  const id = /^\/workstreams\/([^/]+)$/.exec(pathname)?.[1];
  if (id === undefined || id === 'new') return null;
  try {
    return decodeURIComponent(id);
  } catch {
    // This runs during the shell's render, where a throw takes the whole window
    // to the error boundary rather than just the route — and the segment is
    // reachable by hand-edited hash or deep link, so `/workstreams/%` must not
    // be able to do that. Falling back to the raw segment is also what React
    // Router does when it decodes a param, which keeps the id this returns
    // equal to the one the screen keys its detail query by.
    return id;
  }
}

/** Shared by startup warming and the Space-less root route; recency is its only order. */
export function firstLandingWorkstream(workstreams: WorkstreamSummary[]): WorkstreamSummary | undefined {
  // Never a create still in flight, which has no screen to land on yet.
  return workstreams.filter((workstream) => !workstream.pending).sort(compareWorkstreamRecency)[0];
}
