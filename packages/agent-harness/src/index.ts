import type {
  AddressingClassification,
  AutomationPluginActivity,
  AutomationPluginIcon,
  AutomationDraft,
  ExecutionPrincipal,
  HarnessFailureCode,
  ToolDefinition
} from "@avalon/contracts";
import {
  AddressingClassificationSchema,
  AutomationDraftSchema
} from "@avalon/contracts";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { createStreamWatchdog } from "@juno-ai/bind/completion";
import { z } from "zod";
import {
  renderAddressingMessages,
  renderAutomationCompilerMessages,
  type AddressingContextMessage,
} from "./prompts";

export * from "./prompts";
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
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

export interface OpenRouterInferencePayload {
  model: string;
  messages: ModelMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto";
  plugins?: Array<Record<string, unknown>>;
  reasoning?: { effort: "low" | "medium" | "high" };
}

export interface InferenceRequestEvent {
  inferenceRequestId: string;
  turnId: string;
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
  model: string;
  provider: string;
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
  failureKind?: string;
}

/**
 * OpenRouter multimodal content. `file` and `input_audio` are upstream
 * extensions that are not yet represented by every OpenAI SDK release.
 */
export type ModelMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export type ModelMessageContent = string | ModelMessageContentPart[] | null;

export type StructuredModelDiagnostic = {
  stage: "model_request" | "model_response" | "normalize" | "validate" | "repair" | "complete";
  schemaName: string;
  model: string;
  attempt: number;
  fallbackAttempt: number;
  repairAttempt: number;
  latencyMs?: number;
  responseBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number | null;
  success?: boolean;
  failureKind?: string;
  validationIssues?: Array<{ path: string; code: string }>;
};

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, number>;
  error?: { code?: string | number; message?: string };
}

interface ChatRequest {
  messages: ModelMessage[];
  tools?: Array<Record<string, unknown>>;
  toolChoice?: "auto" | "none";
  includeWebSearch?: boolean | undefined;
  maxWebResults?: number | undefined;
  plugins?: Array<Record<string, unknown>> | undefined;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
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

export class OpenRouterClient {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly config: OpenRouterConfig) {
    if (!config.apiKey) throw new OpenRouterError("OPENROUTER_API_KEY is not configured");
    // Workerd host functions validate their receiver. Bind the selected fetch
    // before storing it on the client so `this.fetcher(...)` cannot invoke the
    // native function with the OpenRouterClient instance as `this`.
    this.fetcher = (config.fetch ?? globalThis.fetch).bind(globalThis);
  }

