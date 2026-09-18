import type {
  InferenceAttemptEvent,
  InferenceRequestEvent,
} from "@rally/agent-harness";
import type { Env } from "../env";
import { runtimeDeferral, type WorkDeferral } from "../lib/defer";
import { logStructuredEvent } from "../observability/logger";
import {
  captureStreamingInferenceAttempt,
  captureStreamingInferenceRequest,
} from "./inference-lakehouse";

type AgentInferenceSource = "workstream" | "inline_child";

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
}

export interface AgentInferenceLogger {
  onRequest(request: InferenceRequestEvent): Promise<void>;
  onAttempt(attempt: InferenceAttemptEvent): Promise<void>;
}

export function logAgentInferencePrepared(
  env: Env,
  context: AgentInferenceLogContext,
  timing: {
    runStartedAtMs: number;
    initialAuthorityReadyAtMs: number;
    harnessInputsReadyAtMs: number;
    preparationFinishedAtMs: number;
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
