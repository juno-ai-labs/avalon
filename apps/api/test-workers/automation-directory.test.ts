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

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type AutomationScope } from "@rally/contracts";

import { automationDOName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import type { SidekickDO } from "../src/durable-objects/sidekick-do";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { deliverParentEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
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

function automationStub(automationId: string) {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, asAutomationId(automationId)),
  ));
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
 * the provisional directory row, viewer included, into the workspace.
 */
async function seedRoom(): Promise<void> {
  const room = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(workstreamDOName("global", WORKSPACE_ID, ROOM_ID)));
  await room.reserveChild({
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
}

/** `create`, then the one leg between the automation and the workspace. */
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
  const delivered = await deliverParentEffects(TEST_ENV, automationStub(automationId));
  expect(delivered.map((envelope) => envelope.effect.kind)).toEqual(["directory_automation"]);
  expect(delivered[0]?.effect).toMatchObject({
    kind: "directory_automation",
    automationId,
    authorUserId: AUTHOR_ID,
    lifecycle: "draft",
    scope,
    owningWorkstreamId: scope === "workstream" ? ROOM_ID : null,
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
      .toEqual({ owningWorkstreamId: ROOM_ID });
    // A member who is not in the room does not get the room's rail at all.
    // Asked inside the object: a rejection over the stub is reported a second
    // time as unhandled, which fails the run even when the assertion held.
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.listWorkstreamAutomations({
      workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID,
      userId: MEMBER_ID,
    }))).rejects.toMatchObject({ code: "automation_directory_access_denied", status: 403 });
  });

  it("authorizes library summaries across personal, workspace, and room scopes", async () => {
    const personal = await createAndPublish("personal");
    const shared = await createAndPublish("workspace");
    const owned = await createAndPublish("workstream");
    expect((await workspaceStub().listSidekickDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID })).items.map((item) => item.id).sort()).toEqual([personal, shared, owned].sort());
    expect((await workspaceStub().listSidekickDirectory({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID })).items.map((item) => item.id)).toEqual([shared]);
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
    const afterColour = await runInDurableObject(automationStub(automationId), (instance: SidekickDO) =>
      instance.setAppearance({
        workspaceId: WORKSPACE_ID, automationId, actor: author, appearance: { color: "purple" },
      }));
    // The unset field stays null rather than being filled in with the derived
    // value: what the id derives is a fallback, not a choice somebody made.
    expect(afterColour.appearance).toEqual({ icon: null, color: "purple" });
    const afterIcon = await runInDurableObject(automationStub(automationId), (instance: SidekickDO) =>
      instance.setAppearance({
        workspaceId: WORKSPACE_ID, automationId, actor: author, appearance: { icon: "rocket" },
      }));
    expect(afterIcon.appearance).toEqual({ icon: "rocket", color: "purple" });

    const delivered = await deliverParentEffects(TEST_ENV, automationStub(automationId));
    expect(delivered.at(-1)?.effect).toMatchObject({
      kind: "directory_automation",
      appearance: { icon: "rocket", color: "purple" },
    });
    const listed = await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID });
    expect(listed.items.map((item) => item.appearance)).toEqual([{ icon: "rocket", color: "purple" }]);
    const library = await workspaceStub().listSidekickDirectory({ workspaceId: WORKSPACE_ID, userId: MEMBER_ID });
    expect(library.items.map((item) => item.appearance)).toEqual([{ icon: "rocket", color: "purple" }]);
  });

  it("refuses a choice from somebody who cannot manage the Sidekick", async () => {
    const automationId = await createAndPublish("personal");
    await expect(runInDurableObject(automationStub(automationId), (instance: SidekickDO) => instance.setAppearance({
      workspaceId: WORKSPACE_ID,
      automationId,
      actor: { userId: MEMBER_ID, actorRole: "member", participantOfOwningWorkstream: false },
      appearance: { color: "purple" },
    }))).rejects.toMatchObject({ code: "automation_forbidden", status: 403 });
    const detail = await runInDurableObject(automationStub(automationId), (instance: SidekickDO) =>
      instance.readDetail({
        workspaceId: WORKSPACE_ID,
        automationId,
        actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
      }));
    expect(detail.appearance).toBeUndefined();
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
