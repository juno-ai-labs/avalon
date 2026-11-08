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
  WorkstreamDirectoryUserEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
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
async function mention(parentKind: "canvas" | "automation", parentId: string, clientMessageId: string,
  confirmedParticipantUserIds: string[] = []): Promise<void> {
  const response = await conversation(parentId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create_message", parentKind, auth: auth(AUTHOR), input: {
      text: "@Robin please review the plan", clientMessageId, confirmedParticipantUserIds, attachmentIds: [],
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

/** The newest attention ordinal of a parent's main conversation. */
async function latestOrdinal(parentId: string): Promise<number> {
  return runInDurableObject(conversation(parentId), (_instance, state) => state.storage.sql.exec<{ next: number }>(
    `SELECT next_attention_ordinal AS next FROM workstream WHERE id = 1`).one().next - 1);
}

/** The recipient reads the Chat through its newest message, by the route's own acknowledge operation. */
async function readThroughLatest(canvasId: string, parentKind: "canvas" | "automation" = "canvas"): Promise<void> {
  const latest = await latestOrdinal(canvasId);
  const response = await conversation(canvasId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "acknowledge_read", parentKind, auth: auth(RECIPIENT), input: {
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
    const mentioned = delivered.find((envelope) => envelope.effect.kind === "mention_notification")?.effect;
    expect(mentioned?.kind).toBe("mention_notification");
    const { messageId: turnId, transcriptSequence } = mentioned as { messageId: string; transcriptSequence?: number };
    // The conversation names the turn's place in its transcript, which opening the Chat at it needs.
    expect(transcriptSequence).toBeGreaterThan(0);

    await expect.poll(() => activityPushes(recipient.frames).at(-1)).toMatchObject({
      unseenCount: 1,
      items: [{
        id: `mention:${turnId}:${RECIPIENT}`, kind: "mention", parentKind: "canvas", parentId: canvasId,
        parentTitle: "Launch plan", substreamId: "0", messageId: turnId, messageSequence: transcriptSequence, runId: null,
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

  it("sends nothing about a mention in a Canvas its person cannot open, and lists it once they can", async () => {
    // Only its creator may open it: the confirmed mention seats nobody.
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR, title: "Private plan" });
    await mention("canvas", canvasId, "activity-private-1", [RECIPIENT]);
    await deliverChildEffects(TEST_ENV, conversation(canvasId));
    await runInDurableObject(workspace(), (_instance, state) => expect(state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workspace_activity_items WHERE recipient_user_id = ?`, RECIPIENT).one().n).toBe(1));
    expect(await openedActivity(RECIPIENT)).toEqual({ waterline: expect.any(Number), unseenCount: 0, items: [] });

    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: AUTHOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [RECIPIENT] } });
    expect(await openedActivity(RECIPIENT)).toMatchObject({ unseenCount: 1, items: [{
      kind: "mention", parentId: canvasId, parentTitle: "Private plan", preview: "@Robin please review the plan", seen: false,
    }] });
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
        substreamId: "0", messageId: null, messageSequence: null, runId: null, actor: { kind: "person", id: AUTHOR }, preview: null, seen: false,
      }],
    });

    recipient.socket.send(JSON.stringify({ type: "activity_mark_all_seen" }));
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "participant_added", seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("tells the requester and the Sidekick's manager a run needs input, and only the requester that one finished", async () => {
    const automationId = await activeSidekick();
    const asking = "00000000-0000-7000-8000-0000000ac101";
    const finishing = "00000000-0000-7000-8000-0000000ac102";
    await requestedRuns(automationId, [asking, finishing]);
    await finishRun(automationId, asking, "needs_input");
    await finishRun(automationId, finishing, "completed");
    // The notices are recorded by the Sidekick's own alarm; a socket opened after reads them in its subscribe answer.
    await expect.poll(async () => {
      const activity = await openedActivity(RECIPIENT);
      // The two alarm entries run in either order; the page is newest first.
      return activity && { ...activity, items: [...activity.items].sort((a, b) => String(a.kind).localeCompare(String(b.kind))) };
    }, { timeout: RUN_SETTLE_TIMEOUT_MS }).toMatchObject({
      unseenCount: 2, items: [runItem(automationId, "needs_input", asking), runItem(automationId, "run_finished", finishing)],
    });
    expect(await openedActivity(AUTHOR)).toMatchObject({ unseenCount: 1, items: [runItem(automationId, "needs_input", asking)] });
  });

  it("clears a Needs input row once its run is answered and working again, and sends the list again", async () => {
    const automationId = await activeSidekick();
    const asking = "00000000-0000-7000-8000-0000000ac1a1";
    await requestedRuns(automationId, [asking]);
    await finishRun(automationId, asking, "needs_input");
    await expect.poll(() => openedActivity(RECIPIENT), { timeout: RUN_SETTLE_TIMEOUT_MS })
      .toMatchObject({ unseenCount: 1, items: [runItem(automationId, "needs_input", asking)] });
    const recipient = await connect(RECIPIENT);
    // Answered in the run's own view: the run's conversation reports it working again, and "0" is never read.
    const working = WorkstreamDirectoryCommonEffectSchema.parse({
      kind: "directory_common", title: "Release notes", description: "", preview: "Thanks, carrying on.",
      scope: "workspace", state: "running", systemKind: null, lastActivityAt: NOW, completedAt: null, archivedAt: null,
    });
    await workspace().receiveChildEffects({ substreamId: asSubstreamId(asking), envelopes: [
      envelope("automation", automationId, asking, `answered:${asking}`, working, 3, null)] });
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "needs_input", runId: asking, seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("clears a finished run on a read report at the same cursor, and sends the list again", async () => {
    const automationId = await activeSidekick();
    // The requester has read the shared conversation as far as it goes before the run finishes.
    await readSidekick(automationId, 1, 0);
    const finishing = "00000000-0000-7000-8000-0000000ac103";
    await requestedRuns(automationId, [finishing]);
    await finishRun(automationId, finishing, "completed");
    await expect.poll(() => openedActivity(RECIPIENT), { timeout: RUN_SETTLE_TIMEOUT_MS })
      .toMatchObject({ unseenCount: 1, items: [runItem(automationId, "run_finished", finishing)] });
    const recipient = await connect(RECIPIENT);
    // They open the Sidekick: its read report names the same cursor as before.
    await readSidekick(automationId, 2, 0);
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "run_finished", seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("clears a finished run when its requester reopens the shared conversation at the cursor they had already read", async () => {
    const automationId = await activeSidekick();
    await new ConversationService(TEST_ENV, auth(RECIPIENT)).authorizeViewer(automationId);
    const finishing = "00000000-0000-7000-8000-0000000ac105";
    await requestedRuns(automationId, [finishing]);
    // Someone says something in the shared conversation, and the requester
    // reads through it there, by the conversation's own operation.
    const said = await conversation(automationId).fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", parentKind: "automation", auth: auth(AUTHOR), input: {
        text: "Morning, everyone.", clientMessageId: "activity-reopen-1", confirmedParticipantUserIds: [], attachmentIds: [], mentions: [],
      } }),
    });
    expect(said.status, await said.clone().text()).toBe(200);
    await deliverChildEffects(TEST_ENV, conversation(automationId));
    // The run's own row lands there too, by an alarm; the read comes after it.
    await expect.poll(() => latestOrdinal(automationId), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(2);
    await readThroughLatest(automationId, "automation");
    const cursor = await latestOrdinal(automationId);
    await finishRun(automationId, finishing, "completed");
    await expect.poll(() => openedActivity(RECIPIENT), { timeout: RUN_SETTLE_TIMEOUT_MS })
      .toMatchObject({ unseenCount: 1, items: [runItem(automationId, "run_finished", finishing)] });
    const recipient = await connect(RECIPIENT);
    // Reopened: the second report names the same cursor, and is still heard.
    expect(await latestOrdinal(automationId)).toBe(cursor);
    await readThroughLatest(automationId, "automation");
    await expect.poll(() => activityPushes(recipient.frames).at(-1))
      .toMatchObject({ unseenCount: 0, items: [{ kind: "run_finished", seen: true }] });
    recipient.socket.close(1000, "done");
  });

  it("keeps a finished run unseen for a requester whose report says they never read the shared conversation", async () => {
    const automationId = await activeSidekick();
    const finishing = "00000000-0000-7000-8000-0000000ac106";
    await requestedRuns(automationId, [finishing]);
    await finishRun(automationId, finishing, "completed");
    await expect.poll(() => openedActivity(RECIPIENT), { timeout: RUN_SETTLE_TIMEOUT_MS })
      .toMatchObject({ unseenCount: 1, items: [runItem(automationId, "run_finished", finishing)] });
    // Somebody else's message moves the requester's projection; they have never read it.
    await readSidekick(automationId, 1, 0, null);
    expect(await openedActivity(RECIPIENT)).toMatchObject({ unseenCount: 1, items: [{ kind: "run_finished", seen: false }] });
    // Their own read, at the same cursor, does clear it.
    await readSidekick(automationId, 2, 0, new Date().toISOString());
    expect(await openedActivity(RECIPIENT)).toMatchObject({ unseenCount: 0, items: [{ kind: "run_finished", seen: true }] });
  });

  it("keeps a mention in a run's conversation unseen however far the shared conversation is read", async () => {
    const automationId = await activeSidekick();
    const runId = "00000000-0000-7000-8000-0000000ac104";
    const effect = WorkstreamMentionNotificationEffectSchema.parse({
      kind: "mention_notification", substreamId: runId, intentId: `mention:run-turn:${RECIPIENT}`,
      messageId: "00000000-0000-7000-8000-0000000ac1e1", recipientUserId: RECIPIENT, authorUserId: AUTHOR,
      authorNameSnapshot: "Avery", workstreamTitleSnapshot: "Release notes", messageText: "@Robin look at this run",
      attentionOrdinal: 3, occurredAt: NOW,
    });
    await workspace().receiveChildEffects({ substreamId: asSubstreamId(runId), envelopes: [envelope(
      "automation", automationId, runId, `notification:${effect.intentId}`, effect, 1, 1)] });
    await readSidekick(automationId, 1, 40);
    expect(await openedActivity(RECIPIENT)).toMatchObject({
      unseenCount: 1, items: [{ kind: "mention", substreamId: runId, seen: false }],
    });
  });
});

/** One child's or the shared conversation's effect, as the consumer hands it to the parent. */
function envelope(parentKind: "canvas" | "automation", parentId: string, substreamId: string, messageId: string,
  effect: ConversationEffectEnvelope["effect"], sourceVersion: number, requiredProjectionVersion: number | null): ConversationEffectEnvelope {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
    parentKind, parentId, substreamId, generation: 1, messageId, partitionKey: `${parentId}:${substreamId}:${messageId}`,
    sourceVersion, requiredProjectionVersion, payloadHash: conversationEffectHash(effect), effect,
  });
}

/** An Organization-wide Sidekick, applied by its author. */
async function activeSidekick(): Promise<string> {
  const automationId = asAutomationId(crypto.randomUUID());
  await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR, scope: "workspace", automationId });
  await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId, draft: DEFINITION,
    evaluatorRules: null, submittedByRunId: null });
  await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
    workspaceId: WORKSPACE_ID, automationId, actor: { userId: AUTHOR, actorRole: "member", participantOfOwningWorkstream: false } }));
  return automationId;
}

/** Runs the recipient asked for, as the projection finds them working. */
async function requestedRuns(automationId: string, runIds: readonly string[]): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    for (const runId of runIds) {
      state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
          harness_run_id, state, summary, opening_json, run_as_user_id, coordinator_user_id, created_at, started_at,
          completed_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'running', NULL, NULL, ?, ?, 1, 1, NULL, 1)`,
        automationId, runId, `activity:${runId}`, JSON.stringify({ kind: "manual", requestedByUserId: RECIPIENT }),
        `${runId}-harness`, AUTHOR, AUTHOR);
    }
  });
}

/** The run's conversation reports the state it reached, through the parent's receipt path. */
async function finishRun(automationId: string, runId: string, state: string): Promise<void> {
  const effect = WorkstreamDirectoryCommonEffectSchema.parse({
    kind: "directory_common", title: "Release notes", description: "", preview: `Run ${runId} says hello`,
    scope: "workspace", state, systemKind: null, lastActivityAt: NOW, completedAt: NOW, archivedAt: null,
  });
  await workspace().receiveChildEffects({ substreamId: asSubstreamId(runId), envelopes: [
    envelope("automation", automationId, runId, `finish:${runId}:${state}`, effect, 2, null)] });
}

/** The recipient's read report on the Sidekick's shared conversation, as its conversation sends it. */
async function readSidekick(automationId: string, sourceVersion: number, seenAttentionOrdinal: number,
  lastReadAt?: string | null): Promise<void> {
  const effect = WorkstreamDirectoryUserEffectSchema.parse({
    kind: "directory_user", userId: RECIPIENT, isParticipant: true, unreadCount: 0, youAreMentioned: false, listable: true,
    seenAttentionOrdinal, ...(lastReadAt === undefined ? {} : { lastReadAt }),
  });
  await workspace().receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [
    envelope("automation", automationId, "0", `read:${RECIPIENT}:${sourceVersion}`, effect, sourceVersion, null)] });
}

/** The Activity a fresh socket for this person is opened with. */
async function openedActivity(userId: string): Promise<ActivityFrame | undefined> {
  const socket = await connect(userId);
  socket.socket.close(1000, "done");
  return subscribedActivity(socket.frames);
}

function runItem(automationId: string, kind: string, runId: string) {
  return {
    kind, parentKind: "automation", parentId: automationId, parentTitle: "Release notes", substreamId: runId,
    messageId: null, messageSequence: null, runId, actor: { kind: "sidekick", id: automationId }, preview: `Run ${runId} says hello`, seen: false,
  };
}

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
