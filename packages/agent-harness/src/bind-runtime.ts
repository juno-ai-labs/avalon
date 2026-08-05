import {
  detectCompletionDefect,
  createTurnTextStream,
  type TurnStreamEvent,
} from "@juno-ai/bind/completion";
import { runToolLoop, type ToolLoopState } from "@juno-ai/bind/loop";
import {
  createToolRegistry,
  defineTool,
  initialActivePlugins,
  partitionPluginCatalog,
  pluginFromTools,
  rehydrateActivation,
  toolResultMessage,
  toolWireDefinition,
  type DefinedTool,
  type ToolRegistry,
  type ToolPlugin,
} from "@juno-ai/bind/plugins";
import {
  ROUTE_POLICY_VERSION,
  canonicalModelIdSchema,
  classifyAttemptError,
  createCircuitBreaker,
  executeRoutePlan,
  failureDisposition,
  providerIdSchema,
  retryAfterMsFromHeaders,
  type AttemptTarget,
  type RouteCandidate,
  type RoutePlan,
} from "@juno-ai/bind/routing";
import { createRunDeadline } from "@juno-ai/bind/run";
import { validateAndHealMessages } from "@juno-ai/bind/transcript";
import type OpenAI from "openai";
import { z } from "zod";
import type { HarnessFailureCode } from "@avalon/contracts";
import { modelContextBudget } from "./context-budget";
import {
  BIND_RUNTIME_CORE_TOOL_DEFINITIONS,
  OpenRouterClient,
  OpenRouterError,
  canonicalToolInputHash,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessOutcome,
  type HarnessPlugin,
  type HarnessTool,
  type HarnessToolContext,
  type HarnessToolPolicyIdentity,
  type HarnessToolResult,
  type ModelMessage,
  type RunHarnessInput,
} from "./index";

const CORE_PLUGIN_ID = "avalon:core";
const OPENROUTER_PROVIDER = providerIdSchema.parse("openrouter");
const DEFAULT_CATALOG_TOKENS = 2_500;
const DEFAULT_MAX_ACTIVE_PLUGINS = 12;
const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 128 * 1024;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 128 * 1024;
const circuitBreaker = createCircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 60_000,
  maxCooldownMs: 120_000,
});

type BindPlugin = ToolPlugin<HarnessToolContext> & {
  canonicalId: string;
  modelId: string;
  shortWireName: string;
  displayName?: string;
  searchAliases: readonly string[];
  explicit: boolean;
  toolByWireName: Map<string, HarnessTool>;
  modeByWireName: Map<string, "read" | "write">;
};

type RoutedTurn = {
  result: Awaited<ReturnType<OpenRouterClient["stream"]>>;
  attemptCount: number;
};

type RenderedSystemPrompt = {
  content: string;
  fixedPolicy: string;
  activePluginSnippets: string[];
  boundedCatalog: string;
};

type ModelContextAccounting = {
  aggregateBytes: number;
  fixedPolicyBytes: number;
  activePluginSnippetBytes: number;
  boundedCatalogBytes: number;
  conversationAndToolResultBytes: number;
  toolSchemaBytes: number;
  framingBytes: number;
};

class HarnessLimitError extends Error {
  constructor(readonly code: Exclude<HarnessFailureCode, "harness_execution_failed" | "ambiguous_external_write">, message: string) {
    super(message);
    this.name = "HarnessLimitError";
  }
}

class FatalHarnessPortError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "FatalHarnessPortError";
  }
}

class AmbiguousExternalWriteError extends Error {
  constructor(readonly toolCallId: string, message: string) {
    super(message);
    this.name = "AmbiguousExternalWriteError";
  }
}

class OpenRouterCompletionDefectError extends Error {
  constructor(readonly defect: "empty_completion" | "truncated_tool_call") {
    super(`OpenRouter returned a ${defect.replaceAll("_", " ")}`);
    this.name = "OpenRouterCompletionDefectError";
  }
}

