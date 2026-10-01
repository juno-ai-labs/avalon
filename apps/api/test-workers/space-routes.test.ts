/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The `/spaces` routes, driven as a signed-in member drives them.
 *
 * Every other Space suite enters below this line — at a WorkspaceDO RPC, or at
 * `SpaceService` with the objects around it doubled — and both defects this
 * file was written for live in the part that is skipped: the request schema the
 * route parses a body with, and the Space's own hidden conversation, which a
 * double never refuses the way the real object does. So the subject here is the
 * whole hop: a real session, the real Hono app, the real Durable Objects, and
 * the two reads a client actually has — the workspace socket's connect payload
 * and `GET /workstreams/:id/access`.
 */
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  WorkspaceSocketSyncEventSchema,
  type SpaceId,
  type SpaceSummary,
  type WorkspaceSidebar,
  type WorkstreamId,
} from "@rally/contracts";

import { createApp } from "../src/app";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { SpaceService } from "../src/services/space-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { changeRelationships } from "./helpers/workspace-relationship-events";

/** Its own workspace id: object storage is reset per case, object names are not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000d200");
const OWNER = asUserId("00000000-0000-7000-8000-00000000d201");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000d202");
const OWNER_SESSION = "00000000-0000-7000-8000-00000000d203";
const MEMBER_SESSION = "00000000-0000-7000-8000-00000000d204";
const SESSION_KEY = "space-routes-fixture-session-key";

const OWNER_AUTH: AuthContext = {
  sessionId: OWNER_SESSION,
  userId: OWNER,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "owner",
};

/** The second member, for the reads and the refusals that are about somebody else. */
const MEMBER_AUTH: AuthContext = {
  sessionId: MEMBER_SESSION,
  userId: MEMBER,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
}

/**
 * The environment the routes run against.
 *
 * Two keys the shared test binding has no reason to carry: the session signing
 * key the fixture mints tokens with, and the address allocator's key, which is
 * configuration rather than behaviour.
 */
function routeEnv(): Env {
  return {
    ...env,
    SESSION_SIGNING_KEY: SESSION_KEY,
    WORKSTREAM_EMAIL_ADDRESS_KEY: "workerd-test-email-address-key-0123456789",
  } satisfies Env;
}

const app = createApp();

async function request(
  path: string,
  auth: AuthContext,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<{ status: number; body: unknown }> {
  const token = await new SignJWT({ sid: auth.sessionId, wid: auth.workspaceId, region: auth.region })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setIssuer("avalon-api")
    .setAudience("avalon-desktop")
    .setExpirationTime(new Date("2099-01-01T00:00:00Z"))
    .sign(new TextEncoder().encode(SESSION_KEY));
  const context = createExecutionContext();
  const response = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, routeEnv(), context);
  const value: unknown = await response.json();
  await waitOnExecutionContext(context);
  return { status: response.status, body: value };
}

/**
 * The conversation object a Space id names. Nothing opens it any more; the
 * tests read it only to show that stays true, and a Channel's own
 * conversation is addressed the same way.
 */
function spaceConversation(spaceId: string) {
  return env.SUBSTREAM_AGENTS.getByName(
    conversationObjectName("global", WORKSPACE_ID, spaceId, asSubstreamId("0")),
  );
}

/** `POST /spaces`, answered with the summary the route renders. */
async function createSpace(
  scope: "personal" | "workspace",
  name = scope === "workspace" ? "Company" : "Mine",
): Promise<SpaceSummary> {
  const created = await request("/spaces", OWNER_AUTH, {
    name, iconKey: "briefcase", colorKey: "blue", scope,
  });
  if (created.status !== 201) {
    throw new Error(`POST /spaces answered ${created.status}: ${JSON.stringify(created.body)}`);
  }
  return created.body as SpaceSummary;
}

let ticketSequence = 0;

/**
 * The Space directories as a client actually reads them.
 *
 * There is deliberately no `GET /spaces` — Space state rides the workspace
 * socket's connect payload and nowhere else — so this is the production read
 * path, and asserting through it is asserting on what a person is shown.
 */
