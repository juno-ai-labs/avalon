import { z } from "zod";
import type { SidekickCustomTool, WorkstreamWorkflowInput } from "@rally/contracts";
import {
  renderCodeApi,
  repairRootSchemaForProviders,
  validateToolArguments,
  type HarnessPlugin,
  type HarnessRuntimeView,
  type HarnessTool,
  type HarnessToolContext,
  type HarnessToolResult,
} from "@rally/agent-harness";
import { sha256Hex } from "../../lib/crypto";
import { CodeModeToolError } from "./errors";
import { ENTRY_MODULE, ENTRY_SOURCE, PROGRAM_MODULE, wrapProgram } from "./entry-module";
import {
  CODE_PLUGIN_ID,
  CODE_PLUGIN_MODEL_ID,
  CodeToolGateway,
  callableTools,
  type CallablePlugin,
  type CodeModeHost,
  type RecordedCall,
} from "./gateway";
import {
  CODE_ERROR_MESSAGE_MAX_CHARS,
  CODE_LOG_MAX_BYTES,
  CODE_PROGRAM_DEADLINE_MS,
  CODE_PROGRAM_LOAD_ALLOWANCE_MS,
  CODE_PROGRAM_MAX_BYTES,
  CODE_RESULT_MAX_BYTES,
} from "./limits";

/** What the isolate's entry module answers `run` with. */
type EntryResult =
  | { ok: true; valueJson: string; logs: Array<{ level: string; text: string }>; logsTruncated: boolean }
  | {
      ok: false;
      error: { code: string | null; message: string; callIndex?: number | null; stack?: string | null };
      logs: Array<{ level: string; text: string }>;
      logsTruncated: boolean;
    };

type ProgramEntrypoint = {
  run(
    gateway: CodeToolGateway,
    api: Record<string, string[]>,
    options: { deadlineMs: number; logMaxBytes: number; input: unknown },
  ): Promise<EntryResult>;
};

const CodeExecuteInputSchema = z.strictObject({
  code: z.string().min(1).max(Number.isFinite(CODE_PROGRAM_MAX_BYTES) ? CODE_PROGRAM_MAX_BYTES : Number.MAX_SAFE_INTEGER),
  description: z.string().min(1).max(240),
});

const CODE_EXECUTE_DEFINITION: HarnessTool["definition"] = {
  name: "execute",
  description: "Run one JavaScript program against the typed API in # Code API: several tool calls, loops, arithmetic, filtering and shaping in one step, returning only the answer. For a single tool call, call the tool directly.",
  capability: "code.program.execute",
  mode: "write",
  idempotency: "record_before_execute",
  timeoutMs: CODE_PROGRAM_DEADLINE_MS + 2 * CODE_PROGRAM_LOAD_ALLOWANCE_MS,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["code", "description"],
    properties: {
      code: {
        type: "string",
        minLength: 1,
        ...(Number.isFinite(CODE_PROGRAM_MAX_BYTES) ? { maxLength: CODE_PROGRAM_MAX_BYTES } : {}),
        description: "The body of an async JavaScript function. `tools` is in scope; `return` the answer. Plain ES2023: Math, Date, JSON, Intl, strings, arrays, regular expressions. No imports, no fetch.",
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: 240,
        description: "One participant-facing line saying what the program does. Shown on the activity row; it does not affect execution.",
      },
    },
  },
};

export const CODE_SYSTEM_MESSAGE = `# Code
code_execute runs one JavaScript program you write against the typed API below.
Use it when several calls depend on each other, when you would loop over results,
when you need arithmetic or date math done exactly, or when you would read more
than you need and discard most of it. Make a single call directly.

The program is the body of an async function. \`tools\` holds the API, grouped by
plugin; every tool you hold is there, reads and writes alike. Plain JavaScript is
available: Math, Date, JSON, Intl, strings, arrays, regular expressions. A program
with no tool call is fine when the work is computation. \`return\` the smallest
value that answers the question; the value, not the data, enters your context.
Throw an Error for a condition you cannot handle; its message reaches you.
console.log output is returned, bounded.

Each tool call inside the program is a real call with its own record. A write made
from a program is made for real; compute first and write last, so a failure before
the write leaves nothing half done. A program re-run after an interruption replays
calls that already completed, so keep it deterministic: no Date.now() or
Math.random() in a value that reaches a tool. A failed program says which call
failed, which writes stand, and what to do; correct the program rather than
re-sending it.`;

