/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A person's reply in a Canvas's Chat, end to end on real workerd: the
 * conversation object emits one `new_message_notification` per message, the
 * real activity consumer hands it to the hosted parent, the parent adds it to
 * its conversation's `reply_batch` alarm entry, and the entry records one
 * `new_message` intent and one Activity row per recipient, which the push
 * consumer sends. Only the Apple transport is a double.
 * `docs/push-notifications.md` owns the rule.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { CONVERSATION_ALERT_COOLDOWN_MS, REPLY_BATCH_ALARM_KIND, REPLY_BATCH_SECONDS } from "../src/durable-objects/conversation-reply-batch";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000eb000");
const AUTHOR = asUserId("00000000-0000-7000-8000-0000000eb001");
const RECIPIENT = asUserId("00000000-0000-7000-8000-0000000eb002");
const MENTIONED = asUserId("00000000-0000-7000-8000-0000000eb003");
const NOW = "2026-11-08T10:00:00.000Z";
const TEST_ENV: Env = env;
useHeldEffectQueue();
useOpenRouterDouble(() => ({ say: "Noted." }));
useSelectedModel();

const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: "TARGETING_MATCH" }) } }).FLAGS!;
/** An environment that may send push, as `hosted-mention-notifications.test.ts` builds it. */
const pushEnv = () => ({
  ...env, FLAGS: flags, APP_ENV: "staging" as const, APNS_AUTH_KEY: "configured", APNS_KEY_ID: "configured",
  WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: { jurisdiction: () => env.WORKSPACE_DOS } }).WORKSPACE_DOS,
});

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

/** A message in the Chat, sent the way the Worker sends it, and its effects delivered through the real consumer. */
async function say(canvasId: string, userId: string, text: string, clientMessageId: string, mentions: string[] = []): Promise<void> {
  const response = await conversation(canvasId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create_message", parentKind: "canvas", auth: auth(userId), input: {
      text, clientMessageId, confirmedParticipantUserIds: [], attachmentIds: [],
      mentions: mentions.map((mentioned) => ({ type: "person", userId: mentioned, connectorType: null, displayName: "Sam", startOffset: 0, endOffset: 4 })),
    } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await runDurableObjectAlarm(conversation(canvasId));
  await deliverChildEffects(TEST_ENV, conversation(canvasId));
}

/** Run the conversation's open batch now, rather than waiting out `REPLY_BATCH_SECONDS`. */
async function sendBatch(): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE _internal_durable_alarms SET due_at = 0 WHERE kind = ?`, REPLY_BATCH_ALARM_KIND);
  });
  await runDurableObjectAlarm(workspace());
  await runInDurableObject(workspace(), (_instance, state) => expect(state.storage.sql.exec(
    `SELECT 1 FROM _internal_durable_alarms WHERE kind = ?`, REPLY_BATCH_ALARM_KIND).toArray()).toEqual([]));
}

type Intent = { intent_id: string; recipient_user_id: string; state: string; last_error_code: string | null };
async function replyIntents(): Promise<Intent[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<Intent>(
    `SELECT intent_id, recipient_user_id, state, last_error_code FROM workstream_notification_intents
      WHERE notification_kind = 'new_message' ORDER BY created_at, intent_id`).toArray());
}

type Item = { item_id: string; recipient_user_id: string; message_id: string; preview: string; actor_id: string };
async function replyItems(): Promise<Item[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<Item>(
    `SELECT item_id, recipient_user_id, message_id, preview, actor_id FROM workspace_activity_items
      WHERE kind = 'new_message' ORDER BY created_at, item_id`).toArray());
}

/** The id of the newest turn this person wrote, the message a reply notice is about. */
async function latestTurnBy(canvasId: string, userId: string): Promise<string> {
  return runInDurableObject(conversation(canvasId), (_instance, state) => state.storage.sql.exec<{ id: string }>(
    `SELECT id FROM canonical_conversation_turn_details WHERE author_user_id = ? ORDER BY sequence_number DESC LIMIT 1`, userId).one().id);
}

/** The alert the push consumer sends for this intent. */
async function alertFor(intentId: string): Promise<{ title: string; body: string }[]> {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
  expect(await deliverPush(pushEnv(), { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: RECIPIENT, intentId }, send)).toBe(true);
  return send.mock.calls.map((call) => JSON.parse(((call as unknown[])[2] as PushPayloads).apns) as { aps: { alert: { title: string; body: string } } })
    .map((payload) => payload.aps.alert);
}

/** The Activity this person's workspace socket is opened with. */
async function openedActivity(userId: string): Promise<{ unseenCount: number; items: Array<Record<string, unknown>> }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const sync = await new Promise<{ sidebar: { activity: { unseenCount: number; items: Array<Record<string, unknown>> } } }>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === "workspace_sync") resolve(frame as never);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  socket.close(1000, "done");
  return sync.sidebar.activity;
}

/** A Canvas the three people may open, each seated the way the conversation route seats them. */
async function sharedCanvas(): Promise<string> {
  const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR, title: "Launch plan" });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: AUTHOR, actorRole: "member" },
    update: { visibility: "participants", userIds: [RECIPIENT, MENTIONED] } });
  for (const userId of [AUTHOR, RECIPIENT, MENTIONED]) await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(canvasId);
  return canvasId;
}

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR, sessionId: `session-${AUTHOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT`),
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`UPDATE workspaces SET name = 'Replies' WHERE id = ?`).bind(WORKSPACE_ID),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(AUTHOR),
    ...[[RECIPIENT, "robin@example.com", "Robin"], [MENTIONED, "sam@example.com", "Sam"]].flatMap(([userId, email, name]) => [
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, ?, NULL, 'UTC', ?)`)
        .bind(userId, email, name, NOW),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, userId, NOW),
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
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  await registerPushDevice(pushEnv(), auth(RECIPIENT), "rr", {
    platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
    token: "rr".repeat(32), appVersion: "1",
  });
});