async function spaceDirectories(userId: string): Promise<NonNullable<WorkspaceSidebar["spaces"]>> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": userId === OWNER ? OWNER_SESSION : MEMBER_SESSION,
      "x-rally-socket-ticket-id":
        `00000000-0000-7000-8000-${ticketSequence.toString(16).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const first = new Promise<MessageEvent>((resolve) =>
    socket.addEventListener("message", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  const answer = WorkspaceSocketSyncEventSchema.parse(JSON.parse(String((await first).data)));
  socket.close();
  if (!answer.sidebar?.spaces) throw new Error("workspace sidebar answered without Space directories");
  return answer.sidebar.spaces;
}

/** One real Channel, born through the creation coordinator the product uses. */
async function createChannel(clientMessageId: string, spaceIds: SpaceId[] = []): Promise<WorkstreamId> {
  const created = await new WorkstreamObjectCreationService(routeEnv(), OWNER_AUTH).createPrepared({
    title: "Hiring plan",
    clientMessageId,
    participantUserIds: [],
    spaceIds,
  }, { messages: [{ role: "user", text: "A prepared start" }] });
  return asWorkstreamId(created.workstream.id);
}

/** The Organization's own row for one Space, as the directory holds it. */
async function spaceDirectoryRow(spaceId: string): Promise<Record<string, unknown>> {
  const read = await workspace().runInspectionSql({
    sql: `SELECT title, scope, source_version, archived_at
            FROM spaces WHERE space_id = ?`,
    bindings: [spaceId],
  });
  return read.rows[0] as Record<string, unknown>;
}

/** Whether anything ever opened the conversation named by this parent id. */
async function conversationInitialized(parentId: string): Promise<boolean> {
  return runInDurableObject(spaceConversation(parentId), (_instance, state) => {
    const table = state.storage.sql.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workstream'",
    ).toArray().length === 1;
    return table && state.storage.sql.exec("SELECT 1 FROM workstream LIMIT 1").toArray().length === 1;
  });
}

/** The Space sources `GET /workstreams/:id/access` reports for one Channel. */
async function channelSpaceSources(workstreamId: WorkstreamId) {
  const access = await request(`/workstreams/${workstreamId}/access`, OWNER_AUTH);
  if (access.status !== 200) {
    throw new Error(`GET access answered ${access.status}: ${JSON.stringify(access.body)}`);
  }
  return (access.body as { spaces: { spaceId: string; scope: string }[] }).spaces;
}

describe("GET /workstreams/:id/link-spaces", () => {
  it("lets a Channel reader obtain its visible Space coordinates", async () => {
    const space = await createSpace("workspace");
    const channel = await createChannel("copy-link-reader", [space.id]);
    const result = await request(`/workstreams/${channel}/link-spaces`, OWNER_AUTH);
    expect(result).toEqual({ status: 200, body: { spaceIds: [space.id] } });
    const otherMember = await request(`/workstreams/${channel}/link-spaces`, MEMBER_AUTH);
    expect(otherMember.status).toBe(200);
  });
  it("refuses link coordinates for a Channel the caller cannot open", async () => {
    const missingChannel = asWorkstreamId("00000000-0000-7000-8000-00000000d2ff");
    const result = await request(`/workstreams/${missingChannel}/link-spaces`, MEMBER_AUTH);
    expect(result.status).toBe(404);
  });
});

// The test Worker binds `ACTIVITY_QUEUE` with no consumer, so an object's own
// drain would send every effect into nothing before a case could read it. Held
// here, so a Channel's effects wait for the case that delivers them.
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  ticketSequence = 0;
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    sessionId: OWNER_SESSION,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, OWNER),
    // The session read joins it, so a `users` table without it fails every
    // authenticated request with a D1 error rather than with anything about
    // Spaces.
    env.DB.prepare("ALTER TABLE users ADD COLUMN analytics_person_id TEXT"),
    // The second member is the whole point of an Organization-wide audience:
    // every assertion below about who can see a Space is read as this person.
    env.DB.prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare("INSERT INTO users(id, email, name, timezone, created_at) VALUES (?, ?, 'Second member', 'UTC', '2026-01-01T00:00:00.000Z')")
      .bind(MEMBER, "second@example.com"),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(MEMBER_SESSION, MEMBER, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // Close the cutover, the way the path that opens a new Organization does: a
  // `pending` row is a derived alarm candidate due at the epoch, so without
  // this every case would be measuring the fleet migration.
  await workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });
}, 30_000);


describe("POST /spaces", () => {
  it("makes an Organization-wide Space every member can see", async () => {
    const created = await createSpace("workspace");
    expect(created.scope).toBe("workspace");

    // The Organization's row is the whole Space. Nothing else is written for
    // it: no hidden conversation is opened, so there is no second copy of its
    // name, scope or roster to fall out of step with this one.
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "workspace", title: "Company" });
    expect(await conversationInitialized(created.id)).toBe(false);

    // And the read a second member actually has. A Space nobody but its
    // creator is sent is an Organization-wide Space in name only.
    expect((await spaceDirectories(MEMBER)).active.items)
      .toContainEqual(expect.objectContaining({ id: created.id, scope: "workspace" }));

    // The audience it hands a member Channel, read through the one route that
    // answers it: `spaces` is the Channel's own record of what reaches it, and
    // the scope on that record is what the placement granted.
    const workstreamId = await createChannel("in-company", [asSpaceId(created.id)]);
    expect(await channelSpaceSources(workstreamId))
      .toEqual([expect.objectContaining({ spaceId: created.id, scope: "workspace" })]);
  });

  it("given a caller WorkspaceDO refuses, when they create a Space, then no anchor is written for it", async () => {
    // A guest: an active Organization relationship, and no Space writes.
    await changeRelationships(routeEnv(), WORKSPACE_ID, [MEMBER],
      env.DB.prepare("UPDATE workspace_members SET access_class = 'guest', role = NULL WHERE workspace_id = ? AND user_id = ?")
        .bind(WORKSPACE_ID, MEMBER));
    const anchors = async () => (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workstream_authority_routes WHERE workspace_id = ?",
    ).bind(WORKSPACE_ID).first<{ count: number }>())?.count;
    const before = await anchors();

    // Past the route's own session check, which answers a guest before any
    // Space code runs: this is about the order inside the service.
    const refused = await new SpaceService(routeEnv(), MEMBER_AUTH).create({
      name: "Theirs", iconKey: "briefcase", colorKey: "blue", scope: "workspace",
    }).then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject({ status: 403, code: "space_access_denied" });
    expect(await anchors()).toBe(before);
  });

  it("keeps a personal Space personal, and out of a second member's sidebar", async () => {
    const created = await createSpace("personal");
    expect(created.scope).toBe("personal");

    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "personal" });
    expect((await spaceDirectories(OWNER)).active.items)
      .toContainEqual(expect.objectContaining({ id: created.id }));
    expect((await spaceDirectories(MEMBER)).active.items.map((item) => item.id))
      .not.toContain(created.id);
  });
});

describe("POST /workstreams/import", () => {
  it("rejects an imported title outside the Channel creation contract", async () => {
    const imported = await request("/workstreams/import", OWNER_AUTH, {
      title: "x".repeat(181),
      source: { provider: "claude", url: null },
      content: { messages: [{ role: "user", text: "What did we learn?" }] },
      clientMessageId: "00000000-0000-7000-8000-00000000d204",
      spaceIds: [],
    });

    expect(imported.status).toBe(400);
  });

  it("settles the chosen title and places imported history in the selected Space", async () => {
    const destination = await createSpace("personal", "Research");
    const imported = await request("/workstreams/import", OWNER_AUTH, {
      title: "Imported research",
      source: { provider: "claude", url: null, sessionId: "research-session" },
      content: { messages: [
        { role: "user", text: "What did we learn?", sourceMessageId: "u1" },
        { role: "assistant", text: "The selected result.", sourceMessageId: "a1" },
      ] },
      clientMessageId: "00000000-0000-7000-8000-00000000d205",
      spaceIds: [destination.id],
    });
    expect(imported.status).toBe(201);
    const workstream = (imported.body as {
      workstream: { id: WorkstreamId; title: string; titleStatus: string };
    }).workstream;
    expect(workstream).toMatchObject({ title: "Imported research", titleStatus: "settled" });
    expect(await channelSpaceSources(asWorkstreamId(workstream.id)))
      .toEqual([expect.objectContaining({ spaceId: destination.id, scope: "personal" })]);
  });

  // The import window lists the Channel in the main window under this id
  // before the create returns, so the Channel has to be created under it.
  it("creates the Channel under the id the caller listed it under", async () => {
    const listedId = "019a0000-0000-7000-8000-00000000d2a1";
    const imported = await request("/workstreams/import", OWNER_AUTH, {
      title: "Listed import",
      source: { provider: "claude", url: null, sessionId: "listed-session" },
      content: { messages: [{ role: "user", text: "Listed first", sourceMessageId: "u1" }] },
      clientMessageId: "00000000-0000-7000-8000-00000000d2a2",
      workstreamId: listedId,
      spaceIds: [],
    });

    expect(imported.status).toBe(201);
    expect((imported.body as { workstream: { id: string } }).workstream.id).toBe(listedId);
  });

  it('rejects a different source before uploading its files', async () => {
    const imported = await request('/workstreams/import', OWNER_AUTH, {
      title: 'Source validation', source: { provider: 'claude', url: null, sessionId: 'original' },
      content: { messages: [{ role: 'user', text: 'Original', sourceMessageId: 'u1' }] },
      clientMessageId: '00000000-0000-7000-8000-00000000d206', spaceIds: [],
    });
    expect(imported.status).toBe(201);
    const workstreamId = (imported.body as { workstream: { id: string } }).workstream.id;
    const update = await request(`/workstreams/${workstreamId}/import/update`, OWNER_AUTH, {
      title: 'Different source',
      source: { provider: 'claude', url: null, sessionId: 'another' },
      content: { messages: [{ role: 'user', text: 'Changed', sourceMessageId: 'u1', files: [
        { name: 'report.txt', mimeType: 'text/plain', kind: 'attachment',
          source: { kind: 'inline', encoding: 'utf8', data: 'Should not upload' } },
      ] }] },
      clientMessageId: '00000000-0000-7000-8000-00000000d207',
    });
    expect(update.status).toBe(409);
    expect(update.body).toMatchObject({ error: { code: 'session_import_source_mismatch' } });
    expect(await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM resources').one().count)).toBe(0);
  });
});

describe("POST /spaces/:id/channels/:workstreamId/move", () => {
  it("leaves the destination untouched when the source placement is invalid", async () => {
    const source = await createSpace("personal", "Wrong source");
    const target = await createSpace("personal", "Untouched target");
    const workstreamId = await createChannel("invalid-source-move");

    const moved = await request(
      `/spaces/${target.id}/channels/${workstreamId}/move`,
      OWNER_AUTH,
      { sourceSpaceId: source.id },
    );

    expect(moved).toMatchObject({ status: 404, body: { error: { code: "space_not_found" } } });
    expect((await spaceDirectories(OWNER)).active.items.find((item) => item.id === target.id))
      .toMatchObject({ channelCount: 0 });
    expect((await channelSpaceSources(workstreamId)).map((item) => item.spaceId)).not.toContain(target.id);
  });

  it("moves a Channel behind one HTTP boundary and returns both changed Spaces", async () => {
    const source = await createSpace("personal", "Source");
    const target = await createSpace("personal", "Target");
    const workstreamId = await createChannel("move-channel");
    expect((await request(`/spaces/${source.id}/channels`, OWNER_AUTH, { workstreamId })).status).toBe(200);

    const moved = await request(
      `/spaces/${target.id}/channels/${workstreamId}/move`,
      OWNER_AUTH,
      { sourceSpaceId: source.id },
    );

    expect(moved).toMatchObject({
      status: 200,
      body: {
        source: { id: source.id, channelCount: 0 },
        target: { id: target.id, channelCount: 1 },
      },
    });
    expect(await channelSpaceSources(workstreamId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ spaceId: target.id }),
    ]));
    expect((await channelSpaceSources(workstreamId)).map((item) => item.spaceId)).not.toContain(source.id);
    // One WorkspaceDO transaction: no `move` intent was staged for a resume,
    // and the add-then-remove path (which stages an `add` into the target and a
    // `remove` out of the source) was not taken.
    expect(await workspace().runInspectionSql({
      sql: `SELECT kind, space_id FROM space_intents
             WHERE workstream_id = ? AND (kind IN ('move', 'remove') OR space_id = ?)`,
      bindings: [workstreamId, target.id],
    })).toMatchObject({ rows: [] });
  });

  it("given a Channel whose provenance is behind the source Space, when the one-transaction move is asked, then it writes nothing", async () => {
    const source = await createSpace("personal", "Source");
    const target = await createSpace("personal", "Target");
    const workstreamId = await createChannel("stale-provenance-move");
    expect((await request(`/spaces/${source.id}/channels`, OWNER_AUTH, { workstreamId })).status).toBe(200);
    // The source Space moves past the revision the Channel recorded for it,
    // which is what an audience change still walking its Channels looks like.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE spaces SET revision = revision + 1 WHERE space_id = ?", source.id);
    });
    const snapshot = async () => ({
      memberships: (await workspace().runInspectionSql({
        sql: `SELECT space_id, state, generation FROM space_channel_memberships
               WHERE workstream_id = ? ORDER BY space_id`,
        bindings: [workstreamId],
      })).rows,
      sources: (await workspace().runInspectionSql({
        sql: `SELECT space_id, space_revision, membership_generation FROM parent_space_sources
               WHERE parent_id = ? ORDER BY space_id`,
        bindings: [workstreamId],
      })).rows,
      operations: (await workspace().runInspectionSql({
        sql: "SELECT COUNT(*) AS count FROM parent_access_operations WHERE parent_id = ?",
        bindings: [workstreamId],
      })).rows,
    });
    const before = await snapshot();

    const declined = await workspace().moveSpaceMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      sourceSpaceId: source.id,
      targetSpaceId: target.id,
      workstreamId,
    });

    expect(declined).toEqual({ ok: true, moved: false });
    expect(await snapshot()).toEqual(before);

    // The route takes the add-then-remove path instead, and still moves it.
    const moved = await request(
      `/spaces/${target.id}/channels/${workstreamId}/move`,
      OWNER_AUTH,
      { sourceSpaceId: source.id },
    );
    expect(moved).toMatchObject({
      status: 200,
      body: { source: { id: source.id, channelCount: 0 }, target: { id: target.id, channelCount: 1 } },
    });
    expect((await channelSpaceSources(workstreamId)).map((item) => item.spaceId))
      .toEqual(expect.arrayContaining([target.id]));
  });
});

describe("a Space and its hosted parent", () => {
  it("given a parent reservation that fails, when a Space is reserved, then no Space row commits", async () => {
    const spaceId = asSpaceId("00000000-0000-7000-8000-00000000d2a1");
    // A parent row for this id under another Organization: `reserveChild`
    // finds it and refuses the identity, inside the reservation's transaction.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO parent_metadata
           (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
         VALUES (?, 'space', '00000000-0000-7000-8000-00000000d2ff', 'global', 1, 0, 0)`,
        spaceId,
      );
    });

    const failure = await workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      space: { name: "Company", iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
      spaceId,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await workspace().runInspectionSql({
      sql: "SELECT COUNT(*) AS count FROM spaces WHERE space_id = ?",
      bindings: [spaceId],
    })).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("given no General, when it is opened, then it is written with its parent and later callers reuse it", async () => {
    const actor = { workspaceId: WORKSPACE_ID, userId: OWNER };
    expect(await workspace().openGeneralSpace(actor)).toEqual({ ok: true, absent: true });
    const spaceId = asSpaceId("00000000-0000-7000-8000-00000000d2a2");

    const opened = await workspace().openGeneralSpace({ ...actor, spaceId });

    expect(opened).toMatchObject({ ok: true, created: true, space: { id: spaceId, systemRole: "general" } });
    // The parent's provisional projection superseded the reservation in the
    // same transaction, so the committed row is already at version one.
    expect(await workspace().runInspectionSql({
      sql: `SELECT directory.source_version, parent.parent_kind
              FROM spaces directory JOIN parent_metadata parent ON parent.parent_id = directory.space_id
             WHERE directory.space_id = ?`,
      bindings: [spaceId],
    })).toMatchObject({ rows: [{ source_version: 1, parent_kind: "space" }] });
    expect(await workspace().openGeneralSpace({
      ...actor, spaceId: asSpaceId("00000000-0000-7000-8000-00000000d2a3"),
    })).toMatchObject({ ok: true, created: false, space: { id: spaceId } });
    expect(await workspace().openGeneralSpace(actor)).toMatchObject({ ok: true, created: false, space: { id: spaceId } });
  });
});

