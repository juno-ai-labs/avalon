#!/usr/bin/env node

/**
 * Run the one-shot WorkspaceDO -> AutomationAgent authority cutover after both
 * regional Workers are healthy. Workspace identities come from regional D1;
 * all product-state audit, import, verification, and table removal happens in
 * the named WorkspaceDO reached through the existing regional command Queue.
 */
import { readFile } from "node:fs/promises";

import { createCloudflareClient } from "./configure-cloudflare-observability.mjs";
import { isEntryPoint } from "./entry-point.mjs";

const REGIONS = ["eu", "global"];
const QUEUE_BATCH_SIZE = 100;
const QUEUE_DRAIN_POLL_MS = 2_000;
const INVENTORY_PAGE_SIZE = 1_000;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: wall-clock milliseconds the cutover waits for both regional command
 *   queues to drain before it gives up and fails the deploy.
 * Without it: a consumer that cannot make progress — a WorkspaceDO wedged on a
 *   throwing migration, so every message retries forever without ever reaching
 *   the dead-letter queue the loop does watch — leaves this poll spinning, and
 *   the deploy job holds the release open until GitHub's own job timeout kills
 *   it hours later with no statement of what was stuck. Only our own operators
 *   can cause it, but the guard is not standing in for a bug: the wait is over a
 *   fleet-wide fan-out whose slowest member is not knowable from here.
 * Direction: a deadline; the open value is +Infinity, enforced through the
 *   finiteness guard below so no deadline is computed at all while it is open.
 * Trips: the run throws `automation_cutover_drain_timeout`, naming each region
 *   still holding a backlog. Nothing is rolled back — the cutover is one-shot
 *   per workspace and idempotent — so a rerun resumes where this one stopped.
 * Derive from: the fan-out against the queue's own throughput, not a benchmark.
 *   One message per workspace, each waking one WorkspaceDO that imports its
 *   automations over RPC; pick the wait from how long the slowest workspace's
 *   import may take multiplied by the batches ahead of it, plus the margin a
 *   failing deploy should not eat.
 */
export const AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS = Number.POSITIVE_INFINITY;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function databaseIdFromWranglerConfig(source) {
  const match = source.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/iu);
  if (!match) throw new Error("regional D1 database ID is missing from Wrangler config");
  return match[1];
}

function parseArguments(argv) {
  const args = argv.filter((argument) => argument !== "--");
  const regionValue = args.find((argument) => argument.startsWith("--region="))?.slice("--region=".length) ?? "all";
  if (regionValue !== "all" && !REGIONS.includes(regionValue)) throw new Error(`Unsupported region ${regionValue}`);
  const apply = args.includes("--apply");
  const preflight = args.includes("--preflight");
  if (apply && preflight) throw new Error("--apply and --preflight are mutually exclusive");
  return {
    apply,
    preflight,
    regions: regionValue === "all" ? REGIONS : [regionValue],
  };
}

function queueName(region) {
  return `avalon-${region}-migration-commands`;
}

function deadLetterQueueName(region) {
  return `${queueName(region)}-dead-letter`;
}

function rows(result) {
  const statements = Array.isArray(result) ? result : [result];
  if (statements.length !== 1 || statements[0]?.success !== true || !Array.isArray(statements[0].results)) {
    throw new Error("cloudflare_d1_workspace_inventory_invalid");
  }
  return statements[0].results;
}

/**
 * Every workspace in a region, read in keyset pages.
 *
 * The D1 query API answers with the whole result set in one JSON body and caps
 * that body, so an unpaged `SELECT id FROM workspaces` stops being the
 * inventory at some account size and starts being a prefix of it — silently,
 * because a short answer and a complete one are the same shape. The workspaces
 * past the cut would never be sent a cutover command, and the deploy that
 * replaces both Workers would still report success; each of them would then be
 * left serving `automation_cutover_in_progress` with no record of having been
 * skipped. Keyset on the primary key rather than OFFSET: the pages are read
 * across separate requests, and a workspace created between two of them shifts
 * every later offset by one, dropping a row that was already there.
 */
