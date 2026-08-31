import type {
  AddressingClassification,
  AutomationPluginActivity,
  AutomationPluginIcon,
  AutomationDraft,
  AutomationSetEvaluatorRulesInputV1,
  ConnectorActivityTriggerDescriptor,
  ExecutionPrincipal,
  HarnessFailureCode,
  StructuredFailureDetail,
  ToolDefinition
} from "@rally/contracts";
import {
  AGENT_MODEL_FLAG_KEYS,
  AddressingClassificationSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  AutomationDraftSchema,
  asUserId
} from "@rally/contracts";
import { AzureInferenceEndpointSchema } from "@rally/contracts/url-schemas";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { createStreamWatchdog } from "@juno-ai/bind/completion";
import { chatRequestToJSON } from "@openrouter/sdk/models/chatrequest.js";
import { chatResultFromJSON } from "@openrouter/sdk/models/chatresult.js";
import { chatStreamChunkFromJSON } from "@openrouter/sdk/models/chatstreamchunk.js";
import {
  createEmbeddingsRequestBodyToJSON,
  createEmbeddingsResponseFromJSON,
} from "@openrouter/sdk/models/operations/createembeddings.js";
import type { ChatMessages } from "@openrouter/sdk/models/chatmessages.js";
import type { ChatRequest as OpenRouterChatRequest } from "@openrouter/sdk/models/chatrequest.js";
import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ChatStreamChunk } from "@openrouter/sdk/models/chatstreamchunk.js";
import type { ChatUsage } from "@openrouter/sdk/models/chatusage.js";
import type { OpenRouterMetadata } from "@openrouter/sdk/models/openroutermetadata.js";
import { z } from "zod";
// Cycle: `bind-runtime` imports back from this module. Sound because every
// value it takes is read inside a function body — see `runHarness` below.
import { runHarnessWithBind } from "./bind-runtime";
import {
  renderAddressingMessages,
  renderAutomationCompilerMessages,
  type AddressingContextMessage,
} from "./prompts";
import { toolActivityName } from "./tool-activity";
import type {
  BindLoopProjectionState,
  BindLoopTransition,
  BindProviderBoundary,
} from "./bind-loop-projection";

export * from "./prompts";
export { hasAvalonToolProse, toolActivityName, type ToolActivityStatus } from "./tool-activity";
export {
  applyBindLoopTransition,
  bindLoopMessageChain,
  bindLoopNonSystemMessageCount,
  bindLoopNonSystemMessages,
  BIND_LOOP_PROJECTOR_VERSION,
  BIND_SYSTEM_RENDERER_VERSION,
  canonicalizeBindLoop,
  hashBindLoop,
  pendingBindToolBatch,
  projectBindLoopMessages,
  verifyBindProviderBoundary,
  type BindLoopMessage,
  type BindLoopMessageOrigin,
  type BindLoopMessageNode,
  type BindLoopProjectionState,
  type BindLoopTransition,
  type BindProviderBoundary,
  type PendingBindToolBatch,
  type PendingBindToolCall,
  type BindSystemProjection,
} from "./bind-loop-projection";
export {
  nonObjectRootUnionBranches,
  readableRootUnionBranch,
  repairRootUnionForProviders,
  weakenedCompositionBranches,
} from "./tool-schema-safety";
export {
  BUILT_IN_SKILLS,
  DEEP_RESEARCH_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  WRITING_AN_EMAIL_SKILL,
} from "./built-in-skills";
export {
  AVALON_SKILLS_PLUGIN_ID,
  AVALON_SKILLS_SYSTEM_MESSAGE,
  AVALON_SKILL_TOOL_DEFINITIONS,
  createSkillRuntime,
  type SkillRuntime,
} from "./skills";
export { parseSkillMarkdown, type SkillSummary } from "@juno-ai/bind/skills";
export {
  admitChildRun,
  descendChain,
  rootChain,
  type ChainRef,
  type ChainRule,
  type ChildAdmission,
} from "@juno-ai/bind/run";

export interface OpenRouterConfig {
  apiKey: string;
  primaryModel: string;
  fallbackModels?: string[];
  /** Additional attempts on one model for transport failures before fallback. */
  sameModelRetries?: number;
  appUrl?: string;
  appName?: string;
  fetch?: typeof globalThis.fetch;
  /** Maximum time to establish an HTTP response from OpenRouter. */
  requestEstablishmentTimeoutMs?: number;
  /** Maximum time from response establishment to the first answer/tool bytes. */
  ttftTimeoutMs?: number;
  /** Maximum silence between streamed answer/tool bytes. */
  streamIdleTimeoutMs?: number;
  /** Opaque request ownership and deployment data forwarded to OpenRouter Broadcast. */
  traceContext?: OpenRouterTraceContext;
  /** Optional Azure OpenAI-compatible transport used by Bind's provider router. */
  azure?: AzureOpenAIConfig;
}

export interface AzureOpenAIConfig {
  /** Azure AI resource endpoint; the harness appends `/openai/v1/chat/completions`. */
  endpoint: string;
  apiKey: string;
}

/** Shared freshness horizon for OpenRouter catalog-derived metadata. */
export const OPENROUTER_CATALOG_CACHE_TTL_MS = 60 * 60 * 1_000;

/** One host-resolved token-rate tier Bind can use to bill an Azure attempt. */
export interface AzureModelTokenRates {
  inputUsdPerM: number;
  cachedInputUsdPerM: number;
  outputUsdPerM: number;
}

export interface AzureModelPricingOverride extends AzureModelTokenRates {
  /** OpenRouter applies this tier when total prompt tokens reach this value. */
  minPromptTokens: number;
}

/** Host-resolved base and long-context token rates for an Azure route candidate. */
export interface AzureModelPricing extends AzureModelTokenRates {
  overrides: readonly AzureModelPricingOverride[];
  /** Stable, secret-free identity of the source endpoint inventory and rates. */
  sourceFingerprint: string;
}

export interface OpenRouterTraceContext {
  source: string;
  /** Flagship model-routing key for this inference category. */
  feature: string;
  workspaceId?: string;
  workstreamId?: string;
  substreamId?: string;
  /** Person relevant to this inference, kept separate from the workspace-level Broadcast identity. */
  contextUserId?: string;
  requestId?: string;
  parentRequestId?: string;
  harnessRunId?: string;
  draftId?: string;
  region?: string;
  environment?: string;
  buildSha?: string;
  executionPrincipalType?: "user" | "workspace";
  executionPrincipalId?: string;
}

export interface OpenRouterTracePayload {
  user?: string;
  session_id?: string;
  trace: {
    trace_id: string;
    trace_name: string;
    span_name: string;
    generation_name: string;
    [key: string]: string | number;
  };
}

export function buildOpenRouterTracePayload(
  context: OpenRouterTraceContext,
  request: {
    inferenceRequestId: string;
    generationName: string;
    turnId?: string;
    cursor?: InferenceRequestEvent["cursor"];
    provider?: string;
    /** Primary model selected by Rally before retry or fallback traversal. */
    intendedModel?: string;
    model?: string;
    providerInvocationModel?: string;
  },
): OpenRouterTracePayload {
  const substreamId = context.substreamId ?? (context.workstreamId ? "0" : undefined);
  const traceId = context.requestId ?? context.harnessRunId ?? request.inferenceRequestId;
  const sessionId = context.workstreamId
    ? `${context.workstreamId}-${substreamId ?? "0"}`
    : undefined;
  // A replay of the same durable turn must re-send the same provider body so
  // OpenRouter can retain the cached prefix. The cursor distinguishes retry
  // and fallback positions inside that durable request; the random diagnostic
  // id remains available in Rally's regional telemetry for each HTTP attempt.
  const providerRequestId = context.requestId && request.turnId
    ? [
        context.requestId,
        request.turnId,
        request.cursor?.structuredOutputAttempt ?? 0,
        request.cursor?.stageIndex ?? 0,
        request.cursor?.candidateIndex ?? 0,
        request.cursor?.endpointAttempt ?? 0,
      ].join(":")
    : request.inferenceRequestId;
  const additional: Record<string, string | number> = {
    inference_request_id: providerRequestId,
    source: context.source,
    feature: context.feature,
    product: "rally",
    invocation_type: request.turnId ? "streaming" : "structured",
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.intendedModel ? { intended_model: request.intendedModel } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.providerInvocationModel
      ? { provider_invocation_model: request.providerInvocationModel }
      : {}),
    ...(context.workspaceId ? { workspace_id: context.workspaceId } : {}),
    ...(context.workstreamId ? { workstream_id: context.workstreamId } : {}),
    ...(substreamId ? { substream_id: substreamId } : {}),
    ...(context.workspaceId ? { user_id: context.workspaceId } : {}),
    ...(context.contextUserId ? { context_user_id: context.contextUserId } : {}),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.parentRequestId ? { parent_request_id: context.parentRequestId } : {}),
    ...(context.harnessRunId ? { harness_run_id: context.harnessRunId } : {}),
    ...(context.draftId ? { draft_id: context.draftId } : {}),
    ...(context.region ? { region: context.region } : {}),
    ...(context.environment ? { environment: context.environment } : {}),
    ...(context.buildSha ? { build_sha: context.buildSha } : {}),
    ...(context.executionPrincipalType
      ? { execution_principal_type: context.executionPrincipalType }
      : {}),
    ...(context.executionPrincipalId
      ? { execution_principal_id: context.executionPrincipalId }
      : {}),
    ...(request.turnId ? { turn_id: request.turnId } : {}),
    ...(request.cursor ? {
      structured_output_attempt: request.cursor.structuredOutputAttempt,
      route_stage_index: request.cursor.stageIndex,
      route_candidate_index: request.cursor.candidateIndex,
      endpoint_attempt: request.cursor.endpointAttempt,
    } : {}),
  };
  return {
    ...(context.workspaceId ? { user: context.workspaceId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    trace: {
      trace_id: traceId,
      trace_name: `rally.${context.source}`,
      span_name: request.turnId
        ? `rally.turn.${request.turnId}`
        : `rally.structured.${request.generationName}`,
      generation_name: request.generationName,
      ...additional,
    },
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
  /** Durable source of an exact model-facing wrapper; never sent to a provider. */
  provenance?: ModelMessageProvenance;
}

/**
 * Remove host-only provenance before a model message crosses into Bind's
 * persisted/provider-facing protocol. Constructing the value explicitly keeps
 * that boundary typed and prevents a newly added wire field from leaking by
 * object spread.
 */
export function modelMessageWithoutProvenance(
  message: ModelMessage,
): Readonly<Record<string, unknown>> {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
  };
}

export interface ModelMessageProvenance {
  originKind: "canonical" | "protocol" | "derived";
  sourceKind: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
}

/**
 * A model-only user input owned by one logical activation, not by the
 * participant transcript. The stable identity lets the durable host converge
 * recovery/takeover without comparing message structure or tying admission to
 * a particular execution attempt.
 */
export interface HarnessActivationInput {
  activationInputId: string;
  message: ModelMessage & {
    role: "user";
    provenance: ModelMessageProvenance & {
      originKind: "derived";
      sourceKind: string;
      sourceId: string;
    };
  };
}

export interface HarnessActivationBoundaryResult {
  /** Newly committed appends, in exact Bind state-revision order. */
  transitions: readonly Extract<BindLoopTransition, { kind: "protocol_user_appended" }>[];
  /** Inputs durably acknowledged without a new append, including exact receipt replay. */
  replayedActivationInputIds: readonly string[];
}

export interface OpenRouterInferencePayload {
  model: string;
  messages: ModelMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ModelRequestTool[];
  tool_choice?: "auto";
  plugins?: Array<Record<string, unknown>>;
  reasoning?: { effort: "none" | "low" | "medium" | "high" };
  /** Azure's OpenAI-compatible Chat Completions reasoning control. */
  reasoning_effort?: "low" | "medium" | "high";
  user?: string;
  session_id?: string;
  trace?: OpenRouterTracePayload["trace"];
}

export interface InferenceRequestEvent {
  inferenceRequestId: string;
  turnId: string;
  /** Participant transcript slot, when this host has a participant transcript. */
  transcriptSequence?: number;
  model: string;
  providerInvocationModel: string;
  provider: string;
  cursor: {
    structuredOutputAttempt: number;
    stageIndex: number;
    candidateIndex: number;
    endpointAttempt: number;
  };
  payload: OpenRouterInferencePayload;
}

export interface InferenceAttemptEvent {
  inferenceRequestId: string;
  success: boolean;
  turnId: string;
  /** Participant transcript slot, when this host has a participant transcript. */
  transcriptSequence?: number;
  model: string;
  provider: string;
  providerInvocationModel: string;
  cursor: {
    structuredOutputAttempt: number;
    stageIndex: number;
    candidateIndex: number;
    endpointAttempt: number;
  };
  latencyMs: number;
  disposition?: "success" | "retry" | "defect" | "fallback" | "failed" | "cancelled";
  ttftMs?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number | null;
  costCents?: number;
  responseBytes?: number;
  /** The successful provider result before Bind projects it into transcript rows. */
  response?: {
    content: string;
    toolCalls: ModelToolCall[];
    usage: Record<string, number> | null;
    finishReason: string | null;
    generationId: string | null;
    openRouterMetadata?: Record<string, unknown>;
  };
  failureKind?: string;
  /** The provider's own classification of a rejected request, when it gave one. */
  providerError?: OpenRouterProviderError;
}

/**
 * OpenRouter multimodal content. `file` and `input_audio` are upstream
 * extensions that are not yet represented by every OpenAI SDK release.
 */
export type ModelMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

export type ModelMessageContent = string | ModelMessageContentPart[] | null;

/** OpenRouter/OpenAI-compatible wire tool definition used by the shared client. */
export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ModelRequestTool = ModelToolDefinition | {
  type: "openrouter:web_search";
  search_context_size: "medium";
  max_total_results: number;
};

export type StructuredModelDiagnostic = {
  stage: "model_request" | "model_response" | "normalize" | "validate" | "repair" | "complete";
  schemaName: string;
  model: string;
  attempt: number;
  fallbackAttempt: number;
  repairAttempt: number;
  /** Stable for one provider request, including its validation outcome. */
  inferenceRequestId?: string;
  /** Stable across retries, repairs, and fallback models for one structured call. */
  traceId?: string;
  latencyMs?: number;
  responseBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number | null;
  success?: boolean;
  failureKind?: string;
  /** The provider's own classification of a rejected request, when it gave one. */
  providerError?: OpenRouterProviderError;
  validationIssues?: Array<{ path: string; code: string }>;
  /** Exact provider request body. Present only on `model_request`. */
  requestPayload?: Record<string, unknown>;
  /** Exact successful provider response envelope. */
  responsePayload?: Record<string, unknown>;
};

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  messages: ModelMessage[];
  tools?: ModelRequestTool[];
  toolChoice?: "auto" | "none";
  includeWebSearch?: boolean | undefined;
  maxWebResults?: number | undefined;
  plugins?: Array<Record<string, unknown>> | undefined;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  trace?: OpenRouterTracePayload | undefined;
  signal?: AbortSignal | undefined;
}

export interface StreamResult {
  model: string;
  content: string;
  toolCalls: ModelToolCall[];
  usage: Record<string, number> | null;
  finishReason: string | null;
  generationId: string | null;
  ttftMs: number | null;
  responseBytes: number;
  openRouterMetadata: Record<string, unknown> | null;
}

export interface EmbeddingDiagnostic {
  intendedModel: string;
  requestedModel: string;
  resolvedModel?: string;
  attempt: number;
  fallbackAttempt: number;
  inferenceRequestId: string;
  latencyMs: number;
  success: boolean;
  failureKind?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
  intendedModel: string;
  requestedModel: string;
  resolvedModel: string;
  fallbackAttempt: number;
  inferenceRequestId: string;
  usage: Record<string, number> | null;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** A locally invalid request must never be retried or sent to a fallback model. */
export class OpenRouterRequestError extends OpenRouterError {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

export class AzureOpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AzureOpenAIError";
  }
}

/** A locally invalid Azure request must never traverse to another model. */
export class AzureOpenAIRequestError extends AzureOpenAIError {
  constructor(message: string) {
    super(message);
    this.name = "AzureOpenAIRequestError";
  }
}

