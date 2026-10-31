import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { readStructuredFailure, type WorkstreamWorkflowInput } from "@rally/contracts";
import {
  canonicalToolInputHash,
  formatToolArgumentValidationError,
  normalizeToolArguments,
  omitUnspecifiedToolArguments,
  validateToolArguments,
  type BeforeToolCallDecision,
  type HarnessPlugin,
  type HarnessRuntimeView,
  type HarnessTool,
  type HarnessToolContext,
  type HarnessToolPolicyIdentity,
  type HarnessToolResult,
} from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../../durable-objects/workstream-tool-receipt-protocol";
import { persistToolExecutionPlan, type AttemptLease } from "../../runtime/harness-run-runtime";
import { CodeModeToolError } from "./errors";
import { CODE_CALLS_MAX, CODE_ERROR_MESSAGE_MAX_CHARS } from "./limits";

export const CODE_PLUGIN_ID = "rally:code";
export const CODE_PLUGIN_MODEL_ID = "rally_code";

/**
 * The tools a program may not call: loop controls, whose results are Bind
 * control signals rather than data. Everything else the run holds is callable.
 * A host constant rather than prose, so a refusal is auditable.
 */
export const LOOP_CONTROL_TOOLS: ReadonlySet<string> = new Set(["load_plugin", "load_skill", "request_elicitation"]);

/**
 * What the gateway needs from the host to make a nested call exactly as Bind
 * makes a direct one: the same authorization hook, the same receipt plan, the
 * same settlement. Built in `runWorkstreamHarness`, where those live, and
 * attached to the plugin after the tool inventory is loaded.
 */
export interface CodeModeHost {
  lease: AttemptLease;
  receipts: ToolReceiptObjectPort;
  /** Bind's `beforeToolCall`, run for the nested call. */
  authorize(call: {
    pluginId: string;
    toolName: string;
    inputHash: string;
    policy: HarnessToolPolicyIdentity;
    signal: AbortSignal;
  }): Promise<BeforeToolCallDecision | void>;
  /** The execution plan the host would record for a direct call of this tool. */
  plan(pluginId: string, tool: HarnessTool): {
    plan: Record<string, unknown>;
    compatiblePriorPlans: Record<string, unknown>[];
    connectionId: string | null;
  };
  replayOutput(outputRef: string): Promise<unknown>;
  complete(input: { invocationId: string; toolCallId: string; tool: HarnessTool; result: HarnessToolResult }): Promise<void>;
  fail(input: {
    invocationId: string;
    status: "failed" | "ambiguous";
    phase: string;
    error: { code: string; message: string; data?: { code: string; details?: Record<string, unknown> } };
  }): Promise<void>;
}

export type GatewayAnswer =
  | { ok: true; output: unknown }
  | { ok: false; code: string; error: string; index: number };

export interface RecordedCall {
  index: number;
  tool: string;
  mode: "read" | "write";
  ms: number;
  outcome: "completed" | "failed" | "replayed" | "refused";
}

export interface CallablePlugin {
  plugin: HarnessPlugin;
  tools: HarnessTool[];
}

/**
 * The tools a program may call right now: every active plugin's tools except
 * the code plugin's own and the loop controls, narrowed to `allowedPluginIds`
 * when a saved tool declared its plugins.
 */
export function callableTools(
  view: HarnessRuntimeView,
  allowedPluginIds: ReadonlySet<string> | null,
): CallablePlugin[] {
  return view.activePlugins().flatMap((plugin) => {
    if (plugin.canonicalId === CODE_PLUGIN_ID) return [];
    if (allowedPluginIds && !allowedPluginIds.has(plugin.modelId) && !allowedPluginIds.has(plugin.canonicalId)) return [];
    const tools = plugin.tools.filter((tool) => !LOOP_CONTROL_TOOLS.has(tool.definition.name));
    return tools.length ? [{ plugin, tools }] : [];
  });
}

function bounded(text: string): string {
  return text.length > CODE_ERROR_MESSAGE_MAX_CHARS ? `${text.slice(0, CODE_ERROR_MESSAGE_MAX_CHARS - 3)}...` : text;
}

/**
 * The capability a program holds: one object, passed into the isolate as an
 * RPC argument, resolving every call against the run's live active set. The
 * program never sees a tool list it could widen, and nothing it sends names
 * the run; the run is bound into this object by the host.
 */
