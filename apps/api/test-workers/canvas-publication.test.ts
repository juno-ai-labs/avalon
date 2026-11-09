// A person publishing into a Canvas through the same writes as Rally's own
// publish, on real workerd: WorkspaceDO's resource rows and version triggers,
// the Chat's object, R2 and the artifact host. `docs/rally-mcp.md#publishing`.
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { CanvasPublicationService } from "../src/services/canvas-publication-service";
import { CanvasService, createCanvas } from "../src/services/canvas-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cc000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cc001");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000cc002");
const TEST_ENV: Env = env;
useHeldEffectQueue();

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

const text = (data: string) => ({ encoding: "text" as const, data });

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class)
      VALUES (?, ?, 'active', 'member', 'member')`).bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  // The platform database's hostname routes, which a site's public origin reserves.
  await env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
    hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(region, artifact_id))`).run();
});

describe("publishing into a Canvas", () => {
  it("lands a file as the person's artifact, versions it on a republish, and changes nothing on a repeat", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const first = await publisher.publish(canvasId, { kind: "file", name: "plan.md", title: "Launch plan", content: text("# Plan\n\nShip it.") });
    expect(first).toMatchObject({ kind: "file", title: "Launch plan", version: 1, outcome: "created" });

    const detail = await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId);
    expect(detail.artifacts.map((artifact) => [artifact.resourceId, artifact.title, artifact.version, artifact.kind]))
      .toEqual([[first.resourceId, "Launch plan", 1, "file"]]);
    expect(detail.lastEditor).toEqual({ kind: "person", id: CREATOR });

    const second = await publisher.publish(canvasId, { kind: "file", name: "plan.md", content: text("# Plan\n\nShip it Monday.") });
    expect(second).toMatchObject({ resourceId: first.resourceId, version: 2, outcome: "updated", title: "Launch plan" });
    const repeat = await publisher.publish(canvasId, { kind: "file", name: "plan.md", content: text("# Plan\n\nShip it Monday.") });
    expect(repeat).toMatchObject({ resourceId: first.resourceId, version: 2, outcome: "unchanged" });

    // Each revision records its author: the person, never Rally's run.
    const versions = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ version: number; kind: string; user: string; cause: string }>(
      `SELECT version, author_kind AS kind, author_user_id AS user, cause FROM resource_versions
        WHERE resource_id = ? ORDER BY version`, first.resourceId).toArray());
    expect(versions).toEqual([
      { version: 1, kind: "member", user: CREATOR, cause: "created" },
      { version: 2, kind: "member", user: CREATOR, cause: "published" },
    ]);
  });

  it("publishes a static site from its files", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const published = await new CanvasPublicationService(TEST_ENV, auth(CREATOR)).publish(canvasId, {
      kind: "site", name: "pricing-page",
      files: [{ path: "index.html", content: text("<!doctype html><title>Pricing</title><h1>Pricing</h1>") },
        { path: "style.css", content: text("h1 { color: teal; }") }],
    });
    expect(published).toMatchObject({ kind: "site", version: 1, outcome: "created", title: "pricing-page" });
    const detail = await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId);
    expect(detail.artifacts.map((artifact) => [artifact.resourceId, artifact.kind])).toEqual([[published.resourceId, "site"]]);
  });

  it("stores bytes exactly, from either base64 alphabet or wrapped lines", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const bytes = crypto.getRandomValues(new Uint8Array(3_000));
    const standard = btoa(String.fromCharCode(...bytes));
    const hex = async (value: Uint8Array<ArrayBuffer>) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const encodings = [standard, standard.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""), standard.replace(/(.{76})/gu, "$1\n")];
    for (const [index, data] of encodings.entries()) {
      const published = await publisher.publish(canvasId, { kind: "file", name: `blob-${index}.bin`, content: { encoding: "base64", data } });
      const ref = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ content_ref: string }>(
        "SELECT content_ref FROM resources WHERE id = ?", published.resourceId).one().content_ref);
      expect(await hex(new Uint8Array(await (await env.PAYLOADS.get(ref))!.arrayBuffer()))).toBe(await hex(bytes));
    }
  });

  it("refuses a file over the size cap from its length, before decoding it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    // Not base64 at all: a decode would answer 422, so a 413 means the length decided first.
    const oversized = "!".repeat(Math.ceil(25_000_001 * 4 / 3) + 4);
    await expect(new CanvasPublicationService(TEST_ENV, auth(CREATOR)).publish(canvasId,
      { kind: "file", name: "huge.bin", content: { encoding: "base64", data: oversized } })).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("treats a site's files as a set, and refuses a name published as the other kind", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const files = [{ path: "index.html", content: text("<h1>Hi</h1>") }, { path: "a.css", content: text("h1{}") }];
    await publisher.publish(canvasId, { kind: "site", name: "home", files });
    expect(await publisher.publish(canvasId, { kind: "site", name: "home", files: [...files].reverse() }))
      .toMatchObject({ outcome: "unchanged", version: 1 });
    await expect(publisher.publish(canvasId, { kind: "file", name: "home", content: text("x") }))
      .rejects.toMatchObject({ code: "canvas_artifact_kind_changed" });
  });

  it("refuses someone the Canvas does not admit, and writes nothing", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await expect(new CanvasPublicationService(TEST_ENV, auth(MEMBER)).publish(canvasId,
      { kind: "file", name: "notes.md", content: text("hello") })).rejects.toMatchObject({ code: "conversation_not_found" });
    const rows = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec(`SELECT COUNT(*) AS n FROM resources WHERE provider = 'avalon_generated'`).one());
    expect(rows).toEqual({ n: 0 });
  });
});