export class OpenRouterClient {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly config: OpenRouterConfig) {
    if (!config.apiKey) throw new OpenRouterError("OPENROUTER_API_KEY is not configured");
    // Workerd host functions validate their receiver. Bind the selected fetch
    // before storing it on the client so `this.fetcher(...)` cannot invoke the
    // native function with the OpenRouterClient instance as `this`.
    this.fetcher = (config.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /**
   * Generate embeddings through OpenRouter's native endpoint.
   *
   * The embeddings request contract currently accepts Broadcast's workspace
   * identity (`user`) but not the chat endpoint's custom `trace` object. The
   * session is therefore carried in `X-Session-ID`, and the content-free
   * diagnostic reports intended versus requested/resolved models locally.
   */
  async embed(input: {
    input: string | string[];
    inputType?: "search_query" | "search_document";
    dimensions?: number;
    generationName: string;
    signal?: AbortSignal;
    onDiagnostic?: (event: EmbeddingDiagnostic) => void | Promise<void>;
  }): Promise<EmbeddingResult> {
    const intendedModel = this.config.primaryModel;
    const models = uniqueModels([intendedModel, ...(this.config.fallbackModels ?? [])]);
    const expectedCount = typeof input.input === "string" ? 1 : input.input.length;
    let lastError: unknown;
    for (const [fallbackAttempt, requestedModel] of models.entries()) {
      for (let attempt = 0; attempt <= this.sameModelRetries(); attempt += 1) {
        const startedAt = Date.now();
        const inferenceRequestId = crypto.randomUUID();
        try {
          const tracePayload = this.config.traceContext
            ? buildOpenRouterTracePayload(this.config.traceContext, {
                inferenceRequestId,
                generationName: input.generationName,
                provider: "openrouter",
                intendedModel,
                model: requestedModel,
                providerInvocationModel: requestedModel,
              })
            : undefined;
          let requestPayload: Record<string, unknown>;
          try {
            requestPayload = JSON.parse(createEmbeddingsRequestBodyToJSON({
              model: requestedModel,
              input: input.input,
              ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
              encodingFormat: "float",
              ...(input.inputType ? { inputType: input.inputType } : {}),
              ...(tracePayload?.user ? { user: tracePayload.user } : {}),
            })) as Record<string, unknown>;
          } catch {
            throw new OpenRouterRequestError("Invalid OpenRouter embeddings request");
          }
          const response = await this.fetcher("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: this.headers(tracePayload?.session_id),
            body: JSON.stringify(requestPayload),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const payload = await readJsonResponse<Record<string, unknown>>(response);
          if (!response.ok) {
            const providerError = openRouterProviderError(payload);
            throw new OpenRouterError(
              `OpenRouter embeddings request failed (${response.status})`,
              response.status,
              { providerError },
            );
          }
          if (!payload) throw new OpenRouterError("OpenRouter returned no embeddings response");
          const parsed = createEmbeddingsResponseFromJSON(JSON.stringify(payload));
          if (!parsed.ok || typeof parsed.value === "string") {
            throw new OpenRouterError("OpenRouter returned an invalid embeddings response");
          }
          const orderedEntries = [...parsed.value.data].sort(
            (left, right) => (left.index ?? -1) - (right.index ?? -1),
          );
          const indicesAreComplete = orderedEntries.every(
            (entry, index) => entry.index === index,
          );
          const embeddings = orderedEntries.map((entry) => entry.embedding);
          if (
            embeddings.length !== expectedCount
            || !indicesAreComplete
            || embeddings.some((embedding) => !Array.isArray(embedding) || embedding.length === 0)
            || (input.dimensions !== undefined
              && embeddings.some((embedding) => embedding.length !== input.dimensions))
          ) {
            throw new OpenRouterError("OpenRouter returned embeddings with an unexpected shape");
          }
          const normalized = embeddings as number[][];
          const resolvedModel = parsed.value.model;
          await input.onDiagnostic?.({
            intendedModel,
            requestedModel,
            resolvedModel,
            attempt,
            fallbackAttempt,
            inferenceRequestId,
            latencyMs: Date.now() - startedAt,
            success: true,
          });
          return {
            embeddings: normalized,
            intendedModel,
            requestedModel,
            resolvedModel,
            fallbackAttempt,
            inferenceRequestId,
            usage: parsed.value.usage
              ? {
                  prompt_tokens: parsed.value.usage.promptTokens,
                  total_tokens: parsed.value.usage.totalTokens,
                  ...(typeof parsed.value.usage.cost === "number"
                    ? { cost: parsed.value.usage.cost }
                    : {}),
                }
              : null,
          };
        } catch (error) {
          await input.onDiagnostic?.({
            intendedModel,
            requestedModel,
            attempt,
            fallbackAttempt,
            inferenceRequestId,
            latencyMs: Date.now() - startedAt,
            success: false,
            failureKind: structuredFailureKind(error, input.signal),
          });
          if (input.signal?.aborted) throw error;
          const disposition = openRouterFailureDisposition(error);
          if (disposition === "terminal") throw error;
          lastError = error;
          if (disposition === "retry" && attempt < this.sameModelRetries()) continue;
          break;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OpenRouterError("All configured OpenRouter embedding models failed", undefined, lastError);
  }

  async structured<T>(input: {
    messages: ModelMessage[];
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T;
    model?: string;
    /**
     * `"none"` turns reasoning off explicitly rather than leaving it to the
     * model's default, which differs by model: a route change that moves a
     * mechanical one-shot call onto a thinking-by-default model would
     * otherwise start paying for reasoning nobody asked for.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high";
    signal?: AbortSignal | undefined;
    onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  }): Promise<T> {
    const models = uniqueModels(input.model
      ? [input.model]
      : [this.config.primaryModel, ...(this.config.fallbackModels ?? [])]);
    const schemaMessages = withExpectedJsonSchema(
      input.messages,
      input.schemaName,
      input.jsonSchema,
    );
    let lastError: unknown;
    let repaired = false;
    const traceId = this.config.traceContext?.requestId
      ?? this.config.traceContext?.harnessRunId
      ?? crypto.randomUUID();
    const emitDiagnostic = async (event: StructuredModelDiagnostic): Promise<void> => {
      await input.onDiagnostic?.({ ...event, traceId });
    };
    for (const [fallbackAttempt, model] of models.entries()) {
      let repairMessages: ModelMessage[] | null = null;
      let repairAttempt = 0;
      for (let attempt = 0; attempt <= this.sameModelRetries(); attempt += 1) {
        const startedAt = Date.now();
        const inferenceRequestId = crypto.randomUUID();
        let responsePayload: Record<string, unknown> | undefined;
        let responseMetrics: Partial<Pick<
          StructuredModelDiagnostic,
          | "latencyMs"
          | "responseBytes"
          | "inputTokens"
          | "outputTokens"
          | "reasoningTokens"
          | "cachedInputTokens"
        >> | undefined;
        try {
          const builtTracePayload = this.config.traceContext
            ? buildOpenRouterTracePayload(this.config.traceContext, {
                inferenceRequestId,
                generationName: input.schemaName,
                provider: "openrouter",
                intendedModel: input.model ?? this.config.primaryModel,
                model,
                providerInvocationModel: model,
              })
            : undefined;
          const tracePayload = builtTracePayload
            ? {
                ...builtTracePayload,
                trace: { ...builtTracePayload.trace, trace_id: traceId },
              }
            : undefined;
          const requestPayload = serializeOpenRouterChatRequest({
            model,
            messages: repairMessages ?? schemaMessages,
            stream: false,
            responseFormat: {
              type: "json_schema",
              jsonSchema: {
                name: input.schemaName,
                strict: true,
                schema: input.jsonSchema
              }
            },
            plugins: [{ id: "response-healing" }],
            ...(structuredReasoning(input.reasoningEffort)
              ? { reasoning: structuredReasoning(input.reasoningEffort)! }
              : {}),
            ...(tracePayload ? {
              ...(tracePayload.user ? { user: tracePayload.user } : {}),
              ...(tracePayload.session_id ? { sessionId: tracePayload.session_id } : {}),
              trace: toSdkTrace(tracePayload.trace),
            } : {}),
          });
          await emitDiagnostic({
            stage: "model_request",
            schemaName: input.schemaName,
            model,
            attempt,
            fallbackAttempt,
            repairAttempt,
            inferenceRequestId,
            requestPayload,
          });
          const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(requestPayload),
            ...(input.signal ? { signal: input.signal } : {})
          });
          const payload = await readJsonResponse<{
            id?: string;
            model?: string;
            choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
            usage?: Record<string, number>;
            error?: { message?: string };
          }>(response);
          if (!response.ok) {
            throw new OpenRouterError(
              `OpenRouter request failed (${response.status})`,
              response.status,
              // The envelope's classification, not the body: `payload` can carry
              // the provider's echo of the request that was rejected.
              { providerError: openRouterProviderError(payload) }
            );
          }
          const sdkPayload = parseOpenRouterChatResult(payload);
          const sdkContent = sdkPayload?.choices[0]?.message.content;
          const content = typeof sdkContent === "string"
            ? sdkContent
            : payload?.choices?.[0]?.message?.content;
          if (!content) throw new OpenRouterError("OpenRouter returned no structured content");
          responsePayload = payload as Record<string, unknown>;
          const normalizedUsage = sdkPayload?.usage
            ? sdkUsageRecord(sdkPayload.usage)
            : payload?.usage ?? null;
          const inputTokens = providerUsageNumber(normalizedUsage, "prompt_tokens");
          const outputTokens = providerUsageNumber(normalizedUsage, "completion_tokens");
          const reasoningTokens = providerUsageNumber(normalizedUsage, "reasoning_tokens");
          const cachedInputTokens = providerCachedTokens(normalizedUsage);
          responseMetrics = {
            latencyMs: Date.now() - startedAt,
            responseBytes: new TextEncoder().encode(content).byteLength,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
          };
          await emitDiagnostic({
            stage: "model_response",
            schemaName: input.schemaName,
            model,
            attempt,
            fallbackAttempt,
            repairAttempt,
            inferenceRequestId,
            ...(responseMetrics ?? {}),
            ...(responsePayload ? { responsePayload } : {}),
          });
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(content) as unknown;
          } catch {
            if (!repaired) {
              repaired = true;
              repairAttempt = 1;
              const validationIssues = [{ path: "$", code: "invalid_json" }];
              repairMessages = [
                ...schemaMessages,
                {
                  role: "user",
                  content: `Return a corrected response matching the JSON schema. Validation issues: ${JSON.stringify(validationIssues)}`,
                },
              ];
              await emitDiagnostic({
                stage: "repair",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                inferenceRequestId,
                validationIssues,
              });
              attempt -= 1;
              continue;
            }
            throw new OpenRouterError("OpenRouter returned invalid structured JSON");
          }
          await emitDiagnostic({ stage: "normalize", schemaName: input.schemaName, model, attempt, fallbackAttempt, repairAttempt, inferenceRequestId });
          try {
            const parsed = input.parse(parsedJson);
            await emitDiagnostic({ stage: "validate", schemaName: input.schemaName, model, attempt, fallbackAttempt, repairAttempt, inferenceRequestId });
            await emitDiagnostic({
              stage: "complete",
              schemaName: input.schemaName,
              model,
              attempt,
              fallbackAttempt,
              repairAttempt,
              inferenceRequestId,
              success: true,
              ...(responseMetrics ?? {}),
              ...(responsePayload ? { responsePayload } : {}),
            });
            return parsed;
          } catch (error) {
            if (error instanceof z.ZodError && !repaired) {
              repaired = true;
              const validationIssues = error.issues.slice(0, 25).map((issue) => ({
                path: issue.path.map(String).join("."),
                code: issue.code,
              }));
              repairAttempt = 1;
              repairMessages = [
                ...schemaMessages,
                {
                  role: "user",
                  content: `Return a corrected response matching the JSON schema. Validation issues: ${JSON.stringify(validationIssues)}`,
                },
              ];
              await emitDiagnostic({
                stage: "repair",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                inferenceRequestId,
                validationIssues,
              });
              attempt -= 1;
              continue;
            }
            if (error instanceof z.ZodError) {
              await emitDiagnostic({
                stage: "validate",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                inferenceRequestId,
                validationIssues: error.issues.slice(0, 25).map((issue) => ({
                  path: issue.path.map(String).join("."),
                  code: issue.code,
                })),
              });
            }
            throw error;
          }
        } catch (error) {
          const providerError = error instanceof OpenRouterError
            ? (error.details as { providerError?: OpenRouterProviderError } | undefined)?.providerError
            : undefined;
          await emitDiagnostic({
            stage: "complete",
            schemaName: input.schemaName,
            model,
            attempt,
            fallbackAttempt,
            repairAttempt,
            inferenceRequestId,
            latencyMs: Date.now() - startedAt,
            success: false,
            failureKind: structuredFailureKind(error, input.signal),
            ...(responsePayload ? { responsePayload } : {}),
            ...(providerError ? { providerError } : {}),
          });
          if (input.signal?.aborted) throw error;
          const disposition = openRouterFailureDisposition(error);
          if (disposition === "terminal") throw error;
          lastError = error;
          if (disposition === "retry" && attempt < this.sameModelRetries()) continue;
          break;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OpenRouterError("All configured OpenRouter models failed", undefined, lastError);
  }

  async stream(input: ChatRequest, onDelta: (delta: string) => void | Promise<void>): Promise<StreamResult> {
    const models = uniqueModels([this.config.primaryModel, ...(this.config.fallbackModels ?? [])]);
    let lastError: unknown;
    for (const model of models) {
      for (let attempt = 0; attempt <= this.sameModelRetries(); attempt += 1) {
        let emitted = false;
        try {
          const result = await this.streamModel(
            model,
            input,
            async (delta) => {
              await onDelta(delta);
            },
            () => {
              emitted = true;
            }
          );
          return result;
        } catch (error) {
          // Once any assistant text or tool-call bytes have arrived, replaying
          // the request could duplicate visible output or provider writes.
          if (input.signal?.aborted || emitted) throw error;
          const disposition = openRouterFailureDisposition(error);
          if (disposition === "terminal") throw error;
          lastError = error;
          if (disposition === "retry" && attempt < this.sameModelRetries()) continue;
          break;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OpenRouterError("All configured OpenRouter models failed", undefined, lastError);
  }

  private sameModelRetries(): number {
    return Math.max(0, Math.min(3, Math.trunc(this.config.sameModelRetries ?? 1)));
  }

  private async streamModel(
    model: string,
    input: ChatRequest,
    onDelta: (delta: string) => void | Promise<void>,
    onOutput: () => void
  ): Promise<StreamResult> {
    const requestStartedAt = Date.now();
    let firstOutputAt: number | null = null;
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: this.config.ttftTimeoutMs ?? 120_000,
      interChunkMs: this.config.streamIdleTimeoutMs ?? 15_000,
      maxCallDurationMs: Math.max(
        this.config.ttftTimeoutMs ?? 120_000,
        (this.config.ttftTimeoutMs ?? 120_000) + (this.config.streamIdleTimeoutMs ?? 15_000),
      ),
      external: input.signal ?? null,
    });
    const establishment = new AbortController();
    let establishmentTimedOut = false;
    const establishmentTimer = setTimeout(() => {
      establishmentTimedOut = true;
      establishment.abort(new DOMException("OpenRouter request establishment timed out", "TimeoutError"));
    }, this.config.requestEstablishmentTimeoutMs ?? 30_000);
    const tools = [...(input.tools ?? [])];
    if (input.includeWebSearch) {
      tools.push({
        type: "openrouter:web_search",
        search_context_size: "medium",
        max_total_results: input.maxWebResults ?? 8
      });
    }
    try {
      const requestPayload = serializeOpenRouterChatRequest({
        model,
        messages: input.messages,
        stream: true,
        streamOptions: { includeUsage: true },
        ...(tools.length > 0 ? {
          tools,
          toolChoice: input.toolChoice ?? "auto",
        } : {}),
        ...(input.plugins?.length ? { plugins: input.plugins } : {}),
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        ...(input.trace ? {
          ...(input.trace.user ? { user: input.trace.user } : {}),
          ...(input.trace.session_id ? { sessionId: input.trace.session_id } : {}),
          trace: toSdkTrace(input.trace.trace),
        } : {}),
      });
      const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.any([watchdog.signal, establishment.signal]),
      });
      clearTimeout(establishmentTimer);
      watchdog.open();
    if (!response.ok || !response.body) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }
      throw new OpenRouterError(`OpenRouter stream failed (${response.status})`, response.status, {
        // Preserve retry metadata for routing, plus the provider's own error
        // classification so a rejected request is diagnosable. The response body
        // itself is still not retained by the durable runtime or structured logs.
        headers: {
          "retry-after": response.headers.get("retry-after") ?? undefined,
        },
        providerErrorKind: typeof details === "object" && details !== null ? "structured" : "text",
        providerError: openRouterProviderError(details),
      });
    }

    let content = "";
    let usage: Record<string, number> | null = null;
    let finishReason: string | null = null;
    let generationId: string | null = response.headers.get("x-generation-id");
    let openRouterMetadata: Record<string, unknown> | null = null;
    const pendingCalls = new Map<number, ModelToolCall>();
    let deltaChain = Promise.resolve();
    const parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        if (event.data === "[DONE]") return;
        const chunk = parseOpenRouterStreamChunk(event.data);
        if (chunk.error) {
          throw new OpenRouterError("OpenRouter stream error", undefined, {
            providerError: openRouterProviderError({ error: chunk.error }),
          });
        }
        generationId ??= chunk.id || null;
        if (chunk.openrouterMetadata) openRouterMetadata = openRouterMetadataRecord(chunk.openrouterMetadata);
        if (chunk.usage) usage = sdkUsageRecord(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finishReason) finishReason = choice.finishReason;
        const text = choice.delta?.content;
        const toolCallDeltas = choice.delta?.toolCalls ?? [];
        watchdog.observedChunk(text || toolCallDeltas.length > 0 ? "answer" : "none");
        if (text || toolCallDeltas.length > 0) {
          firstOutputAt ??= Date.now();
          onOutput();
        }
        if (text) {
          content += text;
          deltaChain = deltaChain.then(() => onDelta(text));
        }
        for (const deltaCall of toolCallDeltas) {
          const current = pendingCalls.get(deltaCall.index) ?? {
            id: deltaCall.id ?? `tool-${deltaCall.index}`,
            type: "function" as const,
            function: { name: "", arguments: "" }
          };
          if (deltaCall.id) current.id = deltaCall.id;
          if (deltaCall.function?.name) current.function.name += deltaCall.function.name;
          if (deltaCall.function?.arguments) current.function.arguments += deltaCall.function.arguments;
          pendingCalls.set(deltaCall.index, current);
        }
      }
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    await deltaChain;
      return {
      model,
      content,
      toolCalls: [...pendingCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call),
      usage,
      finishReason,
      generationId,
      ttftMs: firstOutputAt === null ? null : Math.max(0, firstOutputAt - requestStartedAt),
      responseBytes,
      openRouterMetadata,
      };
    } catch (error) {
      const stall = watchdog.stall();
      if (stall) {
        throw new OpenRouterError(`OpenRouter stream stalled (${stall.kind})`, 408, { stall });
      }
      if (establishmentTimedOut && !input.signal?.aborted) {
        throw new OpenRouterError("OpenRouter request establishment timed out", 408, {
          timeoutMs: this.config.requestEstablishmentTimeoutMs ?? 30_000,
        });
      }
      throw error;
    } finally {
      clearTimeout(establishmentTimer);
      watchdog.dispose();
    }
  }

  private headers(sessionId?: string): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Metadata": "enabled",
      ...(sessionId ? { "X-Session-ID": sessionId } : {}),
      ...(this.config.appUrl ? { "HTTP-Referer": this.config.appUrl } : {}),
      ...(this.config.appName ? { "X-Title": this.config.appName } : {})
    };
  }
}

/**
 * Streaming Chat Completions client for Azure AI Foundry's OpenAI-compatible
 * v1 endpoint. Routing and retries stay in Bind; this adapter owns only the
 * provider-specific URL, headers, body, and response normalization.
 */
export class AzureOpenAIClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly chatCompletionsUrl: string;

  constructor(
    private readonly config: AzureOpenAIConfig & Pick<
      OpenRouterConfig,
      | "fetch"
      | "requestEstablishmentTimeoutMs"
      | "ttftTimeoutMs"
      | "streamIdleTimeoutMs"
    >,
  ) {
    if (!config.apiKey.trim()) throw new AzureOpenAIError("AZURE_OPENAI_API_KEY is not configured");
    this.chatCompletionsUrl = azureChatCompletionsUrl(config.endpoint);
    this.fetcher = (config.fetch ?? globalThis.fetch).bind(globalThis);
  }

  async stream(
    input: ChatRequest & { model: string },
    onDelta: (delta: string) => void | Promise<void>,
  ): Promise<StreamResult> {
    if (input.plugins?.length || input.includeWebSearch) {
      throw new AzureOpenAIRequestError("Azure does not support OpenRouter plugins");
    }
    assertAzureMessages(input.messages);
    const requestStartedAt = Date.now();
    let firstOutputAt: number | null = null;
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: this.config.ttftTimeoutMs ?? 120_000,
      interChunkMs: this.config.streamIdleTimeoutMs ?? 15_000,
      maxCallDurationMs: Math.max(
        this.config.ttftTimeoutMs ?? 120_000,
        (this.config.ttftTimeoutMs ?? 120_000) + (this.config.streamIdleTimeoutMs ?? 15_000),
      ),
      external: input.signal ?? null,
    });
    const establishment = new AbortController();
    let establishmentTimedOut = false;
    const establishmentTimer = setTimeout(() => {
      establishmentTimedOut = true;
      establishment.abort(new DOMException("Azure request establishment timed out", "TimeoutError"));
    }, this.config.requestEstablishmentTimeoutMs ?? 30_000);
    try {
      const payload = {
        model: input.model,
        messages: input.messages,
        stream: true as const,
        stream_options: { include_usage: true as const },
        ...(input.tools?.length ? {
          tools: input.tools,
          tool_choice: input.toolChoice ?? "auto",
        } : {}),
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      };
      const response = await this.fetcher(this.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([watchdog.signal, establishment.signal]),
      });
      clearTimeout(establishmentTimer);
      watchdog.open();
      if (!response.ok || !response.body) {
        let details: unknown;
        try {
          details = await response.json();
        } catch {
          details = await response.text();
        }
        throw new AzureOpenAIError(`Azure stream failed (${response.status})`, response.status, {
          headers: { "retry-after": response.headers.get("retry-after") ?? undefined },
          providerErrorKind: typeof details === "object" && details !== null ? "structured" : "text",
          providerError: openRouterProviderError(details),
        });
      }

      let content = "";
      let usage: Record<string, number> | null = null;
      let finishReason: string | null = null;
      let generationId: string | null = response.headers.get("x-request-id");
      const pendingCalls = new Map<number, ModelToolCall>();
      let deltaChain = Promise.resolve();
      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          if (event.data === "[DONE]") return;
          const chunk = parseOpenRouterStreamChunk(event.data);
          if (chunk.error) {
            throw new AzureOpenAIError("Azure stream error", undefined, {
              providerError: openRouterProviderError({ error: chunk.error }),
            });
          }
          generationId ??= chunk.id || null;
          if (chunk.usage) usage = sdkUsageRecord(chunk.usage);
          const choice = chunk.choices?.[0];
          if (!choice) return;
          if (choice.finishReason) finishReason = choice.finishReason;
          const text = choice.delta?.content;
          const toolCallDeltas = choice.delta?.toolCalls ?? [];
          watchdog.observedChunk(text || toolCallDeltas.length > 0 ? "answer" : "none");
          if (text || toolCallDeltas.length > 0) firstOutputAt ??= Date.now();
          if (text) {
            content += text;
            deltaChain = deltaChain.then(() => onDelta(text));
          }
          for (const deltaCall of toolCallDeltas) {
            const current = pendingCalls.get(deltaCall.index) ?? {
              id: deltaCall.id ?? `tool-${deltaCall.index}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (deltaCall.id) current.id = deltaCall.id;
            if (deltaCall.function?.name) current.function.name += deltaCall.function.name;
            if (deltaCall.function?.arguments) current.function.arguments += deltaCall.function.arguments;
            pendingCalls.set(deltaCall.index, current);
          }
        },
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let responseBytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
      await deltaChain;
      return {
        model: input.model,
        content,
        toolCalls: [...pendingCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call),
        usage,
        finishReason,
        generationId,
        ttftMs: firstOutputAt === null ? null : Math.max(0, firstOutputAt - requestStartedAt),
        responseBytes,
        openRouterMetadata: null,
      };
    } catch (error) {
      const stall = watchdog.stall();
      if (stall) throw new AzureOpenAIError(`Azure stream stalled (${stall.kind})`, 408, { stall });
      if (establishmentTimedOut && !input.signal?.aborted) {
        throw new AzureOpenAIError("Azure request establishment timed out", 408, {
          timeoutMs: this.config.requestEstablishmentTimeoutMs ?? 30_000,
        });
      }
      throw error;
    } finally {
      clearTimeout(establishmentTimer);
      watchdog.dispose();
    }
  }
}

function azureChatCompletionsUrl(endpoint: string): string {
  const parsed = AzureInferenceEndpointSchema.safeParse(endpoint.trim());
  if (!parsed.success) {
    throw new AzureOpenAIRequestError(
      "AZURE_OPENAI_ENDPOINT must be an HTTPS resource root or /openai/v1 base",
    );
  }
  const url = new URL(parsed.data);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path || "/openai/v1"}/chat/completions`;
  return url.toString();
}

function assertAzureMessages(messages: ModelMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "file" || part.type === "input_audio") {
        throw new AzureOpenAIRequestError(`Azure does not support ${part.type} message parts`);
      }
      if (part.type === "image_url") assertSupportedOpenRouterImageUrl(part.image_url.url);
    }
  }
}

function serializeOpenRouterChatRequest(input: {
  model: string;
  messages: ModelMessage[];
  stream: boolean;
  streamOptions?: { includeUsage: boolean };
  tools?: ModelRequestTool[];
  toolChoice?: "auto" | "none";
  plugins?: Array<Record<string, unknown>>;
  reasoning?: { effort: "none" | "low" | "medium" | "high" };
  responseFormat?: OpenRouterChatRequest["responseFormat"];
  user?: string;
  sessionId?: string;
  trace?: ReturnType<typeof toSdkTrace>;
}): Record<string, unknown> {
  try {
    const sdkRequest: OpenRouterChatRequest = {
      model: input.model,
      messages: toSdkMessages(input.messages),
      stream: input.stream,
      ...(input.streamOptions ? { streamOptions: input.streamOptions } : {}),
      ...(input.tools ? { tools: toSdkTools(input.tools) } : {}),
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      ...(input.plugins ? { plugins: toSdkPlugins(input.plugins) } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
      ...(input.user ? { user: input.user } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.trace ? { trace: input.trace } : {}),
    };
    return JSON.parse(chatRequestToJSON(sdkRequest)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OpenRouterRequestError) throw error;
    throw new OpenRouterRequestError("Invalid OpenRouter chat request");
  }
}

function toSdkTools(tools: ModelRequestTool[]): NonNullable<OpenRouterChatRequest["tools"]> {
  return tools.map((tool) => tool.type === "function"
    ? tool
    : {
        type: "openrouter:web_search" as const,
        parameters: {
          searchContextSize: tool.search_context_size,
          maxTotalResults: tool.max_total_results,
        },
      });
}

function toSdkPlugins(
  plugins: Array<Record<string, unknown>>,
): NonNullable<OpenRouterChatRequest["plugins"]> {
  return plugins.map((plugin) => {
    if (plugin.id === "response-healing") {
      return {
        id: "response-healing" as const,
        ...(typeof plugin.enabled === "boolean" ? { enabled: plugin.enabled } : {}),
      };
    }
    if (plugin.id === "file-parser") {
      const pdf = plugin.pdf && typeof plugin.pdf === "object"
        ? plugin.pdf as Record<string, unknown>
        : null;
      const engine = pdf?.engine;
      if (engine !== undefined
        && engine !== "native"
        && engine !== "mistral-ocr"
        && engine !== "cloudflare-ai"
        && engine !== "pdf-text") {
        throw new OpenRouterRequestError(`Unsupported OpenRouter PDF parser engine: ${String(engine)}`);
      }
      return {
        id: "file-parser" as const,
        ...(typeof plugin.enabled === "boolean" ? { enabled: plugin.enabled } : {}),
        ...(engine ? { pdf: { engine } } : {}),
      };
    }
    throw new OpenRouterRequestError(`Unsupported OpenRouter plugin: ${String(plugin.id)}`);
  });
}

function toSdkMessages(messages: ModelMessage[]): ChatMessages[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: toSdkContent(message.content) ?? "",
        toolCallId: message.tool_call_id ?? "",
      } as ChatMessages;
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: toSdkContent(message.content),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_calls ? {
          toolCalls: message.tool_calls.map((call) => ({
            id: call.id,
            type: call.type,
            function: call.function,
          })),
        } : {}),
      } as ChatMessages;
    }
    return {
      role: message.role,
      content: toSdkContent(message.content) ?? "",
      ...(message.name ? { name: message.name } : {}),
    } as ChatMessages;
  });
}

