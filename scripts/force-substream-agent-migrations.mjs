import { configuredRegions, regions } from "./regions.mjs";
/**
 * Eagerly wake every stored AgentLoopDO so its constructor applies the
 * currently deployed object-local SQLite schema.
 *
 * This is an operator-run transport over the same regional migration-command
 * queues as the migration tracker. It does not read or rewrite transcript
 * payloads itself: each regional Worker addresses its own object by opaque ID,
 * runs the ordinary constructor migration path, and acknowledges only after
 * the RPC returns.
 */
import { isEntryPoint } from './entry-point.mjs';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const CLASS_NAME = 'AgentLoopDO';
const QUEUE_BATCH_SIZE = 100;
const OBJECT_PAGE_SIZE = 1_000;
const NAMESPACE_PAGE_SIZE = 1_000;
const QUEUE_DRAIN_POLL_MS = 2_000;
const REGIONS = configuredRegions;
const JURISDICTION_BY_REGION = Object.fromEntries(Object.entries(regions).map(([region, config]) => [region, config.jurisdiction]));

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArguments(argv) {
  const argumentsWithoutDelimiter = argv.filter((argument) => argument !== '--');
  const apply = argumentsWithoutDelimiter.includes('--apply');
  const regionArgument = argumentsWithoutDelimiter.find((argument) => argument.startsWith('--region='));
  const probeArgument = argumentsWithoutDelimiter.find(
    (argument) => argument.startsWith('--jurisdiction-probe-url='),
  );
  const region = regionArgument?.slice('--region='.length) ?? 'all';
  if (!['all', ...REGIONS].includes(region)) {
    throw new Error(`Unsupported region ${region}; expected all or a configured region`);
  }
  const unknown = argumentsWithoutDelimiter.filter(
    (argument) => argument !== '--apply'
      && !argument.startsWith('--region=')
      && !argument.startsWith('--jurisdiction-probe-url='),
  );
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}`);
  const jurisdictionProbeUrl = probeArgument?.slice('--jurisdiction-probe-url='.length) ?? null;
  if (jurisdictionProbeUrl !== null) {
    let parsedProbeUrl;
    try {
      parsedProbeUrl = new URL(jurisdictionProbeUrl);
    } catch {
      throw new Error('--jurisdiction-probe-url must be an HTTP URL');
    }
    if (!['http:', 'https:'].includes(parsedProbeUrl.protocol)) {
      throw new Error('--jurisdiction-probe-url must be an HTTP URL');
    }
  }
  return {
    apply,
    jurisdictionProbeUrl,
    regions: region === 'all' ? REGIONS : [region],
  };
}

function commandQueueName(region) {
  return `avalon-${region}-migration-commands`;
}

function deadLetterQueueName(region) {
  return `${commandQueueName(region)}-dead-letter`;
}

function workerName(region) {
  return `avalon-api-${region}`;
}

async function cloudflareRequest(credentials, path, options = {}, fetcher = fetch) {
  const response = await fetcher(
    `${API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}${path}`,
    {
      ...options,
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    },
  );
  const envelope = await response.json();
  if (!response.ok || envelope.success !== true) {
    const code = envelope.errors?.[0]?.code ?? response.status;
    throw new Error(`cloudflare_api_${code}`);
  }
  return envelope;
}

export async function listNamespaces(credentials, fetcher = fetch) {
  const namespaces = [];
  const seen = new Set();
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(NAMESPACE_PAGE_SIZE),
    });
    const envelope = await cloudflareRequest(
      credentials,
      `/workers/durable_objects/namespaces?${query}`,
      {},
      fetcher,
    );
    const rows = Array.isArray(envelope.result) ? envelope.result : [];
    let fresh = 0;
    for (const row of rows) {
      if (typeof row.id !== 'string' || seen.has(row.id)) continue;
      seen.add(row.id);
      namespaces.push(row);
      fresh += 1;
    }
    const totalPages = Number(envelope.result_info?.total_pages ?? page);
    if (page >= totalPages || rows.length < NAMESPACE_PAGE_SIZE) return namespaces;
    if (fresh === 0) throw new Error('cloudflare_namespace_pagination_did_not_advance');
  }
}

async function listQueues(credentials, fetcher) {
  const envelope = await cloudflareRequest(credentials, '/queues', {}, fetcher);
  return Array.isArray(envelope.result) ? envelope.result : [];
}

export async function listStoredObjects(credentials, namespaceId, fetcher = fetch) {
  const objects = [];
  const seenObjects = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(OBJECT_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const envelope = await cloudflareRequest(
      credentials,
      `/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects?${query}`,
      {},
      fetcher,
    );
    const rows = Array.isArray(envelope.result) ? envelope.result : [];
    for (const row of rows) {
      if (row.hasStoredData !== true || typeof row.id !== 'string' || seenObjects.has(row.id)) continue;
      seenObjects.add(row.id);
      objects.push(row.id);
    }
    const nextCursor = envelope.result_info?.cursor;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0 || rows.length === 0) return objects;
    if (seenCursors.has(nextCursor)) throw new Error('cloudflare_object_pagination_did_not_advance');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function classifyRegionalObjects(resource, objectIds, probeUrl, fetcher = fetch) {
  const response = await fetcher(probeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ region: resource.region, objectIds }),
  });
  if (!response.ok) throw new Error(`${resource.region}_jurisdiction_probe_${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload.objects) ? payload.objects : null;
  if (!rows || rows.length !== objectIds.length) {
    throw new Error(`${resource.region}_jurisdiction_probe_incomplete`);
  }
  const expectedIds = new Set(objectIds);
  const seenIds = new Set();
  const eligibleObjectIds = [];
  for (const row of rows) {
    if (typeof row.objectId !== 'string'
      || !expectedIds.has(row.objectId)
      || seenIds.has(row.objectId)
      || row.error !== undefined) {
      throw new Error(`${resource.region}_jurisdiction_probe_invalid`);
    }
    seenIds.add(row.objectId);
    if (row.jurisdiction === JURISDICTION_BY_REGION[resource.region]) {
      eligibleObjectIds.push(row.objectId);
    } else if (row.jurisdiction !== null && typeof row.jurisdiction !== 'string') {
      throw new Error(`${resource.region}_jurisdiction_probe_invalid`);
    }
  }
  return {
    eligibleObjectIds,
    skippedObjects: objectIds.length - eligibleObjectIds.length,
  };
}

