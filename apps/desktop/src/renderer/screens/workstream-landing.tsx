import { Navigate } from 'react-router-dom';
import { InlineError, LoadingState } from '../components/primitives';
import { orderPinnedWorkstreams } from '../components/sidebar';
import { groupWorkstreams } from '../lib/format';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';

/** Resolve only the default route; live list updates never replace an open conversation. */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const workstreams = useWorkstreamsQuery();
  // The workspace socket supplies the opening directory. Missing data is not
  // an empty workspace, and must not flash the new-workstream composer.
  if (!workstreams.data) {
    if (workstreams.error) return <InlineError>{workstreams.error.message}</InlineError>;
    return <LoadingState label="Opening work streams…" />;
  }
  const first = orderPinnedWorkstreams(workstreams.data, null)[0]
    ?? groupWorkstreams(workstreams.data)[0]?.streams[0];
  return <Navigate replace to={first ? `/workstreams/${encodeURIComponent(first.id)}` : '/workstreams/new'} />;
}