describe("PATCH /spaces/:id/audience", () => {
  it("widens a Space and narrows it again, carrying each answer to its member Channel", async () => {
    const created = await createSpace("personal", "Hiring");
    // Born in General and then placed, which is the ordinary way a Channel
    // joins a Space and leaves it a home when this one's source is withdrawn:
    // a Channel whose only seat came from the Space under test is refused
    // `workstream_participant_required` by its own authority, which would be a
    // case about the last participant rather than about the audience.
    const workstreamId = await createChannel("member-channel");
    const placed = await request(`/spaces/${created.id}/channels`, OWNER_AUTH, { workstreamId });
    expect(placed.status).toBe(200);

    const widened = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER],
    }, "PATCH");
    expect(widened).toMatchObject({ status: 200, body: { scope: "workspace" } });

    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "workspace" });
    // WorkspaceDO holds the audience alone; no conversation carries a copy.
    expect(await conversationInitialized(created.id)).toBe(false);
    // The Channel's own record of what this Space supplies, which is the half
    // WorkspaceDO cannot answer and the half a person is shown.
    expect(await channelSpaceSources(workstreamId))
      .toContainEqual(expect.objectContaining({ spaceId: created.id, scope: "workspace" }));
    expect((await spaceDirectories(MEMBER)).active.items)
      .toContainEqual(expect.objectContaining({ id: created.id, scope: "workspace" }));

    // And back. Narrowing is the direction that cannot be expressed as a wider
    // application, so it is the one that has to be read from the Channel too.
    const narrowed = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "personal", participantUserIds: [OWNER],
    }, "PATCH");
    expect(narrowed).toMatchObject({ status: 200, body: { scope: "personal" } });
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "personal" });
    expect(await channelSpaceSources(workstreamId))
      .toContainEqual(expect.objectContaining({ spaceId: created.id, scope: "personal" }));
    // The member keeps the Space's mark and name, because they can still read
    // the Channel placed in it and that Channel has to be drawn somewhere. What
    // they lose is everything the narrowing was about: they are no longer one
    // of its participants, the roster is withheld, and every write on it is now
    // refused them.
    expect((await spaceDirectories(MEMBER)).active.items).toContainEqual(
      expect.objectContaining({
        id: created.id,
        scope: "personal",
        reach: "through_channel",
        participants: [],
      }),
    );
    expect(await request(
      `/spaces/${created.id}`,
      MEMBER_AUTH,
      { name: "Not yours", iconKey: "star", colorKey: "red" },
      "PATCH",
    )).toMatchObject({ status: 403, body: { error: { code: "space_access_denied" } } });
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ title: "Hiring" });
  });

  it("refuses a narrowing that leaves the person asking for it out of the Space", async () => {
    const created = await createSpace("personal", "Hiring");
    const widened = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER],
    }, "PATCH");
    expect(widened.status).toBe(200);

    // A person cannot narrow themselves out of a Space. `personal` admits its
    // participants and nobody else, so this would leave its own caller holding
    // a Space they can no longer change and — with no Channel in it they can
    // read — no longer see, with nothing left to ask for it back with. Refused
    // before the containment preflight walks a single member Channel.
    expect(await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "personal", participantUserIds: [MEMBER],
    }, "PATCH")).toMatchObject({
      status: 409,
      body: { error: { code: "space_audience_self_excluded" } },
    });
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "workspace" });
    expect((await spaceDirectories(OWNER)).active.items).toContainEqual(
      expect.objectContaining({ id: created.id, scope: "workspace", reach: "participant" }),
    );
  });

});

