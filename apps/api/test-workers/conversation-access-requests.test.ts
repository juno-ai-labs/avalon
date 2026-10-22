/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What a member holding a link to a Channel or Breakout they are not in may
 * see of it: `WorkspaceDO.accessRequestSubject`, fed by the same conversation
 * effects production publishes. `docs/channel-access-requests.md` owns the rule.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type SubstreamId,
  type WorkstreamId,
} from "@rally/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { hostedParentStub } from "./helpers/hosted-parent";
import { ConversationAccessRequestService } from "../src/services/conversation-access-request-service";
import { conversationObjectName } from "../src/durable-objects/names";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000ac001");
const privateChannel = asWorkstreamId("00000000-0000-4000-8000-0000000ac0a0");
const archivedChannel = asWorkstreamId("00000000-0000-4000-8000-0000000ac0b0");
const plainBreakout = asSubstreamId("00000000-0000-4000-8000-0000000ac0a1");
const markedBreakout = asSubstreamId("00000000-0000-4000-8000-0000000ac0a2");
const creator = asUserId("00000000-0000-4000-8000-0000000ac011");
const breakoutCreator = asUserId("00000000-0000-4000-8000-0000000ac012");
const requester = asUserId("00000000-0000-4000-8000-0000000ac013");
const at = "2026-10-07T12:00:00.000Z";

const organization = () => hostedParentStub(env, workspaceId);

type CommonEffect = Extract<ConversationEffect, { kind: "directory_common" }>;
function common(title: string, extra: Partial<CommonEffect> = {}): CommonEffect {
  return {
    kind: "directory_common", title, description: "Never shown to a requester", preview: "", scope: "personal",
    state: "idle", systemKind: null, lastActivityAt: at, completedAt: null, archivedAt: null,
    createdByUserId: creator, latestAttentionOrdinal: 0, unreadTrackingStartOrdinal: 0, createdAt: at, updatedAt: at,
    ...extra,
  };
}

let messageSeq = 0;
async function publish(parentId: WorkstreamId, effect: ConversationEffect, substreamId: SubstreamId = asSubstreamId("0")) {
  messageSeq += 1;
  await organization().receiveChildEffects({
    substreamId,
    envelopes: [{
      kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId, parentKind: "workstream",
      parentId, substreamId, generation: 1,
      messageId: `00000000-0000-7000-8000-${String(messageSeq).padStart(12, "0")}`,
      partitionKey: "common", sourceVersion: messageSeq, requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect), effect,
    }],
  });
}

