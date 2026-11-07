/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Canvas's directory row and who may open it, on the real Organization
 * object: a new Canvas opens to its creator alone; a participant, a member of
 * an Organization-wide Canvas, a guest invited by email, and an owner or
 * administrator can open it; a member who is none of those, and a guest
 * outside its list, cannot; and only its creator and the Organization's
 * administrators change who can.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { claimScopeInvitations } from "../src/services/scope-invitation-claims";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ca000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000ca001");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000ca002");
const OTHER = asUserId("00000000-0000-7000-8000-0000000ca003");
const ADMIN = asUserId("00000000-0000-7000-8000-0000000ca004");
/** Already signs in with guest@example.test, so a share to that address is theirs as it is made. */
const GUEST = asUserId("00000000-0000-7000-8000-0000000ca005");
/** A guest of the Organization through some other share, never invited here. */
const OUTSIDER = asUserId("00000000-0000-7000-8000-0000000ca006");
/** Someone with no account yet: a share to them waits for their first sign-in. */
const NEWCOMER = asUserId("00000000-0000-7000-8000-0000000ca007");
let CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000000ca100");

const member = (userId: string) => ({ userId: asUserId(userId), actorRole: "member" as const });
const guest = (userId: string) => ({ userId: asUserId(userId), actorRole: null });

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

async function opens(actor: { userId: string; actorRole: "member" | "admin" | null }): Promise<boolean> {
  // In the object rather than over RPC, so a refusal is the thrown error and not an unhandled remote rejection.
  return runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
    try {
      await instance.canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: { ...actor, userId: asUserId(actor.userId) } });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "canvas_not_found") return false;
      throw error;
    }
  });
}

beforeEach(async () => {
  await reset();
  // Fresh ids per case: an earlier case's delivery alarm must not land in the next case's object.
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  CANVAS_ID = asWorkstreamId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Canvas workspace')").bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES
      (?1,?2,'member','member','active'), (?1,?3,'member','member','active'), (?1,?4,'member','member','active'),
      (?1,?5,'member','admin','active'), (?1,?6,'guest',NULL,'active')`)
      .bind(WORKSPACE_ID, CREATOR, MEMBER, OTHER, ADMIN, OUTSIDER),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Casey Creator'), (?, NULL)").bind(CREATOR, GUEST),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare("INSERT INTO user_verified_emails VALUES ('guest@example.test', ?)").bind(GUEST),
  ]);
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Launch plan", createdByUserId: CREATOR, authorityGeneration: 1,
  });
});

describe("who can open a Canvas", () => {
  it("opens a new Canvas to its creator alone, with no artifacts", async () => {
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) });
    expect(detail).toMatchObject({ id: CANVAS_ID, title: "Launch plan", visibility: "creator", participantUserIds: [],
      artifacts: [], canManage: true, lastEditor: null, writerSidekickId: null });
    expect(await opens(member(MEMBER))).toBe(false);
  });

  it("opens to a participant and to nobody else in the Organization", async () => {
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [MEMBER] } });
    expect(await opens(member(MEMBER))).toBe(true);
    expect(await opens(member(OTHER))).toBe(false);
    // A participant reads and takes part; it does not change the audience.
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(MEMBER) });
    expect(detail.canManage).toBe(false);
    await expect(runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.canvasSetAudience({
      workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(MEMBER), update: { visibility: "workspace", userIds: [] },
    }))).rejects.toMatchObject({ code: "canvas_forbidden" });
  });

  it("opens an Organization-wide Canvas to every member and to no guest outside its list", async () => {
    // An administrator manages, and so opens, a private Canvas they did not make.
    expect(await opens({ userId: ADMIN, actorRole: "admin" })).toBe(true);
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
      actor: { userId: ADMIN, actorRole: "admin" }, update: { visibility: "workspace", userIds: [] } });
    expect(await opens(member(OTHER))).toBe(true);
    expect(await opens(guest(OUTSIDER))).toBe(false);
  });

  it("opens to a guest invited by email, and to no guest it was not shared with", async () => {
    const result = await workspace().createScopeInvitations({
      operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: CREATOR,
      emails: ["guest@example.test"], targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }],
      expiresAt: null,
    });
    expect(result).toMatchObject({ status: "created", invitations: [{ status: "accepted", acceptedByUserId: GUEST }] });
    expect(await opens(guest(GUEST))).toBe(true);
    expect(await opens(guest(OUTSIDER))).toBe(false);
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) });
    expect(detail).toMatchObject({ visibility: "participants", participantUserIds: [GUEST] });
  });

  it("waits for a recipient without an account, and opens to them once they sign in", async () => {
    const result = await workspace().createScopeInvitations({
      operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: CREATOR,
      emails: ["newcomer@example.test"], targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }],
      expiresAt: null,
    });
    expect(result).toMatchObject({ status: "created", invitations: [{ status: "pending", acceptedByUserId: null }] });
    // They verify their mailbox and sign in: signing in claims what waits for it.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, name) VALUES (?, NULL)").bind(NEWCOMER),
      env.DB.prepare("INSERT INTO user_verified_emails VALUES ('newcomer@example.test', ?)").bind(NEWCOMER),
    ]);
    expect(await opens(guest(NEWCOMER))).toBe(false);
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(guest(NEWCOMER))).toBe(true);
  });

  it("refuses an invitation from someone who does not manage the Canvas", async () => {
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [MEMBER] } });
    const result = await workspace().createScopeInvitations({
      operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: MEMBER,
      emails: ["guest@example.test"], targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }],
      expiresAt: null,
    });
    expect(result).toEqual({ status: "denied", reason: "sharing_required" });
    expect(await opens(guest(GUEST))).toBe(false);
  });
});
