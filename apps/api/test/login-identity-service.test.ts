import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { databaseThroughMigration } from "./helpers/migrated-schema";
import { persistVerifiedGoogleIdentity, resolveVerifiedEmailIdentity } from "../src/services/login-identity-service";

const databases: DatabaseSync[] = [];
function database() {
  const db = migratedSqliteDatabase();
  databases.push(db);
  return db;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const google = { subject: "google-subject", email: "Person@Example.com", name: "Person", avatarUrl: null };

describe("verified login identities", () => {
  it("creates a normal email-only user without a fabricated Google subject and converges retries", async () => {
    const db = database();
    const binding = sqliteD1(db);
    const [first, second] = await Promise.all([
      resolveVerifiedEmailIdentity(binding, "Guest@Example.com"),
      resolveVerifiedEmailIdentity(binding, "guest@example.com"),
    ]);
    expect(second).toBe(first);
    expect(db.prepare("SELECT id, platform_user_id, google_subject, onboarding_eligible FROM users").get())
      .toEqual({ id: first, platform_user_id: first, google_subject: null, onboarding_eligible: 0 });
    expect(db.prepare("SELECT user_id FROM user_verified_emails").all()).toEqual([{ user_id: first }]);
  });

  it("reuses a verified Google user's identity and preserves authored presentation", async () => {
    const db = database();
    const binding = sqliteD1(db);
    const id = await persistVerifiedGoogleIdentity(binding, google);
    db.prepare("UPDATE users SET presentation_json = ? WHERE id = ?").run('{"displayName":"Chosen name"}', id);
    expect(await resolveVerifiedEmailIdentity(binding, "PERSON@example.com")).toBe(id);
    expect(await persistVerifiedGoogleIdentity(binding, google)).toBe(id);
    expect(db.prepare("SELECT name FROM users WHERE id = ?").get(id)).toEqual({ name: "Chosen name" });
    expect(db.prepare("SELECT provider,user_id FROM user_login_identities ORDER BY provider").all())
      .toEqual([{ provider: "email", user_id: id }, { provider: "google", user_id: id }]);
  });

  it("removes old mailbox login bindings when a verified Google address changes", async () => {
    const db = database();
    const binding = sqliteD1(db);
    const id = await persistVerifiedGoogleIdentity(binding, google);
    await resolveVerifiedEmailIdentity(binding, google.email);
    expect(await persistVerifiedGoogleIdentity(binding, { ...google, email: "new@example.com" })).toBe(id);
    expect(await resolveVerifiedEmailIdentity(binding, "new@example.com")).toBe(id);
    const formerMailboxOwner = await resolveVerifiedEmailIdentity(binding, google.email);
    expect(formerMailboxOwner).not.toBe(id);
    expect(db.prepare("SELECT email FROM user_verified_emails WHERE user_id = ?").all(id)).toEqual([{ email: "new@example.com" }]);
  });

  it("refuses an unverified profile match and does not silently link another provider", async () => {
    const db = database();
    const binding = sqliteD1(db);
    db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES ('unverified','raw@example.com','Raw','now','now')").run();
    await expect(resolveVerifiedEmailIdentity(binding, "raw@example.com")).rejects.toMatchObject({ code: "verified_identity_required" });
    const guest = await resolveVerifiedEmailIdentity(binding, google.email);
    await expect(persistVerifiedGoogleIdentity(binding, google)).rejects.toThrow();
    expect(await resolveVerifiedEmailIdentity(binding, google.email)).toBe(guest);
    expect(db.prepare("SELECT * FROM user_login_identities WHERE provider = 'google'").all()).toEqual([]);
  });

  it("upgrades populated identities with foreign keys on, preserving membership, sessions and routes", async () => {
    const db = databaseThroughMigration("0107_user_push_devices.sql");
    databases.push(db);
    db.exec(`INSERT INTO users (id,google_subject,email,name,platform_user_id,created_at,updated_at)
      VALUES ('u','subject','Mixed@Example.com','Name','u','now','now');
      INSERT INTO workspaces (id,name,slug,region,created_by_user_id,created_at,updated_at)
      VALUES ('w','Workspace','workspace','global','u','now','now');
      INSERT INTO workspace_members (workspace_id,user_id,role,status,joined_at) VALUES ('w','u','owner','active','now');
      INSERT INTO sessions (id,user_id,workspace_id,region,refresh_token_hash,expires_at,created_at)
      VALUES ('session','u','w','global','hash','later','now');
      INSERT INTO workstreams (id,workspace_id,do_identity_anchor) VALUES ('stream','w',1);
      INSERT INTO workstream_authority_routes
      (workspace_id,workstream_id,generation,object_name,state,source_fence_sequence,updated_at)
      VALUES ('w','stream',1,'stream-object','active',0,'now');`);
    const names = ["users", "workspaces", "workspace_members", "sessions", "workstreams", "workstream_authority_routes"];
    const rows = new Map(names.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
    db.exec("BEGIN");
    db.exec(readFileSync(new URL("../../../packages/db/migrations/0108_email_login_identities.sql", import.meta.url), "utf8"));
    db.exec("COMMIT");
    for (const name of names) expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual(rows.get(name));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("UPDATE users SET platform_user_id = 'another' WHERE id = 'u'"))
      .toThrow("platform_user_id_immutable");
    expect(await resolveVerifiedEmailIdentity(sqliteD1(db), "mixed@example.com")).toBe("u");
  });
});
