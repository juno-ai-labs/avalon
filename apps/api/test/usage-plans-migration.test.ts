import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

it('preserves existing plan history when admitting Max and Ultra transitions', () => {
  const db = new DatabaseSync(':memory:');
  const migration = (name: string) => readFileSync(new URL(`../../../packages/db/usage-migrations/${name}`, import.meta.url), 'utf8');
  try {
    db.exec(migration('0001_usage_ledger.sql'));
    db.exec(migration('0002_usage_events_sidekick.sql'));
    db.prepare('INSERT INTO usage_plan_changes VALUES (?, ?, ?, ?)').run('org', '2026-11-01', 'growth', 'starter');
    db.exec(migration('0003_expand_usage_plans.sql'));
    db.prepare('INSERT INTO usage_plan_changes VALUES (?, ?, ?, ?)').run('org', '2026-11-02', 'max', 'growth');
    db.prepare('INSERT INTO usage_plan_changes VALUES (?, ?, ?, ?)').run('org', '2026-11-03', 'ultra', 'max');
    expect(db.prepare('SELECT plan, previous_plan FROM usage_plan_changes ORDER BY effective_at').all()).toEqual([
      { plan: 'growth', previous_plan: 'starter' }, { plan: 'max', previous_plan: 'growth' }, { plan: 'ultra', previous_plan: 'max' },
    ]);
  } finally { db.close(); }
});
