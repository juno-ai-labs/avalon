import { useLayoutEffect } from 'react';
import {
  markWorkstreamFeedCacheState,
  markWorkstreamFeedDataReady,
  markWorkstreamFeedSocketLease,
  reportWorkstreamFeedAfterPaint,
  type TelemetryCountBucket,
  type WorkstreamFeedCacheState,
  type WorkstreamFeedSource,
  workstreamFeedOpenAttemptId,
} from './telemetry';

/**
 * What the open-latency event names as the feed's source. A transcript that
 * was already in the query cache when the surface mounted reads as the feed
 * cache, unless the entry says it is the local cache's seed: the pool hydrates
 * a conversation before the surface mounts, so the seed is usually there first.
 */
export function resolveFeedOpenSource(
  cacheState: WorkstreamFeedCacheState,
  feedSource: WorkstreamFeedSource | null | undefined,
): WorkstreamFeedSource | null {
  if (feedSource === 'local_cache') return 'local_cache';
  if (cacheState === 'feed_cached') return 'feed_cache';
  return feedSource ?? null;
}

export function useWorkstreamFeedOpenTelemetry({
  cacheState,
  feedSource,
  isReady,
  messageCount,
  readSocketOpenContext,
  workstreamId,
}: {
  cacheState: WorkstreamFeedCacheState;
  feedSource: WorkstreamFeedSource | undefined;
  isReady: boolean;
  messageCount: TelemetryCountBucket | undefined;
  readSocketOpenContext: () => { socketLeaseId?: string };
  workstreamId: string;
}): void {
  useLayoutEffect(() => {
    const socketLeaseId = readSocketOpenContext().socketLeaseId;
    markWorkstreamFeedSocketLease(workstreamId, socketLeaseId);
    markWorkstreamFeedCacheState(workstreamId, cacheState);
    if (!isReady || !feedSource || !messageCount || !workstreamFeedOpenAttemptId(workstreamId)) return;

    // Idempotent across StrictMode's setup-cleanup-setup sequence. Scheduling
    // is deliberately not gated on the return value: cleanup cancels frames,
    // so every subsequent setup must be able to schedule their replacement.
    markWorkstreamFeedDataReady(workstreamId);
    return reportWorkstreamFeedAfterPaint(
      workstreamId,
      feedSource,
      messageCount,
      socketLeaseId,
    );
  }, [cacheState, feedSource, isReady, messageCount, readSocketOpenContext, workstreamId]);
}
