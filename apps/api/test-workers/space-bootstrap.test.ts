/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The one-time cutover that gives an existing Organization its hierarchy.
 *
 * Everything here needs the runtime. The cutover's whole job is to make three
 * objects agree about every Channel in an Organization — WorkspaceDO settles a
 * membership, the Channel's authority records the source, and the conversation
 * takes the audience that implies — and the one thing it must never do is force
 * that through a retained-content fence, which is a SQL trigger inside a real
 * conversation object. A double for any of those would be a double for the
 * thing under test.
 *
 * The Organization it drives is built by the *real* creation path and then
 * reset to the state a pre-cutover Organization is in: Channels with real
 * conversations, real content and real fences, and no Space tables populated at
 * all. Writing the directory rows by hand instead would give the preflight
 * nothing to be about.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  WorkspaceSocketSyncEventSchema,
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SpaceId,
} from "@rally/contracts";
import { conversationEffectHash } from "@rally/contracts/conversation-effects";

import { uuidV7 } from "../src/lib/uuid-v7";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import {
  SpaceBootstrapService,
  placeConnectorChannelInGeneral,
  spaceBootstrapDriver,
} from "../src/services/space-bootstrap-service";
import { SpaceService } from "../src/services/space-service";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { devRoutes } from "../src/routes/dev";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace id: object storage resets per case, object names do not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000dd0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000dd1");
const SESSION_ID = "00000000-0000-7000-8000-000000000dd2";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

/** The two variables the dev-gated seed route refuses to run without. */
function developmentEnv(): Env {
  const creation = creationEnv();
  return new Proxy(creation, {
    get: (current, property, receiver) => property === "APP_ENV" ? "development"
      : property === "RALLY_DEV_AUTH" ? "true"
      : Reflect.get(current, property, receiver),
  });
}

async function createChannel(clientMessageId: string, spaceIds: SpaceId[] = []): Promise<string> {
  const created = await new WorkstreamObjectCreationService(creationEnv(), AUTH).createPrepared({
    title: clientMessageId,
    clientMessageId,
    participantUserIds: [],
    spaceIds,
  }, { messages: [{ role: "user", text: "A prepared start" }] });
  return created.workstream.id;
}

async function personalSpace(): Promise<SpaceId> {
  const reserved = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    space: { name: "Private", iconKey: "briefcase", colorKey: "blue", scope: "personal" },
  });
  if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
  return asSpaceId(reserved.space.id);
}

/**
 * Put the Organization back the way one looks before the cutover.
 *
 * The Channels, their conversations and their audiences stay; every trace of a
 * Space goes. That is the state an existing Organization reaches migration 61
 * in, and building it this way rather than by writing directory rows is what
 * gives the containment preflight a real conversation to refuse.
 */
async function forgetSpaces(): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    for (const table of [
      "space_channel_memberships",
      "spaces",
      "space_viewers",
      "workspace_container_order",
    ]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec(
      `UPDATE space_bootstrap SET phase = 'pending', general_space_id = NULL, cursor = NULL,
              blocked_json = '[]', not_before = 0, attempts = 0, completed_at = NULL WHERE id = 1`,
    );
  });
}

