import { ArtifactPinListSchema, ChannelStatsListSchema, SpaceConversationSchema, PinListSchema, ChannelRailSchema, PersonalOrderSchema, PinnedOrderSchema, SpaceDirectorySchema, WorkstreamPrivateChildSchema, type ChannelRail, type PersonalOrder, type PinnedOrder, type SpaceDirectory } from '@rally/contracts';
import { heldChannelRails, isChannelRailQueryKey, seedChannelRails } from './channel-rails';
import { heldChannelBreakouts, isWorkstreamChildrenQueryKey, seedChannelBreakouts, type ChannelBreakoutLists } from './channel-viewer-state';
import { z } from 'zod';
import { notifyManager, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { mirrorQueriesToLocalCache, queryKeyIsOneOf, type QueryMirror } from './local-cache-mirror';
import { ARTIFACT_PINS_QUERY_KEY, CHANNEL_STATS_QUERY_KEY, MY_THREADS_QUERY_KEY, PINS_QUERY_KEY, SIDEBAR_LIST_QUERY_KEYS, SPACES_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, PERSONAL_ORDER_QUERY_KEY, PINNED_ORDER_QUERY_KEY } from './sidebar-list-store';
import type { AutomationSummary, SpaceConversationSummary, WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAM_PAGE_SIZE, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

// These lists are restored together: painting rows without their pins makes
// the live snapshot look like a user moving every pin into place.
const CachedThreadSchema = z.custom<SpaceConversationSummary>((value: unknown) => {
  if (!isWorkstreamSummaryLike(value)) return false;
  const row = value as WorkstreamSummary & { kind?: unknown; breakoutOf?: unknown };
  if (row.kind === 'channel') return row.breakoutOf === null;
  if (row.kind !== 'breakout') return false;
  const parent = SpaceConversationSchema.shape.breakoutOf.safeParse(row.breakoutOf);
  return parent.success && parent.data !== null && parent.data.substreamId === row.id;
});
const CachedThreadsPageSchema = z.strictObject({
  items: z.array(CachedThreadSchema),
  pinned: z.array(CachedThreadSchema),
  nextCursor: z.string().min(1).nullable(),
});
const NavigationCacheSchema = z.strictObject({
  pins: PinListSchema.optional().catch(undefined),
  artifactPins: ArtifactPinListSchema.optional().catch(undefined),
  channelStats: ChannelStatsListSchema.optional().catch(undefined),
  threads: CachedThreadsPageSchema.optional().catch(undefined),
});
type CachedNavigation = z.infer<typeof NavigationCacheSchema>;

/**
 * What the sidebar and the Space dashboard paint from before the workspace
 * socket answers: the last first page of the Channel directory, the
 * automation list, and both Space directories. One row per
 * workspace scope, written from the query cache after every live payload and
 * read back only into caches that are still empty.
 *
 * `spacesReady` is deliberately not on the row. It is the Organization's
 * current cutover state, and a remembered `true` would paint a hierarchy that
 * a reconnect may immediately contradict; the surfaces read a missing answer as
 * ready, which is the same thing this row would have said and one fewer place
 * for it to go stale.
 */
export interface CachedWorkspaceDirectory {
  navigation?: CachedNavigation;
  workstreams: WorkstreamSummary[];
  automations: AutomationSummary[];
  spaces: SpaceDirectory | null;
  inactiveSpaces: SpaceDirectory | null;
  /**
   * The arrangement this person last committed for each list they ordered.
   *
   * On the row rather than derived so the Organization's manually arranged
   * Space rail can paint its committed order on a cold launch. Legacy Space-
   * and Channel-container arrangements remain in the same compatibility shape,
   * although alphabetical Channel and Breakout rails ignore them.
   *
   * Absent on a row written before this existed, which `parse` absorbs as an
   * empty ordering — one launch painted in the natural order, rather than
   * dropping every cached row to avoid it.
   */
  ordering: PersonalOrder;
  /** All's Pinned order, for the same cold-launch paint; absent on older rows reads as none. */
  pinnedOrder?: PinnedOrder;
  /**
   * Each listed Channel's breakouts for this viewer, as the workspace socket
   * last said them, so the Channel rail paints its breakouts on a cold launch
   * the way the sidebar paints its Channels.
   *
   * Absent on a row written before this existed, which `parse` reads as no
   * lists: those Channels wait for the socket, as they always did, for one
   * launch. A Channel whose list this build cannot read is left out alone.
   */
  breakouts: ChannelBreakoutLists;
  /** Each listed Channel's rail, read the same way as `breakouts`. */
  rails: Record<string, ChannelRail>;
}

export const DIRECTORY_CACHE_KEY = 'directory';

const HARNESS_STATUSES = new Set(['scheduled', 'running', 'needs_input', 'completed', 'failed', 'stopped']);
const SCOPES = new Set(['personal', 'workspace']);
const AUTOMATION_SCOPES = new Set(['you', 'workspace', 'workstream']);
const AUTOMATION_STATUSES = new Set(['active', 'paused', 'draft']);

function isWorkstreamSummaryLike(value: unknown): value is WorkstreamSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['id'] === 'string'
    && typeof candidate['title'] === 'string'
    && typeof candidate['titleStatus'] === 'string'
    && typeof candidate['harnessStatus'] === 'string'
    && HARNESS_STATUSES.has(candidate['harnessStatus'])
    && typeof candidate['scope'] === 'string'
    && SCOPES.has(candidate['scope'])
    && typeof candidate['lastActivityAt'] === 'string'
    && typeof candidate['latestAttentionSequenceNumber'] === 'number'
    && typeof candidate['readThroughSequenceNumber'] === 'number'
    && typeof candidate['manualUnreadGeneration'] === 'number'
    && typeof candidate['hasUnread'] === 'boolean'
    && Array.isArray(candidate['participantUserIds'])
    && Array.isArray(candidate['spaceIds'])
    && typeof candidate['participantExtraCount'] === 'number'
    && (candidate['pinPosition'] === null || typeof candidate['pinPosition'] === 'number')
    && (candidate['spacePins'] === undefined || Array.isArray(candidate['spacePins']));
}

function isAutomationSummaryLike(value: unknown): value is AutomationSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['id'] === 'string'
    && typeof candidate['name'] === 'string'
    && typeof candidate['description'] === 'string'
    && typeof candidate['scope'] === 'string'
    && AUTOMATION_SCOPES.has(candidate['scope'])
    && typeof candidate['status'] === 'string'
    && AUTOMATION_STATUSES.has(candidate['status'])
    && typeof candidate['updatedAt'] === 'string';
}

