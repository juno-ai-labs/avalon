/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The state a work stream is in for somebody who has never opened it.
 *
 * "Unseen" is per-person and lives on the membership row, so nothing about it
 * can be proved against a mock: it is written by the same commit that enqueues
 * the viewer effect the sidebar's dot is drawn from, and cleared by the open
 * path — which is a durable write issued from what otherwise reads like a read.
 * This drives the real product endpoint against real Durable Object SQLite so
 * the participant row, the outbox envelopes, and the ordering between them are
 * the production ones.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  ConversationEffectSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type ConversationEffect,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { hostedParentStub } from "./helpers/hosted-parent";
import { ensureAuditSchema } from "./helpers/audit-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000007b1");
// An earlier object may still finish an alarm while reset is in flight. Each
// case owns a fresh child and parent so that work cannot replay its fixture.
let WORKSTREAM_ID = asWorkstreamId(crypto.randomUUID());
const CREATOR_ID = asUserId("00000000-0000-7000-8000-0000000007b3");
const CREATOR_SESSION_ID = "00000000-0000-7000-8000-0000000007b4";
const INVITEE_ID = "00000000-0000-7000-8000-0000000007b5";
const INVITEE_SESSION_ID = "00000000-0000-7000-8000-0000000007b6";


const AUTH = {
  sessionId: CREATOR_SESSION_ID,
  userId: CREATOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "owner" as const,
};

const INVITEE_AUTH = {
  sessionId: INVITEE_SESSION_ID,
  userId: INVITEE_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};

beforeEach(async () => {
  await reset();
  WORKSTREAM_ID = asWorkstreamId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'owner', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, CREATOR_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-22T20:00:00.000Z')`).bind(WORKSPACE_ID, INVITEE_ID),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(CREATOR_SESSION_ID, CREATOR_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(INVITEE_SESSION_ID, INVITEE_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'creator@example.com', 'Creator', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(CREATOR_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'invitee@example.com', 'Invitee', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(INVITEE_ID),
  ]);
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // holds every object's gate, so this hook can wait out a full reset before it
  // gets to run at all. The work itself — reset, the D1 seed, and the
  // `initializeWorkspace` RPC — takes milliseconds, so a failure here is a hang,
  // never a slow query.
}, 30_000);

function agentStub(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
  ));
}

/**
 * Keep an object's outbox readable for the helpers.
 *
 * The drain alarm fires the moment an effect commits and hands the rows to
 * `ACTIVITY_QUEUE`, which nothing in this Worker consumes, so a read placed
 * after the mutation races the drain (docs/testing.md). A producer that
 * refuses makes the drain defer the rows instead of deleting them, and the
 * helpers then hand exactly those rows to the real consumer.
 */
async function parkEffectQueue(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    const parked = {
      send: () => Promise.reject(new Error("effect_queue_parked_by_test")),
      sendBatch: () => Promise.reject(new Error("effect_queue_parked_by_test")),
    };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? parked
        : Reflect.get(current, property, receiver),
    });
  });
}

async function product(stub: DurableObjectStub, body: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await stub.fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function startWorkstream(stub: DurableObjectStub, participantUserIds: string[]): Promise<void> {
  await parkEffectQueue(stub);
  // Creation commits the participant state under test before execution wakes.
  // Keep the unrelated opening model run inert so its alarm cannot cross reset
  // and replay a previous fixture (the same boundary as participant-notification).
  await runInDurableObject(stub, async (instance) => {
    const productService = (instance as unknown as { product: WorkstreamObjectProductService }).product;
    return productService.initialize(AUTH, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      title: "Warehouse migration",
      objective: "Move the warehouse",
      descriptionSource: "authored",
      titleStatus: "settled",
      emailAddress: null,
      creatorUserId: CREATOR_ID,
      openingMessage: "starting the migration",
      clientMessageId: "unseen-open",
      participantUserIds,
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: CREATOR_ID },
      reason: "user_message",
    });
  });
}

async function connectParticipant(
  stub: DurableObjectStub,
  userId: string,
  sessionId: string,
  ticketId: string,
): Promise<WebSocket> {
  const response = await stub.fetch("https://object.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-workstream-id": WORKSTREAM_ID,
      "x-rally-substream-id": "0",
      "x-rally-user-id": userId,
      "x-rally-session-id": sessionId,
      "x-rally-socket-ticket-id": ticketId,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const snapshot = new Promise<MessageEvent>((resolve) =>
    socket.addEventListener("message", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: false }));
  await snapshot;
  return socket;
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

function nextEvent(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (event.type !== type) return;
      socket.removeEventListener("message", onMessage);
      resolve(event);
    };
    socket.addEventListener("message", onMessage);
  });
}