const subject = (parentId: string, substreamId: string) =>
  organization().accessRequestSubject({ workspaceId, parentId, substreamId });

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT,
      abandoned_at TEXT, placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare(`INSERT INTO workspaces (id, region) VALUES (?, 'global')`).bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member',
      incarnation TEXT DEFAULT 'existing-member', workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, user_id))`),
    ...[creator, breakoutCreator, requester].map((userId) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`,
    ).bind(workspaceId, userId)),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
    ...[creator, breakoutCreator, requester].map((userId) => env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(`session-${userId}`, userId, workspaceId)),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const parentId of [privateChannel, archivedChannel]) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main')`, parentId, creator);
    }
    for (const substreamId of [plainBreakout, markedBreakout]) {
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, ?, 'child', ?, 1, 'Breakout')`, privateChannel, substreamId, breakoutCreator);
    }
  });
  await publish(privateChannel, common("Launch plan", { appearance: { icon: "rocket", color: "teal" } }));
  await publish(privateChannel, common("Pricing", { createdByUserId: breakoutCreator }), plainBreakout);
  await publish(privateChannel, common("Copy", {
    createdByUserId: breakoutCreator, appearance: { icon: null, color: "amber" },
  }), markedBreakout);
  await publish(archivedChannel, common("Old plan", { archivedAt: at }));
});

describe("accessRequestSubject", () => {
  it("names a private Channel with its mark and its creator, and nothing else", async () => {
    expect(await subject(privateChannel, "0")).toEqual({
      kind: "channel", title: "Launch plan", appearance: { icon: "rocket", color: "teal" },
      markId: privateChannel, createdByUserId: creator, requestPending: false,
    });
  });

  it("gives a Breakout with no look of its own the Channel's, resolved from the Channel's id", async () => {
    expect(await subject(privateChannel, plainBreakout)).toEqual({
      kind: "breakout", title: "Pricing", appearance: { icon: "rocket", color: "teal" },
      markId: privateChannel, createdByUserId: breakoutCreator, requestPending: false,
    });
  });

  it("keeps a Breakout's own look, resolved from its own id", async () => {
    expect(await subject(privateChannel, markedBreakout)).toEqual({
      kind: "breakout", title: "Copy", appearance: { icon: null, color: "amber" },
      markId: markedBreakout, createdByUserId: breakoutCreator, requestPending: false,
    });
  });

  it("names nothing archived or unknown", async () => {
    expect(await subject(archivedChannel, "0")).toBeNull();
    expect(await subject(privateChannel, "00000000-0000-4000-8000-0000000ac0ff")).toBeNull();
  });
});

type Frame = Record<string, unknown> & { type?: string };
let ticketSeq = 0;
/** A real hibernating workspace socket for this person, subscribed; resolves with its subscribe answer. */
async function connect(userId: string) {
  ticketSeq += 1;
  const response = await organization().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": workspaceId,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8001-${String(ticketSeq).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`socket refused: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const received: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.addEventListener("message", (event) => {
    if (String(event.data) === "pong") return;
    const frame = JSON.parse(String(event.data)) as Frame;
    received.push(frame);
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
  });
  const next = (match: (frame: Frame) => boolean, label: string) => new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${label} arrived`)), 5_000);
    waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
  });
  const answer = next((frame) => frame.type === "workspace_sync", "subscribe answer");
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  return { socket, received, next, answer: await answer };
}

const ask = (substreamId: string = "0", approverUserId: string = creator) => organization().recordConversationAccessRequest({
  workspaceId, parentId: privateChannel, substreamId, requesterUserId: requester,
  requesterName: "Samantha Lee", approverUserId,
});

describe("stored access requests", () => {
  it.each(["approved", "declined"] as const)("previews the requester's pending request until it is %s", async (status) => {
    // Admission imports the historical main roster from the real conversation
    // object; the directory-only fixture above has not given it an identity.
    const source = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, privateChannel));
    await runInDurableObject(source, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: privateChannel });
    });
    const service = new ConversationAccessRequestService(env, {
      workspaceId, userId: requester, sessionId: `session-${requester}`, region: "global", role: "member",
    });
    expect(await service.preview(privateChannel, "0")).toMatchObject({ access: "requestable", requestPending: false });
    const { request } = await ask();
    expect(await service.preview(privateChannel, "0")).toMatchObject({ access: "requestable", requestPending: true });
    expect(await organization().accessRequestSubject({
      workspaceId, parentId: privateChannel, substreamId: "0", requesterUserId: creator,
    })).toMatchObject({ requestPending: false });
    expect(await organization().accessRequestSubject({
      workspaceId, parentId: privateChannel, substreamId: plainBreakout, requesterUserId: requester,
    })).toMatchObject({ requestPending: false });
    await organization().resolveConversationAccessRequest({ workspaceId, id: request.id, status });
    expect(await service.preview(privateChannel, "0")).toMatchObject({ requestPending: false });
  });

  it("previews a pending Breakout request only for that Breakout", async () => {
    await ask(plainBreakout, breakoutCreator);
    expect(await organization().accessRequestSubject({
      workspaceId, parentId: privateChannel, substreamId: plainBreakout, requesterUserId: requester,
    })).toMatchObject({ requestPending: true });
    expect(await organization().accessRequestSubject({
      workspaceId, parentId: privateChannel, substreamId: markedBreakout, requesterUserId: requester,
    })).toMatchObject({ requestPending: false });
  });

  it("keeps one pending request per person per conversation, so asking again sends nothing new", async () => {
    const first = await ask();
    const again = await ask();
    expect(first.created).toBe(true);
    expect(again).toEqual({ request: first.request, created: false });
  });

  it("asks again by email until one went out, and then never again", async () => {
    const first = await ask();
    expect(first.request.emailed).toBe(false);
    expect((await ask()).request.emailed).toBe(false);
    await organization().markConversationAccessRequestEmailed({ workspaceId, id: first.request.id });
    expect((await ask()).request).toMatchObject({ id: first.request.id, emailed: true });
  });

  it("puts a claimed approval back to pending when its grant fails, and lists it to the approver again", async () => {
    const { request } = await ask();
    const approver = await connect(creator);
    const emptied = approver.next((frame) => frame.type === "workspace_access_requests", "list after the claim");
    expect(await organization().resolveConversationAccessRequest({ workspaceId, id: request.id, status: "approved" }))
      .toMatchObject({ status: "approved" });
    expect((await emptied).requests).toEqual([]);
    const restored = approver.next((frame) => frame.type === "workspace_access_requests", "list after reopening");
    expect(await organization().reopenConversationAccessRequest({ workspaceId, id: request.id }))
      .toMatchObject({ id: request.id, status: "pending" });
    expect(((await restored).requests as Array<{ id: string }>).map((item) => item.id)).toEqual([request.id]);
    // A decline is final: only an approval reopens.
    await organization().resolveConversationAccessRequest({ workspaceId, id: request.id, status: "declined" });
    expect(await organization().reopenConversationAccessRequest({ workspaceId, id: request.id })).toBeNull();
  });

  it("lists a request to its approver on connect and pushes the empty list once it is settled", async () => {
    const { request } = await ask();
    const approver = await connect(creator);
    expect(approver.answer.accessRequests).toEqual([{
      id: request.id, parentId: privateChannel, substreamId: "0", kind: "channel", title: "Launch plan",
      appearance: { icon: "rocket", color: "teal" }, markId: privateChannel, requesterUserId: requester,
      requesterName: "Samantha Lee", requestedAt: expect.any(String),
    }]);
    const pushed = approver.next((frame) => frame.type === "workspace_access_requests", "request list");
    expect(await organization().resolveConversationAccessRequest({ workspaceId, id: request.id, status: "declined" }))
      .toMatchObject({ id: request.id, status: "declined" });
    expect((await pushed).requests).toEqual([]);
    // Settled once: a second answer finds nothing pending.
    expect(await organization().resolveConversationAccessRequest({ workspaceId, id: request.id, status: "approved" })).toBeNull();
  });

  it("names the conversation as it is now, sending the list again when it is renamed or archived", async () => {
    await ask();
    const approver = await connect(creator);
    const renamed = approver.next((frame) => frame.type === "workspace_access_requests", "list after a rename");
    await publish(privateChannel, common("Launch plan v2", { appearance: { icon: "rocket", color: "teal" } }));
    expect(((await renamed).requests as Array<{ title: string }>).map((item) => item.title)).toEqual(["Launch plan v2"]);
    const archived = approver.next((frame) => frame.type === "workspace_access_requests", "list after an archive");
    await publish(privateChannel, common("Launch plan v2", { archivedAt: at }));
    expect((await archived).requests).toEqual([]);
  });

  it("refuses a malformed request by the field it rejected", async () => {
    // On the instance: across a real RPC hop workerd also reports the remote
    // rejection as unhandled. The message asserted is the one that crosses.
    await runInDurableObject(organization(), async (instance) => {
      await expect(instance.recordConversationAccessRequest({
        workspaceId, parentId: "not-a-channel", substreamId: "0", requesterUserId: requester,
        requesterName: "Samantha Lee", approverUserId: creator,
      })).rejects.toThrow(/record_conversation_access_request_invalid:parentId/u);
    });
  });

  it("pushes a new request to its approver alone", async () => {
    const approver = await connect(breakoutCreator);
    const bystander = await connect(creator);
    const pushed = approver.next((frame) => frame.type === "workspace_access_requests", "request list");
    await ask(plainBreakout, breakoutCreator);
    const frame = await pushed;
    expect((frame.requests as Array<{ title: string; markId: string }>).map(({ title, markId }) => ({ title, markId })))
      .toEqual([{ title: "Pricing", markId: privateChannel }]);
    expect(bystander.received.some((received) => received.type === "workspace_access_requests")).toBe(false);
  });
});

describe("migration 95", () => {
  it("adds the request table to an Organization already at 94, keeping what it held", async () => {
    // Populated at 94 and committed in its own event, then upgraded as a
    // deployed object is: a fresh schema has no rows to keep.
    const stub = env.MIGRATION_PROBE_DO!.getByName("conversation-access-requests-v94");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 94);
      expect(before.at(-1)?.version).toBe(94);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-requests", now: 1,
      });
      state.storage.sql.exec(`INSERT INTO channels (
        workstream_id, authority_generation, waterline, source_event_id, payload_hash,
        title, description, preview, scope, exact_state, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
        source_created_at, source_updated_at, projected_at
      ) VALUES (?, 1, 1, 'event-1', 'hash', 'Launch plan', '', '', 'personal', 'idle', 'ad_hoc', 'settled', 0, 0, 100, 100, 100, 100)`,
      privateChannel);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-requests", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT title FROM channels WHERE workstream_id = ?`, privateChannel).toArray()).toEqual([{ title: "Launch plan" }]);
      const insert = (id: string, status: string) => sql.exec(`INSERT INTO conversation_access_requests
        (id, parent_id, substream_id, requester_user_id, requester_name, approver_user_id, status, created_at)
        VALUES (?, ?, '0', ?, 'Samantha Lee', ?, ?, 3)`, id, privateChannel, requester, creator, status);
      insert("request-1", "declined");
      insert("request-2", "pending");
      // One pending request per person per conversation; settled ones do not count.
      expect(() => insert("request-3", "pending")).toThrow(/UNIQUE/u);
      expect(() => insert("request-4", "withdrawn")).toThrow(/CHECK/u);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