export async function runHarnessWithBind(input: RunHarnessInput): Promise<HarnessOutcome> {
  const onTurnWouldEnd = input.onTurnWouldEnd;
  const deadline = createRunDeadline({
    timeoutMs: input.config.maxWallClockMs,
    label: "Avalon Bind run",
  });
  const signal = deadline.withExternal(input.signal);
  const state: ToolLoopState = {
    messages: [],
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    lastPromptTokens: 0,
    lastOutputTokens: 0,
    hasFreshTokenCount: false,
    toolCalls: 0,
  };
  let model: string | null = null;
  let content = "";
  let streamedContent = "";
  let routedAttempts = 0;
  let stableTurnIndex = 0;
  const toolCallPositions = new Map<string, { turn: number; index: number }>();
  const emit = async (event: HarnessEvent): Promise<void> => {
    try {
      await input.onEvent(event);
    } catch (error) {
      if (event.type === "stream_started" || event.type === "stream_delta") {
        await input.onBestEffortEventDropped?.({
          type: event.type,
          turnId: event.turnId,
          epoch: event.epoch,
          streamSeq: event.streamSeq,
        });
        return;
      }
      throw new FatalHarnessPortError("A required host persistence port failed", error);
    }
  };

  try {
    const runtime = await createPluginRuntime(input);
    const initialSystemPrompt = runtime.renderSystemPrompt();
    const healed = validateAndHealMessages([
      { role: "system", content: initialSystemPrompt.content },
      ...toOpenAiMessages(input.messages),
    ]);
    state.messages.push(...healed.messages);
    await input.onTranscriptIssues?.(healed.issues.map((issue) => ({
      kind: issue.kind,
      index: issue.index,
      healed: issue.healed,
    })));

    const result = await runToolLoop({
      state,
      activePlugins: runtime.active,
      maxIterations: input.config.maxIterations,
      signal,
      throwIfTimedOut: deadline.throwIfTimedOut,
      ensureNotCancelled: () => {
        if (signal.aborted) throw abortReason(signal);
        if (state.inputTokens + state.outputTokens > (input.config.maxRunTokens ?? 200_000)) {
          throw new HarnessLimitError("run_token_limit_exceeded", "Run token ceiling exceeded");
        }
        if (state.costCents > (input.config.maxCostCents ?? 500)) {
          throw new HarnessLimitError("run_cost_limit_exceeded", "Run cost ceiling exceeded");
        }
      },
      buildTools: runtime.buildWireTools,
      activatePlugins: (ids) => {
        runtime.activate(ids);
        replaceSystemMessage(state.messages, runtime.renderSystemPrompt().content);
      },
      runsSerially: (toolCall) => toolCall.type === "function" && runtime.runsSerially(toolCall.function.name),
      isFatalToolError: (error) =>
        error instanceof FatalHarnessPortError ||
        error instanceof HarnessLimitError ||
        error instanceof AmbiguousExternalWriteError ||
        signal.aborted,
      onToolCallRejected: (toolCallId, error) => {
        void input.onToolCallRejected?.({
          toolCallId,
          code: error instanceof Error ? error.name : "tool_call_rejected",
        });
      },
      callModel: async (messages, _tools, onOutputProgress) => {
        deadline.throwIfTimedOut();
        await runtime.reauthorizeActive();
        const systemPrompt = runtime.renderSystemPrompt();
        replaceSystemMessage(messages, systemPrompt.content);
        // Bind assembles its tool list before entering callModel. Authorization
        // is deliberately revalidated at this later boundary, so rebuild the
        // wire surface here to prevent a just-revoked plugin from remaining
        // visible to the model for one turn.
        const authorizedTools = runtime.buildWireTools();
        await requiredPort("Run liveness renewal failed", () => input.onLiveness?.("before_model"));
        const prepared = validateAndHealMessages(messages);
        await input.onTranscriptIssues?.(prepared.issues.map((issue) => ({
          kind: issue.kind,
          index: issue.index,
          healed: issue.healed,
        })));
        stableTurnIndex += 1;
        const routed = await routeOpenRouterTurn({
          input,
          messages: prepared.messages,
          tools: authorizedTools,
          systemPrompt,
          signal,
          turnId: `${input.harnessRunId}:turn:${stableTurnIndex}`,
          emit,
          ...(onOutputProgress ? { onOutputProgress } : {}),
        });
        routedAttempts += routed.attemptCount;
        model = routed.result.model;
        const turnInputTokens = numberFromUsage(routed.result.usage, "prompt_tokens");
        const turnOutputTokens = numberFromUsage(routed.result.usage, "completion_tokens");
        const turnCostCents = costCents(routed.result.usage);
        assertCompletedTurnWithinRunLimits({
          priorInputTokens: state.inputTokens,
          priorOutputTokens: state.outputTokens,
          priorCostCents: state.costCents,
          priorToolCalls: state.toolCalls,
          turnInputTokens,
          turnOutputTokens,
          turnCostCents,
          requestedToolCalls: routed.result.toolCalls.length,
          maxRunTokens: input.config.maxRunTokens ?? 200_000,
          maxCostCents: input.config.maxCostCents ?? 500,
          maxToolCalls: input.config.maxToolCalls,
        });
        routed.result.toolCalls.forEach((call, index) => {
          toolCallPositions.set(call.id, { turn: stableTurnIndex, index });
        });
        const message: OpenAI.ChatCompletionMessage = {
            role: "assistant",
            content: routed.result.content || null,
            refusal: null,
            ...(routed.result.toolCalls.length > 0
              ? { tool_calls: routed.result.toolCalls }
              : {}),
        };
        return {
          message,
          inputTokens: turnInputTokens,
          outputTokens: turnOutputTokens,
          cachedInputTokens: cachedTokens(routed.result.usage),
          costCents: turnCostCents,
        };
      },
      runToolCall: async (toolCall) => {
        if (signal.aborted) throw abortReason(signal);
        if (toolCall.type !== "function") {
          return {
            toolMessage: toolResultMessage(toolCall.id, {
              success: false,
              kind: "validation",
              error: "Custom tool calls are not supported by this runtime",
            }),
          };
        }
        const dispatched = runtime.resolveTool(toolCall.function.name);
        if (!dispatched) {
          return {
            toolMessage: toolResultMessage(toolCall.id, {
              success: false,
              kind: "authz",
              error: `Tool ${toolCall.function.name} is not active or authorized`,
            }),
          };
        }
        const policy: HarnessToolPolicyIdentity = {
          canonicalToolName: dispatched.tool.definition.name,
          capability: dispatched.tool.definition.capability,
          mode: dispatched.tool.definition.mode,
          idempotency: dispatched.tool.definition.idempotency,
        };
        let args: unknown;
        try {
          args = JSON.parse(toolCall.function.arguments || "{}") as unknown;
        } catch {
          await emit({
            type: "tool_failed",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            pluginId: dispatched.pluginId,
            policy,
            error: "Tool arguments were not valid JSON",
            phase: "validation",
            outcome: "definitive_failure",
          });
          return {
            toolMessage: toolResultMessage(toolCall.id, {
              success: false,
              kind: "validation",
              error: "Tool arguments were not valid JSON; correct them and try again",
            }),
          };
        }
        const inputHash = await canonicalToolInputHash(args);
        const position = toolCallPositions.get(toolCall.id);
        const receiptId = position
          ? `${input.harnessRunId}:turn:${position.turn}:tool:${position.index}`
          : `${input.harnessRunId}:tool:${toolCall.function.name}:${inputHash.slice(0, 32)}`;
        await requiredPort("Tool authorization revalidation failed", () => input.beforeToolCall?.({
            pluginId: dispatched.pluginId,
            toolName: dispatched.tool.definition.name,
            inputHash,
            signal,
          }));
        const completed = await requiredPort(
          "Tool receipt lookup failed",
          () => input.findCompletedToolResult?.(receiptId, inputHash, {
            pluginId: dispatched.pluginId,
            ...policy,
          }),
        );
        if (completed) {
          return harnessResultOutcome(toolCall.id, completed);
        }
        const executionPlanHash = await canonicalToolInputHash({
          pluginId: dispatched.pluginId,
          toolName: dispatched.tool.definition.name,
          inputHash,
          mode: dispatched.tool.definition.mode,
          idempotency: dispatched.tool.definition.idempotency,
        });
        const providerIdempotencyKey = dispatched.tool.definition.idempotency === "provider_key"
          ? receiptId
          : null;
        try {
          await input.persistToolExecutionPlan?.({
            toolCallId: receiptId,
            pluginId: dispatched.pluginId,
            wireToolName: toolCall.function.name,
            canonicalToolName: dispatched.tool.definition.name,
            inputHash,
            executionPlanHash,
            providerIdempotencyKey,
            mode: dispatched.tool.definition.mode,
            idempotency: dispatched.tool.definition.idempotency,
          });
          await input.checkpointToolInvocation?.({ toolCallId: receiptId, state: "executing" });
        } catch (error) {
          throw new FatalHarnessPortError("Tool execution plan persistence failed", error);
        }
        await emit({
          type: "tool_started",
          toolCallId: receiptId,
          toolName: toolCall.function.name,
          pluginId: dispatched.pluginId,
          policy,
          input: args,
          ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
        });
        const toolSignal = combinedTimeoutSignal(
          signal,
          dispatched.tool.definition.timeoutMs ?? input.config.toolTimeoutMs,
        );
        let toolResult: HarnessToolResult;
        try {
          toolResult = await raceWithSignal(dispatched.tool.execute(args, {
            workspaceId: input.workspaceId,
            workstreamId: input.workstreamId,
            harnessRunId: input.harnessRunId,
            toolCallId: receiptId,
            executionPrincipal: input.executionPrincipal,
            ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
            signal: toolSignal,
          }), toolSignal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool execution failed";
          const interrupted = toolSignal.aborted;
          const ambiguousExternalWrite = interrupted
            && dispatched.tool.definition.mode === "write"
            && dispatched.tool.definition.idempotency === "record_before_execute";
          const failureOutcome = ambiguousExternalWrite
            ? "ambiguous_external_write" as const
            : interrupted
              ? signal.aborted
                ? "aborted" as const
                : "timed_out" as const
              : "definitive_failure" as const;
          await emit({
            type: "tool_failed",
            toolCallId: receiptId,
            toolName: toolCall.function.name,
            pluginId: dispatched.pluginId,
            policy,
            error: message,
            phase: "execution",
            outcome: failureOutcome,
          });
          // A cancellation or timeout racing a non-idempotent write leaves the
          // provider outcome unknown. Preserve that ambiguity before honoring
          // the parent abort so a cancelled run cannot silently retry the write.
          if (ambiguousExternalWrite) {
            await requiredPort("Ambiguous write checkpoint persistence failed", () => input.checkpointToolInvocation?.({ toolCallId: receiptId, state: "timed_out" }));
            await requiredPort("Ambiguous write persistence failed", () => input.onAmbiguousExternalWrite?.({
              toolCallId: receiptId,
              pluginId: dispatched.pluginId,
              toolName: dispatched.tool.definition.name,
            }));
            throw new AmbiguousExternalWriteError(receiptId, `Interrupted write ${dispatched.tool.definition.name} has an unknown external outcome`);
          }
          if (signal.aborted) throw abortReason(signal);
          if (error instanceof FatalHarnessPortError || error instanceof HarnessLimitError || error instanceof AmbiguousExternalWriteError) {
            throw error;
          }
          await requiredPort("Tool failure checkpoint persistence failed", () => input.checkpointToolInvocation?.({
            toolCallId: receiptId,
            state: toolSignal.aborted ? "timed_out" : "failed",
          }));
          return {
            toolMessage: toolResultMessage(toolCall.id, {
              success: false,
              kind: "external",
              error: message,
            }),
          };
        }
        const bounded = boundToolResult(toolResult.output, input.config.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES);
        const persistedResult = { ...toolResult, output: bounded };
        if (toolResult.providerOperationId) {
          await requiredPort("Tool provider checkpoint persistence failed", () => input.checkpointToolInvocation?.({
            toolCallId: receiptId,
            state: "provider_acknowledged",
            providerOperationId: toolResult.providerOperationId!,
          }));
        }
        await emit({
          type: "tool_completed",
          toolCallId: receiptId,
          toolName: toolCall.function.name,
          pluginId: dispatched.pluginId,
          policy,
          result: persistedResult,
        });
        await requiredPort("Tool completion checkpoint persistence failed", () => input.checkpointToolInvocation?.({
          toolCallId: receiptId,
          state: "completed",
          ...(toolResult.providerOperationId ? { providerOperationId: toolResult.providerOperationId } : {}),
        }));
        await requiredPort("Run liveness renewal failed", () => input.onLiveness?.("after_tool"));
        return harnessResultOutcome(toolCall.id, persistedResult);
      },
      onAssistantMessage: (message) => {
        content += message;
      },
      ...(onTurnWouldEnd
        ? {
            onTurnWouldEnd: (assistantMessage: OpenAI.ChatCompletionMessage, cumulativeToolCalls: number) =>
              onTurnWouldEnd({
                assistantContent: typeof assistantMessage.content === "string" ? assistantMessage.content : "",
                cumulativeToolCalls,
              }),
          }
        : {}),
      onProgressUpdate: (outputTokens, toolCalls) => {
        void input.onProgress?.({ outputTokens, toolCalls });
      },
      flushProgress: () => requiredPort("Run usage flush failed", () => input.flushProgress?.({
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          costCents: state.costCents,
          toolCalls: state.toolCalls,
        })),
    });
    await requiredPort("Run liveness renewal failed", () => input.onLiveness?.("iteration_boundary"));

    if (result.stopReason === "waiting_for_reply" || result.stopReason === "resuming_later") {
      if (state.suspended?.toolCallId) {
        await emit({ type: "needs_input", toolCallId: state.suspended.toolCallId });
      }
      return outcome("needs_input", content || streamedContent, model, state, routedAttempts, result.stats);
    }
    if (result.stopReason === "aborted") {
      return outcome("stopped", content || streamedContent, model, state, routedAttempts, result.stats);
    }
    if (result.stopReason === "iteration_limit") {
      throw new HarnessLimitError("run_iteration_limit_exceeded", `Harness exceeded ${input.config.maxIterations} model iterations`);
    }
    await emit({
      type: "stream_completed",
      content: content || streamedContent,
      usage: usageRecord(state),
    });
    return outcome("completed", content || streamedContent, model, state, routedAttempts, result.stats);
  } catch (error) {
    if (input.signal?.aborted && !deadline.timedOut && !(error instanceof AmbiguousExternalWriteError)) {
      return outcome("stopped", content || streamedContent, model, state, routedAttempts);
    }
    const code = error instanceof HarnessLimitError
      ? error.code
      : error instanceof AmbiguousExternalWriteError
        ? "ambiguous_external_write"
      : deadline.timedOut
        ? "run_wall_time_limit_exceeded"
        : "harness_execution_failed";
    const failure: HarnessFailure = {
      kind: deadline.timedOut
        ? "deadline"
        : error instanceof HarnessLimitError
          ? error.code === "context_limit_exceeded" || error.code === "tool_surface_too_large"
            ? "context"
            : "limit"
          : error instanceof AmbiguousExternalWriteError
            ? "ambiguous_external_write"
            : "execution",
      code,
      message: error instanceof Error ? error.message : "Harness execution failed",
    };
    return {
      ...outcome("failed", content || streamedContent, model, state, routedAttempts),
      error: failure.message,
      failure,
    };
  } finally {
    deadline.dispose();
  }

  async function routeOpenRouterTurn(args: {
    input: RunHarnessInput;
    messages: OpenAI.ChatCompletionMessageParam[];
    tools: OpenAI.ChatCompletionTool[] | undefined;
    systemPrompt: RenderedSystemPrompt;
    signal: AbortSignal;
    turnId: string;
    emit: (event: HarnessEvent) => Promise<void>;
    onOutputProgress?: (tokens: number) => void;
  }): Promise<RoutedTurn> {
    let emittedStart = false;
    let currentModel = args.input.config.primaryModel;
    let streamEventChain = Promise.resolve();
    const textStream = createTurnTextStream({
      turnId: args.turnId,
      maxResets: args.input.config.maxStreamResets ?? 4,
      sink: {
        retractable: true,
        emit(event: TurnStreamEvent) {
          streamEventChain = streamEventChain.then(async () => {
            if (!emittedStart) {
              emittedStart = true;
              await args.emit({
                type: "stream_started",
                model: currentModel,
                turnId: event.turnId,
                epoch: event.epoch,
                streamSeq: 0,
                reset: false,
              });
            }
            streamedContent = event.kind === "reset" ? "" : streamedContent + event.text;
            await args.emit({
              type: "stream_delta",
              delta: event.kind === "text" ? event.text : "",
              turnId: event.turnId,
              epoch: event.epoch,
              // Sequence zero is reserved for `stream_started`. Bind's text
              // stream is zero-based, so shift every data/reset frame by one;
              // otherwise the desktop correctly deduplicates the first text
              // chunk as a replay of the start frame.
              streamSeq: event.seq + 1,
              reset: event.kind === "reset",
            });
          });
        },
      },
    });
    const plan = routePlan(args.input.config.primaryModel, args.input.config.fallbackModels ?? [], args.input.workspaceId);
    const routed = await executeRoutePlan({
      plan,
      completionDefectRetries: args.input.config.completionDefectRetries ?? 2,
      breaker: circuitBreaker,
      attempt: async (candidate, cursor) => {
        const requestMessages = prepareModelContextWithinBudget({
          model: candidate.providerInvocationModel,
          maxContextBytes: args.input.config.maxContextBytes,
          ...(args.input.config.maxRunTokens === undefined
            ? {}
            : { maxRunTokens: args.input.config.maxRunTokens }),
          ...(args.input.config.modelContextWindowTokens === undefined
            ? {}
            : { modelContextWindowTokens: args.input.config.modelContextWindowTokens }),
          systemPrompt: args.systemPrompt,
          messages: fromOpenAiMessages(args.messages),
          tools: args.tools ?? [],
        });
        const startedAt = Date.now();
        currentModel = candidate.providerInvocationModel;
        textStream.beginAttempt();
        try {
          const client = new OpenRouterClient({
            ...args.input.config,
            primaryModel: candidate.providerInvocationModel,
            fallbackModels: [],
            sameModelRetries: args.input.config.sameModelRetries ?? 0,
          });
          const result = await client.stream({
            messages: requestMessages,
            ...(args.tools ? { tools: args.tools as unknown as Array<Record<string, unknown>> } : {}),
            ...(modelMessagesContainFile(requestMessages)
              ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] }
              : {}),
            includeWebSearch: false,
            reasoningEffort: args.input.config.reasoningEffort,
            signal: args.signal,
          }, async (delta) => {
            textStream.observe(delta);
            await requiredPort("Run liveness renewal failed", () => args.input.onLiveness?.("during_stream"));
            args.onOutputProgress?.(Math.max(1, Math.ceil(delta.length / 4)));
            await streamEventChain;
          });
          const defect = detectCompletionDefect({
            content: result.content || null,
            tool_calls: result.toolCalls,
          }, result.finishReason === "length");
          if (defect) throw new OpenRouterCompletionDefectError(defect.kind);
          await requiredPort("Inference attempt ledger persistence failed", () => args.input.onInferenceAttempt?.({
            success: true,
            turnId: args.turnId,
            disposition: cursor.stageIndex > 0 || cursor.candidateIndex > 0
              ? "fallback"
              : cursor.endpointAttempt > 0
                ? "retry"
                : "success",
            model: candidate.canonicalModelId,
            provider: candidate.providerId,
            cursor,
            latencyMs: Date.now() - startedAt,
            ttftMs: result.ttftMs,
            inputTokens: numberFromUsage(result.usage, "prompt_tokens"),
            outputTokens: numberFromUsage(result.usage, "completion_tokens"),
            reasoningTokens: numberFromUsage(result.usage, "reasoning_tokens"),
            cachedInputTokens: cachedTokens(result.usage),
            costCents: costCents(result.usage),
            responseBytes: result.responseBytes,
          }));
          return { kind: "success", value: result };
        } catch (error) {
          if (error instanceof FatalHarnessPortError || error instanceof HarnessLimitError || error instanceof AmbiguousExternalWriteError) {
            throw error;
          }
          const target: AttemptTarget = {
            cursor,
            providerId: candidate.providerId,
            canonicalModelId: candidate.canonicalModelId,
            providerInvocationModel: candidate.providerInvocationModel,
            durationMs: Date.now() - startedAt,
          };
          const classified = classifyAttemptError(error, target, {
            isAbort: (value) => args.signal.aborted || (value instanceof Error && value.name === "AbortError"),
            asTransportFailure: classifyOpenRouterFailure,
          });
          const disposition = failureDisposition(classified);
          await requiredPort("Inference attempt ledger persistence failed", () => args.input.onInferenceAttempt?.({
            success: false,
            turnId: args.turnId,
            disposition: classified.kind === "aborted"
              ? "cancelled"
              : classified.kind === "completion_defect"
                ? "defect"
                : disposition.sameEndpointRetry
                  ? "retry"
                  : disposition.nextProvider || disposition.fallbackModel
                    ? "fallback"
                    : "failed",
            model: candidate.canonicalModelId,
            provider: candidate.providerId,
            cursor,
            latencyMs: target.durationMs,
            failureKind: classified.kind,
          }));
          return {
            kind: "failure",
            error: classified,
            producedOutput: textStream.producedOutput,
          };
        }
      },
    });
    if (!routed.ok) {
      textStream.finish("failed");
      await streamEventChain;
      const error = routed.reason === "attempts_exhausted" ? routed.error.cause : new Error("No viable OpenRouter endpoint");
      throw error;
    }
    textStream.finish("succeeded");
    await streamEventChain;
    return { result: routed.value, attemptCount: routed.attemptCount };
  }
}

