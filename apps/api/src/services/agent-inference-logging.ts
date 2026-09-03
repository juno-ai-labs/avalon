import type {
  InferenceAttemptEvent,
  InferenceRequestEvent,
} from "@rally/agent-harness";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import {
  captureStreamingInferenceAttempt,
  captureStreamingInferenceRequest,
} from "./inference-lakehouse";

type AgentInferenceSource = "workstream" | "inline_child" | "meeting_notes";

export interface AgentInferenceLogContext {
  workspaceId: string;
  userId?: string;
  requestId: string;
  draftId?: string;
  source: AgentInferenceSource;
  workstreamId?: string;
  substreamId?: string;
  parentRequestId?: string;
}

export interface AgentInferenceLogger {
  onRequest(request: InferenceRequestEvent): Promise<void>;
  onAttempt(attempt: InferenceAttemptEvent): Promise<void>;
}

export function createAgentInferenceLogger(
  env: Env,
  context: AgentInferenceLogContext,
): AgentInferenceLogger {
  return {
    onRequest: (request) => captureStreamingInferenceRequest(env, context, request),
    onAttempt: async (attempt) => {
      await captureStreamingInferenceAttempt(env, context, attempt);
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
    },
  };
}
