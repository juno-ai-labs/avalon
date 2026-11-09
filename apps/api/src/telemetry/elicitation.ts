import type { UserId, WorkspaceId } from '@rally/contracts';
import { resourceTelemetryEventId, runTelemetryOperationId, telemetryCountBucket } from './product-usage';

/**
 * The `elicitation_presented` event for a question a run opened. The
 * question's id is derived from its tool call's receipt key, so it is a
 * deterministic UUIDv5 the envelope's v7-only `eventId` refuses; the event id
 * is its stable UUIDv7 projection (`resourceTelemetryEventId`, the documented
 * choice for deterministic ids), so a replayed question is still one event.
 * The run's id is projected the same way for the operation correlation, since
 * an imported run's is UUIDv8.
 */
export function elicitationPresentedTelemetry(input: {
  workspaceId: WorkspaceId;
  userId?: UserId;
  elicitationId: string;
  runId: string;
  workstreamId: string;
  responseType: 'text' | 'radio' | 'single_select' | 'multi_select';
  optionCount: number;
}) {
  return {
    workspaceId: input.workspaceId,
    ...(input.userId ? { userId: input.userId } : {}),
    name: 'elicitation_presented' as const,
    properties: {
      elicitationId: input.elicitationId,
      runId: input.runId,
      workstreamId: input.workstreamId,
      responseType: input.responseType,
      optionCount: telemetryCountBucket(input.optionCount),
      surface: 'workstream' as const,
    },
    operationId: runTelemetryOperationId(input.runId),
    eventId: resourceTelemetryEventId(input.elicitationId, 1),
  };
}
