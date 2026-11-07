import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentLoopDO, type SubstreamProductRequest } from "../src/durable-objects/agent-loop-do";
import { rpcResultBody } from "../src/durable-objects/rpc-result";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { createWorkspaceObjectTable } from "./helpers/workspace-object-tables";

const WORKSPACE = "00000000-0000-7000-8000-0000000000c0";
const PARTICIPANT = "00000000-0000-7000-8000-0000000000c1";
const MEMBER = "00000000-0000-7000-8000-0000000000c2";
const OUTSIDER = "00000000-0000-7000-8000-0000000000c3";
const WORKSTREAM = "00000000-0000-7000-8000-0000000000c4";
const SESSION = "00000000-0000-7000-8000-0000000000c5";
const MEMBER_SESSION = "00000000-0000-7000-8000-0000000000c6";
const at = "2026-08-11T09:00:00.000Z";

const databases: DatabaseSync[] = [];
const lifecycleWork: Promise<unknown>[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (let index = 0; index < lifecycleWork.length; index += 1) {
    try {
      await lifecycleWork[index];
    } catch (error) {
      failures.push(error);
    }
  }
  lifecycleWork.length = 0;
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (failures.length > 0) throw new AggregateError(failures, "room lifecycle work failed");
});
beforeEach(() => {
  // The constructor registers a hibernation-friendly ping/pong pair through two
  // Workers globals this Node suite does not have.
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(readonly request: string, readonly response: string) {}
  });
});

const productDatabases = new WeakMap<AgentLoopDO, DatabaseSync>();

function productDatabase(room: AgentLoopDO): DatabaseSync {
  const database = productDatabases.get(room);
  if (!database) throw new Error("room_product_database_missing");
  return database;
}