  async structured<T>(input: {
    messages: ModelMessage[];
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high";
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
    for (const [fallbackAttempt, model] of models.entries()) {
      let repairMessages: ModelMessage[] | null = null;
      let repairAttempt = 0;
      for (let attempt = 0; attempt <= this.sameModelRetries(); attempt += 1) {
        try {
          const startedAt = Date.now();
          await input.onDiagnostic?.({
            stage: "model_request",
            schemaName: input.schemaName,
            model,
            attempt,
            fallbackAttempt,
            repairAttempt,
          });
          const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              model,
              messages: repairMessages ?? schemaMessages,
              stream: false,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: input.schemaName,
                  strict: true,
                  schema: input.jsonSchema
                }
              },
              plugins: [{ id: "response-healing" }],
              reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined,
            }),
            ...(input.signal ? { signal: input.signal } : {})
          });
          const payload = await readJsonResponse<{
            choices?: Array<{ message?: { content?: string | null } }>;
            error?: { message?: string };
          }>(response);
          if (!response.ok) {
            throw new OpenRouterError(
              payload?.error?.message ?? `OpenRouter request failed (${response.status})`,
              response.status,
              payload
            );
          }
          const content = payload?.choices?.[0]?.message?.content;
          if (!content) throw new OpenRouterError("OpenRouter returned no structured content");
          await input.onDiagnostic?.({
            stage: "model_response",
            schemaName: input.schemaName,
            model,
            attempt,
            fallbackAttempt,
            repairAttempt,
            latencyMs: Date.now() - startedAt,
            responseBytes: new TextEncoder().encode(content).byteLength,
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
              await input.onDiagnostic?.({
                stage: "repair",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                validationIssues,
              });
              attempt -= 1;
              continue;
            }
            throw new OpenRouterError("OpenRouter returned invalid structured JSON");
          }
          await input.onDiagnostic?.({ stage: "normalize", schemaName: input.schemaName, model, attempt, fallbackAttempt, repairAttempt });
          try {
            const parsed = input.parse(parsedJson);
            await input.onDiagnostic?.({ stage: "validate", schemaName: input.schemaName, model, attempt, fallbackAttempt, repairAttempt });
            await input.onDiagnostic?.({ stage: "complete", schemaName: input.schemaName, model, attempt, fallbackAttempt, repairAttempt });
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
              await input.onDiagnostic?.({
                stage: "repair",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                validationIssues,
              });
              attempt -= 1;
              continue;
            }
            if (error instanceof z.ZodError) {
              await input.onDiagnostic?.({
                stage: "validate",
                schemaName: input.schemaName,
                model,
                attempt,
                fallbackAttempt,
                repairAttempt,
                validationIssues: error.issues.slice(0, 25).map((issue) => ({
                  path: issue.path.map(String).join("."),
                  code: issue.code,
                })),
              });
            }
            throw error;
          }
        } catch (error) {
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
      const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: true,
          stream_options: { include_usage: true },
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? (input.toolChoice ?? "auto") : undefined,
          plugins: input.plugins?.length ? input.plugins : undefined,
          reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined,
        }),
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
        // Preserve only retry metadata for routing. Provider response bodies are
        // deliberately not retained by the durable runtime or structured logs.
        headers: {
          "retry-after": response.headers.get("retry-after") ?? undefined,
        },
        providerErrorKind: typeof details === "object" && details !== null ? "structured" : "text",
      });
    }

    let content = "";
    let usage: Record<string, number> | null = null;
    let finishReason: string | null = null;
    const pendingCalls = new Map<number, ModelToolCall>();
    let deltaChain = Promise.resolve();
    const parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        if (event.data === "[DONE]") return;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(event.data) as StreamChunk;
        } catch {
          return;
        }
        if (chunk.error) throw new OpenRouterError(chunk.error.message ?? "OpenRouter stream error", undefined, chunk.error);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const text = choice.delta?.content;
        const toolCallDeltas = choice.delta?.tool_calls ?? [];
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
      generationId: response.headers.get("x-generation-id"),
      ttftMs: firstOutputAt === null ? null : Math.max(0, firstOutputAt - requestStartedAt),
      responseBytes,
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

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      ...(this.config.appUrl ? { "HTTP-Referer": this.config.appUrl } : {}),
      ...(this.config.appName ? { "X-Title": this.config.appName } : {})
    };
  }
}

type OpenRouterFailureDisposition = "retry" | "fallback" | "terminal";

