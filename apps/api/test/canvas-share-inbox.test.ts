import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { CanvasShareState } from "@rally/contracts/canvas-share-federation";
import type { Env } from "../src/env";
import {
  applyCanvasShare,
  readSharedCanvases,
  readSharedCanvasesEnabled,
  writeSharedCanvasesEnabled,
} from "../src/services/canvas-share-inbox";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The inbox's queries against the checked-in D1 migrations: what a delivery
// writes, which deliveries it refuses, and what one Organization's list reads.
const at = "2026-11-16T00:00:00.000Z";
const READER = "00000000-0000-7000-8000-0000000bb001";
const HOME = "00000000-0000-7000-8000-0000000bb101";
const ACME = "00000000-0000-7000-8000-0000000bb102";
const LEFT = "00000000-0000-7000-8000-0000000bb103";
const PLAN = "00000000-0000-7000-8000-0000000bb201";
const ROADMAP = "00000000-0000-7000-8000-0000000bb202";
let db: DatabaseSync;
let env: Env;

const shared = (revision: number, title: string, updatedAt = 1_000): CanvasShareState =>
  ({ state: "shared", revision, title, appearance: null, updatedAt });
const titles = async (from = HOME) => (await readSharedCanvases(env, READER, from)).items.map((item) => item.canvas.title);

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
  it("lists a Canvas shared in another Organization, a guest one included, newest first, with that Organization's name", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: PLAN }, shared(1, "Partner plan", 1_000));
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: ROADMAP }, shared(1, "Partner roadmap", 2_000));
    const { enabled, items } = await readSharedCanvases(env, READER, HOME);
    expect(enabled).toBe(true);
    expect(items.map((item) => [item.organization.name, item.canvas.title, item.canvas.updatedAt])).toEqual([
      ["Acme", "Partner roadmap", "1970-01-01T00:00:02.000Z"],
      ["Acme", "Partner plan", "1970-01-01T00:00:01.000Z"],
    ]);
    // Acme's own list never repeats its own Canvases.
    expect(await titles(ACME)).toEqual([]);
  });

  it("refuses a delivery older than the one it holds, in either direction", async () => {
    const target = { userId: READER, workspaceId: ACME, canvasId: PLAN };
    await applyCanvasShare(env, target, shared(3, "Renamed"));
    expect(await applyCanvasShare(env, target, shared(2, "Old title"))).toBe(false);
    expect(await titles()).toEqual(["Renamed"]);
    await applyCanvasShare(env, target, { state: "unshared", revision: 4 });
    expect(await titles()).toEqual([]);
    // A share that left before the unshare arrives after it: still unshared.
    expect(await applyCanvasShare(env, target, shared(3, "Renamed"))).toBe(false);
    expect(await titles()).toEqual([]);
    await applyCanvasShare(env, target, shared(5, "Shared again"));
    expect(await titles()).toEqual(["Shared again"]);
    // A deleted Canvas goes whatever its revision.
    await applyCanvasShare(env, target, { state: "gone" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM canvas_share_inbox").get()).toEqual({ n: 0 });
  });

  it("leaves out an Organization the person is no longer active in", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: LEFT, canvasId: PLAN }, shared(1, "From a suspended membership"));
    expect(await titles()).toEqual([]);
  });

  it("is on until the person turns it off, and lists nothing while off", async () => {
    await applyCanvasShare(env, { userId: READER, workspaceId: ACME, canvasId: PLAN }, shared(1, "Partner plan"));
    expect(await readSharedCanvasesEnabled(env, READER)).toBe(true);
    await writeSharedCanvasesEnabled(env, READER, false);
    expect(await readSharedCanvases(env, READER, HOME)).toEqual({ enabled: false, items: [] });
    await writeSharedCanvasesEnabled(env, READER, true);
    expect(await titles()).toEqual(["Partner plan"]);
  });
});
