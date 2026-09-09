import { Navigate, useLocation } from 'react-router-dom';
import { InlineError, LoadingState } from '../components/primitives';
import { orderPinnedWorkstreams } from '../components/sidebar';
import { compareWorkstreamRecency } from '../lib/format';
import { skippedWorkstreamIds } from '../lib/workstream-landing';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';

/** Resolve only the default route; live list updates never replace an open conversation. */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const workstreams = useWorkstreamsQuery();
  const { state } = useWorkspaceSocket();
  const skipped = skippedWorkstreamIds(useLocation().state);
  // The workspace socket supplies the opening directory. Missing data is not
  // an empty workspace, and must not flash the new-workstream composer.
  if (!workstreams.data) {
    if (workstreams.error) return <InlineError>{workstreams.error.message}</InlineError>;
    if (state === 'unavailable') return <InlineError>Unable to connect to your workspace. Check your connection and restart Rally to try again.</InlineError>;
    return <LoadingState label="Opening work streams…" />;
  }
  // A screen that just left for this route names what it left behind; the
  // directory has not caught up yet, and that row would otherwise be the
  // most recent one here.
  const candidates = workstreams.data.filter((workstream) => !skipped.has(workstream.id));
  const first = orderPinnedWorkstreams(candidates, null)[0]
    ?? [...candidates].sort(compareWorkstreamRecency)[0];
  return <Navigate replace to={first ? `/workstreams/${encodeURIComponent(first.id)}` : '/workstreams/new'} />;
}
