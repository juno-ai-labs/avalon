import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function workflow(name) {
  const source = await readFile(join(repositoryDirectory, '.github/workflows', name), 'utf8');
  return parse(source);
}

function stepsById(job) {
  return Object.fromEntries(job.steps.filter(({ id }) => id).map((step) => [step.id, step]));
}

function assertPinnedActions(job) {
  for (const step of job.steps) {
    if (!step.uses) continue;
    assert.match(step.uses, /@[0-9a-f]{40}$/u, `${step.name} must pin its action to a commit`);
  }
}

test('the reusable workflow admits only protected-main release applies', async () => {
  const value = await workflow('migrate-supabase.yml');
  const resolveJob = value.jobs.resolve;
  const checkout = resolveJob.steps[0];
  const authorize = resolveJob.steps[1];

  assert.deepEqual(Object.keys(value.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(value.on.workflow_dispatch, null);
  assert.deepEqual(value.on.workflow_call.inputs, {
    ref: {
      description: 'Immutable protected-main revision to migrate',
      required: true,
      type: 'string',
    },
    release_gate: {
      description: 'Apply after planning as part of the serialized API release',
      required: true,
      type: 'boolean',
    },
  });
  assert.deepEqual(value.concurrency, {
    group: "${{ inputs.release_gate && format('avalon-nested-supabase-{0}', github.run_id) || format('avalon-supabase-preview-{0}', github.run_id) }}",
    'cancel-in-progress': false,
  });
  assert.equal(checkout.with.ref, '${{ inputs.ref || github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(authorize.id, 'revision');
  assert.deepEqual(authorize.env, { RELEASE_EVENT_NAME: '${{ github.event_name }}' });
  assert.match(authorize.run, /git fetch --no-tags origin main/u);
  assert.match(authorize.run, /git merge-base --is-ancestor "\$resolved_sha" "\$main_sha"/u);
  assert.match(authorize.run, /test "\$resolved_sha" = "\$main_sha"/u);
  assertPinnedActions(resolveJob);
});

test('both local schemas rebuild from the immutable revision before migration', async () => {
  const value = await workflow('migrate-supabase.yml');
  const validate = value.jobs.validate;
  const checkout = validate.steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
  const local = validate.steps.find(({ id }) => id === 'local_schema');
  const cleanup = validate.steps.find(({ name }) => name === 'Stop the local Supabase project');

  assert.equal(validate.needs, 'resolve');
  assert.equal(validate.strategy['fail-fast'], false);
  assert.deepEqual(validate.strategy.matrix.project, ['global', 'regional']);
  assert.equal(checkout.with.ref, '${{ needs.resolve.outputs.sha }}');
  assert.equal(local.run, [
    'set -euo pipefail',
    'pnpm postgres:${{ matrix.project }}:start',
    'pnpm postgres:${{ matrix.project }}:reset',
    'pnpm postgres:${{ matrix.project }}:test',
    '',
  ].join('\n'));
  assert.equal(cleanup.if, 'always()');
  assert.equal(cleanup.run, 'pnpm postgres:stop');
  assertPinnedActions(validate);
});

test('plans, applies, and histories bind each target to the exact schema and credential', async () => {
  const value = await workflow('migrate-supabase.yml');
  const migrate = value.jobs.migrate;
  const steps = stepsById(migrate);
  const expected = [
    {
      suffix: 'eu',
      schema: 'regional',
      secret: 'SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL',
    },
    {
      suffix: 'global_regional',
      schema: 'regional',
      secret: 'SUPABASE_GLOBAL_REGIONAL_MIGRATION_DATABASE_URL',
    },
    {
      suffix: 'global_control',
      schema: 'global',
      secret: 'SUPABASE_GLOBAL_CONTROL_MIGRATION_DATABASE_URL',
    },
  ];

  assert.deepEqual(migrate.needs, ['resolve', 'validate']);
  assert.equal('env' in migrate, false, 'production credentials must not be job-wide');
  assert.equal(
    migrate.steps.find(({ uses }) => uses?.startsWith('actions/checkout@')).with.ref,
    '${{ needs.resolve.outputs.sha }}',
  );
  const identitySteps = [
    {
      id: 'validate_target_eu',
      url: 'SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL',
      ref: 'SUPABASE_EU_REGIONAL_PROJECT_REF',
      region: 'SUPABASE_EU_REGIONAL_REGION',
      target: 'eu-product',
    },
    {
      id: 'validate_target_global_regional',
      url: 'SUPABASE_GLOBAL_REGIONAL_MIGRATION_DATABASE_URL',
      ref: 'SUPABASE_GLOBAL_REGIONAL_PROJECT_REF',
      region: 'SUPABASE_GLOBAL_REGIONAL_REGION',
      target: 'global-product',
    },
    {
      id: 'validate_target_global_control',
      url: 'SUPABASE_GLOBAL_CONTROL_MIGRATION_DATABASE_URL',
      ref: 'SUPABASE_GLOBAL_CONTROL_PROJECT_REF',
      region: 'SUPABASE_GLOBAL_CONTROL_REGION',
      target: 'global-control',
    },
  ];
  for (const identity of identitySteps) {
    assert.deepEqual(steps[identity.id].env, {
      SUPABASE_MANAGEMENT_API_TOKEN: '${{ secrets.SUPABASE_MANAGEMENT_API_TOKEN }}',
      [identity.url]: `\${{ secrets.${identity.url} }}`,
      [identity.ref]: `\${{ vars.${identity.ref} }}`,
      [identity.region]: `\${{ vars.${identity.region} }}`,
    });
    assert.equal(
      steps[identity.id].run,
      `node scripts/validate-supabase-migration-targets.mjs --target=${identity.target}`,
    );
  }
  assert.deepEqual(steps.validate_targets.env, {
    EU_PROJECT_REF: '${{ steps.validate_target_eu.outputs.project_ref }}',
    GLOBAL_PRODUCT_PROJECT_REF:
      '${{ steps.validate_target_global_regional.outputs.project_ref }}',
    GLOBAL_CONTROL_PROJECT_REF:
      '${{ steps.validate_target_global_control.outputs.project_ref }}',
  });
  assert.doesNotMatch(steps.validate_targets.run, /DATABASE_URL|MANAGEMENT_API_TOKEN/u);
  assertPinnedActions(migrate);
  for (const step of migrate.steps) {
    assert.equal(step['continue-on-error'], undefined, `${step.name} must fail closed`);
  }

  for (const target of expected) {
    const secretExpression = `\${{ secrets.${target.secret} }}`;
    assert.deepEqual(steps[`plan_${target.suffix}`].env, { DATABASE_URL: secretExpression });
    assert.equal(
      steps[`plan_${target.suffix}`].run,
      `pnpm exec supabase db push --workdir infrastructure/supabase/${target.schema} --db-url "$DATABASE_URL" --dry-run --skip-vault`,
    );

    assert.equal(steps[`apply_${target.suffix}`].if, 'inputs.release_gate');
    assert.deepEqual(steps[`apply_${target.suffix}`].env, { DATABASE_URL: secretExpression });
    assert.equal(
      steps[`apply_${target.suffix}`].run,
      `pnpm exec supabase db push --workdir infrastructure/supabase/${target.schema} --db-url "$DATABASE_URL" --yes --skip-vault`,
    );

    assert.equal(
      steps[`history_${target.suffix}`].if,
      "always() && steps.validate_targets.outcome == 'success'",
    );
    assert.deepEqual(steps[`history_${target.suffix}`].env, { DATABASE_URL: secretExpression });
    assert.equal(
      steps[`history_${target.suffix}`].run,
      `pnpm exec supabase migration list --workdir infrastructure/supabase/${target.schema} --db-url "$DATABASE_URL"`,
    );
  }

  const orderedIds = migrate.steps.map(({ id }) => id).filter(Boolean);
  assert.deepEqual(orderedIds.slice(orderedIds.indexOf('validate_target_eu')), [
    'validate_target_eu',
    'validate_target_global_regional',
    'validate_target_global_control',
    'validate_targets',
    'plan_eu',
    'plan_global_regional',
    'plan_global_control',
    'apply_eu',
    'apply_global_regional',
    'provision_storage_eu',
    'provision_storage_global_regional',
    'apply_global_control',
    'history_eu',
    'history_global_regional',
    'history_global_control',
  ]);
  const summary = migrate.steps.find(({ name }) => name === 'Record the fleet migration result');
  assert.equal(summary.if, 'always()');
  assert.match(summary.run, /fleet plan complete — no changes applied/u);
  assert.match(summary.run, /\| Target \| Plan \| Apply \| Storage \| History \|/u);
});

test('API preflight and optional fleet migration fail closed before Worker publication', async () => {
  const value = await workflow('deploy-api.yml');
  const paths = value.on.push.paths;
  const verify = value.jobs.verify;
  const preflight = value.jobs.preflight;
  const migration = value.jobs['migrate-postgres'];
  const deploy = value.jobs.deploy;

  assert.deepEqual(value.concurrency, {
    group: 'avalon-production-release',
    'cancel-in-progress': false,
    queue: 'single',
  });
  for (const path of [
    'package.json',
    'infrastructure/supabase/**',
    '.github/workflows/migrate-supabase.yml',
    'scripts/decide-supabase-migration.mjs',
    'scripts/provision-supabase-storage.mjs',
    'scripts/validate-supabase-migration-targets.mjs',
  ]) assert.ok(paths.includes(path), `deployment paths must include ${path}`);

  assert.equal(verify.outputs.verified_sha, '${{ steps.revision.outputs.sha }}');
  assert.equal(verify.outputs.migrate_postgres, '${{ steps.postgres.outputs.required }}');
  assert.equal(verify.steps.find(({ id }) => id === 'postgres').run, (
    'node scripts/decide-supabase-migration.mjs >> "$GITHUB_OUTPUT"'
  ));
  assert.equal(preflight.needs, 'verify');
  assert.equal(
    preflight.steps.find(({ uses }) => uses?.startsWith('actions/checkout@')).with.ref,
    '${{ needs.verify.outputs.verified_sha }}',
  );
  assert.ok(
    preflight.steps.findIndex(({ run }) => run?.includes('check-cloudflare-r2-buckets.mjs'))
      < preflight.steps.findIndex(({ run }) => run?.includes('build:eu')),
  );

  assert.deepEqual(migration.needs, ['verify', 'preflight']);
  assert.equal(migration.if, "needs.verify.outputs.migrate_postgres == 'true'");
  assert.equal(migration.uses, './.github/workflows/migrate-supabase.yml');
  assert.deepEqual(migration.with, {
    ref: '${{ needs.verify.outputs.verified_sha }}',
    release_gate: true,
  });
  assert.deepEqual(deploy.needs, ['verify', 'preflight', 'migrate-postgres']);
  assert.equal(
    deploy.if,
    "always() && needs.verify.result == 'success' && needs.preflight.result == 'success' && (needs.migrate-postgres.result == 'success' || needs.migrate-postgres.result == 'skipped')",
  );
  assertPinnedActions(verify);
  assertPinnedActions(preflight);
  assertPinnedActions(deploy);
});
