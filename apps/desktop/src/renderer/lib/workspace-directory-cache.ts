import { PersonalOrderSchema, SpaceDirectorySchema, type PersonalOrder, type SpaceDirectory } from '@rally/contracts';
import { notifyManager, type QueryClient } from '@tanstack/react-query';
import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { mirrorQueriesToLocalCache, queryKeyIsOneOf, type QueryMirror } from './local-cache-mirror';
import { SIDEBAR_LIST_QUERY_KEYS, SPACES_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, PERSONAL_ORDER_QUERY_KEY } from './sidebar-list-store';
import type { AutomationSummary, WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAM_PAGE_SIZE, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

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
  workstreams: WorkstreamSummary[];
  automations: AutomationSummary[];
  spaces: SpaceDirectory | null;
  inactiveSpaces: SpaceDirectory | null;
  /**
   * The arrangement this person last committed for each list they ordered.
   *
   * On the row rather than derived, because without it a cold launch paints
   * every Space's Channels and every Channel's Breakouts in the order the
   * directory happens to hold them and then reshuffles them a moment later,
   * under somebody whose whole reason for dragging them was that the order
   * mattered.
   *
   * Absent on a row written before this existed, which `parse` absorbs as an
   * empty ordering — one launch painted in the natural order, rather than
   * dropping every cached row to avoid it.
   */
  ordering: PersonalOrder;
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
    && (candidate['pinPosition'] === null || typeof candidate['pinPosition'] === 'number');
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

function parseCachedDirectory(value: unknown): CachedWorkspaceDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const workstreams = parseList(candidate['workstreams'], isWorkstreamSummaryLike);
  const automations = parseList(candidate['automations'], isAutomationSummaryLike);
  const spaces = parseSpaces(candidate['spaces']);
  const inactiveSpaces = parseSpaces(candidate['inactiveSpaces']);
  const ordering = parseOrdering(candidate['ordering']);
  if (!workstreams || !automations || spaces === undefined || inactiveSpaces === undefined) return null;
  if (ordering === undefined) return null;
  return { workstreams, automations, spaces, inactiveSpaces, ordering };
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
  // The directory is seeded as a unit or not at all. The first live payload
  // writes every list at once, so one of them being present means all of them
  // are newer than this row.
  if (queryClient.getQueryData(WORKSTREAMS_QUERY_KEY) !== undefined) return false;
  notifyManager.batch(() => {
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
  });
  return true;
}

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
    matches: queryKeyIsOneOf([
      WORKSTREAMS_QUERY_KEY,
      SIDEBAR_LIST_QUERY_KEYS.automations,
      SPACES_QUERY_KEY,
      INACTIVE_SPACES_QUERY_KEY,
      PERSONAL_ORDER_QUERY_KEY,
    ]),
    snapshot: () => {
      if (!options.live()) return null;
      const workstreams = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY);
      if (!workstreams) return null;
      return {
        // The flat list grows with every page the sidebar loads; the row keeps
        // what a fresh subscribe answer would carry, so the next launch paints
        // page one and the live answer replaces it without a visible collapse.
        workstreams: workstreams.slice(0, WORKSTREAM_PAGE_SIZE),
        automations: queryClient.getQueryData<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations) ?? [],
        spaces: queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY) ?? null,
        inactiveSpaces: queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY) ?? null,
        ordering: queryClient.getQueryData<PersonalOrder>(PERSONAL_ORDER_QUERY_KEY) ?? [],
      };
    },
    write: (value, atEpoch) => workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, value, DIRECTORY_CACHE_KEY, atEpoch),
  });
}