export const CODE_PLUGIN_DESCRIPTION = "Compose several tool calls, or compute over their results, in one JavaScript program: dependent calls, loops, math, filtering and shaping, when the answer the conversation needs is smaller than the data it takes to compute. A single call is made directly.";

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function bounded(text: string): string {
  return text.length > CODE_ERROR_MESSAGE_MAX_CHARS ? `${text.slice(0, CODE_ERROR_MESSAGE_MAX_CHARS - 3)}...` : text;
}

/** The `# Code API` block for a set of callable plugins. */
export function renderCallableApi(callable: readonly CallablePlugin[]): string {
  return renderCodeApi(callable.map(({ plugin, tools }) => ({
    modelId: plugin.modelId,
    description: plugin.description,
    tools: tools.map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      mode: tool.definition.mode,
      inputSchema: repairRootSchemaForProviders(tool.definition.inputSchema),
    })),
  })));
}

export interface RunProgramInput {
  loader: WorkerLoader;
  code: string;
  gateway: CodeToolGateway;
  api: Record<string, string[]>;
  /** The saved tool's validated input, or undefined for `code_execute`. */
  programInput: unknown;
  signal: AbortSignal;
  deadlineMs?: number;
}

/**
 * Load the isolate for this program (cached by the program's hash) and run it.
 * The host-side race is the backstop for a program that blocks its own isolate:
 * the entry's own timer cannot fire inside a busy loop.
 */
