import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  evictCachedWorkstream,
  mergeCachedWorkstreamPage,
  setCachedWorkstreams,
  WORKSTREAMS_QUERY_KEY,
} from './workstreams-cache';
import type { WorkstreamSummary } from './types';

function summary(): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Typed cache boundary',
    titleStatus: 'settled',
    origin: 'ad_hoc',
    harnessStatus: 'completed',
    scope: 'workspace',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    lastActivityAt: '2026-08-12T12:00:00.000Z',
  };
}

describe('setCachedWorkstreams', () => {
  it('stores the flat array its readers consume', () => {
    const queryClient = new QueryClient();
    const items = [summary()];

    setCachedWorkstreams(queryClient, items);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(items);
  });

  it('rejects a page object even when a type escape reaches the runtime boundary', () => {
    const queryClient = new QueryClient();

    expect(() => {
      // The compile-time contract rejects the page, and the runtime invariant
      // remains the backstop for a cast or untyped caller in shipped code.
      // @ts-expect-error A page is not the flat array this cache stores.
      setCachedWorkstreams(queryClient, { items: [summary()], nextCursor: null });
    }).toThrow('expected a WorkstreamSummary array');
  });

  it('refreshes page-one rows without dropping a loaded tail or debug row', () => {
    const queryClient = new QueryClient();
    const first = summary();
    const laterPage = { ...summary(), id: '00000000-0000-7000-8000-000000000002', title: 'Later page' };
    const debugRow = { ...summary(), id: '00000000-0000-7000-8000-000000000003', title: 'System row' };
    setCachedWorkstreams(queryClient, [first, laterPage, debugRow]);

    mergeCachedWorkstreamPage(queryClient, [{ ...first, title: 'Refreshed first page' }]);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([
      { ...first, title: 'Refreshed first page' },
      laterPage,
      debugRow,
    ]);
  });

  it('evicts every per-work-stream cache family after access revocation', () => {
    const queryClient = new QueryClient();
    const workstreamId = summary().id;
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002' };
    setCachedWorkstreams(queryClient, [summary(), other]);
    const prefixes = [
      'workstream',
      'ordered-transcript',
      'transcript-overlays',
      'workstream-feed-source',
      'workstream-socket-snapshot-generation',
      'workstream-context',
      'block-dashboard',
      'block-dashboard-preference',
      'terminal-workstream',
      'dismissed-suggestion-ids',
    ];
    for (const prefix of prefixes) {
      queryClient.setQueryData([prefix, workstreamId], { sensitive: true });
      queryClient.setQueryData([prefix, other.id], { retained: true });
    }
    queryClient.setQueryData(['workstream-context', workstreamId, null], { sensitive: true });

    evictCachedWorkstream(queryClient, workstreamId);

    for (const prefix of prefixes) {
      expect(queryClient.getQueryData([prefix, workstreamId])).toBeUndefined();
      expect(queryClient.getQueryData([prefix, other.id])).toEqual({ retained: true });
    }
    expect(queryClient.getQueryData(['workstream-context', workstreamId, null])).toBeUndefined();
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([other]);
  });
});
