import { useLayoutEffect } from 'react';
import {
  reportWorkstreamSendReadyAfterPaint,
  type WorkstreamSendReadyWorkspaceSocketState,
} from './telemetry';
import { completeCreationTraceAfterPaint } from './perf-trace';

/**
 * Measures the first painted composer whose work-stream-specific send handler
 * is installed. Workspace transport may be connecting or reconnecting: its
 * command queue accepts the send and owns later delivery.
 */
export function useWorkstreamSendReadyTelemetry({
  isReady,
  workspaceSocketState,
  workstreamId,
  substreamId = '0',
}: {
  isReady: boolean;
  workspaceSocketState: WorkstreamSendReadyWorkspaceSocketState | 'unavailable';
  workstreamId: string;
  substreamId?: string;
}): void {
  useLayoutEffect(() => {
    if (!isReady || workspaceSocketState === 'unavailable') return;
    return reportWorkstreamSendReadyAfterPaint(workstreamId, workspaceSocketState, () => {
        completeCreationTraceAfterPaint(workstreamId, substreamId);
    });
  }, [isReady, substreamId, workspaceSocketState, workstreamId]);
}
