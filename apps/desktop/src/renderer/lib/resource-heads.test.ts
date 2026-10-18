import type { ResourceHead } from '@rally/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyResourceHeads, RESOURCE_HEADS_QUERY_KEY } from './resource-heads';
import type { WorkstreamDetail, WorkstreamResource } from './types';
import { workstreamDetailQueryKey } from './workstreams-cache';

const report: WorkstreamResource = {
  id: 'resource-report',
  title: 'Launch report',
  resourceType: 'generated_file',
  mimeType: 'text/markdown',
  updatedAt: '2026-10-18T00:00:00.000Z',
  contentAvailable: true,
  sizeBytes: 10,
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  currentVersion: 1,
  relationshipType: 'generated',
  direction: 'artifact',
};

const head: ResourceHead = {
  resourceId: 'resource-report',
  version: 2,
  title: 'Launch report, final',
  mimeType: 'text/html',
  updatedAt: '2026-10-18T01:00:00.000Z',
  contentAvailable: true,
  sizeBytes: 42,
};

function detail(resources: WorkstreamResource[]) {
  return { resources } satisfies Pick<WorkstreamDetail, 'resources'>;
}

describe('applyResourceHeads', () => {
  it('moves the resource to its new head in every conversation that holds it, keeping how each links it', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(workstreamDetailQueryKey('thread-a'), detail([report]));
    queryClient.setQueryData(workstreamDetailQueryKey('thread-b', 'breakout-1'),
      detail([{ ...report, relationshipType: 'attachment', direction: 'source' }]));

    applyResourceHeads(queryClient, [head]);

    expect(queryClient.getQueryData<WorkstreamDetail>(workstreamDetailQueryKey('thread-a'))?.resources).toEqual([{
      ...report,
      title: 'Launch report, final',
      mimeType: 'text/html',
      updatedAt: '2026-10-18T01:00:00.000Z',
      sizeBytes: 42,
      currentVersion: 2,
    }]);
    expect(queryClient.getQueryData<WorkstreamDetail>(workstreamDetailQueryKey('thread-b', 'breakout-1'))?.resources)
      .toEqual([expect.objectContaining({ currentVersion: 2, relationshipType: 'attachment', direction: 'source' })]);
    expect(queryClient.getQueryData(RESOURCE_HEADS_QUERY_KEY)).toEqual({ 'resource-report': head });
  });

  it('never moves a resource or the recorded head back to an older version', () => {
    const queryClient = new QueryClient();
    const held = detail([{ ...report, currentVersion: 3 }]);
    queryClient.setQueryData(workstreamDetailQueryKey('thread-a'), held);
    applyResourceHeads(queryClient, [{ ...head, version: 3 }]);

    applyResourceHeads(queryClient, [head]);

    expect(queryClient.getQueryData(workstreamDetailQueryKey('thread-a'))).toBe(held);
    expect(queryClient.getQueryData<Record<string, ResourceHead>>(RESOURCE_HEADS_QUERY_KEY)?.['resource-report']?.version)
      .toBe(3);
  });
});
