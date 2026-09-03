/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The one way a run reaches the room that owns its automation.
 *
 * `automation_post_result` is a tool the run holds, offered only to a run of a
 * room's automation. It asks the room's parent whether the room still stands,
 * then appends the result into the room's main conversation as an activation:
 * loop input the room wakes on, keyed by the run so a retry lands once. The
 * room's parent reporting an archive, or a stale authority generation, refuses
 * it; the refusal is the tool's error.
 *
 * The first test drives the whole path: a real run child of a real
 * `AutomationDO`, the provider double calling the tool, the room's
 * `WorkstreamDO` answering `authority`, the room's conversation object
 * admitting the activation and running on it. The refusals are proved at the
 * narrowest real layer, `appendAutomationActivation` on the room's object,
 * because a room archived between a run's start and its tool call is a race
 * a test cannot stage deterministically through the loop.
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

import type { AutomationDO } from "../src/durable-objects/automation-do";
import {
  automationDOName,
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import {
  deliverChildEffects,
  deliverEffectsToWorkspace,
  deliverParentEffects,
} from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad11");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad12";
const STAGED_RUN_ID = "00000000-0000-7000-8000-00000000ad13";
const NOW = "2026-08-29T10:00:00.000Z";
const RESULT_TEXT = "Three pull requests are open and two of them are waiting on review.";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 15_000;

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: AUTHOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

/** Reassigned per test so a finished test's still-draining objects are not the next test's. */
let ordinal = 0;
let ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ad1");
let AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000ad2");

const DEFINITION: AutomationDraft = {
  name: "Pull request counter",
  description: "Counts open pull requests for the room",
  overview: "Counts open pull requests and posts the number to the room.",
  instructions: "Count the open pull requests and post the number to the work stream that owns this automation.",
  triggers: [{ type: "manual" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "workstream",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

/**
 * A run that holds the tool calls it once with the result and then ends; the
 * room's own loop, which does not hold it, acknowledges what it was woken with.
 */
const provider = useOpenRouterDouble((call) => {
  const tool = call.toolNames.find((name) => name.endsWith("automation_post_result"));
  const toolAnswered = call.messages.some((message) => message.role === "tool");
  if (tool && !toolAnswered) return { callTool: { name: tool, arguments: { text: RESULT_TEXT } } };
  return { say: tool ? "Posted the count." : "Acknowledged." };
});
useSelectedModel();
useHeldEffectQueue();

function automationStub(): DurableObjectStub<AutomationDO> {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

function roomParent() {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(workstreamDOName("global", WORKSPACE_ID, ROOM_ID)));
}

function roomConversation() {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, ROOM_ID),
  ));
}

function runChild(runId: string) {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID, asSubstreamId(runId)),
  ));
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function manager() {
  return { userId: AUTHOR_ID, actorRole: "member" as const, participantOfOwningWorkstream: true };
}

function addressed() {
  return { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
}

function activation(runId: string) {
  return {
    type: "automation_activation" as const,
    schemaVersion: 1 as const,
    automationId: AUTOMATION_ID,
    automationName: DEFINITION.name,
    runId,
    deliveryId: runId,
    trigger: { kind: "manual" as const },
    occurredAt: Date.now(),
  };
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
    // The legacy-shaped Global email registry with this automation's address
    // already reserved, which is what `apply` reads back.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES (?, 'global', ?, NULL, ?, ?, ?)`)
      .bind(`counter-${ordinal}`, WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

/**
 * A personal room with the author in it, made the way creation makes one: the
 * parent reserves the main conversation (and puts the provisional row in the
 * workspace), the regional route is written, the conversation object is
 * opened and told what the room is. No opening message and no loop.
 */
async function seedRoom(): Promise<void> {
  await roomParent().reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: ROOM_ID,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: AUTHOR_ID,
    authorityGeneration: 1,
    directory: {
      title: "Release room",
      description: "Ship the release",
      scope: "personal",
      systemKind: null,
      emailAddress: null,
      titleStatus: "settled",
      createdAt: NOW,
    },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, ROOM_ID, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    workstreamId: ROOM_ID,
    title: "Release room",
    objective: "Ship the release",
    scope: "personal",
    createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
}

/** The room's automation, drafted and applied, its sidebar row in the workspace. */
async function seedRoomAutomation(): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "workstream",
    owningWorkstreamId: ROOM_ID,
    automationId: AUTOMATION_ID,
  });
  expect(created.created).toBe(true);
  await automationStub().submitDefinition({ ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  const detail = await runInDurableObject(automationStub(), (instance: AutomationDO) =>
    instance.apply({ ...addressed(), actor: manager() }));
  expect(detail).toMatchObject({ lifecycle: "active", scope: "workstream", owningWorkstreamId: ROOM_ID });
  await deliverParentEffects(TEST_ENV, automationStub());
}

interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  error_json: string | null;
  terminalized_at: number | null;
}

/** Poll a conversation object until one of its runs has ended. */
async function settledRun(stub: DurableObjectStub, expectedRuns = 1): Promise<RunRow[]> {
  await runDurableObjectAlarm(stub);
  let rows: RunRow[] = [];
  await expect.poll(async () => {
    rows = await runInDurableObject(stub, (_instance, state) => {
      try {
        return state.storage.sql.exec<RunRow>(
          `SELECT run_id, status, error_json, terminalized_at FROM runs ORDER BY created_at, run_id`,
        ).toArray();
      } catch {
        return [];
      }
    });
    const terminal = rows.filter((row) => row.terminalized_at !== null);
    return terminal.length >= expectedRuns ? "terminal" : `runs: ${JSON.stringify(rows)}`;
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 100 }).toBe("terminal");
  return rows;
}

async function activationTurns(): Promise<{ client_message_id: string }[]> {
  return runInDurableObject(roomConversation(), (_instance, state) =>
    state.storage.sql.exec<{ client_message_id: string }>(
      `SELECT client_message_id FROM canonical_conversation_turn_details
        WHERE client_message_id LIKE 'automation-activation:%'`,
    ).toArray());
}

beforeEach(async () => {
  ordinal += 1;
  const suffix = String(ordinal).padStart(4, "0");
  ROOM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}0000ad11`);
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${suffix}0000ad12`);
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
  await seedRoomAutomation();
});

