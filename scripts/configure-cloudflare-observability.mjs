import { createHash } from "node:crypto";

import { isEntryPoint } from "./entry-point.mjs";

const RETENTION_RULE_ID = "delete-observability-after-90-days";
const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const WORKERS_TRACE_DATASET = "workers_trace_events";

export const OBSERVABILITY_CONFIGURATIONS = Object.freeze([
  {
    region: "global",
    jurisdiction: "default",
    bucket: "avalon-global-observability",
    script: "avalon-api-global",
  },
  {
    region: "eu",
    jurisdiction: "eu",
    bucket: "avalon-eu-observability",
    script: "avalon-api-eu",
  },
]);

export const LOGPUSH_FIELD_NAMES = Object.freeze([
  "CPUTimeMs",
  "Entrypoint",
  "Event",
  "EventTimestampMs",
  "EventType",
  "Exceptions",
  "Logs",
  "Outcome",
  "ScriptName",
  "ScriptVersion",
  "WallTimeMs",
]);

function filter(key, operation, type, value) {
  return { kind: "filter", key, operation, type, value };
}

function group(filterCombination, filters) {
  return { kind: "group", filterCombination, filters };
}

const regionalServiceFilter = group("or", OBSERVABILITY_CONFIGURATIONS.map((configuration) =>
  filter("$metadata.service", "eq", "string", configuration.script)));

function savedQuery(name, description, filters) {
  return {
    name,
    description,
    parameters: {
      filterCombination: "and",
      filters: [regionalServiceFilter, ...filters],
      limit: 100,
    },
  };
}

export const SAVED_QUERY_DEFINITIONS = Object.freeze([
  savedQuery(
    "Avalon · Failures",
    "Errors from either regional Avalon API.",
    [filter("level", "eq", "string", "error")],
  ),
  savedQuery(
    "Avalon · Invalid model output",
    "Unrecoverable structured model output from either regional Avalon API.",
    [
      filter("event", "eq", "string", "request_failed"),
      filter("code", "eq", "string", "model_output_invalid"),
    ],
  ),
  savedQuery(
    "Avalon · Slow inference",
    "Automation compiler model responses slower than ten seconds.",
    [
      filter("event", "eq", "string", "automation_compiler"),
      filter("stage", "eq", "string", "model_response"),
      filter("latency_ms", "gt", "number", 10_000),
    ],
  ),
  savedQuery(
    "Avalon · Degraded connector workflows",
    "Connector poll timeouts and terminal provider failures.",
    [group("or", [
      filter("event", "eq", "string", "connector_poll_timeout"),
      filter("event", "eq", "string", "connector_poll_failed"),
    ])],
  ),
  savedQuery(
    "Avalon · Rejected model calls",
    "OpenRouter calls the provider refused, with its own rejection classification.",
    // Both conditions, not either: `provider_error_code` on its own would match
    // any future event that happens to carry the field, and an attempt that
    // failed without a provider classification is a transport failure rather
    // than a refusal, which is what this view is named for.
    [
      group("or", [
        filter("event", "eq", "string", "agent_inference_attempt_failed"),
        filter("event", "eq", "string", "structured_inference"),
      ]),
      filter("provider_error_code", "exists", "string"),
    ],
  ),
  savedQuery(
    "Avalon · Broken response contracts",
    "Responses that failed their own schema before leaving the Worker.",
    [
      filter("event", "eq", "string", "request_failed"),
      filter("error_name", "eq", "string", "ZodError"),
    ],
  ),
  savedQuery(
    "Avalon · Harness run outcomes",
    "Terminal root-run summaries from ordinary work streams.",
    [filter("event", "eq", "string", "harness_run_finished")],
  ),
  savedQuery(
    "Avalon · Slow root runs",
    "Terminal root runs whose end-to-end harness time exceeded one minute.",
    [
      filter("event", "eq", "string", "harness_run_finished"),
      filter("duration_ms", "gt", "number", 60_000),
    ],
  ),
  savedQuery(
    "Avalon · Slow Terminal bootstrap",
    "Managed Daytona compatibility installations slower than ten seconds.",
    [
      filter("event", "eq", "string", "terminal_daytona_operation_finished"),
      filter("operation", "eq", "string", "sandbox_bootstrap"),
      filter("install_duration_ms", "gt", "number", 10_000),
    ],
  ),
]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortObject(child)]));
}

