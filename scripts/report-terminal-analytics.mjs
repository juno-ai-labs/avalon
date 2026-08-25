import { isEntryPoint } from "./entry-point.mjs";

const DATASET = "rally_terminal_operations";
const SCHEMA_VERSION = "terminal_platform_v1";

export function parseTerminalAnalyticsArguments(arguments_) {
  const options = { days: 7, region: "all", snapshot: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--days") {
      if (!/^\d+$/u.test(value ?? "")) throw new Error("--days must be an integer between 1 and 90");
      options.days = Number(value);
      if (options.days < 1 || options.days > 90) throw new Error("--days must be between 1 and 90");
      index += 1;
    } else if (argument === "--region") {
      if (value !== "all" && value !== "global" && value !== "eu") {
        throw new Error("--region must be all, global, or eu");
      }
      options.region = value;
      index += 1;
    } else if (argument === "--snapshot") {
      if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(value ?? "")) {
        throw new Error("--snapshot must contain only letters, numbers, dots, underscores, or hyphens");
      }
      options.snapshot = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument ?? ""}`.trim());
    }
  }
  return options;
}

function terminalFilter(options) {
  return [
    `blob1 = '${SCHEMA_VERSION}'`,
    `timestamp > NOW() - INTERVAL '${options.days}' DAY`,
    ...(options.region === "all" ? [] : [`blob4 = '${options.region}'`]),
    ...(options.snapshot ? [`blob5 = '${options.snapshot}'`] : []),
  ].join("\n  AND ");
}

export function buildTerminalAnalyticsQueries(options) {
  const where = terminalFilter(options);
  return {
    overview: `SELECT
  min(timestamp) AS observed_start,
  max(timestamp) AS observed_end,
  count() AS sampled_rows,
  SUM(_sample_interval) AS estimated_operations
FROM ${DATASET}
WHERE ${where}`,
    operations: `SELECT
  blob4 AS region,
  blob5 AS snapshot,
  blob2 AS operation,
  blob3 AS outcome,
  blob6 AS source_state,
  count() AS sampled_rows,
  SUM(_sample_interval) AS estimated_operations,
  SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_duration_ms,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_duration_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_duration_ms,
  max(double1) AS max_duration_ms,
  quantileExactWeighted(0.50)(double2, _sample_interval) AS p50_provider_create_ms,
  quantileExactWeighted(0.95)(double2, _sample_interval) AS p95_provider_create_ms,
  quantileExactWeighted(0.50)(double3, _sample_interval) AS p50_policy_readback_ms,
  quantileExactWeighted(0.95)(double3, _sample_interval) AS p95_policy_readback_ms,
  quantileExactWeighted(0.50)(double4, _sample_interval) AS p50_install_ms,
  quantileExactWeighted(0.95)(double4, _sample_interval) AS p95_install_ms,
  quantileExactWeighted(0.50)(double5, _sample_interval) AS p50_verify_ms,
  quantileExactWeighted(0.95)(double5, _sample_interval) AS p95_verify_ms
FROM ${DATASET}
WHERE ${where}
GROUP BY region, snapshot, operation, outcome, source_state
ORDER BY region, snapshot, operation, outcome, source_state`,
    capabilities: `SELECT
  blob4 AS region,
  blob5 AS snapshot,
  blob8 AS installed_capabilities,
  SUM(_sample_interval) AS estimated_bootstraps
FROM ${DATASET}
WHERE ${where}
  AND blob2 = 'sandbox_bootstrap'
  AND blob3 = 'completed'
GROUP BY region, snapshot, installed_capabilities
ORDER BY region, snapshot, estimated_bootstraps DESC`,
  };
}

export async function queryTerminalAnalytics({
  accountId,
  apiToken,
  sql,
  fetchImplementation = fetch,
}) {
  const response = await fetchImplementation(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
    },
  );
  if (!response.ok) {
    throw new Error(`Cloudflare Analytics Engine query failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("Cloudflare Analytics Engine returned an invalid response");
  }
  return payload.data;
}

