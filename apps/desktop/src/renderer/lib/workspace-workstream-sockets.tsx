import { useMemo, type PropsWithChildren } from 'react';
import { useLocation } from 'react-router-dom';
import type { WorkstreamSummary } from './types';
import type { WorkstreamSocketApi } from './use-workstream-socket';
import { useCachedWorkstreams } from './use-workstreams-query';
import { mainReachable, useConversationDirectory } from './conversation-directory';
import { firstLandingWorkstream, openWorkstreamId, skippedWorkstreamIds } from './workstream-landing';
import { WorkstreamSocketPool } from './workstream-socket-pool';

export const PROACTIVE_RECENT_WORKSTREAM_COUNT = 5;

export function backgroundRealtimeWorkstreamIds(
  activeWorkstreamId: string | null,
  workstreams: WorkstreamSummary[] | undefined,
): string[] {
  // A pending row is a create still in flight: there is no room to connect to.
  const candidates = (workstreams ?? []).filter((workstream) => (
    workstream.id !== activeWorkstreamId && !workstream.pending
  ));
  const recentUnpinned = new Set(candidates
    .filter((workstream) => (workstream.spacePins?.length ?? 0) === 0)
    .sort((left, right) => {
      const activityOrder = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
      return activityOrder || left.id.localeCompare(right.id);
    })
    .slice(0, PROACTIVE_RECENT_WORKSTREAM_COUNT)
    .map((workstream) => workstream.id));
  return candidates.flatMap((workstream) => (
    workstream.harnessStatus === 'running'
      || (workstream.spacePins?.length ?? 0) > 0
      || recentUnpinned.has(workstream.id)
      ? [workstream.id]
      : []
  ));
}

/** The Channel the route has open, unless it is pending; see `keepPendingWorkstreams`. */
export function activeRealtimeWorkstreamId(
  routedWorkstreamId: string | null,
  workstreams: WorkstreamSummary[] | undefined,
): string | null {
  if (routedWorkstreamId === null) return null;
  return workstreams?.some((row) => row.id === routedWorkstreamId && row.pending) ? null : routedWorkstreamId;
}

/** Start the existing pool from the directory, independently of workspace details. */
export function WorkspaceWorkstreamSockets({ api, children }: PropsWithChildren<{
  api: WorkstreamSocketApi | null;
}>): React.JSX.Element {
  const location = useLocation();
  const workstreams = useCachedWorkstreams();
  const directory = useConversationDirectory();
  // The pool dials Main, so it leaves out a Channel whose Main is not this
  // person's (`mainReachable`), whether they are a member or a guest.
  const reachable = (id: string) => mainReachable(workstreams?.find((row) => row.id === id), directory, id) !== false;
  const routed = activeRealtimeWorkstreamId(openWorkstreamId(location.pathname), workstreams);
  const activeWorkstreamId = routed !== null && reachable(routed) ? routed : null;
  const backgroundIds = useMemo(() => {
    const selected = backgroundRealtimeWorkstreamIds(activeWorkstreamId, workstreams);
    if (location.pathname !== '/' || !workstreams) return selected.filter(reachable);
    const skipped = skippedWorkstreamIds(location.state);
    const first = firstLandingWorkstream(workstreams.filter((row) => !skipped.has(row.id)));
    return (first ? [...new Set([first.id, ...selected])] : selected).filter(reachable);
    // `reachable` reads only `workstreams` and `directory`.
  }, [activeWorkstreamId, directory, location.pathname, location.state, workstreams]);
  return <WorkstreamSocketPool api={api} activeWorkstreamId={activeWorkstreamId} backgroundWorkstreamIds={backgroundIds}>{children}</WorkstreamSocketPool>;
}