async function workspaceIds(cloudflare, databaseId, region) {
  const ids = [];
  for (let after = ""; ;) {
    const result = await cloudflare(`/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT id FROM workspaces WHERE region = ? AND id > ? ORDER BY id LIMIT ?",
        params: [region, after, INVENTORY_PAGE_SIZE],
      }),
    });
    const page = rows(result).map((row) => row.id);
    ids.push(...page);
    if (page.length < INVENTORY_PAGE_SIZE) return ids;
    after = page[page.length - 1];
  }
}

async function pagedRows(cloudflare, path) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const next = await cloudflare(`${path}${separator}page=${page}&per_page=${INVENTORY_PAGE_SIZE}`);
    if (!Array.isArray(next)) throw new Error("cloudflare_durable_object_inventory_invalid");
    result.push(...next);
    if (next.length < INVENTORY_PAGE_SIZE) return result;
  }
}

async function workspaceObjectIds(cloudflare, region) {
  const namespaces = await pagedRows(cloudflare, "/workers/durable_objects/namespaces");
  const matches = namespaces.filter((namespace) =>
    namespace.class === "WorkspaceDO" && namespace.script === `avalon-api-${region}`);
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
    throw new Error(`${region}_workspace_do_namespace_count_${matches.length}`);
  }
  const objects = await pagedRows(
    cloudflare,
    `/workers/durable_objects/namespaces/${encodeURIComponent(matches[0].id)}/objects`,
  );
  return objects
    .filter((object) => object.hasStoredData === true && typeof object.id === "string")
    .map((object) => object.id);
}

/**
 * One queue's backlog, or a failure — never a zero this script invented.
 *
 * `?? 0` here would be the worst possible default: a metrics response that
 * changed shape, or an error body that still parsed, would read as "the queue is
 * empty", which is the exact condition the drain loop treats as proof that every
 * workspace was cut over. An absent number is an unknown, and an unknown has to
 * stop the deploy rather than end the wait.
 */
async function queueMetrics(cloudflare, queueId) {
  const result = await cloudflare(`/queues/${queueId}/metrics`);
  const backlog = Number(result?.backlog_count);
  if (!Number.isFinite(backlog)) throw new Error(`cloudflare_queue_metrics_invalid:${queueId}`);
  return backlog;
}

async function sendCommands(cloudflare, queueId, region, targets, runId, requestedAt, mode) {
  for (let offset = 0; offset < targets.length; offset += QUEUE_BATCH_SIZE) {
    const messages = targets.slice(offset, offset + QUEUE_BATCH_SIZE).map((target) => ({
      body: {
        commandId: crypto.randomUUID(),
        runId,
        className: "WorkspaceDO",
        objectId: mode === "preflight" ? target : null,
        objectName: mode === "preflight" ? null : `${region}:${target}`,
        region,
        requestedAt,
        ...(mode === "cutover" ? { automationCutover: { workspaceId: target } } : {}),
      },
      content_type: "json",
    }));
    await cloudflare(`/queues/${queueId}/messages/batch`, {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
  }
}

export async function cutoverAutomationAgents({
  argv = process.argv.slice(2),
  environment = process.env,
  fetcher = fetch,
  read = readFile,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  // Carrying the one constant through a parameter, which is what lets a test
  // pass a finite deadline and prove the trip while the shipped value is open.
  drainTimeoutMs = AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS,
  logger = console,
} = {}) {
  const options = parseArguments(argv);
  const cloudflare = createCloudflareClient({
    accountId: required(environment, "CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required(environment, "CLOUDFLARE_API_TOKEN"),
    fetchImplementation: fetcher,
  });
  const queueRows = await cloudflare("/queues");
  const queues = new Map(queueRows.map((queue) => [queue.queue_name, queue.queue_id]));
  const inventories = [];
  for (const region of options.regions) {
    const config = await read(new URL(`../apps/api/wrangler.${region === "global" ? "global" : "eu"}.jsonc`, import.meta.url), "utf8");
    const queueId = queues.get(queueName(region));
    const deadLetterQueueId = queues.get(deadLetterQueueName(region));
    if (!queueId || !deadLetterQueueId) throw new Error(`${region}_automation_cutover_queue_missing`);
    const ids = await workspaceIds(cloudflare, databaseIdFromWranglerConfig(config), region);
    const objectIds = options.preflight ? await workspaceObjectIds(cloudflare, region) : [];
    if (options.preflight && objectIds.length !== ids.length) {
      throw new Error(`${region}_workspace_do_inventory_mismatch:d1=${ids.length}:stored=${objectIds.length}`);
    }
    inventories.push({
      region,
      queueId,
      deadLetterQueueId,
      workspaceIds: ids,
      objectIds,
    });
  }
  const mode = options.preflight ? "preflight" : options.apply ? "apply" : "dry-run";
  const summary = Object.fromEntries(inventories.map((inventory) => [inventory.region, {
    workspaces: inventory.workspaceIds.length,
    ...(options.preflight ? { storedWorkspaceObjects: inventory.objectIds.length } : {}),
    queue: queueName(inventory.region),
  }]));
  logger.log(JSON.stringify({ mode, regions: summary }, null, 2));
  if (!options.apply && !options.preflight) return { mode, dispatched: 0, regions: summary };

  const initialDeadLetters = new Map(await Promise.all(inventories.map(async (inventory) => [
    inventory.region,
    await queueMetrics(cloudflare, inventory.deadLetterQueueId),
  ])));
  const runId = crypto.randomUUID();
  const requestedAt = Date.now();
  let dispatched = 0;
  for (const inventory of inventories) {
    await sendCommands(
      cloudflare,
      inventory.queueId,
      inventory.region,
      options.preflight ? inventory.objectIds : inventory.workspaceIds,
      runId,
      requestedAt,
      options.preflight ? "preflight" : "cutover",
    );
    dispatched += options.preflight ? inventory.objectIds.length : inventory.workspaceIds.length;
  }
  // The wait comes first, deliberately. Queue metrics are eventually
  // consistent, so a backlog read taken the instant the last batch was accepted
  // can still answer with the pre-dispatch count — zero — and break the loop
  // having proved nothing at all about the messages just sent. Sleeping one
  // poll interval before the first read costs a single interval on a deploy
  // that already waits minutes, and removes the one way this loop can report a
  // drain that never happened.
  const deadline = Number.isFinite(drainTimeoutMs) ? Date.now() + drainTimeoutMs : null;
  for (;;) {
    await wait(QUEUE_DRAIN_POLL_MS);
    const state = await Promise.all(inventories.map(async (inventory) => ({
      region: inventory.region,
      backlog: await queueMetrics(cloudflare, inventory.queueId),
      deadLetters: await queueMetrics(cloudflare, inventory.deadLetterQueueId),
    })));
    for (const current of state) {
      if (current.deadLetters > initialDeadLetters.get(current.region)) {
        throw new Error(`${current.region}_automation_cutover_dead_letter_increased`);
      }
    }
    if (state.every((current) => current.backlog === 0)) break;
    if (deadline !== null && Date.now() >= deadline) {
      const stuck = state.filter((current) => current.backlog > 0)
        .map((current) => `${current.region}=${current.backlog}`).join(",");
      throw new Error(`automation_cutover_drain_timeout:${stuck}`);
    }
  }
  return { mode, runId, dispatched, regions: summary };
}

if (isEntryPoint(import.meta.url)) {
  cutoverAutomationAgents({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
