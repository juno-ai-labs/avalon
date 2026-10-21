import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { archiveThread, reconcileThreadPage, resolveConversation } from './thread-lifecycle';
import { MY_THREADS_QUERY_KEY } from './sidebar-list-store';
import type { SpaceConversationSummary, WorkstreamSummary } from './types';
import { evictCachedWorkstream, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

function thread(overrides: Partial<SpaceConversationSummary> = {}): SpaceConversationSummary {
  return {
    id: 'thread', title: 'Launch', titleStatus: 'settled', harnessStatus: 'completed', scope: 'workspace',
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null, nextPendingWakeup: null,
    pinPosition: null, participantUserIds: [], participantExtraCount: 0, spaceIds: [],
    lastActivityAt: '2026-10-21T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z',
    kind: 'channel', breakoutOf: null, ...overrides,
  };
}

const archived = (): WorkstreamSummary => thread({ archivedAt: '2026-10-21T12:01:00.000Z', updatedAt: '2026-10-21T12:01:00.000Z' });
const restored = (): SpaceConversationSummary => thread({ title: 'Restored launch', updatedAt: '2026-10-21T12:02:00.000Z' });
const page = () => ({ nextCursor: null, items: [thread(), thread({ id: 'child', kind: 'breakout', breakoutOf: { workstreamId: 'thread', substreamId: '0', title: 'Launch' } })], pinned: [thread()] });

describe('shared thread lifecycle', () => {
  it('keeps stale pages and pinned breakouts hidden after the directory tombstone', async () => {
    const client = new QueryClient();
    client.setQueryData(MY_THREADS_QUERY_KEY, { pages: [page()], pageParams: [null] });
    await archiveThread({ archiveWorkstream: vi.fn(async () => archived()) }, client, 'thread', true);
    evictCachedWorkstream(client, 'thread');
    const next = reconcileThreadPage(client, page());
    expect(next.items).toEqual([]);
    expect(next.pinned).toEqual([]);
    expect(client.getQueryData<InfiniteData<ReturnType<typeof page>>>(MY_THREADS_QUERY_KEY)?.pages[0]?.items).toEqual([]);
    client.clear();
  });

  it('does not prune a newer restore that arrives before the archive response', async () => {
    const client = new QueryClient();
    client.setQueryData(MY_THREADS_QUERY_KEY, { pages: [{ nextCursor: null, items: [restored()], pinned: [] }], pageParams: [null] });
    let finish!: (row: WorkstreamSummary) => void;
    const pending = archiveThread({ archiveWorkstream: vi.fn(() => new Promise<WorkstreamSummary>((resolve) => { finish = resolve; })) }, client, 'thread', false);
    setCachedWorkstreams(client, [restored()]);
    finish(archived());
    expect(await pending).toBe(false);
    expect(client.getQueryData<InfiniteData<ReturnType<typeof page>>>(MY_THREADS_QUERY_KEY)?.pages[0]?.items[0]?.title).toBe('Restored launch');
    client.clear();
  });

  it('preserves a restore delivered while the older list request is being cancelled', async () => {
    const client = new QueryClient();
    let cancelled!: () => void;
    vi.spyOn(client, 'cancelQueries').mockImplementation(() => new Promise<void>((resolve) => { cancelled = resolve; }));
    const pending = archiveThread({ archiveWorkstream: vi.fn(async () => archived()) }, client, 'thread', false);
    await vi.waitFor(() => expect(cancelled).toBeTypeOf('function'));
    setCachedWorkstreams(client, [restored()]);
    cancelled();
    expect(await pending).toBe(false);
    expect(reconcileThreadPage(client, page()).items.map((row) => row.id)).toEqual(['thread', 'child']);
    client.clear();
  });

  it.each(['socket', 'list'])('allows a newer restore from the %s after a confirmed archive', async (source) => {
    const client = new QueryClient();
    await archiveThread({ archiveWorkstream: vi.fn(async () => archived()) }, client, 'thread', false);
    evictCachedWorkstream(client, 'thread');
    if (source === 'socket') setCachedWorkstreams(client, [restored()]);
    const child = thread({ id: 'child', kind: 'breakout', breakoutOf: { workstreamId: 'thread', substreamId: '0', title: 'Launch' } });
    const next = reconcileThreadPage(client, { nextCursor: null, items: [child, source === 'list' ? restored() : thread()], pinned: [] });
    expect(next.items.map((row) => row.id)).toEqual(['child', 'thread']);
    client.clear();
  });

  it.each(['directory', 'list'])('marks the cached %s thread resolved after acknowledgement without waiting for a projection', async (source) => {
    const client = new QueryClient();
    if (source === 'directory') setCachedWorkstreams(client, [thread()]);
    client.setQueryData(MY_THREADS_QUERY_KEY, { pages: [page()], pageParams: [null] });
    await resolveConversation({ resolveConversation: vi.fn(async () => undefined) }, client, 'thread', '0');
    expect(client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.resolved).toBe(true);
    expect(client.getQueryData<InfiniteData<ReturnType<typeof page>>>(MY_THREADS_QUERY_KEY)?.pages[0]?.items[0]?.resolved).toBe(true);
    client.clear();
  });

  it('does not overwrite a newer reply that reopens the thread while resolving it', async () => {
    const client = new QueryClient();
    setCachedWorkstreams(client, [thread()]);
    let finish!: () => void;
    const pending = resolveConversation({ resolveConversation: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) }, client, 'thread', '0');
    setCachedWorkstreams(client, [thread({ title: 'New reply', resolved: false })]);
    finish();
    await pending;
    expect(client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.resolved).toBe(false);
    client.clear();
  });
});
