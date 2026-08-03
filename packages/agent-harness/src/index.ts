import type {
  AddressingClassification,
  AutomationDraft,
  ExecutionPrincipal,
  ToolDefinition
} from "@avalon/contracts";
import {
  AddressingClassificationSchema,
  AutomationDraftSchema
} from "@avalon/contracts";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { z } from "zod";
import {
  renderAddressingMessages,
  renderAutomationCompilerMessages,
} from "./prompts";

export * from "./prompts";

export interface OpenRouterConfig {
  apiKey: string;
  primaryModel: string;
  fallbackModels?: string[];
  /** Additional attempts on one model for transport failures before fallback. */
  sameModelRetries?: number;
  appUrl?: string;
  appName?: string;
  fetch?: typeof globalThis.fetch;
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

interface StreamResult {
  model: string;
  content: string;
  toolCalls: ModelToolCall[];
  usage: Record<string, number> | null;
  finishReason: string | null;
  generationId: string | null;
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
    const tools = [...(input.tools ?? [])];
    if (input.includeWebSearch) {
      tools.push({
        type: "openrouter:web_search",
        search_context_size: "medium",
        max_total_results: input.maxWebResults ?? 8
      });
    }
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
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!response.ok || !response.body) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }
      throw new OpenRouterError(`OpenRouter stream failed (${response.status})`, response.status, details);
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
        if (text || toolCallDeltas.length > 0) onOutput();
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
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
      generationId: response.headers.get("x-generation-id")
    };
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
  executionPrincipal: ExecutionPrincipal;
  signal: AbortSignal;
}

export interface HarnessToolResult {
  output: unknown;
  summary: string;
  providerOperationId?: string;
  halt?: "needs_input";
}

export interface HarnessTool {
  definition: ToolDefinition;
  execute(input: unknown, context: HarnessToolContext): Promise<HarnessToolResult>;
}

