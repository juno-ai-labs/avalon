import {
  OpenRouterClient,
  type EmbeddingDiagnostic,
  type EmbeddingResult,
  type ModelMessage,
  type StructuredModelDiagnostic,
} from "@rally/agent-harness";
import { type AgentModelRouting } from "@rally/contracts";
import type { Env } from "../env";
import { createDeadline } from "../lib/deadline";
import { runtimeDeferral, type WorkDeferral } from "../lib/defer";
import { logStructuredEvent } from "../observability/logger";
import {
  AGENT_MODEL_FLAG_KEYS,
  resolveAgentModelRouting,
  type AgentModelFlagContext,
  type AgentModelRole,
} from "./agent-model-flags";
import { captureStructuredInferenceDiagnostic } from "./inference-lakehouse";
import { emitInferenceUsage } from "./usage-metering";
import type { MeteredActivity } from "@rally/contracts/usage";

const STRUCTURED_INFERENCE_TIMEOUT_MS = 2 * 60_000;
/**
 * Text search's embedding model. The name is the history: it was chosen for
 * durable memory, whose vectors are gone, and it stays byte-identical because
 * the Turbopuffer namespace is hashed from it (`text-search.ts`).
 */
export const MEMORY_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b" as const;
/** Provider capitalization is not a change of embedding space. */
export function isMemoryEmbeddingModel(model: string): boolean {
  // OpenRouter returns Qwen/Qwen3-Embedding-8B for the canonical routing slug.
  return model.toLowerCase() === MEMORY_EMBEDDING_MODEL;
}

type StructuredInferenceRole = Extract<
  AgentModelRole,
  | "workstream"
  | "work_opportunity_admission"
  | "work_opportunity_ranking"
  | "workstream_description"
  | "workstream_naming"
  | "suggestion_draft"
  | "memory_sweep"
>;

type StructuredInferenceSource = StructuredInferenceRole;

function structuredInferenceFeature(source: StructuredInferenceSource): string {
  return AGENT_MODEL_FLAG_KEYS[source];
}

export async function runEmbeddingInference(
  env: Env,
  input: {
    context: {
      workspaceId: string;
      workstreamId?: string;
      substreamId?: string;
      userId?: string;
    };
    text: string | string[];
    feature: "search_embedding";
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
  const feature = input.feature;
  const substreamId = input.context.workstreamId
    ? input.context.substreamId ?? "0"
    : undefined;
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: MEMORY_EMBEDDING_MODEL,
    fallbackModels: [],
    appName: "Rally",
    traceContext: {
      source: feature,
      feature,
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
        source: feature,
        feature,
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
        provider_error_code: diagnostic.providerError?.code,
        provider_error_provider: diagnostic.providerError?.providerName,
        provider_error_detail: diagnostic.providerError?.detail,
      },
    );
  };
  try {
    const result = await client.embed({
      input: input.text,
      inputType: input.inputType,
      dimensions: input.dimensions,
      generationName: input.generationName,
      signal,
      onDiagnostic,
    });
    const costUsd = result.usage?.cost;
    emitInferenceUsage(env, runtimeDeferral, {
      eventId: `inf:${result.inferenceRequestId}`,
      workspaceId: input.context.workspaceId,
      activity: feature,
      costCents: costUsd === undefined ? undefined : costUsd * 100,
      model: result.resolvedModel,
      refs: {
        ...(input.context.userId ? { userId: input.context.userId } : {}),
        ...(input.context.workstreamId && substreamId ? { workstreamId: input.context.workstreamId, substreamId } : {}),
      },
    });
    return result;
  } finally {
    deadline.dispose();
  }
}

