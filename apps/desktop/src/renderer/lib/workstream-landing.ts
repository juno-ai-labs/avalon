import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The one route a screen leaves for when what it was showing is no longer
 * there to show — an archived work stream, note, or project, a deleted
 * automation, a work stream the reader just left or marked unread. It resolves
 * to the first sidebar work stream; only an empty workspace opens the composer,
 * which is otherwise reached by an explicit New action alone.
 */
export const WORKSTREAM_LANDING_ROUTE = '/';

/**
 * Work streams the landing must not open even though the directory still lists
 * them. The list is authoritative and this route does not patch it: an archive
 * is removed by the WorkstreamDO tombstone the socket delivers, a batch by its
 * refetch, and both arrive after the screen has already had to leave. A row
 * marked unread is present for good and must not be reopened either, since
 * opening it is what reads it.
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
