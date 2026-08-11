import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { WorkstreamRoom } from "../src/durable-objects/workstream-room";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

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
       created_at, updated_at, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Compensation review', '', 'x@automation.example',
            'active', 'ad_hoc', '${PARTICIPANT}', 'idle', 1, '${at}', '${at}', '${at}', 'personal');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${WORKSTREAM}', '${PARTICIPANT}', '${PARTICIPANT}', 'creator', '${at}');
  `);
  return database;
}

function roomFor(database: DatabaseSync): WorkstreamRoom {
  const state = {
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => [],
    storage: { get: async () => undefined, put: async () => undefined },
  } as unknown as DurableObjectState;
  return new WorkstreamRoom(
    state,
    { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env,
  );
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
  // that check used to be a copy of the read rule that had lost `scope` — so a
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
    database.exec(`UPDATE workstreams SET scope = 'workspace' WHERE id = '${WORKSTREAM}'`);

    const response = await connectAs(roomFor(database), MEMBER);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "socket_ticket_replayed" });
  });
});
