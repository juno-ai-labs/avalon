/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

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
    state.storage.sql.exec("DELETE FROM workspace_project_order");
    state.storage.sql.exec("DELETE FROM project_participants");
    state.storage.sql.exec("DELETE FROM projects");
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
});