function toSdkContent(content: ModelMessageContent): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "image_url") {
      assertSupportedOpenRouterImageUrl(part.image_url.url);
      return { type: part.type, imageUrl: part.image_url };
    }
    if (part.type === "file") {
      return {
        type: part.type,
        file: { filename: part.file.filename, fileData: part.file.file_data },
      };
    }
    if (part.type === "input_audio") {
      return { type: part.type, inputAudio: part.input_audio };
    }
    return part;
  });
}

const OPENROUTER_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,/iu;

/**
 * Rally-owned attachments are private and therefore reach OpenRouter as data
 * URLs. Keep the provider boundary fail-closed if another producer attempts to
 * label a PDF, SVG, TIFF, HEIF, or arbitrary data payload as an image part.
 * OpenRouter supports public HTTP(S) image URLs, but Rally does not send them:
 * their response content type cannot be verified from the request body.
 */
function assertSupportedOpenRouterImageUrl(url: string): void {
  if (OPENROUTER_IMAGE_DATA_URL.test(url)) return;
  throw new OpenRouterRequestError("Unsupported OpenRouter image content type");
}

function toSdkTrace(trace: OpenRouterTracePayload["trace"]): {
  traceId: string;
  traceName: string;
  spanName: string;
  generationName: string;
  additionalProperties: Record<string, string | number>;
} {
  const {
    trace_id: traceId,
    trace_name: traceName,
    span_name: spanName,
    generation_name: generationName,
    ...additionalProperties
  } = trace;
  return { traceId, traceName, spanName, generationName, additionalProperties };
}

function parseOpenRouterChatResult(payload: unknown): ChatResult | null {
  const parsed = chatResultFromJSON(JSON.stringify(payload));
  return parsed.ok ? parsed.value : null;
}

function parseOpenRouterStreamChunk(serialized: string): ChatStreamChunk {
  const parsed = chatStreamChunkFromJSON(serialized);
  if (parsed.ok) return parsed.value;
  let raw: Record<string, unknown> = {};
  try {
    const payload = JSON.parse(serialized) as unknown;
    if (payload && typeof payload === "object") raw = payload as Record<string, unknown>;
  } catch {
    // An unparseable event has no answer or tool-call bytes and is ignored.
  }
  const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    model: typeof raw.model === "string" ? raw.model : "",
    object: "chat.completion.chunk",
    created: typeof raw.created === "number" ? raw.created : 0,
    choices: rawChoices.map((value, index) => {
      const choice = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const delta = choice.delta && typeof choice.delta === "object"
        ? choice.delta as Record<string, unknown>
        : {};
      const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      return {
        index: typeof choice.index === "number" ? choice.index : index,
        finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        delta: {
          ...(typeof delta.content === "string" || delta.content === null ? { content: delta.content } : {}),
          ...(rawToolCalls.length > 0 ? {
            toolCalls: rawToolCalls.map((toolCall, toolIndex) => {
              const record = toolCall && typeof toolCall === "object"
                ? toolCall as Record<string, unknown>
                : {};
              const fn = record.function && typeof record.function === "object"
                ? record.function as Record<string, unknown>
                : {};
              return {
                index: typeof record.index === "number" ? record.index : toolIndex,
                ...(typeof record.id === "string" ? { id: record.id } : {}),
                type: "function" as const,
                function: {
                  ...(typeof fn.name === "string" ? { name: fn.name } : {}),
                  ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
                },
              };
            }),
          } : {}),
        },
      };
    }) as ChatStreamChunk["choices"],
    ...(raw.usage && typeof raw.usage === "object"
      ? { usage: rawUsageToSdk(raw.usage as Record<string, unknown>) }
      : {}),
    ...(raw.error && typeof raw.error === "object"
      ? { error: raw.error as ChatStreamChunk["error"] }
      : {}),
    ...(raw.openrouter_metadata && typeof raw.openrouter_metadata === "object"
      ? { openrouterMetadata: raw.openrouter_metadata as OpenRouterMetadata }
      : {}),
  };
}

function rawUsageToSdk(usage: Record<string, unknown>): ChatUsage {
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : null;
  const completionDetails = usage.completion_tokens_details
    && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : null;
  const reasoningTokens = typeof usage.reasoning_tokens === "number"
    ? usage.reasoning_tokens
    : typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : undefined;
  const cachedInputTokens = typeof usage.cached_tokens === "number"
    ? usage.cached_tokens
    : typeof promptDetails?.cached_tokens === "number"
      ? promptDetails.cached_tokens
      : undefined;
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0)
        + (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0),
    ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
    ...(reasoningTokens === undefined ? {} : {
      completionTokensDetails: { reasoningTokens },
    }),
    ...(cachedInputTokens === undefined ? {} : {
      promptTokensDetails: { cachedTokens: cachedInputTokens },
    }),
  };
}

function sdkUsageRecord(usage: ChatUsage): Record<string, number> {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
    ...(typeof usage.completionTokensDetails?.reasoningTokens === "number"
      ? { reasoning_tokens: usage.completionTokensDetails.reasoningTokens }
      : {}),
    ...(typeof usage.promptTokensDetails?.cachedTokens === "number"
      ? { cached_tokens: usage.promptTokensDetails.cachedTokens }
      : {}),
  };
}

function openRouterMetadataRecord(metadata: OpenRouterMetadata): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

type OpenRouterFailureDisposition = "retry" | "fallback" | "terminal";

function openRouterFailureDisposition(error: unknown): OpenRouterFailureDisposition {
  if (isAbortError(error)) return "terminal";
  if (error instanceof OpenRouterRequestError) return "terminal";
  if (error instanceof OpenRouterError) {
    const status = error.status;
    if (status === 401 || status === 402 || status === 403) return "terminal";
    if (status === 408 || status === 429 || (status != null && status >= 500)) return "retry";
    return "fallback";
  }
  // Fetch rejects transport failures rather than returning an HTTP response.
  if (error instanceof TypeError || (error instanceof Error && error.name === "NetworkError")) {
    return "retry";
  }
  return "fallback";
}

function structuredFailureKind(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) {
    return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? "timeout"
      : "aborted";
  }
  if (error instanceof z.ZodError) return "validation_error";
  if (error instanceof OpenRouterRequestError) return "request_error";
  if (error instanceof OpenRouterError) {
    if (error.status === 408) return "timeout";
    if (error.status === 429) return "rate_limit";
    if (error.status != null && error.status >= 500) return "server_error";
    if (error.status != null) return "provider_error";
    return "completion_error";
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === "NetworkError")) {
    return "network";
  }
  return "unexpected_error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function renderExpectedJsonSchema(
  schemaName: string,
  jsonSchema: Record<string, unknown>,
): string {
  return [
    `Expected structured output JSON Schema (${schemaName}):`,
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  ].join("\n");
}

/**
 * The `reasoning` field for one structured request, or nothing at all.
 *
 * Omitting the field and disabling reasoning are different requests: omitting
 * it accepts whatever the selected model does by default, while `effort:
 * "none"` is the OpenRouter SDK's switch for turning thinking off on a model
 * that would otherwise do it.
 */
function structuredReasoning(
  effort: "none" | "low" | "medium" | "high" | undefined,
): { effort: "none" | "low" | "medium" | "high" } | undefined {
  if (effort === undefined) return undefined;
  return { effort };
}

/**
 * Keep strict provider enforcement and model-visible instructions in sync.
 * Medium-sized models are materially more reliable when the exact schema is
 * present in the conversation instead of existing only in response_format.
 * The instruction rides in the system message: the schema is the harness's
 * own contract, so it belongs with policy, and the user-role messages stay
 * pure data.
 */
function withExpectedJsonSchema(
  messages: ModelMessage[],
  schemaName: string,
  jsonSchema: Record<string, unknown>,
): ModelMessage[] {
  const instruction = [
    renderExpectedJsonSchema(schemaName, jsonSchema),
    "Return only one JSON value that matches this schema exactly. Do not include Markdown or explanatory text in the response.",
  ].join("\n\n");
  const [first, ...rest] = messages;
  if (first?.role === "system" && typeof first.content === "string") {
    return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest];
  }
  return [{ role: "system", content: instruction }, first, ...rest].filter(
    (message): message is ModelMessage => message !== undefined,
  );
}

