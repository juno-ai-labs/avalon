/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * `code_execute` on real workerd: a run loads `rally_code`, the model writes a
 * program that calls two tools and does arithmetic, the program runs in a
 * Dynamic Worker, each nested call lands as its own `tool_effects` row beside
 * the program's, and the model reads back only the program's return value.
 *
 * The double stands in for the provider only; the loader, the gateway, the
 * receipts and the run are the real ones.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { GatewaySession, finishProgram, runProgram } from "../src/services/code-mode";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub } from "./helpers/hosted-parent";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000c0d0");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000c0d1");
const SESSION_ID = "00000000-0000-7000-8000-00000000c0d2";
const NOW = "2026-10-31T10:00:00.000Z";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 20_000;

const AUTH: AuthContext = { sessionId: SESSION_ID, userId: AUTHOR_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member" };

let ordinal = 0;
let ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000c0d");

/** Two reads, arithmetic, a log line, and a small return: the shape the prompt teaches. */
const PROGRAM = `
const first = await tools.rally_core.current_time({});
const second = await tools.rally_core.current_time({});
const sum = [2, 3, 4].reduce((total, n) => total + n, 0);
console.log("read twice", typeof first);
return { sum, sameShape: typeof first === typeof second, rate: Math.round((7 / 9) * 1000) / 1000 };
`;

/** A program that reaches for a loop control: refused by the gateway, not by prose. */
const REFUSED_PROGRAM = `
return await tools.rally_core.request_elicitation({ prompt: "Which one?", options: ["a", "b"] });
`;

/** A tool name the plugin does not have reaches the gateway through the proxy and is refused by name. */
const UNKNOWN_TOOL_PROGRAM = `
return await tools.rally_core.nope({});
`;

/** The isolate has no network: the loader blocks the call, and the program fails as a program. */
const EGRESS_PROGRAM = `
const response = await fetch("https://example.com/");
return response.status;
`;

/** A program that forgets to return: it fails as a program, with the isolate's own message. */
const SYNTAX_PROGRAM = `
return (;
`;

useSelectedModel();
useHeldEffectQueue();
const provider = useOpenRouterDouble((call) => {
  const latest = call.messages.filter((message) => message.role === "user").at(-1);
  const prompt = JSON.stringify(latest?.content ?? "");
  const current = call.messages.slice(call.messages.lastIndexOf(latest!));
  const toolResults = current.filter((message) => message.role === "tool")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  // The program's own result, success or failure, ends the turn. The load_plugin
  // result also names code_execute, so match the program's envelope, not the word.
  if (toolResults.some((result) => result.includes('"calls"') || result.includes('"success":false'))) return { say: "Done." };
  const execute = call.toolNames.find((name) => name === "code_execute");
  if (execute) {
    const code = prompt.includes("REFUSED") ? REFUSED_PROGRAM
      : prompt.includes("UNKNOWN") ? UNKNOWN_TOOL_PROGRAM
        : prompt.includes("EGRESS") ? EGRESS_PROGRAM
          : prompt.includes("SYNTAX") ? SYNTAX_PROGRAM
            : PROGRAM;
    return { callTool: { name: execute, arguments: { code, description: "Read the time twice and add some numbers" } } };
  }
  const load = call.toolNames.find((name) => name.endsWith("load_plugin"));
  if (!load) throw new Error("load_plugin_missing");
  return { callTool: { name: load, arguments: { pluginId: "rally_code" } } };
});

function roomConversation() {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, ROOM_ID)));
}

