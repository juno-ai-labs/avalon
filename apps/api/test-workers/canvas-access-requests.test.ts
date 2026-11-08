/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Asking to open a Canvas, on the real Organization object: a member who
 * cannot open it asks, its deciders (its creator and the Organization's
 * administrators) each get an `access_request` intent and an Activity row on
 * their sockets, a decider approves or denies, and an approval seats the
 * requester and tells them with an `access_granted` intent and row. Being
 * added by Share, or the Canvas being made Organization-wide, settles a
 * waiting request. `docs/canvas-access-requests.md` owns the mechanism.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ee000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000ee001");
const REQUESTER = asUserId("00000000-0000-7000-8000-0000000ee002");
const ADMIN = asUserId("00000000-0000-7000-8000-0000000ee003");
const PARTICIPANT = asUserId("00000000-0000-7000-8000-0000000ee004");
const GUEST = asUserId("00000000-0000-7000-8000-0000000ee005");
let CANVAS_ID = "00000000-0000-7000-8000-0000000ee0c1";
const NOW = "2026-11-08T10:00:00.000Z";

const member = (userId: string) => ({ userId: asUserId(userId), actorRole: userId === ADMIN ? "admin" as const : "member" as const });

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

type ActivityFrame = { unseenCount: number; items: Array<Record<string, unknown>> };

/** A subscribed workspace socket for this person, keeping every Activity it is sent. */
async function connect(userId: string): Promise<{ opened: ActivityFrame; pushes: ActivityFrame[]; close: () => void }> {
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
  const pushes: ActivityFrame[] = [];
  const opened = await new Promise<ActivityFrame>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as { type?: string; sidebar?: { activity: ActivityFrame } } & ActivityFrame;
      if (frame.type === "workspace_sync") resolve(frame.sidebar!.activity);
      if (frame.type === "workspace_activity_list") pushes.push(frame);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  return { opened, pushes, close: () => socket.close(1000, "done") };
}

async function openedActivity(userId: string): Promise<ActivityFrame> {
  const socket = await connect(userId);
  socket.close();
  return socket.opened;
}

/** The intents of one kind, as the push consumer reads them. */
async function intents(kind: string): Promise<Array<{ intent_id: string; recipient_user_id: string; state: string }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ intent_id: string; recipient_user_id: string; state: string }>(
    `SELECT intent_id, recipient_user_id, state FROM workstream_notification_intents WHERE notification_kind = ? ORDER BY recipient_user_id`, kind).toArray());
}

async function requests(): Promise<Array<{ user_id: string; state: string; decided_by_user_id: string | null; message: string | null }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ user_id: string; state: string; decided_by_user_id: string | null; message: string | null }>(
    `SELECT user_id, state, decided_by_user_id, message FROM canvas_access_requests ORDER BY created_at, request_id`).toArray());
}

/** Run an Organization-object call in the object, so a refusal is the thrown error with its code. */
async function refusal(run: (instance: WorkspaceDO) => Promise<unknown>): Promise<string | undefined> {
  return runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
    try {
      await run(instance);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

const ask = (message?: string) => workspace().canvasRequestAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(REQUESTER),
  request: message === undefined ? {} : { message } });
const decide = (decision: "approve" | "deny", decider = CREATOR) => workspace().canvasDecideAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
  actor: member(decider), requesterUserId: REQUESTER, decision });

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  CANVAS_ID = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(CREATOR),
    ...([[REQUESTER, "Robin", "member", "member"], [ADMIN, "Ada", "admin", "member"], [PARTICIPANT, "Pat", "member", "member"],
      [GUEST, "Gus", null, "guest"]] as const).flatMap(([userId, name, role, accessClass]) => [
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, ?, NULL, 'UTC', ?)`)
        .bind(userId, `${name.toLowerCase()}@example.com`, name, NOW),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', ?, ?, ?)`)
        .bind(WORKSPACE_ID, userId, role, accessClass, NOW),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID),
    ]),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  for (const userId of [CREATOR, REQUESTER]) {
    await registerPushDevice(pushEnv(), auth(userId), `d${userId.slice(-1)}`, {
      platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
      token: `${userId.slice(-2)}`.repeat(32), appVersion: "1",
    });
  }
  await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Launch plan", createdByUserId: CREATOR, authorityGeneration: 1 });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
    update: { visibility: "participants", userIds: [PARTICIPANT] } });
});

/** The alert the push consumer sends this person for this intent. */
async function alertFor(recipientUserId: string, intentId: string): Promise<{ title: string; body: string; url: string }> {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
  expect(await deliverPush(pushEnv(), { region: "global", workspaceId: WORKSPACE_ID, recipientUserId, intentId }, send)).toBe(true);
  const apns = JSON.parse(((send.mock.calls[0] as unknown[])[2] as PushPayloads).apns) as { aps: { alert: { title: string; body: string } }; rally: { url: string } };
  return { ...apns.aps.alert, url: apns.rally.url };
}