describe("the other Space operations", () => {
  it("renames and re-dresses a Space without addressing any conversation", async () => {
    const created = await createSpace("workspace", "Hiring");

    const renamed = await request(`/spaces/${created.id}`, OWNER_AUTH, {
      name: "Recruiting", iconKey: "target", colorKey: "violet",
    }, "PATCH");
    expect(renamed).toMatchObject({
      status: 200,
      body: { name: "Recruiting", iconKey: "target", colorKey: "violet" },
    });
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ title: "Recruiting" });
    expect(await conversationInitialized(created.id)).toBe(false);
  });

  it("archives and restores a Space", async () => {
    const general = await createSpace("workspace", "Everything");
    const created = await createSpace("personal", "Hiring");
    // Two Spaces, so the archive is not refused `space_membership_final`: the
    // Channel keeps a home when this one closes.
    const workstreamId = await createChannel("two-homes", [
      asSpaceId(general.id), asSpaceId(created.id),
    ]);

    const archived = await request(`/spaces/${created.id}/archive`, OWNER_AUTH, {}, "POST");
    expect(archived).toMatchObject({ status: 200, body: { status: "archived" } });
    expect(await channelSpaceSources(workstreamId))
      .toEqual([expect.objectContaining({ spaceId: general.id })]);

    const restored = await request(`/spaces/${created.id}/restore`, OWNER_AUTH, {}, "POST");
    expect(restored).toMatchObject({ status: 200, body: { status: "active" } });
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId).sort())
      .toEqual([general.id, created.id].sort());
  });

  it("archives a Space whose only leftover Channel is already archived", async () => {
    const created = await createSpace("personal", "Hiring");
    const workstreamId = await createChannel("archived-only-home", [asSpaceId(created.id)]);
    await deliverEffectsToWorkspace(env, spaceConversation(workstreamId));

    const channelArchived = await request(
      `/workstreams/${workstreamId}`,
      OWNER_AUTH,
      { archived: true },
      "PATCH",
    );
    expect(channelArchived.status).toBe(200);
    await deliverEffectsToWorkspace(env, spaceConversation(workstreamId));

    const archived = await request(`/spaces/${created.id}/archive`, OWNER_AUTH, {}, "POST");
    expect(archived).toMatchObject({ status: 200, body: { status: "archived" } });
    expect(await membershipState(workstreamId, created.id)).toBe("removing");

    const restored = await request(`/spaces/${created.id}/restore`, OWNER_AUTH, {}, "POST");
    expect(restored).toMatchObject({ status: 200, body: { status: "active" } });
    expect(await membershipState(workstreamId, created.id)).toBe("active");
  });
});

