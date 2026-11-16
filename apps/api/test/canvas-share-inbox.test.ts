import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { CanvasShareState } from "@rally/contracts/canvas-share-federation";
import type { Env } from "../src/env";
import {
  applyCanvasShare,
  readSharedCanvases,
  readSharedCanvasPointers,
  readSharedCanvasesEnabled,
  writeSharedCanvasesEnabled,
} from "../src/services/canvas-share-inbox";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The inbox's queries against the checked-in D1 migrations: what a delivery
// writes, which deliveries it refuses, and which pointers one Organization's
// list reads. Resolving a pointer into what a row shows is the origin
// Organization's, proved in `test-workers/canvas-share-federation.test.ts`.
const at = "2026-11-16T00:00:00.000Z";
const READER = "00000000-0000-7000-8000-0000000bb001";
const HOME = "00000000-0000-7000-8000-0000000bb101";
const ACME = "00000000-0000-7000-8000-0000000bb102";
const LEFT = "00000000-0000-7000-8000-0000000bb103";
const PLAN = "00000000-0000-7000-8000-0000000bb201";
const ROADMAP = "00000000-0000-7000-8000-0000000bb202";
let db: DatabaseSync;
let env: Env;

const shared = (revision: number, title: string): CanvasShareState =>
  ({ state: "shared", revision, title, appearance: null, updatedAt: 1_000 });
const pointed = async (from = HOME) => (await readSharedCanvasPointers(env, READER, from))
  .map((group) => [group.organization.name, ...group.canvasIds]);

beforeEach(() => {
  db = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global" });
  db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, 'g-reader', 'r@example.test', 'Reader', ?, ?)`)
    .run(READER, at, at);
  for (const [id, name] of [[HOME, "Home"], [ACME, "Acme"], [LEFT, "Left"]] as const) {
    db.prepare(`INSERT INTO workspaces (id, name, slug, region, placement_affinity, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'global', 'wnam', ?, ?, ?)`).run(id, name, id, READER, at, at);
  }
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)`).run(HOME, READER, at);
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, access_class) VALUES (?, ?, NULL, 'active', ?, 'guest')`).run(ACME, READER, at);
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'suspended', ?)`).run(LEFT, READER, at);
});
afterEach(() => db.close());

describe("the Shared with me inbox", () => {
  it("keeps a pointer to a Canvas shared in another Organization, a guest one included, and nothing of the Canvas", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: PLAN }, shared(1, "Partner plan"));
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: ROADMAP }, shared(1, "Partner roadmap"));
    expect(await pointed()).toEqual([["Acme", PLAN, ROADMAP]]);
    expect(db.prepare("SELECT * FROM canvas_share_inbox ORDER BY canvas_id").all()).toEqual([
      { user_id: READER, workspace_id: ACME, canvas_id: PLAN, revision: 1, shared: 1 },
      { user_id: READER, workspace_id: ACME, canvas_id: ROADMAP, revision: 1, shared: 1 },
    ]);
    // Acme's own list never repeats its own Canvases.
    expect(await pointed(ACME)).toEqual([]);
  });

  it("refuses a delivery older than the one it holds, in either direction", async () => {
    const target = { userId: READER, workspaceId: ACME, canvasId: PLAN };
    await applyCanvasShare(env, target, shared(3, "Renamed"));
    expect(await applyCanvasShare(env, target, shared(2, "Old title"))).toBe(false);
    // A rename bumps the revision, so it changes the inbox and is pushed.
    expect(await applyCanvasShare(env, target, shared(4, "Renamed again"))).toBe(true);
    await applyCanvasShare(env, target, { state: "unshared", revision: 5 });
    expect(await pointed()).toEqual([]);
    // A share that left before the unshare arrives after it: still unshared.
    expect(await applyCanvasShare(env, target, shared(4, "Renamed again"))).toBe(false);
    expect(await pointed()).toEqual([]);
    await applyCanvasShare(env, target, shared(6, "Shared again"));
    expect(await pointed()).toEqual([["Acme", PLAN]]);
    // A deleted Canvas goes whatever its revision.
    await applyCanvasShare(env, target, { state: "gone" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM canvas_share_inbox").get()).toEqual({ n: 0 });
  });

  it("leaves out an Organization the person is no longer active in", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: LEFT, canvasId: PLAN }, shared(1, "From a suspended membership"));
    expect(await pointed()).toEqual([]);
  });

  it("is on until the person turns it off, and lists nothing while off", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: PLAN }, shared(1, "Partner plan"));
    expect(await readSharedCanvasesEnabled(env, READER)).toBe(true);
    await writeSharedCanvasesEnabled(env, READER, false);
    expect(await readSharedCanvases(env, READER, HOME)).toEqual({ enabled: false, items: [] });
    await writeSharedCanvasesEnabled(env, READER, true);
    expect(await readSharedCanvasesEnabled(env, READER)).toBe(true);
  });
});
