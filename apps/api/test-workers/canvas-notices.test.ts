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
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
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
import { claimHarnessAttempt } from "../src/runtime/harness-run-runtime";
import { createHarnessRunObjectPort } from "../src/runtime/harness-run-port";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { reenterInterruptedWriteForRecovery } from "../src/services/integrations";
import { runInput, seedExecutionReceipt, seedParticipantMessage, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ec000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000ec001");
const PARTICIPANT = asUserId("00000000-0000-7000-8000-0000000ec002");
const MUTED = asUserId("00000000-0000-7000-8000-0000000ec003");
const CANVAS = "00000000-0000-7000-8000-0000000ec0c1";
const OTHER_CANVAS = "00000000-0000-7000-8000-0000000ec0c2";
const SIDEKICK = "00000000-0000-7000-8000-0000000ec0a1";
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
    const landed = records.map((row) => JSON.parse(row.content_json) as { recordedAt: number });
    expect(landed).toEqual([{
      kind: "canvas_notices_record", canvasId: CANVAS, purpose: "Tell you when a new newsletter becomes a podcast.",
      registeredBy: { kind: "rally", name: "Rally" }, recordedAt: expect.any(Number),
    }]);
    const notices = (await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, actor: { userId: PARTICIPANT, actorRole: "member" } })).notices;
    expect(notices).toEqual({ purpose: "Tell you when a new newsletter becomes a podcast.", registeredBy: { kind: "rally", name: "Rally" },
      participant: true, channels: null, updatedAt: expect.any(Number) });
    // A client reads the Canvas again only for a record newer than its view; the current record never is.
    expect(landed[0]!.recordedAt).toBeLessThanOrEqual(notices!.updatedAt!);
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
    // The alert says which Canvas it came from.
    expect(payload.aps.alert).toMatchObject({ title: "Reading list: New episode: Stratechery", body: "Twelve minutes from this morning's issue." });
    expect(payload.rally.url).toMatch(/\/cv\/[1-9A-Za-z]+\/$/u);
  });

  it("send the email in place of a push that reaches no device, and not beside one that does", async () => {
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "New episodes.", operationId: "op-1" } });
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "send", title: "New episode", body: "Out now.", sourceId: "fallback" } });
    const queue = Object.getPrototypeOf(env.PUSH_DELIVERY_QUEUE) as { send: (body: unknown) => Promise<void> };
    const queued: unknown[] = [];
    vi.spyOn(queue, "send").mockImplementation(async (body) => { queued.push(body); });
    const message = { region: "global" as const, workspaceId: WORKSPACE_ID, recipientUserId: PARTICIPANT,
      intentId: `fallback:${PARTICIPANT}`, emailFallback: true as const };

    // Every device refuses its token: nothing reached them, so the email goes instead.
    expect(await deliverPush(pushEnv(), message, async (): Promise<ApnsOutcome> => ({ outcome: "bad_token" }))).toBe(true);
    expect(queued).toEqual([{ region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PARTICIPANT,
      intentId: `fallback:${PARTICIPANT}`, channel: "email" }]);

    queued.length = 0;
    await registerPushDevice(pushEnv(), auth(PARTICIPANT), "pp", {
      platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production", token: "qq".repeat(32), appVersion: "1",
    });
    expect(await deliverPush(pushEnv(), message, async (): Promise<ApnsOutcome> => ({ outcome: "sent" }))).toBe(true);
    expect(queued).toEqual([]);
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

  it("finish a send its loop was interrupted in, once, when the run is recovered", async () => {
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "New episodes.", operationId: "op-1" } });
    const triggerMessageId = crypto.randomUUID();
    const input = runInput(crypto.randomUUID(), { workspaceId: WORKSPACE_ID, parentId: CANVAS, parentKind: "canvas",
      triggerMessageId, executionPrincipal: { type: "user", userId: CREATOR } });
    await runInDurableObject(chat(), async (_instance, state) => {
      await seedParticipantMessage(state, { id: triggerMessageId, sequence: 1, authorUserId: CREATOR, text: "Tell everyone." });
      seedExecutionReceipt(state, input.harnessRunId, input, Date.now());
    });
    const runs = createHarnessRunObjectPort(env, WORKSPACE_ID, CANVAS);
    const claim = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "first", leaseSeconds: 300 });
    if (claim.state !== "claimed") throw new Error(`notice_recovery_claim_${claim.state}`);
    const receipts = createToolReceiptObjectPort(env, WORKSPACE_ID, CANVAS);
    const args = { title: "New episode", body: "Out now." };
    // Recorded, then the Worker stopped before the send ran.
    await receipts.admit({ effectIntentId: crypto.randomUUID(), runId: input.harnessRunId, toolCallId: "interrupted", toolName: "send",
      mode: "write", connectionId: null, requestHash: "notice-request", inputJson: JSON.stringify(args),
      executionPlanHash: "notice-plan", executionPlanJson: JSON.stringify({ pluginId: "rally:notifications",
        canonicalToolName: "send", capability: "rally.notifications.send", mode: "write", idempotency: "record_before_execute" }),
      compatiblePriorPlanHashes: [], providerIdempotencyKey: null,
      fence: { runId: input.harnessRunId, attemptId: claim.lease.attemptId, owner: claim.lease.owner }, now: Date.now() });
    await runInDurableObject(chat(), (_instance, state) => state.storage.sql.exec(
      "UPDATE runs SET lease_expires_at=? WHERE run_id=?", Date.now() - 1, input.harnessRunId));
    await evictDurableObject(chat());
    const replacement = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "replacement", leaseSeconds: 300 });
    if (replacement.state !== "claimed") throw new Error(`notice_recovery_replacement_${replacement.state}`);
    const interrupted = (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "interrupted" }))!;

    expect(await reenterInterruptedWriteForRecovery(env, input, { ...interrupted, startedAt: interrupted.startedAt ?? 0 }, replacement.lease, runs))
      .toMatchObject({ outcome: "completed", result: { output: { canvasId: CANVAS, recipients: 3 } } });
    expect((await intents()).map((intent) => intent.recipient_user_id)).toEqual([CREATOR, PARTICIPANT, MUTED].sort());
  });

  it("send the record to open screens only once the registration it shows is saved", async () => {
    const unsent = () => runInDurableObject(chat(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      `SELECT count(*) AS count FROM durable_outbox WHERE state IN ('pending', 'inflight') AND channel = 'semantic_realtime_v1'`).one().count);
    const appended = await chat().appendHostRecord({ schemaVersion: 1, workspaceId: WORKSPACE_ID, parentKind: "canvas",
      workstreamId: CANVAS, clientMessageId: "canvas-notices-record:direct", text: "This Canvas sends notices: Drafts.",
      structuredContent: { kind: "canvas_notices_record", canvasId: CANVAS, purpose: "Drafts.",
        registeredBy: { kind: "rally", name: "Rally" }, recordedAt: Date.now() }, occurredAt: Date.now() });
    expect(appended.outcome).toBe("appended");
    // Written, but held back until its caller has committed what it records.
    expect(await unsent()).toBeGreaterThan(0);
    await chat().publishPending({ workspaceId: WORKSPACE_ID, workstreamId: CANVAS });
    expect(await unsent()).toBe(0);

    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "New episodes.", operationId: "op-1" } });
    expect(await unsent()).toBe(0);
  });

  it("keep a newer registration when an older one is retried", async () => {
    const register = (purpose: string, operationId: string) => workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose, operationId } });
    await register("Drafts.", "op-a");
    await register("New episodes.", "op-b");
    // The first call's result was lost, so the harness runs it again.
    expect(await register("Drafts.", "op-a")).toMatchObject({ outcome: "registered", purpose: "New episodes.", changed: false });
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS,
      actor: { userId: PARTICIPANT, actorRole: "member" } })).notices).toMatchObject({ purpose: "New episodes." });
  });

  it("refuse a Chat's agent once its person can no longer open the Canvas", async () => {
    await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: CHAT_LOOP,
      action: { kind: "register", purpose: "New episodes.", operationId: "op-1" } });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'creator' WHERE canvas_id = ?`, CANVAS);
      state.storage.sql.exec(`DELETE FROM canvas_participants WHERE canvas_id = ? AND user_id = ?`, CANVAS, PARTICIPANT);
    });
    expect(await workspace().canvasNotices({ workspaceId: WORKSPACE_ID, loop: { ...CHAT_LOOP, actingUserId: PARTICIPANT },
      action: { kind: "send", title: "New episode", body: "Out now.", sourceId: "after-removal" } }))
      .toEqual({ outcome: "refused", code: "canvas_access_denied" });
  });
});