describe("an archived Space", () => {
  it("given an archived Space, when it is renamed, then it stays archived and can be restored", async () => {
    const general = await createSpace("workspace", "Everything");
    const created = await createSpace("personal", "Hiring");
    await createChannel("two-homes-renamed", [asSpaceId(general.id), asSpaceId(created.id)]);
    const archived = await request(`/spaces/${created.id}/archive`, OWNER_AUTH, {}, "POST");
    expect(archived).toMatchObject({ status: 200, body: { status: "archived" } });

    const renamed = await request(`/spaces/${created.id}`, OWNER_AUTH, {
      name: "Recruiting", iconKey: "target", colorKey: "violet",
    }, "PATCH");
    expect(renamed.status).toBe(200);

    expect(await spaceDirectoryRow(created.id)).toMatchObject({
      title: "Recruiting", archived_at: expect.any(Number),
    });
    const restored = await request(`/spaces/${created.id}/restore`, OWNER_AUTH, {}, "POST");
    expect(restored).toMatchObject({ status: 200, body: { status: "active" } });
  });
});

/** A personal Space whose participants are exactly these people. */
async function personalSpace(name: string, participantUserIds: readonly string[]): Promise<SpaceSummary> {
  const created = await createSpace("personal", name);
  if (participantUserIds.length === 1 && participantUserIds[0] === OWNER) return created;
  const changed = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
    scope: "personal", participantUserIds,
  }, "PATCH");
  if (changed.status !== 200) {
    throw new Error(`PATCH audience answered ${changed.status}: ${JSON.stringify(changed.body)}`);
  }
  return changed.body as SpaceSummary;
}

