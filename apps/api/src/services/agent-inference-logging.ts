import type {
  InferenceAttemptEvent,
  InferenceRequestEvent,
} from "@rally/agent-harness";
import type { Env } from "../env";
import { runtimeDeferral, type WorkDeferral } from "../lib/defer";
import { logStructuredEvent, type LogFields } from "../observability/logger";
import {
  captureStreamingInferenceAttempt,
  captureStreamingInferenceRequest,
} from "./inference-lakehouse";
import { emitInferenceUsage } from "./usage-metering";

type AgentInferenceSource = "workstream" | "inline_child";

/** One diagnostic for the first provider request of an eligible durable attempt. */
export function createInferenceStartBreakdownReporter(
  env: Env,
  eligible: boolean,
  snapshot: (inferenceRequestId: string) => {
    fields: LogFields;
    activationAuthorizationChecks: number;
    activationDurations: ReadonlyMap<string, Record<string, number>>;
  },
): (inferenceRequestId: string) => void {
  let observed = false;
  return (inferenceRequestId) => {
    if (observed) return;
    observed = true;
    if (!eligible) return;
    const { fields, activationAuthorizationChecks, activationDurations } = snapshot(inferenceRequestId);
    logStructuredEvent(env, "info", "agent_inference_start_breakdown", {
      ...fields,
      initial_activation_auth_check_count: activationAuthorizationChecks,
      // The structured logger truncates arrays at 50. Numeric object keys
      // retain every plugin and avoid treating a plugin ID as a sensitive key.
      initial_activation_details: Object.fromEntries(
        [...activationDurations].map(([pluginId, durations], index) => [
          `plugin_${index}`,
          { plugin_id: pluginId, ...durations },
        ]),
      ),
    });
  };
}

export interface AgentInferenceLogContext {
  workspaceId: string;
  userId?: string;
  requestId: string;
  draftId?: string;
  source: AgentInferenceSource;
  workstreamId?: string;
  substreamId?: string;
  parentRequestId?: string;
  operationId?: string;
  journey?: "workstream_create" | "substream_create" | "message_send";
  requestReceivedAt?: number;
  /** Only the first durable attempt owns the user-request-to-dispatch SLO row. */
  inferenceStartEligible?: boolean;
  /** What this run's attempts are metered as. Compaction attempts are metered separately. */
  usage?: { activity: "agent_run" | "sidekick_run"; sidekickId?: string };
}

export interface AgentInferenceLogger {
  onRequest(request: InferenceRequestEvent): Promise<void>;
  onAttempt(attempt: InferenceAttemptEvent): Promise<void>;
}

export interface AgentInferencePreparationBreakdown {
  initialIdentityRunMs: number;
  persistedOutcomeMs: number;
  initialRunAuthorityMs: number;
  sidekickAuthorityMs: number;
  leaseHeartbeatMs: number;
  runContextMs: number;
  transcriptBootstrapMs: number;
  toolInventoryMs: number;
  toolConstructionMs: number;
  attachmentReplayMs: number;
  transcriptBootstrapRequired: boolean;
  sidekickSnapshotReused: boolean;
}

export function logAgentInferencePrepared(
  env: Env,
  context: AgentInferenceLogContext,
  timing: {
    runStartedAtMs: number;
    initialAuthorityReadyAtMs: number;
    harnessInputsReadyAtMs: number;
    preparationFinishedAtMs: number;
    breakdown: AgentInferencePreparationBreakdown;
  },
): void {
  if (context.inferenceStartEligible === false || context.requestReceivedAt === undefined) return;
  const requestToPreparedMs = timing.preparationFinishedAtMs >= context.requestReceivedAt
    ? timing.preparationFinishedAtMs - context.requestReceivedAt
    : undefined;
  logStructuredEvent(env, "info", "agent_inference_prepared", {
    request_id: context.requestId,
    operation_id: context.operationId,
    journey: context.journey,
    request_received_at: context.requestReceivedAt,
    request_to_prepared_ms: requestToPreparedMs,
    request_clock_skewed: requestToPreparedMs === undefined,
    workspace_id: context.workspaceId,
    workstream_id: context.workstreamId,
    substream_id: context.workstreamId ? context.substreamId ?? "0" : undefined,
    initial_authority_ms: timing.initialAuthorityReadyAtMs - timing.runStartedAtMs,
    context_tools_ms: timing.harnessInputsReadyAtMs - timing.initialAuthorityReadyAtMs,
    scope_activation_routing_ms: timing.preparationFinishedAtMs - timing.harnessInputsReadyAtMs,
    total_ms: timing.preparationFinishedAtMs - timing.runStartedAtMs,
    initial_identity_run_ms: timing.breakdown.initialIdentityRunMs,
    persisted_outcome_ms: timing.breakdown.persistedOutcomeMs,
    initial_run_authority_ms: timing.breakdown.initialRunAuthorityMs,
    sidekick_authority_ms: timing.breakdown.sidekickAuthorityMs,
    lease_heartbeat_ms: timing.breakdown.leaseHeartbeatMs,
    run_context_ms: timing.breakdown.runContextMs,
    transcript_bootstrap_ms: timing.breakdown.transcriptBootstrapMs,
    tool_inventory_ms: timing.breakdown.toolInventoryMs,
    tool_construction_ms: timing.breakdown.toolConstructionMs,
    attachment_replay_ms: timing.breakdown.attachmentReplayMs,
    transcript_bootstrap_required: timing.breakdown.transcriptBootstrapRequired,
    sidekick_snapshot_reused: timing.breakdown.sidekickSnapshotReused,
  });
}

