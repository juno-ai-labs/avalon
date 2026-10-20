/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Who the Organization's workspace socket tells about a change, and how often.
 *
 * A Channel's row goes to the people who can see the Channel, plus the people
 * a write just took it from, who are sent its `workstream: null` tombstone;
 * anybody else is sent nothing, because a null row still names a private
 * Channel and says when it moved. A person's row is built once for all of
 * their sockets, and a burst of writes to one Channel in one delivery sends
 * it once. A sync topic that is one person's setting reaches that person's
 * sockets only, live and on replay after a reconnect.
 *
 * Every test drives the Organization object through the RPCs production uses
 * and reads the frames real hibernating workspace sockets receive.
 * `docs/websocket-architecture.md` owns the fan-out rules.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffectEnvelope,
  type SubstreamId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { noteChangedConnection, workspaceRealtimeInvalidation } from "../src/middleware/workspace-realtime";
import { hostedParentStub } from "./helpers/hosted-parent";
import { changeRelationships } from "./helpers/workspace-relationship-events";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000fd001");
/** Every member reads it. */
const openChannel = asWorkstreamId("00000000-0000-4000-8000-0000000fd0a0");
/** Only its participants, `owner` and `member`, read it. */
const privateChannel = asWorkstreamId("00000000-0000-4000-8000-0000000fd0b0");
const owner = asUserId("00000000-0000-4000-8000-0000000fd011");
const member = asUserId("00000000-0000-4000-8000-0000000fd012");
/** A member of the Organization who is in neither Channel's participants. */
const outsider = asUserId("00000000-0000-4000-8000-0000000fd013");
/** Joins the Organization partway through a test. */
const newcomer = asUserId("00000000-0000-4000-8000-0000000fd014");
const personalConnection = "00000000-0000-4000-8000-0000000fd0c1";
const organizationConnection = "00000000-0000-4000-8000-0000000fd0c2";
const at = "2026-09-26T12:00:00.000Z";

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

