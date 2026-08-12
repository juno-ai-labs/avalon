import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
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
    pinPosition: null,
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
});