async function membershipState(workstreamId: WorkstreamId, spaceId: string): Promise<unknown> {
  const read = await workspace().runInspectionSql({
    sql: "SELECT state FROM space_channel_memberships WHERE workstream_id = ? AND space_id = ?",
    bindings: [workstreamId, spaceId],
  });
  return (read.rows[0] as { state?: unknown } | undefined)?.state;
}

async function intentStates(workstreamId: WorkstreamId, kind: string): Promise<unknown[]> {
  const read = await workspace().runInspectionSql({
    sql: "SELECT state FROM space_intents WHERE workstream_id = ? AND kind = ? ORDER BY created_at",
    bindings: [workstreamId, kind],
  });
  return read.rows.map((row) => (row as { state: unknown }).state);
}

/** The readers the Channel's record says this Space supplied. */
async function spaceReaders(workstreamId: WorkstreamId, spaceId: string): Promise<unknown[]> {
  const read = await workspace().runInspectionSql({
    sql: "SELECT user_id FROM parent_space_readers WHERE parent_id = ? AND space_id = ? ORDER BY user_id",
    bindings: [workstreamId, spaceId],
  });
  return read.rows.map((row) => (row as { user_id: unknown }).user_id);
}

/** Whether the Channel's own conversation seats this person. */
async function seated(workstreamId: WorkstreamId, userId: string): Promise<boolean> {
  return runInDurableObject(spaceConversation(workstreamId), (_instance, state) => (
    state.storage.sql.exec<{ status: string }>(
      "SELECT status FROM participants WHERE user_id = ?", userId,
    ).toArray()[0]?.status === "active"
  ));
}

