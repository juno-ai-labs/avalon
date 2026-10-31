import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { MAXIMUM_FAILURE_AVAILABLE_VALUES, readStructuredFailure, type WorkstreamWorkflowInput } from "@rally/contracts";
import { describeZodIssues, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
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
  type HarnessToolReplayRefusal,
  type HarnessToolResult,
} from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../../durable-objects/workstream-tool-receipt-protocol";
import { persistToolExecutionPlan, type AttemptLease } from "../../runtime/harness-run-runtime";
import { CodeModeToolError } from "./errors";
import { CODE_ERROR_MESSAGE_MAX_CHARS } from "./limits";

export const CODE_PLUGIN_ID = "rally:code";
export const CODE_PLUGIN_MODEL_ID = "rally_code";
/** Plugin identity for a Sidekick's saved tools. */
export const CUSTOM_TOOLS_PLUGIN_ID = "rally:custom-tools";
export const CUSTOM_TOOLS_PLUGIN_MODEL_ID = "rally_custom_tools";

/**
 * The tools a program may not call: loop controls, whose results are Bind
 * control signals rather than data. Everything else the run holds is callable.
 * A host constant rather than prose, so a refusal is auditable.
 */
export const LOOP_CONTROL_TOOLS: ReadonlySet<string> = new Set(["load_plugin", "load_skill", "request_elicitation"]);

/**
 * A tool that itself runs a program: the wizard's `sidekick_tool_test`. Not
 * callable from a program for the reason the two program plugins are not,
 * since it would start a second isolate and a second receipt tree.
 */
export const PROGRAM_RUNNING_CAPABILITIES: ReadonlySet<string> = new Set(["rally.sidekick.tools.test"]);

/**
 * What the gateway needs from the host to make a nested call exactly as Bind
 * makes a direct one: the same authorization hook, the same receipt lookup,
 * the same plan and the same settlement. Built in `runWorkstreamHarness`,
 * where those live, and attached to the plugin just before the loop starts.
 */
export interface CodeModeHost {
  lease: AttemptLease;
  receipts: ToolReceiptObjectPort;
  /** Bind's default per-call timer, for a tool that declares none of its own. */
  toolTimeoutMs: number;
  /** Bind's `beforeToolCall`, run for the nested call. A throw is an authority failure and stops the program. */
  authorize(call: {
    pluginId: string;
    toolName: string;
    inputHash: string;
    policy: HarnessToolPolicyIdentity;
    signal: AbortSignal;
  }): Promise<BeforeToolCallDecision | void>;
  /**
   * The host's own completed-receipt lookup, as Bind calls it before a direct
   * dispatch: a replayed result, a replay refusal, an ambiguous-write halt, or
   * null when the call has to run. `nested` tells it to skip the transcript
   * and event work a root call owns.
   */
  findCompletedToolResult(
    toolCallId: string,
    inputHash: string,
    policy: { pluginId: string } & HarnessToolPolicyIdentity,
    options: { nested: true },
  ): Promise<HarnessToolResult | HarnessToolReplayRefusal | null>;
  /** The execution plan the host would record for a direct call of this tool. */
  plan(pluginId: string, tool: HarnessTool): {
    plan: Record<string, unknown>;
    compatiblePriorPlans: Record<string, unknown>[];
    connectionId: string | null;
  };
  replayOutput(outputRef: string): Promise<unknown>;
  /**
   * The call is about to execute: what Bind's `tool_started` tells the host,
   * so run-scoped observers (the attachment grounding guard) see a nested read
   * as they see a direct one.
   */
  started(call: { toolCallId: string; toolName: string; pluginId: string; policy: HarnessToolPolicyIdentity; input: unknown }): void;
  complete(input: {
    invocationId: string;
    toolCallId: string;
    pluginId: string;
    policy: HarnessToolPolicyIdentity;
    tool: HarnessTool;
    result: HarnessToolResult;
  }): Promise<void>;
  fail(input: {
    invocationId: string;
    toolCallId: string;
    pluginId: string;
    policy: HarnessToolPolicyIdentity;
    toolName: string;
    mode: "read" | "write";
    status: "failed" | "ambiguous";
    phase: "validation" | "execution" | "ambiguous_external_write";
    outcome: "definitive_failure" | "timed_out" | "aborted" | "ambiguous_external_write";
    error: { code: string; message: string; data?: { code: string; details?: Record<string, unknown> } };
  }): Promise<void>;
}

