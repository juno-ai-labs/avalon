/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Each person's Activity, on real workerd: a mention in a Canvas's Chat, an
 * add, and a Sidekick run's two notices each write one row for its recipient
 * in the transaction that records the push intent, the row reaches only that
 * person's workspace sockets as `workspace_activity_list`, and the subscribe
 * answer carries the page. Seen is derived: a read of the conversation past
 * the item clears it with no Activity command, and Mark all seen clears the
 * rest. `docs/activity.md` owns the model.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, type AutomationDraft } from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ac000");
const AUTHOR = asUserId("00000000-0000-7000-8000-0000000ac001");
const RECIPIENT = asUserId("00000000-0000-7000-8000-0000000ac002");
const NOW = "2026-11-08T10:00:00.000Z";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 15_000;
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

type Frame = Record<string, unknown> & { type?: string };
type ActivityFrame = { waterline: number; unseenCount: number; items: Array<Record<string, unknown>> };

/** A workspace socket for this person, subscribed; every frame it receives is kept. */
async function connect(userId: string) {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `session-${userId}`,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const frames: Frame[] = [];
  let pongs = 0;
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") {
        pongs += 1;
        return;
      }
      const frame = JSON.parse(String(event.data)) as Frame;
      frames.push(frame);
      if (frame.type === "workspace_sync") resolve();
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  /** Everything sent before now has arrived once a ping's answer has. */
  const drained = async (): Promise<void> => {
    const before = pongs;
    socket.send("ping");
    await expect.poll(() => pongs).toBeGreaterThan(before);
  };
  return { socket, frames, drained };
}

/** The Activity a socket was opened with. */
function subscribedActivity(frames: Frame[]): ActivityFrame | undefined {
  const sync = frames.find((frame) => frame.type === "workspace_sync") as { sidebar?: { activity?: ActivityFrame } };
  return sync.sidebar?.activity;
}

/** Every Activity push a socket received. */
function activityPushes(frames: Frame[]): ActivityFrame[] {
  return frames.filter((frame) => frame.type === "workspace_activity_list") as unknown as ActivityFrame[];
}

/** The author's message mentioning the recipient, sent the way the Worker sends it. */
async function mention(parentKind: "canvas" | "automation", parentId: string, clientMessageId: string): Promise<void> {
  const response = await conversation(parentId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create_message", parentKind, auth: auth(AUTHOR), input: {
      text: "@Robin please review the plan", clientMessageId, confirmedParticipantUserIds: [], attachmentIds: [],
      mentions: [{ type: "person", userId: RECIPIENT, connectorType: null, displayName: "Robin", startOffset: 0, endOffset: 6 }],
    } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await runDurableObjectAlarm(conversation(parentId));
}

/** A Canvas both people may open, each seated the way the conversation route seats them. */
async function sharedCanvas(): Promise<string> {
  const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR, title: "Launch plan" });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: AUTHOR, actorRole: "member" },
    update: { visibility: "participants", userIds: [RECIPIENT] } });
  for (const userId of [AUTHOR, RECIPIENT]) await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(canvasId);
  return canvasId;
}

/** The recipient reads the Chat through its newest message, by the route's own acknowledge operation. */
async function readThroughLatest(canvasId: string): Promise<void> {
  const latest = await runInDurableObject(conversation(canvasId), (_instance, state) => state.storage.sql.exec<{ next: number }>(
    `SELECT next_attention_ordinal AS next FROM workstream WHERE id = 1`).one().next - 1);
  const response = await conversation(canvasId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "acknowledge_read", parentKind: "canvas", auth: auth(RECIPIENT), input: {
      readThroughSequenceNumber: latest, observedManualUnreadGeneration: 0, entrypoint: "direct",
    } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await deliverChildEffects(TEST_ENV, conversation(canvasId));
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR, sessionId: `session-${AUTHOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT`),
    env.DB.prepare(`UPDATE workspaces SET name = 'Activity' WHERE id = ?`).bind(WORKSPACE_ID),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(AUTHOR),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'robin@example.com', 'Robin', NULL, 'UTC', ?)`).bind(RECIPIENT, NOW),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, RECIPIENT, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${RECIPIENT}`, RECIPIENT, WORKSPACE_ID),
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