function parseList<T>(value: unknown, accept: (item: unknown) => item is T): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    // One row this build cannot read makes the whole list untrustworthy: a
    // partial sidebar would read as an emptier workspace, not a stale one.
    if (!accept(item)) return null;
    items.push(item);
  }
  return items;
}

function parseSpaces(value: unknown): SpaceDirectory | null | undefined {
  if (value === null || value === undefined) return null;
  const parsed = SpaceDirectorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A row written before the ordering existed is read as having none, which is
 * the whole reason the slice is not at version 4: absorbing the absence costs
 * one launch drawn in the natural order, and bumping would cost every person a
 * cold, empty sidebar to avoid it.
 */
function parseOrdering(value: unknown): PersonalOrder | undefined {
  if (value === undefined) return [];
  const parsed = PersonalOrderSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parsePinnedOrder(value: unknown): PinnedOrder {
  const parsed = PinnedOrderSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const BreakoutListSchema = WorkstreamPrivateChildSchema.array();

function parseBreakouts(value: unknown): ChannelBreakoutLists | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const lists: ChannelBreakoutLists = {};
  for (const [workstreamId, list] of Object.entries(value)) {
    const parsed = BreakoutListSchema.safeParse(list);
    if (parsed.success) lists[workstreamId] = parsed.data;
  }
  return lists;
}

function parseRails(value: unknown): Record<string, ChannelRail> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rails: Record<string, ChannelRail> = {};
  for (const [workstreamId, rail] of Object.entries(value)) {
    const parsed = ChannelRailSchema.safeParse(rail);
    if (parsed.success && parsed.data.workstreamId === workstreamId) rails[workstreamId] = parsed.data;
  }
  return rails;
}

function parseCachedDirectory(value: unknown): CachedWorkspaceDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const workstreams = parseList(candidate['workstreams'], isWorkstreamSummaryLike);
  const automations = parseList(candidate['automations'], isAutomationSummaryLike);
  const spaces = parseSpaces(candidate['spaces']);
  const inactiveSpaces = parseSpaces(candidate['inactiveSpaces']);
  const ordering = parseOrdering(candidate['ordering']);
  const breakouts = parseBreakouts(candidate['breakouts']);
  const rails = parseRails(candidate['rails']);
  if (!workstreams || !automations || spaces === undefined || inactiveSpaces === undefined) return null;
  if (ordering === undefined || breakouts === undefined || rails === undefined) return null;
  const pinnedOrder = parsePinnedOrder(candidate['pinnedOrder']);
  const navigation = NavigationCacheSchema.safeParse(candidate['navigation']);
  return { workstreams, automations, spaces, inactiveSpaces, ordering, pinnedOrder, breakouts, rails,
    navigation: navigation.success ? navigation.data : {},
  };
}

