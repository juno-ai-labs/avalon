import { useEffect, useMemo } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { EmptyState, InlineError, LoadingState } from '../components/primitives';
import { channelDestination, emptySpaceRoute, firstLandingWorkstream, landingSpaceId, skippedWorkstreamIds } from '../lib/workstream-landing';
import { associativeWorkstreamsForSidebar, useConversationDirectory } from '../lib/conversation-directory';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { firstSidebarChannelInSpace } from '../lib/sidebar-channel-order';
import { useUiStore } from '../lib/ui-store';

/** Resolve only the default route; live list updates never replace an open conversation. */
export function WorkstreamLandingScreen(): React.JSX.Element {
  const workstreams = useWorkstreamsQuery();
  const spaceDirectories = useSpaceDirectories();
  const spaces = spaceDirectories.active.data;
  const inactiveSpaces = spaceDirectories.inactive.data;
  const { session } = useAppSession();
  const { guest } = useShellCapabilities();
  const channelSort = useUiStore((ui) => ui.sidebarChannelSort);
  const { state, sidebarConnect, loadedSpaceIds } = useWorkspaceSocket();
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
  // The sidebar's own rows: a Channel whose Main is not this reader's opens on
  // the Breakout the conversation directory lists, never on a Main that would
  // refuse them. The directory is the shell's cache, read without a fetch.
  const directory = useConversationDirectory();
  const loaded = useMemo(
    () => workstreams.data && associativeWorkstreamsForSidebar(directory, workstreams.data),
    [directory, workstreams.data],
  );
  // A screen that left a Channel in a Space names that Space, and the landing
  // stays in it, on the row the sidebar draws first there. A Space no longer
  // listed, archived or never seen, lands across the Organization as a bare
  // leave does.
  const stayInSpaceId = useMemo(() => landingSpaceId(routeState), [routeState]);
  const stayInSpace = stayInSpaceId === null ? undefined : spaces?.items.find((row) => row.id === stayInSpaceId);
  const candidates = useMemo(
    () => loaded?.filter((workstream) => !skipped.has(workstream.id)
      && (stayInSpace === undefined || workstream.spaceIds.includes(stayInSpace.id))) ?? [],
    [loaded, skipped, stayInSpace],
  );
  let savedSpaceId: string | null = null;
  try { if (savedSpace) savedSpaceId = decodeURIComponent(savedSpace[1]!); }
  catch { /* Ignore malformed local state. */ }
  const awaitingSpace = (savedSpaceId ?? stayInSpaceId) !== null && !spaces && state !== 'unavailable'
    && sidebarConnect?.spacesLive !== false;
  // A batch can take a whole loaded page — the day's work streams, say — while
  // older ones sit beyond the cursor. No candidate on the pages held is then
  // not an empty workspace; ask for the next page before deciding it is.
  // Keyed on the list rather than on the fetch settling, so a page that fails
  // is not asked for again in a loop: the next request waits for the list to
  // change, which the socket does once the archive's tombstones land.
  // `fetchMore` is deliberately not a dependency: it is re-created as a page
  // settles, and re-requesting on that would be the loop.
  //
  // A landing in a Space waits for that Space's whole list, as the sidebar
  // does: its first pin or first row under an A–Z sort may sit on a later page
  // than a Channel that happens to match.
  const spaceRowsLoaded = stayInSpace === undefined || loaded === undefined ? 0
    : loaded.filter((workstream) => workstream.spaceIds.includes(stayInSpace.id)).length;
  const spaceIncomplete = stayInSpace !== undefined && (sidebarConnect?.channelsBySpace === true
    ? !loadedSpaceIds.has(stayInSpace.id) && !workstreams.isError
    : workstreams.hasMore && spaceRowsLoaded < stayInSpace.channelCount);
  const needsMore = loaded !== undefined && workstreams.hasMore
    && ((sidebarConnect?.channelsBySpace !== true && spaceIncomplete)
      || (savedChannelId !== null
        ? !candidates.some((row) => row.id === savedChannelId)
        : candidates.length === 0 && !awaitingSpace
          && !spaces?.items.some((row) => row.id === savedSpaceId)));
  // Loading a Space at a time, the same wait is for the Spaces not yet in,
  // archived ones included, unless the walk has failed.
  const awaitingSpaces = loaded !== undefined && sidebarConnect?.channelsBySpace === true && !workstreams.isError
    && [...(spaces?.items ?? []), ...(inactiveSpaces?.items ?? [])].some((space) => !loadedSpaceIds.has(space.id))
    && (savedChannelId !== null
      ? !candidates.some((row) => row.id === savedChannelId)
      : candidates.length === 0);
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
  if (needsMore || awaitingSpaces || (loaded !== undefined && spaceIncomplete)) return <LoadingState label="Opening channels…" />;
  if (stayInSpaceId !== null && awaitingSpace) return <LoadingState label="Opening spaces…" />;
  const first = stayInSpace
    ? firstSidebarChannelInSpace(candidates, stayInSpace.id, channelSort)
    : firstLandingWorkstream(candidates);
  // Only a bare startup landing resumes the device's last view. A deliberate
  // leave carries state (including an empty skip list) and uses recency instead.
  if (savedRoute) {
    if (savedChannelId !== null && candidates.some((row) => row.id === savedChannelId)) {
      return <Navigate replace state={savedBreakout ? { restoredBreakout: savedBreakout } : undefined}
        to={`/workstreams/${encodeURIComponent(savedChannelId)}${savedBreakout ? `?substream=${encodeURIComponent(savedBreakout)}` : ''}`} />;
    }
    if (savedSpaceId !== null) {
      if (awaitingSpace) return <LoadingState label="Opening spaces…" />;
      const savedSpace = spaces?.items.find((row) => row.id === savedSpaceId);
      // A Space that has emptied since it was saved opens on starting a Channel,
      // as every empty Space does.
      if (savedSpace) return <Navigate replace to={savedSpace.channelCount === 0
        ? emptySpaceRoute(savedSpace.id, !guest)
        : `/spaces/${encodeURIComponent(savedSpace.id)}`} />;
    }
  }
  if (first) return <Navigate replace to={channelDestination(first)} />;
  if (stayInSpace) return <Navigate replace to={emptySpaceRoute(stayInSpace.id, !guest)} />;
  // No Channel to open. Every Channel is started from a Space, so an empty
  // Organization lands on starting one in General. A guest is not listed
  // General, and is told their shared Channels appear in the sidebar.
  const general = spaces?.items.find((row) => row.systemRole === 'general');
  if (general) return <Navigate replace to={emptySpaceRoute(general.id)} />;
  if (!spaces && state !== 'unavailable'
    && sidebarConnect?.spacesLive !== false) return <LoadingState label="Opening spaces…" />;
  return <EmptyState title="No channels yet" description="Channels shared with you appear in the sidebar." />;
}
