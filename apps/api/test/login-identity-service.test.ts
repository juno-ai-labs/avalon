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
    // Seed every copied dependency branch with foreign keys enabled, including
    // grandchildren and SET NULL references that foreign_key_check cannot detect.
    db.exec(`
      INSERT INTO demo_operations (operation_id,company_name,presenter_user_id,pack_version,cast_json,workspace_id,status,attempt,created_at,updated_at)
      VALUES ('demo','Company','u','v1','{}','w','ready',1,'now','now');
      INSERT INTO demo_operation_phases (operation_id,phase,status,attempt,started_at,finished_at)
      VALUES ('demo','create','completed',1,'now','later');
      INSERT INTO telemetry_accepted_events (event_id,payload_hash,envelope_json,route,routing_basis,analytics_subject_id,subject_user_id,accepted_at,normalized_timestamp,delete_at,delivery_state)
      VALUES ('event','hash','{}','global','explicit_binding','person','u','now','now','later','pending');
      INSERT INTO workspace_invitations (id,workspace_id,email,invited_by_user_id,token_hash,expires_at,created_at,accepted_by_user_id)
      VALUES ('invite','w','invited@example.com','u','invite-hash','later','now','u');
      INSERT INTO telemetry_profile_jobs (id,subject_user_id,workspace_id,job_kind,destination_analytics_id,properties_json,version,state,created_at,delete_at)
      VALUES ('profile','u','w','group_profile','analytics-workspace','{}',1,'pending','now','later');
      INSERT INTO workstream_create_receipts (workspace_id,creator_user_id,client_message_id,workstream_id,generation,request_hash,state,created_at,updated_at)
      VALUES ('w','u','message','stream',1,'hash','completed','now','now');
      INSERT INTO demo_seed_receipts (operation_id,action_id,workspace_id,kind,room,workstream_id,substream_id,completed_at)
      VALUES ('demo','seed','w','create_workstream','room','stream','0','now');
      INSERT INTO oauth_states (id,region,provider,purpose,code_verifier_encrypted,user_id,workspace_id,return_uri,expires_at,invitation_id)
      VALUES ('oauth','global','google','login','encrypted','u','w','https://example.test','later','invite');
      INSERT INTO desktop_login_tickets (id,ticket_hash,user_id,workspace_id,region,expires_at,created_at)
      VALUES ('ticket','ticket-hash','u','w','global','later','now');
      INSERT INTO telemetry_crash_reports (crash_id,upload_id,subject_user_id,subject_workspace_id,installation_analytics_id,route,object_key,byte_size,content_sha256,release,build_id,platform,architecture,process_role,launch_id,channel,received_at,delete_at)
      VALUES ('crash','upload','u','w','installation','global','crash-object',1,'hash','release','build','darwin','arm64','main','launch','stable','now','later');
      INSERT INTO connector_ingress_routes (connection_id,workspace_id,region,connector_type,scope,status,updated_at)
      VALUES ('connection','w','global','slack','workspace','active','now');
      INSERT INTO user_push_devices (id,user_id,installation_id,platform,transport,topic,apns_environment,token,app_version,last_seen_at)
      VALUES ('device','u','installation','ios','apns','ai.rallywith.ios','production','token','1','now');
      INSERT INTO user_push_device_sessions (device_id,session_id) VALUES ('device','session');
      INSERT INTO push_delivery_receipts (workspace_id,intent_id,device_id,delivered_at) VALUES ('w','push','device','now');
      INSERT INTO audit_events (id,workspace_id,actor_type,actor_user_id,workstream_id,action,target_type,target_id,created_at)
      VALUES ('audit','w','user','u','stream','created','workstream','stream','now');
      INSERT INTO workspace_product_authority_routes (workspace_id,generation,state,updated_at)
      VALUES ('w',1,'active','now');
    `);
    const names = [
      "users", "demo_operations", "demo_operation_phases", "telemetry_accepted_events",
      "workspaces", "workspace_members", "workspace_invitations", "telemetry_profile_jobs",
      "workstream_create_receipts", "demo_seed_receipts", "oauth_states", "sessions",
      "desktop_login_tickets", "telemetry_crash_reports", "connector_ingress_routes",
      "user_push_devices", "user_push_device_sessions", "push_delivery_receipts", "workstreams",
      "audit_events", "workstream_authority_routes", "workspace_product_authority_routes",
    ];
    const rows = new Map(names.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
    for (const name of names) expect(rows.get(name), `${name} fixture must be populated`).toHaveLength(1);
    db.exec("BEGIN");
    db.exec(readFileSync(new URL("../../../packages/db/migrations/0108_email_login_identities.sql", import.meta.url), "utf8"));
    db.exec("COMMIT");
    for (const name of names) expect(db.prepare(`SELECT * FROM ${name}`).all(), `${name} must survive identity migration`).toEqual(rows.get(name));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("UPDATE users SET platform_user_id = 'another' WHERE id = 'u'"))
      .toThrow("platform_user_id_immutable");
    expect(await resolveVerifiedEmailIdentity(sqliteD1(db), "mixed@example.com")).toBe("u");
  });
});
