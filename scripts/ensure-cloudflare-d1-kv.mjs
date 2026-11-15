/**
 * Make every D1 database and pinned KV namespace the Wrangler files declare
 * exist, and pin the account's real ids into those files before anything
 * deploys.
 *
 * A D1 binding and a KV binding with an `id` name a resource Wrangler will
 * neither create nor look up: the committed id is the only link. That made a
 * fresh account (an open-source deployment included) a list of hand steps:
 * create each database, then edit its id into every file that binds it. Here
 * the resource's name is the source of truth instead. Each D1 database is found
 * by its `database_name`; each pinned KV namespace by a title equal to its
 * binding name. Whatever the account lacks is created, and every file's id is
 * rewritten to the account's. In the production account the committed ids
 * already match and nothing changes; in another account the checkout is edited
 * in place for the rest of the job and never committed.
 *
 * KV bindings with no `id` are left to Wrangler, which provisions them on first
 * deploy. Test configs carry placeholder ids and are skipped.
 *
 * `--check` is read-only: it fails if a resource is missing or a committed id
 * differs from the account's, without creating or writing anything.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const SKIPPED_CONFIG = /\.(?:test|dry-run|scratch)\.jsonc$/u;
const PERMISSION_ERROR_CODE = 10000;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 20;

/** Every tracked deploy or migration config under apps/, test and dry-run copies excluded. */
export async function deployConfigPaths(root = repositoryDirectory) {
  const paths = [];
  for (const app of await readdir(join(root, 'apps'), { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    for (const file of await readdir(join(root, 'apps', app.name))) {
      // `platform.wrangler.jsonc` is migration-only but pins the same database.
      if (/^(?:[\w-]+\.)?wrangler(?:\.[\w-]+)*\.jsonc$/u.test(file) && !SKIPPED_CONFIG.test(file)) paths.push(join(root, 'apps', app.name, file));
    }
  }
  return paths.sort();
}

function assertSafe(kind, name, where) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) throw new Error(`Unsafe ${kind} name in ${where}: ${String(name)}`);
  return name;
}

/** The D1 databases and pinned KV namespaces one Wrangler file binds. */
export function storageFromWrangler(source, where) {
  const config = parseWranglerConfig(source);
  const databases = (config.d1_databases ?? []).map((binding) => {
    if (binding.jurisdiction) throw new Error(`${where}/${binding.binding}: a D1 jurisdiction is not provisioned here`);
    return { name: assertSafe('D1', binding.database_name, where), id: binding.database_id ?? null };
  });
  const namespaces = (config.kv_namespaces ?? []).filter((binding) => binding.id !== undefined)
    .map((binding) => ({ title: assertSafe('KV', binding.binding, where), id: binding.id }));
  return { databases, namespaces };
}

/**
 * Rewrite ids in place, keeping comments and layout. A D1 object is found by
 * its `database_name`, a KV object by its `binding` inside `kv_namespaces`.
 */
export function pinStorageIds(source, { databases = {}, namespaces = {} }) {
  let output = source.replace(/\{[^{}]*?"database_name"\s*:\s*"([^"]+)"[^{}]*?\}/gu, (object, name) => {
    const id = databases[name];
    if (!id) return object;
    if (/"database_id"\s*:/u.test(object)) return object.replace(/("database_id"\s*:\s*)"[^"]*"/u, `$1"${id}"`);
    return object.replace(/("database_name"\s*:\s*"[^"]+")/u, `$1, "database_id": "${id}"`);
  });
  const start = output.search(/"kv_namespaces"\s*:\s*\[/u);
  if (start >= 0) {
    const end = output.indexOf(']', start);
    const section = output.slice(start, end).replace(/\{[^{}]*?"binding"\s*:\s*"([^"]+)"[^{}]*?\}/gu, (object, binding) => {
      const id = namespaces[binding];
      return id && /"id"\s*:/u.test(object) ? object.replace(/("id"\s*:\s*)"[^"]*"/u, `$1"${id}"`) : object;
    });
    output = output.slice(0, start) + section + output.slice(end);
  }
  return output;
}

