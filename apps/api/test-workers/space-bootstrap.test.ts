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
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import {
  SpaceBootstrapService,
  placeConnectorChannelInGeneral,
  spaceBootstrapDriver,
} from "../src/services/space-bootstrap-service";
import { SpaceService } from "../src/services/space-service";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
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
      "workspace_space_directory",
      "workspace_space_viewers",
      "workspace_space_order",
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
      "UPDATE workspace_workstream_directory SET archived_at = ? WHERE workstream_id = ?",
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
    sql: "SELECT COUNT(*) AS count FROM workspace_space_directory WHERE system_role = 'general'",
    bindings: [],
  });
  return (result.rows[0] as { count: number }).count;
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
});
