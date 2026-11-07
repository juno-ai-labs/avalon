import { AgentCommunicationService } from "../src/services/agent-communication-service";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * How a run reaches the room that owns its automation, and the agent
 * communication paths that share its fixtures.
 *
 * `conversation_post` is the run's tool for it. The Sidekick's home is the
 * owning room's Main conversation here; the post is keyed on the run's
 * harness run and receipt, so a retry lands once, and it is a message from the
 * Sidekick that does not wake the room's agent. The first post test drives the
 * whole path: a real run child of a real hosted Sidekick, the provider double
 * calling the tool, WorkspaceDO resolving the home and admitting the run-as
 * person, the room's conversation object appending the post.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentIdForAddress,
  agentAddressForId,
  WorkstreamWorkflowInputSchema,
  type WorkstreamWorkflowInput,
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type AutomationDraft,
  type SubstreamId,
} from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  conversationObjectName,
  workspaceDOName,
} from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { SlackAgentService } from "../src/services/slack-agent-service";
import { createAutomation } from "../src/services/automation-service";
import { encryptString } from "../src/lib/crypto";
import { attachWorkstreamRuntimeResource } from "../src/services/workstream-object-client";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  bootstrapConversationChildRuntime,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import {
  deliverChildEffects,
  deliverEffectsToWorkspace,
} from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";
import { useOpenRouterDouble, type ProviderCall, type ProviderReply } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { runSidekickAlarms, sidekickWorkspace } from "./helpers/sidekick";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad11");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad12";
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
  customTools: [],
  suggestedScope: "workspace",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

/**
 * A run that holds the tool calls it once with the result and then ends; the
 * room's own loop, which does not hold it, acknowledges what it was woken with.
 */
const LARGE_RESULT_TEXT = "Detailed finding. ".repeat(7_000).trim();
let heldBackgroundModel: Promise<void> | null = null;
/** Set by a test: a run asks its wizard for this change, and the wizard answers on the reply route. */
let sidekickChangeRequest: string | null = null;
const WIZARD_ANSWER = "WIZARD_ANSWER: the weekly totals row is saved.";
function explicitReply(call: ProviderCall, text: string): ProviderReply {
  const latestInput = call.messages.filter((message) => message.role === "user").at(-1);
  const current = call.messages.slice(call.messages.lastIndexOf(latestInput!));
  if (current.some((message) => message.role === "tool"
    && /"data"\s*:\s*\{\s*"messageId"\s*:/u.test(String(message.content)))) {
    return { say: "My local work is complete." };
  }
  const reply = call.toolNames.find((name) => name.endsWith("reply_to_message"));
  if (reply) {
    const messageId = /Message ID: ([0-9a-f-]{36})/u.exec(String(latestInput?.content))?.[1];
    if (!messageId) throw new Error("test_reply_reference_missing");
    return { callTool: { name: reply, arguments: { messageId, message: text } } };
  }
  const load = call.toolNames.find((name) => name.endsWith("load_plugin"));
  if (!load) throw new Error("agent_plugin_loader_missing");
  return { callTool: { name: load, arguments: { pluginId: "rally_agents" } } };
}
const provider = useOpenRouterDouble(async (call) => {
  const latestInput = call.messages.filter((message) => message.role === "user").at(-1);
  if (sidekickChangeRequest) {
    const latest = JSON.stringify(latestInput?.content ?? "");
    // The run, continued by the wizard's answer (under the host's continuation
    // note), ends its turn; the wizard answers on the reply route to the run.
    if (JSON.stringify(call.messages).includes(WIZARD_ANSWER)) return { say: "Passed the answer on." };
    if (latest.includes(sidekickChangeRequest)) return explicitReply(call, WIZARD_ANSWER);
    const ask = call.toolNames.find((name) => name === "request_sidekick_change");
    if (ask) return call.messages.some((message) => message.role === "tool")
      ? { say: "Asked the wizard." }
      : { callTool: { name: ask, arguments: { changes: sidekickChangeRequest } } };
  }
  if (heldBackgroundModel && JSON.stringify(latestInput?.content ?? "").includes("HOLD_BACKGROUND")) await heldBackgroundModel;
  if (JSON.stringify(latestInput?.content ?? "").includes("LARGE_BACKGROUND_RESULT")) return { say: LARGE_RESULT_TEXT };
  if (JSON.stringify(latestInput?.content ?? "").includes("LIST_SIDEKICKS_FROM_MODEL")) {
    if (call.messages.some((message) => message.role === "tool")) return { say: "The Sidekick directory is ready." };
    if (JSON.stringify(latestInput?.content ?? "").includes("REVOKE_BEFORE_TOOL")) {
      await env.DB.prepare("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID, AUTHOR_ID).run();
    }
    const list = call.toolNames.find((name) => name === "sidekicks_list");
    if (!list) throw new Error("agent_directory_not_preloaded");
    return { callTool: { name: list, arguments: {} } };
  }
  if (JSON.stringify(latestInput?.content ?? "").includes("DELEGATE_FROM_MODEL")) {
    if (call.messages.some((message) => message.role === "tool" && /"data"\s*:\s*\{\s*"agentId"\s*:/u.test(String(message.content)))) {
      return { say: "Research is running; I am available here." };
    }
    const start = call.toolNames.find((name) => name.endsWith("start_agent"));
    if (start) return { callTool: { name: start, arguments: { name: "Model-created researcher",
      description: "Compare the options independently", message: "HOLD_BACKGROUND EXPLICIT_REPLY: compare these options" } } };
    const load = call.toolNames.find((name) => name.endsWith("load_plugin"));
    if (!load) throw new Error("agent_plugin_loader_missing");
    return { callTool: { name: load, arguments: { pluginId: "rally_agents" } } };
  }
  if (JSON.stringify(latestInput?.content ?? "").includes("CONFIGURE_SIDEKICK")) {
    const current = call.messages.slice(call.messages.lastIndexOf(latestInput!));
    const results = current.filter((message) => message.role === "tool")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    if (/"accepted"\s*:\s*true/u.test(results)) return explicitReply(call, "The Sidekick configuration is saved.");
    if (!results.includes("currentDefinition")) {
      const list = call.toolNames.find((name) => name === "sidekick_sidekicks_list");
      if (!list) throw new Error("sidekick_directory_tool_missing");
      return { callTool: { name: list, arguments: {} } };
    }
    const submit = call.toolNames.find((name) => name.endsWith("submit_draft"));
    if (!submit) throw new Error("sidekick_authoring_tool_missing");
    const revised = JSON.stringify(latestInput?.content ?? "").includes("REVISE");
    return { callTool: { name: submit, arguments: { ...DEFINITION, sidekickId: null, icon: "file-text", color: "blue",
      name: revised ? "Revised research guide" : "Research guide", triggers: [],
      instructions: revised ? "Compare the options and include their costs." : "Compare the available options." } } };
  }
  if (String(latestInput?.content).includes("EXPLICIT_REPLY")) {
    return explicitReply(call, "Here are the requested findings.");
  }
  const tool = call.toolNames.find((name) => name === "conversation_post");
  const toolAnswered = call.messages.some((message) => message.role === "tool");
  // Names the home: a post that names nothing lands in the Sidekick's own conversation.
  if (tool && !toolAnswered) return { callTool: { name: tool, arguments: { conversation: ROOM_ID, text: RESULT_TEXT } } };
  return { say: tool ? "Posted the count." : "Acknowledged." };
});
useSelectedModel();
useHeldEffectQueue();

/** The Organization object that hosts this Sidekick, and every other in the workspace. */
function sidekickHost() {
  return sidekickWorkspace(TEST_ENV, WORKSPACE_ID);
}

/** The room's parent, hosted by the workspace object. */
function roomParent() {
  return hostedParentStub(env, WORKSPACE_ID);
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

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
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

/**
 * A ready private Breakout of the room with only the author in it, made the way
 * creation makes one. Membership is what lets the author's socket see its id.
 */
async function seedPrivateBreakout(title: string): Promise<SubstreamId> {
  const parent = roomParent();
  const operationId = crypto.randomUUID();
  const recipe = {
    policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
    capture: "none" as const,
    parts: [],
  };
  const reserved = await parent.beginPrivateChildPreparation({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, creatorUserId: AUTHOR_ID, title,
    sourceSubstreamId: "0" as const, sourceThroughTurnId: null, recipe,
    membershipInitializer: { plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [AUTHOR_ID] },
  });
  const hash = "0".repeat(64);
  await parent.savePreparedPrivateChildContext({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId,
    preparedContext: { schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash },
  });
  await parent.claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, actorUserId: AUTHOR_ID });
  await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "workstream", ROOM_ID, reserved.substreamId);
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId: reserved.substreamId,
    title, objective: "", scope: "personal", createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
    emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
  const breakout = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, ROOM_ID, reserved.substreamId)));
  await breakout.installPreparedSubstreamContext({
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId: reserved.substreamId, operationId,
  });
  await parent.setPrivateChildTerminalStatus({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, status: "ready", errorCode: null,
  });
  await deliverChildEffects(TEST_ENV, breakout);
  return reserved.substreamId;
}

