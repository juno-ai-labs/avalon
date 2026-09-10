import { useEffect, useMemo } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { InlineError, LoadingState } from '../components/primitives';
import { firstLandingWorkstream, skippedWorkstreamIds } from '../lib/workstream-landing';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';

/** Resolve only the default route; live list updates never replace an open conversation. */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const workstreams = useWorkstreamsQuery();
  const { state } = useWorkspaceSocket();
  const routeState: unknown = useLocation().state;
  const skipped = useMemo(() => skippedWorkstreamIds(routeState), [routeState]);
  // A screen that just left for this route names what it left behind; the
  // directory has not caught up yet, and that row would otherwise be the
  // most recent one here.
  const loaded = workstreams.data;
  const candidates = useMemo(
    () => loaded?.filter((workstream) => !skipped.has(workstream.id)) ?? [],
    [loaded, skipped],
  );
  // A batch can take a whole loaded page — the day's work streams, say — while
  // older ones sit beyond the cursor. No candidate on the pages held is then
  // not an empty workspace; ask for the next page before deciding it is.
  // Keyed on the list rather than on the fetch settling, so a page that fails
  // is not asked for again in a loop: the next request waits for the list to
  // change, which the socket does once the archive's tombstones land.
  // `fetchMore` is deliberately not a dependency: it is re-created as a page
  // settles, and re-requesting on that would be the loop.
  const needsMore = loaded !== undefined && candidates.length === 0 && workstreams.hasMore;
  const { fetchMore } = workstreams;
  useEffect(() => {
    if (needsMore) fetchMore();
  }, [needsMore, loaded]);
  // The workspace socket supplies the opening directory. Missing data is not
  // an empty workspace, and must not flash the new-workstream composer.
  if (!loaded) {
    if (workstreams.error) return <InlineError>{workstreams.error.message}</InlineError>;
    if (state === 'unavailable') return <InlineError>Unable to connect to your workspace. Check your connection and restart Rally to try again.</InlineError>;
    return <LoadingState label="Opening work streams…" />;
  }
  if (needsMore) return <LoadingState label="Opening work streams…" />;
  const first = firstLandingWorkstream(candidates);
  return <Navigate replace to={first ? `/workstreams/${encodeURIComponent(first.id)}` : '/workstreams/new'} />;
}
