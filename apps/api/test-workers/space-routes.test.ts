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
  runInDurableObject,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSpaceSnapshotEventSchema,
  type SpaceId,
  type SpaceSummary,
  type WorkspaceSidebar,
  type WorkstreamId,
} from "@rally/contracts";
import { INDIVIDUAL_SPACE_CLIENT_CONTRACT } from "@rally/contracts/http-headers";

import { createApp } from "../src/app";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { personalSpaceIdFor } from "../src/durable-objects/workspace-space-protocol";
import { seatOrganizationMember, SpaceBootstrapService, spaceBootstrapDriver } from "../src/services/space-bootstrap-service";
import { SpaceService } from "../src/services/space-service";
import { seatSpaceInvitee } from "../src/services/workspace-realtime-service";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
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
    ...(namingModelReachable ? NAMING_MODEL : {}),
  } satisfies Env;
}

/**
 * The key and model the naming call needs, which the shared binding lacks.
 * Off by default, because only a suite with a provider double installed may
 * let a request reach the model.
 */
const NAMING_MODEL = {
  OPENROUTER_API_KEY: "workerd-test-openrouter-key",
  OPENROUTER_CLASSIFIER_MODEL: "double/naming",
} as const;
let namingModelReachable = false;

const app = createApp();

let importModelHeld = false;
const importContexts: ReturnType<typeof createExecutionContext>[] = [];

async function request(
  path: string,
  auth: AuthContext,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  clientContract: string | null = "3",
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
      ...(clientContract === null ? {} : { "x-rally-client-contract": clientContract }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, routeEnv(), context);
  const value: unknown = response.status === 204 ? null : await response.json();
  // Import admission returns while its deliberately held model is still running.
  if (importModelHeld) importContexts.push(context);
  else await waitOnExecutionContext(context);
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
async function createSpace(name = "Company"): Promise<SpaceSummary> {
  const created = await request("/spaces", OWNER_AUTH, {
    name, iconKey: "briefcase", colorKey: "blue", scope: "workspace",
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
  const { socket, spaces } = await subscribedSocket(userId);
  socket.close();
  return spaces;
}

/** A subscribed workspace socket, left open, with the Space directories its connect payload carried. */
async function subscribedSocket(userId: string): Promise<{
  socket: WebSocket;
  spaces: NonNullable<WorkspaceSidebar["spaces"]>;
}> {
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
  if (!answer.sidebar?.spaces) throw new Error("workspace sidebar answered without Space directories");
  return { socket, spaces: answer.sidebar.spaces };
}

/** The next Space snapshot pushed to an open socket. */
function nextSpaceSnapshot(socket: WebSocket) {
  return new Promise<ReturnType<typeof WorkspaceSpaceSnapshotEventSchema.parse>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const message: unknown = JSON.parse(String(event.data));
      const parsed = WorkspaceSpaceSnapshotEventSchema.safeParse(message);
      if (!parsed.success) return;
      socket.removeEventListener("message", listener);
      resolve(parsed.data);
    };
    socket.addEventListener("message", listener);
  });
}

