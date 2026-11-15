/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Canvas's notices on real workerd (docs/PRDs/2026-11-14_canvas-notices):
 * an agent in the Canvas's Chat turns them on, which lands the record in the
 * Chat; a send records one `canvas_notice` intent and Activity row for the
 * creator and each participant but anyone who muted the Canvas, once per
 * send; the push says what the agent wrote and opens the Canvas; and a
 * Sidekick attached to two Canvases is refused, naming both.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ee000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000ee001");
const PARTICIPANT = asUserId("00000000-0000-7000-8000-0000000ee002");
const MUTED = asUserId("00000000-0000-7000-8000-0000000ee003");
const CANVAS = "00000000-0000-7000-8000-0000000ee0c1";
const OTHER_CANVAS = "00000000-0000-7000-8000-0000000ee0c2";
const SIDEKICK = "00000000-0000-7000-8000-0000000ee0a1";
const NOW = "2026-11-15T10:00:00.000Z";

/** An environment that may send push, as `canvas-artifact-notices.test.ts` builds it. */
const pushEnv = () => ({
  ...env, FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: "true", APP_ENV: "staging" as const, APNS_AUTH_KEY: "configured", APNS_KEY_ID: "configured",
  WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: { jurisdiction: () => env.WORKSPACE_DOS } }).WORKSPACE_DOS,
});

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

const CHAT_LOOP = { parentKind: "canvas" as const, parentId: CANVAS, actingUserId: CREATOR };

async function intents(): Promise<Array<{ intent_id: string; recipient_user_id: string }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ intent_id: string; recipient_user_id: string }>(
    `SELECT intent_id, recipient_user_id FROM workstream_notification_intents WHERE notification_kind = 'canvas_notice'
      ORDER BY recipient_user_id`).toArray());
}

/** The Activity this person's workspace socket is opened with, from a build that reads Canvas notices. */
async function openedActivity(userId: string, clientContract = 16): Promise<{ unseenCount: number; items: Array<Record<string, unknown>> }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      "x-rally-socket-client-contract": String(clientContract),
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

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    ...[PARTICIPANT, MUTED].flatMap((userId, index) => [
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, ?, NULL, 'UTC', ?)`)
        .bind(userId, `person${index}@example.com`, index === 0 ? "Robin" : "Sam", NOW),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at) VALUES (?, ?, 'active', 'member', ?)`)
        .bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID),
    ]),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  await registerPushDevice(pushEnv(), auth(PARTICIPANT), "pp", {
    platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production", token: "pp".repeat(32), appVersion: "1",
  });
  for (const canvasId of [CANVAS, OTHER_CANVAS]) {
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId, title: canvasId === CANVAS ? "Reading list" : "Other",
      createdByUserId: CREATOR, authorityGeneration: 1 });
  }
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, actor: { userId: CREATOR, actorRole: "member" },
    update: { visibility: "participants", userIds: [PARTICIPANT, MUTED] } });
  // The Chat an agent registers from exists, as it does while its agent runs.
  await chat().bootstrapRuntime({ workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: CANVAS, generation: 1 });
});

function chat() {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, CANVAS, asSubstreamId("0"))));
}