async function createPluginRuntime(
  input: RunHarnessInput,
): Promise<{
  active: Set<string>;
  renderSystemPrompt: () => RenderedSystemPrompt;
  buildWireTools: () => OpenAI.ChatCompletionTool[];
  activate: (ids: string[]) => void;
  reauthorizeActive: () => Promise<void>;
  runsSerially: (wireName: string) => boolean;
  resolveTool: (wireName: string) => { pluginId: string; tool: HarnessTool } | null;
}> {
  const plugins = [corePlugin(input), ...(input.plugins ?? []).map(toBindPlugin)];
  const registry = createToolRegistry<BindPlugin>({ corePlugins: [CORE_PLUGIN_ID] });
  for (const plugin of plugins) registry.register(plugin);
  const eligibleIds = new Set(plugins.map((plugin) => plugin.canonicalId));
  const canonicalByModelId = new Map<string, string>();
  for (const plugin of plugins) {
    const existing = canonicalByModelId.get(plugin.modelId);
    if (existing && existing !== plugin.canonicalId) {
      throw new Error(`Duplicate model-facing plugin id: ${plugin.modelId}`);
    }
    canonicalByModelId.set(plugin.modelId, plugin.canonicalId);
  }
  const active = new Set(initialActivePlugins(registry.corePlugins()));
  // `preload` is a host-side selection hint, not proof that activation crossed
  // the durable boundary. Only IDs the host returns after persistence may be
  // restored into Bind's active surface.
  const requested = input.activationHints ?? [];
  const restored = await rehydrateActivation(requested, {
    canonicalizeName: registry.canonicalizeName,
    resolve: async (id) => {
      if (!eligibleIds.has(id)) return "unknown";
      return await requiredPort("Plugin authorization revalidation failed", () => input.reauthorizePlugin?.(id)) === false
        ? "unreachable"
        : true;
    },
  });
  for (const id of restored.active) active.add(id);
  for (const dropped of restored.dropped) await input.onActivationDropped?.(dropped);

  const assertActiveSurface = (candidate: ReadonlySet<string>) => {
    const activeCredentialCount = [...candidate].filter((id) => id !== CORE_PLUGIN_ID).length;
    const maxPlugins = input.config.maxActivePlugins ?? DEFAULT_MAX_ACTIVE_PLUGINS;
    if (activeCredentialCount > maxPlugins) {
      throw new HarnessLimitError("tool_surface_too_large", `Active credential plugin count exceeds ${maxPlugins}`);
    }
    const schemaBytes = toolSchemaBytes(candidate, registry);
    const maxSchemaBytes = input.config.maxToolSchemaBytes ?? DEFAULT_MAX_TOOL_SCHEMA_BYTES;
    if (schemaBytes > maxSchemaBytes) {
      throw new HarnessLimitError("tool_surface_too_large", `Active tool schema surface exceeds ${maxSchemaBytes} bytes`);
    }
  };
  assertActiveSurface(active);

  const activate = (ids: string[]) => {
    const next = new Set(active);
    for (const id of ids) {
      if (!eligibleIds.has(id) || !registry.get(id)) continue;
      next.add(id);
    }
    assertActiveSurface(next);
    active.clear();
    for (const id of next) active.add(id);
  };

  const reauthorizeActive = async () => {
    for (const id of [...active]) {
      if (id === CORE_PLUGIN_ID) continue;
      if (await requiredPort("Plugin authorization revalidation failed", () => input.reauthorizePlugin?.(id)) === false) {
        active.delete(id);
        await input.onActivationDropped?.({ name: id, reason: "unreachable" });
      }
    }
    assertActiveSurface(active);
  };

  const resolveTool = (wireName: string) => {
    // Prefer the exact name Avalon advertised. Some OpenRouter routes have
    // nevertheless returned a namespaced/canonical alias (for example,
    // `avalon_core.web_monitor_fetch`) after a plugin was loaded. Bind has
    // already rebuilt the next-turn tool surface at that point; rejecting the
    // alias would make a successfully activated tool appear unavailable.
    for (const id of [...active].sort()) {
      const plugin = registry.get(id);
      const tool = plugin?.toolByWireName.get(wireName);
      if (tool) return { pluginId: id, tool };
    }

    // Alias resolution is deliberately scoped to the current active surface
    // and succeeds only when one tool matches. It therefore cannot activate a
    // plugin, widen the frozen run authority, or guess across two credential
    // plugins exposing the same canonical tool name. Host authorization and
    // health checks still run immediately before the resolved tool executes.
    const aliases = providerToolAliasCandidates(wireName);
    const matches: Array<{ pluginId: string; tool: HarnessTool }> = [];
    for (const id of [...active].sort()) {
      const plugin = registry.get(id);
      if (!plugin) continue;
      for (const [advertisedWireName, tool] of plugin.toolByWireName) {
        const identities = [
          normalizeToolIdentity(advertisedWireName),
          normalizeToolIdentity(tool.definition.name),
        ];
        if (identities.some((identity) => identity && aliases.has(identity))) {
          matches.push({ pluginId: id, tool });
        }
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  };

  const catalogTool = plugins[0]!.toolByWireName.get("avalon_load_plugin");
  if (catalogTool) {
    catalogTool.execute = async (raw) => {
      const modelId = typeof raw === "object" && raw !== null && "pluginId" in raw ? String(raw.pluginId) : "";
      const id = canonicalByModelId.get(modelId) ?? "";
      if (!eligibleIds.has(id) || id === CORE_PLUGIN_ID) {
        return { output: { error: "plugin_not_available" }, summary: "Plugin is not available" };
      }
      if (await requiredPort("Plugin authorization revalidation failed", () => input.reauthorizePlugin?.(id)) === false) {
        return { output: { error: "plugin_not_authorized" }, summary: "Plugin is no longer authorized" };
      }
      const next = new Set(active).add(id);
      assertActiveSurface(next);
      await requiredPort("Plugin activation persistence failed", () => input.persistActivation?.(id));
      const plugin = registry.get(id)!;
      const tools = plugin.tools.map((tool) => ({
        name: stableWireToolName(plugin.shortWireName, tool.name),
        description: tool.description,
      }));
      return {
        output: { loaded: plugin.modelId, tools },
        summary: `Loaded ${plugin.displayName ?? plugin.modelId}; ${tools.length} tools are now available`,
        loadedPluginName: id,
      } as HarnessToolResult;
    };
  }
  const listTool = plugins[0]!.toolByWireName.get("list_connector_plugins");
  if (listTool) {
    listTool.execute = async () => ({
      output: { plugins: connectorCatalog(registry) },
      summary: "Listed authorized connector plugins",
    });
  }
  const searchTool = plugins[0]!.toolByWireName.get("search_connector_plugins");
  if (searchTool) {
    searchTool.execute = async (raw) => {
      const query = typeof raw === "object" && raw !== null && "query" in raw
        ? String(raw.query).trim().toLowerCase()
        : "";
      const matches = connectorCatalog(registry).filter((plugin) =>
        `${plugin.id} ${plugin.displayName ?? ""} ${plugin.searchAliases.join(" ")} ${plugin.description}`
          .toLowerCase()
          .includes(query));
      return {
        output: { plugins: matches },
        summary: `Found ${matches.length} authorized connector plugins`,
      };
    };
  }

  return {
    active,
    renderSystemPrompt: () => renderStableSystemPrompt(input.systemPrompt, active, registry, input.config.maxCatalogTokens ?? DEFAULT_CATALOG_TOKENS),
    buildWireTools: () => {
      assertActiveSurface(active);
      const definitions: OpenAI.ChatCompletionTool[] = [];
      for (const id of [...active].sort()) {
        const plugin = registry.get(id);
        if (!plugin) continue;
        for (const tool of plugin.tools) {
          if (tool.hidden) continue;
          const harnessTool = [...plugin.toolByWireName.entries()].find(([, value]) => value.definition.name === tool.name)?.[0];
          if (!harnessTool) continue;
          definitions.push(toolWireDefinition(tool, harnessTool));
        }
      }
      return definitions;
    },
    activate,
    reauthorizeActive,
    runsSerially: (wireName) => wireName === "avalon_load_plugin" || resolveTool(wireName)?.tool.definition.mode === "write",
    resolveTool,
  };
}

function corePlugin(input: RunHarnessInput): BindPlugin {
  const tools = [...input.tools];
  for (const definition of BIND_RUNTIME_CORE_TOOL_DEFINITIONS) {
    tools.push({
      definition,
      execute: async () => definition.name === "load_plugin"
        ? { output: { error: "activation_not_initialized" }, summary: "Activation unavailable" }
        : { output: { plugins: [] }, summary: "Plugin catalog unavailable" },
    });
  }
  return buildPlugin({
    canonicalId: CORE_PLUGIN_ID,
    modelId: "avalon_core",
    shortWireName: "avalon",
    description: "Core Avalon work-stream tools and connector plugin activation.",
    systemMessage: "Use avalon.current_time when exact current time or timezone matters; never infer it from transcript timestamps. Connector plugins are groups of tools backed by credentials already authorized for this run. When a request needs an external service, load the relevant available connector plugin before answering. Before claiming that a service or its data is unavailable, inspect the compact catalog and, when needed, use list_connector_plugins or search_connector_plugins and attempt to load the matching plugin. Once loaded, its tools are available on the next model turn. Loading a plugin never expands the run's original authority.",
    tools,
    preload: true,
    explicit: true,
  });
}

function toBindPlugin(plugin: HarnessPlugin): BindPlugin {
  return buildPlugin(plugin);
}

function buildPlugin(plugin: HarnessPlugin): BindPlugin {
  const toolByWireName = new Map<string, HarnessTool>();
  const modeByWireName = new Map<string, "read" | "write">();
  const defined: Array<DefinedTool<HarnessToolContext>> = [];
  for (const harnessTool of plugin.tools) {
    const wireName = plugin.canonicalId === CORE_PLUGIN_ID
      ? harnessTool.definition.name === "load_plugin"
        ? "avalon_load_plugin"
        : harnessTool.definition.name
      : stableWireToolName(plugin.shortWireName, harnessTool.definition.name);
    toolByWireName.set(wireName, harnessTool);
    modeByWireName.set(wireName, harnessTool.definition.mode);
    defined.push(defineTool({
      name: harnessTool.definition.name,
      description: harnessTool.definition.description,
      schema: z.unknown(),
      rawJsonSchema: harnessTool.definition.inputSchema,
      annotations: {
        readOnlyHint: harnessTool.definition.mode === "read",
        destructiveHint: harnessTool.definition.mode === "write",
        idempotentHint: harnessTool.definition.idempotency !== "record_before_execute",
        openWorldHint: true,
      },
      execute: async (args, context) => {
        const result = await harnessTool.execute(args, context);
        return { success: true, data: result.output };
      },
    }));
  }
  const generated = pluginFromTools({
    name: plugin.canonicalId,
    description: plugin.description,
    ...(plugin.systemMessage ? { systemMessage: plugin.systemMessage } : {}),
    tools: defined,
  });
  return {
    ...generated,
    canonicalId: plugin.canonicalId,
    modelId: plugin.modelId,
    shortWireName: plugin.shortWireName,
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    searchAliases: [...(plugin.searchAliases ?? [])],
    explicit: plugin.explicit ?? false,
    toolByWireName,
    modeByWireName,
  };
}

function stableWireToolName(prefix: string, toolName: string): string {
  const normalized = normalizeToolIdentity(toolName);
  const providerPrefix = prefix.replace(/_[2-9][0-9]*$/u, "");
  const instanceSuffix = prefix.slice(providerPrefix.length);
  if (normalized === providerPrefix || normalized.startsWith(`${providerPrefix}_`)) {
    return `${providerPrefix}${instanceSuffix}${normalized.slice(providerPrefix.length)}`.slice(0, 64);
  }
  return `${prefix}_${normalized}`.slice(0, 64);
}

function normalizeToolIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Return normalized identities a provider may have used for one advertised
 * tool name. The full value is included for punctuation-only rewrites, while
 * suffixes cover provider-added namespaces such as `avalon_core.<tool>`.
 */
function providerToolAliasCandidates(value: string): ReadonlySet<string> {
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeToolIdentity(candidate);
    if (normalized) candidates.add(normalized);
  };
  add(value);
  for (const separator of ["::", "__", ".", "/"]) {
    let offset = value.indexOf(separator);
    while (offset >= 0) {
      add(value.slice(offset + separator.length));
      offset = value.indexOf(separator, offset + separator.length);
    }
  }
  return candidates;
}

function connectorCatalog(registry: ToolRegistry<BindPlugin>): Array<{
  id: string;
  displayName?: string;
  searchAliases: readonly string[];
  description: string;
}> {
  return registry.summaries()
    .filter((plugin) => plugin.name !== CORE_PLUGIN_ID)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 500)
    .map((plugin) => {
      const registered = registry.get(plugin.name);
      return {
        id: registered?.modelId ?? plugin.name,
        ...(registered?.displayName ? { displayName: registered.displayName } : {}),
        searchAliases: registered?.searchAliases ?? [],
        description: plugin.description,
      };
    });
}