async function seedRoom(): Promise<void> {
  await hostedParentStub(env, WORKSPACE_ID).reserveChild({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: asSubstreamId("0"), kind: "main",
    createdByUserId: AUTHOR_ID, authorityGeneration: 1,
    directory: { title: "Numbers", description: "", scope: "personal", systemKind: null, emailAddress: null, titleStatus: "settled", createdAt: NOW },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, ROOM_ID, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, title: "Numbers", objective: "", scope: "personal",
    createdByUserId: AUTHOR_ID, participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled",
    emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
}

interface RunRow extends Record<string, SqlStorageValue> { run_id: string; status: string; error_json: string | null; terminalized_at: number | null }
interface EffectRow extends Record<string, SqlStorageValue> { tool_call_id: string; tool_name: string; status: string; mode: string; output_summary: string | null }

async function settledRun(): Promise<RunRow> {
  await runDurableObjectAlarm(roomConversation());
  let rows: RunRow[] = [];
  await expect.poll(async () => {
    rows = await runInDurableObject(roomConversation(), (_instance, state) => {
      try {
        return state.storage.sql.exec<RunRow>("SELECT run_id, status, error_json, terminalized_at FROM runs ORDER BY created_at").toArray();
      } catch {
        return [];
      }
    });
    return rows.some((row) => row.terminalized_at !== null) ? "terminal" : `runs: ${JSON.stringify(rows)}`;
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 100 }).toBe("terminal");
  return rows[0]!;
}

async function effects(): Promise<EffectRow[]> {
  return runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<EffectRow>(
    "SELECT tool_call_id, tool_name, status, mode, output_summary FROM tool_effects ORDER BY tool_position",
  ).toArray());
}

function toolMessages(): string[] {
  return provider.calls.flatMap((call) => call.messages
    .filter((message) => message.role === "tool")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

beforeEach(async () => {
  ordinal += 1;
  ROOM_ID = asWorkstreamId(`00000000-0000-7000-8000-${String(ordinal).padStart(4, "0")}0000c0d1`);
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))).initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
}, 30_000);