describe("a Canvas's notices", () => {
  it("are refused until turned on, which lands the record in the Chat", async () => {
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "send", title: "New episode", body: "Twelve minutes.", sourceId: "early" } }))
      .toEqual({ outcome: "refused", code: "canvas_notices_not_registered" });

    const registered = await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "Tell you when a new newsletter becomes a podcast.", operationId: "op-1" } });
    expect(registered).toMatchObject({ outcome: "registered", canvasId: CANVAS, changed: true });
    // The same sentence again lands nothing new.
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "Tell you when a new newsletter becomes a podcast.", operationId: "op-2" } }))
      .toMatchObject({ outcome: "registered", changed: false });

    const records = await runInDurableObject(chat(), (_instance, state) => state.storage.sql.exec<{ content_json: string }>(
      `SELECT structured_content_json AS content_json FROM canonical_conversation_turn_details WHERE message_type = 'system'`).toArray());
    expect(records.map((row) => JSON.parse(row.content_json))).toEqual([{
      kind: "canvas_notices_record", canvasId: CANVAS, purpose: "Tell you when a new newsletter becomes a podcast.",
      registeredBy: { kind: "rally", name: "Rally" },
    }]);
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, actor: { userId: PARTICIPANT, actorRole: "member" } })).notices)
      .toEqual({ purpose: "Tell you when a new newsletter becomes a podcast.", registeredBy: { kind: "rally", name: "Rally" },
        participant: true, channels: null });
  });

  it("tell the creator and every participant but one who muted it, once per send, and the push opens the Canvas", async () => {
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "New episodes.", operationId: "op-1" } });
    await workspace().canvasSetNoticeChoice({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, actor: { userId: MUTED, actorRole: "member" }, channels: [] });

    const send = { kind: "send" as const, title: "New episode: Stratechery", body: "Twelve minutes from this morning's issue.", sourceId: "send-1" };
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP, action: send }))
      .toEqual({ outcome: "sent", canvasId: CANVAS, recipients: 2 });
    // A retried send records nothing twice.
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP, action: send });
    expect(await intents()).toEqual([
      { intent_id: `send-1:${CREATOR}`, recipient_user_id: CREATOR },
      { intent_id: `send-1:${PARTICIPANT}`, recipient_user_id: PARTICIPANT },
    ]);
    expect(await openedActivity(PARTICIPANT)).toMatchObject({ unseenCount: 1, items: [{
      kind: "canvas_notice", parentId: CANVAS, parentTitle: "Reading list", actor: { kind: "rally", id: null },
      preview: "New episode: Stratechery", seen: false,
    }] });
    // A build older than the kind is sent its Activity without it, rather than failing to parse it.
    expect((await openedActivity(PARTICIPANT, 15)).items).toEqual([]);

    const apns = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PARTICIPANT,
      intentId: `send-1:${PARTICIPANT}` }, apns)).toBe(true);
    const payload = JSON.parse(((apns.mock.calls[0] as unknown[])[2] as PushPayloads).apns) as {
      aps: { alert: { title: string; body: string } }; rally: { url: string };
    };
    expect(payload.aps.alert).toMatchObject({ title: "New episode: Stratechery", body: "Twelve minutes from this morning's issue." });
    expect(payload.rally.url).toMatch(/\/cv\/[1-9A-Za-z]+\/$/u);
  });

  it("refuse a Sidekick attached to two Canvases, naming both, and send from its one Canvas", async () => {
    const attach = (canvasId: string) => runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO sidekick_conversation_attachments (automation_id, parent_kind, parent_id, substream_id, attached_by_user_id, attached_at)
        VALUES (?, 'canvas', ?, '0', ?, ?)`, SIDEKICK, canvasId, CREATOR, Date.now());
    });
    const loop = { parentKind: "automation" as const, parentId: SIDEKICK, actingUserId: CREATOR };
    const send = { kind: "send" as const, title: "Done", body: "It finished.", sourceId: "sidekick-send" };
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop, action: send }))
      .toEqual({ outcome: "refused", code: "notifications_sidekick_has_no_canvas" });
    await attach(CANVAS);
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP, action: { kind: "register", purpose: "Runs.", operationId: "op-1" } });
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop, action: send }))
      .toMatchObject({ outcome: "sent", canvasId: CANVAS });
    await attach(OTHER_CANVAS);
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop, action: { ...send, sourceId: "second" } })).toEqual({
      outcome: "refused", code: "notifications_sidekick_has_several_canvases",
      available: [{ canvasId: CANVAS, title: "Reading list" }, { canvasId: OTHER_CANVAS, title: "Other" }],
    });
  });
});