/** An immutable content fence that excludes everybody but one reader. */
async function fenceRetainedContent(workstreamId: string): Promise<void> {
  await runInDurableObject(
    env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, workstreamId)),
    (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO content_audience_fences (fence_id, audience_json, created_at)
         VALUES (?, ?, ?)`,
        crypto.randomUUID(),
        JSON.stringify({ scope: "users", userIds: [USER_ID] }),
        Date.now(),
      );
    },
  );
}

/** Take a Channel back out of every Space, the way one the coordinator never placed looks. */
async function forgetMembership(workstreamId: string): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM space_channel_memberships WHERE workstream_id = ?",
      workstreamId,
    );
  });
}

/** Archive a Channel the way the Organization sees it. */
async function archiveInDirectory(workstreamId: string): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE channels SET archived_at = ? WHERE workstream_id = ?",
      Date.now(),
      workstreamId,
    );
  });
}

async function cutover(): Promise<SpaceBootstrapService> {
  const driver = await spaceBootstrapDriver(creationEnv(), WORKSPACE_ID, "global");
  if (!driver) throw new Error("no active member to drive the cutover");
  return new SpaceBootstrapService(creationEnv(), driver);
}

async function bootstrapRow(): Promise<{ phase: string; cursor: string | null }> {
  const row = await workspace().runInspectionSql({
    sql: "SELECT phase, cursor FROM space_bootstrap WHERE id = 1",
    bindings: [],
  });
  return row.rows[0] as { phase: string; cursor: string | null };
}

/**
 * Run whatever the row says is due, the way the alarm and the Queue would.
 *
 * The phase on the row is the claim, so this is the consumer's `switch` with
 * the Queue taken out: it walks the pages each pass owes and stops when the
 * cutover settles, either at `complete` or at a `finalize` that refused.
 */
async function runWholeCutover(): Promise<void> {
  const service = await cutover();
  for (let step = 0; step < 100; step += 1) {
    const state = await bootstrapRow();
    if (state.phase === "complete") return;
    const cursor = state.cursor === null ? null : asWorkstreamId(state.cursor);
    if (state.phase === "pending" || state.phase === "general") await service.runGeneral();
    else if (state.phase === "preflight") await service.runPreflight(cursor);
    else if (state.phase === "memberships") await service.runMemberships(cursor);
    else {
      // One close per run. `finalize` either completes the cutover or sends it
      // back to the walk, and a caller that wants the second walk asks for it.
      await service.runFinalize();
      return;
    }
  }
  throw new Error("the cutover did not settle");
}

async function membershipRows(): Promise<Array<{ workstream_id: string; state: string }>> {
  const result = await workspace().runInspectionSql({
    sql: `SELECT workstream_id, state FROM space_channel_memberships ORDER BY workstream_id`,
    bindings: [],
  });
  return result.rows as Array<{ workstream_id: string; state: string }>;
}

async function generalCount(): Promise<number> {
  const result = await workspace().runInspectionSql({
    sql: "SELECT COUNT(*) AS count FROM spaces WHERE system_role = 'general'",
    bindings: [],
  });
  return (result.rows[0] as { count: number }).count;
}

/**
 * Wake this Organization's object and read the alarm it armed for itself,
 * beside the cutover row that alarm is about.
 *
 * Both in one `runInDurableObject`, but the `await` in the middle of it opens
 * the object's input gate — so an alarm parked at `now + 1` may already have
 * fired, claimed the page and moved the cutover's gate before the read. That is
 * the object doing exactly what the alarm was armed for, so the row comes back
 * with the alarm and the caller compares the two rather than racing a stopwatch.
 */
async function alarmArmedOnWake(): Promise<{
  armed: number | null;
  cutover: { not_before: number; attempts: number };
}> {
  return runInDurableObject(workspace(), async (instance, state) => {
    await instance.spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    return {
      armed: await state.storage.getAlarm(),
      cutover: state.storage.sql.exec<{ not_before: number; attempts: number }>(
        "SELECT not_before, attempts FROM space_bootstrap WHERE id = 1",
      ).one(),
    };
  });
}

let ticketSequence = 0;

/**
 * `spacesReady` as a client actually reads it.
 *
 * There is no `GET /spaces`: the flag comes down the workspace socket's connect
 * payload and nowhere else, and it is what decides whether a sidebar draws the
 * hierarchy or the Organization-opening card. Reading the bootstrap row instead
 * would prove the phase moved and say nothing about whether anybody was told.
 */
async function spacesReadyOnSnapshot(): Promise<boolean> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": USER_ID,
      "x-rally-session-id": SESSION_ID,
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
  const initial = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => { resolve(String(event.data)); }, { once: true });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  const answer = WorkspaceSocketSyncEventSchema.parse(JSON.parse(await initial));
  socket.close();
  if (!answer.sidebar) throw new Error("workspace subscribe answered without a sidebar");
  // Optional on the wire so a client talking to a server without the cutover is
  // not permanently opening; a server that has it always sends it.
  if (answer.sidebar.spacesReady === undefined) {
    throw new Error("workspace sidebar answered without spacesReady");
  }
  return answer.sidebar.spacesReady;
}

/**
 * One Channel's common directory row, as its own authority publishes it.
 *
 * This is the envelope a Channel's existence reaches the Organization on, and
 * the one event that can put a Channel in the directory without anything having
 * placed it in a Space.
 */
function directoryCommonEnvelope(input: {
  workstreamId: string;
  title: string;
  systemKind?: "digest" | null;
  generation: number;
  sourceVersion: number;
}): Record<string, unknown> {
  const at = new Date().toISOString();
  const effect = {
    kind: "directory_common" as const,
    title: input.title,
    description: "",
    preview: "",
    scope: "personal" as const,
    state: "idle",
    systemKind: input.systemKind ?? null,
    lastActivityAt: at,
    completedAt: null,
    archivedAt: null,
    createdByUserId: USER_ID,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: at,
    updatedAt: at,
  };
  return {
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: input.workstreamId,
    generation: input.generation,
    // A directory state source identity has to be UUIDv7; the handoff refuses
    // anything else by name.
    messageId: uuidV7(),
    partitionKey: "common",
    sourceVersion: input.sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

/**
 * Deliver one common directory effect, at the next version this Channel's row
 * is fenced on.
 *
 * The handoff refuses an envelope at or below the waterline it already holds,
 * so the version has to be read rather than assumed — a Channel the creation
 * path built has published several already.
 */
async function deliverDirectoryCommon(input: {
  workstreamId: string;
  title: string;
  systemKind?: "digest" | null;
}): Promise<void> {
  const row = await directoryRow(input.workstreamId);
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [directoryCommonEnvelope({
      ...input,
      generation: row?.authority_generation ?? 1,
      sourceVersion: (row?.waterline ?? 0) + 1,
    })],
  } as never);
}

async function directoryRow(workstreamId: string): Promise<{
  title: string;
  waterline: number;
  authority_generation: number;
} | undefined> {
  const result = await workspace().runInspectionSql({
    sql: `SELECT title, waterline, authority_generation FROM channels
           WHERE workstream_id = ?`,
    bindings: [workstreamId],
  });
  return result.rows[0] as {
    title: string;
    waterline: number;
    authority_generation: number;
  } | undefined;
}

/** The audience the conversation itself holds, which is the one that decides. */
async function channelScope(workstreamId: string): Promise<string | null> {
  const audience = await env.SUBSTREAM_AGENTS
    .getByName(conversationObjectName("global", WORKSPACE_ID, workstreamId))
    .readerAudience({ workspaceId: WORKSPACE_ID, workstreamId });
  return audience === null ? null : audience.scope;
}

beforeEach(async () => {
  await reset();
  ticketSequence = 0;
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  await env.DB.batch([
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
}, 30_000);

describe("the Space cutover", () => {
  it("places every Channel in one General, archived ones included, and closes", async () => {
    const privateSpace = await personalSpace();
    const active = await createChannel("active-personal", [privateSpace]);
    const archived = await createChannel("archived-personal", [privateSpace]);
    const organizationWide = await createChannel("organization-wide");
    await archiveInDirectory(archived);
    await forgetSpaces();

    await runWholeCutover();

    expect(await generalCount()).toBe(1);
    const status = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    expect(status).toMatchObject({ phase: "complete", ready: true, blockedWorkstreamIds: [] });
    // One active membership each, and the archived Channel is one of them: a
    // Channel that is restored later must not come back to an Organization
    // that has no home for it.
    expect(await membershipRows()).toEqual([active, archived, organizationWide]
      .map((workstreamId) => ({ workstream_id: workstreamId, state: "active" }))
      .sort((left, right) => left.workstream_id.localeCompare(right.workstream_id)));
    // General is Organization-wide, so a formerly personal Channel becomes
    // Organization-wide with it. That is the PRD's intentional disclosure, and
    // it happens through the Channel's own scope operation rather than beside
    // it.
    expect(await channelScope(active)).toBe("workspace");
  });

  it("finds the fenced Channel before it widens any Channel, and refuses to close", async () => {
    const privateSpace = await personalSpace();
    const safe = await createChannel("safe-personal", [privateSpace]);
    const fenced = await createChannel("fenced-personal", [privateSpace]);
    await fenceRetainedContent(fenced);
    await forgetSpaces();

    await runWholeCutover();

    // The PRD's Existing Organizations section: an unsafe Channel blocks its
    // Organization "without partial mutation". The read-only preflight walks
    // the whole directory before `memberships` may be claimed, so the safe
    // Channel beside the fenced one is *not* Organization-wide and holds no
    // membership either — the disclosure did not happen by half.
    expect(await channelScope(fenced)).toBe("personal");
    expect(await channelScope(safe)).toBe("personal");
    expect(await membershipRows()).toEqual([]);
    const status = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    expect(status.ready).toBe(false);
    expect(status.blockedWorkstreamIds).toEqual([fenced]);
    // The reason is on the row for whoever reads it with SQL, which is how an
    // operator tells a content fence from an Organization with nobody left to
    // act.
    const blocked = await workspace().runInspectionSql({
      sql: "SELECT blocked_json FROM space_bootstrap WHERE id = 1",
      bindings: [],
    });
    expect(String((blocked.rows[0] as { blocked_json: string }).blocked_json))
      .toContain("space_membership_content_fence");
  });

  it("closes once the blocked Channel has a home the fence admits", async () => {
    const fenced = await createChannel("fenced-personal", [await personalSpace()]);
    await fenceRetainedContent(fenced);
    await forgetSpaces();

    await runWholeCutover();
    expect((await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID })).blockedWorkstreamIds)
      .toEqual([fenced]);

    // The remediation an operator has: the fence is immutable and General is
    // Organization-wide, so the Channel can never enter General — what it can
    // have is a home whose audience the fence already admits. Once it has one
    // the hierarchy invariant is true of it, and the walk stops counting it.
    await new SpaceService(creationEnv(), AUTH)
      .addChannel(await personalSpace(), asWorkstreamId(fenced));

    await runWholeCutover();

    // The whole point of B1: a blocker used to be permanent, because the only
    // writer that clears one is a pass that reaches the Channel and a
    // `finalize` that answered `blocked` never ran another.
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true, blockedWorkstreamIds: [] });
    // Remediated, not bypassed: the Channel is in a Space and still personal.
    expect(await channelScope(fenced)).toBe("personal");
  });

  it("is idempotent: a pass interrupted after its placements makes no second General and no second membership", async () => {
    const privateSpace = await personalSpace();
    const first = await createChannel("first", [privateSpace]);
    const second = await createChannel("second");
    await forgetSpaces();

    // The interruption: the placements land and the settlement that would have
    // moved the pass on never runs, so the alarm republishes the same page.
    const service = await cutover();
    await service.runGeneral();
    await service.runMemberships(null);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE space_bootstrap SET phase = 'memberships', cursor = NULL WHERE id = 1",
      );
    });

    await runWholeCutover();

    expect(await generalCount()).toBe(1);
    expect(await membershipRows()).toEqual([first, second]
      .map((workstreamId) => ({ workstream_id: workstreamId, state: "active" }))
      .sort((left, right) => left.workstream_id.localeCompare(right.workstream_id)));
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true });
  });

  it("reopens a finished cutover for a Channel the connector path could not place", async () => {
    await createChannel("already-placed");
    await forgetSpaces();
    await runWholeCutover();
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true });

    // A Channel in no Space on a finished Organization: the Slack agent
    // provisions its own conversation rather than going through the creation
    // coordinator, so its placement is a separate step that can be refused.
    const homeless = await createChannel("slack-opened");
    await forgetMembership(homeless);
    // The refusal a Slack member with no Rally identity produces: the
    // connector's own record of the Channel names nobody the disclosure could
    // be attributed to, so the one-off placement has no actor.
    await placeConnectorChannelInGeneral(creationEnv(), WORKSPACE_ID, {
      workstreamId: asWorkstreamId(homeless),
      scope: "personal",
      placed: false,
      participantUserIds: [],
    });

    // The Organization stops claiming a hierarchy it does not have, which is
    // what gets the alarm to walk it again.
    expect((await bootstrapRow()).phase).not.toBe("complete");
    expect((await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID })).ready).toBe(false);

    await runWholeCutover();

    // The walk reads the Organization's own directory projection, which knows
    // the participants the connector's record did not, so it places what the
    // one-off step could not.
    expect(await membershipRows()).toContainEqual({ workstream_id: homeless, state: "active" });
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true });
  });

  it("arms its own alarm for an Organization that has not finished its cutover", async () => {
    await createChannel("needs-a-home");
    await forgetSpaces();
    await evictDurableObject(workspace());

    // Constructing the object is the whole trigger. The PRD's fleet migration
    // has to finish without relying on user access, so the tracker's forced
    // pass wakes every WorkspaceDO and the alarm it arms for itself is what
    // claims the first page — there is no request behind any of this.
    const woke = await alarmArmedOnWake();
    expect(woke.armed).not.toBeNull();
    // The cutover's own candidate, not the month-away retention sweep. An
    // unstarted cutover's `not_before` is zero and an overdue candidate is
    // parked one millisecond out, so the alarm is due now — unless the wake has
    // already run it, in which case the claim advanced the cutover's gate and
    // the alarm stands on that instant instead. Both readings are this row and
    // nothing else, which is what makes the assertion exact rather than a race
    // against the clock.
    expect(woke.armed! <= Date.now() + 1 || woke.armed === woke.cutover.not_before).toBe(true);

    await runWholeCutover();
    await evictDurableObject(workspace());

    // A finished cutover contributes no candidate, so the object wakes only for
    // whatever else it owes — none of which is owed now.
    const after = await alarmArmedOnWake();
    expect(after.armed === null || after.armed > Date.now() + 1).toBe(true);
  });

  it("refuses to close while a Channel is still outside every Space", async () => {
    const unplaced = await createChannel("unplaced");
    await forgetSpaces();

    const service = await cutover();
    await service.runGeneral();
    // Finalize without the placement pass: the gate is the Channels themselves
    // rather than a count of receipts, because a Channel created while the
    // cutover runs is placed by the creation path and has no receipt at all.
    await service.runFinalize();

    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }).then((s) => s.ready))
      .toBe(false);
    expect(await membershipRows()).toEqual([]);
    void unplaced;
  });

  it("reopens a finished cutover when a Channel it already holds projects from no Space", async () => {
    await createChannel("already-placed");
    await forgetSpaces();
    await runWholeCutover();
    expect(await spacesReadyOnSnapshot()).toBe(true);

    // The event nothing noticed. Every creation path places the Channel it
    // makes, and the cutover places every Channel that predates them — but a
    // directory row is committed by this handoff, and a `complete`
    // Organization is never walked again, so a Channel that projects from no
    // Space would stay homeless with `spacesReady` still saying the hierarchy
    // is renderable. A real Channel, taken back out of every Space, because
    // the walk that has to repair this reads the conversation's own audience
    // and the participants who may act on it.
    const homeless = await createChannel("left-unplaced");
    await forgetMembership(homeless);
    expect((await bootstrapRow()).phase).toBe("complete");

    await deliverDirectoryCommon({ workstreamId: homeless, title: "Arrived unplaced" });

    // The row is committed — the guard is a backstop, not a refusal, and
    // dropping the Organization's own projection of a Channel would be worse
    // than the state it is reacting to.
    expect((await directoryRow(homeless))?.title).toBe("Arrived unplaced");
    expect((await bootstrapRow()).phase).not.toBe("complete");
    expect(await spacesReadyOnSnapshot()).toBe(false);

    // And the walk the reopen armed is what actually repairs it.
    await runWholeCutover();
    expect(await membershipRows()).toContainEqual({ workstream_id: homeless, state: "active" });
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true, blockedWorkstreamIds: [] });
    expect(await spacesReadyOnSnapshot()).toBe(true);
  });

  it("leaves a finished cutover alone for a placed Channel and for a system Channel", async () => {
    const placed = await createChannel("already-placed");
    await forgetSpaces();
    await runWholeCutover();

    // The ordinary case, which is every directory row an Organization ever
    // commits: the Channel has an active membership, so the guard's question
    // answers no and the cutover stays closed. A guard that asked a looser
    // question than the close does would reopen every Organization on every
    // edit to any Channel.
    await deliverDirectoryCommon({ workstreamId: placed, title: "Renamed" });
    expect((await directoryRow(placed))?.title).toBe("Renamed");
    expect((await bootstrapRow()).phase).toBe("complete");

    // And a system Channel, which the hierarchy invariant is not about: the
    // subsystem that writes it decides both its audience and its home, and the
    // close's own predicate excludes it by `system_kind`. Delivered twice, so
    // what is under test here is that exclusion: a system Channel's *first*
    // row is an arrival, which the case below leaves alone whatever the
    // predicate says, and only its second projection reaches the predicate at
    // all.
    const digest = asWorkstreamId("00000000-0000-7000-8000-000000000de2");
    await deliverDirectoryCommon({ workstreamId: digest, title: "Daily digest", systemKind: "digest" });
    await deliverDirectoryCommon({ workstreamId: digest, title: "Daily digest v2", systemKind: "digest" });
    expect((await directoryRow(digest))?.title).toBe("Daily digest v2");
    expect((await bootstrapRow()).phase).toBe("complete");
    expect(await spacesReadyOnSnapshot()).toBe(true);
  });

  it("leaves a finished cutover alone for a Channel arriving in the directory", async () => {
    await createChannel("already-placed");
    await forgetSpaces();
    await runWholeCutover();

    // A Channel's *first* common row is a creation in flight, not a Channel
    // nobody is going to place. `reserveChild` enqueues that row before either
    // creation path has placed anything, and the Channel authority's own
    // recovery alarm delivers it straight to this handoff when it wins the
    // race with the coordinator's flush. On a connector path the reservation
    // comes before the placement and the conversation is provisioned in
    // between, so that alarm has the whole window: a guard that fired on an
    // arrival took `spacesReady` away from every member's sidebar on every run
    // of the ordinary Slack creation, which `space-creation.test.ts` pins from
    // the other side. The Channel's
    // next common projection is what asks the question, by which time its
    // creation has either placed it or failed.
    const arriving = asWorkstreamId("00000000-0000-7000-8000-000000000de3");
    await deliverDirectoryCommon({ workstreamId: arriving, title: "Arriving now" });

    expect((await directoryRow(arriving))?.title).toBe("Arriving now");
    expect((await bootstrapRow()).phase).toBe("complete");
    expect(await spacesReadyOnSnapshot()).toBe(true);
  });
});

describe("the local development seed", () => {
  it("places the Channels it restores in General, so the Organization opens ready", async () => {
    // A Channel the Organization can already see, taken back out of every
    // Space: the state a re-run of `pnpm db:open-authority` finds on a warm
    // container, and the state the seed used to *leave* an Organization in.
    // Built through the real creation path so the directory projection the
    // placement reads — the scope, and the participants who may act on it —
    // is the one an Organization actually holds.
    const workstreamId = await createChannel("restored-fixture");
    await forgetMembership(workstreamId);
    expect(await membershipRows()).toEqual([]);

    const response = await devRoutes.fetch(new Request("https://api.test/seed-product", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        workspaceTables: {},
        automations: [],
        workstreams: [{
          id: workstreamId,
          title: "Restored fixture",
          objective: "What the captured workspace was about",
          harnessStatus: "idle",
          nextSequenceNumber: 4,
          participants: [{ user_id: USER_ID, added_by_user_id: USER_ID, participation_reason: "creator" }],
          harnessRuns: [],
          toolInvocations: [],
          resourceIds: [],
          messages: [],
        }],
      }),
    }), developmentEnv());
    expect(response.status).toBe(200);

    // The point of the change: the seed leaves no Channel outside a Space.
    expect(await membershipRows()).toEqual([{ workstream_id: workstreamId, state: "active" }]);
    expect(await generalCount()).toBe(1);

    // And the Organization reaches the *real* ready state rather than one that
    // happens to be true because nothing was ever placed. The seed reopened
    // the cutover when it found the Channel homeless, so the walk is what
    // closes it, and it can only close once every Channel has a home.
    await runWholeCutover();
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ phase: "complete", ready: true, blockedWorkstreamIds: [] });
    expect(await channelScope(workstreamId)).toBe("workspace");
  });
});