function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function normalizeSavedQueryValue(value, key) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeSavedQueryValue(entry))
      .filter((entry) => entry !== undefined);
    if (normalized.length === 0) return undefined;
    if (key === "datasets" || key === "filters") {
      return normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    }
    return normalized;
  }
  if (!value || typeof value !== "object") return value;

  const normalized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "kind" && childValue === "filter") continue;
    const normalizedChild = normalizeSavedQueryValue(childValue, childKey);
    if (normalizedChild === undefined || normalizedChild === null) continue;
    if (childKey === "filterCombination" && typeof normalizedChild === "string") {
      normalized[childKey] = normalizedChild.toLowerCase();
    } else {
      normalized[childKey] = normalizedChild;
    }
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export function savedQueryMatchesDefinition(query, definition) {
  if (query.name !== definition.name || query.description !== definition.description) return false;
  return canonicalJson(normalizeSavedQueryValue(query.parameters))
    === canonicalJson(normalizeSavedQueryValue(definition.parameters));
}

export function assessSavedQueries(existing = [], definitions = SAVED_QUERY_DEFINITIONS) {
  const verified = [];
  const differences = [];
  for (const definition of definitions) {
    const matches = existing.filter((query) => query.name === definition.name);
    if (matches.length === 0) {
      differences.push({ kind: "missing", definition });
    } else if (matches.length > 1) {
      differences.push({ kind: "duplicated", definition, count: matches.length });
    } else if (!savedQueryMatchesDefinition(matches[0], definition)) {
      differences.push({ kind: "stale", definition });
    } else {
      verified.push(definition);
    }
  }
  return { verified, differences };
}

function savedQueryDifferenceMessage(difference) {
  if (difference.kind === "missing") {
    return `${difference.definition.name}: saved Workers Observability query is missing`;
  }
  if (difference.kind === "duplicated") {
    return `${difference.definition.name}: ${difference.count} saved queries exist; remove duplicates in the Cloudflare dashboard`;
  }
  return `${difference.definition.name}: saved query differs from Avalon; remove the stale query in the Cloudflare dashboard`;
}

export function reconcileLifecycleRules(rules = []) {
  const current = rules.find((rule) => rule.id === RETENTION_RULE_ID);
  const condition = current?.deleteObjectsTransition?.condition;
  const prefix = current?.conditions?.prefix;
  const currentIsValid = current?.enabled === true
    && (prefix === "" || prefix === undefined)
    && condition?.type === "Age"
    && condition.maxAge === RETENTION_SECONDS;
  if (currentIsValid) return { changed: false, rules };

  return {
    changed: true,
    rules: [
      ...rules.filter((rule) => rule.id !== RETENTION_RULE_ID),
      {
        id: RETENTION_RULE_ID,
        enabled: true,
        conditions: { prefix: "" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: RETENTION_SECONDS } },
      },
    ],
  };
}

