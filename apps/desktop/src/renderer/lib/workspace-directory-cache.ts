import { NoteSummarySchema, ProjectDirectorySchema, type ProjectDirectory } from '@rally/contracts';
import { notifyManager, type QueryClient } from '@tanstack/react-query';
import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { mirrorQueriesToLocalCache, queryKeyIsOneOf, type QueryMirror } from './local-cache-mirror';
import { SIDEBAR_LIST_QUERY_KEYS, PROJECTS_QUERY_KEY, INACTIVE_PROJECTS_QUERY_KEY } from './sidebar-list-store';
import type { AutomationSummary, NoteSummary, WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAM_PAGE_SIZE, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

/**
 * What the sidebar and the project space paint from before the workspace
 * socket answers: the last first page of the work-stream directory, the
 * automation and note lists, and both project directories. One row per
 * workspace scope, written from the query cache after every live payload and
 * read back only into caches that are still empty.
 */
export interface CachedWorkspaceDirectory {
  workstreams: WorkstreamSummary[];
  automations: AutomationSummary[];
  notes: NoteSummary[];
  projects: ProjectDirectory | null;
  inactiveProjects: ProjectDirectory | null;
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

function parseProjects(value: unknown): ProjectDirectory | null | undefined {
  if (value === null || value === undefined) return null;
  const parsed = ProjectDirectorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseCachedDirectory(value: unknown): CachedWorkspaceDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const workstreams = parseList(candidate['workstreams'], isWorkstreamSummaryLike);
  const automations = parseList(candidate['automations'], isAutomationSummaryLike);
  const notes = parseList(candidate['notes'], (item): item is NoteSummary => NoteSummarySchema.safeParse(item).success);
  const projects = parseProjects(candidate['projects']);
  const inactiveProjects = parseProjects(candidate['inactiveProjects']);
  if (!workstreams || !automations || !notes || projects === undefined || inactiveProjects === undefined) return null;
  return { workstreams, automations, notes, projects, inactiveProjects };
}

export const workspaceDirectorySlice = defineLocalCacheSlice<CachedWorkspaceDirectory>({
  kind: 'directory',
  version: 1,
  parse: parseCachedDirectory,
});

/**
 * Put the cached directory into the query caches the sidebar, the landing, and
 * the project space read, if none of them has been written yet. The lists go
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
    if (queryClient.getQueryData(SIDEBAR_LIST_QUERY_KEYS.notes) === undefined) {
      queryClient.setQueryData(SIDEBAR_LIST_QUERY_KEYS.notes, cached.notes);
    }
    if (cached.projects && queryClient.getQueryData(PROJECTS_QUERY_KEY) === undefined) {
      queryClient.setQueryData(PROJECTS_QUERY_KEY, cached.projects);
    }
    if (cached.inactiveProjects && queryClient.getQueryData(INACTIVE_PROJECTS_QUERY_KEY) === undefined) {
      queryClient.setQueryData(INACTIVE_PROJECTS_QUERY_KEY, cached.inactiveProjects);
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
      SIDEBAR_LIST_QUERY_KEYS.notes,
      PROJECTS_QUERY_KEY,
      INACTIVE_PROJECTS_QUERY_KEY,
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
        notes: queryClient.getQueryData<NoteSummary[]>(SIDEBAR_LIST_QUERY_KEYS.notes) ?? [],
        projects: queryClient.getQueryData<ProjectDirectory>(PROJECTS_QUERY_KEY) ?? null,
        inactiveProjects: queryClient.getQueryData<ProjectDirectory>(INACTIVE_PROJECTS_QUERY_KEY) ?? null,
      };
    },
    write: (value, atEpoch) => workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, value, DIRECTORY_CACHE_KEY, atEpoch),
  });
}
