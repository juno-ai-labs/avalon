/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What a Sidekick source request tells people, on the real Organization
 * object: the person asked gets one `source_request` intent and an Activity
 * row that names a Sidekick they cannot open; their answer, or a newer ask
 * replacing the request, settles that row as seen; an approval or a decline
 * tells whoever asked with a `source_approved` or `source_declined` intent
 * and row; and the emailed Approve link records the answer once, as the
 * person it was signed for. `docs/sidekick-sources.md` owns the request.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { sendNoticeEmail } from "../src/services/notice-email";
import type { Notice } from "../src/services/notification-notice";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { decideSourceRequestByLink } from "../src/services/sidekick-source-decision-link";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { EMAIL_DELIVERY_TABLE } from "./helpers/email-delivery-tables";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000005ce000");
let SIDEKICK_ID = "00000000-0000-7000-8000-0000005ce0a1";
const MANAGER = asUserId("00000000-0000-7000-8000-0000005ce001");
const PERSON = asUserId("00000000-0000-7000-8000-0000005ce002");
const OTHER = asUserId("00000000-0000-7000-8000-0000005ce003");
const NOW = "2026-11-10T10:00:00.000Z";
const CONDITION = "it is about a pre-seed round";
const ASKED = "Events: Email received. Only when: it is about a pre-seed round";

/** An environment that may send push, as `canvas-access-requests.test.ts` builds it. */
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

type ActivityFrame = { unseenCount: number; items: Array<Record<string, unknown>> };
type Opened = { activity: ActivityFrame; sidekickIds: string[] };

/**
 * A subscribed workspace socket for this person, keeping every Activity it is
 * sent. `clientContract` is what the socket's signed ticket says its build
 * declared: 14 reads the source kinds, and null is a ticket that names none.
 */
async function connect(userId: string, clientContract: number | null = 14): Promise<{ opened: Opened; pushes: ActivityFrame[]; close: () => void }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      ...(clientContract === null ? {} : { "x-rally-socket-client-contract": String(clientContract) }),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const pushes: ActivityFrame[] = [];
  const opened = await new Promise<Opened>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as { type?: string;
        sidebar?: { activity: ActivityFrame; automations: { items: Array<{ id: string }> } } } & ActivityFrame;
      if (frame.type === "workspace_sync") resolve({ activity: frame.sidebar!.activity, sidekickIds: frame.sidebar!.automations.items.map((item) => item.id) });
      if (frame.type === "workspace_activity_list") pushes.push(frame);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  return { opened, pushes, close: () => socket.close(1000, "done") };
}

async function opened(userId: string, clientContract: number | null = 14): Promise<Opened> {
  const socket = await connect(userId, clientContract);
  socket.close();
  return socket.opened;
}

/** The intents of one kind, as the push consumer reads them. */
async function intents(kind: string): Promise<Array<{ intent_id: string; recipient_user_id: string; state: string }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ intent_id: string; recipient_user_id: string; state: string }>(
    `SELECT intent_id, recipient_user_id, state FROM workstream_notification_intents WHERE notification_kind = ? ORDER BY created_at, intent_id`, kind).toArray());
}

async function requestStates(): Promise<Array<{ user_id: string; state: string; condition: string | null }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ user_id: string; state: string; condition: string | null }>(
    `SELECT user_id, state, condition FROM sidekick_source_requests ORDER BY created_at, request_id`).toArray());
}

