#!/usr/bin/env node
// Drives one region's WorkstreamDO authority maintenance cutover end to end:
// drain -> import -> verify -> activate -> open, per docs/runbook.md. The D1
// phase-transition triggers remain the actual safety authority — every flip
// here is a guarded UPDATE those triggers can reject — so this script can
// sequence the campaign but can never advance it past its evidence.
//
// The heavy lifting (page-by-page import, verification, route activation, the
// serving-contract attestation) is cron-owned Worker code; this script only
// flips the operator phases and watches route state until the open guard is
// satisfied. It is safe to rerun: every step resumes from the phase the
// control row is actually in, a completed region is a fast no-op, and a
// quarantined region fails loudly and leaves repair to a human with a new
// generation.
//
// Usage:
//   node scripts/run-authority-cutover.mjs eu
//   node scripts/run-authority-cutover.mjs global
//
// Environment:
//   AVALON_CUTOVER_POLL_MS       poll interval (default 30000)
//   AVALON_CUTOVER_SETTLE_MS     wait after runs drain before importing
//                                (default 60000, lets Queue retries park)
//   AVALON_CUTOVER_DEADLINE_MS   overall budget (default 2 hours); on expiry
//                                the cron keeps progressing and a rerun resumes
//   AVALON_CUTOVER_REQUESTED_BY  recorded on the control row
//   AVALON_CUTOVER_REASON        recorded on the control row

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./entry-point.mjs";

const execFileAsync = promisify(execFile);

const REGION_CONFIGS = {
  global: "wrangler.global.jsonc",
  eu: "wrangler.eu.jsonc",
};

const POLL_MS = Number(process.env.AVALON_CUTOVER_POLL_MS ?? "30000");
const SETTLE_MS = Number(process.env.AVALON_CUTOVER_SETTLE_MS ?? "60000");
const DEADLINE_MS = Number(process.env.AVALON_CUTOVER_DEADLINE_MS ?? String(2 * 60 * 60_000));

export function parseRegion(argv) {
  const [region] = argv.filter((value) => value.length > 0);
  if (!region || !(region in REGION_CONFIGS)) {
    throw new Error(`Usage: run-authority-cutover.mjs <eu|global>; got: ${region ?? "(nothing)"}`);
  }
  return region;
}

// d1 execute takes one raw SQL string, so operator-supplied text is embedded
// as a single-quoted literal. Doubling the quote is the whole SQLite escape.
export function sqlLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

