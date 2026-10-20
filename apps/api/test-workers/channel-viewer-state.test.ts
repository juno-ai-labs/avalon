/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Channel's breakouts and background agents reach its readers on the
 * Organization socket, with no Channel socket at all.
 *
 * The Channel control socket used to add these to what the sidebar row said,
 * one socket per Channel a desktop held. They now ride the Channel's row on
 * the workspace socket: the connect sidebar, and every
 * `workspace_workstream_state` push. Each test here drives a real parent
 * change through the Organization object's own RPCs and reads the frames a
 * real hibernating workspace socket receives. `docs/realtime-sockets.md` owns
 * the protocol.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type SubstreamId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import { hostedParentStub } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000f0001");
const channelA = asWorkstreamId("00000000-0000-4000-8000-0000000f00a0");
const channelB = asWorkstreamId("00000000-0000-4000-8000-0000000f00b0");
const breakoutA = asSubstreamId("00000000-0000-4000-8000-0000000f00a1");
const breakoutB = asSubstreamId("00000000-0000-4000-8000-0000000f00b1");
const backgroundMain = asSubstreamId("00000000-0000-4000-8000-0000000f00a8");
const backgroundInBreakout = asSubstreamId("00000000-0000-4000-8000-0000000f00a9");
/** In Channel A's breakout, and in Channel B's. */
const member = asUserId("00000000-0000-4000-8000-0000000f0011");
/** Reads both Channels, and is in no breakout. */
const owner = asUserId("00000000-0000-4000-8000-0000000f0012");
const at = "2026-09-25T12:00:00.000Z";

const organization = () => hostedParentStub(env, workspaceId);

