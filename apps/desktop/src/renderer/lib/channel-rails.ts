import type { ChannelRail, WorkspaceChannelRailsEvent } from '@rally/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { WorkstreamSummary } from './types';

/**
 * A Channel's rail data (its people, Sidekicks and Channel resources) as the
 * workspace socket answered it, fetched ahead of need a Space at a time.
 *
 * `rail` is null when the server answered without one: the Channel is not
 * visible to this viewer, has no rail yet, or its rail is larger than a frame.
 * Either way the answer is settled at `railWaterline`, so it is not asked for
 * again until the Channel's row says the rail moved, and the rail paints from
 * the conversation's snapshot as it did before rails existed.
 */
export interface HeldChannelRail {
  railWaterline: number;
  rail: ChannelRail | null;
}

export const channelRailQueryKey = (workstreamId: string) => ['channel-rail', workstreamId] as const;
export const isChannelRailQueryKey = (queryKey: readonly unknown[]): boolean =>
  queryKey[0] === channelRailQueryKey('')[0];
/** The newest `railWaterline` any row has said, by Channel. */
const WANTED_KEY = ['channel-rail-wanted'] as const;

function pin(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(['channel-rail'], { gcTime: Number.POSITIVE_INFINITY });
  queryClient.setQueryDefaults(WANTED_KEY, { gcTime: Number.POSITIVE_INFINITY });
}

function wanted(queryClient: QueryClient): Readonly<Record<string, number>> {
  return queryClient.getQueryData<Record<string, number>>(WANTED_KEY) ?? {};
}

/** Record the rail waterline a Channel row carried. */
export function noteRailWaterline(queryClient: QueryClient, workstreamId: string, railWaterline: number): void {
  if ((wanted(queryClient)[workstreamId] ?? -1) >= railWaterline) return;
  pin(queryClient);
  queryClient.setQueryData<Record<string, number>>(WANTED_KEY, (current) => ({
    ...current,
    [workstreamId]: Math.max(railWaterline, current?.[workstreamId] ?? -1),
  }));
}

function hold(queryClient: QueryClient, workstreamId: string, held: HeldChannelRail): void {
  const current = queryClient.getQueryData<HeldChannelRail>(channelRailQueryKey(workstreamId));
  if (current && current.railWaterline > held.railWaterline) return;
  queryClient.setQueryData(channelRailQueryKey(workstreamId), held);
}

/** Write one answer frame. Named Channels it could not answer settle empty. */
export function applyChannelRails(
  queryClient: QueryClient,
  frame: Pick<WorkspaceChannelRailsEvent, 'rails' | 'oversized' | 'unavailable'>,
): void {
  pin(queryClient);
  for (const rail of frame.rails) hold(queryClient, rail.workstreamId, { railWaterline: rail.railWaterline, rail });
  for (const entry of frame.oversized) hold(queryClient, entry.workstreamId, { railWaterline: entry.railWaterline, rail: null });
  for (const workstreamId of frame.unavailable) {
    hold(queryClient, workstreamId, { railWaterline: wanted(queryClient)[workstreamId] ?? 0, rail: null });
  }
}

/**
 * Settle Channels a finished request expected but was not answered about, at
 * the waterline their rows said, so the queue does not ask for them forever.
 */
export function settleUnanswered(queryClient: QueryClient, workstreamIds: Iterable<string>): void {
  const lines = wanted(queryClient);
  for (const workstreamId of workstreamIds) {
    if (isRailStale(queryClient, workstreamId)) {
      hold(queryClient, workstreamId, { railWaterline: lines[workstreamId] ?? 0, rail: null });
    }
  }
}

/**
 * Whether a row has said a newer rail than the one held. A Channel whose rows
 * never carried a waterline (an older server) is never stale: nothing asks.
 */
export function isRailStale(queryClient: QueryClient, workstreamId: string): boolean {
  const line = wanted(queryClient)[workstreamId];
  if (line === undefined) return false;
  const held = queryClient.getQueryData<HeldChannelRail>(channelRailQueryKey(workstreamId));
  return !held || held.railWaterline < line;
}