describe("a person's Activity", () => {
  it("records a Canvas Chat mention for the mentioned person and sends it to their sockets only", async () => {
    const canvasId = await sharedCanvas();
    const author = await connect(AUTHOR);
    const recipient = await connect(RECIPIENT);
    expect(subscribedActivity(recipient.frames)).toMatchObject({ unseenCount: 0, items: [] });
    await mention("canvas", canvasId, "activity-mention-1");
    const delivered = await deliverChildEffects(TEST_ENV, conversation(canvasId));
    const messageId = delivered.find((envelope) => envelope.effect.kind === "mention_notification")?.effect;
    expect(messageId?.kind).toBe("mention_notification");
    const turnId = (messageId as { messageId: string }).messageId;

    await expect.poll(() => activityPushes(recipient.frames).at(-1)).toMatchObject({
      unseenCount: 1,
      items: [{
        id: `mention:${turnId}:${RECIPIENT}`, kind: "mention", parentKind: "canvas", parentId: canvasId,
        parentTitle: "Launch plan", substreamId: "0", messageId: turnId, runId: null,
        actor: { kind: "person", id: AUTHOR }, preview: "@Robin please review the plan",
        createdAt: expect.any(String), seen: false,
      }],
    });
    await author.drained();
    expect(activityPushes(author.frames)).toEqual([]);
    // A redelivery is answered by the receipts: still one row.
    await runInDurableObject(workspace(), (_instance, state) => expect(state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workspace_activity_items`).one().n).toBe(1));
    for (const { socket } of [author, recipient]) socket.close(1000, "done");
  });

  it("clears a mention when its reader reads the Chat past it, with no Activity command", async () => {
    const canvasId = await sharedCanvas();
    await mention("canvas", canvasId, "activity-mention-2");
    await deliverChildEffects(TEST_ENV, conversation(canvasId));
    const recipient = await connect(RECIPIENT);
    expect(subscribedActivity(recipient.frames)).toMatchObject({ unseenCount: 1, items: [{ kind: "mention", seen: false }] });

    await readThroughLatest(canvasId);
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "mention", seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("records being added to a Canvas, and clears everything on Mark all seen", async () => {
    const canvasId = await sharedCanvas();
    const effect = WorkstreamParticipantNotificationEffectSchema.parse({
      kind: "participant_notification", intentId: `added:${canvasId}:${RECIPIENT}`, sourceId: `added:${canvasId}`,
      recipientUserId: RECIPIENT, actorUserId: AUTHOR, actorNameSnapshot: "Avery", workstreamTitleSnapshot: "Launch plan",
      workstreamObjectiveSnapshot: "", occurredAt: NOW,
    });
    const envelope: ConversationEffectEnvelope = ConversationEffectEnvelopeSchema.parse({
      kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "canvas", parentId: canvasId, substreamId: "0", generation: 1,
      messageId: `notification:${effect.intentId}`, partitionKey: `notification:${effect.intentId}`, sourceVersion: 1,
      requiredProjectionVersion: 1, payloadHash: conversationEffectHash(effect), effect,
    });
    const recipient = await connect(RECIPIENT);
    await workspace().receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [envelope] });
    await expect.poll(() => activityPushes(recipient.frames).at(-1)).toMatchObject({
      unseenCount: 1,
      items: [{
        id: effect.intentId, kind: "participant_added", parentKind: "canvas", parentId: canvasId, parentTitle: "Launch plan",
        substreamId: "0", messageId: null, runId: null, actor: { kind: "person", id: AUTHOR }, preview: null, seen: false,
      }],
    });

    recipient.socket.send(JSON.stringify({ type: "activity_mark_all_seen" }));
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "participant_added", seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("tells the requester and the Sidekick's manager a run needs input, and only the requester that one finished", async () => {
    const automationId = asAutomationId(crypto.randomUUID());
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR, scope: "workspace", automationId });
    await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId, draft: DEFINITION,
      evaluatorRules: null, submittedByRunId: null });
    await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
      workspaceId: WORKSPACE_ID, automationId, actor: { userId: AUTHOR, actorRole: "member", participantOfOwningWorkstream: false } }));
    const asking = "00000000-0000-7000-8000-0000000ac101";
    const finishing = "00000000-0000-7000-8000-0000000ac102";
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const runId of [asking, finishing]) {
        state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
            harness_run_id, state, summary, opening_json, seed_json, run_as_user_id, coordinator_user_id, created_at, started_at,
            completed_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, 'running', NULL, NULL, NULL, ?, ?, 1, 1, NULL, 1)`,
          automationId, runId, `activity:${runId}`, JSON.stringify({ kind: "manual", requestedByUserId: RECIPIENT }),
          `${runId}-harness`, AUTHOR, AUTHOR);
      }
    });
    for (const [runId, state] of [[asking, "needs_input"], [finishing, "completed"]] as const) {
      const effect = WorkstreamDirectoryCommonEffectSchema.parse({
        kind: "directory_common", title: "Release notes", description: "", preview: `Run ${runId} says hello`,
        scope: "workspace", state, systemKind: null, lastActivityAt: NOW, completedAt: NOW, archivedAt: null,
      });
      await workspace().receiveChildEffects({ substreamId: asSubstreamId(runId), envelopes: [ConversationEffectEnvelopeSchema.parse({
        kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "automation", parentId: automationId, substreamId: runId, generation: 1,
        messageId: `finish:${runId}:${state}`, partitionKey: `${automationId}:${runId}`, sourceVersion: 2,
        requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect,
      })] });
    }
    const item = (kind: string, runId: string) => ({
      kind, parentKind: "automation", parentId: automationId, parentTitle: "Release notes", substreamId: runId,
      messageId: null, runId, actor: { kind: "sidekick", id: automationId }, preview: `Run ${runId} says hello`, seen: false,
    });
    // The notices are recorded by the Sidekick's own alarm; a socket opened after reads them in its subscribe answer.
    await expect.poll(async () => {
      const recipient = await connect(RECIPIENT);
      recipient.socket.close(1000, "done");
      const activity = subscribedActivity(recipient.frames);
      // The two alarm entries run in either order; the page is newest first.
      return activity && { ...activity, items: [...activity.items].sort((a, b) => String(a.kind).localeCompare(String(b.kind))) };
    }, { timeout: RUN_SETTLE_TIMEOUT_MS }).toMatchObject({
      unseenCount: 2, items: [item("needs_input", asking), item("run_finished", finishing)],
    });
    const manager = await connect(AUTHOR);
    expect(subscribedActivity(manager.frames)).toMatchObject({ unseenCount: 1, items: [item("needs_input", asking)] });
    manager.socket.close(1000, "done");
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