function renderStableSystemPrompt(
  base: string,
  active: ReadonlySet<string>,
  registry: ToolRegistry<BindPlugin>,
  catalogTokens: number,
): RenderedSystemPrompt {
  const activeSections = [...active]
    .sort()
    .flatMap((id) => {
      const plugin = registry.get(id);
      return plugin?.systemMessage ? [`<plugin id="${plugin.modelId}">\n${plugin.systemMessage}\n</plugin>`] : [];
    });
  const catalog = partitionPluginCatalog(active, registry.summaries());
  const catalogLines = catalog.loadable
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((plugin) => {
      const registered = registry.get(plugin.name);
      const displayName = registered?.displayName;
      const aliases = registered?.searchAliases ?? [];
      const discovery = [
        ...(displayName ? [`name=${JSON.stringify(displayName)}`] : []),
        ...(aliases.length > 0 ? [`aliases=${JSON.stringify(aliases)}`] : []),
      ].join("; ");
      return `- id=${JSON.stringify(registered?.modelId ?? plugin.name)}${discovery ? `; ${discovery}` : ""}; description=${plugin.description}`;
    });
  const maxChars = Math.max(256, catalogTokens * 4);
  let used = 0;
  const bounded: string[] = [];
  for (const line of catalogLines) {
    if (used + line.length + 1 > maxChars) break;
    bounded.push(line);
    used += line.length + 1;
  }
  const boundedCatalog = bounded.length > 0
    ? `<available_connector_plugins>\n${bounded.join("\n")}\nUse avalon_load_plugin with the exact plugin id before using one.\n</available_connector_plugins>`
    : "";
  return {
    content: [base, ...activeSections, boundedCatalog].filter(Boolean).join("\n\n"),
    fixedPolicy: base,
    activePluginSnippets: activeSections,
    boundedCatalog,
  };
}