export type GatewayAnswer =
  | { ok: true; output: unknown }
  | { ok: false; code: string; error: string; index: number };

/**
 * Why a call was refused, as a code the custom-tools wrapper reads to choose
 * its sentence: only `plugin_not_loaded` is something a run can fix itself.
 */
export type RefusalReason =
  | "unknown_plugin"
  | "program_in_program"
  | "outside_required_plugins"
  | "plugin_not_loaded"
  | "loop_control"
  | "turn_scoped_result"
  | "unknown_tool"
  | "not_authorized"
  | "program_finished"
  | "program_stopped";

export interface RecordedCall {
  index: number;
  tool: string;
  mode: "read" | "write";
  ms: number;
  outcome: "completed" | "failed" | "replayed" | "refused" | "ambiguous";
  /** Set when the outcome is `refused`. */
  refusal?: RefusalReason;
}

export interface CallablePlugin {
  plugin: HarnessPlugin;
  tools: HarnessTool[];
}

/**
 * The tools a program may call right now: every active plugin's tools except
 * the two program plugins' own (a program cannot run a program), the loop
 * controls, and a tool whose result is current-turn content a program cannot
 * hold; narrowed to `allowedPluginIds` when a saved tool declared its plugins.
 */
export function callableTools(
  view: HarnessRuntimeView,
  allowedPluginIds: ReadonlySet<string> | null,
): CallablePlugin[] {
  return view.activePlugins().flatMap((plugin) => {
    if (plugin.canonicalId === CODE_PLUGIN_ID || plugin.canonicalId === CUSTOM_TOOLS_PLUGIN_ID) return [];
    if (allowedPluginIds && !allowedPluginIds.has(plugin.modelId) && !allowedPluginIds.has(plugin.canonicalId)) return [];
    const tools = plugin.tools.filter((tool) => !LOOP_CONTROL_TOOLS.has(tool.definition.name)
      && !PROGRAM_RUNNING_CAPABILITIES.has(tool.definition.capability) && !tool.yieldsContentParts);
    return tools.length ? [{ plugin, tools }] : [];
  });
}

function bounded(text: string): string {
  return text.length > CODE_ERROR_MESSAGE_MAX_CHARS ? `${text.slice(0, CODE_ERROR_MESSAGE_MAX_CHARS - 3)}...` : text;
}

function refusal(label: string, reason: RefusalReason, why: string, available: string[]): CodeModeToolError {
  return new CodeModeToolError(
    "code_call_refused",
    `${label} cannot be called from a program: ${why}`,
    { reason, field: label, available: available.slice(0, MAXIMUM_FAILURE_AVAILABLE_VALUES) },
  );
}

function ambiguous(label: string): CodeModeToolError {
  return new CodeModeToolError(
    "ambiguous_external_write",
    `Rally could not confirm whether ${label} completed. Do not repeat it; tell the participant what is uncertain and stop.`,
    { reason: "unknown external outcome", field: label },
  );
}

/**
 * Bind's own race: a tool that never reads its signal still ends when the
 * signal fires, so a per-call timer or the run's abort settles the call and
 * the session's close cannot wait on it forever.
 */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
  signal.addEventListener("abort", onAbort, { once: true });
  // The abandoned promise must not surface as an unhandled rejection later.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    }, { once: true });
  }
  return controller.signal;
}