/**
 * Version 4 is a Space's reach.
 *
 * A version 3 row holds Space summaries written before `reach` existed, and it
 * is the one field on that shape `parse` cannot absorb: it says why *this
 * person* can see the Space, and a device holds nothing to derive it from. The
 * two absences it could be read as are both wrong where a reader can see it —
 * guessing a full relationship draws a plus, an **Add to space** entry and a
 * drop target on a Space every one of whose writes the server refuses, and
 * guessing the narrow one takes those controls off every Space on screen and
 * puts them back a moment later.
 *
 * That is the rule the slice is under, and it is the opposite answer to the
 * `ordering` key beside it, which `parse` reads as an empty arrangement
 * because an absence there costs one launch drawn in the natural order. The
 * cost here is one cold launch per device, once.
 */
export const workspaceDirectorySlice = defineLocalCacheSlice<CachedWorkspaceDirectory>({
  kind: 'directory',
  version: 4,
  parse: parseCachedDirectory,
});

/**
 * Put the cached directory into the query caches the sidebar, the landing, and
 * the Space dashboard read, if none of them has been written yet. The lists go
 * in directly rather than through the versioned receivers: a seed has no
 * waterline, and leaving the ledgers untouched is what lets the socket's first
 * payload apply over it whatever version it carries.
 */
export async function hydrateWorkspaceDirectory(
  queryClient: QueryClient,
  scope: string,
  stillWanted: () => boolean,
): Promise<boolean> {
  const epoch = localCacheEpoch();
  const cached = await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY);
  if (!cached || !stillWanted()) return false;
  // A wipe that began while the row was in flight is taking it off the disk;
  // a row on its way out is not a seed.
  if (localCacheEpoch() !== epoch) return false;
  // The socket replaces the directory as a unit, but does not supply the
  // REST-owned thread page. Seed missing navigation even if the socket won.
  const seedDirectory = queryClient.getQueryData(WORKSTREAMS_QUERY_KEY) === undefined;
  notifyManager.batch(() => {
    const navigation = cached.navigation;
    for (const [key, value] of [
      [PINS_QUERY_KEY, navigation?.pins],
      [ARTIFACT_PINS_QUERY_KEY, navigation?.artifactPins],
      [CHANNEL_STATS_QUERY_KEY, navigation?.channelStats],
      [MY_THREADS_QUERY_KEY, navigation?.threads ? { pages: [navigation.threads], pageParams: [null] } : undefined],
    ] as const) {
      if (value !== undefined && queryClient.getQueryData(key) === undefined) {
        queryClient.setQueryData(key, value);
        // Stats can paint immediately, but a Channel must refresh the seed
        // before fixing its opening unread position (readers use Infinity).
        if (key === CHANNEL_STATS_QUERY_KEY) {
          void queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
        }
      }
    }
    if (!seedDirectory) return;
    setCachedWorkstreams(queryClient, cached.workstreams);
    if (queryClient.getQueryData(SIDEBAR_LIST_QUERY_KEYS.automations) === undefined) {
      queryClient.setQueryData(SIDEBAR_LIST_QUERY_KEYS.automations, cached.automations);
    }
    if (cached.spaces && queryClient.getQueryData(SPACES_QUERY_KEY) === undefined) {
      queryClient.setQueryData(SPACES_QUERY_KEY, cached.spaces);
    }
    if (cached.inactiveSpaces && queryClient.getQueryData(INACTIVE_SPACES_QUERY_KEY) === undefined) {
      queryClient.setQueryData(INACTIVE_SPACES_QUERY_KEY, cached.inactiveSpaces);
    }
    if (queryClient.getQueryData(PERSONAL_ORDER_QUERY_KEY) === undefined) {
      queryClient.setQueryData(PERSONAL_ORDER_QUERY_KEY, cached.ordering);
    }
    if (queryClient.getQueryData(PINNED_ORDER_QUERY_KEY) === undefined) {
      queryClient.setQueryData(PINNED_ORDER_QUERY_KEY, cached.pinnedOrder ?? []);
    }
    seedChannelBreakouts(queryClient, cached.breakouts);
    seedChannelRails(queryClient, cached.rails);
  });
  return seedDirectory;
}