function selectRegionalResources(namespaces, queues, regions) {
  return regions.map((region) => {
    const namespaceMatches = namespaces.filter((namespace) =>
      namespace.class === CLASS_NAME && namespace.script === workerName(region));
    if (namespaceMatches.length !== 1 || typeof namespaceMatches[0]?.id !== 'string') {
      throw new Error(`${region}_substream_agent_namespace_count_${namespaceMatches.length}`);
    }
    const commandMatches = queues.filter((queue) => queue.queue_name === commandQueueName(region));
    const deadLetterMatches = queues.filter((queue) => queue.queue_name === deadLetterQueueName(region));
    if (commandMatches.length !== 1 || typeof commandMatches[0]?.queue_id !== 'string') {
      throw new Error(`${region}_migration_command_queue_count_${commandMatches.length}`);
    }
    if (deadLetterMatches.length !== 1 || typeof deadLetterMatches[0]?.queue_id !== 'string') {
      throw new Error(`${region}_migration_dead_letter_queue_count_${deadLetterMatches.length}`);
    }
    return {
      region,
      namespaceId: namespaceMatches[0].id,
      queueId: commandMatches[0].queue_id,
      deadLetterQueueId: deadLetterMatches[0].queue_id,
    };
  });
}

async function queueMetrics(credentials, queueId, fetcher) {
  const envelope = await cloudflareRequest(
    credentials,
    `/queues/${encodeURIComponent(queueId)}/metrics`,
    {},
    fetcher,
  );
  return {
    backlogCount: Number(envelope.result?.backlog_count ?? 0),
    backlogBytes: Number(envelope.result?.backlog_bytes ?? 0),
  };
}

