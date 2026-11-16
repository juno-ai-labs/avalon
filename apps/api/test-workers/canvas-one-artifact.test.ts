/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Canvas holds one artifact, on the real Organization object: the note a
 * publish owes its Canvas (`canvasNoteArtifact`) records the first resource,
 * records a new version of that one, refuses a different resource by name,
 * and takes a different resource in place of every one it held only when the
 * publish asked to replace it. `docs/canvases.md#one-artifact` owns the rule.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c1000");
let CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000000c1100");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000c1001");
const NOW = "2026-11-16T19:00:00.000Z";
const rally = { kind: "rally" as const, id: null };

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

/** A published resource whose publication parent is the Canvas, as a publish from its Chat writes it. */
async function resource(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, publication_parent_id, created_at, updated_at)
      VALUES (?, ?, 'generated_file', 'avalon_generated', ?, '{}', 'attached', ?, ?, ?)`, id, WORKSPACE_ID, title, CANVAS_ID, NOW, NOW);
  });
  return id;
}

const note = (resourceId: string, replace?: boolean) => workspace().canvasNoteArtifact({
  workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, resourceId, editor: rally, ...(replace === undefined ? {} : { replace }),
});

async function listed(): Promise<string[]> {
  return (await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
    actor: { userId: CREATOR, actorRole: "member" } })).artifacts.map((artifact) => artifact.resourceId);
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  CANVAS_ID = asWorkstreamId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Canvas workspace')").bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES (?,?,'member','member','active')")
      .bind(WORKSPACE_ID, CREATOR),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Casey Creator')").bind(CREATOR),
  ]);
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Latent Space", createdByUserId: CREATOR, authorityGeneration: 1,
  });
});

describe("a Canvas's one artifact", () => {
  it("keeps its artifact and refuses a second one by name", async () => {
    const reader = await resource("Reader");
    const podcast = await resource("Podcast");
    expect(await note(reader)).toEqual({ noted: true });
    // A new version of the artifact it holds is still that artifact.
    expect(await note(reader)).toEqual({ noted: true });
    expect(await note(podcast)).toEqual({ noted: false, refused: "canvas_artifact_held" });
    expect(await listed()).toEqual([reader]);
  });

  it("takes a different resource in place of every one it held when the publish replaces it", async () => {
    const reader = await resource("Reader");
    const podcast = await resource("Podcast");
    const combined = await resource("Reader and podcast");
    expect(await note(reader)).toEqual({ noted: true });
    // A Canvas converted from a Thread can hold several; a replacement leaves one.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, 1)", CANVAS_ID, podcast);
    });
    expect(await note(combined, true)).toEqual({ noted: true });
    expect(await listed()).toEqual([combined]);
    // The replaced ones are no longer the Canvas's, so they take no new note either.
    expect(await note(reader)).toEqual({ noted: false, refused: "canvas_artifact_held" });
  });
});
