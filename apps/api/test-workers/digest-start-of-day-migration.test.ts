/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';

const AT = '2026-10-15T00:00:00.000Z';

it('moves every stored digest to 07:45, keeps the evening, and marks each for the default destinations', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('digest-start-of-day');
  await stub.ping();
  const migrations = WORKSPACE_DO_SCHEMA_MIGRATIONS;
  const through = migrations.findIndex((migration) => migration.description === 'every digest sends at the start of the day at 07:45') + 1;
  expect(through).toBeGreaterThan(0);

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: migrations.slice(0, through - 1), component: 'workspace_do', workerVersionId: 'before', now: 1 });
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, 'workspace', 'global', 'wnam', 1, 1)`);
    const schedule = (id: string, dayMask: number, enabled: number, times: number[], email: boolean) => {
      sql.exec(
        `INSERT INTO digest_schedules (id, workspace_id, user_id, day_mask, enabled, execution_principal_json, version, created_at, updated_at)
         VALUES (?, 'workspace', ?, ?, ?, '{}', 1, ?, ?)`,
        id, `user-${id}`, dayMask, enabled, AT, AT,
      );
      for (const minute of times) {
        sql.exec('INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day) VALUES (?, ?)', id, minute);
      }
      if (email) {
        sql.exec(
          `INSERT INTO digest_delivery_targets (id, workspace_id, digest_schedule_id, user_id, target_type, email_address, status, created_at, updated_at)
           VALUES (?, 'workspace', ?, ?, 'email', 'person@example.com', 'active', ?, ?)`,
          `target-${id}`, id, `user-${id}`, AT, AT,
        );
      }
    };
    // The old default, morning and evening, already derived.
    schedule('default', 62, 1, [540, 1050], true);
    sql.exec(
      `INSERT INTO schedules (id, workspace_id, connector_connection_id, digest_schedule_id, schedule_type, rrule,
         interval_seconds, timezone, next_run_at, last_run_at, enabled, version, created_at, updated_at)
       VALUES ('derived', 'workspace', NULL, 'default', 'calendar', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
         NULL, 'Europe/London', ?, NULL, 1, 1, ?, ?)`,
      AT, AT, AT,
    );
    // Evening only, switched off, no days.
    schedule('evening', 0, 0, [1050], true);
    // Nowhere to send it.
    schedule('nowhere', 62, 0, [540], false);
  });

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: migrations.slice(0, through), component: 'workspace_do', workerVersionId: 'after', now: 2 });
    const sql = state.storage.sql;
    expect(sql.exec(`SELECT digest_schedule_id AS id, minute_of_day AS minute FROM digest_schedule_times ORDER BY id, minute`).toArray()).toEqual([
      { id: 'default', minute: 465 },
      { id: 'default', minute: 1050 },
      { id: 'evening', minute: 465 },
      { id: 'evening', minute: 1050 },
      { id: 'nowhere', minute: 465 },
    ]);
    // Switching on waits for the reconciler, which adds the destinations.
    expect(sql.exec('SELECT id, day_mask, enabled, default_destinations_pending AS pending FROM digest_schedules ORDER BY id').toArray()).toEqual([
      { id: 'default', day_mask: 62, enabled: 1, pending: 1 },
      { id: 'evening', day_mask: 62, enabled: 0, pending: 1 },
      { id: 'nowhere', day_mask: 62, enabled: 0, pending: 1 },
    ]);
    // Left for the reconciler to derive again in the owner's timezone.
    expect(sql.exec('SELECT COUNT(*) AS count FROM schedules WHERE digest_schedule_id IS NOT NULL').one()).toEqual({ count: 0 });
    expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
  });
});
