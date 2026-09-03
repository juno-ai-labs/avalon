/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  WorkspaceProjectSnapshotEventSchema,
  type WorkspaceProjectSnapshotEvent,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ParentEffect,
  type WorkstreamId,
} from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

// 09f0, not 09a0: external-event-routing.test.ts owns 09a0, and a shared
// object name is a shared input gate across files (test:scripts enforces
// the split).
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009f0");
const OWNER = asUserId("00000000-0000-7000-8000-0000000009a1");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000009a2");
const INACTIVE = asUserId("00000000-0000-7000-8000-0000000009a3");

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'owner')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'removed', 'member')`)
      .bind(WORKSPACE_ID, INACTIVE),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`project-session-${OWNER}`, OWNER, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`project-session-${MEMBER}`, MEMBER, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM workspace_workstream_directory");
    state.storage.sql.exec("DELETE FROM project_workstream_memberships");
    state.storage.sql.exec("DELETE FROM workspace_project_order");
    state.storage.sql.exec("DELETE FROM project_participants");
    state.storage.sql.exec("DELETE FROM projects");
  });
}

async function seedMembership(projectId: string, workstreamId: string): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO project_workstream_memberships
         (project_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
       VALUES (?, ?, 'active', 1, 1, 1, NULL)`,
      projectId,
      workstreamId,
    );
  });
}

let directorySeq = 0;

/**
 * Publish one work stream into the workspace directory, the way its own object
 * would — the projection a project reads to tell a member it can show from one
 * it cannot.
 */
function directoryEnvelope(
  workstreamId: WorkstreamId,
  archivedAt: string | null,
  sourceVersion: number,
) {
  directorySeq += 1;
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "Member work stream",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    archivedAt,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    resourceLinks: [],
  };
  return {
    kind: "parent_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream" as const,
    parentId: workstreamId,
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(directorySeq).padStart(9, "0")}9e0`,
    partitionKey: "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

async function publishDirectory(
  workstreamId: WorkstreamId,
  archivedAt: string | null,
  sourceVersion: number,
): Promise<void> {
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [directoryEnvelope(workstreamId, archivedAt, sourceVersion)],
  });
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}

/**
 * The next project snapshot, skipping whatever else the socket is carrying.
 *
 * A work stream's archival publishes its own directory state on this socket
 * too, and arrives first; taking the next message flatly would assert against
 * that one instead.
 */
function nextProjectSnapshot(socket: WebSocket): Promise<WorkspaceProjectSnapshotEvent> {
  return new Promise((resolve) => {
    const listen = (event: MessageEvent): void => {
      const decoded = WorkspaceProjectSnapshotEventSchema.safeParse(JSON.parse(String(event.data)));
      if (!decoded.success) return;
      socket.removeEventListener("message", listen);
      resolve(decoded.data);
    };
    socket.addEventListener("message", listen);
  });
}

async function connectProjectViewer(userId: string, suffix: string): Promise<WebSocket> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `project-session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  response.webSocket.accept();
  const initial = nextMessage(response.webSocket);
  response.webSocket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await initial;
  return response.webSocket;
}

beforeEach(async () => {
  await establishWorkspace();
}, 30_000);

async function create(name: string, scope: "personal" | "workspace" = "personal") {
  return workspace().createProject({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    project: { name, iconKey: "briefcase", colorKey: "blue", scope },
  });
}