function expectedLogpushFilter(configuration) {
  return { where: { key: "ScriptName", operator: "eq", value: configuration.script } };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function destinationBucket(destinationConfiguration) {
  if (typeof destinationConfiguration !== "string") return undefined;
  try {
    const url = new URL(destinationConfiguration);
    if (url.protocol !== "r2:" && url.protocol !== "s3:") return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

export function assessLogpushJob(job, configuration) {
  const problems = [];
  if (job.dataset !== WORKERS_TRACE_DATASET) problems.push("dataset");
  if (job.enabled !== true) problems.push("enabled state");
  if (destinationBucket(job.destination_conf) !== configuration.bucket) problems.push("destination bucket");
  if (canonicalJson(parseJson(job.filter)) !== canonicalJson(expectedLogpushFilter(configuration))) {
    problems.push("script filter");
  }

  const output = job.output_options ?? {};
  const actualFields = [...(output.field_names ?? [])].sort();
  const expectedFields = [...LOGPUSH_FIELD_NAMES].sort();
  if (canonicalJson(actualFields) !== canonicalJson(expectedFields)) problems.push("field selection");
  if (output.sample_rate !== 1) problems.push("sample rate");
  if (output.timestamp_format !== "rfc3339") problems.push("timestamp format");

  let delivery = "pending";
  if (job.error_message || job.last_error) delivery = "failing";
  else if (job.last_complete) delivery = "healthy";

  return { valid: problems.length === 0, problems, delivery };
}

export class CloudflareRequestError extends Error {
  constructor(path, status, codes) {
    const codeText = codes.length > 0 ? codes.join(", ") : "unknown";
    super(`Cloudflare request failed for ${path} (${status}; codes: ${codeText})`);
    this.name = "CloudflareRequestError";
    this.status = status;
    this.codes = codes;
  }
}

export function createCloudflareClient({ accountId, apiToken, fetchImplementation = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  return async function cloudflare(path, init = {}) {
    let response;
    try {
      response = await fetchImplementation(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(`Cloudflare network request failed for ${path}`, { cause: error });
    }

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new CloudflareRequestError(path, response.status, []);
    }
    if (!response.ok || payload.success !== true) {
      const codes = (payload.errors ?? [])
        .map((error) => error?.code)
        .filter((code) => typeof code === "number" || typeof code === "string")
        .map(String);
      throw new CloudflareRequestError(path, response.status, codes);
    }
    return payload.result;
  };
}

async function ensureBucket(cloudflare, configuration, checkOnly) {
  const headers = { "cf-r2-jurisdiction": configuration.jurisdiction };
  let bucket;
  try {
    bucket = await cloudflare(`/r2/buckets/${configuration.bucket}`, { headers });
  } catch (error) {
    if (!(error instanceof CloudflareRequestError) || error.status !== 404) throw error;
    if (checkOnly) throw new Error(`${configuration.bucket}: R2 bucket is missing`, { cause: error });
    bucket = await cloudflare("/r2/buckets", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: configuration.bucket }),
    });
    console.info(`${configuration.bucket}: created in ${configuration.jurisdiction} jurisdiction`);
  }

  if (bucket?.jurisdiction && bucket.jurisdiction !== configuration.jurisdiction) {
    throw new Error(`${configuration.bucket}: unexpected R2 jurisdiction ${bucket.jurisdiction}`);
  }
  return headers;
}

async function ensureLifecycle(cloudflare, configuration, headers, checkOnly) {
  const result = await cloudflare(`/r2/buckets/${configuration.bucket}/lifecycle`, { headers });
  const reconciliation = reconcileLifecycleRules(result?.rules);
  if (!reconciliation.changed) {
    console.info(`${configuration.bucket}: 90-day retention verified`);
    return;
  }
  if (checkOnly) throw new Error(`${configuration.bucket}: 90-day retention rule is missing or stale`);
  await cloudflare(`/r2/buckets/${configuration.bucket}/lifecycle`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ rules: reconciliation.rules }),
  });
  console.info(`${configuration.bucket}: 90-day retention reconciled`);
}

async function ensureSavedQueries(cloudflare, checkOnly) {
  const assessment = assessSavedQueries(await cloudflare("/workers/observability/queries") ?? []);
  for (const definition of assessment.verified) {
    console.info(`${definition.name}: saved query verified`);
  }
  if (assessment.differences.length === 0) return;

  const unrepairable = assessment.differences.filter((difference) => difference.kind !== "missing");
  if (checkOnly || unrepairable.length > 0) {
    throw new Error([
      "Saved Workers Observability query drift:",
      ...assessment.differences.map((difference) => `- ${savedQueryDifferenceMessage(difference)}`),
    ].join("\n"));
  }
  for (const difference of assessment.differences) {
    const definition = difference.definition;
    await cloudflare("/workers/observability/queries", {
      method: "POST",
      body: JSON.stringify(definition),
    });
    console.info(`${definition.name}: saved query created`);
  }
}