function describeFailure(response, body) {
  const detail = (body?.errors ?? []).map((error) => `${error.message} [code: ${error.code}]`).join('; ');
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

function permissionHint(response, body, permission) {
  const refused = response.status === 401 || response.status === 403 || (body?.errors ?? []).some((error) => error.code === PERMISSION_ERROR_CODE);
  return refused ? ` The token must hold ${permission}; docs/runbook.md lists the required permissions.` : '';
}

async function call(account, path, init = {}) {
  const response = await account.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}${path}`, {
    ...init, headers: { Authorization: `Bearer ${account.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return { response, body: await response.json().catch(() => null) };
}

/** Name -> id for every D1 database, or title -> id for every KV namespace. */
async function listAll(account, kind) {
  const path = kind === 'd1' ? '/d1/database' : '/storage/kv/namespaces';
  const ids = new Map();
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const { response, body } = await call(account, `${path}?page=${page}&per_page=${PAGE_SIZE}`);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Listing ${kind === 'd1' ? 'D1 databases' : 'KV namespaces'} failed with ${describeFailure(response, body)}.${permissionHint(response, body, kind === 'd1' ? 'D1 Edit' : 'Workers KV Storage Edit')}`);
    }
    const results = body.result ?? [];
    for (const item of results) ids.set(kind === 'd1' ? item.name : item.title, kind === 'd1' ? item.uuid : item.id);
    if (results.length < PAGE_SIZE) return ids;
  }
  throw new Error(`Listing ${kind} stopped after ${PAGE_LIMIT} pages without reaching the end; raise PAGE_LIMIT.`);
}

async function create(account, kind, name) {
  const { response, body } = kind === 'd1'
    ? await call(account, '/d1/database', { method: 'POST', body: JSON.stringify({ name }) })
    : await call(account, '/storage/kv/namespaces', { method: 'POST', body: JSON.stringify({ title: name }) });
  if (response.ok && body?.success === true) return kind === 'd1' ? body.result.uuid : body.result.id;
  const hint = permissionHint(response, body, kind === 'd1' ? 'D1 Edit' : 'Workers KV Storage Edit');
  const error = new Error(`Creating ${kind === 'd1' ? 'D1 database' : 'KV namespace'} ${name} failed with ${describeFailure(response, body)}.${hint}`);
  error.permission = Boolean(hint);
  throw error;
}

/** Create one resource, tolerating a concurrent deploy that created it first. */
async function ensureOne(account, kind, name, log) {
  try {
    const id = await create(account, kind, name);
    log(`Created ${kind === 'd1' ? 'D1 database' : 'KV namespace'} ${name}`);
    return id;
  } catch (error) {
    if (error.permission) throw error;
    const id = (await listAll(account, kind).catch(() => new Map())).get(name);
    if (!id) throw error;
    log(`${name} exists after this run's create was refused (${error.message}); a concurrent deployment created it`);
    return id;
  }
}

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to ensure Cloudflare D1 and KV resources exist`);
  return value;
}

export async function ensureD1AndKv(options = {}) {
  const environment = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const create = options.create ?? true;
  const account = {
    accountId: required('CLOUDFLARE_ACCOUNT_ID', environment),
    token: required('CLOUDFLARE_API_TOKEN', environment),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  const paths = options.paths ?? await deployConfigPaths();
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const declared = { d1: new Map(), kv: new Map() };
  for (const file of files) {
    const where = relative(repositoryDirectory, file.path);
    const { databases, namespaces } = storageFromWrangler(file.source, where);
    for (const database of databases) declared.d1.set(database.name, [...(declared.d1.get(database.name) ?? []), { where, id: database.id }]);
    for (const namespace of namespaces) declared.kv.set(namespace.title, [...(declared.kv.get(namespace.title) ?? []), { where, id: namespace.id }]);
  }

  const resolved = { d1: {}, kv: {} };
  const problems = [];
  for (const kind of ['d1', 'kv']) {
    if (declared[kind].size === 0) continue;
    const present = await listAll(account, kind);
    for (const [name, uses] of declared[kind]) {
      let id = present.get(name);
      if (!id && !create) { problems.push(`missing ${kind === 'd1' ? 'D1 database' : 'KV namespace'} ${name}`); continue; }
      id ??= await ensureOne(account, kind, name, log);
      resolved[kind][name] = id;
      for (const use of uses) {
        if (use.id === id) continue;
        if (!create) problems.push(`${use.where} pins ${name} to ${use.id ?? 'no id'}, but the account's is ${id}`);
        else log(`Pinning ${name} to ${id} in ${use.where} (was ${use.id ?? 'unset'})`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`D1/KV check failed:\n${problems.map((line) => `  ${line}`).join('\n')}\nThe deployment creates and pins these; to do it now, run \`pnpm cloudflare:d1-kv:ensure\`.`);
  }
  if (!create) { log('Every D1 database and pinned KV namespace exists with the committed id'); return resolved; }
  for (const file of files) {
    const pinned = pinStorageIds(file.source, { databases: resolved.d1, namespaces: resolved.kv });
    if (pinned !== file.source) await writeFile(file.path, pinned);
  }
  log(`D1 databases ready: ${Object.keys(resolved.d1).join(', ') || 'none'}; pinned KV namespaces ready: ${Object.keys(resolved.kv).join(', ') || 'none'}`);
  return resolved;
}

if (isEntryPoint(import.meta.url)) {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. The only flag is --check.`);
  await ensureD1AndKv({ create: !flags.includes('--check') });
}