/**
 * The diagnosable part of an OpenRouter error envelope.
 *
 * Provider response bodies are not retained — they can echo prompt content back.
 * `code` and `providerName` are the provider's own classification of the
 * rejection, and without them a run that fails against OpenRouter is
 * indistinguishable from any other failure: the status code alone cannot tell a
 * bad model id from an over-long context from a provider outage.
 *
 * Provider free text is deliberately excluded because some upstreams quote the
 * request back and the host's key-based redactor cannot recognize those echoes.
 */
export interface OpenRouterProviderError {
  code?: string | number;
  providerName?: string;
}

export function openRouterProviderError(payload: unknown): OpenRouterProviderError | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, metadata } = error as {
    code?: unknown;
    metadata?: { provider_name?: unknown };
  };
  const providerName = metadata?.provider_name;
  const captured: OpenRouterProviderError = {
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof providerName === "string" ? { providerName } : {}),
  };
  return Object.keys(captured).length > 0 ? captured : undefined;
}

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function providerUsageNumber(usage: Record<string, number> | null, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function providerCachedTokens(usage: Record<string, number> | null): number | null {
  const value = usage?.cached_tokens ?? usage?.cached_prompt_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const addressingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: {
      type: "string",
      enum: ["agent_action", "human_only", "both", "uncertain"]
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationaleCode: {
      type: "string",
      enum: [
        "imperative",
        "question",
        "connector_mention",
        "rally_reference",
        "active_task",
        "elicitation_answer",
        "human_coordination",
        "social_acknowledgement",
        "insufficient_signal"
      ]
    }
  },
  required: ["classification", "confidence", "rationaleCode"]
};

/**
 * The two ways a message can name the product, and why they are not one pattern.
 *
 * `avalon` is unambiguous: nothing else in a work stream is called that, so
 * seeing it is enough to short-circuit to `agent_action` without spending a
 * model call. `rally` is an ordinary English verb — "let's rally the team on
 * this" names no agent — so the same short-circuit would buy a false positive
 * at 0.96 confidence, decided deterministically and never seen by the model.
 *
 * So the ambiguous token does not short-circuit; it rides into the prompt as
 * `addressesRally`, where the classifier weighs it against the surrounding
 * turns. The prompt tells the model an explicit Rally reference is strong
 * evidence, and this is what makes that true.
 */
const UNAMBIGUOUS_PRODUCT_REFERENCE = /\bavalon\b/iu;
const PRODUCT_REFERENCE = /\b(?:avalon|rally)\b/iu;

export function classifyAddressingHeuristically(input: {
  message: string;
  activeTask: boolean;
  connectorMentions?: string[];
  humanMentions?: string[];
  addressesRally?: boolean;
}): AddressingClassification {
  const text = input.message.trim();
  if ((input.connectorMentions?.length ?? 0) > 0) {
    return { classification: "agent_action", confidence: 0.98, rationaleCode: "connector_mention" };
  }
  if (input.addressesRally || UNAMBIGUOUS_PRODUCT_REFERENCE.test(text)) {
    return { classification: "agent_action", confidence: 0.96, rationaleCode: "rally_reference" };
  }
  // An opening imperative is aimed at the agent only when the message names
  // nobody: "Please review the deck @Alex" hands the work to Alex, so a
  // mentioned person sends the message to the model instead of deciding here.
  if (
    (input.humanMentions?.length ?? 0) === 0
    && /^(please\s+)?(find|check|create|draft|send|review|summarize|investigate|update|compare|prepare)\b/i.test(text)
  ) {
    return { classification: "agent_action", confidence: 0.9, rationaleCode: "imperative" };
  }
  if (/\?$/.test(text)) {
    return { classification: "both", confidence: 0.72, rationaleCode: "question" };
  }
  if (/^(thanks|thank you|sounds good|got it|okay|ok|nice)[!. ]*$/i.test(text)) {
    return { classification: "human_only", confidence: 0.93, rationaleCode: "social_acknowledgement" };
  }
  return input.activeTask
    ? { classification: "uncertain", confidence: 0.55, rationaleCode: "active_task" }
    : { classification: "human_only", confidence: 0.58, rationaleCode: "insufficient_signal" };
}

export async function classifyAddressing(input: {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  message: string;
  activeTask: boolean;
  connectorMentions?: string[];
  humanMentions?: string[];
  addressesRally?: boolean;
  recentMessages?: AddressingContextMessage[];
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  traceContext?: OpenRouterTraceContext;
}): Promise<AddressingClassification> {
  const deterministic = classifyAddressingHeuristically(input);
  if (deterministic.confidence >= 0.9) return deterministic;
  const client = new OpenRouterClient({
    apiKey: input.apiKey,
    primaryModel: input.model,
    ...(input.fallbackModels ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  });
  return client.structured({
    messages: renderAddressingMessages({
      message: input.message,
      activeTask: input.activeTask,
      connectorMentions: input.connectorMentions ?? [],
      humanMentions: input.humanMentions ?? [],
      addressesRally: input.addressesRally ?? PRODUCT_REFERENCE.test(input.message),
      recentMessages: input.recentMessages ?? [],
    }),
    schemaName: "message_addressing",
    jsonSchema: addressingJsonSchema,
    parse: (value) => AddressingClassificationSchema.parse(value),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
  });
}

const automationDraftSubmissionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    overview: { type: "string" },
    instructions: { type: "string" },
    triggers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        description: "Use null for every field that does not apply to the selected trigger type.",
        properties: {
          type: {
            type: "string",
            enum: ["manual", "calendar", "interval", "connector_activity", "semantic_activity", "resource_watch", "webhook"]
          },
          rrule: { type: ["string", "null"] },
          timezone: {
            type: ["string", "null"],
            description: "The IANA timezone a calendar recurrence's wall-clock time is read in, when the person named one. Use null for every other trigger, and for a calendar trigger whose zone nobody named — Rally then reads it in the applicable scheduling default."
          },
          summary: { type: ["string", "null"] },
          intervalSeconds: { type: ["integer", "null"], minimum: 60 },
          connectorType: { type: ["string", "null"] },
          sourceBindingKey: { type: ["string", "null"] },
          suggestedSourcePluginId: { type: ["string", "null"] },
          eventTypes: { type: ["array", "null"], items: { type: "string" } },
          deterministicFilters: {
            type: ["string", "null"],
            description: "A JSON-encoded object of deterministic connector filters."
          },
          deterministicPrefilter: {
            type: ["string", "null"],
            // The one required key lives inside an opaque JSON string, so
            // nothing else the model is shown can state it: the schema cannot
            // constrain the encoded object, and the prose above says only that
            // a prefilter is declared. Naming it here is what stops a ready
            // semantic trigger being submitted without it.
            description: "A JSON-encoded object of deterministic filters applied before semantic classification. A ready semantic_activity trigger must name exactly one declared event type from the plugin in suggestedSourcePluginId, as {\"eventType\": \"the.event.type\"}, optionally alongside that event's declared deterministic filter fields."
          },
          condition: { type: ["string", "null"] },
          resourceId: { type: ["string", "null"] }
        },
        required: [
          "type",
          "rrule",
          "timezone",
          "summary",
          "intervalSeconds",
          "connectorType",
          "sourceBindingKey",
          "suggestedSourcePluginId",
          "eventTypes",
          "deterministicFilters",
          "deterministicPrefilter",
          "condition",
          "resourceId"
        ]
      }
    },
    expectedOutputs: { type: "array", items: { type: "string" } },
    requestedDelivery: {
      type: "array",
      description: "The destinations the owner asked to receive the result themselves: \"email\" for their own email address, \"slack_agent_dm\" for their Rally Slack Agent DM. Use [] when they asked for neither, or when they asked for it to be sent to somebody else. Rally does the sending; this only records what was asked for.",
      items: { type: "string", enum: ["email", "slack_agent_dm"] }
    },
    defaultBehavior: {
      type: "string",
      description: "A JSON-encoded object of default behavior settings; use {} when none are needed."
    },
    recommendedPlugins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pluginId: { type: "string", pattern: "^plugin_[a-z][a-z0-9_]{0,62}$" },
          recommendedTools: { type: "array", items: { type: "string" } },
          reason: { type: "string" }
        },
        required: ["pluginId", "recommendedTools", "reason"]
      }
    },
    memoryTables: {
      type: "array",
      description: "Automation-scoped durable structured collections required across runs; use [] when none are needed.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          usageInstructions: { type: "string" },
          columns: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                type: { type: "string", enum: ["string", "url", "number", "integer", "boolean", "datetime", "date"] },
                required: { type: "boolean" },
                searchable: { type: "boolean" }
              },
              required: ["name", "description", "type", "required", "searchable"]
            }
          },
          keyColumns: { type: "array", minItems: 1, items: { type: "string" } }
        },
        required: ["name", "description", "usageInstructions", "columns", "keyColumns"]
      }
    },
    suggestedScope: { type: "string", enum: ["personal", "workspace"] },
    ready: {
      type: "boolean",
      description: "True only when no blocking human input remains; false means request_elicitation must be called after this draft is submitted."
    }
  },
  required: [
    "name",
    "description",
    "overview",
    "instructions",
    "triggers",
    "expectedOutputs",
    "requestedDelivery",
    "defaultBehavior",
    "recommendedPlugins",
    "memoryTables",
    "suggestedScope",
    "ready"
  ]
};

export interface AutomationCreatorPluginCatalogEntry {
  pluginId: string;
  displayName: string;
  icon: AutomationPluginIcon;
  description: string;
  scope: "personal" | "workspace";
  searchAliases: string[];
  systemMessage: string;
  activityTriggers: ConnectorActivityTriggerDescriptor[];
  tools: Array<{
    name: string;
    /** Canonical adapter identity; `name` remains the exact model-facing wire name. */
    canonicalName?: string;
    description: string;
    capability: string;
    mode: "read" | "write";
    idempotency?: "safe" | "provider_key" | "record_before_execute";
    timeoutMs?: number;
    inputSchema: Record<string, unknown>;
    execute?: HarnessTool["execute"];
  }>;
}

function renderAutomationActivityTriggerGuidance(
  triggers: ConnectorActivityTriggerDescriptor[],
): string {
  if (!triggers.length) return "";
  const lines = triggers.map((trigger) => {
    const filterFields = trigger.filterFields ?? [];
    const filters = filterFields.length
      ? ` Filters: ${filterFields.map((field) =>
          `${field.key} (${field.valueType}; ${field.label}): ${field.description}`).join("; ")}`
      : "";
    return `- ${trigger.eventType}: ${trigger.label}. ${trigger.description}${filters}`;
  });
  return [
    "# Automation activity triggers",
    "Use only these exact normalized event types and declared deterministic filter fields.",
    ...lines,
  ].join("\n");
}

export type AutomationCompilerFailureCode =
  | HarnessFailureCode
  | "automation_draft_not_submitted";

export class AutomationCompilerError extends Error {
  constructor(
    readonly code: AutomationCompilerFailureCode,
    readonly kind: HarnessFailure["kind"] | "completion",
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "AutomationCompilerError";
  }
}

export interface TextDeltaBatcher {
  push(delta: string): Promise<void>;
  flush(): Promise<void>;
  /** Drop pending text without publishing it. See the retraction rule below. */
  discard(): void;
}

/**
 * Coalesce provider text fragments before they become frames on a wire.
 *
 * A model emits a token at a time, and every fragment that reaches a client
 * unbatched costs a frame, a schema parse, a state update, and — where the
 * receiver follows the transcript — a layout pass. The defaults match the
 * sequenced batcher on the work-stream socket path
 * (`createSequencedStreamDeltaBatcher` in `apps/api/src/services/integrations.ts`),
 * so both surfaces coalesce identically; that one stays separate because it
 * also has to keep turn and epoch sequencing, which this one has no concept of.
 *
 * **A retraction is never batched.** A caller with reset semantics settles
 * whatever is pending — `flush` when the retraction only clears part of the
 * receiver's buffer, `discard` when the retracting frame carries the whole
 * replacement — and publishes that frame on its own, so text can never arrive
 * coalesced behind the frame that was meant to replace it. Which of the two
 * applies depends on what the retraction means, so it lives with each caller
 * rather than in here.
 */
export function createTextDeltaBatcher(
  publish: (delta: string) => Promise<void>,
  options: { maxCharacters?: number; maxDelayMs?: number; now?: () => number } = {},
): TextDeltaBatcher {
  const maxCharacters = options.maxCharacters ?? 2_048;
  const maxDelayMs = options.maxDelayMs ?? 100;
  const now = options.now ?? Date.now;
  let pending = "";
  let lastFlushAt = now();

  const flush = async (): Promise<void> => {
    if (!pending) return;
    const delta = pending;
    pending = "";
    lastFlushAt = now();
    await publish(delta);
  };

  return {
    async push(delta: string): Promise<void> {
      pending += delta;
      if (pending.length >= maxCharacters || now() - lastFlushAt >= maxDelayMs) {
        await flush();
      }
    },
    flush,
    discard(): void {
      pending = "";
      lastFlushAt = now();
    },
  };
}

export type AutomationCompilerStreamEvent =
  | { type: "started" }
  | {
      /**
       * A fragment of the architect's narration. `reset: true` replaces the
       * composer's whole narration buffer with `delta` rather than appending.
       */
      type: "delta";
      delta: string;
      reset: boolean;
    }
  | {
      type: "thinking";
      inferenceRequestId: string;
      status: "started" | "completed";
      /** Cumulative model-inference time for this compiler turn. */
      durationMs: number;
    }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      summary: string;
      status: "started" | "completed" | "failed";
      /** The single plugin that owns this tool, or null for Avalon-owned tools. */
      plugin: AutomationPluginActivity | null;
      durationMs?: number;
    }
  | { type: "completed" };

const AUTOMATION_RESEARCH_TOOL_PRESENTATION: Record<string, {
  started: string;
  completed: string;
}> = {
  web_search: {
    started: "Searching the public web…",
    completed: "Web search completed",
  },
  web_fetch: {
    started: "Reading a public web page…",
    completed: "Web page ready",
  },
  automation_plugins_list: {
    started: "Checking available plugin capabilities…",
    completed: "Plugin capabilities are ready",
  },
  automation_plugins_search: {
    started: "Finding the plugins relevant to this automation…",
    completed: "Relevant plugins are ready",
  },
  automation_plugin_inspect: {
    started: "Reviewing what this plugin can do…",
    completed: "Plugin details are ready",
  },
  list_plugins: {
    started: "Checking available plugin capabilities…",
    completed: "Plugin capabilities are ready",
  },
  search_plugins: {
    started: "Finding the plugins relevant to this automation…",
    completed: "Relevant plugins are ready",
  },
  load_plugin: {
    started: "Loading the selected plugin…",
    completed: "Plugin guidance and tools are ready",
  },
  automation_read_resource: {
    started: "Reading an attached automation resource…",
    completed: "Attached resource is ready",
  },
  automation_search_resource: {
    started: "Searching an attached automation resource…",
    completed: "Attachment search completed",
  },
  automation_view_resource: {
    started: "Viewing an attached automation image…",
    completed: "Attached image is ready",
  },
  automation_summarize_resource: {
    started: "Summarizing an attached automation resource…",
    completed: "Attachment summary is ready",
  },
};

/**
 * `pluginIds` is required: a row names the plugins it is actually about, and an
 * optional filter here is how the whole catalog used to leak onto every row.
 */
function automationPluginActivities(
  catalog: AutomationCreatorPluginCatalogEntry[],
  pluginIds: ReadonlySet<string>,
): AutomationPluginActivity[] {
  return catalog
    .filter((plugin) => pluginIds.has(plugin.pluginId))
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      icon: plugin.icon,
    }));
}

/**
 * The plugin whose icon belongs on a research row: the one that owns the tool
 * being called, and nothing else. Tools owned by an Avalon core plugin — web
 * research and plugin discovery — have no connector behind them, so their rows
 * carry no plugin icon rather than standing in for the whole catalog.
 */
function automationOwningPlugin(
  pluginId: string,
  catalog: AutomationCreatorPluginCatalogEntry[],
): AutomationPluginActivity | null {
  if (!pluginId.startsWith("automation:")) return null;
  const owner = automationPluginActivities(catalog, new Set([pluginId.slice("automation:".length)]));
  return owner[0] ?? null;
}

/**
 * Plugins a discovery row is *about*, used only to phrase its label. Naming the
 * plugin a row loaded or inspected does not claim that plugin ran the tool, so
 * these never become icons.
 */
function automationSubjectPlugins(
  toolName: string,
  input: unknown,
  catalog: AutomationCreatorPluginCatalogEntry[],
): AutomationPluginActivity[] {
  if (toolName !== "automation_plugin_inspect" && toolName !== "load_plugin") return [];
  const pluginId = String(asRecord(input).pluginId ?? "");
  return automationPluginActivities(catalog, new Set([pluginId]));
}

function automationSubjectPluginsFromResult(
  toolName: string,
  output: unknown,
  catalog: AutomationCreatorPluginCatalogEntry[],
  fallback: AutomationPluginActivity[],
): AutomationPluginActivity[] {
  const record = asRecord(output);
  if (toolName === "load_plugin") {
    const pluginId = String(record.loaded ?? "");
    return pluginId ? automationPluginActivities(catalog, new Set([pluginId])) : fallback;
  }
  const hasPluginResult = toolName === "automation_plugin_inspect"
    ? Boolean(record.plugin && typeof record.plugin === "object")
    : Array.isArray(record.plugins);
  if (!hasPluginResult) return fallback;
  const pluginRecords = toolName === "automation_plugin_inspect"
    ? [asRecord(record.plugin)]
    : (record.plugins as unknown[]).map(asRecord);
  const pluginIds = new Set(pluginRecords
    .map((plugin) => String(plugin.pluginId ?? ""))
    .filter(Boolean));
  return automationPluginActivities(catalog, pluginIds);
}

