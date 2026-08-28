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

async function workspaceIds(cloudflare, databaseId, region) {
  const result = await cloudflare(`/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT id FROM workspaces WHERE region = ? ORDER BY id",
      params: [region],
    }),
  });
  return rows(result).map((row) => row.id);
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

async function queueMetrics(cloudflare, queueId) {
  const result = await cloudflare(`/queues/${queueId}/metrics`);
  return Number(result?.backlog_count ?? 0);
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
  for (;;) {
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
    await wait(QUEUE_DRAIN_POLL_MS);
  }
  return { mode, runId, dispatched, regions: summary };
}

if (isEntryPoint(import.meta.url)) {
  cutoverAutomationAgents({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
