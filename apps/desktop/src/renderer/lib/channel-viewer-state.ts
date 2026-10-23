import type {
  Workstream,
  WorkstreamAppearance,
  WorkstreamAppearancePatch,
  WorkstreamStateVersion,
} from '@rally/contracts';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { noteRailWaterline } from './channel-rails';
import { retainConversationChildren } from './conversation-cache';
import type { SpaceConversationSummary, WorkstreamDetail } from './types';
import { workstreamDetailQueryKey } from './workstreams-cache';
import { MY_THREADS_QUERY_KEY, type ThreadNavigationPage } from './sidebar-list-store';

/**
 * A Channel's per-viewer state beyond its directory row: the breakouts this
 * person may open and the background agents running for them.
 *
 * Both arrive on the Organization socket's Channel rows (the connect sidebar,
 * a page, a recency move, and every `workspace_workstream_state` push). They
 * used to arrive on one Channel control socket per held Channel; the row now
 * carries them, so there is one socket and one place they are written.
 * `docs/realtime-sockets.md` owns the protocol.
 */
export const workstreamChildrenQueryKey = (workstreamId: string) => ['workstream-children', workstreamId] as const;
export const isWorkstreamChildrenQueryKey = (queryKey: readonly unknown[]): boolean =>
  queryKey[0] === workstreamChildrenQueryKey('')[0];
export const workstreamBackgroundAgentsQueryKey = (workstreamId: string) =>
  ['workstream-background-agents', workstreamId] as const;

interface BreakoutAppearanceOverlay {
  baseline: WorkstreamAppearance | undefined;
  expected: WorkstreamAppearance;
}

export type WorkstreamChildDirectory = Pick<Workstream, 'privateChildren' | 'privateChildrenWaterline'> & {
  /** Absent on a list seeded from the device; see `seedChannelBreakouts`. */
  stateVersion?: WorkstreamStateVersion;
  /** Receipt-backed rows waiting for the parent's authoritative projection. */
  appearanceOverlays?: Record<string, BreakoutAppearanceOverlay>;
};

/** Apply accepted live breakout rosters to navigation rows, including a REST page already in flight. */
export function reconcileThreadNavigationRows(queryClient: QueryClient, rows: SpaceConversationSummary[]): SpaceConversationSummary[] {
  return rows.flatMap((row) => {
    const parent = row.breakoutOf;
    if (!parent) return [row];
    const directory = queryClient.getQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(parent.workstreamId));
    // Device seeds are not authoritative enough to remove a REST row.
    if (!directory?.stateVersion || !directory.privateChildren) return [row];
    const child = directory.privateChildren.find((candidate) => candidate.substreamId === parent.substreamId);
    if (!child) return [];
    return [child.resolved && !row.resolved ? { ...row, resolved: true } : row];
  });
}

export interface BreakoutAppearanceUpdate {
  baseline: WorkstreamAppearance | undefined;
  expected: WorkstreamAppearance;
}

function sameAppearance(left: WorkstreamAppearance | undefined, right: WorkstreamAppearance | undefined): boolean {
  return left?.icon === right?.icon && left?.color === right?.color
    && (left !== undefined) === (right !== undefined);
}

/**
 * Bind a partial choice to the exact parent row it was made against. The child
 * detail supplies fields an older directory row has not projected yet.
 */
export function captureBreakoutAppearanceUpdate(
  queryClient: QueryClient,
  parentId: string,
  substreamId: string,
  patch: WorkstreamAppearancePatch,
): BreakoutAppearanceUpdate {
  const directory = queryClient.getQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(parentId));
  const baseline = directory?.privateChildren?.find((child) => child.substreamId === substreamId)?.appearance;
  const detail = queryClient.getQueryData<WorkstreamDetail>(workstreamDetailQueryKey(parentId, substreamId));
  const effective = baseline ?? detail?.appearance ?? { icon: null, color: null };
  return {
    baseline,
    expected: {
      icon: 'icon' in patch ? patch.icon ?? null : effective.icon,
      color: 'color' in patch ? patch.color ?? null : effective.color,
    },
  };
}

/** Apply a child receipt only while its exact starting row is still current. */
export function applyBreakoutAppearanceReceipt(
  queryClient: QueryClient,
  parentId: string,
  substreamId: string,
  update: BreakoutAppearanceUpdate,
): void {
  queryClient.setQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(parentId), (current) => {
    if (!current?.privateChildren) return current;
    const child = current.privateChildren.find((candidate) => candidate.substreamId === substreamId);
    if (!child || !sameAppearance(child.appearance, update.baseline)) return current;
    return {
      ...current,
      privateChildren: current.privateChildren.map((candidate) => candidate.substreamId === substreamId
        ? { ...candidate, appearance: update.expected }
        : candidate),
      appearanceOverlays: {
        ...current.appearanceOverlays,
        [substreamId]: update,
      },
    };
  });
}