export interface GatewaySessionOptions {
  host: CodeModeHost;
  view: HarnessRuntimeView;
  context: HarnessToolContext;
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">;
  allowedPluginIds: ReadonlySet<string> | null;
}

/**
 * One program's calls: what the gateway does, kept off the RPC surface. The
 * isolate holds a `CodeToolGateway`, whose only method forwards here; nothing
 * on this object is reachable from a program.
 *
 * Lifetime: `close()` ends the session when the program returns, waits for any
 * nested call still running to settle, and turns every later call into a
 * refusal. A thrown authorization or settlement is `fatal`: the
 * program is stopped and the error is rethrown to Bind by the tool, so the run
 * sees the real failure rather than a program's account of it.
 */
export class GatewaySession {
  readonly calls: RecordedCall[] = [];
  readonly gateway: CodeToolGateway;
  fatal: unknown = null;
  private closed = false;
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private serialChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GatewaySessionOptions) {
    this.gateway = new CodeToolGateway(this);
  }

  /**
   * The program is over: refuse new calls and wait for the ones still running
   * to settle. They are not aborted: a program that returned without awaiting
   * a write still made that write, and cutting it off would turn a receipt
   * that was about to complete into an ambiguous one. Only the run's own
   * signal, or a host failure through `stop`, aborts a call.
   */
  async close(): Promise<void> {
    this.closed = true;
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async call(pluginModelId: unknown, toolName: unknown, rawInput: unknown): Promise<GatewayAnswer> {
    const index = this.calls.length;
    const label = `${String(pluginModelId)}.${String(toolName)}`;
    const record: RecordedCall = { index, tool: label, mode: "read", ms: 0, outcome: "refused" };
    this.calls.push(record);
    const started = Date.now();
    const work = (async (): Promise<GatewayAnswer> => {
      try {
        if (this.fatal !== null) {
          throw refusal(label, "program_stopped", "an earlier call failed in a way that stopped the program.", []);
        }
        if (this.closed) {
          throw refusal(label, "program_finished", "the program already returned; a call started after return is not made.", []);
        }
        const resolved = this.resolve(pluginModelId, toolName);
        record.mode = resolved.tool.definition.mode;
        const run = () => this.execute(index, resolved.plugin, resolved.tool, rawInput, record);
        return resolved.tool.serial || resolved.tool.definition.mode === "write"
          ? await this.serialized(run, label)
          : await run();
      } catch (error) {
        if (record.outcome === "refused" && error instanceof CodeModeToolError && error.code === "code_call_refused") {
          record.refusal = error.details?.reason as RefusalReason;
        } else if (record.outcome === "refused") {
          record.outcome = "failed";
        }
        const code = error instanceof CodeModeToolError ? error.code : "code_call_failed";
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code, error: bounded(message), index };
      } finally {
        record.ms = Date.now() - started;
      }
    })();
    this.inFlight.add(work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  /**
   * One write at a time. A call checked the stopped state when it was made;
   * it checks again when its turn comes, because the call ahead of it may be
   * the one that stopped the program.
   */
  private serialized<T>(run: () => Promise<T>, label: string): Promise<T> {
    const guarded = () => {
      if (this.fatal !== null) {
        throw refusal(label, "program_stopped", "an earlier call failed in a way that stopped the program.", []);
      }
      return run();
    };
    const next = this.serialChain.then(guarded, guarded);
    this.serialChain = next.catch(() => undefined);
    return next;
  }

  private resolve(pluginModelId: unknown, toolName: unknown): { plugin: HarnessPlugin; tool: HarnessTool } {
    const label = `${String(pluginModelId)}.${String(toolName)}`;
    const callable = callableTools(this.options.view, this.options.allowedPluginIds);
    const plugin = callable.find((entry) => entry.plugin.modelId === pluginModelId);
    if (!plugin) {
      const known = this.options.view.plugins().find((candidate) => candidate.modelId === pluginModelId);
      const available = callable.map((entry) => entry.plugin.modelId);
      if (!known) throw refusal(label, "unknown_plugin", `no plugin named ${String(pluginModelId)} is in this run.`, available);
      if (known.canonicalId === CODE_PLUGIN_ID || known.canonicalId === CUSTOM_TOOLS_PLUGIN_ID) {
        throw refusal(label, "program_in_program", "a program cannot run another program.", available);
      }
      if (this.options.allowedPluginIds && !this.options.allowedPluginIds.has(known.modelId)) {
        throw refusal(label, "outside_required_plugins", `${known.modelId} is not in this tool's requiredPlugins.`, available);
      }
      throw refusal(label, "plugin_not_loaded", `${known.modelId} is not loaded. Call load_plugin for it directly, then run the program again.`, available);
    }
    const tool = plugin.tools.find((candidate) => candidate.definition.name === toolName);
    if (!tool) {
      const declared = plugin.plugin.tools.find((candidate) => candidate.definition.name === toolName);
      const available = plugin.tools.map((candidate) => candidate.definition.name);
      if (!declared) throw refusal(label, "unknown_tool", `${plugin.plugin.modelId} has no tool named ${String(toolName)}.`, available);
      if (LOOP_CONTROL_TOOLS.has(declared.definition.name)) {
        throw refusal(label, "loop_control", "it is a loop control, not a tool a program can use. Call it directly.", available);
      }
      if (PROGRAM_RUNNING_CAPABILITIES.has(declared.definition.capability)) {
        throw refusal(label, "program_in_program", "it runs a program, and a program cannot run another program. Call it directly.", available);
      }
      throw refusal(label, "turn_scoped_result", "its result is content for the current turn, which a program cannot hold. Call it directly.", available);
    }
    return { plugin: plugin.plugin, tool };
  }

  private replayed(record: RecordedCall, output: unknown): GatewayAnswer {
    record.outcome = "replayed";
    return { ok: true, output };
  }

  /** A failure of the host's own machinery: stop the program and keep the error for Bind. */
  private stop(error: unknown): never {
    if (this.fatal === null) this.fatal = error;
    this.controller.abort(error instanceof Error ? error : new Error(String(error)));
    throw refusal("the program", "program_stopped", "Rally could not authorize or record a call, so the program was stopped.", []);
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
    // The same argument check Bind runs before a dispatch, so a bad argument
    // is a correctable error with no receipt rather than a tool failure.
    let argumentError: z.ZodError | null;
    try {
      argumentError = tool.validateInput?.(args) ?? validateToolArguments(args, definition.inputSchema);
    } catch (error) {
      argumentError = error instanceof z.ZodError ? error : null;
      if (!argumentError) throw error;
    }
    if (argumentError) {
      record.outcome = "failed";
      throw new CodeModeToolError(
        "code_call_failed",
        `Call ${index} (${label}) rejected its arguments: ${formatToolArgumentValidationError(argumentError)} Fix the arguments and run the program again.`,
        { reason: "invalid_arguments", field: label },
      );
    }
    const inputHash = await canonicalToolInputHash(args);
    const toolCallId = `${context.toolCallId}:call:${index}`;
    const policy: HarnessToolPolicyIdentity = {
      canonicalToolName: definition.name,
      capability: definition.capability,
      mode: definition.mode,
      idempotency: definition.idempotency,
    };
    const signal = abortSignals(context.signal, this.controller.signal);
    // Authority first, as Bind orders it: a replayed result is still a result
    // this principal has to be allowed to read.
    let decision: BeforeToolCallDecision | void;
    try {
      decision = await host.authorize({ pluginId: plugin.canonicalId, toolName: definition.name, inputHash, policy, signal });
    } catch (error) {
      this.stop(error);
    }
    if (decision && decision.allowed === false) {
      throw refusal(label, "not_authorized", decision.message, []);
    }
    // The host's own completed-receipt lookup: a replay, a refusal to present
    // an old result as current, an ambiguous write, or nothing yet.
    let prior: HarnessToolResult | HarnessToolReplayRefusal | null;
    try {
      prior = await host.findCompletedToolResult(toolCallId, inputHash, { pluginId: plugin.canonicalId, ...policy }, { nested: true });
    } catch (error) {
      this.stop(error);
    }
    if (prior && "refusal" in prior) {
      record.outcome = "failed";
      throw new CodeModeToolError(
        "code_call_failed",
        `Call ${index} (${label}) completed on an earlier attempt but its result cannot be presented again: ${prior.refusal.message}`,
        { reason: prior.refusal.code, field: label },
      );
    }
    if (prior) {
      if (prior.halt === "needs_input") {
        record.outcome = "ambiguous";
        throw ambiguous(label);
      }
      return this.replayed(record, prior.output);
    }
    const planned = host.plan(plugin.canonicalId, tool);
    const providerIdempotencyKey = definition.idempotency === "provider_key" ? toolCallId : undefined;
    let claim: Awaited<ReturnType<typeof persistToolExecutionPlan>>;
    try {
      claim = await persistToolExecutionPlan(host.receipts, host.lease, {
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
    } catch (error) {
      this.stop(error);
    }
    if (claim.state === "replay_completed") {
      const receipt = await host.receipts.receiptForCall({ runId: input.harnessRunId, toolCallId });
      const output = receipt?.outputRef ? await host.replayOutput(receipt.outputRef) : null;
      return this.replayed(record, output ?? { summary: receipt?.outputSummary ?? "" });
    }
    if (claim.state === "ambiguous_external_write") {
      record.outcome = "ambiguous";
      throw ambiguous(label);
    }
    // Bind's per-call timer, so a nested call that hangs ends as a direct one
    // would, and the program learns which call it was.
    const timeoutMs = tool.resolveTimeoutMs?.(args) ?? definition.timeoutMs ?? host.toolTimeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException(`Call exceeded ${timeoutMs} ms`, "TimeoutError")), timeoutMs);
    const toolSignal = abortSignals(signal, timeout.signal);
    host.started({ toolCallId, toolName: definition.name, pluginId: plugin.canonicalId, policy, input: args });
    let result: HarnessToolResult;
    try {
      result = await raceWithSignal(tool.execute(args, {
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
        signal: toolSignal,
      }), toolSignal);
    } catch (error) {
      throw await this.failed(index, label, plugin, tool, args, { invocationId: claim.invocationId, toolCallId, policy }, error, toolSignal, timeout.signal, record);
    } finally {
      clearTimeout(timer);
    }
    try {
      await host.complete({ invocationId: claim.invocationId, toolCallId, pluginId: plugin.canonicalId, policy, tool, result });
    } catch (error) {
      this.stop(error);
    }
    record.outcome = "completed";
    return { ok: true, output: result.output };
  }

  /**
   * Bind's own classification of a failed dispatch, applied to the nested
   * call: an argument error after the advertised schema accepted the input is
   * correctable; a validation error downstream of valid arguments on a
   * record-before-execute write may have written; an interrupted or timed-out
   * such write may have too; Terminal's `command_outcome_unknown` is the one
   * coded failure that is also ambiguous. Everything else is definitive.
   */
  private async failed(
    index: number,
    label: string,
    plugin: HarnessPlugin,
    tool: HarnessTool,
    args: unknown,
    receipt: { invocationId: string; toolCallId: string; policy: HarnessToolPolicyIdentity },
    error: unknown,
    toolSignal: AbortSignal,
    timeoutSignal: AbortSignal,
    record: RecordedCall,
  ): Promise<CodeModeToolError> {
    const definition = tool.definition;
    const recordBeforeExecuteWrite = definition.mode === "write" && definition.idempotency === "record_before_execute";
    let declaredArgumentError: z.ZodError | null = null;
    if (error instanceof z.ZodError) {
      try {
        declaredArgumentError = tool.validateInput?.(args) ?? validateToolArguments(args, definition.inputSchema);
      } catch {
        declaredArgumentError = null;
      }
    }
    const downstreamValidationError = error instanceof z.ZodError && declaredArgumentError === null;
    const ambiguousResponseValidation = downstreamValidationError && recordBeforeExecuteWrite;
    const structured = readStructuredFailure(error);
    const interrupted = toolSignal.aborted;
    const recoverableTerminalObservation = structured?.code === "command_outcome_unknown"
      && plugin.canonicalId === "rally:terminal" && definition.name === "run_command";
    const ambiguousExternalWrite = (interrupted || ambiguousResponseValidation || recoverableTerminalObservation) && recordBeforeExecuteWrite;
    // A schema failure downstream of valid arguments names the field it
    // rejected, as every boundary must: the receipt's code carries the paths
    // (`tool_response_invalid:<field>`), the sentence Bind would say carries
    // them too. Paths are schema shape; the rejected values stay out.
    const rejectedFields = downstreamValidationError ? describeZodIssues(error as z.ZodError) : null;
    const message = declaredArgumentError
      ? formatToolArgumentValidationError(declaredArgumentError)
      : ambiguousResponseValidation
        ? `The write may have succeeded, but the tool could not validate the provider response (${rejectedFields}). Rally stopped without retrying because repeating the call could duplicate the write.`
        : downstreamValidationError
          ? `The tool failed while validating data after accepting its arguments: ${rejectedFields}.`
          : timeoutSignal.aborted
            ? `The call exceeded its ${tool.resolveTimeoutMs?.(args) ?? definition.timeoutMs ?? this.options.host.toolTimeoutMs} ms limit.`
            : error instanceof Error ? error.message : "Tool execution failed";
    const code = ambiguousExternalWrite
      ? "ambiguous_external_write"
      : declaredArgumentError
        ? "tool_validation_failed"
        : downstreamValidationError
          ? zodDiagnosticCode(error, "tool_response") ?? "tool_failed"
          : structured?.code ?? (timeoutSignal.aborted ? "tool_timeout" : interrupted ? "tool_aborted" : "tool_failed");
    try {
      await this.options.host.fail({
        invocationId: receipt.invocationId,
        toolCallId: receipt.toolCallId,
        pluginId: plugin.canonicalId,
        policy: receipt.policy,
        toolName: definition.name,
        mode: definition.mode,
        status: ambiguousExternalWrite ? "ambiguous" : "failed",
        phase: ambiguousExternalWrite ? "ambiguous_external_write" : declaredArgumentError ? "validation" : "execution",
        outcome: ambiguousExternalWrite ? "ambiguous_external_write" : timeoutSignal.aborted ? "timed_out" : interrupted ? "aborted" : "definitive_failure",
        error: { code, message: message.slice(0, 500), ...(structured ? { data: structured } : {}) },
      });
    } catch (settlementError) {
      this.stop(settlementError);
    }
    if (ambiguousExternalWrite) {
      record.outcome = "ambiguous";
      return ambiguous(label);
    }
    record.outcome = "failed";
    return new CodeModeToolError(
      "code_call_failed",
      `Call ${index} (${label}) failed: ${bounded(message)}`,
      { reason: code, field: label, ...(structured?.details ?? {}) },
    );
  }
}

/**
 * The capability a program holds: one object, passed into the isolate as an
 * RPC argument, with one method. The session it forwards to is a private
 * field, so nothing else the host knows is reachable over the stub; the
 * program never sees a tool list it could widen, and nothing it sends names
 * the run.
 */
export class CodeToolGateway extends RpcTarget {
  readonly #session: GatewaySession;

  constructor(session: GatewaySession) {
    super();
    this.#session = session;
  }

  call(pluginModelId: unknown, toolName: unknown, rawInput: unknown): Promise<GatewayAnswer> {
    return this.#session.call(pluginModelId, toolName, rawInput);
  }
}
