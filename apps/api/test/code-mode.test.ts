/**
 * Code Mode off workerd: the gateway's decisions over a real receipt store,
 * and the pure pieces around it. The isolate itself needs the loader and is
 * proved in `test-workers/code-mode.test.ts`; here the gateway is driven as
 * the entry module would drive it, call by call.
 */

import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { HarnessPlugin, HarnessRuntimeView, HarnessTool, HarnessToolContext, HarnessToolResult } from "@rally/agent-harness";

import {
  CODE_PLUGIN_ID,
  CODE_PLUGIN_MODEL_ID,
  CUSTOM_TOOLS_PLUGIN_ID,
  CUSTOM_TOOLS_PLUGIN_MODEL_ID,
  CodeModeToolError,
  EntryResultSchema,
  GatewaySession,
  callableTools,
  customToolFailure,
  finishProgram,
  programSyntaxRefusal,
  wrapProgram,
  type CodeModeHost,
  type RecordedCall,
} from "../src/services/code-mode";
import { claimHarnessAttempt } from "../src/runtime/harness-run-runtime";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testHarnessRunPort,
  testToolReceiptPort,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-0000000000c0");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-0000000000c1");
const RUN_ID = asHarnessRunId("00000000-0000-4000-8000-0000000000c2");
const USER_ID = asUserId("00000000-0000-4000-8000-0000000000c3");

const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function tool(overrides: Partial<HarnessTool> & { name: string; mode?: "read" | "write"; idempotency?: HarnessTool["definition"]["idempotency"] }): HarnessTool {
  const { name, mode = "read", idempotency = mode === "read" ? "safe" : "record_before_execute", ...rest } = overrides;
  return {
    definition: {
      name,
      description: `${name} description`,
      capability: `test.${name}`,
      mode,
      idempotency,
      inputSchema: { type: "object", properties: { n: { type: "integer", description: "A number." } }, required: [], additionalProperties: false },
    },
    execute: async (input) => ({ output: { echoed: input }, summary: `${name} done` }),
    ...rest,
  };
}

function plugin(canonicalId: string, modelId: string, tools: HarnessTool[]): HarnessPlugin {
  return { canonicalId, modelId, shortWireName: modelId.replace(/^rally_|^plugin_/, ""), description: `${modelId} plugin`, preload: true, tools };
}

function view(active: HarnessPlugin[], inactive: HarnessPlugin[] = []): HarnessRuntimeView {
  return {
    isActive: (canonicalId) => active.some((candidate) => candidate.canonicalId === canonicalId),
    activePlugins: () => active,
    plugins: () => [...active, ...inactive],
  };
}

function context(signal = new AbortController().signal): HarnessToolContext {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: RUN_ID,
    toolCallId: "program-call",
    executionPrincipal: { type: "user", userId: USER_ID },
    signal,
  };
}