function prepareModelContextWithinBudget(input: {
  model: string;
  maxContextBytes: number;
  maxRunTokens?: number;
  modelContextWindowTokens?: Readonly<Record<string, number>>;
  systemPrompt: RenderedSystemPrompt;
  messages: RunHarnessInput["messages"];
  tools: OpenAI.ChatCompletionTool[];
}): RunHarnessInput["messages"] {
  const budget = modelContextBudget({
    model: input.model,
    configuredMaxBytes: input.maxContextBytes,
    ...(input.maxRunTokens === undefined ? {} : { maxRunTokens: input.maxRunTokens }),
    ...(input.modelContextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens: input.modelContextWindowTokens }),
  });
  if (budget.effectiveMaxBytes < 1) {
    throw new HarnessLimitError(
      "context_limit_exceeded",
      `Selected model ${input.model} has an invalid context budget`,
    );
  }

  const renderedSystemIndex = input.messages.findIndex((message) =>
    message.role === "system" && message.content === input.systemPrompt.content);
  const stableSystemMessage: ModelMessage = renderedSystemIndex >= 0
    ? input.messages[renderedSystemIndex]!
    : { role: "system", content: input.systemPrompt.content };
  const conversation = renderedSystemIndex >= 0
    ? input.messages.filter((_message, index) => index !== renderedSystemIndex)
    : input.messages;
  const fixedMessages = [stableSystemMessage];
  const fixedAccounting = accountModelContext({
    systemPrompt: input.systemPrompt,
    messages: fixedMessages,
    tools: input.tools,
  });
  if (fixedAccounting.aggregateBytes > budget.effectiveMaxBytes) {
    throw modelContextLimitError(input.model, budget, fixedAccounting);
  }

  const units = modelContextUnits(conversation);
  let latestUserUnitIndex = -1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]!.some((message) => message.role === "user")) {
      latestUserUnitIndex = index;
      break;
    }
  }
  const selectedUnits: ModelMessage[][] = [];
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const nextSelected = [units[index]!, ...selectedUnits];
    const candidateMessages = [...fixedMessages, ...nextSelected.flat()];
    const accounting = accountModelContext({
      systemPrompt: input.systemPrompt,
      messages: candidateMessages,
      tools: input.tools,
    });
    if (accounting.aggregateBytes <= budget.effectiveMaxBytes) {
      selectedUnits.unshift(units[index]!);
      continue;
    }
    if (selectedUnits.length === 0 || index === latestUserUnitIndex) {
      // The newest unit is required for a coherent continuation. Never slice a
      // message, tool-call arguments, or a tool result merely to make it fit.
      // The newest user request is likewise required throughout a multi-turn
      // tool loop; dropping it would leave the model with tool results but no
      // originating task.
      throw modelContextLimitError(input.model, budget, accounting);
    }
    // Keep one contiguous newest suffix. Skipping a newer unit to retain an
    // older one would silently reorder the conversation's effective history.
    break;
  }
  return [...fixedMessages, ...selectedUnits.flat()];
}

