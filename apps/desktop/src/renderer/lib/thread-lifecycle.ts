import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { ApiError, type RallyApi } from './api';
import type { WorkstreamChildDirectory } from './channel-viewer-state';
import { MY_THREADS_QUERY_KEY } from './sidebar-list-store';
import { reportTelemetryProductIntent, telemetryVisibility } from './telemetry';
import type { SpaceConversationSummary, WorkstreamDetail, WorkstreamSummary } from './types';
import { holdCachedWorkstreamArchive, patchCachedWorkstream, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY, workstreamDetailQueryKey } from './workstreams-cache';

type ThreadPage = Awaited<ReturnType<RallyApi['getMyThreads']>>;
const CONFIRMED_ARCHIVES = ['navigation', 'confirmed-thread-archives'] as const;
type ArchiveVersions = Record<string, string | null>;

function archiveHeld(client: QueryClient, id: string, listed?: SpaceConversationSummary): boolean {
  const held = client.getQueryData<ArchiveVersions>(CONFIRMED_ARCHIVES);
  if (!held || !Object.hasOwn(held, id)) return false;
  const resident = client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.find((row) => row.id === id);
  const residentArchive = resident?.archivedAt ? resident.updatedAt ?? resident.archivedAt : null;
  const previous = held[id] ?? null;
  const version = residentArchive && (previous === null || residentArchive > previous) ? residentArchive : previous;
  if (version !== previous) client.setQueryData<ArchiveVersions>(CONFIRMED_ARCHIVES, { ...held, [id]: version });
  const newerRestore = (row: WorkstreamSummary | undefined): boolean => Boolean(row && !row.archivedAt
    && row.updatedAt && (version === null || row.updatedAt > version));
  if (newerRestore(resident) || (version !== null && newerRestore(listed))) {
    client.setQueryData<ArchiveVersions>(CONFIRMED_ARCHIVES, (current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    return false;
  }
  return true;
}

/** Every page read respects committed archives, including after the directory tombstone removes its marker. */
export function reconcileThreadPage(client: QueryClient, page: ThreadPage): ThreadPage {
  if (!client.getQueryData<ArchiveVersions>(CONFIRMED_ARCHIVES)) return page;
  // A restored parent can sort after its Breakouts in this same page.
  for (const rows of [page.items, page.pinned]) {
    for (const row of rows) if (!row.breakoutOf) archiveHeld(client, row.id, row);
  }
  const keep = (row: SpaceConversationSummary): boolean => !archiveHeld(client, row.breakoutOf?.workstreamId ?? row.id,
    row.breakoutOf ? undefined : row);
  return { ...page, items: page.items.filter(keep), pinned: page.pinned.filter(keep) };
}

/** The archive's version decision, sidebar reconciliation and telemetry are shared by both entry points. */
export async function archiveThread(api: Pick<RallyApi, 'archiveWorkstream'>, client: QueryClient,
  id: string, pinned: boolean): Promise<boolean> {
  const archived = await api.archiveWorkstream(id);
  const applied = holdCachedWorkstreamArchive(client, archived);
  reportTelemetryProductIntent({
    kind: 'workstream_action_completed', workstreamId: id, action: 'archive',
    visibility: telemetryVisibility(archived.scope), origin: archived.systemKind ? 'system' : 'ad_hoc', pinned,
  });
  if (!applied) return false;
  // These session-local receipts outlive section mounts and directory tombstones.
  // A newer restore releases one; changing account/Organization clears the QueryClient.
  client.setQueryDefaults(CONFIRMED_ARCHIVES, { gcTime: Infinity });
  client.setQueryData<ArchiveVersions>(CONFIRMED_ARCHIVES, (held) => ({
    ...held, [id]: archived.updatedAt ?? archived.archivedAt ?? null,
  }));
  await client.cancelQueries({ queryKey: MY_THREADS_QUERY_KEY });
  if (!archiveHeld(client, id)) return false;
  client.setQueryData<InfiniteData<ThreadPage>>(MY_THREADS_QUERY_KEY, (current) => current && ({
    ...current, pages: current.pages.map((page) => reconcileThreadPage(client, page)),
  }));
  return true;
}

/** Reflect the confirmed resolution unless the owning socket has already delivered a newer state. */
export async function resolveConversation(api: Pick<RallyApi, 'resolveConversation'>, client: QueryClient,
  parentId: string, substreamId: string): Promise<void> {
  const current = (): WorkstreamSummary | WorkstreamChildDirectory | undefined => substreamId === '0'
    ? client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.find((row) => row.id === parentId)
    : client.getQueryData<WorkstreamChildDirectory>(['workstream-children', parentId]);
  const observed = current();
  const detailKey = workstreamDetailQueryKey(parentId, substreamId);
  const detail = client.getQueryData<WorkstreamDetail>(detailKey);
  await api.resolveConversation(parentId, substreamId);
  await client.cancelQueries({ queryKey: MY_THREADS_QUERY_KEY });
  if (current() !== observed || client.getQueryData(detailKey) !== detail) return;
  patchCachedWorkstream(client, parentId, { resolved: true }, substreamId);
  if (substreamId === '0' && !observed) {
    const listed = client.getQueryData<InfiniteData<ThreadPage>>(MY_THREADS_QUERY_KEY)?.pages
      .flatMap((page) => [...page.items, ...page.pinned]).find((row) => row.id === parentId && !row.breakoutOf);
    if (listed) setCachedWorkstreams(client, (rows) => [...(rows ?? []), { ...listed, resolved: true }]);
  }
  if (substreamId !== '0') client.setQueryData<WorkstreamChildDirectory>(['workstream-children', parentId], (directory) => directory && ({
    ...directory, privateChildren: directory.privateChildren?.map((child) => child.substreamId === substreamId ? { ...child, resolved: true } : child),
  }));
  const id = substreamId === '0' ? parentId : substreamId;
  const patch = (rows: SpaceConversationSummary[]): SpaceConversationSummary[] => rows.map((row) => row.id === id ? { ...row, resolved: true } : row);
  client.setQueryData<InfiniteData<ThreadPage>>(MY_THREADS_QUERY_KEY, (pages) => pages && ({
    ...pages, pages: pages.pages.map((page) => ({ ...page, items: patch(page.items), pinned: patch(page.pinned) })),
  }));
}

export function resolutionFailure(error: unknown, noun: 'thread' | 'breakout'): string {
  return error instanceof ApiError && error.code === 'substream_archived'
    ? 'Restore this conversation before resolving it.'
    : error instanceof ApiError && error.status === 403 ? 'You no longer have access to resolve this conversation.'
      : error instanceof ApiError && error.status === 404 ? 'This conversation is no longer available.'
        : `The ${noun} couldn’t be resolved. Try again.`;
}