function seededDatabase(options: { openAuthority?: boolean } = {}): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // The legacy product fixture predates guest relationships. Admission reads
  // current membership shape, so apply its real migration before seeding.
  database.exec(readFileSync(new URL("../../../packages/db/migrations/0109_workspace_guest_relationships.sql", import.meta.url), "utf8"));
  database.exec(`
    ALTER TABLE workspaces ADD COLUMN abandoned_at TEXT;
    ALTER TABLE sessions ADD COLUMN workspace_incarnation TEXT DEFAULT 'existing-member';
    ALTER TABLE sessions ADD COLUMN impersonator_user_id TEXT;
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${PARTICIPANT}', 'g-1', 'one@example.com', 'One', '${at}', '${at}'),
           ('${MEMBER}', 'g-2', 'two@example.com', 'Two', '${at}', '${at}'),
           ('${OUTSIDER}', 'g-3', 'three@example.com', 'Three', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${PARTICIPANT}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, incarnation)
    VALUES ('${WORKSPACE}', '${PARTICIPANT}', 'owner', 'active', '${at}', 'existing-member'),
           ('${WORKSPACE}', '${MEMBER}', 'member', 'active', '${at}', 'existing-member');
    INSERT INTO sessions
      (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
    VALUES ('${SESSION}', '${PARTICIPANT}', '${WORKSPACE}', 'global',
            'substream-agent-session-hash', '2099-08-11T09:00:00.000Z', '${at}'),
           ('${MEMBER_SESSION}', '${MEMBER}', '${WORKSPACE}', 'global',
            'substream-agent-member-session-hash', '2099-08-11T09:00:00.000Z', '${at}');
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
  // Every test's database gets the WorkspaceDO tables traversed by the product
  // `get`: pin metadata is no wider than its active, readable Space placement.
  // The object ledger supplies their real shape. Harmless to the socket tests
  // — nothing asserts on their absence. The directory tables are created
  // under their ledger names and renamed the way WorkspaceDO migration 72
  // renames them, since the ledger has no `CREATE TABLE` under the new name.
  for (const table of [
    "workspace_space_directory",
    "workspace_space_viewers",
    "space_channel_memberships",
    "workspace_workstream_directory",
    "workspace_workstream_viewers",
    "workspace_workstream_pins",
  ]) createWorkspaceObjectTable(database, table);
  database.exec(`
    ALTER TABLE workspace_workstream_directory RENAME TO channels;
    ALTER TABLE workspace_workstream_viewers RENAME TO channel_viewers;
    ALTER TABLE workspace_space_directory RENAME TO spaces;
    ALTER TABLE workspace_space_viewers RENAME TO space_viewers;
  `);
  if (options.openAuthority !== false) openWorkstreamAuthorityForTest(database, at);
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
    substreamId: "0",
    userId,
    sessionId: SESSION,
    role: "owner",
    analyticsWorkspaceId: null,
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

function roomFor(
  database: DatabaseSync,
  sockets: FakeSocket[] = [],
  region: string = "global",
): AgentLoopDO {
  const storage = new Map<string, unknown>([
    ["roomIdentity", { workspaceId: WORKSPACE, workstreamId: WORKSTREAM }],
  ]);
  const objectDatabase = testWorkstreamObjectStore();
  databases.push(objectDatabase);
  seedWorkstreamObjectRoot(objectDatabase, { workspaceId: WORKSPACE, workstreamId: WORKSTREAM });
  // A conversation is a Canvas's or a Sidekick's; a stored Thread kind is refused on open.
  objectDatabase.prepare("UPDATE workstream SET parent_kind = 'canvas' WHERE id = 1").run();
  const source = database.prepare(
    "SELECT scope FROM workstreams WHERE id = ? AND workspace_id = ?",
  ).get(WORKSTREAM, WORKSPACE) as { scope: string };
  objectDatabase.prepare("UPDATE workstream SET scope = ? WHERE id = 1").run(source.scope);
  const participants = database.prepare(
    `SELECT user_id, participation_reason, added_by_user_id, joined_at
       FROM workstream_participants WHERE workstream_id = ? AND removed_at IS NULL`,
  ).all(WORKSTREAM) as Array<{
    user_id: string;
    participation_reason: string;
    added_by_user_id: string | null;
    joined_at: string;
  }>;
  for (const participant of participants) {
    objectDatabase.prepare(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status,
          participant_epoch, added_at, removed_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, NULL, ?)`,
    ).run(
      participant.user_id,
      participant.participation_reason,
      participant.added_by_user_id,
      Date.parse(participant.joined_at),
      Date.parse(participant.joined_at),
    );
  }
  const sql = createTestSqlStorage(objectDatabase);
  const state = createCloudflareTestBinding<DurableObjectState>({
    blockConcurrencyWhile: async (body: () => Promise<unknown>) => body(),
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    // Eager loop and projection drains are invocation-owned work. Retain them
    // exactly as workerd does so teardown cannot close their object database
    // while a drain is still settling.
    waitUntil: (promise: Promise<unknown>) => { lifecycleWork.push(promise); },
    storage: {
      get: async (key: string | string[]) => Array.isArray(key)
        ? new Map(key.flatMap((entry) => storage.has(entry) ? [[entry, storage.get(entry)]] : []))
        : storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string | string[]) => {
        if (Array.isArray(key)) {
          let deleted = 0;
          for (const entry of key) if (storage.delete(entry)) deleted += 1;
          return deleted;
        }
        return storage.delete(key);
      },
      list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map(
        [...storage].filter(([key]) => key.startsWith(prefix)),
      ),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql,
      transaction: async (body: (t: unknown) => Promise<unknown>) => body({
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
        delete: async (key: string) => storage.delete(key),
      }),
    },
  });
  const room = new AgentLoopDO(
    state,
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: region, APP_ENV: "test" }),
  );
  productDatabases.set(room, objectDatabase);
  return room;
}