function reconcileBreakoutAppearanceOverlays(
  current: WorkstreamChildDirectory | undefined,
  incoming: WorkstreamChildDirectory,
): WorkstreamChildDirectory {
  if (!current?.appearanceOverlays || !incoming.privateChildren) return incoming;
  const overlays = { ...current.appearanceOverlays };
  const incomingIds = new Set<string>(incoming.privateChildren.map((child) => child.substreamId));
  for (const substreamId of Object.keys(overlays)) {
    if (!incomingIds.has(substreamId)) delete overlays[substreamId];
  }
  const privateChildren = incoming.privateChildren.map((child) => {
    const overlay = overlays[child.substreamId];
    if (!overlay) return child;
    if (sameAppearance(child.appearance, overlay.expected)) {
      delete overlays[child.substreamId];
      return child;
    }
    if (sameAppearance(child.appearance, overlay.baseline)) {
      return { ...child, appearance: overlay.expected };
    }
    delete overlays[child.substreamId];
    return child;
  });
  return {
    ...incoming,
    privateChildren,
    ...(Object.keys(overlays).length > 0 ? { appearanceOverlays: overlays } : {}),
  };
}

function roster(directory: WorkstreamChildDirectory | undefined): string | null {
  return directory?.privateChildren
    ? directory.privateChildren.map((child) => child.substreamId).sort().join(',')
    : null;
}

/** A Channel's breakout list as the device keeps it, by Channel id. */
export type ChannelBreakoutLists = Record<string, NonNullable<Workstream['privateChildren']>>;

/**
 * The breakout lists held for these Channels, for the directory row on disk.
 * Only what a live row said: a Channel whose list is still a seed has one only
 * because a live row once said it, and a Channel with no list is left out.
 */
export function heldChannelBreakouts(queryClient: QueryClient, workstreamIds: readonly string[]): ChannelBreakoutLists {
  const lists: ChannelBreakoutLists = {};
  for (const workstreamId of workstreamIds) {
    const held = queryClient.getQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(workstreamId));
    if (held?.privateChildren) lists[workstreamId] = held.privateChildren;
  }
  return lists;
}

/**
 * Put breakout lists restored from the device into Channels that hold none.
 * No version and no waterline go with them, so the first live row for each
 * Channel replaces its list whatever it says, and nothing is pruned: a seed
 * says nothing about what may be removed from the disk.
 */
export function seedChannelBreakouts(queryClient: QueryClient, lists: ChannelBreakoutLists): void {
  for (const [workstreamId, privateChildren] of Object.entries(lists)) {
    const key = workstreamChildrenQueryKey(workstreamId);
    if (queryClient.getQueryData(key) !== undefined) continue;
    queryClient.setQueryData<WorkstreamChildDirectory>(key, { privateChildren });
  }
}

/**
 * Write one Channel row's per-viewer state. A row that does not carry a field
 * leaves what is held alone: absence means "not said", never "none".
 */
export function applyChannelViewerState(
  queryClient: QueryClient,
  row: Pick<Workstream, 'id' | 'privateChildren' | 'privateChildrenWaterline' | 'backgroundAgentCounts' | 'railWaterline'>,
  stateVersion: WorkstreamStateVersion,
  localCacheScope: string | null,
): void {
  if (row.railWaterline !== undefined) noteRailWaterline(queryClient, row.id, row.railWaterline);
  if (row.privateChildren === undefined && row.backgroundAgentCounts === undefined) return;
  if (row.backgroundAgentCounts !== undefined) {
    queryClient.setQueryData(workstreamBackgroundAgentsQueryKey(row.id), row.backgroundAgentCounts);
  }
  if (row.privateChildren === undefined) return;
  const key = workstreamChildrenQueryKey(row.id);
  const previous = queryClient.getQueryData<WorkstreamChildDirectory>(key);
  const before = roster(previous);
  queryClient.setQueryData<WorkstreamChildDirectory>(key, (current) => {
    const stored = current?.stateVersion;
    if (stored && (stateVersion.authorityGeneration < stored.authorityGeneration
      || (stateVersion.authorityGeneration === stored.authorityGeneration
        && (row.privateChildrenWaterline ?? stateVersion.viewerWaterline)
          < (current.privateChildrenWaterline ?? stored.viewerWaterline)))) return current;
    return reconcileBreakoutAppearanceOverlays(current, {
      privateChildren: row.privateChildren,
      privateChildrenWaterline: row.privateChildrenWaterline,
      stateVersion,
    });
  });
  // Prune from the roster the guard above accepted, which may be the one
  // already held rather than this row's: a stale row that lists fewer
  // children must not take a still-authorized child off the disk.
  const after = roster(queryClient.getQueryData<WorkstreamChildDirectory>(key));
  if (queryClient.getQueryData<WorkstreamChildDirectory>(key) !== previous) {
    queryClient.setQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY, (current) => current ? {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: reconcileThreadNavigationRows(queryClient, page.items),
        pinned: page.pinned ? reconcileThreadNavigationRows(queryClient, page.pinned) : undefined,
      })),
    } : current);
  }
  if (localCacheScope !== null && after !== null && after !== before) {
    void retainConversationChildren(localCacheScope, row.id, new Set(after ? after.split(',') : []));
  }
}
