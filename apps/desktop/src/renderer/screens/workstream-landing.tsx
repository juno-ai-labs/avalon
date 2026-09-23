import { useEffect, useMemo } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { InlineError, LoadingState } from '../components/primitives';
import { firstLandingWorkstream, skippedWorkstreamIds } from '../lib/workstream-landing';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { useAppSession } from '../lib/app-session';

/** Resolve only the default route; live list updates never replace an open conversation. */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const workstreams = useWorkstreamsQuery();
  const spaces = useSpaceDirectories().active.data;
  const { session } = useAppSession();
  const { state, sidebarConnect } = useWorkspaceSocket();
  const routeState: unknown = useLocation().state;
  const savedRoute = routeState == null && session?.workspace && session.user
    ? readLayout(layoutKey(session.workspace.id, session.user.id, 'last-route')) : null;
  const savedChannel = /^\/workstreams\/([^/?]+)$/.exec((savedRoute ?? '').split('?')[0]!);
  const savedSpace = /^\/spaces\/([^/?]+)$/.exec((savedRoute ?? '').split('?')[0]!);
  const savedBreakout = new URLSearchParams((savedRoute ?? '').split('?')[1] ?? '').get('substream');
  let savedChannelId: string | null = null;
  try { if (savedChannel) savedChannelId = decodeURIComponent(savedChannel[1]!); }
  catch { /* Ignore malformed local state. */ }
  const skipped = useMemo(() => skippedWorkstreamIds(routeState), [routeState]);
  // A screen that just left for this route names what it left behind; the
  // directory has not caught up yet, and that row would otherwise be the
  // most recent one here.
  const loaded = workstreams.data;
  const candidates = useMemo(
    () => loaded?.filter((workstream) => !skipped.has(workstream.id)) ?? [],
    [loaded, skipped],
  );
  let savedSpaceId: string | null = null;
  try { if (savedSpace) savedSpaceId = decodeURIComponent(savedSpace[1]!); }
  catch { /* Ignore malformed local state. */ }
  const awaitingSpace = savedSpaceId !== null && !spaces && state !== 'unavailable'
    && sidebarConnect?.spacesLive !== false;
  // A batch can take a whole loaded page — the day's work streams, say — while
  // older ones sit beyond the cursor. No candidate on the pages held is then
  // not an empty workspace; ask for the next page before deciding it is.
  // Keyed on the list rather than on the fetch settling, so a page that fails
  // is not asked for again in a loop: the next request waits for the list to
  // change, which the socket does once the archive's tombstones land.
  // `fetchMore` is deliberately not a dependency: it is re-created as a page
  // settles, and re-requesting on that would be the loop.
  const needsMore = loaded !== undefined && workstreams.hasMore
    && (savedChannelId !== null
      ? !candidates.some((row) => row.id === savedChannelId)
      : candidates.length === 0 && !awaitingSpace
        && !spaces?.items.some((row) => row.id === savedSpaceId));
  const { fetchMore } = workstreams;
  useEffect(() => {
    if (needsMore) fetchMore();
  }, [needsMore, loaded]);
  // The workspace socket supplies the opening directory. Missing data is not
  // an empty workspace, and must not flash the new-workstream composer.
  if (!loaded) {
    if (workstreams.error) return <InlineError>{workstreams.error.message}</InlineError>;
    if (state === 'unavailable') return <InlineError>Unable to connect to your organization. Check your connection and restart Rally to try again.</InlineError>;
    return <LoadingState label="Opening channels…" />;
  }
  if (needsMore) return <LoadingState label="Opening channels…" />;
  const first = firstLandingWorkstream(candidates);
  // Only a bare startup landing resumes the device's last view. A deliberate
  // leave carries state (including an empty skip list) and uses recency instead.
  if (savedRoute) {
    if (savedChannelId !== null && candidates.some((row) => row.id === savedChannelId)) {
      return <Navigate replace state={savedBreakout ? { restoredBreakout: savedBreakout } : undefined}
        to={`/workstreams/${encodeURIComponent(savedChannelId)}${savedBreakout ? `?substream=${encodeURIComponent(savedBreakout)}` : ''}`} />;
    }
    if (savedSpaceId !== null && session?.workspace?.accessClass !== 'guest') {
      if (awaitingSpace) return <LoadingState label="Opening spaces…" />;
      if (spaces?.items.some((row) => row.id === savedSpaceId)) return <Navigate replace to={`/spaces/${encodeURIComponent(savedSpaceId)}`} />;
    }
  }
  return <Navigate replace to={first ? `/workstreams/${encodeURIComponent(first.id)}` : '/workstreams/new'} />;
}