export async function runStructuredInference<T>(
  env: Env,
  input: {
    context: AgentModelFlagContext & { substreamId?: string };
    /** A persisted route bypasses current Flagship targeting and fallback defaults. */
    routing?: AgentModelRouting;
    requestId?: string;
    messages: ModelMessage[];
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T;
    /**
     * `"none"` asks the provider to switch reasoning off. Omission accepts
     * Rally's canonical-model default when one exists, then the provider
     * default. Mechanical one-turn roles should pass `"none"` explicitly.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high";
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
    /** Owning lifecycle override for exact-envelope archive work. */
    defer?: WorkDeferral;
    /** What this call is metered as. See docs/usage-metering.md. */
    activity: MeteredActivity;
    role: StructuredInferenceRole;
  },
): Promise<{
  result: T;
  model: string;
  requestedModel: string;
  resolvedModel: string;
  inputTokens: number | null;
  outputTokens: number | null;
}> {
  const routing = await resolveAgentModelRouting(env, input.role, input.context);
  const feature = structuredInferenceFeature(input.role);
  const substreamId = input.context.workstreamId
    ? input.context.substreamId ?? "0"
    : undefined;
  input.onModelResolved?.(routing.model);
  const completion: { diagnostic?: StructuredModelDiagnostic } = {};
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: routing.model,
    fallbackModels: routing.fallbackModels,
    appName: "Rally",
    traceContext: {
      source: input.role,
      feature,
      region: env.AVALON_REGION,
      environment: env.APP_ENV,
      ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
      ...(substreamId ? { substreamId } : {}),
      ...(input.context.userId ? { contextUserId: input.context.userId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
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
  const onDiagnostic = (diagnostic: StructuredModelDiagnostic): void => {
    logStructuredEvent(
      env,
      diagnostic.validationIssues || diagnostic.failureKind ? "warn" : "info",
      "structured_inference",
      {
        workspace_id: input.context.workspaceId,
        user_id: input.context.workspaceId,
        context_user_id: input.context.userId,
        workstream_id: input.context.workstreamId,
        substream_id: substreamId,
        session_id: input.context.workstreamId
          ? `${input.context.workstreamId}-${substreamId}`
          : undefined,
        trace_id: diagnostic.traceId,
        inference_request_id: diagnostic.inferenceRequestId,
        role: input.role,
        feature,
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
        provider_error_detail: diagnostic.providerError?.detail,
        validation_issues: diagnostic.validationIssues,
      },
    );
    (input.defer ?? runtimeDeferral)(captureStructuredInferenceDiagnostic(env, {
      source: input.role,
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.userId ? { userId: input.context.userId } : {}),
      ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
      ...(substreamId ? { substreamId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(diagnostic.traceId ? { traceId: diagnostic.traceId } : {}),
    }, diagnostic));
    if (diagnostic.stage === "complete" && input.context.workspaceId && diagnostic.inferenceRequestId) {
      emitInferenceUsage(env, input.defer ?? runtimeDeferral, {
        eventId: `inf:${diagnostic.inferenceRequestId}`,
        workspaceId: input.context.workspaceId,
        activity: input.activity,
        costCents: diagnostic.costCents,
        model: diagnostic.model,
        refs: {
          ...(input.context.userId ? { userId: input.context.userId } : {}),
          ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
          ...(substreamId ? { substreamId } : {}),
        },
      });
    }
    if (diagnostic.stage === "complete" && diagnostic.success) completion.diagnostic = diagnostic;
  };
  const reasoningEffort = input.reasoningEffort ?? routing.reasoningEffort;
  try {
    const result = await client.structured({
      messages: input.messages,
      schemaName: input.schemaName,
      jsonSchema: input.jsonSchema,
      parse: input.parse,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      signal,
      onDiagnostic,
    });
    const diagnostic = completion.diagnostic;
    const providerModel = diagnostic?.responsePayload?.model;
    const requestedModel = diagnostic?.model ?? routing.model;
    return {
      result,
      model: routing.model,
      requestedModel,
      resolvedModel: typeof providerModel === "string" && providerModel.length > 0
        ? providerModel : requestedModel,
      inputTokens: diagnostic?.inputTokens ?? null,
      outputTokens: diagnostic?.outputTokens ?? null,
    };
  } finally {
    deadline.dispose();
  }
}
