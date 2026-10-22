/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Where an automation is listed, from the moment `create` makes it.
 *
 * A draft is a sidebar row from its first message: `create` alone puts the
 * automation's row into its parent outbox, and the second queue leg lands it
 * in WorkspaceDO's `automation_directory`. Scope decides who sees it there. A
 * personal automation is its author's; a workspace one is everyone's; a
 * room's automation is listed in that room's rail and in nobody's sidebar.
 *
 * The directory is driven through the real legs, parent outbox to consumer to
 * WorkspaceDO, rather than by writing the directory table: a projection that
 * stopped applying the effect would otherwise pass.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type AutomationDetail, type AutomationScope } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import { AutomationService, createAutomation } from "../src/services/automation-service";
import { searchAudienceGroup, searchAudienceGroupIds } from "../src/services/search-audience";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import type { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";
import { writeSidekickDirectoryRow } from "./helpers/sidekick";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad20");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad21");
const MEMBER_ID = asUserId("00000000-0000-7000-8000-00000000ad22");
const ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ad23");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad24";
const NOW = "2026-08-29T10:00:00.000Z";
const TEST_ENV: Env = env;

useHeldEffectQueue();

let automationOrdinal = 0;

function nextAutomationId() {
  automationOrdinal += 1;
  return asAutomationId(`00000000-0000-7000-8000-${String(automationOrdinal).padStart(4, "0")}00000ad2`);
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

/** A Sidekick's directory row, which is its definition row too: no copy is published. */
async function directoryRow(automationId: string) {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{
    automation_id: string; author_user_id: string; lifecycle: string; scope: string;
    owning_workstream_id: string | null; appearance_json: string | null; run_as_user_id: string | null;
  }>(
    `SELECT automation_id, author_user_id, lifecycle, scope, owning_workstream_id, appearance_json, run_as_user_id
       FROM automation_directory WHERE automation_id = ?`, automationId,
  ).one());
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, MEMBER_ID, NOW),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'member2@example.com', 'Member Two', NULL, 'UTC', ?)`).bind(MEMBER_ID, NOW),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
}

/**
 * A personal room with the author as its one participant, registered the way
 * creation registers it: the parent reserves the main conversation and puts
 * the provisional directory row, viewer included, into the workspace. The
 * parent is hosted by the workspace object itself.
 */
async function seedRoom(): Promise<void> {
  await hostedParentStub(env, WORKSPACE_ID).reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: ROOM_ID,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: AUTHOR_ID,
    authorityGeneration: 1,
    directory: {
      title: "Release room",
      description: "",
      scope: "personal",
      systemKind: null,
      emailAddress: null,
      titleStatus: "settled",
      createdAt: NOW,
    },
  });
  const membership = await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .bind(WORKSPACE_ID, AUTHOR_ID).first<{ incarnation: string }>();
  await withHostedParent(workspaceStub(), ROOM_ID, (parent) => {
    parent["scopeGrants"]({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID }).mutate({
      operationId: crypto.randomUUID(), actorUserId: AUTHOR_ID, userId: AUTHOR_ID,
      target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId: ROOM_ID },
      active: true, expectedRevision: 0,
    }, membership!.incarnation);
  });
}

/** `create`, which writes the Sidekick's directory row in the Organization object. */
async function createAndPublish(scope: AutomationScope): Promise<string> {
  const automationId = nextAutomationId();
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope,
    owningWorkstreamId: scope === "workstream" ? ROOM_ID : null,
    automationId,
  });
  expect(created.created).toBe(true);
  expect(await directoryRow(automationId)).toMatchObject({
    automation_id: automationId,
    author_user_id: AUTHOR_ID,
    lifecycle: "draft",
    scope,
    owning_workstream_id: scope === "workstream" ? ROOM_ID : null,
  });
  return automationId;
}

async function sidebar(userId: string): Promise<{ id: string; status: string; scope: string }[]> {
  const listed = await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId });
  return listed.items.map((item) => ({ id: item.id, status: item.status, scope: item.scope }));
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
});

describe("automation directory", () => {
  it("learns a historical participant before listing the Thread's Sidekick rail", async () => {
    const automationId = await createAndPublish("workstream");
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM workspace_member_status WHERE user_id = ?", AUTHOR_ID);
    });
    const listed = await workspaceStub().listWorkstreamAutomations({ workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, userId: AUTHOR_ID });
    expect(listed.items.map((item) => item.id)).toEqual([automationId]);
  });

  it("lists a personal draft in its author's sidebar and in nobody else's", async () => {
    const automationId = await createAndPublish("personal");

    expect(await sidebar(AUTHOR_ID)).toEqual([{ id: automationId, status: "draft", scope: "personal" }]);
    expect(await sidebar(MEMBER_ID)).toEqual([]);
  });

  it("lists a workspace draft in every member's sidebar", async () => {
    const automationId = await createAndPublish("workspace");

    expect(await sidebar(AUTHOR_ID)).toEqual([{ id: automationId, status: "draft", scope: "workspace" }]);
    expect(await sidebar(MEMBER_ID)).toEqual([{ id: automationId, status: "draft", scope: "workspace" }]);
  });

  it("lists a room's draft only in that room's rail, to that room's participants", async () => {
    const automationId = await createAndPublish("workstream");

    expect(await sidebar(AUTHOR_ID)).toEqual([]);
    expect(await sidebar(MEMBER_ID)).toEqual([]);
    const rail = await workspaceStub().listWorkstreamAutomations({
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      userId: AUTHOR_ID,
    });
    expect(rail.items.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: automationId, status: "draft" },
    ]);
    expect(await workspaceStub().automationOwner({ workspaceId: WORKSPACE_ID, automationId }))
      .toEqual({ owningWorkstreamId: ROOM_ID, owningSubstreamId: "0" });
    // A member who is not in the room does not get the room's rail at all.
    // Asked inside the object: a rejection over the stub is reported a second
    // time as unhandled, which fails the run even when the assertion held.
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.listWorkstreamAutomations({
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      userId: MEMBER_ID,
    }))).rejects.toMatchObject({ code: "sidekick_directory_access_denied", status: 403 });
  });

  it("authorizes library summaries across personal, workspace, and room scopes", async () => {
    const personal = await createAndPublish("personal");
    const shared = await createAndPublish("workspace");
    const owned = await createAndPublish("workstream");
    expect((await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID })).items.map((item) => item.id).sort()).toEqual([personal, shared, owned].sort());
    expect((await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID })).items.map((item) => item.id)).toEqual([shared]);
  });

  it("lists a Channel's Sidekick to the Channel's participants, not only its author, and not to anyone else", async () => {
    // Somebody else's Sidekick in the room, so the room's participant sees
    // it only through the Channel's own participant rows.
    const automationId = nextAutomationId();
    await writeSidekickDirectoryRow(env, {
      automationId, workspaceId: WORKSPACE_ID, authorUserId: "00000000-0000-7000-8000-00000000ad2f",
      lifecycle: "active", scope: "workstream", owningWorkstreamId: ROOM_ID, title: "Release notes", description: "",
    });

    expect((await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID }))
      .items.map((item) => item.id)).toEqual([automationId]);
    expect((await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID }))
      .items).toEqual([]);
  });

  it("names the owning Thread to a reader who is in it, and to nobody who has left it", async () => {
    // One Sidekick the author made and one somebody else made, so both the
    // reader's own row and a row read through the Thread are covered.
    const authored = await createAndPublish("workstream");
    const othersId = nextAutomationId();
    await writeSidekickDirectoryRow(env, {
      automationId: othersId, workspaceId: WORKSPACE_ID, authorUserId: "00000000-0000-7000-8000-00000000ad2f",
      lifecycle: "active", scope: "workstream", owningWorkstreamId: ROOM_ID, title: "Release notes", description: "",
    });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE channels SET appearance_json = ? WHERE workstream_id = ?`,
        JSON.stringify({ icon: "rocket", color: "purple" }), ROOM_ID);
    });
    const thread = { id: ROOM_ID, title: "Release room", appearance: { icon: "rocket", color: "purple" } };
    const author = { userId: AUTHOR_ID, actorRole: "member" as const, participantOfOwningWorkstream: true };

    const library = await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(Object.fromEntries(library.items.map((item) => [item.id, item.owningThread])))
      .toEqual({ [authored]: thread, [othersId]: thread });
    const detail: AutomationDetail = await workspaceStub().sidekickReadDetail({
      workspaceId: WORKSPACE_ID, automationId: authored, actor: author,
    });
    expect(detail.owningThread).toEqual(thread);

    // The author leaves the Thread. They still read the Sidekick they made,
    // and it no longer names the room.
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_grants SET grant_json = json_set(grant_json, '$.active', json('false')) WHERE parent_id = ? AND user_id = ?", ROOM_ID, AUTHOR_ID);
    });
    const after = await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(after.items.map((item) => ({ id: item.id, owningThread: item.owningThread })))
      .toEqual([{ id: authored, owningThread: null }]);
    const detailAfter: AutomationDetail = await workspaceStub().sidekickReadDetail({
      workspaceId: WORKSPACE_ID, automationId: authored, actor: { ...author, participantOfOwningWorkstream: false },
    });
    expect(detailAfter.owningThread).toBeNull();
  });

  it("reads the Sidekicks asked for and the ones a Channel recommends in one call, asked-for first and each once", async () => {
    // Created in this order, so their ids sort A < B < C < D: an order by id
    // is not the order asked for.
    const [a, b, c, d] = [nextAutomationId(), nextAutomationId(), nextAutomationId(), nextAutomationId()];
    for (const [automationId, title] of [[a, "A"], [b, "B"], [c, "C"], [d, "D"]] as const) {
      await writeSidekickDirectoryRow(env, {
        automationId, workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID,
        lifecycle: "active", scope: "workspace", owningWorkstreamId: null, title, description: "",
      });
    }
    // The Channel recommends B first, then A, which is also asked for and
    // keeps its asked-for place. B's place among the recommendations ties
    // with C's among the asked-for, so only the tiers order them.
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      // Hosted rows, as a Sidekick's own writes leave them.
      state.storage.sql.exec(`UPDATE automation_directory SET region = 'global'`);
      for (const [sidekickId, attachedAt] of [[b, 1], [a, 2]] as const) {
        state.storage.sql.exec(
          `INSERT INTO parent_sidekicks(parent_id, sidekick_id, attached_at) VALUES (?, ?, ?)`, ROOM_ID, sidekickId, attachedAt,
        );
      }
    });

    const summaries = await workspaceStub().sidekickReadSkillSummaries({
      workspaceId: WORKSPACE_ID, automationIds: [d, c, a], channelId: ROOM_ID,
      principalUserId: AUTHOR_ID, conversationParentId: ROOM_ID, audienceScope: "workspace", audienceUserIds: [AUTHOR_ID],
    });

    expect(summaries.map((summary) => summary.name)).toEqual(["D", "C", "A", "B"]);
  });

  it("learns a cold library reader once and reuses their membership on subsequent reads", async () => {
    const personal = await createAndPublish("personal");
    const shared = await createAndPublish("workspace");
    const owned = await createAndPublish("workstream");
    // Every statement the Organization object sends to D1 from here on. The
    // request's own authentication already joined the member row; a second
    // read of it inside the object is the round trip this listing must not pay.
    const objectReads: string[] = [];
    await runInDurableObject(workspaceStub(), (instance) => {
      const target = instance as unknown as { env: Env };
      const database = target.env.DB;
      target.env = new Proxy(target.env, {
        get: (current, property, receiver) => property === "DB"
          ? new Proxy(database, {
            get: (db, member) => member === "prepare"
              ? (sql: string) => { objectReads.push(sql); return db.prepare(sql); }
              : Reflect.get(db, member, db),
          })
          : Reflect.get(current, property, receiver),
      });
    });
    const library = (userId: typeof AUTHOR_ID) => new AutomationService(TEST_ENV, {
      sessionId: SESSION_ID, userId, workspaceId: WORKSPACE_ID, region: "global", role: "member", accessClass: "member",
    }).listSidekicks();

    // Who sees what is unchanged: the author sees all three, a member only the workspace one.
    expect((await library(AUTHOR_ID)).items.map((item) => item.id).sort()).toEqual([personal, shared, owned].sort());
    expect((await library(MEMBER_ID)).items.map((item) => item.id)).toEqual([shared]);
    expect(objectReads.filter((sql) => sql.includes("workspace_members"))).toHaveLength(1);
    objectReads.length = 0;
    await library(MEMBER_ID);
    expect(objectReads.filter((sql) => sql.includes("workspace_members"))).toEqual([]);
  });

  it("keeps the three scopes apart in one workspace", async () => {
    const personal = await createAndPublish("personal");
    const shared = await createAndPublish("workspace");
    const owned = await createAndPublish("workstream");

    expect((await sidebar(AUTHOR_ID)).map((item) => item.id).sort()).toEqual([personal, shared].sort());
    expect((await sidebar(MEMBER_ID)).map((item) => item.id)).toEqual([shared]);
    const rail = await workspaceStub().listWorkstreamAutomations({
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      userId: AUTHOR_ID,
    });
    expect(rail.items.map((item) => item.id)).toEqual([owned]);
  });

  it("carries a chosen icon and colour into every list, one field at a time", async () => {
    const automationId = await createAndPublish("workspace");
    const author = { userId: AUTHOR_ID, actorRole: "member" as const, participantOfOwningWorkstream: false };

    // Inside the object, the way every other detail read in these suites is:
    // `AutomationDetail` does not survive the stub's serializable mapping.
    // Through the stub, which is the boundary `AutomationService` crosses in
    // production, per `docs/durable-object-sqlite.md`. The annotation is what
    // makes that possible here: the RPC return mapping collapses
    // `AutomationDetail` to `never`, and `never` is assignable to it, so the
    // type is restored at the call site rather than the call being moved
    // inside the object to dodge it.
    const afterColour: AutomationDetail = await workspaceStub().sidekickSetAppearance({
      workspaceId: WORKSPACE_ID, automationId, actor: author, appearance: { color: "purple" },
    });
    // The unset field stays null rather than being filled in with the derived
    // value: what the id derives is a fallback, not a choice somebody made.
    expect(afterColour.appearance).toEqual({ icon: null, color: "purple" });
    const afterIcon: AutomationDetail = await workspaceStub().sidekickSetAppearance({
      workspaceId: WORKSPACE_ID, automationId, actor: author, appearance: { icon: "rocket" },
    });
    expect(afterIcon.appearance).toEqual({ icon: "rocket", color: "purple" });

    expect(JSON.parse((await directoryRow(automationId)).appearance_json ?? "null")).toEqual({ icon: "rocket", color: "purple" });
    const listed = await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID });
    expect(listed.items.map((item) => item.appearance)).toEqual([{ icon: "rocket", color: "purple" }]);
    const library = await workspaceStub().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID });
    expect(library.items.map((item) => item.appearance)).toEqual([{ icon: "rocket", color: "purple" }]);
  });

  it("refuses a choice from somebody who cannot manage the Sidekick", async () => {
    const automationId = await createAndPublish("personal");
    // Asked inside the object, for the reason the room-rail refusal above gives:
    // a rejection over the stub is reported a second time as unhandled and
    // fails the run even when the assertion held. The two success paths in the
    // test above go through the stub, so the RPC boundary is covered.
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickSetAppearance({
      workspaceId: WORKSPACE_ID,
      automationId,
      actor: { userId: MEMBER_ID, actorRole: "member", participantOfOwningWorkstream: false },
      appearance: { color: "purple" },
    }))).rejects.toMatchObject({ code: "sidekick_forbidden", status: 403 });
    const detail: AutomationDetail = await workspaceStub().sidekickReadDetail({
      workspaceId: WORKSPACE_ID,
      automationId,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(detail.appearance).toBeUndefined();
  });

  it("republishes who a Sidekick runs as when somebody takes it over, so search follows the handoff", async () => {
    const automationId = await createAndPublish("workstream");
    const [group] = await searchAudienceGroupIds([searchAudienceGroup.sidekick(automationId)]);
    const audience = (userId: string) => workspaceStub().readSearchAudience({ workspaceId: WORKSPACE_ID, userId });
    // The member is not in the owning room, so only running the Sidekick lets them search it.
    expect(await audience(MEMBER_ID)).not.toContain(group);
    // Taking it over is for whoever may manage the room; a grant on the room
    // makes the member one, the way sharing a Channel does.
    await withHostedParent(workspaceStub(), ROOM_ID, (parent) => {
      const grants = (parent as unknown as { scopeGrants(address: { workspaceId: string; parentId: string }): ScopeGrantStorage })
        .scopeGrants({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID });
      expect(grants.mutate({ operationId: crypto.randomUUID(), actorUserId: AUTHOR_ID, userId: MEMBER_ID,
        target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId: ROOM_ID }, active: true, expectedRevision: 0 },
      "existing-member")).toMatchObject({ status: "committed" });
    });
    // The canonical grant already makes them a participant and therefore a reader.
    expect(await audience(MEMBER_ID)).toContain(group);
    const claim = await workspaceStub().sidekickClaimExecutionPrincipal({
      workspaceId: WORKSPACE_ID,
      automationId,
      actor: { userId: MEMBER_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(claim.changed).toBe(true);
    expect((await directoryRow(automationId)).run_as_user_id).toBe(MEMBER_ID);
    expect(await audience(MEMBER_ID)).toContain(group);
  });

  it("names every automation for a member's revocation, and a room's own for a lost room", async () => {
    const personal = await createAndPublish("personal");
    const shared = await createAndPublish("workspace");
    const owned = await createAndPublish("workstream");

    // The member authored none of these, and can read the shared one and, as
    // a room participant, the owned one; the walk used to reach only what a
    // person authored, so their sockets on the other two outlived them.
    const revoked = await workspaceStub().revokeSocketAccess({
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE_ID,
      userId: MEMBER_ID,
      sessionId: null,
    });
    expect([...revoked.automationIds].sort()).toEqual([personal, shared, owned].sort());

    expect(await workspaceStub().automationIdsOwnedByWorkstream({ workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID }))
      .toEqual({ automationIds: [owned] });
  });
});
