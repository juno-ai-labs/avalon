import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { provisionImpersonationRelationships, requireDemoOperator, requireImpersonationRelationship } from '../src/services/impersonation';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000001');
const operator = asUserId('00000000-0000-7000-8000-000000000002');
const participant = asUserId('00000000-0000-7000-8000-000000000003');
const newcomer = asUserId('00000000-0000-7000-8000-000000000004');
let database: DatabaseSync;
afterEach(() => database?.close());
function seed() {
  database = migratedSqliteDatabase();
  for (const id of [operator, participant, newcomer]) database.prepare(`INSERT INTO users
    (id, email, name, platform_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')`)
    .run(id, `${id}@rallywith.ai`, id, id);
  database.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Demo', 'demo', 'global', ?, 'now', 'now')`).run(workspaceId, operator);
  for (const id of [operator, participant, newcomer]) database.prepare(`INSERT INTO workspace_members
    (workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', 'now')`).run(workspaceId, id);
  database.prepare(`INSERT INTO demo_operations (operation_id, company_name, presenter_user_id, pack_version,
    cast_json, workspace_id, status, attempt, ready_at, created_at, updated_at)
    VALUES ('demo-operation', 'Demo', ?, '1', ?, ?, 'ready', 1, 'now', 'now', 'now')`)
    .run(operator, JSON.stringify({ presenter: operator, participant }), workspaceId);
  return sqliteD1(database);
}

describe('workspace impersonation authority', () => {
  it('provisions directed and self relationships idempotently without restoring revocations', async () => {
    const db = seed();
    await provisionImpersonationRelationships(db, workspaceId, [operator, participant], 'demo-operation');
    expect(database.prepare('SELECT count(*) AS n FROM impersonation_relationships').get()).toEqual({ n: 4 });
    await requireImpersonationRelationship(db, workspaceId, operator, operator);
    await requireImpersonationRelationship(db, workspaceId, operator, participant);
    database.prepare('UPDATE impersonation_relationships SET revoked_at = ? WHERE operator_user_id = ? AND represented_user_id = ?')
      .run('now', operator, participant);
    await provisionImpersonationRelationships(db, workspaceId, [operator, participant], 'demo-operation');
    await expect(requireImpersonationRelationship(db, workspaceId, operator, participant)).rejects.toMatchObject({ code: 'impersonation_denied' });
    await requireImpersonationRelationship(db, workspaceId, participant, operator);
    await expect(requireImpersonationRelationship(db, workspaceId, operator, newcomer)).rejects.toMatchObject({ code: 'impersonation_denied' });
  });
  it('requires a trusted company identity, original cast, and a published live demo', async () => {
    const db = seed();
    expect((await requireDemoOperator(db, workspaceId, operator, 'global')).cast).toEqual([operator, participant]);
    await expect(requireDemoOperator(db, workspaceId, newcomer, 'global')).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
    for (const email of ['outside@example.com', 'a@sub.rallywith.ai', 'a@rallywith.ai.example.com']) {
      database.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, operator);
      await expect(requireDemoOperator(db, workspaceId, operator, 'global')).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
    }
    database.prepare('UPDATE users SET email = ? WHERE id = ?').run('operator@rallywith.ai', operator);
    database.prepare('UPDATE demo_operations SET ready_at = NULL').run();
    await expect(requireDemoOperator(db, workspaceId, operator, 'global')).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
    database.prepare("UPDATE demo_operations SET ready_at = 'now', retired_at = 'now'").run();
    await expect(requireDemoOperator(db, workspaceId, operator, 'global')).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
    database.prepare('DELETE FROM demo_operations').run();
    await expect(requireDemoOperator(db, workspaceId, operator, 'global')).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
  });
});
