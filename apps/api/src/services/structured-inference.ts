import {
  OpenRouterClient,
  type EmbeddingDiagnostic,
  type EmbeddingResult,
  type ModelMessage,
  type StructuredModelDiagnostic,
} from "@rally/agent-harness";
import type { Env } from "../env";
import { createDeadline } from "../lib/deadline";
import { logStructuredEvent } from "../observability/logger";
import {
  AGENT_MODEL_FLAG_KEYS,
  resolveAgentModelRouting,
  type AgentModelFlagContext,
  type AgentModelRole,
} from "./agent-model-flags";
import { captureStructuredInferenceDiagnostic } from "./inference-lakehouse";

const STRUCTURED_INFERENCE_TIMEOUT_MS = 2 * 60_000;
export const MEMORY_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b" as const;
const MEMORY_EMBEDDING_FEATURE = "memory_embedding";

type StructuredInferenceRole = Extract<
  AgentModelRole,
  | "workstream"
  | "work_opportunity_admission"
  | "work_opportunity_ranking"
  | "workstream_description"
  | "workstream_naming"
  | "automation_result_disposition"
>;

export async function runEmbeddingInference(
  env: Env,
  input: {
    context: {
      workspaceId: string;
      workstreamId?: string;
      substreamId?: string;
      userId?: string;
    };
    text: string;
    inputType: "search_query" | "search_document";
    dimensions: number;
    generationName: string;
    harnessRunId?: string;
    requestId?: string;
    executionPrincipalType?: "user" | "workspace";
    executionPrincipalId?: string;
    signal?: AbortSignal;
  },
): Promise<EmbeddingResult> {
  const substreamId = input.context.workstreamId
    ? input.context.substreamId ?? "0"
    : undefined;
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: MEMORY_EMBEDDING_MODEL,
    fallbackModels: [],
    appName: "Rally",
    traceContext: {
      source: MEMORY_EMBEDDING_FEATURE,
      feature: MEMORY_EMBEDDING_FEATURE,
      region: env.AVALON_REGION,
      environment: env.APP_ENV,
      ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.workstreamId && substreamId
        ? { workstreamId: input.context.workstreamId, substreamId }
        : {}),
      ...(input.context.userId ? { contextUserId: input.context.userId } : {}),
      ...(input.harnessRunId ? { harnessRunId: input.harnessRunId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.executionPrincipalType
        ? { executionPrincipalType: input.executionPrincipalType }
        : {}),
      ...(input.executionPrincipalId
        ? { executionPrincipalId: input.executionPrincipalId }
        : {}),
    },
  });
  const deadline = createDeadline(STRUCTURED_INFERENCE_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline.signal])
    : deadline.signal;
  const onDiagnostic = (diagnostic: EmbeddingDiagnostic): void => {
    const sessionId = input.context.workstreamId
      ? `${input.context.workstreamId}-${substreamId}`
      : undefined;
    logStructuredEvent(
      env,
      diagnostic.success ? "info" : "warn",
      "embedding_inference",
      {
        workspace_id: input.context.workspaceId,
        user_id: input.context.workspaceId,
        context_user_id: input.context.userId,
        workstream_id: input.context.workstreamId,
        substream_id: substreamId,
        trace_id: input.requestId ?? input.harnessRunId ?? diagnostic.inferenceRequestId,
        session_id: sessionId,
        inference_request_id: diagnostic.inferenceRequestId,
        source: MEMORY_EMBEDDING_FEATURE,
        feature: MEMORY_EMBEDDING_FEATURE,
        input_type: input.inputType,
        provider: "openrouter",
        intended_model: diagnostic.intendedModel,
        requested_model: diagnostic.requestedModel,
        model: diagnostic.resolvedModel,
        fallback_attempt: diagnostic.fallbackAttempt,
        endpoint_attempt: diagnostic.attempt,
        latency_ms: diagnostic.latencyMs,
        success: diagnostic.success,
        failure_kind: diagnostic.failureKind,
      },
    );
  };
  try {
    return await client.embed({
      input: input.text,
      inputType: input.inputType,
      dimensions: input.dimensions,
      generationName: input.generationName,
      signal,
      onDiagnostic,
    });
  } finally {
    deadline.dispose();
  }
}