export function createAgentInferenceLogger(
  env: Env,
  context: AgentInferenceLogContext,
  defer: WorkDeferral = runtimeDeferral,
): AgentInferenceLogger {
  let firstProviderRequest = true;
  return {
    onRequest: (request) => {
      const providerRequestIssuedAt = Date.now();
      const measureInferenceStart = firstProviderRequest
        && context.inferenceStartEligible !== false
        && context.requestReceivedAt !== undefined;
      firstProviderRequest = false;
      const requestToInferenceStartMs = measureInferenceStart
        && providerRequestIssuedAt >= context.requestReceivedAt!
        ? providerRequestIssuedAt - context.requestReceivedAt!
        : undefined;
      if (measureInferenceStart) {
        logStructuredEvent(env, "info", "agent_inference_started", {
          request_id: context.requestId,
          inference_request_id: request.inferenceRequestId,
          operation_id: context.operationId,
          journey: context.journey,
          request_received_at: context.requestReceivedAt,
          provider_request_issued_at: providerRequestIssuedAt,
          request_to_inference_start_ms: requestToInferenceStartMs,
          request_clock_skewed: requestToInferenceStartMs === undefined,
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          substream_id: context.workstreamId ? context.substreamId ?? "0" : undefined,
          source: context.source,
          provider: request.provider,
          model: request.model,
        });
      }
      const captureContext: AgentInferenceLogContext = { ...context };
      if (!measureInferenceStart) delete captureContext.requestReceivedAt;
      defer(captureStreamingInferenceRequest(env, captureContext, request, providerRequestIssuedAt));
      return Promise.resolve();
    },
    onAttempt: (attempt) => {
      defer(captureStreamingInferenceAttempt(env, context, attempt));
      if (context.usage) {
        emitInferenceUsage(env, defer, {
          eventId: `inf:${attempt.inferenceRequestId}`,
          workspaceId: context.workspaceId,
          // A compaction summary runs through the same routed turn, under a
          // turn ID the harness marks as compaction.
          activity: attempt.turnId.includes(":compaction:") ? "context_compaction" : context.usage.activity,
          costCents: attempt.costCents,
          model: attempt.model,
          refs: {
            ...(context.userId ? { userId: context.userId } : {}),
            ...(context.workstreamId ? { workstreamId: context.workstreamId, substreamId: context.substreamId ?? "0" } : {}),
            ...(context.usage.sidekickId ? { sidekickId: context.usage.sidekickId } : {}),
          },
        });
      }
      if (!attempt.success && attempt.disposition !== "cancelled") {
        logStructuredEvent(env, "warn", "agent_inference_attempt_failed", {
          request_id: context.requestId,
          inference_request_id: attempt.inferenceRequestId,
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          substream_id: context.workstreamId ? context.substreamId ?? "0" : undefined,
          source: context.source,
          provider: attempt.provider,
          model: attempt.model,
          turn_id: attempt.turnId,
          disposition: attempt.disposition,
          failure_kind: attempt.failureKind,
          latency_ms: attempt.latencyMs,
          fallback_attempt: attempt.cursor.stageIndex,
          attempt: attempt.cursor.endpointAttempt,
          provider_error_code: attempt.providerError?.code,
          provider_error_provider: attempt.providerError?.providerName,
          // `detail`, not `message`: the logger reserves `message` for the row
          // summary it derives, and this is an opaque provider string.
          provider_error_detail: attempt.providerError?.detail,
        });
      }
      return Promise.resolve();
    },
  };
}