type Common = Extract<ConversationEffect, { kind: "directory_common" }>;
function common(title: string, extra: Partial<Common> = {}): Common {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope: "workspace",
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

/** A Channel's common row at `generation`, as the directory step receives it. */
function atGeneration(parentId: WorkstreamId, generation: number, effect: Common, messageId: string): ParentEffectEnvelope {
  return {
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId,
    parentKind: "workstream",
    parentId,
    generation,
    messageId,
    partitionKey: "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

/** Main's own effects, through the parent step, the way its conversation publishes them. */
async function publishMain(parentId: WorkstreamId, ...effects: ConversationEffect[]) {
  await organization().receiveChildEffects({
    substreamId: asSubstreamId("0"),
    envelopes: effects.map((effect) => envelope(parentId, asSubstreamId("0"), effect)),
  });
}

type Frame = Record<string, unknown> & { type?: string };

/** Every JSON frame a socket receives, in order, and a way to wait for the next matching one. */
function frames(socket: WebSocket) {
  const received: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.addEventListener("message", (event) => {
    received.push(String(event.data) === "pong" ? { type: "pong" } : JSON.parse(String(event.data)) as Frame);
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
/** A live change naming `topic`; the subscribe answer names every topic and is not one. */
const syncWith = (topic: string) => (frame: Frame) =>
  frame.type === "workspace_sync" && frame.reason === "change" && (frame.topics as string[]).includes(topic);

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
      "x-rally-socket-ticket-id": `00000000-0000-7000-8002-${String(ticketSeq).padStart(12, "0")}`,
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
  const answer = await sync as Frame & { waterline: number; reason: string; topics: string[] };
  return { socket, stream, answer, userId };
}
type Connected = Awaited<ReturnType<typeof connect>>;

/** Everything the object sent this socket before now has arrived once a ping's auto-response has. */
async function drained(...sockets: Connected[]): Promise<void> {
  for (const { socket, stream } of sockets) {
    const pong = stream.next((frame) => frame.type === "pong", "pong");
    socket.send("ping");
    await pong;
  }
}

/** The Channel rows a socket received after the subscribe answer. */
function rowsFor(connected: Connected, channelId: string): Frame[] {
  return connected.stream.received.filter(stateOf(channelId));
}

function close(...sockets: Connected[]): void {
  for (const { socket } of sockets) socket.close(1000, "done");
}

interface FollowUpRunner {
  runDirectoryFollowUps(entries: readonly number[]): Promise<void>;
}

/**
 * Keep every write's post-commit pass from running, the way a failed or
 * delayed one leaves its recorded follow-up for the alarm. The returned
 * release runs everything recorded meanwhile as one pass, as the alarm does.
 */
async function holdFollowUps(): Promise<() => Promise<void>> {
  await runInDurableObject(organization(), (instance) => {
    (instance as unknown as FollowUpRunner).runDirectoryFollowUps = async () => {};
  });
  return () => runInDurableObject(organization(), async (instance, state) => {
    delete (instance as unknown as Record<string, unknown>).runDirectoryFollowUps;
    await (instance as unknown as FollowUpRunner).runDirectoryFollowUps(pendingFollowUps(state));
  });
}

function pendingFollowUps(state: DurableObjectState): number[] {
  return state.storage.sql.exec<{ id: number }>(
    `SELECT id FROM workspace_directory_followups WHERE state = 'pending' ORDER BY id`,
  ).toArray().map((row) => row.id);
}

/** Somebody who becomes an active member now, with a session to connect with. */
async function join(userId: UserId): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(workspaceId, userId),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, workspaceId),
  ]);
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
    ...[owner, member, outsider].map((userId) => env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`,
    ).bind(workspaceId, userId)),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
    ...[owner, member, outsider].map((userId) => env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(`session-${userId}`, userId, workspaceId)),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const parentId of [openChannel, privateChannel]) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`,
      parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main')`, parentId, owner);
    }
    for (const [id, scope, ownerUserId, pluginId] of [
      [personalConnection, "personal", owner, "plugin_linear_personal"],
      [organizationConnection, "workspace", null, "plugin_linear_workspace"],
    ] as const) {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id, created_at, updated_at)
        VALUES (?, ?, 'linear', ?, ?, 'Linear', ?, 'now', 'now')`,
      id, workspaceId, scope, ownerUserId, pluginId);
    }
  });
  await publishMain(openChannel, common("Open"), viewer(owner), viewer(member));
  await publishMain(privateChannel, common("Private", { scope: "personal" }), viewer(owner), viewer(member));
});

describe("a Channel's row on the workspace socket", () => {
  it("admits cached conversation views separately for the parent and its private breakout", async () => {
    const child = asSubstreamId("00000000-0000-7000-8000-0000000fd099");
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO parent_children(parent_id, substream_id, kind, created_at)
        VALUES (?, ?, 'child', 1)`, openChannel, child);
      state.storage.sql.exec(`INSERT INTO parent_breakout_members
        (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
        VALUES (?, ?, ?, 1, 1, ?, 1, 1)`, openChannel, child, owner, owner);
    });
    for (const substreamId of [asSubstreamId("0"), child]) {
      await organization().applyConversationView({
        type: "conversation_view_v1", region: "global", workspaceId, parentId: openChannel,
        substreamId, turnId: "", generation: 1, revision: 1, content: null,
        header: { title: substreamId === "0" ? "Shared preview" : "Private preview",
          titleStatus: "settled", scope: "personal", harnessStatus: "completed", createdAt: at, updatedAt: at },
      });
    }
    const ownerSocket = await connect(owner);
    const outsiderSocket = await connect(outsider);
    let request = 0;
    const view = async (connection: Connected, substreamId: SubstreamId) => {
      request += 1;
      const requestId = `00000000-0000-7000-8003-${String(request).padStart(12, "0")}`;
      const answer = connection.stream.next(
        (frame) => frame.type === "workspace_conversation_view" && frame.requestId === requestId, "cached view",
      );
      connection.socket.send(JSON.stringify({ type: "conversation_view", requestId, parentId: openChannel, substreamId }));
      return (await answer).view;
    };
    expect(await view(outsiderSocket, asSubstreamId("0"))).toMatchObject({ header: { title: "Shared preview" } });
    expect(await view(outsiderSocket, child)).toBeNull();
    expect(await view(ownerSocket, child)).toMatchObject({ header: { title: "Private preview" } });
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_breakout_members SET active = 0 WHERE parent_id = ? AND substream_id = ?",
        openChannel, child);
    });
    expect(await view(ownerSocket, child)).toBeNull();
    close(ownerSocket, outsiderSocket);
  });

  it("reaches the people who can see the Channel, and says nothing to anybody else", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const memberRow = memberSocket.stream.next(stateOf(privateChannel), "private Channel row");
    const outsiderOpenRow = outsiderSocket.stream.next(stateOf(openChannel), "open Channel row");

    await publishMain(privateChannel, common("Private, renamed", { scope: "personal" }));
    await publishMain(openChannel, common("Open, renamed"));

    expect(((await memberRow).workstream as { title: string }).title).toBe("Private, renamed");
    // The outsider's socket is live and hears the Channel they can read ...
    expect(((await outsiderOpenRow).workstream as { title: string }).title).toBe("Open, renamed");
    // ... and never heard the private Channel's id, not even as a tombstone.
    await drained(outsiderSocket);
    expect(rowsFor(outsiderSocket, privateChannel)).toEqual([]);
    close(memberSocket, outsiderSocket);
  });

  it("sends the tombstone to a participant removed from a private Channel, and to nobody who never saw it", async () => {
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const withdrawn = ownerSocket.stream.next(stateOf(privateChannel), "private Channel tombstone");
    const stillShown = memberSocket.stream.next(stateOf(privateChannel), "private Channel row");

    await publishMain(privateChannel, viewer(owner, false));

    expect((await withdrawn).workstream).toBeNull();
    expect((await stillShown).workstream).not.toBeNull();
    await drained(outsiderSocket);
    expect(rowsFor(outsiderSocket, privateChannel)).toEqual([]);
    close(ownerSocket, memberSocket, outsiderSocket);
  });

  it("sends the tombstone to every reader an Organization-wide Channel narrowed away from", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const withdrawn = outsiderSocket.stream.next(stateOf(openChannel), "open Channel tombstone");
    const stillShown = memberSocket.stream.next(stateOf(openChannel), "open Channel row");

    // Narrowed to its participants; the outsider could read it until now.
    await publishMain(openChannel, common("Open", { scope: "personal" }));

    expect((await withdrawn).workstream).toBeNull();
    expect(((await stillShown).workstream as { title: string }).title).toBe("Open");
    close(memberSocket, outsiderSocket);
  });

  it("sends an archived Channel's tombstone to exactly the people who could see it", async () => {
    const ownerSocket = await connect(owner);
    const outsiderSocket = await connect(outsider);
    const privateGone = ownerSocket.stream.next(stateOf(privateChannel), "private Channel tombstone");
    const openGone = outsiderSocket.stream.next(stateOf(openChannel), "open Channel tombstone");

    await publishMain(privateChannel, common("Private", { scope: "personal", archivedAt: at }));
    await publishMain(openChannel, common("Open", { archivedAt: at }));

    expect((await privateGone).workstream).toBeNull();
    expect((await openGone).workstream).toBeNull();
    await drained(outsiderSocket);
    expect(rowsFor(outsiderSocket, privateChannel)).toEqual([]);
    close(ownerSocket, outsiderSocket);
  });

  it("sends the tombstone to participants a new authority generation hides the Channel from", async () => {
    const ownerSocket = await connect(owner);
    const outsiderSocket = await connect(outsider);
    const hidden = ownerSocket.stream.next(stateOf(privateChannel), "private Channel tombstone");
    const next = atGeneration(privateChannel, 2, common("Private", { scope: "personal" }), "00000000-0000-7000-8000-0000000fd0e1");

    // Until each participant's row arrives at generation 2, none of them joins it.
    await organization().applyWorkstreamDirectoryEffects({ workspaceId, envelopes: [next] });

    expect((await hidden).workstream).toBeNull();
    await drained(outsiderSocket);
    expect(rowsFor(outsiderSocket, privateChannel)).toEqual([]);
    close(ownerSocket, outsiderSocket);
  });

  it("sends the tombstone to every reader when an Organization-wide Channel returns at a new generation for its participants only", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const memberHidden = memberSocket.stream.next(stateOf(openChannel), "open Channel tombstone");
    const outsiderHidden = outsiderSocket.stream.next(stateOf(openChannel), "open Channel tombstone");
    const next = atGeneration(openChannel, 2, common("Open", { scope: "personal" }), "00000000-0000-7000-8000-0000000fd0e2");

    // The outsider read it as an Organization-wide Channel and has no viewer
    // row; the member's row is at generation 1 and does not join generation 2.
    await organization().applyWorkstreamDirectoryEffects({ workspaceId, envelopes: [next] });

    expect((await memberHidden).workstream).toBeNull();
    expect((await outsiderHidden).workstream).toBeNull();
    close(memberSocket, outsiderSocket);
  });

  it("owes a narrowed Channel's tombstone to nobody who joined after the write, however late its follow-up runs", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const release = await holdFollowUps();

    await publishMain(openChannel, common("Open", { scope: "personal" }));
    // Joins, and connects to a sidebar that never had the Channel, before the
    // narrowing's follow-up has run.
    await join(newcomer);
    const newcomerSocket = await connect(newcomer);
    const withdrawn = outsiderSocket.stream.next(stateOf(openChannel), "open Channel tombstone");
    const stillShown = memberSocket.stream.next(stateOf(openChannel), "open Channel row");
    await release();

    expect((await withdrawn).workstream).toBeNull();
    expect((await stillShown).workstream).not.toBeNull();
    await drained(newcomerSocket);
    expect(rowsFor(newcomerSocket, openChannel)).toEqual([]);
    close(memberSocket, outsiderSocket, newcomerSocket);
  });

  it("sends the Channels of every follow-up run in one pass once per socket", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const release = await holdFollowUps();

    // Two deliveries, each its own write and its own recorded follow-up.
    await publishMain(openChannel, common("Open, first"));
    await publishMain(openChannel, common("Open, second"));
    await release();

    await drained(memberSocket, outsiderSocket);
    for (const connected of [memberSocket, outsiderSocket]) {
      expect(rowsFor(connected, openChannel).map((frame) => (frame.workstream as { title: string }).title))
        .toEqual(["Open, second"]);
    }
    close(memberSocket, outsiderSocket);
  });

  it("sends everybody else their row when one person's cannot be built, and finishes the follow-up", async () => {
    const sockets = [await connect(member), await connect(outsider)];
    // Whoever's row is built first cannot be, so the other is built after it.
    let unbuildable: string | null = null;
    await runInDurableObject(organization(), (instance) => {
      const target = instance as unknown as {
        channelRowPayloads(person: { userId: string }, ...rest: unknown[]): string[];
      };
      const original = target.channelRowPayloads.bind(target);
      target.channelRowPayloads = (person, ...rest) => {
        unbuildable ??= person.userId;
        if (person.userId === unbuildable) throw new Error("channel_row_unbuildable");
        return original(person, ...rest);
      };
    });

    await publishMain(openChannel, common("Open, renamed"));

    await drained(...sockets);
    const failed = sockets.find((connected) => connected.userId === unbuildable)!;
    const served = sockets.find((connected) => connected.userId !== unbuildable)!;
    expect(rowsFor(failed, openChannel)).toEqual([]);
    expect(rowsFor(served, openChannel).map((frame) => (frame.workstream as { title: string }).title))
      .toEqual(["Open, renamed"]);
    // Not put off for the alarm to re-run its reconciliations and notices.
    expect(await runInDurableObject(organization(), (_instance, state) => pendingFollowUps(state))).toEqual([]);
    close(...sockets);
  });

  it("sends the tombstone to a member who left the Organization while their socket is still open", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    const withdrawn = memberSocket.stream.next(stateOf(privateChannel), "private Channel tombstone");

    await changeRelationships(env, workspaceId, [member],
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, member));

    expect((await withdrawn).workstream).toBeNull();
    await drained(outsiderSocket);
    expect(rowsFor(outsiderSocket, privateChannel)).toEqual([]);
    close(memberSocket, outsiderSocket);
  });

  it("builds one person's row once and sends it to each of their sockets", async () => {
    const built: string[] = [];
    await runInDurableObject(organization(), (instance) => {
      const target = instance as unknown as {
        channelRowPayloads(person: { userId: string }, ...rest: unknown[]): string[];
      };
      const original = target.channelRowPayloads.bind(target);
      target.channelRowPayloads = (person, ...rest) => {
        built.push(person.userId);
        return original(person, ...rest);
      };
    });
    const first = await connect(member);
    const second = await connect(member);
    const firstRow = first.stream.next(stateOf(openChannel), "open Channel row");
    const secondRow = second.stream.next(stateOf(openChannel), "open Channel row");

    await publishMain(openChannel, common("Open, renamed"));

    expect(await secondRow).toEqual(await firstRow);
    expect(built.filter((userId) => userId === member)).toEqual([member]);
    close(first, second);
  });

  it("sends a burst of changes to one Channel in one delivery as one row per socket", async () => {
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);

    await publishMain(openChannel, ...[1, 2, 3, 4, 5].map((turn) => common(`Open, turn ${turn}`)));

    await drained(memberSocket, outsiderSocket);
    for (const connected of [memberSocket, outsiderSocket]) {
      expect(rowsFor(connected, openChannel).map((frame) => (frame.workstream as { title: string }).title))
        .toEqual(["Open, turn 5"]);
    }
    close(memberSocket, outsiderSocket);
  });
});

