import { useLayoutEffect } from 'react';
import {
  markWorkstreamFeedCacheState,
  markWorkstreamFeedDataReady,
  markWorkstreamFeedSocketLease,
  reportWorkstreamFeedAfterPaint,
  type TelemetryCountBucket,
  type WorkstreamFeedCacheState,
  workstreamFeedOpenAttemptId,
} from './telemetry';

export function useWorkstreamFeedOpenTelemetry({
  cacheState,
  feedSource,
  isReady,
  messageCount,
  readSocketOpenContext,
  workstreamId,
}: {
  cacheState: WorkstreamFeedCacheState;
  feedSource: 'feed_cache' | 'socket_snapshot' | 'boot_payload' | 'legacy_page' | undefined;
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
