import { DatabaseSync } from "node:sqlite";
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { databaseThroughMigration } from './helpers/migrated-schema';

it('preserves Global workspace dependents and immutable routing rows while opening the region vocabulary', () => {
  const database = databaseThroughMigration('0105_connector_maintenance_operations.sql');
  try {
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user', 'google-user', 'member@example.com', 'Member', '2026-09-01', '2026-09-01');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at, placement_affinity)
      VALUES ('workspace', 'Kept workspace', 'kept', 'global', 'user', '2026-09-01', '2026-09-01', 'enam');
      INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ('workspace', 'user', 'owner', 'active');
      INSERT INTO sessions (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
      VALUES ('session', 'user', 'workspace', 'global', 'kept-hash', '2027-09-01', '2026-09-01');
      INSERT INTO workspace_product_authority_routes (workspace_id, generation, state, updated_at)
      VALUES ('workspace', 7, 'active', '2026-09-01');
      INSERT INTO workstream_email_routes (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
      VALUES ('kept@streams.example.com', 'owner', 'global', 'workspace', 'workstream', '2026-09-01', '2026-09-01');
    `);
    database.exec(`INSERT INTO telemetry_accepted_events
      (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id, accepted_at, normalized_timestamp, delete_at, delivery_state)
      VALUES ('event', 'hash', '{}', 'global', 'explicit_binding', 'subject', '2026-09-01', '2026-09-01', '2027-09-01', 'delivered');
      INSERT INTO telemetry_delivery_receipts VALUES ('event', 'hash', 'global', 'delivered', '2026-09-01', '2027-09-01');`);
    const tables = ['workspaces', 'workspace_members', 'sessions', 'workspace_product_authority_routes', 'workstream_email_routes', 'telemetry_accepted_events', 'telemetry_delivery_receipts'];
    const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
    database.exec('BEGIN');
    database.exec(readFileSync(new URL('../../../packages/db/migrations/0106_configurable_regions.sql', import.meta.url), 'utf8'));
    database.exec('COMMIT');
    expect(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.exec(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at, placement_affinity)
      VALUES ('enterprise-workspace', 'Enterprise', 'enterprise', 'enterprise', 'user', '2026-09-14', '2026-09-14', 'wnam')`);
    database.exec(`INSERT INTO telemetry_accepted_events
      (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id, accepted_at, normalized_timestamp, delete_at, delivery_state)
      VALUES ('enterprise-event', 'hash', '{}', 'enterprise', 'explicit_binding', 'subject', '2026-09-01', '2026-09-01', '2027-09-01', 'delivered')`);
    expect(database.prepare("SELECT region FROM workspaces WHERE id = 'enterprise-workspace'").get()).toEqual({ region: 'enterprise' });
  } finally {
    database.close();
  }
});

it('preserves platform artifact routing while allowing another deployment', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../../packages/db/platform-migrations/0001_artifact_hostname_routes.sql', import.meta.url), 'utf8'));
    database.exec("INSERT INTO artifact_hostname_routes VALUES ('quiet-green-river-stone', 'global', 'workspace', 'artifact', '2026-09-01')");
    database.exec(readFileSync(new URL('../../../packages/db/platform-migrations/0002_minimize_artifact_hostname_routes.sql', import.meta.url), 'utf8'));
    database.exec(readFileSync(new URL('../../../packages/db/platform-migrations/0003_configurable_regions.sql', import.meta.url), 'utf8'));
    expect(database.prepare('SELECT * FROM artifact_hostname_routes').get()).toEqual({
      hostname_stub: 'quiet-green-river-stone', region: 'global', artifact_id: 'artifact', created_at: '2026-09-01',
    });
    database.exec("INSERT INTO artifact_hostname_routes VALUES ('bright-blue-mountain-sky', 'enterprise', 'other-artifact', '2026-09-14')");
    expect(database.prepare('SELECT COUNT(*) AS n FROM artifact_hostname_routes').get()).toEqual({ n: 2 });
  } finally { database.close(); }
});
