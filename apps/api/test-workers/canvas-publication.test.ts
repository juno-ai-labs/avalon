// A person publishing into a Canvas through the same writes as Rally's own
// publish, on real workerd: WorkspaceDO's resource rows and version triggers,
// the Chat's object, R2 and the artifact host. `docs/rally-mcp.md#publishing`.
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactManifestSchema, artifactManifestKey, asArtifactId, asUserId, asWorkspaceId, manifestAssetKey } from "@rally/contracts";

/** A version's stored `index.html`, found through its manifest as every reader finds it. */
async function storedPage(artifactId: string, version: number): Promise<string> {
  const manifest = ArtifactManifestSchema.parse(await (await env.PAYLOADS.get(artifactManifestKey(artifactId, version)))!.json());
  const index = manifest.assets.find((asset) => asset.path === "index.html")!;
  return (await env.PAYLOADS.get(manifestAssetKey(manifest, index)))!.text();
}

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { artifactHostDOName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAccessContext } from "../src/services/authorization-service";
import { projectAuthorization } from "../src/services/authorization-projection-service";
import { conversationObjectName } from "../src/durable-objects/names";
import { asSubstreamId } from "@rally/contracts";
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

/**
 * An environment whose bucket stops at the first `put` (or `get`) whose key
 * `matches`, until `release()`: how one publish is held at a chosen step
 * while another runs, the interleaving two concurrent calls produce.
 */
function heldBucket(method: "put" | "get", matches: (key: string) => boolean) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atHold = new Promise<void>((resolve) => { reached = resolve; });
  let held = false;
  const bucket = new Proxy(env.PAYLOADS, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (property === method && !held && typeof args[0] === "string" && matches(args[0])) {
          held = true;
          reached();
          await released;
        }
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  const heldEnv: Env = { ...TEST_ENV, PAYLOADS: bucket };
  return { env: heldEnv, atHold, release };
}

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

// These cases are about who may open a private Canvas, so the Organization
// makes new Canvases private rather than taking the Organization-wide default.
beforeEach(async () => {
  await workspace().saveCanvasSharingDefaults({ workspaceId: WORKSPACE_ID, defaults: { editors: "creator" } });
});

