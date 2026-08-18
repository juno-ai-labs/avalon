import { isEntryPoint } from './entry-point.mjs';

const PROJECT_REF = /^[a-z0-9]{20}$/u;
export const supabaseMigrationTargets = [
  {
    key: 'global-control',
    label: 'Global routing/control',
    kind: 'global-control',
    url: 'SUPABASE_GLOBAL_CONTROL_MIGRATION_DATABASE_URL',
    ref: 'SUPABASE_GLOBAL_CONTROL_PROJECT_REF',
    region: 'SUPABASE_GLOBAL_CONTROL_REGION',
  },
  {
    key: 'global-product',
    label: 'Global product',
    kind: 'regional-product',
    url: 'SUPABASE_GLOBAL_REGIONAL_MIGRATION_DATABASE_URL',
    ref: 'SUPABASE_GLOBAL_REGIONAL_PROJECT_REF',
    region: 'SUPABASE_GLOBAL_REGIONAL_REGION',
  },
  {
    key: 'eu-product',
    label: 'EU product',
    kind: 'regional-product',
    url: 'SUPABASE_EU_REGIONAL_MIGRATION_DATABASE_URL',
    ref: 'SUPABASE_EU_REGIONAL_PROJECT_REF',
    region: 'SUPABASE_EU_REGIONAL_REGION',
  },
];

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function projectRefFromDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Migration database URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Migration database URL must use postgres:// or postgresql://');
  }
  if (url.port === '6543') {
    throw new Error('Migration database URL must not use transaction-pooler port 6543');
  }

  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/u.exec(url.hostname)?.[1];
  const sessionPooler = /^postgres\.([a-z0-9]{20})$/u.exec(decodeURIComponent(url.username))?.[1];
  if (direct && sessionPooler && direct !== sessionPooler) {
    throw new Error('Migration database URL contains conflicting Supabase project refs');
  }
  const projectRef = direct ?? sessionPooler;
  if (!projectRef) {
    throw new Error('Migration database URL must identify its Supabase project ref');
  }
  return projectRef;
}

export async function validateSupabaseMigrationTarget(
  targetKey,
  environment = process.env,
  fetchProject = async (projectRef, token) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Supabase Management API rejected project ${projectRef}: ${response.status}`);
    }
    return response.json();
  },
) {
  const managementToken = required(environment, 'SUPABASE_MANAGEMENT_API_TOKEN');
  const target = resolveSupabaseMigrationTarget(targetKey, environment);
  const project = await fetchProject(target.projectRef, managementToken);
  if (!project || project.ref !== target.projectRef || project.region !== target.expectedRegion) {
    throw new Error(`${target.label} project identity or region does not match its configured slot`);
  }
  return {
    label: target.label,
    kind: target.kind,
    projectRef: target.projectRef,
    region: project.region,
  };
}

function resolveSupabaseMigrationTarget(targetKey, environment) {
  const target = supabaseMigrationTargets.find(({ key }) => key === targetKey);
  if (!target) throw new Error(`Unknown Supabase migration target: ${targetKey}`);
  const expectedRef = required(environment, target.ref);
  const expectedRegion = required(environment, target.region);
  if (!PROJECT_REF.test(expectedRef)) throw new Error(`${target.ref} is not a Supabase project ref`);
  const actualRef = projectRefFromDatabaseUrl(required(environment, target.url));
  if (actualRef !== expectedRef) {
    throw new Error(`${target.label} migration URL does not match ${target.ref}`);
  }
  return { ...target, projectRef: actualRef, expectedRegion };
}

export async function validateSupabaseMigrationTargets(
  environment = process.env,
  fetchProject,
) {
  const identities = supabaseMigrationTargets.map((target) => (
    resolveSupabaseMigrationTarget(target.key, environment)
  ));
  if (new Set(identities.map(({ projectRef }) => projectRef)).size !== identities.length) {
    throw new Error('Supabase migration targets must be three distinct projects');
  }
  return Promise.all(identities.map((target) => (
    validateSupabaseMigrationTarget(target.key, environment, fetchProject)
  )));
}

if (isEntryPoint(import.meta.url)) {
  const targetArgument = process.argv.slice(2).find((value) => value.startsWith('--target='));
  const targetKind = targetArgument?.slice('--target='.length);
  const resolved = targetKind
    ? [await validateSupabaseMigrationTarget(targetKind)]
    : await validateSupabaseMigrationTargets();
  for (const target of resolved) {
    console.log(`Validated Supabase migration target: ${target.label} (${target.projectRef}, ${target.region}, ${target.kind})`);
    if (process.env.GITHUB_OUTPUT) {
      const file = await import('node:fs/promises');
      await file.appendFile(process.env.GITHUB_OUTPUT, `project_ref=${target.projectRef}\n`, 'utf8');
    }
  }
}