let messageSeq = 0;
function envelope(parentId: WorkstreamId, substreamId: SubstreamId, effect: ConversationEffect): ConversationEffectEnvelope {
  messageSeq += 1;
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId,
    parentKind: "workstream",
    parentId,
    substreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(messageSeq).padStart(12, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: messageSeq,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

function common(title: string, extra: Partial<Extract<ConversationEffect, { kind: "directory_common" }>> = {}) {
  return {
    kind: "directory_common" as const,
    title,
    description: "",
    preview: "",
    scope: "workspace" as const,
    state: "idle",
    systemKind: null,
    lastActivityAt: at,
    completedAt: null,
    archivedAt: null,
    createdByUserId: owner,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function viewer(userId: UserId, isParticipant = true) {
  return {
    kind: "directory_user" as const,
    userId,
    isParticipant,
    unreadCount: 0,
    youAreMentioned: false,
    listable: isParticipant,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

/** Publish a Channel's Main the way its conversation does, through the parent step. */
async function publishMain(parentId: WorkstreamId, title: string, extra: Parameters<typeof common>[1] = {}) {
  await organization().receiveChildEffects({
    substreamId: asSubstreamId("0"),
    envelopes: [
      envelope(parentId, asSubstreamId("0"), common(title, extra)),
      envelope(parentId, asSubstreamId("0"), viewer(owner)),
      envelope(parentId, asSubstreamId("0"), viewer(member)),
    ],
  });
}

type Frame = Record<string, unknown> & { type?: string };
type Row = { id: string; privateChildren?: Array<{ substreamId: string }>; privateChildrenWaterline?: number;
  backgroundAgentCounts?: Record<string, number> };

/** Every JSON frame a socket receives, in order, and a way to wait for the next matching one. */
function frames(socket: WebSocket) {
  const received: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.addEventListener("message", (event) => {
    if (String(event.data) === "pong") {
      received.push({ type: "pong" });
    } else {
      received.push(JSON.parse(String(event.data)) as Frame);
    }
    const frame = received.at(-1)!;
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
  });
  return {
    received,
    next(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${label} arrived`)), 5_000);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

const stateOf = (channelId: string) => (frame: Frame) =>
  frame.type === "workspace_workstream_state" && frame.workstreamId === channelId;

let ticketSeq = 0;
async function connect(userId: UserId, afterWaterline = 0) {
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
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const stream = frames(socket);
  const sync = stream.next((frame) => frame.type === "workspace_sync", "subscribe answer");
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline }));
  const answer = await sync as Frame & { waterline: number; sidebar: { workstreams: { items: Row[] } } };
  return { socket, stream, answer };
}

/** Everything the object sent this socket before now has arrived once a ping's auto-response has. */
async function drained(socket: WebSocket, stream: ReturnType<typeof frames>): Promise<void> {
  const pong = stream.next((frame) => frame.type === "pong", "pong");
  socket.send("ping");
  await pong;
}

function rowIn(answer: { sidebar: { workstreams: { items: Row[] } } }, channelId: string): Row {
  const row = answer.sidebar.workstreams.items.find((item) => item.id === channelId);
  if (!row) throw new Error(`sidebar has no row for ${channelId}`);
  return row;
}

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
    ...[owner, member].map((userId) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`,
    ).bind(workspaceId, userId)),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
    ...[owner, member].map((userId) => env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(`session-${userId}`, userId, workspaceId)),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  // Each Channel's parent as its creation leaves it: Main, one ready
  // breakout, and that breakout's roster. Breakout creation itself runs
  // through a conversation object and is covered by its own suite.
  await runInDurableObject(organization(), (_instance, state) => {
    for (const [parentId, breakout] of [[channelA, breakoutA], [channelB, breakoutB]] as const) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`,
      parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main'), (?, ?, 'child', ?, 1, 'Breakout')`,
      parentId, member, parentId, breakout, member);
      state.storage.sql.exec(`INSERT INTO parent_breakout_members
        (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
        VALUES (?, ?, ?, 1, 1, ?, 1, 1)`, parentId, breakout, member, member);
    }
  });
  await publishMain(channelA, "Channel A");
  await publishMain(channelB, "Channel B");
});

describe("a Channel's breakouts and background agents on the workspace socket", () => {
  it("hands each viewer only their own breakouts, per Channel, in the connect sidebar", async () => {
    const memberSocket = await connect(member);
    const ownerSocket = await connect(owner);

    expect(rowIn(memberSocket.answer, channelA).privateChildren?.map((child) => child.substreamId)).toEqual([breakoutA]);
    expect(rowIn(memberSocket.answer, channelB).privateChildren?.map((child) => child.substreamId)).toEqual([breakoutB]);
    // A reader of the Channel who is not on a breakout's roster is told the
    // list is empty, not left without one.
    expect(rowIn(ownerSocket.answer, channelA).privateChildren).toEqual([]);
    expect(rowIn(ownerSocket.answer, channelA).backgroundAgentCounts).toEqual({});
    memberSocket.socket.close(1000, "done");
    ownerSocket.socket.close(1000, "done");
  });

  it("manually resolves Threads and Breakouts, persists across eviction, and refuses an unrelated viewer", async () => {
    const memberSocket = await connect(member);
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: breakoutA, userId: owner }))
      .resolves.toEqual({ outcome: "forbidden" });
    const pushed = memberSocket.stream.next(stateOf(channelA), "manually resolved breakout");
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: breakoutA, userId: member }))
      .resolves.toEqual({ outcome: "resolved" });
    expect((await pushed).workstream).toMatchObject({ privateChildren: [{ substreamId: breakoutA, resolved: true }] });
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: breakoutA, userId: member }))
      .resolves.toEqual({ outcome: "unchanged" });
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: asSubstreamId("0"), userId: owner }))
      .resolves.toEqual({ outcome: "resolved" });
    memberSocket.socket.close(1000, "done");
    await evictDurableObject(organization());
    const reopened = await connect(member);
    expect(rowIn(reopened.answer, channelA)).toMatchObject({ resolved: true, privateChildren: [{ substreamId: breakoutA, resolved: true }] });
    await runInDurableObject(organization(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT substream_id, resolved, archived_at FROM parent_children WHERE parent_id = ? ORDER BY substream_id", channelA).toArray())
        .toEqual([{ substream_id: "0", resolved: 1, archived_at: null }, { substream_id: breakoutA, resolved: 1, archived_at: null }]);
    });
    reopened.socket.close(1000, "done");
  });

  it("resolves Main when a legacy parent's main registry entry is implicit", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM parent_children WHERE parent_id = ? AND substream_id = '0'", channelA);
    });
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: asSubstreamId("0"), userId: owner }))
      .resolves.toEqual({ outcome: "resolved" });
    await runInDurableObject(organization(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT resolved FROM parent_children WHERE parent_id = ? AND substream_id = '0'", channelA).toArray())
        .toEqual([{ resolved: 1 }]);
    });
  });

  it("refuses manual resolution of an archived conversation", async () => {
    // Start from an already-archived registry entry; this suite does not provision a child runtime.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_children SET archived_at = 1 WHERE parent_id = ? AND substream_id = ?", channelA, breakoutA);
    });
    await expect(organization().resolveConversation({ workspaceId, parentId: channelA, substreamId: breakoutA, userId: member }))
      .resolves.toEqual({ outcome: "archived" });
  });

  it("publishes Breakout resolution to readers outside its private roster so shared navigation refreshes", async () => {
    const memberSocket = await connect(member);
    const ownerSocket = await connect(owner);
    const memberRow = memberSocket.stream.next(stateOf(channelA), "resolved member row");
    const effect: ConversationEffect = {
      kind: "activity_event", eventId: crypto.randomUUID(), eventType: "workstream_message_created",
      subjectSequenceNumber: 1, actorType: "user", actorUserId: owner, actorLabel: "Owner",
      title: "Merged", body: "Done", canonicalUrl: null, digestible: false,
      occurredAt: at, sourceKind: "workstream_message", sourceId: crypto.randomUUID(),
      dedupeKey: "resolved-breakout", metadata: { mergedFrom: { breakoutId: breakoutA, title: "Breakout" } }, targets: [],
    };
    await organization().receiveChildEffects({ substreamId: asSubstreamId("0"),
      envelopes: [envelope(channelA, asSubstreamId("0"), effect)] });
    expect((await memberRow).workstream).toMatchObject({ privateChildren: [{ substreamId: breakoutA, resolved: true }] });
    await drained(ownerSocket.socket, ownerSocket.stream);
    expect(ownerSocket.stream.received.find(stateOf(channelA))?.workstream).toMatchObject({ privateChildren: [] });
    memberSocket.socket.close(1000, "done");
    ownerSocket.socket.close(1000, "done");
  });

  it("pushes a changed breakout list to that breakout's members, and to nobody else", async () => {
    const memberSocket = await connect(member);
    const ownerSocket = await connect(owner);
    const pushed = memberSocket.stream.next(stateOf(channelA), "Channel A row");

    await organization().setPrivateChildArchived({
      workspaceId, parentId: channelA, substreamId: breakoutA, actorUserId: member, archived: true,
    });

    const row = (await pushed).workstream as Row;
    expect(row.privateChildren).toEqual([]);
    expect(row.privateChildrenWaterline).toBeGreaterThan(0);
    // Channel B's list did not move, so its row was not sent.
    await drained(memberSocket.socket, memberSocket.stream);
    expect(memberSocket.stream.received.filter(stateOf(channelB))).toEqual([]);
    await drained(ownerSocket.socket, ownerSocket.stream);
    expect(ownerSocket.stream.received.filter(stateOf(channelA))).toEqual([]);
    memberSocket.socket.close(1000, "done");
    ownerSocket.socket.close(1000, "done");
  });

  it("pushes the running background agents to every reader, counted only where each can look", async () => {
    const memberSocket = await connect(member);
    const ownerSocket = await connect(owner);

    const memberMain = memberSocket.stream.next(stateOf(channelA), "Channel A row");
    const ownerMain = ownerSocket.stream.next(stateOf(channelA), "Channel A row");
    await organization().receiveChildEffects({
      substreamId: backgroundMain,
      envelopes: [envelope(channelA, backgroundMain, common("Agent", { state: "running", backgroundAgent: true }))],
    });
    expect(((await memberMain).workstream as Row).backgroundAgentCounts).toEqual({ "0": 1 });
    expect(((await ownerMain).workstream as Row).backgroundAgentCounts).toEqual({ "0": 1 });

    const memberBreakout = memberSocket.stream.next(stateOf(channelA), "Channel A row");
    const ownerBreakout = ownerSocket.stream.next(stateOf(channelA), "Channel A row");
    await organization().receiveChildEffects({
      substreamId: backgroundInBreakout,
      envelopes: [envelope(channelA, backgroundInBreakout, common("Agent", {
        state: "running", backgroundAgent: true, backgroundAgentRootSubstreamId: breakoutA,
      }))],
    });
    expect(((await memberBreakout).workstream as Row).backgroundAgentCounts).toEqual({ "0": 1, [breakoutA]: 1 });
    // The owner cannot open the breakout, so its agent is not theirs to count.
    expect(((await ownerBreakout).workstream as Row).backgroundAgentCounts).toEqual({ "0": 1 });
    memberSocket.socket.close(1000, "done");
    ownerSocket.socket.close(1000, "done");
  });

  it("withdraws only the Channel a reader lost, and keeps their socket and their other Channels", async () => {
    const ownerSocket = await connect(owner);
    const withdrawn = ownerSocket.stream.next(stateOf(channelA), "Channel A tombstone");

    // Channel A narrows to its participants, and the owner is no longer one.
    await organization().receiveChildEffects({
      substreamId: asSubstreamId("0"),
      envelopes: [
        envelope(channelA, asSubstreamId("0"), common("Channel A", { scope: "personal" })),
        envelope(channelA, asSubstreamId("0"), viewer(owner, false)),
      ],
    });
    expect((await withdrawn).workstream).toBeNull();

    const stillThere = ownerSocket.stream.next(stateOf(channelB), "Channel B row");
    await publishMain(channelB, "Channel B, renamed");
    expect(((await stillThere).workstream as Row & { title: string }).title).toBe("Channel B, renamed");
    expect(ownerSocket.socket.readyState).toBe(1); // open
    ownerSocket.socket.close(1000, "done");
  });

  it("gives a socket that was away the current list when it subscribes again from its waterline", async () => {
    const first = await connect(member);
    first.socket.close(1000, "away");

    await organization().setPrivateChildArchived({
      workspaceId, parentId: channelA, substreamId: breakoutA, actorUserId: member, archived: true,
    });

    const again = await connect(member, first.answer.waterline);
    expect(rowIn(again.answer, channelA).privateChildren).toEqual([]);
    expect(rowIn(again.answer, channelB).privateChildren?.map((child) => child.substreamId)).toEqual([breakoutB]);
    again.socket.close(1000, "done");
  });

  it("warms a Channel's Main when a reader brings the Channel to the foreground", async () => {
    const { socket } = await connect(member);
    const main = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", workspaceId, channelA),
    ));
    socket.send(JSON.stringify({
      type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: channelA,
    }));
    // Whether Main is running is the observable, and eviction is what asks:
    // the harness refuses to evict an object that was never started. The wake
    // is not awaited by the presence frame, so give it a few turns to land.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await evictDurableObject(main);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(lastError).toBeNull();
    socket.close(1000, "done");
  });
});
