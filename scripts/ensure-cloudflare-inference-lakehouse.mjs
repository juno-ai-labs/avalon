/**
 * Ensure the complete regional inference lakehouse exists, then materialize
 * deploy-time Wrangler configs containing the stream IDs Cloudflare assigned.
 *
 * Pipelines resources are named and idempotently discovered, but a Worker
 * binding requires the stream's generated ID. Keeping that ID in a committed
 * Wrangler file would make first deployment manual. This preflight instead
 * creates the bucket, catalog, stream, sink, and pipeline from one manifest,
 * verifies immutable existing resources, and writes ignored configs beside the
 * originals so every relative Wrangler path keeps the same meaning.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repositoryDirectory, 'config/inference-lakehouse.json');
const API_BASE = 'https://api.cloudflare.com/client/v4';
const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;
const SAFE_PIPELINE_ENTITY = /^[a-z][a-z0-9_]{2,127}$/u;
const REGIONS = ['eu', 'global'];

class CloudflareApiError extends Error {
  constructor(message, { status, codes = [] } = {}) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.codes = codes;
  }
}

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to provision the inference lakehouse`);
  return value;
}

async function apiRequest({ accountId, token, fetchImpl }, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetchImpl(
    `${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`,
    { ...init, headers },
  );
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true) return body.result;
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const detail = errors.map((error) => `${error.message} [code: ${error.code}]`).join('; ');
  throw new CloudflareApiError(
    `Cloudflare ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    { status: response.status, codes: errors.map((error) => error.code) },
  );
}

function isMissing(error, codes = []) {
  return error instanceof CloudflareApiError
    && (error.status === 404 || error.codes.some((code) => codes.includes(code)));
}

function jurisdictionHeaders(region) {
  return region.jurisdiction === 'eu' ? { 'cf-r2-jurisdiction': 'eu' } : {};
}

function assertManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.binding !== 'INFERENCE_LAKEHOUSE') {
    throw new Error('Unsupported inference lakehouse manifest version or binding');
  }
  for (const name of [manifest.namespace, manifest.table]) {
    if (!SAFE_PIPELINE_ENTITY.test(name)) throw new Error(`Unsafe Data Catalog name: ${name}`);
  }
  for (const regionName of REGIONS) {
    const region = manifest.regions?.[regionName];
    if (!region) throw new Error(`Inference lakehouse manifest is missing ${regionName}`);
    if (!SAFE_BUCKET.test(region.bucket)) throw new Error(`Unsafe ${regionName} lakehouse bucket`);
    for (const [kind, name] of Object.entries({
      stream: region.stream,
      sink: region.sink,
      pipeline: region.pipeline,
    })) {
      if (!SAFE_PIPELINE_ENTITY.test(name)) {
        throw new Error(`Unsafe ${regionName} ${kind} name: ${String(name)}`);
      }
    }
    if (region.jurisdiction !== (regionName === 'eu' ? 'eu' : 'default')) {
      throw new Error(`${regionName} lakehouse has the wrong R2 jurisdiction`);
    }
  }
  return manifest;
}

export async function loadInferenceLakehouseManifest() {
  const manifest = assertManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const schemaPath = join(repositoryDirectory, manifest.streamSchema);
  const streamSchema = JSON.parse(await readFile(schemaPath, 'utf8'));
  if (!Array.isArray(streamSchema.fields) || streamSchema.fields.length === 0) {
    throw new Error('Inference lakehouse stream schema must declare fields');
  }
  return { ...manifest, streamSchema };
}

async function ensureBucket(client, regionName, region, create, log) {
  const path = `/r2/buckets/${region.bucket}`;
  try {
    const bucket = await apiRequest(client, path, { headers: jurisdictionHeaders(region) });
    if (bucket?.name !== region.bucket) throw new Error(`${regionName} R2 lookup returned the wrong bucket`);
    log(`Inference lakehouse bucket present: ${regionName}/${region.bucket} (${region.jurisdiction})`);
    return;
  } catch (error) {
    if (!isMissing(error, [10006])) throw error;
    if (!create) {
      throw new Error(
        `Missing inference lakehouse R2 bucket: ${regionName}/${region.bucket}`,
        { cause: error },
      );
    }
  }
  await apiRequest(client, '/r2/buckets', {
    method: 'POST',
    headers: jurisdictionHeaders(region),
    body: JSON.stringify({ name: region.bucket }),
  });
  log(`Created inference lakehouse bucket: ${regionName}/${region.bucket} (${region.jurisdiction})`);
}

async function ensureCatalog(client, regionName, region, create, log) {
  const path = `/r2-catalog/${region.bucket}`;
  try {
    const catalog = await apiRequest(client, path, { headers: jurisdictionHeaders(region) });
    if (catalog?.status === 'active') {
      log(`Inference Data Catalog active: ${regionName}/${region.bucket}`);
      return catalog;
    }
    if (!create) throw new Error(`Inference Data Catalog is not active: ${regionName}/${region.bucket}`);
  } catch (error) {
    if (!isMissing(error, [40401])) throw error;
    if (!create) {
      throw new Error(
        `Missing inference Data Catalog: ${regionName}/${region.bucket}`,
        { cause: error },
      );
    }
  }
  await apiRequest(client, `${path}/enable`, {
    method: 'POST',
    headers: jurisdictionHeaders(region),
  });
  const catalog = await apiRequest(client, path, { headers: jurisdictionHeaders(region) });
  if (catalog?.status !== 'active') {
    throw new Error(`Inference Data Catalog did not become active: ${regionName}/${region.bucket}`);
  }
  log(`Enabled inference Data Catalog: ${regionName}/${region.bucket}`);
  return catalog;
}

function comparableFields(fields) {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required === true,
    ...(field.items ? { items: comparableFields([field.items])[0] } : {}),
    ...(field.fields ? { fields: comparableFields(field.fields) } : {}),
  }));
}

function assertStream(stream, expectedName, expectedSchema) {
  if (stream.name !== expectedName) throw new Error(`Stream name drift: expected ${expectedName}`);
  if (stream.format?.type !== 'json') throw new Error(`${expectedName} must ingest JSON`);
  if (stream.http?.enabled !== false) throw new Error(`${expectedName} HTTP ingestion must stay disabled`);
  if (stream.worker_binding?.enabled !== true) throw new Error(`${expectedName} Worker binding must stay enabled`);
  const actual = JSON.stringify(comparableFields(stream.schema?.fields ?? []));
  const expected = JSON.stringify(comparableFields(expectedSchema.fields));
  if (actual !== expected) {
    throw new Error(`${expectedName} schema drifted; Pipeline stream schemas are immutable`);
  }
}

function assertSink(sink, expected, manifest) {
  if (sink.name !== expected.sink || sink.type !== 'r2_data_catalog') {
    throw new Error(`${expected.sink} has the wrong name or sink type`);
  }
  if (
    sink.config?.bucket !== expected.bucket
    || sink.config?.namespace !== manifest.namespace
    || sink.config?.table_name !== manifest.table
    || sink.config?.rolling_policy?.interval_seconds !== 300
  ) {
    throw new Error(`${expected.sink} destination or rolling policy drifted; sinks are immutable`);
  }
  if (sink.format?.type !== 'parquet' || sink.format?.compression !== 'zstd') {
    throw new Error(`${expected.sink} must write zstd-compressed Parquet`);
  }
}

function normalizedSql(value) {
  return value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
}

function assertPipeline(pipeline, expectedName, expectedSql) {
  if (pipeline.name !== expectedName || normalizedSql(pipeline.sql ?? '') !== normalizedSql(expectedSql)) {
    throw new Error(`${expectedName} SQL drifted from the checked-in inference lakehouse manifest`);
  }
}

async function namedEntity(client, kind, name) {
  const result = await apiRequest(client, `/pipelines/v1/${kind}?name=${encodeURIComponent(name)}&per_page=100`);
  const matches = (Array.isArray(result) ? result : []).filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${kind} named ${name}`);
  const match = matches[0];
  return match ? apiRequest(client, `/pipelines/v1/${kind}/${match.id}`) : null;
}

async function ensureStream(client, region, schema, create, log) {
  let stream = await namedEntity(client, 'streams', region.stream);
  if (!stream) {
    if (!create) throw new Error(`Missing inference Pipeline stream: ${region.stream}`);
    stream = await apiRequest(client, '/pipelines/v1/streams', {
      method: 'POST',
      body: JSON.stringify({
        name: region.stream,
        format: { type: 'json' },
        http: { enabled: false, authentication: true },
        worker_binding: { enabled: true },
        schema,
      }),
    });
    log(`Created inference Pipeline stream: ${region.stream} (${stream.id})`);
  } else {
    log(`Inference Pipeline stream present: ${region.stream} (${stream.id})`);
  }
  assertStream(stream, region.stream, schema);
  return stream;
}

async function ensureSink(client, region, manifest, token, create, log) {
  let sink = await namedEntity(client, 'sinks', region.sink);
  if (!sink) {
    if (!create) throw new Error(`Missing inference Data Catalog sink: ${region.sink}`);
    sink = await apiRequest(client, '/pipelines/v1/sinks', {
      method: 'POST',
      body: JSON.stringify({
        name: region.sink,
        type: 'r2_data_catalog',
        format: { type: 'parquet', compression: 'zstd' },
        config: {
          bucket: region.bucket,
          namespace: manifest.namespace,
          table_name: manifest.table,
          token,
          rolling_policy: { interval_seconds: 300 },
        },
      }),
    });
    log(`Created inference Data Catalog sink: ${region.sink} (${sink.id})`);
  } else {
    log(`Inference Data Catalog sink present: ${region.sink} (${sink.id})`);
  }
  assertSink(sink, region, manifest);
  return sink;
}

async function ensurePipeline(client, region, create, log) {
  const sql = `INSERT INTO ${region.sink} SELECT * FROM ${region.stream};`;
  let pipeline = await namedEntity(client, 'pipelines', region.pipeline);
  if (!pipeline) {
    if (!create) throw new Error(`Missing inference Pipeline: ${region.pipeline}`);
    pipeline = await apiRequest(client, '/pipelines/v1/pipelines', {
      method: 'POST',
      body: JSON.stringify({ name: region.pipeline, sql }),
    });
    log(`Created inference Pipeline: ${region.pipeline} (${pipeline.id})`);
  } else {
    log(`Inference Pipeline present: ${region.pipeline} (${pipeline.id})`);
  }
  assertPipeline(pipeline, region.pipeline, sql);
  return pipeline;
}

export async function materializeInferenceLakehouseWranglerConfigs(
  manifest,
  resources,
  options = {},
) {
  const outputDirectory = options.outputDirectory ?? join(repositoryDirectory, 'apps/api');
  const written = {};
  for (const regionName of REGIONS) {
    const sourcePath = join(repositoryDirectory, `apps/api/wrangler.${regionName}.jsonc`);
    const config = parseWranglerConfig(await readFile(sourcePath, 'utf8'));
    config.pipelines = [{ binding: manifest.binding, stream: resources[regionName].stream.id }];
    const outputPath = join(outputDirectory, `.wrangler.inference.${regionName}.json`);
    await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    written[regionName] = outputPath;
  }
  return written;
}

export async function ensureInferenceLakehouse(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const create = options.create ?? true;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const manifest = options.manifest ?? await loadInferenceLakehouseManifest();
  assertManifest(manifest);
  const client = { accountId, token, fetchImpl };
  const resources = {};

  for (const regionName of REGIONS) {
    const region = manifest.regions[regionName];
    await ensureBucket(client, regionName, region, create, log);
    await ensureCatalog(client, regionName, region, create, log);
    const stream = await ensureStream(client, region, manifest.streamSchema, create, log);
    const sink = await ensureSink(client, region, manifest, token, create, log);
    const pipeline = await ensurePipeline(client, region, create, log);
    resources[regionName] = { stream, sink, pipeline };
  }

  const configs = options.materializeBindings
    ? await materializeInferenceLakehouseWranglerConfigs(manifest, resources, options)
    : undefined;
  return { manifest, resources, configs };
}

if (isEntryPoint(import.meta.url)) {
  const check = process.argv.includes('--check');
  const materializeBindings = process.argv.includes('--materialize-bindings');
  await ensureInferenceLakehouse({ create: !check, materializeBindings });
}
