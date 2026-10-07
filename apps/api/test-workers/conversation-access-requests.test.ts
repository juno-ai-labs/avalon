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

import { hostedParentStub } from "./helpers/hosted-parent";

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
      expires_at TEXT NOT NULL)`),
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
      markId: privateChannel, createdByUserId: creator,
    });
  });

  it("gives a Breakout with no look of its own the Channel's, resolved from the Channel's id", async () => {
    expect(await subject(privateChannel, plainBreakout)).toEqual({
      kind: "breakout", title: "Pricing", appearance: { icon: "rocket", color: "teal" },
      markId: privateChannel, createdByUserId: breakoutCreator,
    });
  });

  it("keeps a Breakout's own look, resolved from its own id", async () => {
    expect(await subject(privateChannel, markedBreakout)).toEqual({
      kind: "breakout", title: "Copy", appearance: { icon: null, color: "amber" },
      markId: markedBreakout, createdByUserId: breakoutCreator,
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
  it("keeps one pending request per person per conversation, so asking again sends nothing new", async () => {
    const first = await ask();
    const again = await ask();
    expect(first.created).toBe(true);
    expect(again).toEqual({ request: first.request, created: false });
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