/**
 * What the sidebar is currently being told about one person.
 *
 * Read from the hosted parent's projection of the child's effects rather than
 * from the child's outbox: the outbox holds every effect ever enqueued until
 * it is delivered, while the parent's row is the current answer. Delivery is
 * driven by hand through the real Queue consumer, which makes the read
 * deterministic instead of alarm-timed.
 */
async function viewerState(stub: DurableObjectStub, userId: string): Promise<
  Extract<ConversationEffect, { kind: "directory_user" }> | null
> {
  await deliverChildEffects(env, stub);
  const rows = await runInDurableObject(hostedParentStub(env, WORKSPACE_ID), (_instance, state) =>
    state.storage.sql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM parent_child_viewer_projections
        WHERE parent_id = ? AND user_id = ? ORDER BY substream_id`,
      WORKSTREAM_ID,
      userId,
    ).toArray());
  const effects = rows
    .map((row) => ConversationEffectSchema.parse(JSON.parse(row.effect_json)))
    .filter((effect): effect is Extract<ConversationEffect, { kind: "directory_user" }> => (
      effect.kind === "directory_user"
    ));
  return effects.at(-1) ?? null;
}

async function firstOpenedAt(stub: DurableObjectStub, userId: string): Promise<number | null | undefined> {
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ first_opened_at: number | null }>(
      `SELECT first_opened_at FROM participants WHERE user_id = ?`,
      userId,
    ).toArray());
  return rows[0]?.first_opened_at;
}

async function participantStatus(stub: DurableObjectStub, userId: string): Promise<string | undefined> {
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM participants WHERE user_id = ?`,
      userId,
    ).toArray());
  return rows[0]?.status;
}