/** One real Channel, born through the creation coordinator the product uses. */
async function createChannel(
  clientMessageId: string,
  spaceIds: SpaceId[] = [],
  audience: { scope?: "personal" | "workspace"; participantUserIds?: string[] } = {},
): Promise<WorkstreamId> {
  const created = await new WorkstreamObjectCreationService(routeEnv(), OWNER_AUTH).createPrepared({
    title: "Hiring plan",
    clientMessageId,
    participantUserIds: audience.participantUserIds ?? [],
    scope: audience.scope ?? "personal",
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

/** The Spaces a Channel is placed in, as WorkspaceDO answers a reader, sorted. */
async function channelSpaceIds(workstreamId: WorkstreamId): Promise<string[]> {
  const placed = await workspace().channelSpaces({ workspaceId: WORKSPACE_ID, userId: OWNER, workstreamId });
  return [...placed.spaceIds].sort();
}

/** Deliver the durable archive commands independently of the HTTP request. */
async function resumeChannelArchives(workstreamId: WorkstreamId): Promise<string> {
  const read = await workspace().runInspectionSql({
    sql: "SELECT operation_id FROM space_intents WHERE kind = 'archive' AND workstream_id = ? ORDER BY created_at DESC",
    bindings: [workstreamId],
  });
  const operationId = String(read.rows[0]?.operation_id);
  expect(read.rows.length).toBeGreaterThan(0);
  await workspace().resumeSpaceIntent({ auth: OWNER_AUTH, operationId });
  return operationId;
}

/** Drive the existing repair phases, whose Queue is deliberately held in this suite. */
async function finishHomeRepair(): Promise<void> {
  const driver = await spaceBootstrapDriver(routeEnv(), WORKSPACE_ID, "global");
  if (!driver) throw new Error("home repair has no active member");
  const service = new SpaceBootstrapService(routeEnv(), driver);
  for (;;) {
    const read = await workspace().runInspectionSql({
      sql: "SELECT phase, cursor, blocked_json FROM space_bootstrap WHERE id = 1", bindings: [],
    });
    const row = read.rows[0];
    if (!row) throw new Error("home repair state missing");
    expect(JSON.parse(String(row.blocked_json))).toEqual([]);
    if (row.phase === "complete") return;
    const cursor = row.cursor === null ? null : asWorkstreamId(String(row.cursor));
    if (row.phase === "general" || row.phase === "pending") await service.runGeneral();
    else if (row.phase === "preflight") await service.runPreflight(cursor);
    else if (row.phase === "memberships") await service.runMemberships(cursor);
    else if (row.phase === "finalize") await service.runFinalize();
    else throw new Error(`unexpected home repair phase ${String(row.phase)}`);
  }
}

/** The audience `GET /workstreams/:id/access` reports as the Channel's own. */
async function channelAudience(workstreamId: WorkstreamId): Promise<{ scope: string; participantUserIds: string[] }> {
  const access = await request(`/workstreams/${workstreamId}/access`, OWNER_AUTH);
  if (access.status !== 200) {
    throw new Error(`GET access answered ${access.status}: ${JSON.stringify(access.body)}`);
  }
  const { direct } = access.body as { direct: { scope: string; participantUserIds: string[] } };
  return { scope: direct.scope, participantUserIds: [...direct.participantUserIds].sort() };
}

describe("GET /workstreams/:id/link-spaces", () => {
  it("lets a Channel reader obtain its visible Space coordinates", async () => {
    const space = await createSpace();
    const channel = await createChannel("copy-link-reader", [space.id], { scope: "workspace" });
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
    const created = await createSpace();
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

    // And none to a member Channel: one placed in it keeps the private
    // audience it was born with.
    const workstreamId = await createChannel("in-company", [asSpaceId(created.id)]);
    expect(await channelSpaceIds(workstreamId)).toEqual([created.id]);
    expect(await channelAudience(workstreamId)).toEqual({ scope: "personal", participantUserIds: [OWNER] });
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

  // A desktop released before every Space was Organization-wide still asks
  // for `personal`; it gets the only scope there is rather than a refusal.
  it("creates an Organization-wide Space when a released client asks for a personal one", async () => {
    const created = await request("/spaces", OWNER_AUTH, {
      name: "Mine", iconKey: "briefcase", colorKey: "blue", scope: "personal",
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Mine", scope: "workspace" });
    expect((await spaceDirectories(OWNER)).active.items.find((item) => item.name === "Mine"))
      .toMatchObject({ scope: "workspace" });
  });
});

describe("POST /workstreams", () => {
  useSelectedModel();
  useOpenRouterDouble(async () => ({ say: "On it." }));

  // A Space grants no reader, so the route is what makes a Channel a person
  // starts in Rally public; without it every new Channel would be private.
  it("creates a Channel a person starts in a Space as Organization-wide", async () => {
    const space = await createSpace("Launch");
    const created = await request("/workstreams", OWNER_AUTH, {
      openingMessage: "Plan the launch",
      clientMessageId: "route-default-scope",
      participantUserIds: [],
      attachmentIds: [],
      spaceIds: [space.id],
    });

    expect(created.status).toBe(201);
    const { workstream } = created.body as { workstream: { id: WorkstreamId; scope: string } };
    expect(workstream.scope).toBe("workspace");
    expect(await channelAudience(workstream.id)).toEqual({ scope: "workspace", participantUserIds: [OWNER] });
  });
});

describe("a Space created without an icon", () => {
  // Opened by the gate when a case wants a person's edit to land first.
  let gate: Promise<void> = Promise.resolve();
  useSelectedModel();
  useOpenRouterDouble(async () => {
    await gate;
    return { say: JSON.stringify({ title: "Hiring pipeline", icon: "rocket" }) };
  });

  beforeEach(() => { namingModelReachable = true; });
  afterEach(() => { namingModelReachable = false; gate = Promise.resolve(); });

  async function storedIcon(spaceId: string): Promise<string | undefined> {
    return (await spaceDirectories(OWNER)).active.items.find((item) => item.id === spaceId)?.iconKey;
  }

  it("is given the icon Rally chooses from its name", async () => {
    // Through the route, which hands the pass to `waitUntil`; `request` waits
    // on that execution context before it returns. The slow answer is what
    // tells the two apart: a pass the route let go of lands after the read.
    gate = new Promise((resolve) => setTimeout(resolve, 1_000));
    const created = await request("/spaces", OWNER_AUTH, { name: "Hiring", colorKey: "blue", scope: "workspace" });
    expect(created).toMatchObject({ status: 201, body: { iconKey: "circle-dot" } });

    expect(await storedIcon((created.body as SpaceSummary).id)).toBe("rocket");
  });

  it("keeps the icon a person picks while Rally is still choosing", async () => {
    let release = () => {};
    gate = new Promise((resolve) => { release = resolve; });
    const deferred: Promise<void>[] = [];
    const service = new SpaceService(routeEnv(), OWNER_AUTH);
    const created = await service.create(
      { name: "Hiring", colorKey: "blue", scope: "workspace" },
      undefined,
      (work) => deferred.push(work),
    );
    await service.updatePresentation(asSpaceId(created.id), { name: "Hiring", iconKey: "target", colorKey: "blue" });

    release();
    await Promise.all(deferred);
    expect(await storedIcon(created.id)).toBe("target");
  });
});

describe("conversation import routes", () => {
  // Starting an import starts its agent. A run that ends before the import
  // completes takes its unopened Channel back, so each test's agent waits on
  // the model until the test is over, as a real one is mid-read when the
  // desktop completes.
  let release = () => {};
  beforeEach(() => {
    const held = new Promise<void>((resolve) => { release = resolve; });
    gate = held;
    importModelHeld = true;
  });
  afterEach(async () => {
    release();
    importModelHeld = false;
    await Promise.all(importContexts.splice(0).map(context => waitOnExecutionContext(context)));
  });
  let gate: Promise<void> = Promise.resolve();
  useSelectedModel();
  useOpenRouterDouble(async () => {
    await gate;
    return { say: "Imported." };
  });
  const SOURCE_URL = "https://claude.ai/chat/0a1b2c3d-0000-4000-8000-00000000d200";
  const SOURCE = { provider: "claude", url: SOURCE_URL, sessionId: "0a1b2c3d-0000-4000-8000-00000000d200" };

  /** Reserve a Channel through the start route, then open it with `messages`. */
  async function importChannel(title: string, clientMessageId: string, spaceIds: string[], messages: unknown[]) {
    const started = await request("/workstreams/import/runs", OWNER_AUTH, { sourceUrl: SOURCE_URL, title, clientMessageId, spaceIds });
    expect(started.status).toBe(201);
    const { workstreamId } = started.body as { workstreamId: WorkstreamId };
    return request(`/workstreams/${workstreamId}/import/complete`, OWNER_AUTH, {
      title, source: SOURCE, content: { messages }, clientMessageId, spaceIds,
    });
  }

  it.each([null, "1", "2"])("refuses import admission from unsupported client contract %s", async (contract) => {
    const before = await request("/workstreams", OWNER_AUTH);
    const body = { sourceUrl: SOURCE_URL, title: "Unsupported import", clientMessageId: "00000000-0000-7000-8000-00000000d299", spaceIds: [] };
    const started = await request("/workstreams/import/runs", OWNER_AUTH, body, "POST", contract);
    expect(started).toMatchObject({ status: 426, body: { error: { code: "client_update_required", message: "Update Rally to import conversations with this version of the browser tools." } } });
    const updated = await request("/workstreams/00000000-0000-7000-8000-00000000d299/import/runs", OWNER_AUTH, {}, "POST", contract);
    expect(updated.status).toBe(426);
    expect(await request("/workstreams", OWNER_AUTH)).toEqual(before);
  });

  it("takes an import back through the abandon route by its create key alone", async () => {
    const clientMessageId = "00000000-0000-7000-8000-00000000d208";
    const started = await request("/workstreams/import/runs", OWNER_AUTH, { sourceUrl: SOURCE_URL, title: "Taken back", clientMessageId, spaceIds: [] });
    expect(started.status).toBe(201);
    const { workstreamId } = started.body as { workstreamId: string };
    expect(await request("/workstreams/import/abandon", OWNER_AUTH, { clientMessageId })).toEqual({ status: 204, body: null });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
      "SELECT archived_at FROM channels WHERE workstream_id = ?", workstreamId).one().archived_at)).not.toBeNull();
  });

  it("rejects an imported title outside the Channel creation contract", async () => {
    const started = await request("/workstreams/import/runs", OWNER_AUTH, {
      sourceUrl: SOURCE_URL,
      title: "x".repeat(181),
      clientMessageId: "00000000-0000-7000-8000-00000000d204",
      spaceIds: [],
    });

    expect(started.status).toBe(400);
  });

  it("settles the chosen title and places imported history in the selected Space", async () => {
    const destination = await createSpace("Research");
    const imported = await importChannel("Imported research", "00000000-0000-7000-8000-00000000d205", [destination.id], [
      { role: "user", text: "What did we learn?", sourceMessageId: "u1" },
      { role: "assistant", text: "The selected result.", sourceMessageId: "a1" },
    ]);
    expect(imported.status).toBe(201);
    const workstream = (imported.body as {
      workstream: { id: WorkstreamId; title: string; titleStatus: string };
    }).workstream;
    expect(workstream).toMatchObject({ title: "Imported research", titleStatus: "settled" });
    expect(await channelSpaceIds(asWorkstreamId(workstream.id))).toEqual([destination.id]);
  });

  it('rejects a different source before uploading its files', async () => {
    const imported = await importChannel('Source validation', '00000000-0000-7000-8000-00000000d206', [],
      [{ role: 'user', text: 'Original', sourceMessageId: 'u1' }]);
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
    const source = await createSpace("Wrong source");
    const target = await createSpace("Untouched target");
    const workstreamId = await createChannel("invalid-source-move");

    const moved = await request(
      `/spaces/${target.id}/channels/${workstreamId}/move`,
      OWNER_AUTH,
      { sourceSpaceId: source.id },
    );

    expect(moved).toMatchObject({ status: 404, body: { error: { code: "space_not_found" } } });
    expect((await spaceDirectories(OWNER)).active.items.find((item) => item.id === target.id))
      .toMatchObject({ channelCount: 0 });
    expect(await channelSpaceIds(workstreamId)).not.toContain(target.id);
  });

  it("moves a Channel behind one HTTP boundary and returns both changed Spaces", async () => {
    const source = await createSpace("Source");
    const target = await createSpace("Target");
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
    expect(await channelSpaceIds(workstreamId)).toContain(target.id);
    expect(await channelSpaceIds(workstreamId)).not.toContain(source.id);
    // One WorkspaceDO transaction: no `move` intent was staged for a resume,
    // and the add-then-remove path (which stages an `add` into the target and a
    // `remove` out of the source) was not taken.
    expect(await workspace().runInspectionSql({
      sql: `SELECT kind, space_id FROM space_intents
             WHERE workstream_id = ? AND (kind IN ('move', 'remove') OR space_id = ?)`,
      bindings: [workstreamId, target.id],
    })).toMatchObject({ rows: [] });
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

describe("PATCH /spaces/:id", () => {
  // A Personal Channel is `individual`; a desktop built before that scope reads
  // it as the private Channel it is rather than failing to parse the summary.
  it("answers a Personal Channel as private to a client that predates its scope", async () => {
    await seatOrganizationMember(routeEnv(), WORKSPACE_ID, OWNER);
    const personal = await personalSpaceIdFor(WORKSPACE_ID, OWNER);
    const rename = { name: "Scratch", iconKey: "briefcase", colorKey: "blue" };

    const released = await request(`/spaces/${personal}`, OWNER_AUTH, rename, "PATCH", "3");
    const current = await request(`/spaces/${personal}`, OWNER_AUTH, rename, "PATCH", String(INDIVIDUAL_SPACE_CLIENT_CONTRACT));

    expect([released.status, released.body]).toEqual([200, expect.objectContaining({ name: "Scratch", scope: "personal" })]);
    expect([current.status, current.body]).toEqual([200, expect.objectContaining({ name: "Scratch", scope: "individual" })]);
  });
});

describe("PATCH /spaces/:id/audience", () => {
  it("changes who a Space lists, stages nothing for its member Channel, and leaves that Channel's audience alone", async () => {
    const created = await createSpace("Hiring");
    const workstreamId = await createChannel("member-channel");
    const placed = await request(`/spaces/${created.id}/channels`, OWNER_AUTH, { workstreamId });
    expect(placed.status).toBe(200);

    const changed = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER],
    }, "PATCH");
    expect(changed).toMatchObject({ status: 200, body: { scope: "workspace" } });
    expect((changed.body as SpaceSummary).participants.map((participant) => participant.userId).sort())
      .toEqual([OWNER, MEMBER].sort());

    // WorkspaceDO holds the audience alone; no conversation carries a copy,
    // and nothing is staged to carry it to a Channel.
    expect(await conversationInitialized(created.id)).toBe(false);
    expect(await workspace().runInspectionSql({
      sql: "SELECT kind FROM space_intents WHERE space_id = ? AND kind = 'audience'",
      bindings: [created.id],
    })).toMatchObject({ rows: [] });
    // A Space participant is not a Channel reader.
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect(await channelAudience(workstreamId)).toEqual({ scope: "personal", participantUserIds: [OWNER] });
  });

  it("makes a Channel private to its members and keeps it so in the directory", async () => {
    const created = await createSpace("Hiring");

    const saved = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "personal", participantUserIds: [OWNER],
    }, "PATCH");

    expect(saved.status).toBe(200);
    expect(await spaceDirectoryRow(created.id)).toMatchObject({ scope: "personal" });
  });

  it("lets a participant leave a private Channel, after which it is gone from their list and not from the others'", async () => {
    const created = await createSpace("Hiring");
    await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "personal", participantUserIds: [OWNER, MEMBER],
    }, "PATCH");

    // The owner is already connected: the leave has to be pushed to them.
    const owner = await subscribedSocket(OWNER);
    const pushed = nextSpaceSnapshot(owner.socket);

    const left = await request(`/spaces/${created.id}/audience`, MEMBER_AUTH, {
      scope: "personal", participantUserIds: [OWNER],
    }, "PATCH");

    expect(left).toEqual({ status: 204, body: null });
    expect((await spaceDirectories(MEMBER)).active.items.map((item) => item.id)).not.toContain(created.id);
    const kept = (await pushed).spaces.active.items.find((item) => item.id === created.id);
    owner.socket.close();
    expect(kept?.participants.map((participant) => participant.userId)).toEqual([OWNER]);
  });
});

describe("Organization invitees in a Space", () => {
  const DANA = asUserId("00000000-0000-7000-8000-00000000d2e1");

  /** The D1 rows an Organization invitation leaves before it is accepted. */
  async function invite(email: string, state: "pending" | "revoked" = "pending"): Promise<void> {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_invitations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
        accepted_at TEXT, revoked_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      )`),
      env.DB.prepare(`INSERT INTO workspace_invitations (id, workspace_id, email, accepted_at, revoked_at, expires_at, created_at)
        VALUES (?, ?, ?, NULL, ?, '2099-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`)
        .bind(crypto.randomUUID(), WORKSPACE_ID, email, state === "revoked" ? "2026-10-02T00:00:00.000Z" : null),
    ]);
  }

  async function participantIds(spaceId: string): Promise<string[]> {
    const space = (await spaceDirectories(OWNER)).active.items.find((item) => item.id === spaceId);
    return (space?.participants ?? []).map((participant) => participant.userId).sort();
  }

  it("lists a pending invitee by address and seats them as a participant when they join", async () => {
    await invite("dana@example.com");
    const created = await createSpace("Hiring");

    const saved = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER], inviteeEmails: ["Dana@Example.com"],
    }, "PATCH");
    expect(saved.status).toBe(200);
    expect(await request(`/spaces/${created.id}/invitees`, MEMBER_AUTH))
      .toEqual({ status: 200, body: { items: [{ email: "dana@example.com" }] } });

    // Accepting writes the membership, then seats them where they were listed.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id, email, name, timezone, created_at) VALUES (?, 'dana@example.com', 'Dana', 'UTC', '2026-01-01T00:00:00.000Z')")
        .bind(DANA),
      env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role, access_class)
        VALUES (?, ?, 'active', 'member', 'member')`).bind(WORKSPACE_ID, DANA),
    ]);
    expect(await seatSpaceInvitee(routeEnv(), WORKSPACE_ID, DANA, "dana@example.com")).toEqual([created.id]);

    expect(await participantIds(created.id)).toEqual([OWNER, DANA].sort());
    expect(await request(`/spaces/${created.id}/invitees`, OWNER_AUTH))
      .toEqual({ status: 200, body: { items: [] } });
  });

  it("refuses an address with no pending invitation, and a member taking an invitee out", async () => {
    await invite("dana@example.com");
    await invite("gone@example.com", "revoked");
    const created = await createSpace("Hiring");

    const unknown = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER], inviteeEmails: ["gone@example.com"],
    }, "PATCH");
    expect(unknown).toMatchObject({ status: 422, body: { error: { code: "space_invitee_not_invited" } } });

    await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER], inviteeEmails: ["dana@example.com"],
    }, "PATCH");
    const removal = await request(`/spaces/${created.id}/audience`, MEMBER_AUTH, {
      scope: "workspace", participantUserIds: [OWNER, MEMBER], inviteeEmails: [],
    }, "PATCH");
    expect(removal).toMatchObject({ status: 403, body: { error: { code: "participant_removal_denied" } } });
    expect(await request(`/spaces/${created.id}/invitees`, OWNER_AUTH))
      .toEqual({ status: 200, body: { items: [{ email: "dana@example.com" }] } });
  });
});

describe("the other Space operations", () => {
  it("renames and re-dresses a Space without addressing any conversation", async () => {
    const created = await createSpace("Hiring");

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

  it("archives exclusive threads without moving them to General, while shared threads stay active", async () => {
    const opened = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId(crypto.randomUUID()),
    });
    if (!opened.ok || "absent" in opened) throw new Error("openGeneralSpace refused");
    const channel = await createSpace("Blog");
    const other = await createSpace("Editorial");
    const exclusive = await createChannel("exclusive-calendar", [asSpaceId(channel.id)]);
    const shared = await createChannel("shared-calendar", [asSpaceId(channel.id), asSpaceId(other.id)]);
    await deliverEffectsToWorkspace(env, spaceConversation(exclusive));
    await deliverEffectsToWorkspace(env, spaceConversation(shared));

    expect(await request(`/spaces/${channel.id}/archive`, OWNER_AUTH, {}, "POST"))
      .toMatchObject({ status: 200, body: { status: "archived" } });

    const lifecycle = (id: string) => runInDurableObject(spaceConversation(id), (_instance, state) =>
      state.storage.sql.exec<{ exact_state: string; archived: number }>(
        "SELECT exact_state, archived_at IS NOT NULL AS archived FROM workstream WHERE id = 1",
      ).one());
    // Returning the Channel result does not wait for any thread authority.
    expect(await lifecycle(exclusive)).toEqual({ exact_state: "idle", archived: 0 });
    await resumeChannelArchives(exclusive);
    expect(await lifecycle(exclusive)).toEqual({ exact_state: "archived", archived: 1 });
    expect(await lifecycle(shared)).toEqual({ exact_state: "idle", archived: 0 });
    await deliverEffectsToWorkspace(env, spaceConversation(exclusive));
    expect(await channelSpaceIds(exclusive)).not.toContain(opened.space.id);
    expect(await channelSpaceIds(shared)).toEqual([other.id]);
    expect(await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: exclusive, userId: OWNER }))
      .toMatchObject({ authorized: true, archived: true });

    expect(await request(`/spaces/${channel.id}/restore`, OWNER_AUTH, {}, "POST"))
      .toMatchObject({ status: 200, body: { status: "active" } });
    expect(await lifecycle(exclusive)).toEqual({ exact_state: "archived", archived: 1 });
    expect(await channelSpaceIds(shared)).toEqual([channel.id, other.id].sort());
  });

  it("replays an interrupted Channel archive without re-archiving a thread restored afterwards", async () => {
    const channel = await createSpace("Blog");
    const thread = await createChannel("archive-receipt", [asSpaceId(channel.id)]);
    await deliverEffectsToWorkspace(env, spaceConversation(thread));
    expect((await request(`/spaces/${channel.id}/archive`, OWNER_AUTH, {}, "POST")).status).toBe(200);
    await resumeChannelArchives(thread);
    await deliverEffectsToWorkspace(env, spaceConversation(thread));

    const intent = await workspace().runInspectionSql({
      sql: "SELECT operation_id, state FROM space_intents WHERE kind = 'archive' AND workstream_id = ?",
      bindings: [thread],
    });
    expect(intent.rows).toEqual([{ operation_id: expect.any(String), state: "settled" }]);
    const operationId = String(intent.rows[0]?.operation_id);
    // The thread committed, but WorkspaceDO died before saving its receipt.
    await workspace().runInspectionSql({
      sql: "UPDATE space_intents SET state = 'pending' WHERE operation_id = ?", bindings: [operationId],
    });
    expect((await request(`/workstreams/${thread}`, OWNER_AUTH, { archived: false }, "PATCH")).status).toBe(200);
    await deliverEffectsToWorkspace(env, spaceConversation(thread));

    expect(await workspace().resumeSpaceIntent({ auth: OWNER_AUTH, operationId }))
      .toEqual({ ok: true, outcome: "settled" });
    expect(await runInDurableObject(spaceConversation(thread), (_instance, state) =>
      state.storage.sql.exec<{ archived: number }>(
        "SELECT archived_at IS NOT NULL AS archived FROM workstream WHERE id = 1",
      ).one())).toEqual({ archived: 0 });
    expect(await workspace().runInspectionSql({
      sql: "SELECT state FROM space_intents WHERE operation_id = ?", bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "cancelled" }] });
    await finishHomeRepair();
    const general = await new SpaceService(routeEnv(), OWNER_AUTH).ensureGeneral();
    expect(await channelSpaceIds(thread)).toContain(general.id);
  });

  it("replays a lost archive reply with the same command hash after retry metadata changes", async () => {
    const channel = await createSpace("Blog");
    const thread = await createChannel("archive-hash", [asSpaceId(channel.id)]);
    await deliverEffectsToWorkspace(env, spaceConversation(thread));
    expect((await request(`/spaces/${channel.id}/archive`, OWNER_AUTH, {}, "POST")).status).toBe(200);
    // Exercise actual alarm delivery, not only the resume RPC.
    await workspace().runInspectionSql({
      sql: "UPDATE space_intents SET not_before = 0 WHERE workstream_id = ?", bindings: [thread],
    });
    await runDurableObjectAlarm(workspace());
    const operationId = await resumeChannelArchives(thread);
    // Mutable resume metadata is not part of the archive command's identity.
    await workspace().runInspectionSql({
      sql: "UPDATE space_intents SET state = 'pending', cursor = 'recovered' WHERE operation_id = ?", bindings: [operationId],
    });
    await resumeChannelArchives(thread);
    expect(await workspace().runInspectionSql({
      sql: "SELECT state, last_error_code FROM space_intents WHERE operation_id = ?", bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "settled", last_error_code: null }] });
  });

  it.each(["restore", "share"] as const)("cancels an undelivered thread archive after a %s", async (change) => {
    const channel = await createSpace("Blog");
    const other = await createSpace("Editorial");
    const thread = await createChannel(`archive-superseded-${change}`, [asSpaceId(channel.id)]);
    await deliverEffectsToWorkspace(env, spaceConversation(thread));
    expect((await request(`/spaces/${channel.id}/archive`, OWNER_AUTH, {}, "POST")).status).toBe(200);
    if (change === "restore") {
      expect((await request(`/spaces/${channel.id}/restore`, OWNER_AUTH, {}, "POST")).status).toBe(200);
    } else {
      expect(await workspace().addSpaceChannel({
        auth: OWNER_AUTH, spaceId: asSpaceId(other.id), workstreamId: thread,
      })).toMatchObject({ ok: true });
    }
    const operationId = await resumeChannelArchives(thread);
    expect(await runInDurableObject(spaceConversation(thread), (_instance, state) =>
      state.storage.sql.exec<{ archived: number }>("SELECT archived_at IS NOT NULL AS archived FROM workstream WHERE id = 1").one()))
      .toEqual({ archived: 0 });
    expect(await workspace().runInspectionSql({
      sql: "SELECT state, receipts_json FROM space_intents WHERE operation_id = ?", bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "settled", receipts_json: '["archive_superseded"]' }] });
    expect(await channelSpaceIds(thread)).toContain(change === "restore" ? channel.id : other.id);
  });

  it.each(["Main access", "Organization membership"] as const)("settles a permanent %s refusal and repairs the live thread's home", async (revoked) => {
    const channel = await createSpace("Blog");
    const thread = await createChannel("archive-access-revoked", [asSpaceId(channel.id)], { participantUserIds: [MEMBER] });
    await deliverEffectsToWorkspace(env, spaceConversation(thread));
    // Hold this delivery in durable scheduling state before it is staged. The
    // real alarm can run while grant revocation awaits its participant projection.
    // Explicit resume below ignores not_before and exercises the refusal itself.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER hold_archive_delivery AFTER INSERT ON space_intents
        WHEN NEW.kind = 'archive'
        BEGIN UPDATE space_intents SET not_before = 253402300799000 WHERE operation_id = NEW.operation_id; END`);
    });
    expect((await request(`/spaces/${channel.id}/archive`, OWNER_AUTH, {}, "POST")).status).toBe(200);
    if (revoked === "Main access") {
      // Remove the owning-Thread and Main grants together, holding the directory effect.
      await new WorkstreamObjectClient(routeEnv(), OWNER_AUTH, thread).removeParticipant(OWNER, { owningThread: true });
    } else {
      await changeRelationships(env, WORKSPACE_ID, [OWNER],
        env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
          .bind(WORKSPACE_ID, OWNER));
    }
    const operationId = await resumeChannelArchives(thread);
    expect(await workspace().runInspectionSql({
      sql: "SELECT state, last_error_code FROM space_intents WHERE operation_id = ?", bindings: [operationId],
    })).toMatchObject({ rows: [{ state: "settled",
      last_error_code: revoked === "Main access" ? "workstream_not_found" : "space_intent_requester_inactive" }] });
    await deliverEffectsToWorkspace(env, spaceConversation(thread));
    await finishHomeRepair();
    const general = await new SpaceService(routeEnv(), MEMBER_AUTH).ensureGeneral();
    expect(await workspace().channelSpaces({ workspaceId: WORKSPACE_ID, userId: MEMBER, workstreamId: thread }))
      .toMatchObject({ spaceIds: [general.id] });
  });

  it("archives and restores a Space", async () => {
    const general = await createSpace("Everything");
    const created = await createSpace("Hiring");
    // A shared thread stays active in its other Channel.
    const workstreamId = await createChannel("two-homes", [
      asSpaceId(general.id), asSpaceId(created.id),
    ]);

    const archived = await request(`/spaces/${created.id}/archive`, OWNER_AUTH, {}, "POST");
    expect(archived).toMatchObject({ status: 200, body: { status: "archived" } });
    expect(await channelSpaceIds(workstreamId)).toEqual([general.id]);

    const restored = await request(`/spaces/${created.id}/restore`, OWNER_AUTH, {}, "POST");
    expect(restored).toMatchObject({ status: 200, body: { status: "active" } });
    expect(await channelSpaceIds(workstreamId)).toEqual([general.id, created.id].sort());
  });

  it("archives a Space whose only leftover Channel is already archived", async () => {
    const created = await createSpace("Hiring");
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
    const general = await createSpace("Everything");
    const created = await createSpace("Hiring");
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

/** A Space whose participants are exactly these people. */
async function spaceWith(name: string, participantUserIds: readonly string[]): Promise<SpaceSummary> {
  const created = await createSpace(name);
  if (participantUserIds.length === 1 && participantUserIds[0] === OWNER) return created;
  const changed = await request(`/spaces/${created.id}/audience`, OWNER_AUTH, {
    scope: "workspace", participantUserIds,
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

/** Whether the Channel's own conversation seats this person. */
async function seated(workstreamId: WorkstreamId, userId: string): Promise<boolean> {
  return runInDurableObject(spaceConversation(workstreamId), (_instance, state) => (
    state.storage.sql.exec<{ status: string }>(
      "SELECT status FROM participants WHERE user_id = ?", userId,
    ).toArray()[0]?.status === "active"
  ));
}

describe("a Channel's Space membership, driven from WorkspaceDO", () => {
  it("given a private Channel, when it is added to a Space that lists another member, then it stays private with its own participants and the membership is active in one call", async () => {
    const mine = await spaceWith("Mine", [OWNER]);
    const hiring = await spaceWith("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("add-existing", [asSpaceId(mine.id)]);

    const added = await request(`/spaces/${hiring.id}/channels`, OWNER_AUTH, { workstreamId });

    expect(added).toMatchObject({ status: 200, body: { id: hiring.id, channelCount: 1 } });
    expect(await channelAudience(workstreamId)).toEqual({ scope: "personal", participantUserIds: [OWNER] });
    expect(await seated(workstreamId, MEMBER)).toBe(false);
    expect(await membershipState(workstreamId, hiring.id)).toBe("active");
    expect(await intentStates(workstreamId, "add")).toEqual([]);
  });

  it("given a private Channel in two Spaces, when it leaves one, then nobody is withdrawn and the removal commits in one call", async () => {
    const mine = await spaceWith("Mine", [OWNER]);
    const hiring = await spaceWith("Hiring", [OWNER, MEMBER]);
    const workstreamId = await createChannel("leave-one", [asSpaceId(mine.id), asSpaceId(hiring.id)], {
      participantUserIds: [MEMBER],
    });
    expect(await seated(workstreamId, MEMBER)).toBe(true);

    const removed = await request(`/spaces/${hiring.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");

    expect(removed).toMatchObject({ status: 200, body: { id: hiring.id, channelCount: 0 } });
    expect(await channelAudience(workstreamId))
      .toEqual({ scope: "personal", participantUserIds: [OWNER, MEMBER].sort() });
    expect(await channelSpaceIds(workstreamId)).toEqual([mine.id]);
    expect(await membershipState(workstreamId, hiring.id)).toBe("removed");
    expect(await intentStates(workstreamId, "remove")).toEqual([]);
  });

  it("given an Organization-wide Channel, when it leaves a Space, then it stays Organization-wide and nothing is revoked", async () => {
    const company = await createSpace("Company");
    const mine = await spaceWith("Mine", [OWNER]);
    const workstreamId = await createChannel("stays-open", [asSpaceId(company.id), asSpaceId(mine.id)], {
      scope: "workspace",
    });
    // A revocation Queue that refuses every send: a removal that narrowed
    // anything would have to publish through it and would fail.
    const revocations = Object.getPrototypeOf(env.ACCESS_REVOCATION_QUEUE) as { send: (body: unknown) => Promise<void> };
    const refuse = vi.spyOn(revocations, "send").mockImplementation(async () => {
      throw new Error("revocation_queue_unavailable");
    });

    const removed = await request(`/spaces/${company.id}/channels/${workstreamId}`, OWNER_AUTH, undefined, "DELETE");
    refuse.mockRestore();

    expect(removed).toMatchObject({ status: 200, body: { id: company.id, channelCount: 0 } });
    expect((await channelAudience(workstreamId)).scope).toBe("workspace");
    expect(await membershipState(workstreamId, company.id)).toBe("removed");
    expect(await intentStates(workstreamId, "remove")).toEqual([]);
  });
});

describe("the navigation routes", () => {
  it("answers a member's threads, Channel stats, pins and Activity, and keeps a pin across reads", async () => {
    const space = await createSpace("Outbound");

    const threads = await request("/navigation/threads", MEMBER_AUTH);
    expect(threads).toMatchObject({ status: 200, body: { items: [], pinned: [], nextCursor: null } });
    const stats = await request("/navigation/channel-stats", MEMBER_AUTH);
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual(expect.arrayContaining([expect.objectContaining({ channelId: space.id, threadCount: 0 })]));

    expect(await request(`/navigation/pins/channel/${space.id}`, MEMBER_AUTH, {}, "PUT"))
      .toEqual({ status: 200, body: [{ kind: "channel", id: space.id, parentId: null }] });
    expect(await request("/navigation/pins", MEMBER_AUTH))
      .toEqual({ status: 200, body: [{ kind: "channel", id: space.id, parentId: null }] });
    // One person's pin, and nobody else's.
    expect(await request("/navigation/pins", OWNER_AUTH)).toEqual({ status: 200, body: [] });

    expect(await request("/navigation/activity", MEMBER_AUTH)).toMatchObject({ status: 200, body: { items: [] } });
  });

  it("refuses what its schemas do not admit, naming no internal detail", async () => {
    const space = await createSpace("Outbound");
    const breakoutWithoutParent = await request(
      "/navigation/pins/breakout/00000000-0000-7000-8000-00000000d2f1", MEMBER_AUTH, {}, "PUT",
    );
    expect(breakoutWithoutParent.status).toBe(404);
    expect((await request("/navigation/pins/folder/00000000-0000-7000-8000-00000000d2f1", MEMBER_AUTH, {}, "PUT")).status)
      .toBe(400);
    expect((await request("/navigation/activity/seen", MEMBER_AUTH, { seenThrough: "x" }, "PUT")).status).toBe(400);
    expect((await request(`/navigation/threads?cursor=${"a".repeat(201)}`, MEMBER_AUTH)).status).toBe(400);
    expect((await request(`/spaces/${space.id}/read-state`, MEMBER_AUTH, {
      readThroughSequenceNumber: 0, observedManualUnreadGeneration: 0,
    }, "PATCH")).status).toBe(400);
  });

  it("reads a Channel's feed and acknowledges it for the person asking", async () => {
    const space = await createSpace("Outbound");
    expect(await request(`/spaces/${space.id}/feed`, MEMBER_AUTH))
      .toMatchObject({ status: 200, body: { items: [], nextCursor: null } });
    expect(await request(`/spaces/${space.id}/read-state`, MEMBER_AUTH, { readThroughSequenceNumber: 0 }, "PATCH"))
      .toMatchObject({ status: 200, body: { channelId: space.id, hasUnread: false } });
  });

  /** The member's one Activity row about this thread. */
  async function activityRow(workstreamId: WorkstreamId): Promise<Record<string, unknown> | undefined> {
    const page = await request("/navigation/activity", MEMBER_AUTH);
    expect(page.status).toBe(200);
    return (page.body as { items: Array<Record<string, unknown>> }).items
      .find((item) => item.threadId === workstreamId);
  }

  it("settles a started thread's Activity row when the app reports the Channel read past its placement", async () => {
    const space = await createSpace("Outbound");
    const workstreamId = await createChannel("activity-channel-read", [asSpaceId(space.id)], { scope: "workspace" });
    await deliverEffectsToWorkspace(env, spaceConversation(workstreamId));
    expect(await activityRow(workstreamId)).toMatchObject({ kind: "thread_started", unread: true });

    const stats = await request("/navigation/channel-stats", MEMBER_AUTH);
    const placement = (stats.body as Array<{ channelId: string; latestAttentionSequenceNumber: number }>)
      .find((row) => row.channelId === space.id)?.latestAttentionSequenceNumber;
    expect(placement).toBe(1);
    // Short of the placement settles nothing.
    expect((await request("/navigation/activity/events", MEMBER_AUTH, {
      events: [{ kind: "read", subject: { kind: "channel", channelId: space.id }, through: 0 }],
    })).status).toBe(204);
    expect(await activityRow(workstreamId)).toMatchObject({ unread: true });

    expect((await request("/navigation/activity/events", MEMBER_AUTH, {
      events: [{ kind: "read", subject: { kind: "channel", channelId: space.id }, through: 1 }],
    })).status).toBe(204);
    expect(await activityRow(workstreamId)).toMatchObject({ kind: "thread_started", unread: false });
  });

  it("settles a started thread's Activity row when the app reports the thread opened", async () => {
    const space = await createSpace("Outbound");
    const workstreamId = await createChannel("activity-thread-open", [asSpaceId(space.id)], { scope: "workspace" });
    await deliverEffectsToWorkspace(env, spaceConversation(workstreamId));
    expect(await activityRow(workstreamId)).toMatchObject({ kind: "thread_started", unread: true });

    expect((await request("/navigation/activity/events", MEMBER_AUTH, {
      events: [{ kind: "read", subject: { kind: "thread", threadId: workstreamId }, through: 0 }],
    })).status).toBe(204);

    expect(await activityRow(workstreamId)).toMatchObject({ kind: "thread_started", unread: false });
  });

  it("refuses an Activity event its schema does not admit", async () => {
    expect((await request("/navigation/activity/events", MEMBER_AUTH, { events: [] })).status).toBe(400);
    expect((await request("/navigation/activity/events", MEMBER_AUTH, {
      events: [{ kind: "read", subject: { kind: "folder", id: "x" }, through: 0 }],
    })).status).toBe(400);
    expect((await request("/navigation/activity/events", MEMBER_AUTH, {
      events: [{ kind: "read", subject: { kind: "channel", channelId: "x" }, through: -1 }],
    })).status).toBe(400);
  });

  it("serves a Channel's messages to a build that reads them, and withholds them from one that does not", async () => {
    const opened = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000d2a4"),
    });
    if (!opened.ok || "absent" in opened) throw new Error("openGeneralSpace refused");
    const path = `/spaces/${opened.space.id}/feed`;
    expect(await request(path, MEMBER_AUTH, undefined, "GET", "6")).toMatchObject({
      status: 200,
      body: { items: [{ kind: "message", message: { author: { kind: "rally" }, body: expect.stringMatching(/^Welcome to Rally, we’ve created a channel/u) } }] },
    });
    expect(await request(path, MEMBER_AUTH, undefined, "GET", "5")).toMatchObject({ status: 200, body: { items: [] } });
  });

  it("serves a thread's merge to a build that reads merges, and the same words as a plain message to one that does not", async () => {
    const opened = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000d2a5"),
    });
    if (!opened.ok || "absent" in opened) throw new Error("openGeneralSpace refused");
    const threadId = "00000000-0000-7000-8000-00000000d2a6";
    await workspace().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: threadId, substreamId: asSubstreamId("0"), kind: "main",
      createdByUserId: OWNER, authorityGeneration: 1,
      directory: { title: "Launch plan", description: "", scope: "workspace", systemKind: null, emailAddress: null,
        titleStatus: "settled", createdAt: "2026-10-16T00:00:00.000Z" },
    });
    await runInDurableObject(workspace(), (instance) => {
      (instance as unknown as { spaceStorage(): { postMessage(spaceId: string, draft: unknown, postedAt: number): unknown } })
        .spaceStorage().postMessage(opened.space.id, {
          author: { kind: "member", userId: OWNER }, body: "Shipped.", key: `merge:${threadId}`, replace: true,
          sourceWorkstreamId: threadId, embeds: [], operationId: "op-1",
        }, Date.now());
    });
    const path = `/spaces/${opened.space.id}/feed`;
    const merged = (body: unknown) => (body as { items: Array<{ kind: string; message?: Record<string, unknown> }> }).items
      .flatMap((item) => (item.message?.body === "Shipped." ? [item] : []));
    const current = await request(path, MEMBER_AUTH, undefined, "GET", "7");
    expect(merged(current.body)).toEqual([expect.objectContaining({
      attentionSequenceNumber: expect.any(Number),
      message: expect.objectContaining({ merge: { threadId, title: "Launch plan", summary: null, embeds: [] } }),
    })]);
    const older = await request(path, MEMBER_AUTH, undefined, "GET", "6");
    expect(merged(older.body)).toEqual([{
      kind: "message", placedAt: expect.any(String),
      message: { id: expect.any(String), author: { kind: "member", userId: OWNER }, body: "Shipped." },
    }]);
    // Activity: a merged row for a build that reads merges, none for one that does not.
    const activityRows = async (contract: string) => ((await request("/navigation/activity", MEMBER_AUTH, undefined, "GET", contract))
      .body as { items: Array<{ kind: string; mergedInto?: unknown }> }).items.filter((item) => item.kind === "merged");
    expect(await activityRows("7")).toEqual([expect.objectContaining({
      kind: "merged", threadId, mergedInto: { channelId: opened.space.id, name: opened.space.name },
    })]);
    expect(await activityRows("6")).toEqual([]);
  });

  it("serves a private thread's merge, without the thread but with its embeds, to a build that reads private merges, and leaves it out for one that does not", async () => {
    const opened = await workspace().openGeneralSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: asSpaceId("00000000-0000-7000-8000-00000000d2a7"),
    });
    if (!opened.ok || "absent" in opened) throw new Error("openGeneralSpace refused");
    const threadId = "00000000-0000-7000-8000-00000000d2a8";
    await workspace().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: threadId, substreamId: asSubstreamId("0"), kind: "main",
      createdByUserId: OWNER, authorityGeneration: 1,
      directory: { title: "Comp bands", description: "", scope: "personal", systemKind: null, emailAddress: null,
        titleStatus: "settled", createdAt: "2026-10-16T00:00:00.000Z" },
    });
    await runInDurableObject(workspace(), (instance) => {
      (instance as unknown as { spaceStorage(): { postMessage(spaceId: string, draft: unknown, postedAt: number): unknown } })
        .spaceStorage().postMessage(opened.space.id, {
          author: { kind: "member", userId: OWNER }, body: "Bands are set.", key: `merge:${threadId}`, replace: true,
          sourceWorkstreamId: threadId, embeds: [{ id: "resource-2", title: "Comp model", kind: "document" }], operationId: "op-p",
        }, Date.now());
    });
    const path = `/spaces/${opened.space.id}/feed`;
    const merged = (body: unknown) => (body as { items: Array<{ kind: string; message?: Record<string, unknown> }> }).items
      .flatMap((item) => (item.message?.body === "Bands are set." ? [item] : []));
    expect(merged((await request(path, MEMBER_AUTH, undefined, "GET", "9")).body)).toEqual([expect.objectContaining({
      message: expect.objectContaining({ merge: { threadId, title: "", summary: null, embeds: [{ id: "resource-2", title: "Comp model", kind: "document" }], private: true } }),
    })]);
    expect(merged((await request(path, MEMBER_AUTH, undefined, "GET", "8")).body)).toEqual([]);
    // Activity likewise: its row, without the thread, only for a build that reads it.
    const activityRows = async (contract: string) => ((await request("/navigation/activity", MEMBER_AUTH, undefined, "GET", contract))
      .body as { items: Array<{ kind: string; threadTitle: string; mergedInto?: unknown }> }).items.filter((item) => item.kind === "merged");
    expect(await activityRows("9")).toEqual([expect.objectContaining({
      threadTitle: "", mergedInto: { channelId: opened.space.id, name: opened.space.name, threadPrivate: true },
    })]);
    expect(await activityRows("8")).toEqual([]);
  });

  it("answers nobody who is not signed in", async () => {
    const response = await app.request("/navigation/threads", {}, routeEnv(), createExecutionContext());
    expect(response.status).toBe(401);
  });
});
