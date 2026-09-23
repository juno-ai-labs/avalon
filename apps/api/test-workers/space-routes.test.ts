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
  evictDurableObject,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

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
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { deliverEffectsToWorkspaceInOrder } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

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
 * The Space's hidden main conversation, and the effects it has queued.
 *
 * Nothing about a Space is settled until they land. The reservation answers the
 * creator inside the request so the Space is in their sidebar immediately, and
 * the conversation's own `directory_common` effect supersedes that row a Queue
 * round trip later — which is the step a test that stops at the response never
 * takes, and the step both directions of the audience change are read through.
 */
function spaceConversation(spaceId: string) {
  return env.SUBSTREAM_AGENTS.getByName(
    conversationObjectName("global", WORKSPACE_ID, spaceId, asSubstreamId("0")),
  );
}

async function settleSpaceEffects(spaceId: string): Promise<void> {
  await deliverEffectsToWorkspaceInOrder(routeEnv(), spaceConversation(spaceId));
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
            FROM workspace_space_directory WHERE space_id = ?`,
    bindings: [spaceId],
  });
  return read.rows[0] as Record<string, unknown>;
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
// here and delivered by `settleSpaceEffects`, which is the real consumer.
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
    // Cold before its own projections are read, because that is the state a
    // Space spends its life in: nothing opens its conversation, so the object
    // is evicted between the request that made it and everything after.
    await evictDurableObject(spaceConversation(created.id));
    await settleSpaceEffects(created.id);

    // The row the Organization holds, at the version the Space's own object
    // wrote rather than the one its reservation did. `reserveSpace` writes
    // source version 0 and `reserveChild` delivers 1; anything above them is
    // the conversation's own aggregate, and a Space stuck below it is one the
    // Organization can never be told anything new about — not its scope, not
    // its name, not its appearance.
    const row = await spaceDirectoryRow(created.id);
    expect(row).toMatchObject({ scope: "workspace", title: "Company" });
    expect(Number(row.source_version)).toBeGreaterThan(1);

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

  it("keeps a personal Space personal, and out of a second member's sidebar", async () => {
    const created = await createSpace("personal");
    expect(created.scope).toBe("personal");
    await evictDurableObject(spaceConversation(created.id));
    await settleSpaceEffects(created.id);

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
    expect(await workspace().runInspectionSql({
      sql: `SELECT kind, state, source_space_id, space_id
              FROM space_intents WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1`,
      bindings: [workstreamId],
    })).toMatchObject({
      rows: [{
        kind: "move",
        state: "settled",
        source_space_id: source.id,
        space_id: target.id,
      }],
    });
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
    // The Space's conversation is cold by the time anybody edits the Space —
    // it has no socket, no feed and no reader — so this is the ordinary state
    // of the object every one of these operations addresses, not a corner.
    await evictDurableObject(spaceConversation(created.id));

    const widened = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER],
    }, "PATCH");
    expect(widened).toMatchObject({ status: 200, body: { scope: "workspace" } });

    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "workspace" });
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

  it("names the Space's own authority when its conversation cannot answer", async () => {
    const created = await createSpace("personal", "Hiring");
    // The way this breaks in production: the Space's own authority cannot
    // write, so it answers with the 500 it gives when it cannot say what went
    // wrong. A trigger is how a refusal is made to happen at exactly that
    // statement rather than by stubbing the call that issues it.
    await runInDurableObject(spaceConversation(created.id), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_space_conversation_scope
           BEFORE UPDATE ON workstream
           BEGIN SELECT RAISE(ABORT, 'space conversation storage unavailable'); END`,
      );
    });

    const refused = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER],
    }, "PATCH");
    // Named, because the code was in hand. `internal_error` is what this
    // answered before, and it is indistinguishable in a log from every other
    // unhandled failure the Worker has.
    expect(refused.body).toMatchObject({
      error: { code: "space_authority_unreachable" },
    });
  });
});

describe("the other Space operations that reach the hidden conversation", () => {
  it("renames and re-dresses a Space whose conversation is cold", async () => {
    const created = await createSpace("workspace", "Hiring");
    await evictDurableObject(spaceConversation(created.id));

    const renamed = await request(`/spaces/${created.id}`, OWNER_AUTH, {
      name: "Recruiting", iconKey: "target", colorKey: "violet",
    }, "PATCH");
    expect(renamed).toMatchObject({
      status: 200,
      body: { name: "Recruiting", iconKey: "target", colorKey: "violet" },
    });
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ title: "Recruiting" });
  });

  it("archives and restores a Space whose conversation is cold", async () => {
    const general = await createSpace("workspace", "Everything");
    const created = await createSpace("personal", "Hiring");
    // Two Spaces, so the archive is not refused `space_membership_final`: the
    // Channel keeps a home when this one closes.
    const workstreamId = await createChannel("two-homes", [
      asSpaceId(general.id), asSpaceId(created.id),
    ]);
    await evictDurableObject(spaceConversation(created.id));

    const archived = await request(`/spaces/${created.id}/archive`, OWNER_AUTH, {}, "POST");
    expect(archived).toMatchObject({ status: 200, body: { status: "archived" } });
    expect(await channelSpaceSources(workstreamId))
      .toEqual([expect.objectContaining({ spaceId: general.id })]);

    const restored = await request(`/spaces/${created.id}/restore`, OWNER_AUTH, {}, "POST");
    expect(restored).toMatchObject({ status: 200, body: { status: "active" } });
    expect((await channelSpaceSources(workstreamId)).map((source) => source.spaceId).sort())
      .toEqual([general.id, created.id].sort());
  });
});