export async function runProgram(input: RunProgramInput): Promise<EntryResult> {
  const deadlineMs = input.deadlineMs ?? CODE_PROGRAM_DEADLINE_MS;
  const hash = await sha256Hex(input.code);
  const worker = input.loader.get(`code:${hash}`, () => ({
    compatibilityDate: "2026-08-01",
    mainModule: ENTRY_MODULE,
    modules: { [ENTRY_MODULE]: ENTRY_SOURCE, [PROGRAM_MODULE]: wrapProgram(input.code) },
    env: {},
    globalOutbound: null,
  }));
  // The loader types the entrypoint as a bare Fetcher; `run` is the RPC method
  // our own entry module exports, so the boundary is converted explicitly.
  const stub: unknown = worker.getEntrypoint();
  const entry = stub as ProgramEntrypoint;
  const logMaxBytes = Number.isFinite(CODE_LOG_MAX_BYTES) ? CODE_LOG_MAX_BYTES : Number.MAX_SAFE_INTEGER;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.run(input.gateway, input.api, { deadlineMs, logMaxBytes, input: input.programInput }),
      new Promise<EntryResult>((resolve, reject) => {
        timer = setTimeout(() => resolve({
          ok: false,
          error: { code: "deadline", message: "deadline" },
          logs: [],
          logsTruncated: false,
        }), deadlineMs + CODE_PROGRAM_LOAD_ALLOWANCE_MS);
        input.signal.addEventListener("abort", () => reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("aborted")), { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Turn the isolate's answer into the tool result or the typed failure, naming
 * the writes that completed so the model never repeats them.
 */
export function finishProgram(result: EntryResult, calls: readonly RecordedCall[], description: string, deadlineMs = CODE_PROGRAM_DEADLINE_MS): HarnessToolResult {
  const completedWrites = calls
    .filter((call) => call.mode === "write" && (call.outcome === "completed" || call.outcome === "replayed"))
    .map((call) => `${call.tool} at ${call.index}`);
  const writesNote = completedWrites.length ? ` Completed writes: ${completedWrites.join(", ")}.` : "";
  if (!result.ok) {
    const failure = result.error;
    const message = bounded(failure.message);
    if (failure.code === "deadline") {
      throw new CodeModeToolError(
        "code_program_timed_out",
        `The program did not finish within ${deadlineMs} ms after ${calls.length} calls. Split the work into smaller programs or call the tools directly; do not repeat the completed writes it names.${writesNote}`,
        { reason: `exceeded ${deadlineMs} ms`, retryAfterMs: 0 },
      );
    }
    if (failure.code === "unserializable") {
      throw new CodeModeToolError(
        "code_program_failed",
        `The program's return value could not be serialized as JSON: ${message}. Return plain data (objects, arrays, strings, numbers).${writesNote}`,
        { reason: message, field: "return" },
      );
    }
    const at = failure.callIndex ?? null;
    const where = at !== null ? ` at call ${at} (${calls[at]?.tool ?? "unknown"})` : "";
    if (failure.code && (failure.code.startsWith("code_") || failure.code === "ambiguous_external_write")) {
      throw new CodeModeToolError(failure.code, `${failure.message}${writesNote}`, {
        reason: message,
        ...(at !== null && calls[at] ? { field: calls[at].tool } : {}),
      });
    }
    throw new CodeModeToolError(
      "code_program_failed",
      `The program threw${where}: ${message} Fix the program and run it again; do not repeat the completed writes it names.${writesNote}`,
      { reason: message, field: "code" },
    );
  }
  const bytes = textBytes(result.valueJson);
  if (bytes > CODE_RESULT_MAX_BYTES) {
    throw new CodeModeToolError(
      "code_result_too_large",
      `The return value is ${bytes} bytes; the limit is ${CODE_RESULT_MAX_BYTES}. Return the answer, not the data: aggregate or select fields.${writesNote}`,
      { reason: `${bytes} bytes returned`, field: "return", expected: `<= ${CODE_RESULT_MAX_BYTES} bytes` },
    );
  }
  return {
    output: {
      value: JSON.parse(result.valueJson) as unknown,
      logs: result.logs,
      calls: calls.map((call) => ({ index: call.index, tool: call.tool, mode: call.mode, ms: call.ms, outcome: call.outcome })),
      truncated: { logs: result.logsTruncated },
    },
    summary: `${description} (${calls.length} ${calls.length === 1 ? "call" : "calls"})`,
  };
}

/** The advertised schema, with unknown properties refused as the schema says. */
function validateToolArgumentsStrict(raw: unknown, inputSchema: Record<string, unknown>): z.ZodError | null {
  return validateToolArguments(raw, inputSchema);
}

export interface CodePlugin {
  plugin: HarnessPlugin;
  /** Bind the host seams once the run's lease and hooks exist. */
  attachHost(host: CodeModeHost): void;
  /** Run a saved tool's program with its declared plugin allowance. */
  runProgramForTool(
    run: { tool: SidekickCustomTool; input: unknown; context: HarnessToolContext },
    options: { loader: WorkerLoader; input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId"> },
  ): Promise<HarnessToolResult>;
}

/**
 * The `rally:code` plugin: one loadable tool, `code_execute`, and the per-turn
 * `# Code API` rendered from the run's active plugins.
 */
export function createCodePlugin(options: {
  loader: WorkerLoader;
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId">;
}): CodePlugin {
  let host: CodeModeHost | null = null;
  let view: HarnessRuntimeView | null = null;
  const execute: HarnessTool = {
    definition: CODE_EXECUTE_DEFINITION,
    serial: true,
    // Re-entry converges: the gateway replays every nested call that already
    // completed and runs only the ones that did not.
    reenterable: true,
    validateInput: (raw) => {
      const parsed = CodeExecuteInputSchema.safeParse(raw);
      return parsed.success ? null : parsed.error;
    },
    execute: async (raw: unknown, context: HarnessToolContext) => {
      const parsed = CodeExecuteInputSchema.parse(raw);
      if (!host || !view) {
        throw new CodeModeToolError("code_unavailable", "Programs cannot run in this conversation right now. Call the tools directly.", { reason: "code runtime not attached" });
      }
      const callable = callableTools(view, null);
      const api = Object.fromEntries(callable.map(({ plugin, tools }) => [plugin.modelId, tools.map((tool) => tool.definition.name)]));
      const gateway = new CodeToolGateway({ host, view, context, input: options.input, allowedPluginIds: null });
      const result = await runProgram({
        loader: options.loader,
        code: parsed.code,
        gateway,
        api,
        programInput: undefined,
        signal: context.signal,
      });
      return finishProgram(result, gateway.calls, parsed.description);
    },
  };
  return {
    plugin: {
      canonicalId: CODE_PLUGIN_ID,
      modelId: CODE_PLUGIN_MODEL_ID,
      shortWireName: "code",
      displayName: "Code",
      activityDisplayName: "Code",
      searchAliases: ["program", "script", "javascript", "compose", "calculate", "math", "loop", "filter"],
      description: CODE_PLUGIN_DESCRIPTION,
      systemMessage: CODE_SYSTEM_MESSAGE,
      renderSystemMessage: (runtime) => {
        const callable = callableTools(runtime, null);
        const api = renderCallableApi(callable);
        return api
          ? `${CODE_SYSTEM_MESSAGE}\n\n# Code API\n\`\`\`ts\n${api}\n\`\`\``
          : `${CODE_SYSTEM_MESSAGE}\n\n# Code API\nNo tools are callable from a program right now; load a plugin first, or write a program with no tool calls.`;
      },
      attachRuntimeView: (runtime) => {
        view = runtime;
      },
      tools: [execute],
      preload: false,
      explicit: false,
    },
    attachHost: (attached) => {
      host = attached;
    },
    runProgramForTool: async ({ tool, input, context }, runOptions) => {
      if (!host || !view) {
        throw new CodeModeToolError("code_unavailable", "Programs cannot run in this conversation right now. Call the tools directly.", { reason: "code runtime not attached" });
      }
      const allowed = new Set(tool.requiredPlugins);
      const callable = callableTools(view, allowed);
      const missing = tool.requiredPlugins.filter((pluginId) => !callable.some(({ plugin }) => plugin.modelId === pluginId));
      if (missing.length) {
        throw new CodeModeToolError(
          "code_call_refused",
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not loaded; call load_plugin directly first.`,
          { reason: "required plugin not active", field: "requiredPlugins", available: callable.map(({ plugin }) => plugin.modelId).slice(0, 40) },
        );
      }
      const api = Object.fromEntries(callable.map(({ plugin, tools }) => [plugin.modelId, tools.map((candidate) => candidate.definition.name)]));
      const gateway = new CodeToolGateway({ host, view, context, input: runOptions.input, allowedPluginIds: allowed });
      const result = await runProgram({
        loader: runOptions.loader,
        code: tool.code,
        gateway,
        api,
        programInput: input,
        signal: context.signal,
      });
      return finishProgram(result, gateway.calls, tool.description);
    },
  };
}

/** Plugin identity for a Sidekick's saved tools. */
export const CUSTOM_TOOLS_PLUGIN_ID = "rally:custom-tools";
export const CUSTOM_TOOLS_PLUGIN_MODEL_ID = "rally_custom_tools";

export const CUSTOM_TOOLS_SYSTEM_MESSAGE = "Custom tools were written and tested for this Sidekick. Prefer one over rediscovering its method. A failed custom tool names the call that failed and the writes that stand; follow the instructions' failure step rather than reconstructing the method by hand.";

/** A saved tool's program failure, in the run's vocabulary. */
function customToolFailure(name: string, error: unknown): never {
  if (!(error instanceof CodeModeToolError)) throw error;
  const suffix = " Do not rebuild its method by hand; follow the failure step in your instructions.";
  switch (error.code) {
    case "code_program_failed":
      throw new CodeModeToolError("custom_tool_failed", `custom_${name} failed: ${error.message}${suffix}`, error.details);
    case "code_program_timed_out":
      throw new CodeModeToolError("custom_tool_timed_out", `custom_${name} ${error.message}${suffix}`, error.details);
    case "code_result_too_large":
      throw new CodeModeToolError("custom_tool_result_too_large", `custom_${name} returned too much: ${error.message} This is a tool defect; say so where your instructions send failures, so the review can fix the tool.`, error.details);
    case "code_call_refused":
      throw new CodeModeToolError("custom_tool_unavailable", `custom_${name} needs a plugin this run does not hold: ${error.message} Post that the tool is unavailable where your instructions say, and stop this step.`, error.details);
    default:
      throw error;
  }
}

export interface RunCustomToolInput {
  tool: SidekickCustomTool;
  input: unknown;
  context: HarnessToolContext;
}

/**
 * Run a saved tool's program: the same executor and gateway as `code_execute`,
 * narrowed to the plugins the tool declared, with the validated input in
 * scope as `input`. Used by `sidekick_tool_test` in the wizard and by every
 * materialized `custom_<name>` in a run.
 */
export function runCustomTool(codePlugin: CodePlugin, run: RunCustomToolInput, options: { loader: WorkerLoader; input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId"> }): Promise<HarnessToolResult> {
  return codePlugin.runProgramForTool(run, options);
}

/**
 * The `rally:custom-tools` plugin for one run: one `HarnessTool` per saved tool,
 * always active, each running its program through the Code Mode executor. The
 * surface hash folds the code in through `providerOperationName`, so a receipt
 * replays only against the program that produced it.
 */
export async function createCustomToolsPlugin(
  codePlugin: CodePlugin,
  tools: readonly SidekickCustomTool[],
  options: { loader: WorkerLoader; input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId"> },
): Promise<HarnessPlugin | null> {
  if (tools.length === 0) return null;
  const harnessTools = await Promise.all(tools.map(async (tool): Promise<HarnessTool> => {
    const codeHash = await sha256Hex(tool.code);
    const inputSchema = { ...tool.inputSchema, type: "object" as const, additionalProperties: false } as Record<string, unknown>;
    return {
      definition: {
        name: tool.name,
        description: tool.description,
        capability: "sidekick.tools.run",
        mode: "write",
        idempotency: "record_before_execute",
        timeoutMs: CODE_PROGRAM_DEADLINE_MS + 2 * CODE_PROGRAM_LOAD_ALLOWANCE_MS,
        providerOperationName: `custom:${codeHash}`,
        inputSchema,
      },
      serial: true,
      reenterable: true,
      validateInput: (raw) => validateToolArgumentsStrict(raw, inputSchema),
      execute: async (raw, context) => {
        const argumentError = validateToolArgumentsStrict(raw, inputSchema);
        if (argumentError) throw argumentError;
        try {
          return await codePlugin.runProgramForTool({ tool, input: raw, context }, options);
        } catch (error) {
          return customToolFailure(tool.name, error);
        }
      },
    };
  }));
  return {
    canonicalId: CUSTOM_TOOLS_PLUGIN_ID,
    modelId: CUSTOM_TOOLS_PLUGIN_MODEL_ID,
    shortWireName: "custom",
    displayName: "Custom tools",
    activityDisplayName: "Custom tools",
    description: `Tools written and tested for this Sidekick: ${tools.map((tool) => tool.name).join(", ")}.`,
    systemMessage: CUSTOM_TOOLS_SYSTEM_MESSAGE,
    tools: harnessTools,
    preload: true,
    explicit: true,
  };
}
