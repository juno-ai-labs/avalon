import { Navigate, useLocation } from 'react-router-dom';

import { EmptyState, ErrorNotice, LoadingState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { OPEN_EXPANDED, channelRoute } from '../lib/navigation-routes';
import { usePins } from '../lib/pins';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { landingSpaceId, skippedWorkstreamIds } from '../lib/workstream-landing';

/**
 * The root route: where Rally opens. The route this person last had open on
 * this device, else the Channel a screen just left asked to return to, else
 * their first pinned Channel, else General, else the first
 * Channel A–Z. A thread a screen just left (archived, made unread) is never
 * reopened from the saved route. A saved thread under a Channel reopens
 * expanded, as the Channel and the sidebar open one. A saved breakout is
 * named as restored instead, so its thread returns to Main when the breakout
 * was merged or removed since; an expand request would expand the breakout.
 */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const { session } = useAppSession();
  const { active } = useSpaceDirectories();
  const { state, sidebarConnect } = useWorkspaceSocket();
  const pins = usePins();
  const routeState: unknown = useLocation().state;
  const skipped = skippedWorkstreamIds(routeState);
  const savedRoute = routeState == null && session?.workspace && session.user
    ? readLayout(layoutKey(session.workspace.id, session.user.id, 'last-route')) : null;
  const savedThreadId = /\/(?:threads|workstreams)\/([^/?]+)/.exec(savedRoute ?? '')?.[1] ?? null;
  if (savedRoute && /^\/(channels|workstreams)\//.test(savedRoute) && (savedThreadId === null || !skipped.has(savedThreadId))) {
    const savedBreakoutId = new URLSearchParams(savedRoute.split('?')[1] ?? '').get('substream');
    const expandsThread = savedThreadId !== null && savedRoute.startsWith('/channels/') && savedBreakoutId === null;
    const restoreState = savedBreakoutId !== null ? { restoredBreakout: savedBreakoutId }
      : expandsThread ? OPEN_EXPANDED : null;
    return <Navigate replace state={restoreState} to={savedRoute} />;
  }
  const channels = active.data?.items;
  if (!channels) {
    if (state === 'unavailable' || sidebarConnect?.spacesLive === false) {
      return <ErrorNotice>Unable to connect to your organization. Check your connection and restart Rally to try again.</ErrorNotice>;
    }
    return <LoadingState label="Opening channels…" />;
  }
  const pinned = pins.find((pin) => pin.kind === 'channel' && channels.some((channel) => channel.id === pin.id));
  const returnTo = landingSpaceId(routeState);
  const first = channels.find((channel) => channel.id === returnTo)?.id
    ?? pinned?.id
    ?? channels.find((channel) => channel.systemRole === 'general')?.id
    ?? [...channels].sort((left, right) => left.name.localeCompare(right.name))[0]?.id;
  if (first) return <Navigate replace to={channelRoute(first)} />;
  return <EmptyState description="Channels shared with you appear in the sidebar." title="No channels yet" />;
}