describe("a person's reply in a Canvas's Chat", () => {
  it("tells everyone else once per batch, with the newest reply, and nobody it mentions or wrote it", async () => {
    const canvasId = await sharedCanvas();
    await say(canvasId, AUTHOR, "@Sam first draft is up", "reply-1", [MENTIONED]);
    await say(canvasId, AUTHOR, "@Sam second pass is in, have a look", "reply-2", [MENTIONED]);
    // Nothing is told before the batch runs, which is due a batch's length after the first reply.
    expect(await replyIntents()).toEqual([]);
    await runInDurableObject(workspace(), (_instance, state) => {
      const entries = state.storage.sql.exec<{ due_at: number; created_at: number }>(
        `SELECT due_at, created_at FROM _internal_durable_alarms WHERE kind = ?`, REPLY_BATCH_ALARM_KIND).toArray();
      expect(entries.map((entry) => entry.due_at - entry.created_at)).toEqual([REPLY_BATCH_SECONDS * 1_000]);
    });
    await sendBatch();

    const newest = await latestTurnBy(canvasId, AUTHOR);
    // One notice, for the one person neither writing nor mentioned.
    expect(await replyIntents()).toEqual([
      { intent_id: `new_message:${newest}:${RECIPIENT}`, recipient_user_id: RECIPIENT, state: "delivered", last_error_code: null },
    ]);
    expect(await replyItems()).toEqual([{
      item_id: `new_message:${newest}:${RECIPIENT}`, recipient_user_id: RECIPIENT, message_id: newest,
      preview: "@Sam second pass is in, have a look", actor_id: AUTHOR,
    }]);
    expect(await openedActivity(RECIPIENT)).toMatchObject({ unseenCount: 1, items: [{
      kind: "new_message", parentKind: "canvas", parentId: canvasId, parentTitle: "Launch plan", substreamId: "0",
      messageId: newest, messageSequence: expect.any(Number), actor: { kind: "person", id: AUTHOR }, seen: false,
    }] });
    expect(await alertFor(`new_message:${newest}:${RECIPIENT}`)).toEqual([{ title: "Avery in Launch plan", body: "@Sam second pass is in, have a look" }]);
  });

  it("makes nothing of Rally's reply", async () => {
    // Alone in the Canvas, every message is for Rally, and Rally answers it.
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR, title: "Solo plan" });
    await new ConversationService(TEST_ENV, auth(AUTHOR)).authorizeViewer(canvasId);
    await say(canvasId, AUTHOR, "Draft the plan", "rally-1");
    await expect.poll(async () => {
      await runDurableObjectAlarm(conversation(canvasId));
      await deliverChildEffects(TEST_ENV, conversation(canvasId));
      return runInDurableObject(conversation(canvasId), (_instance, state) => state.storage.sql.exec(
        `SELECT 1 FROM canonical_conversation_turn_details WHERE role = 'assistant' AND content LIKE '%Noted.%'`).toArray().length);
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    await runInDurableObject(workspace(), (_instance, state) => expect(state.storage.sql.exec(
      `SELECT kind FROM _internal_durable_alarms WHERE kind = ?`, REPLY_BATCH_ALARM_KIND).toArray()).toEqual([]));
    expect(await replyIntents()).toEqual([]);
  });

  it("records a reply within the cooldown without a push, and pushes again once it has passed", async () => {
    const canvasId = await sharedCanvas();
    await say(canvasId, AUTHOR, "First draft is up", "cool-1");
    await sendBatch();
    await say(canvasId, AUTHOR, "One more change", "cool-2");
    await sendBatch();
    const [first, second] = (await replyIntents()).filter((intent) => intent.recipient_user_id === RECIPIENT);
    expect(first!.state).toBe("delivered");
    expect(second).toMatchObject({ state: "skipped", last_error_code: "conversation_alert_cooldown" });
    // The unseen row moved to the newer reply rather than adding one.
    expect((await replyItems()).filter((item) => item.recipient_user_id === RECIPIENT))
      .toEqual([expect.objectContaining({ item_id: first!.intent_id, preview: "One more change" })]);

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE workstream_notification_intents SET delivered_at = ? WHERE delivered_at IS NOT NULL`,
        new Date(Date.now() - CONVERSATION_ALERT_COOLDOWN_MS - 1_000).toISOString());
    });
    await say(canvasId, AUTHOR, "Final version", "cool-3");
    await sendBatch();
    const third = (await replyIntents()).filter((intent) => intent.recipient_user_id === RECIPIENT)[2]!;
    expect(third.state).toBe("delivered");
    expect(await alertFor(third.intent_id)).toEqual([{ title: "Avery in Launch plan", body: "Final version" }]);
  });

  it("clears the row once its reader reads past the reply, and the next reply is a new row", async () => {
    const canvasId = await sharedCanvas();
    await say(canvasId, AUTHOR, "First draft is up", "seen-1");
    await sendBatch();
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
    expect(await openedActivity(RECIPIENT)).toMatchObject({ unseenCount: 0, items: [{ kind: "new_message", seen: true }] });

    await say(canvasId, AUTHOR, "Another thing", "seen-2");
    await sendBatch();
    expect((await replyItems()).filter((item) => item.recipient_user_id === RECIPIENT).map((item) => item.preview))
      .toEqual(["First draft is up", "Another thing"]);
  });
});