async function wranglerD1Execute(region, sql) {
  const apiDirectory = fileURLToPath(new URL("../apps/api/", import.meta.url));
  let stdout;
  try {
    ({ stdout } = await execFileAsync("pnpm", [
      "exec", "wrangler", "d1", "execute", "DB",
      "--remote", "--json",
      "--config", REGION_CONFIGS[region],
      "--command", sql,
    ], { cwd: apiDirectory, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    // execFile's message is just the command line; the D1 trigger name the
    // caller matches on (e.g. workstream_authority_runs_not_drained) arrives
    // on wrangler's stdout/stderr, so surface both in the thrown error.
    const detail = [error?.stdout, error?.stderr]
      .filter((chunk) => typeof chunk === "string" && chunk.trim().length > 0)
      .join("\n");
    throw new Error(`d1 execute failed: ${detail.slice(0, 2000) || String(error)}`, { cause: error });
  }
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) {
    throw new Error(`d1 execute did not succeed: ${stdout.slice(0, 500)}`);
  }
  return { results: first.results ?? [], changes: Number(first.meta?.changes ?? 0) };
}

async function readControl(execSql) {
  const { results } = await execSql(
    `SELECT phase, generation, serving_contract_version,
            required_serving_contract_version, reason
       FROM workstream_authority_control WHERE id = 1`,
  );
  const control = results[0];
  if (!control) throw new Error("workstream_authority_control row is missing");
  return control;
}

async function countNonterminalRuns(execSql) {
  const { results } = await execSql(
    `SELECT COUNT(*) AS count FROM harness_runs
      WHERE status IN ('scheduled', 'running') AND terminalized_at IS NULL`,
  );
  return Number(results[0]?.count ?? 0);
}

async function routeStates(execSql, table, generation) {
  const { results } = await execSql(
    `SELECT state, COUNT(*) AS count FROM ${table}
      WHERE generation = ${generation} GROUP BY state ORDER BY state`,
  );
  return Object.fromEntries(results.map((row) => [row.state, Number(row.count)]));
}

async function quarantineDetails(execSql, generation) {
  const workstreams = await execSql(
    `SELECT workstream_id, last_error_code FROM workstream_authority_routes
      WHERE generation = ${generation} AND state = 'quarantined' LIMIT 5`,
  );
  const workspaces = await execSql(
    `SELECT workspace_id, last_error_code FROM workspace_product_authority_routes
      WHERE generation = ${generation} AND state = 'quarantined' LIMIT 5`,
  );
  return [...workstreams.results, ...workspaces.results];
}

function nonActiveTotal(states) {
  return Object.entries(states)
    .filter(([state]) => state !== "active")
    .reduce((total, [, count]) => total + count, 0);
}

function quarantineError(details) {
  const summary = details
    .map((row) => `${row.workstream_id ?? row.workspace_id}: ${row.last_error_code ?? "unknown"}`)
    .join("; ");
  return new Error(
    `The campaign quarantined; repair the cause and rerun with a NEW generation by hand `
    + `(docs/runbook.md). First quarantined routes: ${summary || "see route tables"}`,
  );
}

/**
 * Drive one region's cutover to `durable_object_open`. Returns "already_open"
 * when there was nothing to do, "opened" when this invocation performed or
 * completed the campaign.
 */
export async function runCutover(region, {
  execSql,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
  deadlineMs = DEADLINE_MS,
  requestedBy = process.env.AVALON_CUTOVER_REQUESTED_BY ?? "deploy-api-workflow",
  reason = process.env.AVALON_CUTOVER_REASON ?? "automated cutover at merge",
} = {}) {
  const deadline = now() + deadlineMs;
  let control = await readControl(execSql);

  if (control.phase === "durable_object_open") {
    log(`[${region}] already durable_object_open (generation ${control.generation}); nothing to do`);
    return "already_open";
  }
  if (control.phase === "quarantined") {
    throw quarantineError(await quarantineDetails(execSql, control.generation));
  }

  if (control.phase === "legacy_open") {
    const generation = Number(control.generation) + 1;
    const at = sqlLiteral(new Date(now()).toISOString());
    const flipped = await execSql(
      `UPDATE workstream_authority_control
          SET phase = 'maintenance_draining', generation = ${generation},
              requested_by = ${sqlLiteral(requestedBy)}, reason = ${sqlLiteral(reason)},
              started_at = ${at}, updated_at = ${at}
        WHERE id = 1 AND phase = 'legacy_open'`,
    );
    log(`[${region}] ${flipped.changes === 1 ? "entered" : "already entering"} maintenance_draining as generation ${generation}`);
    control = await readControl(execSql);
  } else {
    log(`[${region}] resuming an in-flight campaign from ${control.phase} (generation ${control.generation})`);
  }

  let settledAt = null;
  for (;;) {
    if (now() > deadline) {
      throw new Error(
        `[${region}] deadline exceeded in ${control.phase}; the Worker cron keeps progressing — rerun this script to resume watching`,
      );
    }

    if (control.phase === "maintenance_draining") {
      const runs = await countNonterminalRuns(execSql);
      if (runs > 0) {
        settledAt = null;
        log(`[${region}] draining: ${runs} nonterminal run(s) remain`);
      } else if (settledAt === null) {
        // Runs are drained; hold one settle window so in-flight Queue
        // deliveries park in retry before the import snapshot freezes.
        settledAt = now();
        log(`[${region}] runs drained; settling ${settleMs}ms before importing`);
      } else if (now() - settledAt >= settleMs) {
        const at = sqlLiteral(new Date(now()).toISOString());
        try {
          await execSql(
            `UPDATE workstream_authority_control
                SET phase = 'maintenance_importing', updated_at = ${at}
              WHERE id = 1 AND phase = 'maintenance_draining'`,
          );
          log(`[${region}] entered maintenance_importing; cron owns the campaign from here`);
        } catch (error) {
          // A run admitted before draining can still terminalize late; the
          // drain guard rejecting the flip just means another poll cycle.
          if (!String(error).includes("workstream_authority_runs_not_drained")) throw error;
          settledAt = null;
        }
      }
    } else if (control.phase === "maintenance_importing" || control.phase === "maintenance_verified") {
      const workstreamStates = await routeStates(execSql, "workstream_authority_routes", control.generation);
      const workspaceStates = await routeStates(execSql, "workspace_product_authority_routes", control.generation);
      log(
        `[${region}] ${control.phase}: workstream routes ${JSON.stringify(workstreamStates)}, `
        + `workspace routes ${JSON.stringify(workspaceStates)}, `
        + `contract ${control.serving_contract_version}/${control.required_serving_contract_version}`,
      );
      if ((workstreamStates.quarantined ?? 0) > 0 || (workspaceStates.quarantined ?? 0) > 0) {
        throw quarantineError(await quarantineDetails(execSql, control.generation));
      }
      const ready = control.phase === "maintenance_verified"
        && nonActiveTotal(workstreamStates) === 0
        && nonActiveTotal(workspaceStates) === 0
        && Number(control.serving_contract_version) >= Number(control.required_serving_contract_version);
      if (ready) {
        const at = sqlLiteral(new Date(now()).toISOString());
        try {
          const opened = await execSql(
            `UPDATE workstream_authority_control
                SET phase = 'durable_object_open', opened_at = ${at}, updated_at = ${at}
              WHERE id = 1 AND phase = 'maintenance_verified'`,
          );
          if (opened.changes === 1) {
            log(`[${region}] durable_object_open — cutover complete for generation ${control.generation}`);
            return "opened";
          }
        } catch (error) {
          // The open guard re-checks routes and attestation transactionally; a
          // rejection between our read and the flip only means "not yet".
          if (!String(error).includes("workstream_authority_not_ready_to_open")) throw error;
        }
      }
    } else if (control.phase === "quarantined") {
      throw quarantineError(await quarantineDetails(execSql, control.generation));
    } else if (control.phase === "durable_object_open") {
      log(`[${region}] durable_object_open — cutover complete for generation ${control.generation}`);
      return "opened";
    }

    await wait(pollMs);
    control = await readControl(execSql);
  }
}

async function main() {
  const region = parseRegion(process.argv.slice(2));
  const outcome = await runCutover(region, {
    execSql: (sql) => wranglerD1Execute(region, sql),
  });
  console.log(`[${region}] outcome: ${outcome}`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