function publish(room: AgentLoopDO, event: Record<string, unknown>): Promise<Response> {
  return room.fetch(new Request("https://room.internal/internal/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rally-workspace-id": WORKSPACE,
      "x-rally-workstream-id": WORKSTREAM,
      "x-rally-substream-id": "0",
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
function connectAs(room: AgentLoopDO, userId: string): Promise<Response> {
  const sessionId = userId === MEMBER ? MEMBER_SESSION : SESSION;
  return room.fetch(new Request("https://room.internal/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE,
      "x-rally-workstream-id": WORKSTREAM,
      "x-rally-substream-id": "0",
      "x-rally-user-id": userId,
      "x-rally-session-id": sessionId,
      "x-rally-socket-ticket-id": "3f1b0f4a-59cb-4f5f-8d1e-6d3e5a2a9c11",
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) - 1),
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

  it("refuses an internal event that cannot pin the room identity", async () => {
    const response = await roomFor(seededDatabase()).fetch(new Request(
      "https://room.internal/internal/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "harness_status_changed", status: "running" }),
      },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_room_identity" });
  });

  it("refuses late room events after the source snapshot is frozen", async () => {
    const database = seededDatabase({ openAuthority: false });
    database.exec(`
      UPDATE workstream_authority_control
         SET phase = 'maintenance_draining', generation = 1, updated_at = '2026-08-17T00:00:00.000Z'
       WHERE id = 1;
      UPDATE workstream_authority_control
         SET phase = 'maintenance_importing', updated_at = '2026-08-17T00:01:00.000Z'
       WHERE id = 1;
    `);
    const response = await roomFor(database).fetch(new Request(
      "https://room.internal/internal/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rally-workspace-id": WORKSPACE,
          "x-rally-workstream-id": WORKSTREAM,
        },
        body: JSON.stringify({ type: "harness_status_changed", status: "running" }),
      },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "workstream_maintenance",
      phase: "maintenance_importing",
      generation: 1,
    });
  });
});

describe("who the work-stream room disconnects", () => {
  // Connect-time authorization only covers the sockets opened after a change.
  // The ones already inside are closed by the access-revocation queue and by
  // nothing else: this room re-checks nothing on its own, on a timer or on a
  // retraction it happens to be publishing. See docs/access-revocation.md.
  it("closes the sockets of the person it is told lost access", async () => {
    const revoked = fakeSocket(PARTICIPANT);
    const kept = fakeSocket(MEMBER);
    const room = roomFor(seededDatabase(), [revoked, kept]);

    await room.revokeSocketAccess({
      reason: "workspace_membership_removed",
      workspaceId: asWorkspaceId(WORKSPACE),
      userId: PARTICIPANT,
      sessionId: null,
    });

    expect(revoked.closes).toEqual([
      { code: 1008, reason: "You can no longer read this work stream" },
    ]);
    expect(kept.closes).toEqual([]);
    // The people who stay must stop seeing the closed reader listed as
    // present: `webSocketClose` fires for a *client*-initiated close, so
    // closing one here invokes nothing.
    expect(kept.sent.map((payload) => (JSON.parse(payload) as { type: string }).type))
      .toEqual(["presence_changed"]);
  });

  it("closes only the windows that presented a revoked session", async () => {
    const revoked = fakeSocket(PARTICIPANT);
    const otherWindow = fakeSocket(PARTICIPANT);
    otherWindow.serializeAttachment({
      ...(otherWindow.deserializeAttachment() as Record<string, unknown>),
      sessionId: "00000000-0000-7000-8000-0000000000c9",
    });
    const room = roomFor(seededDatabase(), [revoked, otherWindow]);

    await room.revokeSocketAccess({
      reason: "session_revoked",
      workspaceId: asWorkspaceId(WORKSPACE),
      userId: PARTICIPANT,
      sessionId: SESSION,
    });

    expect(revoked.closes.map((close) => close.code)).toEqual([1008]);
    // One window signing out must not sign the person out of the others.
    expect(otherWindow.closes).toEqual([]);
  });

  it("closes a legacy socket that carries no session, rather than exempting it", async () => {
    const legacy = fakeSocket(PARTICIPANT);
    const attachment = legacy.deserializeAttachment() as Record<string, unknown>;
    delete attachment.sessionId;
    legacy.serializeAttachment(attachment);
    const room = roomFor(seededDatabase(), [legacy]);

    // This schema alone makes `sessionId` optional — a socket accepted before
    // the command gateway carries none — so `undefined !== "<id>"` would exempt
    // exactly the transcript feed from every logout and expiry. It cannot be
    // shown not to be the revoked session.
    await room.revokeSocketAccess({
      reason: "session_revoked",
      workspaceId: asWorkspaceId(WORKSPACE),
      userId: PARTICIPANT,
      sessionId: SESSION,
    });

    expect(legacy.closes.map((close) => close.code)).toEqual([1008]);
  });

  it("closes a reader the work stream itself just stopped admitting", async () => {
    const reader = fakeSocket(MEMBER);
    const kept = fakeSocket(PARTICIPANT);
    const room = roomFor(seededDatabase(), [reader, kept]);

    const response = await publish(room, { type: "workstream_scope_changed", scope: "personal" });

    expect(response.status).toBe(202);
    // Object-local, and a different question from the one the queue answers:
    // whether *this work stream* still admits this person is held in this
    // object's own SQL, and nothing else can answer it. Without this they keep
    // receiving the live transcript until the window closes.
    expect(reader.closes.map((close) => close.code)).toEqual([1008]);
    expect(kept.closes).toEqual([]);
    // Swept before the broadcast, so the event that excluded them is not the
    // last thing they are sent.
    expect(reader.sent).toEqual([]);
    // The scope change, then a refreshed roster: the people who stay must stop
    // seeing an evicted reader listed as present.
    expect(kept.sent.map((payload) => (JSON.parse(payload) as { type: string }).type))
      .toEqual(["workstream_scope_changed", "presence_changed"]);
  });

  it("closes a participant taken out of a work stream that is already private", async () => {
    const database = seededDatabase();
    const removed = fakeSocket(PARTICIPANT);
    const room = roomFor(database, [removed]);
    const sql = createTestSqlStorage(productDatabase(room));
    sql.exec("UPDATE participants SET status = 'removed', removed_at = ? WHERE user_id = ?", Date.now(), PARTICIPANT);

    const response = await publish(room, { type: "participant_removed", userId: PARTICIPANT });

    expect(response.status).toBe(202);
    expect(removed.closes.map((close) => close.code)).toEqual([1008]);
  });

  it("leaves everyone in place when the work stream is open to the workspace", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workstreams SET scope = 'workspace' WHERE id = '${WORKSTREAM}'`);
    const reader = fakeSocket(MEMBER);
    const room = roomFor(database, [reader]);

    await publish(room, { type: "participant_removed", userId: PARTICIPANT });

    expect(reader.closes).toEqual([]);
    expect(reader.sent).toHaveLength(1);
  });

  it("asks D1 nothing while publishing, however often it publishes", async () => {
    const database = seededDatabase();
    const reader = fakeSocket(MEMBER);
    const room = roomFor(database, [reader]);
    const asked: string[] = [];
    const original = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql: string) => {
      asked.push(sql);
      return original(sql);
    });

    await publish(room, { type: "harness_status_changed", status: "running" });
    await publish(room, { type: "harness_status_changed", status: "completed" });

    // An authorization query on this path is what the queue exists to remove:
    // the transcript feed is the highest-frequency socket in the product.
    expect(asked.filter((sql) => sql.includes("workspace_members"))).toEqual([]);
    expect(reader.closes).toEqual([]);
  });
});

describe("what authority the product API accepts", () => {
  // The incident these pin down (2026-08-22): connector ingress presented a
  // synthesized `slack:{team}:{user}` session id, the room looked it up in
  // `sessions` — where it never existed — and every linked member's Slack
  // message died as `session_revoked`. A connector principal now says what it
  // is, and the room verifies the D1 fact that is its to verify: current
  // active membership in this workspace and region. The link itself is the
  // Worker's per-message check, where the link rows live.
  //
  // These live in the Node suite deliberately: the auth decision reads
  // regional D1 and nothing else — no object storage, no alarm, no socket —
  // and this harness's database applies the checked-in migrations, so the
  // membership join is proved against the real schema. The workers suite's
  // D1 starts empty and would prove it against hand-written tables.
  function productAuth(
    overrides: Partial<SubstreamProductRequest["auth"]> = {},
  ): SubstreamProductRequest["auth"] {
    return {
      sessionId: "slack:T123:U456",
      userId: asUserId(PARTICIPANT),
      workspaceId: asWorkspaceId(WORKSPACE),
      region: "global",
      role: "owner",
      ...overrides,
    };
  }

  const sessionRefusal = { error: "session_revoked", message: "Sign in again to continue" };
  const connectorRefusal = {
    error: "connector_member_revoked",
    message: "You are no longer an active member of this workspace",
  };

  it.each([
    { operation: "search_turns" as const, turnIds: ["private-turn"] },
    { operation: "search_link" as const, turnId: "private-turn", linkId: "private-link" },
  ])("refuses revoked sessions for $operation", async (operation) => {
    const result = await roomFor(seededDatabase()).handleProductRequest({ ...operation, parentKind: "canvas" as const, auth: productAuth() });
    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(sessionRefusal);
  });

  it("still refuses a synthesized session id that claims no principal", async () => {
    const result = await roomFor(seededDatabase())
      .handleProductRequest({ operation: "get", parentKind: "canvas" as const, auth: productAuth() });

    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(sessionRefusal);
  });

  it("runs a connector-principal request as the member the ingress verified", async () => {
    const result = await roomFor(seededDatabase())
      .handleProductRequest({ operation: "get", parentKind: "canvas" as const, auth: productAuth({ principal: "connector" }) });

    expect(result.status).toBe(200);
    expect(rpcResultBody(result)).toMatchObject({ id: WORKSTREAM });
  });

  it("refuses a connector principal for somebody who is not an active member", async () => {
    const database = seededDatabase();
    database.exec(
      `UPDATE workspace_members SET status = 'suspended'
        WHERE workspace_id = '${WORKSPACE}' AND user_id = '${PARTICIPANT}'`,
    );

    const result = await roomFor(database)
      .handleProductRequest({ operation: "get", parentKind: "canvas" as const, auth: productAuth({ principal: "connector" }) });

    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(connectorRefusal);
  });

  it("refuses a connector principal whose asserted role has gone stale", async () => {
    const result = await roomFor(seededDatabase()).handleProductRequest({
      operation: "get",
      parentKind: "canvas" as const, auth: productAuth({ principal: "connector", role: "member" }),
    });

    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(connectorRefusal);
  });

  it("refuses a connector principal when the workspace is not this region's", async () => {
    // The room here is the enterprise deployment; the seeded workspace's row says
    // global. This isolates the `workspace.region` clause — the one that
    // stops a connector principal being honored by an object in the wrong
    // jurisdiction, and the one most tempting to "simplify away" because the
    // product layer re-checks membership without it. The asserted region
    // matches the room's on purpose: without the SQL clause, the membership
    // row alone would admit this request and the equality check would pass.
    const result = await roomFor(seededDatabase(), [], "enterprise").handleProductRequest({
      operation: "get",
      parentKind: "canvas" as const, auth: productAuth({ principal: "connector", region: "enterprise" }),
    });

    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(connectorRefusal);
  });

  it("refuses a connector principal that asserts another region", async () => {
    const result = await roomFor(seededDatabase()).handleProductRequest({
      operation: "get",
      parentKind: "canvas" as const, auth: productAuth({ principal: "connector", region: "enterprise" }),
    });

    expect(result.status).toBe(401);
    expect(rpcResultBody(result)).toEqual(connectorRefusal);
  });

  it("sends a session principal over the wire with no marker at all", async () => {
    // The dangerous regression is not the marker being dropped for connector
    // ingress — that fails loudly in the Slack suite — but the marker being
    // attached too broadly: a session-principal request that gained it would
    // be verified without the `sessions` join, so a revoked login would keep
    // working. `toEqual` is what makes the *absence* of the key meaningful.
    const captured: Array<{ auth: unknown }> = [];
    const stub = {
      handleProductRequest: vi.fn((request: { auth: unknown }) => {
        captured.push(request);
        return { status: 401, bodyJson: JSON.stringify(sessionRefusal) };
      }),
    };
    const binding: DurableObjectNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: vi.fn(() => createTestDurableObjectId("room-id")),
      get: vi.fn(() => stub),
      jurisdiction: vi.fn((): DurableObjectNamespace => binding),
    });
    const env = createTestEnv({
      DB: sqliteD1(seededDatabase()),
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: binding,
    });
    const client = new WorkstreamObjectClient(env, {
      sessionId: SESSION,
      userId: asUserId(PARTICIPANT),
      workspaceId: asWorkspaceId(WORKSPACE),
      region: "global",
      role: "owner",
    }, WORKSTREAM, "0", false, "canvas");

    await expect(client.get()).rejects.toMatchObject({ code: "session_revoked" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.auth).toEqual({
      sessionId: SESSION,
      userId: PARTICIPANT,
      workspaceId: WORKSPACE,
      region: "global",
      role: "owner",
    });
  });
});