async function publisherCanvasArchive(canvasId: string): Promise<void> {
  await new CanvasService(TEST_ENV, auth(CREATOR)).archive(canvasId);
}

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

  it("makes a new name the Canvas's one artifact, and versions a listed one beside the others a converted Canvas holds", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const listed = async () => (await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).artifacts.map((artifact) => artifact.resourceId).sort();
    const plan = await publisher.publish(canvasId, { kind: "file", name: "plan.md", content: text("# Plan") });
    const budget = await publisher.publish(canvasId, { kind: "file", name: "budget.md", content: text("# Budget") });
    expect(await listed()).toEqual([budget.resourceId]);
    // As a Canvas converted from a Thread holds them: both listed.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, 1)", canvasId, plan.resourceId);
    });
    await publisher.publish(canvasId, { kind: "file", name: "plan.md", content: text("# Plan, revised") });
    expect(await listed()).toEqual([plan.resourceId, budget.resourceId].sort());
  });

  it("refuses a first publication whose bytes were prepared before Canvas archive", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const hold = heldBucket("put", (key) => key.includes("/published/"));
    const pending = new CanvasPublicationService(hold.env, auth(CREATOR)).publish(canvasId,
      { kind: "file", name: "first.md", content: text("Late first publication") }).then(() => "published", (error: unknown) => error instanceof Error && "code" in error ? error.code : "refused");
    try {
      await hold.atHold;
      await publisherCanvasArchive(canvasId);
    } finally { hold.release(); }
    expect(await pending).toBe("canvas_archived");
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM resources WHERE publication_parent_id = ?", canvasId).one().n)).toBe(0);
  });

  it("fences a publication already preparing bytes when its Canvas is archived", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const first = await publisher.publish(canvasId, { kind: "file", name: "plan.md", content: text("Before archive") });
    await projectAuthorization(TEST_ENV, { type: "authorization_projection_v1", region: "global", workspaceId: WORKSPACE_ID,
      parentId: canvasId, substreamId: asSubstreamId("0") });
    const decide = () => createAccessContext(TEST_ENV, auth(CREATOR)).check({ kind: "resource", workspaceId: WORKSPACE_ID,
      resourceId: first.resourceId });
    expect((await decide()).status).toBe("allowed");
    const hold = heldBucket("put", (key) => key.includes("/published/"));
    const pending = new CanvasPublicationService(hold.env, auth(CREATOR)).publish(canvasId,
      { kind: "file", name: "plan.md", content: text("After archive") }).then(() => "published", (error: unknown) => error instanceof Error && "code" in error ? error.code : "refused");
    try {
      await hold.atHold;
      await publisherCanvasArchive(canvasId);
    } finally { hold.release(); }
    expect(await pending).toBe("canvas_archived");
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ version: number }>(
      "SELECT MAX(version) AS version FROM resource_versions WHERE resource_id = ?", first.resourceId).one().version)).toBe(1);
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId, asSubstreamId("0"))));
    expect((await decide()).status).toBe("not_found");
    // Retained bytes and versions stay readable to storage, not to their publisher.
    expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec("SELECT 1 FROM workstream WHERE id = 1").toArray().length)).toBe(1);
  });

  it("revokes a published site's active viewer session through durable Canvas archive fan-out", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const published = await new CanvasPublicationService(TEST_ENV, auth(CREATOR)).publish(canvasId,
      { kind: "site", name: "dashboard", files: [{ path: "index.html", content: text("<h1>Dashboard</h1>") }] });
    const artifactId = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ artifact_id: string }>(
      "SELECT artifact_id FROM artifact_registry WHERE resource_id = ?", published.resourceId).one().artifact_id);
    const host = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName("global", asArtifactId(artifactId))));
    const { code } = await host.openForViewer({ userId: CREATOR, appSessionId: `session-${CREATOR}`, displayName: "Creator" });
    const session = await host.redeemCode(code);
    expect((await host.checkSession(session!.session)).ok).toBe(true);
    await publisherCanvasArchive(canvasId);
    await runDurableObjectAlarm(workspace());
    await expect.poll(() => host.checkSession(session!.session)).toEqual({ ok: false, reason: "no_session" });
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

  it("builds a component into a site, recognizes an unchanged one from its source, and refuses what cannot build before any sandbox", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const builtPage = new TextEncoder().encode("<!doctype html><title>Dashboard</title><div id=root></div>");
    const builder = { build: vi.fn(async () => ({ renderedTextLength: 42, files: [{ path: "index.html", bytes: builtPage,
      sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", builtPage))].map((b) => b.toString(16).padStart(2, "0")).join("") }] })) };
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR), builder);
    const dashboard = { kind: "site" as const, name: "dashboard", files: [{ path: "Dashboard.jsx",
      content: text('import { TrendingUp } from "lucide-react";\nexport default function Dashboard() { return <TrendingUp />; }') }] };

    const first = await publisher.publish(canvasId, dashboard);
    expect(first).toMatchObject({ kind: "site", outcome: "created", version: 1, build: { source: "component", files: 1, renderedTextLength: 42 } });
    // No abort signal: this call has no request to be cancelled with.
    expect(builder.build).toHaveBeenCalledWith(canvasId, { kind: "component", entry: "Dashboard.jsx" }, expect.any(Array), undefined);
    // What was served is what the build made, not the source.
    const served = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ artifact_id: string; current_version: number }>(
      "SELECT artifact_id, current_version FROM artifact_registry WHERE resource_id = ?", first.resourceId).one());
    expect(await storedPage(served.artifact_id, served.current_version))
      .toBe(new TextDecoder().decode(builtPage));

    expect(await publisher.publish(canvasId, dashboard)).toMatchObject({ outcome: "unchanged", version: 1 });
    expect(builder.build).toHaveBeenCalledOnce();

    await expect(publisher.publish(canvasId, { kind: "site", name: "scene", files: [{ path: "Scene.jsx",
      content: text('import * as THREE from "three";\nexport default function Scene() { return null; }') }] }))
      .rejects.toMatchObject({ status: 422, code: "canvas_build_unsupported_import:three" });
    expect(builder.build).toHaveBeenCalledOnce();
  });

  it("finishes a site publish that stopped before the registry and the server moved, when it is retried unchanged", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const site = (heading: string) => ({ kind: "site" as const, name: "home", files: [{ path: "index.html", content: text(`<h1>${heading}</h1>`) }] });
    await publisher.publish(canvasId, site("One"));
    const second = await publisher.publish(canvasId, site("Two"));
    expect(second).toMatchObject({ outcome: "updated", version: 2 });
    const registry = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ artifact_id: string; current_version: number }>(
      "SELECT artifact_id, current_version FROM artifact_registry WHERE resource_id = ?", second.resourceId).one());
    const { artifact_id: artifactId } = await registry();
    const host = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId))));
    const served = () => runInDurableObject(host, (_instance, state) =>
      state.storage.sql.exec<{ current_version: number }>("SELECT current_version FROM artifact_state WHERE id = 1").one().current_version);
    // As if the second publish had moved the resource row and stopped there.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE artifact_registry SET current_version = 1 WHERE resource_id = ?", second.resourceId);
    });
    await runInDurableObject(host, (_instance, state) => { state.storage.sql.exec("UPDATE artifact_state SET current_version = 1 WHERE id = 1"); });

    expect(await publisher.publish(canvasId, site("Two"))).toMatchObject({ outcome: "unchanged" });
    expect((await registry()).current_version).toBe(2);
    expect(await served()).toBe(2);
  });

  it("activates only the publish that moved the row when two of one site race, each writing its own version", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const site = (heading: string) => ({ kind: "site" as const, name: "home", files: [{ path: "index.html", content: text(`<h1>${heading}</h1>`) }] });
    const first = await new CanvasPublicationService(TEST_ENV, auth(CREATOR)).publish(canvasId, site("One"));
    const isManifest = (key: string) => key.endsWith("/manifest.json");
    // Both read version 1. The winner stops before its manifest, then the
    // loser takes the next version and stops there too; the winner moves the
    // row and finishes, and only then does the loser try to.
    const winnerHold = heldBucket("put", isManifest);
    const winner = new CanvasPublicationService(winnerHold.env, auth(CREATOR)).publish(canvasId, site("Winner"));
    await winnerHold.atHold;
    const loserHold = heldBucket("put", isManifest);
    const loser = new CanvasPublicationService(loserHold.env, auth(CREATOR)).publish(canvasId, site("Loser"));
    const loserOutcome = loser.then(() => "resolved", (error: unknown) => error);
    await loserHold.atHold;
    winnerHold.release();
    expect(await winner).toMatchObject({ outcome: "updated" });
    loserHold.release();
    expect(await loserOutcome).toMatchObject({ status: 409, code: "canvas_publish_conflict" });

    const registry = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ artifact_id: string; current_version: number }>(
      "SELECT artifact_id, current_version FROM artifact_registry WHERE resource_id = ?", first.resourceId).one());
    const host = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName(env.AVALON_REGION, asArtifactId(registry.artifact_id))));
    const served = await runInDurableObject(host, (_instance, state) =>
      state.storage.sql.exec<{ current_version: number }>("SELECT current_version FROM artifact_state WHERE id = 1").one().current_version);
    expect([registry.current_version, served]).toEqual([2, 2]);
    // The winner's version holds the winner's bytes, not the loser's written over them.
    expect(await storedPage(registry.artifact_id, 2)).toBe("<h1>Winner</h1>");
  });

  it("never moves the registry or the served version back when an unchanged retry overlaps a later publish", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const site = (heading: string) => ({ kind: "site" as const, name: "home", files: [{ path: "index.html", content: text(`<h1>${heading}</h1>`) }] });
    await publisher.publish(canvasId, site("One"));
    const second = await publisher.publish(canvasId, site("Two"));
    const registry = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ artifact_id: string; current_version: number }>(
      "SELECT artifact_id, current_version FROM artifact_registry WHERE resource_id = ?", second.resourceId).one());
    const { artifact_id: artifactId } = await registry();
    const host = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId))));
    const served = () => runInDurableObject(host, (_instance, state) =>
      state.storage.sql.exec<{ current_version: number }>("SELECT current_version FROM artifact_state WHERE id = 1").one().current_version);
    // As if the second publish had moved the resource row and stopped there.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE artifact_registry SET current_version = 1 WHERE resource_id = ?", second.resourceId);
    });
    await runInDurableObject(host, (_instance, state) => { state.storage.sql.exec("UPDATE artifact_state SET current_version = 1 WHERE id = 1"); });

    // The retry reads the row and the lagging registry, then stops before
    // reading the manifest; a later publish lands completely meanwhile.
    const retryHold = heldBucket("get", () => true);
    const retry = new CanvasPublicationService(retryHold.env, auth(CREATOR)).publish(canvasId, site("Two"));
    await retryHold.atHold;
    expect(await publisher.publish(canvasId, site("Three"))).toMatchObject({ outcome: "updated" });
    const later = await registry();
    expect(later.current_version).toBeGreaterThan(2);
    retryHold.release();
    expect(await retry).toMatchObject({ outcome: "unchanged" });
    expect((await registry()).current_version).toBe(later.current_version);
    expect(await served()).toBe(later.current_version);
  });

  it("leaves the Canvas's attribution alone on an unchanged republish, and lists an artifact whose note never landed", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
    const file = { kind: "file" as const, name: "plan.md", content: text("# Plan") };
    const first = await publisher.publish(canvasId, file);
    // Rally wrote to the Canvas since.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE canvas_directory SET last_editor_kind = 'rally', last_editor_id = NULL WHERE canvas_id = ?", canvasId);
    });
    expect(await publisher.publish(canvasId, file)).toMatchObject({ outcome: "unchanged" });
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).lastEditor).toEqual({ kind: "rally", id: null });

    // As if the first publish had stopped before noting: the retry lists it.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM canvas_artifacts WHERE canvas_id = ?", canvasId);
    });
    expect(await publisher.publish(canvasId, file)).toMatchObject({ outcome: "unchanged" });
    const detail = await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId);
    expect(detail.artifacts.map((artifact) => artifact.resourceId)).toEqual([first.resourceId]);
    expect(detail.lastEditor).toEqual({ kind: "person", id: CREATOR });
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
