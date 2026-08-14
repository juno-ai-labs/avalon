import type {
  InferenceAttemptEvent,
  InferenceRequestEvent,
} from "@avalon/agent-harness";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logStructuredEvent } from "../observability/logger";

type AgentInferenceSource = "workstream" | "automation_compiler" | "inline_child" | "hypersight" | "meeting_notes";

export interface AgentInferenceLogContext {
  workspaceId: string;
  requestId: string;
  draftId?: string;
  source: AgentInferenceSource;
  workstreamId?: string;
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
  // Capture is unconditional: the ledger is the compliance record of what every
  // model was asked, so there is no workspace preference to read and no path
  // through here that skips the write. Whether a captured payload may then be
  // used to improve the platform is a separate consent question, answered later
  // from `workspace_improvement_sharing_periods` — see
  // `docs/inference-payload-logging.md`.
  return {
    onRequest: (request) => bestEffort(env, context, "request", request.inferenceRequestId, async () => {
      const createdAt = new Date().toISOString();
      const objectKey = inferenceObjectKey(context, request.inferenceRequestId, createdAt);
      const metadata = {
        inferenceRequestId: request.inferenceRequestId,
        requestId: context.requestId,
        ...(context.draftId ? { draftId: context.draftId } : {}),
        ...(context.parentRequestId ? { parentRequestId: context.parentRequestId } : {}),
        workspaceId: context.workspaceId,
        ...(context.workstreamId ? { workstreamId: context.workstreamId } : {}),
        source: context.source,
        turnId: request.turnId,
        provider: request.provider,
        model: request.model,
        providerInvocationModel: request.providerInvocationModel,
        cursor: request.cursor,
        messageCount: request.payload.messages.length,
        toolCount: request.payload.tools?.length ?? 0,
        createdAt,
      };
      const serialized = JSON.stringify({ metadata, request: request.payload });
      const payloadBytes = new TextEncoder().encode(serialized).byteLength;
      const payloadSha256 = await sha256(serialized);

      await env.PAYLOADS.put(objectKey, serialized, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          workspaceId: context.workspaceId,
          requestId: context.requestId,
          ...(context.draftId ? { draftId: context.draftId } : {}),
          inferenceRequestId: request.inferenceRequestId,
          source: context.source,
        },
      });

      try {
        await env.DB.prepare(
          `INSERT INTO agent_inference_payload_logs
           (id, workspace_id, request_id, parent_request_id, workstream_id, turn_id,
            source, provider, model, provider_model, metadata_json, object_key,
            payload_sha256, payload_bytes, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
        ).bind(
          request.inferenceRequestId,
          context.workspaceId,
          context.requestId,
          context.parentRequestId ?? null,
          context.workstreamId ?? null,
          request.turnId,
          context.source,
          request.provider,
          request.model,
          request.providerInvocationModel,
          JSON.stringify(metadata),
          objectKey,
          payloadSha256,
          payloadBytes,
          createdAt,
        ).run();
      } catch (error) {
        await env.PAYLOADS.delete(objectKey).catch(() => undefined);
        throw error;
      }

      logStructuredEvent(env, "info", "agent_inference_payload_logged", {
        request_id: context.requestId,
        draft_id: context.draftId,
        inference_request_id: request.inferenceRequestId,
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        source: context.source,
        provider: request.provider,
        model: request.model,
        object_key: objectKey,
        payload_bytes: payloadBytes,
        payload_sha256: payloadSha256,
      });
    }),
    onAttempt: (attempt) => bestEffort(env, context, "attempt", attempt.inferenceRequestId, async () => {
      // A provider rejection is an operational event rather than payload
      // capture, so it is a structured log line as well as a ledger update: the
      // ledger row exists only once a request was built, and a rejection is
      // worth seeing in Workers Logs without a D1 read.
      if (!attempt.success && attempt.disposition !== "cancelled") {
        logStructuredEvent(env, "warn", "agent_inference_attempt_failed", {
          request_id: context.requestId,
          inference_request_id: attempt.inferenceRequestId,
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
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
        });
      }
      const completedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE agent_inference_payload_logs
            SET outcome = ?1,
                failure_classification = ?2,
                latency_ms = ?3,
                ttft_ms = ?4,
                input_tokens = ?5,
                output_tokens = ?6,
                context_tokens = ?7,
                reasoning_tokens = ?8,
                cached_tokens = ?9,
                cost_microusd = ?10,
                response_bytes = ?11,
                completed_at = ?12
          WHERE id = ?13 AND workspace_id = ?14`,
      ).bind(
        attempt.disposition ?? (attempt.success ? "success" : "failed"),
        attempt.failureKind ?? null,
        attempt.latencyMs,
        attempt.ttftMs ?? null,
        attempt.inputTokens ?? null,
        attempt.outputTokens ?? null,
        attempt.inputTokens == null || attempt.outputTokens == null
          ? null
          : attempt.inputTokens + attempt.outputTokens,
        attempt.reasoningTokens ?? null,
        attempt.cachedInputTokens ?? null,
        attempt.costCents == null ? null : Math.max(0, Math.round(attempt.costCents * 10_000)),
        attempt.responseBytes ?? null,
        completedAt,
        attempt.inferenceRequestId,
        context.workspaceId,
      ).run();
    }),
  };
}

function inferenceObjectKey(
  context: AgentInferenceLogContext,
  inferenceRequestId: string,
  createdAt: string,
): string {
  const day = createdAt.slice(0, 10);
  return `agent-inference/${context.workspaceId}/${day}/${inferenceRequestId}.json`;
}

async function bestEffort(
  env: Env,
  context: AgentInferenceLogContext,
  phase: "request" | "attempt",
  inferenceRequestId: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logStructuredEvent(env, "warn", "agent_inference_payload_log_failed", {
      request_id: context.requestId,
      draft_id: context.draftId,
      inference_request_id: inferenceRequestId,
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      source: context.source,
      phase,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