describe("WorkspaceDO project authority", () => {
  it("given a personal project, when members list projects, then only active participants receive it", async () => {
    await expect(create("Hiring")).resolves.toMatchObject({ ok: true });

    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Hiring" }] } });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [] } });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: INACTIVE }))
      .resolves.toEqual({ ok: false, code: "project_access_denied" });
  });

  it("given a workspace project, when an active workspace member lists projects, then they receive it", async () => {
    await expect(create("Close", "workspace")).resolves.toMatchObject({ ok: true });

    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Close" }] } });
  });

  it("given two subscribed members, when one changes project visibility, then both receive their own canonical snapshot", async () => {
    const ownerSocket = await connectProjectViewer(OWNER, "921");
    const memberSocket = await connectProjectViewer(MEMBER, "922");
    try {
      const ownerCreated = nextMessage(ownerSocket);
      const memberCreated = nextMessage(memberSocket);
      const created = await create("Shared hiring", "workspace");
      if (!created.ok) throw new Error("project_fixture_failed");
      expect(WorkspaceProjectSnapshotEventSchema.parse(
        JSON.parse(String((await ownerCreated).data)),
      ).projects.active.items).toEqual([expect.objectContaining({ name: "Shared hiring" })]);
      expect(WorkspaceProjectSnapshotEventSchema.parse(
        JSON.parse(String((await memberCreated).data)),
      ).projects.active.items).toEqual([expect.objectContaining({ name: "Shared hiring" })]);

      const ownerChanged = nextMessage(ownerSocket);
      const memberChanged = nextMessage(memberSocket);
      await expect(workspace().updateProjectAudience({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        projectId: created.project.id,
        audience: { scope: "personal", participantUserIds: [OWNER] },
      })).resolves.toMatchObject({ ok: true });
      expect(WorkspaceProjectSnapshotEventSchema.parse(
        JSON.parse(String((await ownerChanged).data)),
      ).projects.active.items).toEqual([expect.objectContaining({ scope: "personal" })]);
      expect(WorkspaceProjectSnapshotEventSchema.parse(
        JSON.parse(String((await memberChanged).data)),
      ).projects.active.items).toEqual([]);
    } finally {
      ownerSocket.close(1000, "test complete");
      memberSocket.close(1000, "test complete");
    }
  });

  it("given personal projects with separate readers, when their names match, then both can exist without a visibility probe", async () => {
    const first = await create("Hiring");
    expect(first).toMatchObject({ ok: true });
    await expect(workspace().createProject({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      project: { name: "Hiring", iconKey: "briefcase", colorKey: "blue", scope: "personal" },
    })).resolves.toMatchObject({ ok: true });

    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Hiring" }] } });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Hiring" }] } });
  });

  it("given shared projects, when one viewer reorders, then another viewer keeps their server order", async () => {
    const first = await create("First", "workspace");
    const second = await create("Second", "workspace");
    const third = await create("Third", "workspace");
    if (!first.ok || !second.ok || !third.ok) throw new Error("project_fixture_failed");
    await workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: MEMBER });

    await expect(workspace().reorderProjects({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      order: { projectIds: [third.project.id, first.project.id, second.project.id] },
    })).resolves.toMatchObject({
      ok: true,
      directory: { items: [{ name: "Third" }, { name: "First" }, { name: "Second" }] },
    });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({
        ok: true,
        directory: { items: [{ name: "First" }, { name: "Second" }, { name: "Third" }] },
      });
  });

  it("given a project, when presentation changes, then only its presentation revision advances", async () => {
    const created = await create("Hiring");
    if (!created.ok) throw new Error("project_fixture_failed");

    await expect(workspace().updateProjectPresentation({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
      presentation: { name: "Hiring 2027", iconKey: "target", colorKey: "green" },
    })).resolves.toMatchObject({
      ok: true,
      project: {
        name: "Hiring 2027",
        presentationRevision: 2,
        audienceGeneration: 1,
        lifecycleGeneration: 1,
      },
    });
  });

  it("given an active project, when its audience changes, then scope and participants advance together", async () => {
    const created = await create("Audience");
    if (!created.ok) throw new Error("project_fixture_failed");

    await expect(workspace().updateProjectAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
      audience: { scope: "workspace", participantUserIds: [OWNER, MEMBER] },
    })).resolves.toMatchObject({
      ok: true,
      project: {
        scope: "workspace",
        audienceGeneration: 2,
        participants: [
          { userId: OWNER, state: "active" },
          { userId: MEMBER, state: "active" },
        ],
      },
    });
  });

  it("given an incompatible move, when destination preparation starts, then source detaches before audience work", async () => {
    const source = await create("Private source");
    const target = await create("Workspace target", "workspace");
    if (!source.ok || !target.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b1");
    await seedMembership(source.project.id, workstreamId);

    const plan = await workspace().prepareProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: target.project.id,
      workstreamId,
    });
    expect(plan).toMatchObject({ ok: true, sourceProjectId: source.project.id, sourceDetached: true });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM project_workstream_memberships WHERE project_id = ? AND workstream_id = ?",
        source.project.id,
        workstreamId,
      ).one().state).toBe("removed");
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM project_workstream_memberships WHERE project_id = ? AND workstream_id = ?",
        target.project.id,
        workstreamId,
      ).one().state).toBe("joining");
    });
    if (!plan.ok) throw new Error("membership_fixture_failed");
    await workspace().cancelProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: target.project.id,
      workstreamId,
      membershipGeneration: plan.membershipGeneration,
      sourceProjectId: plan.sourceProjectId,
      sourceDetached: plan.sourceDetached,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      const states = state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM project_workstream_memberships WHERE workstream_id = ? ORDER BY project_id",
        workstreamId,
      ).toArray().map((row) => row.state);
      expect(states).toEqual(["removed", "removed"]);
    });
  });

  it("given a compatible move, when destination finalizes, then source stays active until the atomic swap", async () => {
    const source = await create("Workspace source", "workspace");
    const target = await create("Private target");
    if (!source.ok || !target.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b2");
    await seedMembership(source.project.id, workstreamId);

    const plan = await workspace().prepareProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: target.project.id,
      workstreamId,
    });
    expect(plan).toMatchObject({ ok: true, sourceProjectId: source.project.id, sourceDetached: false });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM project_workstream_memberships WHERE project_id = ? AND workstream_id = ?",
        source.project.id,
        workstreamId,
      ).one().state).toBe("active");
    });
    if (!plan.ok) throw new Error("membership_fixture_failed");
    await workspace().finalizeProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: target.project.id,
      workstreamId,
      membershipGeneration: plan.membershipGeneration,
      sourceProjectId: plan.sourceProjectId,
      sourceDetached: plan.sourceDetached,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      const rows = state.storage.sql.exec<{ project_id: string; state: string }>(
        "SELECT project_id, state FROM project_workstream_memberships WHERE workstream_id = ?",
        workstreamId,
      ).toArray();
      expect(rows.find((row) => row.project_id === source.project.id)?.state).toBe("removed");
      expect(rows.find((row) => row.project_id === target.project.id)?.state).toBe("active");
    });
  });

  it("given an active workspace project membership, when audience constraints are read, then direct narrowing is fenced", async () => {
    const created = await create("Public project", "workspace");
    if (!created.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b8");
    await seedMembership(created.project.id, workstreamId);

    await expect(workspace().projectWorkstreamConstraints({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      workstreamId,
    })).resolves.toEqual({ activeProject: true, requiresWorkspaceScope: true });
  });

  it("given an existing member work stream, when a default is added, then one fenced Queue target is created", async () => {
    const created = await create("Default propagation");
    if (!created.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b3");
    const resourceId = "00000000-0000-7000-8000-0000000009b4";
    await seedMembership(created.project.id, workstreamId);

    const added = await workspace().addProjectDefaultResource({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
      resourceId,
    });
    expect(added).toMatchObject({
      ok: true,
      project: { defaultResourceIds: [resourceId] },
      targets: [{ workstreamId, defaultGeneration: 1, membershipGeneration: 1 }],
    });
    if (!added.ok) throw new Error("default_fixture_failed");
    const message = {
      type: "project_default_resource" as const,
      region: "global" as const,
      workspaceId: WORKSPACE_ID,
      requestedByUserId: OWNER,
      ...added.targets[0]!,
    };
    await expect(workspace().projectDefaultTargetCurrent(message)).resolves.toBe(true);
    await runInDurableObject(workspace(), (_instance, state) => {
      const publication = state.storage.sql.exec<{ state: string; requested_by_user_id: string }>(
        `SELECT state, requested_by_user_id FROM project_default_resource_publications
          WHERE project_id = ? AND resource_id = ?`,
        created.project.id,
        resourceId,
      ).one();
      expect(publication.requested_by_user_id).toBe(OWNER);
      // The real alarm may run before this inspection. Either state proves the
      // durable row exists; the publisher unit test owns reject-and-retry.
      expect(["pending", "accepted"]).toContain(publication.state);
    });

    await expect(workspace().recordProjectDefaultTargetFailure(message)).resolves.toBe(true);
    await expect(workspace().failProjectDefaultTarget(message)).resolves.toBe(true);
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string; attempts: number; last_error_code: string }>(
        `SELECT state, attempts, last_error_code FROM project_default_resource_targets
          WHERE project_id = ? AND resource_id = ?`,
        created.project.id,
        resourceId,
      ).one()).toEqual({
        state: "terminal",
        attempts: 2,
        last_error_code: "project_no_active_participant",
      });
    });

    await workspace().removeProjectDefaultResource({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
      resourceId,
    });
    await expect(workspace().projectDefaultTargetCurrent(message)).resolves.toBe(false);
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM project_workstream_memberships WHERE project_id = ? AND workstream_id = ?",
        created.project.id,
        workstreamId,
      ).one().state).toBe("active");
    });
  });

  it("given a project member, when its work stream is archived, then the project counts it apart from the members it can show", async () => {
    const created = await create("Startup stuff");
    if (!created.ok) throw new Error("project_fixture_failed");
    const listed = asWorkstreamId("00000000-0000-7000-8000-0000000009c1");
    const archived = asWorkstreamId("00000000-0000-7000-8000-0000000009c2");
    await seedMembership(created.project.id, listed);
    await seedMembership(created.project.id, archived);
    await publishDirectory(listed, null, 1);
    await publishDirectory(archived, null, 1);

    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({
        ok: true,
        directory: { items: [{ workstreamIds: [listed, archived] }] },
      });

    await publishDirectory(archived, "2026-09-01T00:00:00.000Z", 2);

    // No surface can list an archived work stream, so the count every surface
    // reads no longer includes it.
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ workstreamIds: [listed] }] } });
    // The membership itself is untouched — it is what returns the work stream
    // to this project if it is unarchived, and what an audience change still
    // has to reach.
    await expect(workspace().listProjectMembers({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
    })).resolves.toEqual({ ok: true, workstreamIds: [listed, archived] });
  });

  it("given a member whose first directory projection has not landed, when the project is listed, then it still counts", async () => {
    const created = await create("Startup stuff");
    if (!created.ok) throw new Error("project_fixture_failed");
    const unprojected = asWorkstreamId("00000000-0000-7000-8000-0000000009c6");
    await seedMembership(created.project.id, unprojected);

    // A work stream started inside a project is a member before its own object
    // publishes it into the directory. The listable-member read joins against
    // that directory, and an inner join would drop the work stream out of its
    // own project for the seconds in between.
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({
        ok: true,
        directory: { items: [{ workstreamIds: [unprojected] }] },
      });
  });

  it("given a subscribed viewer, when a member work stream is archived, then a newer project snapshot arrives without a project write", async () => {
    const created = await create("Startup stuff", "workspace");
    if (!created.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009c3");
    await seedMembership(created.project.id, workstreamId);
    await publishDirectory(workstreamId, null, 1);
    const before = await workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER });
    if (!before.ok) throw new Error("project_fixture_failed");

    const socket = await connectProjectViewer(OWNER, "923");
    try {
      const snapshot = nextProjectSnapshot(socket);
      await publishDirectory(workstreamId, "2026-09-01T00:00:00.000Z", 2);
      const projects = (await snapshot).projects;
      expect(projects.active.items).toEqual([expect.objectContaining({ workstreamIds: [] })]);
      // Newer than the directory its reader already holds. A snapshot at the
      // same waterline is a replay to every client that receives it, so one
      // published without advancing it corrects nothing on screen.
      expect(projects.active.waterline).toBeGreaterThan(before.directory.waterline);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("given an archival whose delivery is retried, when the same envelope replays, then the corrected snapshot is published again", async () => {
    const created = await create("Startup stuff", "workspace");
    if (!created.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009c5");
    await seedMembership(created.project.id, workstreamId);
    await publishDirectory(workstreamId, null, 1);
    const archival = directoryEnvelope(workstreamId, "2026-09-01T00:00:00.000Z", 2);
    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [archival],
    });

    const socket = await connectProjectViewer(OWNER, "925");
    try {
      const snapshot = nextProjectSnapshot(socket);
      // The row and its receipt commit before the publications this method
      // awaits, so a rejection in any of those redelivers an envelope whose
      // archival is already recorded and has nothing left to compare against.
      // Acknowledging that replay without republishing would leave every open
      // window on the count this change exists to correct.
      await workspace().applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [archival],
      });
      expect((await snapshot).projects.active.items)
        .toEqual([expect.objectContaining({ workstreamIds: [] })]);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("given a work stream in no project, when it is archived, then no project snapshot is published", async () => {
    const created = await create("Startup stuff", "workspace");
    if (!created.ok) throw new Error("project_fixture_failed");
    const stranger = asWorkstreamId("00000000-0000-7000-8000-0000000009c4");
    await publishDirectory(stranger, null, 1);

    const socket = await connectProjectViewer(OWNER, "924");
    try {
      let published = false;
      socket.addEventListener("message", (event: MessageEvent) => {
        if (WorkspaceProjectSnapshotEventSchema.safeParse(JSON.parse(String(event.data))).success) {
          published = true;
        }
      });
      await publishDirectory(stranger, "2026-09-01T00:00:00.000Z", 2);
      // The archive of a work stream no project holds changes no project, and
      // ordinary activity publishes this same effect: republishing both
      // project lists to every socket for each of those would cost the sidebar
      // far more than the count is worth.
      await workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER });
      expect(published).toBe(false);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("given an active project, when it is archived, then navigation and pending defaults stop but history remains", async () => {
    const created = await create("Finished project");
    if (!created.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b5");
    const resourceId = "00000000-0000-7000-8000-0000000009b6";
    await seedMembership(created.project.id, workstreamId);
    const added = await workspace().addProjectDefaultResource({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
      resourceId,
    });
    if (!added.ok) throw new Error("default_fixture_failed");

    await expect(workspace().archiveProject({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
    })).resolves.toMatchObject({ ok: true, project: { status: "archived", workstreamIds: [workstreamId] } });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [] } });
    await expect(workspace().listInactiveProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Finished project", status: "archived" }] } });
    const target = { type: "project_default_resource" as const, region: "global" as const,
      workspaceId: WORKSPACE_ID, requestedByUserId: OWNER, ...added.targets[0]! };
    await expect(workspace().projectDefaultTargetCurrent(target)).resolves.toBe(false);
  });

  it("given an archived membership and a new active assignment, when restore is attempted, then it stays archived", async () => {
    const archived = await create("Archived source");
    const active = await create("Current project");
    if (!archived.ok || !active.ok) throw new Error("project_fixture_failed");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000009b7");
    await seedMembership(archived.project.id, workstreamId);
    await workspace().archiveProject({ workspaceId: WORKSPACE_ID, userId: OWNER, projectId: archived.project.id });
    const plan = await workspace().prepareProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: active.project.id,
      workstreamId,
    });
    if (!plan.ok) throw new Error("membership_fixture_failed");
    expect(plan.sourceProjectId).toBeNull();
    await workspace().finalizeProjectMembership({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: active.project.id,
      workstreamId,
      membershipGeneration: plan.membershipGeneration,
      sourceProjectId: null,
      sourceDetached: false,
    });

    await expect(workspace().restoreProject({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: archived.project.id,
    })).resolves.toEqual({ ok: false, code: "project_restore_conflict" });
  });

  it("given an archived empty project, when it is restored, then it returns to active server order", async () => {
    const created = await create("Paused project");
    if (!created.ok) throw new Error("project_fixture_failed");
    await workspace().archiveProject({ workspaceId: WORKSPACE_ID, userId: OWNER, projectId: created.project.id });

    await expect(workspace().restoreProject({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      projectId: created.project.id,
    })).resolves.toMatchObject({ ok: true, project: { status: "active" }, targets: [] });
    await expect(workspace().listProjects({ workspaceId: WORKSPACE_ID, userId: OWNER }))
      .resolves.toMatchObject({ ok: true, directory: { items: [{ name: "Paused project" }] } });
  });
});
