import { AgentCommunicationService } from "../src/services/agent-communication-service";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The one way a run reaches the room that owns its automation.
 *
 * `sidekick_post_result` is a tool the run holds, offered only to a run of a
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
  agentIdForAddress,
  agentAddressForId,
  WorkstreamWorkflowInputSchema,
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
import { attachWorkstreamRuntimeResource } from "../src/services/workstream-object-client";
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
let heldBackgroundModel: Promise<void> | null = null;
const provider = useOpenRouterDouble(async (call) => {
  const latestInput = call.messages.filter((message) => message.role === "user").at(-1);
  if (heldBackgroundModel && JSON.stringify(latestInput?.content ?? "").includes("HOLD_BACKGROUND")) await heldBackgroundModel;
  if (JSON.stringify(latestInput?.content ?? "").includes("DELEGATE_FROM_MODEL")) {
    if (call.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("agentId"))) {
      return { say: "Research is running; I am available here." };
    }
    const start = call.toolNames.find((name) => name.endsWith("start_agent"));
    if (start) return { callTool: { name: start, arguments: { name: "Model-created researcher",
      description: "Compare the options independently", message: "HOLD_BACKGROUND: compare these options" } } };
    const load = call.toolNames.find((name) => name.endsWith("load_plugin"));
    if (!load) throw new Error("agent_plugin_loader_missing");
    return { callTool: { name: load, arguments: { pluginId: "rally_agents" } } };
  }
  if (JSON.stringify(latestInput?.content ?? "").includes("NO_REPLY_REQUIRED")) {
    const endTurn = call.toolNames.find((name) => name.endsWith("end_turn"));
    if (endTurn) return { callTool: { name: endTurn, arguments: {}, text: "No further response is needed." } };
    const load = call.toolNames.find((name) => name.endsWith("load_plugin"));
    if (!load) throw new Error("agent_plugin_loader_missing");
    return { callTool: { name: load, arguments: { pluginId: "rally_agents" } } };
  }
  const tool = call.toolNames.find((name) => name.endsWith("sidekick_post_result"));
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
  heldBackgroundModel = null;
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

describe("sidekick_post_result", () => {
  it("delegates through a real Bind tool receipt and answers another message before the worker finishes", async () => {
    let release = () => {};
    heldBackgroundModel = new Promise<void>((resolve) => { release = resolve; });
    try {
      const response = await post(roomConversation(), "/internal/product", { operation: "create_message", auth: AUTH,
        input: { text: "DELEGATE_FROM_MODEL: research this, and stay available. PRIVATE_PARENT_DETAIL",
          clientMessageId: crypto.randomUUID(), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } });
      expect(response.status).toBe(200);
      expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed", error_json: null });
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

  it("ends through Bind without an automatic reply and continues on a later message", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Quiet teammate", description: "Wait for a useful request",
      message: "NO_REPLY_REQUIRED: no further action is needed.", attachmentIds: [] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    expect(run).toMatchObject({ status: "completed", error_json: null });
    await expect.poll(() => runInDurableObject(child, (_instance, state) => state.storage.sql.exec<{ settled: number }>(
      "SELECT external_settled_at IS NOT NULL AS settled FROM runs WHERE run_id = ?", run!.run_id,
    ).one().settled), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
    expect(await runInDurableObject(roomConversation(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs",
    ).one().n)).toBe(0);
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "idle" });
    await service.send({ agentId: started.agentId, message: "Now send a useful result.", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() });
    expect((await settledRun(child, 2))[1]).toMatchObject({ status: "completed" });
    expect((await settledRun(roomConversation()))[0]).toMatchObject({ status: "completed" });
  });

  it("forwards an existing attachment into the worker's canonical message and reply", async () => {
    const resourceId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
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
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    const started = await service.start({ name: "Attachment researcher", description: "Read the supplied resource",
      message: "Read the attached research.", attachmentIds: [resourceId, imageId] }, context);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    const childInput = await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ resource_id: string }>(
        "SELECT resource_id FROM participant_transcript_attachments ORDER BY position",
      ).toArray()).toEqual([{ resource_id: resourceId }, { resource_id: imageId }]);
      return WorkstreamWorkflowInputSchema.parse(JSON.parse(state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id,
      ).one().execution_context_json));
    });
    const reply = await new AgentCommunicationService(TEST_ENV, childInput).send({
      messageId: childInput.agentExchange!.messageId, message: "Here is the research.", attachmentIds: [resourceId, imageId],
    }, { ...context, effectIntentId: crypto.randomUUID() });
    await expect.poll(() => runInDurableObject(roomConversation(), (_instance, state) =>
      state.storage.sql.exec<{ resource_id: string }>(
        "SELECT resource_id FROM participant_transcript_attachments WHERE turn_id = ? ORDER BY position", reply.messageId,
      ).toArray()), { timeout: RUN_SETTLE_TIMEOUT_MS }).toEqual([{ resource_id: resourceId }, { resource_id: imageId }]);
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(resourceId))).toBe(true);
    expect(provider.calls.some((call) => call.messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes("Read the attached research.")
      && JSON.stringify(message.content).includes("ATTACHMENT MANIFEST")
      && JSON.stringify(message.content).includes("research.txt")))).toBe(true);
    expect(provider.calls.some((call) => call.messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes(`data:image/png;base64,${png}`)))).toBe(true);
    await expect(service.send({ agentId: started.agentId, message: "Read this too", attachmentIds: [crypto.randomUUID()] },
      { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("Attach the resource");
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
      const response = await roomParent().fetch("https://workstream.test/socket", { headers: {
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
      expect(frame.metadata.privateChildren).toEqual([]);
      release();
      await settledRun(child);
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

  it("starts a hidden independent agent idempotently and lists its name and description", async () => {
    const input = WorkstreamWorkflowInputSchema.parse({
      region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: ROOM_ID,
      substreamId: "0", loopId: `workstream:${ROOM_ID}:substream:0:loop`, harnessRunId: crypto.randomUUID(),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test",
    });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context = {
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal,
    };
    const args = { name: "Researcher", description: "Compare the deployment approaches", message: "Compare static and dynamic deployment.", attachmentIds: [] };
    const started = await service.start(args, context);
    expect(await service.start(args, context)).toEqual(started);
    const address = agentAddressForId(started.agentId);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, address.substreamId),
    ));
    const [run] = await settledRun(child);
    expect(run).toMatchObject({ status: "completed", error_json: null });
    expect(provider.calls.some((call) => JSON.stringify(call.messages).includes(args.message))).toBe(true);
    await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes(started.agentId)
      && JSON.stringify(call.messages).includes("Acknowledged.")), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await service.list()).toMatchObject({ agents: [{ agentId: started.agentId, name: args.name, description: args.description }] });
    expect(await child.agentRuntimeInfo()).toMatchObject({ background: true, executionPrincipal: input.executionPrincipal });
    expect(await roomParent().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: address.substreamId, userId: AUTHOR_ID })).toMatchObject({ authorized: false });
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'agent-message:%'").one().n).toBe(1);
    });
    await service.stop(started.agentId);
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
    expect(await service.start(args, context)).toEqual(started);
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
    await service.send({ agentId: started.agentId, message: "Now compare their pricing.", attachmentIds: [] },
      { ...context, toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID() });
    await settledRun(child, 2);
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "idle" });
    const childInput = await runInDurableObject(child, (_instance, state) => WorkstreamWorkflowInputSchema.parse(JSON.parse(
      state.storage.sql.exec<{ execution_context_json: string }>("SELECT execution_context_json FROM runs WHERE run_id = ?", run!.run_id).one().execution_context_json,
    )));
    const answer = "Static deployments cost less at this workload.";
    await new AgentCommunicationService(TEST_ENV, childInput).send({ messageId: childInput.agentExchange!.messageId,
      message: answer, attachmentIds: [] }, { ...context, effectIntentId: crypto.randomUUID() });
    await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes(answer)),
      { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
    const sidekicks = await service.sidekicks();
    expect(sidekicks.sidekicks[0]).toMatchObject({ sidekickId: AUTOMATION_ID, scope: "workstream", owningWorkstreamId: ROOM_ID });
    await service.send({ agentId: sidekicks.sidekicks[0]!.agentId, message: "Explain your current configuration.", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() });
    const authoring = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID)));
    await settledRun(authoring);
    expect((await service.list()).agents.some((agent) => agent.agentId === sidekicks.sidekicks[0]!.agentId)).toBe(true);
    expect((await workspaceStub().ownedAgentDescendants({ workspaceId: WORKSPACE_ID, agentId: service.senderId })).agentIds).not.toContain(sidekicks.sidekicks[0]!.agentId);
    const nested = await new AgentCommunicationService(TEST_ENV, childInput).start({ name: "Nested researcher",
      description: "Check one detail", message: "Check the cost assumption.", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() });
    const nestedAddress = agentAddressForId(nested.agentId);
    const grandchild = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, ROOM_ID, nestedAddress.substreamId),
    ));
    await settledRun(grandchild);
    await service.stop(started.agentId);
    expect(await grandchild.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
    expect(await authoring.agentRuntimeInfo()).toMatchObject({ background: false });
    const archived = await post(roomConversation(), "/internal/product", { operation: "update", auth: AUTH, input: { archived: true } });
    expect(archived.status).toBe(200);
    await deliverEffectsToWorkspace(TEST_ENV, roomConversation());
    expect(await child.agentRuntimeInfo()).toMatchObject({ status: "stopped" });
    await expect(service.send({ agentId: started.agentId, message: "Continue", attachmentIds: [] },
      { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("archived");


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
    expect(JSON.stringify(asked!.messages)).toContain(senderAgentId);
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

  it("refuses an agent message when the parent is archived even before the child's projection catches up", async () => {
    const recipientAgentId = agentIdForAddress({ parentKind: "workstream", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const senderAgentId = agentIdForAddress({ parentKind: "automation", parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") });
    await runInDurableObject(roomParent(), (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET archived_at = ?", Date.now());
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

  it("posts the run's result into the owning room's main conversation, once, and the room runs on it", async () => {
    const started = await automationStub().runNow({ ...addressed(), actor: manager(), idempotencyKey: "post-result-0001" });

    // The run child: provisioned by the run alarm, ends after the tool round trip.
    await runDurableObjectAlarm(automationStub());
    const [run] = await settledRun(runChild(started.runId));
    expect(run).toMatchObject({ status: "completed", error_json: null });
    const offered = provider.calls.filter((call) => call.toolNames.some((name) => name.endsWith("sidekick_post_result")));
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered[1]!.messages.some((message) => message.role === "tool")).toBe(true);

    // The room: the activation is its loop input, keyed by the run, and the
    // room's own loop ran on it.
    const [roomRun] = await settledRun(roomConversation());
    expect(roomRun).toMatchObject({ status: "completed", error_json: null });
    expect(await activationTurns()).toEqual([{ client_message_id: `automation-activation:${started.runId}` }]);
    // The activation is admitted as a system-actor pending input. It has to
    // leave that queue: a pending input the drain refuses stays first in line
    // and the room processes nothing after it.
    expect(await runInDurableObject(roomConversation(), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM pending_loop_inputs`).one().count,
    )).toBe(0);
    const acknowledged = provider.calls.filter((call) => !call.toolNames.some((name) => name.endsWith("sidekick_post_result")));
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
    expect(replay).toEqual({ outcome: "replayed", code: "sidekick_activation_replayed" });
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
    expect(appended).toEqual({ outcome: "appended", code: "sidekick_activation_appended" });
    // The wake is real: the room runs on it before this test lets go of it.
    const [roomRun] = await settledRun(roomConversation());
    expect(roomRun).toMatchObject({ status: "completed", error_json: null });
    expect(await activationTurns()).toEqual([{ client_message_id: `automation-activation:${STAGED_RUN_ID}` }]);
    await deliverChildEffects(TEST_ENV, roomConversation());
  });
});