function modelContextLimitError(
  model: string,
  budget: ReturnType<typeof modelContextBudget>,
  accounting: ModelContextAccounting,
): HarnessLimitError {
  return new HarnessLimitError(
    "context_limit_exceeded",
    [
      `Selected model ${model} context requires ${accounting.aggregateBytes} bytes but its budget is ${budget.effectiveMaxBytes} bytes`,
      ...(budget.contextWindowTokens === null
        ? []
        : [`(model window ${budget.contextWindowTokens} tokens, reserved run budget ${budget.reservedRunTokens} tokens),`]),
      `(fixed policy ${accounting.fixedPolicyBytes}, active plugin snippets ${accounting.activePluginSnippetBytes},`,
      `bounded catalog ${accounting.boundedCatalogBytes}, conversation/tool results ${accounting.conversationAndToolResultBytes},`,
      `tool schemas ${accounting.toolSchemaBytes}, framing ${accounting.framingBytes})`,
    ].join(" "),
  );
}

function modelContextUnits(messages: RunHarnessInput["messages"]): ModelMessage[][] {
  const units: ModelMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      units.push([message]);
      continue;
    }
    const expectedResults = new Set(message.tool_calls.map((call) => call.id));
    const unit = [message];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const candidate = messages[cursor]!;
      if (candidate.role !== "tool" || !candidate.tool_call_id || !expectedResults.has(candidate.tool_call_id)) break;
      unit.push(candidate);
      expectedResults.delete(candidate.tool_call_id);
      cursor += 1;
    }
    units.push(unit);
    index = cursor - 1;
  }
  return units;
}