export type HarnessEvent =
  | { type: "stream_started"; model: string }
  | { type: "stream_delta"; delta: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_completed"; toolCallId: string; toolName: string; result: HarnessToolResult }
  | {
      type: "tool_failed";
      toolCallId: string;
      toolName: string;
      error: string;
      phase: "validation" | "execution";
    }
  | { type: "stream_completed"; content: string; usage: Record<string, number> | null }
  | { type: "needs_input"; toolCallId: string };

export interface RunHarnessInput {
  config: OpenRouterConfig & {
    maxIterations: number;
    maxToolCalls: number;
    maxWallClockMs: number;
    toolTimeoutMs: number;
    maxWebResults: number;
  };
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  systemPrompt: string;
  messages: ModelMessage[];
  tools: HarnessTool[];
  includeWebSearch?: boolean;
  onEvent(event: HarnessEvent): void | Promise<void>;
  findCompletedToolResult?: (toolCallId: string, inputHash: string) => Promise<HarnessToolResult | null>;
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
  kind: "deadline" | "execution";
  code: "harness_deadline_exceeded" | "harness_execution_failed";
  message: string;
}

export async function runHarness(input: RunHarnessInput): Promise<HarnessOutcome> {
  const deadlineController = new AbortController();
  let abortSource: "deadline" | "external" | null = input.signal?.aborted ? "external" : null;
  const markExternalAbort = () => {
    abortSource ??= "external";
  };
  input.signal?.addEventListener("abort", markExternalAbort, { once: true });
  const deadline = setTimeout(() => {
    abortSource ??= "deadline";
    deadlineController.abort("wall_clock_limit");
  }, Math.max(0, input.config.maxWallClockMs));
  const signal = combineSignals([input.signal, deadlineController.signal]);
  const client = new OpenRouterClient(input.config);
  const tools = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
  const modelTools = input.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.inputSchema
    }
  }));
  const messages: ModelMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.messages
  ];
  const aggregateUsage: Record<string, number> = {};
  const runStats = emptyHarnessRunStats();
  let content = "";
  let toolCallCount = 0;
  let model: string | null = null;
  let completedIterations = 0;

  const finish = (
    status: HarnessOutcome["status"],
    failure?: HarnessFailure
  ): HarnessOutcome => ({
    status,
    content,
    model,
    iterations: completedIterations,
    toolCalls: toolCallCount,
    usage: aggregateUsage,
    stats: snapshotHarnessRunStats(runStats, toolCallCount),
    ...(failure ? { error: failure.message, failure } : {})
  });

  const finishAbort = (): HarnessOutcome => {
    if (abortSource === "external") return finish("stopped");
    return finish("failed", deadlineFailure(input.config.maxWallClockMs));
  };

  try {
    for (let iteration = 1; iteration <= input.config.maxIterations; iteration += 1) {
      if (signal.aborted) return finishAbort();
      await input.onEvent({ type: "stream_started", model: input.config.primaryModel });
      const modelStartedAt = monotonicNow();
      let streamed: StreamResult;
      try {
        streamed = await client.stream(
          {
            messages,
            tools: modelTools,
            includeWebSearch: input.includeWebSearch,
            maxWebResults: input.config.maxWebResults,
            signal
          },
          async (delta) => {
            await input.onEvent({ type: "stream_delta", delta });
          }
        );
      } finally {
        runStats.modelTimeMs += elapsedMs(modelStartedAt);
      }
      if (signal.aborted) return finishAbort();
      model = streamed.model;
      for (const [key, value] of Object.entries(streamed.usage ?? {})) {
        if (Number.isFinite(value)) aggregateUsage[key] = (aggregateUsage[key] ?? 0) + value;
      }
      accumulateHarnessUsage(runStats, streamed.usage);
      runStats.turns += 1;
      completedIterations = iteration;
      content += streamed.content;
      if (streamed.toolCalls.length === 0) {
        await input.onEvent({ type: "stream_completed", content, usage: streamed.usage });
        return finish("completed");
      }
      messages.push({
        role: "assistant",
        content: streamed.content || null,
        tool_calls: streamed.toolCalls
      });

      toolCallCount += streamed.toolCalls.length;
      if (toolCallCount > input.config.maxToolCalls) {
        throw new Error(`Harness exceeded ${input.config.maxToolCalls} tool calls`);
      }

      const plannedCalls = streamed.toolCalls.map((call, originalIndex): PlannedToolCall => ({
        call,
        originalIndex,
        stableToolCallId: stableHarnessToolCallId(input.harnessRunId, iteration, originalIndex)
      }));
      const reads = plannedCalls.filter(({ call }) => tools.get(call.function.name)?.definition.mode === "read");
      const writes = plannedCalls.filter(({ call }) => tools.get(call.function.name)?.definition.mode !== "read");
      const resultByIndex = new Map<number, ToolCallExecution>();

      // Read-only calls may overlap, but wait for every started read to settle
      // so cancellation cannot leave a terminal event racing after run finish.
      const settledReads = await Promise.allSettled(
        reads.map((planned) => executeToolCall(planned, input, tools, signal))
      );
      for (let index = 0; index < settledReads.length; index += 1) {
        const settled = settledReads[index]!;
        if (settled.status === "rejected") throw settled.reason;
        resultByIndex.set(reads[index]!.originalIndex, settled.value);
      }
      const haltedRead = [...resultByIndex.values()].find((result) => result.halt);
      if (haltedRead) {
        appendToolResultsInOriginalOrder(plannedCalls, resultByIndex, messages, runStats);
        await input.onEvent({ type: "needs_input", toolCallId: haltedRead.toolCallId });
        return finish("needs_input");
      }

      let haltedWrite: ToolCallExecution | null = null;
      for (const planned of writes) {
        const result = await executeToolCall(planned, input, tools, signal);
        resultByIndex.set(planned.originalIndex, result);
        if (result.halt) {
          haltedWrite = result;
          break;
        }
      }
      // The model transcript must always match the provider's original call
      // order even though safe reads may have completed out of order.
      appendToolResultsInOriginalOrder(plannedCalls, resultByIndex, messages, runStats);
      if (haltedWrite) {
        await input.onEvent({ type: "needs_input", toolCallId: haltedWrite.toolCallId });
        return finish("needs_input");
      }
    }
    throw new Error(`Harness exceeded ${input.config.maxIterations} model iterations`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown harness failure";
    if (signal.aborted) return finishAbort();
    return finish("failed", {
      kind: "execution",
      code: "harness_execution_failed",
      message
    });
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", markExternalAbort);
  }
}

interface ToolCallExecution {
  message: ModelMessage;
  halt: boolean;
  toolCallId: string;
  toolName: string;
  durationMs: number | null;
}

interface PlannedToolCall {
  call: ModelToolCall;
  originalIndex: number;
  stableToolCallId: string;
}

export function stableHarnessToolCallId(
  harnessRunId: string,
  turnIndex: number,
  originalToolIndex: number
): string {
  return `${harnessRunId}:turn:${turnIndex}:tool:${originalToolIndex}`;
}

