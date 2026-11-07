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
  asUserId,
  asWorkspaceId,
  type UserId,
} from "@rally/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import pushDevicesMigration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import { splitSqlStatements } from "../src/lib/sql-statements";
import type { HonoAppEnv } from "../src/env";
import { noteChangedConnection, workspaceRealtimeInvalidation } from "../src/middleware/workspace-realtime";
import { hostedParentStub } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000fd001");
const owner = asUserId("00000000-0000-4000-8000-0000000fd011");
const member = asUserId("00000000-0000-4000-8000-0000000fd012");
/** A member of the Organization who is in neither Channel's participants. */
const outsider = asUserId("00000000-0000-4000-8000-0000000fd013");
const personalConnection = "00000000-0000-4000-8000-0000000fd0c1";
const organizationConnection = "00000000-0000-4000-8000-0000000fd0c2";
const organization = () => hostedParentStub(env, workspaceId);

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

function close(...sockets: Connected[]): void {
  for (const { socket } of sockets) socket.close(1000, "done");
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
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY)`),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL, revoked_at TEXT,
      expires_at TEXT NOT NULL, impersonator_user_id TEXT)`),
    ...[owner, member, outsider].map((userId) => env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(`session-${userId}`, userId, workspaceId)),
  ]);
  await env.DB.batch(splitSqlStatements(pushDevicesMigration).map((sql) => env.DB.prepare(sql)));
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
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
});

describe("a workspace sync topic's audience", () => {
  it("tells only its owner of a per-person change, now and on replay after a reconnect", async () => {
    // A log to resume from: waterline 0 is a first connect, not a resume.
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const ownerSocket = await connect(owner);
    const memberSocket = await connect(member);
    const waterline = ownerSocket.answer.waterline;
    const told = ownerSocket.stream.next(syncWith("viewer_preferences"), "preference invalidation");

    await organization().publishSync(["viewer_preferences"], workspaceId, "wnam", { audienceUserIds: [owner] });

    expect((await told).topics).toEqual(["viewer_preferences"]);
    await drained(memberSocket);
    expect(memberSocket.stream.received.filter(syncWith("viewer_preferences"))).toEqual([]);
    close(ownerSocket, memberSocket);

    // Both were away for it; only its owner is told on the way back.
    const ownerAgain = await connect(owner, waterline);
    const memberAgain = await connect(member, waterline);
    expect(ownerAgain.answer).toMatchObject({ reason: "change", topics: ["viewer_preferences"] });
    expect(memberAgain.answer).toMatchObject({ reason: "resume", topics: [] });
    close(ownerAgain, memberAgain);
  });

  it("answers a replay at the log's waterline, past events that were other people's", async () => {
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const away = await connect(member);
    const waterline = away.answer.waterline;
    close(away);

    await organization().publishSync(["resources"], workspaceId, "wnam");
    const latest = await organization().publishSync(["viewer_preferences"], workspaceId, "wnam", { audienceUserIds: [owner] });

    const back = await connect(member, waterline);
    // Left at the member's own newest event, the cursor would trail every
    // later event for somebody else and fall out of the pruning window.
    expect(back.answer).toMatchObject({ reason: "change", topics: ["resources"], waterline: latest });
    close(back);
  });

  it("drops a retired topic from a stored event on replay, and still answers the resume", async () => {
    await organization().publishSync(["terminal_policy"], workspaceId, "wnam");
    const away = await connect(member);
    const waterline = away.answer.waterline;
    close(away);
    // An event written before Activity and the Thread directory were retired.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_sync_events(event_id, topics_json, audience_json, occurred_at)
        VALUES (?, ?, NULL, ?)`, crypto.randomUUID(), JSON.stringify(["activity", "workstream_directory", "resources"]), Date.now());
    });

    const back = await connect(member, waterline);
    expect(back.answer).toMatchObject({ reason: "change", topics: ["resources"] });
    // The one-release compatibility page a pre-pivot desktop requires to parse.
    expect(back.answer).toMatchObject({ sidebar: {
      workstreams: { directoryWaterline: 0, items: [], stateVersions: [], nextCursor: null },
      notes: { waterline: 0, items: [], nextCursor: null },
    } });
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
    expect((await told).topics).toEqual(["connector_connections", "resources"]);
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
