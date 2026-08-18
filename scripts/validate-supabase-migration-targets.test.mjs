import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectRefFromDatabaseUrl,
  validateSupabaseMigrationTarget,
  validateSupabaseMigrationTargets,
} from './validate-supabase-migration-targets.mjs';

const refs = {
  control: 'abcdefghijklmnopqrst',
  global: 'bcdefghijklmnopqrstu',
  eu: 'cdefghijklmnopqrstuv',
};

function direct(projectRef) {
  return `postgresql://postgres:password@db.${projectRef}.supabase.co:5432/postgres`;
}

function session(projectRef) {
  return `postgresql://postgres.${projectRef}:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
}

function environment(overrides = {}) {
  return {
    SUPABASE_GLOBAL_CONTROL_MIGRATION_DATABASE_URL: direct(refs.control),
    SUPABASE_GLOBAL_CONTROL_PROJECT_REF: refs.control,
    SUPABASE_GLOBAL_CONTROL_REGION: 'us-east-1',
    SUPABASE_GLOBAL_REGIONAL_MIGRATION_DATABASE_URL: session(refs.global),
    SUPABASE_GLOBAL_REGIONAL_PROJECT_REF: refs.global,
    SUPABASE_GLOBAL_REGIONAL_REGION: 'us-east-1',
    SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL: session(refs.eu),
    SUPABASE_EU_REGIONAL_PROJECT_REF: refs.eu,
    SUPABASE_EU_REGIONAL_REGION: 'eu-west-1',
    SUPABASE_MANAGEMENT_API_TOKEN: 'test-management-token',
    ...overrides,
  };
}

test('extracts immutable project identity from direct and session-mode URLs', () => {
  assert.equal(projectRefFromDatabaseUrl(direct(refs.control)), refs.control);
  assert.equal(projectRefFromDatabaseUrl(session(refs.global)), refs.global);
  assert.throws(
    () => projectRefFromDatabaseUrl(session(refs.eu).replace(':5432/', ':6543/')),
    /must not use transaction-pooler/u,
  );
  assert.throws(
    () => projectRefFromDatabaseUrl('https://example.com'),
    /must use postgres/u,
  );
});

test('accepts three distinct hosted projects in their configured kind and region slots', async () => {
  const regions = new Map([
    [refs.control, 'us-east-1'], [refs.global, 'us-east-1'], [refs.eu, 'eu-west-1'],
  ]);
  assert.deepEqual(await validateSupabaseMigrationTargets(
    environment(),
    async (projectRef, token) => {
      assert.equal(token, 'test-management-token');
      return { ref: projectRef, region: regions.get(projectRef) };
    },
  ), [
    { label: 'Global routing/control', kind: 'global-control', projectRef: refs.control, region: 'us-east-1' },
    { label: 'Global product', kind: 'regional-product', projectRef: refs.global, region: 'us-east-1' },
    { label: 'EU product', kind: 'regional-product', projectRef: refs.eu, region: 'eu-west-1' },
  ]);
});

test('validates one target without requiring another target credential', async () => {
  const isolated = {
    SUPABASE_MANAGEMENT_API_TOKEN: 'test-management-token',
    SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL: direct(refs.eu),
    SUPABASE_EU_REGIONAL_PROJECT_REF: refs.eu,
    SUPABASE_EU_REGIONAL_REGION: 'eu-west-1',
  };
  assert.deepEqual(await validateSupabaseMigrationTarget(
    'eu-product',
    isolated,
    async (projectRef, token) => {
      assert.equal(token, 'test-management-token');
      return { ref: projectRef, region: 'eu-west-1' };
    },
  ), {
    label: 'EU product',
    kind: 'regional-product',
    projectRef: refs.eu,
    region: 'eu-west-1',
  });
});

test('rejects a mismatched or duplicate regional target before any migration plan', async () => {
  await assert.rejects(
    validateSupabaseMigrationTargets(environment({
      SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL: session(refs.global),
    })),
    /EU product migration URL does not match/u,
  );
  await assert.rejects(
    validateSupabaseMigrationTargets(environment({
      SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL: session(refs.global),
      SUPABASE_EU_REGIONAL_PROJECT_REF: refs.global,
    })),
    /three distinct projects/u,
  );
});

test('rejects a hosted project in the wrong region before migration planning', async () => {
  await assert.rejects(
    validateSupabaseMigrationTargets(
      environment(),
      async (projectRef) => ({ ref: projectRef, region: 'us-east-1' }),
    ),
    /EU product project identity or region does not match/u,
  );
});
