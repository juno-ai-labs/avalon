import type { ResourceHead } from '@rally/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchThroughOwner } from './fetch-through-owner';
import type { WorkstreamDetail, WorkstreamResource } from './types';

/**
 * The newest head this window knows for each resource, by id, from whichever
 * source told it: the workspace socket's `workspace_resource_versions`, or a
 * conversation's own snapshot or resource event.
 *
 * Two things read it. {@link followResourceHeads} keeps every conversation
 * detail at least this new, whoever writes the detail and in whatever order.
 * The app shell refreshes popped-out windows from it, so it is the one place
 * a window learns of a version, whether or not its conversation is on screen.
 */
export const RESOURCE_HEADS_QUERY_KEY = ['resource-heads'] as const;

type ResourceHeads = Readonly<Record<string, ResourceHead>>;

/** What a cached conversation detail holds that a head can move. */
type ResourceHolder = Pick<WorkstreamDetail, 'resources'>;

/** Move a resource held in memory to a newer head, keeping how its conversation links it. */
export function withResourceHead(resource: WorkstreamResource, head: ResourceHead): WorkstreamResource {
  if (resource.id !== head.resourceId || resource.currentVersion >= head.version) return resource;
  const next: WorkstreamResource = {
    ...resource,
    title: head.title,
    updatedAt: head.updatedAt,
    contentAvailable: head.contentAvailable,
    sizeBytes: head.sizeBytes,
    currentVersion: head.version,
  };
  // Absent rather than null, as `mapResource` leaves it.
  if (head.mimeType) next.mimeType = head.mimeType;
  else delete next.mimeType;
  return next;
}

function isDetailQueryKey(queryKey: readonly unknown[]): boolean {
  return (queryKey[0] === 'workstream' && queryKey.length === 2)
    || (queryKey[0] === 'substream-workstream' && queryKey.length === 3);
}

function holdsResources(value: unknown): value is ResourceHolder {
  return typeof value === 'object' && value !== null && Array.isArray((value as ResourceHolder).resources);
}

/** A detail with every resource moved to its recorded head, or the same detail when none is behind. */
function withHeads<T extends ResourceHolder>(detail: T, heads: ResourceHeads): T {
  let changed = false;
  const resources = detail.resources.map((resource) => {
    const head = heads[resource.id];
    const next = head ? withResourceHead(resource, head) : resource;
    if (next !== resource) changed = true;
    return next;
  });
  return changed ? { ...detail, resources } : detail;
}

const NO_HEADS: ResourceHeads = Object.freeze({});

function readHeads(queryClient: QueryClient): ResourceHeads {
  return queryClient.getQueryData<ResourceHeads>(RESOURCE_HEADS_QUERY_KEY) ?? NO_HEADS;
}

/**
 * Keep the newer of each head, writing nothing when none is newer. A first
 * version is never recorded: nothing can be behind it.
 */
function recordHeads(queryClient: QueryClient, heads: readonly ResourceHead[]): void {
  const current = readHeads(queryClient);
  const newer = heads.filter((head) => (current[head.resourceId]?.version ?? 1) < head.version);
  if (newer.length === 0) return;
  queryClient.setQueryDefaults(RESOURCE_HEADS_QUERY_KEY, { gcTime: Number.POSITIVE_INFINITY });
  const next: Record<string, ResourceHead> = { ...current };
  for (const head of newer) {
    if ((next[head.resourceId]?.version ?? 1) < head.version) next[head.resourceId] = head;
  }
  queryClient.setQueryData<ResourceHeads>(RESOURCE_HEADS_QUERY_KEY, next);
}

/** The head a conversation's own copy of a resource states, when it states a whole one. */
function headOf(resource: WorkstreamResource): ResourceHead | null {
  if (resource.updatedAt === undefined) return null;
  return {
    resourceId: resource.id,
    version: resource.currentVersion,
    title: resource.title,
    mimeType: resource.mimeType ?? null,
    updatedAt: resource.updatedAt,
    contentAvailable: resource.contentAvailable ?? false,
    sizeBytes: resource.sizeBytes ?? 0,
  };
}

/**
 * Apply announced heads to every conversation detail in the cache that holds
 * one of these resources at an older version, and record them.
 *
 * Every preview keys on `currentVersion`, so moving it here is what reloads an
 * open panel, a site preview and the version list.
 */
export function applyResourceHeads(queryClient: QueryClient, heads: readonly ResourceHead[]): void {
  recordHeads(queryClient, heads);
  const recorded = readHeads(queryClient);
  queryClient.setQueriesData<ResourceHolder>(
    { predicate: (query) => isDetailQueryKey(query.queryKey) },
    (current) => (holdsResources(current) ? withHeads(current, recorded) : current),
  );
}

/**
 * Hold every conversation detail at the newest head this window knows, from
 * now until the returned function is called.
 *
 * A detail has many writers (its socket's snapshot and resource events, a
 * REST answer, the local cache), and any of them can land after a newer head
 * with an older copy of a resource. Rather than each writer remembering to
 * merge, every write of a detail is followed here: a resource behind its
 * recorded head is moved forward, and a resource ahead of it records its own
 * head. The write a correction makes finds nothing behind, so it stops there.
 */
export function followResourceHeads(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const { queryKey } = event.query;
    if (!isDetailQueryKey(queryKey)) return;
    const detail: unknown = event.query.state.data;
    if (!holdsResources(detail)) return;
    recordHeads(queryClient, detail.resources.flatMap((resource) => {
      const head = headOf(resource);
      return head ? [head] : [];
    }));
    const moved = withHeads(detail, readHeads(queryClient));
    if (moved !== detail) queryClient.setQueryData(queryKey, moved);
  });
}

/** The recorded heads, for a surface that shows resources outside their conversation. */
export function useResourceHeads(): ResourceHeads {
  return useQuery<ResourceHeads>({
    queryKey: RESOURCE_HEADS_QUERY_KEY,
    queryFn: fetchThroughOwner,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }).data ?? NO_HEADS;
}