describe("a Channel's Space membership, driven from WorkspaceDO", () => {
  it("given an existing Channel, when it is added to a Space, then the Space's readers are seated and attributed and the membership settles", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("add-existing", [asSpaceId(mine.id)]);
    expect(await seated(workstreamId, MEMBER)).toBe(false);

    const added = await request(`/spaces/${hiring.id}/channels`, OWNER_AUTH, { workstreamId });

    expect(added).toMatchObject({ status: 200, body: { id: hiring.id, channelCount: 1 } });
    expect(await seated(workstreamId, MEMBER)).toBe(true);
    // Attributed to the Space that supplied them, in the transaction that
    // activated the membership, so that Space's departure takes them with it.
    expect(await spaceReaders(workstreamId, hiring.id)).toEqual([MEMBER]);
    expect(await membershipState(workstreamId, hiring.id)).toBe("active");
    expect(await intentStates(workstreamId, "add")).toEqual(["settled"]);
  });

  it("given a reader the Channel's conversation refuses, when the Channel is added, then its reason reaches the caller and nothing stays staged", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("add-refused", [asSpaceId(mine.id)]);
    // The member leaves between the Space naming them and the Channel seating
    // them. The conversation reads membership from D1 itself, which is what
    // refuses the seat.
    await env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, MEMBER).run();

    const refused = await request(`/spaces/${hiring.id}/channels`, OWNER_AUTH, { workstreamId });

    expect(refused).toMatchObject({ status: 422, body: { error: { code: "invalid_workspace_member" } } });
    expect(await membershipState(workstreamId, hiring.id)).toBe("removed");
    expect(await intentStates(workstreamId, "add")).toEqual(["cancelled"]);
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId)).toEqual([mine.id]);
  });

  it("given a Channel in two Spaces, when it leaves one, then the readers only that Space supplied are withdrawn and the removal settles", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("leave-one", [asSpaceId(mine.id), asSpaceId(hiring.id)]);
    expect(await seated(workstreamId, MEMBER)).toBe(true);

    const removed = await request(`/spaces/${hiring.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");

    expect(removed).toMatchObject({ status: 200, body: { id: hiring.id, channelCount: 0 } });
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect(await seated(workstreamId, OWNER)).toBe(true);
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId)).toEqual([mine.id]);
    expect(await membershipState(workstreamId, hiring.id)).toBe("removed");
    expect(await intentStates(workstreamId, "remove")).toEqual(["settled"]);
  });

  it("given a removal whose narrowing is not announced, when the alarm resumes it, then WorkspaceDO finishes it without the Queue", async () => {
    const company = await createSpace("workspace", "Company");
    const mine = await personalSpace("Mine", [OWNER]);
    const workstreamId = await createChannel("narrowed", [asSpaceId(company.id), asSpaceId(mine.id)]);
    // A revocation Queue outage, which nothing in this runtime can produce on
    // the real binding: every send through it is refused for this request.
    const revocations = Object.getPrototypeOf(env.ACCESS_REVOCATION_QUEUE) as { send: (body: unknown) => Promise<void> };
    const refuse = vi.spyOn(revocations, "send").mockImplementation(async () => {
      throw new Error("revocation_queue_unavailable");
    });

    const refused = await request(`/spaces/${company.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");

    // Not settled: every non-participant reader's socket is still open, so the
    // intent is left for the alarm rather than recorded as delivered.
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "channel_narrowing_publish_failed" } } });
    expect(await membershipState(workstreamId, company.id)).toBe("removing");
    expect(await intentStates(workstreamId, "remove")).toEqual(["pending"]);
    refuse.mockRestore();

    const activity = vi.mocked((Object.getPrototypeOf(env.ACTIVITY_QUEUE) as {
      sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => Promise<void>;
    }).sendBatch);
    activity.mockClear();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE space_intents SET not_before = 0 WHERE kind = 'remove'");
    });
    await runDurableObjectAlarm(workspace());

    expect(await membershipState(workstreamId, company.id)).toBe("removed");
    expect(await intentStates(workstreamId, "remove")).toEqual(["settled"]);
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId)).toEqual([mine.id]);
    // Finished in place: nothing was handed to a Worker to resume.
    const sent = activity.mock.calls.flatMap(([messages]) => [...messages])
      .map((message) => (message.body as { type?: unknown }).type);
    expect(sent).not.toContain("space_intent_resume");
  });

  it("given a removal that dies before the Channel is asked, when the alarm resumes it, then the readers only that Space supplied are withdrawn", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("remove-replayed", [asSpaceId(mine.id), asSpaceId(hiring.id)]);
    expect(await seated(workstreamId, MEMBER)).toBe(true);
    // The first canonical operation fails: the plan transaction has already
    // withdrawn the source from the Channel's record, and nobody was removed.
    const unreachable = vi.spyOn(WorkstreamObjectClient.prototype, "removeParticipant")
      .mockRejectedValueOnce(new Error("conversation_unreachable"));

    const failed = await request(`/spaces/${hiring.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");
    unreachable.mockRestore();

    expect(failed.status).toBe(503);
    expect(await seated(workstreamId, MEMBER)).toBe(true);
    expect(await intentStates(workstreamId, "remove")).toEqual(["pending"]);

    await resumeOnAlarm();

    // The resume replays the retraction the plan recorded, so the reader the
    // departing Space supplied is withdrawn, not left as a direct reader.
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect(await seated(workstreamId, OWNER)).toBe(true);
    expect(await membershipState(workstreamId, hiring.id)).toBe("removed");
    expect(await intentStates(workstreamId, "remove")).toEqual(["settled"]);
  });

  it("given an add that dies after seating a reader, when the alarm resumes it, then the membership settles with that reader attributed", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("add-replayed", [asSpaceId(mine.id)]);

    await addDyingAfterSeating(workstreamId, hiring.id);
    expect(await membershipState(workstreamId, hiring.id)).toBe("joining");

    await resumeOnAlarm();

    expect(await membershipState(workstreamId, hiring.id)).toBe("active");
    expect(await intentStates(workstreamId, "add")).toEqual(["settled"]);
    expect(await seated(workstreamId, MEMBER)).toBe(true);
    expect(await spaceReaders(workstreamId, hiring.id)).toEqual([MEMBER]);
  });

  it("given an add that dies after seating a reader, when the Space moves on before the resume, then that reader is withdrawn with the add", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("add-superseded", [asSpaceId(mine.id)]);

    await addDyingAfterSeating(workstreamId, hiring.id);
    // The Space's audience moves after the add was staged: applying the Space
    // as it is now would be an add nobody asked for.
    const moved = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId(hiring.id),
      operationId: crypto.randomUUID(),
      audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    });
    if (!moved.ok) throw new Error(moved.code);

    await resumeOnAlarm();

    expect(await intentStates(workstreamId, "add")).toEqual(["cancelled"]);
    expect(await membershipState(workstreamId, hiring.id)).toBe("removed");
    // The reader the dead attempt seated was recorded as this Space's when it
    // was planned, so abandoning the add takes them out again.
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId)).toEqual([mine.id]);
  });

  it("given a removal still in flight, when the alarm reaches its intent, then the alarm leaves it to the request", async () => {
    const mine = await personalSpace("Mine", [OWNER]);
    const hiring = await personalSpace("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("remove-in-flight", [asSpaceId(mine.id), asSpaceId(hiring.id)]);
    const original = WorkstreamObjectClient.prototype.removeParticipant;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let removals = 0;
    const slow = vi.spyOn(WorkstreamObjectClient.prototype, "removeParticipant")
      .mockImplementation(async function (this: WorkstreamObjectClient, ...args) {
        removals += 1;
        // Only the request's own call waits; a second run of the intent would not.
        if (removals === 1) await held;
        return original.apply(this, args);
      });

    const pending = request(`/spaces/${hiring.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");
    for (let attempt = 0; attempt < 200 && removals === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(removals).toBe(1);

    await resumeOnAlarm();
    // The alarm claimed the intent and left it: the request holding it is
    // the one finishing it.
    expect(removals).toBe(1);

    release();
    expect(await pending).toMatchObject({ status: 200 });
    slow.mockRestore();
    expect(removals).toBe(1);
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect(await intentStates(workstreamId, "remove")).toEqual(["settled"]);
  });
});