describe("automation_post_result", () => {
  it("posts the run's result into the owning room's main conversation, once, and the room runs on it", async () => {
    const started = await automationStub().runNow({ ...addressed(), actor: manager(), idempotencyKey: "post-result-0001" });

    // The run child: provisioned by the run alarm, ends after the tool round trip.
    await runDurableObjectAlarm(automationStub());
    const [run] = await settledRun(runChild(started.runId));
    expect(run).toMatchObject({ status: "completed", error_json: null });
    const offered = provider.calls.filter((call) => call.toolNames.some((name) => name.endsWith("automation_post_result")));
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered[1]!.messages.some((message) => message.role === "tool")).toBe(true);

    // The room: the activation is its loop input, keyed by the run, and the
    // room's own loop ran on it.
    const [roomRun] = await settledRun(roomConversation());
    expect(roomRun).toMatchObject({ status: "completed", error_json: null });
    expect(await activationTurns()).toEqual([{ client_message_id: `automation-activation:${started.runId}` }]);
    const acknowledged = provider.calls.filter((call) => !call.toolNames.some((name) => name.endsWith("automation_post_result")));
    expect(acknowledged.length).toBeGreaterThanOrEqual(1);
    // What the room's model was asked carries the posted result, labelled as
    // an automation's untrusted output, and nothing about the tool.
    const roomAsked = acknowledged.find((call) => JSON.stringify(call.messages).includes(RESULT_TEXT));
    expect(roomAsked).toBeDefined();
    expect(roomAsked!.messages.map((message) => message.role)).toEqual(["system", "user"]);

    // A retry of the same delivery is a replay, not a second wake.
    const replay = await roomConversation().appendAutomationActivation({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      authorityGeneration: 1,
      deliveryId: started.runId,
      text: RESULT_TEXT,
      executionPrincipal: { type: "user", userId: AUTHOR_ID },
      activation: activation(started.runId),
    });
    expect(replay).toEqual({ outcome: "replayed", code: "automation_activation_replayed" });
    expect(await activationTurns()).toHaveLength(1);
  });

  it("refuses the activation once the owning room is archived, and the archive pauses the automation", async () => {
    // Archived through the room's own surface; the archive reaches the room's
    // parent on the first queue leg and the workspace on the second, which
    // tells the automation its room is gone.
    const archived = await post(roomConversation(), "/internal/product", {
      operation: "update",
      auth: AUTH,
      input: { archived: true },
    });
    expect(archived.status).toBe(200);
    await deliverEffectsToWorkspace(TEST_ENV, roomConversation());

    expect(await roomParent().authority({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
    const refused = await roomConversation().appendAutomationActivation({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      authorityGeneration: 1,
      deliveryId: STAGED_RUN_ID,
      text: RESULT_TEXT,
      executionPrincipal: { type: "user", userId: AUTHOR_ID },
      activation: activation(STAGED_RUN_ID),
    });
    expect(refused).toEqual({ outcome: "refused", code: "workstream_archived" });
    expect(await activationTurns()).toEqual([]);
    const pending = await runInDurableObject(roomConversation(), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM pending_loop_inputs`).one().count);
    expect(pending).toBe(0);

    const automation = await runInDurableObject(automationStub(), (_instance, state) =>
      state.storage.sql.exec<{ lifecycle: string; paused_by: string | null; owning_room_archived_at: number | null }>(
        `SELECT lifecycle, paused_by, owning_room_archived_at FROM automation WHERE id = 1`,
      ).one());
    expect(automation).toMatchObject({ lifecycle: "paused", paused_by: "room_archive" });
    expect(automation.owning_room_archived_at).not.toBeNull();
    expect(await automationStub().authority({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
  });

  it("refuses a stale authority generation and appends under the current one", async () => {
    const stale = await roomConversation().appendAutomationActivation({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      authorityGeneration: 2,
      deliveryId: STAGED_RUN_ID,
      text: RESULT_TEXT,
      executionPrincipal: { type: "user", userId: AUTHOR_ID },
      activation: activation(STAGED_RUN_ID),
    });
    expect(stale).toEqual({ outcome: "refused", code: "workstream_authority_generation_stale" });
    expect(await activationTurns()).toEqual([]);

    const appended = await roomConversation().appendAutomationActivation({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      authorityGeneration: 1,
      deliveryId: STAGED_RUN_ID,
      text: RESULT_TEXT,
      executionPrincipal: { type: "user", userId: AUTHOR_ID },
      activation: activation(STAGED_RUN_ID),
    });
    expect(appended).toEqual({ outcome: "appended", code: "automation_activation_appended" });
    // The wake is real: the room runs on it before this test lets go of it.
    const [roomRun] = await settledRun(roomConversation());
    expect(roomRun).toMatchObject({ status: "completed", error_json: null });
    expect(await activationTurns()).toEqual([{ client_message_id: `automation-activation:${STAGED_RUN_ID}` }]);
    await deliverChildEffects(TEST_ENV, roomConversation());
  });
});