function number(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCount(value) {
  return Math.round(number(value)).toLocaleString("en-US");
}

function formatDuration(value) {
  const milliseconds = number(value);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function operationLabel(row) {
  if (row.operation === "sandbox_create") return "Create sandbox";
  if (row.operation === "sandbox_bootstrap") return "Bootstrap managed image";
  if (row.operation === "sandbox_start" && row.source_state === "stopped") return "Warm stopped sandbox";
  if (row.operation === "sandbox_start" && row.source_state === "archived") return "Restore archived sandbox";
  if (row.operation === "sandbox_start") return `Start sandbox (${row.source_state})`;
  return String(row.operation);
}

export function formatTerminalAnalyticsReport(options, results) {
  const overview = results.overview[0] ?? {};
  const lines = [
    "Daytona platform analytics",
    `Requested window: last ${options.days} day${options.days === 1 ? "" : "s"}`,
    `Observed data: ${overview.observed_start ?? "none"} → ${overview.observed_end ?? "none"}`,
    `Filters: region=${options.region}, snapshot=${options.snapshot ?? "all"}`,
    `Operations: ${formatCount(overview.estimated_operations)} estimated from ${formatCount(overview.sampled_rows)} sampled rows`,
    "",
    "Latency by operation",
  ];

  if (results.operations.length === 0) lines.push("  No observations in this window.");
  for (const row of results.operations) {
    lines.push(
      `  ${row.region}/${row.snapshot} · ${operationLabel(row)} · ${row.outcome}`,
      `    observations ${formatCount(row.estimated_operations)}; total avg ${formatDuration(row.avg_duration_ms)}, p50 ${formatDuration(row.p50_duration_ms)}, p95 ${formatDuration(row.p95_duration_ms)}, max ${formatDuration(row.max_duration_ms)}`,
    );
    if (row.operation === "sandbox_create") {
      lines.push(
        `    provider create p50 ${formatDuration(row.p50_provider_create_ms)}, p95 ${formatDuration(row.p95_provider_create_ms)}; policy read-back p50 ${formatDuration(row.p50_policy_readback_ms)}, p95 ${formatDuration(row.p95_policy_readback_ms)}`,
      );
    } else if (row.operation === "sandbox_bootstrap") {
      lines.push(
        `    policy read-back p50 ${formatDuration(row.p50_policy_readback_ms)}, p95 ${formatDuration(row.p95_policy_readback_ms)}; install p50 ${formatDuration(row.p50_install_ms)}, p95 ${formatDuration(row.p95_install_ms)}; verify p50 ${formatDuration(row.p50_verify_ms)}, p95 ${formatDuration(row.p95_verify_ms)}`,
      );
    }
  }

  lines.push("", "Managed-image gaps installed");
  const capabilityTotals = new Map();
  for (const row of results.capabilities) {
    const count = number(row.estimated_bootstraps);
    for (const capability of String(row.installed_capabilities ?? "none").split(",")) {
      if (capability === "none" || capability === "") continue;
      const key = `${row.region}/${row.snapshot} · ${capability}`;
      capabilityTotals.set(key, (capabilityTotals.get(key) ?? 0) + count);
    }
  }
  if (capabilityTotals.size === 0) lines.push("  None recorded.");
  else for (const [capability, count] of [...capabilityTotals].sort()) {
    lines.push(`  ${capability}: ${formatCount(count)} bootstraps`);
  }

  lines.push("", "Image decision signal");
  const bootstrapCohorts = results.operations
    .filter((row) => row.operation === "sandbox_bootstrap" && row.outcome === "completed");
  if (bootstrapCohorts.length === 0) lines.push("  No successful bootstrap cohort is available yet.");
  for (const row of bootstrapCohorts) {
    const successfulBootstraps = number(row.estimated_operations);
    const installP95 = number(row.p95_install_ms);
    const cohort = `${row.region}/${row.snapshot}`;
    if (successfulBootstraps < 100) {
      lines.push(`  ${cohort}: Collect ${formatCount(100 - successfulBootstraps)} more successful bootstrap observations before comparing a custom image.`);
    } else if (installP95 > 10_000) {
      lines.push(`  ${cohort}: Benchmark a prebuilt Avalon snapshot; compatibility installation p95 is ${formatDuration(installP95)} across ${formatCount(successfulBootstraps)} bootstraps.`);
    } else {
      lines.push(`  ${cohort}: Keep daytona-small for now; compatibility installation p95 is ${formatDuration(installP95)} across ${formatCount(successfulBootstraps)} bootstraps.`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseTerminalAnalyticsArguments(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  }
  const queries = buildTerminalAnalyticsQueries(options);
  const [overview, operations, capabilities] = await Promise.all([
    queryTerminalAnalytics({ accountId, apiToken, sql: queries.overview }),
    queryTerminalAnalytics({ accountId, apiToken, sql: queries.operations }),
    queryTerminalAnalytics({ accountId, apiToken, sql: queries.capabilities }),
  ]);
  process.stdout.write(formatTerminalAnalyticsReport(options, { overview, operations, capabilities }));
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Terminal analytics report failed"}\n`);
    process.exitCode = 1;
  });
}