/** The room's automation, drafted and applied, its sidebar row in the workspace. */
async function seedRoomAutomation(): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "workspace",
    
    automationId: AUTOMATION_ID
  });
  expect(created.created).toBe(true);
  await sidekickHost().sidekickSubmitDefinition({ ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  const detail = await runInDurableObject(sidekickHost(), (instance: WorkspaceDO) =>
    instance.sidekickApply({ ...addressed(), actor: manager() }));
  expect(detail).toMatchObject({ lifecycle: "active", scope: "workspace", });
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

beforeEach(async () => {
  heldBackgroundModel = null;
  sidekickChangeRequest = null;
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

describe("a room Sidekick's run and the room's agents", () => {
  it.each([false, true])("uses model-turn authority for directory reads and refuses the next turn after revocation (%s)", async (revoked) => {
    await runInDurableObject(workspaceStub(), (instance) => {
      const target = instance as unknown as {
        activeWorkspaceMember: (workspaceId: string, userId: string) => Promise<boolean>;
        directoryMembershipChecks: number;
      };
      const check = target.activeWorkspaceMember.bind(target);
      target.directoryMembershipChecks = 0;
      target.activeWorkspaceMember = async (...args) => {
        target.directoryMembershipChecks++;
        return check(...args);
      };
    });
    const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
      input: { text: `LIST_SIDEKICKS_FROM_MODEL ${revoked ? "REVOKE_BEFORE_TOOL" : ""}`,
        clientMessageId: crypto.randomUUID(), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
    expect(response.status).toBe(200);
    const [run] = await settledRun(roomConversation());
    expect(run?.status).toBe(revoked ? "failed" : "completed");
    if (revoked) {
      // The preceding model turn authorized this built-in read; the next
      // model boundary sees the removal and stops the run.
      expect(await runInDurableObject(roomConversation(), (_instance, state) =>
        state.storage.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM tool_effects WHERE tool_name = 'sidekicks_list'",
        ).one().n)).toBe(1);
    } else expect(provider.calls.some((call) => call.messages.some((message) =>
      message.role === "tool" && JSON.stringify(message.content).includes("sidekicks")))).toBe(true);
    expect(await runInDurableObject(workspaceStub(), (instance) =>
      (instance as unknown as { directoryMembershipChecks: number }).directoryMembershipChecks)).toBe(0);
  });

  it("delegates through a real Bind tool receipt and answers another message before the worker finishes", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    try {
      const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
        input: { text: "DELEGATE_FROM_MODEL: research this, and stay available. PRIVATE_PARENT_DETAIL",
          clientMessageId: crypto.randomUUID(), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
      expect(response.status).toBe(200);
      expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed", error_json: null });
      const initialCall = provider.calls.find((call) => JSON.stringify(call.messages).includes("DELEGATE_FROM_MODEL"));
      expect(initialCall?.toolNames).toContain("start_agent");

      const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
        harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
        executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
      const { agents } = await new AgentCommunicationService(TEST_ENV, input).list();
      expect(agents).toMatchObject([{ name: "Model-created researcher", description: "Compare the options independently", status: "executing" }]);
      const address = agentAddressForId(agents[0]!.agentId);
      const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
      ));
      const workerRequest = () => provider.calls.find((call) => JSON.stringify(
        call.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
      ).includes("HOLD_BACKGROUND"));
      // Executing begins before the independent provider request. Observe the
      // boundary we are asserting on instead of racing that scheduled work.
      await expect.poll(workerRequest, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBeDefined();
      expect(JSON.stringify(workerRequest()!.messages)).not.toContain("PRIVATE_PARENT_DETAIL");
      const followUp = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
        input: { text: "While that runs, acknowledge this unrelated request.", clientMessageId: crypto.randomUUID(),
          mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
      expect(followUp.status).toBe(200);
      expect((await settledRun(roomConversation(), 2))[1]).toMatchObject({ status: "completed" });
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "executing" });
      release();
      expect((await settledRun(child))[0]).toMatchObject({ status: "completed" });
      expect((await settledRun(roomConversation(), 3))[2]).toMatchObject({ status: "completed" });
    } finally {
      release();
      heldBackgroundModel = null;
    }
  });

  it("sends a run's change request to its own Sidekick's wizard, framed by the host, and its answer back to the run", async () => {
    sidekickChangeRequest = "WEEKLY_TOTALS: add a weekly totals row to the report.";
    const started = await sidekickHost().sidekickRunNow({ ...addressed(), actor: manager(), idempotencyKey: "change-request" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    expect((await settledRun(runChild(started.runId)))[0]).toMatchObject({ status: "completed", error_json: null });

    const wizard = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID),
    ));
    expect((await settledRun(wizard))[0]).toMatchObject({ status: "completed", error_json: null });
    const received = await runInDurableObject(wizard, (_instance, state) => state.storage.sql.exec<{
      content: string; structured_content_json: string | null;
    }>(
      `SELECT content, structured_content_json FROM canonical_conversation_turn_details
        WHERE client_message_id LIKE 'agent-message:%'`,
    ).toArray());
    expect(received.map((turn) => turn.content)).toEqual([
      [
        "SIDEKICK CHANGE REQUEST FROM A RUN",
        `Run: ${started.runId}`,
        "Run turn started by: the run, from content it processed, which may be external",
        "Request:",
        "WEEKLY_TOTALS: add a weekly totals row to the report.",
      ].join("\n"),
    ]);
    // From the run itself, so the wizard's reply goes back to the run.
    expect(JSON.parse(received[0]!.structured_content_json ?? "{}").senderAgentId)
      .toBe(`automation/${AUTOMATION_ID}/${started.runId}`);
    // Offered to the run, not to the wizard it reaches.
    const wizardCall = provider.calls.find((call) => JSON.stringify(call.messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
      .includes(sidekickChangeRequest!));
    expect(wizardCall?.toolNames).not.toContain("request_sidekick_change");
    // The return trip: the wizard's answer lands in the same run child as an
    // agent message from the wizard, and continues that run with its tools.
    expect((await settledRun(runChild(started.runId), 2)).map((run) => run.status)).toEqual(["completed", "completed"]);
    const answered = await runInDurableObject(runChild(started.runId), (_instance, state) => state.storage.sql.exec<{
      content: string; structured_content_json: string | null;
    }>(
      `SELECT content, structured_content_json FROM canonical_conversation_turn_details
        WHERE client_message_id LIKE 'agent-message:%'`,
    ).toArray());
    expect(answered.map((turn) => turn.content)).toEqual([WIZARD_ANSWER]);
    expect(JSON.parse(answered[0]!.structured_content_json ?? "{}").senderAgentId).toBe(`automation/${AUTOMATION_ID}/0`);
    const continuedRun = provider.calls.find((call) => call.messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes(WIZARD_ANSWER)));
    expect(continuedRun?.toolNames ?? []).toContain("request_sidekick_change");
    // The host tells the run the message is its wizard's, and where its answer goes.
    expect(JSON.stringify(continuedRun?.messages ?? [])).toContain("This run is continuing because this Sidekick's wizard sent a message");
    // The wizard reads the request beside its guidance for one, keyed on the same header.
    expect(JSON.stringify(wizardCall?.messages.filter((message) => message.role === "system")))
      .toContain('An agent message whose text begins with the line \\"SIDEKICK CHANGE REQUEST FROM A RUN\\"');
  });

  it("refuses a change request from a conversation that is not a Sidekick run", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    await expect(new AgentCommunicationService(TEST_ENV, input).requestSidekickChange("Add a row.", context))
      .rejects.toThrow("Only a Sidekick run can request a change to its own Sidekick this way.");
  });

  it.each([
    { hint: "mail_calendar", grants: ["gmail.read"], tools: ["google_gmail_search"] },
    { hint: "drive", grants: ["drive.read"], tools: ["google_drive_search"] },
    { hint: "drive", grants: ["gmail.read"], tools: [] },
    { hint: null, grants: ["gmail.read", "drive.read"], tools: ["google_gmail_search", "google_drive_search"] },
  ])("restores only granted Google tools from a saved $hint activation hint", async ({ hint, grants, tools }) => {
    const connectionId = "00000000-0000-7000-8000-00000000ad40";
    const credentials = await encryptString(JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z" }), TEST_ENV.CONNECTOR_CREDENTIALS_KEY, connectionId);
    const providerFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ sub: "fixture-account" });
      return providerFetch(input, init);
    });
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec(
      `INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id,
         provider_account_id, display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id, encrypted_credentials, credential_iv, credential_key_version)
       VALUES (?, ?, 'google', 'personal', ?, 'google-account', 'Google', ?, 'healthy', '{}', '{}', ?, ?, 'plugin_google', ?, ?, 1)`,
      connectionId, WORKSPACE_ID, AUTHOR_ID, JSON.stringify(grants), NOW, NOW, credentials.ciphertext, credentials.iv,
    ));
    const pluginId = `connection:${connectionId}${hint === null ? "" : `:${hint}`}`;
    await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec(
      `INSERT INTO plugin_activation_hints (plugin_id, activated_at, last_authorized_at) VALUES (?, ?, ?)`,
      pluginId, Date.now(), Date.now(),
    ));
    const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
      input: { text: "Inspect the tools available from the saved Google activation.", clientMessageId: crypto.randomUUID(),
        mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
    expect(response.status).toBe(200);
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed", error_json: null });
    expect(provider.calls[0]?.toolNames.filter((name) => ["google_gmail_search", "google_drive_search"].includes(name)).sort())
      .toEqual([...tools].sort());
  });

  it("keeps a large final response local without creating a parent message", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Detailed researcher", description: "Return the complete result",
      message: "LARGE_BACKGROUND_RESULT: return all findings.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    expect(run).toMatchObject({ status: "completed", error_json: null });
    await expect.poll(() => runInDurableObject(child, (_instance, state) => state.storage.sql.exec<{ settled: number }>(
      "SELECT external_settled_at IS NOT NULL AS settled FROM runs WHERE run_id = ?", run!.run_id,
    ).one().settled), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
    // The parent hears that the worker finished without replying, and nothing
    // else: the final response itself stays in the worker's transcript.
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
      `Agent Detailed researcher finished without replying. Id: ${started.agentId}`,
    ))).toBe(true);
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(LARGE_RESULT_TEXT.slice(0, 80)))).toBe(false);
    // The notice is tagged as one. Without it the stored turn is shaped exactly
    // like a teammate's own message, and the only two ends of a worker's life
    // the transcript records are indistinguishable from ordinary traffic.
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{
      structured_content_json: string | null;
    }>(
      `SELECT structured_content_json FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND client_message_id LIKE 'agent-message:%'`,
    ).toArray().map((turn) => JSON.parse(turn.structured_content_json ?? "{}").notice)))
      .toEqual(["finished_without_reply"]);
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
        SELECT client_message_id FROM pending_loop_input_mailbox WHERE client_message_id LIKE 'agent-message:%'
        UNION SELECT client_message_id FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'
      )`,
    ).one().n)).toBe(1);
  });

  it("hands a Channel run's Slack outcome the member who triggered it and every message it answered", async () => {
    const deliveries = vi.spyOn(SlackAgentService.prototype, "deliverWorkstreamOutcome").mockResolvedValue(undefined);
    try {
      const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
        harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID }, reason: "test",
        // A follow-up from a second member in a thread somebody else opened.
        slackOrigin: { teamId: "T1", actorSlackUserId: "U_FOLLOW_UP", channelId: "C1", channelName: null,
          threadTs: "1.0", invocationType: "app_mention", channelType: "public", matchedAvalonUserId: null,
          nearbyMessagesStatus: "not_applicable", nearbyMessages: [], attachments: [],
          reactionAnchor: { channelId: "C1", messageTs: "9.0" } } });
      await runInDurableObject(roomConversation(), async (instance, state) => {
        // A third member's follow-up was steered into this run at a step boundary.
        state.storage.sql.exec(
          `INSERT INTO run_absorbed_slack_origins (input_id, run_id, slack_origin_json, created_at)
           VALUES (?, ?, ?, 0)`,
          crypto.randomUUID(),
          input.harnessRunId,
          JSON.stringify({ ...input.slackOrigin, actorSlackUserId: "U_STEER",
            reactionAnchor: { channelId: "C1", messageTs: "11.0" } }),
        );
        const target = instance as unknown as {
          deliverAgentRunResult: (input: WorkstreamWorkflowInput, outcome: { status: "needs_input" }) => Promise<string | null>;
        };
        await target.deliverAgentRunResult(input, { status: "needs_input" });
      });
      expect(deliveries.mock.calls.map((args) => args.slice(3))).toEqual([[
        `${input.harnessRunId}:needs_input`,
        "needs_input",
        {
          triggeringSlackUserId: "U_FOLLOW_UP",
          reactionAnchor: { channelId: "C1", messageTs: "9.0" },
          absorbedReactionAnchors: [{ channelId: "C1", messageTs: "11.0" }],
        },
      ]]);
    } finally {
      deliveries.mockRestore();
    }
  });

  it("replays an explicit reply after lost admission confirmation and a cold restart", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await new AgentCommunicationService(TEST_ENV, input).start({ name: "Researcher",
      description: "Prepare findings", message: "Prepare findings locally.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    // The worker finished without replying, and its owner runs on that notice
    // before the reply is injected, so the reply meets the ordinary admission
    // path rather than a mid-run mailbox.
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
    const replyService = new AgentCommunicationService(TEST_ENV, childInput);
    const replyContext = { ...context, effectIntentId: crypto.randomUUID() };
    const reply = { messageId: childInput.agentExchange!.messageId, message: "Explicit findings.", attachmentIds: [] };
    await runInDurableObject(roomConversation(), (instance) => {
      const target = instance as unknown as {
        product: { admitSystemActivation: (...args: unknown[]) => Promise<unknown> };
      };
      const admit = target.product.admitSystemActivation.bind(target.product);
      target.product.admitSystemActivation = async (...args) => {
        await admit(...args);
        target.product.admitSystemActivation = admit;
        throw new Error("injected_reply_confirmation_loss");
      };
    });
    await expect(replyService.send(reply, replyContext)).rejects.toThrow("injected_reply_confirmation_loss");
    await settledRun(roomConversation(), 2);
    // Crash only the recipient. Graceful eviction waits for live requests;
    // aborting every object also resets Miniflare's D1 and breaks isolation.
    let beforeCrash: unknown;
    await expect(runInDurableObject(roomConversation(), (instance, state) => {
      beforeCrash = instance;
      state.abort("injected_recipient_restart");
    })).rejects.toThrow("injected_recipient_restart");
    expect(await runInDurableObject(roomConversation(), (instance) => instance === beforeCrash)).toBe(false);
    await replyService.send(reply, replyContext);
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
        SELECT client_message_id FROM pending_loop_input_mailbox WHERE client_message_id LIKE 'agent-message:%'
        UNION SELECT client_message_id FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'
      )`,
    ).one().n)).toBe(2);
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs",
    ).one().n)).toBe(2);
  });

  it.each(["needs_input", "failed"] as const)("settles %s beside the completed run's own notice, with only failed runs adding one more", async (status) => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
      message: "no further action is needed.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    // The real run completed without replying, so the owner already holds that
    // one notice and has run on it.
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
    await runInDurableObject(child, async (instance) => {
      const target = instance as unknown as {
        deliverAgentRunResult: (input: WorkstreamWorkflowInput, outcome: { status: "needs_input" | "failed"; error: { code: string; message: string } }) => Promise<string | null>;
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await target.deliverAgentRunResult(childInput, { status, error: {
          code: "ambiguous_external_write", message: "An external action's outcome could not be confirmed; do not repeat it.",
        } });
      }
    });
    if (status === "failed") {
      await settledRun(roomConversation(), 2);
      expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
        `Agent failed due to ambiguous_external_write. Id: ${started.agentId}`,
      ))).toBe(true);
      // The notice is tagged and carries its diagnostic. The feed's failure row
      // is the reader's whole record of this — it does not show the body — and
      // the recipient model needs the host attribution to tell a real notice
      // from a worker that was talked into sending the same words.
      expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{
        structured_content_json: string | null;
      }>(
        `SELECT structured_content_json FROM canonical_conversation_turn_details
          WHERE substream_id = '0' AND client_message_id LIKE 'agent-message:%'`,
      ).toArray().map((turn) => {
        const content = JSON.parse(turn.structured_content_json ?? "{}");
        return [content.notice, content.noticeReason];
      }))).toContainEqual(["failed", "ambiguous_external_write"]);
      expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
        "Notice from Rally, not from an agent",
      ))).toBe(true);
    }
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
        SELECT client_message_id FROM pending_loop_input_mailbox WHERE client_message_id LIKE 'agent-message:%'
        UNION SELECT client_message_id FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'
      )`,
    ).one().n)).toBe(status === "failed" ? 2 : 1);
  });

  it("tells the owner once when a worker finishes without replying, and not when it replied", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const conversation = (agentId: Parameters<typeof agentAddressForId>[0]) => {
      const address = agentAddressForId(agentId);
      return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
      ));
    };
    const notices = () => runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
        SELECT client_message_id FROM pending_loop_input_mailbox WHERE client_message_id LIKE 'agent-message:%'
        UNION SELECT client_message_id FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'
      )`,
    ).one().n);
    const started = await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
      message: "no further action is needed.", attachmentIds: [] }, context);
    // The result says how the reply comes back, at the moment the model reads it.
    expect(started).toMatchObject({ name: "Quiet teammate" });
    expect(started.next).toContain("There is no tool to fetch it. Do not resend the assignment.");
    const quiet = conversation(started.agentId);
    const [run] = await settledRun(quiet);
    expect(run).toMatchObject({ status: "completed" });
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
      `Agent Quiet teammate finished without replying. Id: ${started.agentId}`,
    ))).toBe(true);
    expect(await notices()).toBe(1);
    // Settling the same run again delivers nothing: the run supplies the identity.
    const childInput = await runInDurableObject(quiet, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    await runInDurableObject(quiet, async (instance) => {
      const target = instance as unknown as {
        deliverAgentRunResult: (input: WorkstreamWorkflowInput, outcome: { status: "completed" }) => Promise<string | null>;
      };
      await target.deliverAgentRunResult(childInput, { status: "completed" });
    });
    expect(await notices()).toBe(1);
    // A worker that replied has said what it had to say; its completion is silent.
    const replied = await service.start({ name: "Replying teammate", description: "Report back",
      message: "EXPLICIT_REPLY: report back.", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
    expect((await settledRun(conversation(replied.agentId)))[0]).toMatchObject({ status: "completed" });
    expect((await settledRun(roomConversation(), 2))[1]).toMatchObject({ status: "completed" });
    expect(await notices()).toBe(2);
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes("Here are the requested findings."))).toBe(true);
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
      `Agent Replying teammate finished without replying`,
    ))).toBe(false);
    // A worker that delegated and ended its turn is waiting on its delegate,
    // not finished: starting an agent is a hand-off, and the reply wakes it.
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    try {
      const delegating = await service.start({ name: "Delegating teammate", description: "Split the work",
        message: "DELEGATE_FROM_MODEL: split this work.", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
      expect((await settledRun(conversation(delegating.agentId)))[0]).toMatchObject({ status: "completed" });
      expect(await notices()).toBe(2);
      expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
        "Agent Delegating teammate finished without replying",
      ))).toBe(false);
      // Its delegate replies and it wakes; ending that turn without a word is
      // the silence its owner is told about.
      release();
      expect((await settledRun(conversation(delegating.agentId), 2))[1]).toMatchObject({ status: "completed" });
      expect((await settledRun(roomConversation(), 3))[2]).toMatchObject({ status: "completed" });
      expect(await notices()).toBe(3);
      expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
        "Agent Delegating teammate finished without replying",
      ))).toBe(true);
    } finally {
      release();
      heldBackgroundModel = null;
    }
  });

  it("keeps a recursively stopped owner stopped when its child reports failure", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const owner = await service.start({ name: "Owner", description: "Coordinate work", message: "Finish locally.", attachmentIds: [] }, context);
    const conversation = (agentId: typeof owner.agentId) => {
      const address = agentAddressForId(agentId);
      return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, address.parentId, address.substreamId)));
    };
    const ownerConversation = conversation(owner.agentId);
    await settledRun(ownerConversation);
    const readInput = (stub: ReturnType<typeof conversation>) => runInDurableObject(stub, (_instance, state) =>
      WorkstreamWorkflowInputSchema.parse(JSON.parse(state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs ORDER BY created_at DESC LIMIT 1",
      ).one().execution_context_json)));
    const ownerService = new AgentCommunicationService(TEST_ENV, await readInput(ownerConversation));
    const child = await ownerService.start({ name: "Child", description: "Do the work", message: "Finish locally.", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() });
    const childConversation = conversation(child.agentId);
    await settledRun(childConversation);
    // The child finished without replying; the owner runs on that notice
    // before it is stopped, so the stop below holds only the failure notice.
    await settledRun(ownerConversation, 2);
    await service.stop(owner.agentId);
    await new AgentCommunicationService(TEST_ENV, await readInput(childConversation)).notifyFailure("provider_unavailable");
    expect(await ownerConversation.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
    expect(await runInDurableObject(ownerConversation, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs",
    ).one().n)).toBe(2);
    expect(await runInDurableObject(ownerConversation, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_loop_input_mailbox",
    ).one().n)).toBe(1);
    // The stop holds that notice until the owner is resumed, so it is not a
    // reason to wake. Reporting it at `now` ran this object's alarm about five
    // times a second in production, for as long as the agent stayed stopped.
    expect(await runInDurableObject(ownerConversation, (instance) =>
      (instance as unknown as { nextLoopWorkAt(now: number): number | null }).nextLoopWorkAt(Date.now()))).toBeNull();
    await service.send({ agentId: owner.agentId, message: "Continue your work.", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() });
    await settledRun(ownerConversation, 3);
    expect(await ownerConversation.agentRuntimeInfo()).not.toMatchObject({ status: "stopped" });
  });

  it("fences an owner before reading descendants during recursive stop", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
      message: "no further action is needed.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    const attempted = { reached: false, created: false };
    const target = service as unknown as {
      workspace: () => Promise<{ ownedAgentDescendants: (request: { workspaceId: string; agentId: typeof started.agentId }) => Promise<{ agentIds: typeof started.agentId[] }> }>;
    };
    const workspace = target.workspace.bind(target);
    target.workspace = async () => {
      const actual = await workspace();
      return { ownedAgentDescendants: async (request) => {
        // Read real WorkspaceDO state, then allow a start at precisely the
        // snapshot/stop boundary. No storage or RPC result is fabricated.
        const snapshot = await actual.ownedAgentDescendants(request);
        if (request.agentId === started.agentId && !attempted.reached) {
          attempted.reached = true;
          try {
            await new AgentCommunicationService(TEST_ENV, childInput).start({
              name: "Late child", description: "Register during a stop", message: "Finish your local work.", attachmentIds: [],
            }, { ...context, effectIntentId: crypto.randomUUID() });
            attempted.created = true;
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "agent_origin_stopped") throw error;
          }
        }
        return snapshot;
      } };
    };
    await service.stop(started.agentId);
    expect(attempted).toEqual({ reached: true, created: false });
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
  });

  it.each([false, true])("keeps a child stopped when its opening admission races an owner stop (lost confirmation: %s)", async (loseConfirmation) => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
      message: "no further action is needed.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    const nestedService = new AgentCommunicationService(TEST_ENV, childInput);
    // Interleave at delivery, shared by public sends and the initial assignment.
    // Keep real admission and storage; only schedule the competing stop here.
    const target = nestedService as unknown as {
      deliver: (args: Parameters<typeof service.send>[0], messageId: string,
        resumeStopped?: boolean, teamId?: typeof started.agentId) => Promise<{ messageId: string }>;
    };
    const deliver = target.deliver.bind(target);
    target.deliver = async (...args) => {
      await service.stop(started.agentId);
      const result = await deliver(...args);
      if (loseConfirmation) throw new Error("opening_confirmation_lost");
      return result;
    };
    await expect(nestedService.start({ name: "Racing child", description: "Opening admission after stop",
      message: "Finish your local work.", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() }))
      .rejects.toThrow(loseConfirmation ? "opening_confirmation_lost" : "stopped");
    const descendants = await workspaceStub().ownedAgentDescendants({ workspaceId: WORKSPACE_ID, agentId: started.agentId });
    expect(descendants.agentIds).toHaveLength(1);
    const nestedAddress = agentAddressForId(descendants.agentIds[0]!);
    const nested = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, nestedAddress.substreamId),
    ));
    expect(await nested.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
  });

  it.each(["worker", "sidekick"] as const)("keeps a %s final response local and sends only explicit replies", async (kind) => {
    const deliveries = vi.spyOn(SlackAgentService.prototype, "deliverWorkstreamOutcome");
    try {
      const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
        harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
        executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
      const service = new AgentCommunicationService(TEST_ENV, input);
      const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
        toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
        executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
      const started = kind === "worker"
        ? await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
          message: "Finish your local work.", attachmentIds: [] }, context)
        : await service.createSidekick("workspace", context);
      if (kind === "sidekick") await service.send({ agentId: started.agentId,
        message: "Finish your local work.", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
      const address = agentAddressForId(started.agentId);
      const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, address.parentId, address.substreamId),
      ));
      const [run] = await settledRun(child);
      expect(run).toMatchObject({ status: "completed", error_json: null });
      await expect.poll(() => runInDurableObject(child, (_instance, state) => state.storage.sql.exec<{ settled: number }>(
        "SELECT external_settled_at IS NOT NULL AS settled FROM runs WHERE run_id = ?", run!.run_id,
      ).one().settled), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
      // A worker that finished without replying is reported to the room, and
      // nothing else reaches it: the final response is projected nowhere. A
      // Sidekick's authoring conversation is not a background agent and sends
      // no such notice.
      const notices = kind === "worker" ? 1 : 0;
      if (notices) expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
      expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM runs",
      ).one().n)).toBe(notices);
      expect(deliveries.mock.calls.filter((args) => args[3].startsWith(`${run!.run_id}:`))).toEqual([]);
      expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
          SELECT client_message_id FROM pending_loop_input_mailbox WHERE client_message_id LIKE 'agent-message:%'
          UNION SELECT client_message_id FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'
        )`,
      ).one().n)).toBe(notices);
      expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(
        `finished without replying. Id: ${started.agentId}`,
      ))).toBe(kind === "worker");
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "idle" });
      await service.send({ agentId: started.agentId, message: "EXPLICIT_REPLY: send a useful result.", attachmentIds: [] },
        { ...context, effectIntentId: crypto.randomUUID() });
      expect((await settledRun(child, 2))[1]).toMatchObject({ status: "completed" });
      expect((await settledRun(roomConversation(), notices + 1))[notices]).toMatchObject({ status: "completed" });
    } finally {
      deliveries.mockRestore();
    }
  });

  it("forwards an existing attachment into the worker's canonical message and reply", async () => {
    const resourceId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    const extraIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    const attachmentIds = [resourceId, imageId, ...extraIds];
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imageRef = `global/${WORKSPACE_ID}/agent-test/${imageId}.png`;
    await env.PAYLOADS.put(imageRef, Uint8Array.from(atob(png), (character) => character.charCodeAt(0)));
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'avalon_upload', 'research.txt', 'text/plain',
          NULL, '{"size":12}', ?, 'attached', ?, ?)`,
        resourceId, WORKSPACE_ID, AUTHOR_ID, NOW, NOW);
      for (const extraId of extraIds) {
        state.storage.sql.exec(`INSERT INTO resources
          (id, workspace_id, resource_type, provider, title, mime_type, metadata_json,
           uploaded_by_user_id, attachment_status, created_at, updated_at)
          VALUES (?, ?, 'document', 'avalon_upload', 'finding.txt', 'text/plain',
            '{"size":12}', ?, 'attached', ?, ?)`, extraId, WORKSPACE_ID, AUTHOR_ID, NOW, NOW);
      }
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at,
         model_content_ref, model_mime_type, model_content_status)
        VALUES (?, ?, 'document', 'avalon_upload', 'diagram.png', 'image/png', ?,
          '{"size":68}', ?, 'attached', ?, ?, ?, 'image/png', 'ready')`,
        imageId, WORKSPACE_ID, imageRef, AUTHOR_ID, NOW, NOW, imageRef);
    });
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId, attachedByUserId: AUTHOR_ID });
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId: imageId, attachedByUserId: AUTHOR_ID });
    for (const extraId of extraIds) {
      await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
        resourceId: extraId, attachedByUserId: AUTHOR_ID });
    }
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const beforeInvalidOpening = await service.list();
    await expect(service.start({ name: "Invalid researcher", description: "Unavailable context",
      message: "Read this", attachmentIds: [crypto.randomUUID()] }, { ...context, effectIntentId: crypto.randomUUID() }))
      .rejects.toThrow("Attach the resource");
    expect(await service.list()).toEqual(beforeInvalidOpening);
    const started = await service.start({ name: "Attachment researcher", description: "Read the supplied resource",
      message: "Read the attached research.", attachmentIds: [resourceId, ...attachmentIds] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ resource_id: string }>(
        "SELECT resource_id FROM participant_transcript_attachments ORDER BY position",
      ).toArray()).toEqual(attachmentIds.map((resource_id) => ({ resource_id })));
      return WorkstreamWorkflowInputSchema.parse(JSON.parse(state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id,
      ).one().execution_context_json));
    });
    const reply = await new AgentCommunicationService(TEST_ENV, childInput).send({
      messageId: childInput.agentExchange!.messageId, message: "Here is the research.", attachmentIds: [...attachmentIds, imageId],
    }, { ...context, effectIntentId: crypto.randomUUID() });
    await expect.poll(() => runInDurableObject(roomConversation(), (_instance, state) =>
      state.storage.sql.exec<{ resource_id: string }>(
        "SELECT resource_id FROM participant_transcript_attachments WHERE turn_id = ? ORDER BY position", reply.messageId,
      ).toArray()), { timeout: RUN_SETTLE_TIMEOUT_MS }).toEqual(attachmentIds.map((resource_id) => ({ resource_id })));
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(resourceId))).toBe(true);
    expect(provider.calls.some((call) => call.messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes("Read the attached research.")
      && JSON.stringify(message.content).includes("ATTACHMENT MANIFEST")
      && JSON.stringify(message.content).includes("research.txt")))).toBe(true);
    expect(provider.calls.some((call) => call.messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes(`data:image/png;base64,${png}`)))).toBe(true);
    const empty = await service.start({ name: "Empty researcher", description: "Wait for context",
      message: "Wait for the research.", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
    const emptyAddress = agentAddressForId(empty.agentId);
    const emptyChild = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, emptyAddress.substreamId),
    ));
    await settledRun(emptyChild);
    await expect(service.send({ agentId: empty.agentId, message: "Read this too", attachmentIds: [resourceId, crypto.randomUUID()] },
      { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("Attach the resource");
    await runInDurableObject(emptyChild, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM workstream_resource_links").one().n).toBe(0);
    });
    // Archive after the sender's authority check but before recipient admission.
    // The real recipient refuses the input and must retain no attachment link.
    const boundary = service as unknown as { validateAttachments(ids: string[]): Promise<string[]> };
    const validate = boundary.validateAttachments.bind(service);
    boundary.validateAttachments = async (ids) => {
      const validated = await validate(ids);
      const archived = await post(roomConversation(), "/internal/product", {
        operation: "update", auth: AUTH, input: { archived: true },
      });
      expect(archived.status).toBe(200);
      await deliverEffectsToWorkspace(TEST_ENV, roomConversation());
      return validated;
    };
    await expect(service.send({ agentId: empty.agentId, message: "Read after archive", attachmentIds: [resourceId] },
      { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("archived");
    await runInDurableObject(emptyChild, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM workstream_resource_links").one().n).toBe(0);
    });
  });

  it("lets Bind settle an owned stop after the in-flight model step returns", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    try {
      const started = await service.start({ name: "Researcher", description: "Finish one model step",
        message: "HOLD_BACKGROUND: compare the alternatives", attachmentIds: [] }, {
        workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
        toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
        executionPrincipal: input.executionPrincipal, signal: new AbortController().signal,
      });
      const address = agentAddressForId(started.agentId);
      const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
      ));
      await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes("HOLD_BACKGROUND")),
        { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
      await service.stop(started.agentId);
      const active = await runInDurableObject(child, (_instance, state) => state.storage.sql.exec<RunRow>(
        "SELECT run_id, status, error_json, terminalized_at FROM runs ORDER BY created_at, run_id",
      ).toArray());
      expect(active).toMatchObject([{ status: "running", terminalized_at: null }]);
      release();
      expect(await settledRun(child)).toMatchObject([{ status: "cancelled" }]);
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
      expect(provider.calls.filter((call) => JSON.stringify(call.messages).includes("HOLD_BACKGROUND"))).toHaveLength(1);
    } finally {
      release();
      heldBackgroundModel = null;
    }
  });

  it("archives active owned workers through Bind while leaving an independent Sidekick running", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    try {
      const independent = await service.createSidekick("workspace", context);
      await service.send({ agentId: independent.agentId, message: "HOLD_BACKGROUND: independent setup", attachmentIds: [] },
        { ...context, effectIntentId: crypto.randomUUID() });
      const sidekick = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, independent.sidekickId),
      ));
      const started = await service.start({ name: "Owned researcher", description: "Research until archived",
        message: "HOLD_BACKGROUND: owned research", attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
      const address = agentAddressForId(started.agentId);
      const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
      ));
      await expect.poll(() => provider.calls.filter((call) => JSON.stringify(call.messages).includes("HOLD_BACKGROUND")).length,
        { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(2);
      const archived = await post(roomConversation(), "/internal/product", { operation: "update", auth: AUTH, input: { archived: true } });
      expect(archived.status).toBe(200);
      await deliverEffectsToWorkspace(TEST_ENV, roomConversation());
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
      expect(await sidekick.agentRuntimeInfo()).toMatchObject({ status: "executing" });
      expect(await runInDurableObject(child, (_instance, state) => state.storage.sql.exec<RunRow>(
        "SELECT run_id, status, error_json, terminalized_at FROM runs",
      ).toArray())).toMatchObject([{ status: "running", terminalized_at: null }]);
      release();
      const [archivedRun] = await settledRun(child);
      expect(archivedRun?.status, JSON.stringify(archivedRun)).toBe("cancelled");
      const [sidekickRun] = await settledRun(sidekick);
      expect(sidekickRun).toMatchObject({ status: "completed" });
      await expect.poll(() => runInDurableObject(sidekick, (_instance, state) => state.storage.sql.exec<{ settled: number }>(
        "SELECT external_settled_at IS NOT NULL AS settled FROM runs WHERE run_id = ?", sidekickRun!.run_id,
      ).one().settled), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
      await expect(service.send({ agentId: started.agentId, message: "Continue", attachmentIds: [] },
        { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("archived");
    } finally {
      release();
      heldBackgroundModel = null;
    }
  });

  it("answers a participant while a worker is blocked and publishes only its running count", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    let socket: WebSocket | undefined;
    try {
      const started = await service.start({ name: "Slow researcher", description: "Research in the background",
        message: "HOLD_BACKGROUND: research the alternatives", attachmentIds: [] }, {
        workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
        toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
        executionPrincipal: input.executionPrincipal, signal: new AbortController().signal,
      });
      const address = agentAddressForId(started.agentId);
      const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
      ));
      await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes("HOLD_BACKGROUND")),
        { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
      const foreground = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
        input: { text: "Rally, are you still available?", clientMessageId: crypto.randomUUID(),
          mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
      expect(foreground.status).toBe(200);
      expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "executing" });
      await deliverChildEffects(TEST_ENV, roomConversation());
      await deliverChildEffects(TEST_ENV, child);
      const response = await roomParent().fetch("https://workstream.test/parent-socket", { headers: {
        Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-workstream-id": ROOM_ID,
        "x-rally-user-id": AUTHOR_ID, "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": crypto.randomUUID(),
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
      } });
      expect(response.status).toBe(101);
      socket = response.webSocket!;
      socket.accept();
      const metadata = new Promise<MessageEvent>((resolve) => socket!.addEventListener("message", resolve, { once: true }));
      socket.send(JSON.stringify({ type: "subscribe" }));
      const frame = JSON.parse(String((await metadata).data));
      expect(frame.metadata.backgroundAgentCount).toBe(1);
      expect(frame.metadata.backgroundAgentCounts).toEqual({ "0": 1 });
      expect(frame.metadata.privateChildren).toEqual([]);
      const heldForeground = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
        input: { text: "HOLD_BACKGROUND: foreground work to stop", clientMessageId: crypto.randomUUID(),
          mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
      expect(heldForeground.status).toBe(200);
      await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes("foreground work to stop")),
        { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
      await runInDurableObject(roomConversation(), async (instance) => {
        const target = instance as unknown as {
          product: { stopForAdmittedSocket: (auth: AuthContext, operationId: string) => Promise<void> };
        };
        await target.product.stopForAdmittedSocket(AUTH, crypto.randomUUID());
      });
      expect(await child.agentRuntimeInfo()).toMatchObject({ status: "executing" });
      release();
      expect((await settledRun(roomConversation(), 2))[1]).toMatchObject({ status: "cancelled" });
      expect((await settledRun(child))[0]).toMatchObject({ status: "completed" });
      let latestCount = 1;
      socket.addEventListener("message", (event) => {
        const update = JSON.parse(String(event.data));
        if (update.type === "workstream_metadata") latestCount = update.metadata.backgroundAgentCount;
      });
      await deliverChildEffects(TEST_ENV, child);
      await expect.poll(() => latestCount, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(0);
    } finally {
      release();
      heldBackgroundModel = null;
      socket?.close();
    }
  });

  it("counts a Breakout's workers, and the workers they start, only in that Breakout", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    const breakoutId = await seedPrivateBreakout("Side question");
    const startFrom = async (substreamId: SubstreamId, backgroundAgent: boolean) => {
      const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "workstream", parentId: ROOM_ID, substreamId, loopId: `workstream:${ROOM_ID}:substream:${substreamId}:loop`,
        harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null, backgroundAgent,
        executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
      const started = await new AgentCommunicationService(TEST_ENV, input).start({ name: "Researcher",
        description: "Research in the background", message: "HOLD_BACKGROUND: research the alternatives", attachmentIds: [] }, {
        workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
        toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
        executionPrincipal: input.executionPrincipal, signal: new AbortController().signal,
      });
      const address = agentAddressForId(started.agentId);
      return { substreamId: address.substreamId, stub: env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId))) };
    };
    let socket: WebSocket | undefined;
    try {
      const worker = await startFrom(breakoutId, false);
      const nested = await startFrom(worker.substreamId, true);
      for (const agent of [worker, nested]) {
        await expect.poll(async () => (await agent.stub.agentRuntimeInfo())?.status,
          { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe("executing");
        await deliverChildEffects(TEST_ENV, agent.stub);
      }
      const response = await roomParent().fetch("https://workstream.test/parent-socket", { headers: {
        Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-workstream-id": ROOM_ID,
        "x-rally-user-id": AUTHOR_ID, "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": crypto.randomUUID(),
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
      } });
      expect(response.status).toBe(101);
      socket = response.webSocket!;
      socket.accept();
      const metadata = new Promise<MessageEvent>((resolve) => socket!.addEventListener("message", resolve, { once: true }));
      socket.send(JSON.stringify({ type: "subscribe" }));
      const frame = JSON.parse(String((await metadata).data));
      expect(frame.metadata.backgroundAgentCounts).toEqual({ [breakoutId]: 2 });
      expect(frame.metadata.backgroundAgentCount).toBe(2);
      // Someone outside the Breakout never learns its id from the counts.
      const outsider = await withHostedParent(roomParent(), ROOM_ID, (parent) => (parent as unknown as {
        metadataForUser(userId: string): { backgroundAgentCounts?: Record<string, number> } | null;
      }).metadataForUser(crypto.randomUUID()));
      expect(outsider?.backgroundAgentCounts).toEqual({});
      // Stopped rather than finished: a finished worker notifies its starter,
      // whose run would outlive the test.
      for (const agent of [nested, worker]) await agent.stub.stopOwnedAgent();
      release();
      for (const agent of [worker, nested]) {
        expect((await settledRun(agent.stub))[0]).toMatchObject({ status: "cancelled" });
      }
    } finally {
      release();
      heldBackgroundModel = null;
      socket?.close();
    }
  });

  it("preserves the authority refusal when delegated initialization is fenced", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({
      region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: ROOM_ID,
      substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`, harnessRunId: crypto.randomUUID(),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test",
    });
    let restore!: () => void;
    await runInDurableObject(roomParent(), (instance: WorkspaceDO) => {
      const reserve = instance.reserveAgentChild;
      const spy = vi.spyOn(Object.getPrototypeOf(instance) as WorkspaceDO, "reserveAgentChild")
        .mockImplementation(async function (this: WorkspaceDO, ...args) {
          const result = await reserve.apply(this, args);
          // Simulate a generation changing between reservation and bootstrap.
          return { ...result, authorityGeneration: result.authorityGeneration + 1 };
        });
      restore = () => spy.mockRestore();
    });
    try {
      await expect(new AgentCommunicationService(TEST_ENV, input).start({
        name: "Researcher", description: "Compare deployments", message: "Compare deployments.", attachmentIds: [],
      }, {
        workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
        toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "workstream_runtime_bootstrap_fenced" });
    } finally {
      restore();
    }
  });

  it("admits an ordinary agent exchange once and wakes a model with its sender and reply reference", async () => {
    const recipientAgentId = agentIdForAddress({ parentKind: "workstream", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const senderAgentId = agentIdForAddress({ parentKind: "automation", parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") });
    const messageId = crypto.randomUUID();
    const request = {
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, messageId,
      clientMessageId: `agent-message:${messageId}`, recipientAgentId,
      text: "Research is ready; compare the two approaches.",
      agentExchange: { teamId: recipientAgentId, senderAgentId, messageId },
      attachmentIds: [], executionPrincipal: { type: "user" as const, userId: AUTHOR_ID },
      origin: "agent_message" as const, now: Date.now(),
    };
    expect(await roomConversation().admitAgentMessage(request)).toEqual({ accepted: true, messageId });
    expect(await roomConversation().admitAgentMessage(request)).toEqual({ accepted: true, messageId });
    const [run] = await settledRun(roomConversation());
    expect(run).toMatchObject({ status: "completed", error_json: null });
    const asked = provider.calls.find((call) => JSON.stringify(call.messages).includes(request.text));
    expect(asked).toBeDefined();
    // The model reads a Sidekick's id as `sidekick/…`; storage keeps `automation/…`.
    expect(JSON.stringify(asked!.messages)).toContain(`Message from agent sidekick/${AUTOMATION_ID}/0.`);
    expect(JSON.stringify(asked!.messages)).toContain(messageId);
    await runInDurableObject(roomConversation(), (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM canonical_conversation_turn_details WHERE client_message_id = ?", request.clientMessageId,
      ).one().n).toBe(1);
      const context = state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id,
      ).one();
      expect(JSON.parse(context.execution_context_json).agentExchange).toEqual(request.agentExchange);
    });
  });

  it("keeps the receiver's inherited principal when another principal sends a continuation", async () => {
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    await roomConversation().initializeBackgroundAgent({ executionPrincipal: principal, rootSubstreamId: asSubstreamId("0") });
    const recipientAgentId = agentIdForAddress({ parentKind: "workstream", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const senderAgentId = agentIdForAddress({ parentKind: "automation", parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") });
    const messageId = crypto.randomUUID();
    expect(await roomConversation().admitAgentMessage({
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, messageId, clientMessageId: `agent-message:${messageId}`,
      recipientAgentId, text: "Continue with your existing tools", agentExchange: { teamId: recipientAgentId, senderAgentId, messageId },
      attachmentIds: [], executionPrincipal: { type: "user", userId: asUserId(crypto.randomUUID()) },
      origin: "agent_message", now: Date.now(),
    })).toEqual({ accepted: true, messageId });
    const [run] = await settledRun(roomConversation());
    expect(run).toMatchObject({ status: "completed", error_json: null });
    const actual = await runInDurableObject(roomConversation(), (_instance, state) => JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs ORDER BY started_at DESC LIMIT 1",
      ).one().execution_context_json,
    ).executionPrincipal);
    expect(actual).toEqual(principal);
  });

  it("follows the Channel's directory row when that row says archived", async () => {
    const childId = asSubstreamId(crypto.randomUUID());
    // Only the directory row: every sidebar and search reader trusts it, so
    // the parent's own gate has to agree with it.
    await runInDurableObject(roomParent(), (_instance, state) => {
      state.storage.sql.exec("UPDATE channels SET archived_at = ? WHERE workstream_id = ?", Date.now(), ROOM_ID);
      // The parent's identity row is untouched and still there, so nothing
      // but the directory row can be what refuses the reservation below.
      expect(state.storage.sql.exec("SELECT 1 FROM parent_metadata WHERE parent_id = ?", ROOM_ID).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec<{ archived_at: number | null }>(
        "SELECT archived_at FROM channels WHERE workstream_id = ?", ROOM_ID,
      ).one().archived_at).not.toBeNull();
    });
    await expect(Promise.resolve(roomParent().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: childId, createdByUserId: AUTHOR_ID,
      kind: "child", authorityGeneration: 1,
    }))).rejects.toThrow("workstream_archived");
    const registered = await runInDurableObject(roomParent(), (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM parent_children WHERE parent_id = ? AND substream_id = ?", ROOM_ID, childId).one().n);
    expect(registered).toBe(0);
  });

  it("refuses child reservation after archival without registering the child", async () => {
    const childId = asSubstreamId(crypto.randomUUID());
    await runInDurableObject(roomParent(), (_instance, state) => {
      state.storage.sql.exec("UPDATE channels SET archived_at = ? WHERE workstream_id = ?", Date.now(), ROOM_ID);
    });
    await expect(Promise.resolve(roomParent().reserveAgentChild({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: childId, createdByUserId: AUTHOR_ID,
    }))).rejects.toThrow("workstream_archived");
    await expect(Promise.resolve(roomParent().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: childId, createdByUserId: AUTHOR_ID,
      kind: "child", authorityGeneration: 1,
    }))).rejects.toThrow("workstream_archived");
    const registered = await runInDurableObject(roomParent(), (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM parent_children WHERE parent_id = ? AND substream_id = ?", ROOM_ID, childId).one().n);
    expect(registered).toBe(0);
  });

  it.each(["deleted"] as const)("refuses child reservation for a %s Sidekick", async (reason) => {
    const childId = asSubstreamId(crypto.randomUUID());
    await runInDurableObject(sidekickHost(), (_instance, state) => {
      if (reason === "deleted") state.storage.sql.exec("UPDATE automation_directory SET lifecycle = 'deleted' WHERE automation_id = ?", AUTOMATION_ID);
      else state.storage.sql.exec("UPDATE automation_directory SET owning_room_archived_at = ? WHERE automation_id = ?", Date.now(), AUTOMATION_ID);
    });
    await expect(Promise.resolve(sidekickHost().reserveAgentChild({
      workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, substreamId: childId, createdByUserId: AUTHOR_ID,
    }))).rejects.toThrow("workstream_archived");
    await expect(Promise.resolve(sidekickHost().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, substreamId: childId, createdByUserId: AUTHOR_ID,
      kind: "child", authorityGeneration: 1,
    }))).rejects.toThrow("workstream_archived");
    const registered = await runInDurableObject(sidekickHost(), (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sidekick_children WHERE sidekick_id = ? AND substream_id = ?", AUTOMATION_ID, childId).one().n);
    expect(registered).toBe(0);
  });

  it("refuses an agent message when the parent is archived even before the child's projection catches up", async () => {
    const recipientAgentId = agentIdForAddress({ parentKind: "workstream", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const senderAgentId = agentIdForAddress({ parentKind: "automation", parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") });
    await runInDurableObject(roomParent(), (_instance, state) => {
      state.storage.sql.exec("UPDATE channels SET archived_at = ? WHERE workstream_id = ?", Date.now(), ROOM_ID);
    });
    const messageId = crypto.randomUUID();
    expect(await roomConversation().admitAgentMessage({
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, messageId, clientMessageId: `agent-message:${messageId}`,
      recipientAgentId, text: "Continue the work", agentExchange: { teamId: recipientAgentId, senderAgentId, messageId },
      attachmentIds: [], executionPrincipal: { type: "user", userId: AUTHOR_ID }, origin: "agent_message", now: Date.now(),
    })).toEqual({ accepted: false, code: "workstream_archived" });
    await runInDurableObject(roomConversation(), (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_loop_input_mailbox").one().n).toBe(0);
    });
  });

});
