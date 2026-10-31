/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's saved tool on real workerd: the definition carries a program,
 * publication accepts it, a run receives it as `custom_<name>`, and calling it
 * runs the program with the run's input in scope, its nested calls recorded
 * as child receipts of the tool's own. Also the one refusal only publication
 * can make: a tool on an instruction-only Sidekick.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type AutomationDraft,
} from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub } from "./helpers/hosted-parent";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { runSidekickAlarms, sidekickWorkspace } from "./helpers/sidekick";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000cd10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000cd11");
const SESSION_ID = "00000000-0000-7000-8000-00000000cd12";
const NOW = "2026-10-31T10:00:00.000Z";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 20_000;

let ordinal = 0;
let ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000cd1");
let AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000cd2");

/** The saved tool: one nested read, arithmetic over the run's input, a small return. */
const DAY_MATH = {
  name: "day_math",
  description: "Doubles a day count after reading the current time. Call it with the number of days.",
  inputSchema: {
    type: "object" as const,
    properties: { days: { type: "integer", description: "The number of days to double." } },
    required: ["days"],
    additionalProperties: false as const,
  },
  code: "const now = await tools.rally_core.current_time({});\nreturn { doubled: input.days * 2, readTime: typeof now === 'string' };",
  requiredPlugins: ["rally_core"],
};

const DEFINITION: AutomationDraft = {
  name: "Day doubler",
  description: "Doubles a number of days with its saved tool",
  overview: "Calls custom_day_math and reports the result.",
  instructions: "Call custom_day_math with days = 21 and report the doubled value in one line.",
  triggers: [{ type: "manual" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  customTools: [DAY_MATH],
  suggestedScope: "workstream",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

useSelectedModel();
useHeldEffectQueue();
const provider = useOpenRouterDouble((call) => {
  const latest = call.messages.filter((message) => message.role === "user").at(-1);
  const current = call.messages.slice(call.messages.lastIndexOf(latest!));
  if (current.some((message) => message.role === "tool")) return { say: "Doubled: 42 days." };
  const tool = call.toolNames.find((name) => name === "custom_day_math");
  if (tool) return { callTool: { name: tool, arguments: { days: 21 } } };
  return { say: "No saved tool was offered." };
});

function sidekickHost() {
  return sidekickWorkspace(TEST_ENV, WORKSPACE_ID);
}

function runChild(runId: string) {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID, asSubstreamId(runId)),
  ));
}

function manager() {
  return { userId: AUTHOR_ID, actorRole: "member" as const, participantOfOwningWorkstream: true };
}

function addressed() {
  return { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
}

async function seedRegionalDatabase(): Promise<void> {
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES (?, 'global', ?, NULL, ?, ?, ?)`).bind(`doubler-${ordinal}`, WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

async function seedRoom(): Promise<void> {
  await hostedParentStub(env, WORKSPACE_ID).reserveChild({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: asSubstreamId("0"), kind: "main",
    createdByUserId: AUTHOR_ID, authorityGeneration: 1,
    directory: { title: "Doubling room", description: "", scope: "personal", systemKind: null, emailAddress: null, titleStatus: "settled", createdAt: NOW },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, ROOM_ID, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, title: "Doubling room", objective: "", scope: "personal",
    createdByUserId: AUTHOR_ID, participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled",
    emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
}

async function seedSidekick(definition: AutomationDraft): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workstream", owningWorkstreamId: ROOM_ID, automationId: AUTOMATION_ID,
  });
  expect(created.created).toBe(true);
  await sidekickHost().sidekickSubmitDefinition({ ...addressed(), draft: definition, evaluatorRules: null, submittedByRunId: null });
  const detail = await runInDurableObject(sidekickHost(), (instance: WorkspaceDO) => instance.sidekickApply({ ...addressed(), actor: manager() }));
  expect(detail).toMatchObject({ lifecycle: "active" });
}

interface RunRow extends Record<string, SqlStorageValue> { run_id: string; status: string; error_json: string | null; terminalized_at: number | null }
interface EffectRow extends Record<string, SqlStorageValue> { tool_call_id: string; tool_name: string; status: string; mode: string; output_summary: string | null }

async function settledRun(stub: DurableObjectStub): Promise<RunRow> {
  await runDurableObjectAlarm(stub);
  let rows: RunRow[] = [];
  await expect.poll(async () => {
    rows = await runInDurableObject(stub, (_instance, state) => {
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

beforeEach(async () => {
  ordinal += 1;
  const suffix = String(ordinal).padStart(4, "0");
  ROOM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}0000cd11`);
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${suffix}0000cd12`);
  await reset();
  await seedRegionalDatabase();
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))).initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
}, 30_000);

describe("a Sidekick's saved tools", () => {
  it("offers custom_<name> to a run and executes its program with the input in scope", async () => {
    await seedSidekick(DEFINITION);
    const started = await sidekickHost().sidekickRunNow({ ...addressed(), actor: manager(), idempotencyKey: "custom-tool-run-0001" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    const run = await settledRun(runChild(started.runId));
    expect(run).toMatchObject({ status: "completed", error_json: null });

    const rows = await runInDurableObject(runChild(started.runId), (_instance, state) => state.storage.sql.exec<EffectRow>(
      "SELECT tool_call_id, tool_name, status, mode, output_summary FROM tool_effects ORDER BY tool_position",
    ).toArray());
    const tool = rows.find((row) => row.tool_name === "custom_day_math");
    expect(tool).toMatchObject({ status: "completed", mode: "write", output_summary: `${DAY_MATH.description} (1 call)` });
    const nested = rows.filter((row) => row.tool_call_id.startsWith(`${tool!.tool_call_id}:call:`));
    expect(nested.map((row) => [row.tool_name, row.status])).toEqual([["current_time", "completed"]]);

    const result = provider.calls.flatMap((call) => call.messages.filter((message) => message.role === "tool"))
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .find((message) => message.includes('"doubled"'));
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!) as { data: { value: unknown; calls: Array<{ tool: string }> } };
    expect(parsed.data.value).toEqual({ doubled: 42, readTime: true });
    expect(parsed.data.calls.map((call) => call.tool)).toEqual(["rally_core.current_time"]);
    // The run's prompt carried the saved tools' instruction, and the tool's own description.
    const offered = provider.calls.find((call) => call.toolNames.includes("custom_day_math"));
    expect(String(offered?.messages.find((message) => message.role === "system")?.content ?? "")).toContain("The custom_* tools were written and tested for this Sidekick");
  });

  it("refuses a tool on an instruction-only Sidekick by field", async () => {
    const created = await createAutomation(TEST_ENV, {
      workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workstream", owningWorkstreamId: ROOM_ID, automationId: AUTOMATION_ID,
    });
    expect(created.created).toBe(true);
    const refusal = await runInDurableObject(sidekickHost(), async (instance: WorkspaceDO) => {
      try {
        await instance.sidekickSubmitDefinition({ ...addressed(), draft: { ...DEFINITION, triggers: [] }, evaluatorRules: null, submittedByRunId: null });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(refusal).toContain("submit_definition_invalid");
    expect(refusal).toContain("draft.customTools.0");
  });
});