function accountModelContext(input: {
  systemPrompt: RenderedSystemPrompt;
  messages: RunHarnessInput["messages"];
  tools: OpenAI.ChatCompletionTool[];
}): ModelContextAccounting {
  const renderedSystemIndex = input.messages.findIndex((message) =>
    message.role === "system" && message.content === input.systemPrompt.content);
  const conversation = renderedSystemIndex < 0
    ? input.messages
    : input.messages.filter((_message, index) => index !== renderedSystemIndex);
  const fixedPolicyBytes = utf8Bytes(input.systemPrompt.fixedPolicy);
  const activePluginSnippetBytes = input.systemPrompt.activePluginSnippets
    .reduce((bytes, snippet) => bytes + utf8Bytes(snippet), 0);
  const boundedCatalogBytes = utf8Bytes(input.systemPrompt.boundedCatalog);
  const accountedConversation = binarySafeModelMessages(conversation);
  const accountedMessages = binarySafeModelMessages(input.messages);
  const conversationAndToolResultBytes = jsonBytes(accountedConversation);
  const toolSchemaBytes = input.tools.length > 0 ? jsonBytes(input.tools) : 0;
  // Measure the exact logical context handed to OpenRouter. Framing covers the
  // system-message role/object, JSON escaping, array separators, and the prompt
  // separators between independently measured policy/plugin/catalog sections.
  const aggregateBytes = jsonBytes({
    messages: accountedMessages,
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
  });
  const categorizedBytes = fixedPolicyBytes
    + activePluginSnippetBytes
    + boundedCatalogBytes
    + conversationAndToolResultBytes
    + toolSchemaBytes;
  return {
    aggregateBytes,
    fixedPolicyBytes,
    activePluginSnippetBytes,
    boundedCatalogBytes,
    conversationAndToolResultBytes,
    toolSchemaBytes,
    framingBytes: Math.max(0, aggregateBytes - categorizedBytes),
  };
}

function binarySafeModelMessages(messages: RunHarnessInput["messages"]): RunHarnessInput["messages"] {
  return JSON.parse(JSON.stringify(messages, (key, value: unknown) => {
    if ((key === "url" || key === "file_data") && typeof value === "string" && value.startsWith("data:")) {
      return `[binary data URI omitted from text-context accounting; ${value.length} characters]`;
    }
    if (key === "data" && typeof value === "string" && value.length > 1_024) {
      return `[binary audio omitted from text-context accounting; ${value.length} characters]`;
    }
    return value;
  })) as RunHarnessInput["messages"];
}

function toolSchemaBytes(active: ReadonlySet<string>, registry: ToolRegistry<BindPlugin>): number {
  let bytes = 0;
  for (const id of active) {
    const plugin = registry.get(id);
    if (!plugin) continue;
    for (const tool of plugin.tools) {
      bytes += new TextEncoder().encode(JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.rawJsonSchema ?? {},
      })).byteLength;
    }
  }
  return bytes;
}

function routePlan(primary: string, fallbacks: string[], workspaceId: string): RoutePlan {
  const models = [...new Set([primary, ...fallbacks].filter(Boolean))];
  const stages = models.map((model, index) => {
    const canonical = canonicalModelIdSchema.parse(model);
    const candidate: RouteCandidate = {
      providerId: OPENROUTER_PROVIDER,
      canonicalModelId: canonical,
      providerInvocationModel: model,
      credentialSource: "platform",
      creditEligible: false,
      capabilities: new Set(["chat_completions", "streaming", "tools"]),
      maxCompletionTokens: null,
      pricingBasis: { kind: "provider_reported" },
      bindingFingerprint: `openrouter:${model}`,
      breakerScope: workspaceId,
    };
    return {
      kind: index === 0 ? "primary" as const : "fallback_model" as const,
      canonicalModelId: canonical,
      policy: { mode: "only" as const, provider: OPENROUTER_PROVIDER },
      candidates: [candidate],
    };
  });
  return {
    policyVersion: ROUTE_POLICY_VERSION,
    requirements: {
      capabilities: new Set(["chat_completions", "streaming", "tools"]),
      requestedMaxCompletionTokens: null,
    },
    stages,
  };
}

function replaceSystemMessage(messages: OpenAI.ChatCompletionMessageParam[], content: string): void {
  const index = messages.findIndex((message) => message.role === "system");
  const next: OpenAI.ChatCompletionSystemMessageParam = { role: "system", content };
  if (index >= 0) messages[index] = next;
  else messages.unshift(next);
}

function classifyOpenRouterFailure(error: unknown) {
  if (error instanceof OpenRouterCompletionDefectError) {
    return { kind: error.defect, statusCode: null, retryAfterMs: null } as const;
  }
  if (error instanceof OpenRouterError) {
    const status = error.status ?? null;
    return {
      kind: status === 429
        ? "rate_limit" as const
        : status != null && status >= 500
          ? "server_error" as const
          : status === 402
            ? "no_credits" as const
            : "api" as const,
      statusCode: status,
      retryAfterMs: retryAfterMsFromHeaders((error.details as { headers?: unknown } | undefined)?.headers),
    };
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === "NetworkError")) {
    return { kind: "network" as const, statusCode: null, retryAfterMs: null };
  }
  return null;
}