/** A real receipt store with a claimed attempt, and a host whose seams are spies. */
async function hostOver(overrides: Partial<CodeModeHost> = {}) {
  const objectDatabase = testWorkstreamObjectStore();
  openDatabases.push(objectDatabase);
  seedWorkstreamObjectRoot(objectDatabase, {
    workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID, title: "Code", description: "Code",
    originType: "ad_hoc", createdByUserId: USER_ID, exactState: "idle",
  });
  seedWorkstreamRun(objectDatabase, { id: RUN_ID, status: "admitted", executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });
  const receipts = testToolReceiptPort(objectDatabase);
  const runs = testHarnessRunPort(objectDatabase);
  const claim = await claimHarnessAttempt(runs, { harnessRunId: RUN_ID }, { attemptId: "attempt-code", owner: "owner-code" });
  if (claim.state !== "claimed") throw new Error("expected a claimed attempt");
  const host: CodeModeHost = {
    lease: claim.lease,
    receipts,
    toolTimeoutMs: 30_000,
    authorize: vi.fn(async () => ({ allowed: true as const })),
    findCompletedToolResult: vi.fn(async () => null),
    plan: (pluginId, candidate) => ({
      plan: { pluginId, canonicalToolName: candidate.definition.name, capability: candidate.definition.capability, mode: candidate.definition.mode, idempotency: candidate.definition.idempotency, toolSurfaceHash: "surface" },
      compatiblePriorPlans: [],
      connectionId: null,
    }),
    replayOutput: vi.fn(async () => ({ replayed: true })),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
  const rows = () => objectDatabase.prepare("SELECT tool_call_id, tool_name, status, mode FROM tool_effects ORDER BY tool_position").all() as Array<Record<string, unknown>>;
  return { host, rows };
}

const core = plugin("rally:core", "rally_core", [
  tool({ name: "current_time" }),
  tool({ name: "request_elicitation", mode: "write", idempotency: "provider_key" }),
]);

describe("callableTools", () => {
  it("offers every active plugin's tools except programs, loop controls and turn-scoped results, narrowed to an allowance", () => {
    const image = tool({ name: "view_image", yieldsContentParts: true });
    const terminal = plugin("rally:terminal", "rally_terminal", [tool({ name: "run_command", mode: "write" }), image]);
    const code = plugin(CODE_PLUGIN_ID, CODE_PLUGIN_MODEL_ID, [tool({ name: "execute", mode: "write" })]);
    const custom = plugin(CUSTOM_TOOLS_PLUGIN_ID, CUSTOM_TOOLS_PLUGIN_MODEL_ID, [tool({ name: "day_math", mode: "write" })]);
    const all = callableTools(view([core, terminal, code, custom]), null);
    expect(all.map((entry) => [entry.plugin.modelId, entry.tools.map((candidate) => candidate.definition.name)])).toEqual([
      ["rally_core", ["current_time"]],
      ["rally_terminal", ["run_command"]],
    ]);
    expect(callableTools(view([core, terminal]), new Set(["rally_core"])).map((entry) => entry.plugin.modelId)).toEqual(["rally_core"]);
  });
});

describe("GatewaySession", () => {
  it("runs a nested call as a receipt of its own and settles it through the host", async () => {
    const { host, rows } = await hostOver();
    const session = new GatewaySession({ host, view: view([core]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const answer = await session.gateway.call("rally_core", "current_time", { n: 2 });
    expect(answer).toEqual({ ok: true, output: { echoed: { n: 2 } } });
    expect(rows()).toEqual([{ tool_call_id: "program-call:call:0", tool_name: "current_time", status: "executing", mode: "read" }]);
    expect(host.authorize).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "rally:core", toolName: "current_time" }));
    expect(host.findCompletedToolResult).toHaveBeenCalledWith("program-call:call:0", expect.any(String), expect.objectContaining({ pluginId: "rally:core", canonicalToolName: "current_time" }), { nested: true });
    expect(host.complete).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "program-call:call:0" }));
    expect(session.calls.map((call) => [call.index, call.tool, call.outcome])).toEqual([[0, "rally_core.current_time", "completed"]]);
  });

  it("replays a completed child the host already holds, and goes ambiguous on a halt, without executing", async () => {
    const execute = vi.fn(async (): Promise<HarnessToolResult> => ({ output: {}, summary: "ran" }));
    const replayable = plugin("rally:core", "rally_core", [tool({ name: "current_time", execute })]);
    const { host, rows } = await hostOver({
      findCompletedToolResult: vi.fn(async (toolCallId: string) => toolCallId.endsWith(":call:0")
        ? { output: { fromReceipt: true }, summary: "Completed" }
        : { output: { error: "ambiguous_external_write" }, summary: "unknown", halt: "needs_input" as const }),
    });
    const session = new GatewaySession({ host, view: view([replayable]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    expect(await session.gateway.call("rally_core", "current_time", {})).toEqual({ ok: true, output: { fromReceipt: true } });
    const second = await session.gateway.call("rally_core", "current_time", {});
    expect(second).toMatchObject({ ok: false, code: "ambiguous_external_write", index: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(session.calls.map((call) => call.outcome)).toEqual(["replayed", "ambiguous"]);
  });

  it("refuses by name, before any receipt: unknown plugin, program in program, loop control, turn-scoped, unknown tool, unloaded, outside the allowance", async () => {
    const { host, rows } = await hostOver();
    const code = plugin(CODE_PLUGIN_ID, CODE_PLUGIN_MODEL_ID, [tool({ name: "execute", mode: "write" })]);
    const web = plugin("rally:web", "rally_web", [tool({ name: "search" })]);
    const withImage = plugin("rally:core", "rally_core", [...core.tools, tool({ name: "view_image", yieldsContentParts: true })]);
    const input = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID };
    const open = new GatewaySession({ host, view: view([withImage, code], [web]), context: context(), input, allowedPluginIds: null });
    const narrowed = new GatewaySession({ host, view: view([withImage, web]), context: context(), input, allowedPluginIds: new Set(["rally_core"]) });
    const reasons = await Promise.all([
      open.gateway.call("plugin_nope", "x", {}),
      open.gateway.call("rally_code", "execute", {}),
      open.gateway.call("rally_core", "request_elicitation", {}),
      open.gateway.call("rally_core", "view_image", {}),
      open.gateway.call("rally_core", "nope", {}),
      open.gateway.call("rally_web", "search", {}),
      narrowed.gateway.call("rally_web", "search", {}),
    ]);
    expect(reasons.every((answer) => !answer.ok && answer.code === "code_call_refused")).toBe(true);
    expect([...open.calls, ...narrowed.calls].map((call) => call.refusal)).toEqual([
      "unknown_plugin", "program_in_program", "loop_control", "turn_scoped_result", "unknown_tool", "plugin_not_loaded", "outside_required_plugins",
    ]);
    expect(reasons[2]).toMatchObject({ error: expect.stringContaining("loop control") });
    expect(reasons[5]).toMatchObject({ error: expect.stringContaining("load_plugin") });
    expect(rows()).toEqual([]);
    expect(host.authorize).not.toHaveBeenCalled();
  });

  it("rejects bad arguments with no receipt, and classifies a tool's failure as Bind does", async () => {
    const failing = plugin("rally:core", "rally_core", [
      tool({ name: "current_time" }),
      tool({ name: "bad_response", mode: "write", execute: async () => { throw new z.ZodError([]); } }),
      tool({ name: "coded", execute: async () => { throw Object.assign(new Error("Provider said no"), { code: "provider_refused", details: { reason: "quota" } }); } }),
    ]);
    const { host, rows } = await hostOver();
    const session = new GatewaySession({ host, view: view([failing]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const invalid = await session.gateway.call("rally_core", "current_time", { n: "two" });
    expect(invalid).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("rejected its arguments") });
    expect(rows()).toEqual([]);

    const ambiguous = await session.gateway.call("rally_core", "bad_response", {});
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous_external_write" });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ambiguous", phase: "ambiguous_external_write", toolName: "bad_response", mode: "write" }));

    const coded = await session.gateway.call("rally_core", "coded", {});
    expect(coded).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("Provider said no") });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", phase: "execution", error: expect.objectContaining({ code: "provider_refused" }) }));
    expect(session.calls.map((call) => call.outcome)).toEqual(["failed", "ambiguous", "failed"]);
  });

  it("times a nested call out with its own timer: a read fails, a record-before-execute write is ambiguous", async () => {
    const waitForSignal: HarnessTool["execute"] = (_input, toolContext) => new Promise((_resolve, reject) => {
      toolContext.signal.addEventListener("abort", () => reject(toolContext.signal.reason), { once: true });
    });
    const slow = plugin("rally:core", "rally_core", [
      tool({ name: "slow_read", execute: waitForSignal, definition: { ...tool({ name: "slow_read" }).definition, timeoutMs: 20 } }),
      tool({ name: "slow_write", mode: "write", execute: waitForSignal, definition: { ...tool({ name: "slow_write", mode: "write" }).definition, timeoutMs: 20 } }),
    ]);
    const { host } = await hostOver();
    const session = new GatewaySession({ host, view: view([slow]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    expect(await session.gateway.call("rally_core", "slow_read", {})).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("20 ms") });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.objectContaining({ code: "tool_timeout" }) }));
    expect(await session.gateway.call("rally_core", "slow_write", {})).toMatchObject({ ok: false, code: "ambiguous_external_write" });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ambiguous" }));
  });

  it("stops the program when authorization throws, and keeps that error for the host", async () => {
    const authorityLost = new Error("run_authority_lost");
    const { host, rows } = await hostOver({ authorize: vi.fn(async () => { throw authorityLost; }) });
    const session = new GatewaySession({ host, view: view([core]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const first = await session.gateway.call("rally_core", "current_time", {});
    expect(first).toMatchObject({ ok: false, code: "code_call_refused", error: expect.stringContaining("stopped") });
    expect(session.fatal).toBe(authorityLost);
    const second = await session.gateway.call("rally_core", "current_time", {});
    expect(second).toMatchObject({ ok: false, code: "code_call_refused" });
    expect(session.calls.map((call) => call.refusal)).toEqual(["program_stopped", "program_stopped"]);
    expect(rows()).toEqual([]);
  });

  it("closing waits for a call in flight, aborts it, and refuses every call made after the program returned", async () => {
    let release: (() => void) | undefined;
    const aborted: unknown[] = [];
    const hanging = plugin("rally:core", "rally_core", [tool({
      name: "hang",
      execute: (_input, toolContext) => new Promise((resolve) => {
        toolContext.signal.addEventListener("abort", () => aborted.push(toolContext.signal.reason), { once: true });
        release = () => resolve({ output: { late: true }, summary: "late" });
      }),
    })]);
    const { host } = await hostOver();
    const session = new GatewaySession({ host, view: view([hanging]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const inFlight = session.gateway.call("rally_core", "hang", {});
    await vi.waitFor(() => expect(release).toBeDefined());
    let closed = false;
    const closing = session.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    expect(aborted).toHaveLength(1);
    release!();
    await closing;
    expect(await inFlight).toEqual({ ok: true, output: { late: true } });
    const late = await session.gateway.call("rally_core", "hang", {});
    expect(late).toMatchObject({ ok: false, code: "code_call_refused", error: expect.stringContaining("already returned") });
    expect(session.calls.at(-1)?.refusal).toBe("program_finished");
  });
});

function recorded(overrides: Partial<RecordedCall> & { index: number }): RecordedCall {
  return { tool: "rally_core.current_time", mode: "read", ms: 1, outcome: "completed", ...overrides };
}

describe("finishProgram", () => {
  const fine = { ok: true as const, valueJson: JSON.stringify({ sum: 9 }), logs: [{ level: "log", text: "hi" }] };

  it("returns the value, logs and recorded calls of a program that answered", () => {
    const result = finishProgram({ result: fine, deadlinePassed: false }, [recorded({ index: 0 })], "Add things");
    expect(result).toEqual({
      output: { value: { sum: 9 }, logs: [{ level: "log", text: "hi" }], calls: [{ index: 0, tool: "rally_core.current_time", mode: "read", ms: 1, outcome: "completed" }] },
      summary: "Add things (1 call)",
    });
  });

  it("derives the failure from what the gateway recorded, not from the code the program threw", () => {
    const thrown = (code: string | null, callIndex: number | null) => ({ ok: false as const, error: { code, message: "boom", callIndex }, logs: [] });
    const code = (run: Parameters<typeof finishProgram>[0], calls: RecordedCall[]) => {
      try {
        finishProgram(run, calls, "d");
        return null;
      } catch (error) {
        return error instanceof CodeModeToolError ? error.code : "not_coded";
      }
    };
    expect(code({ result: thrown("code_call_refused", 0), deadlinePassed: false }, [recorded({ index: 0, outcome: "refused", refusal: "loop_control" })])).toBe("code_call_refused");
    expect(code({ result: thrown(null, 0), deadlinePassed: false }, [recorded({ index: 0, outcome: "failed" })])).toBe("code_call_failed");
    expect(code({ result: fine, deadlinePassed: false }, [recorded({ index: 0, mode: "write", outcome: "ambiguous" })])).toBe("ambiguous_external_write");
    // A program that throws an error dressed as a refusal, or claims the deadline early, is a program failure.
    expect(code({ result: thrown("code_call_refused", null), deadlinePassed: false }, [])).toBe("code_program_failed");
    expect(code({ result: thrown("deadline", null), deadlinePassed: false }, [])).toBe("code_program_failed");
    expect(code({ result: thrown("deadline", null), deadlinePassed: true }, [])).toBe("code_program_timed_out");
    // Past the deadline the failure is the deadline whatever the program threw: the runtime's CPU kill is caught like any error.
    expect(code({ result: thrown(null, null), deadlinePassed: true }, [])).toBe("code_program_timed_out");
  });

  it("names the completed writes in every failure, and bounds the result over value and logs", () => {
    const calls = [recorded({ index: 0, tool: "plugin_slack.post", mode: "write" }), recorded({ index: 1, outcome: "failed" })];
    expect(() => finishProgram({ result: { ok: false, error: { code: null, message: "x", callIndex: 1 }, logs: [] }, deadlinePassed: false }, calls, "d"))
      .toThrow("Completed writes: plugin_slack.post at 0.");
    expect(() => finishProgram({ result: fine, deadlinePassed: false }, [], "d", { resultMaxBytes: 10 }))
      .toThrow(expect.objectContaining({ code: "code_result_too_large" }));
    expect(finishProgram({ result: fine, deadlinePassed: false }, [], "d", { resultMaxBytes: 11 }).summary).toBe("d (0 calls)");
  });
});

describe("customToolFailure", () => {
  const code = (error: unknown) => {
    try {
      customToolFailure("day_math", error);
      return null;
    } catch (mapped) {
      return mapped instanceof CodeModeToolError ? { code: mapped.code, message: mapped.message } : "not_coded";
    }
  };

  it("maps every executor code to the run's vocabulary, with the next step in the sentence", () => {
    expect(code(new CodeModeToolError("code_program_failed", "The program threw: x"))).toMatchObject({ code: "custom_tool_failed", message: expect.stringContaining("custom_day_math failed") });
    expect(code(new CodeModeToolError("code_program_timed_out", "slow"))).toMatchObject({ code: "custom_tool_timed_out" });
    expect(code(new CodeModeToolError("code_result_too_large", "big"))).toMatchObject({ code: "custom_tool_result_too_large", message: expect.stringContaining("defect in the tool") });
    expect(code(new CodeModeToolError("code_call_refused", "rally_web is not loaded.", { reason: "plugin_not_loaded" })))
      .toMatchObject({ code: "custom_tool_unavailable", message: expect.stringContaining("Call load_plugin for it, then call custom_day_math again") });
    expect(code(new CodeModeToolError("code_call_refused", "cannot", { reason: "outside_required_plugins" })))
      .toMatchObject({ code: "custom_tool_unavailable", message: expect.stringContaining("defect in the tool") });
    expect(code(new CodeModeToolError("ambiguous_external_write", "unknown"))).toMatchObject({ code: "ambiguous_external_write", message: expect.stringContaining("custom_day_math may have completed a write") });
    expect(() => customToolFailure("day_math", new Error("plain"))).toThrow("plain");
  });
});

describe("the program module", () => {
  it("always wraps the body, and refuses module syntax before the loader sees it", () => {
    expect(wrapProgram("return 1;")).toBe("export default async function run(tools, console, input) {\nreturn 1;\n}");
    expect(wrapProgram("export default async function run() { return 1; }")).toContain("export default async function run(tools, console, input) {\nexport default");
    expect(programSyntaxRefusal("return 1;")).toBeNull();
    expect(programSyntaxRefusal("import x from 'y';\nreturn 1;")).toContain("remove top-level import and export");
    expect(programSyntaxRefusal("const m = await import('cloudflare:workers');")).toContain("import()");
    expect(programSyntaxRefusal("const exported = 1; return 'import ' + exported;")).toBeNull();
  });

  it("parses the isolate's answer with a schema and rejects anything else", () => {
    expect(EntryResultSchema.safeParse({ ok: true, valueJson: "1", logs: [] }).success).toBe(true);
    expect(EntryResultSchema.safeParse({ ok: false, error: { code: null, message: "m", callIndex: 2 }, logs: [{ level: "warn", text: "t" }] }).success).toBe(true);
    expect(EntryResultSchema.safeParse({ ok: true, value: 1 }).success).toBe(false);
    expect(EntryResultSchema.safeParse({ ok: false, error: { message: 1 }, logs: [] }).success).toBe(false);
  });
});