describe("a work stream nobody has shown this person yet", () => {
  it("is unseen for everybody named at the start except the person who started it", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);

    expect(await firstOpenedAt(stub, CREATOR_ID)).toEqual(expect.any(Number));
    expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();
    // The dot is drawn from the projected effect, not from the row here, so
    // the effect is what has to carry it.
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(true);
    expect((await viewerState(stub, CREATOR_ID))?.unseen).toBe(false);

    const creatorView = await product(stub, { operation: "get", auth: AUTH });
    expect(creatorView.body.unseen).toBe(false);
  });

  it("is unseen for somebody added to a work stream that already exists", async () => {
    const stub = agentStub();
    await startWorkstream(stub, []);

    const added = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(added.status).toBe(200);

    expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(true);
  });

  it("stops being unseen the first time that person opens it, and says so in the same answer", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(true);

    const opened = await product(stub, { operation: "get", auth: INVITEE_AUTH });
    expect(opened.status).toBe(200);
    // The detail returned by the open already says seen. Answering `true` here
    // and correcting it over the socket a beat later would light the dot on the
    // work stream they are looking at.
    expect(opened.body.unseen).toBe(false);
    expect(await firstOpenedAt(stub, INVITEE_ID)).toEqual(expect.any(Number));
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(false);
  });

  it("keeps a speculative socket snapshot unseen until navigation promotes it", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);
    expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();

    const response = await stub.fetch("https://object.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": INVITEE_ID,
        "x-rally-session-id": INVITEE_SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-0000000007d1",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        "x-rally-socket-after-sequence": "0",
        "x-rally-socket-speculative": "true",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const snapshot = nextEvent(socket, "snapshot");
    socket.accept();
    await snapshot;

    expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(true);

    socket.send(JSON.stringify({ type: "mark_opened" }));
    await expect.poll(
      () => firstOpenedAt(stub, INVITEE_ID),
      { timeout: 5_000 },
    ).toEqual(expect.any(Number));
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(false);
    socket.close(1000, "test complete");
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
      { timeout: 5_000 },
    ).toBe(0);
  });

  it("does not make a work stream new again when somebody adds a person who is already in it", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);
    await product(stub, { operation: "get", auth: INVITEE_AUTH });
    const opened = await firstOpenedAt(stub, INVITEE_ID);

    const again = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(again.status).toBe(200);

    expect(await firstOpenedAt(stub, INVITEE_ID)).toBe(opened);
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(false);
  });

  it("is unseen again for somebody taken out of a work stream and put back in", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);
    await product(stub, { operation: "get", auth: INVITEE_AUTH });

    const removed = await product(stub, { operation: "remove_participant", owningThread: true, auth: AUTH, userId: INVITEE_ID });
    expect(removed.status).toBe(200);
    const readded = await product(stub, { operation: "add_participant", auth: AUTH, userId: INVITEE_ID });
    expect(readded.status).toBe(200);

    // The work stream moved on without them, and the add is announced to them
    // again — the epoch beside this says so too, so the marker agrees.
    expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();
    expect((await viewerState(stub, INVITEE_ID))?.unseen).toBe(true);
  });

  it("lets a participant remove themselves while another participant remains", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);

    const removed = await product(stub, {
      operation: "remove_participant", owningThread: true,
      auth: INVITEE_AUTH,
      userId: INVITEE_ID,
    });

    expect(removed.status).toBe(200);
    expect(await participantStatus(stub, INVITEE_ID)).toBe("removed");
    expect(await participantStatus(stub, CREATOR_ID)).toBe("active");
  });

  it("lets a participant remove somebody else while they remain in the work stream", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);

    const removed = await product(stub, {
      operation: "remove_participant", owningThread: true,
      auth: INVITEE_AUTH,
      userId: CREATOR_ID,
    });

    expect(removed.status).toBe(200);
    expect(await participantStatus(stub, CREATOR_ID)).toBe("removed");
    expect(await participantStatus(stub, INVITEE_ID)).toBe("active");
  });

  it("refuses to remove the final participant", async () => {
    const stub = agentStub();
    await startWorkstream(stub, []);

    const removed = await product(stub, {
      operation: "remove_participant", owningThread: true,
      auth: AUTH,
      userId: CREATOR_ID,
    });

    expect(removed.status).toBe(409);
    expect(removed.body).toMatchObject({
      error: "workstream_participant_required",
    });
    expect(await participantStatus(stub, CREATOR_ID)).toBe("active");
  });

  it("closes revoked sockets and republishes removal when the first local event fails", async () => {
    const stub = agentStub();
    await startWorkstream(stub, [INVITEE_ID]);
    const creatorSocket = await connectParticipant(
      stub,
      CREATOR_ID,
      CREATOR_SESSION_ID,
      "00000000-0000-7000-8000-0000000007c1",
    );
    const inviteeSocket = await connectParticipant(
      stub,
      INVITEE_ID,
      INVITEE_SESSION_ID,
      "00000000-0000-7000-8000-0000000007c2",
    );

    let failPublication = true;
    await runInDurableObject(stub, (instance) => {
      const publisher = instance as unknown as { deliverCommittedRealtimeEvent(event: unknown): Promise<void> };
      const publish = publisher.deliverCommittedRealtimeEvent.bind(instance);
      publisher.deliverCommittedRealtimeEvent = async (event) => {
        if (failPublication) throw new Error("injected_local_event_failure");
        await publish(event);
      };
    });

    const closed = nextClose(inviteeSocket);
    const first = await product(stub, {
      operation: "remove_participant", owningThread: true,
      auth: AUTH,
      userId: INVITEE_ID,
    });
    expect(first.status).toBe(200);
    expect(await participantStatus(stub, INVITEE_ID)).toBe("removed");
    expect((await closed).code).toBe(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE);

    const replayed = nextEvent(creatorSocket, "participant_removed");
    failPublication = false;
    const retry = await product(stub, {
      operation: "remove_participant", owningThread: true,
      auth: AUTH,
      userId: INVITEE_ID,
    });
    expect(retry.status).toBe(200);
    await expect(replayed).resolves.toMatchObject({
      type: "participant_removed",
      userId: INVITEE_ID,
    });
    creatorSocket.close(1000, "test complete");
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
      { timeout: 5_000 },
    ).toBe(0);
    // The suite's 30s budget covers two real WebSocket handshake-plus-
    // subscribe round trips and three product ops under contended
    // parallel-file load, not a slow object. `nextClose` and
    // `nextEvent` deliberately never reject: the convention here is to let the
    // harness timeout be the failure and size the budget for the work.
  });

  describe("on a Rally access support session (docs/impersonation.md)", () => {
    const SUPPORT_SESSION_ID = "00000000-0000-7000-8000-0000000007e1";
    const STAFF_ID = "00000000-0000-7000-8000-0000000007e2";
    const SUPPORT_AUTH = { ...INVITEE_AUTH, sessionId: SUPPORT_SESSION_ID };

    beforeEach(async () => {
      await env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at, impersonator_user_id)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z', ?)`)
        .bind(SUPPORT_SESSION_ID, INVITEE_ID, WORKSPACE_ID, STAFF_ID).run();
    });

    async function attention(stub: DurableObjectStub, userId: string): Promise<number | undefined> {
      const rows = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ seen: number }>(
          `SELECT seen_attention_ordinal AS seen FROM member_attention WHERE user_id = ?`,
          userId,
        ).toArray());
      return rows[0]?.seen;
    }

    it("opens and reads it without it becoming opened or read for the person", async () => {
      const stub = agentStub();
      await startWorkstream(stub, [INVITEE_ID]);

      const opened = await product(stub, { operation: "get", auth: SUPPORT_AUTH });
      expect(opened.status).toBe(200);
      expect(opened.body.unseen).toBe(true);
      expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();

      const before = await attention(stub, INVITEE_ID);
      const read = await product(stub, {
        operation: "acknowledge_read", auth: SUPPORT_AUTH,
        input: { readThroughSequenceNumber: 1, observedManualUnreadGeneration: 0 },
      });
      expect(read.status).toBe(200);
      expect(await attention(stub, INVITEE_ID)).toBe(before);
    });

    it("records each command its socket sends, as the staff member acting for the person", async () => {
      await ensureAuditSchema();
      const stub = agentStub();
      await startWorkstream(stub, [INVITEE_ID]);
      const response = await stub.fetch("https://object.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-workstream-id": WORKSTREAM_ID,
          "x-rally-substream-id": "0",
          "x-rally-user-id": INVITEE_ID,
          "x-rally-session-id": SUPPORT_SESSION_ID,
          "x-rally-socket-ticket-id": "00000000-0000-7000-8000-0000000007e4",
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
          "x-rally-socket-impersonator-id": STAFF_ID,
        },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      const snapshot = nextEvent(socket, "snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: false }));
      await snapshot;
      socket.send(JSON.stringify({ type: "set_workstream_appearance", operationId: crypto.randomUUID(), appearance: {} }));
      await expect.poll(async () => (await env.AUDIT_DB.prepare(
        `SELECT actor_user_id, target_id, workstream_id, json_extract(metadata_json, '$.command') AS command
           FROM audit_events WHERE action = 'support_session.socket_command'
            AND json_extract(metadata_json, '$.sessionId') = ?`,
      ).bind(SUPPORT_SESSION_ID).all()).results, { timeout: 5_000 }).toEqual([{
        actor_user_id: STAFF_ID, target_id: INVITEE_ID, workstream_id: WORKSTREAM_ID, command: "set_workstream_appearance",
      }]);
      socket.close(1000, "test complete");
      await expect.poll(
        () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
        { timeout: 5_000 },
      ).toBe(0);
    });

    it("never lists the person as present from a socket", async () => {
      const stub = agentStub();
      await startWorkstream(stub, [INVITEE_ID]);
      const response = await stub.fetch("https://object.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-workstream-id": WORKSTREAM_ID,
          "x-rally-substream-id": "0",
          "x-rally-user-id": INVITEE_ID,
          "x-rally-session-id": SUPPORT_SESSION_ID,
          "x-rally-socket-ticket-id": "00000000-0000-7000-8000-0000000007e3",
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
          "x-rally-socket-impersonator-id": STAFF_ID,
        },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      const snapshot = nextEvent(socket, "snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: true }));
      await snapshot;
      expect(await firstOpenedAt(stub, INVITEE_ID)).toBeNull();
      // The feed lists as viewers only people outside its participant list, so
      // read the list as if the person were not a participant: their socket is
      // subscribed with presence on, and only the support session keeps it off.
      const viewers = await runInDurableObject(stub, (instance) => {
        const agent = instance as unknown as {
          product: { activeParticipantIds(): string[] };
          loadViewers(workspaceId: string, workstreamId: string): Promise<unknown[]>;
        };
        agent.product.activeParticipantIds = () => [];
        return agent.loadViewers(WORKSPACE_ID, WORKSTREAM_ID);
      });
      expect(viewers).toEqual([]);
      socket.close(1000, "test complete");
      await expect.poll(
        () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
        { timeout: 5_000 },
      ).toBe(0);
    });
  });
});