async function executeToolCall(
  planned: PlannedToolCall,
  input: RunHarnessInput,
  tools: Map<string, HarnessTool>,
  parentSignal: AbortSignal
): Promise<ToolCallExecution> {
  if (parentSignal.aborted) throw abortReason(parentSignal);
  const { call, stableToolCallId } = planned;
  const tool = tools.get(call.function.name);
  if (!tool) {
    const error = `Unknown or unauthorized tool: ${call.function.name}`;
    await input.onEvent({
      type: "tool_failed",
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      error,
      phase: "validation"
    });
    return {
      message: { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) },
      halt: false,
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      durationMs: null
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}") as unknown;
  } catch {
    const error = "Tool arguments were not valid JSON";
    await input.onEvent({
      type: "tool_failed",
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      error,
      phase: "validation"
    });
    return {
      message: { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) },
      halt: false,
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      durationMs: null
    };
  }
  const inputHash = await canonicalToolInputHash(args);
  const completed = await input.findCompletedToolResult?.(stableToolCallId, inputHash);
  if (completed) {
    return {
      message: { role: "tool", tool_call_id: call.id, content: JSON.stringify(completed.output) },
      halt: completed.halt === "needs_input",
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      durationMs: null
    };
  }
  if (parentSignal.aborted) throw abortReason(parentSignal);
  await input.onEvent({ type: "tool_started", toolCallId: stableToolCallId, toolName: call.function.name, input: args });
  const timeout = AbortSignal.timeout(input.config.toolTimeoutMs);
  const signal = combineSignals([parentSignal, timeout]);
  const toolStartedAt = monotonicNow();
  let result: HarnessToolResult | null = null;
  let executionError: unknown = null;
  const abortWaiter = rejectionOnAbort(signal);
  const execution = Promise.resolve().then(() => tool.execute(args, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: input.harnessRunId,
    executionPrincipal: input.executionPrincipal,
    signal
  }));
  try {
    result = await Promise.race([execution, abortWaiter.promise]);
  } catch (error) {
    executionError = error;
  } finally {
    abortWaiter.dispose();
  }
  if (signal.aborted && executionError == null) {
    executionError = parentSignal.aborted
      ? abortReason(parentSignal)
      : new Error(`Tool execution exceeded ${input.config.toolTimeoutMs}ms timeout`);
  }
  const durationMs = elapsedMs(toolStartedAt);
  if (executionError != null) {
    const message = executionError instanceof Error ? executionError.message : "Tool execution failed";
    await input.onEvent({
      type: "tool_failed",
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      error: message,
      phase: "execution"
    });
    // Cancellation is a run-level outcome, not a synthetic tool response for
    // the model. Emit the terminal tool event, then let the harness classify it.
    if (parentSignal.aborted) throw abortReason(parentSignal);
    return {
      message: { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) },
      halt: false,
      toolCallId: stableToolCallId,
      toolName: call.function.name,
      durationMs
    };
  }
  if (!result) throw new Error("Tool execution completed without a result");
  await input.onEvent({
    type: "tool_completed",
    toolCallId: stableToolCallId,
    toolName: call.function.name,
    result
  });
  return {
    message: { role: "tool", tool_call_id: call.id, content: JSON.stringify(result.output) },
    halt: result.halt === "needs_input",
    toolCallId: stableToolCallId,
    toolName: call.function.name,
    durationMs
  };
}

function appendToolResultsInOriginalOrder(
  plannedCalls: PlannedToolCall[],
  resultByIndex: Map<number, ToolCallExecution>,
  messages: ModelMessage[],
  stats: HarnessRunStats
): void {
  for (const planned of plannedCalls) {
    const result = resultByIndex.get(planned.originalIndex);
    if (!result) continue;
    accumulateToolTiming(stats, result);
    messages.push(result.message);
  }
}

function emptyHarnessRunStats(): HarnessRunStats {
  return {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelTimeMs: 0,
    toolTimeMs: 0,
    outputTokensPerSecond: null,
    toolTimeBreakdownMs: {}
  };
}

function snapshotHarnessRunStats(stats: HarnessRunStats, toolCalls: number): HarnessRunStats {
  return {
    ...stats,
    toolCalls,
    outputTokensPerSecond:
      stats.modelTimeMs > 0 && stats.outputTokens > 0
        ? (stats.outputTokens / stats.modelTimeMs) * 1_000
        : null,
    toolTimeBreakdownMs: { ...stats.toolTimeBreakdownMs }
  };
}

function accumulateHarnessUsage(
  stats: HarnessRunStats,
  usage: Record<string, number> | null
): void {
  if (!usage) return;
  stats.inputTokens += numericUsageValue(usage, "prompt_tokens", "input_tokens");
  stats.outputTokens += numericUsageValue(usage, "completion_tokens", "output_tokens");
}

function numericUsageValue(
  usage: Record<string, number>,
  primaryKey: string,
  alternateKey: string
): number {
  const value = usage[primaryKey] ?? usage[alternateKey] ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function accumulateToolTiming(stats: HarnessRunStats, result: ToolCallExecution): void {
  if (result.durationMs == null) return;
  stats.toolTimeMs += result.durationMs;
  stats.toolTimeBreakdownMs[result.toolName] =
    (stats.toolTimeBreakdownMs[result.toolName] ?? 0) + result.durationMs;
}

function deadlineFailure(timeoutMs: number): HarnessFailure {
  return {
    kind: "deadline",
    code: "harness_deadline_exceeded",
    message: `Harness exceeded ${Math.max(0, timeoutMs)}ms wall-clock deadline`
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "Harness execution was cancelled",
    "AbortError"
  );
}

function rejectionOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
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
