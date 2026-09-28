import { ChannelRailSchema, type ChannelRail } from '@rally/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  applyChannelRails,
  channelRailQueryKey,
  isRailStale,
  nextChannelRailRequest,
  noteRailWaterline,
  seedChannelRails,
  settleUnanswered,
  type HeldChannelRail,
} from './channel-rails';

const a = '00000000-0000-7000-8000-00000000000a';
const b = '00000000-0000-7000-8000-00000000000b';
const c = '00000000-0000-7000-8000-00000000000c';
const d = '00000000-0000-7000-8000-00000000000d';
const general = '00000000-0000-4000-8000-000000000001';
const design = '00000000-0000-4000-8000-000000000002';

function rail(workstreamId: string, railWaterline: number): ChannelRail {
  return ChannelRailSchema.parse({
    workstreamId, railWaterline, participantUserIds: [],
    sidekicks: { owned: [], recommended: [], attached: [] }, resources: [],
  });
}

const spaces = { items: [{ id: general }, { id: design }] };
const rows = [
  { id: a, spaceIds: [general] },
  { id: b, spaceIds: [general] },
  { id: c, spaceIds: [design] },
  { id: d, spaceIds: [] },
];

describe('channel rails', () => {
  it('asks for nothing about a Channel whose rows never said a rail waterline', () => {
    const queryClient = new QueryClient();
    expect(isRailStale(queryClient, a)).toBe(false);
    expect(nextChannelRailRequest(queryClient, a, rows, spaces)).toBeNull();
  });

  it('asks by name for the Channel in front, then each Space\'s stale Channels, then Channels in no Space', () => {
    const queryClient = new QueryClient();
    for (const id of [a, b, c, d]) noteRailWaterline(queryClient, id, 1);

    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toEqual([c]);
    applyChannelRails(queryClient, { rails: [rail(c, 1)], oversized: [], unavailable: [] });
    // Design holds only `c`, now current; General's stale Channels are named.
    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toEqual([a, b]);
    applyChannelRails(queryClient, { rails: [rail(a, 1), rail(b, 1)], oversized: [], unavailable: [] });
    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toEqual([d]);
    applyChannelRails(queryClient, { rails: [rail(d, 1)], oversized: [], unavailable: [] });
    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toBeNull();
  });

  it('asks the foreground Channel\'s Space first, and only its stale Channels', () => {
    const queryClient = new QueryClient();
    for (const id of [a, b, c]) noteRailWaterline(queryClient, id, 1);
    applyChannelRails(queryClient, { rails: [rail(a, 1), rail(c, 1)], oversized: [], unavailable: [] });

    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toEqual([b]);

    noteRailWaterline(queryClient, c, 2);
    expect(nextChannelRailRequest(queryClient, null, rows, spaces)).toEqual([b]);
    expect(nextChannelRailRequest(queryClient, c, rows, spaces)).toEqual([c]);
  });

  it('keeps the newer rail when an older answer arrives late', () => {
    const queryClient = new QueryClient();
    applyChannelRails(queryClient, { rails: [rail(a, 3)], oversized: [], unavailable: [] });
    applyChannelRails(queryClient, { rails: [rail(a, 2)], oversized: [], unavailable: [] });
    expect(queryClient.getQueryData<HeldChannelRail>(channelRailQueryKey(a))?.railWaterline).toBe(3);
  });

  it('settles a Channel the answer did not cover, so the queue does not loop on it', () => {
    const queryClient = new QueryClient();
    noteRailWaterline(queryClient, a, 4);
    settleUnanswered(queryClient, [a]);
    expect(isRailStale(queryClient, a)).toBe(false);
    expect(queryClient.getQueryData<HeldChannelRail>(channelRailQueryKey(a))).toEqual({ railWaterline: 4, rail: null });
  });

  it('treats a rail restored from disk as current at the waterline it was answered at', () => {
    const queryClient = new QueryClient();
    seedChannelRails(queryClient, { [a]: rail(a, 5) });
    noteRailWaterline(queryClient, a, 5);
    expect(isRailStale(queryClient, a)).toBe(false);
    noteRailWaterline(queryClient, a, 6);
    expect(isRailStale(queryClient, a)).toBe(true);
  });
});
