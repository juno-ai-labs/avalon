import { CanvasSidebarRowSchema, type CanvasSidebarRow } from '@rally/contracts';
import { notifyManager, type QueryClient } from '@tanstack/react-query';

import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { mirrorQueriesToLocalCache, queryKeyIsOneOf, type QueryMirror } from './local-cache-mirror';
import { SIDEBAR_LIST_QUERY_KEYS, sidebarListApplied } from './sidebar-list-store';
import type { AutomationSummary } from './types';

/**
 * What the Canvases and Sidekicks lists paint from before the workspace socket
 * answers: the two lists as the socket last said them, one row per workspace
 * scope. A list is on the row only once the socket has applied it in the
 * session that wrote it, so an absent list is "never heard", which seeds
 * nothing, rather than an empty one, which would paint "no Canvases".
 */
export interface CachedCanvasDirectory {
  canvases?: CanvasSidebarRow[];
  sidekicks?: AutomationSummary[];
}

export const CANVAS_DIRECTORY_CACHE_KEY = 'canvas-directory';

const AUTOMATION_SCOPES = new Set(['you', 'workspace']);
const AUTOMATION_STATUSES = new Set(['active', 'paused', 'draft']);

/** The fields a Sidekick row needs to paint; a newer build's extra fields pass through. */
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

function parseRows<T>(value: unknown, accept: (item: unknown) => item is T): T[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  // One row this build cannot read drops the list: a partial list reads as
  // fewer Canvases, not stale ones.
  return value.every(accept) ? value : null;
}

const isCanvasRow = (item: unknown): item is CanvasSidebarRow => CanvasSidebarRowSchema.safeParse(item).success;

function parseCachedCanvasDirectory(value: unknown): CachedCanvasDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const canvases = parseRows(candidate['canvases'], isCanvasRow);
  const sidekicks = parseRows(candidate['sidekicks'], isAutomationSummaryLike);
  if (canvases === null || sidekicks === null) return null;
  return { ...(canvases ? { canvases } : {}), ...(sidekicks ? { sidekicks } : {}) };
}

export const canvasDirectorySlice = defineLocalCacheSlice<CachedCanvasDirectory>({
  kind: 'canvas-directory',
  version: 1,
  parse: parseCachedCanvasDirectory,
});

/**
 * Seed each list into its cache entry if nothing has written it yet. The seed
 * leaves the waterline ledger alone, so the socket's first list applies over it
 * whatever version it carries.
 */
export async function hydrateCanvasDirectory(
  queryClient: QueryClient,
  scope: string,
  stillWanted: () => boolean,
): Promise<void> {
  const epoch = localCacheEpoch();
  const cached = await canvasDirectorySlice.read(scope, CANVAS_DIRECTORY_CACHE_KEY);
  if (!cached || !stillWanted() || localCacheEpoch() !== epoch) return;
  notifyManager.batch(() => {
    if (cached.canvases && queryClient.getQueryData(SIDEBAR_LIST_QUERY_KEYS.canvases) === undefined) {
      queryClient.setQueryData(SIDEBAR_LIST_QUERY_KEYS.canvases, cached.canvases);
    }
    if (cached.sidekicks && queryClient.getQueryData(SIDEBAR_LIST_QUERY_KEYS.automations) === undefined) {
      queryClient.setQueryData(SIDEBAR_LIST_QUERY_KEYS.automations, cached.sidekicks);
    }
  });
}

const directoryKey = queryKeyIsOneOf([SIDEBAR_LIST_QUERY_KEYS.canvases, SIDEBAR_LIST_QUERY_KEYS.automations]);

/** Keep the row equal to whichever of the two lists the socket has applied. */
export function mirrorCanvasDirectory(queryClient: QueryClient, scope: string): QueryMirror {
  return mirrorQueriesToLocalCache<CachedCanvasDirectory>(queryClient, {
    matches: directoryKey,
    snapshot: () => {
      const canvases = sidebarListApplied(queryClient, 'canvases')
        ? queryClient.getQueryData<CanvasSidebarRow[]>(SIDEBAR_LIST_QUERY_KEYS.canvases) : undefined;
      const sidekicks = sidebarListApplied(queryClient, 'automations')
        ? queryClient.getQueryData<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations) : undefined;
      if (!canvases && !sidekicks) return null;
      return { ...(canvases ? { canvases } : {}), ...(sidekicks ? { sidekicks } : {}) };
    },
    write: (value, atEpoch) => canvasDirectorySlice.write(scope, CANVAS_DIRECTORY_CACHE_KEY, value, CANVAS_DIRECTORY_CACHE_KEY, atEpoch),
  });
}
