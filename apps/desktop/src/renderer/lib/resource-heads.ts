import type { ResourceHead } from '@rally/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchThroughOwner } from './fetch-through-owner';
import type { WorkstreamDetail, WorkstreamResource } from './types';

/**
 * The newest head the workspace socket has announced for each resource, by id.
 *
 * Read by whatever shows a resource outside the conversation that holds it
 * (a popped-out artifact window); a conversation's own detail is patched in
 * place by {@link applyResourceHeads}, so its previews follow without this.
 */
export const RESOURCE_HEADS_QUERY_KEY = ['resource-heads'] as const;

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

/** What a cached conversation detail holds that a head can move. */
type ResourceHolder = Pick<WorkstreamDetail, 'resources'>;

function isDetailQueryKey(queryKey: readonly unknown[]): boolean {
  return (queryKey[0] === 'workstream' && queryKey.length === 2)
    || (queryKey[0] === 'substream-workstream' && queryKey.length === 3);
}

/**
 * Apply announced heads to every conversation detail in the cache that holds
 * one of these resources at an older version, and record them for surfaces
 * outside a conversation.
 *
 * Every preview keys on `currentVersion`, so moving it here is what reloads an
 * open panel, a site preview, the version list and, while its conversation is
 * on screen, a popped-out window. A head no newer than the one held changes
 * nothing, so the conversation socket's own `resource_updated` for the same
 * version, arriving in either order, is harmless.
 */
export function applyResourceHeads(queryClient: QueryClient, heads: readonly ResourceHead[]): void {
  const byId = new Map(heads.map((head) => [head.resourceId, head]));
  queryClient.setQueriesData<ResourceHolder>({ predicate: (query) => isDetailQueryKey(query.queryKey) }, (current) => {
    if (!current || !Array.isArray(current.resources)) return current;
    let changed = false;
    const resources = current.resources.map((resource) => {
      const head = byId.get(resource.id);
      const next = head ? withResourceHead(resource, head) : resource;
      if (next !== resource) changed = true;
      return next;
    });
    return changed ? { ...current, resources } : current;
  });
  queryClient.setQueryDefaults(RESOURCE_HEADS_QUERY_KEY, { gcTime: Number.POSITIVE_INFINITY });
  queryClient.setQueryData<Readonly<Record<string, ResourceHead>>>(RESOURCE_HEADS_QUERY_KEY, (current = {}) => {
    const next = { ...current };
    for (const head of heads) {
      if ((next[head.resourceId]?.version ?? 0) < head.version) next[head.resourceId] = head;
    }
    return next;
  });
}

const NO_HEADS: Readonly<Record<string, ResourceHead>> = Object.freeze({});

/** The announced heads, for a surface that shows resources outside their conversation. */
export function useResourceHeads(): Readonly<Record<string, ResourceHead>> {
  return useQuery<Readonly<Record<string, ResourceHead>>>({
    queryKey: RESOURCE_HEADS_QUERY_KEY,
    queryFn: fetchThroughOwner,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }).data ?? NO_HEADS;
}