export class CodeToolGateway extends RpcTarget {
  readonly calls: RecordedCall[] = [];
  private serialChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      host: CodeModeHost;
      view: HarnessRuntimeView;
      context: HarnessToolContext;
      input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">;
      allowedPluginIds: ReadonlySet<string> | null;
    },
  ) {
    super();
  }

  async call(pluginModelId: unknown, toolName: unknown, rawInput: unknown): Promise<GatewayAnswer> {
    const index = this.calls.length;
    const label = `${String(pluginModelId)}.${String(toolName)}`;
    const record: RecordedCall = { index, tool: label, mode: "read", ms: 0, outcome: "refused" };
    this.calls.push(record);
    const started = Date.now();
    try {
      if (index >= CODE_CALLS_MAX) {
        throw new CodeModeToolError(
          "code_budget_exhausted",
          `The program made ${CODE_CALLS_MAX} calls, the most one program may make. Do less per program or page less.`,
          { reason: `call limit ${CODE_CALLS_MAX}`, expected: `<= ${CODE_CALLS_MAX} calls` },
        );
      }
      const resolved = this.resolve(pluginModelId, toolName);
      record.mode = resolved.tool.definition.mode;
      const run = () => this.execute(index, resolved.plugin, resolved.tool, rawInput, record);
      return resolved.tool.serial || resolved.tool.definition.mode === "write"
        ? await this.serialized(run)
        : await run();
    } catch (error) {
      if (record.outcome !== "replayed") record.outcome = record.outcome === "completed" ? "completed" : error instanceof CodeModeToolError && error.code === "code_call_refused" ? "refused" : "failed";
      const code = error instanceof CodeModeToolError ? error.code : "code_call_failed";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code, error: bounded(message), index };
    } finally {
      record.ms = Date.now() - started;
    }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serialChain.then(run, run);
    this.serialChain = next.catch(() => undefined);
    return next;
  }

  private resolve(pluginModelId: unknown, toolName: unknown): { plugin: HarnessPlugin; tool: HarnessTool } {
    const callable = callableTools(this.options.view, this.options.allowedPluginIds);
    const plugin = callable.find((entry) => entry.plugin.modelId === pluginModelId);
    if (!plugin) {
      const known = this.options.view.plugins().find((candidate) => candidate.modelId === pluginModelId);
      const why = !known
        ? `no plugin named ${String(pluginModelId)} is in this run`
        : known.canonicalId === CODE_PLUGIN_ID
          ? "a program cannot run another program"
          : this.options.allowedPluginIds && !this.options.allowedPluginIds.has(known.modelId)
            ? "it is outside this tool's declared plugins"
            : `${known.modelId} is not loaded; call load_plugin directly first`;
      throw new CodeModeToolError(
        "code_call_refused",
        `${String(pluginModelId)}.${String(toolName)} cannot be called from a program: ${why}. Call it directly.`,
        { reason: why, field: `${String(pluginModelId)}.${String(toolName)}`, available: callable.map((entry) => entry.plugin.modelId).slice(0, 40) },
      );
    }
    const tool = plugin.tools.find((candidate) => candidate.definition.name === toolName);
    if (!tool) {
      const control = plugin.plugin.tools.some((candidate) => candidate.definition.name === toolName);
      const why = control ? "it is a loop control, not a tool a program can use" : `no tool named ${String(toolName)} in ${plugin.plugin.modelId}`;
      throw new CodeModeToolError(
        "code_call_refused",
        `${plugin.plugin.modelId}.${String(toolName)} cannot be called from a program: ${why}. Call it directly.`,
        { reason: why, field: `${plugin.plugin.modelId}.${String(toolName)}`, available: plugin.tools.map((candidate) => candidate.definition.name).slice(0, 40) },
      );
    }
    return { plugin: plugin.plugin, tool };
  }

  private ambiguous(name: string): CodeModeToolError {
    return new CodeModeToolError(
      "ambiguous_external_write",
      `Rally could not confirm whether ${name} completed on an earlier attempt. Do not repeat it; tell the participant what is uncertain and stop.`,
      { reason: "unknown external outcome", field: name },
    );
  }

  private async replayed(record: RecordedCall, receipt: { outputRef: string | null; outputSummary: string | null }): Promise<GatewayAnswer> {
    record.outcome = "replayed";
    const output = receipt.outputRef ? await this.options.host.replayOutput(receipt.outputRef) : null;
    return { ok: true, output: output ?? { summary: receipt.outputSummary ?? "" } };
  }

  private async execute(
    index: number,
    plugin: HarnessPlugin,
    tool: HarnessTool,
    rawInput: unknown,
    record: RecordedCall,
  ): Promise<GatewayAnswer> {
    const { host, context, input } = this.options;
    const definition = tool.definition;
    const label = `${plugin.modelId}.${definition.name}`;
    const args = rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? normalizeToolArguments(omitUnspecifiedToolArguments(rawInput, definition.inputSchema), definition.inputSchema, definition.mode)
      : rawInput;
    const inputHash = await canonicalToolInputHash(args);
    const toolCallId = `${context.toolCallId}:call:${index}`;
    const existing = await host.receipts.receiptForCall({ runId: input.harnessRunId, toolCallId });
    if (existing?.status === "completed") {
      if (existing.requestHash !== inputHash) {
        throw new CodeModeToolError(
          "code_replay_diverged",
          `Call ${index} (${label}) sent different arguments on re-run than the completed record. Remove nondeterminism (time, randomness) from arguments and run again.`,
          { reason: "arguments differ from the completed record", field: "code" },
        );
      }
      return this.replayed(record, existing);
    }
    const unsettledWrite = existing && existing.status !== "failed"
      && definition.mode === "write" && definition.idempotency === "record_before_execute" && !tool.reenterable;
    if (existing?.status === "ambiguous" || unsettledWrite) {
      if (existing && existing.status !== "ambiguous") {
        await host.fail({
          invocationId: existing.effectIntentId,
          status: "ambiguous",
          phase: "ambiguous_external_write",
          error: { code: "ambiguous_external_write", message: `Interrupted write ${definition.name} has an unknown external outcome` },
        });
      }
      throw this.ambiguous(label);
    }
    const policy: HarnessToolPolicyIdentity = {
      canonicalToolName: definition.name,
      capability: definition.capability,
      mode: definition.mode,
      idempotency: definition.idempotency,
    };
    const decision = await host.authorize({ pluginId: plugin.canonicalId, toolName: definition.name, inputHash, policy, signal: context.signal });
    if (decision && decision.allowed === false) {
      throw new CodeModeToolError("code_call_refused", `${label} cannot be called from a program: ${decision.message}`, { reason: decision.code, field: label });
    }
    const planned = host.plan(plugin.canonicalId, tool);
    const providerIdempotencyKey = definition.idempotency === "provider_key" ? toolCallId : undefined;
    const claim = await persistToolExecutionPlan(host.receipts, host.lease, {
      harnessRunId: input.harnessRunId,
      workspaceId: input.workspaceId,
      workstreamId: input.parentId,
      toolCallId,
      toolName: definition.name,
      ...(planned.connectionId ? { connectionId: planned.connectionId } : {}),
      inputHash,
      input: args,
      plan: planned.plan,
      compatiblePriorPlans: planned.compatiblePriorPlans,
      ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
      mode: definition.mode,
    });
    if (claim.state === "replay_completed") {
      const receipt = await host.receipts.receiptForCall({ runId: input.harnessRunId, toolCallId });
      return this.replayed(record, receipt ?? { outputRef: null, outputSummary: null });
    }
    if (claim.state === "ambiguous_external_write") throw this.ambiguous(label);
    let result: HarnessToolResult;
    try {
      result = await tool.execute(args, {
        workspaceId: input.workspaceId,
        workstreamId: input.parentId,
        harnessRunId: input.harnessRunId,
        toolCallId,
        effectIntentId: claim.invocationId,
        executionPrincipal: context.executionPrincipal,
        ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
        ...(decision?.allowed === true && decision.authorizationContext !== undefined
          ? { authorizationContext: decision.authorizationContext }
          : {}),
        signal: context.signal,
      });
    } catch (error) {
      const structured = readStructuredFailure(error);
      const argumentError = error instanceof z.ZodError
        ? tool.validateInput?.(args) ?? validateToolArguments(args, definition.inputSchema)
        : null;
      const message = argumentError
        ? formatToolArgumentValidationError(argumentError)
        : error instanceof Error ? error.message : "Tool execution failed";
      const interruptedWrite = context.signal.aborted
        && definition.mode === "write" && definition.idempotency === "record_before_execute";
      await host.fail({
        invocationId: claim.invocationId,
        status: interruptedWrite ? "ambiguous" : "failed",
        phase: interruptedWrite ? "ambiguous_external_write" : argumentError ? "validation" : "execution",
        error: {
          code: structured?.code ?? (argumentError ? "invalid_arguments" : "tool_failed"),
          message: message.slice(0, 500),
          ...(structured ? { data: structured } : {}),
        },
      });
      if (interruptedWrite) throw this.ambiguous(label);
      throw new CodeModeToolError(
        "code_call_failed",
        `Call ${index} (${label}) failed: ${bounded(message)} The program stopped there.`,
        { reason: bounded(message), field: label, ...(structured?.details ?? {}) },
      );
    }
    await host.complete({ invocationId: claim.invocationId, toolCallId, tool, result });
    record.outcome = "completed";
    return { ok: true, output: result.output };
  }
}