/** A person's own Google connection, held by the Organization object as production holds it. */
async function connectGoogle(userId: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name, granted_scopes_json, status,
        cursor_json, config_json, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'google', 'personal', ?, ?, ?, '[]', 'healthy', '{}', '{}', ?, ?, ?)`,
    connectionId, WORKSPACE_ID, userId, `account-${userId}`, `${userId}@example.com`, NOW, NOW, `plugin_google_${connectionId}`));
  return connectionId;
}

const manager = { userId: MANAGER, actorRole: "member" as const, participantOfOwningWorkstream: false };

/** The manager asks these people to let new mail start the Sidekick. */
async function ask(userIds: string[], condition: string | null = CONDITION) {
  return workspace().sidekickRequestSources({
    workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, actor: manager, actorName: "Avery",
    ask: { userIds: userIds.map(asUserId), connectorType: "google", eventTypes: ["email.received"], condition },
  });
}

const decide = (requestId: string, decision: "approve" | "decline", userId = PERSON) => workspace().sidekickDecideSourceRequest({
  workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, requestId, userId, decision });

/** The alert the push consumer sends this person for this intent. */
async function alertFor(recipientUserId: string, intentId: string): Promise<{ title: string; body: string }> {
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
  expect(await deliverPush(pushEnv(), { region: "global", workspaceId: WORKSPACE_ID, recipientUserId, intentId }, send)).toBe(true);
  const apns = JSON.parse(((send.mock.calls[0] as unknown[])[2] as PushPayloads).apns) as { aps: { alert: { title: string; body: string } } };
  return apns.aps.alert;
}

/** What the notification queue was handed, the Organization object's sends included. */
let queued: Array<{ recipientUserId: string; intentId: string; channel?: string }> = [];

type QueueSend = { send: (body: unknown, options?: QueueSendOptions) => Promise<void> };

beforeEach(async () => {
  await reset();

  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  SIDEKICK_ID = crypto.randomUUID();
  queued = [];
  const prototype = Object.getPrototypeOf(env.PUSH_DELIVERY_QUEUE) as QueueSend;
  const original = prototype.send;
  vi.spyOn(prototype, "send").mockImplementation(async function (this: QueueSend, body, options) {
    if (typeof body === "object" && body !== null && "intentId" in body) queued.push(body as (typeof queued)[number]);
    return original.call(this, body, options);
  });
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: MANAGER, sessionId: `session-${MANAGER}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Juno Labs'`),
    env.DB.prepare(`ALTER TABLE users ADD COLUMN presentation_json TEXT`),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(MANAGER),
    ...([[PERSON, "Robin"], [OTHER, "Pat"]] as const).flatMap(([userId, name]) => [
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, ?, NULL, 'UTC', ?)`)
        .bind(userId, `${name.toLowerCase()}@example.com`, name, NOW),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', 'member', 'member', ?)`)
        .bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID),
    ]),
    env.DB.prepare(EMAIL_DELIVERY_TABLE),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  for (const userId of [MANAGER, PERSON]) {
    await registerPushDevice(pushEnv(), auth(userId), `d${userId.slice(-1)}`, {
      platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
      token: `${userId.slice(-2)}`.repeat(32), appVersion: "1",
    });
  }
  // A personal Sidekick: only its author opens it, so the person asked cannot.
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, authorUserId: MANAGER, scope: "personal", authorityGeneration: 1 });
  await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
    `UPDATE automation_directory SET title = 'Deals' WHERE automation_id = ?`, SIDEKICK_ID));
  await connectGoogle(PERSON);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a Sidekick source request tells people", () => {
  it("tells the person asked once, in an Activity row that names a Sidekick they cannot open", async () => {
    const person = await connect(PERSON);
    expect(person.opened).toEqual({ activity: { waterline: expect.any(Number), unseenCount: 0, items: [] }, sidekickIds: [] });
    const [request] = (await ask([PERSON])).requests;
    // Asking again for the same thing answers with the request already waiting, and tells nobody twice.
    expect((await ask([PERSON])).requests.map((entry) => entry.requestId)).toEqual([request!.requestId]);
    expect(await intents("source_request")).toEqual([
      { intent_id: `source_request:${request!.requestId}`, recipient_user_id: PERSON, state: "delivered" }]);

    await expect.poll(() => person.pushes.at(-1)).toMatchObject({ unseenCount: 1, items: [{
      id: `source_request:${request!.requestId}`, kind: "source_request", parentKind: "automation", parentId: SIDEKICK_ID,
      parentTitle: "Deals", actor: { kind: "person", id: MANAGER }, preview: ASKED, seen: false,
      sourceRequest: { requestId: request!.requestId, state: "pending", connectorType: "google", eventTypes: ["email.received"],
        condition: CONDITION, requestedByName: "Avery", personName: null },
    }] });
    person.close();
    // Still not theirs to open: the row lists without the Sidekick doing so.
    expect((await opened(PERSON)).sidekickIds).toEqual([]);
    expect(await alertFor(PERSON, `source_request:${request!.requestId}`))
      .toEqual({ title: "Avery asked to use your Gmail for Deals", body: ASKED });
    // Whoever asked is told nothing until the person answers.
    expect((await opened(MANAGER)).activity.items).toEqual([]);
    expect(queued.filter((message) => message.channel === "email")).toEqual([]);
  });

  it("settles the asked person's row as seen when they approve, and tells whoever asked who approved", async () => {
    const [request] = (await ask([PERSON])).requests;
    const person = await connect(PERSON);
    expect(await decide(request!.requestId, "approve")).toMatchObject({ state: "approved" });
    await expect.poll(() => person.pushes.at(-1)).toMatchObject({ unseenCount: 0, items: [{
      kind: "source_request", seen: true, sourceRequest: { state: "approved", requestedByName: "Avery", personName: "Robin" } }] });
    person.close();
    expect((await opened(MANAGER)).activity).toMatchObject({ unseenCount: 1, items: [{
      id: `source_approved:${request!.requestId}`, kind: "source_approved", parentKind: "automation", parentId: SIDEKICK_ID, parentTitle: "Deals",
      actor: { kind: "person", id: PERSON }, preview: ASKED, seen: false,
      sourceRequest: { requestId: request!.requestId, state: "approved", connectorType: "google", eventTypes: ["email.received"],
        condition: CONDITION, requestedByName: "Avery", personName: "Robin" },
    }] });
    expect(await intents("source_approved")).toEqual([
      { intent_id: `source_approved:${request!.requestId}`, recipient_user_id: MANAGER, state: "delivered" }]);
    expect(await alertFor(MANAGER, `source_approved:${request!.requestId}`))
      .toEqual({ title: "Robin approved Deals's use of their Gmail", body: ASKED });
    // The same answer again reads back as it stands and tells nobody again.
    expect(await decide(request!.requestId, "approve")).toMatchObject({ state: "approved" });
    expect(await intents("source_approved")).toHaveLength(1);
    expect(await intents("source_declined")).toEqual([]);
  });

  it("tells whoever asked about a decline, and nobody when a newer ask replaces a waiting one or a person answers their own", async () => {
    const [first] = (await ask([PERSON], "it is about a seed round")).requests;
    const [second] = (await ask([PERSON])).requests;
    expect(await requestStates()).toEqual([
      { user_id: PERSON, state: "cancelled", condition: "it is about a seed round" }, { user_id: PERSON, state: "pending", condition: CONDITION }]);
    // The replaced request's row is no longer the person's to act on: it reads seen, and only the newer one waits.
    expect((await opened(PERSON)).activity).toMatchObject({ unseenCount: 1, items: [
      { id: `source_request:${second!.requestId}`, seen: false, sourceRequest: { state: "pending" } },
      { id: `source_request:${first!.requestId}`, seen: true, sourceRequest: { state: "cancelled", personName: null } },
    ] });
    expect([...await intents("source_approved"), ...await intents("source_declined")]).toEqual([]);

    expect(await decide(second!.requestId, "decline")).toMatchObject({ state: "declined" });
    expect((await opened(PERSON)).activity).toMatchObject({ unseenCount: 0, items: [
      { seen: true, sourceRequest: { state: "declined", personName: "Robin" } }, { seen: true, sourceRequest: { state: "cancelled" } }] });
    expect(await intents("source_declined")).toEqual([
      { intent_id: `source_declined:${second!.requestId}`, recipient_user_id: MANAGER, state: "delivered" }]);
    expect((await opened(MANAGER)).activity).toMatchObject({ unseenCount: 1, items: [{
      kind: "source_declined", parentTitle: "Deals", actor: { kind: "person", id: PERSON }, seen: false,
      sourceRequest: { state: "declined", personName: "Robin" } }] });
    expect(await alertFor(MANAGER, `source_declined:${second!.requestId}`))
      .toEqual({ title: "Robin declined Deals's use of their Gmail", body: ASKED });

    // Asking for one's own connection is one's own act: approved at once, and no row or notice for anybody.
    await connectGoogle(MANAGER);
    expect((await ask([MANAGER])).requests).toMatchObject([{ state: "approved", yours: true }]);
    expect(await intents("source_request")).toHaveLength(2);
    expect(await intents("source_approved")).toEqual([]);
    expect((await opened(MANAGER)).activity.items).toHaveLength(1);
  });

  it("emails the person two links, and the Approve link records their answer once without a session", async () => {
    await workspace().saveMemberPreferences({ workspaceId: WORKSPACE_ID, userId: PERSON, preferences: { notify: { accessRequests: ["email"] } } });
    const [request] = (await ask([PERSON])).requests;
    const intentId = `source_request:${request!.requestId}`;
    // Queued after the commit, for the one sink the person chose.
    expect(queued).toEqual([{ region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PERSON, intentId, channel: "email" }]);

    const sink = vi.fn<(env: unknown, notice: Notice) => Promise<{ outcome: "sent" }>>(async () => ({ outcome: "sent" }));
    expect(await deliverPush(env, { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PERSON, intentId, channel: "email" },
      undefined, undefined, sink)).toBe(true);
    const notice = sink.mock.calls[0]![1];
    expect(notice).toMatchObject({ kind: "source_request", title: "Avery asked to use your Gmail for Deals", body: ASKED, actorName: "Avery" });
    expect(notice.actions!.map((action) => action.label)).toEqual(["Approve", "Decline"]);
    const fields = (label: string) => {
      const url = new URL(notice.actions!.find((action) => action.label === label)!.url);
      expect(`${url.origin}${url.pathname}`).toBe("https://app.test/app/source-requests/decision");
      const fragment = new URLSearchParams(url.hash.slice(1));
      expect(fragment.get("region")).toBe("global");
      return { workspaceId: fragment.get("workspace")!, sidekickId: fragment.get("sidekick")!, requestId: fragment.get("request")!,
        userId: fragment.get("person")!, decision: fragment.get("decision") as "approve" | "decline", token: fragment.get("token")! };
    };
    const approve = fields("Approve");
    const decline = fields("Decline");
    expect(approve).toMatchObject({ workspaceId: WORKSPACE_ID, sidekickId: SIDEKICK_ID, requestId: request!.requestId, userId: PERSON, decision: "approve" });

    // The email itself: a button's worth of text for each answer, and no link into a Sidekick the person cannot open.
    const send = vi.fn<(message: EmailMessageBuilder) => Promise<EmailSendResult>>(async () => ({ messageId: "cf_1" }));
    const production = { ...env, APP_ENV: "production" as const, EMAIL_NOTIFICATION_FROM: "Rally <notify@rallywith.ai>" };
    expect(await sendNoticeEmail(production, notice, send)).toEqual({ outcome: "sent" });
    expect(send.mock.calls[0]![0].text).toBe([
      "Hi Robin,", "", "Avery asked to use your Gmail for Deals.", "", `"${ASKED}"`, "",
      `Approve: ${notice.actions![0]!.url}`, `Decline: ${notice.actions![1]!.url}`, "",
      "Opening a button records your answer. You can also answer in Rally, under Activity.", "",
      "You chose email for Access requests in Juno Labs. Change it in Rally under Settings, Notifications.",
    ].join("\n"));
    const html = String(send.mock.calls[0]![0].html);
    expect(html).toContain(">Approve</a>");
    expect(html).toContain(">Decline</a>");
    expect(html).not.toContain("Open in Rally");

    // A link edited into the other answer, or into another person's, is refused before anything is read.
    await expect(decideSourceRequestByLink(env, { ...approve, decision: "decline" })).rejects.toMatchObject({ code: "sidekick_source_link_invalid" });
    await expect(decideSourceRequestByLink(env, { ...approve, userId: OTHER })).rejects.toMatchObject({ code: "sidekick_source_link_invalid" });
    expect(await requestStates()).toMatchObject([{ state: "pending" }]);

    const approved = { state: "approved", applied: true, sidekickName: "Deals", requestedByName: "Avery", connectorName: "Gmail",
      eventLabels: ["Email received"], condition: CONDITION };
    expect(await decideSourceRequestByLink(env, approve)).toEqual(approved);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT user_id, connector_type, event_types_json, condition, origin FROM sidekick_sources WHERE sidekick_id = ?`, SIDEKICK_ID).toArray()))
      .toEqual([{ user_id: PERSON, connector_type: "google", event_types_json: '["email.received"]', condition: CONDITION, origin: "request" }]);
    // Opened again, the link says the same and whoever asked is not told twice.
    expect(await decideSourceRequestByLink(env, approve)).toEqual(approved);
    expect(await intents("source_approved")).toHaveLength(1);
    // The other button, opened after the answer, changes nothing and says how the request stands.
    expect(await decideSourceRequestByLink(env, decline)).toEqual({ ...approved, applied: false });
    expect(await requestStates()).toMatchObject([{ state: "approved" }]);
  });

  it("sends a build older than the source kinds its Activity without them, row and count alike", async () => {
    // A mention the older build does read, beside the request it does not.
    await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `INSERT INTO workspace_activity_items (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id,
         actor_kind, actor_id, preview, attention_ordinal, created_at)
       VALUES ('mention:one', ?, ?, 'mention', 'automation', ?, '0', 'person', ?, 'Look at this', NULL, 1)`,
      WORKSPACE_ID, MANAGER, SIDEKICK_ID, PERSON));
    const [request] = (await ask([PERSON])).requests;
    await decide(request!.requestId, "approve");
    const older = await connect(MANAGER, 13);
    expect(older.opened.activity).toMatchObject({ unseenCount: 1, items: [{ kind: "mention" }] });
    expect((await opened(MANAGER, null)).activity).toMatchObject({ unseenCount: 1, items: [{ kind: "mention" }] });
    expect((await opened(MANAGER)).activity).toMatchObject({ unseenCount: 2, items: [{ kind: "source_approved" }, { kind: "mention" }] });
    // A push for a row the older build cannot read carries the list without it too.
    const [again] = (await ask([PERSON], "it is about a seed round")).requests;
    await decide(again!.requestId, "decline");
    await expect.poll(() => older.pushes.at(-1)).toMatchObject({ unseenCount: 1, items: [{ kind: "mention" }] });
    expect(older.pushes.flatMap((push) => push.items.map((item) => item.kind))).not.toContain("source_declined");
    older.close();
    expect((await opened(PERSON, 13)).activity).toEqual({ waterline: expect.any(Number), unseenCount: 0, items: [] });
  });

  it("answers a link for a request a newer ask replaced by saying so, and leaves the newer one waiting", async () => {
    await workspace().saveMemberPreferences({ workspaceId: WORKSPACE_ID, userId: PERSON, preferences: { notify: { accessRequests: ["email"] } } });
    const [first] = (await ask([PERSON], "it is about a seed round")).requests;
    const sink = vi.fn<(env: unknown, notice: Notice) => Promise<{ outcome: "sent" }>>(async () => ({ outcome: "sent" }));
    await deliverPush(env, { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PERSON,
      intentId: `source_request:${first!.requestId}`, channel: "email" }, undefined, undefined, sink);
    const fragment = new URLSearchParams(new URL(sink.mock.calls[0]![1].actions![0]!.url).hash.slice(1));
    await ask([PERSON]);
    expect(await decideSourceRequestByLink(env, { workspaceId: fragment.get("workspace")!, sidekickId: fragment.get("sidekick")!,
      requestId: fragment.get("request")!, userId: fragment.get("person")!, decision: "approve", token: fragment.get("token")! }))
      .toEqual({ state: "cancelled", applied: false, sidekickName: "Deals", requestedByName: "Avery", connectorName: "Gmail",
        eventLabels: ["Email received"], condition: "it is about a seed round" });
    expect((await requestStates()).map((entry) => entry.state)).toEqual(["cancelled", "pending"]);
    expect(await intents("source_approved")).toEqual([]);
  });
});