export async function runStructuredInference<T>(
  env: Env,
  input: {
    role: StructuredInferenceRole;
    context: AgentModelFlagContext;
    messages: ModelMessage[];
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T;
    /**
     * `"none"` asks the provider to switch reasoning off rather than leaving it
     * to the model's default, which differs by model — a mechanical one-turn
     * role would otherwise start paying for thinking the first time a flag
     * retargets it at a model that reasons unless told not to.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high";
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
  },
): Promise<{ result: T; model: string }> {
  const routing = await resolveAgentModelRouting(env, input.role, input.context);
  input.onModelResolved?.(routing.model);
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: routing.model,
    fallbackModels: routing.fallbackModels,
    appName: "Rally",
    traceContext: {
      source: input.role,
      feature: AGENT_MODEL_FLAG_KEYS[input.role],
      region: env.AVALON_REGION,
      environment: env.APP_ENV,
      ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
      ...(input.context.userId ? { contextUserId: input.context.userId } : {}),
    },
  });
  // Most callers are queue consumers and Workflow steps, whose invocation ends
  // when this returns. An `AbortSignal.timeout` would stay armed for the rest of
  // its two-minute window and hold that invocation open; the deadline is
  // disposed once the call settles instead. See `lib/deadline.ts`.
  const deadline = createDeadline(STRUCTURED_INFERENCE_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline.signal])
    : deadline.signal;
  const onDiagnostic = async (diagnostic: StructuredModelDiagnostic): Promise<void> => {
    logStructuredEvent(
      env,
      diagnostic.validationIssues || diagnostic.failureKind ? "warn" : "info",
      "structured_inference",
      {
        workspace_id: input.context.workspaceId,
        user_id: input.context.workspaceId,
        context_user_id: input.context.userId,
        workstream_id: input.context.workstreamId,
        substream_id: input.context.workstreamId ? "0" : undefined,
        session_id: input.context.workstreamId
          ? `${input.context.workstreamId}-0`
          : undefined,
        trace_id: diagnostic.traceId,
        inference_request_id: diagnostic.inferenceRequestId,
        role: input.role,
        feature: AGENT_MODEL_FLAG_KEYS[input.role],
        stage: diagnostic.stage,
        schema_name: diagnostic.schemaName,
        provider: "openrouter",
        intended_model: routing.model,
        model: diagnostic.model,
        attempt: diagnostic.attempt,
        fallback_attempt: diagnostic.fallbackAttempt,
        repair_attempt: diagnostic.repairAttempt,
        latency_ms: diagnostic.latencyMs,
        response_bytes: diagnostic.responseBytes,
        input_tokens: diagnostic.inputTokens,
        output_tokens: diagnostic.outputTokens,
        success: diagnostic.success,
        failure_kind: diagnostic.failureKind,
        provider_error_code: diagnostic.providerError?.code,
        provider_error_provider: diagnostic.providerError?.providerName,
        validation_issues: diagnostic.validationIssues,
      },
    );
    await captureStructuredInferenceDiagnostic(env, {
      source: input.role,
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.userId ? { userId: input.context.userId } : {}),
      ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
      ...(diagnostic.traceId ? { traceId: diagnostic.traceId } : {}),
    }, diagnostic);
  };
  try {
    const result = await client.structured({
      messages: input.messages,
      schemaName: input.schemaName,
      jsonSchema: input.jsonSchema,
      parse: input.parse,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      signal,
      onDiagnostic,
    });
    return { result, model: routing.model };
  } finally {
    deadline.dispose();
  }
}