function automationPluginNames(plugins: AutomationPluginActivity[]): string {
  if (!plugins.length) return "connected plugins";
  const names = plugins.map((plugin) => plugin.displayName);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/**
 * Discovery rows can legitimately name several plugins at once, which the
 * shared row prose deliberately cannot express. Everything else — web research
 * and connector tools — defers to `toolActivityName` so the automation composer
 * and a work stream never word the same row differently.
 */
function automationDiscoveryActivityName(
  toolName: string,
  status: "started" | "completed" | "failed",
  plugins: AutomationPluginActivity[],
): string {
  if (toolName === "web_search" || toolName === "web_fetch") {
    return toolActivityName({ toolName, status });
  }
  const names = automationPluginNames(plugins);
  if (toolName === "automation_plugins_search" || toolName === "search_plugins") {
    if (status === "completed") return plugins.length ? `Found ${names}` : "Searched connected plugins";
    return `Searching ${names}`;
  }
  if (toolName === "load_plugin") {
    return status === "completed" ? `Loaded ${names}` : `Loading ${names}`;
  }
  if (toolName === "automation_plugin_inspect") return `Reading ${names}`;
  if (toolName === "automation_plugins_list" || toolName === "list_plugins") {
    return status === "completed" ? `Reviewed ${names}` : `Reviewing ${names}`;
  }
  return toolActivityName({ toolName, status, plugin: plugins[0] ?? null });
}

export async function compileAutomation(input: {
  apiKey: string;
  model: string;
  /** Stable automation-draft loop identity supplied by production hosts. */
  loopId?: string;
  workspaceId?: string;
  userId?: string;
  fallbackModels?: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  latestUserAttachmentParts?: ModelMessageContentPart[];
  currentDraft?: AutomationDraft | null;
  defaultTimezones?: { personal: string; workspace: string };
  pluginCatalog?: AutomationCreatorPluginCatalogEntry[];
  /** Avalon-owned plugins available through the same progressive-disclosure catalog. */
  additionalPlugins?: HarnessPlugin[];
  /** Request-scoped tools owned by the preloaded automation architect. */
  architectTools?: HarnessTool[];
  /** Durable host mutations owned by the AutomationAgent compiler run. */
  draftMutationPort?: {
    setEvaluatorRules(
      rules: AutomationSetEvaluatorRulesInputV1,
      context: HarnessToolContext,
    ): Promise<{ accepted: true }>;
    submitDraft(
      draft: AutomationDraft,
      context: HarnessToolContext,
    ): Promise<{ accepted: true }>;
    requestElicitation(
      elicitation: z.infer<typeof RequestElicitationInputSchema>,
      context: HarnessToolContext,
    ): Promise<{ accepted: true }>;
  };
  draftResearchPort?: {
    searchPeople(query: string): Promise<unknown>;
    searchResources(query: string): Promise<unknown>;
  };
  maxResearchIterations?: number;
  /**
   * The host's transport-retry budget. Threaded in rather than defaulted here
   * because every caller shares one module-scoped circuit breaker keyed by
   * workspace: a compiler that kept retrying while an operator had set the
   * deployment budget to 0 would go on charging failures against the breaker
   * of the very work streams that switch was thrown to protect.
   */
  transportRetries?: number;
  maxWebResults?: number;
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  onInferenceRequest?: (request: InferenceRequestEvent) => void | Promise<void>;
  onInferenceAttempt?: (attempt: InferenceAttemptEvent) => void | Promise<void>;
  onStreamEvent?: (event: AutomationCompilerStreamEvent) => void | Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Deterministic catalog snapshot for tests or hosts with a cached catalog. */
  contextWindowTokensByModel?: Readonly<Record<string, number | null | undefined>>;
  traceContext?: OpenRouterTraceContext;
}): Promise<AutomationDraft> {
  const rendered = renderAutomationCompilerMessages({
    messages: input.messages,
    currentDraft: input.currentDraft ?? null,
    ...(input.defaultTimezones ? { defaultTimezones: input.defaultTimezones } : {}),
  });
  const conversationMessages: ModelMessage[] = rendered.slice(1);
  if (input.latestUserAttachmentParts?.length) {
    let latestUserIndex = -1;
    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
      if (conversationMessages[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex >= 0) {
      const latestUserMessage = conversationMessages[latestUserIndex]!;
      conversationMessages[latestUserIndex] = {
        ...latestUserMessage,
        content: [
          ...(latestUserMessage.content ? [{ type: "text" as const, text: String(latestUserMessage.content) }] : []),
          ...input.latestUserAttachmentParts,
        ],
      };
    }
  }
  const catalog = input.pluginCatalog ?? [];
  const executablePlugins: HarnessPlugin[] = catalog.map((plugin) => ({
    canonicalId: `automation:${plugin.pluginId}`,
    modelId: plugin.pluginId,
    shortWireName: plugin.pluginId.replace(/^plugin_/u, "").slice(0, 48),
    displayName: plugin.displayName,
    searchAliases: plugin.searchAliases,
    description: plugin.description,
    systemMessage: [plugin.systemMessage, renderAutomationActivityTriggerGuidance(plugin.activityTriggers)]
      .filter(Boolean)
      .join("\n\n"),
    tools: plugin.tools.flatMap((tool) => tool.execute
      ? [{
          definition: {
            name: tool.canonicalName ?? tool.name,
            description: tool.description,
            capability: tool.capability,
            mode: tool.mode,
            idempotency: tool.idempotency ?? "safe",
            ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
            inputSchema: tool.inputSchema,
          },
          execute: tool.execute,
        }]
      : []),
    preload: false,
    explicit: false,
  }));
  const draftState: { submitted: AutomationDraft | null } = { submitted: null };
  const loadedAutomationPluginIds = new Set<string>();
  const inspectedAutomationPluginIds = new Set<string>();
  const resolvedAutomationPersonIds = new Set<string>();
  const resolvedAutomationResources = new Map<string, {
    pluginId: string;
    resourceType: string;
    sourceBindingKeys: readonly string[];
  }>();
  let submissionReminderSent = false;
  let elicitationReminderSent = false;
  let modelTimeMs = 0;
  /**
   * The composer shows one narration bubble for the whole compile, but Bind's
   * stream resets are scoped to a turn: a route restart replays only the turn
   * it abandoned. Remembering what earlier turns settled lets a reset restore
   * them instead of erasing the plan the person has already read, and lets the
   * `started` frame — which clears the bubble — be sent once rather than once
   * per turn.
   */
  const narration = { started: false, turnId: "", settled: "", current: "" };
  const narrationBatch = createTextDeltaBatcher(async (delta) => {
    await input.onStreamEvent?.({ type: "delta", delta, reset: false });
  });
  /**
   * Every frame that is not batched narration settles the batch first, so a
   * tool row, a thinking row, or the completion can never overtake the text
   * that was written before it.
   */
  const emitStreamEvent = async (event: AutomationCompilerStreamEvent): Promise<void> => {
    await narrationBatch.flush();
    await input.onStreamEvent?.(event);
  };
  const toolStartedAt = new Map<string, number>();
  const toolLabelPlugins = new Map<string, AutomationPluginActivity[]>();
  const creatorDefinition = (name: string): HarnessTool["definition"] => {
    const definition = AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`automation_creator_definition_missing:${name}`);
    return definition;
  };
  const creatorTools: HarnessTool[] = [
    {
      definition: creatorDefinition("plugins_list"),
      execute: async () => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_list", {}, catalog),
        summary: "Listed authorized automation plugins",
      }),
    },
    {
      definition: creatorDefinition("plugins_search"),
      execute: async (raw) => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_search", asRecord(raw), catalog),
        summary: "Searched authorized automation plugins",
      }),
    },
    {
      definition: creatorDefinition("plugin_inspect"),
      execute: async (raw) => {
        const output = executeAutomationCreatorDiscoveryTool("plugin_inspect", asRecord(raw), catalog);
        const pluginId = String(asRecord(raw).pluginId ?? "");
        if (pluginId) inspectedAutomationPluginIds.add(pluginId);
        return { output, summary: "Inspected an authorized automation plugin" };
      },
    },
    {
      definition: creatorDefinition("people_search"),
      validateInput: (raw) => {
        const parsed = z.object({ query: z.string().min(1) }).strict().safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw) => {
        if (!input.draftResearchPort) throw new Error("automation_draft_research_host_unavailable");
        const { query } = z.object({ query: z.string().min(1) }).strict().parse(raw);
        const output = await input.draftResearchPort.searchPeople(query);
        const people = asRecord(output).people;
        if (Array.isArray(people)) {
          for (const person of people) {
            const id = asRecord(person).id;
            if (typeof id === "string") resolvedAutomationPersonIds.add(id);
          }
        }
        return {
          output,
          summary: "Searched workspace people",
        };
      },
    },
    {
      definition: creatorDefinition("resources_search"),
      validateInput: (raw) => {
        const parsed = z.object({ query: z.string().min(1) }).strict().safeParse(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw) => {
        if (!input.draftResearchPort) throw new Error("automation_draft_research_host_unavailable");
        const { query } = z.object({ query: z.string().min(1) }).strict().parse(raw);
        const output = await input.draftResearchPort.searchResources(query);
        const resources = asRecord(output).resources;
        if (Array.isArray(resources)) {
          for (const resource of resources) {
            const row = asRecord(resource);
            if (
              typeof row.id === "string"
              && typeof row.pluginId === "string"
              && typeof row.resourceType === "string"
            ) {
              resolvedAutomationResources.set(row.id, {
                pluginId: row.pluginId,
                resourceType: row.resourceType,
                sourceBindingKeys: Array.isArray(row.sourceBindingKeys)
                  ? row.sourceBindingKeys.filter((value): value is string => typeof value === "string")
                  : [],
              });
            }
          }
        }
        return {
          output,
          summary: "Searched authorized resources",
        };
      },
    },
    {
      definition: creatorDefinition("submit_draft"),
      serial: true,
      /**
       * The draft's real contract is `AutomationDraftSchema`, and the parts of
       * it that decide whether a submission is accepted — a ready activity
       * trigger's binding key, its inspected plugin, its declared prefilter
       * event type, unique memory-table names — are cross-field refinements no
       * JSON Schema can state, so the declared `inputSchema` accepts arguments
       * the executor then rejects.
       *
       * Without this hook the runtime sees arguments that match everything it
       * was shown, files the executor's `ZodError` as downstream data
       * validation, and hands the model "the tool could not validate its data;
       * retry without changing the arguments". The model obeys: it resubmits
       * the same draft, is refused identically, and the compile ends with no
       * draft at all. That is request 8592b3f1 — four identical rejections of
       * one missing `deterministicPrefilter.eventType`, then
       * `automation_draft_not_submitted` and a 502 the person could only read
       * as "try again". Re-running the same parse here is what turns that dead
       * end into the named field, because it is the one signal that separates a
       * correctable argument from an external fault.
       */
      validateInput: (raw) => {
        const parsed = parseAutomationSubmission(raw);
        return parsed.success ? null : parsed.error;
      },
      execute: async (raw, context) => {
        await input.onDiagnostic?.({
          stage: "normalize",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
        });
        const parsed = parseAutomationSubmission(raw);
        await input.onDiagnostic?.({
          stage: "validate",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
          ...(!parsed.success
            ? {
                validationIssues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
                })),
              }
            : {}),
        });
        if (!parsed.success) throw parsed.error;
        if (parsed.data.ready) {
          const sourcePluginIds = parsed.data.triggers.flatMap((trigger) =>
            trigger.type === "connector_activity" || trigger.type === "semantic_activity" || trigger.type === "webhook"
              ? trigger.suggestedSourcePluginId ? [trigger.suggestedSourcePluginId] : []
              : []);
          const unloadedPluginId = [...sourcePluginIds, ...parsed.data.recommendedPlugins.map((plugin) => plugin.pluginId)]
            .find((pluginId) => (
              !loadedAutomationPluginIds.has(pluginId) || !inspectedAutomationPluginIds.has(pluginId)
            ));
          if (unloadedPluginId) {
            throw new Error(`Load and inspect ${unloadedPluginId} before submitting it in a ready automation draft`);
          }
        }
        await input.draftMutationPort?.submitDraft(parsed.data, context);
        draftState.submitted = parsed.data;
        await input.onDiagnostic?.({
          stage: "complete",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
        });
        return {
          output: { accepted: true },
          summary: draftState.submitted.ready ? "Submitted ready automation draft" : "Submitted partial automation draft",
          ...(draftState.submitted.ready ? { halt: "completed" as const } : {}),
        };
      },
    },
    {
      definition: creatorDefinition("set_evaluator_rules"),
      serial: true,
      validateInput: (raw) => evaluatorRuleIssues(raw),
      execute: async (raw, context) => {
        if (!input.draftMutationPort) throw new Error("automation_draft_mutation_host_unavailable");
        // The harness consults `validateInput` only after the executor has
        // already thrown a ZodError, so a semantic check that lives there
        // alone never runs — the rule reaches durable storage unchecked. The
        // executor enforces the same function, and `validateInput` keeps
        // pointing at it so the two can never drift.
        const issues = evaluatorRuleIssues(raw);
        if (issues) throw issues;
        const rules = AutomationSetEvaluatorRulesInputV1Schema.parse(raw);
        const result = await input.draftMutationPort.setEvaluatorRules(rules, context);
        return {
          output: result,
          summary: rules.evaluators.length === 0
            ? "Cleared external event evaluator rules"
            : `Set ${rules.evaluators.length} external event evaluator rule${rules.evaluators.length === 1 ? "" : "s"}`,
        };
      },
    },
  ];
  function evaluatorRuleIssues(raw: unknown): z.ZodError | null {
        const parsed = AutomationSetEvaluatorRulesInputV1Schema.safeParse(raw);
        if (!parsed.success) return parsed.error;
        const issues: z.core.$ZodIssue[] = [];
        for (const [index, evaluator] of parsed.data.evaluators.entries()) {
          const plugin = catalog.find((candidate) => candidate.pluginId === evaluator.source.suggestedSourcePluginId);
          if (!plugin || !inspectedAutomationPluginIds.has(plugin.pluginId)) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "suggestedSourcePluginId"],
              message: "This plugin has not been inspected. Call automation_plugin_inspect with this plugin ID, then set the rules again using only the event types and filter fields it declares.",
              input: evaluator.source.suggestedSourcePluginId,
            });
            continue;
          }
          const event = evaluator.source.event;
          const eventTypes = event.kind === "event_type"
            ? [event.eventType]
            : plugin.activityTriggers
                .filter((descriptor) => (descriptor.eventFamilies ?? []).includes(event.eventFamily))
                .map((descriptor) => descriptor.eventType);
          if (eventTypes.length === 0) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "event"],
              message: "This plugin declares no event of that name or family. Use one of the event types listed by automation_plugin_inspect for this plugin.",
              input: evaluator.source.event,
            });
            continue;
          }
          const resolvedResource = evaluator.source.resourceId
            ? resolvedAutomationResources.get(evaluator.source.resourceId)
            : undefined;
          if (
            evaluator.source.resourceId
            && (
              !resolvedResource
              || resolvedResource.pluginId !== plugin.pluginId
              || !resolvedResource.sourceBindingKeys.includes(evaluator.source.sourceBindingKey)
            )
          ) {
            issues.push({
              code: "custom",
              path: ["evaluators", index, "source", "resourceId"],
              message: "This resource is not one this plugin can watch. Find it with resources_search and use an ID it returns for this source binding.",
              input: evaluator.source.resourceId,
            });
          }
          for (const eventType of eventTypes) {
            const descriptor = plugin.activityTriggers.find((candidate) => candidate.eventType === eventType);
            if (
              resolvedResource
              && !(descriptor?.resourceRelationships ?? []).some(
                (relationship) => relationship.resourceType === resolvedResource.resourceType,
              )
            ) {
              issues.push({
                code: "custom",
                path: ["evaluators", index, "source", "resourceId"],
                message: "This event cannot be filtered by that resource type. Use a resource whose type appears in the relationships automation_plugin_inspect lists for this event.",
                input: evaluator.source.resourceId,
              });
            }
            if (!descriptor || evaluator.when.kind !== "dnf") continue;
            for (const [groupIndex, group] of evaluator.when.anyOf.entries()) {
              for (const [leafIndex, leaf] of group.allOf.entries()) {
                const field = (descriptor.filterFields ?? []).find((candidate) => candidate.key === leaf.attribute);
                if (
                  !field
                  || !(field.operators ?? []).includes(leaf.operator)
                  || (leaf.kind !== "presence" && leaf.kind !== field.valueType)
                ) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "anyOf", groupIndex, "allOf", leafIndex],
                    message: "This filter field, operator, or value type is not one the plugin declares. Use a field from automation_plugin_inspect with one of the operators it lists and a value of the type it names.",
                    input: leaf,
                  });
                }
                if (
                  (leaf.kind === "person_id" || leaf.kind === "person_id_array")
                  && (Array.isArray(leaf.value) ? leaf.value : [leaf.value])
                    .some((personId) => !resolvedAutomationPersonIds.has(personId))
                ) {
                  issues.push({
                    code: "custom",
                    path: ["evaluators", index, "when", "anyOf", groupIndex, "allOf", leafIndex, "value"],
                    message: "This person ID was never resolved. Find the person with people_search and use an ID it returned.",
                    input: leaf.value,
                  });
                }
              }
            }
          }
        }
    return issues.length > 0 ? new z.ZodError(issues) : null;
  }
  const timeTool = automationCurrentTimeTool(input.defaultTimezones);
  const requestElicitationTool: HarnessTool = {
    definition: AVALON_REQUEST_ELICITATION_TOOL_DEFINITION,
    serial: true,
    validateInput: (raw) => {
      const result = RequestElicitationInputSchema.safeParse(raw);
      return result.success ? null : result.error;
    },
    execute: async (raw, context) => {
      const args = RequestElicitationInputSchema.parse(raw);
      if (!draftState.submitted) {
        throw new Error("Submit the best current draft with automation_submit_draft before requesting input");
      }
      await input.draftMutationPort?.requestElicitation(args, context);
      draftState.submitted = {
        ...draftState.submitted,
        followUpQuestion: args.prompt,
        elicitation: {
          responseType: args.responseType === "text" ? "free_text" : args.responseType === "multi_select" ? "multi_select" : "single_select",
          prompt: args.prompt,
          placeholder: null,
          options: args.options,
          minimumSelections: args.minimumSelections,
          maximumSelections: args.maximumSelections,
          allowOther: args.responseType !== "text",
        },
        ready: false,
      };
      return {
        output: { accepted: true },
        summary: "Requested automation input",
        halt: "needs_input",
      };
    },
  };
  const corePlugins: HarnessPlugin[] = [
    {
      canonicalId: AVALON_CORE_PLUGIN_ID,
      modelId: "rally_core",
      shortWireName: "core",
      description: "Read the exact current time and applicable timezones.",
      systemMessage: "Use core_current_time when exact current time or timezone matters; never infer it from transcript timestamps. Use core_request_elicitation only after saving the best current draft when a blocking human choice remains.",
      tools: [timeTool, requestElicitationTool],
      preload: true,
      explicit: true,
    },
    {
      canonicalId: AVALON_AUTOMATION_ARCHITECT_PLUGIN_ID,
      modelId: "rally_automation_architect",
      shortWireName: "automation",
      description: "Research authorized plugins, inspect frozen draft attachments, and submit automation drafts.",
      tools: [...creatorTools, ...(input.architectTools ?? [])],
      preload: true,
      explicit: true,
    },
  ];
  await input.onDiagnostic?.({
    stage: "model_request",
    schemaName: "automation_draft",
    model: input.model,
    attempt: 1,
    fallbackAttempt: 0,
    repairAttempt: 0,
  });
  const compilerExecutionId = crypto.randomUUID();
  const outcome = await runHarness({
    config: {
      apiKey: input.apiKey,
      primaryModel: input.model,
      fallbackModels: input.fallbackModels ?? [],
      ...(input.fetch ? { fetch: input.fetch } : {}),
      sameModelRetries: 1,
      maxIterations: Math.max(12, Math.min(32, input.maxResearchIterations ?? 20)),
      maxToolCalls: 80,
      maxWallClockMs: 180_000,
      toolTimeoutMs: 10_000,
      ...(input.transportRetries === undefined ? {} : { transportRetries: input.transportRetries }),
      maxWebResults: Math.max(1, Math.min(20, input.maxWebResults ?? 8)),
      maxCostCents: 1_000,
      maxCatalogTokens: 2_500,
      reasoningEffort: "high",
    },
    workspaceId: input.workspaceId ?? "00000000-0000-7000-8000-000000000001",
    workstreamId: "00000000-0000-7000-8000-000000000002",
    loopId: input.loopId
      ?? `automation-compiler:${input.workspaceId ?? "default"}:${input.userId ?? "default"}:loop`,
    harnessRunId: compilerExecutionId,
    executionPrincipal: {
      type: "user",
      userId: asUserId(input.userId ?? "00000000-0000-7000-8000-000000000003"),
    },
    traceContext: input.traceContext ?? {
      source: "automation_compiler",
      feature: AGENT_MODEL_FLAG_KEYS.automation_compiler,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.userId ? { contextUserId: input.userId } : {}),
    },
    systemPrompt: String(rendered[0]?.content ?? ""),
    messages: [
      ...conversationMessages,
      {
        role: "user",
        content: [
          "The arguments to automation_submit_draft are the expected structured output and must match this rendered schema exactly:",
          renderExpectedJsonSchema("automation_draft", automationDraftSubmissionJsonSchema),
        ].join("\n\n"),
      },
    ],
    plugins: [...(input.additionalPlugins ?? []), ...executablePlugins],
    compaction: {
      ...(input.contextWindowTokensByModel
        ? { contextWindowTokensByModel: input.contextWindowTokensByModel }
        : input.fetch
          ? { contextWindowTokensByModel: Object.fromEntries([
              input.model,
              ...(input.fallbackModels ?? []),
            ].map((modelId) => [modelId, 200_000])) }
          : {}),
    },
    corePlugins,
    // The compiler is intentionally ephemeral and has no participant
    // transcript. Bind still reserves its stable model-turn identity before
    // provider I/O; there is simply no participant sequence to attach.
    onEvent: async (event) => {
      if (event.type === "stream_started") {
        if (narration.started) return;
        narration.started = true;
        await emitStreamEvent({ type: "started" });
      } else if (event.type === "stream_delta") {
        if (event.turnId !== narration.turnId) {
          narration.settled = [narration.settled, narration.current].filter(Boolean).join("\n\n");
          narration.turnId = event.turnId;
          narration.current = "";
        }
        if (event.reset) {
          narration.current = "";
          // The retraction goes out alone: anything still pending belongs to
          // the attempt being abandoned, and coalescing it behind this frame
          // would restore the text the reset exists to remove.
          narrationBatch.discard();
          await emitStreamEvent({ type: "delta", delta: narration.settled, reset: true });
          return;
        }
        if (!event.delta) return;
        // A new turn continues the same bubble, so its first fragment carries
        // the paragraph break that separates it from the previous update.
        const separator = narration.settled && !narration.current ? "\n\n" : "";
        narration.current += event.delta;
        await narrationBatch.push(`${separator}${event.delta}`);
      } else if (event.type === "tool_started") {
        const plugin = automationOwningPlugin(event.pluginId, catalog);
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (plugin ? {
              started: "Using an authorized connector…",
              completed: "Connector operation completed",
            } : undefined);
        if (!presentation) return;
        const labelPlugins = plugin
          ? [plugin]
          : automationSubjectPlugins(event.toolName, event.input, catalog);
        toolStartedAt.set(event.toolCallId, Date.now());
        toolLabelPlugins.set(event.toolCallId, labelPlugins);
        await emitStreamEvent({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "started", labelPlugins),
          summary: presentation.started,
          status: "started",
          plugin,
        });
      } else if (event.type === "tool_completed") {
        if (event.toolName === "load_plugin") {
          const loaded = String(asRecord(event.result.output).loaded ?? "");
          if (loaded) loadedAutomationPluginIds.add(loaded);
        }
        const plugin = automationOwningPlugin(event.pluginId, catalog);
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (plugin ? {
              started: "Using an authorized connector…",
              completed: event.result.summary,
            } : undefined);
        if (!presentation) return;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const labelPlugins = plugin
          ? [plugin]
          : automationSubjectPluginsFromResult(
              event.toolName,
              event.result.output,
              catalog,
              toolLabelPlugins.get(event.toolCallId) ?? [],
            );
        toolStartedAt.delete(event.toolCallId);
        toolLabelPlugins.delete(event.toolCallId);
        await emitStreamEvent({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "completed", labelPlugins),
          summary: presentation.completed,
          status: "completed",
          plugin,
          ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
        });
      } else if (event.type === "tool_failed") {
        const plugin = automationOwningPlugin(event.pluginId, catalog);
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (plugin ? {
              started: "Using an authorized connector…",
              completed: "Connector operation failed",
            } : undefined);
        if (!presentation) return;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const labelPlugins = plugin ? [plugin] : toolLabelPlugins.get(event.toolCallId) ?? [];
        toolStartedAt.delete(event.toolCallId);
        toolLabelPlugins.delete(event.toolCallId);
        await emitStreamEvent({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "failed", labelPlugins),
          summary: "This research step failed; Rally will adjust the plan.",
          status: "failed",
          plugin,
          ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
        });
      }
    },
    onInferenceRequest: async (request) => {
      await input.onInferenceRequest?.(request);
      await emitStreamEvent({
        type: "thinking",
        inferenceRequestId: request.inferenceRequestId,
        status: "started",
        durationMs: modelTimeMs,
      });
    },
    onInferenceAttempt: async (attempt) => {
      await input.onInferenceAttempt?.(attempt);
      modelTimeMs += attempt.latencyMs;
      await emitStreamEvent({
        type: "thinking",
        inferenceRequestId: attempt.inferenceRequestId,
        status: "completed",
        durationMs: modelTimeMs,
      });
      await input.onDiagnostic?.({
        stage: "model_response",
        schemaName: "automation_draft",
        model: attempt.model,
        attempt: attempt.cursor.endpointAttempt + 1,
        fallbackAttempt: attempt.cursor.candidateIndex,
        repairAttempt: attempt.cursor.structuredOutputAttempt,
        latencyMs: attempt.latencyMs,
        success: attempt.success,
        ...(attempt.inputTokens === undefined ? {} : { inputTokens: attempt.inputTokens }),
        ...(attempt.outputTokens === undefined ? {} : { outputTokens: attempt.outputTokens }),
        ...(attempt.reasoningTokens === undefined ? {} : { reasoningTokens: attempt.reasoningTokens }),
        ...(attempt.cachedInputTokens === undefined ? {} : { cachedInputTokens: attempt.cachedInputTokens }),
        ...(attempt.responseBytes === undefined ? {} : { responseBytes: attempt.responseBytes }),
        ...(attempt.failureKind === undefined ? {} : { failureKind: attempt.failureKind }),
      });
    },
    acceptEmptyCompletion: true,
    onTurnWouldEnd: () => {
      if (!draftState.submitted && !submissionReminderSent) {
        submissionReminderSent = true;
        return [
          "You ended the previous turn without successfully calling automation_submit_draft, so no automation draft has been submitted.",
          "Call automation_submit_draft now with the best current draft and set ready=false only when an essential blocking detail remains.",
          "The tool arguments must match this rendered JSON Schema exactly:",
          renderExpectedJsonSchema("automation_draft", automationDraftSubmissionJsonSchema),
          "Call automation_submit_draft without assistant text in the same turn. Do not print the JSON as Markdown.",
        ].join("\n\n");
      }
      if (draftState.submitted && !draftState.submitted.ready && !draftState.submitted.elicitation && !elicitationReminderSent) {
        elicitationReminderSent = true;
        return [
          "The saved automation draft still needs blocking input.",
          "Call core_request_elicitation now with exactly one focused structured question. Do not ask the question in assistant text.",
        ].join("\n\n");
      }
      return null;
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (draftState.submitted && (draftState.submitted.ready || draftState.submitted.elicitation)) {
    await emitStreamEvent({ type: "completed" });
    return draftState.submitted;
  }
  if (outcome.failure) {
    throw new AutomationCompilerError(
      outcome.failure.code,
      outcome.failure.kind,
      outcome.failure.kind !== "authorization" && outcome.failure.kind !== "ambiguous_external_write",
      memberSafeHarnessFailureMessage(outcome.failure.code),
    );
  }
  throw new AutomationCompilerError(
    "automation_draft_not_submitted",
    "completion",
    true,
    "The automation creator ended without submitting a draft",
  );
}

