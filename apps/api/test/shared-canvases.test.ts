import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env";
import { personOrganizations, readSharedCanvasesEnabled, writeSharedCanvasesEnabled } from "../src/services/shared-canvases";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The two D1 reads a shared-Canvas list is built from, against the checked-in
// migrations: which Organizations a person is in (and a guest of), and their
// switch. What each Organization answers is proved on real objects in
// `test-workers/canvas-share-federation.test.ts`.
const at = "2026-11-16T00:00:00.000Z";
const PERSON = "00000000-0000-7000-8000-0000000bb001";
const HOME = "00000000-0000-7000-8000-0000000bb101";
const ACME = "00000000-0000-7000-8000-0000000bb102";
const LEFT = "00000000-0000-7000-8000-0000000bb103";
const GONE = "00000000-0000-7000-8000-0000000bb104";
let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  db = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global" });
  db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, 'g-person', 'p@example.test', 'Person', ?, ?)`)
    .run(PERSON, at, at);
  for (const [id, name] of [[HOME, "Home"], [ACME, "Acme"], [LEFT, "Left"], [GONE, "Gone"]] as const) {
    db.prepare(`INSERT INTO workspaces (id, name, slug, region, placement_affinity, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'global', 'wnam', ?, ?, ?)`).run(id, name, id, PERSON, at, at);
  }
  db.prepare(`UPDATE workspaces SET abandoned_at = ? WHERE id = ?`).run(at, GONE);
  const member = (workspaceId: string, status: string, guest: boolean) => db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, access_class) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, PERSON, guest ? null : "member", status, at, guest ? "guest" : "member");
  member(HOME, "active", false);
  member(ACME, "active", true);
  member(LEFT, "suspended", true);
  member(GONE, "active", true);
});
afterEach(() => db.close());

describe("building a shared-Canvas list", () => {
  it("names the Organizations a person is active in, and which they are a guest of", async () => {
    expect((await personOrganizations(env, PERSON)).map(({ name, guest }) => [name, guest])).toEqual([["Home", false], ["Acme", true]]);
  });

  it("is on until the person turns it off", async () => {
    expect(await readSharedCanvasesEnabled(env, PERSON)).toBe(true);
    await writeSharedCanvasesEnabled(env, PERSON, false);
    expect(await readSharedCanvasesEnabled(env, PERSON)).toBe(false);
    await writeSharedCanvasesEnabled(env, PERSON, true);
    expect(await readSharedCanvasesEnabled(env, PERSON)).toBe(true);
  });
});