async function createLogpushJob(cloudflare, accountId, configuration) {
  const permissionGroups = await cloudflare("/tokens/permission_groups");
  const bucketWrite = permissionGroups.find((groupDefinition) =>
    groupDefinition.name === "Workers R2 Storage Bucket Item Write"
      && groupDefinition.scopes?.includes("com.cloudflare.edge.r2.bucket"));
  if (!bucketWrite) throw new Error("Workers R2 Storage Bucket Item Write permission is unavailable");

  const jobName = `avalon-${configuration.region}-workers-trace-r2`;
  const tokenName = `${jobName}-writer`;
  const tokens = await cloudflare("/tokens");
  for (const token of tokens.filter((candidate) => candidate.name === tokenName)) {
    await cloudflare(`/tokens/${token.id}`, { method: "DELETE" });
  }

  const resource = `com.cloudflare.edge.r2.bucket.${accountId}_${configuration.jurisdiction}_${configuration.bucket}`;
  const writer = await cloudflare("/tokens", {
    method: "POST",
    body: JSON.stringify({
      name: tokenName,
      policies: [{
        effect: "allow",
        resources: { [resource]: "*" },
        permission_groups: [{ id: bucketWrite.id, name: bucketWrite.name }],
      }],
    }),
  });

  try {
    const secretAccessKey = createHash("sha256").update(writer.value).digest("hex");
    // Newly minted R2 account tokens are eventually visible to the Logpush service.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const query = new URLSearchParams({
      "account-id": accountId,
      "access-key-id": writer.id,
      "secret-access-key": secretAccessKey,
    });
    return await cloudflare("/logpush/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: jobName,
        dataset: WORKERS_TRACE_DATASET,
        destination_conf: `r2://${configuration.bucket}/workers-trace/{DATE}?${query}`,
        enabled: true,
        filter: JSON.stringify(expectedLogpushFilter(configuration)),
        output_options: {
          field_names: LOGPUSH_FIELD_NAMES,
          sample_rate: 1,
          timestamp_format: "rfc3339",
        },
      }),
    });
  } catch (error) {
    await cloudflare(`/tokens/${writer.id}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}

async function ensureLogpushJobs(cloudflare, accountId, checkOnly) {
  const jobs = await cloudflare(`/logpush/jobs?dataset=${WORKERS_TRACE_DATASET}`);
  for (const configuration of OBSERVABILITY_CONFIGURATIONS) {
    const jobName = `avalon-${configuration.region}-workers-trace-r2`;
    const matches = (jobs ?? []).filter((job) => job.name === jobName);
    if (matches.length > 1) throw new Error(`${jobName}: duplicate Logpush jobs require operator cleanup`);
    let job = matches[0];
    if (!job) {
      if (checkOnly) throw new Error(`${jobName}: Logpush job is missing`);
      job = await createLogpushJob(cloudflare, accountId, configuration);
      console.info(`${jobName}: configured`);
    }

    const assessment = assessLogpushJob(job, configuration);
    if (!assessment.valid) {
      throw new Error(`${jobName}: configuration drift detected (${assessment.problems.join(", ")})`);
    }
    if (assessment.delivery === "failing") {
      throw new Error(`${jobName}: Cloudflare reports a delivery failure; inspect the Logpush dashboard for the provider detail`);
    }
    if (assessment.delivery === "pending") {
      console.info(`${jobName}: configuration verified; delivery pending (no completed batch yet)`);
    } else {
      console.info(`${jobName}: configuration and delivery verified`);
    }
  }
}

export async function configureCloudflareObservability({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  checkOnly = process.argv.includes("--check"),
  fetchImplementation = fetch,
} = {}) {
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  }
  const cloudflare = createCloudflareClient({ accountId, apiToken, fetchImplementation });

  for (const configuration of OBSERVABILITY_CONFIGURATIONS) {
    const headers = await ensureBucket(cloudflare, configuration, checkOnly);
    await ensureLifecycle(cloudflare, configuration, headers, checkOnly);
  }
  await ensureLogpushJobs(cloudflare, accountId, checkOnly);
  await ensureSavedQueries(cloudflare, checkOnly);
}

if (isEntryPoint(import.meta.url)) {
  configureCloudflareObservability().catch((error) => {
    console.error(error instanceof Error ? error.message : "Cloudflare observability configuration failed");
    process.exitCode = 1;
  });
}
