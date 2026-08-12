import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkstreamRoom } from "../src/durable-objects/workstream-room";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

const WORKSPACE = "00000000-0000-7000-8000-0000000000c0";
const PARTICIPANT = "00000000-0000-7000-8000-0000000000c1";
const MEMBER = "00000000-0000-7000-8000-0000000000c2";
const OUTSIDER = "00000000-0000-7000-8000-0000000000c3";
const WORKSTREAM = "00000000-0000-7000-8000-0000000000c4";
const at = "2026-08-11T09:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  // The constructor registers a hibernation-friendly ping/pong pair through two
  // Workers globals this Node suite does not have.
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(readonly request: string, readonly response: string) {}
  });
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${PARTICIPANT}', 'g-1', 'one@example.com', 'One', '${at}', '${at}'),
           ('${MEMBER}', 'g-2', 'two@example.com', 'Two', '${at}', '${at}'),
           ('${OUTSIDER}', 'g-3', 'three@example.com', 'Three', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${PARTICIPANT}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${PARTICIPANT}', 'owner', 'active', '${at}'),
           ('${WORKSPACE}', '${MEMBER}', 'member', 'active', '${at}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
       created_by_user_id, harness_status, next_sequence_number, last_activity_at,
       created_at, updated_at, visibility)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Compensation review', '', 'x@automation.example',
            'active', 'ad_hoc', '${PARTICIPANT}', 'idle', 1, '${at}', '${at}', '${at}', 'private');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${WORKSTREAM}', '${PARTICIPANT}', '${PARTICIPANT}', 'creator', '${at}');
  `);
  return database;
}

interface FakeSocket {
  userId: string;
  closes: { code: number; reason: string }[];
  sent: string[];
  deserializeAttachment(): unknown;
  serializeAttachment(value: unknown): void;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

/** A hibernation-API socket, as far as the room touches one. */
function fakeSocket(userId: string): FakeSocket {
  const closes: { code: number; reason: string }[] = [];
  const sent: string[] = [];
  let attachment: unknown = {
    connectionId: "8f14e45f-ceea-467a-9e6f-1a9f9c8b3f21",
    workspaceId: WORKSPACE,
    workstreamId: WORKSTREAM,
    userId,
    connectedAt: at,
    afterSequence: 0,
    subscribed: true,
  };
  return {
    userId,
    closes,
    sent,
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: unknown) => { attachment = value; },
    send: (payload: string) => { sent.push(payload); },
    close: (code: number, reason: string) => { closes.push({ code, reason }); },
  };
}

function roomFor(database: DatabaseSync, sockets: FakeSocket[] = []): WorkstreamRoom {
  const storage = new Map<string, unknown>([
    ["roomIdentity", { workspaceId: WORKSPACE, workstreamId: WORKSTREAM }],
  ]);
  const state = createCloudflareTestBinding<DurableObjectState>({
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
      setAlarm: async () => undefined,
      transaction: async (body: (t: unknown) => Promise<unknown>) => body({
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
        delete: async (key: string) => storage.delete(key),
      }),
    },
  });
  return new WorkstreamRoom(
    state,
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" }),
  );
}

function publish(room: WorkstreamRoom, event: Record<string, unknown>): Promise<Response> {
  return room.fetch(new Request("https://room.internal/internal/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-avalon-workspace-id": WORKSPACE,
      "x-avalon-workstream-id": WORKSTREAM,
    },
    body: JSON.stringify(event),
  }));
}

/**
 * Every connection here carries a ticket that has already expired.
 *
 * A socket that is authorized goes on to build a `WebSocketPair` and a 101
 * response, neither of which exists in Node — so the ticket is what stops it a
 * step later, and the difference between "refused at the gate" and "let
 * through" is legible as 403 against 401.
 */
function connectAs(room: WorkstreamRoom, userId: string): Promise<Response> {
  return room.fetch(new Request("https://room.internal/socket", {
    headers: {
      Upgrade: "websocket",
      "x-avalon-workspace-id": WORKSPACE,
      "x-avalon-workstream-id": WORKSTREAM,
      "x-avalon-user-id": userId,
      "x-avalon-socket-ticket-id": "3f1b0f4a-59cb-4f5f-8d1e-6d3e5a2a9c11",
      "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) - 1),
    },
  }));
}

describe("who the work-stream room lets connect", () => {
  // The room authorizes each socket itself rather than trusting the ticket, and
  // that check used to be a copy of the read rule that had lost `visibility` — so a
  // member who was not a participant could open a socket onto a private work
  // stream and be sent its transcript live.
  it("refuses a member who is not in a private work stream", async () => {
    const response = await connectAs(roomFor(seededDatabase()), MEMBER);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("refuses somebody who is not in the workspace at all", async () => {
    const response = await connectAs(roomFor(seededDatabase()), OUTSIDER);

    expect(response.status).toBe(403);
  });

  it("lets that same member in once the work stream is open to the workspace", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workstreams SET visibility = 'public' WHERE id = '${WORKSTREAM}'`);

    const response = await connectAs(roomFor(database), MEMBER);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "socket_ticket_replayed" });
  });
});

