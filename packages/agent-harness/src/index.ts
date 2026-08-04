import type {
  AddressingClassification,
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
} from "./prompts";

export * from "./prompts";
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
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

export type StructuredModelDiagnostic = {
  stage: "model_request" | "model_response" | "normalize" | "validate" | "repair" | "complete";
  schemaName: string;
  model: string;
  attempt: number;
  fallbackAttempt: number;
  repairAttempt: number;
  latencyMs?: number;
  responseBytes?: number;
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
    signal?: AbortSignal | undefined;
    onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  }): Promise<T> {
    const models = uniqueModels(input.model
      ? [input.model]
      : [this.config.primaryModel, ...(this.config.fallbackModels ?? [])]);
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
              messages: repairMessages ?? input.messages,
              stream: false,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: input.schemaName,
                  strict: true,
                  schema: input.jsonSchema
                }
              },
              plugins: [{ id: "response-healing" }]
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
                ...input.messages,
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
                ...input.messages,
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
          tool_choice: tools.length > 0 ? (input.toolChoice ?? "auto") : undefined
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
    }),
    schemaName: "message_addressing",
    jsonSchema: addressingJsonSchema,
    parse: (value) => AddressingClassificationSchema.parse(value),
    ...(input.signal ? { signal: input.signal } : {})
  });
}

const automationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
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
    requiredCapabilities: { type: "array", items: { type: "string" } },
    expectedOutputs: { type: "array", items: { type: "string" } },
    defaultBehavior: {
      type: "string",
      description: "A JSON-encoded object of default behavior settings; use {} when none are needed."
    },
    suggestedScope: { type: "string", enum: ["personal", "workspace"] },
    followUpQuestion: { type: ["string", "null"] },
    ready: { type: "boolean" }
  },
  required: [
    "name",
    "description",
    "instructions",
    "triggers",
    "requiredCapabilities",
    "expectedOutputs",
    "defaultBehavior",
    "suggestedScope",
    "followUpQuestion",
    "ready"
  ]
};

export async function compileAutomation(input: {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  currentDraft?: AutomationDraft | null;
  defaultTimezones?: { personal: string; workspace: string };
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<AutomationDraft> {
  const client = new OpenRouterClient({
    apiKey: input.apiKey,
    primaryModel: input.model,
    ...(input.fallbackModels ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return client.structured({
    messages: renderAutomationCompilerMessages({
      messages: input.messages,
      currentDraft: input.currentDraft ?? null,
    }),
    schemaName: "automation_draft",
    jsonSchema: automationJsonSchema,
    parse: (value) => AutomationDraftSchema.parse(normalizeAutomationDraft(value, input.defaultTimezones)),
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
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
  return {
    ...draft,
    triggers,
    defaultBehavior: parseJsonObject(draft.defaultBehavior)
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
        summary: trigger.summary,
      };
    case "interval":
      return { type: "interval", intervalSeconds: trigger.intervalSeconds, summary: trigger.summary };
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
  halt?: "needs_input";
  /** Bind control signal used only by Avalon's core plugin loader. */
  loadedPluginName?: string;
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

/** Bind-owned catalog policies mirrored and verified by the durable host. */
export const BIND_RUNTIME_CORE_TOOL_DEFINITIONS = [
  {
    name: "list_connector_plugins",
    description: "List authorized connector plugins available to this frozen run scope.",
    capability: "avalon.plugins.list",
    mode: "read",
    idempotency: "safe",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "search_connector_plugins",
    description: "Search authorized connector plugins available to this frozen run scope.",
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
    description: "Load one authorized connector plugin from the catalog for this run.",
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
}

/** A credential-scoped Bind plugin whose trusted prose is authored in code. */
export interface HarnessPlugin {
  /** Opaque host authorization/persistence identity (connection:<uuid>). */
  canonicalId: string;
  /** Stable workspace-local identifier exposed to the model (plugin_google). */
  modelId: string;
  shortWireName: string;
  /** Static, code-authored label used only for catalog display and discovery. */
  displayName?: string;
  /** Additional static, code-authored aliases accepted by plugin search. */
  searchAliases?: readonly string[];
  description: string;
  systemMessage?: string;
  tools: HarnessTool[];
  /** Host-side request to persist this plugin before supplying an activation hint. */
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

export interface RunHarnessInput {
  config: OpenRouterConfig & {
    maxIterations: number;
    maxToolCalls: number;
    maxWallClockMs: number;
    /** Maximum UTF-8 bytes in the complete logical context for each selected route model. */
    maxContextBytes: number;
    toolTimeoutMs: number;
    maxWebResults: number;
    maxRunTokens?: number;
    maxCostCents?: number;
    /** Optional exact overrides for provider/model context windows in tokens. */
    modelContextWindowTokens?: Readonly<Record<string, number>>;
    maxCatalogTokens?: number;
    maxActivePlugins?: number;
    maxToolSchemaBytes?: number;
    maxToolResultBytes?: number;
    maxStreamResets?: number;
    completionDefectRetries?: number;
  };
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  systemPrompt: string;
  messages: ModelMessage[];
  tools: HarnessTool[];
  plugins?: HarnessPlugin[];
  /** Connector activations already durably persisted by the host. */
  activationHints?: string[];
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
  beforeToolCall?: (input: {
    pluginId: string;
    toolName: string;
    inputHash: string;
    signal: AbortSignal;
  }) => void | Promise<void>;
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
  onInferenceAttempt?: (attempt: {
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
  }) => void | Promise<void>;
  onTranscriptIssues?: (issues: Array<{ kind: string; index?: number; healed?: boolean }>) => void | Promise<void>;
  onToolCallRejected?: (event: { toolCallId: string; code: string }) => void | Promise<void>;
  onProgress?: (progress: { outputTokens: number; toolCalls: number }) => void | Promise<void>;
  flushProgress?: (progress: {
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    toolCalls: number;
  }) => void | Promise<void>;
  onLiveness?: (stage: "before_model" | "during_stream" | "after_tool" | "iteration_boundary") => void | Promise<void>;
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
  run_token_limit_exceeded: "This run reached its token limit",
  run_cost_limit_exceeded: "This run reached its cost limit",
  harness_execution_failed: "The Avalon harness could not complete this run",
  context_limit_exceeded: "This run could not fit safely in the selected model context",
  tool_surface_too_large: "The authorized tool surface is too large for one run",
  ambiguous_external_write: "An external write may have completed, so Avalon did not retry it",
});

export function memberSafeHarnessFailureMessage(code: HarnessFailureCode): string {
  return MEMBER_SAFE_HARNESS_FAILURE_MESSAGES[code];
}

export {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  modelContextBudget,
  resolveModelContextWindowTokens,
  type ModelContextBudget,
} from "./context-budget";

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
  automationJsonSchema,
  normalizeAutomationDraft
};