async function sendCommands(credentials, resource, objectIds, runId, requestedAt, fetcher) {
  let dispatched = 0;
  for (let index = 0; index < objectIds.length; index += QUEUE_BATCH_SIZE) {
    const slice = objectIds.slice(index, index + QUEUE_BATCH_SIZE);
    const messages = slice.map((objectId) => ({
      body: {
        commandId: crypto.randomUUID(),
        runId,
        className: CLASS_NAME,
        objectId,
        objectName: null,
        region: resource.region,
        requestedAt,
      },
      content_type: 'json',
    }));
    await cloudflareRequest(
      credentials,
      `/queues/${encodeURIComponent(resource.queueId)}/messages/batch`,
      { method: 'POST', body: JSON.stringify({ messages }) },
      fetcher,
    );
    dispatched += slice.length;
  }
  return dispatched;
}

async function waitForDrain(credentials, resources, initialDeadLetters, fetcher, wait) {
  for (;;) {
    const metrics = await Promise.all(resources.flatMap((resource) => [
      queueMetrics(credentials, resource.queueId, fetcher),
      queueMetrics(credentials, resource.deadLetterQueueId, fetcher),
    ]));
    const state = resources.map((resource, index) => ({
      region: resource.region,
      command: metrics[index * 2],
      deadLetter: metrics[index * 2 + 1],
    }));
    for (const current of state) {
      if (current.deadLetter.backlogCount > initialDeadLetters.get(current.region)) {
        throw new Error(`${current.region}_migration_dead_letter_increased`);
      }
    }
    if (state.every((current) => current.command.backlogCount === 0)) return state;
    await wait(QUEUE_DRAIN_POLL_MS);
  }
}

export async function forceSubstreamAgentMigrations({
  argv = process.argv.slice(2),
  environment = process.env,
  fetcher = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = console,
} = {}) {
  const options = parseArguments(argv);
  if (options.apply && !options.jurisdictionProbeUrl) {
    throw new Error('--jurisdiction-probe-url is required with --apply');
  }
  const credentials = {
    accountId: required(environment, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required(environment, 'CLOUDFLARE_API_TOKEN'),
  };
  const [namespaces, queues] = await Promise.all([
    listNamespaces(credentials, fetcher),
    listQueues(credentials, fetcher),
  ]);
  const resources = selectRegionalResources(namespaces, queues, options.regions);
  const rawInventories = await Promise.all(resources.map(async (resource) => ({
    resource,
    objectIds: await listStoredObjects(credentials, resource.namespaceId, fetcher),
  })));
  const inventories = options.jurisdictionProbeUrl
    ? await Promise.all(rawInventories.map(async ({ resource, objectIds }) => ({
        resource,
        objectIds,
        ...await classifyRegionalObjects(
          resource,
          objectIds,
          options.jurisdictionProbeUrl,
          fetcher,
        ),
      })))
    : rawInventories.map(({ resource, objectIds }) => ({
        resource,
        objectIds,
        eligibleObjectIds: null,
        skippedObjects: null,
      }));
  const summary = Object.fromEntries(inventories.map(({
    resource,
    objectIds,
    eligibleObjectIds,
    skippedObjects,
  }) => [
    resource.region,
    {
      storedObjects: objectIds.length,
      eligibleObjects: eligibleObjectIds?.length ?? null,
      skippedObjects,
      queue: commandQueueName(resource.region),
    },
  ]));
  logger.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', regions: summary }, null, 2));
  if (!options.apply) return { mode: 'dry-run', runId: null, dispatched: 0, regions: summary };

  const initialDeadLetters = new Map(await Promise.all(resources.map(async (resource) => [
    resource.region,
    (await queueMetrics(credentials, resource.deadLetterQueueId, fetcher)).backlogCount,
  ])));
  const runId = crypto.randomUUID();
  const requestedAt = Date.now();
  let dispatched = 0;
  for (const { resource, eligibleObjectIds } of inventories) {
    if (!eligibleObjectIds) throw new Error(`${resource.region}_jurisdiction_probe_missing`);
    dispatched += await sendCommands(
      credentials,
      resource,
      eligibleObjectIds,
      runId,
      requestedAt,
      fetcher,
    );
  }
  logger.log(JSON.stringify({ runId, dispatched, state: 'queued' }));
  const drained = await waitForDrain(credentials, resources, initialDeadLetters, fetcher, wait);
  logger.log(JSON.stringify({ runId, dispatched, state: 'drained', queues: drained }, null, 2));
  return { mode: 'apply', runId, dispatched, regions: summary, queues: drained };
}

if (isEntryPoint(import.meta.url)) {
  forceSubstreamAgentMigrations().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
