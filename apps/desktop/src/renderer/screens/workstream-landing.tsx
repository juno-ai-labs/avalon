import type { PinList } from '@rally/contracts';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';

import { EmptyState, InlineError, LoadingState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { channelRoute } from '../lib/navigation-routes';
import { PINS_QUERY_KEY } from '../lib/sidebar-list-store';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { landingSpaceId, skippedWorkstreamIds } from '../lib/workstream-landing';

/**
 * The root route: where Rally opens. The route this person last had open on
 * this device, else the Channel a screen just left asked to return to, else
 * their first pinned Channel, else General, else the first
 * Channel A–Z. A thread a screen just left (archived, made unread) is never
 * reopened from the saved route.
 */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const { session } = useAppSession();
  const { active } = useSpaceDirectories();
  const { state, sidebarConnect } = useWorkspaceSocket();
  const pins = useQuery<PinList>({ queryKey: PINS_QUERY_KEY, queryFn: async () => [], enabled: false });
  const routeState: unknown = useLocation().state;
  const skipped = skippedWorkstreamIds(routeState);
  const savedRoute = routeState == null && session?.workspace && session.user
    ? readLayout(layoutKey(session.workspace.id, session.user.id, 'last-route')) : null;
  const savedThreadId = /\/(?:threads|workstreams)\/([^/?]+)/.exec(savedRoute ?? '')?.[1] ?? null;
  if (savedRoute && /^\/(channels|workstreams)\//.test(savedRoute) && (savedThreadId === null || !skipped.has(savedThreadId))) {
    return <Navigate replace to={savedRoute} />;
  }
  const channels = active.data?.items;
  if (!channels) {
    if (state === 'unavailable' || sidebarConnect?.spacesLive === false) {
      return <InlineError>Unable to connect to your organization. Check your connection and restart Rally to try again.</InlineError>;
    }
    return <LoadingState label="Opening channels…" />;
  }
  const pinned = (pins.data ?? []).find((pin) => pin.kind === 'channel' && channels.some((channel) => channel.id === pin.id));
  const returnTo = landingSpaceId(routeState);
  const first = channels.find((channel) => channel.id === returnTo)?.id
    ?? pinned?.id
    ?? channels.find((channel) => channel.systemRole === 'general')?.id
    ?? [...channels].sort((left, right) => left.name.localeCompare(right.name))[0]?.id;
  if (first) return <Navigate replace to={channelRoute(first)} />;
  return <EmptyState description="Channels shared with you appear in the sidebar." title="No channels yet" />;
}
