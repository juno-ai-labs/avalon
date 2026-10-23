import { asSubstreamId, asWorkstreamId } from '@rally/contracts';
import { QueryObserver, skipToken } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { applyChannelViewerState, type WorkstreamChildDirectory } from './channel-viewer-state';
import { createQueryClient } from './query-client';

afterEach(() => vi.useRealTimers());

it('retains socket-owned counts and breakouts when observers mount before the first socket row', async () => {
  vi.useFakeTimers();
  const client = createQueryClient();
  const id = asWorkstreamId('00000000-0000-7000-8000-000000000001');
  const counts = new QueryObserver<Record<string, number> | null>(client, {
    queryKey: ['workstream-background-agents', id], queryFn: skipToken, initialData: null,
  });
  const children = new QueryObserver<WorkstreamChildDirectory | null>(client, {
    queryKey: ['workstream-children', id], queryFn: skipToken, initialData: null,
  });
  const stopCounts = counts.subscribe(() => undefined);
  const stopChildren = children.subscribe(() => undefined);
  applyChannelViewerState(client, {
    id, backgroundAgentCounts: { [asSubstreamId('0')]: 2 }, privateChildren: [],
  }, {
    authorityGeneration: 1, commonWaterline: 1, viewerWaterline: 1,
    commonEventId: '00000000-0000-7000-8000-000000000002',
    viewerEventId: '00000000-0000-7000-8000-000000000003',
  }, null);
  // Leave before any React rerender can reinstall observer options.
  stopCounts();
  stopChildren();
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect.soft(client.getQueryData(['workstream-background-agents', id])).toEqual({ '0': 2 });
  expect.soft(client.getQueryData<WorkstreamChildDirectory>(['workstream-children', id])?.privateChildren).toEqual([]);
  client.clear();
});