function openRouterFailureDisposition(error: unknown): OpenRouterFailureDisposition {
  if (isAbortError(error)) return "terminal";
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
 * Keep strict provider enforcement and model-visible instructions in sync.
 * Medium-sized models are materially more reliable when the exact schema is
 * present in the conversation instead of existing only in response_format.
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
  const result = [...messages];
  const last = result.at(-1);
  if (last?.role !== "user") {
    return [...result, { role: "user", content: instruction }];
  }
  if (typeof last.content === "string") {
    result[result.length - 1] = { ...last, content: `${last.content}\n\n${instruction}` };
    return result;
  }
  if (Array.isArray(last.content)) {
    result[result.length - 1] = {
      ...last,
      content: [...last.content, { type: "text", text: instruction }],
    };
    return result;
  }
  result[result.length - 1] = { ...last, content: instruction };
  return result;
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
        "avalon_reference",
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

export function classifyAddressingHeuristically(input: {
  message: string;
  activeTask: boolean;
  connectorMentions?: string[];
  addressesAvalon?: boolean;
}): AddressingClassification {
  const text = input.message.trim();
  if ((input.connectorMentions?.length ?? 0) > 0) {
    return { classification: "agent_action", confidence: 0.98, rationaleCode: "connector_mention" };
  }
  if (input.addressesAvalon || /\bavalon\b/i.test(text)) {
    return { classification: "agent_action", confidence: 0.96, rationaleCode: "avalon_reference" };
  }
  if (/^(please\s+)?(find|check|create|draft|send|review|summarize|investigate|update|compare|prepare)\b/i.test(text)) {
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
  addressesAvalon?: boolean;
  recentMessages?: AddressingContextMessage[];
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<AddressingClassification> {
  const deterministic = classifyAddressingHeuristically(input);
  if (deterministic.confidence >= 0.9) return deterministic;
  const client = new OpenRouterClient({
    apiKey: input.apiKey,
    primaryModel: input.model,
    ...(input.fallbackModels ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return client.structured({
    messages: renderAddressingMessages({
      message: input.message,
      activeTask: input.activeTask,
      connectorMentions: input.connectorMentions ?? [],
      addressesAvalon: input.addressesAvalon ?? /\bavalon\b/iu.test(input.message),
      recentMessages: input.recentMessages ?? [],
    }),
    schemaName: "message_addressing",
    jsonSchema: addressingJsonSchema,
    parse: (value) => AddressingClassificationSchema.parse(value),
    ...(input.signal ? { signal: input.signal } : {})
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
          timezone: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          intervalSeconds: { type: ["integer", "null"], minimum: 60 },
          connectorType: { type: ["string", "null"] },
          eventTypes: { type: ["array", "null"], items: { type: "string" } },
          deterministicFilters: {
            type: ["string", "null"],
            description: "A JSON-encoded object of deterministic connector filters."
          },
          deterministicPrefilter: {
            type: ["string", "null"],
            description: "A JSON-encoded object used before semantic classification."
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
          "eventTypes",
          "deterministicFilters",
          "deterministicPrefilter",
          "condition",
          "resourceId"
        ]
      }
    },
    expectedOutputs: { type: "array", items: { type: "string" } },
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
  tools: Array<{
    name: string;
    /** Canonical adapter identity; `name` remains the exact model-facing wire name. */
    canonicalName?: string;
    description: string;
    capability: string;
    mode: "read" | "write";
    idempotency?: "safe" | "provider_key" | "record_before_execute";
    inputSchema: Record<string, unknown>;
    execute?: HarnessTool["execute"];
  }>;
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

export type AutomationCompilerStreamEvent =
  | { type: "started" }
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
      plugins: AutomationPluginActivity[];
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
};

function automationPluginActivities(
  catalog: AutomationCreatorPluginCatalogEntry[],
  pluginIds?: ReadonlySet<string>,
): AutomationPluginActivity[] {
  return catalog
    .filter((plugin) => !pluginIds || pluginIds.has(plugin.pluginId))
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      icon: plugin.icon,
    }));
}

function automationDiscoveryPluginsFromInput(
  toolName: string,
  input: unknown,
  catalog: AutomationCreatorPluginCatalogEntry[],
): AutomationPluginActivity[] {
  if (toolName !== "automation_plugin_inspect" && toolName !== "load_plugin") {
    return automationPluginActivities(catalog);
  }
  const pluginId = String(asRecord(input).pluginId ?? "");
  return automationPluginActivities(catalog, new Set([pluginId]));
}

function automationDiscoveryPluginsFromResult(
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

function automationDiscoveryActivityName(
  toolName: string,
  status: "started" | "completed" | "failed",
  plugins: AutomationPluginActivity[],
): string {
  if (toolName === "web_search") {
    return status === "completed" ? "Searched the public web" : "Searching the public web";
  }
  if (toolName === "web_fetch") {
    return status === "completed" ? "Read a public web page" : "Reading a public web page";
  }
  const names = automationPluginNames(plugins);
  if (toolName === "automation_plugins_search") {
    if (status === "completed") return plugins.length ? `Found ${names}` : "Searched connected plugins";
    return `Searching ${names}`;
  }
  if (toolName === "load_plugin") {
    return status === "completed" ? `Loaded ${names}` : `Loading ${names}`;
  }
  if (toolName === "automation_plugin_inspect") return `Reading ${names}`;
  return status === "completed" ? `Reviewed ${names}` : `Reviewing ${names}`;
}

export async function compileAutomation(input: {
  apiKey: string;
  model: string;
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
  maxResearchIterations?: number;
  maxWebResults?: number;
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  onInferenceRequest?: (request: InferenceRequestEvent) => void | Promise<void>;
  onInferenceAttempt?: (attempt: InferenceAttemptEvent) => void | Promise<void>;
  onStreamEvent?: (event: AutomationCompilerStreamEvent) => void | Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Deterministic catalog snapshot for tests or hosts with a cached catalog. */
  contextWindowTokensByModel?: Readonly<Record<string, number | null | undefined>>;
}): Promise<AutomationDraft> {
  const rendered = renderAutomationCompilerMessages({
    messages: input.messages,
    currentDraft: input.currentDraft ?? null,
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
    systemMessage: plugin.systemMessage,
    tools: plugin.tools.flatMap((tool) => tool.execute
      ? [{
          definition: {
            name: tool.canonicalName ?? tool.name,
            description: tool.description,
            capability: tool.capability,
            mode: tool.mode,
            idempotency: tool.idempotency ?? "safe",
            inputSchema: tool.inputSchema,
          },
          execute: tool.execute,
        }]
      : []),
    preload: false,
    explicit: false,
  }));
  const draftState: { submitted: AutomationDraft | null } = { submitted: null };
  let submissionReminderSent = false;
  let elicitationReminderSent = false;
  let modelTimeMs = 0;
  const toolStartedAt = new Map<string, number>();
  const toolPlugins = new Map<string, AutomationPluginActivity[]>();
  const creatorTools: HarnessTool[] = [
    {
      definition: {
        name: "plugins_list",
        description: "List every connector plugin authorized for this automation creator, with compact trusted metadata.",
        capability: "avalon.automation.plugins.list",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      execute: async () => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_list", {}, catalog),
        summary: "Listed authorized automation plugins",
      }),
    },
    {
      definition: {
        name: "plugins_search",
        description: "Search authorized connector plugins and their tools by capability, provider, action, or keyword.",
        capability: "avalon.automation.plugins.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
        },
      },
      execute: async (raw) => ({
        output: executeAutomationCreatorDiscoveryTool("plugins_search", asRecord(raw), catalog),
        summary: "Searched authorized automation plugins",
      }),
    },
    {
      definition: {
        name: "plugin_inspect",
        description: "Inspect one authorized plugin's trusted system guidance and exact tool schemas before recommending it.",
        capability: "avalon.automation.plugins.inspect",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { pluginId: { type: "string" } },
          required: ["pluginId"],
        },
      },
      execute: async (raw) => ({
        output: executeAutomationCreatorDiscoveryTool("plugin_inspect", asRecord(raw), catalog),
        summary: "Inspected an authorized automation plugin",
      }),
    },
    {
      definition: {
        name: "submit_draft",
        description: "Save the best current automation draft. Set ready=false when blocking input remains, then call core_request_elicitation with the structured question.",
        capability: "avalon.automation.submit",
        mode: "read",
        idempotency: "safe",
        inputSchema: automationDraftSubmissionJsonSchema,
      },
      execute: async (raw) => {
        await input.onDiagnostic?.({
          stage: "normalize",
          schemaName: "automation_draft",
          model: input.model,
          attempt: 1,
          fallbackAttempt: 0,
          repairAttempt: 0,
        });
        const normalized = normalizeAutomationDraft(raw, input.defaultTimezones);
        const parsed = AutomationDraftSchema.safeParse(normalized);
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
      serial: true,
    },
  ];
  const timeTool = automationCurrentTimeTool(input.defaultTimezones);
  const requestElicitationTool: HarnessTool = {
    definition: AVALON_REQUEST_ELICITATION_TOOL_DEFINITION,
    execute: async (raw) => {
      const args = RequestElicitationInputSchema.parse(raw);
      if (!draftState.submitted) {
        throw new Error("Submit the best current draft with automation_submit_draft before requesting input");
      }
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
      modelId: "avalon_core",
      shortWireName: "core",
      description: "Read the exact current time and applicable timezones.",
      systemMessage: "Use core_current_time when exact current time or timezone matters; never infer it from transcript timestamps. Use core_request_elicitation only after saving the best current draft when a blocking human choice remains.",
      tools: [timeTool, requestElicitationTool],
      preload: true,
      explicit: true,
    },
    {
      canonicalId: AVALON_AUTOMATION_ARCHITECT_PLUGIN_ID,
      modelId: "avalon_automation_architect",
      shortWireName: "automation",
      description: "Research authorized plugins and submit automation drafts.",
      tools: creatorTools,
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
      maxWebResults: Math.max(1, Math.min(20, input.maxWebResults ?? 8)),
      maxCostCents: 1_000,
      maxCatalogTokens: 2_500,
      reasoningEffort: "high",
    },
    workspaceId: input.workspaceId ?? "00000000-0000-7000-8000-000000000001",
    workstreamId: "00000000-0000-7000-8000-000000000002",
    harnessRunId: crypto.randomUUID(),
    executionPrincipal: {
      type: "user",
      userId: input.userId ?? "00000000-0000-7000-8000-000000000003",
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
    onEvent: async (event) => {
      if (event.type === "stream_started") {
        await input.onStreamEvent?.({ type: "started" });
      } else if (event.type === "tool_started") {
        const runtimePlugin = event.pluginId.startsWith("automation:")
          ? automationPluginActivities(catalog, new Set([event.pluginId.slice("automation:".length)]))
          : [];
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (runtimePlugin.length ? {
              started: "Using an authorized connector…",
              completed: "Connector operation completed",
            } : undefined);
        if (!presentation) return;
        const plugins = runtimePlugin.length
          ? runtimePlugin
          : automationDiscoveryPluginsFromInput(event.toolName, event.input, catalog);
        toolStartedAt.set(event.toolCallId, Date.now());
        toolPlugins.set(event.toolCallId, plugins);
        await input.onStreamEvent?.({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "started", plugins),
          summary: presentation.started,
          status: "started",
          plugins,
        });
      } else if (event.type === "tool_completed") {
        const runtimePlugin = event.pluginId.startsWith("automation:")
          ? automationPluginActivities(catalog, new Set([event.pluginId.slice("automation:".length)]))
          : [];
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (runtimePlugin.length ? {
              started: "Using an authorized connector…",
              completed: event.result.summary,
            } : undefined);
        if (!presentation) return;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const plugins = runtimePlugin.length
          ? runtimePlugin
          : automationDiscoveryPluginsFromResult(
              event.toolName,
              event.result.output,
              catalog,
              toolPlugins.get(event.toolCallId) ?? [],
            );
        toolStartedAt.delete(event.toolCallId);
        toolPlugins.delete(event.toolCallId);
        await input.onStreamEvent?.({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "completed", plugins),
          summary: presentation.completed,
          status: "completed",
          plugins,
          ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
        });
      } else if (event.type === "tool_failed") {
        const runtimePlugin = event.pluginId.startsWith("automation:")
          ? automationPluginActivities(catalog, new Set([event.pluginId.slice("automation:".length)]))
          : [];
        const presentation = AUTOMATION_RESEARCH_TOOL_PRESENTATION[event.toolName]
          ?? (runtimePlugin.length ? {
              started: "Using an authorized connector…",
              completed: "Connector operation failed",
            } : undefined);
        if (!presentation) return;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const plugins = runtimePlugin.length ? runtimePlugin : toolPlugins.get(event.toolCallId) ?? [];
        toolStartedAt.delete(event.toolCallId);
        toolPlugins.delete(event.toolCallId);
        await input.onStreamEvent?.({
          type: "tool",
          toolCallId: event.toolCallId,
          name: automationDiscoveryActivityName(event.toolName, "failed", plugins),
          summary: "This research step failed; Avalon will adjust the plan.",
          status: "failed",
          plugins,
          ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
        });
      }
    },
    onInferenceRequest: async (request) => {
      await input.onInferenceRequest?.(request);
      await input.onStreamEvent?.({
        type: "thinking",
        inferenceRequestId: request.inferenceRequestId,
        status: "started",
        durationMs: modelTimeMs,
      });
    },
    onInferenceAttempt: async (attempt) => {
      await input.onInferenceAttempt?.(attempt);
      modelTimeMs += attempt.latencyMs;
      await input.onStreamEvent?.({
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
    await input.onStreamEvent?.({ type: "completed" });
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

function normalizeAutomationDraft(
  value: unknown,
  defaultTimezones?: { personal: string; workspace: string },
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const draft = value as Record<string, unknown>;
  const scope = draft.suggestedScope === "workspace" ? "workspace" : "personal";
  const defaultTimezone = defaultTimezones?.[scope];
  const triggers = Array.isArray(draft.triggers)
    ? draft.triggers.map((trigger) => normalizeAutomationTrigger(trigger, defaultTimezone))
    : draft.triggers;
  const ready = draft.ready !== false;
  return {
    ...draft,
    triggers,
    requiredCapabilities: [],
    defaultBehavior: parseJsonObject(draft.defaultBehavior),
    memoryTables: Array.isArray(draft.memoryTables) ? draft.memoryTables : [],
    ready,
    followUpQuestion: null,
    elicitation: null,
  };
}

function normalizeAutomationTrigger(value: unknown, defaultTimezone?: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const trigger = value as Record<string, unknown>;
  switch (trigger.type) {
    case "manual":
      return { type: "manual" };
    case "calendar":
      return {
        type: "calendar",
        rrule: trigger.rrule,
        timezone: typeof trigger.timezone === "string" && trigger.timezone.trim()
          ? trigger.timezone
          : defaultTimezone,
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
        eventTypes: trigger.eventTypes,
        deterministicFilters: parseJsonObject(trigger.deterministicFilters)
      };
    case "semantic_activity":
      return {
        type: "semantic_activity",
        connectorType: trigger.connectorType,
        deterministicPrefilter: parseJsonObject(trigger.deterministicPrefilter),
        condition: trigger.condition
      };
    case "resource_watch":
      return { type: "resource_watch", resourceId: trigger.resourceId };
    case "webhook":
      return { type: "webhook", eventTypes: trigger.eventTypes };
    default:
      return value;
  }
}

function normalizeTriggerSummary(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
  executionPrincipal: ExecutionPrincipal;
  /** Stable per-receipt key for provider APIs that support idempotent writes. */
  providerIdempotencyKey?: string;
  signal: AbortSignal;
}

export interface HarnessToolResult {
  output: unknown;
  summary: string;
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
export const AVALON_DISCOVERY_PLUGIN_ID = "avalon:discovery";
export const AVALON_CORE_PLUGIN_ID = "avalon:core";
export const AVALON_MEMORY_PLUGIN_ID = "avalon:memory";
export const AVALON_TABLES_PLUGIN_ID = "avalon:tables";
export const AVALON_WEB_PLUGIN_ID = "avalon:web";
export const AVALON_WORKSTREAM_PLUGIN_ID = "avalon:workstream";
export const AVALON_AUTOMATION_ARCHITECT_PLUGIN_ID = "avalon:automation_architect";

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
  description: "Ask a structured blocking question and pause this harness run for human input.",
  capability: "elicitation.write",
  mode: "write",
  idempotency: "provider_key",
  inputSchema: z.toJSONSchema(RequestElicitationInputSchema) as Record<string, unknown>,
} as const satisfies ToolDefinition;

export const AVALON_DISCOVERY_TOOL_DEFINITIONS = [
  {
    name: "list_plugins",
    description: "List plugins available to this frozen run scope.",
    capability: "avalon.plugins.list",
    mode: "read",
    idempotency: "safe",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "search_plugins",
    description: "Search plugins available to this frozen run scope.",
    capability: "avalon.plugins.search",
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
    capability: "avalon.plugins.load",
    // Activation changes only Avalon's durable run surface. It does not write
    // to an external provider and is safe to resume from the same receipt.
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
  /** Execute in model-declared order before concurrent tools in the same batch. */
  serial?: boolean;
}

/** A Bind plugin whose trusted identity, prose, and tool policy are authored by the host. */
export interface HarnessPlugin {
  /** Stable host authorization/persistence identity (`avalon:*` or `connection:<uuid>`). */
  canonicalId: string;
  /** Stable identifier exposed to the model (`avalon_core` or `plugin_google`). */
  modelId: string;
  shortWireName: string;
  /** Static, code-authored label used only for catalog display and discovery. */
  displayName?: string;
  /** Additional static, code-authored aliases accepted by plugin search. */
  searchAliases?: readonly string[];
  description: string;
  systemMessage?: string;
  tools: HarnessTool[];
  /** For deferred plugins, requests persistence before an activation hint; ignored for core plugins. */
  preload: boolean;
  explicit?: boolean;
}

export type HarnessEvent =
  | {
      type: "stream_started";
      model: string;
      turnId: string;
      epoch: number;
      streamSeq: number;
      reset: false;
    }
  | {
      type: "stream_delta";
      delta: string;
      turnId: string;
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
      phase: "validation" | "execution";
      outcome: "definitive_failure" | "timed_out" | "aborted" | "ambiguous_external_write";
    }
  | { type: "stream_completed"; content: string; usage: Record<string, number> | null }
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
  /** Persist the compacted continuation context after Bind swaps it in. */
  persist?: (checkpoint: HarnessCompactionCheckpoint) => void | Promise<void>;
}

export interface RunHarnessInput {
  config: OpenRouterConfig & {
    maxIterations: number;
    maxToolCalls: number;
    maxWallClockMs: number;
    toolTimeoutMs: number;
    maxWebResults: number;
    maxCostCents?: number;
    maxCatalogTokens?: number;
    /** Cap on how many skills one run may hold loaded. Defaults to Bind's. */
    maxActiveSkills?: number;
    /** Cap on the total tokens of loaded skill bodies. Defaults to Bind's. */
    maxActiveSkillBodyTokens?: number;
    maxStreamResets?: number;
    completionDefectRetries?: number;
    /** Model reasoning effort passed consistently through Bind's routed turns. */
    reasoningEffort?: "low" | "medium" | "high";
  };
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  systemPrompt: string;
  messages: ModelMessage[];
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
  includeWebSearch?: boolean;
  onEvent(event: HarnessEvent): void | Promise<void>;
  onBestEffortEventDropped?: (event: {
    type: "stream_started" | "stream_delta";
    turnId: string;
    epoch: number;
    streamSeq: number;
  }) => void | Promise<void>;
  findCompletedToolResult?: (
    toolCallId: string,
    inputHash: string,
    policy: { pluginId: string } & HarnessToolPolicyIdentity,
  ) => Promise<HarnessToolResult | null>;
  reauthorizePlugin?: (canonicalId: string) => boolean | Promise<boolean>;
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
  kind: "deadline" | "execution" | "context" | "limit" | "authorization" | "ambiguous_external_write";
  code: HarnessFailureCode;
  message: string;
}

const MEMBER_SAFE_HARNESS_FAILURE_MESSAGES: Readonly<Record<HarnessFailureCode, string>> = Object.freeze({
  run_wall_time_limit_exceeded: "This run reached its time limit",
  run_iteration_limit_exceeded: "This run reached its model-turn limit",
  run_tool_call_limit_exceeded: "This run reached its tool-call limit",
  run_cost_limit_exceeded: "This run reached its cost limit",
  harness_execution_failed: "The Avalon harness could not complete this run",
  context_limit_exceeded: "This run could not fit safely in the selected model context",
  tool_surface_too_large: "The authorized tool surface is too large for one run",
  ambiguous_external_write: "An external write may have completed, so Avalon did not retry it",
});

export function memberSafeHarnessFailureMessage(code: HarnessFailureCode): string {
  return MEMBER_SAFE_HARNESS_FAILURE_MESSAGES[code];
}

export async function runHarness(input: RunHarnessInput): Promise<HarnessOutcome> {
  const { runHarnessWithBind } = await import("./bind-runtime");
  return runHarnessWithBind(input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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
  addressingJsonSchema,
  automationJsonSchema: automationDraftSubmissionJsonSchema,
  normalizeAutomationDraft
};