describe("code_execute on workerd", () => {
  it("runs a program whose nested calls are receipts of their own and returns only its value", async () => {
    const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
      input: { text: "CODE_MODE_SUM please", clientMessageId: crypto.randomUUID(), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
    expect(response.status).toBe(200);
    const run = await settledRun();
    expect(run).toMatchObject({ status: "completed", error_json: null });

    const rows = await effects();
    const program = rows.find((row) => row.tool_name === "code_execute");
    expect(program).toMatchObject({ status: "completed", mode: "write", output_summary: "Read the time twice and add some numbers (2 calls)" });
    const nested = rows.filter((row) => row.tool_call_id.startsWith(`${program!.tool_call_id}:call:`));
    expect(nested.map((row) => [row.tool_call_id.slice(program!.tool_call_id.length), row.tool_name, row.status, row.mode])).toEqual([
      [":call:0", "current_time", "completed", "read"],
      [":call:1", "current_time", "completed", "read"],
    ]);

    const result = toolMessages().find((message) => message.includes('"value"'));
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!) as { data: { value: unknown; logs: unknown; calls: Array<Record<string, unknown>> } };
    expect(parsed.data.value).toEqual({ sum: 9, sameShape: true, rate: 0.778 });
    expect(parsed.data.logs).toEqual([{ level: "log", text: "read twice string" }]);
    expect(parsed.data.calls.map((call) => [call.index, call.tool, call.mode, call.outcome])).toEqual([
      [0, "rally_core.current_time", "read", "completed"],
      [1, "rally_core.current_time", "read", "completed"],
    ]);
    // The provider saw the typed API while the plugin was active, and never a raw tool result.
    const systemPrompts = provider.calls.map((call) => String(call.messages.find((message) => message.role === "system")?.content ?? ""));
    expect(systemPrompts.some((prompt) => prompt.includes("# Code API") && prompt.includes("current_time(input:"))).toBe(true);
    expect(systemPrompts.some((prompt) => prompt.includes("Comments below are copied from each tool's definition"))).toBe(true);
    expect(toolMessages().some((message) => message.includes("iso8601"))).toBe(false);
  });

  async function failedProgram(keyword: string): Promise<{ code: string | undefined; error: string }> {
    const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
      input: { text: `CODE_MODE_SUM ${keyword}`, clientMessageId: crypto.randomUUID(), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
    expect(response.status).toBe(200);
    expect(await settledRun()).toMatchObject({ status: "completed" });
    const failure = toolMessages().find((message) => message.includes('"success":false'));
    expect(failure).toBeDefined();
    const parsed = JSON.parse(failure!) as { success: boolean; error: string; data?: { code: string } };
    expect(parsed.success).toBe(false);
    const rows = await effects();
    expect(rows.find((row) => row.tool_name === "code_execute")?.status).toBe("failed");
    expect(rows.filter((row) => row.tool_call_id.includes(":call:"))).toEqual([]);
    return { code: parsed.data?.code, error: parsed.error };
  }

  it("refuses a loop control from inside a program by name, as a refusal", async () => {
    const failure = await failedProgram("REFUSED");
    expect(failure.code).toBe("code_call_refused");
    expect(failure.error).toContain("request_elicitation cannot be called from a program: it is a loop control");
  });

  it("refuses a tool name the plugin does not have, reached through the proxy", async () => {
    const failure = await failedProgram("UNKNOWN");
    expect(failure.code).toBe("code_call_refused");
    expect(failure.error).toContain("rally_core has no tool named nope");
  });

  it("has no network: fetch from a program fails the program", async () => {
    const failure = await failedProgram("EGRESS");
    expect(failure.code).toBe("code_program_failed");
    expect(failure.error).toContain("The program threw");
  });

  it("reports a program that does not compile as the program's failure, with the compiler's message", async () => {
    const failure = await failedProgram("SYNTAX");
    expect(failure.code).toBe("code_program_failed");
    expect(failure.error).toContain("could not be loaded or run");
  });
});

describe("runProgram on workerd", () => {
  const stubSession = () => new GatewaySession({
    host: {} as never,
    view: { isActive: () => false, activePlugins: () => [], plugins: () => [] },
    context: { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: "run", toolCallId: "call", executionPrincipal: { type: "user", userId: AUTHOR_ID }, signal: new AbortController().signal },
    input: { workspaceId: WORKSPACE_ID, parentId: ROOM_ID, harnessRunId: "run" },
    allowedPluginIds: null,
  });

  it("ends a program that never answers at its deadline, from the isolate's own timer", async () => {
    const session = stubSession();
    const run = await runProgram({
      loader: env.CODE_LOADER!, code: "await new Promise(() => {}); return 1;", gateway: session.gateway, api: {},
      programInput: undefined, signal: new AbortController().signal, deadlineMs: 200,
    });
    expect(run).toMatchObject({ deadlinePassed: true, result: { ok: false, error: { code: "deadline" } } });
    expect(() => finishProgram(run, session.calls, "d", { deadlineMs: 200 })).toThrow(expect.objectContaining({ code: "code_program_timed_out" }));
  });

  it("gives the program its input, its console and plain JavaScript, and no isolate state from an earlier program", async () => {
    const first = await runProgram({
      loader: env.CODE_LOADER!, code: "globalThis.leak = 'yes'; console.warn('w', { a: 1 }); return { twice: input.n * 2, big: (2n ** 64n).toString() };",
      gateway: stubSession().gateway, api: {}, programInput: { n: 21 }, signal: new AbortController().signal,
    });
    expect(first.result).toEqual({ ok: true, valueJson: JSON.stringify({ twice: 42, big: "18446744073709551616" }), logs: [{ level: "warn", text: 'w {"a":1}' }] });
    const second = await runProgram({
      loader: env.CODE_LOADER!, code: "return typeof globalThis.leak;", gateway: stubSession().gateway, api: {}, programInput: undefined, signal: new AbortController().signal,
    });
    expect(second.result).toMatchObject({ ok: true, valueJson: '"undefined"' });
  });
});
