import { useMemo, type PropsWithChildren } from 'react';
import { useLocation } from 'react-router-dom';
import type { WorkstreamSummary } from './types';
import type { WorkstreamSocketApi } from './use-workstream-socket';
import { useCachedWorkstreams } from './use-workstreams-query';
import { firstLandingWorkstream, openWorkstreamId, skippedWorkstreamIds } from './workstream-landing';
import { WorkstreamSocketPool } from './workstream-socket-pool';

export const PROACTIVE_RECENT_WORKSTREAM_COUNT = 5;

export function backgroundRealtimeWorkstreamIds(
  activeWorkstreamId: string | null,
  workstreams: WorkstreamSummary[] | undefined,
): string[] {
  const candidates = (workstreams ?? []).filter((workstream) => workstream.id !== activeWorkstreamId);
  const recentUnpinned = new Set(candidates
    .filter((workstream) => workstream.pinPosition === null)
    .sort((left, right) => {
      const activityOrder = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
      return activityOrder || left.id.localeCompare(right.id);
    })
    .slice(0, PROACTIVE_RECENT_WORKSTREAM_COUNT)
    .map((workstream) => workstream.id));
  return candidates.flatMap((workstream) => (
    workstream.harnessStatus === 'running'
      || workstream.pinPosition !== null
      || recentUnpinned.has(workstream.id)
      ? [workstream.id]
      : []
  ));
}

/** Start the existing pool from the directory, independently of workspace details. */
export function WorkspaceWorkstreamSockets({ api, children }: PropsWithChildren<{
  api: WorkstreamSocketApi | null;
}>): React.JSX.Element {
  const location = useLocation();
  const workstreams = useCachedWorkstreams();
  const activeWorkstreamId = openWorkstreamId(location.pathname);
  const backgroundIds = useMemo(() => {
    const selected = backgroundRealtimeWorkstreamIds(activeWorkstreamId, workstreams);
    if (location.pathname !== '/' || !workstreams) return selected;
    const skipped = skippedWorkstreamIds(location.state);
    const first = firstLandingWorkstream(workstreams.filter((row) => !skipped.has(row.id)));
    return first ? [...new Set([first.id, ...selected])] : selected;
  }, [activeWorkstreamId, location.pathname, location.state, workstreams]);
  return <WorkstreamSocketPool api={api} activeWorkstreamId={activeWorkstreamId} backgroundWorkstreamIds={backgroundIds}>{children}</WorkstreamSocketPool>;
}
