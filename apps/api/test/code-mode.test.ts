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
import { AmbiguousExternalWriteError, type HarnessPlugin, type HarnessRuntimeView, type HarnessTool, type HarnessToolContext, type HarnessToolResult } from "@rally/agent-harness";

import {
  CODE_PLUGIN_ID,
  CODE_PLUGIN_MODEL_ID,
  CUSTOM_TOOLS_PLUGIN_ID,
  CUSTOM_TOOLS_PLUGIN_MODEL_ID,
  CodeModeToolError,
  EntryResultSchema,
  GatewaySession,
  callableTools,
  checkProgram,
  customToolFailure,
  finishProgram,
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
    started: vi.fn(),
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
    const testTool = tool({ name: "tool_test", mode: "write" });
    testTool.definition = { ...testTool.definition, capability: "rally.sidekick.tools.test" };
    const sidekicks = plugin("rally:sidekicks", "rally_sidekicks", [tool({ name: "plugins_list" }), testTool]);
    const code = plugin(CODE_PLUGIN_ID, CODE_PLUGIN_MODEL_ID, [tool({ name: "execute", mode: "write" })]);
    const custom = plugin(CUSTOM_TOOLS_PLUGIN_ID, CUSTOM_TOOLS_PLUGIN_MODEL_ID, [tool({ name: "day_math", mode: "write" })]);
    const search = tool({ name: "search_messages" });
    search.definition = { ...search.definition, capability: "slack.search" };
    const slack = plugin("connector:slack", "plugin_slack", [tool({ name: "post_message", mode: "write" }), search]);
    const all = callableTools(view([core, terminal, code, custom, sidekicks, slack]), null);
    expect(all.map((entry) => [entry.plugin.modelId, entry.tools.map((candidate) => candidate.definition.name)])).toEqual([
      ["rally_core", ["current_time"]],
      ["rally_terminal", ["run_command"]],
      ["rally_sidekicks", ["plugins_list"]],
      ["plugin_slack", ["post_message"]],
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
    expect(host.started).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "program-call:call:0", pluginId: "rally:core", input: { n: 2 } }));
    expect(host.complete).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "program-call:call:0", pluginId: "rally:core", policy: expect.objectContaining({ canonicalToolName: "current_time" }) }));
    expect(session.calls.map((call) => [call.index, call.tool, call.outcome])).toEqual([[0, "rally_core.current_time", "completed"]]);
  });

  it("replays a completed child the host already holds, and halts the program on an ambiguous one, without executing", async () => {
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
    // The program cannot catch the error and write again: every later call is refused.
    const third = await session.gateway.call("rally_core", "current_time", {});
    expect(third).toMatchObject({ ok: false, code: "code_call_refused", error: expect.stringContaining("unknown outcome") });
    expect(session.halted).toMatchObject({ code: "ambiguous_external_write" });
    expect(execute).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(session.calls.map((call) => call.outcome)).toEqual(["replayed", "ambiguous", "refused"]);
    expect(session.calls[2]!.refusal).toBe("program_stopped");
  });

  it("refuses by name, before any receipt: unknown plugin, program in program, loop control, turn-scoped, transient, unknown tool, unloaded, outside the allowance", async () => {
    const { host, rows } = await hostOver();
    const code = plugin(CODE_PLUGIN_ID, CODE_PLUGIN_MODEL_ID, [tool({ name: "execute", mode: "write" })]);
    const web = plugin("rally:web", "rally_web", [tool({ name: "search" })]);
    const slackSearch = tool({ name: "search_messages" });
    slackSearch.definition = { ...slackSearch.definition, capability: "slack.search" };
    const withImage = plugin("rally:core", "rally_core", [...core.tools, tool({ name: "view_image", yieldsContentParts: true }), slackSearch]);
    const input = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID };
    const open = new GatewaySession({ host, view: view([withImage, code], [web]), context: context(), input, allowedPluginIds: null });
    const narrowed = new GatewaySession({ host, view: view([withImage, web]), context: context(), input, allowedPluginIds: new Set(["rally_core"]) });
    const reasons = await Promise.all([
      open.gateway.call("plugin_nope", "x", {}),
      open.gateway.call("rally_code", "execute", {}),
      open.gateway.call("rally_core", "request_elicitation", {}),
      open.gateway.call("rally_core", "view_image", {}),
      open.gateway.call("rally_core", "search_messages", {}),
      open.gateway.call("rally_core", "nope", {}),
      open.gateway.call("rally_web", "search", {}),
      narrowed.gateway.call("rally_web", "search", {}),
    ]);
    expect(reasons.every((answer) => !answer.ok && answer.code === "code_call_refused")).toBe(true);
    expect([...open.calls, ...narrowed.calls].map((call) => call.refusal)).toEqual([
      "unknown_plugin", "program_in_program", "loop_control", "turn_scoped_result", "transient_result", "unknown_tool", "plugin_not_loaded", "outside_required_plugins",
    ]);
    expect(reasons[2]).toMatchObject({ error: expect.stringContaining("loop control") });
    expect(reasons[4]).toMatchObject({ error: expect.stringContaining("may not be stored") });
    expect(reasons[6]).toMatchObject({ error: expect.stringContaining("load_plugin") });
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

    const coded = await session.gateway.call("rally_core", "coded", {});
    expect(coded).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("Provider said no") });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", phase: "execution", error: expect.objectContaining({ code: "provider_refused" }) }));

    // A validation error downstream of valid arguments on a record-before-execute write is ambiguous, and halts the program.
    const ambiguous = await session.gateway.call("rally_core", "bad_response", {});
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous_external_write" });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ambiguous", phase: "ambiguous_external_write", toolName: "bad_response", mode: "write" }));
    expect(session.halted).not.toBeNull();
    expect(session.calls.map((call) => call.outcome)).toEqual(["failed", "failed", "ambiguous"]);
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
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", outcome: "timed_out", toolCallId: "program-call:call:0", error: expect.objectContaining({ code: "tool_timeout" }) }));
    expect(await session.gateway.call("rally_core", "slow_write", {})).toMatchObject({ ok: false, code: "ambiguous_external_write" });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ambiguous" }));
  });

  it("clamps a nested call's timer to what is left of the program's budget, so no call outlives the program", async () => {
    const waitForSignal: HarnessTool["execute"] = (_input, toolContext) => new Promise((_resolve, reject) => {
      toolContext.signal.addEventListener("abort", () => reject(toolContext.signal.reason), { once: true });
    });
    const long = plugin("rally:core", "rally_core", [
      tool({ name: "long_read", execute: waitForSignal, definition: { ...tool({ name: "long_read" }).definition, timeoutMs: 300_000 } }),
    ]);
    const { host } = await hostOver();
    const session = new GatewaySession({ host, view: view([long]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null, deadlineAt: Date.now() + 30 });
    const started = Date.now();
    expect(await session.gateway.call("rally_core", "long_read", {})).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringMatching(/exceeded its \d{1,2} ms limit/) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "timed_out", error: expect.objectContaining({ code: "tool_timeout" }) }));
  });

  it("names the rejected field when a tool fails validating data after valid arguments", async () => {
    const issues = [{ code: "invalid_type" as const, expected: "number" as const, received: "string" as const, path: ["rows", 0, "n"], message: "Expected number" }];
    const strict = plugin("rally:core", "rally_core", [
      tool({ name: "read_rows", execute: async () => { throw new z.ZodError(issues as never); } }),
      tool({ name: "write_rows", mode: "write", execute: async () => { throw new z.ZodError(issues as never); } }),
    ]);
    const { host } = await hostOver();
    const session = new GatewaySession({ host, view: view([strict]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const read = await session.gateway.call("rally_core", "read_rows", {});
    expect(read).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("rows.0.n") });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.objectContaining({ code: expect.stringMatching(/^tool_response_invalid:.*rows/) }) }));
    const write = await session.gateway.call("rally_core", "write_rows", {});
    expect(write).toMatchObject({ ok: false, code: "ambiguous_external_write" });
    expect(host.fail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ambiguous", error: expect.objectContaining({ code: "ambiguous_external_write", message: expect.stringContaining("rows.0.n") }) }));
  });

  it("ends a tool that ignores its signal at the per-call timer, so the session can close", async () => {
    const deaf = plugin("rally:core", "rally_core", [tool({ name: "deaf", execute: () => new Promise(() => undefined), definition: { ...tool({ name: "deaf" }).definition, timeoutMs: 20 } })]);
    const { host } = await hostOver();
    const session = new GatewaySession({ host, view: view([deaf]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const started = Date.now();
    expect(await session.gateway.call("rally_core", "deaf", {})).toMatchObject({ ok: false, code: "code_call_failed", error: expect.stringContaining("20 ms") });
    await session.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("runs writes side by side, each with its own receipt", async () => {
    let inFlight = 0;
    let most = 0;
    let releaseWrites: (() => void) | undefined;
    const writesHeld = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const held: HarnessTool["execute"] = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (inFlight === 2) releaseWrites?.();
      await writesHeld;
      inFlight -= 1;
      return { output: {}, summary: "written" };
    };
    const writes = plugin("rally:core", "rally_core", [
      tool({ name: "first", mode: "write", execute: held, definition: { ...tool({ name: "first", mode: "write" }).definition, timeoutMs: 2_000 } }),
      tool({ name: "second", mode: "write", execute: held, definition: { ...tool({ name: "second", mode: "write" }).definition, timeoutMs: 2_000 } }),
    ]);
    const { host, rows } = await hostOver();
    const session = new GatewaySession({ host, view: view([writes]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const answers = await Promise.all([session.gateway.call("rally_core", "first", {}), session.gateway.call("rally_core", "second", {})]);
    expect(answers).toEqual([{ ok: true, output: {} }, { ok: true, output: {} }]);
    expect(most).toBe(2);
    expect(rows().map((row) => row.tool_call_id)).toEqual(["program-call:call:0", "program-call:call:1"]);
  });

  it("claims no write after another call stopped the program, though both were started together", async () => {
    // The second write is authorized and looked up while the first's
    // authorization is still out; the first then stops the program, and the
    // second, reaching its claim afterwards, is refused with no receipt.
    let failFirst: (() => void) | undefined;
    const firstOut = new Promise<void>((resolve) => { failFirst = resolve; });
    let secondLookedUp: (() => void) | undefined;
    const secondIn = new Promise<void>((resolve) => { secondLookedUp = resolve; });
    let releaseLookup: (() => void) | undefined;
    const lookupHeld = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const executed: string[] = [];
    const { host, rows } = await hostOver({
      authorize: vi.fn(async ({ toolName }) => {
        if (toolName === "first") { await firstOut; throw new Error("run_authority_lost"); }
        return { allowed: true as const };
      }),
      findCompletedToolResult: vi.fn(async () => { secondLookedUp?.(); await lookupHeld; return null; }),
    });
    const writes = plugin("rally:core", "rally_core", [
      tool({ name: "first", mode: "write", execute: async () => { executed.push("first"); return { output: {}, summary: "first" }; } }),
      tool({ name: "second", mode: "write", execute: async () => { executed.push("second"); return { output: {}, summary: "second" }; } }),
    ]);
    const session = new GatewaySession({ host, view: view([writes]), context: context(), input: { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId: RUN_ID }, allowedPluginIds: null });
    const first = session.gateway.call("rally_core", "first", {});
    const second = session.gateway.call("rally_core", "second", {});
    await secondIn;
    failFirst?.();
    expect(await first).toMatchObject({ ok: false, code: "code_call_refused" });
    releaseLookup?.();
    expect(await second).toMatchObject({ ok: false, code: "code_call_refused", error: expect.stringContaining("stopped") });
    expect(session.calls.map((call) => call.refusal)).toEqual(["program_stopped", "program_stopped"]);
    expect(executed).toEqual([]);
    expect(rows()).toEqual([]);
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

  it("closing waits for a call in flight without aborting it, and refuses every call made after the program returned", async () => {
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
    expect(aborted).toEqual([]);
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
        return error instanceof CodeModeToolError ? error.code : error instanceof AmbiguousExternalWriteError ? "bind_halt" : "not_coded";
      }
    };
    expect(code({ result: thrown("code_call_refused", 0), deadlinePassed: false }, [recorded({ index: 0, outcome: "refused", refusal: "loop_control" })])).toBe("code_call_refused");
    expect(code({ result: thrown(null, 0), deadlinePassed: false }, [recorded({ index: 0, outcome: "failed" })])).toBe("code_call_failed");
    // An ambiguous nested write is Bind's own halt, not a program failure: the loop stops as after a direct write.
    expect(code({ result: fine, deadlinePassed: false }, [recorded({ index: 0, mode: "write", outcome: "ambiguous" })])).toBe("bind_halt");
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
    // Bind's halt is not the tool's failure to explain; it passes through untouched.
    const halt = new AmbiguousExternalWriteError("call", "unknown");
    expect(() => customToolFailure("day_math", halt)).toThrow(halt);
    expect(() => customToolFailure("day_math", new Error("plain"))).toThrow("plain");
  });
});

describe("the program module", () => {
  it("always wraps the body, whatever shape the model wrote", () => {
    expect(wrapProgram("return 1;")).toBe("export default async function run(tools, console, input) {\nreturn 1;\n}");
    expect(wrapProgram("export default async function run() { return 1; }")).toContain("export default async function run(tools, console, input) {\nexport default");
  });

  it("parses the isolate's answer with a schema and rejects anything else", () => {
    expect(EntryResultSchema.safeParse({ ok: true, valueJson: "1", logs: [] }).success).toBe(true);
    expect(EntryResultSchema.safeParse({ ok: false, error: { code: null, message: "m", callIndex: 2 }, logs: [{ level: "warn", text: "t" }] }).success).toBe(true);
    expect(EntryResultSchema.safeParse({ ok: true, value: 1 }).success).toBe(false);
    expect(EntryResultSchema.safeParse({ ok: false, error: { message: 1 }, logs: [] }).success).toBe(false);
  });
});

describe("checkProgram", () => {
  const writeTools = new Set(["rally_tables.insert_rows", "plugin_slack.send_message"]);
  const check = (code: string) => checkProgram(code, { writeTools }).map((found) => [found.code, found.line, found.message]);

  it("passes awaited writes in sequence, writes in try/catch, a write kept in a variable, reads in any shape, and a program with no writes", () => {
    expect(check([
      "const [a, b] = await Promise.all([tools.rally_tables.query({}), tools.rally_tables.query({ n: 1 })]);",
      "let rows; try { rows = await tools.rally_tables.query({}); } catch (e) { rows = []; }",
      "for (const row of rows) { await tools.rally_tables.insert_rows({ rows: [row] }); }",
      "try { await tools.rally_tables.insert_rows({ rows }); } catch (e) { return { failed: e.message }; }",
      "const pending = tools.plugin_slack.send_message({ text: 'later' });",
      "await pending;",
      "const ids = rows.map((row) => row.id);",
      "return tools.plugin_slack.send_message({ text: ids.join(',') });",
    ].join("\n"))).toEqual([]);
    expect(check("return Date.now() + Math.random();")).toEqual([]);
  });

  it("names the body's own line of a program that does not parse", () => {
    const issues = checkProgram("const a = 1;\nconst b = ;", { writeTools });
    expect(issues).toEqual([{ code: "syntax_error", line: 2, column: 11, message: "Line 2, column 11: Unexpected token." }]);
  });

  it("refuses a write whose promise is dropped, bare or in a forEach callback, once per call site, and passes writes side by side", () => {
    expect(check("tools.rally_tables.insert_rows({});\nreturn 1;")).toEqual([
      ["write_not_awaited", 1, expect.stringContaining("Line 1: rally_tables.insert_rows is a write that is not awaited where it is called.")],
    ]);
    expect(check("rows.forEach((row) => tools.rally_tables.insert_rows({ rows: [row] }));")).toEqual([
      ["write_in_callback", 1, expect.stringContaining("inside a forEach() callback, which drops its promise")],
    ]);
    expect(check("rows.filter(async (row) => {\n  await tools.rally_tables.insert_rows({ rows: [row] });\n});")).toEqual([
      ["write_in_callback", 2, expect.stringContaining("inside a filter() callback")],
    ]);
    expect(check([
      "await Promise.all([tools.rally_tables.query({}), tools.plugin_slack.send_message({})]);",
      "await Promise.all(rows.map(async (row) => {\n  await tools.rally_tables.insert_rows({ rows: [row] });\n}));",
      "const settled = await Promise.allSettled(rows.map((row) => tools.rally_tables.insert_rows({ rows: [row] })));",
    ].join("\n"))).toEqual([]);
  });

  it("refuses the clock and random numbers only in a program that writes, and follows no alias or computed name", () => {
    expect(check("const at = Date.now();\nconst id = Math.random();\nconst when = new Date();\nconst parsed = new Date('2026-01-01');\nawait tools.rally_tables.insert_rows({ at, id, when, parsed });")).toEqual([
      ["write_with_clock_or_random", 1, expect.stringContaining("Date.now() in a program that writes")],
      ["write_with_clock_or_random", 2, expect.stringContaining("Math.random() in a program that writes")],
      ["write_with_clock_or_random", 3, expect.stringContaining("new Date() in a program that writes")],
    ]);
    expect(check("const t = tools.rally_tables;\nt.insert_rows({});\nreturn tools['rally_tables'].insert_rows({});")).toEqual([]);
  });
});
