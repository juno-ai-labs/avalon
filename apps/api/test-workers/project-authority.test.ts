/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009a0");
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
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
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
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
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
