import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideSupabaseMigration,
  migrationOwnedFilesChanged,
  packageMigrationInputsChanged,
  productDataAuthority,
} from './decide-supabase-migration.mjs';

const wrangler = (authority) => `{"vars":{"PRODUCT_DATA_AUTHORITY":"${authority}"}}`;
const readWrangler = (authorities) => async (path) => (
  path.includes('global') ? wrangler(authorities.global) : wrangler(authorities.eu)
);

test('product authority parsing fails closed on absent, repeated, or unknown values', () => {
  assert.equal(productDataAuthority(wrangler('d1'), 'global'), 'd1');
  assert.throws(() => productDataAuthority('{}', 'global'), /exactly once/u);
  assert.throws(
    () => productDataAuthority(`${wrangler('d1')} ${wrangler('postgres')}`, 'global'),
    /exactly once/u,
  );
  assert.throws(() => productDataAuthority(wrangler('other'), 'global'), /unsupported/u);
});

test('only migration-owned root package fields force a fleet gate', () => {
  const baseline = {
    version: '1.0.0',
    scripts: { test: 'node test.mjs', 'postgres:stop': 'supabase stop --all' },
    devDependencies: { supabase: '2.114.0' },
  };
  assert.equal(packageMigrationInputsChanged(baseline, { ...baseline, version: '1.1.0' }), false);
  assert.equal(packageMigrationInputsChanged(baseline, {
    ...baseline,
    devDependencies: { supabase: '2.115.0' },
  }), true);
  assert.equal(packageMigrationInputsChanged(baseline, {
    ...baseline,
    scripts: { ...baseline.scripts, 'postgres:stop': 'supabase stop --all --no-backup' },
  }), true);
  assert.equal(migrationOwnedFilesChanged(['apps/api/src/index.ts'], {}, {}), false);
  assert.equal(migrationOwnedFilesChanged(['pnpm-lock.yaml'], {}, {}), false);
  assert.equal(
    migrationOwnedFilesChanged(['infrastructure/supabase/regional/config.toml'], {}, {}),
    true,
  );
  assert.equal(
    migrationOwnedFilesChanged(['scripts/validate-supabase-migration-targets.mjs'], {}, {}),
    true,
  );
});

test('D1-only releases skip Postgres unless source changes or an operator forces it', async () => {
  const ordinary = await decideSupabaseMigration({
    environment: {},
    readFile: readWrangler({ global: 'd1', eu: 'd1' }),
  });
  assert.deepEqual(ordinary, { required: false, reasons: [] });

  const forced = await decideSupabaseMigration({
    environment: { FORCE_POSTGRES_MIGRATION: 'true' },
    readFile: readWrangler({ global: 'd1', eu: 'd1' }),
  });
  assert.deepEqual(forced, { required: true, reasons: ['operator'] });

  const active = await decideSupabaseMigration({
    environment: {},
    readFile: readWrangler({ global: 'd1', eu: 'shadow' }),
  });
  assert.deepEqual(active, { required: true, reasons: ['authority'] });
});

test('an initial push fails safe and requires the fleet gate', async () => {
  const decision = await decideSupabaseMigration({
    environment: { BEFORE_SHA: '0000000000000000000000000000000000000000' },
    readFile: readWrangler({ global: 'd1', eu: 'd1' }),
  });
  assert.deepEqual(decision, { required: true, reasons: ['migration-source'] });
});