function toOpenAiMessages(messages: RunHarnessInput["messages"]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content as unknown as OpenAI.ChatCompletionAssistantMessageParam["content"],
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      } as OpenAI.ChatCompletionAssistantMessageParam;
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
        tool_call_id: message.tool_call_id ?? "missing",
      };
    }
    return {
      role: message.role,
      content: (message.content ?? "") as unknown as OpenAI.ChatCompletionMessageParam["content"],
    } as OpenAI.ChatCompletionMessageParam;
  });
}

function fromOpenAiMessages(messages: OpenAI.ChatCompletionMessageParam[]): RunHarnessInput["messages"] {
  const result: RunHarnessInput["messages"] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: typeof message.content === "string" ? message.content : null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.filter((call) => call.type === "function") } : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        tool_call_id: message.tool_call_id,
      });
      continue;
    }
    if (message.role === "system" || message.role === "developer" || message.role === "user") {
      result.push({
        role: message.role === "developer" ? "system" : message.role,
        content: message.role === "user" && Array.isArray(message.content)
          ? message.content as unknown as ModelMessage["content"]
          : typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      });
    }
  }
  return result;
}

function modelMessagesContainFile(messages: RunHarnessInput["messages"]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part.type === "file"));
}

function harnessResultOutcome(toolCallId: string, result: HarnessToolResult) {
  return {
    toolMessage: toolResultMessage(toolCallId, { success: true, data: result.output }),
    ...(result.halt === "needs_input"
      ? { suspend: { toolCallId, reason: "needs_input", resumeKind: "answer" as const } }
      : {}),
    ...((result as HarnessToolResult & { loadedPluginName?: string }).loadedPluginName
      ? { loadedPluginName: (result as HarnessToolResult & { loadedPluginName: string }).loadedPluginName }
      : {}),
  };
}

function boundToolResult(value: unknown, maxBytes: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new HarnessLimitError("context_limit_exceeded", "Tool result could not be represented safely as JSON");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= maxBytes) return value;
  const envelopeBudget = maxBytes - 128;
  if (envelopeBudget < 32) {
    throw new HarnessLimitError("context_limit_exceeded", "Tool result budget is too small for a safe reduction envelope");
  }
  const reduced = structurallyReduceJson(value, envelopeBudget);
  if (reduced === undefined) {
    throw new HarnessLimitError("context_limit_exceeded", "Tool result could not be reduced without slicing JSON structure");
  }
  const envelope = { truncated: true, originalBytes: bytes, data: reduced };
  if (jsonBytes(envelope) > maxBytes) {
    throw new HarnessLimitError("context_limit_exceeded", "Safely reduced tool result still exceeds its context budget");
  }
  return envelope;
}

function structurallyReduceJson(value: unknown, maxBytes: number): unknown | undefined {
  if (jsonBytes(value ?? null) <= maxBytes) return value ?? null;
  if (typeof value === "string") {
    const codePoints = Array.from(value);
    let low = 0;
    let high = codePoints.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${codePoints.slice(0, middle).join("")}…`;
      if (jsonBytes(candidate) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? `${codePoints.slice(0, low).join("")}…` : undefined;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const remaining = Math.max(16, maxBytes - jsonBytes(output) - 2);
      const reduced = structurallyReduceJson(item, remaining);
      if (reduced === undefined) break;
      const candidate = [...output, reduced];
      if (jsonBytes(candidate) > maxBytes) break;
      output.push(reduced);
    }
    return output.length > 0 ? output : undefined;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const keyCost = jsonBytes(key) + 4;
      const remaining = Math.max(16, maxBytes - jsonBytes(output) - keyCost);
      const reduced = structurallyReduceJson(item, remaining);
      if (reduced === undefined) continue;
      const candidate = { ...output, [key]: reduced };
      if (jsonBytes(candidate) > maxBytes) continue;
      output[key] = reduced;
    }
    return Object.keys(output).length > 0 ? output : undefined;
  }
  return undefined;
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function combinedTimeoutSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, timeoutMs))]);
}

function assertCompletedTurnWithinRunLimits(input: {
  priorInputTokens: number;
  priorOutputTokens: number;
  priorCostCents: number;
  priorToolCalls: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  turnCostCents: number;
  requestedToolCalls: number;
  maxRunTokens: number;
  maxCostCents: number;
  maxToolCalls: number;
}): void {
  const totalTokens = input.priorInputTokens
    + input.priorOutputTokens
    + input.turnInputTokens
    + input.turnOutputTokens;
  if (totalTokens > input.maxRunTokens) {
    throw new HarnessLimitError(
      "run_token_limit_exceeded",
      `Run token ceiling of ${input.maxRunTokens} was exceeded`,
    );
  }

  const totalCostCents = input.priorCostCents + input.turnCostCents;
  if (totalCostCents > input.maxCostCents) {
    throw new HarnessLimitError(
      "run_cost_limit_exceeded",
      `Run cost ceiling of ${input.maxCostCents} cents was exceeded`,
    );
  }

  const totalToolCalls = input.priorToolCalls + input.requestedToolCalls;
  if (totalToolCalls > input.maxToolCalls) {
    // Reject the complete batch before Bind dispatches any member. Partially
    // running an oversized parallel batch could perform a write and then fail
    // the run solely because a sibling call crossed the ceiling.
    throw new HarnessLimitError(
      "run_tool_call_limit_exceeded",
      `Run tool-call ceiling of ${input.maxToolCalls} would be exceeded`,
    );
  }
}

function numberFromUsage(usage: Record<string, number> | null, key: string): number {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cachedTokens(usage: Record<string, number> | null): number | null {
  const value = usage?.cached_tokens ?? usage?.cached_prompt_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function costCents(usage: Record<string, number> | null): number {
  const dollars = usage?.cost;
  return typeof dollars === "number" && Number.isFinite(dollars) ? dollars * 100 : 0;
}

function usageRecord(state: ToolLoopState): Record<string, number> {
  return {
    prompt_tokens: state.inputTokens,
    completion_tokens: state.outputTokens,
    cached_tokens: 0,
    cost_cents: state.costCents,
  };
}

function outcome(
  status: HarnessOutcome["status"],
  content: string,
  model: string | null,
  state: ToolLoopState,
  routedAttempts: number,
  stats?: {
    turns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    modelTimeMs: number;
    toolTimeMs: number;
    outputTokensPerSecond: number | null;
    toolTimeBreakdownMs: Readonly<Record<string, number>>;
  },
): HarnessOutcome {
  return {
    status,
    content,
    model,
    iterations: state.hasFreshTokenCount ? Math.max(1, routedAttempts) : 0,
    toolCalls: state.toolCalls,
    usage: usageRecord(state),
    stats: stats
      ? {
          turns: stats.turns,
          toolCalls: stats.toolCalls,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          modelTimeMs: stats.modelTimeMs,
          toolTimeMs: stats.toolTimeMs,
          outputTokensPerSecond: stats.outputTokensPerSecond,
          toolTimeBreakdownMs: { ...stats.toolTimeBreakdownMs },
        }
      : {
          turns: state.hasFreshTokenCount ? Math.max(1, routedAttempts) : 0,
          toolCalls: state.toolCalls,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          modelTimeMs: 0,
          toolTimeMs: 0,
          outputTokensPerSecond: null,
          toolTimeBreakdownMs: {},
        },
  };
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function requiredPort<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FatalHarnessPortError) throw error;
    throw new FatalHarnessPortError(label, error);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Run aborted", "AbortError");
}
