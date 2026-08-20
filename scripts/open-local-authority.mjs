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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");

function query(sql) {
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
if (control.phase !== "legacy_open") {
  console.error(`Local authority is mid-walk at '${control.phase}'. Reset the local database (delete apps/api/.wrangler/state) and reseed, or finish the walk by hand.`);
  process.exit(1);
}

const generation = Number(control.generation) + 1;
const advance = (sql) => query(sql);

// Draining admits no new legacy work and creates pending route rows for every
// existing work stream and workspace.
advance(`UPDATE workstream_authority_control
    SET phase='maintenance_draining', generation=${generation},
        serving_contract_version=required_serving_contract_version,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id=1`);

// The drain gate: no live legacy runs may cross into the import phase. Seeded
// fixtures ship one; a developer may have made more.
advance(`UPDATE harness_runs
    SET status='completed',
        terminalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE terminalized_at IS NULL`);

advance(`UPDATE workstream_authority_control SET phase='maintenance_importing',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);

// Route states move with the phases: verified before the verified gate, active
// before the open gate. `importing` first because the route machine is also
// forward-only.
for (const state of ["importing", "verified"]) {
  advance(`UPDATE workstream_authority_routes SET state='${state}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
  advance(`UPDATE workspace_product_authority_routes SET state='${state}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
}
advance(`UPDATE workstream_authority_control SET phase='maintenance_verified',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`);
for (const table of ["workstream_authority_routes", "workspace_product_authority_routes"]) {
  advance(`UPDATE ${table} SET state='active', activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE generation=${generation}`);
}
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
  const seeds = query(
    "SELECT id, workspace_id FROM workstreams WHERE do_identity_anchor IS NULL OR do_identity_anchor != 1",
  );
  if (seeds.length === 0) {
    console.log("No legacy work streams to import.");
    return;
  }
  const health = await fetch(new URL("/health", baseUrl)).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.log(`Worker not running at ${baseUrl}; start \`pnpm dev:api:local\` and re-run to import the ${seeds.length} seeded work stream(s).`);
    return;
  }
  for (const seed of seeds) {
    const response = await fetch(new URL("/dev/import-seed-workstream", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: seed.workspace_id, workstreamId: seed.id }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Import failed for ${seed.id}: ${JSON.stringify(body).slice(0, 200)}`);
      process.exit(1);
    }
    console.log(`Imported ${seed.id}: ${JSON.stringify(body.copied ?? body)}`);
  }
}