/** Whether any row has said a rail waterline for this Channel: the server serves rails for it. */
export function hasRailWaterline(queryClient: QueryClient, workstreamId: string): boolean {
  return wanted(queryClient)[workstreamId] !== undefined;
}

/** The rails held for these Channels, for the directory row on disk. */
export function heldChannelRails(queryClient: QueryClient, workstreamIds: readonly string[]): Record<string, ChannelRail> {
  const rails: Record<string, ChannelRail> = {};
  for (const workstreamId of workstreamIds) {
    const held = queryClient.getQueryData<HeldChannelRail>(channelRailQueryKey(workstreamId));
    if (held?.rail) rails[workstreamId] = held.rail;
  }
  return rails;
}

/**
 * Put rails restored from the device into Channels that hold none. Each keeps
 * the waterline it was answered at: a waterline and its data are committed
 * together, so a live row at the same waterline has nothing newer to say.
 */
export function seedChannelRails(queryClient: QueryClient, rails: Record<string, ChannelRail>): void {
  pin(queryClient);
  for (const [workstreamId, rail] of Object.entries(rails)) {
    if (queryClient.getQueryData(channelRailQueryKey(workstreamId)) !== undefined) continue;
    queryClient.setQueryData<HeldChannelRail>(channelRailQueryKey(workstreamId), { railWaterline: rail.railWaterline, rail });
  }
}

/** This Channel's rail, or undefined while none is held. */
export function useChannelRail(workstreamId: string | null): ChannelRail | undefined {
  return useQuery<HeldChannelRail | undefined, Error, ChannelRail | undefined>({
    queryKey: channelRailQueryKey(workstreamId ?? ''),
    queryFn: async () => undefined,
    enabled: false,
    select: (held) => held?.rail ?? undefined,
  }).data;
}

export type ChannelRailTarget =
  | { spaceId: string; expected: string[] }
  | { workstreamIds: string[] };

/** The same bound `list_workstreams` carries; the contract's number. */
const WORKSTREAM_IDS_PER_REQUEST = 250;

/**
 * The next request the prefetch queue should send, or null when every rail it
 * knows of is current.
 *
 * Order: the Channel in front, then its Spaces, then the other Spaces in the
 * directory's order, then Channels in no Space. A Space whose every known
 * Channel is stale is asked for whole, by Space; one with only some stale is
 * asked for by those Channels, so a single moved rail never resends a Space.
 */
export function nextChannelRailRequest(
  queryClient: QueryClient,
  foregroundWorkstreamId: string | null,
  rows: readonly Pick<WorkstreamSummary, 'id' | 'spaceIds' | 'pending'>[],
  spaces: { items: readonly { id: string }[] } | undefined,
): ChannelRailTarget | null {
  const stale = (id: string): boolean => isRailStale(queryClient, id);
  if (foregroundWorkstreamId && stale(foregroundWorkstreamId)) return { workstreamIds: [foregroundWorkstreamId] };
  const live = rows.filter((row) => !row.pending);
  const foregroundSpaces = live.find((row) => row.id === foregroundWorkstreamId)?.spaceIds ?? [];
  const order = [...new Set([...foregroundSpaces, ...(spaces?.items ?? []).map((space) => space.id)])];
  for (const spaceId of order) {
    const members = live.filter((row) => row.spaceIds.includes(spaceId));
    const staleIds = members.filter((row) => stale(row.id)).map((row) => row.id);
    if (staleIds.length === 0) continue;
    if (staleIds.length === members.length) return { spaceId, expected: staleIds };
    return { workstreamIds: staleIds.slice(0, WORKSTREAM_IDS_PER_REQUEST) };
  }
  const loose = live.filter((row) => stale(row.id)).map((row) => row.id);
  return loose.length > 0 ? { workstreamIds: loose.slice(0, WORKSTREAM_IDS_PER_REQUEST) } : null;
}