/**
 * An add whose Worker dies after the Channel seated the Space's reader: the
 * seat goes through and the request then never comes back, so the object is
 * evicted with the intent staged and the membership `joining`.
 */
async function addDyingAfterSeating(workstreamId: WorkstreamId, spaceId: string): Promise<void> {
  const original = WorkstreamObjectClient.prototype.addParticipant;
  const hang = vi.spyOn(WorkstreamObjectClient.prototype, "addParticipant")
    .mockImplementation(async function (this: WorkstreamObjectClient, ...args) {
      await original.apply(this, args);
      return new Promise(() => undefined);
    });
  const pending = request(`/spaces/${spaceId}/channels`, OWNER_AUTH, { workstreamId })
    .then(() => null, (error: unknown) => error);
  for (let attempt = 0; attempt < 400 && !await seated(workstreamId, MEMBER); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await seated(workstreamId, MEMBER)).toBe(true);
  await runInDurableObject(workspace(), (_instance, state) => state.abort("add_died_after_seating"))
    .then(() => null, (error: unknown) => error);
  await pending;
  hang.mockRestore();
}

/** One alarm with every unsettled intent due: the alarm resumes each in place. */
async function resumeOnAlarm(): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("UPDATE space_intents SET not_before = 0 WHERE state IN ('pending', 'applied')");
  });
  await runDurableObjectAlarm(workspace());
}
