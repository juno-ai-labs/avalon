#!/usr/bin/env node
// Walks the configured local D1 authorities from `legacy_open` to
// `durable_object_open`, so a freshly migrated-and-seeded local stack runs the
// same post-cutover model production runs. Without this, local development
// exercises the legacy path and none of the Durable-Object-authority code —
// which is how a defect that failed every production harness run stayed
// invisible to every local check.
//
// The walk respects the remaining trigger-enforced state machine production
// used: phases advance one step at a time, and this script explicitly creates
// routing rows for any conversation D1 already anchors now that migration 0090
// has removed the completed one-time import-population triggers. A fresh seed
// anchors none: after the ledger opens, the development-only HTTP seed route
// makes seed-product.json's Canvases and Sidekick through the Worker's own
// creation paths, which anchor and route them as they would in production. No product row is read from D1; this is
// why the script is local bootstrap rather than an operational import tool.
//
// Idempotent: a stack already at `durable_object_open` is left untouched.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pnpmExecutable } from "./migrate-d1.mjs";
import {
  localAuthorityRegions,
  localAuthorityTarget,
} from "./open-local-authority-sql.mjs";

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");

function query(sql, target) {
  // A running `wrangler dev` holds the same SQLite files, so individual
  // statements can lose a lock race and fail transiently. Retrying is the
  // contract here — every statement in this walk is idempotent by design.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const output = execFileSync(pnpmExecutable(), [
        "exec", "wrangler", "d1", "execute", "DB",
        "--config", target.config,
        "--persist-to", target.state,
        "--local", "--json",
        "--command", sql,
      ], { cwd: apiDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const start = output.indexOf("[");
      if (start === -1) throw new Error(`wrangler returned no JSON for: ${sql.slice(0, 80)}`);
      return JSON.parse(output.slice(start))[0]?.results ?? [];
    } catch (error) {
      lastError = error;
      // A synchronous wait without the Unix `sleep` binary, which Windows lacks.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (1 + attempt) * 1_000);
    }
  }
  throw lastError;
}

for (const region of localAuthorityRegions) await openRegion(region);

async function openRegion(region) {
  const target = localAuthorityTarget(region);
  const [control] = query(
    "SELECT phase, generation, serving_contract_version, required_serving_contract_version FROM workstream_authority_control WHERE id = 1",
    target,
  );
  if (!control) {
    throw new Error(`No ${region} workstream_authority_control row — run \`pnpm db:migrate && pnpm db:seed\` first.`);
  }
  if (control.phase === "durable_object_open") {
    console.log(`Local ${region} authority already open (generation ${control.generation}).`);
    await importSeeds(region, target);
    return;
  }
  const PHASES = ["legacy_open", "maintenance_draining", "maintenance_importing", "maintenance_verified", "durable_object_open"];
  if (!PHASES.includes(control.phase)) {
    throw new Error(`Local ${region} authority is in unknown phase '${control.phase}'.`);
  }

  // Resuming a half-finished walk is the common failure mode — a crashed Worker
  // or an interrupted script leaves the phase mid-machine — so every step below
  // is guarded by "are we before this phase" rather than assumed from a clean
  // start.
  const reached = (phase) => PHASES.indexOf(control.phase) >= PHASES.indexOf(phase);
  const generation = control.phase === "legacy_open"
    ? Number(control.generation) + 1
    : Number(control.generation);
  const advance = (sql) => query(sql, target);

  // Draining admits no new legacy work and creates pending route rows for every
  // existing work stream and workspace.
  if (!reached("maintenance_draining")) {
    advance(`UPDATE workstream_authority_control
      SET phase='maintenance_draining', generation=${generation},
          serving_contract_version=required_serving_contract_version,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=1`);
  }

  if (!reached("maintenance_importing")) {
    advance(`UPDATE workstream_authority_control SET phase='maintenance_importing',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
  }

  // These are routing rows, not import receipts on a fresh post-0090 database.
  // Production creates them alongside each new object after the authority is
  // open; the local seed predates that transition, so bootstrap them here.
  advance(`INSERT INTO workstream_authority_routes (
    workspace_id, workstream_id, generation, object_name, state, stage_index,
    source_cursor, source_fence_sequence, source_hash, target_hash,
    row_counts_json, imported_at, verified_at, activated_at, updated_at
  )
  SELECT w.workspace_id, w.id, ${generation}, ws.region || ':' || w.workspace_id || ':' || w.id,
         'pending', 0, 0, 0, 'seeded_in_do', 'seeded_in_do', '{}', NULL, NULL, NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM workstreams w JOIN workspaces ws ON ws.id = w.workspace_id
  ON CONFLICT(workstream_id) DO UPDATE SET
    workspace_id=excluded.workspace_id, generation=excluded.generation,
    object_name=excluded.object_name, state='pending', stage_index=0,
    source_cursor=0, source_fence_sequence=0, source_hash='seeded_in_do',
    target_hash='seeded_in_do', row_counts_json='{}', imported_at=NULL,
    verified_at=NULL, activated_at=NULL, last_error_code=NULL,
    updated_at=excluded.updated_at`);
  // Route states move with the phases: verified before the verified gate, active
  // before the open gate. `importing` first because the route machine is also
  // forward-only. Route updates are idempotent, so a resumed walk repeats them
  // harmlessly.
  for (const state of ["importing", "verified"]) {
    advance(`UPDATE workstream_authority_routes SET state='${state}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation} AND state != 'active'`);
  }
  if (!reached("maintenance_verified")) {
    advance(`UPDATE workstream_authority_control SET phase='maintenance_verified',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
  }
  // Only the workstream route table records an activation time.
  advance(`UPDATE workstream_authority_routes SET state='active', activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
  advance(`UPDATE workstream_authority_control SET phase='durable_object_open',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);

  const [after] = query("SELECT phase, generation FROM workstream_authority_control WHERE id = 1", target);
  if (after?.phase !== "durable_object_open") {
    throw new Error(`${region} walk did not complete; authority is at '${after?.phase}'.`);
  }
  console.log(`Local ${region} authority open (generation ${after.generation}).`);

  await importSeeds(region, target);
}

// Seeds the product fixtures — two Canvases and a Sidekick — through the
// Worker's own dev-gated seed route. The
// Worker may not be running when the walk is performed; say so rather than
// half-succeeding.
async function importSeeds(region, target) {
  const baseUrl = region === "global" && process.env.AVALON_E2E_BASE_URL
    ? process.env.AVALON_E2E_BASE_URL
    : target.baseUrl;
  const fixtures = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "seed-product.json"),
    "utf8",
  ));
  const health = await fetch(new URL("/health", baseUrl)).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.log(`${region} Worker not running at ${baseUrl}; start \`pnpm dev:api:local\` and re-run to seed the product fixtures.`);
    return;
  }
  const payload = { ...fixtures };
  delete payload.comment;
  const response = await fetch(new URL("/dev/seed-product", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${region} product seed failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  for (const entry of body.canvases ?? []) {
    console.log(`Seeded ${region} Canvas ${entry.canvasId}: ${JSON.stringify(entry.copied)}`);
  }
  for (const entry of body.automations ?? []) {
    console.log(`Seeded ${region} Sidekick ${entry.automationId}: ${entry.lifecycle}`);
  }
}