describe("asking to open a Canvas", () => {
  it("tells each decider, answers a second ask with the first, and an approval seats the requester and tells them", async () => {
    expect(await workspace().canvasAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(REQUESTER) }))
      .toEqual({ access: "requestable", title: null, request: null });
    const creator = await connect(CREATOR);
    expect(await ask("  I'm picking up the launch  ")).toEqual({ status: "pending" });
    expect(await ask("again")).toEqual({ status: "pending" });
    expect(await requests()).toEqual([{ user_id: REQUESTER, state: "pending", decided_by_user_id: null, message: "I'm picking up the launch" }]);
    expect((await intents("access_request")).map((intent) => intent.recipient_user_id)).toEqual([ADMIN, CREATOR].sort());
    expect(await workspace().canvasAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(REQUESTER) }))
      .toEqual({ access: "requestable", title: null, request: { state: "pending", requestedAt: expect.any(String) } });

    const waiting = { kind: "access_request", parentKind: "canvas", parentId: CANVAS_ID, parentTitle: "Launch plan",
      actor: { kind: "person", id: REQUESTER }, preview: "I'm picking up the launch" };
    await expect.poll(() => creator.pushes.at(-1)).toMatchObject({ unseenCount: 1, items: [{
      ...waiting, accessRequest: { state: "pending", decidedByName: null, decidedByUserId: null }, seen: false }] });
    const requestIntent = (await intents("access_request")).find((intent) => intent.recipient_user_id === CREATOR)!;
    expect(await alertFor(CREATOR, requestIntent.intent_id)).toMatchObject({ title: "Robin asked to open Launch plan", body: "I'm picking up the launch" });
    // The Share panel lists it for a decider, and for nobody else.
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) })).pendingAccessRequests)
      .toEqual([{ userId: REQUESTER, name: "Robin", message: "I'm picking up the launch", requestedAt: expect.any(String) }]);
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(PARTICIPANT) })).pendingAccessRequests)
      .toBeUndefined();

    expect(await decide("approve")).toEqual({ state: "approved" });
    await expect.poll(() => creator.pushes.at(-1)).toMatchObject({ unseenCount: 0, items: [{
      ...waiting, accessRequest: { state: "approved", decidedByName: "Avery", decidedByUserId: CREATOR }, seen: true }] });
    expect((await openedActivity(ADMIN)).items).toMatchObject([{ kind: "access_request", accessRequest: { state: "approved", decidedByName: "Avery", decidedByUserId: CREATOR }, seen: true }]);
    await runInDurableObject(workspace(), (_instance, state) => expect(state.storage.sql.exec(
      `SELECT source, added_by_user_id FROM canvas_participants WHERE canvas_id = ? AND user_id = ?`, CANVAS_ID, REQUESTER).toArray())
      .toEqual([{ source: "request", added_by_user_id: CREATOR }]));
    expect(await openedActivity(REQUESTER)).toMatchObject({ unseenCount: 1, items: [{
      kind: "access_granted", parentId: CANVAS_ID, parentTitle: "Launch plan", actor: { kind: "person", id: CREATOR }, seen: false }] });
    const [granted] = await intents("access_granted");
    expect(granted).toMatchObject({ recipient_user_id: REQUESTER, state: "delivered" });
    expect(await alertFor(REQUESTER, granted!.intent_id)).toMatchObject({ title: "Avery let you into Launch plan",
      url: expect.stringMatching(/\/cv\/[1-9A-Za-z]+\/$/u) });
    // Settled once: a second decision is refused by name.
    expect(await refusal((instance) => instance.canvasDecideAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      requesterUserId: REQUESTER, decision: "deny" }))).toBe("canvas_access_request_settled");
    creator.close();
  });

  it("settles a denial without telling the requester, and lets them ask again", async () => {
    await ask();
    expect(await decide("deny", ADMIN)).toEqual({ state: "denied" });
    expect(await intents("access_granted")).toEqual([]);
    expect((await openedActivity(REQUESTER)).items).toEqual([]);
    expect((await openedActivity(CREATOR)).items).toMatchObject([{ kind: "access_request", accessRequest: { state: "denied", decidedByName: "Ada", decidedByUserId: ADMIN }, seen: true }]);
    expect(await workspace().canvasAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(REQUESTER) }))
      .toMatchObject({ request: { state: "denied" } });
    expect(await ask()).toEqual({ status: "pending" });
    expect((await requests()).map((request) => request.state)).toEqual(["denied", "pending"]);
  });

  it("settles a waiting request when Share adds its person, and grants every one when the Canvas opens to the Organization", async () => {
    await ask();
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [PARTICIPANT, REQUESTER] } });
    expect(await requests()).toMatchObject([{ state: "approved", decided_by_user_id: CREATOR }]);
    expect((await intents("access_granted")).map((intent) => intent.recipient_user_id)).toEqual([REQUESTER]);

    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [PARTICIPANT] } });
    expect(await ask()).toEqual({ status: "pending" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "workspace", userIds: [] } });
    expect((await requests()).map((request) => request.state)).toEqual(["approved", "approved"]);
    expect(await intents("access_granted")).toHaveLength(2);
    expect(await ask()).toEqual({ status: "already_participant" });
  });

  it("refuses a guest and someone who does not decide, by name, and an id that is no Canvas as not found", async () => {
    const guest = { userId: GUEST, actorRole: null };
    expect(await refusal((instance) => instance.canvasRequestAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: guest, request: {} })))
      .toBe("canvas_access_request_not_member");
    expect(await refusal((instance) => instance.canvasAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: guest })))
      .toBe("canvas_access_request_not_member");
    expect(await refusal((instance) => instance.canvasAccess({ workspaceId: WORKSPACE_ID, canvasId: crypto.randomUUID(), actor: member(REQUESTER) })))
      .toBe("canvas_not_found");
    await ask();
    expect(await refusal((instance) => instance.canvasDecideAccess({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(PARTICIPANT),
      requesterUserId: REQUESTER, decision: "approve" }))).toBe("canvas_access_decision_not_manager");
    expect(await requests()).toMatchObject([{ state: "pending" }]);
  });
});
