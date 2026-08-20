#!/usr/bin/env node
// Walks the local Global D1 authority from `legacy_open` to
// `durable_object_open`, so a freshly migrated-and-seeded local stack runs the
// same post-cutover model production runs. Without this, local development
// exercises the legacy path and none of the Durable-Object-authority code —
// which is how a defect that failed every production harness run stayed
// invisible to every local check.
//
// The walk respects the same trigger-enforced state machine production used:
// phases advance one step at a time, seed runs are terminalized before the
// drain gate, and the seed work streams' routes are advanced with the phases.
// The seed work streams end up serving *empty* objects — their D1 product rows
// are not imported, because the import campaign was retired after the
// production cutover. That is acceptable for local work, which creates fresh
// work streams; it is why this is a local development script and not an
// operational tool.
//
// Idempotent: a stack already at `durable_object_open` is left untouched.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");

function query(sql) {
  // A running `wrangler dev` holds the same SQLite files, so individual
  // statements can lose a lock race and fail transiently. Retrying is the
  // contract here — every statement in this walk is idempotent by design.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const output = execFileSync("pnpm", [
        "exec", "wrangler", "d1", "execute", "DB",
        "--config", "wrangler.global.jsonc",
        "--persist-to", ".wrangler/state/global",
        "--local", "--json",
        "--command", sql,
      ], { cwd: apiDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const start = output.indexOf("[");
      if (start === -1) throw new Error(`wrangler returned no JSON for: ${sql.slice(0, 80)}`);
      return JSON.parse(output.slice(start))[0]?.results ?? [];
    } catch (error) {
      lastError = error;
      execFileSync("sleep", [String(1 + attempt)]);
    }
  }
  throw lastError;
}

const [control] = query(
  "SELECT phase, generation, serving_contract_version, required_serving_contract_version FROM workstream_authority_control WHERE id = 1",
);
if (!control) {
  console.error("No workstream_authority_control row — run `pnpm db:migrate && pnpm db:seed` first.");
  process.exit(1);
}
if (control.phase === "durable_object_open") {
  console.log(`Local authority already open (generation ${control.generation}).`);
  await importSeeds();
  process.exit(0);
}
const PHASES = ["legacy_open", "maintenance_draining", "maintenance_importing", "maintenance_verified", "durable_object_open"];
if (!PHASES.includes(control.phase)) {
  console.error(`Local authority is in unknown phase '${control.phase}'.`);
  process.exit(1);
}

// Resuming a half-finished walk is the common failure mode — a crashed Worker
// or an interrupted script leaves the phase mid-machine — so every step below
// is guarded by "are we before this phase" rather than assumed from a clean
// start.
const reached = (phase) => PHASES.indexOf(control.phase) >= PHASES.indexOf(phase);
const generation = control.phase === "legacy_open"
  ? Number(control.generation) + 1
  : Number(control.generation);
const advance = (sql) => query(sql);

// Draining admits no new legacy work and creates pending route rows for every
// existing work stream and workspace.
if (!reached("maintenance_draining")) {
  advance(`UPDATE workstream_authority_control
      SET phase='maintenance_draining', generation=${generation},
          serving_contract_version=required_serving_contract_version,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=1`);
}

// The drain gate: no live legacy runs may cross into the import phase.
advance(`UPDATE harness_runs
    SET status='completed',
        terminalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE terminalized_at IS NULL`);

if (!reached("maintenance_importing")) {
  advance(`UPDATE workstream_authority_control SET phase='maintenance_importing',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
}

// Route states move with the phases: verified before the verified gate, active
// before the open gate. `importing` first because the route machine is also
// forward-only. Route updates are idempotent, so a resumed walk repeats them
// harmlessly.
for (const state of ["importing", "verified"]) {
  advance(`UPDATE workstream_authority_routes SET state='${state}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation} AND state != 'active'`);
  advance(`UPDATE workspace_product_authority_routes SET state='${state}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation} AND state != 'active'`);
}
if (!reached("maintenance_verified")) {
  advance(`UPDATE workstream_authority_control SET phase='maintenance_verified',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
}
// Only the workstream route table records an activation time.
advance(`UPDATE workstream_authority_routes SET state='active', activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
advance(`UPDATE workspace_product_authority_routes SET state='active', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
advance(`UPDATE workstream_authority_control SET phase='durable_object_open',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);

const [after] = query("SELECT phase, generation FROM workstream_authority_control WHERE id = 1");
if (after?.phase !== "durable_object_open") {
  console.error(`Walk did not complete; authority is at '${after?.phase}'.`);
  process.exit(1);
}
console.log(`Local authority open (generation ${after.generation}).`);

await importSeeds();

// Imports the seeded work streams into their objects, through the Worker's own
// dev-gated import route, so the smoke check's fixtures survive the walk. The
// Worker may not be running when the walk is performed; say so rather than
// half-succeeding.
async function importSeeds() {
  const baseUrl = process.env.AVALON_E2E_BASE_URL ?? "http://127.0.0.1:8787";
  const fixtures = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "seed-product.json"),
    "utf8",
  ));
  const health = await fetch(new URL("/health", baseUrl)).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.log(`Worker not running at ${baseUrl}; start \`pnpm dev:api:local\` and re-run to seed the product fixtures.`);
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
    console.error(`Product seed failed: ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  for (const entry of body.workstreams ?? []) {
    console.log(`Seeded ${entry.workstreamId}: ${JSON.stringify(entry.copied)}`);
  }
}
