/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Narrowing who may open a Canvas or a Sidekick closes the open conversation
 * feed of everyone it took away, and of nobody else. The conversation object
 * authorized each socket when it connected and cannot see the audience move,
 * so the Organization object tells it through the access-revocation Queue;
 * this drives that Queue's real consumer by hand, hop by hop, against real
 * conversation objects holding real hibernatable sockets.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, type AutomationDraft } from "@rally/contracts";
import { EffectQueueMessageSchema } from "@rally/contracts/conversation-effects";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { consumeAccessRevocationQueue } from "../src/queues/access-revocation-consumer";
import { createAutomation } from "../src/services/automation-service";
import { createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cf000");
const OWNER = asUserId("00000000-0000-7000-8000-0000000cf001");
const REMOVED = asUserId("00000000-0000-7000-8000-0000000cf002");
const KEPT = asUserId("00000000-0000-7000-8000-0000000cf003");
const NOW = "2026-11-07T10:00:00.000Z";
const TEST_ENV: Env = env;
useHeldEffectQueue();
useOpenRouterDouble(() => ({ say: "Noted." }));
useSelectedModel();

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

function conversation(parentId: string): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, asSubstreamId("0"))));
}

/** A reader's feed socket on a parent's shared conversation, admitted the way the Worker forwards it. */
async function openFeed(parentId: string, userId: string): Promise<{ socket: WebSocket; closed: Promise<CloseEvent> }> {
  await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(parentId);
  const response = await conversation(parentId).fetch("https://substream.test/socket", { headers: {
    Upgrade: "websocket",
    "x-rally-workspace-id": WORKSPACE_ID,
    "x-rally-workstream-id": parentId,
    "x-rally-substream-id": "0",
    "x-rally-user-id": userId,
    "x-rally-session-id": `session-${userId}`,
    "x-rally-socket-ticket-id": crypto.randomUUID(),
    "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    "x-rally-socket-after-sequence": "0",
  } });
  expect(response.status, response.status === 101 ? "" : await response.text()).toBe(101);
  const socket = response.webSocket!;
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  socket.accept();
  return { socket, closed };
}

/** Every access-revocation message published while `run` ran. */
async function publishedRevocations(run: () => Promise<unknown>): Promise<unknown[]> {
  const bodies: unknown[] = [];
  const queue = env.ACCESS_REVOCATION_QUEUE;
  // Accepted, as a Queue with room answers: the consumer below is the delivery.
  const accepted = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  vi.spyOn(queue, "send").mockImplementation(async (body: unknown) => { bodies.push(body); return accepted; });
  // `useHeldEffectQueue` already spied `sendBatch` on the binding prototype,
  // and `vi.spyOn` reuses that spy, so this implementation also answers the
  // Activity Queue's sends from every object in the isolate. A conversation
  // object's drain alarm firing inside this window (seen under a loaded full
  // suite) would otherwise be recorded as a revocation hop; it is held, as
  // that helper holds it.
  vi.spyOn(queue, "sendBatch").mockImplementation(async (messages: Iterable<MessageSendRequest<unknown>>) => {
    const batch = [...messages];
    if (batch.some((message) => EffectQueueMessageSchema.safeParse(message.body).success)) {
      throw new Error("effect_queue_held_by_test");
    }
    for (const message of batch) bodies.push(message.body);
    return accepted;
  });
  await run();
  return bodies;
}

/** Hand each published hop to the real consumer, and the hops it publishes in turn, until none is left. */
async function drain(bodies: unknown[]): Promise<void> {
  let pending = bodies;
  while (pending.length > 0) {
    const next = await publishedRevocations(async () => {
      const batch = createMessageBatch("avalon-do-runtime-test-access-revocations",
        pending.map((body) => ({ id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1 })));
      await consumeAccessRevocationQueue(batch, env);
      expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    });
    pending = next;
  }
}

/** Sockets the conversation object still holds, by reader. */
async function heldBy(parentId: string): Promise<string[]> {
  return runInDurableObject(conversation(parentId), (_instance, state) => state.getWebSockets()
    .map((socket) => (socket.deserializeAttachment() as { userId: string }).userId).sort());
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: OWNER, sessionId: `session-${OWNER}` });
  await env.DB.batch([
    ...[REMOVED, KEPT].flatMap((userId) => [
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
        VALUES (?, ?, 'Reader', NULL, 'UTC', ?)`).bind(userId, `${userId}@example.com`, NOW),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID),
    ]),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
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
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("narrowing a conversation's audience", () => {
  it("closes the open Chat feed of a person a Canvas stopped admitting, and keeps the rest", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: OWNER, title: "Launch plan" });
    const share = (userIds: string[]) => workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId,
      actor: { userId: OWNER, actorRole: "member" }, update: { visibility: "participants", userIds } });
    await share([REMOVED, KEPT]);
    const removed = await openFeed(canvasId, REMOVED);
    const kept = await openFeed(canvasId, KEPT);

    const hops = await publishedRevocations(() => share([KEPT]));
    expect(hops).toEqual([expect.objectContaining({
      kind: "access_revoked", reason: "workstream_participant_removed", workspaceId: WORKSPACE_ID,
      userId: REMOVED, sessionId: null, target: { scope: "substream", workstreamId: canvasId, substreamId: "0" },
    })]);
    await drain(hops);

    expect((await removed.closed).code).toBe(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE);
    expect(kept.socket.readyState).toBe(WebSocket.OPEN);
    expect(await heldBy(canvasId)).toEqual([KEPT]);
    kept.socket.close(1000, "test complete");
  });

  it("closes the open feed of a member an Organization-wide Sidekick stopped admitting, and keeps its list", async () => {
    const automationId = asAutomationId(crypto.randomUUID());
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: OWNER, scope: "workspace", automationId });
    await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId, draft: DEFINITION,
      evaluatorRules: null, submittedByRunId: null });
    const actor = { userId: OWNER, actorRole: "member" as const, participantOfOwningWorkstream: false };
    await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({ workspaceId: WORKSPACE_ID, automationId, actor }));
    const removed = await openFeed(automationId, REMOVED);
    const kept = await openFeed(automationId, KEPT);

    const hops = await publishedRevocations(() => runInDurableObject(workspace(), (instance: WorkspaceDO) =>
      instance.sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId, actor, update: { audience: "people", userIds: [KEPT] } })));
    expect(hops).toEqual([expect.objectContaining({
      kind: "access_revoked", reason: "workstream_participant_removed", userId: REMOVED, sessionId: null,
      target: { scope: "automation", automationId },
    })]);
    await drain(hops);

    expect((await removed.closed).code).toBe(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE);
    expect(kept.socket.readyState).toBe(WebSocket.OPEN);
    expect(await heldBy(automationId)).toEqual([KEPT]);
    kept.socket.close(1000, "test complete");
  });
});

const DEFINITION: AutomationDraft = {
  name: "Release notes",
  description: "Answers questions about releases",
  overview: "Answers questions about releases",
  instructions: "Answer the question you were asked about releases.",
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