describe("who the work-stream room disconnects", () => {
  // Connect-time authorization only covers the sockets opened after a change.
  // These are the ones that were already inside, which is what a bystander
  // reading the work stream at the moment it closes actually is.
  it("closes the reader a work stream just became private without", async () => {
    const evicted = fakeSocket(MEMBER);
    const kept = fakeSocket(PARTICIPANT);
    const room = roomFor(seededDatabase(), [evicted, kept]);

    const response = await publish(room, { type: "workstream_visibility_changed", visibility: "private" });

    expect(response.status).toBe(202);
    expect(evicted.closes).toEqual([
      { code: 1008, reason: "You can no longer read this work stream" },
    ]);
    expect(kept.closes).toEqual([]);
    // Swept before the broadcast, so the event that excluded them is not the
    // last thing they are sent.
    expect(evicted.sent).toEqual([]);
    // The visibility change, and a refreshed roster: the people who stay must stop
    // seeing the evicted reader listed as present in a work stream they were
    // just shut out of.
    expect(kept.sent.map((payload) => (JSON.parse(payload) as { type: string }).type))
      .toEqual(["workstream_visibility_changed", "presence_changed"]);
  });

  it("closes a participant who was taken out of a private work stream", async () => {
    const database = seededDatabase();
    const removed = fakeSocket(PARTICIPANT);
    const room = roomFor(database, [removed]);
    // Losing a participant retracts read access in a private work stream
    // exactly as narrowing the visibility does, and nothing else disconnects them.
    database.exec(`DELETE FROM workstream_participants WHERE user_id = '${PARTICIPANT}'`);

    const response = await publish(room, { type: "participant_removed", userId: PARTICIPANT });

    expect(response.status).toBe(202);
    expect(removed.closes.map((close) => close.code)).toEqual([1008]);
  });

  it("leaves everyone in place when the work stream is open to the workspace", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workstreams SET visibility = 'public' WHERE id = '${WORKSTREAM}'`);
    const reader = fakeSocket(MEMBER);
    const room = roomFor(database, [reader]);

    await publish(room, { type: "participant_removed", userId: PARTICIPANT });

    expect(reader.closes).toEqual([]);
    expect(reader.sent).toHaveLength(1);
  });

  it("re-checks on its own when the retraction never reached it", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workstreams SET visibility = 'public' WHERE id = '${WORKSTREAM}'`);
    const reader = fakeSocket(MEMBER);
    const room = roomFor(database, [reader]);
    // An ordinary event: the room checks the connected set and finds nothing
    // wrong, which is also what starts its revalidation clock.
    await publish(room, { type: "harness_status_changed", status: "running" });
    expect(reader.closes).toEqual([]);

    // The work stream goes private and the publisher that would have said so
    // fails — `publishWorkstreamEvent` swallows that, so the room is never told.
    database.exec(`UPDATE workstreams SET visibility = 'private' WHERE id = '${WORKSTREAM}'`);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);

    // The next thing the room would have sent them is what catches it.
    await publish(room, { type: "harness_status_changed", status: "completed" });

    expect(reader.closes.map((close) => close.code)).toEqual([1008]);
    expect(reader.sent).toHaveLength(1);
  });

  it("does not re-check on every frame of a stream", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workstreams SET visibility = 'public' WHERE id = '${WORKSTREAM}'`);
    const reader = fakeSocket(MEMBER);
    const room = roomFor(database, [reader]);
    await publish(room, { type: "harness_status_changed", status: "running" });
    database.exec(`UPDATE workstreams SET visibility = 'private' WHERE id = '${WORKSTREAM}'`);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);

    // Deltas are the one high-frequency event, and a turn that emits them has
    // already passed a `stream_started` through the check.
    await publish(room, {
      type: "stream_delta",
      messageId: WORKSTREAM,
      delta: "…",
      reset: false,
      turnId: "turn-1",
      epoch: 0,
      streamSeq: 1,
    });

    expect(reader.closes).toEqual([]);
  });

  it("makes everyone reconnect, rather than stranding them, when it cannot tell who may stay", async () => {
    const database = seededDatabase();
    const reader = fakeSocket(PARTICIPANT);
    const room = roomFor(database, [reader]);
    database.exec("DROP TABLE workstream_participants");

    await publish(room, { type: "workstream_visibility_changed", visibility: "private" });

    // 1011, not the access-revoked code: a failed query is not evidence that
    // this reader lost access, and a reconnect is authorized against D1 again.
    // Closing them as "revoked" would strand a legitimate reader on an error
    // screen over one bad query.
    expect(reader.closes.map((close) => close.code)).toEqual([1011]);
  });
});