const directoryKey = queryKeyIsOneOf([
  PINS_QUERY_KEY,
  ARTIFACT_PINS_QUERY_KEY,
  CHANNEL_STATS_QUERY_KEY,
  MY_THREADS_QUERY_KEY,
  WORKSTREAMS_QUERY_KEY,
  SIDEBAR_LIST_QUERY_KEYS.automations,
  SPACES_QUERY_KEY,
  INACTIVE_SPACES_QUERY_KEY,
  PERSONAL_ORDER_QUERY_KEY,
  PINNED_ORDER_QUERY_KEY,
]);

/**
 * Keep the workspace's directory row equal to the lists in the query cache,
 * once the socket has delivered them. `live` is the caller's word that the
 * lists are the socket's rather than a seed; until it says so, changes are
 * observed and nothing is written.
 */
export function mirrorWorkspaceDirectory(
  queryClient: QueryClient,
  scope: string,
  options: { live: () => boolean },
): QueryMirror {
  return mirrorQueriesToLocalCache<CachedWorkspaceDirectory>(queryClient, {
    matches: (queryKey) => directoryKey(queryKey) || isWorkstreamChildrenQueryKey(queryKey) || isChannelRailQueryKey(queryKey),
    snapshot: () => {
      if (!options.live()) return null;
      const workstreams = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY);
      if (!workstreams) return null;
      // The flat list grows with every page the sidebar loads; the row keeps
      // what a fresh subscribe answer would carry, so the next launch paints
      // page one and the live answer replaces it without a visible collapse.
      // A pending row is a create in flight in this window only; restored on
      // the next launch it would be a Channel nothing ever created.
      const kept = workstreams.filter((row) => !row.pending).slice(0, WORKSTREAM_PAGE_SIZE);
      return {
        navigation: {
          pins: queryClient.getQueryData(PINS_QUERY_KEY),
          artifactPins: queryClient.getQueryData(ARTIFACT_PINS_QUERY_KEY),
          channelStats: queryClient.getQueryData(CHANNEL_STATS_QUERY_KEY),
          threads: queryClient.getQueryData<InfiniteData<NonNullable<CachedNavigation['threads']>>>(MY_THREADS_QUERY_KEY)?.pages[0],
        },
        workstreams: kept,
        breakouts: heldChannelBreakouts(queryClient, kept.map((row) => row.id)),
        rails: heldChannelRails(queryClient, kept.map((row) => row.id)),
        automations: queryClient.getQueryData<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations) ?? [],
        spaces: queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY) ?? null,
        inactiveSpaces: queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY) ?? null,
        ordering: queryClient.getQueryData<PersonalOrder>(PERSONAL_ORDER_QUERY_KEY) ?? [],
        pinnedOrder: queryClient.getQueryData<PinnedOrder>(PINNED_ORDER_QUERY_KEY) ?? [],
      };
    },
    write: (value, atEpoch) => workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, value, DIRECTORY_CACHE_KEY, atEpoch),
  });
}