describe("a workspace sync topic's audience", () => {
  it("tells only its owner of a per-person change, now and on replay after a reconnect", async () => {
    // A log to resume from: waterline 0 is a first connect, not a resume.
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    const waterline = ownerSocket.answer.waterline;
    const told = ownerSocket.stream.next(syncWith("digest_schedule"), "digest invalidation");

    await organization().publishSync(["digest_schedule"], workspaceId, "wnam", { audienceUserIds: [owner] });

    expect((await told).topics).toEqual(["digest_schedule"]);
    await drained(memberSocket);
    expect(memberSocket.stream.received.filter(syncWith("digest_schedule"))).toEqual([]);
    close(ownerSocket, memberSocket);

    // Both were away for it; only its owner is told on the way back.
    const ownerAgain = await connect(owner, waterline);
    const memberAgain = await connect(member, waterline);
    expect(ownerAgain.answer).toMatchObject({ reason: "change", topics: ["digest_schedule"] });
    expect(memberAgain.answer).toMatchObject({ reason: "resume", topics: [] });
    close(ownerAgain, memberAgain);
  });

  it("answers a replay at the log's waterline, past events that were other people's", async () => {
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const away = await connect(member);
    const waterline = away.answer.waterline;
    close(away);

    await organization().publishSync(["notes"], workspaceId, "wnam");
    const latest = await organization().publishSync(["digest_schedule"], workspaceId, "wnam", { audienceUserIds: [owner] });

    const back = await connect(member, waterline);
    // Left at the member's own newest event, the cursor would trail every
    // later event for somebody else and fall out of the pruning window.
    expect(back.answer).toMatchObject({ reason: "change", topics: ["notes"], waterline: latest });
    close(back);
  });

  it("replays a personal connection's change to its owner alone", async () => {
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const away = await connect(owner);
    const waterline = away.answer.waterline;
    close(away);

    await organization().publishSync(["connector_connections"], workspaceId, "wnam", { connectionId: personalConnection });

    const ownerBack = await connect(owner, waterline);
    const memberBack = await connect(member, waterline);
    expect(ownerBack.answer).toMatchObject({ reason: "change", topics: ["connector_connections"] });
    expect(memberBack.answer).toMatchObject({ reason: "resume", topics: [] });
    close(ownerBack, memberBack);
  });

  it("tells the connection a request's route named to its audience, through the request middleware", async () => {
    const app = new Hono<HonoAppEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", { workspaceId, userId: owner } as HonoAppEnv["Variables"]["auth"]);
      await next();
    });
    app.use("*", workspaceRealtimeInvalidation);
    // A creating route: the path carries no id, so the route names it.
    app.post("/connections/custom-mcp", (c) => {
      noteChangedConnection(c, personalConnection);
      return c.body(null, 201);
    });
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    const told = ownerSocket.stream.next(syncWith("connector_connections"), "created connection invalidation");

    const context = createExecutionContext();
    const response = await app.fetch(new Request("https://api.test/connections/custom-mcp", { method: "POST" }), env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(201);
    expect((await told).topics).toEqual(["connector_connections", "digest_schedule", "resources"]);
    await drained(memberSocket);
    expect(memberSocket.stream.received.filter(syncWith("connector_connections"))).toEqual([]);
    close(ownerSocket, memberSocket);
  });

  it("tells a personal connection's change to its owner, and an Organization connection's to everyone", async () => {
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    const ownerTold = ownerSocket.stream.next(syncWith("connector_connections"), "personal connection invalidation");

    await organization().publishSync(["connector_connections"], workspaceId, "wnam", { connectionId: personalConnection });
    await ownerTold;
    await drained(memberSocket);
    expect(memberSocket.stream.received.filter(syncWith("connector_connections"))).toEqual([]);

    const ownerToldAgain = ownerSocket.stream.next(syncWith("resources"), "Organization connection invalidation");
    const memberTold = memberSocket.stream.next(syncWith("resources"), "Organization connection invalidation");
    await organization().publishSync(["resources"], workspaceId, "wnam", { connectionId: organizationConnection });
    expect((await ownerToldAgain).topics).toEqual(["resources"]);
    expect((await memberTold).topics).toEqual(["resources"]);
    close(ownerSocket, memberSocket);
  });

  it("still tells everyone of an Organization-wide change", async () => {
    const ownerSocket = await connect(owner);
    const outsiderSocket = await connect(outsider);
    const ownerTold = ownerSocket.stream.next(syncWith("terminal_policy"), "terminal policy invalidation");
    const outsiderTold = outsiderSocket.stream.next(syncWith("terminal_policy"), "terminal policy invalidation");

    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");

    expect((await ownerTold).topics).toEqual(["terminal_policy"]);
    expect((await outsiderTold).topics).toEqual(["terminal_policy"]);
    close(ownerSocket, outsiderSocket);
  });
});