function executeAutomationCreatorDiscoveryTool(
  toolName: string,
  args: Record<string, unknown>,
  catalog: AutomationCreatorPluginCatalogEntry[],
): unknown {
  if (toolName === "plugins_list") {
    return {
      plugins: catalog.map((plugin) => ({
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        description: plugin.description,
        scope: plugin.scope,
        aliases: plugin.searchAliases,
        tools: plugin.tools.map((tool) => ({ name: tool.name, description: tool.description, capability: tool.capability, mode: tool.mode })),
        activityTriggerCount: plugin.activityTriggers.length,
      })),
    };
  }
  if (toolName === "plugins_search") {
    const query = String(args.query ?? "").trim().toLocaleLowerCase();
    const matches = catalog.filter((plugin) => JSON.stringify({
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      description: plugin.description,
      aliases: plugin.searchAliases,
      tools: plugin.tools.map((tool) => ({ name: tool.name, description: tool.description, capability: tool.capability })),
      activityTriggers: plugin.activityTriggers.map((trigger) => ({ eventType: trigger.eventType, label: trigger.label })),
    }).toLocaleLowerCase().includes(query));
    return {
      query,
      plugins: matches.map((plugin) => ({
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        description: plugin.description,
        scope: plugin.scope,
        aliases: plugin.searchAliases,
        tools: plugin.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          capability: tool.capability,
          mode: tool.mode,
        })),
      })),
    };
  }
  if (toolName === "plugin_inspect") {
    const pluginId = String(args.pluginId ?? "");
    const plugin = catalog.find((entry) => entry.pluginId === pluginId);
    return plugin ? {
      plugin: {
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        description: plugin.description,
        scope: plugin.scope,
        aliases: plugin.searchAliases,
        systemMessage: plugin.systemMessage,
        tools: plugin.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          capability: tool.capability,
          mode: tool.mode,
          idempotency: tool.idempotency ?? "safe",
          inputSchema: tool.inputSchema,
        })),
        // Projected rather than returned whole, like `plugins_search` above.
        // A descriptor also carries `digestible`, which answers a question
        // about scheduled digests and nothing about whether an automation may
        // trigger on the event — and it reads `false` on two thirds of GitHub's
        // triggers, which a model building an automation would reasonably take
        // as "not available to me".
        activityTriggers: plugin.activityTriggers.map((trigger) => ({
          eventType: trigger.eventType,
          label: trigger.label,
          description: trigger.description,
          filterFields: trigger.filterFields,
        })),
      },
    } : { error: "plugin_not_found", pluginId };
  }
  return { error: "unknown_discovery_tool" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function automationCurrentTimeTool(
  defaultTimezones?: { personal: string; workspace: string },
): HarnessTool {
  return {
    definition: AVALON_CURRENT_TIME_TOOL_DEFINITION,
    execute: async (raw) => {
      const args = z.object({ timezone: z.string().min(1).max(100).optional() }).parse(raw);
      const workspaceTimezone = canonicalIanaTimezone(defaultTimezones?.workspace ?? "UTC");
      const timezone = canonicalIanaTimezone(
        args.timezone ?? defaultTimezones?.personal ?? workspaceTimezone,
      );
      const text = easyEnglishCurrentTime(new Date(), timezone, workspaceTimezone);
      return { output: text, summary: text };
    },
  };
}

function canonicalIanaTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function easyEnglishCurrentTime(
  instant: Date,
  timezone: string,
  workspaceTimezone: string,
): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return [
    `current local time: ${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
    `local timezone: ${timezone}`,
    `workspace timezone: ${workspaceTimezone}`,
    `local date: ${parts.month} ${parts.day} ${parts.year}`,
    `iso8601 timestamp: ${instant.toISOString()}`,
  ].join("\n");
}

/**
 * The one parse a submitted draft gets.
 *
 * Both the executor and `validateInput` go through here, because the
 * correction the model receives is only useful if it names a field the
 * executor actually rejects. Two call sites that each normalized and parsed
 * for themselves would be one edit away from disagreeing — and a correction
 * naming a field the executor is fine with is the same unwinnable loop with a
 * different field's name on it.
 */
function parseAutomationSubmission(raw: unknown): z.ZodSafeParseResult<AutomationDraft> {
  return AutomationDraftSchema.safeParse(normalizeAutomationDraft(raw));
}

function normalizeAutomationDraft(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const draft = value as Record<string, unknown>;
  const triggers = Array.isArray(draft.triggers)
    ? draft.triggers.map((trigger) => normalizeAutomationTrigger(trigger))
    : draft.triggers;
  const ready = draft.ready !== false;
  return {
    ...draft,
    triggers,
    requiredCapabilities: [],
    defaultBehavior: parseJsonObject(draft.defaultBehavior),
    memoryTables: Array.isArray(draft.memoryTables) ? draft.memoryTables : [],
    // A destination named twice is one destination, and one the schema does not
    // know is dropped rather than failing the whole submission — the draft is
    // still usable, the create screen just does not pre-tick that box. Sorted
    // as well as de-duplicated: the normalized draft is rendered back into the
    // compiler's own prefix on every later turn, so letting the model's word
    // order decide those bytes costs a prompt-cache hit per turn for nothing.
    requestedDelivery: Array.isArray(draft.requestedDelivery)
      ? [...new Set(draft.requestedDelivery.filter((entry) =>
        entry === "email" || entry === "slack_agent_dm"))].sort()
      : [],
    ready,
    followUpQuestion: null,
    elicitation: null,
  };
}

function normalizeAutomationTrigger(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const trigger = value as Record<string, unknown>;
  switch (trigger.type) {
    case "manual":
      return { type: "manual" };
    case "calendar":
      return {
        type: "calendar",
        rrule: trigger.rrule,
        // A zone nobody named stays absent all the way to storage. Filling the
        // account default in here would make it byte-identical to a zone the
        // person asked for, and every later reader — the create screen's chosen
        // scope, somebody adopting a shared template — would be answering with
        // the drafting session's guess instead of their own account.
        timezone: typeof trigger.timezone === "string" && trigger.timezone.trim()
          ? trigger.timezone
          : null,
        summary: normalizeTriggerSummary(trigger.summary, "Recurring schedule"),
      };
    case "interval":
      return {
        type: "interval",
        intervalSeconds: trigger.intervalSeconds,
        summary: normalizeTriggerSummary(trigger.summary, "Recurring interval"),
      };
    case "connector_activity":
      return {
        type: "connector_activity",
        connectorType: trigger.connectorType,
        sourceBindingKey: trigger.sourceBindingKey,
        suggestedSourcePluginId: trigger.suggestedSourcePluginId,
        eventTypes: trigger.eventTypes,
        deterministicFilters: parseJsonObject(trigger.deterministicFilters)
      };
    case "semantic_activity":
      return {
        type: "semantic_activity",
        connectorType: trigger.connectorType,
        sourceBindingKey: trigger.sourceBindingKey,
        suggestedSourcePluginId: trigger.suggestedSourcePluginId,
        deterministicPrefilter: jsonObjectOrRaw(trigger.deterministicPrefilter),
        condition: trigger.condition
      };
    case "resource_watch":
      return { type: "resource_watch", resourceId: trigger.resourceId };
    case "webhook":
      return {
        type: "webhook",
        sourceBindingKey: trigger.sourceBindingKey,
        suggestedSourcePluginId: trigger.suggestedSourcePluginId,
        eventTypes: trigger.eventTypes,
      };
    default:
      return value;
  }
}

function normalizeTriggerSummary(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * A JSON-encoded object, or whatever was sent when it is not one.
 *
 * `parseJsonObject` answers `{}` for a string it cannot decode, which is the
 * right tolerance for a field nobody has to get right. It is the wrong one
 * here: an empty prefilter fails the ready-trigger refinement, so a model that
 * sent `{eventType: drive.file_changed}` — unquoted keys, or a JSON string
 * encoded twice — is told it declared no event type while looking at one it
 * plainly wrote, and resubmits. Handing the string through instead lets the
 * schema reject the value that was actually sent. On a draft that is saved it
 * also stops a filter the model wrote being dropped, which would leave the
 * automation matching every event of its kind rather than the one asked for.
 */
function jsonObjectOrRaw(value: unknown): unknown {
  if (typeof value !== "string") return parseJsonObject(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export interface HarnessToolContext {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  /** Stable durable receipt ID for this exact tool request. */
  toolCallId: string;
  /**
   * The host's durable identity for whatever this call does outside Avalon.
   *
   * `toolCallId` names the request; this names the receipt the host recorded
   * for it, and it is what a tool keys provider-side work to — a sandbox task,
   * a remote job — so a resumed attempt finds the effect it already started
   * rather than starting a second one.
   *
   * Optional because only the host can mint it, and a host may implement no
   * receipt ports at all. A tool that needs one must fail when it is absent;
   * substituting `toolCallId` would key the effect to a coordinate the
   * recorded receipt never used.
   */
  effectIntentId?: string;
  executionPrincipal: ExecutionPrincipal;
  /** Stable per-receipt key for provider APIs that support idempotent writes. */
  providerIdempotencyKey?: string;
  signal: AbortSignal;
}

export interface HarnessToolResult {
  output: unknown;
  summary: string;
  /**
   * Current-turn model content that must never enter a durable receipt or
   * transcript. The harness relays these parts after the JSON tool result and
   * the host recreates them from authorized regional state on receipt replay.
   */
  contentParts?: ModelMessageContentPart[];
  providerOperationId?: string;
  halt?: "needs_input" | "completed";
  /** Bind control signal used only by Avalon's discovery plugin loader. */
  loadedPluginName?: string;
  /** Bind control signal used only by `load_skill`. */
  loadedSkillRef?: string;
}

/**
 * One loadable instruction module, as the host hands it to the harness.
 *
 * Authored as markdown. `description` and `whenToUse` are the only parts the
 * model sees before it loads the skill, so they carry the whole routing
 * decision: what this is, and when it applies. `body` is paid for only on load.
 *
 * `SKILL.md` files parse straight into this shape with `parseSkillMarkdown`
 * from `@juno-ai/bind/skills`.
 */
export interface HarnessSkill {
  /** Lower-kebab identifier, unique within a run. What `load_skill` takes. */
  name: string;
  /** Tier-1 catalog line: what the skill does. */
  description: string;
  /** Tier-1 activation hint: when to reach for it. */
  whenToUse: string;
  /** The instructions injected once loaded. */
  body: string;
  /**
   * The plugin whose tools this skill describes, if any. Two effects, both
   * conservative: the skill is offered only to a run whose scope already
   * includes that plugin, and loading it *names* the plugin rather than
   * activating it — a document must not be able to grant a capability.
   */
  ownerPlugin?: string;
  /** Bundled reference files, readable with `read_skill_resource` after loading. */
  resources?: Array<{ path: string; body: string; contentType?: string }>;
}

/**
 * Immutable policy identity selected by Bind when it resolves a model tool
 * call. The provider-facing wire name is intentionally absent: providers may
 * rewrite that alias, while authorization and durable receipts must remain
 * bound to the canonical tool definition.
 */
export interface HarnessToolPolicyIdentity {
  canonicalToolName: string;
  capability: string;
  mode: ToolDefinition["mode"];
  idempotency: ToolDefinition["idempotency"];
}

export interface BeforeToolCallInput {
  pluginId: string;
  toolName: string;
  inputHash: string;
  policy: HarnessToolPolicyIdentity;
  signal: AbortSignal;
}

export type BeforeToolCallDecision =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

export type BeforeToolCallHook = (
  input: BeforeToolCallInput,
) => BeforeToolCallDecision | void | Promise<BeforeToolCallDecision | void>;

/** Compose host policy hooks in order, stopping at the first explicit rejection. */
export function composeBeforeToolCallHooks(
  ...hooks: Array<BeforeToolCallHook | null | undefined>
): BeforeToolCallHook {
  return async (input) => {
    for (const hook of hooks) {
      if (!hook) continue;
      const decision = await hook(input);
      if (decision?.allowed === false) return decision;
    }
    return { allowed: true };
  };
}

/** Keep tools model-visible while rejecting selected operation modes before execution. */
export function rejectToolModesBeforeCall(
  modes: ReadonlySet<ToolDefinition["mode"]> | readonly ToolDefinition["mode"][],
  message: string,
  code = "tool_mode_not_allowed",
): BeforeToolCallHook {
  const blockedModes = modes instanceof Set ? modes : new Set(modes);
  return ({ policy }) => blockedModes.has(policy.mode)
    ? { allowed: false, code, message }
    : { allowed: true };
}

/** Bind-owned catalog policies mirrored and verified by the durable host. */
export const AVALON_DISCOVERY_PLUGIN_ID = "rally:discovery";
export const AVALON_CORE_PLUGIN_ID = "rally:core";
export const AVALON_MEMORY_PLUGIN_ID = "rally:memory";
export const AVALON_TABLES_PLUGIN_ID = "rally:tables";
export const AVALON_WEB_PLUGIN_ID = "rally:web";
export const AVALON_WORKSTREAM_PLUGIN_ID = "rally:workstream";
export const AVALON_MULTIMODAL_GENERATION_PLUGIN_ID = "rally:multimodal-generation";
export const AVALON_AUTOMATION_ARCHITECT_PLUGIN_ID = "rally:automation_architect";

export const AVALON_CURRENT_TIME_TOOL_DEFINITION = {
  name: "current_time",
  description: "Return the current local time, local IANA timezone, workspace IANA timezone, local date, and UTC ISO-8601 timestamp. Local time defaults to the current user's timezone for user runs and the workspace timezone for workspace runs; optionally accepts another valid IANA timezone.",
  capability: "time.read",
  mode: "read",
  idempotency: "safe",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "Optional IANA timezone, for example America/New_York.",
      },
    },
  },
} as const satisfies ToolDefinition;

export const RequestElicitationInputSchema = z.object({
  prompt: z.string().min(1).max(4_000),
  responseType: z.enum(["text", "radio", "single_select", "multi_select"]),
  options: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(300),
    description: z.string().max(800).nullable().default(null),
  }).strict()).max(30).default([]),
  minimumSelections: z.number().int().nonnegative().default(0),
  maximumSelections: z.number().int().positive().nullable().default(null),
}).strict().superRefine((input, context) => {
  if (input.responseType !== "text" && input.options.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "Selection questions require options",
    });
  }
  if (input.maximumSelections !== null && input.maximumSelections < input.minimumSelections) {
    context.addIssue({
      code: "custom",
      path: ["maximumSelections"],
      message: "Maximum selections must be at least the minimum selections",
    });
  }
});

export type RequestElicitationInput = z.infer<typeof RequestElicitationInputSchema>;

export const AVALON_REQUEST_ELICITATION_TOOL_DEFINITION = {
  name: "request_elicitation",
  description:
    "Ask a structured blocking question and pause this harness run for human input. Call this only for what no authorized tool can determine: a value a connector, memory, or a durable table could look up is not missing input, so search for it first and ask only if that search comes back empty. Check the plugin catalog as part of that search — a connector listed there can answer even though its tools are absent from the current turn, and the tools in front of you are only the ones already loaded. State in the prompt what you already searched and what it returned.",
  capability: "elicitation.write",
  mode: "write",
  idempotency: "record_before_execute",
  inputSchema: z.toJSONSchema(RequestElicitationInputSchema) as Record<string, unknown>,
} as const satisfies ToolDefinition;

/**
 * The automation architect's own tools, as data.
 *
 * Split out of `compileAutomation` so the schema guard can reach them: they are
 * authored provider-facing schemas like any other, but they are built inside
 * that function against its run state, so a guard walking the registries could
 * not see them and would have reported a clean surface while they regressed.
 * Only `execute` needs the closure; the definitions never varied.
 */
export const AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS = [
  {
    name: "plugins_list",
    description: "List every connector plugin authorized for this automation creator, with compact trusted metadata.",
    capability: "rally.automation.plugins.list",
    mode: "read",
    idempotency: "safe",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "plugins_search",
    description: "Search authorized connector plugins and their tools by capability, provider, action, or keyword.",
    capability: "rally.automation.plugins.search",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    },
  },
  {
    name: "plugin_inspect",
    description: "Inspect one authorized plugin's trusted system guidance and exact tool schemas before recommending it.",
    capability: "rally.automation.plugins.inspect",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { pluginId: { type: "string" } },
      required: ["pluginId"],
    },
  },
  {
    name: "people_search",
    description: "Search authorized workspace people and return canonical person IDs for evaluator rules.",
    capability: "rally.automation.people.search",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    },
  },
  {
    name: "resources_search",
    description: "Search authorized resources and return canonical resource IDs with their source plugin and binding relationship.",
    capability: "rally.automation.resources.search",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    },
  },
  {
    name: "set_evaluator_rules",
    description: "Replace all external-event evaluator rules for this draft. Search for people and resources and inspect each named plugin first. Pass [] only to clear all rules.",
    capability: "rally.automation.evaluators.set",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: z.toJSONSchema(AutomationSetEvaluatorRulesInputV1Schema) as Record<string, unknown>,
  },
  {
    name: "submit_draft",
    description: "Save the best current automation draft. Set ready=false when blocking input remains, then call core_request_elicitation with the structured question.",
    capability: "rally.automation.submit",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: automationDraftSubmissionJsonSchema,
  },
] as const satisfies readonly HarnessTool["definition"][];

export const AVALON_DISCOVERY_TOOL_DEFINITIONS = [
  {
    name: "list_plugins",
    description: "List plugins available to this frozen run scope.",
    capability: "rally.plugins.list",
    mode: "read",
    idempotency: "safe",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "search_plugins",
    description: "Search plugins available to this frozen run scope using ranked keywords across IDs, names, aliases, and descriptions. Returns the top 20 matches plus the total match count.",
    capability: "rally.plugins.search",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    },
  },
  {
    name: "load_plugin",
    description: "Load one available plugin from the catalog for this run.",
    capability: "rally.plugins.load",
    // Activation may prepare convergent host-owned runtime infrastructure, but
    // never performs an outward-facing provider/data write. Hooks must be safe
    // to resume from the same receipt after an ambiguous interruption.
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { pluginId: { type: "string" } },
      required: ["pluginId"],
    },
  },
] as const satisfies readonly ToolDefinition[];

export interface HarnessTool {
  definition: ToolDefinition;
  execute(input: unknown, context: HarnessToolContext): Promise<HarnessToolResult>;
  /** Resolve a host-only execution deadline after validated input is known. */
  resolveTimeoutMs?: (input: unknown) => number | undefined;
  /**
   * Re-run code-authored input refinements when a Zod failure escapes the
   * executor. JSON Schema cannot represent every refinement, so this keeps a
   * correctable argument error distinct from downstream response validation.
   *
   * **A tool whose executor parses with a schema stricter than the one it
   * advertises owes the runtime one of these.** Without it the runtime reads
   * only the advertised schema, finds arguments that match it, files the
   * tool's own rejection as somebody else's data problem, and tells the model
   * to retry without changing them — which it does, until the run ends. That
   * failure is silent in every log: `automation_submit_draft` shipped without
   * one and cost a production compile before anyone could see why.
   */
  validateInput?: (input: unknown) => z.ZodError | null;
  /** Execute in model-declared order before concurrent tools in the same batch. */
  serial?: boolean;
}

/** Frozen run identity passed to a deferred plugin while it becomes active. */
export interface HarnessPluginActivationContext {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  signal: AbortSignal;
}

/** A host-authored, model-safe explanation for a rejected plugin activation. */
export class HarnessPluginActivationError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessPluginActivationError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A Bind plugin whose trusted identity, prose, and tool policy are authored by the host. */
export interface HarnessPlugin {
  /** Stable host authorization/persistence identity (`avalon:*` or `connection:<uuid>`). */
  canonicalId: string;
  /** Stable identifier exposed to the model (`rally_core` or `plugin_google`). */
  modelId: string;
  shortWireName: string;
  /** Static, code-authored label used only for catalog display and discovery. */
  displayName?: string;
  /** Additional static, code-authored aliases accepted by plugin search. */
  searchAliases?: readonly string[];
  description: string;
  systemMessage?: string;
  tools: HarnessTool[];
  /**
   * Resolve a provider-authored tool surface when this deferred plugin is
   * activated. The catalog remains static and trusted; only the active tool
   * definitions are replaced. Results are cached for the lifetime of one run.
   */
  loadTools?: () => Promise<HarnessTool[]>;
  /**
   * Prepare plugin-owned runtime state before this deferred plugin becomes
   * model-visible after an explicit `load_plugin`. A rejection leaves the plugin
   * inactive. Successful preparation is cached for the run; a failed hook may
   * be retried by a later explicit load. Restored durable activations do not run
   * the hook and retain their ordinary first-tool preparation path.
   *
   * `load_plugin` is read-safe: this hook may prepare convergent host-owned
   * runtime infrastructure, but must be safe to repeat after response loss and
   * must not perform an outward-facing provider or user-data write. Throw
   * `HarnessPluginActivationError` only with host-authored model-safe guidance;
   * other rejection details are hidden from the model.
   */
  onActivate?: (context: HarnessPluginActivationContext) => Promise<void>;
  /** Extend `load_plugin`'s deadline for a blocking activation hook. */
  activationTimeoutMs?: number;
  /** For deferred plugins, requests persistence before an activation hint; ignored for core plugins. */
  preload: boolean;
  explicit?: boolean;
}

export type HarnessEvent =
  | {
      /** A lossy context checkpoint has begun and ordinary token output is paused. */
      type: "compaction_started";
      compactionIndex: number;
      trigger: "manual" | "auto";
    }
  | {
      /** The matching checkpoint either became durable or failed the run. */
      type: "compaction_finished";
      compactionIndex: number;
      trigger: "manual" | "auto";
      outcome: "completed" | "failed";
    }
  | {
      type: "stream_started";
      model: string;
      turnId: string;
      transcriptSequence?: number;
      epoch: number;
      streamSeq: number;
      reset: false;
    }
  | {
      type: "stream_delta";
      delta: string;
      turnId: string;
      transcriptSequence?: number;
      epoch: number;
      streamSeq: number;
      reset: boolean;
    }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      pluginId: string;
      policy: HarnessToolPolicyIdentity;
      input: unknown;
      providerIdempotencyKey?: string;
    }
  | { type: "tool_completed"; toolCallId: string; toolName: string; pluginId: string; policy: HarnessToolPolicyIdentity; result: HarnessToolResult }
  | {
      type: "tool_failed";
      toolCallId: string;
      toolName: string;
      pluginId: string;
      policy: HarnessToolPolicyIdentity;
      error: string;
      /** Sanitized model-facing recovery data, when the thrown error declares it. */
      data?: StructuredFailureDetail;
      phase: "validation" | "execution";
      outcome: "definitive_failure" | "timed_out" | "aborted" | "ambiguous_external_write";
    }
  | {
      type: "stream_completed";
      content: string;
      turnId: string;
      transcriptSequence?: number;
      usage: Record<string, number> | null;
    }
  | { type: "needs_input"; toolCallId: string };

export interface HarnessCompactionCheckpoint {
  trigger: "manual" | "auto";
  summary: string;
  messages: ModelMessage[];
  model: string;
  contextTokensBeforeCompaction: number;
  contextWindowTokens: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface HarnessCompactionConfig {
  /** Optional catalog snapshot, primarily for deterministic hosts/tests. */
  contextWindowTokensByModel?: Readonly<Record<string, number | null | undefined>>;
  /** Capture host authorization state before the summary sees the transcript. */
  prepare?: () => void | Promise<void>;
  /** Persist the compacted continuation context after Bind swaps it in. */
  persist?: (checkpoint: HarnessCompactionCheckpoint) => void | Promise<void>;
  /** Render fresh, authorized deterministic context for the live checkpoint only. */
  renderAppendix?: () => string | Promise<string>;
}

export interface BindCompactionCommit {
  checkpoint: HarnessCompactionCheckpoint;
  transition: Extract<BindLoopTransition, { kind: "state_replaced" }>;
}

/**
 * The outcome of revalidating one plugin's authorization.
 *
 * `denied` is a decision about authority: the credential was revoked, the
 * grant was withdrawn, the principal no longer owns it. `indeterminate` is the
 * absence of a decision — a provider timeout, a transport failure, a host
 * error. Both leave the plugin inactive, and they are deliberately separate:
 * only `denied` may be reported to the model as an authorization outcome, so a
 * failure to verify is never presented to a run as a revoked grant.
 */
export type PluginAuthorization = "authorized" | "denied" | "indeterminate";

/**
 * Why a plugin's authorization is being revalidated, which decides how far the
 * host has to go to answer.
 *
 * `activation` is a plugin becoming usable — a `load_plugin`, a restored hint,
 * the initial preload. It happens a handful of times per run, and the answer
 * has to be current all the way to the provider.
 *
 * `continuation` is the check between model turns, which runs before *every*
 * inference. What it exists to catch is authority the host itself withdrew
 * mid-run: a revoked grant, a removed member, an archived work stream, a
 * connection marked unhealthy — all of which the host knows from its own
 * records. Answering it with a provider round trip per active plugin per turn
 * spends real quota to re-learn something the host already knows, and on a
 * connector whose health check writes it is worse than wasteful.
 */
export type PluginAuthorizationOccasion = "activation" | "continuation";

export interface RunHarnessInput {
  config: OpenRouterConfig & {
    /** Optional iteration ceiling; callers that intend an unlimited loop omit it. */
    maxIterations?: number;
    /** Optional ceiling for deliberately bounded callers. Ordinary work-stream runs omit it. */
    maxToolCalls?: number;
    /** Optional ceiling for deliberately bounded callers. Ordinary work-stream runs omit it. */
    maxWallClockMs?: number;
    toolTimeoutMs: number;
    maxWebResults: number;
    /** Optional ceiling for deliberately bounded callers. Ordinary work-stream runs omit it. */
    maxCostCents?: number;
    /**
     * Budget for one catalog, applied **per catalog** rather than across them:
     * the plugin directory and the skill directory each get this much, so a run
     * with a large surface of both can carry up to twice it in catalog text.
     */
    maxCatalogTokens?: number;
    /** Cap on how many skills one run may hold loaded. Defaults to Bind's. */
    maxActiveSkills?: number;
    /** Cap on the bytes one `read_skill_resource` returns. Defaults to 64 KiB. */
    maxSkillResourceBytes?: number;
    /** Cap on the total tokens of loaded skill bodies. Defaults to Bind's. */
    maxActiveSkillBodyTokens?: number;
    maxStreamResets?: number;
    completionDefectRetries?: number;
    /**
     * Whole-plan re-executions after **every** route candidate failed with a
     * transport fault the provider owns (no response, 408, 429, 5xx).
     *
     * Bind's disposition matrix answers such a failure by traversing to the next
     * provider and then the fallback model; it has no same-endpoint budget for
     * one, because with somewhere to traverse to there is no reason to wait.
     * That leaves a plan with nowhere to go — a work stream pinned to one model
     * from the developer-mode selector, whose route carries no fallbacks by
     * design — with no recovery at all, so a single stalled request discards the
     * whole run. `isRetriableAttemptError` is Bind saying a fresh attempt later
     * could plausibly succeed and expecting the host to be the one that makes
     * it; this is that retry.
     *
     * Defaults to 1. Higher is not obviously better: each re-execution records
     * another failure against the shared per-workspace circuit breaker, whose
     * threshold is 3, so a large budget trades one run's recovery for opening
     * the endpoint on everyone else's.
     */
    transportRetries?: number;
    /** Model reasoning effort passed consistently through Bind's routed turns. */
    reasoningEffort?: "low" | "medium" | "high";
  };
  workspaceId: string;
  workstreamId: string;
  /** Stable identity of the one persistent Bind loop owned by this substream. */
  loopId: string;
  /** Subordinate execution receipt; never used as loop or turn identity. */
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  /** Provider-side Broadcast correlation. Hosts should supply the real surface identity. */
  traceContext?: OpenRouterTraceContext;
  /**
   * Resolves Azure billing rates before Bind builds a route. Production reads
   * per-model OpenRouter endpoint-average records from a shared Cloudflare KV.
   */
  resolveAzureModelPricing?: (
    canonicalModelIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, AzureModelPricing>>;
  systemPrompt: string;
  messages: ModelMessage[];
  /** Exact durable head to resume. Absent only when this loop has never started. */
  bindLoopProjection?: BindLoopProjectionState | null;
  /**
   * Enables provider-measured transcript compaction. The harness compares the
   * latest OpenRouter prompt + completion usage with 80% of the selected
   * model's advertised context window; it never estimates the prompt locally.
   */
  compaction?: HarnessCompactionConfig;
  /** Stable always-active plugin bundles registered for this runtime. */
  corePlugins?: HarnessPlugin[];
  plugins?: HarnessPlugin[];
  /** Disable even the built-in discovery tools for deliberately model-only runs. */
  pluginDiscovery?: boolean;
  /** Connector activations already durably persisted by the host. */
  activationHints?: string[];
  /**
   * Loadable instructions for this run — procedures and reference knowledge the
   * model may pull into its own prompt, the knowledge counterpart of `plugins`.
   *
   * Resolved by the host against the execution principal *before* admission and
   * frozen with the run scope, exactly like the plugin surface: `load_skill`
   * can only surface a body that is already in this array, so nothing here
   * reaches a store mid-run and no skill can widen what the run may read.
   */
  skills?: HarnessSkill[];
  /** Skill refs already durably recorded as loaded, for a resumed attempt. */
  skillActivationHints?: string[];
  /** Called when the model loads a skill, so a resumed attempt can restore it. */
  persistSkillActivation?: (ref: string) => void | Promise<void>;
  /**
   * Observe a skill warning from Bind: a name collision that lost a skill
   * (the registry is keyed by name, last write wins), a restored hint refused
   * by a narrowed scope, a pinned body that drifted. Unwired, all three are
   * computed and discarded.
   */
  onSkillWarning?: (message: string, fields: Record<string, unknown>) => void;
  includeWebSearch?: boolean;
  onEvent(event: HarnessEvent): void | Promise<void>;
  onBestEffortEventDropped?: (event: {
    type: "stream_started" | "stream_delta";
    turnId: string;
    transcriptSequence?: number;
    epoch: number;
    streamSeq: number;
  }) => void | Promise<void>;
  findCompletedToolResult?: (
    toolCallId: string,
    inputHash: string,
    policy: { pluginId: string } & HarnessToolPolicyIdentity,
  ) => Promise<HarnessToolResult | null>;
  reauthorizePlugin?: (
    canonicalId: string,
    occasion: PluginAuthorizationOccasion,
  ) => PluginAuthorization | Promise<PluginAuthorization>;
  persistActivation?: (canonicalId: string) => void | Promise<void>;
  onActivationDropped?: (drop: unknown) => void | Promise<void>;
  beforeToolCall?: BeforeToolCallHook;
  persistToolExecutionPlan?: (plan: {
    toolCallId: string;
    pluginId: string;
    wireToolName: string;
    canonicalToolName: string;
    inputHash: string;
    executionPlanHash: string;
    providerIdempotencyKey: string | null;
    mode: "read" | "write";
    idempotency: ToolDefinition["idempotency"];
  }) => void | Promise<void>;
  /**
   * The durable receipt identity the host recorded for this tool call.
   *
   * Resolved once per dispatch, after `tool_started` — the event a host uses
   * to write that receipt, and therefore the first moment it has an answer —
   * and before the tool runs, so the answer reaches the tool as
   * `HarnessToolContext.effectIntentId`.
   *
   * It is a port rather than something the harness derives because the host
   * mints the identity and keeps it: `toolCallId` is stable across a resumed
   * run, but its receipt row is created once, so an id recomputed here would
   * not match the one an interrupted attempt already wrote provider work
   * against. Returning `undefined` is how a host says it has none.
   */
  resolveToolEffectIntentId?: (
    toolCallId: string,
  ) => string | undefined | Promise<string | undefined>;
  checkpointToolInvocation?: (checkpoint: {
    toolCallId: string;
    state: "executing" | "provider_acknowledged" | "completed" | "failed" | "timed_out";
    providerOperationId?: string;
  }) => void | Promise<void>;
  onAmbiguousExternalWrite?: (event: { toolCallId: string; pluginId: string; toolName: string }) => void | Promise<void>;
  /** Receives the complete provider request body immediately before dispatch. */
  onInferenceRequest?: (request: InferenceRequestEvent) => void | Promise<void>;
  onInferenceAttempt?: (attempt: InferenceAttemptEvent) => void | Promise<void>;
  onTranscriptIssues?: (issues: Array<{ kind: string; index?: number; healed?: boolean }>) => void | Promise<void>;
  /**
   * Required by transcript-aware hosts. The callback must durably commit the
   * transition before resolving; Bind will not accept the corresponding message
   * or replacement into its private loop until it does.
   */
  onBindLoopTransition?: (transition: BindLoopTransition) => void | Promise<void>;
  /** Called after the exact post-validation provider input has been hash-checked. */
  onBindProviderBoundary?: (boundary: BindProviderBoundary) => void | Promise<void>;
  /**
   * Reserve the participant transcript position before any provider request for
   * this model turn. Transcript-aware hosts require this port and must commit
   * before resolving; generic Bind hosts omit it and receive sequence-less
   * stream/checkpoint events. In both cases the `assistant_reserved` Bind
   * transition is accepted before provider I/O.
   */
  onAssistantTurnReserved?: (turn: {
    loopId: string;
    executionId: string;
    turnId: string;
    modelTurnIndex: number;
  }) => { transcriptSequence: number } | Promise<{ transcriptSequence: number }>;
  /**
   * Durable activation boundary for model-only inputs such as a wake-up,
   * connector activity, digest brief, or recalled memory. The host atomically
   * deduplicates and commits these inputs under the supplied execution and Bind
   * head fence before resolving. Bind applies only the exact returned
   * transitions, requires an immutable-receipt acknowledgement for every
   * replay, and will not start provider I/O unless every requested ID appears
   * exactly once across those two result sets.
   */
  activationInputs?: readonly HarnessActivationInput[];
  onActivationBoundary?: (activation: {
    loopId: string;
    executionId: string;
    generation: number;
    stateRevision: number;
    inputs: readonly HarnessActivationInput[];
  }) => HarnessActivationBoundaryResult | Promise<HarnessActivationBoundaryResult>;
  /**
   * Atomic safe-boundary delivery for durable steer inputs. The host returns
   * only transitions it has already committed with the pending-input delivery.
   * Bind appends those exact messages after every tool batch settles and before
   * accepting a tool-less turn as final. A delayed elicitation answer may first
   * close its withheld tool slot, then append the participant response in the
   * same durable settlement.
   */
  onStepSettled?: (step: {
    loopId: string;
    executionId: string;
    assistantTurnId: string;
    modelTurnIndex: number;
    generation: number;
    stateRevision: number;
    wouldEnd: boolean;
  }) => {
    transitions: readonly Extract<BindLoopTransition, {
      kind: "tool_result_accepted" | "protocol_user_appended";
    }>[];
    stop: boolean;
  } | Promise<{
    transitions: readonly Extract<BindLoopTransition, {
      kind: "tool_result_accepted" | "protocol_user_appended";
    }>[];
    stop: boolean;
  }>;
  /** Atomically owns the compaction checkpoint and Bind replacement transition. */
  onBindCompaction?: (commit: BindCompactionCommit) => void | Promise<void>;
  /**
   * Last host policy boundary before an assistant turn becomes part of Bind's
   * durable loop and participant transcript. The returned content is the only
   * content accepted by either authority. Hosts use this to replace output that
   * cannot safely cross a participant boundary; it is not a presentation hook.
   */
  transformAssistantMessageBeforeAcceptance?: (turn: {
    turnId: string;
    content: string;
    hasToolCalls: boolean;
  }) => string | Promise<string>;
  onToolCallRejected?: (event: { toolCallId: string; code: string }) => void | Promise<void>;
  onProgress?: (progress: { outputTokens: number; toolCalls: number }) => void | Promise<void>;
  flushProgress?: (progress: {
    inputTokens: number;
    outputTokens: number;
    /** Latest completed OpenRouter prompt + completion count; not cumulative spend. */
    contextTokens: number;
    costCents: number;
    toolCalls: number;
  }) => void | Promise<void>;
  onLiveness?: (stage: "before_model" | "during_stream" | "after_tool" | "iteration_boundary") => void | Promise<void>;
  /**
   * Called immediately before Bind would accept a tool-less assistant turn as
   * the end of the run. Returning a non-empty string appends a model-only user
   * message to the live transcript and continues the same bounded loop.
   */
  acceptEmptyCompletion?: boolean;
  onTurnWouldEnd?: (turn: {
    assistantContent: string;
    cumulativeToolCalls: number;
  }) => string | null | Promise<string | null>;
  signal?: AbortSignal;
}

export interface HarnessOutcome {
  status: "completed" | "needs_input" | "failed" | "stopped";
  content: string;
  model: string | null;
  iterations: number;
  toolCalls: number;
  usage: Record<string, number>;
  stats: HarnessRunStats;
  error?: string;
  failure?: HarnessFailure;
}

export interface HarnessRunStats {
  /** Successfully completed model turns. */
  turns: number;
  /** Tool calls requested by completed model turns, including cached calls. */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Total wall time spent awaiting model routing, retries, and generation. */
  modelTimeMs: number;
  /** Sum of individual tool execution durations; parallel tools intentionally overlap. */
  toolTimeMs: number;
  outputTokensPerSecond: number | null;
  toolTimeBreakdownMs: Record<string, number>;
}

export interface HarnessFailure {
  kind:
    | "deadline"
    | "execution"
    | "context"
    | "limit"
    | "authorization"
    | "ambiguous_external_write"
    // The model provider, not Avalon. Its own arm rather than `execution` so a
    // caller deciding whether to retry does not have to re-derive from the code
    // what the harness already classified. Use it only where provider ownership
    // is *known* — see `routing` below for the case where it is not.
    | "provider"
    // Avalon declined to reach an endpoint: the circuit breaker was open, so no
    // request went out. Deliberately not `provider`, even though it usually
    // follows provider faults, because the breaker also opens on a credential or
    // credit failure and records only that a key is open, never why. Filing that
    // under `provider` would tell a caller branching on `kind` that an
    // operator-actionable configuration problem is transient provider trouble.
    | "routing"
    // The platform refused the call. Not `execution`, which means Avalon's own
    // defect, and not `provider`, which means the model service: this is the
    // runtime Avalon is hosted on declining to carry a subrequest, and the
    // remedy is neither a retry nor a support ticket about the port that asked.
    | "platform";
  code: HarnessFailureCode;
  message: string;
}

/**
 * What a member reads when a run fails.
 *
 * Two rules hold across the whole set, and both were learned from a real
 * failure rather than chosen. **Every string names a next action or says
 * plainly that there is none**: a sentence that only diagnoses leaves a reader
 * staring at a Retry button with no basis for pressing it, and during a
 * provider outage that means pressing it repeatedly into a failing upstream.
 * And **no string uses a word that only exists inside Avalon** — "harness" is
 * an implementation detail a member has no model of, so blaming it says only
 * that something they cannot see went wrong.
 *
 * Keep them separable *by cause and by remedy*, not by the code printed beside
 * them. Two sentences that differ only in wording but imply different advice
 * are worse than one sentence, because the reader cannot tell which they got.
 */
const MEMBER_SAFE_HARNESS_FAILURE_MESSAGES: Readonly<Record<HarnessFailureCode, string>> = Object.freeze({
  run_wall_time_limit_exceeded: "This run reached its time limit",
  run_iteration_limit_exceeded: "This run reached its model-turn limit",
  run_tool_call_limit_exceeded: "This run reached its tool-call limit",
  run_cost_limit_exceeded: "This run reached its cost limit",
  harness_execution_failed: "Rally could not complete this run. Retrying is unlikely to help — copy the request ID for support",
  tool_receipt_persistence_failed: "Rally could not record this tool's durable outcome. Check its card before retrying a write — if it is unresolved, copy the request ID for support",
  run_state_persistence_failed: "Rally could not save this run's progress. Retrying is unlikely to help — copy the request ID for support",
  context_limit_exceeded: "This run could not fit safely in the selected model context",
  tool_surface_too_large: "The authorized tool surface is too large for one run",
  ambiguous_external_write: "An external write may have completed, so Rally did not retry it",
  // Not "did not respond": this code also covers a 429 and a 5xx, where the
  // service answered and the answer was an error. Naming the symptom it does not
  // have would hand a member a diagnosis that contradicts the logs.
  provider_unavailable: "The model service could not complete this request. This usually clears on its own — try again in a moment",
  // Deliberately cause-neutral, and deliberately not confident that waiting is
  // the fix. The breaker opens `open_immediately` on a credential or credit
  // failure as readily as it does on repeated outages, and it records only that
  // a key is open — never why. So this may not say "after repeated failures",
  // which can be false, and may not stop at "try again", which sends someone
  // retrying an operator-actionable problem indefinitely.
  provider_circuit_open: "Rally has paused requests to this model. Try again shortly — if it keeps happening, copy the request ID for support",
  // Says "this run", not "this tool" or "this save": the refusal lands on
  // whichever call asked next, so naming the operation would name the wrong
  // one. Retrying is offered because the limit is per invocation and a fresh
  // run starts a fresh one — which is exactly what happened on 2026-08-24,
  // where the next run in the same work stream completed.
  platform_limit_exceeded: "Rally hit a platform limit partway through this run. Trying again usually works — if it keeps happening, copy the request ID for support",
});

export function memberSafeHarnessFailureMessage(code: HarnessFailureCode): string {
  return MEMBER_SAFE_HARNESS_FAILURE_MESSAGES[code];
}

/**
 * Statically imported, not `await import("./bind-runtime")`.
 *
 * The dynamic form never settled under `@cloudflare/vitest-pool-workers`: the
 * promise stayed pending past 36 seconds while a 2-second timer kept firing in
 * the same isolate, so the isolate was live and the module load simply never
 * completed. Every workers test that let a run reach inference therefore hung
 * in `runHarness` and failed as a timeout somewhere unrelated, which is what
 * `docs/testing.md` means by a run that has to be kept away from the model.
 *
 * `bind-runtime` imports seven runtime values back from this module, so this is
 * a cycle. It is a sound one: all seven are read inside function bodies rather
 * than at module top level, so neither module observes the other's bindings
 * before they initialize.
 *
 * Why the import was dynamic in the first place is not recorded — the line
 * arrives with the repository's initial import and carries no rationale — so a
 * change that needs the lazy form back should establish its reason afresh
 * rather than restore it on the strength of this note.
 */
export async function runHarness(input: RunHarnessInput): Promise<HarnessOutcome> {
  return runHarnessWithBind(input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalToolInputHash(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

export const __testing = {
  canonicalJson,
  executeAutomationCreatorDiscoveryTool,
  addressingJsonSchema,
  automationJsonSchema: automationDraftSubmissionJsonSchema,
  normalizeAutomationDraft,
  automationResearchToolPresentation: AUTOMATION_RESEARCH_TOOL_PRESENTATION,
};
